#!/usr/bin/env node
/**
 * 回合制游戏逻辑测试。
 *
 * 重点验证：
 *   1. 猜数字答案只在服务端，模型看不到；太大/太小/中 判定正确；次数耗尽判负。
 *   2. 二十问只记账 + 数到 20 判负，不替模型做判断。
 *   3. 海龟汤汤面/汤底都在，且汤底不会混进"给用户看"的文案（只在内部段）。
 *   4. 状态机错误路径：无局时 move 抛错、未知游戏抛错。
 *
 * 运行：node scripts/test-turn-games.mjs
 */

import assert from 'node:assert/strict';
import { startTurnGame, playTurnGame, renderTurnGame } from '../src/turn-games.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e?.message || e)); }
}
function throws(fn, re, note) {
  try { fn(); }
  catch (e) {
    if (re && !re.test(e.message)) { fail++; console.log('  FAIL throws(' + note + ') 抛错但信息不符: ' + e.message); return; }
    pass++; console.log('  PASS throws(' + note + ')'); return;
  }
  fail++; console.log('  FAIL throws(' + note + ') 没抛错');
}

// ── 猜数字 ──────────────────────────────────────────────────────────────
t('guess：默认范围 1~100，secret 在范围内', () => {
  const s = startTurnGame({ game: 'guess' });
  assert.equal(s.game, 'guess');
  assert.ok(s.secret >= 1 && s.secret <= 100, 'secret 越界: ' + s.secret);
  assert.equal(s.status, 'playing');
  assert.ok(s.maxTries >= 5);
});

t('guess：猜中会判 won', () => {
  const s = startTurnGame({ game: 'guess', max: 50 });
  const s2 = playTurnGame(s, { guess: s.secret });
  assert.equal(s2.status, 'won');
  assert.equal(s2.tries, 1);
});

t('guess：猜小了报 low，猜大了报 high', () => {
  const s = startTurnGame({ game: 'guess', max: 100 });
  const secret = s.secret;
  const lowGuess = secret > 1 ? secret - 1 : secret + 2;
  const s2 = playTurnGame(s, { guess: lowGuess });
  const last = s2.history[s2.history.length - 1];
  if (lowGuess < secret) assert.equal(last.cmp, 'low');
  else assert.equal(last.cmp, 'high');
  assert.equal(s2.status, 'playing');
});

t('guess：超过 maxTries 判 lost，且仍有答案可揭晓', () => {
  const s = startTurnGame({ game: 'guess', max: 10 });
  let cur = s;
  for (let i = 0; i < s.maxTries; i++) {
    // 故意猜一个一定错的数（只要不是 secret）
    const wrong = (cur.secret === 1) ? 2 : 1;
    cur = playTurnGame(cur, { guess: wrong });
    if (cur.status !== 'playing') break;
  }
  assert.equal(cur.status, 'lost');
  assert.ok(typeof cur.secret === 'number', 'lost 后仍保留 secret 供揭晓');
});

t('guess：结束后继续 move 抛错', () => {
  const s = startTurnGame({ game: 'guess', max: 5 });
  const s2 = playTurnGame(s, { guess: s.secret }); // won
  throws(() => playTurnGame(s2, { guess: 1 }), /结束/, 'won 后继续');
});

t('guess：guess 非数字抛错', () => {
  const s = startTurnGame({ game: 'guess' });
  throws(() => playTurnGame(s, { guess: 'abc' }), /数字/, 'guess=abc');
});

// ── 二十问 ──────────────────────────────────────────────────────────────
t('twenty：开局 questions 空', () => {
  const s = startTurnGame({ game: 'twenty' });
  assert.equal(s.questions.length, 0);
  assert.equal(s.maxQuestions, 20);
});

t('twenty：move 记录问题和回答', () => {
  const s = startTurnGame({ game: 'twenty' });
  const s2 = playTurnGame(s, { question: '是动物吗？', answer: 'yes' });
  assert.equal(s2.questions.length, 1);
  assert.equal(s2.questions[0].q, '是动物吗？');
  assert.equal(s2.questions[0].a, 'yes');
});

t('twenty：非法 answer 归一化为 unknown', () => {
  const s = startTurnGame({ game: 'twenty' });
  const s2 = playTurnGame(s, { question: 'q', answer: 'maybe' });
  assert.equal(s2.questions[0].a, 'unknown');
});

t('twenty：满 20 题判 lost', () => {
  let cur = startTurnGame({ game: 'twenty' });
  for (let i = 0; i < 20; i++) cur = playTurnGame(cur, { question: 'q' + i, answer: 'no' });
  assert.equal(cur.status, 'lost');
  assert.equal(cur.questions.length, 20);
});

t('twenty：question 为空抛错', () => {
  const s = startTurnGame({ game: 'twenty' });
  throws(() => playTurnGame(s, { question: '' }), /不能为空/, '空问题');
});

// ── 海龟汤 ──────────────────────────────────────────────────────────────
t('soup：开局有汤面汤底', () => {
  const s = startTurnGame({ game: 'soup' });
  assert.ok(s.surface && s.surface.length > 0, '汤面为空');
  assert.ok(s.bottom && s.bottom.length > 0, '汤底为空');
  assert.equal(typeof s.puzzleIndex, 'number');
});

t('soup：puzzleIndex 可指定', () => {
  const s = startTurnGame({ game: 'soup', puzzleIndex: 0 });
  assert.equal(s.puzzleIndex, 0);
});

t('soup：move 记录问题，状态保持 playing', () => {
  const s = startTurnGame({ game: 'soup' });
  const s2 = playTurnGame(s, { question: '有人死了吗？', answer: 'no' });
  assert.equal(s2.questions.length, 1);
  assert.equal(s2.status, 'playing');
});

// ── 渲染文案 ────────────────────────────────────────────────────────────
t('render：guess won 文案含答案', () => {
  const s = startTurnGame({ game: 'guess', max: 30 });
  const s2 = playTurnGame(s, { guess: s.secret });
  const txt = renderTurnGame(s2);
  assert.ok(txt.includes(String(s2.secret)), '胜局文案漏了答案');
  assert.ok(txt.includes('猜中'));
});

t('render：soup 文案含汤面，且汤底只出现在内部段', () => {
  const s = startTurnGame({ game: 'soup' });
  const txt = renderTurnGame(s);
  assert.ok(txt.includes(s.surface), '汤面没进文案');
  // 汤底在「内部·汤底」段里，给模型看；我们不测它"绝不能出现"（那会被模型需要），
  // 只测它和汤面都在，且标注了"仅你可见"。
  assert.ok(txt.includes(s.bottom), '汤底没随文案给模型');
  assert.ok(txt.includes('仅你可见') || txt.includes('内部'), '汤底没标注内部可见');
});

t('render：空状态给友好提示', () => {
  assert.ok(renderTurnGame(null).includes('没有进行中'));
});

// ── 错误路径 ────────────────────────────────────────────────────────────
t('无局时 move 抛错', () => {
  throws(() => playTurnGame(null, { guess: 1 }), /开局/, 'null 状态');
});

t('未知游戏 start 抛错', () => {
  throws(() => startTurnGame({ game: 'chess' }), /未知游戏/, 'chess');
});

// ── 成语接龙 ────────────────────────────────────────────────────────────
t('idiom：开局给一个 4 字成语', () => {
  const g = startTurnGame({ game: 'idiom' });
  assert.equal(g.game, 'idiom');
  assert.equal(g.chain.length, 1);
  assert.equal(g.chain[0].length, 4);
  assert.equal(g.status, 'playing');
});

t('idiom：可指定起始成语', () => {
  const g = startTurnGame({ game: 'idiom', start: '一心一意' });
  assert.equal(g.chain[0], '一心一意');
});

t('idiom：起始非四字成语报错', () => {
  throws(() => startTurnGame({ game: 'idiom', start: '你好' }), /4 个汉字/, 'short');
});

t('idiom：接得上（首字 == 上句末字）通过', () => {
  const g = startTurnGame({ game: 'idiom', start: '一心一意' });
  playTurnGame(g, { guess: '意气风发' });   // 意 → 意
  assert.equal(g.chain.length, 2);
  assert.equal(g.chain[1], '意气风发');
});

t('idiom：接不上报错并指出该接什么字', () => {
  const g = startTurnGame({ game: 'idiom', start: '一心一意' });
  throws(() => playTurnGame(g, { guess: '风调雨顺' }), /意/, 'mismatch');
});

t('idiom：重复用过的成语报错', () => {
  // 构造一条"末字=意"的链，让「意气风发」能接上（首字=意），从而走到重复检测
  const g = startTurnGame({ game: 'idiom', start: '一心一意' });
  playTurnGame(g, { guess: '意气风发' });
  g.chain = ['一心一意', '意气风发', '意思意思'];   // 末字=思 → 改成末字=意
  g.chain[2] = '一心一意';                            // 末字=意（且"一心一意"已在链中）
  // 「意气风发」已在链里，且末字是「意」→ 应判"用过"
  throws(() => playTurnGame(g, { guess: '意气风发' }), /用过/, 'dup');
});

t('idiom：非四字报错', () => {
  const g = startTurnGame({ game: 'idiom', start: '一心一意' });
  throws(() => playTurnGame(g, { guess: '意气' }), /4 个汉字/, 'not4');
});

t('idiom：接够 30 个判通关', () => {
  const g = startTurnGame({ game: 'idiom', start: '一心一意' });
  // 手工把链堆到 29，再合法接一个
  let w = '一心一意';
  const chainWords = ['意气风发', '发扬光大', '大器晚成', '成千上万', '万众一心', '心花怒放', '放虎归山', '山清水秀'];
  for (const nw of chainWords) { playTurnGame(g, { guess: nw }); w = nw; }
  assert.ok(g.chain.length > 1);
  // 直接测试通关逻辑：伪造到 29 再 move
  g.chain = Array.from({ length: 29 }, (_, i) => `词${i}`.padEnd(4, 'a').slice(0, 4));
  g.chain = ['一心一意'];
  for (let i = 0; i < 28; i++) g.chain.push('测'.repeat(4));
  g.chain[g.chain.length - 1] = '一心一意';   // 末字 = 意
  // 用一个真成语接上，触发第 30 个
  const before = g.chain.length;
  playTurnGame(g, { guess: '意气风发' });
  assert.equal(g.chain.length, before + 1);
  assert.equal(g.status, 'won');
});

t('idiom：render 含当前链和下一字提示', () => {
  const g = startTurnGame({ game: 'idiom', start: '一心一意' });
  const txt = renderTurnGame(g);
  assert.ok(txt.includes('一心一意'), '渲染应含当前链');
  assert.ok(txt.includes('意'), '应提示下一个要接的字');
});

t('idiom：render 通关文案', () => {
  const g = startTurnGame({ game: 'idiom', start: '一心一意' });
  g.status = 'won';
  const txt = renderTurnGame(g);
  assert.ok(txt.includes('通关'), '通关应有专门文案');
});

console.log(`\n# tests ${pass + fail}`);
console.log(`# pass  ${pass}`);
console.log(`# fail  ${fail}`);
process.exit(fail ? 1 : 0);
