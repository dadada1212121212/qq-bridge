// json-file / day-key 回归（2026-10-20 统一实现时新增）。
//
// 这两个模块是全仓最底层的东西（所有状态文件都走它、所有"今天几号"都走它），
// 所以每条语义都得钉住 —— 尤其是几个**曾经各写各的、行为还不一样**的分支：
//   · Windows 的 UTF-8 BOM（不剥就 JSON.parse 必失败）
//   · 空文件（要当"没有"而不是"坏"）
//   · required 与 quarantine 的组合（必须抛 vs 必须挪走坏文件）
//   · 本地日期 vs UTC（本机 UTC+8，0~8 点差一天）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../src/json-file.js';
import { localDayKey, localDayString, dayStartTs, daysAgoOf } from '../src/day-key.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-file-test-'));
const f = (name) => path.join(dir, name);

let pass = 0; let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}
function eq(name, actual, expected) {
  ok(actual === expected, `${name}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`);
}

console.log('## readJsonFile');
{
  fs.writeFileSync(f('ok.json'), JSON.stringify({ a: 1 }), 'utf8');
  eq('正常文件', readJsonFile(f('ok.json'), null)?.a, 1);

  eq('文件不存在 → fallback', readJsonFile(f('nope.json'), 'FB'), 'FB');
  eq('fallback 默认 null', readJsonFile(f('nope.json')), null);

  fs.writeFileSync(f('empty.json'), '   \n', 'utf8');
  eq('空文件 → fallback（不是"坏"）', readJsonFile(f('empty.json'), 'FB'), 'FB');
  eq('空文件不产生 .bad', fs.existsSync(f('empty.json.bad')), false);

  // Windows 记事本写的 BOM：不剥掉 JSON.parse 会报 Unexpected token
  fs.writeFileSync(f('bom.json'), '\uFEFF{"b":2}', 'utf8');
  eq('剥掉 UTF-8 BOM 后能解析', readJsonFile(f('bom.json'), null)?.b, 2);

  fs.writeFileSync(f('bad.json'), '{oops', 'utf8');
  const logs = [];
  eq('坏文件 → fallback', readJsonFile(f('bad.json'), 'FB', { log: (m) => logs.push(m) }), 'FB');
  ok(logs.length === 1 && logs[0].includes('bad.json'), '坏文件会记一行日志（带文件名）');
  eq('默认不挪坏文件（可能不是自己的文件）', fs.existsSync(f('bad.json')), true);

  fs.writeFileSync(f('bad2.json'), '{oops', 'utf8');
  readJsonFile(f('bad2.json'), 'FB', { quarantine: true });
  eq('quarantine=true 时挪成 .bad', fs.existsSync(f('bad2.json.bad')), true);
  eq('原文件已不在', fs.existsSync(f('bad2.json')), false);

  let threw = null;
  try { readJsonFile(f('bad.json'), 'FB', { required: true }); } catch (e) { threw = e; }
  ok(threw && /解析失败/.test(threw.message), 'required 时解析失败要抛（启动必需配置 fail-fast）');
  threw = null;
  try { readJsonFile(f('nope.json'), 'FB', { required: true }); } catch (e) { threw = e; }
  ok(threw && /读取失败/.test(threw.message), 'required 时文件缺失也要抛');
}

console.log('## writeJsonAtomic');
{
  writeJsonAtomic(f('w1.json'), { x: 1 });
  eq('能读回来', readJsonFile(f('w1.json'), null)?.x, 1);
  const raw = fs.readFileSync(f('w1.json'), 'utf8');
  ok(!raw.includes('\n'), '默认紧凑写（不加缩进，省空间）');

  writeJsonAtomic(f('w2.json'), { y: 2 }, { pretty: true });
  const raw2 = fs.readFileSync(f('w2.json'), 'utf8');
  ok(raw2.includes('\n  "y"'), 'pretty=true 时带缩进（人要看的状态文件）');

  writeJsonAtomic(f('deep/a/b/c.json'), { z: 3 });
  eq('父目录自动创建', readJsonFile(f('deep/a/b/c.json'), null)?.z, 3);

  const before = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length;
  writeJsonAtomic(f('w3.json'), { ok: true });
  const after = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length;
  eq('不留 .tmp 垃圾', after, before);
}

console.log('## day-key（本地日期，不是 UTC）');
{
  // 2026-10-20 07:30 本地时间：UTC 那边还是 10-19（UTC+8）
  const earlyMorning = new Date(2026, 9, 20, 7, 30, 0).getTime();
  eq('北京时间早上 7:30 算当天', localDayKey(earlyMorning), '2026-10-20');
  ok(localDayKey(earlyMorning) !== new Date(earlyMorning).toISOString().slice(0, 10),
    '与 toISOString 的结果不同（这正是当初那个 bug）');

  eq('offset=1 是昨天', localDayString(1, earlyMorning), '2026-10-19');
  eq('offset=0 是今天', localDayString(0, earlyMorning), '2026-10-20');

  // 跨月/跨年边界
  eq('跨月', localDayString(1, new Date(2026, 10, 1, 9, 0, 0).getTime()), '2026-10-31');
  eq('跨年', localDayString(1, new Date(2027, 0, 1, 9, 0, 0).getTime()), '2026-12-31');

  eq('dayStartTs 解析本地零点', new Date(dayStartTs('2026-10-20')).getHours(), 0);
  eq('daysAgoOf 按本地日切（差 2 天）', daysAgoOf('2026-10-18', new Date(2026, 9, 20, 1, 0, 0).getTime()), 2);
  eq('daysAgoOf 非法日期返回 0（不抛）', daysAgoOf('not-a-day', Date.now()), 0);
}

console.log(`\nJSON/日期统一层：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
