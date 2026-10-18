// 「主人私聊一天至少主动找一次」的注册期回归网（纯源码断言，不起桥接、不碰 QQ）。
//
// 为什么需要它：原来的主动机会是软的 —— 每 30~90 分钟随机判一次、按概率开口
// （默认 probability 0.3，深夜 ×0.3、刚说过话 ×0.5、一小时内已发 5 条 ×0.3），
// 结果是「她可能一整天都没主动找过主人」；用户明确要求把它变成硬指标。
// 现在：主人私聊距上次主动机会超过 ownerProactiveMinIntervalMs（默认 20h ≈ 每天一次）时，
// 只要不忙、过了空闲阈值、且不在深夜，就跳过概率直接投放一次主动机会。
// 这条网盯四件事：
//   1) 保底真的存在（默认值 + 归一化白名单 + config.json 三处都在，缺一处等于配置写不进去）；
//   2) 只对主人私聊生效（别把保底撒到群里变成刷屏）；
//   3) 深夜不硬叫、忙的时候不打扰（保底不能把「人情味」变成「骚扰」）；
//   4) 投放后记账并持久化（lastProactiveAt 必须在默认/反序列化/序列化三处，否则重启即归零 → 一天能触发很多次）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
const LINES = SRC.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
const countLines = (needle) => LINES.filter((l) => l.includes(needle)).length;
const lineWith = (needle) => {
  const hit = LINES.filter((l) => l.includes(needle));
  assert.equal(hit.length, 1, 'src/bridge.js 里应当恰好有一行含「' + needle + '」，实际 ' + hit.length + ' 行');
  return hit[0];
};

test('主动保底存在：默认值、归一化白名单、config.json 都在', () => {
  assert.ok(SRC.includes('ownerProactiveMinIntervalMs: 20 * 60 * 60 * 1000'), '默认保底间隔必须是 20 小时');
  assert.ok(lineWith("for (const k of ['checkIntervalMinMs'").includes('ownerProactiveMinIntervalMs'),
    'POST /api/socialV2/config 的归一化白名单必须含保底间隔，否则控制台改不动它');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(cfg.socialV2.proactive.ownerProactiveMinIntervalMs, 72000000, 'config.json 要显式写上 72000000（20h）');
});

test('保底只对主人私聊生效', () => {
  assert.ok(SRC.includes("const ownerQQ = String(cfg.ownerQQ ?? cfg.socialV2?.ownerQQ ?? '');"), '主人 QQ 取自 cfg.ownerQQ（兼容 cfg.socialV2.ownerQQ）');
  assert.ok(SRC.includes("const ownerKey = ownerQQ ? `private:${ownerQQ}` : '';"), '主人键必须是 private:<ownerQQ>');
  assert.ok(lineWith('if (ownerKey && key === ownerKey && dailyInterval > 0 && !night) {').includes('ownerKey'),
    '保底条件必须锁定在主人私聊那一行');
});

test('深夜不硬叫、忙时不打扰、且没有拆掉原来的概率路径', () => {
  assert.ok(SRC.includes('const night = hour >= 23 || hour < 8;'), '深夜判定要提出来复用');
  assert.ok(SRC.includes('if (night) prob *= 0.3;'), '深夜概率照旧压到 0.3');
  assert.ok(SRC.includes('dailyDue = sinceProactive >= dailyInterval && idle >= idleThreshold && !isConversationBusyV2(key, st);'),
    '保底也要过空闲阈值、且会话不忙');
  assert.ok(SRC.includes('if ((dailyDue || (idle >= idleThreshold && Math.random() < prob)) && !isConversationBusyV2(key, st)) {'),
    '保底与原概率路径是 OR，不能替换掉概率路径');
});

test('保底投放后记账并跨重启保留', () => {
  assert.ok(SRC.includes('st.lastProactiveAt = Date.now(); saveSocialV2State();'), '投放后必须记账并落盘');
  assert.equal(countLines('lastProactiveAt: 0,'), 1, '新会话默认值里要有 lastProactiveAt');
  assert.equal(countLines('lastProactiveAt: Number(val.lastProactiveAt) || 0,'), 1, '反序列化要恢复 lastProactiveAt');
  assert.equal(countLines('lastProactiveAt: Number(st.lastProactiveAt) || 0,'), 1, '序列化要保存 lastProactiveAt');
  assert.ok(SRC.includes('主动保底：距上次主动机会'), '触发时必须留日志，否则以后没法确认它到底跑没跑');
});
