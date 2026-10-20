// 「模型漏填 key」自愈的回归测试（2026-10-20 事故）。
//
// 事故经过：PTC 模式下模型第一笔 qq_send_message 只写了 token、没写 key，MCP 的 zod 在
// handler 之前就抛 `-32602 expected string, received undefined at key`，桥接那套按令牌
// 反查的自愈根本没机会跑；她去调 qq_get_prompt 求救同样被拒（救命工具也要 key），最后靠
// `const names = ["agentToken",...]` 暴力试了 7 次才摸到 key，首轮 9 次调用全花在这上面。
//
// 这里钉三件事：
//   1) 带 key 的工具，schema 里 key 必须是 optional —— 否则 zod 会先毙掉，写多少逻辑都白搭；
//   2) 只传 token 时不能再报 zod 的 `received undefined at key`，要给一句能照着做的提示；
//   3) token 仍是必填（安全边界没被顺手放松）。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const entry = fileURLToPath(new URL('../src/mcp-snowluma-safe.js', import.meta.url))
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] })
const client = new Client({ name: 'bridge-key-selfheal-test', version: '0.1.0' })

let pass = 0
const ok = (cond, label, detail) => {
  assert.ok(cond, label + (detail === undefined ? '' : ' → ' + JSON.stringify(detail)))
  pass += 1
  console.log('  ✓ ' + label)
}

try {
  await client.connect(transport)
  const { tools } = await client.listTools()
  const byName = new Map(tools.map((t) => [t.name, t]))

  console.log('\n[1] schema：key 可省，token 仍必填')
  const send = byName.get('qq_send_message')
  ok(!!send, 'qq_send_message 已注册')
  const required = send.inputSchema?.required ?? []
  const props = send.inputSchema?.properties ?? {}
  ok(!!props.key, 'schema 里仍有 key 字段')
  ok(!required.includes('key'), 'key 不在 required 里（可省略）', required)
  ok(required.includes('token'), 'token 仍在 required 里（安全边界没放松）', required)
  ok(/可以省略/.test(props.key?.description ?? ''), 'key 的描述写明了可以省略', props.key?.description)

  // 所有带 key 的工具都必须允许省略，否则下次又会在某个冷门工具上踩同一个坑。
  const stillRequired = tools
    .filter((t) => (t.inputSchema?.properties ?? {}).key && (t.inputSchema?.required ?? []).includes('key'))
    .map((t) => t.name)
  ok(stillRequired.length === 0, '没有任何工具还把 key 标成必填', stillRequired)

  console.log('\n[2] 只传 token：给的是「该怎么办」，不是 zod 的天书')
  const noKey = await client.callTool({
    name: 'qq_send_message',
    arguments: { token: '0'.repeat(48), messages: '自愈测试，不该真的发出去' }
  })
  const text = noKey.content?.[0]?.text ?? ''
  ok(noKey.isError === true, '缺 key 且反查失败时返回 isError', text.slice(0, 120))
  ok(!/received undefined at key/i.test(text), '不再抛 zod 的 expected string, received undefined at key', text.slice(0, 200))
  ok(/缺少会话 key/.test(text), '提示里明说了缺什么', text.slice(0, 120))
  ok(/private:3796180411|group:群号/.test(text) && /48 位十六进制/.test(text), '提示里给了 key 与 token 的形状', text.slice(0, 200))

  console.log('\n[3] 同样不传 key 的读工具走同一条路')
  const promptRes = await client.callTool({ name: 'qq_get_prompt', arguments: { token: '0'.repeat(48) } })
  const ptext = promptRes.content?.[0]?.text ?? ''
  ok(!/received undefined at key/i.test(ptext), 'qq_get_prompt 也不再报 zod 参数错', ptext.slice(0, 200))
  ok(/缺少会话 key/.test(ptext) || /失败/.test(ptext), 'qq_get_prompt 给出可读的失败原因', ptext.slice(0, 120))

  console.log(`\n✅ 全部 ${pass} 条断言通过`)
} finally {
  await client.close()
}
