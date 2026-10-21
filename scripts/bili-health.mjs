// [养鱼 2026-10-21] B 站链路体检：一条命令查清"评论为什么发不出去"。
//
// 用法：node scripts/bili-health.mjs
//
// 为什么要它：评论发不出去有三层可能，报错却都长得像"登录不行"——
//   ① 凭证文件不存在/字段不全（state/bili-account.json）
//   ② 凭证过期（nav 接口拒绝）
//   ③ **MCP 进程跑的是旧代码**（lib 改了但 mcp-bilibili.js 是长命进程，不重启不生效）
// ③ 最坑：文件没问题、nav 也没问题，但工具里用的还是旧模块，报「cookie 不完整」，
// 看起来像登录坏了，实际重登一百次也没用。这个脚本会直接调一次 MCP 工具来验。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBili } from '../src/bilibili-lib.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = path.join(REPO_ROOT, 'state', 'bili-account.json');
const MCP_ENTRY = path.join(REPO_ROOT, 'src', 'mcp-bilibili.js');

const ok = (m) => console.log('  ✅ ' + m);
const bad = (m) => console.log('  ❌ ' + m);
let failed = 0;
let staleMcp = false;

console.log('\n【1/4】凭证文件');
if (!fs.existsSync(ACCOUNT)) {
  bad(`不存在：${ACCOUNT}\n     先跑 node scripts/bili-login-qr.mjs --serve`);
  failed++;
} else {
  let a = null;
  try { a = JSON.parse(fs.readFileSync(ACCOUNT, 'utf8')); } catch (e) { bad('不是合法 JSON：' + e.message); failed++; }
  if (a) {
    const missing = ['SESSDATA', 'bili_jct', 'DedeUserID'].filter((k) => !a[k] && !(k === 'bili_jct' && a.biliJct));
    if (missing.length) { bad('缺字段：' + missing.join(', ')); failed++; }
    else ok(`三件套齐全（SESSDATA ${a.SESSDATA.length} 字符，DedeUserID=${a.DedeUserID}）`);
  }
}

console.log('\n【2/4】登录态（直接问 B 站 nav 接口）');
if (!failed) {
  try {
    const bili = createBili({ log: () => {} });
    bili._internal.setAuthLoader(async () => JSON.parse(fs.readFileSync(ACCOUNT, 'utf8')));
    const m = await bili.me();
    ok(`有效：${m.uname}（Lv.${m.level}，mid=${m.mid}，硬币 ${m.coin}）`);
  } catch (e) { bad('无效：' + e.message); failed++; }
}

console.log('\n【3/4】运行中的 MCP 进程是否跑的最新代码');
// MCP 是长命进程（DSH 拉起后一直活着），lib 改了它不会自动重载。
// 判断方式：进程启动时间 vs 两个源文件的 mtime。进程更早 ⇒ 跑的是旧代码。
{
  const procs = await runningMcpProcs();
  const newestSrc = Math.max(
    safeMtime(path.join(REPO_ROOT, 'src', 'bilibili-lib.js')),
    safeMtime(path.join(REPO_ROOT, 'src', 'mcp-bilibili.js'))
  );
  if (procs === null) {
    console.log('  ⚠️ 查不到进程列表（PowerShell 调用失败），跳过——这一步只能靠肉眼确认 MCP 是否重启过');
  } else if (!procs.length) {
    console.log('  ⚠️ 没找到运行中的 mcp-bilibili 进程（可能 DSH 还没拉起，或不用 DSH）——跳过');
  } else {
    if (procs.length > 1) {
      console.log('  ⚠️ 同时有 ' + procs.length + ' 个 mcp-bilibili 进程（孤儿/重复？）：'
        + procs.map((p) => 'PID ' + p.pid).join(', '));
    }
    // 最新拉起的那个才是 DSH 重连后实际在用的（旧的孤儿不影响，但也该清）
    const live = procs[procs.length - 1];
    if (live.startedAt < newestSrc) {
      bad(`PID ${live.pid} 启动于 ${fmtTime(live.startedAt)}，但代码改到 ${fmtTime(newestSrc)}`
        + '\n     它内存里是旧代码 ⇒ 杀掉让 DSH 自动重启（约 1 秒）：taskkill /PID ' + live.pid + ' /F');
      staleMcp = true;
      failed++;
    } else {
      ok(`PID ${live.pid} 启动于 ${fmtTime(live.startedAt)}，晚于最新代码改动（${fmtTime(newestSrc)}）`);
    }
  }
}

console.log('\n【4/4】MCP 工具（用磁盘上的代码另起一份验证）');
if (!failed) {
  const res = await callMcpTool('bili_whoami');
  if (res.error) { bad('调用失败：' + res.error); failed++; }
  else if (res.isError) { bad('工具返回错误：' + res.text); failed++; }
  else ok(res.text);
}

function safeMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function fmtTime(ms) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/** 列出运行中的 mcp-bilibili 进程（按启动时间升序）。查询失败返回 null，查到 0 个返回 []。 */
function runningMcpProcs() {
  return new Promise((resolve) => {
    // 让 PowerShell 直接吐 ISO 8601：默认输出是本地化字符串（"2026年10月21日 16:39:00"），
    // Date.parse 解析不了，会被误判成"没找到进程"。
    const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" '
      + '| Where-Object { $_.CommandLine -like \'*mcp-bilibili*\' } '
      + '| Sort-Object CreationDate '
      + '| ForEach-Object { "$($_.ProcessId)`t$($_.CreationDate.ToString(\'o\'))" }';
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      const out = [];
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const m = /^(\d+)\t(.+)$/.exec(line.trim());
        if (!m) continue;
        const t = Date.parse(m[2]);
        if (Number.isFinite(t)) out.push({ pid: Number(m[1]), startedAt: t });
      }
      out.sort((a, b) => a.startedAt - b.startedAt);
      resolve(out);
    });
  });
}

if (failed) {
  console.log('\n⚠️ 有 ' + failed + ' 项没过。');
  if (staleMcp) {
    console.log('   注意：凭证和登录态都没问题，是 **MCP 进程跑的是旧代码**——重登一百次也没用。');
    console.log('   杀掉它，DSH 会自动拉起新实例（reconnect.enabled=true，约 1 秒）：');
    console.log('     taskkill /PID <上面那个 PID> /F');
  } else {
    console.log('   按上面提示逐项修，修完再跑一遍本脚本。');
  }
  process.exit(1);
}
console.log('\n全部通过，可以正常评论/点赞/投币。\n');

/** 起一个 MCP 子进程，调一个工具，拿文本结果。 */
function callMcpTool(name, args = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MCP_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const pending = new Map();
    const done = (v) => { try { child.kill(); } catch { /* 已退出 */ } resolve(v); };
    const timer = setTimeout(() => done({ error: 'MCP 响应超时（15s）' }), 15000);

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        const cb = pending.get(msg.id);
        if (cb) { pending.delete(msg.id); cb(msg); }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); done({ error: e.message }); });

    const req = (id, method, params) => new Promise((res) => { pending.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });

    (async () => {
      try {
        await req(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bili-health', version: '1' } });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        const r = await req(2, 'tools/call', { name, arguments: args });
        clearTimeout(timer);
        const text = (r.result?.content || []).map((c) => c.text).join(' ');
        done({ text: text || '(空)', isError: !!r.result?.isError, error: r.error ? JSON.stringify(r.error) : null });
      } catch (e) { clearTimeout(timer); done({ error: e.message }); }
    })();
  });
}
