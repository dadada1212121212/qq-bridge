#!/usr/bin/env node
// 一次性工具：把「产物 patch 里被手改、但权威源没跟上」的人设提示词回填进源。
//
// 方向：产物（plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml，DSH 实际加载、也是线上生效的那份）
//       是正确文本 → 回填进源（dsh/agent-presets/qq-chat-v2/agent.cordis.yml 的 persona.config.prefix）。
// 做法：解析源的 prefix（>- 折叠标量）建立「折叠值下标 → 原始行/列」映射；对源值与产物值逐逻辑行做
//       字符级 LCS diff 得到最小差异片段；把片段端点映射回原始字符区间，做最小替换，不动任何格式。
// 校验：① 写回后重新解析，persona.prefix 与产物逐字相同；② 除 persona 行外结构完全不变；
//       ③ renderPatch() 与磁盘产物字节相同（→ --check 必然转绿）。
//
// 用法：node scripts/_sync-preset-source.mjs            # 预演（不改文件）
//       node scripts/_sync-preset-source.mjs --write    # 写入
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { renderPatch, patchFileFor, REPO_ROOT } from './build-agent-preset-patches.mjs';

const PRESET = 'qq-chat-v2';
const WRITE = process.argv.includes('--write');
const SRC = path.join(REPO_ROOT, 'dsh', 'agent-presets', PRESET, 'agent.cordis.yml');
const PROD = patchFileFor(PRESET);

const die = (msg) => { console.error(`[sync] ERROR ${msg}`); process.exit(1); };
const show = (s, n = 90) => (s.length > n ? `${s.slice(0, n)}…(${s.length} 字)` : s);
const stripCR = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line);

// ---- 0. 读源/产物 ----
const rawText = fs.readFileSync(SRC, 'utf8');
const rawLines = rawText.split('\n');
const doc = yaml.load(rawText);
const srcPersona = doc.find((r) => r && r.id === 'persona');
if (!srcPersona) die('源里找不到 persona 行');
const P = srcPersona.config.prefix;

const prodText = fs.readFileSync(PROD, 'utf8');
const prodDoc = yaml.load(prodText);
const prodPersona = prodDoc[0].insert[0].config.plugins.find((r) => r && r.id === 'persona');
const Q = prodPersona.config.prefix;
if (P === Q) { console.log('[sync] 源与产物已一致，无需改动'); process.exit(0); }

// ---- 1. 定位 prefix 折叠块，重建折叠值并建立下标→(行,列)映射 ----
const keyLine = rawLines.findIndex((l) => /^\s*prefix:\s*>[-+]?\s*$/.test(l));
if (keyLine < 0) die('源里找不到 `prefix: >-` 行');
let first = keyLine + 1;
while (first < rawLines.length && stripCR(rawLines[first]).trim() === '') first++;
const contentIndent = stripCR(rawLines[first]).match(/^(\s*)/)[1].length;
let blockEnd = keyLine + 1;
for (let i = keyLine + 1; i < rawLines.length; i++) {
  const line = stripCR(rawLines[i]);
  if (line.trim() === '') { blockEnd = i + 1; continue; }
  const indent = line.match(/^(\s*)/)[1].length;
  if (indent < contentIndent) break;
  if (indent > contentIndent) die(`prefix 块第 ${i + 1} 行缩进更深（literal 段），本工具不支持`);
  blockEnd = i + 1;
}
const segs = [];
for (let i = keyLine + 1; i < blockEnd; i++) {
  const line = stripCR(rawLines[i]);
  if (line.trim() === '') segs.push({ blank: true });
  else segs.push({ text: line.slice(contentIndent), line: i, col: contentIndent });
}
while (segs.length && segs[0].blank) segs.shift();
while (segs.length && segs[segs.length - 1].blank) segs.pop();

let fold = '';
const map = []; // 折叠值每个字符 → {line, col}；折叠分隔符处为 null
let seen = 0; let blanks = 0;
for (const seg of segs) {
  if (seg.blank) { blanks++; continue; }
  if (seen > 0) {
    const sep = blanks > 0 ? '\n'.repeat(blanks) : ' ';
    fold += sep;
    for (let k = 0; k < sep.length; k++) map.push(null);
  }
  seen++; blanks = 0;
  for (let k = 0; k < seg.text.length; k++) { fold += seg.text[k]; map.push({ line: seg.line, col: seg.col + k }); }
}
if (fold !== P) die(`自建折叠值与解析值不一致（${fold.length} vs ${P.length}）——折叠规则假设错误`);
console.log(`[sync] prefix ${P.length} 字；块在源文件第 ${keyLine + 2}–${blockEnd} 行；折叠映射校验通过`);

// ---- 2. 字符级 LCS diff（逐逻辑行），取最小差异片段 ----
function lcsHunks(o, n) {
  const N = o.length; const M = n.length; const W = M + 1;
  const dp = new Int32Array((N + 1) * W);
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      dp[i * W + j] = o[i] === n[j]
        ? dp[(i + 1) * W + j + 1] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const hunks = [];
  let cur = null;
  const flush = () => { if (cur && (cur.oEnd > cur.oStart || cur.nEnd > cur.nStart)) hunks.push(cur); cur = null; };
  let i = 0; let j = 0;
  while (i < N && j < M) {
    if (o[i] === n[j]) { flush(); i++; j++; continue; }
    if (!cur) cur = { oStart: i, oEnd: i, nStart: j, nEnd: j };
    if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { i++; cur.oEnd = i; } else { j++; cur.nEnd = j; }
  }
  if (i < N || j < M) {
    if (!cur) cur = { oStart: i, oEnd: N, nStart: j, nEnd: M };
    else { cur.oEnd = N; cur.nEnd = M; }
  }
  flush();
  return hunks.map((h) => ({ oStart: h.oStart, oEnd: h.oEnd, nText: n.slice(h.nStart, h.nEnd) }));
}

const a = P.split('\n'); const b = Q.split('\n');
if (a.length !== b.length) die(`源/产物行数不同（${a.length} vs ${b.length}），本工具只处理同构差异`);
const lineStart = []; { let acc = 0; for (const line of a) { lineStart.push(acc); acc += line.length + 1; } }

const regions = [];
for (let n = 0; n < a.length; n++) {
  if (a[n] === b[n]) continue;
  for (const h of lcsHunks(a[n], b[n])) {
    const start = lineStart[n] + h.oStart;
    const endEx = lineStart[n] + h.oEnd; // 独占
    let from = null; let to = null;
    if (endEx > start) {
      if (map[start] === null || map[endEx - 1] === null) die(`第 ${n + 1} 行差异落在折叠分隔符上，无法安全映射`);
      from = map[start]; to = map[endEx - 1];
    } else {
      // 纯插入：插在 map[start] 那个字符之前；若在逻辑行末尾，则插在最后一个字符之后
      const at = start < map.length ? map[start] : null;
      if (at) { from = at; to = { line: at.line, col: at.col - 1 }; }
      else {
        const prev = map[start - 1];
        if (!prev) die(`第 ${n + 1} 行插入点无法映射`);
        from = { line: prev.line, col: prev.col + 1 };
        to = prev;
      }
    }
    regions.push({ line: n + 1, oldFrag: a[n].slice(h.oStart, h.oEnd), nText: h.nText, from, to });
  }
}

// ---- 3. 映射到整份文件的字符区间并替换 ----
const lineOffset = []; { let acc = 0; for (const line of rawLines) { lineOffset.push(acc); acc += line.length + 1; } }
for (const r of regions) {
  r.fromOff = lineOffset[r.from.line] + r.from.col;
  r.toOff = lineOffset[r.to.line] + r.to.col;
  if (r.toOff < r.fromOff - 1) die('区间方向异常');
  console.log(`\n[sync] 第 ${r.line} 行差异 → 源文件 ${r.from.line + 1}:${r.from.col + 1} … ${r.to.line + 1}:${r.to.col + 1}`);
  console.log(`  旧: ${show(r.oldFrag)}`);
  console.log(`  新: ${show(r.nText)}`);
}

let out = rawText;
for (const r of [...regions].sort((x, y) => y.fromOff - x.fromOff)) {
  out = out.slice(0, r.fromOff) + r.nText + out.slice(r.toOff + 1);
}

// ---- 4. 校验 ----
const reparsed = yaml.load(out);
const newPersona = reparsed.find((r) => r && r.id === 'persona');
if (newPersona.config.prefix !== Q) die('回填后源的 prefix 仍与产物不同');
const shape = (rows) => JSON.stringify(rows.map((r) => (r && r.id === 'persona'
  ? { ...r, config: { ...r.config, prefix: '<prefix>' } }
  : r)));
if (shape(doc) !== shape(reparsed)) die('除 persona.prefix 外的其它内容被改动');

if (!WRITE) { console.log('\n[sync] 预演通过（未写文件）。加 --write 落盘。'); process.exit(0); }
fs.writeFileSync(SRC, out, 'utf8');
const rerender = renderPatch(PRESET);
if (rerender !== prodText) {
  fs.writeFileSync(SRC, rawText, 'utf8');
  die(`重新渲染与产物不逐字节相同（${rerender.length} vs ${prodText.length}）——已回滚源文件`);
}
console.log(`\n[sync] 已写入 ${path.relative(REPO_ROOT, SRC)}：prefix 与产物逐字相同、其它结构未变、renderPatch() 与产物字节相同。`);
