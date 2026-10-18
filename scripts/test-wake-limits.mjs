// 「被点名必达」的注册期回归网（纯源码断言，不起桥接、不碰 QQ）。
//
// 为什么需要它：唤醒频率闸门（默认每分钟 1 次、群聊每小时 30 次）一旦撞上，旧行为是
// **静默丢弃**那次唤醒——日志里坐实过
// 「唤醒频率超限，最早可用时段在 6 分钟后（超过延后上限 5 分钟），放弃本次唤醒（atMention）」，
// 也就是「群里有人 @ 她，她根本不知道」。这条网盯三件事：
//   1) 豁免名单里有 atMention（2026-10-11 扩到 private/poke/nameMention/keyword/admin/question），
//      且分钟/小时两个闸门都真的让开了（少一个就等于没修）；
//   2) 豁免仍有绝对天花板 maxWakePerHourAtMention —— 不能变成被人拿 @ 刷屏烧钱的通道；
//   3) 「限流不再静默丢唤醒」的延后机制（deferWakeV2）还在，没有退回裸 return。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8')
  + '\n' + fs.readFileSync(path.join(root, 'src', 'console-server.js'), 'utf8');
const LINES = SRC.split(/\r?\n/);
const lineWith = (needle) => {
  const hit = LINES.filter((l) => l.includes(needle));
  assert.equal(hit.length, 1, `src/bridge.js 里应当恰好有一行含「${needle}」，实际 ${hit.length} 行`);
  return hit[0];
};

test('被 @ 点名的唤醒不吃分钟/小时成本闸门', () => {
  const exempt = /const WAKE_CAP_EXEMPT_REASONS = new Set\(\[([^\]]*)\]\)/.exec(SRC);
  assert.ok(exempt, '豁免名单那一行必须存在（否则被叫了会被成本闸门静默丢掉）');
  const exemptReasons = [...exempt[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(exemptReasons.includes('atMention'), '豁免名单里必须有 atMention');
  // 2026-10-11 扩表（用户二次报「有时候她不会回信息」）：主人私聊、被拍、叫名字、命中关键词、
  // 我的控制台唤醒、被提问也算「有人在跟她说话」，一律不许被成本闸门饿死。名单钉在测试里，
  // 防止有人顺手删掉 private —— 那会让主人私聊重新被每分钟 1 次的闸门静默延后。
  for (const reason of ['atMention', 'private', 'poke', 'nameMention', 'keyword', 'admin', 'question']) {
    assert.ok(exemptReasons.includes(reason), `豁免名单里必须有 ${reason}`);
  }
  assert.match(SRC, /const AT_MENTION_MIN_GAP_MS = 3000;/, '豁免通道需要最小间隔（一条消息带多个 @ 时别连打）');
  // 两道闸门都必须让开：任何一道漏加 !capExempt，被 @ 就还是会被静默丢掉。
  assert.match(lineWith('const minuteFull = maxPerMinute'), /!capExempt/, '每分钟闸门必须让开 capExempt');
  assert.match(lineWith('const hourFull = maxPerHour'), /!capExempt/, '每小时闸门必须让开 capExempt');
  // capExempt 是三行连写：名单 → 天花板 → 最小间隔，缺一不可。
  assert.match(SRC,
    /const capExempt = WAKE_CAP_EXEMPT_REASONS\.has\(reasonBase\)\r?\n\s*&& recentHour < maxPerHourAtMention\r?\n\s*&& now - lastWakeAtAny >= AT_MENTION_MIN_GAP_MS/,
    'capExempt 必须同时满足名单/天花板/最小间隔');
  // 绕闸门必须留痕，否则以后再出「被 @ 不回」没法从日志定位。
  assert.match(SRC, /被点名必达：绕过唤醒频率闸门/);
});

test('@ 豁免有绝对天花板，不是无限刷屏通道', () => {
  assert.match(SRC, /recentHour < maxPerHourAtMention/, '豁免必须被 maxPerHourAtMention 兜住');
  assert.match(SRC, /Number\(cfg\.socialV2\?\.wake\?\.maxWakePerHourAtMention\) \|\| Math\.max\(60, maxPerHour\)/,
    '天花板默认 max(60, maxWakePerHour)，且可由配置覆盖');
  // config API 写回来的值要过同一套归一化，否则控制台改的上限不生效。
  assert.match(lineWith("'maxWakePerHourAtMention'"), /for \(const k of \[/, 'maxWakePerHourAtMention 要在 wake 数值归一化白名单里');
});

test('限流仍然是延后，不是静默丢弃（呆住修复不许回退）', () => {
  assert.match(SRC, /function deferWakeV2\(key, reason, st, opts\)/, '延后唤醒的实现还在');
  assert.match(SRC, /deferWakeV2\(key, reason, st, \{ now, maxPerMinute, maxPerHour/, '限流分支必须仍然走 deferWakeV2');
  assert.doesNotMatch(SRC, /if \(minuteFull \|\| hourFull\) \{\s*\r?\n\s*return;/, '限流分支不许退回裸 return');
});

test('优先级表里 @ 高于提问与概率唤醒（合并窗口内不被降级）', () => {
  const at = Number(/atMention: (\d+)/.exec(SRC)?.[1]);
  const q = Number(/question: (\d+)/.exec(SRC)?.[1]);
  const prob = Number(/probability: (\d+)/.exec(SRC)?.[1]);
  assert.ok(at > q && at > prob && at > 0, `atMention(${at}) 应高于 question(${q}) 与 probability(${prob})`);
});
