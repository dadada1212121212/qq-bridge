// 一次性探针：确认 qq-owner 这个「派生 preset」真的进了 DSH 的注册表。
//
// 背景：qq-owner 不是独立目录，而是构建期由 qq-chat-v2 派生（只差守卫行 + persona 追加段），
// 写进 plugins/qq-agent-presets/presets/qq-owner.patch.yml。桥接在主人私聊里按 id 找它：
// 找不到就 fail-closed 回退到普通 preset（主人暂时无法操作手机），只留一行日志。
// 所以「装上了没有」必须问运行中的 DSH，不能只看文件在不在。
//
// 用法：node scripts/probe-owner-preset.mjs [baseUrl]
import { discoverDshSessionCookie } from '../src/dsh-client.js';

const BASE = process.argv[2] || process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';

async function rpc(cookie, method, args = {}) {
  const rpcId = `probe-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (res.status !== 200 || (body && body.error)) {
    throw new Error(`${method} 失败：HTTP ${res.status} ${body?.error?.message ?? text.slice(0, 300)}`);
  }
  return body?.result?.value;
}

const cookie = discoverDshSessionCookie(BASE);
if (!cookie) {
  console.error('拿不到 DSH 会话 Cookie');
  process.exitCode = 2;
} else {
  const value = await rpc(cookie, 'agentPresets/list');
  const presets = value?.presets ?? [];
  console.log('agentPresets/list →');
  for (const p of presets) {
    console.log(`  · ${p.id}${p.broken ? `   ⚠️ broken: ${p.broken}` : ''}${p.name ? `   (${p.name})` : ''}`);
  }
  const ids = presets.map((p) => p.id);
  for (const id of ['qq-chat', 'qq-chat-v2', 'qq-owner']) {
    console.log(`${ids.includes(id) ? '✅' : '❌'} ${id}`);
  }
  const owner = presets.find((p) => p.id === 'qq-owner');
  if (owner) {
    const doc = await rpc(cookie, 'agentPresets/read', { agentPreset: 'qq-owner' });
    const text = String(doc?.content ?? '');
    console.log('--- qq-owner 子行 ---');
    for (const line of text.split('\n')) {
      if (/^\s*- id:/.test(line)) console.log('  ' + line.trim());
    }
    console.log(`守卫行是主人版: ${text.includes('qq-tool-restrict-owner')}`);
    console.log(`含手机用法说明: ${text.includes('phone-adb') || text.includes('phone_')}`);
  }
}
