#!/usr/bin/env node
// setup-dsh.mjs — 在目标设备上安装 qq-bridge 的 DSH 端配置
//
// 功能：
//   1. 安装两套 agent preset：qq-chat、qq-chat-v2
//      （DSH 0.1.7 机制：作为 qq-agent-presets bundle 的 patch 层插入
//        @deepseek-ai/dsh-agent-preset 行；~/.dsh/.agent-presets/ 目录已不再被读取）
//   2. 在 DSH profile 的 cordis.patch.yml 中挂载三个 MCP server：
//      mcp-snowluma / mcp-snowluma-host / mcp-web-search-safe
//   3. 在 profile package.json 中注册两个 bundle：qq-mode-console、qq-agent-presets
//
// 用法：
//   node scripts/setup-dsh.mjs [profile]
//
// 默认 profile 为 web；可用环境变量 DSH_HOME 指定 DSH 根目录。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { BUNDLE_DIR, PRESETS, buildPatches, patchFileFor } from './build-agent-preset-patches.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = process.argv[2] || 'web';

// A profile is a directory name, never a path (same boundary as DSH itself).
if (PROFILE === '.' || PROFILE === '..' || PROFILE === 'node_modules'
    || /[\\/\x00-\x1f<>:"|?*]/.test(PROFILE) || /[. ]$/.test(PROFILE)) {
  fatal(`invalid profile name: ${JSON.stringify(PROFILE)}`);
}

function log(msg) {
  console.log(`[setup-dsh] ${msg}`);
}

function fatal(msg) {
  console.error(`[setup-dsh] ERROR: ${msg}`);
  process.exit(1);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * 备份一个即将被覆盖的文件。
 *
 * 为什么不用 `flag: 'wx'`（写一次就永不更新）：那样第一次安装会留下一个备份，
 * 之后每次 setup 都静默跳过 —— 用户后来手工改过的内容再被覆盖时，桌上那份备份
 * 早已过期，等于「有备份但救不回来」。改为每次覆盖前打时间戳快照，只保留最近 N 份。
 */
function backupBeforeOverwrite(file, keep = 5) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.bak-${stamp}`;
  try {
    fs.copyFileSync(file, dest);
  } catch (error) {
    log(`⚠️ 备份失败（${file}）：${error?.message ?? error}；继续但请自行确认原内容`);
    return null;
  }
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.bak-`;
    const snaps = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
    // 时间戳升序 ⇒ 前面的是最旧的，只保留最后 keep 份
    for (const f of snaps.slice(0, Math.max(0, snaps.length - keep))) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch {}
  return dest;
}

// ── agent preset：DSH 0.1.7 机制 ─────────────────────────────────────────────
//
// 0.1.5：preset 是 ~/.dsh/.agent-presets/<preset>/ 下的目录，DSH 启动时扫目录装载。
// 0.1.7：注册表既不扫目录也不接受 preset 路径；preset 是一条普通 loader 行
//        （@deepseek-ai/dsh-agent-preset，config.plugins 内联子行列表），
//        由 bundle 的 patch 文件插入。因此这里做两件事：
//          ① 把 qq-agent-presets bundle 注册进 profile（link: 依赖 + bundles + junction）；
//          ② 从仓库权威源（dsh/agent-presets/<preset>/）重新生成 patch 文件。
//        旧目录不再写入、也不删除（见 reportLegacyPresetDir）。
// bundle 名字表见下方（依赖 PHONE_ADB_DIR，所以在它定义之后再声明）。

/** 从仓库源重新生成 bundle 里的 patch 文件（人格正文/工具面改了就必须重跑）。 */
function regeneratePresetPatches() {
  const results = buildPatches({ log: () => {} });
  for (const { file, changed } of results) {
    log(`preset patch ${changed ? '已生成' : '已是最新'}: ${path.relative(REPO_ROOT, file)}`);
  }
  for (const name of PRESETS) {
    const file = patchFileFor(name);
    if (!fs.existsSync(file)) fatal(`preset patch 未生成：${file}`);
  }
}

/**
 * 旧机制的安装目录：0.1.7 起 DSH 完全不再读它。
 *
 * 这里**只报告、不删除**——里面可能是用户手改过的人设（仓库源文件救不回来）。
 * 顺带对比仓库源：一致说明没丢东西，不一致说明用户改的那份已不再生效，需要人工合并。
 */
function reportLegacyPresetDir() {
  const legacy = path.join(DSH_HOME, '.agent-presets');
  if (!fs.existsSync(legacy)) return;
  log(`注意：${legacy} 是 DSH 0.1.5 的 preset 安装目录，0.1.7 起不再被读取（保留未删，可自行备份后清理）`);
  for (const name of PRESETS) {
    const installed = path.join(legacy, name, 'agent.cordis.yml');
    if (!fs.existsSync(installed)) continue;
    const source = path.join(REPO_ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
    const same = fs.existsSync(source) && fs.readFileSync(installed, 'utf8') === fs.readFileSync(source, 'utf8');
    log(same
      ? `  · ${name}：旧目录副本与仓库源一致（无内容丢失）`
      : `  ⚠️ ${name}：旧目录副本与仓库源**不一致**——那份手改内容不会再生效，请人工合并到 dsh/agent-presets/${name}/agent.cordis.yml`);
  }
}

function yamlSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * 老号之外的额外桥接安装（第二个/第三个 QQ 账号）。
 *
 * 为什么必须单独一对 MCP：`src/mcp-snowluma-safe.js` 用 `path.resolve(__dirname, '..')`
 * 定位自己的 ROOT，每次调用都重读 `<ROOT>/config.json`（控制台端口/令牌、snowluma 端点、
 * 白名单都在那）。所以第二个账号必须指向**它自己那份** `src/mcp-snowluma-safe.js`，
 * 否则新号的工具调用会打到老号桥接上 —— 那是"用错账号发消息"这种最难发现的错。
 *
 * serverName 必须带后缀（`snowluma2`/`snowluma2-host`）：两套 MCP 工具同名会撞车。
 *
 * 来源（两者都读，合并去重）：
 *   · 环境变量 `QQ_EXTRA_BRIDGES`（用 path 分隔符分隔多个目录）
 *   · `<REPO_ROOT>/extra-bridges.json`：`{ "roots": ["<安装目录>", { "root": "...", "slot": 3 }] }`
 *     slot 决定 serverName 后缀（默认按出现顺序 2、3、4…；写了 slot 就用它）。
 */
function resolveExtraBridges() {
  const raw = [];
  if (process.env.QQ_EXTRA_BRIDGES) raw.push(...process.env.QQ_EXTRA_BRIDGES.split(path.delimiter));
  const registry = path.join(REPO_ROOT, 'extra-bridges.json');
  if (fs.existsSync(registry)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(registry, 'utf8'));
      if (parsed && Array.isArray(parsed.roots)) raw.push(...parsed.roots);
    } catch (error) {
      log(`⚠️ extra-bridges.json 解析失败（已跳过额外桥接）：${error?.message ?? error}`);
    }
  }
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const spec = typeof item === 'string' ? { root: item } : (item || {});
    const root = path.resolve(String(spec.root ?? '').trim());
    if (!root || root === REPO_ROOT || seen.has(root)) continue;
    const script = path.join(root, 'src', 'mcp-snowluma-safe.js');
    if (!fs.existsSync(script)) {
      log(`⚠️ 跳过额外桥接 ${root}：找不到 ${script}`);
      continue;
    }
    seen.add(root);
    out.push({ root, slot: Number.isInteger(spec.slot) ? spec.slot : out.length + 2 });
  }
  return out;
}

const EXTRA_BRIDGES = resolveExtraBridges();
/** 额外桥接的 MCP 条目 id（`mcp-snowluma-<slot>` / `mcp-snowluma-host-<slot>`）。 */
const EXTRA_MCP_IDS = EXTRA_BRIDGES.flatMap((b) => [`mcp-snowluma-${b.slot}`, `mcp-snowluma-host-${b.slot}`]);

// 由桥接托管的 MCP 条目 id：脚本对这几个 id 拥有所有权，可安全地按 id 增删。
const MANAGED_MCP_IDS = ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe', 'mcp-phone-adb', ...EXTRA_MCP_IDS];

// 手机控制工具的仓库位置：与本仓库同级（ungrouped/phone-adb），可用环境变量覆盖。
const PHONE_ADB_DIR = process.env.PHONE_ADB_DIR || path.resolve(REPO_ROOT, '..', 'phone-adb');

// bundle 名字 → 仓库内源目录。分两张表是因为**新 bundle 不在 qq-bridge/plugins/ 下**：
// dsh-phone-agent 是第三方 DSH 插件（作者 sktyou），放在 phone-adb 目录下——它和
// "手机控制"是同一件事，不混进 qq-bridge 自己的插件目录里。
// 声明位置必须在 PHONE_ADB_DIR 之后（const 有暂时性死区，提前用会 ReferenceError）。
const BUNDLE_NAMES = ['qq-mode-console', 'qq-agent-presets', 'dsh-phone-agent'];
const BUNDLE_SOURCES = {
  'qq-mode-console': path.join(REPO_ROOT, 'plugins', 'qq-mode-console'),
  'qq-agent-presets': path.join(REPO_ROOT, 'plugins', 'qq-agent-presets'),
  'dsh-phone-agent': path.join(PHONE_ADB_DIR, 'dsh-phone-agent-plugin'),
};

// dsh-phone-agent 的手机 IP：它自带 cordis.patch.yml 里写的是作者的示例 IP
// （192.168.12.138），照抄会连到不存在的机器上。这里从 phone-adb/state.json 读真实 IP，
// 生成时替换掉，免得每次都要人肉去改那个文件。
const PHONE_AGENT_PATCH = path.join(BUNDLE_SOURCES['dsh-phone-agent'], 'cordis.patch.yml');

/**
 * 找一个能跑 mcp_phone_adb.py 的 Python。
 *
 * 为什么允许"找不到"而不是 fatal：手机控制是**可选能力**，装不上不该让整套 QQ 桥接
 * 配置装不成。找不到时跳过这一条 MCP 并大声提示，其余部分照常。
 */
function findPython() {
  const candidates = [
    process.env.PHONE_ADB_PYTHON,
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
    'C:\\Python313\\python.exe',
    'C:\\Python312\\python.exe',
    '/usr/bin/python3',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which',
      [process.platform === 'win32' ? 'python' : 'python3'],
      { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const first = String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (first) return first;
  } catch {}
  return '';
}

function mcpEntries() {
  const node = process.execPath;
  const python = findPython();
  const phoneScript = path.join(PHONE_ADB_DIR, 'mcp_phone_adb.py');
  const servers = {
    'mcp-snowluma': { serverName: 'snowluma', script: path.join(REPO_ROOT, 'src', 'mcp-snowluma-safe.js'), toolCallTimeoutMs: 725000 },
    'mcp-snowluma-host': { serverName: 'snowluma-host', script: path.join(REPO_ROOT, 'src', 'mcp-host-server.js') },
    'mcp-web-search-safe': { serverName: 'web-search-safe', script: path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js') },
    // 手机控制：用 Python 跑（零依赖、直接 import phone.py；见 phone-adb/mcp_phone_adb.py 头部说明）。
    'mcp-phone-adb': python && fs.existsSync(phoneScript)
      ? { serverName: 'phone-adb', command: python, args: [phoneScript] }
      : null,
  };
  for (const bridge of EXTRA_BRIDGES) {
    const base = `snowluma${bridge.slot}`;
    servers[`mcp-snowluma-${bridge.slot}`] = {
      serverName: base,
      script: path.join(bridge.root, 'src', 'mcp-snowluma-safe.js'),
      toolCallTimeoutMs: 725000,
    };
    servers[`mcp-snowluma-host-${bridge.slot}`] = {
      serverName: `${base}-host`,
      script: path.join(bridge.root, 'src', 'mcp-host-server.js'),
    };
  }
  if (!servers['mcp-phone-adb']) {
    log(`⚠️ 跳过 mcp-phone-adb：${!python ? '找不到 Python' : '找不到 ' + phoneScript}`
      + '（可用 PHONE_ADB_PYTHON / PHONE_ADB_DIR 指定；不影响其它 MCP）');
    delete servers['mcp-phone-adb'];
  }
  let out = '# === qq-bridge MCP BEGIN ===\n';
  out += '# 由 scripts/setup-dsh.mjs 维护；这段区块会被整体替换，请勿手工编辑内部条目。\n';
  for (const [id, s] of Object.entries(servers)) {
    const command = s.command || node;
    const args = s.args || [s.script];
    out += `- insert:\n`;
    out += `    - id: ${id}\n`;
    out += `      name: '@deepseek-ai/dsh-mcp-client'\n`;
    out += `      config:\n`;
    out += `        serverName: ${s.serverName}\n`;
    out += `        transport: stdio\n`;
    out += `        command: ${yamlSingleQuote(command)}\n`;
    out += `        args:\n`;
    for (const a of args) out += `          - ${yamlSingleQuote(a)}\n`;
    // qq_wait_for_messages 最长可等 10 分钟；DSH 默认 60s 会提前掐断工具调用。
    if (s.toolCallTimeoutMs) out += `        toolCallTimeoutMs: ${s.toolCallTimeoutMs}\n`;
  }
  out += '# === qq-bridge MCP END ===\n';
  return out;
}

function prepareCordisPatch() {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const original = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  const lines = original.replace(/^\uFEFF/, '').split(/\r?\n/);
  // Repair only the historical invalid *root* [] followed by block operations.
  // A nested [] or a line inside a literal scalar is user data and must survive.
  const first = lines.findIndex((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (first >= 0 && lines[first].trim() === '[]'
      && lines.slice(first + 1).some((line) => /^-\s/.test(line))) {
    lines.splice(first, 1);
  }
  let doc;
  try { doc = yaml.load(lines.join('\n')) ?? []; }
  catch (error) { fatal(`failed to parse ${patchFile}; file unchanged: ${error.message}`); }
  if (!Array.isArray(doc)) fatal(`${patchFile} must contain a YAML array; file unchanged`);
  let removed = 0;
  const kept = [];
  for (const operation of doc) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      fatal(`invalid patch operation in ${patchFile}; file unchanged`);
    }
    if (!Object.hasOwn(operation, 'insert')) { kept.push(operation); continue; }
    if (!Array.isArray(operation.insert)) fatal(`insert must be an array in ${patchFile}; file unchanged`);
    const entries = operation.insert.filter((entry) => {
      if (!MANAGED_MCP_IDS.includes(entry?.id)) return true;
      removed++;
      return false;
    });
    // Retain shared insert parents and their selectors/other operation fields.
    if (entries.length || Object.keys(operation).length > 1) kept.push({ ...operation, insert: entries });
  }
  const text = (kept.length ? `${yaml.dump(kept, { lineWidth: -1, noRefs: true })}\n` : '') + mcpEntries();
  return { patchFile, original, text, removed };
}

function patchCordis({ patchFile, original, text, removed }) {
  ensureDir(path.dirname(patchFile));
  // Parsing/serialization normalizes formatting; keep the original text (including comments).
  if (original && original !== text) {
    backupBeforeOverwrite(patchFile);
  }
  const temporary = `${patchFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, patchFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  log(`cordis.patch.yml: MCP 条目已同步（清理旧条目 ${removed} 条，写入 ${MANAGED_MCP_IDS.length} 条）`);
}

/**
 * 建一个指向本仓库的目录链接（Windows 用 junction，免管理员权限）。
 *
 * 链接已存在时校验指向：指向本仓库 ⇒ 跳过（幂等）；指向别处/悬空 ⇒ 重建。
 * 指向别处说明用户手工挪过文件，这里按"重装"处理并明确打印。
 */
function ensureDirLink(linkPath, targetDir, label) {
  if (!fs.existsSync(targetDir)) fatal(`${label} 源目录不存在: ${targetDir}`);
  ensureDir(path.dirname(linkPath));

  let existing = null;
  try {
    existing = fs.lstatSync(linkPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') fatal(`failed to inspect ${label}: ${error?.message ?? error}`);
  }

  if (existing) {
    if (!existing.isSymbolicLink()) {
      fatal(`${label} 已存在且不是符号链接/junction: ${linkPath}。请先手工移走或删除，然后重跑。`);
    }
    let sameTarget = false;
    try {
      const target = fs.realpathSync(linkPath);
      const expected = fs.realpathSync(targetDir);
      sameTarget = process.platform === 'win32'
        ? String(target).toLowerCase() === String(expected).toLowerCase()
        : String(target) === String(expected);
    } catch {}
    if (sameTarget) {
      log(`${label} 已存在且指向本仓库: ${linkPath}`);
      return linkPath;
    }
    log(`${label} 存在但指向别处/失效，重建: ${linkPath}`);
    fs.rmSync(linkPath, { recursive: true, force: true });
  }

  try {
    if (process.platform === 'win32') {
      fs.symlinkSync(targetDir, linkPath, 'junction');
    } else {
      fs.symlinkSync(targetDir, linkPath, 'dir');
    }
    log(`${label} 已创建: ${linkPath}`);
  } catch (e) {
    fatal(`failed to create ${label}: ${e.message}`);
  }
  return linkPath;
}

/**
 * 把仓库里的 bundle 包接进 profile。
 *
 * 两层链接，与 `dsh plugin install`（pnpm）物化出的形态一致：
 *   ~/.dsh/plugins/<name>  → 仓库目录（人工可读的"安装位"）
 *   <profile>/node_modules/<name> → ~/.dsh/plugins/<name>（Node 解析路径）
 * 第二层必须自己建：preset 子行按 profile 目录解析裸说明符
 * （qq-agent-presets/qq-tool-restrict.mjs），缺了它 preset 会整条挂载失败。
 */
/**
 * dsh-phone-agent 需要一层**额外的** node_modules 链接，别的 bundle 不需要。
 *
 * 为什么必须有（2026-10-12 实测踩出来的）：这个插件的入口是
 * `lib/index.js`，里面用裸 import 语句引 `@deepseek-ai/dsh-tools`。
 * Node 解析裸说明符时是**从导入文件所在目录往上找到第一个 node_modules**——
 * 而它的真实文件在 `ungrouped/phone-adb/dsh-phone-agent-plugin/`，
 * 那个位置上面没有 DSH 的 node_modules，于是报：
 *     ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'
 *
 * 对照：qq-agent-presets 为什么不用这个？因为它的 preset 子行是**从 profile 目录**
 * 解析裸说明符的（见 ensureBundle 上面那段注释），路径锚点不一样。
 *
 * 曾经试过只链 dsh-tools + cordis 两个包 → 失败，因为还有传递依赖
 * （dsh-attachment 等）。所以这里链**整个** profiles/node_modules，
 * 一次把整条依赖图接上。用 junction（不是 symlink）：Windows 上 Node 的
 * realpath 解析对 symlink 会锚回原处，junction 才认。
 */
function ensurePhoneAgentDeps() {
  const pluginDir = BUNDLE_SOURCES['dsh-phone-agent'];
  if (!fs.existsSync(pluginDir)) {
    log(`dsh-phone-agent 不在预期位置，跳过依赖链接：${pluginDir}`);
    return;
  }
  ensureDirLink(path.join(pluginDir, 'node_modules'),
    path.join(DSH_HOME, 'profiles', 'node_modules'),
    'dsh-phone-agent node_modules link');
}

function ensureBundle(name) {
  const repoDir = BUNDLE_SOURCES[name] ?? path.join(REPO_ROOT, 'plugins', name);
  const linkDir = ensureDirLink(path.join(DSH_HOME, 'plugins', name), repoDir, `bundle ${name} link`);
  ensureDirLink(path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', name), linkDir, `bundle ${name} node_modules link`);
  return linkDir;
}

/**
 * 把 phone-adb/state.json 里的真实手机 IP 写进 dsh-phone-agent 的 cordis.patch.yml。
 *
 * 为什么必须做：这个插件自带的 patch 里 host 是作者的示例 IP，照抄会连到不存在的
 * 机器上——而且失败长得很像"App 挂了"（见其 README：IP 变了之后 ping 通、
 * 但 TCP 永远超时）。手机 IP 在校园网里是会变的，所以从 state.json 取，
 * 那是 phone-adb 侧已经维护着的唯一事实源。
 *
 * 只在**能读到 IP** 时改写；读不到就原样保留并在日志里提示，不猜一个。
 */
function syncPhoneAgentHost() {
  if (!fs.existsSync(PHONE_AGENT_PATCH)) {
    log(`dsh-phone-agent patch 不存在，跳过 IP 同步：${PHONE_AGENT_PATCH}`);
    return;
  }
  let ip = '';
  try {
    const st = JSON.parse(fs.readFileSync(path.join(PHONE_ADB_DIR, 'state.json'), 'utf8'));
    ip = String(st.ip || '').trim();
  } catch (e) {
    log(`读不到 phone-adb/state.json（${e.message}），dsh-phone-agent 的 host 保持原样`);
    return;
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    log(`state.json 里的 ip 不像 IPv4（${ip || '空'}），dsh-phone-agent 的 host 保持原样`);
    return;
  }
  const before = fs.readFileSync(PHONE_AGENT_PATCH, 'utf8');
  // 只替换 host 那一行的值，保留其余内容（含作者的注释）。
  const after = before.replace(/^(\s*host:\s*).*$/m, `$1${ip}`);
  if (after !== before) {
    fs.writeFileSync(PHONE_AGENT_PATCH, after, 'utf8');
    log(`dsh-phone-agent host -> ${ip}`);
  } else {
    log(`dsh-phone-agent host 已是 ${ip}`);
  }
}

function patchProfilePackage(links) {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const pkgFile = path.join(profileDir, 'package.json');
  ensureDir(profileDir);
  let pkg = { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  if (fs.existsSync(pkgFile)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    } catch (e) {
      fatal(`failed to parse ${pkgFile}: ${e.message}`);
    }
  }
  pkg.name = pkg.name || `dsh-profile-${PROFILE}`;
  pkg.private = pkg.private !== false;
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) pkg.dependencies = {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
  for (const [name, linkDir] of Object.entries(links)) {
    const linkVal = `link:${linkDir.replace(/\\/g, '/')}`;
    if (pkg.dependencies[name] !== linkVal) {
      pkg.dependencies[name] = linkVal;
      log(`package.json dependency ${name} -> ${linkVal}`);
    }
    if (!pkg.dsh.profile.bundles.includes(name)) {
      pkg.dsh.profile.bundles.push(name);
      log(`package.json bundle added: ${name}`);
    }
  }
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  log(`profile package.json ensured: ${pkgFile}`);
}

function ensureLocalModeFile() {
  const stateDir = path.join(REPO_ROOT, 'state');
  const modeFile = path.join(stateDir, 'mode.json');
  if (fs.existsSync(modeFile)) {
    log(`state/mode.json already exists; leave as-is (current mode may be user-configured)`);
    return;
  }
  ensureDir(stateDir);
  // DSH 0.1.5 起不再有 'router-standard' preset；留空表示「用 DSH 自己声明的默认 preset」，
  // 由 bridge.js 的 resolvePresetName() 兜底（硬编码已下线的名字只会换来每次启动的误导性告警）。
  fs.writeFileSync(modeFile, `${JSON.stringify({ mode: 'reserved2', closedAgentPreset: '' }, null, 2)}\n`, 'utf8');
  log(`state/mode.json created with mode=reserved2 (fallback if DSH settings are not available)`);
}

// qq-mode-console / qq-agent-presets 以 link: 依赖注册进 profile package.json 后，DSH 首次启动
// 需要先安装一次才能解析这些 bundle（否则 cold start 报 "cannot resolve profile bundle"）。
// dsh CLI 可用时自动执行。
function autoInstallProfileBundles() {
  if (process.env.QQ_BRIDGE_SKIP_DSH_INSTALL === '1') {
    log('auto-install skipped: QQ_BRIDGE_SKIP_DSH_INSTALL=1');
    return;
  }
  const windows = process.platform === 'win32';
  // Node cannot spawn npm's .cmd shim directly. Keep the shell command constant;
  // the validated (no quotes/control chars) profile travels through one quoted
  // environment expansion, with delayed expansion disabled to preserve '!'.
  const cmd = windows ? (process.env.ComSpec || 'cmd.exe') : 'dsh';
  const args = windows
    ? ['/d', '/v:off', '/s', '/c', 'dsh.cmd plugin --profile "%QQ_BRIDGE_SETUP_PROFILE%" install']
    : ['plugin', '--profile', PROFILE, 'install'];
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    windowsVerbatimArguments: windows,
    ...(windows ? { env: { ...process.env, QQ_BRIDGE_SETUP_PROFILE: PROFILE } } : {}),
  });
  if (r.error) {
    log(`auto-install failed to start/complete（${r.error.code || r.error.message}）。`);
    log(`若 DSH 启动报“cannot resolve profile bundle”，请手动执行：dsh plugin --profile ${PROFILE} install`);
    return;
  }
  if (r.status === 0) {
    log(`dsh plugin --profile ${PROFILE} install: OK`);
  } else {
    log(`dsh plugin --profile ${PROFILE} install 返回退出码 ${r.status}（若 DSH 启动报 bundle 解析失败，请手动重跑该命令）`);
  }
}

// Validate the existing YAML before changing any presets or configuration.
log(EXTRA_BRIDGES.length
  ? `额外桥接安装：${EXTRA_BRIDGES.map((b) => `slot ${b.slot} → ${b.root}`).join('；')}`
  : '额外桥接安装：无（只有老号一套 MCP）');
const cordisPatch = prepareCordisPatch();
regeneratePresetPatches();
syncPhoneAgentHost();
patchCordis(cordisPatch);
const links = {};
for (const name of BUNDLE_NAMES) {
  // dsh-phone-agent 是**可选**能力（手机控制在同级 phone-adb 仓库里）。源目录不在时跳过它，
  // 别让整套装失败 —— 这和 ensurePhoneAgentDeps / 手机 MCP 那条「装不上就跳过并提示」口径一致。
  const src = BUNDLE_SOURCES[name] ?? path.join(REPO_ROOT, 'plugins', name);
  if (name === 'dsh-phone-agent' && !fs.existsSync(src)) {
    log(`跳过 dsh-phone-agent：源目录不存在 ${src}（手机控制为可选能力）`);
    continue;
  }
  links[name] = ensureBundle(name);
}
ensurePhoneAgentDeps();
patchProfilePackage(links);
reportLegacyPresetDir();
ensureLocalModeFile();
autoInstallProfileBundles();
log('Done. Restart DSH (or reload the profile) so the new presets/MCP take effect.');
