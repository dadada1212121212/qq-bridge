#!/usr/bin/env node
// QQ 唤醒器（独立常驻进程，不依赖 DSH / 桥接 / 这个仓库的会话）。
//
// 要解决的问题：桥接进程（src/bridge.js）没跑的时候，QQ 里的消息没人接，
// 只能人跑到电脑前手动启动 —— 出门在外就没法用。
//
// 做法：一个极小的常驻进程，直接连 SnowLuma 的 OneBot WebSocket，**只听主人私聊里的斜杠命令**：
//   /status            看桥接/DSH/QQ 是否活着
//   /start             启动桥接（没开的时候用这个叫醒机器人）
//   /restart           重启桥接
//   /stop              停掉桥接
//   /silent on|off     静默模式（只在主人私聊回话）
//   /get  <路径>       读配置（白名单路径）
//   /set  <路径> <值>  改配置（白名单 + 类型校验），改完自动重启桥接生效
//   /help              帮助
//
// 安全边界（按重要程度排）：
//   1) 只认 config.json 里的 ownerQQ，且**只处理私聊**；其他人发什么都忽略（连报错都不回）。
//   2) 只处理以 / 或 ／ 开头的命令；普通聊天一个字都不回 —— 桥接开着的时候不会打架。
//   3) /set 只接受白名单里的路径（见 ALLOWED_PATHS），且按原值类型校验；不接受任意 JSON 路径写入。
//   4) 所有子进程调用都是「固定脚本 + 固定参数」，不拼 shell 字符串，不执行任意命令。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text as messageText } from '@snowluma/sdk';
import { discoverSnowLumaConnection } from './snowluma-conn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const LOG_FILE = path.join(ROOT, 'logs', 'wake-bot.log');
const BRIDGE_CONTROL = path.join(ROOT, 'scripts', 'bridge-control.ps1');

/** 允许通过 /set 改的配置路径（其余一律拒绝）。 */
export const ALLOWED_PATHS = Object.freeze([
  'socialV2.enabled',
  'socialV2.thinkingFiller.enabled',
  'socialV2.thinkingFiller.afterMs',
  'socialV2.wait.minQuietAfterNewMs',
  'socialV2.wait.replyQuietCapMs',
  'socialV2.wake.leanAfterFirst',
  'socialV2.wake.batchWindowMs',
  'socialV2.context.sessionReuseWarmMs',
  'socialV2.memoryDb.autoLearn',
  'socialV2.memoryDb.maxChars',
  'socialV2.send.maxMessageChars',
]);

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

export function logLine(text) {
  ensureDir(path.dirname(LOG_FILE));
  const line = '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + text + '\n';
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch { /* ignore */ }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function loadConfig() {
  const base = readJson(path.join(ROOT, 'config.json'), {});
  const local = readJson(path.join(ROOT, 'config.local.json'), {});
  return { base, local, merged: deepMerge(base, local) };
}

function deepMerge(a, b) {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return b === undefined ? a : b;
  const out = Array.isArray(a) ? [...a] : { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = (k in a) ? deepMerge(a[k], v) : v;
  }
  return out;
}

function getPath(obj, dotted) {
  return String(dotted).split('.').reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), obj);
}

function setPath(obj, dotted, value) {
  const keys = String(dotted).split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

/** 按「现值类型」把字符串转成目标值；类型不对就抛错，绝不写半截。 */
export function coerceLike(current, raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (typeof current === 'boolean') {
    if (/^(true|1|on|开|是|启用|打开)$/i.test(text)) return true;
    if (/^(false|0|off|关|否|停用|关闭)$/i.test(text)) return false;
    throw new Error('这个开关只接受 on/off 或 true/false');
  }
  if (typeof current === 'number') {
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) throw new Error('这里要一个非负数字');
    return n;
  }
  if (typeof current === 'string') return text;
  throw new Error('这个配置项没有可用的默认值，不能从 QQ 改');
}

/** 解析一条命令；不是命令返回 null。 */
/**
 * 从 OneBot 事件里取纯文本正文。
 *
 * 为什么不能直接 String(event.message)：message 可能是
 *   · 字符串（大部分实现），
 *   · 段数组 [{ type:'text', data:{ text:'/status' } }]（OneBot v11 标准），
 *   · 对象（SnowLuma 某些版本）。
 * 直接 String() 会得到 "[object Object]" —— 实测就是这样：日志里能看到消息到了，
 * 但内容成了 [object Object]，于是每条命令都被当成普通聊天忽略。
 */
export function extractText(event) {
  const m = event && event.message;
  if (typeof m === 'string' && m.trim()) return m;
  if (Array.isArray(m)) {
    return m.map((seg) => {
      if (typeof seg === 'string') return seg;
      if (!seg || typeof seg !== 'object') return '';
      const d = seg.data;
      if (d && typeof d === 'object') return String(d.text != null ? d.text : (d.content != null ? d.content : ''));
      return String(seg.text != null ? seg.text : '');
    }).join('');
  }
  if (m && typeof m === 'object') {
    const t = m.text != null ? m.text : (m.raw_message != null ? m.raw_message : '');
    if (typeof t === 'string' && t.trim()) return t;
  }
  return String((event && event.raw_message) || '');
}

export function parseCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const m = raw.match(/^[\/／]\s*([a-zA-Z][a-zA-Z-]*)\s*(.*)$/);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), args: m[2].trim() };
}

/** 判定一条私聊消息是否该由唤醒器处理（只有主人 + 命令）。 */
export function shouldHandle({ userId, ownerQQ, text }) {
  if (String(userId) !== String(ownerQQ)) return { ok: false, reason: 'not-owner' };
  const parsed = parseCommand(text);
  if (!parsed) return { ok: false, reason: 'not-command' };
  return { ok: true, ...parsed };
}

function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

function runPowerShell(args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE_CONTROL, ...args], { cwd: ROOT, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout || '').trim(), err: String(stderr || '').trim() });
    });
  });
}

export function chunkText(text, size = 450) {
  const s = String(text || '');
  if (s.length <= size) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

function makeSender(cfg) {
  const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg.snowluma?.accessToken || '');
  return async function send(userId, text) {
    for (const part of chunkText(text)) {
      try {
        const res = await fetch(httpUrl + '/send_private_msg', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: 'Bearer ' + token } : {}),
          },
          body: JSON.stringify({ user_id: Number(userId), message: part }),
        });
        if (!res.ok) logLine('send failed ' + res.status);
      } catch (error) {
        logLine('send error: ' + (error?.message ?? error));
      }
    }
  };
}

function readRoleMode() {
  const st = readJson(path.join(STATE_DIR, 'current-role.json'), { role: null, mode: 'active' });
  return String(st.mode || 'active');
}

function writeRoleMode(mode) {
  const file = path.join(STATE_DIR, 'current-role.json');
  const st = readJson(file, { role: null, mode: 'active' });
  st.mode = mode;
  writeJson(file, st);
}

/** 执行一条命令，返回要回复的文本。纯函数式地集中在这里，方便单测。 */
export async function executeCommand({ cmd, args }, deps) {
  const { send, config, restartBridge, startBridge, stopBridge, portOpen: portFn } = deps;
  // [养鱼 2026-10-21] 角色模式的读写必须可注入。事故：test-wake-bot 的 /silent 用例
  // 直接调了这里的真实 writeRoleMode，而 STATE_DIR 指向**真实** state/ ——
  // 于是跑一次 `npm test` 就把线上机器人切成静默（群聊一票否决），机器人看起来"死了"。
  // 现在测试传替身即可，生产路径行为完全不变。
  const readMode = typeof deps.readRoleMode === 'function' ? deps.readRoleMode : readRoleMode;
  const writeMode = typeof deps.writeRoleMode === 'function' ? deps.writeRoleMode : writeRoleMode;
  const bridgeUp = await portFn(3100);
  const dshUp = await portFn(3080);
  switch (cmd) {
    case 'help':
      return [
        'QQ 唤醒器命令（只有你能用）：',
        '/status  看桥接 / DSH / QQ 状态',
        '/start   启动 QQ 机器人（桥接没开时用这个）',
        '/restart 重启桥接',
        '/stop    停掉桥接',
        '/silent on|off  静默模式（只在私聊回话）',
        '/get  <路径>    读配置，例 /get socialV2.memoryDb.maxChars',
        '/set  <路径> <值> 改配置并重启，例 /set socialV2.thinkingFiller.enabled off',
      ].join('\n');
    case 'status': {
      const mode = readMode() === 'silent' ? '静默（只在私聊回话）' : 'active（正常接话）';
      return [
        '桥接：' + (bridgeUp ? '在跑（3100）' : '没跑 —— 发 /start 叫我'),
        'DSH：' + (dshUp ? '可达（3080）' : '不可达'),
        'QQ：已连接（你正在跟我说话）',
        '角色模式：' + mode,
        '记忆自动学习：' + (getPath(config, 'socialV2.memoryDb.autoLearn') === false ? '关' : '开'),
      ].join('\n');
    }
    case 'start': {
      if (bridgeUp) return '桥接本来就在跑（3100）。要重启用 /restart。';
      const r = await startBridge();
      const up2 = await portFn(3100);
      return (up2 ? '已启动桥接，机器人上线了。' : '启动命令已发出，但 3100 还没起来。输出：\n' + (r.out || r.err || '').slice(0, 300));
    }
    case 'restart': {
      const r = await restartBridge();
      const up2 = await portFn(3100);
      return (up2 ? '桥接已重启，机器人回来了。' : '重启没成功。输出：\n' + (r.out || r.err || '').slice(0, 300));
    }
    case 'stop': {
      const r = await stopBridge();
      const up2 = await portFn(3100);
      return (up2 ? '停不下来（3100 还在）。输出：\n' + (r.out || r.err || '').slice(0, 300) : '桥接已停。发 /start 可以再叫起来。');
    }
    case 'silent': {
      const a = String(args || '').toLowerCase();
      if (a === 'on' || a === '开') { writeMode('silent'); return '已切到静默：群里不接话，只回你私聊。'; }
      if (a === 'off' || a === '关') { writeMode('active'); return '已恢复：按唤醒配置正常接话。'; }
      return '用法：/silent on 或 /silent off（现在是 ' + readMode() + '）';
    }
    case 'get': {
      if (!args) return '用法：/get socialV2.memoryDb.maxChars';
      if (ALLOWED_PATHS.indexOf(args) < 0) return '这条路径不在可读白名单里。可读：\n' + ALLOWED_PATHS.join('\n');
      const v = getPath(config, args);
      return args + ' = ' + (v === undefined ? '（未设置）' : JSON.stringify(v));
    }
    case 'set': {
      const sp = String(args || '').split(/\s+/);
      const p = sp[0];
      const rawValue = sp.slice(1).join(' ');
      if (!p || !rawValue) return '用法：/set socialV2.thinkingFiller.enabled off';
      if (ALLOWED_PATHS.indexOf(p) < 0) return '这条路径不在可写白名单里。可写：\n' + ALLOWED_PATHS.join('\n');
      const current = getPath(config, p);
      let value;
      try { value = coerceLike(current, rawValue); } catch (error) { return '没改：' + (error?.message ?? error); }
      const applied = deps.applySetting(p, value);
      if (bridgeUp) await restartBridge();
      return '已设置 ' + p + ' = ' + JSON.stringify(value) + '（写进 ' + applied + '）' + (bridgeUp ? '，桥接已重启生效。' : '。桥接没在跑，下次启动生效。');
    }
    default:
      return '不认识的命令：/' + cmd + '。发 /help 看用法。';
  }
}

/** 进程入口（被 run-qq-wake.cmd 拉起）。 */
export async function main() {
  ensureDir(STATE_DIR);
  // 单实例：启动文件夹、手动重启、看门狗都可能把它拉起来多次；两个实例会抢同一条 WS。
  const pidFile = path.join(STATE_DIR, 'wake-bot.pid');
  // 用「独占创建」当锁：'wx' 只有第一个进程能成功，同时启动两个也只活一个（文件存在不代表活着，
  // 所以要再判一次 pid；确认是僵尸才删掉重试）。
  const acquire = () => {
    try {
      const fd = fs.openSync(pidFile, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return 'acquired';
    } catch {
      let old = 0;
      try { old = Number(String(fs.readFileSync(pidFile, 'utf8')).trim()); } catch { old = 0; }
      if (old && old !== process.pid) {
        try { process.kill(old, 0); return 'busy'; } catch { /* 旧进程已死，清掉锁再试 */ }
      }
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
      try {
        const fd = fs.openSync(pidFile, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return 'acquired';
      } catch { return 'busy'; }
    }
  };
  const lockState = acquire();
  if (lockState !== 'acquired') { logLine('已有实例在跑，本进程退出（单实例保护）'); return; }
  const cleanPidFile = () => { try { if (String(fs.readFileSync(pidFile, 'utf8')).trim() === String(process.pid)) fs.unlinkSync(pidFile); } catch { /* ignore */ } };
  process.on('exit', cleanPidFile);
  const { merged } = loadConfig();
  const cfg = merged;
  const ownerQQ = String(cfg.ownerQQ || '');
  if (!ownerQQ) {
    logLine('缺少 ownerQQ，拒绝启动（否则任何人都能下命令）');
    process.exit(2);
  }
  const send = makeSender(cfg);
  logLine('唤醒器启动，owner=' + ownerQQ + '，SnowLuma=' + String(cfg.snowluma?.wsUrl || ''));

  const deps = {
    config: cfg,
    portOpen,
    startBridge: () => runPowerShell(['-Action', 'start']),
    stopBridge: () => runPowerShell(['-Action', 'stop']),
    restartBridge: () => runPowerShell(['-Action', 'restart']),
    applySetting(dotted, value) {
      // 有 config.local.json 且里面确实有这个键 → 改 local（它覆盖 base），否则改 config.json
      const localFile = path.join(ROOT, 'config.local.json');
      const local = readJson(localFile, null);
      const useLocal = local && getPath(local, dotted) !== undefined;
      const file = useLocal ? localFile : path.join(ROOT, 'config.json');
      const data = readJson(file, {});
      setPath(data, dotted, value);
      writeJson(file, data);
      logLine('set ' + dotted + ' = ' + JSON.stringify(value) + ' -> ' + path.basename(file));
      return path.basename(file);
    },
  };

  // SnowLuma 的 HTTP token（3000）和 WS token（3001）**不是同一个值**，config.json 里存的是 HTTP 那个。
  // 直接拿它连 WS 必然被拒（close 1006），所以先做一次端点发现（复用桥接同一套 snowluma-conn.js）。
  let wsUrl = String(cfg.snowluma?.wsUrl || 'ws://127.0.0.1:3001');
  let wsToken = cfg.snowluma?.accessToken || undefined;
  try {
    const found = await discoverSnowLumaConnection({ cfg, timeoutMs: 5000 });
    if (found?.ok && found.wsUrl) {
      wsUrl = found.wsUrl;
      // 注意字段名：discover 返回的是 wsToken（WS 专用 token），不是 accessToken（HTTP 那个）。
      wsToken = found.wsToken || found.accessToken || wsToken;
      logLine('端点发现成功：' + wsUrl + '（账号 ' + (found.self?.user_id ?? '?') + '）');
    } else {
      logLine('端点发现失败（' + (found?.error ?? '未知') + '），仍用 config 里的 wsUrl 试连');
    }
  } catch (error) {
    logLine('端点发现异常：' + (error?.message ?? error));
  }

  const bot = new SnowLumaWebSocketClient({
    url: wsUrl,
    accessToken: wsToken,
    reconnect: true,
  });

  // 诊断：任何 WS 事件都留一行（只记类型/发送者/前 40 字），否则「没反应」时无从判断
  // 是「没收到」还是「收到了被当成普通聊天忽略了」。
  try {
    bot.onEvent((event) => {
      const post = String(event?.post_type || '?');
      if (post !== 'message') return;
      const who = String(event?.user_id ?? '');
      if (who !== String(ownerQQ)) return; // 只记主人的消息，别人的不落盘
      logLine('事件收到：' + post + '/' + String(event.message_type || '') + ' from ' + who + '：' + extractText(event).slice(0, 40));
    });
  } catch { /* 老 SDK 没有 onEvent */ }

  bot.onPrivateMessage(async (event) => {
    if (Number(event.user_id) === Number(event.self_id)) return;
    const text = extractText(event).trim();
    const verdict = shouldHandle({ userId: event.user_id, ownerQQ, text });
    if (!verdict.ok) {
      // 主人发来的东西但没被当成命令 → 记下来（这是「发了命令没反应」最常见的现场）
      if (String(event.user_id) === String(ownerQQ)) logLine('主人私聊但非命令（已忽略）：' + text.slice(0, 40));
      return;
    }
    try {
      const reply = await executeCommand(verdict, deps);
      await send(event.user_id, reply);
    } catch (error) {
      logLine('命令执行失败: ' + (error?.message ?? error));
      await send(event.user_id, '命令出错了：' + String(error?.message ?? error).slice(0, 200));
    }
  });

  let lastWsErrLog = 0;
  bot.on('error', (error) => {
    // SDK 自带重连，断了会连续报错；60 秒只记一条，免得日志被刷爆
    const now = Date.now();
    if (now - lastWsErrLog > 60000) { lastWsErrLog = now; logLine('WS 错误: ' + (error?.message ?? error)); }
  });
  try { bot.on('open', () => logLine('已连上 SnowLuma OneBot（' + wsUrl + '）')); } catch { /* 老 SDK 没有 open 事件 */ }
  // 连接由 ensureMode() 决定（桥接在跑就不抢）——SDK 的构造函数只建对象，不会自己连。
  // 接管规则：桥接(3100)在跑 → 让出 WS 连接（SnowLuma 的 OneBot WS 基本只服务一个客户端，
  // 两边抢会互相踢下线）；桥接没跑 → 接管，等主人发命令把它叫起来。每 5 秒看一次。
  let holding = false;
  async function ensureMode() {
    try {
      const bridgeUp = await portOpen(3100);
      if (bridgeUp && holding) {
        holding = false;
        try { bot.close(1000, 'bridge-up'); } catch { /* ignore */ }
        logLine('桥接在跑，唤醒器让出 WS 连接（只保留进程待命）');
      } else if (!bridgeUp && !holding) {
        try {
          await bot.connect();
          holding = true;
          logLine('桥接没跑，唤醒器接管 WS：现在发 /start 就能把它叫起来');
        } catch (error) {
          logLine('接管失败（稍后重试）: ' + (error?.message ?? error));
        }
      }
    } catch (error) {
      logLine('接管检查异常: ' + (error?.message ?? error));
    }
  }
  // 注意：这里**不能** unref —— 进程的唯一存活依据就是这两个定时器（WS 断开时没有别的句柄），
  // unref 会让 node 在「桥接在跑、不用连 WS」的那段时间直接退出（实测启动即退出 code=0）。
  setTimeout(() => { void ensureMode(); }, 1500);
  setInterval(() => { void ensureMode(); }, 5000);
  // 保活心跳：即使 WS 断了也不能让进程退出（否则登录自启就白装了）。
  setInterval(() => logLine('心跳：进程存活'), 6 * 3600 * 1000);
  process.on('uncaughtException', (error) => logLine('uncaught: ' + (error?.stack ?? error)));
  process.on('unhandledRejection', (error) => logLine('unhandledRejection: ' + (error?.stack ?? error)));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch((error) => { logLine('启动失败: ' + (error?.stack ?? error)); process.exit(1); });
