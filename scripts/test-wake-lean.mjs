#!/usr/bin/env node
// [省token] 静态段「本会话只发一次」的回归测试。
//
// 背景：唤醒提示是作为新的 user 消息追加到会话尾部的，所以每轮重发的静态段
// （人设速记/会话令牌/查证/省一步…）都是全价未命中（1 元/M）。把它改成
// 「同一 DSH 会话只整条发一次、之后只发动态段」以后，它留在上下文里按
// 缓存命中价（0.02 元/M）读，省 50 倍。
//
// 这里锁住四件事：
//   1. 第一轮整条发（人设/令牌/省一步都在），并且写了标记
//   2. 同一会话第二轮只发动态段（有【老规矩】、没有静态段），且明显更短
//   3. 会话轮换（retireSession）后自动整条重发
//   4. 开关 leanAfterFirst=false 时恢复旧行为；投递被拒时不写标记
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const STATIC = ['【人设速记】', '【会话令牌】', '【省一步】', '【查证与回答】'];

async function withBridge(fn, overrides = null) {
  const h = await bridgeHarness({ config: { socialV2: {
    // 这条测试关心的是提示词形态，不是限流：把闸门开大，好让连续两次唤醒都真的投递。
    wake: { leanAfterFirst: true, preSleepWaitEnabled: false, maxWakePerMinute: 99, maxWakePerHour: 999, ...(overrides?.wake ?? {}) },
    wait: { minMs: 100, maxMs: 2000, minQuietAfterNewMs: 0 },
    proactive: { enabled: false },
    sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

// 第二轮之后直接用 deliverPrompt(wakeReason) 注入：sendWakePromptV2 会先给会话
// 挂 30 分钟 pendingWakeKeys 租约，等 turn/end 才放行，而夹具里没有真的回合
// 结束事件（会一直「繁忙」）。deliverPrompt 走的正是投递前那段真代码
// （deliverPromptNow → buildWakePromptV2 + lean 判定 + 写标记），所以照样锁住行为。
const nextWake = (h, reason = 'question') => h.deliverPrompt(KEY, '', { wakeReason: reason });

function textOf(prompt) {
  return prompt.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

test('第一轮整条发静态段，并写下「本会话已发过」标记', async () => {
  await withBridge(async (h) => {
    await h.sendWakePromptV2(KEY, 'question');
    assert.equal(h.calls.prompts.length, 1);
    const first = textOf(h.calls.prompts[0]);
    for (const seg of STATIC) assert.ok(first.includes(seg), '第一轮缺少静态段：' + seg);
    const st = h.getSocialV2State(KEY);
    assert.ok(st.wakeStaticSent, '没写标记');
    assert.ok(st.wakeStaticSent.sessionId, '标记里没有 sessionId');
    assert.equal(st.wakeStaticSent.sessionId, h.calls.prompts[0].sessionId);
  });
});

test('同一会话第二轮只发动态段，明显更短，且指向【老规矩】', async () => {
  await withBridge(async (h) => {
    await h.sendWakePromptV2(KEY, 'question');
    await nextWake(h);
    // 上面两条都投递成功（deliverPrompt 已经把 calls.prompts 塞满），取最早那条作基线。
    const first = textOf(h.calls.prompts[0]);
    const second = textOf(h.calls.prompts[1]);
    assert.ok(second.includes('【老规矩】'), '精简轮要提醒她照着上一条提示做');
    for (const seg of STATIC) assert.ok(!second.includes(seg), '精简轮不该重发静态段：' + seg);
    // 动态段必须还在：唤醒原因、行动指引
    assert.ok(second.includes('【唤醒】'), '唤醒原因不能丢');
    assert.ok(second.includes('【行动前】'), '行动指引不能丢');
    assert.ok(second.length < first.length * 0.6, '精简轮应明显短于整条：' + second.length + ' vs ' + first.length);
  });
});

test('会话轮换后自动整条重发（令牌也换成新的）', async () => {
  await withBridge(async (h) => {
    await h.sendWakePromptV2(KEY, 'question');
    const oldToken = h.getSocialV2State(KEY).agentToken;
    h.retireSession(KEY);
    await h.sendWakePromptV2(KEY, 'question');
    assert.equal(h.calls.prompts.length, 2);
    const second = textOf(h.calls.prompts[1]);
    for (const seg of STATIC) assert.ok(second.includes(seg), '轮换后缺少静态段：' + seg);
    const newToken = h.getSocialV2State(KEY).agentToken;
    assert.notEqual(newToken, oldToken, '轮换应该换令牌');
    assert.ok(second.includes(newToken), '轮换后要带新令牌');
    assert.equal(h.getSocialV2State(KEY).wakeStaticSent.sessionId, h.calls.prompts[1].sessionId);
  });
});

test('开关 leanAfterFirst=false 时恢复每轮整条发', async () => {
  await withBridge(async (h) => {
    h.cfg.socialV2.wake.leanAfterFirst = false;
    await h.sendWakePromptV2(KEY, 'question');
    await nextWake(h);
    const second = textOf(h.calls.prompts[1]);
    for (const seg of STATIC) assert.ok(second.includes(seg), '关掉开关后应当每轮整条发：' + seg);
    assert.ok(!second.includes('【老规矩】'));
  });
});

test('投递被拒时不写标记（下一轮仍然是整条）', async () => {
  await withBridge(async (h) => {
    h.api.sessions.prompt = async (params) => {
      h.calls.prompts.push(params);
      return { result: { ok: false, error: { code: 'FIXTURE_REJECT', message: 'fixture rejection' } } };
    };
    await nextWake(h);
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.getSocialV2State(KEY).wakeStaticSent, null, '被拒的投递不能记账');
  });
});

test('标记会落盘（重启后不重发）', async () => {
  await withBridge(async (h) => {
    await h.sendWakePromptV2(KEY, 'question');
    const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'));
    const entry = saved.conversations[KEY];
    assert.ok(entry, '会话状态没落盘');
    assert.ok(entry.wakeStaticSent && entry.wakeStaticSent.sessionId, '标记没落盘');
  });
});
test('默认不配置 leanAfterFirst 时每轮整条发（默认值必须是「不省」）', async () => {
  // 血账：2026-10-18 05:13 把精简设成默认开，一个小时里就把人设/查证规则一起省掉，
  // 主人当场测出「降智」。所以默认值反过来：想省必须显式写 true。
  await withBridge(async (h) => {
    delete h.cfg.socialV2.wake.leanAfterFirst;
    await h.deliverPrompt(KEY, '', { wakeReason: 'question' });
    await nextWake(h);
    const second = textOf(h.calls.prompts[1]);
    for (const seg of STATIC) assert.ok(second.includes(seg), '默认配置下第二轮也必须是整条：' + seg);
  });
});
