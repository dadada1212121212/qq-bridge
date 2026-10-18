// 钉住 DSH 0.1.7 preset 装配的「防漂移」契约（纯离线，不需要 DSH 在跑）：
//   1. bundle patch（plugins/qq-agent-presets/presets/*.patch.yml）与仓库权威源逐字一致；
//   2. patch 的形状符合新机制：insert 一条 @deepseek-ai/dsh-agent-preset 行，
//      config 里带 id/name/description/order/plugins；
//   3. 守卫行只能用「从 profile 目录可解析」的引用方式（裸说明符），
//      不允许任何相对/绝对路径子行名 —— 那正是 0.1.7 下静默装不上的坑；
//   4. **安全边界**：严格白名单（群聊）与主人白名单（qq-owner）一份实现、两个入口，
//      且手机工具 mcp__phone-adb__ **只能**落在主人那一份里。
//
// 2026-10-12 起多了 qq-owner（派生 preset）。它不由人写 agent.cordis.yml，
// 而是由 build-agent-preset-patches.mjs 从 qq-chat-v2 现算——所以这里对它的断言
// 是「只有两处差异」，而不是「与某个源文件逐字相同」（派生本来就不该有第二份源）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import {
  BUNDLE_DIR, DERIVED_PRESET_INFO, GUARD_SPECIFIER, GUARD_SPECIFIER_BY_PRESET, PRESETS, REPO_ROOT,
  buildPatches, patchFileFor, presetRowId,
} from './build-agent-preset-patches.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}

const read = (p) => fs.readFileSync(p, 'utf8');
const load = (p) => yaml.load(read(p));

console.log('## 1. 产物与源不漂移（--check 语义）');
{
  const results = buildPatches({ check: true, log: () => {} });
  for (const { file, changed } of results) {
    ok(!changed, `${path.relative(REPO_ROOT, file)} 与源一致（不一致请跑 node scripts/build-agent-preset-patches.mjs）`);
  }
}

console.log('## 2. patch 形状符合 DSH 0.1.7 的 preset 机制');
for (const name of PRESETS) {
  const file = patchFileFor(name);
  ok(fs.existsSync(file), `${path.relative(REPO_ROOT, file)} 存在`);
  const doc = load(file);
  ok(Array.isArray(doc) && doc.length === 1 && Array.isArray(doc[0]?.insert), `${name}: 顶层是 [ { insert: [...] } ]`);
  const row = doc[0].insert[0];
  ok(row.id === presetRowId(name), `${name}: 行 id = ${presetRowId(name)}（非 preset 名，便于按行定位）`);
  ok(row.name === '@deepseek-ai/dsh-agent-preset', `${name}: 行 name = @deepseek-ai/dsh-agent-preset`);
  ok(row.config?.id === name, `${name}: config.id = ${name}（桥接按这个 id 解析 preset）`);
  ok(Array.isArray(row.config.plugins) && row.config.plugins.length > 0, `${name}: config.plugins 非空（新机制里必填）`);

  const derived = DERIVED_PRESET_INFO[name];
  const baseName = derived ? derived.from : name;

  const meta = derived ? derived.meta : load(path.join(REPO_ROOT, 'dsh', 'agent-presets', name, 'preset.yml'));
  ok(row.config.name === meta.name && row.config.description === meta.description && row.config.order === meta.order,
    `${name}: ${derived ? '派生声明' : 'preset.yml'} 的 name/description/order 原样带进 config`);

  const source = load(path.join(REPO_ROOT, 'dsh', 'agent-presets', baseName, 'agent.cordis.yml'));

  if (!derived) {
    // 与源行列表逐字对比：只允许守卫行的 name 被改写。
    const expected = structuredClone(source);
    for (const r of expected) if (r.name === './qq-tool-restrict.mjs') r.name = GUARD_SPECIFIER;
    assert.deepEqual(row.config.plugins, expected, `${name}: config.plugins 必须与 agent.cordis.yml 完全一致（守卫名除外）`);
    ok(true, `${name}: config.plugins 与 agent.cordis.yml 逐字一致（${expected.length} 行）`);

    // 人格正文是产品本体：单独再钉一次，防止「顺手改写/截断」。
    const srcPersona = source.find((r) => r.id === 'persona');
    const patchPersona = row.config.plugins.find((r) => r.id === 'persona');
    ok(typeof srcPersona?.config?.prefix === 'string' && srcPersona.config.prefix === patchPersona?.config?.prefix,
      `${name}: persona.prefix 逐字一致（${srcPersona?.config?.prefix?.length ?? 0} 字符）`);
  } else {
    // 派生 preset：断言「差异只发生在声明过的地方」——守卫行、persona 追加、
    // （可选）persona 里的工具名改写。用「除这些外全部深相等」表达，
    // 比在测试里重算一遍派生结果更抗改。
    const patchRows = row.config.plugins;
    ok(patchRows.map((r) => r.id).join(',') === source.map((r) => r.id).join(','),
      `${name}: 行 id 与基座 ${baseName} 完全一致且同序（${patchRows.length} 行）`);

    const changed = [];
    for (const r of patchRows) {
      if (r.id === 'persona' || r.id === 'qq-tool-restrict') continue;
      const b = source.find((x) => x.id === r.id);
      if (JSON.stringify(b) !== JSON.stringify(r)) changed.push(r.id);
    }
    ok(changed.length === 0,
      `${name}: 除 persona 与守卫外每行与基座 ${baseName} 逐字相同${changed.length ? `（被改动：${changed.join(', ')}）` : ''}`);

    const g = patchRows.find((r) => r.id === 'qq-tool-restrict');
    ok(g?.name === derived.guardSpecifier, `${name}: 守卫行指向 ${derived.guardSpecifier}`);

    const basePrefix = source.find((r) => r.id === 'persona').config.prefix;
    const derivedPrefix = patchRows.find((r) => r.id === 'persona').config.prefix;
    // 期望值 = 基座前缀按声明的 prefixRewrites 做同一套字面替换（没有改写时就是基座本身）。
    let expectedPrefix = basePrefix;
    for (const [from, to] of derived.prefixRewrites) expectedPrefix = expectedPrefix.split(from).join(to);
    ok(derivedPrefix.startsWith(expectedPrefix),
      `${name}: persona 前缀完整继承基座（${basePrefix.length} 字符，未截断${derived.prefixRewrites.length ? '；工具名按 prefixRewrites 改写' : ''}）`);
    if (derived.prefixRewrites.length > 0) {
      // 第二个 QQ 号的工具名必须**全部**换掉。留一个 mcp__snowluma__ 她就会照着提示词
      // 去调**另一个账号**的 MCP（两套 MCP 在同一个 profile 里都注册着）。
      const stale = ['mcp__snowluma__', 'mcp__snowluma-host__'].filter((needle) => derivedPrefix.includes(needle));
      ok(stale.length === 0,
        `${name}: persona 前缀里不再出现老号那套工具名${stale.length ? `；残留：${stale.join(', ')}` : ''}`);
    }
    ok(derivedPrefix.endsWith(derived.prefixAppendText),
      `${name}: persona 末尾追加了声明的那段（+${derived.prefixAppendText.length} 字符）`);
    if (name === 'qq-owner') {
      // 追加段必须真的说清了「怎么用 + 绝不能做什么」，不是空壳。
      for (const needle of ['phone_state', 'phone_screen', 'phone_tap_text', 'phone_look',
        '绝对不要在群里提手机', '会花钱', '你没有这些工具']) {
        ok(derivedPrefix.includes(needle), `${name}: 手机说明段包含「${needle}」`);
      }
    }
  }
}

console.log('## 3. 守卫行引用方式：只用「profile 目录可解析」的裸说明符');
for (const name of PRESETS) {
  const row = load(patchFileFor(name))[0].insert[0];
  const specifier = GUARD_SPECIFIER_BY_PRESET[name];
  const guard = row.config.plugins.find((r) => r.id === 'qq-tool-restrict');
  ok(guard !== undefined, `${name}: 有 qq-tool-restrict 守卫行`);
  ok(guard?.name === specifier, `${name}: 守卫行 name = ${specifier}`);
  const bad = row.config.plugins.filter((r) => typeof r.name === 'string' && (r.name.startsWith('.') || path.isAbsolute(r.name)));
  ok(bad.length === 0, `${name}: 没有任何相对/绝对路径子行名（0.1.7 下会按 profile 目录解析而装不上）${bad.length ? `：${bad.map((r) => r.name).join(', ')}` : ''}`);
  const guardFile = path.join(BUNDLE_DIR, specifier.slice('qq-agent-presets/'.length));
  ok(fs.existsSync(guardFile), `${name}: 守卫实现存在（${path.relative(REPO_ROOT, guardFile)}）`);
}

console.log('## 4. bundle 声明与安全边界');
{
  const pkg = JSON.parse(read(path.join(BUNDLE_DIR, 'package.json')));
  const patches = pkg.dsh?.bundle?.patch;
  ok(Array.isArray(patches), 'qq-agent-presets 的 dsh.bundle.patch 是数组（一个 bundle 可带多层 patch）');
  for (const name of PRESETS) {
    const declared = `./presets/${name}.patch.yml`;
    ok(patches?.includes(declared), `bundle 列出了 ${declared}`);
    ok(fs.existsSync(path.join(BUNDLE_DIR, declared)), `${declared} 存在`);
  }

  const canonical = path.join(BUNDLE_DIR, 'qq-tool-restrict.mjs');
  const canonicalText = read(canonical);
  for (const needle of ["const SAFE_PREFIXES", "'mcp__snowluma__'", "'mcp__web-search-safe__'",
    'SAFE_EXACT', 'return `工具 ', 'export function installGuard']) {
    ok(canonicalText.includes(needle), `权威守卫包含 ${needle}`);
  }

  // 手机前缀**绝不能**出现在共享白名单数组里（它只该在 OWNER_EXTRA_PREFIXES）。
  const fromSafe = canonicalText.indexOf('const SAFE_PREFIXES');
  const safeBlock = canonicalText.slice(fromSafe, canonicalText.indexOf(']', fromSafe));
  ok(!safeBlock.includes('mcp__phone-adb__'),
    'SAFE_PREFIXES（群聊共享的那份）不含 mcp__phone-adb__');

  const canonicalMod = await import(pathToFileURL(canonical).href);
  const ownerPath = path.join(BUNDLE_DIR, 'qq-tool-restrict-owner.mjs');
  const ownerMod = await import(pathToFileURL(ownerPath).href);
  const fishPath = path.join(BUNDLE_DIR, 'qq-tool-restrict-fish.mjs');
  const fishMod = await import(pathToFileURL(fishPath).href);

  // 一份实现：preset 目录下的壳必须是 re-export，且导出同一个 apply。
  const SHIMS = {
    'qq-chat': ['qq-tool-restrict.mjs', canonicalMod],
    'qq-chat-v2': ['qq-tool-restrict.mjs', canonicalMod],
    'qq-owner': ['qq-tool-restrict-owner.mjs', ownerMod],
    'qq-chat-v2-fish': ['qq-tool-restrict-fish.mjs', fishMod],
  };
  for (const name of PRESETS) {
    const [fileName, mod] = SHIMS[name];
    const shim = path.join(REPO_ROOT, 'dsh', 'agent-presets', name, fileName);
    ok(fs.existsSync(shim), `${name}/${fileName} 存在（按老路径读文件的脚本仍能工作）`);
    const text = read(shim);
    ok(text.includes(`export * from`) && text.includes(`/plugins/qq-agent-presets/${fileName}'`),
      `${name}/${fileName} 是指向唯一实现的 re-export 壳`);
    const shimMod = await import(pathToFileURL(shim).href);
    assert.equal(shimMod.apply, mod.apply, `${name}: 壳与实现在同一模块实例上`);
    assert.deepEqual(shimMod.inject, ['tools']);
  }
  assert.equal(canonicalMod.name, 'qq-tool-restrict');
  assert.equal(ownerMod.name, 'qq-tool-restrict-owner');
  assert.equal(fishMod.name, 'qq-tool-restrict-fish');
  ok(true, 're-export 壳与权威实现导出同一份 apply/inject');

  // ── 严格白名单（群聊 / 仿真会话用）────────────────────────────────────────
  let guardFn;
  const restricted = [];
  canonicalMod.apply({ tools: { restrict: ({ deny }) => restricted.push(...deny), guard: (fn) => { guardFn = fn; } } });
  ok(restricted.includes('pwsh') && restricted.includes('dev_install_package'), 'restrict 名单含本地执行面与开发注入器工具');
  // 2026-10-15：注册期也要遮手机面。此前这里只断言执行期，导致 phone_lan（7,805B）
  // 与 20 个 mcp__phone-adb__*（≈4.4KB）一直留在群聊会话的 schema 里（活会话
  // request/header 实测可见）⇒ L7 在注册期是破的，且模型会为一个"看起来能用"的
  // 工具反复编参数、白烧 token。
  const phoneNotHidden = canonicalMod.STRICT_ONLY_TOOL_NAMES.filter((n) => !restricted.includes(n));
  ok(phoneNotHidden.length === 0,
    `严格版 restrict 名单含全部手机工具${phoneNotHidden.length ? `；漏了：${phoneNotHidden.join(', ')}` : ''}`);
  const harnessNotHidden = canonicalMod.HARNESS_ONLY_TOOL_NAMES.filter((n) => !restricted.includes(n));
  ok(harnessNotHidden.length === 0,
    `严格版 restrict 名单含全部宿主专用工具${harnessNotHidden.length ? `；漏了：${harnessNotHidden.join(', ')}` : ''}`);
  for (const name of ['ask_user_question', 'todo_write', 'mcp__snowluma__qq_send_message', 'mcp__web-search-safe__web_fetch']) {
    assert.equal(guardFn({ name }), undefined, `白名单应放行 ${name}`);
  }
  ok(true, '白名单放行 QQ MCP 与无害模型侧工具');
  let deniedAll = true;
  for (const name of ['bash', 'read', 'write', 'dev_future_unknown_tool', 'mcp__other__x', '', null, undefined, 123]) {
    if (typeof guardFn({ name }) !== 'string') deniedAll = false;
  }
  ok(deniedAll, '非法/未知/空工具名一律拒绝（fail-closed）');

  // ★ 最关键的一条：严格白名单必须**拒绝**全部手机工具。
  //   一旦这条红了，说明群聊（或任何非主人会话）拿到了手机控制权——
  //   那意味着群里任何人都能让她点外卖、下单、付款、以主人名义发消息。
  const phoneLeaks = ['mcp__phone-adb__phone_tap', 'mcp__phone-adb__phone_type',
    'mcp__phone-adb__phone_look', 'mcp__phone-adb__phone_screen', 'mcp__phone-adb__phone_connect',
    // 2026-10-12：dsh-phone-agent 是原生 cordis 插件，工具名是裸的 `phone_lan`
    // （不带 mcp__ 前缀），走精确名白名单。必须一起断言——否则它只是因为名字
    // 不匹配而被"顺带"拒绝，万一有人误把它塞进 SAFE_EXACT 就没人拦得住了。
    'phone_lan']
    .filter((n) => typeof guardFn({ name: n }) !== 'string');
  ok(phoneLeaks.length === 0,
    `严格白名单拒绝全部手机工具（群聊拿不到手机控制权）${phoneLeaks.length ? `；漏了：${phoneLeaks.join(', ')}` : ''}`);

  // ── 主人白名单（只有 qq-owner 用）────────────────────────────────────────
  let ownerGuard;
  const ownerRestricted = [];
  ownerMod.apply({
    tools: {
      restrict: ({ deny }) => ownerRestricted.push(...deny),
      guard: (fn) => { ownerGuard = fn; },
    },
  });
  // 2026-10-15：主人版走的必须是 allowPhoneAdb=true 那条分支 ⇒ 手机面**不得**被遮，
  // 同时宿主专用面照旧遮（QQ 会话无论哪种都没有 GUI 交付面）。
  const ownerPhoneDenied = canonicalMod.STRICT_ONLY_TOOL_NAMES.filter((n) => ownerRestricted.includes(n));
  ok(ownerPhoneDenied.length === 0,
    `主人版 restrict 不得遮手机工具${ownerPhoneDenied.length ? `；误遮：${ownerPhoneDenied.join(', ')}` : ''}`);
  const ownerHarnessMissing = canonicalMod.HARNESS_ONLY_TOOL_NAMES.filter((n) => !ownerRestricted.includes(n));
  ok(ownerHarnessMissing.length === 0,
    `主人版也要遮宿主专用工具${ownerHarnessMissing.length ? `；漏了：${ownerHarnessMissing.join(', ')}` : ''}`);
  const wantAllowed = ['mcp__phone-adb__phone_tap', 'mcp__phone-adb__phone_look',
    'mcp__phone-adb__phone_state', 'mcp__snowluma__qq_send_message',
    'mcp__web-search-safe__web_fetch', 'ask_user_question', 'todo_write',
    // dsh-phone-agent 的裸工具名（见 qq-tool-restrict.mjs 的 OWNER_EXTRA_EXACT）。
    // 漏了这条的话，插件挂上也调不动，表现为「装了但用不了」这种最难查的失败。
    'phone_lan'];
  const notAllowed = wantAllowed.filter((n) => ownerGuard({ name: n }) !== undefined);
  ok(notAllowed.length === 0,
    `主人白名单放行手机工具与 QQ 工具${notAllowed.length ? `；没放行：${notAllowed.join(', ')}` : ''}`);
  const ownerLeaks = ['bash', 'read', 'write', 'dev_future_unknown_tool', 'mcp__other__x', '', null, undefined, 123]
    .filter((n) => typeof ownerGuard({ name: n }) !== 'string');
  ok(ownerLeaks.length === 0,
    `主人白名单仍然 fail-closed（未知/非法工具照拒）${ownerLeaks.length ? `；漏了：${ownerLeaks.map(String).join(', ')}` : ''}`);

  // ── 新号白名单（只有 qq-chat-v2-fish 用）────────────────────────────────
  // 第二个 QQ 号（3901900049）的 MCP serverName 带后缀 ⇒ 工具名是 mcp__snowluma2__。
  // 老号那套 mcp__snowluma__ 在**同一个 profile 里同样注册着**，所以这份白名单必须
  // 只放行新号那套：放过老号那套 = 她用另一个账号发消息（最难发现的那种错）。
  let fishGuard;
  const fishRestricted = [];
  fishMod.apply({
    tools: {
      restrict: ({ deny }) => fishRestricted.push(...deny),
      guard: (fn) => { fishGuard = fn; },
    },
  });
  const fishWantAllowed = ['mcp__snowluma2__qq_send_message', 'mcp__snowluma2__qq_get_unread_messages',
    'mcp__snowluma2-host__snowluma_status', 'mcp__web-search-safe__web_fetch',
    'ask_user_question', 'todo_write'];
  const fishNotAllowed = fishWantAllowed.filter((n) => fishGuard({ name: n }) !== undefined);
  ok(fishNotAllowed.length === 0,
    `新号白名单放行它自己那套 MCP 与无害模型侧工具${fishNotAllowed.length ? `；没放行：${fishNotAllowed.join(', ')}` : ''}`);
  const fishLeaks = ['mcp__snowluma__qq_send_message', 'mcp__snowluma__qq_get_unread_messages',
    'mcp__snowluma-host__snowluma_status', 'mcp__phone-adb__phone_tap', 'phone_lan',
    'bash', 'read', 'write', 'dev_future_unknown_tool', 'mcp__other__x', '', null, undefined, 123]
    .filter((n) => typeof fishGuard({ name: n }) !== 'string');
  ok(fishLeaks.length === 0,
    `新号白名单拒绝老号工具 / 手机工具 / 未知名（fail-closed）${fishLeaks.length ? `；漏了：${fishLeaks.map(String).join(', ')}` : ''}`);
  // 拒绝理由必须直接给出正确前缀：两套 MCP 的工具名只差一个后缀（snowluma vs snowluma2），
  // 只回「不在白名单内」她会反复重试同一个错名字，白烧一整轮。
  const fishAliasMsgs = ['mcp__snowluma__qq_send_message', 'mcp__snowluma-host__snowluma_status']
    .map((n) => fishGuard({ name: n }));
  ok(fishAliasMsgs.every((m) => typeof m === 'string' && m.includes('mcp__snowluma2')),
    `新号白名单在拒绝老号工具时把正确前缀写进理由（${fishAliasMsgs[0] ?? 'undefined'}）`);
  const fishPhoneHidden = canonicalMod.STRICT_ONLY_TOOL_NAMES.filter((n) => !fishRestricted.includes(n));
  ok(fishPhoneHidden.length === 0,
    `新号版注册期同样遮全部手机工具${fishPhoneHidden.length ? `；漏了：${fishPhoneHidden.join(', ')}` : ''}`);

  // 三个守卫必须是**不同的** apply：否则说明「按 preset 分流」没生效，
  // 等于全员拿到手机权（owner）或全员用错账号（fish）。
  ok(ownerMod.apply !== canonicalMod.apply && fishMod.apply !== canonicalMod.apply && fishMod.apply !== ownerMod.apply,
    '严格版 / 主人版 / 新号版的 apply 互相不同（按 preset 分流确实生效）');
}

console.log(failures === 0 ? '\n✅ agent preset patch 契约通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
