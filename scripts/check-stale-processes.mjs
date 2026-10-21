// [养鱼 2026-10-21] 查「长命进程跑的是旧代码」。
//
// 为什么需要它：桥接和 MCP 都是长命进程，src/*.js 只在启动时读一次。
// 改完代码不重启 ⇒ 内存里还是旧逻辑，报错却长得跟别的原因一样——
// 今天就踩了两次：MCP 报「B 站 cookie 不完整」（实际是字段名错配的旧代码），
// 桥接改了 file-transfer 却还跑着改之前的版本。这类问题肉眼看不出来。
//
// 用法：node scripts/check-stale-processes.mjs        （npm run check:stale）
// 退出码 1 = 有进程在跑旧代码。
//
// 判断方式：进程启动时间 vs 它**真正 import 到的**本地文件的最新 mtime。
// 只比它自己的依赖链，不拿全目录比——否则改一个无关文件就满屏假红。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase();
const ROOT_NORM = norm(REPO_ROOT);

const ok = (m) => console.log('  ✅ ' + m);
const bad = (m) => console.log('  ❌ ' + m);
const fmt = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false });

function safeMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

/** 起一次 powershell，返回 stdout（失败返回 null）。 */
function ps(command) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 15000 }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''));
    });
  });
}

/** 所有 node 进程：[{ pid, startedAt, cmdline }]。查不到返回 null。 */
async function nodeProcs() {
  const out = await ps('Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" '
    + '| ForEach-Object { "$($_.ProcessId)`t$($_.CreationDate.ToString(\'o\'))`t$($_.CommandLine)" }');
  if (out === null) return null;
  const list = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+)\t([^\t]+)\t(.*)$/.exec(line.trim());
    if (!m) continue;
    const t = Date.parse(m[2]);
    if (!Number.isFinite(t)) continue;
    list.push({ pid: Number(m[1]), startedAt: t, cmdline: m[3] });
  }
  return list;
}

/** 监听某端口的进程 pid，没有返回 null。 */
async function portOwner(port) {
  const out = await ps(`Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue `
    + '| Select-Object -First 1 -ExpandProperty OwningProcess');
  const n = Number(String(out || '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 从入口文件出发，收集它真正会加载的本地 .js（递归跟随相对路径 import/require）。
 * 只收仓库内的文件，避免跟到 node_modules 里。
 */
function localDeps(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    const key = norm(file);
    if (seen.has(key)) continue;
    seen.add(key);
    let code = '';
    try { code = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const re = /(?:from\s*|require\s*\(\s*|import\s*)['"](\.[^'"]+)['"]/g;
    let m;
    while ((m = re.exec(code))) {
      const spec = m[1];
      let target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target) && fs.existsSync(target + '.js')) target += '.js';
      if (!fs.existsSync(target)) continue;
      if (!norm(target).startsWith(ROOT_NORM)) continue;
      stack.push(target);
    }
  }
  return [...seen];
}

/** 入口文件的路径写法要能对上仓库真实路径（相对路径要补全）。 */
function resolveEntry(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const abs = path.isAbsolute(s) ? s : path.resolve(REPO_ROOT, s);
  return fs.existsSync(abs) ? abs : null;
}

console.log('\n长命进程新鲜度检查（' + REPO_ROOT + '）');

const procs = await nodeProcs();
if (procs === null) {
  console.log('  ⚠️ 查不到进程列表（powershell 调用失败），没法判断。');
  process.exit(2);
}

// 1) 找桥接：按端口归属认人。命令行都是 "node src\bridge.js"，
//    光看命令行分不清 3100（主仓）和 3101（fish），端口才准。
let consolePort = 3100;
try { consolePort = Number(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8')).consolePort) || 3100; } catch { /* 用默认值 */ }

const targets = [];
const bridgePid = await portOwner(consolePort);
if (bridgePid) {
  const p = procs.find((x) => x.pid === bridgePid);
  targets.push({
    label: `桥接 :${consolePort}`,
    pid: bridgePid,
    startedAt: p ? p.startedAt : null,
    entry: path.join(REPO_ROOT, 'src', 'bridge.js'),
  });
} else {
  // 不能静默跳过：桥接恰恰是最容易跑旧代码的那个，漏了它却报"全部最新"就是假绿。
  console.log(`  ⚠️ :${consolePort} 上没有监听进程——桥接没起？这一步跳过（其余进程照查）`);
}

// 2) 找 MCP：命令行里带本仓绝对路径的 src/mcp-*.js。
for (const p of procs) {
  if (!norm(p.cmdline).includes(ROOT_NORM)) continue;
  const m = /(\S*mcp-[A-Za-z0-9._-]+\.js)/.exec(p.cmdline);
  if (!m) continue;
  const entry = resolveEntry(m[1]);
  if (!entry) continue;
  targets.push({ label: path.basename(entry), pid: p.pid, startedAt: p.startedAt, entry });
}

if (!targets.length) {
  console.log('  ⚠️ 没找到本仓的长命进程（桥接没起、MCP 也没被拉起）——没什么可查的。');
  process.exit(0);
}

let stale = 0;
for (const t of targets) {
  const deps = localDeps(t.entry);
  let newest = 0;
  let newestFile = '';
  for (const f of deps) {
    const mt = safeMtime(f);
    if (mt > newest) { newest = mt; newestFile = f; }
  }
  const head = `${t.label}（PID ${t.pid}）`;
  if (t.startedAt == null) {
    console.log('  ⚠️ ' + head + ' 拿不到启动时间，跳过');
    continue;
  }
  if (!deps.length) {
    console.log('  ⚠️ ' + head + ' 解析不到依赖（入口文件不存在？），跳过');
    continue;
  }
  if (newest > t.startedAt) {
    bad(`${head} 启动于 ${fmt(t.startedAt)}，但 ${path.basename(newestFile)} 改到 ${fmt(newest)}`
      + `\n     ⇒ 它跑的是旧代码（依赖 ${deps.length} 个文件）`);
    stale++;
  } else {
    ok(`${head} 启动于 ${fmt(t.startedAt)}，依赖 ${deps.length} 个文件都没更新过`);
  }
}

if (stale) {
  console.log(`\n⚠️ ${stale} 个进程在跑旧代码。重启方式：`);
  console.log('   桥接：杀 node 后 run-qqbridge.cmd 会 5 秒内自愈（别按 *bridge.js* 通杀，会同时命中两个号）');
  console.log('   MCP：杀掉即可，DSH 按 reconnect.enabled=true 自动拉起（约 1 秒）');
  process.exit(1);
}
console.log('\n全部在跑最新代码。\n');
