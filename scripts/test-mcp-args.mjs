// [养鱼 2026-10-21] MCP 工具参数容错的回归。
//
// 背景：一次真实对话里模型连续三次撞在 zod 上——
//   bili_search 传 { keyword } → `expected string, received undefined at query`
//   bili_post_comment 传 { bvid } → 同样报错
//   qq_set_wake_config 传 mode:'silent' → `expected one of "diving"|"active"`
// 每次都要再猜一轮，既慢又烧 token。这里钉住两件事：
//   ① 别名在 **schema 层**就被接受（zod 会丢弃未声明的键，声明漏了就等于没传）；
//   ② 真的一个都没传时，给的是能照着做的中文，不是 zod 的 JSON 路径。
//
// 注意：凡是"会真的发出去"的调用一律不测（发评论/发消息），只用
// 「缺必填项 ⇒ 在本地就被拦下」和「无效令牌 ⇒ 走到桥接才失败」这两类路径。
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickStr, argNames, missingArgHint, normEnum, aliasFields, foldAliases, asArray, pickStrOrList } from '../src/mcp-args.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? `（${extra}）` : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? `（实际 ${extra}）` : '')); }
};

// ── 纯函数 ───────────────────────────────────────────────────────────────────
console.log('## pickStr：按优先级取，跳过空值');
t('取第一个非空', pickStr({ query: '鲸鱼' }, ['query', 'keyword']) === '鲸鱼');
t('主名缺失时回退别名', pickStr({ keyword: '蓝鲸' }, ['query', 'keyword']) === '蓝鲸');
t('空串不算（避免用空关键词去搜）', pickStr({ query: '  ', keyword: '肥鱼' }, ['query', 'keyword']) === '肥鱼');
t('数字转字符串（BV 号/QQ 号常被当数字传）', pickStr({ mid: 3546974573824927 }, ['mid']) === '3546974573824927');
t('全缺返回空串', pickStr({}, ['query']) === '');
t('非对象不炸', pickStr(null, ['query']) === '');

console.log('## argNames：报错时回显"你到底传了什么"');
t('列出收到的键', argNames({ bvid: 'BV1', content: 'x' }) === 'bvid / content');
t('空对象', argNames({}) === '（空）');

console.log('## missingArgHint：说清缺哪个 + 你传了什么');
{
  const h = missingArgHint('bili_post_comment', 'message', '评论正文', { bvid: 'BV1JaJo6jEqH' });
  t('点名工具', h.includes('bili_post_comment'));
  t('点名缺失字段', h.includes('message'));
  t('回显收到的参数', h.includes('bvid'));
  t('不出现 zod 的 JSON 路径', !h.includes('at query') && !h.includes('received undefined'));
}

console.log('## normEnum：常见说法归一');
{
  const aliases = { diving: 'diving', silent: 'diving', quiet: 'diving', active: 'active', normal: 'active' };
  t('silent → diving', normEnum('silent', aliases) === 'diving');
  t('大小写/空格无关', normEnum('  SILENT ', aliases) === 'diving');
  t('normal → active', normEnum('normal', aliases) === 'active');
  t('认不出返回空串（交给调用方报错）', normEnum('sleepy', aliases) === '');
  t('非字符串返回空串', normEnum(undefined, aliases) === '');
}

console.log('## aliasFields：别名都声明成可选');
{
  const fakeZ = { string: () => ({ optional: () => 'OPT' }) };
  const f = aliasFields(fakeZ, ['query', 'keyword', 'q'], 'query');
  t('不含主名', !Object.hasOwn(f, 'query'));
  t('含 keyword / q', Object.hasOwn(f, 'keyword') && Object.hasOwn(f, 'q'));
}

console.log('## foldAliases：别名折叠 + 认不出的键要报出来');
{
  const map = { atMention: ['at', 'mention'], nameMention: ['name'], keywords: ['keyword'] };
  const r = foldAliases({ at: true, name: false, keyword: '鲸鱼' }, map);
  t('at → atMention', r.value.atMention === true);
  t('name → nameMention（false 也要折叠，不能当没传）', r.value.nameMention === false);
  t('keyword → keywords', r.value.keywords === '鲸鱼');
  t('别名键被删掉，不会转发给桥接', !('at' in r.value) && !('name' in r.value) && !('keyword' in r.value));
  t('没有多余键时不报警', r.dropped.length === 0, r.dropped.join(','));

  const bad = foldAliases({ at: true, zzz: 1, yyy: 2 }, map);
  t('认不出的键被列出来（这就是"静默失效"的解药）', bad.dropped.join(',') === 'zzz,yyy', bad.dropped.join(','));

  const both = foldAliases({ atMention: false, at: true }, map);
  t('规范名优先，别名不覆盖它', both.value.atMention === false);

  t('非对象不炸', foldAliases(null, map).value === null);
}

console.log('## asArray / pickStrOrList：关键词可拆，消息不能拆');
{
  t('数组原样', asArray(['a', 'b']).join('|') === 'a|b');
  t('逗号串拆分', asArray('大肥鱼,本鲸').join('|') === '大肥鱼|本鲸');
  t('中文逗号也拆', asArray('大肥鱼，本鲸').length === 2);
  t('空格也拆', asArray('a b').length === 2);

  // 消息绝不能按空格拆：一句话被拆成两条发出去是事故。
  t('消息字符串原样保留', pickStrOrList({ messages: '我今天有点累 想早点睡' }, ['messages']) === '我今天有点累 想早点睡');
  t('消息别名回退', pickStrOrList({ message: '在' }, ['messages', 'message']) === '在');
  t('消息数组原样', Array.isArray(pickStrOrList({ messages: ['一', '二'] }, ['messages'])));
  t('全空返回 undefined', pickStrOrList({ messages: '   ' }, ['messages']) === undefined);
}

// ── 真实 MCP 协议：别名必须过 zod ────────────────────────────────────────────
console.log('## bili_post_comment：只传 bvid（别名）也要过校验');
{
  // 不传 message ⇒ handler 在本地就拦下，绝不会真的发出去。
  const r = await callTool(path.join(ROOT, 'src', 'mcp-bilibili.js'), 'bili_post_comment', { bvid: 'BV1JaJo6jEqH' });
  t('没有 zod 校验错误', !r.error, r.error || '');
  t('返回友好提示而不是 zod 原文', /缺少 message/.test(r.text), r.text.slice(0, 60));
  t('提示里回显了 bvid', /bvid/.test(r.text));
}

console.log('## bili_post_comment：一个参数都不给');
{
  const r = await callTool(path.join(ROOT, 'src', 'mcp-bilibili.js'), 'bili_post_comment', {});
  t('没有 zod 校验错误', !r.error, r.error || '');
  t('先报 video 缺失', /缺少 video/.test(r.text), r.text.slice(0, 60));
}

console.log('## qq_set_wake_config：mode 传 silent 也要过校验');
{
  // 令牌故意用假的：校验通过 ⇒ 一路走到桥接才失败，错误文案是"设置唤醒配置失败"。
  const r = await callTool(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'qq_set_wake_config', {
    key: 'private:1',
    token: 'x'.repeat(48),
    config: { mode: 'silent' },
  });
  t('没有 zod 校验错误', !r.error, r.error || '');
  t('不是 enum 报错', !/expected one of/.test(r.text), r.text.slice(0, 80));
  t('走到了桥接（说明 schema 收下了 silent）', /设置唤醒配置失败/.test(r.text), r.text.slice(0, 80));
}

console.log('## qq_send_message：messages 写成 message 也要能发');
{
  // token 给个假的（48 位）：能过 schema，桥接会以"未授权"拒绝，不会真的发出去。
  const r = await callTool(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'qq_send_message', { key: 'private:1', token: 'x'.repeat(48), message: '在' });
  t('没有 zod 校验错误', !/Input validation error/.test(r.text) && !r.error, (r.error || r.text).slice(0, 90));
  t('没报 messages 缺失', !/缺少 messages/.test(r.text), r.text.slice(0, 60));
  t('走到了桥接（说明 message 别名被认下）', /发送失败/.test(r.text), r.text.slice(0, 60));
}

console.log('## 端到端：别名折叠后转发给桥接，认不出的字段要明说');
{
  const requests = [];
  const api = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, key: 'private:1', wakeConfig: { mode: 'diving', triggers: { atMention: true } } }));
  });
  await new Promise((resolve, reject) => {
    api.once('error', reject);
    api.listen(0, '127.0.0.1', resolve);
  });
  let fixture = null;
  try {
    fixture = await fs.promises.mkdtemp(path.join(ROOT, '.tmp-mcp-args-test-'));
    await fs.promises.mkdir(path.join(fixture, 'src'));
    await Promise.all(['mcp-snowluma-safe.js', 'qq-model-view.js', 'sensitive.js', 'mcp-args.js'].map((name) =>
      fs.promises.copyFile(path.join(ROOT, 'src', name), path.join(fixture, 'src', name))));
    await fs.promises.writeFile(path.join(fixture, 'config.json'), JSON.stringify({ consolePort: api.address().port }));

    const r = await callTool(path.join(fixture, 'src', 'mcp-snowluma-safe.js'), 'qq_set_wake_config', {
      key: 'private:1',
      token: 'fixture-token',
      config: { mode: 'silent', triggers: { at: true, name: true, keyword: '大肥鱼,本鲸', zzz: 1 } },
    }, fixture);

    const body = requests.at(-1)?.body || {};
    const tr = body.config?.triggers || {};
    t('打到了桥接', requests.length === 1, String(requests.length));
    t('mode 归一成 diving', body.config?.mode === 'diving', String(body.config?.mode));
    t('at → atMention', tr.atMention === true);
    t('name → nameMention', tr.nameMention === true);
    t('keyword 字符串拆成数组', Array.isArray(tr.keywords) && tr.keywords.join('|') === '大肥鱼|本鲸', JSON.stringify(tr.keywords));
    t('别名键没有转发出去', !('at' in tr) && !('name' in tr) && !('keyword' in tr));
    t('认不出的 zzz 没有转发', !('zzz' in tr));
    t('响应里明确说了 zzz 没生效（不许静默成功）', /zzz/.test(r.text) && /没生效/.test(r.text), r.text.slice(-120));
  } finally {
    await new Promise((resolve) => api.close(resolve));
    if (fixture) await fs.promises.rm(fixture, { recursive: true, force: true });
  }
}

console.log('\n参数容错：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);

/** 起一个 MCP 子进程，走 stdio JSON-RPC 调一个工具。 */
function callTool(entry, name, args, cwd = ROOT) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], cwd });
    let buf = '';
    const pending = new Map();
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已退出 */ }
      resolve(v);
    };
    const timer = setTimeout(() => done({ error: 'MCP 响应超时（20s）', text: '' }), 20000);

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const cb = pending.get(msg.id);
        if (cb) { pending.delete(msg.id); cb(msg); }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); done({ error: e.message, text: '' }); });

    const req = (id, method, params) => new Promise((res) => {
      pending.set(id, res);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

    (async () => {
      try {
        await req(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-args-test', version: '1' } });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        const r = await req(2, 'tools/call', { name, arguments: args });
        clearTimeout(timer);
        const text = (r.result?.content || []).map((c) => c.text).join(' ');
        done({ text: text || '', error: r.error ? String(r.error.message || JSON.stringify(r.error)) : null });
      } catch (e) {
        clearTimeout(timer);
        done({ error: e.message, text: '' });
      }
    })();
  });
}
