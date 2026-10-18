#!/usr/bin/env node
// [省token 每轮新会话] 主人 m12006：每一次「发言的回复」都重开会话，不带上一轮的历史。
//
// 背景：旧会话会把全部历史一直挂在上下文里。冷群隔几个小时（DeepSeek 前缀缓存早过期）
// 再开口时，那段历史要按「未命中价」（1 元/M）重读一遍，聊得越久越贵 —— 就是
// 「缓存时间一过，成本马上指数爆炸」。改成每轮新会话后，成本固定为「一条提示词 + 回复」。
//
// 这里锁住五件事：
//   1. 不配 freshSessionPerTurn（默认）时完全不动会话 —— 老行为可回退
//   2. 开启后：第二次唤醒投递到**新会话**，旧会话被归档，turnCount 归零，令牌换新
//   3. 回合真在跑（v2TurnStartAt 里有值）时绝不轮换，避免把一轮上下文劈两半
//   4. 与 lean（静态段只发一次）互斥：每轮都要带完整静态段，不能发【老规矩】
//   5. 每轮提示词都带未读快照【本次消息快照】，未读消息随提示词一起进新会话
import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const STATIC = ['【人设速记】', '【会话令牌】', '【省一步】', '【查证与回答】'];

async function withBridge(fn, { fresh = true, lean = false, context = {} } = {}) {
  const h = await bridgeHarness({ config: { socialV2: {
    // 这条测试关心的是「哪一轮落到哪个会话」，不是限流：把闸门开大。
    wake: { leanAfterFirst: lean, preSleepWaitEnabled: false, maxWakePerMinute: 99, maxWakePerHour: 999 },
    wait: { minMs: 100, maxMs: 2000, minQuietAfterNewMs: 0 },
    proactive: { enabled: false },
    sticker: { enabled: false },
    // sessionReuseWarmMs = 0 ⇒ 永远重开（老语义）；不传则用默认 5 分钟窗口。
    context: fresh ? { freshSessionPerTurn: true, sessionReuseWarmMs: 0, ...context } : {},
  } } });
  h.setMode('reserved2');
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

// sendWakePromptV2 投递后会挂 pendingWakeKeys 租约等 turn/end；夹具里没有真回合结束，
// 所以这里手动「模拟回合结束」，才能连续发第二次唤醒。
function endTurn(h) {
  h.pendingWakeKeys.delete(KEY);
  h.disarmPendingWakeLease(KEY);
}

function textOf(prompt) {
  return prompt.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

test('默认不配 freshSessionPerTurn：连续两轮落在同一个会话（老行为）', async () => {
  await withBridge(async (h) => {
    await h.sendWakePromptV2(KEY, 'question');
    const sid1 = h.state.sessions[KEY];
    assert.ok(sid1, '第一轮应当建会话');
    endTurn(h);
    await h.sendWakePromptV2(KEY, 'question');
    assert.equal(h.state.sessions[KEY], sid1, '默认不该换会话');
    assert.equal(h.calls.prompts[1].sessionId, sid1);
    assert.equal(h.calls.created.length, 1, '默认不该多建会话');
  }, { fresh: false });
});

test('开启后：第二轮是新会话，旧会话归档、turnCount 归零、令牌换新', async () => {
  await withBridge(async (h) => {
    await h.sendWakePromptV2(KEY, 'question');
    const sid1 = h.state.sessions[KEY];
    const tok1 = h.getSocialV2State(KEY).agentToken;
    h.getSocialV2State(KEY).turnCount = 3;
    endTurn(h);
    await h.sendWakePromptV2(KEY, 'question');
    const sid2 = h.state.sessions[KEY];
    assert.notEqual(sid2, sid1, '第二轮必须是新会话');
    assert.equal(h.calls.prompts[1].sessionId, sid2, '提示词要投到新会话');
    assert.ok(h.calls.archived.includes(sid1), '旧会话要被归档');
    assert.equal(h.calls.created.length, 2, '两轮应该各建一个会话');
    assert.equal(h.getSocialV2State(KEY).turnCount, 0, '轮换后回合计数归零');
    assert.notEqual(h.getSocialV2State(KEY).agentToken, tok1, '轮换应该换会话令牌');
  }, { context: { sessionReuseWarmMs: 0 } });
});

test('回合还在跑（v2TurnStartAt 有值）时不轮换', async () => {
  await withBridge(async (h) => {
    await h.sendWakePromptV2(KEY, 'question');
    const sid = h.state.sessions[KEY];
    h.v2TurnStartAt.set(sid, Date.now());
    const rotated = h.freshSessionBeforeWakeV2(KEY, 'question');
    assert.equal(rotated, false, '回合在跑时不能轮换');
    assert.equal(h.state.sessions[KEY], sid, '会话映射不能丢');
    assert.deepEqual(h.calls.archived, [], '不能归档正在跑的会话');
  });
});

test('与 lean 互斥：每轮都带完整静态段，不发【老规矩】', async () => {
  await withBridge(async (h) => {
    await h.sendWakePromptV2(KEY, 'question');
    endTurn(h);
    await h.sendWakePromptV2(KEY, 'question');
    const second = textOf(h.calls.prompts[1]);
    for (const seg of STATIC) assert.ok(second.includes(seg), '新会话里必须重新带上静态段：' + seg);
    assert.ok(!second.includes('【老规矩】'), '新会话没有「上一条提示」可参照，不能发精简版');
  }, { lean: true });
});

test('未读消息随提示词进入新会话（已读/未读标记替代上下文）', async () => {
  await withBridge(async (h) => {
    await h.sendWakePromptV2(KEY, 'question');
    endTurn(h);
    const st = h.getSocialV2State(KEY);
    const seq = (Number(st.lastUnreadSeq) || 0) + 1;
    h.appendSocialV2Message(KEY, '阿豆', '刚才说到哪了', '刚才说到哪了', false, false, seq);
    await h.sendWakePromptV2(KEY, 'question');
    const second = textOf(h.calls.prompts[1]);
    assert.ok(second.includes('【本次消息快照】'), '每轮都要带未读快照');
    assert.ok(second.includes('刚才说到哪了'), '未读内容要在新会话里出现（不靠上一轮的历史）');
    assert.ok(/readThroughSeq/.test(second), '要给出已读水位，收尾靠它确认读过');
  });
});
test('与瘦提示词互斥：asks 回合也发完整版（带「上次聊到哪」回顾）', async () => {
  await withBridge(async (h) => {
    const st0 = h.getSocialV2State(KEY);
    for (let i = 0; i < 3; i++) {
      const seq = (Number(st0.lastUnreadSeq) || 0) + 1;
      h.appendSocialV2Message(KEY, '阿豆', 'fixture-' + i, 'fixture-' + i, false, false, seq);
    }
    // 'asks' 在旧逻辑里一律走瘦提示词（砍掉回顾/关系/参与感）；新会话里砍掉这些等于失忆。
    await h.sendWakePromptV2(KEY, 'asks');
    const text = textOf(h.calls.prompts[0]);
    assert.ok(text.includes('【上次聊到哪'), '新会话必须带上跨会话回顾（瘦身版会砍掉它）');
    assert.ok(text.includes('【人设速记】'), '完整版要带人设速记');
  });
});

test('[延迟] 连续对话（间隔小于复用窗口）沿用同一会话，不重开也不新建', async () => {
  await withBridge(async (h) => {
    await h.sendWakePromptV2(KEY, 'question');
    const sid1 = h.state.sessions[KEY];
    endTurn(h);
    await h.sendWakePromptV2(KEY, 'private');
    assert.equal(h.state.sessions[KEY], sid1, '同一窗口内不该换会话');
    assert.equal(h.calls.prompts[1].sessionId, sid1, '第二条也投到同一会话');
    assert.equal(h.calls.created.length, 1, '不该为第二条消息再建会话');
    assert.deepEqual(h.calls.archived, [], '不该归档还在用的会话');
  }, { context: { sessionReuseWarmMs: 10 * 60 * 1000 } });
});

test('[延迟] 隔了超过复用窗口才重开会话（省 token 的本意：久未说话别重读老历史）', async () => {
  await withBridge(async (h) => {
    await h.sendWakePromptV2(KEY, 'question');
    const sid1 = h.state.sessions[KEY];
    endTurn(h);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await h.sendWakePromptV2(KEY, 'private');
    assert.notEqual(h.state.sessions[KEY], sid1, '超过窗口应当重开');
    assert.equal(h.calls.created.length, 2, '重开要新建会话');
    assert.ok(h.calls.archived.includes(sid1), '旧的要归档');
  }, { context: { sessionReuseWarmMs: 5 } });
});

test('[省token] 复用窗口内但上下文超上限 → 重开（避免 10 万 token 全价重读）', async () => {
  await withBridge(async (h) => {
    await h.sendWakePromptV2(KEY, 'question');
    const sid1 = h.state.sessions[KEY];
    endTurn(h);
    h.lastContextTokensV2.set(KEY, 90000);
    await h.sendWakePromptV2(KEY, 'private');
    assert.notEqual(h.state.sessions[KEY], sid1, '超过上限应当重开新会话');
    assert.ok(h.calls.archived.includes(sid1), '旧会话要被归档');
  }, { context: { sessionReuseWarmMs: 30 * 60 * 1000, sessionReuseMaxContextTokens: 60000 } });
});
