// 联网搜索纯逻辑测试：解析 + 竞速 + 缓存 + 渲染。
// 全部用注入的假 fetcher，不打网络 —— 秒跑，且能精确控制"谁快谁慢谁失败"。
import {
  sanitizeQuery, decodeHtml, unwrapBingUrl, splitResultBlocks,
  parseBingHtml, parseDuckHtml, parseBaiduHtml,
  SearchCache, searchWeb as searchWebReal, renderSearchResult,
  normalizeUrl, titleKey, mergeResults, ttlForQuery, smartTruncate,
  extractDate, annotateDates,
  setSourceHealth, sourceCooldownLeft, resetSourceCooldowns,
  SOURCE_TIMEOUT_MS, CACHE_MAX_ENTRIES, FAILURE_MEMO_MS,
  TTL_FAST_MS, TTL_SLOW_MS, TTL_DEFAULT_MS
} from '../src/web-search-lib.js';

// 假引擎的标题（'F'/'t'）跟查询词毫无关系，相关度过滤会把它们全丢掉；
// 这些用例测的是竞速/缓存/渲染，所以统一打开"允许噪声兜底"。
const searchWeb = (query, deps = {}) => searchWebReal(query, { allowNoisyFallback: true, ...deps });

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

// ── 1. sanitizeQuery ───────────────────────────────────────────────
eq('去 CQ 码', sanitizeQuery('这是 [CQ:at,qq=123] 测试'), '这是 测试');
eq('去控制字符', sanitizeQuery('a\u0000b\u001fc'), 'a b c');
eq('压空白', sanitizeQuery('  a   b  '), 'a b');
eq('截断到 120', sanitizeQuery('x'.repeat(300)).length, 120);
eq('空输入返回空串', sanitizeQuery(''), '');
eq('null 返回空串', sanitizeQuery(null), '');
eq('undefined 返回空串', sanitizeQuery(undefined), '');

// ── 2. decodeHtml ──────────────────────────────────────────────────
eq('去标签', decodeHtml('<b>粗体</b>'), '粗体');
eq('实体 &amp;', decodeHtml('a &amp; b'), 'a & b');
eq('实体 &nbsp;', decodeHtml('a&nbsp;b'), 'a b');
eq('去 script 内容', decodeHtml('<script>var x=1</script>正文'), '正文');
eq('去 style 内容', decodeHtml('<style>.a{}</style>正文'), '正文');
eq('&#39; 转单引号', decodeHtml('it&#39;s'), "it's");
eq('&hellip;', decodeHtml('等等&hellip;'), '等等…');
eq('null 返回空串', decodeHtml(null), '');

// ── 3. unwrapBingUrl ───────────────────────────────────────────────
eq('普通外链直接返回', unwrapBingUrl('https://example.com/a'), 'https://example.com/a');
eq('bing 内链返回空', unwrapBingUrl('https://cn.bing.com/search?q=x'), '');
eq('空串返回空', unwrapBingUrl(''), '');
// a1 + base64url("https://real.example.com/x")
const target = 'a1' + Buffer.from('https://real.example.com/x').toString('base64url');
eq('解 a1 包装链接',
  unwrapBingUrl(`https://www.bing.com/ck/a?u=${target}&ntb=1`),
  'https://real.example.com/x');

// ── 4. splitResultBlocks ───────────────────────────────────────────
const bingSample = `
<ul>
<li class="b_algo" data-id iid=SERP.1><h2><a href="https://a.com/">标题A</a></h2><p>摘要A</p></li>
<li class="b_algo" data-id iid=SERP.2><h2><a href="https://b.com/">标题B</a></h2><p>摘要B</p></li>
</ul>`;
eq('切出 2 个块', splitResultBlocks(bingSample, 'b_algo').length, 2);
ok('块含标题A', splitResultBlocks(bingSample, 'b_algo')[0].includes('标题A'));
ok('块 1 不含标题B（边界正确）', !splitResultBlocks(bingSample, 'b_algo')[0].includes('标题B'));
eq('没有标记时返回空', splitResultBlocks('<li class="other">x</li>', 'b_algo').length, 0);
// 属性顺序调换也要能切（旧实现 split 精确串就是这样挂的）
eq('class 在 id 之后也能切',
  splitResultBlocks('<li data-id=1 class="b_algo x"><h2>t</h2></li>', 'b_algo').length, 1);

// ── 5. parseBingHtml ───────────────────────────────────────────────
const bingPage = bingSample;
const bingRes = parseBingHtml(bingPage, 8);
eq('Bing 解析出 2 条', bingRes.length, 2);
eq('第 1 条标题', bingRes[0].title, '标题A');
eq('第 1 条 URL', bingRes[0].url, 'https://a.com/');
eq('第 1 条摘要', bingRes[0].snippet, '摘要A');
eq('limit 生效', parseBingHtml(bingPage, 1).length, 1);
eq('无结果页返回空（Bing 那种 84KB 形态）', parseBingHtml('<html><body>nothing</body></html>').length, 0);
eq('空串返回空', parseBingHtml('').length, 0);
eq('null 返回空', parseBingHtml(null).length, 0);

// ── 6. parseDuckHtml ───────────────────────────────────────────────
const duckPage = `
<table>
<tr><td><a class="result-link" href="https://d1.com/">结果一</a></td></tr>
<tr><td class="result-snippet">这是摘要一</td></tr>
<tr><td><a class="result-link" href="https://d2.com/">结果二</a></td></tr>
<tr><td class="result-snippet">这是摘要二</td></tr>
</table>`;
const duckRes = parseDuckHtml(duckPage, 8);
eq('DDG 解析出 2 条', duckRes.length, 2);
eq('DDG 第 1 条标题', duckRes[0].title, '结果一');
eq('DDG 第 1 条 URL', duckRes[0].url, 'https://d1.com/');
ok('DDG 摘要取到', duckRes[0].snippet.includes('摘要一'));
eq('DDG limit 生效', parseDuckHtml(duckPage, 1).length, 1);
eq('DDG 空页返回空', parseDuckHtml('<html></html>').length, 0);

// ── 7. parseBaiduHtml ──────────────────────────────────────────────
const baiduPage = `
<div class="result c-container" id="1">
  <h3><a href="https://b1.com/">百度结果一</a></h3>
  <span class="c-abstract">百度摘要一内容够长了吧</span>
</div>
<div class="result c-container" id="2">
  <h3><a href="https://b2.com/">百度结果二</a></h3>
  <span class="c-abstract">百度摘要二内容够长了吧</span>
</div>`;
const baiduRes = parseBaiduHtml(baiduPage, 8);
eq('百度解析出 2 条', baiduRes.length, 2);
eq('百度第 1 条标题', baiduRes[0].title, '百度结果一');
eq('百度第 1 条 URL', baiduRes[0].url, 'https://b1.com/');
eq('百度 limit 生效', parseBaiduHtml(baiduPage, 1).length, 1);
eq('百度空页返回空', parseBaiduHtml('<html></html>').length, 0);

// ── 8. SearchCache ─────────────────────────────────────────────────
{
  const c = new SearchCache(3, 60000);
  eq('空缓存取不到', c.get('a'), null);
  c.set('a', { v: 1 });
  eq('存了能取到', c.get('a'), { v: 1 });
  c.set('b', { v: 2 }); c.set('c', { v: 3 }); c.set('d', { v: 4 });
  eq('超上限淘汰最旧', c.get('a'), null);
  ok('最新的还在', c.get('d') !== null);
  eq('size 不超上限', c.size, 3);
  c.clear();
  eq('clear 后为空', c.size, 0);
}
{
  // TTL：用负数 ttl 让条目立刻过期
  const c = new SearchCache(10, -1);
  c.set('k', { v: 1 });
  eq('TTL 过期取不到', c.get('k'), null);
}
{
  // LRU：get 会把命中的挪到最新，从而保护它不被淘汰
  const c = new SearchCache(2, 60000);
  c.set('a', { v: 1 }); c.set('b', { v: 2 });
  c.get('a');              // a 变成最新
  c.set('c', { v: 3 });    // 淘汰 b
  ok('命中过的 a 被保住', c.get('a') !== null);
  eq('没被命中的 b 被淘汰', c.get('b'), null);
}

// ── 9. searchWeb：竞速（慢源不拖累） ───────────────────────────────
const ENGINES = [
  { name: 'slow', buildUrl: (q) => `slow:${q}`, parse: () => [{ title: 'S', url: 'https://slow.com/', snippet: '' }] },
  { name: 'fast', buildUrl: (q) => `fast:${q}`, parse: () => [{ title: 'F', url: 'https://fast.com/', snippet: '' }] }
];

{
  const seen = [];
  const deps = {
    fetchText: async (url) => {
      const name = url.split(':')[0];
      const delay = name === 'slow' ? 200 : 10;
      await new Promise((r) => setTimeout(r, delay));
      return { statusCode: 200, body: `<html data-engine="${name}"></html>` };
    },
    engines: ENGINES,
    onSource: (name, info) => seen.push([name, info.ok])
  };
  // 两个源都要能返回 200，parse 直接给结果 —— 快的赢。
  // 注意：两个引擎的 parse 都返回结果，所以 fast 先完成即胜出。
  const r = await searchWeb('测试', deps);
  ok('竞速：source 如实标出贡献结果的源（含快源 fast）', String(r.source).split('+').includes('fast'));
  ok('拿回了结果', r.results.length >= 1);
  // 宽限期内慢源的结果也会并进来（一起重排），所以只断言快源那条在里面。
  ok('结果里含 fast 源的内容', r.results.some((x) => x.title === 'F'));
}
{
  // 慢源挂掉，只剩快源 —— 也要成功（说明单源失败不影响整体）
  const deps = {
    fetchText: async (url) => {
      if (url.startsWith('slow')) throw new Error('慢源挂了');
      return { statusCode: 200, body: 'ok' };
    },
    engines: ENGINES
  };
  const r = await searchWeb('测试2', deps);
  eq('一个源挂了仍成功', r.source, 'fast');
  ok('errors 里记了失败源', r.errors.some((e) => e.startsWith('slow')));
}

// ── 10. searchWeb：全部失败 → 优雅返回 ────────────────────────────
{
  const r = await searchWeb('全挂', {
    fetchText: async () => { throw new Error('boom'); },
    engines: ENGINES
  });
  eq('全失败结果为空', r.results.length, 0);
  eq('全失败 source 为空', r.source, '');
  eq('全失败记了 2 条错误', r.errors.length, 2);
}

// ── 11. searchWeb：空查询不联网 ────────────────────────────────────
{
  let called = 0;
  const r = await searchWeb('   ', { fetchText: async () => { called += 1; return {}; }, engines: ENGINES });
  eq('空查询不请求', called, 0);
  eq('空查询返回空结果', r.results.length, 0);
  ok('空查询有原因', r.errors.includes('查询词为空'));
}

// ── 12. searchWeb：缓存命中（第二次零网络） ────────────────────────
{
  let netCalls = 0;
  const cache = new SearchCache(10, 60000);
  const deps = {
    fetchText: async () => { netCalls += 1; return { statusCode: 200, body: 'ok' }; },
    engines: ENGINES, cache
  };
  const r1 = await searchWeb('缓存词', deps);
  eq('第一次没走缓存', r1.cached, false);
  const callsAfterFirst = netCalls;
  const r2 = await searchWeb('缓存词', deps);
  eq('第二次命中缓存', r2.cached, true);
  eq('第二次没有网络请求', netCalls, callsAfterFirst);
  eq('缓存结果一致', r2.results[0].title, r1.results[0].title);
}

// ── 13. searchWeb：limit 与 timeoutMs 传递 ────────────────────────
{
  const timeouts = [];
  await searchWeb('x', {
    fetchText: async (url, tmo) => { timeouts.push(tmo); return { statusCode: 200, body: 'ok' }; },
    engines: ENGINES,
    timeoutMs: 1234
  });
  ok('timeoutMs 传到了 fetchText', timeouts.every((t) => t === 1234));
  eq('默认超时是 3500', SOURCE_TIMEOUT_MS, 3500);
}
{
  const r = await searchWeb('y', {
    fetchText: async () => ({ statusCode: 200, body: 'ok' }),
    engines: [{ name: 'many', buildUrl: (q) => q, parse: () => Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, url: `https://x${i}.com/`, snippet: '' })) }],
    limit: 3
  });
  eq('limit 截断结果', r.results.length, 3);
}

// ── 14. searchWeb：非 2xx 视为失败 ────────────────────────────────
{
  const r = await searchWeb('z', {
    fetchText: async () => ({ statusCode: 503, body: '' }),
    engines: ENGINES
  });
  eq('全 503 视为全失败', r.results.length, 0);
  eq('记了 2 条错误', r.errors.length, 2);
}

// ── 15. searchWeb：解析器抛异常要被兜住 ───────────────────────────
{
  const r = await searchWeb('boom', {
    fetchText: async () => ({ statusCode: 200, body: 'ok' }),
    engines: [{ name: 'badparse', buildUrl: (q) => q, parse: () => { throw new Error('parse炸了'); } }]
  });
  eq('解析抛异常不炸整体', r.results.length, 0);
  ok('记了解析失败原因', r.errors.some((e) => e.includes('解析失败')));
}

// ── 16. searchWeb：没有 fetchText 要抛 ────────────────────────────
{
  let threw = false;
  try { await searchWeb('x', {}); } catch { threw = true; }
  ok('缺 fetchText 会抛错', threw);
}

// ── 17. renderSearchResult ────────────────────────────────────────
{
  const payload = {
    query: 'yyds', source: 'bing', cached: false,
    results: [
      { title: '永远的神', url: 'https://a.com/', snippet: '这是解释' },
      { title: '永不掉线', url: 'https://b.com/', snippet: '' }
    ],
    errors: []
  };
  const txt = renderSearchResult(payload, { max: 6 });
  ok('渲染含查询词', txt.includes('yyds'));
  ok('渲染含来源', txt.includes('bing'));
  ok('渲染含第 1 条标题', txt.includes('永远的神'));
  ok('渲染含摘要', txt.includes('这是解释'));
  ok('渲染带序号', txt.includes('1. '));
  ok('渲染是紧凑多行（省 token）', txt.split('\n').length === 3);
}
{
  const txt = renderSearchResult({ query: '没结果', results: [], errors: ['bing: 无有效结果'] });
  ok('空结果有兜底文案', txt.includes('没搜到'));
  // 给模型看的是"下一步怎么做"，不是每个引擎的私有报错（那串东西只会让她再重试一遍）。
  ok('空结果不再甩引擎私有报错', !txt.includes('无有效结果') && !txt.includes('bing:'));
  ok('空结果给出可执行的下一步', txt.includes('再试'));
}
{
  const many = renderSearchResult({
    query: 'q', source: 's', results: Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, snippet: '' })), errors: []
  }, { max: 3 });
  eq('渲染 max 生效', many.split('\n').length, 4); // 1 行头 + 3 条
}
{
  eq('空 payload 不炸', typeof renderSearchResult(null), 'string');
}

// ── 18. 常量断言 ──────────────────────────────────────────────────
eq('缓存上限 200', CACHE_MAX_ENTRIES, 200);

// ── 19. attempts：同一源并发多打，抵消"随机空手" ──────────────────
{
  // 模拟 Bing 那种行为：5 次里只有第 3 次给结果。
  let calls = 0;
  const r = await searchWeb('随机源', {
    fetchText: async () => { calls += 1; return { statusCode: 200, body: 'ok' }; },
    engines: [{
      name: 'flaky',
      buildUrl: (q) => q,
      attempts: 5,
      // 用全局调用序号决定这次给不给结果
      parse: () => (calls >= 3
        ? [{ title: '终于有了', url: 'https://ok.com/', snippet: '' }]
        : [])
    }]
  });
  ok('并发多打后拿到了结果', r.results.length === 1);
  eq('结果来自 flaky', r.source, 'flaky');
  eq('清掉了胜出源的噪音错误（只剩非胜出源的）', r.errors.length, 0);
}
{
  // attempts=1 时不加 # 后缀
  const seen = [];
  await searchWeb('单个', {
    fetchText: async () => ({ statusCode: 200, body: 'ok' }),
    engines: [{ name: 'one', buildUrl: (q) => q, attempts: 1, parse: () => [{ title: 't', url: 'https://a.com/', snippet: '' }] }],
    onSource: (n) => seen.push(n)
  });
  eq('attempts=1 时源名不带 #', seen, ['one']);
}
{
  // attempts>1 时 onSource 能得到带 # 的标签
  const seen = [];
  await searchWeb('多个', {
    fetchText: async () => ({ statusCode: 200, body: 'ok' }),
    engines: [{ name: 'multi', buildUrl: (q) => q, attempts: 3, parse: () => [{ title: 't', url: 'https://a.com/', snippet: '' }] }],
    onSource: (n) => seen.push(n)
  });
  ok('attempts>1 时源名带 # 序号', seen.some((n) => n.startsWith('multi#')));
  ok('并发打满 3 次', seen.length >= 3);
}
{
  // attempts 给了非法值要回落到 1
  const seen = [];
  await searchWeb('非法attempts', {
    fetchText: async () => ({ statusCode: 200, body: 'ok' }),
    engines: [{ name: 'bad', buildUrl: (q) => q, attempts: 0, parse: () => [{ title: 't', url: 'https://a.com/', snippet: '' }] }],
    onSource: (n) => seen.push(n)
  });
  eq('attempts=0 回落到 1 次', seen, ['bad']);
}
{
  // attempts 超上限也要被夹住（<= 8）：让所有副本都空手，这样 calls 会跑到夹取后的次数
  let calls = 0;
  const r = await searchWeb('超大attempts', {
    fetchText: async () => { calls += 1; return { statusCode: 200, body: 'ok' }; },
    engines: [{ name: 'huge', buildUrl: (q) => q, attempts: 999, parse: () => [] }]
  });
  eq('attempts 被夹到 8 次', calls, 8);
  eq('全空手时结果是空的', r.results.length, 0);
  ok('全空手时错误数是 8 条', r.errors.length === 8);
}
{
  // 胜出源的噪音清掉，但**别的源**的失败要留着
  const r = await searchWeb('混合', {
    fetchText: async (url) => {
      if (url.startsWith('dead')) throw new Error('死源');
      return { statusCode: 200, body: 'ok' };
    },
    engines: [
      { name: 'dead', buildUrl: (q) => `dead:${q}`, attempts: 1, parse: () => [] },
      { name: 'live', buildUrl: (q) => `live:${q}`, attempts: 3, parse: () => [{ title: 'ok', url: 'https://a.com/', snippet: '' }] }
    ]
  });
  ok('胜出源噪音被清掉', !r.errors.some((e) => e.startsWith('live')));
  ok('别家的失败被保留', r.errors.some((e) => e.startsWith('dead')));
}
{
  // 默认引擎表只剩实测可用的源
  const { SEARCH_ENGINES, SEARCH_ENGINES_EXTRA, SOURCE_COOLDOWN_MS, MERGE_GRACE_MS } = await import('../src/web-search-lib.js');
  eq('默认源池 4 个（anysearch 前置）', SEARCH_ENGINES.map((e) => e.name), ['anysearch', 'sogou', 'so360m', 'bing']);
  ok('anysearch 走 JSON API（runner，不做 HTML 解析）', typeof SEARCH_ENGINES[0].run === 'function');
  ok('bing 仍有并发 attempts 兜随机空手', SEARCH_ENGINES.find((e) => e.name === 'bing').attempts >= 2);
  ok('HTML 源都配了 buildUrl 与 parse，API 源配了 run',
    SEARCH_ENGINES.every((e) => (typeof e.run === 'function')
      || (typeof e.buildUrl === 'function' && typeof e.parse === 'function')));
  ok('死源被移出默认池（放 EXTRA）', !SEARCH_ENGINES.some((e) => e.name === 'baidu')
    && SEARCH_ENGINES_EXTRA.some((e) => e.name === 'so360'));
  ok('DDG/百度 这类必挂源不再拖慢默认兜底', !SEARCH_ENGINES_EXTRA.some((e) => e.name === 'duckduckgo' || e.name === 'baidu'));
// ── 21. 失败不留痕：空结果不写缓存、免得一次瞬时失败锁死 10 分钟 ──
{
  const cache = new SearchCache(10, 60000);
  const r = await searchWeb('空手甲', {
    fetchText: async () => ({ statusCode: 200, body: 'ok' }),
    engines: [{ name: 'empty', buildUrl: (q) => q, parse: () => [] }],
    cache
  });
  eq('空结果照旧返回空', r.results.length, 0);
  eq('空结果不进缓存', cache.size, 0);
}

// ── 22. 失败备忘：同一句 20 秒内再问，直接告诉"刚查过"且不再打网络 ──
{
  let calls = 0;
  const deps = {
    fetchText: async () => { calls += 1; return { statusCode: 200, body: 'ok' }; },
    engines: [{ name: 'empty', buildUrl: (q) => q, parse: () => [] }]
  };
  await searchWeb('备忘词', deps);
  const firstCalls = calls;
  const r2 = await searchWeb('备忘词', deps);
  eq('第二次标记 repeated', r2.repeated, true);
  eq('第二次不再打网络', calls, firstCalls);
  ok('备忘里带"刚查过"的提示', String(r2.note).includes('刚查过一次'));
  ok('失败备忘窗口是秒级、不是分钟级', FAILURE_MEMO_MS >= 1000 && FAILURE_MEMO_MS <= 60000);
}

// ── 23. 低相关兜底：全不达标也给两条线索，别空手而归 ──────────────
{
  const cache = new SearchCache(10, 60000);
  const r = await searchWebReal('量子纠缠 的 具体 应用 场景 有哪些', {
    allowNoisyFallback: false, cache,
    fetchText: async () => ({ statusCode: 200, body: 'ok' }),
    engines: [{
      name: 'noisy', buildUrl: (q) => q,
      parse: () => [
        { title: '完全无关的标题甲', url: 'https://x1.com/', snippet: 'zzz' },
        { title: '也无关的标题乙', url: 'https://x2.com/', snippet: 'zzz' },
        { title: '第三个无关', url: 'https://x3.com/', snippet: 'zzz' }
      ]
    }]
  });
  ok('低相关时不空手', r.results.length > 0);
  ok('低相关最多给 2 条', r.results.length <= 2);
  ok('低相关明确标注"只是沾边"', String(r.note).includes('相关度偏低'));
  eq('低相关标记到 payload 上', r.lowConfidence, true);
  eq('低相关结果不进缓存（下次还能再试一次真结果）', cache.size, 0);
}
  ok('有风控冷却时长', SOURCE_COOLDOWN_MS >= 10000);
  ok('合并宽限期不超过单个源超时', MERGE_GRACE_MS > 0 && MERGE_GRACE_MS <= SOURCE_TIMEOUT_MS);
}

// ── [2026-10-20] 去重 / TTL / 截断 / 源健康度 ──────────────────────────
{
  // 规范化地址：去掉跟踪参数、锚点、www、末尾斜杠
  eq('去 utm/锚点/末尾斜杠', normalizeUrl('https://www.bilibili.com/video/BV1xx/?utm_source=a&spm_id_from=b#t=1'), 'bilibili.com/video/BV1xx');
  eq('http 与 https 视为同一条', normalizeUrl('http://example.com/a/'), normalizeUrl('https://example.com/a'));
  eq('保留有意义的查询参数', normalizeUrl('https://a.com/s?q=%E5%8E%9F%E7%A5%9E'), 'a.com/s?q=%E5%8E%9F%E7%A5%9E');
  eq('非法地址不炸', normalizeUrl('不是地址'), '不是地址');

  // 标题指纹：忽略空格标点
  eq('标题指纹忽略标点空格', titleKey('【原神】5.0 卡池！'), titleKey('原神 5.0 卡池'));

  // 合并去重：三个源给同一条只留一条
  const merged = mergeResults(
    [{ url: 'https://www.a.com/x/?utm_source=1', title: '同一个页面' }],
    [
      { url: 'http://a.com/x', title: '同一个页面' },
      { url: 'https://b.com/y', title: '另一个页面' },
      { url: 'https://c.com/z', title: '完全不同的标题内容' }
    ]
  );
  eq('规范化地址 + 标题指纹双重去重', merged.length, 3);
  ok('保留先出现的那个', merged[0].url.includes('utm_source'));
  eq('空输入安全', mergeResults([], []), []);

  // 缓存 TTL 分层
  eq('时效性查询用短 TTL', ttlForQuery('今天天气怎么样'), TTL_FAST_MS);
  eq('价格类用短 TTL', ttlForQuery('显卡现在多少钱'), TTL_FAST_MS);
  eq('梗/常识用长 TTL', ttlForQuery('这个梗是什么意思'), TTL_SLOW_MS);
  eq('其它用默认 TTL', ttlForQuery('量子力学'), TTL_DEFAULT_MS);
  ok('短 TTL 明显短于长 TTL', TTL_FAST_MS < TTL_SLOW_MS && TTL_FAST_MS <= TTL_DEFAULT_MS);

  // 智能截断：短文不动
  const shortText = '很短的一段正文。';
  const st = smartTruncate(shortText, 8000);
  eq('短文不截断', st.truncated, false);
  eq('短文原样返回', st.text, shortText);

  // 长文：保头保尾 + 给续读 offset
  const longText = Array.from({ length: 500 }, (_, i) => `第${i}段：这是一段用来测试截断的内容，长度大约二十来个字。`).join('\n');
  const lt = smartTruncate(longText, 2000);
  eq('长文被截断', lt.truncated, true);
  ok('保留开头', lt.text.startsWith('第0段'));
  ok('保留了尾部内容', lt.text.includes('第499段'));
  ok('中间有省略标记', lt.text.includes('中间省略'));
  ok('给了续读 offset', lt.nextOffset > 1000 && lt.nextOffset < longText.length);
  ok('切点在句子边界（不会切半个字）', /[。\n]$/.test(lt.text.slice(0, lt.text.indexOf('\n…（中间省略'))));
  const resumed = smartTruncate(longText.slice(lt.nextOffset), 2000, lt.nextOffset);
  ok('从 offset 续读能拿到后面的内容', resumed.text.trimStart().startsWith('第') && resumed.text.includes('段'));

  // 源健康度播种：跨重启的冷却要进进程内冷却表
  resetSourceCooldowns();
  setSourceHealth({ cooldownMap: () => new Map([['sogou', Date.now() + 5000]]) });
  ok('落盘冷却能播种进进程', sourceCooldownLeft('sogou') > 0);
  setSourceHealth(null);
  resetSourceCooldowns();
  eq('解绑后恢复干净', sourceCooldownLeft('sogou'), 0);
}

// ── [2026-10-20] 结果时效标注 ──────────────────────────────────────────
{
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);
  eq('绝对日期', extractDate('发布于 2023-05-12 的公告', now)?.label, '2023-05-12');
  eq('中文年月', extractDate('2023年5月更新', now)?.label, '2023-05');
  eq('斜杠日期', extractDate('2024/7/1 起施行', now)?.label, '2024-07-01');
  eq('相对时间', extractDate('3天前更新', now)?.label, '3天前');
  ok('相对时间能算出时间戳', Math.abs((now - extractDate('2小时前', now).ts) - 7200000) < 1000);
  eq('价格区间不会被当日期', extractDate('价格 2000-3000元', now), null);
  eq('版本号不会被当日期', extractDate('原神5.0版本', now), null);
  eq('未来日期不认', extractDate('2099-01-01', now), null);
  eq('没日期返回 null', extractDate('今天天气不错', now), null);

  const annotated = annotateDates([
    { title: '有日期的', snippet: '2024-03-05 发布' },
    { title: '没日期的', snippet: '内容' }
  ], now);
  eq('抽到的补上 date', annotated[0].date, '2024-03-05');
  eq('没抽到的原样', annotated[1].date, undefined);

  const rendered = renderSearchResult({ query: 'q', source: 's', results: [{ title: 'T', snippet: 'S', date: '2023-05-12' }] }, { max: 3 });
  ok('结果里带日期', rendered.includes('（2023-05-12）'));
  const stale = renderSearchResult({ query: 'q', source: 's', results: [{ title: 'T' }], staleHint: '这批结果都比较旧' });
  ok('旧结果警告会显示', stale.includes('这批结果都比较旧'));
  ok('没有警告时不多一个字', !renderSearchResult({ query: 'q', source: 's', results: [{ title: 'T' }] }).includes('⚠'));
}

console.log(`联网搜索（纯逻辑）：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
