// Execute both real preset plugins against a captured tools service, without DSH/QQ.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
// 2026-10-12：多了一个 qq-owner（主人私聊专用）。它挂的是主人版守卫，**多放行**手机工具；
// 严格版必须继续拒绝手机工具——这条差异就是"群聊拿不到手机控制权"的全部依据，
// 所以两边都在这里断言，而不是只测一边。
const GUARD_CASES = [
  { preset: 'qq-chat', file: 'qq-tool-restrict.mjs', phoneAllowed: false },
  { preset: 'qq-chat-v2', file: 'qq-tool-restrict.mjs', phoneAllowed: false },
  { preset: 'qq-owner', file: 'qq-tool-restrict-owner.mjs', phoneAllowed: true },
];
for (const { preset, file, phoneAllowed } of GUARD_CASES) {
  const { apply } = await import(pathToFileURL(path.join(root, 'dsh/agent-presets', preset, file)).href);
  let guard;
  const restricted = [];
  apply({ tools: {
    restrict: ({ deny }) => restricted.push(...deny),
    guard: (callback) => { guard = callback; },
  } });
  assert.equal(typeof guard, 'function');
  assert.ok(restricted.includes('dev_install_package'));
  for (const name of ['ask_user_question', 'todo_write', 'mcp__snowluma__qq_send_message',
    'mcp__snowluma-host__snowluma_status', 'mcp__web-search-safe__web_fetch']) {
    assert.equal(guard({ name }), undefined, `${preset}: expected allowed ${name}`);
  }
  const PHONE_TOOLS = ['mcp__phone-adb__phone_tap', 'mcp__phone-adb__phone_type',
    'mcp__phone-adb__phone_look', 'mcp__phone-adb__phone_screen', 'mcp__phone-adb__phone_connect'];
  if (phoneAllowed) {
    for (const name of PHONE_TOOLS) {
      assert.equal(guard({ name }), undefined, `${preset}: 主人版应放行 ${name}`);
    }
  } else {
    for (const name of PHONE_TOOLS) {
      assert.equal(typeof guard({ name }), 'string',
        `${preset}: 严格版必须拒绝 ${name}（否则群聊能操作手机）`);
    }
  }
  for (const name of ['web_fetch', 'web_search', 'bash', 'read_file', 'dev_future_tool',
    'mcp__untrusted__web_fetch', '', null, undefined]) {
    try { assert.equal(typeof guard({ name }), 'string', `${preset}: must reject ${String(name)}`); }
    catch (error) { failures++; console.error(`FAIL ${error.message}`); }
  }
  // 2026-10-19：被拒的本机/宿主工具必须拿到「讲清楚为什么用不了」的专门理由，
  // 不能再丢回那句泛泛的「不在白名单内」——模型会以为是自己名字写错了，换个写法反复重试。
  // 起因是一次真实的 `tool=pwsh` 调用（harness 日志里的审批事件）。
  for (const name of ['pwsh', 'bash', 'read', 'write', 'edit', 'glob', 'grep', 'run_code', 'subagent']) {
    try {
      const reason = guard({ name });
      assert.equal(typeof reason, 'string', `${preset}: 必须拒绝本机工具 ${name}`);
      assert.ok(reason.includes('别再试'), `${preset}: ${name} 的拒绝理由必须叫它别再试（现在是：${reason}）`);
      assert.ok(reason.includes(name), `${preset}: ${name} 的拒绝理由必须点名这个工具`);
      assert.ok(!reason.includes('不在'), `${preset}: ${name} 不该再收到泛泛的「不在白名单内」`);
    } catch (error) { failures++; console.error(`FAIL ${error.message}`); }
  }
  for (const name of ['web_search', 'web_fetch', 'advanced_search']) {
    try {
      const reason = guard({ name });
      assert.equal(typeof reason, 'string', `${preset}: 必须拒绝宿主搜索 ${name}`);
      assert.ok(reason.includes('mcp__web-search-safe__web_search'),
        `${preset}: ${name} 的拒绝理由必须指出正路是 mcp__web-search-safe__web_search（现在是：${reason}）`);
    } catch (error) { failures++; console.error(`FAIL ${error.message}`); }
  }
  console.log(`${preset}: 放行项/拒绝项核对通过（手机工具${phoneAllowed ? '已放行' : '已拒绝'}）`);
}
// ── state/ 权限收紧（Windows 上 mode 0o600 是空操作，必须动 ACL）的离线守卫 ──────────
// 这里只做"结构 + 编码"级断言：真正的 icacls/UAC 行为在这个环境里跑不了（沙箱禁止改 ACL），
// 而**假装测过**比不测更危险，所以明确只钉住下面这些不会骗人的事实。
import fs from 'node:fs';
{
  const helperPath = path.join(root, 'scripts/harden-state-acl.mjs');
  assert.ok(fs.existsSync(helperPath), 'ACL 收紧助手必须存在（start.bat 依赖它）');
  const helper = fs.readFileSync(helperPath, 'utf8');
  for (const needle of ['icacls', '/inheritance:r', '--elevated', 'isHardened', 'process.exit(0)']) {
    assert.ok(helper.includes(needle), `ACL 助手应包含 ${needle}`);
  }
  // 失败必须降级为非阻断：任何一条 sayAlways/console.log 之后都不得以非 0 退出。
  assert.ok(!/process\.exit\([1-9]/.test(helper), 'ACL 助手不得以非 0 退出码结束（否则会阻断启动）');
  // 提权递归防护：被自己拉起的那一次必须跳过提权重试。
  assert.ok(/!isElevatedRun/.test(helper), '提权重试必须被 --elevated 标记短路，防止递归');

  const bat = fs.readFileSync(path.join(root, 'start.bat'));
  const batText = bat.toString('latin1');
  const nonAscii = [...bat].filter((b) => b > 127).length;
  assert.equal(nonAscii, 0, 'start.bat 必须保持纯 ASCII（否则非 UTF-8 控制台会乱码）');
  assert.equal(batText.match(/(?<!\r)\n/g)?.length ?? 0, 0, 'start.bat 必须使用 CRLF');
  assert.ok(batText.includes('harden-state-acl.mjs'), 'start.bat 必须在启动桥接前调用 ACL 助手');
  // 助手必须排在 node src/bridge.js 之前，否则"启动时收紧"就不成立
  assert.ok(batText.indexOf('harden-state-acl.mjs') < batText.indexOf('node src/bridge.js'), 'ACL 助手必须先于桥接启动');
  console.log('state ACL hardening: helper is non-blocking, recursion-guarded, and wired into start.bat');
}

// ── 合规不变量 L6：本程序**只探测、不部署** SnowLuma ────────────────────────────────
// 依据：SnowLuma EULA §5.4（中文为准）
//   「除事先取得著作权人的书面授权外……不得复制、修改、单独再分发或再许可该组件。
//     将其并入第三方安装包或 Docker 镜像、**通过自动化脚本部署**，或者将其用于任何商业用途，
//     均须事先取得书面授权。」
// 2026-09-20：`start_snowluma` / `stop_snowluma` 与 `snowluma.allowProcessControl` 已整体移除。
// 这条测试**防止它们（或同类能力）被无意加回来**——本项目唯一一条"删掉的功能不许复活"的约束。
{
  const host = fs.readFileSync(path.join(root, 'src/mcp-host-server.js'), 'utf8');
  // ① 代码里不得再出现进程启停原语（注释中为记录原因可以提，故先剔掉纯注释行）
  const code = host.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  for (const bad of ['spawn(', 'taskkill', 'execFileSync', 'child_process']) {
    assert.ok(!code.includes(bad), `mcp-host-server.js 不得再出现「${bad}」（违反 EULA §5.4 的 L6 不变量）`);
  }
  // ② 不得再注册这两个工具
  for (const tool of ['start_snowluma', 'stop_snowluma']) {
    assert.ok(!host.includes(`'${tool}'`), `不得再注册 ${tool}（EULA §5.4）`);
  }
  // ③ 配置项不得复活（代码与模板两侧都查）
  assert.ok(!code.includes('allowProcessControl'), 'mcp-host-server.js 不得再读取 allowProcessControl');
  const example = fs.readFileSync(path.join(root, 'config.example.json'), 'utf8');
  assert.ok(!example.includes('allowProcessControl'), 'config.example.json 不得再提供 allowProcessControl');
  // ④ 只读工具必须还在（别把整个 server 删空）
  assert.ok(host.includes("'snowluma_status'"), 'snowluma_status（只读探活）必须保留');
  // ⑤ 包元数据必须声明许可证（独立复核发现此前缺失）
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'MIT', 'package.json 必须声明 license 字段');
  // ⑥ 本机执行面的唯一入口：梗图渲染（qq_make_meme）要起一次本地 PowerShell，这跟 SnowLuma
  //    的部署/生命周期毫无关系，所以那几行必须待在 src/meme-render.mjs —— 不是搬回这个文件里。
  //    2026-10-12 的由来：渲染曾经写在 mcp-host-server.js 里，于是上面 ① 的断言红了
  //    （「不得再出现 spawn(」），当时的选择是把执行面拆到独立模块，而不是放宽这条断言。
  //    这两条断言让「渲染坏了」和「进程控制复活了」两种回归都能被抓到。
  const memeRender = fs.readFileSync(path.join(root, 'src/meme-render.mjs'), 'utf8');
  assert.ok(memeRender.includes('spawn('), 'src/meme-render.mjs 必须仍是唯一的本机起进程入口');
  assert.ok(host.includes("from './meme-render.mjs'"),
    'mcp-host-server.js 必须从 ./meme-render.mjs 取渲染能力（别把起进程的代码搬回来）');
  console.log('L6 compliance: no SnowLuma process control, no allowProcessControl, license declared, 本机执行面只在 meme-render.mjs');
}

process.exitCode = failures ? 1 : 0;
