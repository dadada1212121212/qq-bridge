#!/usr/bin/env node
/**
 * 运行时唤醒提示词分段实测。
 *
 * 与 measure-wake-cost.mjs 的区别
 * ==============================
 * `measure-wake-cost.mjs` 是**静态**分析（读源码量表达式长度），
 * 只能给出配置上限。这个脚本用 harness 真正调用一次
 * `buildWakePromptV2`，拿到**运行时真实字符数** —— 才知道该砍哪一段。
 *
 * 为什么必须实测：`recapLine` / `dbLine` / `memoryLine` 都是函数调用
 * （`memoryDb.buildDigest(...)` / `formatMemoryV2(st)` 等）返回的，
 * 长度取决于当时的记忆数据量，看源码看不出来。
 *
 * 运行：
 *   node scripts/probe-wake-cost.mjs            # 群聊场景
 *   node scripts/probe-wake-cost.mjs --key private:10001
 */

import { bridgeHarness } from './audit-bridge-harness.mjs';

const argv = process.argv.slice(2);
const keyArgIdx = argv.indexOf('--key');
const KEY = keyArgIdx >= 0 ? argv[keyArgIdx + 1] : 'group:456';

/** 把提示词按已知的分段标记切开，得到 [{tag, len}]。
 *
 * ⚠️ 为什么用「标记切分」而不是去调内部变量：分段变量在
 * `buildWakePromptV2` 的闭包内，外部拿不到。而提示词里每段都有
 * 明确的中文标题（【人设速记】【会话令牌】…），按标题切分既能拿到
 * 真实长度，又**不依赖内部实现**（改代码不会让脚本失效）。
 */
function segment(prompt) {
  // 找所有 "【...】" 标题的位置，按位置切段
  const re = /【[^】]{1,20}】/g;
  const hits = [];
  let m;
  while ((m = re.exec(prompt)) !== null) {
    hits.push({ at: m.index, title: m[0] });
  }
  if (hits.length === 0) return [];
  const segs = [];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].at;
    const end = i + 1 < hits.length ? hits[i + 1].at : prompt.length;
    // ⚠️ 必须在这里就把文本存下来。早先版本只存 len，后面按排序结果
    // 去 `prompt.slice(0, s.len)` 算 token —— 那是错的：排序后 len 与
    // 原文位置不再对应，切出来的是**完全无关的一段**。宁可多存一份文本。
    const text = prompt.slice(start, end);
    segs.push({ title: hits[i].title, len: text.length, text });
  }
  return segs;
}

function estTokens(text) {
  let cjk = 0, other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return Math.round(cjk + other * 0.3);
}

const h = await bridgeHarness({
  config: {
    socialV2: {
      wake: { preSleepWaitEnabled: false },
      wait: { minMs: 100, maxMs: 2000, minQuietAfterNewMs: 0 },
      proactive: { enabled: true },
      sticker: { enabled: true },
    },
  },
});
h.setMode('reserved2');
const st = h.getSocialV2State(KEY);

// 塞一些假消息，让「被唤醒的对话原文」段有内容
try {
  h.seedMessages?.(KEY, [
    { seq: 1, sender: '群友A', text: '今天天气不错啊' },
    { seq: 2, sender: '群友B', text: '是啊，适合出去玩' },
    { seq: 3, sender: '群友A', text: '大肥鱼在吗' },
  ]);
} catch { /* harness 可能不提供 seedMessages，忽略 */ }

let prompt = '';
for (const reason of ['replyCheck', 'proactiveCheck', 'timeout', 'poke']) {
  try {
    prompt = await h.buildWakePromptV2(KEY, reason);
    if (prompt && prompt.length > 200) break;
  } catch (e) {
    console.error(`  构建(${reason}) 失败：${e?.message || e}`);
  }
}

console.log('='.repeat(66));
console.log(`唤醒提示词运行时实测  key=${KEY}`);
console.log('='.repeat(66));
if (!prompt) {
  console.log('⚠️ 没能构建出提示词（harness 环境可能不完整）');
  process.exit(1);
}

console.log(`总长度 ${prompt.length} 字  估算 ${estTokens(prompt)} token`);
console.log();
const segs = segment(prompt);
if (segs.length === 0) {
  console.log('（未识别到分段标记，打印前 600 字）');
  console.log(prompt.slice(0, 600));
} else {
  console.log('按长度排序的分段：');
  console.log('  ' + '段落'.padEnd(18) + '字符'.padStart(6)
    + '占比'.padStart(8) + '估算token'.padStart(10));
  for (const s of segs.sort((a, b) => b.len - a.len)) {
    const pct = ((s.len / prompt.length) * 100).toFixed(1) + '%';
    console.log('  ' + s.title.padEnd(18) + String(s.len).padStart(6)
      + pct.padStart(8) + String(estTokens(s.text)).padStart(10));
  }
}
console.log();
console.log('注：token 估算按「中文 1 字 ≈ 1 token、ASCII ≈ 0.3 token」粗算，');
console.log('    实际以 DeepSeek 分词为准（实测 step=1 的 cacheMiss 可作校准参考）。');
