#!/usr/bin/env node
// [印象档案] 结构化群友档案的单元测试。
//
// 背景：原先 memberImpressions 只能存一串自由文本 traits，生日/称呼偏好/雷点
// 这些「记一次就长期有效」的硬信息无处安放，而且注入时按插入序 slice(-10)，
// 会让很久没提的人卡在前面、把最近聊的人挤出提示词。
//
// 这里覆盖三件事：
//   1. 结构化字段能写、能持久化、不传时不被清空、传「无」才清空
//   2. 注入时按 lastSeenAt 倒序（最近互动的人优先），且结构化字段渲染出来
//   3. 字段长度有上限、令牌会被脱敏
import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'private:123';

async function withBridge(fn) {
  const h = await bridgeHarness({});
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

test('结构化印象：写入后能在 state 里读到', async () => {
  await withBridge(async (h) => {
    h.appendMemoryV2(h.getSocialV2State(KEY), 'memberImpression', '爱发自拍', {
      target: '小张', birthday: '07-26', preferName: '张张', avoid: '别提前任'
    });
    const st = h.getSocialV2State(KEY);
    const im = st.memberImpressions['小张'];
    assert.ok(im, '印象没写进去');
    assert.equal(im.birthday, '07-26');
    assert.equal(im.preferName, '张张');
    assert.equal(im.avoid, '别提前任');
    assert.equal(im.traits.length, 1);
    assert.equal(im.traits[0], '爱发自拍');
    assert.equal(im.interactionCount, 1);
  });
});

test('结构化印象：再记一次不传硬信息时保留原值', async () => {
  await withBridge(async (h) => {
    h.appendMemoryV2(h.getSocialV2State(KEY), 'memberImpression', '爱发自拍', {
      target: '小张', birthday: '07-26', preferName: '张张'
    });
    // 第二次只补一条印象标签，不带 birthday/preferName
    h.appendMemoryV2(h.getSocialV2State(KEY), 'memberImpression', '打游戏很菜', { target: '小张' });
    const im = h.getSocialV2State(KEY).memberImpressions['小张'];
    assert.equal(im.birthday, '07-26', '没传生日却被清空了 —— 会丢信息');
    assert.equal(im.preferName, '张张');
    assert.equal(im.traits.length, 2);
    assert.equal(im.traits[0], '爱发自拍');
    assert.equal(im.traits[1], '打游戏很菜');
    assert.equal(im.interactionCount, 2);
  });
});

test('结构化印象：传「无」才真的清空', async () => {
  await withBridge(async (h) => {
    h.appendMemoryV2(h.getSocialV2State(KEY), 'memberImpression', 'x', { target: '小张', avoid: '别提前任' });
    assert.equal(h.getSocialV2State(KEY).memberImpressions['小张'].avoid, '别提前任');
    h.appendMemoryV2(h.getSocialV2State(KEY), 'memberImpression', 'x2', { target: '小张', avoid: '无' });
    assert.equal(h.getSocialV2State(KEY).memberImpressions['小张'].avoid, '', '传「无」应该清空');
  });
});

test('结构化印象：空串当作没传，不清空已有值', async () => {
  await withBridge(async (h) => {
    h.appendMemoryV2(h.getSocialV2State(KEY), 'memberImpression', 'x', { target: '小张', birthday: '07-26' });
    h.appendMemoryV2(h.getSocialV2State(KEY), 'memberImpression', 'y', { target: '小张', birthday: '   ' });
    assert.equal(h.getSocialV2State(KEY).memberImpressions['小张'].birthday, '07-26',
      '传空白字符串把已有生日报销了');
  });
});

test('结构化印象：字段超长会被截断', async () => {
  await withBridge(async (h) => {
    h.appendMemoryV2(h.getSocialV2State(KEY), 'memberImpression', 'x', {
      target: '小张',
      birthday: 'A'.repeat(50),
      preferName: 'B'.repeat(50),
      avoid: 'C'.repeat(100)
    });
    const im = h.getSocialV2State(KEY).memberImpressions['小张'];
    assert.equal(im.birthday.length, 10);
    assert.equal(im.preferName.length, 20);
    assert.equal(im.avoid.length, 40);
  });
});

test('注入：结构化字段渲染进【对群友的印象】', async () => {
  await withBridge(async (h) => {
    h.appendMemoryV2(h.getSocialV2State(KEY), 'memberImpression', '嘴很甜', {
      target: '小张', birthday: '07-26', preferName: '张张', avoid: '别提前任'
    });
    const prompt = h.buildWakePromptV2(KEY, 'test');
    assert.match(prompt, /对群友的印象/);
    assert.match(prompt, /生日 07-26/);
    assert.match(prompt, /喜欢被叫「张张」/);
    assert.match(prompt, /别碰：别提前任/);
    assert.match(prompt, /嘴很甜/);
  });
});

test('注入：按 lastSeenAt 倒序，最近互动的人优先', async () => {
  await withBridge(async (h) => {
    // 先记一个「老张」，再记「小李」，最后回过来补老张一条 —— 老张是最新的
    h.appendMemoryV2(h.getSocialV2State(KEY), 'memberImpression', '老印象', { target: '老张' });
    h.appendMemoryV2(h.getSocialV2State(KEY), 'memberImpression', '新面孔', { target: '小李' });
    h.appendMemoryV2(h.getSocialV2State(KEY), 'memberImpression', '刚聊过', { target: '老张' });
    const prompt = h.buildWakePromptV2(KEY, 'test');
    const iOld = prompt.indexOf('老张');
    const iNew = prompt.indexOf('小李');
    assert.ok(iOld > 0 && iNew > 0, '两个人都没渲染出来');
    assert.ok(iOld < iNew, '最近互动过的老张应该排在前面（按 lastSeenAt 倒序）');
  });
});

test('注入：只保留最近 10 个人', async () => {
  await withBridge(async (h) => {
    for (let i = 0; i < 15; i++) {
      h.appendMemoryV2(h.getSocialV2State(KEY), 'memberImpression', `印象${i}`, { target: `人${String(i).padStart(2, '0')}` });
    }
    const prompt = h.buildWakePromptV2(KEY, 'test');
    assert.ok(prompt.includes('人14'), '最新的那个人不见了');
    assert.ok(!prompt.includes('人00'), '最老的那个人应该被挤出前 10');
  });
});

test('结构化印象：已知会话令牌会被脱敏', async () => {
  await withBridge(async (h) => {
    // redactKnownTokensOnly 只脱敏「已注册过」的令牌（KNOWN_AGENT_TOKENS）——
    // 也就是会话自己的 agentToken。用真实令牌才能验证这条链路。
    // 注意：提示词里本来就有【会话令牌】那一行（那是正常且必需的），
    // 所以只能断言「印象那一段」被脱敏，不能断言整篇不含令牌。
    const st = h.getSocialV2State(KEY);
    const token = st.agentToken;
    assert.ok(token && token.length >= 16, '会话令牌没生成');
    h.appendMemoryV2(st, 'memberImpression', 'x', { target: '小张', avoid: `他给过我 ${token}` });
    const im = h.getSocialV2State(KEY).memberImpressions['小张'];
    assert.ok(!String(im.avoid).includes(token), `印象里存的还是明文令牌：${im.avoid}`);
    assert.ok(String(im.avoid).includes('***'), '应该是被换成 *** 而不是整段丢掉');
  });
});
