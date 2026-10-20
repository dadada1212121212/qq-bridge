// [patch 长思考先说一句] 回归网：有人在找她、她想超过阈值还没开口时，桥接要替她先垫一句。
//
// 起因（2026-10-18 主人 m11759）：「要是出现了长时间的思考，就要 AI 提前发布一条对话，以回应」。
// 纯判定函数 thinkingFillerDueV2 从 bridge.js 源码里抽出来真跑，避免只 grep 关键字。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// bridge.js 在 Windows 上是 CRLF：先归一化成 \n 再切片。
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ✅ ' + name); }
  else { fail += 1; console.error('  ❌ ' + name); }
}

function sliceFn(name) {
  const start = bridgeSrc.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const end = bridgeSrc.indexOf('\n  }', start);
  return end > 0 ? bridgeSrc.slice(start, end + 4) : '';
}

const dueSrc = sliceFn('thinkingFillerDueV2');
const confSrc = sliceFn('thinkingFillerConfigV2');
console.log('## 源码切片');
ok(dueSrc.length > 0, '在 bridge.js 里找到了 thinkingFillerDueV2 的完整函数体');
ok(confSrc.length > 0, '在 bridge.js 里找到了 thinkingFillerConfigV2 的完整函数体');

let due = null;
let makeConf = null;
try {
  due = new Function(dueSrc + '\n    return thinkingFillerDueV2;')();
  makeConf = (cfg, texts) => new Function('cfg', 'THINKING_FILLER_DEFAULT_TEXTS', confSrc + '\n    return thinkingFillerConfigV2;')(cfg, texts)();
} catch (error) {
  ok(false, '函数体可编译（' + (error?.message ?? error) + '）');
}
const DEF = ['x', 'y'];

const base = {
  enabled: true, afterMs: 30000, elapsedMs: 31000,
  turnStartMatches: true, sentThisTurn: false, alreadySent: false,
  scopeOk: true, inboundFresh: true
};
const withBase = (patch) => ({ ...base, ...patch });

console.log('## 判定');
ok(due(base) === true, '默认条件满足时该垫一句');
ok(due(withBase({ enabled: false })) === false, '配置关掉时绝不垫');
ok(due(withBase({ elapsedMs: 29999 })) === false, '还没超时（29.999s）不垫');
ok(due(withBase({ elapsedMs: 30000 })) === true, '刚好到阈值就算超时');
ok(due(withBase({ sentThisTurn: true })) === false, '这一回合她已经开口了，不垫');
ok(due(withBase({ alreadySent: true })) === false, '同一回合只垫一次');
ok(due(withBase({ turnStartMatches: false })) === false, '回合已结束/已换新回合，旧定时器不许补垫');
ok(due(withBase({ inboundFresh: false })) === false, '十分钟内没人找她（定时唤醒等）不垫');
ok(due(withBase({ scopeOk: false })) === false, '群聊默认不垫');
ok(due(null) === false, '没传信息时安全返回 false');

console.log('## 配置');
const d1 = makeConf({ socialV2: {} }, DEF);
ok(d1.enabled === true, '不写配置时默认开启');
ok(d1.afterMs === 30000, '默认阈值 30 秒');
ok(d1.includeGroups === false, '默认只在私聊垫');
ok(d1.texts.join(',') === 'x,y', '没配 texts 时用内置话术');
const d2 = makeConf({ socialV2: { thinkingFiller: { enabled: false, afterMs: 5000, texts: [' 稍等 '], includeGroups: true } } }, DEF);
ok(d2.enabled === false, 'enabled=false 生效');
ok(d2.afterMs === 5000, 'afterMs 可配');
ok(d2.texts.join(',') === '稍等', '自定义话术会 trim');
ok(d2.includeGroups === true, 'includeGroups 可开');
const d3 = makeConf({ socialV2: { thinkingFiller: { afterMs: 10 } } }, DEF);
ok(d3.afterMs === 3000, '阈值有下限 3 秒，避免刚开回合就垫');

console.log('## 接线');
// 窗口不能太窄：省步计数那行加进来后，turn/start 到挂定时器的间距已经 460+ 字符，
// 400 的窗口会让这条断言长期假红（代码其实是对的）。
ok(/frame\.event\.type === 'turn\/start'[\s\S]{0,1200}armThinkingFillerV2\(key, frame\.sessionId/.test(bridgeSrc), 'turn/start 时按会话挂定时器');
ok(/v2TurnStartAt\.delete\(frame\.sessionId\);\n\s*clearThinkingFillerV2\(frame\.sessionId\);/.test(bridgeSrc), '回合结束时清掉定时器（主回合与第二槽位都要清）');
ok((bridgeSrc.match(/clearThinkingFillerV2\(frame\.sessionId\);/g) || []).length >= 2, '主回合 + 第二槽位都有清理');
ok(/sendToQQ\(key, fillerText\);/.test(bridgeSrc), '垫场话走统一的 QQ 发送通道');
ok(/shouldBlockSilentReply\(key\)\) return;/.test(bridgeSrc) && /peakQuietAppliesV2\(key\)\) return;/.test(bridgeSrc), '静默/高峰静默时不垫');

// ── 联调：真的走一遍桥接发送通道（不联网，QQ/DSH 都是桩） ──────────────
console.log('## 联调（真发送通道）');
const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
const PRIVATE = 'private:10001';

async function withBridge(fn) {
  const h = await bridgeHarness({ config: {
    ownerQQ: '10001',
    allow: { private: ['10001'] },
    socialV2: {
      peakQuiet: { enabled: false },
      wake: { preSleepWaitEnabled: false, maxWakePerMinute: 99, maxWakePerHour: 999 },
      proactive: { enabled: false },
      sticker: { enabled: false },
      thinkingFiller: { enabled: true, afterMs: 3000 }
    }
  } });
  h.setMode('reserved2');
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

await withBridge(async (h) => {
  await h.sendWakePromptV2(PRIVATE, 'question');
  const sid = h.state.sessions[PRIVATE];
  ok(!!sid, '唤醒后拿到了私聊会话 id');
  const st = h.getSocialV2State(PRIVATE);
  st.lastIncomingAt = Date.now();
  st.turnSentCount = 0;
  const turnStart = Date.now() - 4000;
  h.v2TurnStartAt.set(sid, turnStart);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
  const before = h.calls.sent.length;
  h.maybeSendThinkingFillerV2(PRIVATE, sid, turnStart);
  await settle();                       // 发送走队列，等它落地
  const added = h.calls.sent.slice(before);
  ok(added.length === 1, '超时没开口时真的发了一条');
  ok(added[0]?.kind === 'private' && added[0]?.id === 10001, '发到了主人私聊');
  ok(['等下，我想想', '这个我得查一下，稍等', '嗯…让我理理'].includes(added[0]?.text), '发的是垫场话术：' + added[0]?.text);

  const mid = h.calls.sent.length;
  h.maybeSendThinkingFillerV2(PRIVATE, sid, turnStart);
  await settle();
  ok(h.calls.sent.length === mid, '同一回合只垫一次');

  st.turnSentCount = 1;
  const turnStart2 = Date.now() - 4000;
  h.v2TurnStartAt.set(sid, turnStart2);
  const mid2 = h.calls.sent.length;
  h.maybeSendThinkingFillerV2(PRIVATE, sid, turnStart2);
  await settle();
  ok(h.calls.sent.length === mid2, '她已经开口时不垫');

  st.turnSentCount = 0;
  h.v2TurnStartAt.delete(sid);
  const mid3 = h.calls.sent.length;
  h.maybeSendThinkingFillerV2(PRIVATE, sid, turnStart);
  await settle();
  ok(h.calls.sent.length === mid3, '回合结束后不垫');
});

await withBridge(async (h) => {
  await h.sendWakePromptV2(PRIVATE, 'question');
  const sid = h.state.sessions[PRIVATE];
  const st = h.getSocialV2State(PRIVATE);
  st.lastIncomingAt = Date.now() - 30 * 60 * 1000;
  st.turnSentCount = 0;
  const turnStart = Date.now() - 4000;
  h.v2TurnStartAt.set(sid, turnStart);
  const before = h.calls.sent.length;
  h.maybeSendThinkingFillerV2(PRIVATE, sid, turnStart);
  ok(h.calls.sent.length === before, '十分钟内没人找她（定时/主动唤醒）不垫');
});

console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;