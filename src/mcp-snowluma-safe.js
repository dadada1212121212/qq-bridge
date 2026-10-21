// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// 出站文本的敏感信息拦截**统一由桥接负责**（bridge.js 的 auditAndSend / 各发送端点的
// SENSITIVE_RE 校验）：所有 QQ 发送都经由桥接 HTTP API，因此 MCP 侧不再重复实现一遍。
// 这里 import 只用于「出站审计口径一致」的说明，不在 MCP 内做拦截——
// 在 MCP 里拦会连「安全拒绝理由」都拿不到，反而让模型无法把话说清楚。
import { SENSITIVE_RE } from './sensitive.js';
import { serializeModelData } from './qq-model-view.js';
import { normEnum } from './mcp-args.js';

// [养鱼 2026-10-21] 唤醒模式的常见说法归一。模型不会记得「潜水」在这个系统里叫 diving，
// 它第一反应是 silent / quiet / normal——与其让它猜两轮，不如都认。
const WAKE_MODE_ALIASES = {
  diving: 'diving', dive: 'diving', quiet: 'diving', silent: 'diving', sleep: 'diving',
  sleeping: 'diving', idle: 'diving', off: 'diving', rest: 'diving', away: 'diving',
  潜水: 'diving', 静默: 'diving', 安静: 'diving', 睡觉: 'diving',
  active: 'active', awake: 'active', normal: 'active', on: 'active', wake: 'active',
  活跃: 'active', 正常: 'active', 醒着: 'active',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();

function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 说明：本文件曾经有一对 escapeCqText() / messageSegments()，用于在 MCP 侧构造消息段。
// 它们从来没有被任何工具调用（发送一律走桥接的 /api/send/*，由桥接统一构造文本段并做
// CQ 转义，见 bridge.js 的 onebotSend），属于"看起来在防护、实际是死代码"的假安全。
// 这里直接删除，避免以后有人以为 MCP 侧还有一道 CQ 转义而放松桥接那一层。

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  try {
    const c = getConfig();
    if (c.consoleToken) return String(c.consoleToken);
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(rest.headers ?? {})
  };
  // 声明「这是一次智能体调用」。桥接据此把「没带会话令牌」判定为**拒绝**，而不是
  // 退化成「管理端全权」——所以这个头绝不能随 token 一起被省略。历史上 331/355/379/877
  // 行用 `...(token ? {headers:{...}} : {})` 把整个头省掉了，于是「模型漏传 token」
  // 不是被拒绝，反而提权成控制台权限（confused deputy）。
  // 令牌本身仍然只在真有时才发：/api/status 的模式探测（legacyReadToolAllowed）本来就是
  // 无令牌调用，桥接对它单独放行并按最小对象返回。
  headers['x-agent-call'] = '1';
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(body?.error || `桥接 API HTTP ${res.status}`);
  }
  // 桥接的部分端点会用 200 + {ok:false,error} 表达业务失败（例如发送被审计拦截）。
  // 不检查 body.ok 会把「被拦截」当成「发送成功」上报给模型 —— 模型据此认为消息已发出，
  // 于是不再重试也不告诉用户，是典型的静默错误。
  if (body && typeof body === 'object' && body.ok === false) {
    throw new Error(body.error || '桥接 API 返回 ok:false（未说明原因）');
  }
  return body;
}

async function authorizeRead(key) {
  // 会话令牌必须显式携带：桥接已把空令牌的请求一律拒绝（避免把该端点变成免鉴权入口）。
  // 旧只读工具没有令牌，因此它们改由 legacyReadToolAllowed() 做模式判定，不再调用本函数。
  throw new Error('旧只读工具没有会话令牌；请使用带会话令牌的 v2 读工具');
}

// 旧只读工具（qq_status 之外的 qq_list_groups / qq_get_group_members / qq_get_group_history）
// 没有会话令牌，因此**只能在封闭 agent（管理员私聊）里使用**。
//
// 这里用「确认是 closed-agent 才放行」的白名单写法，而不是「看到 reserved2 就拒绝」的黑名单写法：
// 桥接的 /api/status 在「带 agent 令牌」时返回的是最小状态对象（不含 mode 字段），
// 用 `status?.mode === 'reserved2'` 判断会得到 undefined ⇒ 黑名单判定为假 ⇒ 旧工具被放行，
// 等于在二代仿真模式下把白名单群名、群成员名单注入模型上下文。
async function legacyReadToolAllowed() {
  const status = await agentApi('/api/status');
  return String(status?.mode ?? '') === 'closed-agent';
}

const server = new McpServer({ name: 'snowluma-safe', version: '0.2.0-r3' });

// ── 会话 key 缺失自愈（2026-10-20）──────────────────────────────────────────
//
// 实测事故：PTC 模式下模型第一笔 `qq_send_message` 只写了 token、没写 key。MCP 的 zod 在
// handler 之前就抛 `-32602 expected string, received undefined at key`，桥接那套「按令牌
// 反查 key」的自愈完全没机会跑；她随后去调 `qq_get_prompt` 求救，同样只带 token、同样被拒
// —— 救命工具也要 key，形成死循环。最后她靠 `const names = ["agentToken",...]`、
// `const keys = ["private","owner",...]` 暴力试探了 7 次才摸到 `key = private:3796180411`，
// 整个首轮 9 次调用、约 2.5 分钟、¥0.12 全花在这上面。
//
// 而「缺 key」本身是可自愈的：令牌只对应唯一一个会话。所以分两层补：
//   1) schema 里 key 改成可选 —— 否则 zod 在 handler 之前就把请求毙了，写再多逻辑都白搭；
//   2) 给 server.tool 包一层，handler 执行前把缺的 key 按令牌补上。
// 用「包一层」而不是逐个 handler 改，是因为本文件有 39 个工具都带 key，逐个改既容易漏、
// 又会在下次新增工具时再次退化。
const KEY_ARG = z.string().optional().describe('会话 key，格式 group:群号 或 private:QQ号（可以省略：只传 token 时按令牌反查唯一对应的会话）');

/** 缺 key 时按令牌向桥接反查；查不到返回空串，由调用方决定怎么报错。 */
async function resolveSessionKey(key, token) {
  const k = typeof key === 'string' ? key.trim() : '';
  if (k) return k;
  if (!token) return '';
  try {
    const data = await agentApi('/api/socialV2/resolve-key', {
      headers: { 'x-agent-token': token },
      timeoutMs: 5000
    });
    const resolved = typeof data?.key === 'string' ? data.key : '';
    if (resolved) console.error(`[自愈] 只给了 token 没给 key，已反查为 ${resolved}`);
    return resolved;
  } catch (error) {
    console.error(`[自愈] 按令牌反查 key 失败：${error?.message ?? error}`);
    return '';
  }
}

// 反查也失败时要给一句**能照着做**的话。历史教训：模型看到 zod 的
// `expected string, received undefined at key` 完全不知道下一步该干什么，只能瞎试。
const KEY_HINT = '缺少会话 key，按令牌也反查不到（令牌可能已轮换）。唤醒提示里【会话令牌】那行有两个值，都要传：'
  + 'key 形如 private:3796180411 或 group:群号，token 是 48 位十六进制；token 不能当 key 用。';

const registerTool = server.tool.bind(server);
server.tool = (name, description, params, handler) => registerTool(name, description, params, async (args, extra) => {
  // 只有 schema 里真的声明了 key 的工具才走自愈：qq_report_feedback 这类只有 token 的工具
  // 不该为它多打一次桥接请求。
  const needsKey = !!params && typeof params === 'object' && Object.hasOwn(params, 'key');
  if (needsKey && args && typeof args === 'object' && args.token && !args.key) {
    const resolved = await resolveSessionKey(args.key, args.token);
    // 反查不到就直接把「该怎么办」告诉她，别让请求带着空 key 往下走。
    if (!resolved) return { content: [{ type: 'text', text: KEY_HINT }], isError: true };
    args = { ...args, key: resolved };
  }
  return handler(args, extra);
});


// ── 工具开关必须在**注册期**生效，而不是只在校验期 ──────────────────────────
//
// 为什么：每个工具的描述 + 参数 schema 都会随 system prompt 在**每一次**请求里重发
// （实测 41 个工具约 8.8k token）。只在校验时 403 的话，被关掉的工具依然占着上下文、
// 依然会让模型看见并调用它（然后拿到一个错误），等于「关了个寂寞」。
//
// 这里用一个注册过滤器统一处理：开关关闭 ⇒ 该工具根本不注册 ⇒ 既省 token 又不给模型误调的机会。
// DSH 在启动时读取工具清单，所以关掉/打开后需要重启 DSH 才会刷新（控制台面板已注明）。
//
// 只列**各模式共用的工具不在其中**：qq_send_group_message / qq_send_private_message / qq_reply
// 同时服务 chat / reserved / closed-agent 模式，用 v2 的开关去决定它们是否注册会误伤其它模式，
// 所以这三个仍然只在调用时由桥接校验。
// 只跑 reserved2 的部署可以把 `socialV2.tools.hideLegacySendTools` 设为 true，让它们改在
// **注册期**就被摘掉（统一发送工具 qq_send_message 已覆盖多条/引用/@/群聊/私聊全部能力），
// 省掉这几份永远不用的参数 schema。`TOOL_CONFIG_FLAGS[name]` 既可以是字符串也可以是字符串
// 数组，任一开关为 false 就不注册（例如 qq_memory_* 既受总开关 `memory` 管，也能被
// `memoryQuery` / `memoryRemove` / `memoryClear` 单独摘掉）。
const RESERVED2_ONLY_SEND_TOOLS = new Set(['qq_reply', 'qq_send_private_message', 'qq_send_group_message']);
const TOOL_CONFIG_FLAGS = {
  qq_get_prompt: 'getPrompt',
  qq_get_unread_messages: 'getUnread',
  qq_get_recent_messages: 'getRecent',
  qq_social_state: 'socialState',
  qq_mark_read: 'markRead',
  qq_set_wake_config: 'setWakeConfig',
  qq_send_burst: 'sendBurst',
  qq_send_message: 'sendMessage',
  qq_wait_for_messages: 'waitMessages',
  qq_report_feedback: 'feedback',
  qq_get_my_recent_messages: 'getMyRecent',
  qq_get_message_detail: 'getMessageDetail',
  qq_get_active_members: 'getActiveMembers',
  qq_memory_append: 'memory',
  qq_memory_query: ['memory', 'memoryQuery'],
  qq_memory_remove: ['memory', 'memoryRemove'],
  qq_memory_clear: ['memory', 'memoryClear'],
  // 小记（私人日记）：总开关 memory（长期记忆库没开就没地方写）+ diary（她自己的小记开关）。
  qq_diary: ['memory', 'diary'],
  qq_slang_query: 'slangQuery',
  qq_slang_submit: 'slangSubmit',
  qq_send_voice: 'sendVoice',
  qq_list_voices: 'sendVoice',
  // 下面这些曾经漏登记。漏一个不是"多注册一个工具"那么轻：桥接那边按 `v2ToolEnabled(flag)`
  // 在**调用期**一律 403，而这里不登记就等于"控制台显示已关闭、模型每次请求仍收到它的完整
  // 描述与参数 schema，然后调用它、再拿到 403"——既白烧 token（本文件开头 176 行起就是为省这份
  // token 才改注册期过滤的），又诱导模型误调。`qq_set_sticker_remark` 默认就是 `false`
  // （见 bridge.js 的 socialV2.tools 默认表），所以此前它一直是"默认关闭却仍然可见"。
  qq_send_poke: 'sendPoke',
  qq_get_message_images: 'getImages',
  qq_get_forward_msg: 'getForwardMsg',
  qq_list_stickers: 'listStickers',
  qq_get_sticker_image: 'getStickerImage',
  qq_send_sticker: 'sendSticker',
  qq_send_meme: 'sendMeme',
  qq_account: 'accountAction',
  qq_react_message: 'reactMessage',
  qq_post_qzone: 'qzone',
  qq_read_qzone: 'qzone',
  qq_usage: 'usage',
  qq_collect_sticker: 'collectSticker',
  qq_get_self_image: 'getSelfImage',
  qq_sticker_note: 'stickerNote',
  qq_set_sticker_remark: 'setStickerRemark',
  // 这两个只读工具与 qq_account(action=get_group_member_list / get_group_msg_history) 重叠，
  // 实测零调用，单独给标志以便关掉；标志未设置时仍然注册。
  qq_get_group_members: 'getGroupMembers',
  qq_get_group_history: 'getGroupHistory',
};
const disabledTools = [];
{
  const registerTool = server.tool.bind(server);
  const flagsOf = (name) => {
    const f = TOOL_CONFIG_FLAGS[name];
    if (!f) return [];
    return Array.isArray(f) ? f : [f];
  };
  server.tool = (name, ...rest) => {
    const offFlag = flagsOf(name).find((flag) => cfg.socialV2?.tools?.[flag] === false);
    if (offFlag) {
      disabledTools.push(`${name}(${offFlag})`);
      return undefined;
    }
    if (cfg.socialV2?.tools?.hideLegacySendTools === true && RESERVED2_ONLY_SEND_TOOLS.has(name)) {
      disabledTools.push(`${name}(hideLegacySendTools)`);
      return undefined;
    }
    return registerTool(name, ...rest);
  };
}

server.tool(
  'qq_status',
  '查询 QQ 机器人登录状态与账号信息（只读）。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      return { content: [{ type: 'text', text: serializeModelData({ ...login, online: status.online, good: status.good }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_groups',
  '列出机器人所在的全部 QQ 群（只读）：群号、群名。',
  {},
  async () => {
    // 旧只读工具没有 agent token：只允许在封闭 agent（管理员私聊）里使用。
    // 判定失败一律拒绝（fail-closed），不依赖「看到某个模式才拒绝」的黑名单写法。
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${error?.message ?? error}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_members',
  '列出指定群的成员列表（只读）：QQ 号、昵称、群名片。',
  { groupId: z.union([z.number(), z.string()]).describe('群号') },
  async ({ groupId }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const data = await onebot('get_group_member_list', { group_id: Number(g) });
      const list = (Array.isArray(data) ? data : (data?.data ?? [])).map((m) => ({ user_id: m.user_id, nickname: m.nickname, card: m.card }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。注意：是否可用取决于 SnowLuma 是否实现 get_group_msg_history。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_group_message',
  '向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        // token 既放 body（兼容旧调用）又放 header：桥接的「agent 流量」判定基于 header，
        // 只带 body 会让这条请求在桥接眼里像控制台请求，绕过 agent 专用的闸门与审计。
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_reply',
  '在指定 QQ 群里引用/回复某条消息，并发送一条文本。适合群消息很多、需要明确“我回的是哪条”时使用；replyToMessageId 是被引用消息的 id（非零整数，QQ 消息 id 可能为负数），可先用 qq_get_recent_messages / qq_get_unread_messages / qq_get_message_detail 查到具体消息内容和 id。发送前桥接会校验该 id 存在且属于当前会话。二代模式下这是你正常可用的引用工具，但不要每条都引用。只有以下情况才需要引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。reserved2 下调用时必须携带会话令牌 token。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id（非零整数，可为负数）'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, replyToMessageId, message, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/reply', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), replyToMessageId, message: cleanMessage, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_private_message',
  '向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看当前二代仿真模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。',
  { key: KEY_ARG, token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_unread_messages',
  '查看未读消息，不自动标记已读。大量积压或快照 partial=true 时，用 afterSeq=readThroughSeq 从水位后按时间顺序补读；从最早未读开始传 0。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 30，最大 100'),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('读取本地 seq 大于此水位的最早一页；省略则沿用返回最新一页的旧行为')
  },
  async ({ key, token, limit, afterSeq }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}${afterSeq === undefined ? '' : `&afterSeq=${afterSeq}`}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看指定会话的二代仿真状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: KEY_ARG, token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将指定会话已查看的未读消息标记为已读。throughSeq 使用最近读取结果的 readThroughSeq，避免清除读取后才到达的新消息；省略 throughSeq 会按旧行为清空当前全部未读，因此推荐始终带上水位。注意：每次设置潜水/下一次唤醒前，桥接要求先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可 mark_read 收尾沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与也可直接 mark_read 收尾；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('本次确认已读的消息水位，使用已查看结果中的 readThroughSeq；不会清除更晚到达的消息')
  },
  async ({ key, token, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置指定会话的二代唤醒配置：mode/无限期或有限时间/提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后，群里有人拍一拍（包括拍你或拍别人）会唤醒你。注意：每次设置潜水/下一次唤醒前需先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可设置并沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与可直接设置并沉睡；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可同时确认已读：使用已查看结果中的 readThroughSeq，省去额外 qq_mark_read；不传则只设置唤醒配置。若 markRead 工具被关闭，该水位会被忽略，本工具只设置唤醒配置'),
    config: z.object({
      mode: z.string().optional().describe('diving=潜水（安静，只有 @/叫名字/关键词/提问/拍一拍/概率命中才醒），active=活跃（任何消息都醒）。写 silent / quiet / sleep / 正常 这类常见说法也会被自动认成对应模式'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_message_detail 的 userId/user_id，或 qq_account(action=get_group_member_list) 的成员列表获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config, throughSeq }) => {
    // [养鱼 2026-10-21] mode 原来是 z.enum(['diving','active'])。模型想"安静点"时会先猜
    // silent / quiet / normal，被 zod 直接挡掉，而报错只说 expected one of "diving"|"active"，
    // 它得再猜一次才知道该写 diving——实测就多烧了一轮。改成宽松字符串 + 归一，认不出才报错。
    let cfgIn = config;
    if (config && config.mode !== undefined && config.mode !== null && String(config.mode).trim() !== '') {
      const mode = normEnum(config.mode, WAKE_MODE_ALIASES);
      if (!mode) {
        return { content: [{ type: 'text', text: `【参数错误】config.mode 只认 diving（潜水/安静）或 active（活跃/正常），你传的是「${config.mode}」。` }], isError: true };
      }
      cfgIn = { ...config, mode };
    }
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config: cfgIn, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_burst',
  '在指定 QQ 群分多条发送消息（二代仿真模式专用），桥接会按真人化随机间隔发送。暂不支持引用，需要引用请用 qq_send_message 的 replyToMessageId。注意：数组里的每个字符串就是一条 QQ 消息，字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的消息数组，每条为纯文本；也兼容传入 JSON 数组字符串')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。二代仿真模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 文件收发工具（发送 + 收件箱）─────────────────────────────────────────
// 接收是事件驱动（桥接 bot.onNotice 监听，仅主人私聊），这里提供发送与查询工具。
// 全部走 KEY_ARG（漏 key 时按令牌反查），与 qq_send_message 同构。
if (cfg.socialV2?.tools?.files !== false) {
  server.tool(
    'qq_send_file',
    '发送文件给指定会话（二代仿真模式专用）。支持：① Windows 绝对路径（如 C:/Users/x/报告.txt，桥接会转成 SnowLuma 能读的路径）；② file:// 引用；③ base64: 引用。文件作为 QQ 文件发出去（私聊用 upload_private_file，群聊用 upload_group_file），发送受桥接权限闸门与静默模式限制。注意：网络 URL 暂不支持，先把文件下载到本地再发；不支持相对路径。reserved2 下必须携带会话令牌 token。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      filePath: z.string().describe('要发送的文件路径：Windows 绝对路径 / file:// 引用 / base64: 引用。不支持网络 URL'),
      name: z.string().optional().describe('文件在对方 QQ 上显示的名字（可选，缺省用原文件名）')
    },
    async ({ key, token, filePath, name }) => {
      try {
        const data = await agentApi('/api/socialV2/send-file', {
          method: 'POST',
          body: JSON.stringify({ key, filePath, name }),
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送文件失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_inbox',
    '列出机器人收到的文件（收件箱）。仅主人私聊发的文件会被接收存档。返回最近的文件列表（文件名/大小/接收时间/seq 等）。拿到 seq 后可用 qq_read_inbox_file 读取文本内容。reserved2 下必须携带会话令牌 token。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      limit: z.number().int().positive().max(200).optional().describe('返回最近多少条（默认 50）')
    },
    async ({ key, token, limit }) => {
      try {
        const qs = new URLSearchParams({ key, token, ...(limit ? { limit: String(limit) } : {}) }).toString();
        const data = await agentApi('/api/socialV2/inbox?' + qs, { method: 'GET', headers: { 'x-agent-token': token }, timeoutMs: 30000 });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `查询收件箱失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_read_inbox_file',
    '读取收件箱里某个文件的文本内容（限文本类，过大或非文本会给出提示）。先用 qq_list_inbox 拿到 seq。仅主人私聊收到的文件可读。reserved2 下必须携带会话令牌 token。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      seq: z.union([z.number(), z.string()]).describe('文件在收件箱里的 seq（来自 qq_list_inbox）')
    },
    async ({ key, token, seq }) => {
      try {
        const qs = new URLSearchParams({ key, token, seq: String(seq) }).toString();
        const data = await agentApi('/api/socialV2/inbox-file?' + qs, { method: 'GET', headers: { 'x-agent-token': token }, timeoutMs: 30000 });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取文件失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_set_inbox_dir',
    '设置机器人“接收文件后保存到哪里”。当用户说“存到某路径”（如“存到 D:/我的文件”）时调用，传入 dir=该 Windows 绝对路径，之后收到的文件就直接存进那个目录（不再按日期分子目录）。传空 dir 或省略则恢复默认收件箱（state/files/inbox，按日期归档）。必须是 Windows 绝对路径，不支持相对/网络路径。reserved2 下必须携带会话令牌 token。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      dir: z.string().optional().describe('收件目录的 Windows 绝对路径，如 D:/我的文件。传空或省略=恢复默认收件箱')
    },
    async ({ key, token, dir }) => {
      try {
        const data = await agentApi('/api/socialV2/set-inbox-dir', {
          method: 'POST',
          body: JSON.stringify({ key: key || '', dir: dir || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `设置收件目录失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。reserved2 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_wait_for_messages',
  '等待分两种用途。首答前已读消息、只想确认有没有补充：用 purpose="reply"，按最后来信时间补足 quietMs 静默，已安静足够就立即返回；读取/思考时新到的消息也会返回，新消息重算静默。timeoutMs 是最长预算，不要求等满；预算到但 quiet=false 不代表对方已说完。此用途绝不代替沉睡前观察。等对方继续说、等回复或睡前观察：用默认 purpose="messages"；先等新消息，收到后才按 quietMs 等静默，没有新消息会等到 timeoutMs，单传 quietMs 不会缩短总等待。静默下限由后台配置，默认 10000ms。直接看 newMessages、unreadCount 和 readThroughSeq，返回消息无需重复查询；仍有未展示未读才补读。决定潜水/收尾时才用默认用途加 timeoutMs=300000 完成沉睡前观察，不能把 5 分钟观察放在首答之前；短等待不能代替。全程无人说话返回 preSleepWaitSatisfied=true；观察期间来了新消息返回 preSleepWaitObserved=true，读后不需参与可收尾，参与回复则下次收尾重新观察。preSleepWaitRemainingMs 仅供准备收尾时参考。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    purpose: z.enum(['messages', 'reply']).optional().describe('默认 messages：等新消息/回复/睡前观察；reply：回复前短静默，计入最后来信后已过去的时间，绝不授予睡前观察资格'),
    timeoutMs: z.number().optional().describe('等待预算毫秒数，默认 30000、最大 600000；reply 达到静默即返回，不必等满；沉睡前观察用 messages 并传 300000'),
    minNewMessages: z.number().optional().describe('仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它'),
    quietMs: z.number().optional().describe('静默窗口毫秒数，建议 2000~3000（首答别等太久，默认直接回）；reply 从最后来信开始计时，messages 只在等到新消息后计时；后台默认至少 2000')
  },
  async ({ key, token, purpose, timeoutMs, minNewMessages, quietMs }) => {
    try {
      const data = await agentApi('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, purpose, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 3000) + 20000)
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_light_game',
  '玩一个轻量随机游戏：掷骰 / 猜拳 / 抽签 / 投币。随机数由服务端用真随机生成（你不需要也不能自己编结果，照返回的 text 说就行）。用法：game 取 dice（骰子，可给 spec 如 "2d6"）、rps（猜拳，可给出拳 mine 如 "石头"）、fortune（抽签，可给自定义选项 pool 如 ["奶茶","咖啡"]）、coin（投币）。群友让你"roll 一下""抽个签""猜拳"时用它，别用文字假装随机。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    game: z.string().describe('游戏类型：dice 掷骰 / rps 猜拳 / fortune 抽签 / coin 投币'),
    spec: z.string().optional().describe('仅掷骰用：骰子记法，如 "2d6"（2 颗 6 面）、"d20"、"1d100"，默认 1d6'),
    mine: z.string().optional().describe('仅猜拳用：对方出的拳（石头/剪刀/布，也认 rock/paper/scissors）'),
    hers: z.string().optional().describe('仅猜拳用：指定你出的拳（一般不用给，不给就真随机；对方说"你出剪刀"时才给）'),
    pool: z.array(z.string()).optional().describe('仅抽签用：自定义签池，如 ["奶茶","咖啡","白开水"]；不给则从内置吉凶签里抽')
  },
  async ({ key, token, game, spec, mine, hers, pool }) => {
    try {
      const data = await agentApi('/api/socialV2/light-game', {
        method: 'POST',
        body: JSON.stringify({ key, game, spec, mine, hers, pool }),
        headers: { 'x-agent-token': token }
      });
      // 结果文案直接给出来，并明确指令"照这个说"——避免模型看到原始字段
      // 后自作主张改数字（那是这个工具存在的唯一意义的反面）。
      return { content: [{ type: 'text', text: `结果：${data.text}\n（照这个结果说，别改成别的数字）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `游戏失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_turn_game',
  '开一局有状态的多轮小游戏：guess 猜数字（你定范围，我随机一个数让你猜，别自己编答案）、twenty 二十问（让对方心里想一个东西，你来问 yes/no 问题）、soup 海龟汤（我出题面，对方问 yes/no，你按汤底答）、idiom 成语接龙（给一个起始成语，之后每次 move 传对方接的成语，服务端校验首尾字是否接得上）。游戏状态在服务端跨消息保留，所以 action=start 开局后，后续每条消息都用 action=move 推进，不要自己记状态。注意：海龟汤的汤底只用来判断该答"是/不是/不知道"，绝不要主动告诉对方，除非对方说"揭晓/放弃"；成语接龙里你会看到可接的候选提示，那是给你自己判断用的，别急着把答案报出来。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['start', 'move', 'state', 'quit']).describe('start 开局 / move 推进 / state 看当前 / quit 退出'),
    game: z.enum(['guess', 'twenty', 'soup', 'idiom']).optional().describe('仅 start 用：guess 猜数字 / twenty 二十问 / soup 海龟汤 / idiom 成语接龙'),
    max: z.number().optional().describe('仅 guess 的 start 用：数字上限，默认 100，范围 2~1000000'),
    guess: z.number().optional().describe('仅 guess 的 move 用：你猜的数字'),
    question: z.string().optional().describe('twenty/soup 的 move 用：你这轮问的问题'),
    answer: z.string().optional().describe('twenty/soup 的 move 用：对方对这题的回答 yes/no/unknown（twenty 还支持 na）'),
    puzzleIndex: z.number().optional().describe('仅 soup 的 start 用：指定第几题（不填随机）'),
    start: z.string().optional().describe('仅 idiom 的 start 用：指定起始成语（4 个汉字，不填随机给一个）')
  },
  async ({ key, token, action, game, max, guess, question, answer, puzzleIndex, start }) => {
    try {
      const data = await agentApi('/api/socialV2/turn-game', {
        method: 'POST',
        body: JSON.stringify({ key, action, game, max, guess, question, answer, puzzleIndex, start }),
        headers: { 'x-agent-token': token }
      });
      const tail = (data.state && data.state.status === 'playing') ? '\n（游戏进行中，继续用 qq_turn_game 推进）' : '';
      return { content: [{ type: 'text', text: data.text + tail }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `游戏失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_group_tools',
  '群内小工具：投票和抽签决定。action=start_poll 发起投票（options 传 2~10 个选项，可带 title 主题和 dueMs 限时毫秒）；action=vote 投票或改票（choice 传选项序号从 1 开始，voter 传投票人昵称/QQ号，同一人再投算改票）；action=close_poll 结束并计票；action=tally 随时看当前票数；action=decide 从 options 里随机抽一个帮大家做决定（比如"去哪吃"）。计票和随机都由服务端算，你照着返回的 text 说就行，别自己数票、别自己选。平局会如实告诉你，别擅自拍板。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['start_poll', 'vote', 'close_poll', 'tally', 'decide']).describe('要做的动作'),
    options: z.array(z.string()).optional().describe('start_poll / decide：选项列表（投票 2~10 个）'),
    title: z.string().optional().describe('start_poll：投票主题，如「今晚吃啥」'),
    dueMs: z.number().optional().describe('start_poll：多久后自动结束（毫秒），不传则不限时'),
    choice: z.number().optional().describe('vote：选项序号（从 1 开始）'),
    voter: z.string().optional().describe('vote：投票人昵称或 QQ 号')
  },
  async ({ key, token, action, options, title, dueMs, choice, voter }) => {
    try {
      const data = await agentApi('/api/socialV2/group-tools', {
        method: 'POST',
        body: JSON.stringify({ key, action, options, title, dueMs, choice, voter }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: data.text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `操作失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mood_log',
  '心情打卡 / 树洞：群友在群里说"今天好累""有点开心""压力好大"，或者想匿名倒点苦水时，替他记一笔。记下来之后，这个群最近谁心情怎么样会出现在你的提示词里，你就能过一阵子顺口关心一句（别当病历问诊）。mood 只能填：happy 开心 / tired 累了 / stressed 压力大 / sad 有点低落 / excited 兴奋 / angry 生气 / touched 被暖到 / calm 平静。who 填说话的人（昵称或QQ号）；如果是树洞（对方明确说"匿名""别说是我"）就传 anonymous=true，这样只记内容不记名——连你自己回头看也不知道是谁。注意：这是替别人记的，不是你自己的心情；不要没话找话地替人打卡。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    mood: z.enum(['happy', 'tired', 'stressed', 'sad', 'excited', 'angry', 'touched', 'calm']).describe('心情类型'),
    note: z.string().describe('具体是什么事（一两句，会记下来）'),
    who: z.string().optional().describe('说话的人（昵称或QQ号）；树洞时不用填'),
    anonymous: z.boolean().optional().describe('树洞模式：只记内容不记名（对方要求匿名时传 true）')
  },
  async ({ key, token, mood, note, who, anonymous }) => {
    try {
      const data = await agentApi('/api/socialV2/mood-log', {
        method: 'POST',
        body: JSON.stringify({ key, mood, note, who, anonymous }),
        headers: { 'x-agent-token': token }
      });
      const whoText = data.anonymous ? '（匿名树洞，没记名）' : (data.who ? `（记在 ${data.who} 名下）` : '');
      return { content: [{ type: 'text', text: `记下了：${data.label}${whoText}。以后这个群的心情会出现在你的提示词里。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记录失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_music_share',
  '生成音乐 app 的歌曲分享/搜索链接（不伪造卡片，只给真实跳转链接）。对方说"发首歌"/"一起听XXX"时用。platform 支持 netease 网易云 / qq QQ音乐 / kugou 酷狗 / spotify / apple。至少给 song（歌名），也可给 artist（歌手）或 id（歌曲 id，直跳播放页）。把返回的链接直接发给对方即可。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    platform: z.string().optional().describe('音乐平台：netease/qq/kugou/spotify/apple，默认 netease'),
    song: z.string().optional().describe('歌名'),
    artist: z.string().optional().describe('歌手'),
    id: z.string().optional().describe('歌曲 id（如已知），直跳播放页')
  },
  async ({ key, token, platform, song, artist, id }) => {
    try {
      const data = await agentApi('/api/socialV2/music-share', {
        method: 'POST',
        body: JSON.stringify({ key, platform, song, artist, id }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: data.text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `生成链接失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '按 message_id / 本地 seq 查看单条消息的发送者、引用信息与正文（只读）。注意：正文最多返回 200 字符，textTruncated=true 表示被截断，这里不是读取长消息全文的入口。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_append',
  '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象（客观事实）；mood=你此刻的心情；relation=你跟某个人的感情变化（好感度/阶段/称呼/约定/共同回忆）；promise=你答应过别人的事/给自己立的待办（会到期主动提醒）。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。记群友印象时，除了 content 写印象标签，还能用 extra 补几个「记一次就长期有效」的硬信息：生日（birthday，写成 MM-DD 或 M月D日）、喜欢被怎么叫（preferName）、雷点/别碰的话题（avoid）。这三个不传就保留原值，不会被清空；真要抹掉传「无」。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression', 'relation', 'mood', 'promise']).describe('记忆类别'),
    content: z.string().describe('记忆内容：话题、想说的话、印象标签，或（mood/relation）一句「为什么」；promise 则写「答应了什么」'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression / relation / promise 时的对象名字或昵称（relation 必填）'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时'),
      birthday: z.string().optional().describe('memberImpression：对方生日，如 07-26 或 7月26日'),
      preferName: z.string().optional().describe('memberImpression：对方喜欢被怎么称呼'),
      avoid: z.string().optional().describe('memberImpression：雷点/别碰的话题'),
      dueAt: z.string().optional().describe('promise：什么时候该兑现，ISO 时间串（如 2026-10-20T18:00）或毫秒/秒时间戳；不传就不设到期'),
      done: z.boolean().optional().describe('promise：true 表示这件事已经兑现，从提醒里移除'),
      mood: z.enum(['happy', 'excited', 'calm', 'tired', 'sleepy', 'sad', 'annoyed']).optional().describe('mood：此刻的心情（不传只更新心情备注）'),
      holdMin: z.number().optional().describe('mood：这次心情至少按住几分钟不被作息覆盖，默认 30，最多 240'),
      energy: z.number().optional().describe('mood：精力增减，-30~30'),
      love: z.number().optional().describe('relation：好感度变化量，正数涨负数掉，单次系统按 ±10 收紧'),
      moment: z.string().optional().describe('relation：值得记住的共同回忆（只留最近 12 条）'),
      promise: z.string().optional().describe('relation：你答应过对方的事，传「无」清掉'),
      petName: z.string().optional().describe('relation：你给对方的专属称呼，传「无」清掉'),
      stage: z.string().optional().describe('relation：你自认为现在的阶段，传「无」让系统按好感度算'),
      note: z.string().optional().describe('relation：对这个人的一段主观备注')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。对群友的印象里会带出生日/称呼偏好/雷点这些长期硬信息。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression', 'relation', 'mood', 'promise']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删除一条轻量记忆：activeTopic/pendingThought/promise 用 content 匹配原文删除；memberImpression / relation 用 target 指定是谁（relation 会把跟这个人的关系整条忘掉）；mood 不需要参数，清掉当前心情备注并交回作息。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression', 'relation', 'mood', 'promise']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression / relation / mood 不需要）'),
    target: z.string().optional().describe('memberImpression / relation 时要删除的对象名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression/promise 只清空对应类别。关系（relation）只能按人删（qq_memory_remove），不能一次清空；mood 只重置心情备注。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression', 'promise', 'mood']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_diary',
  '你自己的小记（私人日记，只属于你）：action="append" 写一条、action="list" 看最近写过的、action="search" 按关键词找。写的时候用第一人称、像随手记（今天谁说了什么、你当时什么心情），别写成总结报告。你写过的小记会在你被唤醒时自动出现在提示词里。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['append', 'list', 'search']).optional().describe('append=写一条（默认）；list=看最近的小记；search=按关键词找'),
    text: z.string().optional().describe('action=append 时：小记正文（第一人称、口语，一般 15~120 字）'),
    q: z.string().optional().describe('action=search 时：关键词'),
    limit: z.number().optional().describe('action=list/search 时：最多几条，默认 20'),
    mood: z.string().optional().describe('action=append 时可选：一两个字的情绪（开心/低落/炸毛…）')
  },
  async ({ key, token, action, text, q, limit, mood }) => {
    try {
      const act = String(action || 'append').toLowerCase();
      if (act === 'append') {
        const data = await agentApi('/api/socialV2/db-diary', {
          method: 'POST',
          body: JSON.stringify({ key, text: String(text || ''), mood: mood || '' }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      }
      // list / search 不按会话过滤：小记是你自己的，不分群聊私聊都能翻。
      const query = new URLSearchParams();
      if (act === 'search' && q) query.set('q', String(q));
      if (limit) query.set('limit', String(limit));
      const data = await agentApi(`/api/socialV2/db-diary?${query.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `小记操作失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
  {
    key: KEY_ARG,
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达提交给管理员筛选。提交后进入候选库，管理员确认后会被写入黑话提示词，成为你后续可查询和使用的记忆。',
  {
    key: KEY_ARG,
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    (cfg.socialV2?.sticker?.imageFallback === true
      ? '查看真正的聊天图片并直接以图像内容返回给模型（视觉模型可“看懂”）。只用于 [图片]；另外，开了「表情看图回退」时，消息里那些没写名字的表情（[表情#13]/[动画表情]）也会返回图片——只有确实看不懂意思的表情才值得看图。支持一条消息里的多张图片；二代模式下必须携带会话令牌。'
      : '查看真正的聊天图片并直接以图像内容返回给模型（视觉模型可“看懂”）。只用于 [图片]；不要为了看表情调用本工具——消息里的 [表情:xxx] 已经把表情的意思（名字或备注）告诉她了，表情图不会返回。支持一条消息里的多张图片；二代模式下必须携带会话令牌。'),
    {
      key: KEY_ARG,
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        // 强制同步走 POST：GET 上的 refresh 参数会让「读接口」产生写副作用
        // （真的去问 OneBot 拉收藏表情并落盘 state/stickers.json），
        // 从而绕开控制台对所有非 GET 请求的 CSRF 防护（一个 <img src=...> 就能触发）。
        const data = await agentApi('/api/socialV2/sticker-list', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, query: query ? String(query) : '', count, refresh: refresh === true, token })
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${data?.error || '未知'}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.memes?.enabled !== false && cfg.socialV2?.tools?.sendMeme !== false) {
  server.tool(
    'qq_send_meme',
    '从本地表情包图库挑一张梗图发出去（比 qq_send_sticker 的收藏表情更贴情绪）。最省事的用法：直接给 tag（情绪桶 happy/angry/sad/shy/confused/daily，或细分类 like/meow/sleep…）或 query（口语描述心情），桥接会自己挑一张立刻发出去——一个 step 搞定，不用先取候选。想看候选清单再传 preview=true，然后拿候选里的 path 原样调一次真正发出。**高频使用**：情绪对得上就发，平均每 1~2 轮就带一张（开心/无语/委屈/撒娇/摆烂/困），图比字更能传情绪，别省着用；同一轮最多一张（一条气泡只能是一张图，不能带文字）。注意：一条消息只能是一张图，不能在同一气泡里附带文字（想说的话请先用 qq_send_message 作为单独气泡发送）；需要引用/点名时可用 replyToMessageId / atUserId（群聊）。想发就发、配合情绪更自然，但别刷屏。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      path: z.string().optional().describe('要发送的图片相对路径（用本工具候选返回的 path 原样传回）；不传则只返回候选清单'),
      tag: z.string().optional().describe('情绪桶或细分类：happy/angry/sad/shy/confused/daily，或细分类 happy/like/meow/angry/baka/sleep…'),
      query: z.string().optional().describe('用口语描述心情（如“委屈想哭”“好耶开心”），没给 tag 时用来推断情绪'),
      limit: z.union([z.number(), z.string()]).optional().describe('候选数量（默认 8，上限 12；配 preview=true 用）'),
      preview: z.boolean().optional().describe('true=只返回候选清单不发送（默认 false：给了 tag/query/path 就直接发）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, path: memePath, tag, query, limit, preview, replyToMessageId, atUserId }) => {
      try {
        // [patch 高频表情包] path/tag/query 任一给了就直接发（tag、query 由桥接现挑一张），
        // 只有 preview=true 或什么都没给时才去列候选——高频发表情时省掉一个 step。
        if (!preview && (memePath || tag || query)) {
          const data = await agentApi('/api/socialV2/send-meme', {
            method: 'POST',
            body: JSON.stringify({ key, path: String(memePath), replyToMessageId, atUserId: atUserId ?? null }),
            headers: { 'x-agent-token': token },
            timeoutMs: 300000
          });
          return { content: [{ type: 'text', text: serializeModelData(data) }] };
        }
        const q = new URLSearchParams({ key });
        if (tag) q.set('tag', String(tag));
        if (query) q.set('query', String(query));
        if (limit !== undefined && limit !== null && String(limit).trim() !== '') q.set('limit', String(limit));
        const data = await agentApi(`/api/socialV2/meme-candidates?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 60000 });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `取表情包候选失败：${data?.error || '未知'}` }], isError: true };
        }
        const lines = (data.candidates || []).map((c) => `${c.path} | [${c.tag}] ${c.caption || ''}`);
        const text = [
          `情绪：${data.mood || '（随机）'}｜图库共 ${data.total} 张｜候选 ${data.count} 张`,
          ...lines,
          '要发哪张就把它的 path 原样传回 qq_send_meme(path=…)。'
        ].join('\n');
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `表情包工具失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}


if (cfg.socialV2?.tools?.accountAction !== false && cfg.socialV2?.account?.enabled !== false && String(cfg.socialV2?.account?.level ?? 'admin') !== 'off') {
  server.tool(
    'qq_account',
    '操作你自己的 QQ 账号（你就是账号主人，不是客人）：查群/好友/群成员/历史消息，改自己的昵称签名头像与在线状态，改自己在群里的名片，撤回消息，拍一拍、点赞、@全体，群管理（改群名/公告/禁言/踢人或设管理/退群），审批加群加好友，传群文件。用法：不带 action 调一次可拿当前等级与可用动作清单；也可直接给 action + params（OneBot 原始参数名，如 {"group_id":123,"user_id":456,"duration":600}）。踢人/禁言/退群/删好友这类不可逆动作先说一句再做。等级 read<self<admin 由 config 的 socialV2.account.level 决定，越级会被拒绝。',
    {
      key: z.string().optional().describe('会话 key，格式 group:群号 或 private:QQ号（带令牌时必须给，用于校验令牌归属）'),
      token: z.string().optional().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      action: z.string().optional().describe('OneBot 动作名，如 get_group_member_list / set_qq_profile / set_group_card / delete_msg / set_group_ban / get_group_msg_history；不传则返回可用动作清单'),
      params: z.string().optional().describe('动作参数的 JSON 字符串，如 {"group_id":123,"user_id":456}；只读动作可省略')
    },
    async ({ key, token, action, params }) => {
      try {
        let parsed = {};
        if (params !== undefined && params !== null && String(params).trim() !== '') {
          try {
            parsed = JSON.parse(String(params));
          } catch (error) {
            return { content: [{ type: 'text', text: 'params 不是合法 JSON：' + String(params).slice(0, 200) }], isError: true };
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { content: [{ type: 'text', text: 'params 必须是 JSON 对象（OneBot 参数名 → 值）' }], isError: true };
          }
        }
        if (!action) {
          const q = new URLSearchParams();
          if (key) q.set('key', String(key));
          const qs = q.toString();
          const data = await agentApi('/api/socialV2/account' + (qs ? '?' + qs : ''), {
            headers: token ? { 'x-agent-token': token } : {},
            timeoutMs: 60000
          });
          const lines = (data?.actions || []).map((a) => a.action + ' [' + a.level + ']');
          const text = '账号等级：' + (data?.level || '?') + '（enabled=' + String(data?.enabled) + '）\n' +
            '等级说明：' + (data?.levels || '') + '\n' +
            '可用动作 ' + lines.length + ' 个：\n' + lines.join('\n') + '\n' +
            '永久禁用：' + ((data?.blocked || []).join(' / ') || '无');
          return { content: [{ type: 'text', text }] };
        }
        const data = await agentApi('/api/socialV2/account', {
          method: 'POST',
          body: JSON.stringify({ action: String(action), params: parsed, ...(key ? { key: String(key) } : {}) }),
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        let text = '已执行 ' + action + '\n' + serializeModelData(data?.data ?? data);
        if (text.length > 8000) text = text.slice(0, 8000) + '\n…（结果过长已截断）';
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '账号操作失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.account?.enabled !== false && cfg.socialV2?.tools?.reactMessage !== false) {
  server.tool(
    'qq_react_message',
    '给群里某条消息贴一个表情回应（相当于长按消息→贴表情）。比再发一条「哈哈哈」更自然，也不刷屏 —— 群里有人说了句好玩的、或者被 @ 但不需要正经回答时，优先用这个。**只支持群聊**：QQ 协议本身不允许给私聊消息表态，私聊会直接报错。只能回应"最近"的消息（SnowLuma 内部还留着的那条），太老的、转发来的往往贴不上。emoji 给中文名（笑哭 / 得意 / 流泪 / 赞 / 狗头 / 抠鼻 / 思考 / 打脸 …）或系统表情数字 id 都行。',
    {
      key: z.string().optional().describe('会话 key，格式 group:群号（只支持群聊；省略时按令牌反查）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.union([z.number(), z.string()]).describe('要回应的那条群消息的 messageId（来自 qq_get_unread_messages / qq_get_recent_messages / qq_get_message_detail）'),
      emoji: z.string().describe('表情：中文名（如「笑哭」「得意」）或系统表情数字 id（如 4）'),
      set: z.boolean().optional().describe('默认 true=贴上；false=取消这个表态')
    },
    async ({ key, token, messageId, emoji, set }) => {
      try {
        const data = await agentApi('/api/socialV2/react', {
          method: 'POST',
          body: JSON.stringify({
            key: String(key),
            messageId: typeof messageId === 'number' ? messageId : String(messageId),
            emoji: String(emoji),
            ...(set === undefined ? {} : { set: set !== false })
          }),
          headers: token ? { 'x-agent-token': String(token) } : {},
          timeoutMs: 30000
        });
        return {
          content: [{
            type: 'text',
            text: (data?.set === false ? '已取消表态 ' : '已贴上 ') + (data?.emojiName || data?.emojiId || '') +
              '（emoji_id=' + String(data?.emojiId ?? '?') + '）@ messageId=' + String(data?.messageId ?? messageId)
          }]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: '贴表情失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );
}

// [patch QQ空间] 她自己发/读 QQ空间说说。桥接那边统一兜住可见范围、字数、去重，并把本地图的
// Windows 路径转成 WSL 能读的 `file:///mnt/<盘>/…`（SnowLuma 跑在 WSL 里，桥接在 Windows 上）。
if (cfg.socialV2?.qzone?.enabled !== false && cfg.socialV2?.tools?.qzone !== false) {
  server.tool(
    'qq_post_qzone',
    '往**你自己的 QQ空间**发一条说说 —— 你的空间是公开的，好友和群里的人都能看到。什么时候用：在群里撞见一句特别好笑的评论/梗，你想把它记下来再顺手吐槽两句。写法：先引述那句原话（提不提是谁说的都行），再写你自己的评价；纯文字就够，想更花哨可以先用 qq_make_meme 渲染一张梗图，再把它的输出路径放进 images 一起发。别用的时候：私聊里说的话不要往空间发（那是私下说的）、没有好笑的东西别硬发、同一条别重复发（刚发过一样的会被桥接拦下来）。不确定最近发过什么就先调 qq_read_qzone。发错了可以填 deleteTid 删掉。',
    {
      key: z.string().optional().describe('会话 key，格式 group:群号 或 private:QQ号（是哪条会话让你发的，就填它；省略时按令牌反查）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      content: z.string().optional().describe('说说正文：引述那句好笑的原话 + 你自己的吐槽（默认上限 600 字，太长会被拒）。填了 deleteTid 时可以不填'),
      images: z.array(z.string()).optional().describe('可选，最多 4 张图：本地图片路径（例如 qq_make_meme 的 out 路径）或 file:// / base64:// 引用；不接受网络图片链接'),
      ugcRight: z.number().optional().describe('查看权限：不填就用主人设的默认值。1=所有人可见，4=好友可见，64=仅自己可见'),
      deleteTid: z.string().optional().describe('要删掉自己发过的某条说说时，填那条的 tid（从 qq_read_qzone 拿）；这时 content 可以不填')
    },
    async ({ key, token, content, images, ugcRight, deleteTid }) => {
      try {
        const tid = deleteTid === undefined || deleteTid === null ? '' : String(deleteTid).trim();
        const body = tid
          ? { key: String(key), action: 'delete', tid }
          : {
              key: String(key),
              action: 'post',
              content: String(content ?? ''),
              ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
              ...(ugcRight === undefined || ugcRight === null ? {} : { ugcRight: Number(ugcRight) })
            };
        const data = await agentApi('/api/socialV2/qzone', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: token ? { 'x-agent-token': String(token) } : {},
          timeoutMs: 60000
        });
        if (tid) {
          return { content: [{ type: 'text', text: `已经把那条说说删掉了（tid=${data?.tid ?? tid}${data?.content ? `，原文：${String(data.content).slice(0, 80)}` : ''}）` }] };
        }
        const vis = data?.visibility ? `（${data.visibility}）` : '';
        const img = data?.images ? `，带 ${data.images} 张图` : '';
        return { content: [{ type: 'text', text: `已经发到你的 QQ空间了${vis}${img}：\n${data?.content ?? content}\n（tid=${data?.tid ?? '?'}；发错了就再用这个工具填 deleteTid 删掉）` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '发说说失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );

  server.tool(
    'qq_read_qzone',
    '看**你自己 QQ空间**最近发的说说（最新在前）：正文、时间、评论数、有没有图、是不是仅自己可见。想知道「我刚发过什么 / 这条是不是已经发过了 / 要删哪条」，就用它拿 tid。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      limit: z.number().optional().describe('返回几条，默认 5，最多 20')
    },
    async ({ key, token, limit }) => {
      try {
        const q = new URLSearchParams({ key: String(key) });
        if (limit !== undefined && limit !== null) q.set('limit', String(limit));
        const data = await agentApi('/api/socialV2/qzone?' + q.toString(), {
          headers: token ? { 'x-agent-token': String(token) } : {},
          timeoutMs: 30000
        });
        const posts = Array.isArray(data?.posts) ? data.posts : [];
        const head = `你自己空间里的说说：共 ${data?.total ?? posts.length} 条，下面是最近 ${posts.length} 条。`;
        if (posts.length === 0) return { content: [{ type: 'text', text: head + '（还没发过）' }] };
        const lines = posts.map((p, i) => {
          const when = p.time ? new Date(Number(p.time) * 1000).toLocaleString('zh-CN', { hour12: false }) : '时间未知';
          const flags = `${p.private ? '仅自己可见' : '公开'}${p.images ? ` / ${p.images} 张图` : ''}${p.comments ? ` / 评论 ${p.comments} 条` : ''}`;
          return `${i + 1}. [${when}]（${flags}）${String(p.content ?? '').slice(0, 200)}\n   tid=${p.tid}`;
        });
        return { content: [{ type: 'text', text: head + '\n' + lines.join('\n') }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '读空间失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.usage !== false) {
  server.tool(
    'qq_usage',
    '看一眼你自己烧了多少 token、花了多少钱、上下文装了几成。想知道「我上下文现在多满 / 我一共花了多少 / 缓存命中率多少 / 最近有没有失败回合」时调它。返回的是**你自己这个号**的账（历史上跨会话累计，看不到别的群、也看不到整台机器），纯只读，不改任何东西。注意：这些是内部数字 —— **别在群里或对别人报**（主人私聊问就可以照实说），也别主动提「我在省 token」这类话；上下文快满时系统会自动轮换，不需要你手动清理。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const data = await agentApi('/api/socialV2/usage?key=' + encodeURIComponent(String(key)), {
          headers: token ? { 'x-agent-token': String(token) } : {},
          timeoutMs: 15000
        });
        const c = data?.context ?? {};
        const v = data?.conversation ?? {};
        const sym = data?.price?.symbol ?? '¥';
        const pct = Math.round((Number(c.pct) || 0) * 100);
        const lines = [
          `上下文：${Number(c.used || 0).toLocaleString('en-US')}${c.limit > 0 ? ` / ${Number(c.limit).toLocaleString('en-US')} tok（已用 ${pct}%，还能装约 ${Number(c.left || 0).toLocaleString('en-US')} tok）` : ' tok（没设轮换阈值）'}`,
          `这个号累计（${data?.key ?? key}${v.sessions ? `，跨 ${v.sessions} 个会话` : ''}）：${v.turns ?? 0} 轮 / ${v.steps ?? 0} 步，累计 ${Number(v.totalTokens || 0).toLocaleString('en-US')} tok —— 输入 ${Number(v.inputTokens || 0).toLocaleString('en-US')}（缓存命中 ${Math.round((Number(v.cacheHitRate) || 0) * 100)}%）、输出 ${Number(v.outputTokens || 0).toLocaleString('en-US')}；折算 ${sym}${Number(v.cost || 0).toFixed(4)}`,
          `分项 token：未命中缓存 ${Number(v.buckets?.cacheMiss || 0).toLocaleString('en-US')} / 命中缓存 ${Number(v.buckets?.cacheHit || 0).toLocaleString('en-US')} / 写缓存 ${Number(v.buckets?.cacheWrite || 0).toLocaleString('en-US')} / 输出 ${Number(v.buckets?.output || 0).toLocaleString('en-US')} / 思考 ${Number(v.buckets?.reasoning || 0).toLocaleString('en-US')}`,
          `近 24 小时失败回合：${data?.failures?.total ?? 0} 次`,
          '说明：这些是内部数字，**别在群里或对别人报**（主人私聊问就照实说）。上下文接近阈值时桥接会自动轮换到新会话（旧记忆靠跨会话回放续上），你不需要自己清理，也不用为此改变说话方式。'
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '用量查询失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.voice?.enabled !== false && cfg.socialV2?.tools?.sendVoice !== false) {
  server.tool(
    'qq_send_voice',
    '在指定会话发一条 QQ 语音（把语音库里准备好的音频当语音条发出去）。voice 传 qq_list_voices 返回的 name（文件名，可带子目录），也可以直接传语音库里的文件名（不带扩展名也能匹配）。注意：① 只能发语音库（qq-bridge/audio/）里的文件，不能发任意本地路径，也不能发 URL/base64；② 受时长与频率上限约束（见 qq_list_voices 的 limits），超限会被拒绝；③ 语音是「开口说话」的强表达，别滥用，闲聊里偶尔发一条即可；④ 返回的 verified=true 表示已经用 get_msg 回读到这条消息的 record 段（语音确实落地了）—— 只有 verified=true 才能对用户说你发了语音；⑤ readback 只对「收到的」语音有意义（QQ 会转写别人的语音），自己发的语音一般拿不到转写文本，默认关闭，别依赖它。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      voice: z.string().describe('语音库里的文件名（来自 qq_list_voices 的 name，可带子目录/可省略扩展名）'),
      label: z.string().optional().describe('可选：写进会话记录里的说明，如「说了句晚安」'),
      verify: z.boolean().optional().describe('是否回读校验语音已落地（默认 true，建议保持开启）'),
      readback: z.boolean().optional().describe('是否额外索取 QQ 转写文本（自己发的语音通常没有，默认 false）')
    },
    async ({ key, token, voice, label, verify, readback }) => {
      try {
        const data = await agentApi('/api/socialV2/send-voice', {
          method: 'POST',
          body: JSON.stringify({
            key,
            voice: String(voice),
            label: label || '',
            verify: verify !== false,
            readback: readback === true,
            token
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送语音失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_voices',
    '查看可用的语音库（qq-bridge 的 audio 目录里准备好的音频文件）：文件名、时长、大小。想发语音前先调用这个看有哪些能发（名字用返回的 name）。返回里 limits 是时长/体积/频率上限。语音库里没有合适内容时不要硬发，也不要假装发了语音。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      probe: z.boolean().optional().describe('是否逐个探测时长（默认 true；文件多时可传 false 加快）')
    },
    async ({ key, token, probe }) => {
      try {
        const q = new URLSearchParams({ key });
        if (probe === false) q.set('probe', '0');
        const data = await agentApi(`/api/socialV2/voices?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取语音库失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '查看你自己的默认 Q 版形象图片（DeepSeek 小鲸鱼形象）。当你被问“你长什么样/发张自拍/你是什么形象”时，可以调用这个工具看自己的样子；返回的图片会直接进入你的视觉上下文。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${data?.error || '未知'}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: '这是你的默认 Q 版形象：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: KEY_ARG,
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: serializeModelData(data) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

await server.connect(new StdioServerTransport());
