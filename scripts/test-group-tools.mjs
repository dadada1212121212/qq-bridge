// 群内小工具（投票 / 抽签决定）纯逻辑测试 —— 不起 harness，跑得快。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startPoll, castVote, closePoll, tallyPoll, decideAmong,
  renderPoll, renderDecide
} from '../src/group-tools.js';

test('投票：开局要求至少 2 个选项', () => {
  assert.throws(() => startPoll({ options: ['只有一个'] }), /2 个选项/);
});

test('投票：选项去重校验', () => {
  assert.throws(() => startPoll({ options: ['A', 'A'] }), /不能重复/);
});

test('投票：最多 10 个选项', () => {
  const many = Array.from({ length: 11 }, (_, i) => `选项${i}`);
  assert.throws(() => startPoll({ options: many }), /最多 10/);
});

test('投票：空白选项被过滤', () => {
  const p = startPoll({ options: ['吃火锅', '  ', '吃烧烤'] });
  assert.equal(p.options.length, 2);
});

test('投票：正常投票与计票', () => {
  const p = startPoll({ options: ['火锅', '烧烤', '日料'], title: '今晚吃啥' });
  castVote(p, { choice: 1, voter: '小张' });
  castVote(p, { choice: 1, voter: '小李' });
  castVote(p, { choice: 2, voter: '小王' });
  const t = tallyPoll(p);
  assert.deepEqual([...t.counts], [2, 1, 0]);
  assert.equal(t.total, 3);
  assert.equal(t.winner, 0);
  assert.equal(t.tie, false);
});

test('投票：同一人重复投算改票，不加票数', () => {
  const p = startPoll({ options: ['A', 'B'] });
  const r1 = castVote(p, { choice: 1, voter: '小张' });
  const r2 = castVote(p, { choice: 2, voter: '小张' });
  assert.equal(r1.wasFirst, true);
  assert.equal(r2.changed, true);
  const t = tallyPoll(p);
  assert.deepEqual([...t.counts], [0, 1]);
  assert.equal(t.total, 1, '改票不该让总票数变 2');
});

test('投票：平局如实标出，不擅自选赢家', () => {
  const p = startPoll({ options: ['A', 'B'] });
  castVote(p, { choice: 1, voter: 'x' });
  castVote(p, { choice: 2, voter: 'y' });
  const t = tallyPoll(p);
  assert.equal(t.tie, true);
  assert.equal(t.winner, null);
  assert.deepEqual([...t.winners], [0, 1]);
  assert.match(renderPoll(p, t), /打平/);
});

test('投票：选项序号越界报错', () => {
  const p = startPoll({ options: ['A', 'B'] });
  assert.throws(() => castVote(p, { choice: 3, voter: 'x' }), /1~2/);
  assert.throws(() => castVote(p, { choice: 0, voter: 'x' }), /1~2/);
});

test('投票：投票人不能为空', () => {
  const p = startPoll({ options: ['A', 'B'] });
  assert.throws(() => castVote(p, { choice: 1, voter: '  ' }), /投票人/);
});

test('投票：结束后不能再投', () => {
  const p = startPoll({ options: ['A', 'B'] });
  castVote(p, { choice: 1, voter: 'x' });
  closePoll(p);
  assert.throws(() => castVote(p, { choice: 2, voter: 'y' }), /已经结束/);
});

test('投票：超时自动判为结束', () => {
  const p = startPoll({ options: ['A', 'B'], dueMs: 1000 });
  p.endsAt = Date.now() - 1;   // 手工把它推到过去，模拟时间到了
  assert.throws(() => castVote(p, { choice: 1, voter: 'x' }), /时间到|结束/);
  assert.equal(p.status, 'closed');
});

test('投票：渲染结果文案含赢家名', () => {
  const p = startPoll({ options: ['火锅', '烧烤'], title: '吃啥' });
  castVote(p, { choice: 1, voter: 'a' });
  castVote(p, { choice: 1, voter: 'b' });
  const text = renderPoll(p, closePoll(p));
  assert.match(text, /火锅/);
  assert.match(text, /赢了/);
});

test('投票：零票结束有专门文案', () => {
  const p = startPoll({ options: ['A', 'B'] });
  const text = renderPoll(p, closePoll(p));
  assert.match(text, /没人投票/);
});

test('抽签决定：从选项里真随机选一个', () => {
  const r = decideAmong(['火锅', '烧烤', '日料']);
  assert.ok(['火锅', '烧烤', '日料'].includes(r.picked));
  assert.equal(r.options[r.index], r.picked);
  assert.match(renderDecide(r), /抽中了/);
});

test('抽签决定：空列表报错', () => {
  assert.throws(() => decideAmong([]), /空/);
  assert.throws(() => decideAmong('不是数组'), /必须是数组/);
});

test('抽签决定：单选项也返回它', () => {
  const r = decideAmong(['只有这个']);
  assert.equal(r.picked, '只有这个');
});

test('抽签决定：真随机（大样本不该只出一种）', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(decideAmong(['A', 'B', 'C']).picked);
  assert.equal(seen.size, 3, '三次抽签应能覆盖到全部三种');
});
