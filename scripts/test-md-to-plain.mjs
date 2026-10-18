// md-to-plain 纯函数回归测试（不依赖 SnowLuma / DSH / QQ）。
// 用法：node scripts/test-md-to-plain.mjs
import { mdToPlain, splitForQQ, truncateText, truncateTextTail, stripLoneSurrogates } from '../src/md-to-plain.js';

let failed = 0;
const assert = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// ── mdToPlain ────────────────────────────────────────────────────────────
assert('代码块去围栏（含语言标注）', mdToPlain('a\n```js\nconsole.log(1)\n```\nb') === 'a\nconsole.log(1)\nb');
assert('行内代码', mdToPlain('use `npm i` now') === 'use npm i now');
assert('链接保留文字+地址', mdToPlain('[docs](https://x.com/a)') === 'docs (https://x.com/a)');
assert('图片保留替代文字', mdToPlain('![logo](https://x.com/l.png)') === 'logo');
assert('粗体/斜体/删除线', mdToPlain('**bold** *it* ~~del~~') === 'bold it del');
assert('标题符', mdToPlain('# 标题\n## 二级') === '标题\n二级');
assert('引用符', mdToPlain('> 引用') === '引用');
assert('列表符', mdToPlain('- 甲\n- 乙\n1. 丙') === '• 甲\n• 乙\n1. 丙');

// ── splitForQQ ───────────────────────────────────────────────────────────
// 长 emoji 文本：不允许切断代理对
const emoji = '😀'.repeat(3000);
const parts = splitForQQ(emoji, 4000);
assert('emoji 长文本被切分', parts.length > 1);
assert('emoji 无断裂代理对', parts.every((p) => {
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) return i + 1 < p.length && p.charCodeAt(i + 1) >= 0xDC00 && p.charCodeAt(i + 1) <= 0xDFFF;
  }
  return true;
}));
assert('emoji 内容完整保留', parts.join('') === emoji);

// 长行文本：换行处切断时换行符必须保留（拼接后与原文一致）
const lines = 'abc\n'.repeat(2000);
const parts2 = splitForQQ(lines, 4000);
assert('换行切分', parts2.length > 1);
assert('换行内容完整保留', parts2.join('') === lines);

// 混合内容
const mixed = ('第一行内容😀\n第二行内容🀄\n'.repeat(1000)) + '尾部';
assert('混合内容完整保留', splitForQQ(mixed, 4000).join('') === mixed);

// 短文本不切
assert('短文本不切分', splitForQQ('你好世界', 4000).length === 1);

// ── 代理对安全：truncateText / truncateTextTail / stripLoneSurrogates ────────
// 背景（见 QQ-接入进度与下一步.md §0.21）：裸 slice 按 UTF-16 码元切，切在 emoji 中间会留下
// 「孤代理项」，JSON.stringify 把它写成 "\ud83d" 发给 DeepSeek ⇒ 400；且它会被存进会话帧，
// 之后每一步重发历史都再 400（换新会话也没用）。这组断言就是钉死这条线。
const hasLoneSurrogate = (s) => {
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = str.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      const p = str.charCodeAt(i - 1);
      if (!(p >= 0xd800 && p <= 0xdbff)) return true;
    }
  }
  return false;
};

// 反面断言：先证明「旧写法真的会切坏」，否则这组测试可能只是因为样例没踩中而空过。
const pairAt = 'a'.repeat(35) + '😀' + 'b'.repeat(10); // 第 36 个码元正好是高代理
assert('反面：裸 slice(0,36)+… 会切出孤代理项', hasLoneSurrogate(pairAt.slice(0, 36) + '…'));
assert('truncateText 不切出孤代理项', !hasLoneSurrogate(truncateText(pairAt, 36)));
assert('truncateText 该丢就丢（长度为 35）', truncateText(pairAt, 36) === 'a'.repeat(35));
assert('truncateText 不切出孤代理项（切点在一对中间）', !hasLoneSurrogate(truncateText(pairAt, 37)));
assert('truncateText 保留完整 emoji', truncateText(pairAt, 37).endsWith('😀'));
assert('truncateText 短文本原样返回', truncateText('abc', 10) === 'abc');
assert('truncateText 非有限上限返回空串（与 slice 一致）', truncateText('abc', NaN) === '');
assert('truncateText 开头就是代理对时至少留一个完整码点', truncateText('😀😀😀', 1) === '😀');
assert('truncateText 纯 BMP 与 slice 完全一致', truncateText('x'.repeat(100), 36) === 'x'.repeat(36));

assert('truncateTextTail 不切出孤代理项（切点落在低代理）', !hasLoneSurrogate(truncateTextTail('😀' + 'x'.repeat(5), 6)));
assert('truncateTextTail 保住整对（宁可多一个码元）', truncateTextTail('😀' + 'x'.repeat(5), 6) === '😀' + 'x'.repeat(5));
assert('truncateTextTail 不切出孤代理项（切点落在高代理）', !hasLoneSurrogate(truncateTextTail('x'.repeat(5) + '😀', 2)));
assert('truncateTextTail 短文本原样返回', truncateTextTail('abc', 10) === 'abc');

assert('stripLoneSurrogates 丢掉孤高代理', stripLoneSurrogates('a\ud83db') === 'ab');
assert('stripLoneSurrogates 丢掉孤低代理', stripLoneSurrogates('a\ude00b') === 'ab');
assert('stripLoneSurrogates 保留完整代理对', stripLoneSurrogates('a😀b') === 'a😀b');
assert('stripLoneSurrogates 修掉真实坏样本（✋+半 emoji+…）', stripLoneSurrogates('✋\ud83d…') === '✋…');
assert('stripLoneSurrogates 幂等', (() => {
  const bad = '🍚🍚🍚🍚\ud83c…后面还有字';
  const once = stripLoneSurrogates(bad);
  return once === stripLoneSurrogates(once) && !hasLoneSurrogate(once) && once === '🍚🍚🍚🍚…后面还有字';
})());
assert('stripLoneSurrogates 空/非字符串输入安全', stripLoneSurrogates(null) === '' && stripLoneSurrogates(123) === '123');
assert('stripLoneSurrogates 对干净文本零改动', stripLoneSurrogates(mixed) === mixed);
// 整条链路：坏文本 → truncateText/strip 洗过之后，JSON 里不再出现半个字符的转义
const poisoned = '【上次聊到哪（跨会话回放）】\n我: ' + pairAt.slice(0, 36) + '…';
assert('洗过的提示词 JSON 里没有孤代理转义', !/"\\u(d[89ab][0-9a-f]{2})"/i.test(JSON.stringify(stripLoneSurrogates(poisoned))) || !hasLoneSurrogate(stripLoneSurrogates(poisoned)));

// 穷举性质：拿「真的把线上搞挂过」的那几条消息，穷举每一个截断长度，两种截断都不能切出孤代理项。
// realPoison 取自 qqbridge.service.log 22:45:54（群 429626254 里被 @ 之后刷的那串），
// 它的 36 字截断结果就是当时冻进 state/social-v2.json、导致该群每个新会话第一步就 400 的那一行。
const realPoison = '@蓝色大肥鱼 你会 ✋😡✋🍚来 ✋😡✋🍚来 ✋😡✋🍚来 ✋😡✋🍚来 ✋😡✋🍚来 ✋😡✋🍚来 吗';
const emojiSamples = [pairAt, mixed, realPoison, '🍚'.repeat(20), '✋😡✋🍚来'.repeat(6)];
const badAt = [];
let rawSliceBad = 0;
for (const s of emojiSamples) {
  for (let n = 1; n <= s.length; n++) {
    if (hasLoneSurrogate(truncateText(s, n))) badAt.push(`truncateText(${n})`);
    if (hasLoneSurrogate(truncateTextTail(s, n))) badAt.push(`truncateTextTail(${n})`);
    if (hasLoneSurrogate(s.slice(0, n) + '…')) rawSliceBad++;
  }
}
assert('穷举：任何截断长度都不切出孤代理项（5 个真实样本 × 全长度）', badAt.length === 0, JSON.stringify(badAt.slice(0, 5)));
assert('穷举：这些真实样本确实踩得中旧写法（反面证据）', rawSliceBad > 0, `rawSliceBad=${rawSliceBad}`);

if (failed > 0) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n🎉 md-to-plain 全部通过');
