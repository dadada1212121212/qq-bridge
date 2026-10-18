// 模拟 DSH 的 dsh-mcp-client：以 stdio 拉起桥接的 MCP server，握手并列出工具，
// 验证各 MCP server 在新版 DSH 环境下仍能被正常接入（不需要 SnowLuma 在线）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

// phone-adb 用 Python 跑（零依赖、直接 import phone.py，见该文件头部的取舍说明），
// 所以这一条是 command+args 的**异构**条目，不是 Node 脚本。
const PHONE_ADB_DIR = process.env.PHONE_ADB_DIR || path.resolve(ROOT, '..', 'phone-adb');

/** 找一个能跑 mcp_phone_adb.py 的 Python；找不到就跳过这一条而不是整体失败。 */
function findPython() {
  const cands = [
    process.env.PHONE_ADB_PYTHON,
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
    'C:\\Python313\\python.exe', '/usr/bin/python3',
  ];
  return cands.find((c) => c && fs.existsSync(c)) || '';
}

const PYTHON = findPython();
const PHONE_SCRIPT = path.join(PHONE_ADB_DIR, 'mcp_phone_adb.py');

const SERVERS = [
  { serverName: 'snowluma', command: NODE, args: [path.join(ROOT, 'src/mcp-snowluma-safe.js')] },
  { serverName: 'snowluma-host', command: NODE, args: [path.join(ROOT, 'src/mcp-host-server.js')] },
  { serverName: 'web-search-safe', command: NODE, args: [path.join(ROOT, 'src/mcp-web-search-safe.js')] },
  ...(PYTHON && fs.existsSync(PHONE_SCRIPT)
    ? [{ serverName: 'phone-adb', command: PYTHON, args: [PHONE_SCRIPT], cwd: PHONE_ADB_DIR }]
    : []),
];

if (!PYTHON || !fs.existsSync(PHONE_SCRIPT)) {
  console.log(`⚠️ 跳过 phone-adb：${!PYTHON ? '找不到 Python' : `找不到 ${PHONE_SCRIPT}`}`
    + '（可用 PHONE_ADB_PYTHON / PHONE_ADB_DIR 指定）');
}

let failures = 0;
for (const { serverName, command, args, cwd } of SERVERS) {
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: cwd ?? ROOT,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'dsh-mcp-probe', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.log(`✅ ${serverName}: ${names.length} tools`);
    console.log(`   ${names.join(', ')}`);
    // 校验 DSH 的命名契约：mcp__<serverName>__<rawName>
    const bad = names.filter((n) => !/^[A-Za-z0-9_-]{1,64}$/.test(n));
    if (bad.length) { console.log(`   ⚠️ 不符合 DSH 工具名契约: ${bad.join(', ')}`); failures += 1; }
  } catch (error) {
    console.log(`❌ ${serverName}: ${error?.message ?? error}`);
    failures += 1;
  } finally {
    try { await client.close(); } catch {}
  }
}
console.log(failures === 0 ? '\n全部 MCP server 接入正常' : `\n${failures} 个 MCP server 异常`);
process.exit(failures === 0 ? 0 : 1);
