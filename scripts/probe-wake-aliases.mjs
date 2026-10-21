// [养鱼 2026-10-21] 唤醒配置别名容错的**真实链路**探针。
//
// 为什么单测不够：单测只能证明"参数过了 zod"，证明不了"别名真的落进了桥接状态"。
// 这个脚本打真桥接、真会话：用别名写 → 读回来逐字段比对 → 再还原。
//
// 用法：node scripts/probe-wake-aliases.mjs        （npm run probe:wake-aliases）
// 会临时改动主人私聊会话的唤醒配置，跑完自动还原；失败也会还原。
//
// 只验证"写进去的是什么"，不触发任何 QQ 发送。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'private:3796180411';
const CONSOLE_TOKEN = process.env.QQBRIDGE_CONSOLE_TOKEN || 'wuxi-itc8n29pmy00';
const BASE = `http://127.0.0.1:${process.env.QQBRIDGE_PORT || 3100}`;

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? `（${extra}）` : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? `（实际 ${extra}）` : '')); }
};

async function getJson(pathname) {
  const sep = pathname.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${pathname}${sep}token=${CONSOLE_TOKEN}`, { signal: AbortSignal.timeout(10000) });
  return res.json();
}

const readState = () => getJson(`/api/socialV2/state?key=${encodeURIComponent(KEY)}`);

/** 从唤醒提示里取会话令牌，避免在脚本里硬编码。 */
async function sessionToken() {
  const j = await getJson(`/api/socialV2/wake-preview?key=${encodeURIComponent(KEY)}`);
  const m = /([0-9a-f]{48})/.exec(JSON.stringify(j));
  if (!m) throw new Error('唤醒提示里找不到会话令牌');
  return m[1];
}

console.log('\n唤醒配置别名容错 · 真实链路探针');
console.log('目标会话：' + KEY);

const before = await readState();
if (!before.ok) { console.log('  ❌ 桥接读不到状态：' + JSON.stringify(before)); process.exit(1); }
const snap = before.wakeConfig;
console.log('改动前：' + JSON.stringify({ mode: snap.mode, ...snap.triggers }));

const token = await sessionToken();
let restored = false;

/** 用规范名把配置写回原样。 */
async function restore() {
  if (restored) return;
  restored = true;
  const r = await callTool('qq_set_wake_config', {
    key: KEY,
    token,
    config: {
      mode: snap.mode,
      infinite: snap.infinite,
      triggers: {
        atMention: snap.triggers.atMention,
        nameMention: snap.triggers.nameMention,
        keywords: snap.triggers.keywords,
        question: snap.triggers.question,
        poke: snap.triggers.poke,
        anyMessage: snap.triggers.anyMessage,
        probability: snap.triggers.probability,
      },
    },
  });
  const after = await readState();
  const ok = after.ok
    && after.wakeConfig.mode === snap.mode
    && after.wakeConfig.triggers.atMention === snap.triggers.atMention
    && after.wakeConfig.triggers.nameMention === snap.triggers.nameMention
    && JSON.stringify(after.wakeConfig.triggers.keywords) === JSON.stringify(snap.triggers.keywords)
    && after.wakeConfig.triggers.probability === snap.triggers.probability;
  console.log((ok ? '  ✅ ' : '  ❌ ') + '配置已还原' + (ok ? '' : '（还原失败，请手动检查！）' + (r.error || '')));
  if (!ok) fail++;
}

try {
  // ── 用**别名**写：at / name / keyword / prob 全是模型会猜的写法，zzz 是瞎编的字段
  console.log('\n【1】用别名写入（at / name / keyword / prob / silent + 一个瞎编的 zzz）');
  const r1 = await callTool('qq_set_wake_config', {
    key: KEY,
    token,
    config: {
      mode: 'silent',
      triggers: { at: false, name: false, keyword: '测试甲,测试乙', question: false, poke: false, prob: 0.5, zzz: 1 },
    },
  });
  t('工具调用没报错', !r1.error && !r1.isError, r1.error || r1.text.slice(0, 80));
  t('响应里点名说了 zzz 没生效', /zzz/.test(r1.text) && /没生效/.test(r1.text), r1.text.slice(-100));

  const mid = await readState();
  const tr = mid.wakeConfig.triggers;
  t('mode: silent → diving', mid.wakeConfig.mode === 'diving', mid.wakeConfig.mode);
  t('at → atMention 生效（false 也要写进去）', tr.atMention === false, String(tr.atMention));
  t('name → nameMention 生效', tr.nameMention === false, String(tr.nameMention));
  t('keyword 字符串 → 数组', JSON.stringify(tr.keywords) === '["测试甲","测试乙"]', JSON.stringify(tr.keywords));
  t('question 生效', tr.question === false, String(tr.question));
  t('poke 生效', tr.poke === false, String(tr.poke));
  t('prob → probability 生效', tr.probability === 0.5, String(tr.probability));
  t('zzz 没被持久化进状态', !('zzz' in tr), Object.keys(tr).join(','));

  // ── 用**规范名**写一遍，确认没被别名逻辑搞坏
  console.log('\n【2】用规范名写入（回归：别名逻辑不能妨碍正常写法）');
  const r2 = await callTool('qq_set_wake_config', {
    key: KEY,
    token,
    config: { mode: 'diving', triggers: { atMention: true, nameMention: true, keywords: ['规范甲'], probability: 0.2 } },
  });
  t('工具调用没报错', !r2.error && !r2.isError, r2.error || r2.text.slice(0, 80));
  t('没有多余字段告警', !/没生效/.test(r2.text), r2.text.slice(-80));
  const mid2 = await readState();
  t('atMention 回到 true', mid2.wakeConfig.triggers.atMention === true);
  t('keywords 换成规范甲', JSON.stringify(mid2.wakeConfig.triggers.keywords) === '["规范甲"]', JSON.stringify(mid2.wakeConfig.triggers.keywords));
  t('probability 0.2', mid2.wakeConfig.triggers.probability === 0.2);

  // ── 非法 mode 要被挡住，且不能改动状态
  console.log('\n【3】非法 mode 必须被拦下，且状态不变');
  const r3 = await callTool('qq_set_wake_config', { key: KEY, token, config: { mode: 'sleepy' } });
  t('返回参数错误', /参数错误/.test(r3.text), r3.text.slice(0, 60));
  const mid3 = await readState();
  t('状态没被改动', JSON.stringify(mid3.wakeConfig.triggers.keywords) === '["规范甲"]', JSON.stringify(mid3.wakeConfig.triggers.keywords));
} finally {
  console.log('\n【还原】');
  await restore();
}

console.log(`\n真实链路：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);

/** 起一个 MCP 子进程，走 stdio JSON-RPC 调一个工具。 */
function callTool(name, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp-snowluma-safe.js')], {
      stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT,
    });
    let buf = '';
    const pending = new Map();
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已退出 */ }
      resolve(v);
    };
    const timer = setTimeout(() => done({ error: 'MCP 响应超时（20s）', text: '' }), 20000);

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const cb = pending.get(msg.id);
        if (cb) { pending.delete(msg.id); cb(msg); }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); done({ error: e.message, text: '' }); });

    const req = (id, method, params) => new Promise((res) => {
      pending.set(id, res);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

    (async () => {
      try {
        await req(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe-wake-aliases', version: '1' } });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        const r = await req(2, 'tools/call', { name, arguments: args });
        clearTimeout(timer);
        const text = (r.result?.content || []).map((c) => c.text).join(' ');
        done({ text: text || '', isError: !!r.result?.isError, error: r.error ? String(r.error.message || JSON.stringify(r.error)) : null });
      } catch (e) {
        clearTimeout(timer);
        done({ error: e.message, text: '' });
      }
    })();
  });
}
