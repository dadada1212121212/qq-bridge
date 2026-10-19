// [拟人四件套] 纯规则单测：事件跟进 / 敌意和解词 / 纪念日里程碑 / 情景抽样。
// 只测 src/social-mechanisms.js 与 src/long-memory.js 的纯逻辑，不碰网络与桥接。
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectEventFollowUp, HOSTILE_RE, PEACE_RE, milestoneDays, diffBiliFollowsV2 } from '../src/social-mechanisms.js';
import { createLongMemory } from '../src/long-memory.js';

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error(`✗ ${name}: ${e?.message || e}`); process.exitCode = 1; }
}

const NOW = new Date('2026-10-19T12:00:00+08:00').getTime();
const H = 3600000;

// ── ①事件跟进：detectEventFollowUp ─────────────────────────────
ok('明天+考试 → 24h 后到点、再过一天跟进', () => {
  const hit = detectEventFollowUp('我明天要考试，紧张死了', NOW);
  assert.ok(hit, '应当命中');
  assert.equal(hit.event, '考试');
  assert.equal(hit.dueAt - NOW, 24 * H);
  assert.equal(hit.followUpAt - hit.dueAt, 24 * H);
});
ok('后天 → 48h；大后天 → 72h', () => {
  assert.equal(detectEventFollowUp('后天出成绩', NOW).dueAt - NOW, 48 * H);
  assert.equal(detectEventFollowUp('大后天面试', NOW).dueAt - NOW, 72 * H);
});
ok('下周/下个月 → 7 天', () => {
  assert.equal(detectEventFollowUp('下周有一场比赛', NOW).dueAt - NOW, 168 * H);
  assert.equal(detectEventFollowUp('下个月体检', NOW).dueAt - NOW, 168 * H);
});
ok('说了日期没说清具体时间 → 默认 48h', () => {
  assert.equal(detectEventFollowUp('我的面试定在 18 号', NOW).dueAt - NOW, 48 * H);
});
ok('聊过去的事不记（缺未来时间词）', () => {
  assert.equal(detectEventFollowUp('昨天的考试挂了', NOW), null);
});
ok('普通闲聊不记（缺事件词）', () => {
  assert.equal(detectEventFollowUp('明天一起打游戏呀', NOW), null);
});
ok('超长句截断到 120 字内也要能命中', () => {
  const s = '废话'.repeat(55) + '明天答辩';
  assert.equal(detectEventFollowUp(s, NOW).event, '答辩');
});

// ── ④敌意 / 和解词 ────────────────────────────────────────────
ok('敌意词命中', () => {
  for (const t of ['闭嘴吧', '你就是个废物', '懒得理你了', '你烦不烦啊']) assert.ok(HOSTILE_RE.test(t), t);
});
ok('玩梗不算敌意（「滚呐」式玩笑不命中）', () => {
  assert.ok(!HOSTILE_RE.test('哈哈哈滚呐'), '玩笑话不应命中');
  assert.ok(!HOSTILE_RE.test('今天真开心'), '闲聊不应命中');
});
ok('和解词命中', () => {
  for (const t of ['对不起嘛', '是我的错', '别生气了', '刚才是我不对']) assert.ok(PEACE_RE.test(t), t);
});

// ── ②纪念日里程碑 ─────────────────────────────────────────────
ok('里程碑命中：7/30/100/365/1000', () => {
  for (const d of [7, 30, 100, 365, 1000]) assert.equal(milestoneDays(d), d);
});
ok('非里程碑返回 0：6/31/364/999', () => {
  for (const d of [6, 31, 364, 999]) assert.equal(milestoneDays(d), 0);
});

// ── ③记忆自检素材：sampleEpisode ─────────────────────────────
const tmpDb = fileURLToPath(new URL('./tmp-test-long-memory.db', import.meta.url));
const lm = createLongMemory({ file: tmpDb, log: () => {} });
ok('sampleEpisode：空库返回 null', () => {
  assert.equal(lm.sampleEpisode('group:1'), null);
});
ok('sampleEpisode：能从最近 10 条里抽出带摘要的旧情景', () => {
  for (let i = 1; i <= 12; i++) {
    lm.consolidateDay('group:1', `2026-09-${String(i).padStart(2, '0')}`, {
      // consolidateDay 只固化「聊了 ≥3 条」的天
      messages: [
        { sender: '小明', is_self: 0, text: `第${i}天聊了比赛` },
        { sender: '小明', is_self: 0, text: '他问我昨天看没看' },
        { sender: '我', is_self: 1, text: '看了看了，太精彩了' }
      ],
      facts: [], events: [], mood: '平静'
    });
  }
  const ep = lm.sampleEpisode('group:1');
  assert.ok(ep && ep.summary, '应抽出一条带 summary 的情景');
  assert.equal(ep.key, 'group:1');
});
ok('sampleEpisode：会话隔离（别的 key 抽不到）', () => {
  assert.equal(lm.sampleEpisode('group:2'), null);
});

try { lm.close(); } catch { /* */ }
try { unlinkSync(tmpDb); } catch { /* */ }

// ── [养鱼·追更] diffBiliFollowsV2 判新规则 ────────────────────────────────────
const VIDEO_A = { bvid: 'BV1AbCdEfGh1', title: '旧稿', pubdate: 1760000000, url: 'u1' };
const VIDEO_B = { bvid: 'BV1XyZwVuTs2', title: '新稿', pubdate: 1760800000, url: 'u2' };
const FOLLOWS = [{ mid: '12345', name: '老番茄' }, { mid: '67890', name: '影视飓风' }, { name: '没给mid的忽略' }];
ok('diffBiliFollows：首次建档只记水位不报更新（避免把旧稿全安利一遍）', () => {
  const r = diffBiliFollowsV2(FOLLOWS, {}, new Map([['12345', { mid: '12345', name: '老番茄', count: [VIDEO_A] }]]));
  assert.equal(r.updates.length, 0);
  assert.equal(r.seeded, 1);
  assert.equal(r.state['12345'].lastBvid, VIDEO_A.bvid);
  assert.equal(r.state['12345'].seeded, true);
});
ok('diffBiliFollows：换了新 bvid 才报更新，水位跟着走', () => {
  const prev = { '12345': { name: '老番茄', lastBvid: VIDEO_A.bvid, lastTitle: '旧稿', seeded: true } };
  const r1 = diffBiliFollowsV2(FOLLOWS, prev, new Map([['12345', { count: [VIDEO_A] }]]));
  assert.equal(r1.updates.length, 0, '同一投稿不算新');
  const r2 = diffBiliFollowsV2(FOLLOWS, prev, new Map([['12345', { count: [VIDEO_B] }]]));
  assert.equal(r2.updates.length, 1);
  assert.equal(r2.updates[0].name, '老番茄');
  assert.equal(r2.updates[0].video.bvid, VIDEO_B.bvid);
  assert.equal(r2.state['12345'].lastBvid, VIDEO_B.bvid);
});
ok('diffBiliFollows：抓失败的 UP 水位不动、不影响别人', () => {
  const prev = { '12345': { name: '老番茄', lastBvid: VIDEO_A.bvid, seeded: true } };
  const results = new Map([['12345', null], ['67890', { count: [VIDEO_A] }]]);
  const r = diffBiliFollowsV2(FOLLOWS, prev, results);
  assert.equal(r.updates.length, 0, '67890 首次见是建档不算更新');
  assert.equal(r.state['12345'].lastBvid, VIDEO_A.bvid, '抓失败的水位原样');
  assert.equal(r.state['67890'].seeded, true);
});
ok('diffBiliFollows：名单里的脏条目（没 mid）被跳过', () => {
  const r = diffBiliFollowsV2(FOLLOWS, {}, new Map());
  assert.equal(Object.keys(r.state).length, 0);
});
ok('diffBiliFollows：results 传普通对象也行', () => {
  const r = diffBiliFollowsV2([{ mid: '12345', name: 'x' }], {}, { 12345: { count: [VIDEO_A] } });
  assert.equal(r.seeded, 1);
});

console.log(`test-social-mechanisms: ${passed} 断言通过${process.exitCode ? '（存在失败）' : ''}`);
