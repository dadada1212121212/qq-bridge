// [承诺/待办] 单元测试：
//  - appendMemoryV2(category='promise') 的写入/去重/兑现/容量治理
//  - formatMemoryV2 的到期渲染（已到期/今天/明天/还有 N 天）与排序
//  - describeDueV2 / isPromiseDueV2 的边界
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'private:123';

async function withBridge(fn) {
  const h = await bridgeHarness({});
  try { await fn(h); } finally { await h.close(); }
}

const st = (h) => h.getSocialV2State(KEY);
const push = (h, content, extra = {}) => h.appendMemoryV2(st(h), 'promise', content, extra);

test('待办：写入一条基本待办', async () => {
  await withBridge(async (h) => {
    push(h, '周末陪主人打游戏', { target: '主人', dueAt: Date.now() + 3 * 24 * 3600 * 1000 });
    const list = st(h).promises;
    assert.equal(list.length, 1);
    assert.equal(list[0].text, '周末陪主人打游戏');
    assert.equal(list[0].target, '主人');
    assert.ok(list[0].dueAt > Date.now());
    assert.equal(list[0].done, false);
    assert.ok(list[0].createdAt > 0);
  });
});

test('待办：dueAt 接受 ISO 字符串并解析成毫秒', async () => {
  await withBridge(async (h) => {
    push(h, '记得买生日蛋糕', { dueAt: '2027-01-01T09:00:00' });
    const p = st(h).promises[0];
    assert.equal(p.dueAt, Date.parse('2027-01-01T09:00:00'));
  });
});

test('待办：dueAt 传秒级时间戳自动升到毫秒', async () => {
  await withBridge(async (h) => {
    push(h, '秒级时间戳', { dueAt: 1800000000 });
    assert.equal(st(h).promises[0].dueAt, 1800000000 * 1000);
  });
});

test('待办：不传 dueAt 时 dueAt=0（不设到期）', async () => {
  await withBridge(async (h) => {
    push(h, '有空的时候整理一下表情包');
    assert.equal(st(h).promises[0].dueAt, 0);
  });
});

test('待办：同一人同一句话不重复添加，而是更新', async () => {
  await withBridge(async (h) => {
    push(h, '请他吃饭', { target: '小张', dueAt: Date.now() + 86400000 });
    push(h, '请他吃饭', { target: '小张', dueAt: Date.now() + 2 * 86400000 });
    assert.equal(st(h).promises.length, 1);
    assert.ok(st(h).promises[0].updatedAt > 0);
  });
});

test('待办：不同人对同一句话算两条', async () => {
  await withBridge(async (h) => {
    push(h, '帮个忙', { target: '小张' });
    push(h, '帮个忙', { target: '小李' });
    assert.equal(st(h).promises.length, 2);
  });
});

test('待办：done=true 标记兑现且不再出现在提醒里', async () => {
  await withBridge(async (h) => {
    push(h, '答应给他带奶茶', { target: '小张', dueAt: Date.now() + 3600000 });
    push(h, '答应给他带奶茶', { target: '小张', done: true });
    const p = st(h).promises.find((x) => x.text === '答应给他带奶茶');
    assert.equal(p.done, true);
    assert.ok(p.doneAt > 0);
    const text = h.formatMemoryV2(st(h));
    assert.ok(!text.includes('答应给他带奶茶'), '已兑现的待办不该出现在提醒里');
  });
});

test('待办：未完成的超过 40 条会裁掉最旧的', async () => {
  await withBridge(async (h) => {
    for (let i = 0; i < 45; i++) push(h, `待办 ${i}`, { target: `人${i}` });
    const unfinished = st(h).promises.filter((p) => !p.done);
    assert.equal(unfinished.length, 40);
    assert.ok(!unfinished.some((p) => p.text === '待办 0'), '最旧的应被裁掉');
    assert.ok(unfinished.some((p) => p.text === '待办 44'));
  });
});

test('注入：无待办时不出现【答应过的事】', async () => {
  await withBridge(async (h) => {
    const text = h.formatMemoryV2(st(h));
    assert.ok(!text.includes('答应过的事'));
  });
});

test('注入：待办按到期时间升序排列（越急越靠前）', async () => {
  await withBridge(async (h) => {
    const now = Date.now();
    push(h, '远期的事', { dueAt: now + 30 * 86400000 });
    push(h, '近期的事', { dueAt: now + 3600000 });
    push(h, '中期的事', { dueAt: now + 5 * 86400000 });
    const text = h.formatMemoryV2(st(h));
    const iRecent = text.indexOf('近期的事');
    const iMid = text.indexOf('中期的事');
    const iFar = text.indexOf('远期的事');
    assert.ok(iRecent < iMid && iMid < iFar, '应按到期时间升序');
  });
});

test('注入：到期当天/逾期时标题带「该主动提了」', async () => {
  await withBridge(async (h) => {
    push(h, '今天要还的书', { dueAt: Date.now() + 60000 });
    const text = h.formatMemoryV2(st(h));
    assert.ok(text.includes('该主动提了'), '到期的待办应提示主动提');
    assert.ok(text.includes('今天'));
  });
});

test('注入：远期待办标题不带「该主动提了」', async () => {
  await withBridge(async (h) => {
    push(h, '下个月的事', { dueAt: Date.now() + 20 * 86400000 });
    const text = h.formatMemoryV2(st(h));
    assert.ok(text.includes('答应过的事'));
    assert.ok(!text.includes('该主动提了'));
    assert.ok(text.includes('还有 20 天'));
  });
});

test('注入：无到期时间的待办也显示，且排在最后', async () => {
  await withBridge(async (h) => {
    push(h, '没设时间的事');
    push(h, '有时间的', { dueAt: Date.now() + 86400000 });
    const text = h.formatMemoryV2(st(h));
    assert.ok(text.includes('没设时间的事'));
    assert.ok(text.indexOf('有时间的') < text.indexOf('没设时间的事'), '无 dueAt 的排最后');
  });
});

test('注入：逾期标「已到期」', async () => {
  await withBridge(async (h) => {
    push(h, '早该做的事', { dueAt: Date.now() - 3 * 86400000 });
    const text = h.formatMemoryV2(st(h));
    assert.ok(text.includes('已到期'));
  });
});

test('注入：带 target 的待办渲染出「谁：」前缀', async () => {
  await withBridge(async (h) => {
    push(h, '答应帮他翻译', { target: '小张' });
    const text = h.formatMemoryV2(st(h));
    assert.ok(/小张：答应帮他翻译/.test(text));
  });
});

test('安全：待办里的会话令牌被脱敏', async () => {
  await withBridge(async (h) => {
    const token = st(h).agentToken;
    assert.ok(token && token.length >= 16);
    push(h, `他给过我 ${token}`, { target: '小张' });
    const formatted = h.formatMemoryV2(st(h));
    // 【答应过的事】段落里不该出现明文令牌（提示词别处的【会话令牌】行不受影响）
    const block = formatted.split('【答应过的事')[1] || '';
    assert.ok(!block.includes(token), '令牌漏进待办提醒了');
  });
});

// ── 生日提醒（复用印象档案的 birthday 字段） ────────────────────────────────
const imp = (h, target, extra = {}) => h.appendMemoryV2(st(h), 'memberImpression', 'x', { target, ...extra });

function mmdd(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('生日：今天生日会在印象里标出', async () => {
  await withBridge(async (h) => {
    imp(h, '小张', { birthday: mmdd(0) });
    const text = h.formatMemoryV2(st(h));
    assert.ok(text.includes('今天'), '应标出今天生日');
    assert.ok(text.includes('生日快乐'), '应提示说生日快乐');
  });
});

test('生日：明天生日标「明天」', async () => {
  await withBridge(async (h) => {
    imp(h, '小李', { birthday: mmdd(1) });
    const text = h.formatMemoryV2(st(h));
    assert.ok(text.includes('明天'));
  });
});

test('生日：一周内标「还有 N 天」', async () => {
  await withBridge(async (h) => {
    imp(h, '小王', { birthday: mmdd(5) });
    const text = h.formatMemoryV2(st(h));
    assert.ok(text.includes('还有 5 天'), '实际输出：' + text);
  });
});

test('生日：超过一周不特别标注，只显示原值', async () => {
  await withBridge(async (h) => {
    imp(h, '小赵', { birthday: mmdd(20) });
    const text = h.formatMemoryV2(st(h));
    assert.ok(text.includes(`生日 ${mmdd(20)}`));
    assert.ok(!text.includes('还有'));
  });
});

test('生日：支持「7月26日」这种写法', async () => {
  await withBridge(async (h) => {
    const d = new Date(Date.now() + 2 * 86400000);
    const cn = `${d.getMonth() + 1}月${d.getDate()}日`;
    imp(h, '小孙', { birthday: cn });
    const text = h.formatMemoryV2(st(h));
    assert.ok(text.includes('还有 2 天'), '中文写法应能解析，实际：' + text);
  });
});

// ── 在场成员优先的印象注入 ──────────────────────────────────────────────────
test('在场优先：最近说过话的人排在印象列表前面', async () => {
  await withBridge(async (h) => {
    // 先让 A 印象深刻（更早），B 印象较旧，但 B 是"在场"的人
    imp(h, '阿明', { birthday: '' });
    imp(h, '小美', { birthday: '' });
    // 让阿明的 lastSeenAt 更早、小美更早 —— 手工压一下时间
    const s = st(h);
    s.memberImpressions['阿明'].lastSeenAt = Date.now() - 100000;
    s.memberImpressions['小美'].lastSeenAt = Date.now() - 200000;
    // 小美刚发言 → 应该排到前面
    h.appendSocialV2Message(KEY, '小美', '我回来了', '我回来了', false, false, 1);
    const text = h.formatMemoryV2(s);
    const iXiao = text.indexOf('小美');
    const iA = text.indexOf('阿明');
    assert.ok(iXiao >= 0 && iA >= 0, '两个人都该出现');
    assert.ok(iXiao < iA, '在场的小美应排在阿明前面');
  });
});

test('在场优先：都不在场时退回按 lastSeenAt 倒序', async () => {
  await withBridge(async (h) => {
    imp(h, '甲', { birthday: '' });
    imp(h, '乙', { birthday: '' });
    const s = st(h);
    s.memberImpressions['甲'].lastSeenAt = Date.now() - 300000;
    s.memberImpressions['乙'].lastSeenAt = Date.now() - 100000;
    const text = h.formatMemoryV2(s);
    assert.ok(text.indexOf('乙') < text.indexOf('甲'), '最近互动的乙应靠前');
  });
});
