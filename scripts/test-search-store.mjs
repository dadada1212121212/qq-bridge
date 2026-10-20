// 搜索磁盘层测试（2026-10-20 新增）：缓存 / 源健康度 / 统计 / 卡片台账。
// 全部落临时目录，不碰真实 state/，也不打网络 —— 秒跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readJsonSafe, writeJsonAtomic,
  createDiskCache, createSourceHealth, createStats, createCardLog
} from '../src/search-store.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-store-test-'));
const f = (name) => path.join(dir, name);

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond) {
  if (cond) pass += 1;
  else { fail += 1; failures.push(name); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass += 1;
  else { fail += 1; failures.push(`${name}（实际 ${a} ≠ 期望 ${e}）`); }
}

// ── 1. 基础读写 ────────────────────────────────────────────────────
eq('读不存在的文件给 fallback', readJsonSafe(f('nope.json'), { a: 1 }), { a: 1 });
fs.writeFileSync(f('bad.json'), '{不是json', 'utf8');
eq('读坏 JSON 也给 fallback', readJsonSafe(f('bad.json'), []), []);
ok('坏文件被挪走（下次不会反复读坏）', fs.existsSync(f('bad.json.bad')) && !fs.existsSync(f('bad.json')));
writeJsonAtomic(f('w.json'), { hello: 1 });
eq('原子写能读回来', readJsonSafe(f('w.json'), null), { hello: 1 });

// ── 2. 落盘缓存 ────────────────────────────────────────────────────
{
  let clock = 1_000_000;
  const file = f('cache.json');
  const c = createDiskCache({ file, maxEntries: 3, now: () => clock });
  c.set('k1', { query: 'k1', results: [{ title: 'A' }] }, 60_000);
  eq('写入后能读到', c.get('k1')?.results?.[0]?.title, 'A');
  c.flush();
  ok('落盘文件已生成', fs.existsSync(file));

  const c2 = createDiskCache({ file, maxEntries: 3, now: () => clock });
  eq('新实例（模拟重启）仍能读到', c2.get('k1')?.results?.[0]?.title, 'A');

  clock += 61_000;
  eq('过期后读不到', c2.get('k1'), null);
  ok('过期条目被清掉', c2.size === 0);

  // 容量上限：只留最新 3 条
  for (let i = 0; i < 5; i += 1) { clock += 10; c2.set(`n${i}`, { query: `n${i}` }, 600_000); }
  eq('超出上限只留 maxEntries 条', c2.size, 3);
  ok('最老的先被淘汰', c2.get('n0') === null && c2.get('n4') !== null);

  // TTL <= 0 不写入（避免"永久缓存"这种坑）
  c2.set('zero', { query: 'zero' }, 0);
  eq('TTL 为 0 不缓存', c2.get('zero'), null);
}

// ── 3. 源健康度 ────────────────────────────────────────────────────
{
  let clock = 5_000_000;
  const file = f('health.json');
  const h = createSourceHealth({ file, now: () => clock, minSamples: 4, minRate: 0.2 });

  h.record('sogou', true);
  h.record('sogou', true);
  eq('成功的源不在冷却表', h.cooldownMap().has('sogou'), false);

  // 连续失败 → 成功率 0 → 长期跳过
  for (let i = 0; i < 5; i += 1) h.record('dead', false);
  ok('样本足够且成功率极低的源被跳过', h.cooldownMap().has('dead'));

  // 样本不足不判死（避免偶发失败就把源拉黑）
  h.record('fresh', false);
  h.record('fresh', false);
  eq('样本不足的源不跳过', h.cooldownMap().has('fresh'), false);

  // 回归钉：失败太久（3 天没新样本）必须放它回来试一次，否则网络恢复后这个源永远回不来
  clock += 4 * 86400000;
  eq('失败 3 天后不再跳过（给它一次恢复机会）', h.cooldownMap().has('dead'), false);

  // 显式冷却
  h.markCooldown('bing', clock + 30_000);
  ok('显式冷却立刻生效', h.cooldownMap().has('bing'));
  clock += 31_000;
  eq('冷却到期后恢复', h.cooldownMap().has('bing'), false);

  h.flush();
  const h2 = createSourceHealth({ file, now: () => clock });
  ok('健康度跨重启保留', h2.snapshot().engines.sogou?.ok === 2);

  // 出口探测缓存
  eq('没探过返回 null', h2.probeCache(), null);
  h2.setProbe({ baidu: false, duckduckgo: true });
  eq('探过能读回', h2.probeCache()?.duckduckgo, true);
  clock += 25 * 3600 * 1000;
  eq('探测结果 24 小时后过期', h2.probeCache(), null);
}

// ── 4. 统计 ────────────────────────────────────────────────────────
{
  const file = f('stats.json');
  const s = createStats({ file });
  s.bump('searches');
  s.bump('searches');
  s.bump('diskHits');
  s.bump('net', 300);
  s.bump('net', 500);
  const today = s.snapshot(7)[0];
  eq('搜索次数累计', today.searches, 2);
  eq('缓存命中累计', today.diskHits, 1);
  eq('联网次数累计', today.net, 2);
  eq('耗时只对带 ms 的调用累计', today.ms, 800);
  eq('耗时样本数', today.n, 2);
}

// ── 5. 卡片台账 ────────────────────────────────────────────────────
{
  const file = f('cards.jsonl');
  const log = createCardLog({ file });
  log.append({ at: Date.now(), query: '原神 5.0 卡池', tokens: ['原神', '5.', '.0', '卡池'], summary: 'A' });
  log.append({ at: Date.now(), query: '怎么煮鸡蛋不粘壳', tokens: ['怎么', '么煮', '煮鸡', '鸡蛋', '蛋不', '不粘', '粘壳'], summary: 'B' });
  eq('两张卡都写进去了', log.recent().length, 2);

  const hit = log.findByTokens(['原神', '卡池']);
  eq('重叠度高能召回', hit?.card?.query, '原神 5.0 卡池');
  eq('不相关的查不到', log.findByTokens(['显卡', '驱动']), null);

  // 低相关兜底卡不参与召回（那批线索本来就不值得复用）
  log.append({ at: Date.now(), query: '低相关查询', tokens: ['低相', '相关', '关查', '查询'], summary: 'C', lowConfidence: true });
  eq('低相关卡不被召回', log.findByTokens(['低相', '相关', '关查', '查询']), null);

  // 过期卡不召回
  log.append({ at: Date.now() - 10 * 86400000, query: '老查询', tokens: ['老查', '查询'], summary: 'D' });
  eq('超过 7 天的卡不召回', log.findByTokens(['老查', '查询']), null);

  // 体积超限时只留最后若干行
  const small = createCardLog({ file: f('rotate.jsonl'), maxBytes: 400, keepLines: 3 });
  for (let i = 0; i < 20; i += 1) small.append({ at: Date.now(), query: `q${i}`, tokens: [`q${i}`], summary: 'x'.repeat(40) });
  ok('超体积后文件被裁剪', small.recent().length <= 3);
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }

console.log(`搜索磁盘层：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('失败项：');
  for (const x of failures) console.log('  ✗ ' + x);
  process.exit(1);
}
