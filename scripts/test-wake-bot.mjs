#!/usr/bin/env node
// [QQ 唤醒器] 纯逻辑单测：解析、鉴权、白名单、类型校验、命令分发。
//
// 这里**不连网络、不启进程**：拿假的 deps 跑 executeCommand，验证它改的是正确的文件、
// 拒绝不该接受的输入。真机联通性靠 /status 实测（见交付说明）。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseCommand, shouldHandle, coerceLike, chunkText, executeCommand, ALLOWED_PATHS,
} from '../src/qq-wake-bot.js';

test('parseCommand：只认 / 或 ／ 开头的命令', () => {
  assert.deepEqual(parseCommand('/status'), { cmd: 'status', args: '' });
  assert.deepEqual(parseCommand('／set socialV2.memoryDb.maxChars 1200'), { cmd: 'set', args: 'socialV2.memoryDb.maxChars 1200' });
  assert.equal(parseCommand('你好呀'), null, '普通聊天不是命令');
  assert.equal(parseCommand('status'), null, '不带斜杠不算');
  assert.equal(parseCommand(''), null);
});

test('shouldHandle：只有主人私聊里的命令才处理', () => {
  const owner = '10001';
  assert.equal(shouldHandle({ userId: owner, ownerQQ: owner, text: '/status' }).ok, true);
  assert.equal(shouldHandle({ userId: '123', ownerQQ: owner, text: '/status' }).reason, 'not-owner');
  assert.equal(shouldHandle({ userId: owner, ownerQQ: owner, text: '在吗' }).reason, 'not-command');
});

test('coerceLike：按现值类型转换，非法值拒绝', () => {
  assert.equal(coerceLike(true, 'off'), false);
  assert.equal(coerceLike(false, '开'), true);
  assert.equal(coerceLike(800, '1500'), 1500);
  assert.throws(() => coerceLike(800, '很久'), /非负数字/);
  assert.throws(() => coerceLike(true, '也许'), /on\/off/);
});

test('chunkText：长回复切片，不丢字', () => {
  const parts = chunkText('a'.repeat(1000), 450);
  assert.equal(parts.length, 3);
  assert.equal(parts.join(''), 'a'.repeat(1000));
});

function fakeDeps(over = {}) {
  const calls = { sent: [], started: 0, stopped: 0, restarted: 0, sets: [], roleMode: [] };
  let mode = 'active';
  return {
    calls,
    deps: {
      config: { socialV2: { memoryDb: { autoLearn: true, maxChars: 1500 }, thinkingFiller: { enabled: true } } },
      send: async () => {},
      startBridge: async () => { calls.started += 1; return { ok: true, out: 'new pid=1' }; },
      stopBridge: async () => { calls.stopped += 1; return { ok: true, out: 'killed' }; },
      restartBridge: async () => { calls.restarted += 1; return { ok: true, out: 'new pid=2' }; },
      portOpen: async () => false,
      applySetting: (p, v) => { calls.sets.push([p, v]); return 'config.json'; },
      // [养鱼 2026-10-21] 必须替身：真实实现写的是 state/current-role.json，
      // 不替身就等于"跑一次测试把线上机器人切成静默"。见文件末尾的硬回归。
      readRoleMode: () => mode,
      writeRoleMode: (m) => { mode = m; calls.roleMode.push(m); },
      ...over,
    },
  };
}

test('/help 列出全部命令', async () => {
  const { deps } = fakeDeps();
  const text = await executeCommand({ cmd: 'help', args: '' }, deps);
  for (const c of ['/status', '/start', '/restart', '/stop', '/silent', '/get', '/set']) {
    assert.ok(text.includes(c), '帮助里应有 ' + c);
  }
});

test('/start：桥接没跑时启动它；已经在跑就不重复启动', async () => {
  const a = fakeDeps();
  const t1 = await executeCommand({ cmd: 'start', args: '' }, a.deps);
  assert.equal(a.calls.started, 1);
  assert.ok(/已启动|启动命令已发出/.test(t1));

  const b = fakeDeps({ portOpen: async () => true });
  const t2 = await executeCommand({ cmd: 'start', args: '' }, b.deps);
  assert.equal(b.calls.started, 0, '已经在跑时不该再启动');
  assert.ok(t2.includes('本来就在跑'));
});

test('/silent：写模式文件并回执', async () => {
  const { deps, calls } = fakeDeps();
  const t = await executeCommand({ cmd: 'silent', args: 'on' }, deps);
  assert.ok(/静默/.test(t));
  assert.deepEqual(calls.roleMode, ['silent'], '应该写 silent');
  const bad = await executeCommand({ cmd: 'silent', args: '也许' }, deps);
  assert.ok(bad.includes('用法'));
  assert.deepEqual(calls.roleMode, ['silent'], '非法参数不许写');
  const off = await executeCommand({ cmd: 'silent', args: 'off' }, deps);
  assert.ok(/已恢复/.test(off));
  assert.deepEqual(calls.roleMode, ['silent', 'active']);
});

// [养鱼 2026-10-21] 硬回归：跑测试**绝不能**动线上的角色状态。
// 事故：/silent 用例直接调了真实的 writeRoleMode（STATE_DIR 指向真实 state/），
// 于是每跑一次 npm test 就把线上机器人切成静默，群里一条都不回，看着像"死了"。
test('执行 /silent 不许碰真实 state/current-role.json', async () => {
  const real = new URL('../state/current-role.json', import.meta.url);
  const before = fs.existsSync(real) ? fs.readFileSync(real, 'utf8') : null;
  const beforeMtime = fs.existsSync(real) ? fs.statSync(real).mtimeMs : null;

  const { deps } = fakeDeps();
  await executeCommand({ cmd: 'silent', args: 'on' }, deps);
  await executeCommand({ cmd: 'silent', args: 'off' }, deps);
  await executeCommand({ cmd: 'status', args: '' }, deps);

  const after = fs.existsSync(real) ? fs.readFileSync(real, 'utf8') : null;
  const afterMtime = fs.existsSync(real) ? fs.statSync(real).mtimeMs : null;
  assert.equal(after, before, '真实角色状态被测试改写了！');
  assert.equal(afterMtime, beforeMtime, '真实角色状态文件被测试重写了（内容相同也不行）');
});

test('/set：白名单外拒绝；白名单内走 applySetting 并重启桥接', async () => {
  const a = fakeDeps({ portOpen: async () => true });
  const denied = await executeCommand({ cmd: 'set', args: 'socialV2.snowluma.accessToken abc' }, a.deps);
  assert.ok(/白名单/.test(denied), '凭据路径必须拒绝');
  assert.equal(a.calls.sets.length, 0);

  const b = fakeDeps({ portOpen: async () => true });
  const ok = await executeCommand({ cmd: 'set', args: 'socialV2.thinkingFiller.enabled off' }, b.deps);
  assert.deepEqual(b.calls.sets, [['socialV2.thinkingFiller.enabled', false]]);
  assert.equal(b.calls.restarted, 1, '改完配置要重启桥接生效');
  assert.ok(ok.includes('已设置'));
});

test('/get：读白名单路径；越界拒绝', async () => {
  const { deps } = fakeDeps();
  const t = await executeCommand({ cmd: 'get', args: 'socialV2.memoryDb.maxChars' }, deps);
  assert.ok(t.includes('1500'));
  const denied = await executeCommand({ cmd: 'get', args: 'ownerQQ' }, deps);
  assert.ok(/白名单/.test(denied));
});

test('ALLOWED_PATHS 里没有凭据类路径', () => {
  for (const p of ALLOWED_PATHS) {
    assert.ok(!/token|password|secret|accessToken/i.test(p), '白名单里不该出现 ' + p);
  }
});
