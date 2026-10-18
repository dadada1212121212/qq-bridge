#!/usr/bin/env node
/**
 * 轻量游戏端点端到端测试。
 *
 * 与 test-light-games.mjs 的分工
 * ==============================
 *   单元测试（test-light-games.mjs）：验证游戏**算法**（骰子范围、猜拳视角…）
 *   本文件：验证**HTTP 端点**这层 —— 鉴权、限频、参数透传、错误码。
 *
 * 端点这层单独测的理由：算法对了但端点忘了校验 token，等于把游戏接口
 * 暴露给任何能访问本机端口的人。而且限频写错了会导致模型"多抽几次挑
 * 一个喜欢的"（那本质是在作弊），这类问题单元测试看不到。
 *
 * 用 harness 起隔离环境，不碰真实 QQ、不发真消息。
 * 运行：node scripts/test-light-game-endpoint.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e?.message || e)); }
}

const KEY = 'group:456';
const h = await bridgeHarness({
  config: {
    socialV2: {
      tools: { lightGame: true },
      wake: { preSleepWaitEnabled: false },
      wait: { minMs: 100, maxMs: 2000, minQuietAfterNewMs: 0 },
      proactive: { enabled: false },
      sticker: { enabled: false },
    },
  },
});
h.setMode('reserved2');
const st = h.getSocialV2State(KEY);
const server = h.startConsoleServer();
if (!server.listening) await new Promise((r) => server.once('listening', r));
const port = server.address().port;

function post(body, { token = st.agentToken, key = KEY, noToken = false } = {}) {
  return new Promise((resolve, reject) => {
    // ⚠️ 必须同时带两个头，这是 MCP 工具真实的行为：
    //   x-console-token —— 控制台的全权凭证，**所有**请求的前置门（4051 行）
    //   x-agent-token   —— 会话令牌，用于把调用绑定到具体会话
    // 只带 agent token 会被前置门以 401「请提供控制台访问令牌」挡掉，
    // 那样测出来的 401 是"我头传错了"，而不是"鉴权逻辑正确"。
    const headers = {
      'content-type': 'application/json',
      'x-console-token': 'fixture-console-token',
    };
    if (!noToken && token) {
      headers['x-agent-token'] = token;
      headers['x-agent-call'] = '1';
    }
    const req = http.request({
      hostname: '127.0.0.1', port,
      path: `/api/socialV2/light-game?key=${encodeURIComponent(key)}`,
      method: 'POST', headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: { raw: data } }); }
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

console.log('='.repeat(60));
console.log('轻量游戏端点端到端测试');
console.log('='.repeat(60));

console.log('\n【正常路径】');
await t('掷骰 2d6 返回结果与文案', async () => {
  const r = await post({ key: KEY, game: 'dice', spec: '2d6' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  assert.equal(r.data.result.kind, 'dice');
  assert.equal(r.data.result.rolls.length, 2);
  assert.match(r.data.text, /掷出了/);
});
await t('猜拳返回视角说明', async () => {
  const r = await post({ key: KEY, game: 'rps', mine: '石头' });
  assert.equal(r.data.ok, true);
  assert.equal(r.data.result.mine, '石头');
  assert.ok(['win', 'lose', 'draw'].includes(r.data.result.outcome));
});
await t('抽签自定义池只从池里出', async () => {
  const r = await post({ key: KEY, game: 'fortune', pool: ['甲', '乙'] });
  assert.equal(r.data.ok, true);
  assert.ok(['甲', '乙'].includes(r.data.result.result));
  assert.equal(r.data.result.custom, true);
});
await t('投币返回正/反面', async () => {
  const r = await post({ key: KEY, game: 'coin' });
  assert.equal(r.data.ok, true);
  assert.ok(['正面', '反面'].includes(r.data.result.result));
});

console.log('\n【参数校验】');
await t('未知游戏 → 400 且带可读错误', async () => {
  const r = await post({ key: KEY, game: '麻将' });
  assert.equal(r.status, 400);
  assert.equal(r.data.ok, false);
  assert.match(r.data.error, /不认识的游戏/);
});
await t('非法骰子记法 → 400', async () => {
  const r = await post({ key: KEY, game: 'dice', spec: 'xyz' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /格式不对/);
});
await t('猜拳非法出拳 → 400', async () => {
  const r = await post({ key: KEY, game: 'rps', mine: '锤子' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /石头/);
});
await t('缺 key → 400', async () => {
  const r = await post({ game: 'dice' }, { key: '' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /key 不能为空/);
});

console.log('\n【鉴权】');
await t('agent token 错 → 403（被会话绑定校验拦下）', async () => {
  const r = await post({ key: KEY, game: 'dice' }, { token: 'wrong-token-xyz' });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.match(r.data.error, /会话令牌|token/);
});
await t('★ 声明了 x-agent-call 但令牌为空 → 403（confused deputy 防护）', async () => {
  // 这个头是 MCP 侧声明"我是智能体调用"用的。若带了它却没有有效令牌，
  // 集中关卡必须拒绝 —— 否则「模型忘了传 token」会被当成控制台全权。
  const r = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port,
      path: `/api/socialV2/light-game?key=${encodeURIComponent(KEY)}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-console-token': 'fixture-console-token',
        'x-agent-call': '1',
        'x-agent-token': '',
      },
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(d || '{}') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ key: KEY, game: 'dice' }));
  });
  assert.equal(r.status, 403, `应被拒，实际 ${r.status} ${JSON.stringify(r.data)}`);
  assert.match(r.data.error, /会话令牌|token/);
});

console.log('\n【限频】');
await t('一分钟内超过 30 次会被 429 拦下', async () => {
  const codes = [];
  for (let i = 0; i < 35; i++) {
    const r = await post({ key: KEY, game: 'coin' });
    codes.push(r.status);
  }
  const late = codes.slice(30);
  assert.ok(late.includes(429),
    `第 31 次起应出现 429，实际状态序列尾部：${late.join(',')}`);
});
await t('★ 限频是按 key 隔离的（别的会话不受影响）', async () => {
  // harness 的白名单是 allow.groups=['456'] / allow.private=['123']，
  // 所以"另一个会话"只能用 private:123。用白名单外的 key 会在
  // v2SessionAllowed 就被 403 挡下，那样测的是白名单而不是限频隔离。
  const other = 'private:123';
  const st2 = h.getSocialV2State(other);
  const r = await post({ key: other, game: 'coin' },
    { token: st2.agentToken, key: other });
  assert.equal(r.status, 200,
    `别的会话被 group:456 的限频误伤：${JSON.stringify(r.data)}`);
});

console.log('\n' + '='.repeat(60));
console.log(`通过 ${pass}，失败 ${fail}`);
console.log('='.repeat(60));
server.close();
process.exit(fail ? 1 : 0);
