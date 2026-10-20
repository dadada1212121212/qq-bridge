// 链接顺手读的纯逻辑测试：抽 URL / HTML 转文本 / 摘要段格式。
import { extractLinks, htmlToText, extractTitle, formatLinkDigest } from '../src/link-digest.js';

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

// ── 抽链接 ─────────────────────────────────────────────────────────
eq('抽一条普通链接', extractLinks('看这个 https://example.com/a 挺有意思'), ['https://example.com/a']);
eq('剥掉句尾标点', extractLinks('看 https://example.com/a。'), ['https://example.com/a']);
eq('剥掉右括号', extractLinks('（见 https://example.com/a)'), ['https://example.com/a']);
eq('中文标点也算边界', extractLinks('链接https://example.com/a，然后'), ['https://example.com/a']);
eq('最多两条', extractLinks('https://a.com/1 https://b.com/2 https://c.com/3').length, 2);
eq('非 http 不算', extractLinks('mailto:x@y.com file:///c:/a.txt'), []);
eq('太短的不算', extractLinks('http://a.b'), []);
eq('没有链接返回空数组', extractLinks('今天天气不错'), []);
eq('去重', extractLinks('https://a.com/x https://a.com/x'), ['https://a.com/x']);

// ── HTML 转文本 ────────────────────────────────────────────────────
eq('去标签', htmlToText('<p>你好</p><b>世界</b>'), '你好 世界');
eq('去 script/style', htmlToText('<script>var a=1;</script><style>.x{}</style>正文'), '正文');
eq('未闭合的 style 不吞正文（截断页常见）', htmlToText('<style>.x{color:red}正文'), '正文');
eq('从 body 处截起（丢掉头部样式）', htmlToText('<html><head><style>.a{}</style></head><body>正文</body></html>'), '正文');
ok('未闭合 script 的标签被去掉', !htmlToText('<script>var a=1').includes('<script'));
ok('解实体', htmlToText('a&amp;b&lt;c&gt;d&quot;e&#39;f').includes("a&b<c>d\"e'f"));
eq('压空白', htmlToText('  a \n\n  b  '), 'a b');
eq('空输入安全', htmlToText(''), '');

// ── 标题 ───────────────────────────────────────────────────────────
eq('取 title', extractTitle('<html><head><title>页面标题 - 站点</title></head>'), '页面标题 - 站点');
eq('title 里带实体也能解', extractTitle('<title>A &amp; B</title>'), 'A & B');
eq('没 title 返回空串', extractTitle('<html></html>'), '');

// ── 摘要段 ─────────────────────────────────────────────────────────
eq('正文太短不生成（宁可不提也别让她硬编）', formatLinkDigest({ title: 'T', text: '短' }), '');
const long = '这是一段足够长的正文内容。'.repeat(20);
const seg = formatLinkDigest({ title: '标题', text: long, url: 'https://a.com' });
ok('长正文生成摘要段', seg.startsWith('【刚有人贴的链接】标题'));
ok('带正文', seg.includes('这是一段足够长的正文内容'));
ok('带行为提示', seg.includes('没看全的地方别硬编'));
ok('正文超长会截断', formatLinkDigest({ title: 'T', text: '字'.repeat(5000), maxChars: 700 }).length < 900);
ok('没标题时退回 URL', formatLinkDigest({ title: '', text: long, url: 'https://a.com/x' }).includes('https://a.com/x'));

console.log(`链接顺手读：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('失败项：');
  for (const x of failures) console.log('  ✗ ' + x);
  process.exit(1);
}
