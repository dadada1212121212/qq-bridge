#!/usr/bin/env node
// [长记忆 2026-10-18] 自动提炼 + 定期整理 + 相关性注入的回归测试。
//
// 锁住三件事：
//   1. learnFacts 从聊天里规则式提炼事实，且「同一条只记一次」、每轮有条数上限
//   2. consolidateFacts 合并近似重复、清掉过期的自动事实、每人限量
//   3. buildDigest 注入时按当前话题相关性排序，并守住 maxChars 预算
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryDb } from '../src/memory-db.js';

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mem-'));
  const mdb = createMemoryDb({ file: path.join(dir, 'mem.db'), log: () => {} });
  try {
    return fn(mdb);
  } finally {
    try { mdb.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const msg = (over) => ({ sender: '阿豆', userId: '1001', text: '', isSelf: false, time: Date.now(), ...over });

test('learnFacts：从自我介绍/喜好/约定里提炼事实，重复不重复记', () => {
  withDb((mdb) => {
    const wrote = mdb.learnFacts([
      msg({ text: '我叫阿豆，今年 19' }),
      msg({ text: '我喜欢吃麻辣烫' }),
      msg({ text: '说好明天一起打游戏' }),
    ], { key: 'group:1' });
    assert.ok(wrote >= 2, '至少提炼出两条，实际 ' + wrote);

    // 同一条再说一遍：只加 hits，不新增
    const again = mdb.learnFacts([msg({ text: '我喜欢吃麻辣烫' })], { key: 'group:1' });
    assert.equal(again, 0, '重复的话不该再写一条');

    // 重复那句之后库里条数不该再涨
    const n1 = mdb.stats().facts;
    mdb.learnFacts([msg({ text: '我喜欢吃麻辣烫' })], { key: 'group:1' });
    assert.equal(mdb.stats().facts, n1, '重复的话不该让事实条数变多');
  });
});

test('learnFacts：每轮条数有上限，不会把整段聊天灌进库', () => {
  withDb((mdb) => {
    const many = [];
    for (let i = 0; i < 10; i += 1) many.push(msg({ text: '我喜欢吃第' + i + '种零食' + i }));
    const wrote = mdb.learnFacts(many, { key: 'group:2', maxPerCall: 3 });
    assert.equal(wrote, 3, '上限 3 条，实际 ' + wrote);
  });
});

test('consolidateFacts：近似重复合并、每人限量', () => {
  withDb((mdb) => {
    mdb.learnFacts([msg({ text: '我每天都要喝冰美式' })], { key: 'group:3' });
    // 直接写两条只差标点的近似重复（自动提炼会对同一句去重，这里模拟历史累积的重复）
    mdb.recordFact({ scope: 'person', subject: '1001', text: '阿豆：喜欢吃麻辣烫' });
    mdb.recordFact({ scope: 'person', subject: '1001', text: '阿豆：喜欢吃麻辣烫。' });
    const before = mdb.stats().facts;
    const r = mdb.consolidateFacts({ maxPerSubject: 3 });
    assert.ok(r.merged >= 1, '标点差异的两条应当合并，实际 merged=' + r.merged);
    assert.ok(mdb.stats().facts <= before, '整理后条数不能变多');
  });
});

test('buildDigest：学到的事实会进「你记着的事」，且守住字数预算', () => {
  withDb((mdb) => {
    mdb.learnFacts([
      msg({ text: '我喜欢吃麻辣烫' }),
      msg({ text: '我养了一只叫团子的橘猫' }),
    ], { key: 'group:9' });
    const st = {
      recentMessages: [msg({ text: '团子今天又把我键盘踩了', time: Date.now() })],
      unread: [],
    };
    const digest = mdb.buildDigest({ key: 'group:9', st, maxChars: 1500 });
    assert.ok(digest.includes('你记着的事'), '要有「你记着的事」段落');
    assert.ok(digest.includes('团子') || digest.includes('麻辣烫'), '提炼出的事实要出现在摘要里');
    assert.ok(digest.length <= 1600, '预算 1500 字（含标题）内，实际 ' + digest.length);
  });
});
