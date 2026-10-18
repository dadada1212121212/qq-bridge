#!/usr/bin/env node
/**
 * 轻量随机游戏测试。
 *
 * 重点验证三件事：
 *   1. **猜拳胜负视角不能反** —— 返回值里 outcome 是「从群友角度」说的，
 *      如果反了，她会把"我赢了"说成"你赢了"，在群里极其明显。
 *   2. **骰子范围与分布** —— 1d6 必须只出 1~6，且多次掷要有变化
 *      （不能因为实现 bug 恒定出同一个数）。
 *   3. **参数校验要真的拦得住** —— 非法输入必须抛错，而不是静默降级。
 *      静默降级会让"2d999999"这种请求变成一个看似正常的假结果。
 *
 * 运行：node scripts/test-light-games.mjs
 */

import assert from 'node:assert/strict';
import {
  rollDice, rockPaperScissors, drawFortune, flipCoin,
  playLightGame, renderLightGame,
} from '../src/light-games.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e?.message || e)); }
}
function throws(fn, re, note) {
  try { fn(); }
  catch (e) {
    if (re && !re.test(e.message)) {
      throw new Error(`${note || '异常信息不符'}：期望匹配 ${re}，实际「${e.message}」`);
    }
    return;
  }
  throw new Error(`${note || '本应抛错但没抛'}`);
}

console.log('='.repeat(60));
console.log('轻量随机游戏测试');
console.log('='.repeat(60));

console.log('\n【骰子】');
t('1d6 结果在 1~6', () => {
  for (let i = 0; i < 200; i++) {
    const r = rollDice('1d6');
    assert.equal(r.kind, 'dice');
    assert.equal(r.n, 1);
    assert.equal(r.faces, 6);
    assert.ok(r.total >= 1 && r.total <= 6, `越界：${r.total}`);
    assert.equal(r.rolls.length, 1);
  }
});
t('2d6 的 total 等于各颗之和，且范围 2~12', () => {
  for (let i = 0; i < 200; i++) {
    const r = rollDice('2d6');
    assert.equal(r.rolls.length, 2);
    assert.equal(r.total, r.rolls[0] + r.rolls[1]);
    assert.ok(r.total >= 2 && r.total <= 12, `越界：${r.total}`);
  }
});
t('d20（省略颗数）默认 1 颗', () => {
  const r = rollDice('d20');
  assert.equal(r.n, 1);
  assert.equal(r.faces, 20);
});
t('多次掷骰会出现不同结果（不是恒定值）', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(rollDice('1d6').total);
  assert.ok(seen.size >= 4, `只出现了 ${seen.size} 种结果，疑似恒定：${[...seen]}`);
});
t('默认参数（不传）是 1d6', () => {
  const r = rollDice();
  assert.equal(r.n, 1);
  assert.equal(r.faces, 6);
});
t('非法格式抛错：abc', () => { throws(() => rollDice('abc'), /格式不对/, 'abc 应报格式错'); });
t('非法格式抛错：d', () => { throws(() => rollDice('d'), /格式不对/); });
t('颗数超限抛错：21d6', () => { throws(() => rollDice('21d6'), /颗数/); });
t('骰面超限抛错：1d1000 可以，1d1001 不行', () => {
  rollDice('1d1000');                       // 边界内，不该抛
  throws(() => rollDice('1d1001'), /骰面/);
});
t('骰面下限：1d1 抛错（单面骰没意义）', () => { throws(() => rollDice('1d1'), /骰面/); });

console.log('\n【猜拳 —— 视角是重点】');
t('不给出拳时 outcome=unknown，她仍出自己的', () => {
  const r = rockPaperScissors();
  assert.equal(r.outcome, 'unknown');
  assert.ok(['石头', '剪刀', '布'].includes(r.her));
  assert.equal(r.mine, null);
});
t('平局判定正确', () => {
  for (const x of ['石头', '剪刀', '布']) {
    const r = rockPaperScissors(x, x);   // 指定她出同一拳 → 必平局
    assert.equal(r.outcome, 'draw', `同为 ${x} 应平局，得到 ${r.outcome}`);
  }
});
t('可以指定她出什么（群友说「你出剪刀」）', () => {
  const r = rockPaperScissors('石头', '剪刀');
  assert.equal(r.her, '剪刀');
  assert.equal(r.outcome, 'win', '石头赢剪刀 → 群友角度 win');
});
t('指定她出的拳若是非法值要抛错', () => {
  throws(() => rockPaperScissors('石头', '锤子'), /她出的拳/);
});
t('默认（不指定 hers）仍然是随机的', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(rockPaperScissors().her);
  assert.equal(seen.size, 3, `只出现 ${[...seen]}`);
});
t('★ 胜负视角：群友出石头、她出剪刀 → 从群友角度是 win', () => {
  // 直接构造：反复掷直到她出剪刀，然后用石头打她
  let checked = false;
  for (let i = 0; i < 500 && !checked; i++) {
    const probe = rockPaperScissors('石头');
    if (probe.her === '剪刀') {
      assert.equal(probe.outcome, 'win',
        '石头赢剪刀 → 从群友角度应是 win（群友赢）');
      checked = true;
    }
  }
  assert.ok(checked, '500 次都没掷出剪刀，随机源可疑');
});
t('★ 胜负视角：群友出剪刀、她出石头 → 从群友角度是 lose（她赢）', () => {
  let checked = false;
  for (let i = 0; i < 500 && !checked; i++) {
    const probe = rockPaperScissors('剪刀');
    if (probe.her === '石头') {
      assert.equal(probe.outcome, 'lose',
        '石头赢剪刀 → 从群友角度应是 lose（群友输=她赢）');
      checked = true;
    }
  }
  assert.ok(checked, '500 次都没掷出石头，随机源可疑');
});
t('英文缩写也能出（rock/scissors/paper）', () => {
  const r = rockPaperScissors('rock');
  assert.equal(r.mine, '石头');
});
t('单字也能出（石/剪/布）', () => {
  assert.equal(rockPaperScissors('石').mine, '石头');
  assert.equal(rockPaperScissors('剪').mine, '剪刀');
  assert.equal(rockPaperScissors('布').mine, '布');
});
t('非法出拳抛错', () => { throws(() => rockPaperScissors('锤子'), /石头\/剪刀\/布/); });
t('三种拳都会出现（随机源有效）', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(rockPaperScissors().her);
  assert.equal(seen.size, 3, `只出现了 ${[...seen]}`);
});

console.log('\n【抽签】');
t('默认池抽出的都在默认签列表里', () => {
  const ok = new Set(['大吉', '中吉', '小吉', '末吉', '吉', '平', '凶', '大凶']);
  for (let i = 0; i < 200; i++) {
    const r = drawFortune();
    assert.ok(ok.has(r.result), `出了池外的值：${r.result}`);
    assert.equal(r.custom, false);
  }
});
t('自定义池：只从给的选项里抽', () => {
  const pool = ['奶茶', '咖啡', '白开水'];
  for (let i = 0; i < 100; i++) {
    const r = drawFortune(pool);
    assert.ok(pool.includes(r.result));
    assert.equal(r.custom, true);
    assert.equal(r.poolSize, 3);
  }
});
t('自定义池会全部抽到（不是只出第一个）', () => {
  const pool = ['A', 'B', 'C', 'D', 'E'];
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(drawFortune(pool).result);
  assert.equal(seen.size, 5, `只抽到 ${[...seen]}`);
});
t('空池抛错', () => { throws(() => drawFortune([]), /空/); });
t('全是空白的池抛错', () => { throws(() => drawFortune(['', '  ']), /没有有效选项/); });
t('超 100 项抛错', () => {
  throws(() => drawFortune(Array.from({ length: 101 }, (_, i) => 'x' + i)), /最多 100/);
});
t('默认池会给出稀有度标注', () => {
  let sawRarity = false;
  for (let i = 0; i < 500; i++) {
    const r = drawFortune();
    if (r.rarity) { sawRarity = true; break; }
  }
  assert.ok(sawRarity, '500 次都没抽到大吉或凶，权重可疑');
});

console.log('\n【投币】');
t('只出正面或反面，且两种都出现', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const r = flipCoin();
    assert.ok(['正面', '反面'].includes(r.result));
    seen.add(r.result);
  }
  assert.equal(seen.size, 2, `只出现 ${[...seen]}`);
});

console.log('\n【统一入口】');
t('中英文别名都能路由', () => {
  assert.equal(playLightGame('dice').kind, 'dice');
  assert.equal(playLightGame('roll').kind, 'dice');
  assert.equal(playLightGame('骰子').kind, 'dice');
  assert.equal(playLightGame('rps').kind, 'rps');
  assert.equal(playLightGame('猜拳').kind, 'rps');
  assert.equal(playLightGame('fortune').kind, 'fortune');
  assert.equal(playLightGame('抽签').kind, 'fortune');
  assert.equal(playLightGame('coin').kind, 'coin');
  assert.equal(playLightGame('投币').kind, 'coin');
});
t('大小写不敏感', () => {
  assert.equal(playLightGame('DICE').kind, 'dice');
  assert.equal(playLightGame('RPS').kind, 'rps');
});
t('未知游戏抛错并列出支持项', () => {
  throws(() => playLightGame('麻将'), /不认识的游戏.*dice/s);
});
t('参数正确透传（spec / mine / pool）', () => {
  assert.equal(playLightGame('dice', { spec: '3d8' }).n, 3);
  assert.equal(playLightGame('rps', { mine: '石头' }).mine, '石头');
  assert.equal(playLightGame('fortune', { pool: ['X'] }).result, 'X');
});

console.log('\n【渲染文案】');
t('骰子单颗与多颗文案不同', () => {
  const one = renderLightGame({ kind: 'dice', n: 1, faces: 6, rolls: [5], total: 5 });
  const two = renderLightGame({ kind: 'dice', n: 2, faces: 6, rolls: [3, 4], total: 7 });
  assert.match(one, /掷出了 5/);
  assert.match(two, /各颗：3 \+ 4/);
});
t('★ 猜拳文案明确标注视角，避免模型说反', () => {
  const win = renderLightGame({ kind: 'rps', her: '剪刀', mine: '石头', outcome: 'win' });
  assert.match(win, /对方赢/, 'outcome=win 必须渲染成"对方赢"');
  const lose = renderLightGame({ kind: 'rps', her: '石头', mine: '剪刀', outcome: 'lose' });
  assert.match(lose, /她赢/, 'outcome=lose 必须渲染成"她赢"');
});
t('抽签文案带稀有度与自定义标注', () => {
  const s = renderLightGame({ kind: 'fortune', result: '大吉', rarity: '极稀有', custom: false, poolSize: 12 });
  assert.match(s, /大吉/);
  assert.match(s, /极稀有/);
  const c = renderLightGame({ kind: 'fortune', result: '奶茶', rarity: null, custom: true, poolSize: 3 });
  assert.match(c, /自定义的 3 个选项/);
});
t('投币文案', () => {
  assert.match(renderLightGame({ kind: 'coin', result: '正面' }), /正面/);
});

console.log('\n' + '='.repeat(60));
console.log(`通过 ${pass}，失败 ${fail}`);
console.log('='.repeat(60));
process.exit(fail ? 1 : 0);
