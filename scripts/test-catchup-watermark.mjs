// [patch 补拉时限 + 启动先用本地模式 + 补拉水位] 回归网（离线，不需要 QQ 在线）。
//
// 为什么需要这个文件
// ------------------
// 主人 m01940：「有时候他会回去重新处理已经处理好的聊天记录」。根因是三件事叠在一起：
//   ① 桥接在 DSH 不可达时启动，currentMode 会一直停在硬编码的 'chat'（refreshMode()
//      只在 checkDsh 探活成功时被调用）→ 入站消息全走一代路径；
//   ② 一代路径不写 reserved2 的 lastIncomingAt 水位 → 这些消息对补拉看门狗完全不可见；
//   ③ 补拉只比「水位 vs QQ 历史里的服务器时间」，没有任何时限 → 水位一旦严重滞后，就把
//      几小时甚至十几小时前的旧消息当成「从未入站」重新补回、再叫醒她一次。
// 三处判定都是「做错了也未必看得出来」的那类：日志里只表现为她偶尔回一句过期的废话，
// 或者干脆没人发现。所以这里把 catchUpMissedV2 从 bridge.js 里抽出来真跑（注入假 Date、
// 假 OneBot、假唤醒判定），再用源码断言钉住另外两处。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

const bridgeSrc = read('src/bridge.js');
const cfg = JSON.parse(read('config.json'));
const example = JSON.parse(read('config.example.json'));

/** 从 bridge.js 里切一段源码出来（找不到就报失败并返回空串）。 */
function sliceBetween(startAnchor, endAnchor, label) {
  const a = bridgeSrc.indexOf(startAnchor);
  const b = a < 0 ? -1 : bridgeSrc.indexOf(endAnchor, a);
  const found = a >= 0 && b > a;
  ok(found, `${label}能在 bridge.js 里定位（${startAnchor.slice(0, 46)}…）`);
  return found ? bridgeSrc.slice(a, b) : '';
}

// 假钟：把抽出来的源码里的 `Date.now()` / `new Date()` 固定到某个时刻。
function fixedDate(ms) {
  return class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(ms); }
    static now() { return ms; }
  };
}

// ── 抽源码：历史消息转文本 + 补拉主逻辑 ──────────────────────────────────────
const histTextSrc = sliceBetween(
  'function historyMessageTextV2(m) {',
  'async function catchUpMissedV2(key, opts = {}) {',
  '历史消息转文本 helper'
);
const catchUpSrc = sliceBetween(
  'async function catchUpMissedV2(key, opts = {}) {',
  '  function startCatchUpWatch() {',
  '补拉主逻辑 catchUpMissedV2'
);

const KEY = 'private:10001';
const SELF_UIN = '3877661691';
const OWNER_QQ = '10001';

/**
 * 搭一个只跑 catchUpMissedV2 的沙箱。
 * @param {object} o
 * @param {number} o.nowMs          假钟当前时刻
 * @param {object} o.st              该会话的 reserved2 状态（lastIncomingAt / recentMessages / unread …）
 * @param {object[]} o.history       OneBot get_*_msg_history 返回的消息
 * @param {object} o.wake            cfg.socialV2.wake 覆盖项（catchUpMaxAgeMs 等）
 * @param {string} o.wakeReason      假唤醒判定返回的原因（'' = 不打扰）
 * @param {string} o.currentMode     默认 reserved2，用来验证模式守卫
 */
function makeSandbox({ nowMs, st, history, wake = {}, wakeReason = '', currentMode = 'reserved2' }) {
  const cfgIn = { ownerQQ: OWNER_QQ, socialV2: { wake, enabled: true } };
  const socialV2 = { conversations: new Map([[KEY, st]]), paused: false };
  const logs = [];
  const activity = [];
  const appended = [];
  const wakes = [];
  const calls = [];
  const deps = {
    cfg: cfgIn,
    socialV2,
    currentMode,
    isSessionAllowedInCurrentMode: () => true,
    catchUpLastAt: new Map(),
    CATCHUP_MIN_GAP_MS: 60_000,
    oneBotCall: async (action, params) => { calls.push({ action, params }); return { messages: history }; },
    log: (m) => logs.push(String(m)),
    selfUinV2: async () => SELF_UIN,
    appendSocialV2Message: (...args) => appended.push(args),
    appendActivity: (m) => activity.push(String(m)),
    getSocialV2State: () => st,
    isConversationBusyV2: () => false,
    evaluateWakeTriggerV2: () => wakeReason,
    scheduleWakeV2: (key, reason) => wakes.push(reason),
  };
  const factory = new Function(
    'deps',
    'Date',
    `const { cfg, socialV2, currentMode, isSessionAllowedInCurrentMode, catchUpLastAt,
             CATCHUP_MIN_GAP_MS, oneBotCall, log, selfUinV2, appendSocialV2Message,
             appendActivity, getSocialV2State, isConversationBusyV2, evaluateWakeTriggerV2,
             scheduleWakeV2 } = deps;
     ${histTextSrc}
     ${catchUpSrc}
     return { catchUpMissedV2 };`
  );
  const { catchUpMissedV2 } = factory(deps, fixedDate(nowMs));
  return { run: (opts) => catchUpMissedV2(KEY, opts), logs, activity, appended, wakes, calls, st };
}

const textMsg = (id, timeSec, text, userId = '99') => ({
  message_id: id,
  time: timeSec,
  sender: { user_id: userId, nickname: `群友${userId}` },
  message: [{ type: 'text', data: { text } }],
});

const emptySt = (lastIncomingAt) => ({ lastIncomingAt, recentMessages: [], unread: [], lastUnreadSeq: 7 });
const HOUR = 3600_000;

// ── ① 核心回归：水位滞后 15 小时 ⇒ 旧消息不许重放，新消息照补 ──────────────────
console.log('## 补拉时限（主人 m01940 的场景）');
{
  const now = 1_760_000_000_000;
  const box = makeSandbox({
    nowMs: now,
    st: emptySt(now - 15 * HOUR),
    wake: { catchUpMaxAgeMs: 900_000 },
    history: [
      textMsg(101, Math.floor((now - 3 * HOUR) / 1000), '这样啊'),   // 早就聊过、水位却落后 15 小时
      textMsg(102, Math.floor((now - 30_000) / 1000), '在吗'),       // 真的漏了（30 秒前）
    ],
  });
  const n = await box.run();
  ok(n === 1, `只补回 1 条（实际 ${n} 条）`);
  ok(box.appended.length === 1 && box.appended[0][2] === '在吗',
    `补回来的是 30 秒前那条（实际 ${box.appended.map((a) => a[2]).join('/') || '无'}）`);
  ok(box.logs.some((l) => /忽略 1 条过期未入站消息/.test(l)), '日志里明确写了「忽略 1 条过期未入站消息」');
  ok(!box.logs.some((l) => /这样啊/.test(l)), '3 小时前那句「这样啊」没有出现在补拉日志里');
}

// ── ② 全是过期消息 ⇒ 一条都不补，也不叫醒她 ─────────────────────────────────
{
  const now = 1_760_000_000_000;
  const box = makeSandbox({
    nowMs: now,
    st: emptySt(now - 15 * HOUR),
    wake: { catchUpMaxAgeMs: 900_000 },
    history: [textMsg(201, Math.floor((now - 3 * HOUR) / 1000), '睡了吗？')],
    wakeReason: 'private',
  });
  const n = await box.run();
  ok(n === 0 && box.appended.length === 0, '过期的漏消息不再入未读（0 条）');
  ok(box.wakes.length === 0, '没有触发任何唤醒');
  ok(box.logs.some((l) => /忽略 1 条过期未入站消息/.test(l)), '仍然留下一行可 grep 的忽略日志');
}

// ── ③ 配 catchUpMaxAgeMs=0 ⇒ 回到旧行为（明确要无限补时才这样） ──────────────
{
  const now = 1_760_000_000_000;
  const box = makeSandbox({
    nowMs: now,
    st: emptySt(now - 15 * HOUR),
    wake: { catchUpMaxAgeMs: 0 },
    history: [textMsg(301, Math.floor((now - 3 * HOUR) / 1000), '睡了吗？')],
  });
  const n = await box.run();
  ok(n === 1 && box.appended.length === 1, '配 0 = 不限时限，旧行为保留（想无限补就得显式配 0）');
  ok(!box.logs.some((l) => /忽略/.test(l)), '不限时限时不会打印忽略日志');
}

// ── ④ 原有的 message_id 去重没被时限改动挤掉 ────────────────────────────────
{
  const now = 1_760_000_000_000;
  const st = emptySt(now - 5 * 60_000);
  st.recentMessages = [{ messageId: '555', text: '刚说过' }];
  const box = makeSandbox({
    nowMs: now,
    st,
    wake: { catchUpMaxAgeMs: 900_000 },
    history: [textMsg(555, Math.floor((now - 2 * 60_000) / 1000), '刚说过')],
  });
  const n = await box.run();
  ok(n === 0 && box.appended.length === 0, '已经记在 recentMessages 里的 message_id 仍然被跳过');
}

// ── ⑤ 时限内的真漏消息：照补，并且该叫醒就叫醒 ─────────────────────────────
{
  const now = 1_760_000_000_000;
  const box = makeSandbox({
    nowMs: now,
    st: emptySt(now - 5 * 60_000),
    wake: { catchUpMaxAgeMs: 900_000 },
    history: [textMsg(401, Math.floor((now - 2 * 60_000) / 1000), '大肥鱼在吗')],
    wakeReason: 'atMention',
  });
  const n = await box.run();
  ok(n === 1 && box.appended.length === 1, '时限内的漏消息照补（补拉的本职没被削弱）');
  ok(box.wakes.length === 1 && box.wakes[0] === 'backfill:atMention', `命中唤醒条件会叫醒她（${box.wakes[0] ?? '无'}）`);
  ok(box.logs.some((l) => /补拉触发唤醒（atMention）/.test(l)), '日志里有「补拉触发唤醒」');
}

// ── ⑥ 同会话最小间隔 + 模式守卫 ────────────────────────────────────────────
{
  const now = 1_760_000_000_000;
  const box = makeSandbox({
    nowMs: now,
    st: emptySt(now - 5 * 60_000),
    wake: { catchUpMaxAgeMs: 900_000 },
    history: [textMsg(501, Math.floor((now - 60_000) / 1000), '喂')],
  });
  await box.run();
  const second = await box.run();
  ok(second === 0 && box.calls.length === 1, `60 秒最小间隔内的第二次核对直接返回（拉历史 ${box.calls.length} 次）`);
}
{
  const now = 1_760_000_000_000;
  const box = makeSandbox({
    nowMs: now,
    st: emptySt(now - 5 * 60_000),
    wake: { catchUpMaxAgeMs: 900_000 },
    history: [textMsg(601, Math.floor((now - 60_000) / 1000), '喂')],
    currentMode: 'chat',
  });
  const n = await box.run();
  ok(n === 0 && box.calls.length === 0, '不是 reserved2 模式时补拉根本不启动');
}

// ── ⑦ 源码断言：三处补丁都在该在的位置 ──────────────────────────────────────
console.log('## 源码断言（三处补丁的位置与默认值）');
{
  const refreshAt = bridgeSrc.indexOf('await refreshMode();');
  const dshWatchAt = bridgeSrc.indexOf('\n  startDshWatch();');
  ok(refreshAt > 0 && dshWatchAt > 0 && refreshAt < dshWatchAt,
    '启动时先 await refreshMode()，再 startDshWatch()（DSH 不在线也能定成 reserved2）');
  ok(/\[bridge\] 启动模式：\$\{currentMode\}/.test(bridgeSrc), '启动日志会打印实际生效的模式与来源');
  ok(/modeFromDsh = true;/.test(bridgeSrc) && /currentMode = fromLocal; modeFromDsh = false;/.test(bridgeSrc),
    'refreshMode 两条分支都记下模式来源（DSH / 本地）');
  ok(/let currentMode = 'chat';/.test(bridgeSrc),
    '硬编码默认仍是 chat（这正是 DSH 离线启动时踩坑的原因，保持不变但由启动处兜住）');

  ok(/\[patch 补拉时限\]/.test(bridgeSrc), '补拉时限补丁标记在');
  ok(/catchUpMaxAgeMs \?\? 15 \* 60_000/.test(bridgeSrc), '默认时限是 15 分钟');
  ok(/if \(tMs <= floorMs \+ 1000\)/.test(bridgeSrc), '过滤用的是带时限的 floorMs');
  ok(/if \(tMs > sinceMs \+ 1000\) skippedOld \+= 1;/.test(bridgeSrc), '被时限挡下的条数会单独计数');

  const reservedLogAt = bridgeSrc.indexOf('[reserved2] 消息已入未读');
  const watermarkAt = bridgeSrc.indexOf('stWatermark.lastIncomingAt = Date.now();');
  ok(/\[patch 补拉水位\]/.test(bridgeSrc), '补拉水位补丁标记在');
  ok(reservedLogAt > 0 && watermarkAt > reservedLogAt,
    '推水位的代码在一代路径上（reserved2 分支已经在上面 return 掉了）');
  ok(/const stWatermark = socialV2\.conversations\.get\(key\);/.test(bridgeSrc),
    '只推已有会话的水位，不给没跑过 reserved2 的 key 凭空造状态');
}

// ── ⑧ 配置可发现性：两个 config 里都写明了这个 knob ─────────────────────────
console.log('## 配置');
{
  ok(cfg.socialV2?.wake?.catchUpMaxAgeMs === 900_000, 'config.json：catchUpMaxAgeMs=900000（15 分钟）');
  ok(example.socialV2?.wake?.catchUpMaxAgeMs === 900_000, 'config.example.json 也写了，方便以后发现这个 knob');
  ok(cfg.socialV2?.wake?.catchUpIntervalMs === 45000 && cfg.socialV2?.wake?.catchUpMinGapMs === 60000,
    '原有的 catchUpIntervalMs / catchUpMinGapMs 没被改动');
}

console.log(`\n补拉去重/时限回归：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
