// [patch DSH重启清残留] 回归网：DSH 重启后必须立刻解除「在途回合」占用（离线，不需要 DSH / QQ）。
//
// 为什么需要这个文件
// ------------------
// 2026-10-12 00:44:46 DSH 探活失败 → 00:45:12 重新就绪。DSH 重启时会重新挂载每个会话并补发一次
// **非回合事件**，于是 bridge 的 `collectors.set(sessionId, …)` 把这些会话建了起来；而那一轮的
// `turn/end` 永远不会到（旧进程已经死了），`busyPartsV2` 就一直报 `collectorOpen`，
// `isConversationBusyV2` 恒为真 —— 表现就是「她好像没反应」：
//   00:45:57 private:seq189 … 00:51:05 private:seq196 共 8 条（含 2 次拍一拍）
//   全被 `[reserved2] 会话繁忙，暂存唤醒原因` 挡下，她的 turn/start 停在 7 次一次都没跑。
// 整整 8 分钟（V2_BUSY_STALE_MS = 480000）之后 collector 过期才自愈 —— 中间靠「呆住看门狗」在
// 00:53:31 补了一次唤醒，她才醒过来（00:53:42 真发了一条 QQ空间说说）。
//
// 修法：`checkDsh` 里 `dshReady` 由 false 变 true（且中断 ≥ 8s）时调 releaseInflightOnDshRestart：
// 清掉该会话的五个「回合态」标记并补发积压唤醒。这里把该函数**源码抽出来真跑**，
// 而不是只 grep 关键字 —— grep 过的代码照样可以是错的。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// bridge.js 在 Windows 上是 CRLF：先归一化成 \n 再切片/匹配，否则按行锚点会全部落空。
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

// ── 抽源码：只取函数本体（从 `function releaseInflightOnDshRestart` 到 `return released; }`） ──
const FN_START = 'function releaseInflightOnDshRestart(reason) {';
const FN_END = '\n    return released;\n  }';
const start = bridgeSrc.indexOf(FN_START);
const end = start >= 0 ? bridgeSrc.indexOf(FN_END, start) : -1;
const fnSrc = start >= 0 && end > 0 ? bridgeSrc.slice(start, end + FN_END.length) : '';

console.log('## 函数本体');
ok(fnSrc.length > 0, '在 bridge.js 里找到了 releaseInflightOnDshRestart 的完整函数体');
ok(!/pendingWakeKeys/.test(fnSrc), '函数体只清「回合态」标记，不碰 pendingWakeKeys（它有自己的 30 分钟租约）');

// 真跑：把函数体塞进 new Function，注入桩变量。
const ARGS = ['socialV2', 'state', 'collectors', 'v2TurnStartAt', 'v2LastFrameAt',
  'pendingSendToolCalls', 'toolCallNames', 'getSocialV2State', 'scheduleWakeV2', 'log', 'dshQueueEnabledV2',
  'redriveInterruptedOnRestart'];
let releaseFactory = null;
try {
  releaseFactory = new Function(...ARGS, `${fnSrc}\n    return releaseInflightOnDshRestart;`);
} catch (error) {
  ok(false, `函数体可编译（${error?.message ?? error}）`);
}

function scenario({ sessions, keys, states, marks, queueEnabled = true }) {
  const socialV2 = { conversations: new Map(keys.map((k) => [k, {}])) };
  const maps = {
    collectors: new Map(),
    v2TurnStartAt: new Map(),
    v2LastFrameAt: new Map(),
    pendingSendToolCalls: new Map(),
    toolCallNames: new Map()
  };
  for (const [sid, names] of Object.entries(marks || {})) {
    for (const n of names) maps[n].set(sid, true);
  }
  const logs = [];
  const scheduled = [];
  const redriveCalls = [];
  // 工厂调用一次 = 把桩变量绑进闭包，返回真正可跑的 releaseInflightOnDshRestart。
  const release = releaseFactory(
    socialV2,
    { sessions },
    maps.collectors,
    maps.v2TurnStartAt,
    maps.v2LastFrameAt,
    maps.pendingSendToolCalls,
    maps.toolCallNames,
    (k) => states[k] ?? {},
    (k, r) => scheduled.push([k, r]),
    (...a) => logs.push(a.join(' ')),
    () => queueEnabled,
    (k, sid, label) => redriveCalls.push([k, sid, label])
  );
  const released = release('DSH 中断 26s');
  return { released, maps, logs, scheduled, states, redriveCalls };
}

console.log('## 清标记 + 补发积压（复现 2026-10-12 00:45 那次卡死的现场）');
if (releaseFactory) {
  const r = scenario({
    sessions: { 'private:10001': 'sid-old', 'group:666560256': 'sid-group' },
    keys: ['private:10001', 'group:666560256'],
    states: {
      'private:10001': { pendingWakeReasons: [{ reason: 'private', seq: 189 }, { reason: 'poke', seq: 190 }, { reason: 'private', seq: 196 }] },
      'group:666560256': { pendingWakeReasons: [] }
    },
    marks: {
      'sid-old': ['collectors', 'v2TurnStartAt', 'v2LastFrameAt', 'pendingSendToolCalls', 'toolCallNames'],
      'sid-group': ['collectors']
    }
  });
  ok(r.released === 2, `两个会话都清理了在途标记（released=${r.released}）`);
  ok([...r.maps.collectors.keys()].length === 0, 'collectors 清空（本次卡死的元凶就是它）');
  ok([...r.maps.v2TurnStartAt.keys()].length === 0, 'v2TurnStartAt 清空（旧进程的 turn/start 不会再结束）');
  ok([...r.maps.v2LastFrameAt.keys()].length === 0, 'v2LastFrameAt 清空');
  ok([...r.maps.pendingSendToolCalls.keys()].length === 0, 'pendingSendToolCalls 清空');
  ok([...r.maps.toolCallNames.keys()].length === 0, 'toolCallNames 清空');
  ok(r.scheduled.length === 1 && r.scheduled[0][0] === 'private:10001',
    '只给有积压的会话补发唤醒（群里没积压就不吵它）');
  ok(r.scheduled[0]?.[1] === 'private', "补发用的是最后一条积压原因（取 ''private''，即主人那 8 条里的末条）");
  ok((r.states['private:10001'].pendingWakeReasons || []).length === 0, '补发后积压队列被取空（不会重复补发）');
  ok(r.logs.some((l) => /\[DSH重启\].*清理在途标记/.test(l)), '日志里留下可 grep 的 [DSH重启] 清理在途标记');
  ok(r.logs.some((l) => /共 3 条/.test(l)), '日志里写明补发了几条积压');

  const clean = scenario({
    sessions: { 'private:1': 'sid-a' }, keys: ['private:1'], states: { 'private:1': { pendingWakeReasons: [] } }, marks: {}
  });
  ok(clean.released === 0 && clean.scheduled.length === 0, '空闲会话不受影响（released=0，不补发）');

  const orphan = scenario({
    sessions: {}, keys: ['private:1'], states: { 'private:1': { pendingWakeReasons: [{ reason: 'private', seq: 9 }] } },
    marks: { 'sid-a': ['collectors'] }
  });
  ok(orphan.released === 0, '没有会话映射的 key 直接跳过（内存里的孤儿标记不该误伤）');
  ok([...orphan.maps.collectors.keys()].length === 1, '跳过的 key 不会被改动');

  // [patch 信息队列禁用]（用户 m03167）：默认不补发积压唤醒 —— 那条「过峰后补跑」就是一轮全上下文的大额 token。
  const noQueue = scenario({
    sessions: { 'private:10001': 'sid-old', 'group:666560256': 'sid-group' },
    keys: ['private:10001', 'group:666560256'],
    states: {
      'private:10001': { pendingWakeReasons: [{ reason: 'private', seq: 189 }, { reason: 'poke', seq: 190 }, { reason: 'private', seq: 196 }] },
      'group:666560256': { pendingWakeReasons: [] }
    },
    marks: { 'sid-old': ['collectors', 'v2TurnStartAt'], 'sid-group': ['collectors'] },
    queueEnabled: false
  });
  ok(noQueue.scheduled.length === 0, '信息队列关闭时：一条积压唤醒都不补发（零 token）');
  ok((noQueue.states['private:10001'].pendingWakeReasons || []).length === 0, '积压原因照样被取空（不留在内存里）');
  ok(noQueue.logs.some((l) => /丢弃 3 条积压唤醒（信息队列已禁用）/.test(l)), '日志写明丢弃了几条积压（可 grep）');
  ok(noQueue.logs.some((l) => /清理在途标记/.test(l)), '在途标记照样清理（该修的卡死还是会修好）');

  // ── [patch 中断补跑] 2026-10-16 真发生过：Harness 在 qq_send_message 调用中途死掉，
  // dsh-session 事后补了一条 "The tool call was interrupted ..."，那句回复根本没发出去，
  // 而 bridge 只认 completed/error/aborted，interrupted 被静默丢弃。这里钉住重启那条路。
  const lostSend = scenario({
    sessions: { 'private:10001': 'sid-lost' },
    keys: ['private:10001'],
    states: { 'private:10001': { pendingWakeReasons: [] } },
    marks: { 'sid-lost': ['collectors', 'pendingSendToolCalls'] }
  });
  ok(lostSend.released === 1, '有消息在途中的会话照样被清标记');
  ok(lostSend.redriveCalls.length === 1, 'send_message 发出去却没等到结果 ⇒ 重启后补跑一次「回头检查」');
  ok(lostSend.redriveCalls[0]?.[0] === 'private:10001', '补跑对准原来是那个会话');
  ok(lostSend.redriveCalls[0]?.[1] === 'sid-lost', '补跑用重启前的 sessionId');

  const sendNoMark = scenario({
    sessions: { 'private:1': 'sid-b' }, keys: ['private:1'], states: { 'private:1': { pendingWakeReasons: [] } },
    marks: { 'sid-b': ['collectors'] }
  });
  ok(sendNoMark.redriveCalls.length === 0, '没有在途 send_message 就不补跑（别为了重启白烧一轮）');

  const sendWithBacklog = scenario({
    sessions: { 'private:1': 'sid-c' }, keys: ['private:1'],
    states: { 'private:1': { pendingWakeReasons: [{ reason: 'private', seq: 7 }] } },
    marks: { 'sid-c': ['collectors', 'pendingSendToolCalls'] }
  });
  ok(sendWithBacklog.scheduled.length === 1 && sendWithBacklog.redriveCalls.length === 0,
    '已经有积压唤醒要补发时不再额外补跑（那一轮自己会看到未读，别烧两次）');
}

console.log('## 触发条件（bridge.js 里的接线）');
ok(/if \(downMs >= 8000\) \{[\s\S]{0,160}releaseInflightOnDshRestart\(/.test(bridgeSrc),
  'dshReady 由 false→true 且中断 ≥ 8s 才清（一次偶发探活失败不清正在跑的回合）');
ok(/dshDownSince = Date\.now\(\);[\s\S]{0,80}DSH 不可用/.test(bridgeSrc), 'DSH 探活失败时记下 dshDownSince');
ok(/const downMs = dshDownSince \? Date\.now\(\) - dshDownSince : 0;/.test(bridgeSrc), '就绪时算出中断时长');
ok(/DSH 已就绪（模式: \$\{currentMode\}）\$\{downMs >= 1000 \? `（中断 \$\{Math\.round\(downMs \/ 1000\)\}s）` : ''\}/.test(bridgeSrc),
  '就绪日志带上「中断 Ns」，下次从日志一眼能看出是不是刚重启过');
ok(/V2_BUSY_PART_HOLDING = new Set\(\['pendingWakeTimer', 'pendingWakeKeys', 'queueRunning', 'queueBacklog', 'turnOpen', 'collectorOpen'\]\)/.test(bridgeSrc),
  'busy 占用源清单没变（collectorOpen 仍是其中一个，所以必须靠重启清残留）');
ok(/const V2_BUSY_STALE_MS = 480000/.test(bridgeSrc),
  'collector 兜底过期仍是 8 分钟 ⇒ 没有这道修复，重启后就是饿 8 分钟');
ok(/items\.length && dshQueueEnabledV2\(\)[\s\S]{0,900}丢弃 \$\{items\.length\} 条积压唤醒（信息队列已禁用）/.test(bridgeSrc),
  '[patch 信息队列禁用] bridge.js 里积压唤醒的补发受 dshQueueEnabledV2 管，默认只丢弃');
ok(/else if \(ended\.reason\.kind === 'interrupted'\)/.test(bridgeSrc),
  '[patch 中断补跑] 回合结束的分支里有 interrupted（以前只认 completed/error/aborted，中断被静默丢弃）');
ok(/INTERRUPT_RETRY_HINT/.test(bridgeSrc) && /claimMalformedRetry\(interruptRetryAt/.test(bridgeSrc),
  '[patch 中断补跑] 中断补跑受 interruptRetryAt 冷却管，不会每次抖动都烧一轮');
ok(/if \(hadPendingSend && !items\.length\) redriveInterruptedOnRestart\(/.test(bridgeSrc),
  '[patch 中断补跑] 重启清残留时按「有没有在途 send_message」决定补不补跑');

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
