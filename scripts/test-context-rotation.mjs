// 会话轮换口径回归：「当前上下文多大」必须是**最近一步的输入**，
// 而不是「最新一轮所有步的累加」。
//
// 钉住的是 2026-10-07 坐实的线上故障：会话轮换读了 tokenLedger.conversation() 里
// 最新一轮的 buckets，而那一轮是 buildIndex 用 addBuckets 逐条累加出来的——
// 一轮正常对话 8 步 × ~30K ≈ 24 万 ⇒ 任何**正常**的一轮都超过 60000 阈值，
// 于是每轮都被判定「该退役重建」（实测全天 29 次，private:10001 在
// 15:35:36 与 15:36:38 一分钟内连轮两次：604126 → 86612）。
// 代价是上下文全丢、缓存全冷、preset 反复重挂。
//
// 覆盖点：
//   1. 单轮多步 → 取最后一步，不是该轮累加（本测试的核心）；
//   2. 写缓存计入输入（cacheWrite 也是这一步重发的上下文）；
//   3. 乱序到达的旧采样不许把「最新一步」打回去；
//   4. 没有该会话的采样时返回 0（调用方据此回退到内存里的上次值）；
//   5. 跨重启（重放 journal）与 compact 淘汰之后仍然正确；
//   6. bridge.js 的 contextTokensOfKeyV2 必须走 latestStepInput，且不再为此读 conversation()。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PRICE_TABLE } from '../src/model-prices.js';
import { createTokenLedger } from '../src/token-ledger.js';

let failed = 0;
function assert(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { console.error(`❌ ${label}`); failed = 1; }
}
function eq(actual, expected, label) {
  assert(actual === expected, `${label}（期望 ${expected}，实得 ${actual}）`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-context-rotation-'));
const ledgerFile = path.join(tmpDir, 'token-usage.jsonl');
const KEY = 'private:10001';
// 周一 20:00 = 空闲档，让这个测试与「跑测试的时刻」无关（高峰 2 倍价只影响金额，不影响口径）。
const AT = Date.parse('2026-03-02T20:00:00+08:00');
const usage = (cacheMiss, output, cacheHit = 0, extra = {}) =>
  ({ inputTokens: cacheMiss, outputTokens: output, cacheReadTokens: cacheHit, ...extra });
const evMsg = (seq, turn, step, at, u) =>
  ({ seq, time: at, type: 'assistant/message', data: { turn, step, usage: u } });
function freshLedger(opts = {}) {
  try { fs.unlinkSync(ledgerFile); } catch {}
  return createTokenLedger({ file: ledgerFile, priceTable: DEFAULT_PRICE_TABLE, resolveKey: () => KEY, ...opts });
}

// ── 1. 单轮多步：取最后一步，不是该轮累加 ────────────────────────────────
let ledger = freshLedger();
const SID = 'session-a';
eq(typeof ledger.latestStepInput, 'function', '账本导出 latestStepInput');
eq(ledger.latestStepInput(SID), 0, '没有采样时返回 0');

ledger.ingestEvent({ sessionId: SID, event: evMsg(11, 1, 1, AT, usage(10000, 50, 20000)) }); // 输入 30000
ledger.ingestEvent({ sessionId: SID, event: evMsg(12, 1, 2, AT + 1000, usage(10000, 60, 25000)) }); // 输入 35000
eq(ledger.latestStepInput(SID), 35000, '同一轮两步 → 取最后一步（35000）而不是两步之和（65000）');

const detail = ledger.conversation(KEY, { turnLimit: 200 });
const turnBuckets = detail?.turns?.[0]?.buckets ?? {};
const accumulated = (Number(turnBuckets.cacheMiss) || 0) + (Number(turnBuckets.cacheHit) || 0);
eq(accumulated, 65000, '对照：conversation() 的一轮 buckets 是该轮所有步的累加（这就是旧口径踩的坑）');
assert(ledger.latestStepInput(SID) !== accumulated, 'latestStepInput 绝不能等于该轮累加值');

// ── 2. 写缓存计入输入 ────────────────────────────────────────────────────
ledger.ingestEvent({ sessionId: SID, event: evMsg(13, 1, 3, AT + 2000, usage(1000, 10, 0, { cacheWriteTokens: 2000 })) });
eq(ledger.latestStepInput(SID), 3000, 'cacheWrite 也属于这一步重发的上下文（1000 未命中 + 2000 写缓存）');

// ── 3. 乱序到达的旧采样不许把「最新一步」打回去 ──────────────────────────
ledger.ingestEvent({ sessionId: SID, event: evMsg(14, 1, 4, AT - 5000, usage(999999, 1, 0)) });
eq(ledger.latestStepInput(SID), 3000, '更早时间的迟到采样被忽略（不回退到 999999）');

// ── 4. 换会话不会读到别人的上下文 ────────────────────────────────────────
eq(ledger.latestStepInput('session-b'), 0, '另一个会话（刚轮换出来的新会话）读到 0，不会继承上一个会话的大上下文');
ledger.ingestEvent({ sessionId: 'session-b', event: evMsg(15, 1, 1, AT + 3000, usage(500, 5, 0)) });
eq(ledger.latestStepInput('session-b'), 500, '新会话自己的采样生效');
eq(ledger.latestStepInput(SID), 3000, '旧会话的值不受新会话影响');

// ── 5. 生产故障形态：8 步 × ~30K 的正常一轮 ──────────────────────────────
ledger = freshLedger();
const SID8 = 'session-c';
for (let step = 1; step <= 8; step += 1) {
  ledger.ingestEvent({ sessionId: SID8, event: evMsg(100 + step, 1, step, AT + step * 1000, usage(10000, 40, 21000 + step)) });
}
const lastStep = 10000 + 21000 + 8;
eq(ledger.latestStepInput(SID8), lastStep, `8 步一轮：取最后一步 ${lastStep}`);
const turn8 = ledger.conversation(KEY, { turnLimit: 200 })?.turns?.[0]?.buckets ?? {};
const acc8 = (Number(turn8.cacheMiss) || 0) + (Number(turn8.cacheHit) || 0);
assert(acc8 > 60000, `对照：该轮累加 ${acc8} 已超 60000 阈值（旧口径下每一轮都会退役重建）`);
assert(ledger.latestStepInput(SID8) < 60000, '修好之后同一个正常轮次不会误触轮换阈值');

// ── 6. 跨重启与 compact 淘汰 ─────────────────────────────────────────────
const reloaded = createTokenLedger({ file: ledgerFile, priceTable: DEFAULT_PRICE_TABLE, resolveKey: () => KEY });
eq(reloaded.latestStepInput(SID8), lastStep, '重放落盘 journal 之后口径不变');

// 淘汰路径：samples 被 compact 掉之后，「最近一步」仍在内存里记得（这正是单独存一份的理由）
const evicting = freshLedger({ maxLines: 4 });
for (let step = 1; step <= 6; step += 1) {
  evicting.ingestEvent({ sessionId: 'session-d', event: evMsg(200 + step, 1, step, AT + step * 1000, usage(1000, 5, 40000)) });
}
assert(evicting.stats().samples <= 4, '逐轮明细确实被压到上限内（样本已淘汰）');
eq(evicting.latestStepInput('session-d'), 41000, 'compact 淘汰之后 latestStepInput 仍返回最近一步');

// ── 7. bridge.js 的接线（源码断言） ──────────────────────────────────────
const bridgePath = fileURLToPath(new URL('../src/bridge.js', import.meta.url));
const bridgeSrc = fs.readFileSync(bridgePath, 'utf8');
const fnAt = bridgeSrc.indexOf('function contextTokensOfKeyV2(key)');
assert(fnAt > 0, 'bridge.js 里找得到 contextTokensOfKeyV2');
const fnBody = fnAt > 0 ? bridgeSrc.slice(fnAt, fnAt + 900) : '';
assert(/const cur = tokenLedger\.latestStepInput\(sid\);/.test(fnBody), 'contextTokensOfKeyV2 用账本的 latestStepInput(sid) 取当前上下文');
assert(!/tokenLedger\.conversation\(/.test(fnBody), 'contextTokensOfKeyV2 不再读 conversation()（那是「一轮累加」的来源）');

console.log(failed ? '\n❌ test-context-rotation 有失败项' : '\n✅ test-context-rotation 全部通过');
process.exit(failed ? 1 : 0);
