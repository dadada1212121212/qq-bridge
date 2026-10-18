// 验证「某个 MCP 工具**确实不在**模型的工具面里」。
//
// 为什么需要：`cordis.patch.yml` 里写 `disabled: true` 不等于 DSH 真的把它摘了 ——
// 配置拼错、profile 没重新合成、字段名不对，全都只会表现成「工具不存在」这一种结果，
// 而没有任何一处会报错。唯一能证伪的办法就是真建一个会话、让模型去调一次，
// 看有没有 `tool/call` 事件。
//
// 用法：node scripts/probe-mcp-absent.mjs <preset> <工具全名>
//   node scripts/probe-mcp-absent.mjs qq-chat-v2 mcp__snowluma2__qq_account
//   node scripts/probe-mcp-absent.mjs qq-owner mcp__phone-adb__phone_status
//
// 退出码：0 = 确认不存在（预期）；1 = 竟然调用成功了（配置没生效）；2 = preset 挂载失败。
// ⚠️ 和 probe-owner-phone.mjs 一样直连 DSH，不经过桥接。
import { randomUUID } from 'node:crypto';
import { probeCookie, probeRpc, probeMuxSocket, probeWorkspaceDir } from './probe-auth.mjs';

const PRESET = process.argv[2] || 'qq-chat-v2';
const TOOL = process.argv[3];
if (!TOOL) {
  console.error('用法：node scripts/probe-mcp-absent.mjs <preset> <工具全名>');
  process.exit(2);
}

const cookie = probeCookie();
const rpc = probeRpc(cookie);

const dir = probeWorkspaceDir('mcp-absent');
const ws = await rpc('workspace/create', { request: { path: dir } });
const wsId = ws.value.workspace.workspaceId;

const sc = await rpc('session/create', { request: { workspaceId: wsId, agentPreset: PRESET } });
if (!sc.ok) {
  console.error(`❌ preset ${PRESET} 挂载失败: ${sc.error.code}: ${sc.error.message}`);
  process.exit(2);
}
const sessionId = sc.value.sessionId;
console.log(`session ${sessionId} (preset=${PRESET}, 目标工具=${TOOL})`);

await rpc('session/selectModel', {
  request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
});

const socket = probeMuxSocket(cookie);
const streamId = randomUUID();
const eventStreamId = randomUUID();
const toolCalls = [];
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
          content: [{ type: 'text', text: `调用 ${TOOL} 工具一次（不要传参数），然后只回复：完成` }],
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
    if (e.type === 'tool/call') toolCalls.push(String(e.data?.name ?? e.data?.toolName ?? ''));
    if (e.type === 'turn/end') finish('done');
  });
  socket.addEventListener('close', () => finish('closed'));
  socket.addEventListener('error', () => finish('error'));
});

const why = await done;
const called = toolCalls.includes(TOOL);
console.log(`\n结果: ${why}`);
console.log('最终文本:', JSON.stringify(text.slice(0, 300)));
console.log('tool/call:', JSON.stringify(toolCalls));
console.log('\n判定:');
console.log(`  ${TOOL} 被调用 : ${called ? '❌ 调到了（配置没生效）' : '✅ 不存在（符合预期）'}`);

try { socket.close(); } catch {}
await rpc('workspace/archiveSession', { request: { sessionId } });
console.log('[cleanup] archived');
process.exit(called ? 1 : 0);
