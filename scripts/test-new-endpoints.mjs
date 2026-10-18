#!/usr/bin/env node
/**
 * 新工具 HTTP 端点端到端测试：回合制游戏 + 音乐分享链接。
 *
 * 与逻辑测试（test-turn-games.mjs / test-music-links.mjs）的分工：
 *   逻辑测试验证算法；本文件验证 **HTTP 端点这层** —— 鉴权、限频、参数透传、错误码。
 *
 * 用 harness 起隔离环境，不碰真实 QQ、不发真消息。
 * 运行：node scripts/test-new-endpoints.mjs
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
      tools: { turnGame: true, musicShare: true, groupTools: true },
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

// ⚠️ key 必须同时进 body（端点从 body.key 读），并带两个头（x-console-token 前置门 + x-agent-token 会话绑定）。
function post(path, body, { token = st.agentToken, key = KEY, noToken = false, noCallHeader = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' };
    if (!noToken && token) {
      headers['x-agent-token'] = token;
      if (!noCallHeader) headers['x-agent-call'] = '1';
    }
    const req = http.request({
      hostname: '127.0.0.1', port,
      path: `${path}?key=${encodeURIComponent(key)}`,
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
    req.end(JSON.stringify({ key, ...body }));
  });
}

// ── 回合制游戏端点 ────────────────────────────────────────────────────────
await t('turn-game：start 返回 ok 与文案', async () => {
  const r = await post('/api/socialV2/turn-game', { action: 'start', game: 'guess', max: 50 });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.ok(r.data.text && r.data.text.length > 0, '没返回文案');
  assert.equal(r.data.state.game, 'guess');
  assert.equal(r.data.state.status, 'playing');
});

await t('turn-game：move 推进后状态保留（跨调用）', async () => {
  await post('/api/socialV2/turn-game', { action: 'start', game: 'guess', max: 100 });
  const r = await post('/api/socialV2/turn-game', { action: 'move', guess: 50 });
  assert.equal(r.status, 200);
  assert.equal(r.data.state.tries, 1, 'tries 没累加');
  assert.ok(r.data.text.includes('太大') || r.data.text.includes('太小') || r.data.text.includes('中'), '文案没说大小');
});

await t('turn-game：未开局就 move 返回 400', async () => {
  const k2 = 'private:123';   // 在白名单内，确保 403 来自"无局"而非"会话不允许"
  const st123 = h.getSocialV2State(k2);
  const r = await post('/api/socialV2/turn-game', { action: 'move', guess: 1 }, { key: k2, token: st123.agentToken });
  assert.equal(r.status, 400, '应 400，实际 ' + r.status);
  assert.ok(/开局/.test(r.data.error));
});

await t('turn-game：state 返回当前局面', async () => {
  await post('/api/socialV2/turn-game', { action: 'start', game: 'twenty' });
  const r = await post('/api/socialV2/turn-game', { action: 'state' });
  assert.equal(r.status, 200);
  assert.equal(r.data.state.game, 'twenty');
});

await t('turn-game：quit 后无进行中的局', async () => {
  await post('/api/socialV2/turn-game', { action: 'start', game: 'soup' });
  const r = await post('/api/socialV2/turn-game', { action: 'quit' });
  assert.equal(r.status, 200);
  assert.ok(/结束/.test(r.data.text));
});

await t('turn-game：缺 key 返回 400', async () => {
  const r = await post('/api/socialV2/turn-game', { action: 'start', game: 'guess' }, { key: '' });
  assert.equal(r.status, 400);
});

await t('turn-game：agent token 错 → 403', async () => {
  const r = await post('/api/socialV2/turn-game', { action: 'start', game: 'guess' }, { token: 'wrong-token-xyz' });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.ok(/会话令牌|token/.test(r.data.error));
});

await t('turn-game：声明 x-agent-call 但令牌空 → 403（confused deputy）', async () => {
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: `/api/socialV2/turn-game?key=${encodeURIComponent(KEY)}`, method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': '' } },
      (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(d || '{}') })); });
    req.on('error', reject); req.end(JSON.stringify({ key: KEY, action: 'start', game: 'guess' }));
  });
  assert.equal(r.status, 403, `应被拒，实际 ${r.status} ${JSON.stringify(r.data)}`);
});

await t('turn-game：工具禁用 → 403', async () => {
  const h2 = await bridgeHarness({
    config: { socialV2: { tools: { turnGame: false }, wake: { preSleepWaitEnabled: false }, proactive: { enabled: false }, sticker: { enabled: false } } },
  });
  h2.setMode('reserved2');
  const st2 = h2.getSocialV2State('group:456');   // 用白名单内的 key，避免被"会话不允许"先挡下
  const s2 = h2.startConsoleServer();
  if (!s2.listening) await new Promise((r) => s2.once('listening', r));
  const p2 = s2.address().port;
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: p2, path: '/api/socialV2/turn-game?key=' + encodeURIComponent('group:456'), method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': st2.agentToken, 'x-agent-call': '1' } },
      (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(d || '{}') })); });
    req.on('error', reject); req.end(JSON.stringify({ key: 'group:456', action: 'start', game: 'guess' }));
  });
  assert.equal(r.status, 403, '禁用应 403，实际 ' + r.status);
  assert.ok(/未启用/.test(r.data.error));
});

await t('turn-game：一分钟内超 60 次 → 429 限频', async () => {
  const codes = [];
  for (let i = 0; i < 65; i++) codes.push((await post('/api/socialV2/turn-game', { action: 'state' })).status);
  const late = codes.slice(60);
  assert.ok(late.includes(429), `第 61 次起应出现 429，尾部：${late.join(',')}`);
});

// ── 音乐分享端点 ──────────────────────────────────────────────────────────
await t('music-share：返回真实链接', async () => {
  const r = await post('/api/socialV2/music-share', { platform: 'netease', song: '稻香', artist: '周杰伦' });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.ok(r.data.url.startsWith('https://'), '不是 https 链接: ' + r.data.url);
  assert.ok(r.data.url.includes('music.163.com'), '域名不对: ' + r.data.url);
  assert.ok(r.data.text.includes(r.data.url), '文案漏了链接');
});

await t('music-share：id 直跳播放页', async () => {
  const r = await post('/api/socialV2/music-share', { platform: 'qq', id: '999' });
  assert.equal(r.status, 200);
  assert.ok(r.data.url.includes('999'), 'id 没进链接: ' + r.data.url);
});

await t('music-share：啥都没给 → 400', async () => {
  const r = await post('/api/socialV2/music-share', {});
  assert.equal(r.status, 400);
});

await t('music-share：agent token 错 → 403', async () => {
  const r = await post('/api/socialV2/music-share', { song: 'x' }, { token: 'wrong' });
  assert.equal(r.status, 403);
});

await t('music-share：声明 x-agent-call 但令牌空 → 403', async () => {
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: `/api/socialV2/music-share?key=${encodeURIComponent(KEY)}`, method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': '' } },
      (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(d || '{}') })); });
    req.on('error', reject); req.end(JSON.stringify({ key: KEY, song: 'x' }));
  });
  assert.equal(r.status, 403);
});

// ── 群内小工具端点 ─────────────────────────────────────────────────────
await t('group-tools：开投票返回选项列表', async () => {
  const r = await post('/api/socialV2/group-tools', { action: 'start_poll', options: ['火锅', '烧烤'], title: '今晚吃啥' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  assert.equal(r.data.poll.options.length, 2);
  assert.match(r.data.text, /投票/);
});

await t('group-tools：投票后 tally 记到票', async () => {
  await post('/api/socialV2/group-tools', { action: 'start_poll', options: ['A', 'B'] });
  await post('/api/socialV2/group-tools', { action: 'vote', choice: 1, voter: '小张' });
  const r = await post('/api/socialV2/group-tools', { action: 'tally' });
  assert.equal(r.status, 200);
  assert.equal(r.data.tally.total, 1);
  assert.equal(r.data.tally.counts[0], 1);
});

await t('group-tools：改票不增加总票数', async () => {
  await post('/api/socialV2/group-tools', { action: 'start_poll', options: ['A', 'B'] });
  await post('/api/socialV2/group-tools', { action: 'vote', choice: 1, voter: '同一个人' });
  await post('/api/socialV2/group-tools', { action: 'vote', choice: 2, voter: '同一个人' });
  const r = await post('/api/socialV2/group-tools', { action: 'tally' });
  assert.equal(r.data.tally.total, 1);
  assert.equal(r.data.tally.counts[1], 1);
});

await t('group-tools：平局如实返回 tie', async () => {
  await post('/api/socialV2/group-tools', { action: 'start_poll', options: ['A', 'B'] });
  await post('/api/socialV2/group-tools', { action: 'vote', choice: 1, voter: 'x' });
  await post('/api/socialV2/group-tools', { action: 'vote', choice: 2, voter: 'y' });
  const r = await post('/api/socialV2/group-tools', { action: 'close_poll' });
  assert.equal(r.data.tally.tie, true);
  assert.equal(r.data.tally.winner, null);
});

await t('group-tools：decide 从选项里选一个', async () => {
  const r = await post('/api/socialV2/group-tools', { action: 'decide', options: ['火锅', '烧烤', '日料'] });
  assert.equal(r.status, 200);
  assert.ok(['火锅', '烧烤', '日料'].includes(r.data.result.picked));
});

await t('group-tools：选项少于 2 个 → 400', async () => {
  const r = await post('/api/socialV2/group-tools', { action: 'start_poll', options: ['只有一个'] });
  assert.equal(r.status, 400);
});

await t('group-tools：未知 action → 400', async () => {
  const r = await post('/api/socialV2/group-tools', { action: '乱来' });
  assert.equal(r.status, 400);
});

await t('group-tools：token 错 → 403', async () => {
  const r = await post('/api/socialV2/group-tools', { action: 'decide', options: ['A', 'B'] }, { token: 'wrong-token' });
  assert.equal(r.status, 403);
});

console.log(`\n# tests ${pass + fail}`);
console.log(`# pass  ${pass}`);
console.log(`# fail  ${fail}`);
server.close();
process.exit(fail ? 1 : 0);
