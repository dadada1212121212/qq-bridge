// 蓝色大肥鱼 · 手机控制台
// 作用：在手机上（同一局域网）随时启动/关闭 QQ 聊天机器人。
// 依赖：无（只用 Node 内置模块）。Node >= 18（用了全局 fetch）。
//
// 设计要点：
//   1) 机器人关掉之后自己没法接指令，所以控制台必须是一个**独立的常驻服务**。
//   2) 真正的启停逻辑直接复用项目里已有的 bot-start.ps1 / bot-stop.ps1（幂等、含 WSL 侧）。
//   3) 令牌鉴权：第一次启动自动生成 botctl/token.txt，之后所有请求必须带 ?t=<token>。

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const QQ_BRIDGE_ROOT = path.resolve(HERE, '..');
// 同级的 qq-dsh-bridge 仓库（启停脚本在那里）。默认按目录结构推，可用环境变量覆盖：
// 写死绝对路径会把本机用户名带进公开仓库，换个机器也直接跑不起来。
const QQ_DSH_BRIDGE_ROOT = process.env.QQ_DSH_BRIDGE_ROOT
  || path.resolve(QQ_BRIDGE_ROOT, '..', 'qq-dsh-bridge');
const SCRIPTS = path.join(QQ_DSH_BRIDGE_ROOT, 'scripts');

const TOKEN_FILE = path.join(HERE, 'token.txt');
const LOG_FILE = path.join(HERE, 'botctl.log');
const PORT = Number(process.env.BOTCTL_PORT || 3111);
const BRIDGE_PORT = 3100;
const DSH_PORT = 3080;

/**
 * 桥接控制台令牌。
 *
 * **绝不能写死在源码里**：这是公开仓库，写死等于把机器人的管理口令公开出去
 * （拿到它就能读聊天记录、改配置、以她的身份发消息）。按桥接自己的口径取值：
 *   ① 环境变量 `QQ_BRIDGE_CONSOLE_TOKEN`（临时覆盖 / 容器里用）
 *   ② `config.json` 的 `consoleToken`（桥接启动时优先用的就是这个）
 *   ③ `state/console-token`（没配 config 时桥接自动生成并落盘的那份）
 * 三处都拿不到就返回空串，调用方据此报错，而不是拿一个假令牌去撞 401。
 */
function loadConsoleToken() {
  const fromEnv = String(process.env.QQ_BRIDGE_CONSOLE_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(QQ_BRIDGE_ROOT, 'config.json'), 'utf8'));
    const fromCfg = String(cfg?.consoleToken ?? '').trim();
    if (fromCfg) return fromCfg;
  } catch { /* 没有 config.json：多半是首次运行，走自动生成那份 */ }
  try {
    const fromState = fs.readFileSync(path.join(QQ_BRIDGE_ROOT, 'state', 'console-token'), 'utf8').trim();
    if (fromState) return fromState;
  } catch { /* 桥接还没启动过 */ }
  return '';
}
const CONSOLE_TOKEN = loadConsoleToken();

// ── 令牌 ────────────────────────────────────────────────────────────────────
function loadToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch { /* 首次运行，下面生成 */ }
  const t = crypto.randomBytes(12).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, t, 'utf8');
  return t;
}
const TOKEN = loadToken();

// ── 自我守护：第一次启动时把自己以「无窗口」方式重新拉起，然后退出 ──────────
// 计划任务只能直接执行 node.exe（沙箱不允许用 powershell/wscript 包一层），
// 这样会留下一个黑色控制台窗口。这里让带窗口的那一份立刻退出、由无窗口的
// 子进程接管，窗口就消失了。调试时设 BOTCTL_FOREGROUND=1 可跳过。
if (!process.env.BOTCTL_DAEMON && !process.env.BOTCTL_FOREGROUND) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: QQ_BRIDGE_ROOT,
    env: { ...process.env, BOTCTL_DAEMON: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] daemonize: parent=${process.pid} child=${child.pid}\n`); } catch {}
  process.exit(0);
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* 日志失败不影响主流程 */ }
  console.log(line);
}

// ── 小工具 ──────────────────────────────────────────────────────────────────
function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function fetchJson(url, headers = {}, timeoutMs = 3500) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  return await res.json();
}

// ── 操作队列（同一时间只允许一个启停动作）──────────────────────────────────
let currentOp = null;

function opRunning() {
  return currentOp && !currentOp.done;
}

function runScript(name, scriptFile, args = []) {
  if (opRunning()) {
    const err = new Error(`已有操作正在进行：${currentOp.name}`);
    err.code = 'BUSY';
    throw err;
  }
  const op = {
    name,
    startedAt: Date.now(),
    endedAt: null,
    done: false,
    exitCode: null,
    tail: [],
  };
  currentOp = op;
  log(`op start: ${name}`);

  const ps = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, scriptFile), ...args],
    { cwd: SCRIPTS, windowsHide: true }
  );

  const push = (buf) => {
    const text = buf.toString('utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) continue;
      op.tail.push(line);
      if (op.tail.length > 300) op.tail.shift();
    }
  };
  ps.stdout.on('data', push);
  ps.stderr.on('data', push);
  ps.on('error', (e) => {
    op.tail.push(`启动失败：${e.message}`);
    op.done = true;
    op.exitCode = -1;
    op.endedAt = Date.now();
    log(`op error: ${name} ${e.message}`);
  });
  ps.on('close', (code) => {
    op.done = true;
    op.exitCode = code;
    op.endedAt = Date.now();
    log(`op end: ${name} exit=${code}`);
  });

  return op;
}

// ── 状态汇总 ────────────────────────────────────────────────────────────────
async function collectStatus() {
  const [bridgeUp, dshUp] = await Promise.all([portOpen(BRIDGE_PORT), portOpen(DSH_PORT)]);
  let bridge = null;
  let roleMode = null;
  let snowluma = null;
  if (bridgeUp) {
    try {
      const s = await fetchJson(`http://127.0.0.1:${BRIDGE_PORT}/api/status`, { 'x-console-token': CONSOLE_TOKEN });
      bridge = {
        dshReady: !!s.dshReady,
        mode: s.mode ?? null,
        roleMode: s.roleMode ?? null,
        allowGroups: s.allowGroups ?? null,
      };
      roleMode = s.roleMode ?? null;
      snowluma = s.snowluma
        ? {
            connected: !!s.snowluma.connected,
            accountOnline: !!s.snowluma.accountOnline,
            lastPacketAgoMs: s.snowluma.lastPacketAgoMs ?? null,
          }
        : null;
    } catch (e) {
      bridge = { error: String(e.message || e) };
    }
  }

  return {
    running: bridgeUp,
    bridgePort: BRIDGE_PORT,
    dshPort: DSH_PORT,
    dshUp,
    bridge,
    roleMode,
    snowluma,
    op: currentOp
      ? {
          name: currentOp.name,
          running: !currentOp.done,
          exitCode: currentOp.exitCode,
          elapsedMs: (currentOp.endedAt ?? Date.now()) - currentOp.startedAt,
          tail: currentOp.tail.slice(-60),
        }
      : null,
    serverTime: new Date().toISOString(),
  };
}

// ── 鉴权 ────────────────────────────────────────────────────────────────────
function authorized(req, url) {
  const fromQuery = url.searchParams.get('t');
  const fromHeader = req.headers['x-botctl-token'];
  const given = fromQuery || fromHeader || '';
  if (!given || given.length !== TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
  } catch {
    return false;
  }
}

// ── 页面 ────────────────────────────────────────────────────────────────────
function page(token) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f5f6f8">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>大肥鱼开关</title>
<style>
  :root{--bg:#f5f6f8;--card:#fff;--text:#16181d;--muted:#6b7280;--line:#e5e7eb;
        --ok:#16a34a;--off:#9ca3af;--danger:#dc2626;--blue:#2563eb}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;background:var(--bg);color:var(--text);
       font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
       padding:18px 16px calc(24px + env(safe-area-inset-bottom))}
  h1{font-size:17px;margin:0 0 14px;font-weight:600;letter-spacing:.3px}
  h1 small{color:var(--muted);font-weight:400;font-size:13px;margin-left:6px}
  .card{background:var(--card);border-radius:16px;padding:18px;margin-bottom:14px;
        box-shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.04)}
  .state{display:flex;align-items:center;gap:12px}
  .dot{width:14px;height:14px;border-radius:50%;background:var(--off);flex:0 0 auto}
  .dot.on{background:var(--ok);box-shadow:0 0 0 6px rgba(22,163,74,.14)}
  .dot.busy{background:#f59e0b;animation:pulse 1s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  .big{font-size:24px;font-weight:700;letter-spacing:.5px}
  .sub{color:var(--muted);font-size:13px;margin-top:3px}
  .rows{margin-top:14px;border-top:1px solid var(--line);padding-top:12px}
  .row{display:flex;justify-content:space-between;font-size:14px;padding:5px 0}
  .row span:first-child{color:var(--muted)}
  .row b{font-weight:600}
  .ok{color:var(--ok)} .bad{color:var(--danger)} .mid{color:#b45309}
  .btns{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  button{font:inherit;font-weight:600;border:0;border-radius:14px;padding:16px 10px;
         color:#fff;background:var(--blue);transition:transform .08s,opacity .2s}
  button:active{transform:scale(.97)}
  button:disabled{opacity:.45}
  .start{background:var(--ok)} .stop{background:var(--danger)}
  .ghost{background:#fff;color:var(--text);border:1px solid var(--line);font-weight:500;
         padding:13px 10px;border-radius:14px;width:100%;margin-top:12px}
  pre{background:#0f1115;color:#d6dae3;border-radius:12px;padding:12px;font-size:12px;
      line-height:1.55;max-height:230px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:10px 0 0}
  .hint{color:var(--muted);font-size:12px;margin-top:10px;text-align:center}
</style>
</head>
<body>
<h1>蓝色大肥鱼<small>手机控制台</small></h1>

<div class="card">
  <div class="state">
    <div class="dot" id="dot"></div>
    <div>
      <div class="big" id="stateText">读取中…</div>
      <div class="sub" id="stateSub">正在连接电脑</div>
    </div>
  </div>
  <div class="rows">
    <div class="row"><span>桥接 3100</span><b id="rBridge">—</b></div>
    <div class="row"><span>DSH 大脑 3080</span><b id="rDsh">—</b></div>
    <div class="row"><span>QQ 账号</span><b id="rQQ">—</b></div>
    <div class="row"><span>群聊模式</span><b id="rMode">—</b></div>
  </div>
</div>

<div class="btns">
  <button class="start" id="btnStart">启动</button>
  <button class="stop" id="btnStop">关闭</button>
</div>
<button class="ghost" id="btnMode">切换群聊模式</button>

<div class="card" id="logCard" style="display:none">
  <div class="sub" id="logTitle">执行输出</div>
  <pre id="logBox"></pre>
</div>

<div class="hint" id="hint">每 3 秒自动刷新</div>

<script>
const T = ${JSON.stringify(token)};
const q = (p) => p + (p.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(T);
const $ = (id) => document.getElementById(id);
let busy = false;

function setBusy(v){
  busy = v;
  $('btnStart').disabled = v;
  $('btnStop').disabled = v;
  $('btnMode').disabled = v;
}

function paint(s){
  const opRunning = s.op && s.op.running;
  const dot = $('dot');
  dot.className = 'dot' + (opRunning ? ' busy' : (s.running ? ' on' : ''));

  if (opRunning){
    $('stateText').textContent = s.op.name === 'start' ? '正在启动…' : '正在关闭…';
    $('stateSub').textContent = '已用 ' + Math.round(s.op.elapsedMs/1000) + ' 秒，请稍候';
  } else if (s.running){
    $('stateText').textContent = '运行中';
    $('stateSub').textContent = s.bridge && s.bridge.dshReady ? '大脑已就绪，可以聊天' : '桥接在跑，等 DSH 就绪';
  } else {
    $('stateText').textContent = '已关闭';
    $('stateSub').textContent = '点下面的「启动」把她叫起来';
  }

  const badge = (el, ok, yes, no) => {
    el.textContent = ok ? yes : no;
    el.className = ok ? 'ok' : 'bad';
  };
  badge($('rBridge'), s.running, '在跑', '停了');
  badge($('rDsh'), s.dshUp, '在跑', '没开');
  badge($('rQQ'), !!(s.snowluma && s.snowluma.accountOnline), '在线', '离线');
  const mode = s.roleMode;
  $('rMode').textContent = mode === 'silent' ? '静默（只回主人私聊）' : (mode ? '正常' : '—');
  $('rMode').className = mode === 'silent' ? 'mid' : (mode ? 'ok' : '');
  $('btnMode').textContent = mode === 'silent' ? '解除静默（恢复群聊发言）' : '切换为静默（只回主人）';
  $('btnMode').disabled = !s.running || opRunning;

  if (s.op && s.op.tail && s.op.tail.length){
    $('logCard').style.display = 'block';
    $('logTitle').textContent = '执行输出（' + (s.op.name === 'start' ? '启动' : '关闭') + (s.op.running ? '中' : ' 已结束，退出码 ' + s.op.exitCode) + '）';
    const box = $('logBox');
    box.textContent = s.op.tail.join('\\n');
    box.scrollTop = box.scrollHeight;
  }
  setBusy(!!opRunning);
}

async function refresh(){
  try {
    const r = await fetch(q('/api/status'), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    paint(await r.json());
    $('hint').textContent = '每 3 秒自动刷新 · ' + new Date().toLocaleTimeString('zh-CN');
  } catch (e){
    $('dot').className = 'dot';
    $('stateText').textContent = '连不上电脑';
    $('stateSub').textContent = String(e.message || e);
  }
}

async function act(kind){
  if (busy) return;
  if (kind === 'stop' && !confirm('确定关闭 QQ 聊天机器人？')) return;
  setBusy(true);
  try {
    const r = await fetch(q('/api/' + kind), { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) alert(j.error || ('操作失败：HTTP ' + r.status));
  } catch (e){
    alert('请求失败：' + (e.message || e));
  }
  refresh();
}

$('btnStart').onclick = () => act('start');
$('btnStop').onclick = () => act('stop');
$('btnMode').onclick = () => act('toggle-mode');

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
}

// ── HTTP 服务 ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (!authorized(req, url)) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('需要令牌：请在地址后面加上 ?t=<token>（token 见 botctl/token.txt）');
    return;
  }

  const sendJson = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page(TOKEN));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      sendJson(200, await collectStatus());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/start') {
      try {
        runScript('start', 'bot-start.ps1');
        sendJson(200, { ok: true, started: 'start' });
      } catch (e) {
        sendJson(e.code === 'BUSY' ? 409 : 500, { ok: false, error: e.message });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      try {
        // -KeepQQ：只停桥接，不动 WSL 里登录着的 QQ。
        // 这样「关闭」是秒级的，也不会把 QQ 踢下线（下次启动不用重新扫码）。
        runScript('stop', 'bot-stop.ps1', ['-KeepQQ']);
        sendJson(200, { ok: true, started: 'stop' });
      } catch (e) {
        sendJson(e.code === 'BUSY' ? 409 : 500, { ok: false, error: e.message });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/toggle-mode') {
      if (opRunning()) { sendJson(409, { ok: false, error: '正在执行其他操作' }); return; }
      const st = await collectStatus();
      if (!st.running) { sendJson(409, { ok: false, error: '机器人没在跑，先启动' }); return; }
      const next = st.roleMode === 'silent' ? 'active' : 'silent';
      const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/role-mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': CONSOLE_TOKEN },
        body: JSON.stringify({ mode: next }),
        signal: AbortSignal.timeout(5000),
      });
      const j = await r.json().catch(() => ({}));
      log(`role-mode -> ${next} (${r.status})`);
      sendJson(r.ok ? 200 : 500, { ok: r.ok, roleMode: j.roleMode ?? next, error: j.error });
      return;
    }

    sendJson(404, { ok: false, error: 'not found' });
  } catch (e) {
    log('handler error:', e?.stack || String(e));
    sendJson(500, { ok: false, error: String(e?.message || e) });
  }
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    log(`端口 ${PORT} 已被占用（可能已经有一个控制台在跑），本实例退出`);
    process.exit(0);
  }
  log('server error:', e?.stack || String(e));
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  log(`botctl listening on 0.0.0.0:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) {
        log(`  手机访问： http://${n.address}:${PORT}/?t=${TOKEN}`);
      }
    }
  }
});
