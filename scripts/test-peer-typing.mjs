#!/usr/bin/env node
/**
 * 「等对方说完」回归：对方正在打字时，别抢话。
 *
 * 上游事实（SnowLuma 1.14.x，index.mjs 里 convertFriendInputStatus）：
 *   QQ 的 InputStatusNotify → notice/notify + sub_type=input_status
 *   { user_id, event_type, status_text }，event_type 1=正在输入 3=正在讲话
 *   **只有私聊**（friend_input_status），群聊上游不推。
 *
 * 这里要钉住的三件事，任何一件错了用户都会立刻感觉到：
 *   ① 群聊不能等 —— 上游不发这个事件，若判据写成「有信号就等」，
 *      将来上游真给群聊发了，群里会莫名其妙慢半拍；
 *   ② 等待必须有上限 —— 对方写长文时不能让她永远不说话；
 *   ③ 等待必须真发生在**发送之前** —— 只记状态不拦发送等于没做。
 *
 * 运行：node scripts/test-peer-typing.mjs
 */
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e?.message || e)); }
}

// 时间都调小：单测不该真等 6 秒。
const GRACE = 600;
const VOICE = 1200;
const CAP = 1500;

const h = await bridgeHarness({
  config: {
    socialV2: {
      peerTyping: { enabled: true, graceMs: GRACE, voiceGraceMs: VOICE, maxWaitMs: CAP },
      // 人类化首条延迟会干扰计时断言，关掉。
      send: { firstDelayEnabled: false },
      wake: { preSleepWaitEnabled: false },
      wait: { minMs: 0, maxMs: 0, minQuietAfterNewMs: 0 },
      proactive: { enabled: false },
      sticker: { enabled: false },
    },
  },
});
h.setMode('reserved2');

const OWNER = 'private:123';

console.log('## 记状态：只认私聊');

await t('私聊记录后剩余等待在 (0, grace] 内', () => {
  h.notePeerTyping(OWNER, 1);
  const left = h.peerTypingRemainingMs(OWNER);
  assert.ok(left > 0, '刚记录就该有剩余等待，实际 ' + left);
  assert.ok(left <= GRACE, '不能超过 graceMs，实际 ' + left);
});

await t('群聊 key 一律不记（上游根本不发群聊 typing）', () => {
  h.notePeerTyping('group:456', 1);
  assert.equal(h.peerTypingRemainingMs('group:456'), 0);
});

await t('非法 key / 空 key 不炸', () => {
  assert.equal(h.peerTypingRemainingMs(''), 0);
  assert.equal(h.peerTypingRemainingMs(null), 0);
  h.notePeerTyping(null, 1);
  h.notePeerTyping('', 1);
});

await t('录音（eventType=3）等得比打字久', () => {
  const key = 'private:901';
  h.notePeerTyping(key, 3);
  const left = h.peerTypingRemainingMs(key);
  assert.ok(left > GRACE, '录音宽限应长于打字宽限，实际 ' + left);
  assert.ok(left <= VOICE, '不能超过 voiceGraceMs，实际 ' + left);
});

await t('eventType 缺省 / 乱传当打字处理', () => {
  const a = 'private:902';
  const b = 'private:903';
  h.notePeerTyping(a, undefined);
  h.notePeerTyping(b, '乱写的');
  assert.ok(h.peerTypingRemainingMs(a) > 0);
  assert.ok(h.peerTypingRemainingMs(b) > 0);
  assert.ok(h.peerTypingRemainingMs(a) <= GRACE);
});

console.log('\n## 等待：真的等，且有上限');

await t('没信号时立即返回 0', async () => {
  const t0 = Date.now();
  const waited = await h.waitPeerTypingIdleV2('private:910');
  assert.equal(waited, 0);
  assert.ok(Date.now() - t0 < 100, '不该有任何等待');
});

await t('有信号时等掉剩余时间', async () => {
  const key = 'private:911';
  h.notePeerTyping(key, 1);
  const t0 = Date.now();
  const waited = await h.waitPeerTypingIdleV2(key);
  const elapsed = Date.now() - t0;
  assert.ok(waited > 0, '应该等到东西');
  // 允许 200ms 的调度误差（Windows 定时器精度差）
  assert.ok(elapsed >= GRACE - 200, `至少等 ${GRACE - 200}ms，实际 ${elapsed}`);
  assert.ok(elapsed < GRACE + 600, `不该超太多，实际 ${elapsed}`);
});

await t('等待结束后再查剩余是 0（不会重复等）', async () => {
  const key = 'private:912';
  h.notePeerTyping(key, 1);
  await h.waitPeerTypingIdleV2(key);
  assert.equal(h.peerTypingRemainingMs(key), 0);
});

await t('maxWaitMs 封顶：对方一直打，也不能无限等', async () => {
  const key = 'private:913';
  // 先给一次信号，再每 200ms 补一次，模拟对方持续输入。
  // 少了第一次信号，waitPeerTypingIdleV2 会在第一次检查就返回 0 —— 那不是 bug，
  // 是"还没开始打字"，第一版用例就栽在这里。
  h.notePeerTyping(key, 1);
  const pump = setInterval(() => h.notePeerTyping(key, 1), 200);
  const t0 = Date.now();
  const waited = await h.waitPeerTypingIdleV2(key);
  clearInterval(pump);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed <= CAP + 400, `必须被 maxWaitMs(${CAP}) 截断，实际 ${elapsed}`);
  assert.ok(waited >= CAP - 200, '应该等满上限，实际 ' + waited);
});

console.log('\n## 发送闸门：等待必须发生在发送之前');

// 发送要走白名单（夹具只放行 private:123 / group:456），所以这里必须用主人私聊。
// 上一用例等完之后信号已过期，下一个用例天然就是"没在打字"。
await t('对方在打字 ⇒ sendMessagesV2 被推迟', async () => {
  h.notePeerTyping(OWNER, 1);
  const t0 = Date.now();
  await h.sendMessagesV2(OWNER, ['在的'], [], null);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= GRACE - 200, `发送前应等 ${GRACE}ms，实际只用了 ${elapsed}`);
});

await t('没在打字 ⇒ 立刻发，不额外拖慢', async () => {
  const t0 = Date.now();
  await h.sendMessagesV2(OWNER, ['在的'], [], null);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 300, `不该有等待，实际 ${elapsed}`);
});

await t('等待期间对面又敲了两下 ⇒ 顺延（不是按旧时间戳醒）', async () => {
  const key = 'private:922';
  h.notePeerTyping(key, 1);
  // 半程时补一次信号，剩余时间应该被刷新
  const refreshAt = Math.round(GRACE * 0.6);
  const timer = setTimeout(() => h.notePeerTyping(key, 1), refreshAt);
  const t0 = Date.now();
  await h.waitPeerTypingIdleV2(key);
  clearTimeout(timer);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed > GRACE, `应被顺延到 ${refreshAt}+${GRACE}ms 以上，实际 ${elapsed}`);
});

await t('群聊发送完全不受影响', async () => {
  const key = 'group:456';
  h.notePeerTyping(key, 1); // 就算硬塞信号也不该生效
  const t0 = Date.now();
  await h.sendMessagesV2(key, ['在的'], [], null);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 300, `群里不该等，实际 ${elapsed}`);
});

await t('自动转发路径（auditAndSend）也让路', async () => {
  // 两条发送路径都要拦：只拦工具发送的话，自动转发照样抢话，用户感觉还是被抢。
  h.notePeerTyping(OWNER, 1);
  const t0 = Date.now();
  await h.auditAndSend(OWNER, '在的');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= GRACE - 200, `自动转发也该等 ${GRACE}ms，实际 ${elapsed}`);
});

console.log('\n## 开关：关掉就彻底不参与');

await t('enabled=false 时记也不记、等也不等', async () => {
  const h2 = await bridgeHarness({
    config: {
      socialV2: {
        peerTyping: { enabled: false, graceMs: 600, maxWaitMs: 1500 },
        send: { firstDelayEnabled: false },
        wake: { preSleepWaitEnabled: false },
        wait: { minMs: 0, maxMs: 0, minQuietAfterNewMs: 0 },
        proactive: { enabled: false },
        sticker: { enabled: false },
      },
    },
  });
  h2.setMode('reserved2');
  try {
    const key = 'private:123';
    h2.notePeerTyping(key, 1);
    assert.equal(h2.peerTypingRemainingMs(key), 0, '关掉后不该有剩余等待');
    const t0 = Date.now();
    await h2.sendMessagesV2(key, ['在的'], [], null);
    assert.ok(Date.now() - t0 < 300, '关掉后不该拖慢发送');
  } finally {
    await h2.close();
  }
});

await h.close();
console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
