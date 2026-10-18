#!/usr/bin/env node
// 开关：把第二个 QQ 号（3901900049 / snowluma2）的两套 MCP 从 DSH profile 里停用或启用。
//
// 为什么需要：两套 QQ MCP 都注册在同一个 profile 里，**每轮提示词都要带上两份工具说明**
// （snowluma 32 个工具约 6360 字、snowluma2 34 个约 6646 字 ≈ 5k token）。DSH 的
// tools.restrict 只能遮「全局工具」，MCP 是 preset 作用域注册的，遮不掉 —— 所以第二个号
// 停用期间，唯一省下这份 token 的办法就是让它别注册。
//
// 实现方式：给两个 insert 块里的 entry 加 `disabled: true`（**不是**注释掉整段）。
// 为什么不用注释：① 注释掉等于删条目，任何人用 yaml.dump 重写一遍（比如 setup-dsh.mjs
// 的 patchCordis）注释就没了，块会原样复活；② `disabled` 是 DSH 自己的字段，和
// mcp-phone-adb 现在用的完全是同一个机制，语义清楚、YAML 往返也保得住。
// ⚠️ 但 setup-dsh.mjs 会把这几个块**整段重建**（MANAGED_MCP_IDS），重建后 disabled 会丢
//    —— 同 mcp-phone-adb 区块里的警告。跑过 setup 之后要重新执行一次 --off。
//
// 用法：
//   node scripts/toggle-snowluma2.mjs --status   # 看当前是开还是关（默认）
//   node scripts/toggle-snowluma2.mjs --off      # 停用（省 ~5k token/轮，第二个号暂时用不了）
//   node scripts/toggle-snowluma2.mjs --on       # 启用
//
// 改完必须**重启 DSH**（profile 配置只在启动时合成），重启桥接没用。
// 每次写入前都会备份成 cordis.patch.yml.bak-snowluma2-<时间戳>。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = path.join(os.homedir(), '.dsh', 'profiles', 'tauri', 'cordis.patch.yml');
const IDS = ['mcp-snowluma-2', 'mcp-snowluma-host-2'];
const DISABLED_RE = /^\s+disabled:\s*true\s*$/;

const arg = process.argv[2] || '--status';

function readLines() {
  return fs.readFileSync(FILE, 'utf8').split('\n');
}

/** 找出含指定 id 的 `- insert:` 块：从该块起始行到下一个顶格 `- ` 之前。 */
function findBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^-\s/.test(line)) continue; // 只认顶格的列表项
    let end = i + 1;
    while (end < lines.length && !/^-\s/.test(lines[end])) end += 1;
    const chunk = lines.slice(i, end).join('\n');
    if (IDS.some((id) => new RegExp(`id:\\s*${id}\\b`).test(chunk))) {
      blocks.push({ start: i, end });
    }
    i = end - 1;
  }
  return blocks;
}

/** 块内 `- id: <目标 id>` 那一行的下标，以及它同级键的缩进。 */
function idLineOf(lines, block) {
  for (let i = block.start; i < block.end; i += 1) {
    const m = /^(\s*)-\s+id:\s*(\S+)\s*$/.exec(lines[i]);
    if (m && IDS.includes(m[2])) return { index: i, indent: `${m[1]}  ` };
  }
  return null;
}

function status(lines) {
  const blocks = findBlocks(lines);
  let off = 0;
  for (const b of blocks) {
    for (let i = b.start; i < b.end; i += 1) {
      if (DISABLED_RE.test(lines[i])) { off += 1; break; }
    }
  }
  return { blocks: blocks.length, off };
}

function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`找不到 profile 配置：${FILE}`);
    process.exit(1);
  }
  const lines = readLines();
  const st = status(lines);

  if (arg === '--status') {
    console.log(`文件：${FILE}`);
    console.log(`找到 ${st.blocks} 个 snowluma2 MCP 块，其中 ${st.off} 个已停用。`);
    console.log(st.off === st.blocks && st.blocks > 0
      ? '当前状态：已停用（第二个号不可用，省约 5k token/轮）'
      : st.off > 0 ? '当前状态：只停用了一部分（配置不一致，建议 --off 再确认）' : '当前状态：已注册（两套 MCP 都在工具清单里）');
    return;
  }

  if (arg !== '--off' && arg !== '--on') {
    console.error('用法：--status | --off | --on');
    process.exit(1);
  }
  if (st.blocks === 0) {
    console.error('没找到目标块（id 不是 mcp-snowluma-2 / mcp-snowluma-host-2？配置结构可能变了，先人工确认）');
    process.exit(1);
  }

  // 从后往前改，避免插入/删除行导致前面的下标失效。
  const out = [...lines];
  const blocks = findBlocks(lines).reverse();
  let changed = 0;
  for (const b of blocks) {
    const at = idLineOf(out, b);
    if (!at) continue;
    const existing = [];
    for (let i = b.start; i < b.end; i += 1) if (DISABLED_RE.test(out[i])) existing.push(i);
    if (arg === '--off') {
      if (existing.length) continue;
      out.splice(at.index + 1, 0, `${at.indent}disabled: true`);
      changed += 1;
    } else {
      if (!existing.length) continue;
      for (const i of existing.reverse()) out.splice(i, 1);
      changed += 1;
    }
  }

  if (!changed) {
    console.log(`没有需要改动的地方（已经是${arg === '--off' ? '停用' : '启用'}状态）。`);
    return;
  }

  const bak = `${FILE}.bak-snowluma2-${Date.now()}`;
  fs.copyFileSync(FILE, bak);
  fs.writeFileSync(FILE, out.join('\n'), 'utf8');

  const after = status(readLines());
  console.log(`${arg === '--off' ? '已停用' : '已启用'}：${after.blocks} 个块，${after.off} 个处于停用状态。`);
  console.log(`备份：${bak}`);
  console.log('下一步：重启 DSH 才会生效（profile 配置只在启动时合成），重启桥接没用。');
}

main();
