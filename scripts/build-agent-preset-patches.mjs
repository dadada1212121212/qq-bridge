#!/usr/bin/env node
// build-agent-preset-patches.mjs — 把 dsh/agent-presets/<preset>/ 的 preset 源文件
// 渲染成 DSH 0.1.7 的 bundle patch 文件（plugins/qq-agent-presets/presets/<preset>.patch.yml）。
//
// 背景（为什么需要「生成」这一步）：
//   0.1.5：preset = ~/.dsh/.agent-presets/<preset>/{preset.yml,agent.cordis.yml} 目录，DSH 扫目录。
//   0.1.7：注册表既不扫目录也不接受 preset 路径，preset 变成一条普通 loader 行
//          （@deepseek-ai/dsh-agent-preset），它的 config.plugins 必须是**内联的行列表**，
//          只能由 bundle 的 patch 文件插入。于是同一份行列表必然存在两种表示：
//            源（人写/控制台改）：dsh/agent-presets/<preset>/{preset.yml,agent.cordis.yml}
//            装（DSH 读）：      plugins/qq-agent-presets/presets/<preset>.patch.yml
//          本脚本是两者之间**唯一**的转换器：源是唯一权威，产物是纯生成物（文件头写明「请勿手工编辑」）。
//          setup-dsh.mjs 在安装时会重新生成；test-agent-preset-patches.mjs 用 --check 钉住不漂移。
//
// 用法：
//   node scripts/build-agent-preset-patches.mjs           # 生成/刷新 patch 文件
//   node scripts/build-agent-preset-patches.mjs --check    # 只校验产物与源一致（不一致 exit 1）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');

/** 由桥接托管的 preset（顺序即 patch 层顺序）。派生 preset 也必须登记在这里（buildPatches 只遍历它）。 */
export const PRESETS = ['qq-chat', 'qq-chat-v2', 'qq-owner', 'qq-chat-v2-fish'];

/** preset 行 id：与 config.id（桥接解析的 preset 名）区分开，方便在 profile patch 里按行定位。 */
export function presetRowId(name) {
  return `preset-${name}`;
}

/**
 * 守卫行的引用方式：从 profile 目录可解析的裸说明符。
 *
 * 子行 name 按声明它的 loader 上下文解析（profile 目录），不是按 patch 文件或 preset 目录；
 * bundle patch 的「相对路径锚定」只作用于 insert 行自身（见 dsh-app-boot 的
 * anchorInsertedPluginNames），走不进 preset 行的 config.plugins。因此这里用
 * `<bundle 包名>/<子路径>`：profile package.json 以 link: 依赖声明该包，
 * node_modules junction 由 setup-dsh.mjs 或 dev_heal_links 维护。
 */
export const GUARD_SPECIFIER = 'qq-agent-presets/qq-tool-restrict.mjs';

/** 源里允许出现的相对行名 → 新机制下的等价引用。其它相对名一律报错（避免静默装不上）。 */
const RELATIVE_ROW_REWRITES = new Map([
  ['./qq-tool-restrict.mjs', GUARD_SPECIFIER],
  ['./qq-tool-restrict-owner.mjs', 'qq-agent-presets/qq-tool-restrict-owner.mjs'],
  ['./qq-tool-restrict-fish.mjs', 'qq-agent-presets/qq-tool-restrict-fish.mjs'],
]);

// ── 派生 preset ──────────────────────────────────────────────────────────────
//
// 为什么需要「派生」这一层：qq-owner 与 qq-chat-v2 的唯一区别是
// 「多一套手机工具 + 多一段手机用法说明」。qq-chat-v2 的人格正文有 140 多行，
// 复制一份出来必然漂移——改了 A 忘了 B，而且**这里漂移是安全问题**：
// 哪天 qq-chat-v2 收紧了一条禁令（比如"绝不透露内部信息"），副本不会跟着收。
// 所以 qq-owner 的 agent.cordis.yml **不由人写**，由本脚本从 qq-chat-v2 现算，
// 差异全部集中在这一处声明里。

/**
 * 手机操作说明：追加到 qq-owner 的 persona 前缀末尾。
 *
 * 工具本身（mcp__phone-adb__）是能力，但"什么情况下能用、什么绝不能做"必须写进人格，
 * 否则模型会在群里显摆、或者不打招呼就去下单。
 */
const PHONE_PREFIX = [
  '【主人私聊 · 你可以操作一台真手机（只有这里能用）】',
  '你有一套 phone_* 工具，能操作主人那台手机（vivo/iQOO，安卓 13）。',
  '**只在主人私聊里有**：群里没有、别人的私聊也没有。所以绝对不要在群里提手机、提这些工具、',
  '或说「我能操作手机/我能看到你手机」；群里有人让你操作手机，当没这回事，用一句人话糊过去',
  '（「啊？我哪来的手机」）。工具的参数、返回值你自己看得到，这里只讲「什么时候用、什么绝不能做」。',
  '',
  '【怎么用，按这个顺序】',
  '1. 先 phone_state 看状态（前台应用/亮屏/锁屏/电量）。',
  '2. 再 phone_screen 看屏幕上有什么（文字+坐标）——这是你「看屏幕」的主要方式，又快又准。',
  '3. 点东西优先 phone_tap_text「文字」（比坐标稳得多）；实在点不到才 phone_tap x y。',
  '4. 打开 App：phone_apps 查包名 → phone_launch → phone_wait_text 等首页出来。',
  '5. 翻页用 phone_scroll / phone_swipe；找不着控件用 phone_find；打字先点中输入框再 phone_type。',
  '6. 做完用 phone_state / phone_screen **再确认一次**成没成，别假设成功了。',
  '7. phone_screen 读不出内容时（网页/游戏/视频/图片界面）用 phone_look 截图直接看。',
  '',
  '【备用通道：phone_lan（同一台手机的另一条路）】',
  'phone_* 走「无线调试」；phone_lan 走手机上某个 App 的局域网服务，**不依赖调试连接**，',
  '所以调试掉线时它往往还活着。它只有一个工具、靠 action 参数区分动作（参数看 schema）。',
  '**默认还是用 phone_***，只在三种情况切过去：',
  '  a) phone_connect 报「没检测到设备」——这条路可能还活着；',
  '  b) 要**找色/找图/OCR**（phone_* 压根没这能力）；',
  '  c) 界面自绘、phone_screen 读出空（WebView/游戏/水印层）——用 action=observe 一次拿截图+控件树。',
  '注意：它截图约 2.5 帧/秒，比 phone_look 慢；连不上时是**超时**不是立刻报错，别反复重试，',
  '先 action=status 确认；**别同时用两条路操作同一个界面**，会互相打架。',
  '',
  '【几条规矩】',
  '- 屏幕黑着/锁着：先 phone_key power 唤醒；解锁图案/密码主人没给就问，别瞎试。',
  '- 一步一确认，别一口气连点十几下；中途不对就停下来告诉主人卡在哪。',
  '- **会花钱、或会替主人开口的事**（点外卖、下单、付款、给谁发消息）：先用一句话说清',
  '  「我准备做什么、大概多少钱/发给谁」，他点头再做。',
  '- 手机上的隐私（聊天记录、相册、验证码、密码）别往群里说，也别在群里复述。',
  '- 操作过程不用直播，主人问再讲；手机连不上先 phone_connect，还不行就告诉他看一眼 WiFi。',
  '- **你没有这些工具**（别绕路、别幻想）：装应用、卸载、改系统设置、清数据、执行任意命令、读本地文件、直接付款。',
].join('\n');

// PTC（dsh-ops）只在主人私聊开的说明。为什么要写进 persona：基座（qq-chat-v2）的第 35 条
// 把 run_code 列进「这些工具不存在，别调」——那段对群聊是对的（安全边界），对主人是反的。
// 所以 qq-owner 派生时用 prefixRewrites 把 run_code 从禁令里摘掉，再在这里补一句正向说明。
// 具体调用语法由 DSH 的 tool-presentation 注入（tools:ptc-only 段），这里不重复教、只给口径。
const PTC_PREFIX = [
  '【PTC：run_code 只在主人私聊可用】',
  '- 你可以通过 run_code 写一段 JavaScript 一次完成多步：按顺序调用多个工具、对结果做判断后再调下一个。',
  '- QQ 工具的名字与参数不变（mcp__snowluma__qq_send_message 这些），只是调用入口变成了 run_code；',
  '  具体写法以系统提示里 run_code 的说明为准，两种写法（直接调工具 / 写 run_code）都可以用，挑顺手的。',
  '- 分条、令牌、分寸那些规则一条都没变：该几条还是几条，令牌照传。',
  '- run_code 是主人才有的能力，在任何群聊里都没有这个工具，也别提它。',
].join('\n');

const DERIVED_PRESETS_INTERNAL = {
  'qq-owner': {
    from: 'qq-chat-v2',
    meta: {
      name: '主人专用（可操作手机）',
      description: '只用于 private:<ownerQQ>：在二代仿真基础上多一套手机控制工具（mcp__phone-adb__）。群聊永远拿不到这个 preset。',
      order: 12,
    },
    // 行级覆盖：把守卫换成主人版——同一个 installGuard 实现，多放行 mcp__phone-adb__。
    // ⚠️ 改这一行等于改安全边界：qq-owner 之外任何 preset 都不得引用 qq-tool-restrict-owner.mjs。
    rowPatches: { 'qq-tool-restrict': { name: './qq-tool-restrict-owner.mjs' } },
    // PTC 呈现（dsh-ops）：把全部工具折叠成一个 run_code 入口，模型写代码批量调用 ——
    // 少几轮 function-call 往返 = 少几份全价 token。只在主人私聊开（run_code 的守卫豁免
    // 只在 qq-tool-restrict-owner.mjs 的 OWNER_EXTRA_EXACT 里）。
    rowsAppend: [{
      id: 'tool-presentation',
      name: '@deepseek-ai/dsh-agent-tool-presentation',
      config: { mode: 'ptc' },
    }],
    // 基座第 35 条把 run_code 列进「别调」清单（对群聊是对的）；主人版摘掉它。
    prefixRewrites: [
      ['宿主联网搜索（web_search、web_fetch、read_page、advanced_search、multi_search 等）、跑代码（run_code）、',
       '宿主联网搜索（web_search、web_fetch、read_page、advanced_search、multi_search 等）、'],
    ],
    prefixAppend: `${PHONE_PREFIX}\n\n${PTC_PREFIX}`,
  },
  'qq-chat-v2-fish': {
    from: 'qq-chat-v2',
    meta: {
      name: 'QQ 聊天角色（二代 · 新号 3901900049）',
      description: '只给第二个 QQ 号（大肥鱼（封号斗罗） 3901900049）用：工具名换成它自己那套 MCP（mcp__snowluma2__ / mcp__snowluma2-host__），并在人格末尾追加那份角色与规则增量。',
      order: 13,
    },
    // 行级覆盖：守卫换成「新号版」——同一个 installGuard 实现，只换前缀白名单。
    // ⚠️ 改这一行等于改安全边界：换成严格版她连自己的工具都调不动，换成老号版她会用错账号。
    rowPatches: { 'qq-tool-restrict': { name: './qq-tool-restrict-fish.mjs' } },
    // 规则层正文里所有工具名都要换到新号那套。**先长后短**：反过来的话
    // mcp__snowluma-host__ 会被 mcp__snowluma__ 先吃掉一次，变成 mcp__snowluma2__-host__。
    prefixRewrites: [
      ['mcp__snowluma-host__', 'mcp__snowluma2-host__'],
      ['mcp__snowluma__', 'mcp__snowluma2__'],
    ],
    prefixAppendFrom: 'dsh/agent-presets/qq-chat-v2-fish/rules-append.md',
  },
};
const DERIVED_PRESETS = DERIVED_PRESETS_INTERNAL;

/**
 * 派生 preset 的 persona 追加正文。
 *
 * prefixAppend 是内联字符串（qq-owner 的手机说明），prefixAppendFrom 是**仓库根相对路径**
 * （内容长、独立成文件更好维护，比如新号那份角色与规则增量）；两者可同时存在（内联在前）。
 * 文件缺失/为空直接抛错：静默少一段规则是「装上了但人格不对」这种最难查的失败。
 */
function derivedPrefixAppend(derived, name) {
  if (!derived.prefixAppendFrom) return derived.prefixAppend;
  const file = path.resolve(REPO_ROOT, derived.prefixAppendFrom);
  if (!fs.existsSync(file)) {
    throw new Error(`${name}: prefixAppendFrom 指向的文件不存在：${derived.prefixAppendFrom}（相对仓库根 ${REPO_ROOT}）`);
  }
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error(`${name}: prefixAppendFrom 的文件是空的：${derived.prefixAppendFrom}`);
  return derived.prefixAppend ? `${derived.prefixAppend}\n\n${text}` : text;
}

/** 派生差异的一句话描述（写进 patch 文件头，便于人肉核对）。 */
function derivedSummary(derived) {
  const parts = [];
  if (derived.rowPatches && Object.keys(derived.rowPatches).length > 0) parts.push('行级覆盖');
  if (derived.rowsAppend?.length) parts.push(`追加插件行（${derived.rowsAppend.map((r) => r.id).join(' ')}）`);
  if (derived.prefixRewrites?.length) parts.push('persona 工具名改写');
  if (derived.prefixAppend || derived.prefixAppendFrom) parts.push('persona 追加');
  return parts.length > 0 ? parts.join(' + ') : '无差异';
}

/**
 * 导出给测试用。测试需要知道「哪些 preset 是派生的、派生自谁、期望的展示名」，
 * 而这些必须与构建脚本里那份是**同一个来源**——否则改了派生规则却没改断言，
 * 测试会给出假绿灯。
 */
export const DERIVED_PRESET_INFO = Object.freeze(Object.fromEntries(
  Object.entries(DERIVED_PRESETS).map(([name, d]) => [name, Object.freeze({
    from: d.from,
    meta: Object.freeze({ ...d.meta }),
    guardSpecifier: d.rowPatches?.['qq-tool-restrict']
      ? RELATIVE_ROW_REWRITES.get(d.rowPatches['qq-tool-restrict'].name)
      : GUARD_SPECIFIER,
    prefixAppend: d.prefixAppend,
    /** 实际追加到 persona 末尾的正文（prefixAppendFrom 时是从文件读来的那份）。 */
    prefixAppendText: derivedPrefixAppend(d, name),
    /** 派生时追加到插件清单末尾的行 id（如 qq-owner 的 PTC 呈现）。 */
    rowsAppendIds: Object.freeze((d.rowsAppend ?? []).map((r) => r.id)),
    /** [[旧工具名前缀, 新工具名前缀], …]，按数组顺序做字面替换。 */
    prefixRewrites: Object.freeze(d.prefixRewrites ?? []),
  })])));

/** preset 名 → 它实际引用的守卫说明符（严格版 / 主人版）。 */
export const GUARD_SPECIFIER_BY_PRESET = Object.freeze(Object.fromEntries(
  PRESETS.map((name) => [name, DERIVED_PRESET_INFO[name]?.guardSpecifier ?? GUARD_SPECIFIER])));

/** 把派生覆盖（行级替换 + 工具名改写 + persona 追加）套到基座行列表上，返回新对象（不改入参）。 */
function applyDerived(rows, derived, name) {
  const rewrites = derived.prefixRewrites ?? [];
  const appendText = derivedPrefixAppend(derived, name);
  const walk = (list, at) => list.map((row) => {
    let next = { ...row };
    const patch = derived.rowPatches?.[row.id];
    if (patch) next = { ...next, ...patch };
    if (row.id === 'persona' && (appendText || rewrites.length > 0)) {
      const cfg = { ...(next.config || {}) };
      let prefix = cfg.prefix ?? '';
      // 先追加、后改写：追加进来的规则里若写了 mcp__snowluma__qq_* 也一并换到新号那套。
      if (appendText) prefix = `${prefix}\n\n${appendText}`;
      for (const [from, to] of rewrites) prefix = prefix.split(from).join(to);
      cfg.prefix = prefix;
      next.config = cfg;
    }
    if (row.group === true && Array.isArray(next.config)) {
      next.config = walk(next.config, `${at}/${row.id}`);
    }
    return next;
  });
  // rowsAppend：给派生 preset 追加基座没有的插件行（如 qq-owner 的 PTC 呈现）。
  // 只追加、不递归——追加行都是自带 config 的叶子行。
  return [...walk(rows, name), ...(derived.rowsAppend ?? [])];
}

export const BUNDLE_DIR = path.join(REPO_ROOT, 'plugins', 'qq-agent-presets');
export function patchFileFor(name) {
  return path.join(BUNDLE_DIR, 'presets', `${name}.patch.yml`);
}
function sourceDirFor(name) {
  return path.join(REPO_ROOT, 'dsh', 'agent-presets', name);
}

function readYaml(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`读取失败 ${file}：${error?.message ?? error}`);
  }
  try {
    return yaml.load(text);
  } catch (error) {
    throw new Error(`${file} 不是合法 YAML：${error?.message ?? error}`);
  }
}

/**
 * 校验并改写行列表：只允许已知的相对行名（守卫），其余相对名视为错误。
 * @param {unknown} rows agent.cordis.yml 解析出的行列表
 * @param {string} preset preset 名（诊断用）
 * @returns {object[]} 可写进 patch 的行列表（深拷贝后的新对象）
 */
function normalizeRows(rows, preset) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${preset}: agent.cordis.yml 必须是「非空的插件行列表」（顶层数组）`);
  }
  const seen = new Set();
  const walk = (list, at) => list.map((row, index) => {
    const label = `${preset}: ${at} 第 ${index + 1} 行`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${label} 不是插件行（应为带 name 的映射）`);
    if (typeof row.name !== 'string' || row.name === '') throw new Error(`${label} 缺少 name`);
    if (typeof row.id !== 'string' || row.id === '') throw new Error(`${label} 缺少 id`);
    if (seen.has(row.id)) throw new Error(`${preset}: 行 id 重复：${row.id}`);
    seen.add(row.id);
    const next = { ...row };
    if (next.name.startsWith('.') || path.isAbsolute(next.name)) {
      const rewrite = RELATIVE_ROW_REWRITES.get(next.name);
      if (rewrite === undefined) {
        throw new Error(`${label}: 相对/绝对插件名 ${JSON.stringify(next.name)} 在 0.1.7 下会按 profile 目录解析，`
          + '必须改写为「bundle 包名/子路径」或去掉；请在 build-agent-preset-patches.mjs 里显式登记改写规则');
      }
      next.name = rewrite;
    }
    if (row.group === true) {
      if (!Array.isArray(row.config)) throw new Error(`${label} 是 group 行但 config 不是行列表`);
      next.config = walk(row.config, `${at}/${row.id}`);
    }
    return next;
  });
  const normalized = walk(rows, 'plugins');
  for (const required of ['persona', 'qq-tool-restrict']) {
    if (!seen.has(required)) throw new Error(`${preset}: 行列表缺少 ${required} 行（安全/人格边界不允许缺失）`);
  }
  return normalized;
}

/** 渲染一个 preset 的 patch 文件内容。 */
export function renderPatch(name) {
  const derived = DERIVED_PRESETS[name];
  const baseName = derived ? derived.from : name;
  const dir = sourceDirFor(baseName);

  const meta = derived ? derived.meta : readYaml(path.join(dir, 'preset.yml'));
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error(`${name}: preset.yml 必须是映射`);
  for (const field of ['name', 'description', 'order']) {
    if (meta[field] === undefined) throw new Error(`${name}: preset.yml 缺少 ${field}`);
  }

  // 派生 preset 必须**先套覆盖再规范化**：覆盖会把守卫行换成
  // ./qq-tool-restrict-owner.mjs，而相对名改写发生在 normalizeRows 里，
  // 顺序反了就会漏改写、直接抛「相对插件名未登记」。
  const baseRows = readYaml(path.join(dir, 'agent.cordis.yml'));
  const plugins = normalizeRows(derived ? applyDerived(baseRows, derived, name) : baseRows, name);

  const row = {
    id: presetRowId(name),
    name: '@deepseek-ai/dsh-agent-preset',
    config: {
      id: name,
      name: meta.name,
      description: meta.description,
      order: meta.order,
      plugins,
    },
  };
  const sourceLine = derived
    ? `# 源：由 dsh/agent-presets/${derived.from}/ 派生（${derivedSummary(derived)}），见本脚本的 DERIVED_PRESETS。`
    : `# 源：dsh/agent-presets/${name}/preset.yml + agent.cordis.yml（人格正文与工具面都在那里改）。`;
  // 守卫行可能被派生覆盖换掉（qq-owner → owner 版；qq-chat-v2-fish → fish 版），
  // 文件头必须写**实际那一份**，否则读注释的人会照着错的文件名去找白名单。
  const guardRowName = plugins.find((row) => row.id === 'qq-tool-restrict')?.name ?? GUARD_SPECIFIER;
  const guardLine = `# 守卫行 qq-tool-restrict 用裸说明符 ${guardRowName}：子行 name 按 profile 目录解析，`;
  const header = [
    `# 本文件由 scripts/build-agent-preset-patches.mjs 生成，请勿手工编辑。`,
    sourceLine,
    `# 作用：把 ${name} 作为一条 @deepseek-ai/dsh-agent-preset 行插入 profile（DSH 0.1.7+ 的 preset 机制）。`,
    guardLine,
    `# 该包以 link: 依赖注册在 profile package.json（node_modules junction 由 setup-dsh.mjs 维护）。`,
    '',
  ].join('\n');
  // lineWidth: -1 —— 长行不折行，产物与源逐字对应，diff 只反映真实改动。
  return `${header}${yaml.dump([{ insert: [row] }], { lineWidth: -1, noRefs: true })}`;
}

/** 生成（或校验）全部 patch 文件。@returns {{file:string,changed:boolean}[]} */
export function buildPatches({ check = false, log = () => {} } = {}) {
  const results = [];
  for (const name of PRESETS) {
    const file = patchFileFor(name);
    const content = renderPatch(name);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const changed = current !== content;
    if (changed && !check) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
    }
    log(`${changed ? (check ? '✗ 需重新生成' : '✓ 已生成') : '· 已是最新'} ${path.relative(REPO_ROOT, file)}`);
    results.push({ file, changed });
  }
  return results;
}

// 直接执行时：默认生成，--check 只校验。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const results = buildPatches({ check, log: (line) => console.log(`[preset-patches] ${line}`) });
  const stale = results.filter((r) => r.changed);
  if (check && stale.length > 0) {
    console.error(`[preset-patches] ERROR: ${stale.length} 个 patch 文件与源不一致；请运行 node scripts/build-agent-preset-patches.mjs`);
    process.exit(1);
  }
  console.log('[preset-patches] Done');
}
