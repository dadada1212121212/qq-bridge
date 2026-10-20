// 静默失败台账回归（2026-10-20）。
//
// 钉住的是"吞掉之后要留痕迹"这件事本身：
//   ① 计数/首次/最近/最后一条错误都要记对（否则控制台看到的数字没意义）；
//   ② 必须**跨重启保留**（每次重启从 0 开始 = 等于没记）；
//   ③ 日志要限流（一秒几十次的失败不能把日志刷爆，但第一次必须打出来）；
//   ④ 台账文件坏了不能把桥接带崩（这层要是能抛，就成了新的故障源）；
//   ⑤ tag 数量封顶（防止有人把用户输入拼进 tag 把文件撑爆）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSilentFailures } from '../src/silent-failures.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-failures-test-'));
const file = path.join(dir, 'silent-failures.json');

let pass = 0; let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}
function eq(name, actual, expected) {
  ok(actual === expected, `${name}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`);
}

let clock = 1_700_000_000_000;
const now = () => clock;

console.log('## 基本记账');
{
  const logs = [];
  const sf = createSilentFailures({ file, log: (m) => logs.push(m), now, flushMs: 0 });
  eq('新台账 total 为 0', sf.snapshot().total, 0);

  sf.swallow('巡园 tick', new Error('boom'));
  clock += 60_000;
  sf.swallow('巡园 tick', new Error('boom2'));
  sf.swallow('链接摘要', new Error('dns fail'));

  const snap = sf.snapshot();
  eq('两个 tag', snap.tags, 2);
  eq('总次数', snap.total, 3);
  const stroll = snap.top.find((r) => r.tag === '巡园 tick');
  eq('按 tag 计数', stroll.count, 2);
  eq('最后一条错误是最新的那条', stroll.lastMsg, 'boom2');
  eq('agoMs 按最后一次算', stroll.agoMs, 0);
  eq('首次时间记的是第一次', stroll.firstAt, 1_700_000_000_000);
  ok(logs.length >= 2, '每次失败都打日志（前 3 次）');
  ok(logs[0].includes('巡园 tick') && logs[0].includes('累计 1 次'), '日志里带 tag 与累计次数');
}

console.log('## 跨重启保留');
{
  const sf2 = createSilentFailures({ file, log: () => {}, now });
  const snap = sf2.snapshot();
  eq('重启后仍能看到 3 次', snap.total, 3);
  sf2.swallow('巡园 tick', new Error('third'));
  eq('重启后继续累加', sf2.snapshot().top.find((r) => r.tag === '巡园 tick').count, 3);
}

console.log('## 日志限流');
{
  const logs = [];
  const sf = createSilentFailures({ file: path.join(dir, 'throttle.json'), log: (m) => logs.push(m), now, flushMs: 0 });
  for (let i = 0; i < 120; i += 1) sf.swallow('hot', new Error('x' + i));
  eq('120 次只打了 4 行日志（前 3 次 + 第 100 次）', logs.length, 4);
  ok(logs[3].includes('累计 100 次'), '第 100 次那行写的是 100');
  eq('但计数一次都没少', sf.snapshot().total, 120);
}

console.log('## tag 封顶');
{
  const sf = createSilentFailures({ file: path.join(dir, 'cap.json'), log: () => {}, now, flushMs: 0, maxTags: 3 });
  sf.swallow('a', new Error('1')); sf.swallow('b', new Error('2')); sf.swallow('c', new Error('3'));
  sf.swallow('a', new Error('1'));
  sf.swallow('d', new Error('4'));
  const snap = sf.snapshot();
  eq('tag 数量不超过上限', snap.tags, 3);
  ok(snap.top.some((r) => r.tag === 'a'), '留下的是次数多的那个（a 有 2 次）');
  // a 有 2 次；b/c/d 都只有 1 次，按"次数最少 + 最久没出现"淘汰的是 b。
  ok(!snap.top.some((r) => r.tag === 'b'), '被挤掉的是「次数最少且最久没出现」的那个');
}

console.log('## 坏文件自愈 + 绝不抛');
{
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ this is not json', 'utf8');
  let threw = false;
  let sf = null;
  try { sf = createSilentFailures({ file: bad, log: () => {}, now, flushMs: 0 }); } catch { threw = true; }
  ok(!threw, '台账文件损坏时不抛（否则会变成新的故障源）');
  eq('坏文件被挪成 .bad', fs.existsSync(bad + '.bad'), true);
  sf.swallow('x', new Error('y'));
  eq('挪走后能正常记账', sf.snapshot().total, 1);

  const sf2 = createSilentFailures({ file: null, log: () => {}, now, flushMs: 0 });
  ok(sf2.swallow('无文件模式', null) === true, 'error 为 null 也不抛');
  ok(sf2.swallow('', 'plain string') === true, 'tag 为空串也不抛');
  ok(sf2.snapshot().top.some((r) => r.tag === 'unknown'), '空 tag 归到 unknown');
}

console.log('## 清空');
{
  const sf = createSilentFailures({ file: path.join(dir, 'reset.json'), log: () => {}, now, flushMs: 0 });
  sf.swallow('a', new Error('1'));
  sf.reset();
  eq('reset 后 total 归零', sf.snapshot().total, 0);
  const again = createSilentFailures({ file: path.join(dir, 'reset.json'), log: () => {}, now });
  eq('reset 也落盘了', again.snapshot().total, 0);
}

console.log('## 长错误文本会截断');
{
  const sf = createSilentFailures({ file: path.join(dir, 'long.json'), log: () => {}, now, flushMs: 0 });
  sf.swallow('long', new Error('x'.repeat(500)));
  const msg = sf.snapshot().top[0].lastMsg;
  ok(msg.length <= 180, `最后一条错误被截到 180 字以内（实际 ${msg.length}）`);
}

console.log(`\n静默失败台账：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
