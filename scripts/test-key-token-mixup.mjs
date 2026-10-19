// Regression for 「agent token 无效」: the wake prompt used to instruct the model to put the
// session token into BOTH `key` and `token` (see src/bridge.js buildWakePromptV2). Historical
// turns still carry that wrong sentence, so the bridge heals it at the request entry points:
// readBody() for POST bodies and the query rewrite for GET endpoints.
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const ACTIVE = { mode: 'active' };
const TOKEN_SHAPED_BUT_UNRELATED = 'a'.repeat(48);
let failures = 0;
let tests = 0;

async function test(name, run) {
  tests++;
  const h = await bridgeHarness({ config: { socialV2: {
    wake: { preSleepWaitEnabled: false, preSleepWaitMs: 1000 },
    wait: { minMs: 100, maxMs: 2000, minQuietAfterNewMs: 0 },
    proactive: { enabled: false },
    sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (route, { body, token = st.agentToken, key = KEY, admin = false, query = '' } = {}) => new Promise((resolve, reject) => {
    const headers = { 'x-console-token': 'fixture-console-token' };
    if (!admin) headers['x-agent-token'] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `${route.startsWith('/') ? route : `/api/socialV2/${route}`}?key=${encodeURIComponent(key)}${query}`,
      method: body === undefined ? 'GET' : 'POST', headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('fixture HTTP request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify({ key, ...body }));
  });
  const append = (text, { key = KEY, id = `fixture-${h.getSocialV2State(key).lastUnreadSeq + 1}` } = {}) => {
    h.appendSocialV2Message(key, 'fixture-person', text, text, false, false, id, [], '789', []);
    return h.getSocialV2State(key).lastUnreadSeq;
  };
  try { await run({ h, st, request, append }); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.stack); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

await test('a POST whose key is the session token is healed instead of rejected', async ({ st, request, append }) => {
  append('hello');
  const read = await request('unread');
  assert.equal(read.status, 200);
  // 模型把令牌同时填进 key 和 token —— 正是用户实测报错的那种入参。
  const result = await request('wake-config', {
    key: st.agentToken,
    body: { config: ACTIVE, throughSeq: read.data.readThroughSeq },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.markedCount, 1);
  assert.equal(st.wakeConfig.confirmedBy, 'set_wake_config');
  assert.equal(st.wakeConfig.mode, 'active');
});

await test('a GET whose query key is the session token is healed too', async ({ st, request, append }) => {
  append('one');
  append('two');
  const read = await request('unread', { key: st.agentToken });
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.equal(read.data.messages.length, 2);
  assert.equal(read.data.readThroughSeq, 2);
  const recent = await request('recent', { key: st.agentToken, query: '&limit=5' });
  assert.equal(recent.status, 200, JSON.stringify(recent.data));
});

await test('a token-shaped key that is not the presented token is still rejected', async ({ request }) => {
  const denied = await request('unread', { key: TOKEN_SHAPED_BUT_UNRELATED });
  assert.equal(denied.status, 403);
  assert.match(denied.data.error, /agent token 无效/);
});

await test('the healed request still lands on the right conversation', async ({ h, st, request, append }) => {
  const OTHER = 'group:789';
  h.getSocialV2State(OTHER);
  append('mine');
  append('theirs', { key: OTHER });
  const read = await request('unread', { key: st.agentToken });
  assert.equal(read.status, 200);
  assert.equal(read.data.messages.length, 1);
  assert.equal(read.data.messages[0].text, 'mine');
  assert.equal(h.getSocialV2State(OTHER).unread.length, 1, 'another conversation must stay untouched');
});

await test('the wake prompt spells out the real conversation key next to the token', async ({ h, st }) => {
  const prompt = await h.buildWakePromptV2(KEY, 'newMessage');
  assert.ok(prompt.includes(`key = ${KEY}`), 'wake prompt must carry the real conversation key');
  assert.ok(prompt.includes(st.agentToken), 'wake prompt must still carry the session token');
  assert.ok(!prompt.includes('同时填进 key 和 token'), 'the old misleading instruction must be gone');
  // 提醒版（回合收尾）走的是另一处 tokenLine，同样要修好。
  const reminder = h.buildWakeReminderPromptV2(KEY);
  assert.ok(reminder.includes(`key = ${KEY}`));
  assert.ok(!reminder.includes('同时填进 key 和 token'));
});

await test('fully swapped key/token (token in key, key in token) is healed too', async ({ st, request, append }) => {
  // [patch 2026-10-19] 新场景：key=令牌、token=会话 key 整个填反（实测 qq_get_prompt 报
  // 「未授权：智能体调用必须携带有效的会话令牌」）。key 反查 + token 按 key 补真令牌。
  append('swap');
  const read = await request('unread');
  const result = await request('wake-config', {
    key: st.agentToken,
    body: { config: ACTIVE, throughSeq: read.data.readThroughSeq, token: KEY },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
});

console.log(`\n${tests - failures}/${tests} passed`);
if (failures) process.exitCode = 1;
