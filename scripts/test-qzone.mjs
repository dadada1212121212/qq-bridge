// [patch QQ空间] 她自己发 QQ空间说说的回归网（离线，不需要 QQ 在线）。
//
// 为什么需要这个文件
// ------------------
// 这次加的是「她能在群里看到一句好笑的评论就发到 QQ空间、再顺手吐槽」的能力。链路是三段，
// 任何一段断了都只表现为「她好像没发」或「她发出去一张糊图」，而日志里未必看得出来：
//   ① preset 里得有一条规矩 + 两个工具名（源 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`
//      和**DSH 真正加载的产物** `plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml`，
//      只改源不重生成 patch = 她压根收不到这段规矩）；
//   ② MCP server 得真注册出 `qq_post_qzone` / `qq_read_qzone`（受 `socialV2.tools.qzone` 与
//      `socialV2.qzone.enabled` 两个开关管；漏登记 `TOOL_CONFIG_FLAGS` 的后果见该文件 216 行起）；
//   ③ 桥接端点得把本地图片的 **Windows 路径转成 WSL 能读的 `file:///mnt/<盘>/…`**
//      —— SnowLuma 跑在 WSL 里、桥接跑在 Windows 上，转错就是「图发不出去」。
// 第 ③ 条是本文件最有价值的断言：它把 bridge.js 里的 `qzoneImageRef` **源码抽出来真跑**，
// 而不是只 grep 关键字（grep 过的代码照样可以是错的）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

const bridgeSrc = read('src/bridge.js');
const mcpSrc = read('src/mcp-snowluma-safe.js');
const cfg = JSON.parse(read('config.json'));
const example = JSON.parse(read('config.example.json'));

// ── ① preset：源 + 产物都要有这一段 ─────────────────────────────────────────
console.log('## preset 规矩');
{
  const presetSrc = read('dsh/agent-presets/qq-chat-v2/agent.cordis.yml');
  const patch = read('plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml');
  ok(/qq_post_qzone/.test(presetSrc), 'preset 源提到 qq_post_qzone');
  ok(/qq_read_qzone/.test(presetSrc), 'preset 源提到 qq_read_qzone');
  ok(/私聊里说的[^。]*不要往空间发/.test(presetSrc), 'preset 源写明「私聊里说的不要往空间发」');
  ok(/qq_post_qzone/.test(patch), 'DSH 真正加载的 patch 产物里也有（只改源不重生成 = 她收不到）');
  ok(/QQ空间/.test(patch), 'patch 产物里带有 QQ空间 小节标题');
}

// ── ② MCP：真起 stdio server 列工具 ─────────────────────────────────────────
console.log('## MCP 工具注册（stdio 真起）');
{
  const qzoneOn = cfg.socialV2?.tools?.qzone !== false && cfg.socialV2?.qzone?.enabled !== false;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src/mcp-snowluma-safe.js')],
    cwd: ROOT,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'qzone-probe', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    if (!qzoneOn) {
      console.log('  ⏭  当前 config.json 关掉了 socialV2.qzone / tools.qzone，跳过注册断言');
    } else {
      ok(byName.has('qq_post_qzone'), '注册出 qq_post_qzone');
      ok(byName.has('qq_read_qzone'), '注册出 qq_read_qzone');
      const post = byName.get('qq_post_qzone');
      ok(!!post && /QQ空间/.test(post.description ?? ''), 'qq_post_qzone 描述里点明是往自己 QQ空间发');
      ok(!!post && /私聊里说的话不要往空间发/.test(post.description ?? ''), 'qq_post_qzone 描述里带着「私聊内容别外发」的护栏');
      ok(!!post && Object.keys(post.inputSchema?.properties ?? {}).includes('deleteTid'), 'qq_post_qzone 暴露 deleteTid（发错了能删）');
      const readTool = byName.get('qq_read_qzone');
      ok(!!readTool && Object.keys(readTool.inputSchema?.properties ?? {}).includes('limit'), 'qq_read_qzone 支持 limit');
    }
  } catch (error) {
    ok(false, `MCP server 接入失败：${error?.message ?? error}`);
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

// ── ③ 桥接端点 + 图片路径转换（抽源码真跑）──────────────────────────────────
console.log('## bridge 端点与 WSL 路径转换');
{
  ok(bridgeSrc.includes("url.pathname === '/api/socialV2/qzone'"), 'bridge 有 /api/socialV2/qzone 路由');
  ok(bridgeSrc.includes('file:///mnt/'), 'bridge 里带 Windows→WSL 的路径转换');
  ok(/\[1, 4, 64\]\.includes\(right\)/.test(bridgeSrc), '可见范围白名单是 1/4/64（16/128 要名单，明确拒绝）');
  ok(bridgeSrc.includes("oneBotCall('send_qzone_msg'"), '发说说走 OneBot send_qzone_msg');
  ok(bridgeSrc.includes("oneBotCall('delete_qzone_msg'"), '删说说走 OneBot delete_qzone_msg');
  ok(/socialV2\?\.qzone\?\.enabled !== false/.test(bridgeSrc), '默认开：qzone.enabled 未设置时为启用');

  // 把 qzoneImageRef 的源码切出来，注入假的 path/fs/cfg 真跑一遍。
  const start = bridgeSrc.indexOf('  function qzoneImageRef(raw) {');
  const end = bridgeSrc.indexOf('  function noteActiveChatKey(key) {');
  ok(start > 0 && end > start, '能在 bridge.js 里定位 qzoneImageRef 源码');
  if (start > 0 && end > start) {
    const src = bridgeSrc.slice(start, end);
    const make = (qzoneCfg) => new Function('path', 'fs', 'cfg', 'ROOT', `${src}\nreturn qzoneImageRef;`)(
      path, fs, { socialV2: { qzone: qzoneCfg } }, ROOT,
    );
    const strict = make({ allowRemoteImages: false });
    const loose = make({ allowRemoteImages: true });

    ok(strict('') === '', '空字符串 → 空（调用方过滤掉）');
    const local = strict('config.json');
    ok(/^file:\/\//.test(local) && local.endsWith('/config.json'), `相对路径 → file:// 引用（${local}）`);
    if (process.platform === 'win32') {
      ok(/^file:\/\/\/mnt\/[a-z]\//.test(local), 'Windows 盘符被转成 file:///mnt/<盘>/…（WSL 才读得到）');
      ok(!local.includes('\\'), '转换后不含反斜杠');
    }
    ok(strict('file:///mnt/c/x.png') === 'file:///mnt/c/x.png', 'file:// 引用原样透传');
    ok(strict('base64://AAAA') === 'base64://AAAA', 'base64:// 引用原样透传');

    let remoteRejected = false;
    try { strict('https://example.com/a.png'); } catch { remoteRejected = true; }
    ok(remoteRejected, '默认拒绝网络图片链接（主人只勾了「梗图渲染」，没勾「带群里看到的图片直链」）');
    ok(loose('https://example.com/a.png') === 'https://example.com/a.png',
      'allowRemoteImages=true 时才放行网络图片（开关真的接线了）');

    let missing = '';
    try { strict('C:\\definitely-missing\\nope.png'); } catch (error) { missing = String(error?.message ?? error); }
    ok(/找不到图片文件/.test(missing), '本地图不存在时报「找不到图片文件」（而不是把死路径丢给 SnowLuma）');
  }
}

// ── ④ 配置默认值（用户拍过板的四条）────────────────────────────────────────
console.log('## 配置默认值');
{
  const q = cfg.socialV2?.qzone ?? {};
  ok(q.enabled !== false, 'config.json：qzone 默认开');
  ok(q.ugcRight === 1, 'config.json：默认所有人可见（ugcRight=1，用户拍板）');
  ok(q.allowRemoteImages === false, 'config.json：默认不收网络图片链接（用户没勾这一项）');
  ok(q.allowImages === true, 'config.json：允许带图（梗图渲染那条）');
  ok(Number(q.maxImages) >= 1, 'config.json：带图有张数上限');
  ok(q.dedupeWindowMs > 0, 'config.json：同文去重窗口 > 0（不设频率上限，但不许连发同一条）');
  ok(cfg.socialV2?.tools?.qzone === true, 'config.json：tools.qzone 显式登记（控制台/文档可见）');

  const eq = example.socialV2?.qzone ?? {};
  ok(Object.keys(eq).length > 0, 'config.example.json 也带 qzone 段（模板对得上）');
  ok(eq.ugcRight === 1 && eq.allowRemoteImages === false, '出厂模板与真实配置同口径');
  ok(example.socialV2?.tools?.qzone === true, 'config.example.json：tools.qzone=true');
}

// ── ⑤ 边界没被放宽 ─────────────────────────────────────────────────────────
console.log('## 边界');
{
  // 注意：这个声明是缩进在函数体里的（`  const ACCOUNT_ACTION_LEVELS = {` … `  };`），
  // 用 `\n};` 会匹配不到 —— 这里按「起点 + 第一个顶格前的 `};`」切。
  const accStart = bridgeSrc.indexOf('const ACCOUNT_ACTION_LEVELS = {');
  const accEnd = accStart < 0 ? -1 : bridgeSrc.indexOf('\n  };', accStart);
  const block = accStart >= 0 && accEnd > accStart ? bridgeSrc.slice(accStart, accEnd) : '';
  ok(!!block, '能定位 ACCOUNT_ACTION_LEVELS');
  ok(!!block && !/qzone/i.test(block),
    '没有把 qzone 动作塞进 qq_account 白名单（她只能走专用端点，不能自己拼 OneBot 参数）');
  ok(mcpSrc.includes("qq_post_qzone: 'qzone'") && mcpSrc.includes("qq_read_qzone: 'qzone'"),
    'TOOL_CONFIG_FLAGS 登记了两个 qzone 工具（否则「控制台显示关着、模型仍收到 schema 再吃 403」）');
  const guard = read('plugins/qq-agent-presets/qq-tool-restrict.mjs');
  ok(/mcp__snowluma__/.test(guard) && /SAFE_PREFIXES/.test(guard),
    '工具守卫仍是前缀白名单 ⇒ 新工具不用单独登记名字（否则会静默拒绝）');
}

console.log(`\nQQ空间回归：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
