#!/usr/bin/env node
// 模型成本账本：读 state/token-usage.jsonl，按模型/会话/小时汇总 token 与 ¥ 成本。
// 用法：node scripts/model-cost-report.mjs [--since=YYYY-MM-DD] [--until=YYYY-MM-DD] [--key=private:123] [--by=model|key|hour|day]
// 口径：只统计 k==="turn" 的行（k==="base" 是整条会话的累计快照，混加会重复计数）。
// 单价来自 src/model-prices.js 的 ratesAt()（含北京高峰 2 倍与 config.json 的 pricing 覆盖）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePriceTable, ratesAt, beijingParts } from '../src/model-prices.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const STATE = path.join(root, 'state');
const USAGE = path.join(STATE, 'token-usage.jsonl');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : '';
};
const sinceDay = argOf('since');
const untilDay = argOf('until');
const onlyKey = argOf('key');
const by = (argOf('by') || 'model').toLowerCase();
const sinceTime = argOf('since-time');
const untilTime = argOf('until-time');
const priceAs = argOf('price-as');
const clockOffsetMs = (hhmm) => { if (!hhmm) return 0; const [h, mi] = String(hhmm).split(':').map(Number); return ((Number(h) || 0) * 60 + (Number(mi) || 0)) * 60000; };

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); } catch {}
const table = resolvePriceTable(cfg.pricing);

const dayWindowMs = (day, endOfDay) => {
  const [y, m, d] = String(day).split('-').map(Number);
  const start = Date.UTC(y, m - 1, d) - 8 * 3600 * 1000; // 北京时间当天 00:00 的 UTC 毫秒
  return start + (endOfDay ? 24 * 3600 * 1000 - 1 : 0);
};
const todayDay = beijingParts(Date.now()).date;
const sinceMs = sinceDay ? dayWindowMs(sinceDay, false) + clockOffsetMs(sinceTime) : 0;
const untilMs = untilDay
  ? dayWindowMs(untilDay, false) + (untilTime ? clockOffsetMs(untilTime) : 24 * 3600 * 1000 - 1)
  : (untilTime ? dayWindowMs(todayDay, false) + clockOffsetMs(untilTime) : Number.POSITIVE_INFINITY);

if (!fs.existsSync(USAGE)) {
  console.error('找不到 ' + USAGE);
  process.exit(1);
}

const raw = fs.readFileSync(USAGE, 'utf8').split(/\r?\n/).filter(Boolean);
const buckets = new Map();
const baseSnaps = new Map();
const turnSeen = new Set();
let steps = 0, turns = 0, retries = 0;
let hit = 0, miss = 0, write = 0, out = 0, reasoning = 0, cost = 0, peakCost = 0;
let firstMs = null, lastMs = null;
const peakSplit = { peak: 0, off: 0 };

for (const line of raw) {
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  const t = Number(row.t) || 0;
  if (row.k === 'base') {
    const prev = baseSnaps.get(row.sid);
    if (!prev || Number(prev.seq) < Number(row.seq)) baseSnaps.set(row.sid, row);
    continue;
  }
  if (row.k !== 'turn') continue;
  if (t < sinceMs || t > untilMs) continue;
  if (onlyKey && row.key !== onlyKey) continue;
  const b = row.b || {};
  const cHit = Number(b.cacheHit) || 0, cMiss = Number(b.cacheMiss) || 0;
  const cWrite = Number(b.cacheWrite) || 0, cOut = Number(b.output) || 0;
  const cReason = Number(b.reasoning) || 0;
  const rates = ratesAt(priceAs || row.model, t, table);
  const rowCost = (cHit * rates.cacheHit + cMiss * rates.cacheMiss + cWrite * rates.cacheWrite + cOut * rates.output) / table.unit;
  steps += 1; hit += cHit; miss += cMiss; write += cWrite; out += cOut; reasoning += cReason;
  cost += rowCost;
  if (rates.tier === 'peak') { peakCost += rowCost; peakSplit.peak += 1; } else peakSplit.off += 1;
  const tk = row.sid + '#' + row.turn;
  if (!turnSeen.has(tk)) { turnSeen.add(tk); turns += 1; }
  if (Number(row.retry) > 0) retries += 1;
  if (!firstMs || t < firstMs) firstMs = t;
  if (!lastMs || t > lastMs) lastMs = t;
  const day = beijingParts(t).date;
  const hour = beijingParts(t).clock.slice(0, 2);
  const labels = by === 'key' ? [row.key] : by === 'hour' ? [day + ' ' + hour + ':00'] : by === 'day' ? [day] : [String(row.provider || '?') + '/' + String(row.model || '?')];
  for (const label of labels) {
    const cur = buckets.get(label) || { steps: 0, turns: new Set(), hit: 0, miss: 0, write: 0, out: 0, cost: 0, keys: new Set(), models: new Set() };
    cur.steps += 1; cur.turns.add(tk);
    cur.hit += cHit; cur.miss += cMiss; cur.write += cWrite; cur.out += cOut; cur.cost += rowCost;
    cur.keys.add(row.key); cur.models.add(String(row.model));
    buckets.set(label, cur);
  }
}

const nf = (n) => Number(n).toLocaleString('en-US');
const money = (n) => '¥' + (n >= 1 ? n.toFixed(3) : n.toFixed(4));
const fmt = (ms) => (ms ? new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) : '-');

console.log('模型成本账本 · 数据源 state/token-usage.jsonl（只算 k=turn 行）');
console.log('窗口: ' + (sinceDay || '全部') + (sinceTime ? ' ' + sinceTime : '') + ' -> ' + (untilDay || '现在') + (untilTime ? ' ' + untilTime : '') + '   按 ' + by + ' 分组' + (onlyKey ? '   仅 ' + onlyKey : '') + (priceAs ? '   计价按 ' + priceAs : ''));
if (firstMs) console.log('首步 ' + fmt(firstMs) + '   末步 ' + fmt(lastMs) + '   （北京时间 UTC+8）');
console.log('');
const rows = [...buckets.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].steps - a[1].steps);
const head = ['分组', '步', '轮', '输入(命中)', '输入(未命中)', '输出', '成本'].map((s) => s.padEnd(10)).join('');
console.log(head);
for (const [label, v] of rows) {
  console.log(String(label).padEnd(38) + String(v.steps).padStart(5) + String(v.turns.size).padStart(6) + nf(v.hit).padStart(14) + nf(v.miss).padStart(14) + nf(v.out).padStart(11) + money(v.cost).padStart(11));
}
console.log('');
const inTotal = hit + miss + write;
console.log('合计: ' + steps + ' 步 / ' + turns + ' 轮 / retry ' + retries + ' 次');
console.log('token: 命中 ' + nf(hit) + ' + 未命中 ' + nf(miss) + (write ? ' + 写缓存 ' + nf(write) : '') + ' = 输入 ' + nf(inTotal) + '，输出 ' + nf(out) + (reasoning ? '（含思考 ' + nf(reasoning) + '）' : ''));
console.log('缓存命中率: ' + (inTotal ? (hit / inTotal * 100).toFixed(2) + '%' : '-'));
console.log('成本: ' + money(cost) + '   平均 ' + money(turns ? cost / turns : 0) + '/轮，' + money(steps ? cost / steps : 0) + '/步');
console.log('高峰步数: ' + peakSplit.peak + '（' + money(peakCost) + '），空闲步数: ' + peakSplit.off);
const hours = firstMs ? Math.max((lastMs - firstMs) / 3600000, 1 / 60) : 0;
if (hours > 0) console.log('跨度 ' + hours.toFixed(2) + ' 小时 → 折算 ' + money(cost / hours * 24) + '/天（按当前节奏线性外推）');
if (cfg.dsh) console.log('当前 config.json: provider=' + cfg.dsh.provider + ' model=' + cfg.dsh.model + ' effort=' + cfg.dsh.reasoningEffort);
console.log('');
console.log('会话级累计快照（k=base，每会话最新一条，未计入上面的合计）:');
for (const row of [...baseSnaps.values()].sort((a, b) => Number(b.t) - Number(a.t)).slice(0, 8)) {
  const b = row.b || {};
  const r = ratesAt(row.model, Number(row.t), table);
  const c = ((Number(b.cacheHit) || 0) * r.cacheHit + (Number(b.cacheMiss) || 0) * r.cacheMiss + (Number(b.cacheWrite) || 0) * r.cacheWrite + (Number(b.output) || 0) * r.output) / table.unit;
  console.log('  ' + String(row.key).padEnd(24) + String(row.sid).slice(0, 14) + '  ' + fmt(Number(row.t)) + '  命中 ' + nf(b.cacheHit || 0).padStart(9) + ' / 未命中 ' + nf(b.cacheMiss || 0).padStart(8) + ' / 输出 ' + nf(b.output || 0).padStart(6) + '  ' + money(c));
}