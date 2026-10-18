// 定时播报纯逻辑测试：节日判定 + 热榜解析。
// 这个套件不依赖 bridge/harness，纯 import src/broadcast-lib.js，秒跑。
import {
  SOLAR_FESTIVALS, LUNAR_FESTIVALS, MAJOR_FESTIVALS,
  festivalOf, festivalGreeting, extractHotTitles, extractHotTitlesFromHtml, buildHotTopicHint
} from '../src/broadcast-lib.js';

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

// ── 1. 节日表基本形态 ────────────────────────────────────────────────
ok('公历表非空', Object.keys(SOLAR_FESTIVALS).length >= 10);
ok('农历表非空', Object.keys(LUNAR_FESTIVALS).length >= 60);
ok('农历表键格式都是 YYYY-MM-DD', Object.keys(LUNAR_FESTIVALS).every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)));
ok('公历表键格式都是 MM-DD', Object.keys(SOLAR_FESTIVALS).every((k) => /^\d{2}-\d{2}$/.test(k)));
ok('农历表覆盖 2025-2035', [2025, 2028, 2031, 2035].every((y) => Object.keys(LUNAR_FESTIVALS).some((k) => k.startsWith(String(y)))));
ok('MAJOR_FESTIVALS 含春节/中秋/国庆', ['春节', '中秋节', '国庆节'].every((n) => MAJOR_FESTIVALS.has(n)));

// ── 2. festivalOf 公历 ──────────────────────────────────────────────
eq('元旦', festivalOf('2026-01-01'), { name: '元旦', major: true, kind: 'solar' });
eq('国庆', festivalOf('2026-10-01')?.name, '国庆节');
eq('圣诞', festivalOf('2026-12-25')?.name, '圣诞节');
eq('圣诞不是大节', festivalOf('2026-12-25')?.major, false);
eq('儿童节不是大节', festivalOf('2026-06-01')?.major, false);
eq('普通日子返回 null', festivalOf('2026-05-20'), null);

// ── 3. festivalOf 农历 ──────────────────────────────────────────────
eq('2026 春节', festivalOf('2026-02-17'), { name: '春节', major: true, kind: 'lunar' });
eq('2025 中秋', festivalOf('2025-10-06')?.name, '中秋节');
eq('2026 端午', festivalOf('2026-06-19')?.name, '端午节');
eq('2026 七夕', festivalOf('2026-08-19')?.name, '七夕');

// 农历优先于公历：2031-10-01 既是国庆又是中秋，应报中秋
eq('农历优先于公历（2031-10-01 报中秋）', festivalOf('2031-10-01')?.name, '中秋节');
eq('2031-10-01 的类型是 lunar', festivalOf('2031-10-01')?.kind, 'lunar');
// 对照：2030-10-01 只有国庆
eq('2030-10-01 报国庆', festivalOf('2030-10-01')?.name, '国庆节');

// 表外年份：只认公历
eq('表外年份农历不判（2040-02-17 不是春节）', festivalOf('2040-02-17'), null);
eq('表外年份公历照常（2040-10-01 是国庆）', festivalOf('2040-10-01')?.name, '国庆节');

// ── 4. festivalOf 输入健壮性 ────────────────────────────────────────
eq('空串返回 null', festivalOf(''), null);
eq('undefined 返回 null', festivalOf(undefined), null);
eq('null 返回 null', festivalOf(null), null);
eq('格式不对返回 null', festivalOf('2026/01/01'), null);
eq('缺位返回 null', festivalOf('2026-1-1'), null);
eq('带空格能识别', festivalOf('  2026-01-01  ')?.name, '元旦');

// ── 5. festivalGreeting ─────────────────────────────────────────────
ok('春节有祝福语', festivalGreeting('春节').includes('吉利'));
ok('元旦有祝福语', festivalGreeting('元旦').includes('新年'));
ok('中秋提到月饼/月亮/团圆', /月饼|月亮|团圆/.test(festivalGreeting('中秋节')));
ok('未知节日返回空串', festivalGreeting('火星节') === '');
ok('安全：不认识的名字不抛', festivalGreeting(undefined) === '');

// ── 6. extractHotTitles：多种结构 ──────────────────────────────────
eq('裸数组', extractHotTitles(['A', 'B', 'C']), ['A', 'B', 'C']);
eq('data 包裹', extractHotTitles({ data: ['A', 'B'] }), ['A', 'B']);
eq('result 包裹', extractHotTitles({ result: ['A'] }), ['A']);
eq('list 包裹', extractHotTitles({ list: ['A'] }), ['A']);
eq('items 包裹', extractHotTitles({ items: ['A'] }), ['A']);
eq('word 字段', extractHotTitles({ data: [{ word: '热搜一' }] }), ['热搜一']);
eq('title 字段', extractHotTitles({ data: [{ title: '热搜二' }] }), ['热搜二']);
eq('name 字段', extractHotTitles({ data: [{ name: '热搜三' }] }), ['热搜三']);
eq('query 字段', extractHotTitles({ data: [{ query: '热搜四' }] }), ['热搜四']);
eq('hotword 字段', extractHotTitles({ data: [{ hotword: '热搜五' }] }), ['热搜五']);
eq('混合对象/字符串', extractHotTitles({ data: ['甲', { word: '乙' }, { title: '丙' }] }), ['甲', '乙', '丙']);

// ── 7. extractHotTitles：清洗与限额 ────────────────────────────────
eq('去重', extractHotTitles(['A', 'A', 'B']), ['A', 'B']);
eq('去空白项', extractHotTitles(['  A  ', '', '   ', 'B']), ['A', 'B']);
eq('压扁内部空白', extractHotTitles(['热搜  一\n二']), ['热搜 一 二']);
eq('限额生效', extractHotTitles(['1', '2', '3', '4', '5'], 3), ['1', '2', '3']);
eq('limit=0 返回空', extractHotTitles(['A'], 0), []);
eq('limit 负数返回空', extractHotTitles(['A'], -1), []);
eq('超长标题被截断到 60', extractHotTitles(['x'.repeat(200)])[0].length, 60);
eq('没有标题字段的对象被跳过', extractHotTitles({ data: [{ foo: 'bar' }, { word: 'ok' }] }), ['ok']);
// 嵌套结构：现在要能递归深挖（百度热榜就是 data.cards[0].content[0].content[] 这种）
eq('嵌套两层能挖到', extractHotTitles({ data: { data: ['A'] } }), ['A']);
eq('百度热榜真实结构（cards→content→content→word）', extractHotTitles({
  success: true,
  data: { cards: [{ component: 'tabTextList', content: [{ content: [{ word: '热搜甲' }, { word: '热搜乙' }] }] }] }
}), ['热搜甲', '热搜乙']);
eq('多层包装里挑最深的那层', extractHotTitles({
  data: { cards: [{ content: [{ content: [{ word: '甲' }, { word: '乙' }] }] }], noise: ['不是标题'] }
}), ['甲', '乙']);
eq('只有一层直接命中（不被递归干扰）', extractHotTitles({ data: ['A', 'B'] }), ['A', 'B']);

// ── 8. extractHotTitles：异常输入不抛 ──────────────────────────────
eq('null 返回空', extractHotTitles(null), []);
eq('undefined 返回空', extractHotTitles(undefined), []);
eq('数字返回空', extractHotTitles(42), []);
eq('字符串返回空', extractHotTitles('hello'), []);
eq('空对象返回空', extractHotTitles({}), []);

// ── 9. extractHotTitlesFromHtml ────────────────────────────────────
eq('从 HTML 抠标题', extractHotTitlesFromHtml('<li>热搜第一条</li><li>热搜第二条</li>'), ['热搜第一条', '热搜第二条']);
eq('HTML 去重', extractHotTitlesFromHtml('<a>甲乙丙</a><b>甲乙丙</b>'), ['甲乙丙']);
eq('HTML 过滤纯符号', extractHotTitlesFromHtml('<i>12345</i><b>真正的标题</b>'), ['真正的标题']);
eq('HTML 过滤 CSS/JS 片段', extractHotTitlesFromHtml('<style>a{color:red}</style><b>正常标题</b>'), ['正常标题']);
eq('HTML 过滤无中文', extractHotTitlesFromHtml('<b>hello world</b>'), []);
eq('HTML 限额', extractHotTitlesFromHtml('<i>甲甲甲甲甲甲</i><i>乙乙乙乙乙乙</i><i>丙丙丙丙丙丙</i>', 2), ['甲甲甲甲甲甲', '乙乙乙乙乙乙']);
eq('HTML limit=0 返回空', extractHotTitlesFromHtml('<b>标题</b>', 0), []);
eq('HTML 空串返回空', extractHotTitlesFromHtml(''), []);
eq('HTML null 返回空', extractHotTitlesFromHtml(null), []);

// ── 10. buildHotTopicHint ──────────────────────────────────────────
const hint = buildHotTopicHint(['甲', '乙']);
ok('hint 含第一条', hint.includes('甲'));
ok('hint 含第二条', hint.includes('乙'));
ok('hint 强调别照抄', hint.includes('别照着念'));
ok('hint 用列表符号', hint.includes('- 甲'));
eq('空列表返回空串', buildHotTopicHint([]), '');
eq('非数组返回空串', buildHotTopicHint('x'), '');
eq('只过滤空白项后为空则返回空串', buildHotTopicHint(['', '  ']), '');
eq('过滤掉空项但保留有效的', buildHotTopicHint(['', '甲']).includes('- 甲'), true);

console.log(`定时播报（纯逻辑）：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
