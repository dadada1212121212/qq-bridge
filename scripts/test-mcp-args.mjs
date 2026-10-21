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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickStr, argNames, missingArgHint, normEnum, aliasFields } from '../src/mcp-args.js';

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

console.log('\n参数容错：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);

/** 起一个 MCP 子进程，走 stdio JSON-RPC 调一个工具。 */
function callTool(entry, name, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT });
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
