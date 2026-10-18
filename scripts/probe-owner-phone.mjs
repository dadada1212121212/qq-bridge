// 端到端验证「主人私聊」这条路真的能操作手机。
//
// 为什么需要这个探针（它是整条链上唯一能证伪的一环）：
//   · qq-owner preset 是否注册进 DSH  →  agentPresets/list 能回答（probe-owner-preset.mjs）
//   · 守卫是否按 preset 分流          →  scripts/test-agent-preset-patches.mjs 能回答（纯函数）
//   · **DSH 真的把 mcp__phone-adb__* 挂进了 qq-owner 会话的工具面**  →  只有真建一个会话、
//     让模型真的调一次工具才能回答。patch 里写了 mcp-phone-adb 不等于它起得来：
//     Python 路径写错、MCP server 启动即崩、preset 行名解析失败，都只会表现为
//     「工具不存在」，而桥接那边只会静默回退 —— 没有任何一处会报错。
//
// 这个探针直连 DSH，**不经过桥接**，所以桥接没重启也能跑。
//
// 用法：node scripts/probe-owner-phone.mjs [preset]
//   qq-owner     → 期望「调用成功、返回真机数据」（isError:false）
//   qq-chat-v2   → 期望「被守卫拒绝」（isError:true，正文含「不在QQ 桥接白名单内」）
// 退出码：0 通过；1 未观测到手机工具调用 / 被守卫拒绝 / 调了本地工具；2 preset 挂载失败。
//
// ⚠️ 别用 `e.data.isError` 判断成败：tool/result 事件的形状是
//    { turn, step, message: { role:'tool', content:[{type:'text',text}], isError, ... } }
//    —— `isError` 在 **message 里面**，不在 data 顶层。第一版探针写成
//    `e.data?.isError ?? e.data?.error !== undefined`，字段缺失时求值成 false，
//    于是把「qq-chat-v2 被正确拒绝」误报成「群聊也能拿到手机控制权」，
//    差点去改一个本来就对的守卫。现在一律留原文 + 匹配拒绝话术。
import { randomUUID } from 'node:crypto';
import { probeCookie, probeRpc, probeMuxSocket, probeWorkspaceDir } from './probe-auth.mjs';

const PRESET = process.argv[2] || 'qq-owner';
const cookie = probeCookie();
const rpc = probeRpc(cookie);

const dir = probeWorkspaceDir('owner-phone');
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
          content: [{ type: 'text', text: '调用 mcp__phone-adb__phone_status 工具一次（不要传参数），然后只回复：完成' }],
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
    // 结果事件**原样留档**：`isError` 的字段名在不同 DSH 版本里变过，靠猜字段会得到
    // 「字段缺失 → 默认 false」的假阴性（第一版探针就是这么误判 qq-chat-v2 通过了的）。
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

const calledPhone = toolCalls.some((c) => String(c.name).startsWith('mcp__phone-adb__'));
// 判「被守卫拒绝」用结果正文里的拒绝话术，不依赖 isError 字段名。
const DENY_MARK = /不在(主人私聊|QQ 桥接)白名单内|已拒绝/;
const phoneDenied = toolResults.some((r) => DENY_MARK.test(r.raw));
const phoneErrored = toolResults.some((r) => /"isError":true/.test(r.raw));
const calledLocal = toolCalls.some((c) => /^(pwsh|bash|shell|write|edit|read|glob|grep|run_command)$/.test(String(c.name)));

console.log('\n判定:');
console.log(`  手机工具可调用            : ${calledPhone ? '✅' : '❌ 未观测到 mcp__phone-adb__ 调用'}`);
console.log(`  被守卫拒绝                : ${phoneDenied ? '⛔ 是（预期：群聊 preset 必须拒绝）' : '否'}`);
console.log(`  结果带 isError            : ${phoneErrored ? '是' : '否'}`);
console.log(`  未调用本地危险工具        : ${calledLocal ? '❌ 出现了本地工具调用' : '✅'}`);

try { socket.close(); } catch {}
await rpc('workspace/archiveSession', { request: { sessionId } });
console.log('[cleanup] archived');
process.exit(calledPhone && !phoneDenied && !calledLocal ? 0 : 1);
