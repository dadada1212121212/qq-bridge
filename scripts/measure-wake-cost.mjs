#!/usr/bin/env node
/**
 * 唤醒提示词分段成本测量。
 *
 * 为什么需要它
 * ============
 * 报告《聊天记录分析与DeepSeek特征优化-2026-10-12》第八节估算
 * 「记忆三件套 ≈1,900 token/轮 ≈ 23 万/天全价」，并建议调小
 * `recapMaxChars` / `memoryDb.maxChars`。但那是**估算**，不是实测。
 *
 * 在按估算动手之前，先把每一段的真实字符数量出来 ——
 * 改配置是不可逆地影响人格表现的，值得先确认「这一段到底占多少」。
 *
 * 方法：静态分析 `src/bridge.js` 里三段式组装处，把每个变量名对应的
 * **最大字符预算**抽出来。注意这只能给出预算上限，不是运行时实际值；
 * 但对「该不该调小某个配置」这个决策，预算已经是需要的那个数 ——
 * 因为配置项控制的正是上限。
 *
 * 运行：node scripts/measure-wake-cost.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRIDGE = path.join(ROOT, 'src', 'bridge.js');
const CONFIG = path.join(ROOT, 'config.json');

const src = fs.readFileSync(BRIDGE, 'utf8');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

/** 取 cfg.xxx.yyy 的值（支持默认值）。 */
function cfgVal(dotted, dflt) {
  let cur = cfg;
  for (const k of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object') return dflt;
    cur = cur[k];
  }
  return cur == null ? dflt : cur;
}

/** 从源码里抽 `const <name> = ...;` 的右侧表达式（到分号或空行）。 */
function assignmentRhs(name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*`);
  const m = re.exec(src);
  if (!m) return null;
  // 从 = 之后扫到顶层分号（粗略处理括号/模板字符串嵌套）
  let i = m.index + m[0].length;
  let depth = 0;
  let out = '';
  let inStr = null;
  while (i < src.length) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch; out += ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++; out += ch;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--; out += ch;
    } else if (ch === ';' && depth <= 0) {
      break;
    } else {
      out += ch;
    }
    i++;
  }
  return out.trim();
}

// 三段的分组（与 bridge.js 的 stableSeg / slowSeg / volatileSeg 保持一致）
const GROUPS = {
  stableSeg: ['cardLine', 'roleLine', 'personaLine', 'antiAiLine', 'countLine',
    'proactiveLine', 'stickerStrategyLine', 'memeLine', 'accountLine',
    'tokenLine', 'preSleepLine'],
  slowSeg: ['moeLine', 'wakeLine', 'recapLine', 'dbLine', 'diaryLine', 'styleLine'],
  volatileSeg: ['moodLine', 'moodMemoryLine', 'relationLine', 'statusLine', 'usageLine', 'stickerContextLine',
    'memoryLine', 'participationLine', 'recallLine', 'replyLine'],
};

/**
 * 每个段落对应的「配置上限」—— 这是真正可调的杠杆。
 * 值 = [配置路径, 当前值, 中文说明]。没有配置项的段标 null（写死在代码里）。
 */
const KNOBS = {
  recapLine: ['socialV2.context.recapMaxChars', '摘要回放'],
  dbLine: ['socialV2.memoryDb.maxChars', '长期记忆库'],
  memoryLine: [null, '本轮记忆注入（条数×每条上限）'],
  diaryLine: [null, '日记注入'],
  wakeLine: ['socialV2.context.wakeMaxChars', '被唤醒的对话原文'],
  stickerContextLine: [null, '表情上下文'],
  memeLine: [null, '梗图库注入'],
};

/** 粗略估算：中文字符 ≈ 1 token，ASCII ≈ 0.3 token。 */
function estTokens(text) {
  let cjk = 0, other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return Math.round(cjk + other * 0.3);
}

console.log('='.repeat(66));
console.log('唤醒提示词分段成本（静态预算分析）');
console.log('='.repeat(66));
console.log(`配置文件 wakeBudgetChars = ${cfgVal('socialV2.context.wakeBudgetChars', 9000)} 字`);
console.log();

let totalMax = 0;
for (const [group, names] of Object.entries(GROUPS)) {
  console.log(`【${group}】`);
  for (const n of names) {
    const rhs = assignmentRhs(n);
    const knob = KNOBS[n];
    let note = '';
    if (knob && knob[0]) {
      const v = cfgVal(knob[0], null);
      note = `  [配置 ${knob[0]} = ${v}]`;
    } else if (knob) {
      note = `  [${knob[1]}，无独立配置项]`;
    }
    const len = rhs ? rhs.length : 0;
    totalMax += len;
    console.log(`  ${n.padEnd(22)} 表达式 ${String(len).padStart(5)} 字符${note}`);
  }
  console.log();
}

// 记忆三件套单独拎出来（报告点名的优化对象）
console.log('-'.repeat(66));
console.log('报告点名的「记忆三件套」');
console.log('-'.repeat(66));
const trio = ['memoryLine', 'recapLine', 'dbLine'];
let trioLen = 0;
for (const n of trio) {
  const rhs = assignmentRhs(n);
  trioLen += rhs ? rhs.length : 0;
}
console.log(`  三者表达式合计 ${trioLen} 字符（不含运行时数据）`);
console.log();

console.log('-'.repeat(66));
console.log('可调杠杆（改这些配置能直接减提示词长度）');
console.log('-'.repeat(66));
const levers = [
  ['socialV2.context.recapMaxChars', 1600, '摘要回放上限'],
  ['socialV2.memoryDb.maxChars', 800, '长期记忆库上限'],
  ['socialV2.memoryDb.interestMaxChars', 420, '兴趣画像上限'],
  ['socialV2.context.wakeMaxChars', 1800, '唤醒原文上限'],
  ['socialV2.memoryDb.recallMaxChars', 300, '回忆上限'],
];
for (const [p, dflt, desc] of levers) {
  const v = cfgVal(p, dflt);
  // 估算该配置对 token 的贡献（按中文 1 字 ≈ 1 token 粗算）
  console.log(`  ${desc.padEnd(16)} ${p.padEnd(38)} = ${v}`);
}
console.log();
console.log('注：以上是**配置上限**，运行时实际值通常小于上限（取决于当日数据量）。');
console.log('    要看真实值，需在运行时打印分段长度 —— 见 scripts/probe-wake-cache.mjs');
