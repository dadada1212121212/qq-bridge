// 坏 JSON 修复重试（src/malformed-retry.js）的离线单测。
// 背景：模型偶发把工具调用参数写成非法 JSON，provider 那 5 次重试复用同一段上下文救不回来；
// 桥接因此补一次「明说问题在哪」的重跑。这里钉住申报逻辑与提示词本身，不连 DSH、不连 QQ。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INTERRUPT_RETRY_COOLDOWN_MS,
  INTERRUPT_RETRY_HINT,
  MALFORMED_RETRY_COOLDOWN_MS,
  MALFORMED_RETRY_HINT,
  claimMalformedRetry,
  isMalformedCode,
} from '../src/malformed-retry.js';

test('isMalformedCode 认得 provider 的几种写法', () => {
  assert.equal(isMalformedCode('MALFORMED_RESPONSE'), true);
  assert.equal(isMalformedCode('malformed_response'), true);
  assert.equal(isMalformedCode(' MALFORMED_RESPONSE '), true);
  assert.equal(isMalformedCode('INVALID_REQUEST'), false);
  assert.equal(isMalformedCode(''), false);
  assert.equal(isMalformedCode(undefined), false);
});

test('第一次补跑放行，冷却窗口内不再放行', () => {
  const store = new Map();
  const t0 = 1_000_000;
  assert.equal(claimMalformedRetry(store, 'private:1', t0), true);
  assert.equal(claimMalformedRetry(store, 'private:1', t0 + 1), false);
  assert.equal(claimMalformedRetry(store, 'private:1', t0 + MALFORMED_RETRY_COOLDOWN_MS - 1), false);
  // 冷却到点后重新放行（不是永久封锁：同一个会话以后还可能再犯）
  assert.equal(claimMalformedRetry(store, 'private:1', t0 + MALFORMED_RETRY_COOLDOWN_MS), true);
});

test('不同会话互不影响', () => {
  const store = new Map();
  const now = 2_000_000;
  assert.equal(claimMalformedRetry(store, 'private:1', now), true);
  assert.equal(claimMalformedRetry(store, 'group:2', now), true);
});

test('key 缺失或非法时一律拒绝（不允许匿名补跑）', () => {
  const store = new Map();
  assert.equal(claimMalformedRetry(store, '', 1), false);
  assert.equal(claimMalformedRetry(store, null, 1), false);
  assert.equal(claimMalformedRetry(null, 'private:1', 1), false);
  assert.equal(store.size, 0, '被拒绝的申请不该写状态');
});

test('补跑提示必须点出「上一轮死于非法 JSON」并给出可执行写法', () => {
  assert.match(MALFORMED_RETRY_HINT, /JSON/);
  assert.match(MALFORMED_RETRY_HINT, /裸换行/);
  assert.match(MALFORMED_RETRY_HINT, /拆成多条/);
  // 别把「系统提示」写成对方说的话，否则模型会以为群友在教它
  assert.match(MALFORMED_RETRY_HINT, /系统提示/);
});

// ── 回合被中断的补跑（2026-10-18）──────────────────────────────────────────
// 背景：Harness 进程在回合中途死掉/被强杀，dsh-session 会在下次开会话时补一条
// "The tool call was interrupted ..." 收尾事件；那时模型想发的那句话就丢了。
test('中断补跑：同一个会话在冷却窗口内只补一次', () => {
  const store = new Map();
  const t0 = 3_000_000;
  assert.equal(INTERRUPT_RETRY_COOLDOWN_MS, 5 * 60 * 1000);
  assert.equal(claimMalformedRetry(store, 'private:1', t0, INTERRUPT_RETRY_COOLDOWN_MS), true);
  assert.equal(claimMalformedRetry(store, 'private:1', t0 + 60_000, INTERRUPT_RETRY_COOLDOWN_MS), false);
  assert.equal(claimMalformedRetry(store, 'private:1', t0 + INTERRUPT_RETRY_COOLDOWN_MS, INTERRUPT_RETRY_COOLDOWN_MS), true);
});

test('中断补跑提示：说清「被打断/可能有话没发出去」，且不许把提示说出来', () => {
  assert.match(INTERRUPT_RETRY_HINT, /系统提示/);
  assert.match(INTERRUPT_RETRY_HINT, /打断/);
  assert.match(INTERRUPT_RETRY_HINT, /没发出去/);
  assert.match(INTERRUPT_RETRY_HINT, /别把这段提示说出来/);
  // 不许让它复述业务内容或重发已发过的
  assert.match(INTERRUPT_RETRY_HINT, /别重复/);
});

