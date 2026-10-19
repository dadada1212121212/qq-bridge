// 重启循环的停机语义：hold 生效时，run-qqbridge.cmd 的 5 秒循环不许把桥接拉起来。
//
// 为什么必须有这个文件
// --------------------
// 2026-10-19 给主号启动器补 5 秒重启循环时，最容易踩的坑就是「循环无条件重启」
// 把 /stop 停机功能打穿：bridge-control.ps1 的 stop 只杀 node 进程 + 写 hold 文件，
// 循环若无视 hold，主人用 QQ 发的 /stop 再也关不掉机器人，「等 /start 叫醒」
// 这个功能直接消失。本测试把 isHoldActive 的三条语义与 CLI 退出码钉死。
// 判定口径必须与 qq-dsh-bridge/start-services.ps1（保活任务侧）保持一致，
// 否则「循环觉得该停、保活觉得该拉」会打起来。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHoldActive } from './hold-state.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(root, 'scripts', 'hold-state.mjs');
// 固定时刻：边界用例必须可复现，不能拿 Date.now() 现算。
const NOW = 1792000000000;
const HOLD = (over = {}) => JSON.stringify({ services: ['qqbridge'], until: NOW + 60000, ...over });

test('空/坏输入一律未生效', () => {
  for (const raw of ['', '   ', null, undefined, 'not json{', '[1,2]', '"str"', '42', 'null']) {
    assert.equal(isHoldActive(raw, NOW), false, `raw=${JSON.stringify(raw)}`);
  }
});

test('services 不含 qqbridge 也不算生效', () => {
  assert.equal(isHoldActive(HOLD({ services: ['gateway'] }), NOW), false);
  assert.equal(isHoldActive(HOLD({ services: [] }), NOW), false);
  assert.equal(isHoldActive(HOLD({ services: 'qqbridge' }), NOW), false); // 不是数组 = 结构不对
});

test('until 缺失或非数字按未生效（不许无限期停机）', () => {
  assert.equal(isHoldActive('{"services":["qqbridge"]}', NOW), false);
  assert.equal(isHoldActive('{"services":["qqbridge"],"until":"soon"}', NOW), false);
});

test('过期 = 未生效（hold 到期后循环要恢复重启）', () => {
  assert.equal(isHoldActive(HOLD({ until: NOW - 1 }), NOW), false);
  assert.equal(isHoldActive(HOLD({ until: NOW }), NOW), false); // 边界：> now 才算生效
  assert.equal(isHoldActive(HOLD({ until: NOW + 1 }), NOW), true);
});

test('未过期 + services 含 qqbridge 或通配符 = 生效', () => {
  assert.equal(isHoldActive(HOLD(), NOW), true);
  assert.equal(isHoldActive(HOLD({ services: ['*'] }), NOW), true);
  assert.equal(isHoldActive(HOLD({ services: ['gateway', 'qqbridge'] }), NOW), true);
});

// ── CLI 段：cmd 循环只认退出码，出口行为必须一起钉住 ─────────────────────────
// 注意：CLI 用的是真实时钟，until 必须按 Date.now() 现算；上面的 NOW 只服务于
// 纯函数段的边界可复现（拿它写文件会让 hold 在真实时钟里早已过期）。
const tmp = mkdtempSync(join(tmpdir(), 'hold-state-test-'));
after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const runCli = (file) => spawnSync(process.execPath, [CLI, file], { encoding: 'utf8' });
const HOLD_LIVE = (over = {}) =>
  JSON.stringify({ services: ['qqbridge'], until: Date.now() + 60000, ...over });

test('CLI：未过期的 hold → 退出码 1 + 输出 held', () => {
  const f = join(tmp, 'active.json');
  writeFileSync(f, HOLD_LIVE());
  const r = runCli(f);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /held/);
});

test('CLI：过期/服务不符 → 退出码 0 + 输出 free', () => {
  const f1 = join(tmp, 'expired.json');
  writeFileSync(f1, HOLD_LIVE({ until: Date.now() - 1 }));
  assert.equal(runCli(f1).status, 0);
  const f2 = join(tmp, 'other.json');
  writeFileSync(f2, HOLD_LIVE({ services: ['gateway'] }));
  assert.equal(runCli(f2).status, 0);
});

test('CLI：文件不存在/坏 JSON → 退出码 0（读失败不许永久躺平）', () => {
  assert.equal(runCli(join(tmp, 'nope.json')).status, 0);
  const f = join(tmp, 'broken.json');
  writeFileSync(f, '{oops');
  const r = runCli(f);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /free/);
});
