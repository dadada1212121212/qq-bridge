#!/usr/bin/env node
// [省 token 2026-10-18] 白名单遮罩单测：把「不在白名单里的继承层工具」从 schema 藏掉。
//
// 背景：53k 的共享前缀 = 系统提示 + 工具说明书。同一个 DSH 里注册着两套 QQ MCP
// （老号 mcp__snowluma__ / 鱼号 mcp__snowluma2__），还有 free-search、im、modsearch
// 这些全局工具；QQ 会话一个都用不上（执行期本来就被 guard 拒），但每轮都在读它们的说明。
// 这里锁住三件事：
//   1. 只留白名单（前缀 + 两个精确名），其余继承层工具全部进 deny
//   2. restrict 对 unknown 名字整批拒绝时，剥掉它们在报错里列出的名字后重试成功
//   3. 拿不到工具清单时 fail-open（返回 0、不打网络、不抛）
import test from 'node:test';
import assert from 'node:assert/strict';
import { maskToAllowlist } from '../plugins/qq-agent-presets/qq-tool-restrict.mjs';

function fakeCtx(names, { failFirstWith = [], viewThrows = false } = {}) {
  const calls = [];
  let first = true;
  return {
    calls,
    tools: {
      view() {
        if (viewThrows) throw new Error('no view');
        return { restrictableNames: new Set(names) };
      },
      restrict(filter) {
        calls.push(filter);
        if (first && failFirstWith.length > 0) {
          first = false;
          throw new Error('tools.restrict() names unknown global tool(s) ' + failFirstWith.map((n) => '"' + n + '"').join(', '));
        }
      },
    },
  };
}

const PREFIXES = ['mcp__snowluma__', 'mcp__snowluma-host__', 'mcp__web-search-safe__'];

test('只留白名单：鱼号那套 MCP、free-search、im 工具全部进 deny', () => {
  const names = [
    'mcp__snowluma__qq_send_message',
    'mcp__snowluma-host__qq_make_meme',
    'mcp__web-search-safe__web_search',
    'ask_user_question',
    'todo_write',
    'mcp__snowluma2__qq_send_message',
    'mcp__snowluma2-host__qq_make_meme',
    'web_search',
    'notify_qq',
    'session_control',
    'phone_lan',
  ];
  const ctx = fakeCtx(names);
  const masked = maskToAllowlist(ctx, { scope: 'QQ 桥接', prefixes: PREFIXES, exacts: [] });
  assert.equal(masked, 6, '11 个工具里应当遮掉 6 个（另一套 MCP 2 个 + 5 个全局里的 4 个）');
  const deny = ctx.calls[0].deny;
  assert.deepEqual(
    [...deny].sort(),
    ['mcp__snowluma2-host__qq_make_meme', 'mcp__snowluma2__qq_send_message', 'notify_qq', 'phone_lan', 'session_control', 'web_search'],
  );
  for (const kept of ['mcp__snowluma__qq_send_message', 'mcp__snowluma-host__qq_make_meme', 'mcp__web-search-safe__web_search', 'ask_user_question', 'todo_write']) {
    assert.ok(!deny.includes(kept), kept + ' 必须留着');
  }
});

test('主人版：phone-adb 前缀与 phone_lan 精确名都保留', () => {
  const names = ['mcp__phone-adb__phone_tap', 'phone_lan', 'mcp__snowluma__qq_send_message', 'web_search'];
  const ctx = fakeCtx(names);
  maskToAllowlist(ctx, {
    scope: '主人私聊',
    prefixes: [...PREFIXES, 'mcp__phone-adb__'],
    exacts: ['phone_lan'],
  });
  assert.deepEqual(ctx.calls[0].deny, ['web_search'], '只该遮掉 web_search');
});

test('unknown 名字让整批 restrict 抛错时，剥掉后重试成功', () => {
  const names = ['mcp__snowluma__qq_send_message', 'mcp__snowluma2__qq_diary', 'web_search'];
  const ctx = fakeCtx(names, { failFirstWith: ['mcp__snowluma2__qq_diary'] });
  const masked = maskToAllowlist(ctx, { scope: 'QQ 桥接', prefixes: PREFIXES, exacts: [] });
  assert.equal(ctx.calls.length, 2, '应当重试一次');
  assert.equal(masked, 1, '最终只遮掉 web_search');
  assert.deepEqual(ctx.calls[1].deny, ['web_search']);
});

test('拿不到工具清单时 fail-open（返回 0 且不抛）', () => {
  const ctx = fakeCtx(['a'], { viewThrows: true });
  assert.equal(maskToAllowlist(ctx, { scope: 'QQ 桥接', prefixes: PREFIXES, exacts: [] }), 0);
  assert.equal(ctx.calls.length, 0);
});

test('已全部在白名单内时不做任何 restrict', () => {
  const names = ['mcp__snowluma__qq_send_message', 'ask_user_question'];
  const ctx = fakeCtx(names);
  assert.equal(maskToAllowlist(ctx, { scope: 'QQ 桥接', prefixes: PREFIXES, exacts: [] }), 0);
  assert.equal(ctx.calls.length, 0);
});
