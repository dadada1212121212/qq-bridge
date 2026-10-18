// 端到端验证「主人私聊」这条路能用 dsh-phone-agent（工具名 phone_lan）。
//
// 为什么值得单独一个探针，而不是复用 probe-owner-phone.mjs：
//   `phone_lan` 和前一套 `mcp__phone-adb__*` 是**完全不同的一条链**——
//   它不受 MCP server 能不能起来影响，而是受三件事影响，每一件都只会表现为
//   「工具不存在」或「调用失败」，没有任何一处会主动报错：
//     ① 插件有没有被 DSH 加载（bundle 注册 + Node 能否解析 @deepseek-ai/dsh-tools）
//     ② 手机上的 App 有没有在跑、无障碍开没开、IP 对不对
//     ③ 守卫的 OWNER_EXTRA_EXACT 有没有放行 `phone_lan`
//
// 用法：node scripts/probe-owner-phone-lan.mjs [preset]
//   qq-owner     → 期望「调用成功」（action=status 返回连接信息）
//   qq-chat-v2   → 期望「被守卫拒绝」（正文含「不在QQ 桥接白名单内」）
// 退出码：0 通过；1 未观测到调用 / 被守卫拒绝 / 调了本地工具；2 preset 挂载失败。
//
// ⚠️ 与 probe-owner-phone.mjs 同样的坑：`isError` 在 `message` 里面，不在 data 顶层，
//    所以判定一律用**结果正文**匹配，不靠字段名。
import { randomUUID } from 'node:crypto';
import { probeCookie, probeRpc, probeMuxSocket, probeWorkspaceDir } from './probe-auth.mjs';

const PRESET = process.argv[2] || 'qq-owner';
const cookie = probeCookie();
const rpc = probeRpc(cookie);

const dir = probeWorkspaceDir('owner-phone-lan');
const ws = await rpc('workspace/create', { request: { path: dir } });
const wsId = ws.value.workspace.workspaceId;

const sc = await rpc('session/create', { request: { workspaceId: wsId, agentPreset: PRESET } });
if (!sc.ok) {
  console.error(`❌ preset ${PRESET} 挂载失败: ${sc.error.code}: ${sc.error.message}`);
  process.exit(2);
}
const sessionId = sc.value.sessionId;
console.log(`session ${sessionId} (preset=${PRESET})`);

const sm = await rpc('session/selectModel', {
  request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
});
console.log('selectModel ->', sm.ok ? JSON.stringify(sm.value.selected) : `FAIL ${sm.error.code}: ${sm.error.message}`);

const socket = probeMuxSocket(cookie);
const streamId = randomUUID();
const eventStreamId = randomUUID();
const toolCalls = [];
const toolResults = [];
let text = '';

const done = new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 120_000);
  const finish = (why) => { clearTimeout(timer); resolve(why); };
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }));
    socket.send(JSON.stringify({ type: 'open', streamId: eventStreamId, endpoint: '$events', payload: { args: {} } }));
    setTimeout(async () => {
      const p = await rpc('session/prompt', {
        request: {
          sessionId, requestId: randomUUID(), mode: 'queue',
          content: [{ type: 'text', text: '调用 phone_lan 工具一次，参数 action 传 "status"，然后只回复：完成' }],
        },
      });
      console.log('prompt ->', JSON.stringify(p).slice(0, 160));
    }, 700);
  });
  socket.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== 'item' || m.streamId === eventStreamId) return;
    const v = m.value;
    if (v?.type !== 'event') return;
    const e = v.event;
    if (e.type === 'assistant/message') for (const b of e.data?.message?.content ?? []) if (b?.type === 'text') text += b.text;
    if (e.type === 'tool/call') toolCalls.push({ name: e.data?.name ?? e.data?.toolName, args: e.data?.arguments ?? e.data?.args });
    if (e.type === 'tool/result') toolResults.push({ raw: JSON.stringify(e.data).slice(0, 1200) });
    if (e.type === 'turn/end') finish('done');
  });
  socket.addEventListener('close', () => finish('closed'));
  socket.addEventListener('error', () => finish('error'));
});

const why = await done;
console.log(`\n结果: ${why}`);
console.log('最终文本:', JSON.stringify(text.slice(0, 300)));
console.log('tool/call:', JSON.stringify(toolCalls, null, 2));
console.log('tool/result(raw):');
for (const r of toolResults) console.log('  ' + r.raw);

const calledLan = toolCalls.some((c) => String(c.name) === 'phone_lan');
const DENY_MARK = /不在(主人私聊|QQ 桥接)白名单内|已拒绝/;
const lanDenied = toolResults.some((r) => DENY_MARK.test(r.raw));
const lanErrored = toolResults.some((r) => /"isError":true/.test(r.raw));
const calledLocal = toolCalls.some((c) => /^(pwsh|bash|shell|write|edit|read|glob|grep|run_command)$/.test(String(c.name)));
// 连不上手机的典型正文（插件抛的是 connection timeout / ECONNREFUSED 之类）
const lanUnreachable = toolResults.some((r) => /ECONNREFUSED|ETIMEDOUT|timeout|connect/i.test(r.raw));

console.log('\n判定:');
console.log(`  phone_lan 可调用          : ${calledLan ? '✅' : '❌ 未观测到 phone_lan 调用（插件没挂上？）'}`);
console.log(`  被守卫拒绝                : ${lanDenied ? '⛔ 是（预期：群聊 preset 必须拒绝）' : '否'}`);
console.log(`  结果带 isError            : ${lanErrored ? '是' : '否'}`);
console.log(`  疑似连不上手机            : ${lanUnreachable ? '⚠️ 是（看 IP / App 有没有开）' : '否'}`);
console.log(`  未调用本地危险工具        : ${calledLocal ? '❌ 出现了本地工具调用' : '✅'}`);

try { socket.close(); } catch {}
await rpc('workspace/archiveSession', { request: { sessionId } });
console.log('[cleanup] archived');
process.exit(calledLan && !lanDenied && !calledLocal ? 0 : 1);
