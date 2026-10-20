// 联网搜索的核心逻辑：多源并行竞速 + 结果缓存 + 各源解析。
//
// 为什么要重写（原 mcp-web-search-safe.js 的 bingSearch 已经半失效）：
//   实测 Bing 在两种页面形态间**随机切换** —— 一种 98KB 带 10 条 <li class="b_algo">，
//   另一种 84KB **一条结果都没有**。同一 query 连打 4 次得到 有/无/无/有，
//   即约 50% 的请求注定空手而归。原来只走这一个源、失败就返回空，用户体感就是"搜不到"。
//
// 本模块的四条提速手段：
//   1. **多源并行竞速**（Promise.any）：Bing / DuckDuckGo Lite / 百度同时打，
//      谁先给出**有效**结果就用谁，不等慢的那个 —— 把"50% 空手"摊薄到几乎不可能同时空。
//   2. **每源独立短超时**（默认 3.5s）：一个源卡住不拖累整体（原实现是全局 20s）。
//   3. **结果缓存**（LRU + TTL）：同一个词第二次搜是**零网络延迟**。
//      她理解梗/黑话时经常反复问同一个词，这条收益最大。
//   4. **宽松的容器切分**：不再 split 精确串（Bing 一改 class 就全废），
//      改成"按 <li ... b_algo ...> 标签边界切"，属性顺序/有无都吃得下。
//
// 本文件不 import safe-fetch，fetcher 由调用方注入 —— 这样纯逻辑可以脱离网络单测。

/** 各源的独立超时：比 safe-fetch 默认 20s 短得多，慢就换源。 */
export const SOURCE_TIMEOUT_MS = 3500;
/** 缓存：最多 200 条、默认 10 分钟。热门词命中率远高于此。 */
// 失败备忘：同一个查询刚失败过，20 秒内再问就直接认输，不重打一轮网络
// （她连着追同一个问题时，反复重搜只会多烧时间和 token，结果还是一样）。
export const FAILURE_MEMO_MS = 20 * 1000;
const failureMemo = new Map();

/** 空结果时给模型看的一句话原因 + 下一步，不列每个引擎的私有报错。 */
export function failureHint(errors = []) {
  const list = Array.isArray(errors) ? errors : [];
  const throttled = list.some((e) => /冷却中|HTTP 4\d\d|风控页|captcha|超时|timeout|abort|限流/i.test(String(e)));
  if (throttled) {
    return '搜索引擎这会儿在限流（403/风控/超时）。过一两分钟再试，或者只留核心实体词；不要用同一句立刻重搜。';
  }
  return '没有可用的结果。换个更短的词再试（只留核心实体名）；不要用同一句立刻重搜。';
}

export const CACHE_MAX_ENTRIES = 200;
export const CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * 触发风控页/异常页后的冷却时长。
 *
 * 为什么需要（实测 2026-10-18）：360（www.so.com 与 m.so.com）和搜狗对同一 IP 的
 * 连续检索非常敏感 —— 头一两次给完整结果页（300-500KB），连打三五次就变成
 * 9.8KB 的「访问异常页面」、6.5KB 的 JS 挑战页，或者搜狗直接 403。
 * 冷却期内直接跳过该源，别把配额浪费在注定失败的请求上。
 */
export const SOURCE_COOLDOWN_MS = 45 * 1000;
/** 首个有效结果到手后，再等这么久把其它源晚到的结果并进池子（不拖慢主路径太多）。 */
export const MERGE_GRACE_MS = 1200;
/** 每个源的冷却截止时间戳（模块级，进程内共享）。 */
const sourceCooldownUntil = new Map();
/** 清空冷却状态（单测/排障用）。 */
export function resetSourceCooldowns() { sourceCooldownUntil.clear(); }
/** 看某个源还要冷却多久（毫秒），0 表示可用。 */
export function sourceCooldownLeft(name, now = Date.now()) {
  return Math.max(0, (sourceCooldownUntil.get(name) || 0) - now);
}

/**
 * 注入源健康度存储（可选）。生产由 MCP 进程传入落盘实现：
 * 启动时把"上次记住的冷却/长期死源"播种进进程内冷却表，运行中把每次成功/失败记下来。
 * 不注入就是纯内存行为（单测、独立调用都不受影响）。
 */
let sourceHealthStore = null;
export function setSourceHealth(health) {
  sourceHealthStore = health || null;
  if (!sourceHealthStore) return;
  try {
    for (const [name, until] of sourceHealthStore.cooldownMap()) {
      const u = Number(until) || 0;
      if (u > 0) sourceCooldownUntil.set(name, Math.max(sourceCooldownUntil.get(name) || 0, u));
    }
  } catch { /* 播种失败不该影响搜索 */ }
}
export function getSourceHealth() { return sourceHealthStore; }

/** 触发一次冷却：进程内 + 落盘（跨重启记住这个源在挂）。 */
function setCooldown(name, ms = SOURCE_COOLDOWN_MS) {
  const until = Date.now() + ms;
  sourceCooldownUntil.set(name, until);
  try { sourceHealthStore?.markCooldown(name, until); } catch { /* 落盘失败不影响冷却 */ }
}
/**
 * Bing 每个查询并发打几次。
 *
 * 为什么需要这个（实测数据）：Bing 在两种页面形态间**随机**切换 ——
 * 一种 98KB 带 10 条结果，一种 84KB（含 `b_no` 区块，"没找到结果"）。
 * 同一个词连打 3 次得到 `0/8/0`、`8/0/0`、`0/8/0` —— **与查询词无关，纯随机**，
 * 是它的无状态后端负载均衡。单打一次约 50% 空手。
 *
 * 实测（2026-10-15）：并发打 6 次耗时 834ms、命中 3/6 —— **并发不增加耗时**
 * （和单次请求的 600ms 同一量级），所以"多打几次"是笔划算买卖：
 *   attempts=3 → 命中率 ≈ 87.5%
 *   attempts=5 → 命中率 ≈ 96.9%（本文件采用）
 * 取第一个有结果的立即返回，其余请求在后台自行结束（不 await）。
 */
export const BING_ATTEMPTS = 5;

/** HTML 实体与标签清理。 */
export function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    // 其余常见命名实体：Bing/360 的标题里大量用 &ensp; &middot; &ndash; 当分隔符，
    // 不认就会带着 &ensp; 这种垃圾进上下文。
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&middot;/g, '·')
    .replace(/&bull;/g, '·')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rsquo;/g, '’')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&copy;/g, '©')
    .replace(/&reg;/g, '®')
    .replace(/&deg;/g, '°')
    .replace(/&times;/g, '×')
    .replace(/&divide;/g, '÷')
    // 数字实体：Bing 标题里常见 &#183; / &#0183; / &#x27; 之类，不转义会原样进标题。
    .replace(/&#(x?)([0-9a-fA-F]+);/g, (m, hex, code) => {
      const n = Number.parseInt(code, hex ? 16 : 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** 查询词清洗：去 CQ 码、控制字符、压空白、限长。 */
export function sanitizeQuery(query) {
  return String(query ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Bing 的跳转包装链接（bing.com/ck/a?...&u=a1<base64>）解出真实 URL。 */
export function unwrapBingUrl(href) {
  const raw = String(href ?? '').trim();
  if (!raw) return '';
  const isBingHost = /^https?:\/\/([a-z0-9-]+\.)*bing\.com\//i.test(raw);
  // 非 bing 域名的普通外链：直接用。
  if (/^https?:\/\//i.test(raw) && !isBingHost) return raw;
  try {
    const u = new URL(raw, 'https://cn.bing.com');
    const target = u.searchParams.get('u');
    if (target && /^a1/i.test(target)) {
      // a1 后面是 base64url 编码的真实地址。
      const b64 = target.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const decoded = Buffer.from(pad, 'base64').toString('utf8');
      if (/^https?:\/\//i.test(decoded)) return decoded;
    }
    // bing 自己的内链（搜索页/首页等）不是结果地址 → 返回空，别当结果用。
    if (isBingHost) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
  } catch { /* 解不出来就算了 */ }
  return '';
}

/**
 * 按标签边界切出各条结果的 HTML 块。
 * 不用精确字符串（Bing 一改属性顺序就全废），而是找所有满足 `b_algo` 的 <li> 起点，
 * 一直切到下一个 <li 或容器结束。返回块数组。
 */
export function splitResultBlocks(html, marker = 'b_algo') {
  const text = String(html ?? '');
  const out = [];
  // 标记可能含正则元字符，先转义。
  const safe = String(marker).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<li\\b[^>]*\\b(?:class|id)\\s*=\\s*"[^"]*\\b${safe}\\b[^"]*"[^>]*>`,
    'gi'
  );
  const starts = [];
  let m;
  while ((m = pattern.exec(text))) starts.push(m.index + m[0].length);
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i];
    // 到下一个 <li 或整段结束为止。
    const nextLi = text.indexOf('<li', from);
    const to = nextLi === -1 ? text.length : nextLi;
    out.push(text.slice(from, to));
  }
  return out;
}

/** 从一块 Bing 结果 HTML 里取 title/url/snippet。 */
function parseBingBlock(block) {
  const h2 = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const title = h2 ? decodeHtml(h2[1]) : '';
  // 优先取 h2 里的链接（那才是结果主链接），退而求其次取块内第一个外链。
  let href = '';
  if (h2) {
    const a = h2[0].match(/href="([^"]+)"/i);
    if (a) href = unwrapBingUrl(decodeHtml(a[1]));
  }
  if (!href) {
    const a = block.match(/<a[^>]+href="([^"]+)"/i);
    if (a) href = unwrapBingUrl(decodeHtml(a[1]));
  }
  const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const snippet = p ? decodeHtml(p[1]) : '';
  return { title, url: href, snippet };
}

/** 解析 Bing 结果页（只认带 b_algo 的那种形态；另一种形态返回空数组）。 */
export function parseBingHtml(html, limit = 8) {
  const max = Math.max(1, Number(limit) || 8);
  const out = [];
  for (const block of splitResultBlocks(html, 'b_algo')) {
    const r = parseBingBlock(block);
    if (r.title && r.url) out.push(r);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 解析 DuckDuckGo Lite（https://lite.duckduckgo.com/lite/）结果页。
 * 结构简单：结果链接是 <a class="result-link" href="...">标题</a>，摘要跟在后面的单元格里。
 */
export function parseDuckHtml(html, limit = 8) {
  const max = Math.max(1, Number(limit) || 8);
  const text = String(html ?? '');
  const out = [];
  const re = /<a[^>]+class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(text)) && out.length < max) {
    const url = decodeHtml(m[1]);
    const title = decodeHtml(m[2]);
    if (!title || !/^https?:\/\//i.test(url)) continue;
    // 摘要：往后找最近的 result-snippet 单元格。
    const tail = text.slice(m.index, m.index + 2000);
    const sn = tail.match(/class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    out.push({ title, url, snippet: sn ? decodeHtml(sn[1]) : '' });
  }
  // 兜底：老结构用 table 布局，result-link 可能不存在；试更宽松的链接匹配。
  if (!out.length) {
    const loose = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{4,120}?)<\/a>/gi;
    let n;
    while ((n = loose.exec(text)) && out.length < max) {
      const url = decodeHtml(n[1]);
      const title = decodeHtml(n[2]);
      if (!title || title.length < 2) continue;
      if (/duckduckgo\.com/i.test(url)) continue;
      out.push({ title, url, snippet: '' });
    }
  }
  return out;
}

/**
 * 解析百度结果页。百度现在的搜索结果主体是 <div class="result c-container" ...>，
 * 标题在 <h3><a ...>标题</a></h3>。摘要各种 class 不一，尽力取。
 */
export function parseBaiduHtml(html, limit = 8) {
  const max = Math.max(1, Number(limit) || 8);
  const text = String(html ?? '');
  const out = [];
  // 按 c-container 容器切块。
  const parts = text.split(/<div[^>]+class="[^"]*\bc-container\b[^"]*"/i).slice(1);
  for (const block of parts) {
    const h3 = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!h3) continue;
    const a = h3[1].match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const url = decodeHtml(a[1]);
    const title = decodeHtml(a[2]);
    if (!title || !/^https?:\/\//i.test(url)) continue;
    // 摘要：取块内最后一段可见文本（百度摘要 class 五花八门，取个大概）。
    const spans = [...block.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)]
      .map((s) => decodeHtml(s[1]))
      .filter((s) => s.length > 12);
    out.push({ title, url, snippet: spans.length ? spans[spans.length - 1].slice(0, 200) : '' });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 360 搜索解析器（https://www.so.com/s?q=）。
 * 结果块是 <li class="res-list" ...>，标题 <h3><a ...>，真实地址在 a 的 data-mdurl 属性里
 * （href 是 360 自己的 /link?m=... 跳转，别直接用）。
 */
export function parseSo360Html(html, limit = 8) {
  const max = Math.max(1, Number(limit) || 8);
  const text = String(html ?? '');
  const out = [];
  const starts = [];
  const mark = /<li\b[^>]*class="[^"]*\bres-list\b[^"]*"[^>]*>/gi;
  let m;
  while ((m = mark.exec(text))) starts.push(m.index + m[0].length);
  for (let i = 0; i < starts.length && out.length < max; i += 1) {
    const from = starts[i];
    const next = text.indexOf('<li', from);
    const block = text.slice(from, next === -1 ? from + 8000 : next);
    const a = block.match(/<h3[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const attrs = a[1] || '';
    const title = decodeHtml(a[2]);
    const md = attrs.match(/data-mdurl="([^"]+)"/i);
    const href = attrs.match(/href="([^"]+)"/i);
    let url = md ? decodeHtml(md[1]) : '';
    if (!/^https?:\/\//i.test(url)) {
      const h = href ? decodeHtml(href[1]) : '';
      url = /^https?:\/\//i.test(h) ? h : ''; // 相对跳转链接没有真实地址，丢弃
    }
    if (!title || !url) continue;
    const desc = block.match(/<(?:p|div)[^>]*class="[^"]*\bres-desc\b[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/i);
    out.push({ title, url, snippet: desc ? decodeHtml(desc[1]).slice(0, 200) : '' });
  }
  return out;
}

/**
 * 360 移动版解析器（https://m.so.com/s?q=）。
 *
 * 桌面版 www.so.com 在连打几次后必被风控，移动版的额度明显更宽，且结果质量不差
 * （实测「怎么把鸡蛋煮得不粘壳」直接给出抖音/好看的实操视频与图文答案）。
 * 移动版每条结果都是 <a href="https://m.so.com/jump?..." data-mdurl="真实URL">，
 * data-mdurl 就是真实地址 —— 比去解 jump 链接可靠。
 */
export function parseSo360MobileHtml(html, limit = 8) {
  const max = Math.max(1, Number(limit) || 8);
  const text = String(html ?? '');
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*data-mdurl="([^"]+)"[^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(text)) && out.length < max) {
    const url = decodeHtml(m[2] || '');
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    const plain = decodeHtml(m[3].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (plain.length < 6) continue;
    seen.add(url);
    out.push({ title: plain.slice(0, 120), url, snippet: plain.slice(120, 260) });
  }
  return out;
}

/**
 * 搜狗手机版解析器。
 *
 * 为什么要走手机版（实测 2026-10-18）：这台机器的出口 IP 用**桌面 Chrome UA**
 * 请求 www.sogou.com 会被直接 403（162 字节的 nginx 拒绝页），Firefox/Edge/iPad UA
 * 也一样；但换成 Android Chrome UA 立刻拿到 300KB+ 的完整结果页 ——
 * 说明它的风控是按 UA 分桶的，手机版给了另一条额度。
 *
 * 手机版标题在 <h3 class="vr-tit"><a ...>标题</a></h3> 里，而那个 a 的 href 是
 * 搜狗自己的跳转页，**真实地址在它的 pcurl=/url= 参数里**（URL 编码过），
 * 所以直接解出来用，别把跳转链丢给模型。
 */
export function parseSogouMobileHtml(html, limit = 8) {
  const max = Math.max(1, Number(limit) || 8);
  const text = String(html ?? '');
  const out = [];
  const seen = new Set();
  const re = /<h3[^>]*class="[^"]*vr-tit[^"]*"[^>]*>([\s\S]*?)<\/h3>/gi;
  let m;
  while ((m = re.exec(text)) && out.length < max) {
    const block = m[1] || '';
    const a = block.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const title = decodeHtml(a[2]);
    if (!title || title.includes('大家还在搜') || title.length < 2) continue;
    const attrs = a[1] || '';
    const pick = (key) => {
      const hit = attrs.match(new RegExp('[?&]' + key + '=([^&"\']+)', 'i'));
      return hit ? hit[1] : '';
    };
    const rawTarget = pick('pcurl') || pick('url');
    let url = '';
    if (rawTarget) {
      try { url = decodeURIComponent(rawTarget.replace(/&amp;/g, '&')); } catch { url = ''; }
    }
    if (!url) {
      const href = (attrs.match(/href="([^"]+)"/i) || [])[1] || '';
      if (href) url = href.startsWith('http') ? href : 'https://www.sogou.com/web' + href;
    }
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, snippet: '' });
  }
  return out;
}

/**
 * 搜狗解析器（https://www.sogou.com/web?query=）。
 * 结果标题是 <h3 class="vr-title"><a href="/link?url=...">标题</a></h3>；
 * href 是搜狗的跳转链接（浏览器/抓取时都能跟随到真页），保留成绝对地址。
 */
export function parseSogouHtml(html, limit = 8) {
  const max = Math.max(1, Number(limit) || 8);
  const text = String(html ?? '');
  const out = [];
  const starts = [];
  const mark = /<h3[^>]*class="[^"]*\bvr-title\b[^"]*"[^>]*>/gi;
  let m;
  while ((m = mark.exec(text))) starts.push(m.index + m[0].length);
  for (let i = 0; i < starts.length && out.length < max; i += 1) {
    const block = text.slice(starts[i], starts[i] + 4000);
    const a = block.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const attrs = a[1] || '';
    const href = (attrs.match(/href="([^"]+)"/i) || [])[1] || '';
    const title = decodeHtml(a[2]);
    if (!title || !href) continue;
    const url = /^https?:\/\//i.test(href) ? decodeHtml(href) : 'https://www.sogou.com' + decodeHtml(href);
    out.push({ title, url, snippet: '' });
  }
  return out;
}

/**
 * 查询词拆成可匹配的片段：英文/数字按词、中文按二元组（bigram）。
 * 用来算结果的相关度 —— 比直接信引擎自己的排序靠谱得多：
 * Bing 中文经常把「字词典」页面排到前几名（搜「原神 5.0 版本卡池」第一条是「原（汉语文字）」）。
 */
export function queryTokens(query) {
  const s = String(query ?? '').toLowerCase();
  const tokens = new Set();
  for (const w of s.match(/[a-z0-9][a-z0-9._+-]{1,}/g) || []) tokens.add(w);
  for (const run of s.replace(/[^\u4e00-\u9fa5]/g, ' ').split(/\s+/)) {
    if (run.length < 2) continue; // 单字太宽泛，会匹配所有东西
    for (let i = 0; i + 2 <= run.length; i += 1) tokens.add(run.slice(i, i + 2));
    if (run.length === 2) tokens.add(run);
  }
  return [...tokens];
}

/** 一条结果对查询的覆盖率：命中片段数 / 总片段数。 */
export function scoreResult(result, tokens) {
  const hay = String((result && result.title) || '') + ' ' + String((result && result.snippet) || '');
  const low = hay.toLowerCase();
  let hits = 0;
  for (const t of tokens) if (low.includes(t)) hits += 1;
  return { hits, score: tokens.length ? hits / tokens.length : 0 };
}

/**
 * 按相关度过滤 + 重排。
 * - 保留 score >= minScore（默认 0.3）或至少命中 2 个片段的结果；
 * - 全都被判为不相关时保留原样（宁可给点噪声，也别空手）；
 * - 同分保持引擎原顺序（稳定排序）。
 */
export function relevanceSplit(list, query, opts = {}) {
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!items.length) return { kept: [], dropped: 0, scored: [] };
  const tokens = queryTokens(query);
  if (!tokens.length) return { kept: items.slice(), dropped: 0, scored: [] };
  const minScore = Number.isFinite(opts.minScore) ? Number(opts.minScore) : 0.3;
  const minHits = Number.isFinite(opts.minHits) ? Number(opts.minHits) : 2;
  const scored = items.map((r, i) => ({ r, i, ...scoreResult(r, tokens) }));
  const kept = scored.filter((s) => s.score >= minScore || s.hits >= minHits);
  kept.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return { kept: kept.map((s) => s.r), dropped: items.length - kept.length, scored };
}

export function rankResults(list, query, opts = {}) {
  const { kept } = relevanceSplit(list, query, opts);
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  // 全被判为不相关时默认保留原样（宁可给点噪声，也别空手）。
  if (!kept.length && opts.keepAllIfEmpty !== false) return items.slice();
  return kept;
}

/**
 * 地址规范化：只留"这条结果到底是哪个页面"。
 * 三个源给同一条结果时，URL 常常只差 utm_*、末尾斜杠、www、http/https 或 #锚点 ——
 * 原来只 strip 末尾斜杠，去重形同虚设，一屏 6 条里 3 条是同一个页面。
 */
const TRACKING_PARAM_RE = /^(utm_|spm|scm|from|share_|ref$|referrer|fbclid|gclid|vd_source|buvid|wfr|ivk_sa|chksm)/i;
export function normalizeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  try {
    const x = new URL(s);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) {
      if (TRACKING_PARAM_RE.test(k)) x.searchParams.delete(k);
    }
    const host = x.hostname.toLowerCase().replace(/^www\./, '');
    const p = x.pathname.replace(/\/+$/, '');
    const qs = x.searchParams.toString();
    return `${host}${p}${qs ? `?${qs}` : ''}`;
  } catch {
    return s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('#')[0].replace(/\/+$/, '').toLowerCase();
  }
}

/** 标题指纹：去空白/标点/符号后比较，用来抓"同一条内容换了标题措辞"。 */
export function titleKey(t) {
  return String(t || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 合并两个结果列表，按规范化地址 + 标题指纹去重（保留先出现的那个）。 */
export function mergeResults(base, extra) {
  const out = [];
  const seen = new Set();
  const seenTitle = new Set();
  const push = (r) => {
    if (!r) return;
    const key = normalizeUrl(r.url);
    const tk = titleKey(r.title);
    if (key && seen.has(key)) return;
    // 标题完全相同且够长 ⇒ 基本是同一个页面换了入口地址，合并掉。
    if (tk && tk.length >= 6 && seenTitle.has(tk)) return;
    if (key) seen.add(key);
    if (tk && tk.length >= 6) seenTitle.add(tk);
    out.push(r);
  };
  for (const r of Array.isArray(base) ? base : []) push(r);
  for (const r of Array.isArray(extra) ? extra : []) push(r);
  return out;
}

/**
 * 结果该缓存多久：时效性内容不能缓存一天（价格/比分/新闻），
 * 常识和梗可以（她反复问同一个梗是最典型的命中场景）。
 */
const FAST_TTL_RE = /新闻|最新|今天|今日|昨天|刚刚|现在|实时|价格|多少钱|售价|股价|汇率|天气|气温|比分|赛程|战报|票房|销量|上映|开播|更新|版本|发布|政策|几点|开幕|闭幕|名单|排名/;
const SLOW_TTL_RE = /梗|黑话|是什么|为什么|怎么|如何|意思|出处|区别|教程|原理|历史|百科|介绍|哪些|推荐|评价/;
export const TTL_FAST_MS = 30 * 60 * 1000;
export const TTL_SLOW_MS = 24 * 3600 * 1000;
export const TTL_DEFAULT_MS = 6 * 3600 * 1000;
export function ttlForQuery(query) {
  const s = String(query || '');
  if (FAST_TTL_RE.test(s)) return TTL_FAST_MS;
  if (SLOW_TTL_RE.test(s)) return TTL_SLOW_MS;
  return TTL_DEFAULT_MS;
}

/**
 * 智能截断：不再"前 8000 字一刀切"。
 * 长教程/文档的关键结论经常在尾部，硬截断等于把答案丢掉；这里保留头（约 68%）
 * 和尾（约 32%），中间省略并告诉模型用 offset 续读，切点尽量落在换行/句号上。
 */
function cutIndex(text, from, to, dir) {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(text.length, Math.max(from, to));
  if (hi - lo <= 0) return lo;
  const window = 400;
  if (dir === 'back') {
    for (let i = hi; i >= Math.max(lo, hi - window); i -= 1) {
      if (/[\n。！？!?.]/.test(text[i - 1] || '')) return i;
    }
    return hi;
  }
  for (let i = lo; i <= Math.min(hi + window, text.length - 1); i += 1) {
    if (/[\n。！？!?.]/.test(text[i] || '')) return i + 1;
  }
  return lo;
}

export function smartTruncate(text, maxChars = 8000, baseOffset = 0) {
  const s = String(text ?? '');
  const max = Math.max(400, Number(maxChars) || 8000);
  const base = Math.max(0, Number(baseOffset) || 0);
  if (s.length <= max) return { text: s, truncated: false, nextOffset: 0, total: s.length };
  const headLen = Math.floor(max * 0.68);
  const tailLen = Math.floor(max * 0.32);
  const headEnd = cutIndex(s, 0, headLen, 'back');
  const tailStartRaw = Math.max(headEnd, s.length - tailLen);
  const tailStart = cutIndex(s, tailStartRaw, s.length, 'forward');
  const omitted = Math.max(0, tailStart - headEnd);
  const marker = `\n…（中间省略 ${omitted} 字；要看这一段用 offset=${base + headEnd}）\n`;
  return {
    text: s.slice(0, headEnd) + marker + s.slice(tailStart),
    truncated: true,
    nextOffset: base + tailStart,
    total: s.length
  };
}

/**
 * 引擎表：`{ name, buildUrl, parse, attempts }`。
 *
 * ⚠️ 源池里**只放实测可达的源**（2026-10-15 实测，校园网）：
 *   - **Bing**：可达，但每次约 50% 概率返回"无结果"形态 → 用 `attempts` 并发多打抵消。
 *   - ~~百度~~：直接返回「百度安全验证」反爬页（1438 字节），**必然失败** → 剔除。
 *   - ~~DuckDuckGo Lite~~：超时不可达 → 剔除。
 *   - **360 搜索**：可达，结果是带 data-mdurl 的真实地址；中文长句理解比 Bing 好，做第二源兜底。
 * 把死源留在池子里不是"更稳"，是**更慢** —— Promise.any 要等所有源都失败才算失败，
 * 一个恒失败的源会把整体耗时拖到它的超时上限。解析器仍导出（parseBaiduHtml / parseDuckHtml）
 * 便于以后网络环境变了再启用。
 */
/** 手机版 Chrome UA：搜狗/360 的手机版页面按 UA 分桶，桌面 UA 会被风控拒掉。 */
export const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';

/**
 * AnySearch 免费 JSON API（无需 key，匿名额度）：结构化结果、不会被 HTML 风控页拦。
 * 本机对搜狗/360 的 HTML 页面频繁 403/风控，这条 API 才是稳定主力源。
 */
export const ANYSEARCH_URL = 'https://api.anysearch.com/v1/search';

/** AnySearch 单次预算：它稳定但慢（实测 1.5–3s，冷启动 TLS 更久），比 HTML 源给得宽。 */
const ANYSEARCH_TIMEOUT_MS = 8000;

async function runAnysearch(query, { limit = 8, fetchImpl = null } = {}) {
  // 允许调用方注入 fetch（测试里必须能钉死网络，否则一个断言就会真的打到 api.anysearch.com）。
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const body = JSON.stringify({ query, max_results: Math.max(3, Math.min(10, Number(limit) || 8)) });
  let lastErr = null;
  // 失败重试一次：本机链路上偶发 abort/5xx 很常见，重试比换源快得多。
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ANYSEARCH_TIMEOUT_MS);
    try {
      const res = await doFetch(ANYSEARCH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.code !== 0) throw new Error(`API ${data?.message ?? data?.code}`);
      const list = Array.isArray(data?.data?.results) ? data.data.results : [];
      if (!list.length) {
        // 空结果多半是匿名额度被瞬时限流，不代表"真的没有"：退一下重试一次再认输。
        lastErr = new Error('无结果');
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 450));
          continue;
        }
        return [];
      }
      return list
        .filter((r) => r && r.url)
        .map((r) => ({
          title: String(r.title || r.url).slice(0, 120),
          url: String(r.url),
          snippet: String(r.snippet || r.content || '').slice(0, 200)
        }));
    } catch (err) {
      lastErr = err;
      if (attempt === 2) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('anysearch 失败');
}

export const SEARCH_ENGINES = [
  // AnySearch：无 key 的 JSON API，直接给相关结果（不会被 HTML 风控页拦），做第一主力。
  {
    name: 'anysearch',
    run: runAnysearch,
    attempts: 1
  },
  // 搜狗手机版：中文口语长句理解最好（「怎么把鸡蛋煮得不粘壳」直接给做法），
  // 且手机 UA 不会被桌面版那道 403 卡住。必须带 headers，否则 safe-fetch 默认的桌面 UA 会被拒。
  {
    name: 'sogou',
    buildUrl: (q) => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`,
    parse: parseSogouMobileHtml,
    headers: { 'user-agent': MOBILE_UA },
    attempts: 1
  },
  // 360 移动版：给的是带 data-mdurl 的真实地址；风控额度比桌面版宽，做第二中文源。
  {
    name: 'so360m',
    buildUrl: (q) => `https://m.so.com/s?q=${encodeURIComponent(q)}`,
    parse: parseSo360MobileHtml,
    attempts: 1
  },
  // Bing：本机这条出口链路上结果质量已经很差（常返「热门推荐」而非答案），
  // 只留作最后的兜底 + 英文场景（英文技术词它还行）。
  {
    name: 'bing',
    buildUrl: (q) => `https://cn.bing.com/search?q=${encodeURIComponent(q)}&form=QBLH&mkt=zh-CN`,
    parse: parseBingHtml,
    attempts: 2
  }
];

/** 备用源池（当前网络下不可用，仅保留解析器以便环境变化时启用）。 */
export const SEARCH_ENGINES_EXTRA = [
  // 桌面版搜狗：当前 IP 用桌面 UA 必 403，留着等换网络后手改回默认池。
  { name: 'sogou-web', buildUrl: (q) => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`, parse: parseSogouHtml, attempts: 1 },
  // 360 桌面版：中文理解最好，但连打三五次必被风控 —— 只当主源都不达标时的补刀。
  { name: 'so360', buildUrl: (q) => `https://www.so.com/s?q=${encodeURIComponent(q)}`, parse: parseSo360Html, attempts: 1 },
  // 下面两个在当前离线链路上恒失败（DDG 超时、百度出安全验证页，都要等它超时拖慢整体），
  // 解析器保留着，等换网络/挂代理后手改回 EXTRA 就能用。
  { name: 'duckduckgo', buildUrl: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, parse: parseDuckHtml, attempts: 1, disabled: true },
  { name: 'baidu', buildUrl: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`, parse: parseBaiduHtml, attempts: 1, disabled: true }
].filter((e) => !e.disabled);

/**
 * 出口探测用的备用源：本机链路上 DDG 超时、百度返安全验证页，所以默认不进源池。
 * 但网络环境会变（换网/挂代理），与其让人手改代码，不如启动时探一次：
 * 通了就自动并入，没通就继续用国内源。探测结果缓存 24 小时，不每次都探。
 */
export const PROBE_ENGINE_DEFS = {
  duckduckgo: { name: 'duckduckgo', buildUrl: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, parse: parseDuckHtml, attempts: 1 },
  baidu: { name: 'baidu', buildUrl: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`, parse: parseBaiduHtml, attempts: 1 }
};

/** 简单的 LRU + TTL 缓存。 */
export class SearchCache {
  constructor(max = CACHE_MAX_ENTRIES, ttlMs = CACHE_TTL_MS) {
    this.max = Math.max(1, Number(max) || CACHE_MAX_ENTRIES);
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.map = new Map(); // key -> { at, value }（Map 的插入顺序天然当 LRU 用）
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    // ttlMs <= 0 表示"立刻过期"（便于测试与"关缓存"），不是"永不过期"。
    if (this.ttlMs <= 0 || Date.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    // 命中后挪到末尾（最新）。
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { at: Date.now(), value });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
  get size() { return this.map.size; }
  clear() { this.map.clear(); }
}

/**
 * 多源并行竞速搜索。
 *
 * @param {string} rawQuery 原始查询词
 * @param {object} deps
 *   - `fetchText(url, timeoutMs)` → `{ statusCode, body }`（必填；生产用 safeFetch 包装）
 *   - `cache` SearchCache（可选）
 *   - `engines` 引擎表（可选，默认 SEARCH_ENGINES）
 *   - `limit` 每个源要几条（默认 8）
 *   - `timeoutMs` 每源独立超时（默认 SOURCE_TIMEOUT_MS）
 *   - `onSource` 每源完成时的回调（可选，便于日志/测试观测）
 * @returns `{ query, results, source, cached, tookMs, errors }`
 */
export async function searchWeb(rawQuery, deps = {}) {
  const query = sanitizeQuery(rawQuery);
  const started = Date.now();
  if (!query) {
    return { query: '', results: [], source: '', cached: false, tookMs: 0, errors: ['查询词为空'], note: '查询词为空，没法搜。' };
  }
  const {
    fetchText, cache = null, engines = SEARCH_ENGINES,
    // 调用方自定义源池时，默认不再去碰模块里的备用源（否则单测会真的打网络）。
    extraEngines = engines === SEARCH_ENGINES ? SEARCH_ENGINES_EXTRA : [],
    limit = 8, timeoutMs = SOURCE_TIMEOUT_MS, onSource = null,
    // 相关度全部不达标时，是否仍返回未过滤的原结果。默认 false：
    // 用户反馈过"搜出来一堆不相关的东西"，宁可她看到"没搜到"，也别喂一屏噪声。
    allowNoisyFallback = false,
    // 自定义 runner（anysearch）用的 HTTP 实现；生产不传就落到全局 fetch。
    fetchImpl = null
  } = deps;
  if (typeof fetchText !== 'function') throw new Error('searchWeb 需要 deps.fetchText');

  const cacheKey = `${query}::${limit}`;
  if (cache) {
    const hit = cache.get(cacheKey);
    if (hit) return { ...hit, cached: true, tookMs: Date.now() - started };
  }
  // 刚失败过就别再打一轮：直接告诉她为什么、接下来该怎么办。
  const memo = failureMemo.get(cacheKey);
  if (memo && Date.now() - memo.at < FAILURE_MEMO_MS) {
    return {
      query, results: [], source: '', cached: false, tookMs: Date.now() - started,
      errors: [], repeated: true,
      note: `刚查过一次也没搜到。${memo.note}`
    };
  }

  const errors = [];
  const attemptsOf = (engine) => {
    const n = Number(engine.attempts ?? 1);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(Math.floor(n), 8);
  };

  /** 打一次某个源；拿不到有效结果就 reject（由调用方汇总）。 */
  const runOnceRaw = async (engine, seq) => {
    const label = attemptsOf(engine) > 1 ? `${engine.name}#${seq}` : engine.name;
    const left = sourceCooldownLeft(engine.name);
    if (left > 0) {
      const msg = `${label}: 冷却中（还有 ${Math.ceil(left / 1000)}s）`;
      errors.push(msg);
      throw new Error(msg);
    }
    const t0 = Date.now();
    // 走自定义 runner 的源（JSON API，如 anysearch）：直接拿结构化结果，跳过 HTML 抓取与解析。
    if (typeof engine.run === 'function') {
      let apiResults = [];
      try {
        apiResults = (await engine.run(query, { timeoutMs, limit, fetchImpl })) || [];
      } catch (error) {
        const msg = `${label}: ${error?.message ?? error}`;
        errors.push(msg);
        if (onSource) onSource(label, { ok: false, ms: Date.now() - t0, count: 0, error: msg });
        throw new Error(msg);
      }
      if (!apiResults.length) {
        const msg = `${label}: 无有效结果`;
        errors.push(msg);
        if (onSource) onSource(label, { ok: false, ms: Date.now() - t0, count: 0, error: msg });
        throw new Error(msg);
      }
      if (onSource) onSource(label, { ok: true, ms: Date.now() - t0, count: apiResults.length });
      return { source: engine.name, results: apiResults };
    }
    const url = engine.buildUrl(query);
    let body = '';
    try {
      const res = engine.headers
        ? await fetchText(url, timeoutMs, { headers: engine.headers })
        : await fetchText(url, timeoutMs);
      body = String(res?.body || '');
      if (!res || res.statusCode < 200 || res.statusCode >= 300) {
        // 403 / 429 / 5xx：多半是风控，记冷却，别反复撞。
        setCooldown(engine.name);
        throw new Error(`HTTP ${res?.statusCode ?? '??'}`);
      }
      // 风控/异常页的典型特征：页面很短，或者标题里就是这些词。
      if (body.length < 8000 && /访问异常|安全验证|请输入验证码|Forbidden|403 Forbidden|captcha/i.test(body.slice(0, 3000))) {
        setCooldown(engine.name);
        throw new Error('命中风控页');
      }
    } catch (error) {
      const msg = `${label}: ${error?.message ?? error}`;
      errors.push(msg);
      if (onSource) onSource(label, { ok: false, ms: Date.now() - t0, count: 0, error: msg });
      throw new Error(msg);
    }
    let results = [];
    try { results = engine.parse(body, limit) || []; } catch (error) {
      const msg = `${label}: 解析失败 ${error?.message ?? error}`;
      errors.push(msg);
      if (onSource) onSource(label, { ok: false, ms: Date.now() - t0, count: 0, error: msg });
      throw new Error(msg);
    }
    if (!results.length) {
      const msg = `${label}: 无有效结果`;
      errors.push(msg);
      if (onSource) onSource(label, { ok: false, ms: Date.now() - t0, count: 0, error: msg });
      throw new Error(msg);
    }
    if (onSource) onSource(label, { ok: true, ms: Date.now() - t0, count: results.length });
    return { source: engine.name, results };
  };

  /**
   * 记录源健康度：成功/失败都记（冷却跳过不算失败 —— 那是我们主动不打，
   * 记进去会让"上次失败率"永远降不下来，源就再也回不来了）。
   */
  const runOnce = async (engine, seq) => {
    try {
      const r = await runOnceRaw(engine, seq);
      try { sourceHealthStore?.record(engine.name, true); } catch { /* */ }
      return r;
    } catch (error) {
      const msg = String(error?.message || '');
      if (!/冷却中/.test(msg)) {
        try { sourceHealthStore?.record(engine.name, false); } catch { /* */ }
      }
      throw error;
    }
  };

  /**
   * 并发打一组源，返回合并后的结果池。
   *
   * 为什么不纯用 Promise.any：竞速只拿"第一个成功"，但中文长句在 Bing 上经常
   * 第一个成功的是**不相关**的那份（字词典页），真正的答案在慢一点的搜狗/360 里。
   * 所以：先拿首个有效结果保底（决定耗时），再在宽限期内把其它源的结果并进来一起重排。
   */
  const gather = async (list) => {
    const pool = [];
    let firstSource = '';
    const tasks = [];
    for (const engine of list) {
      const n = attemptsOf(engine);
      for (let seq = 1; seq <= n; seq += 1) {
        const task = runOnce(engine, seq);
        task.then((value) => {
          if (!firstSource) firstSource = value.source;
          // 给每条结果打上来源标记，输出时才能如实写成「来自 anysearch+bing」而不是只报首个成功源。
          pool.push(...value.results.map((r) => (r && r.source ? r : { ...r, source: value.source })));
        }).catch(() => {});
        tasks.push(task);
      }
    }
    const settled = Promise.allSettled(tasks);
    if (!tasks.length) return { pool, firstSource: '', anyOk: false, settled };
    try {
      await Promise.any(tasks);
    } catch {
      return { pool, firstSource, anyOk: false, settled };
    }
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, MERGE_GRACE_MS))]);
    return { pool, firstSource, anyOk: true, settled };
  };

  const main = await gather(engines);
  if (!main.anyOk && !main.pool.length) {
    const note = failureHint(errors);
    failureMemo.set(cacheKey, { at: Date.now(), note });
    return { query, results: [], source: '', cached: false, tookMs: Date.now() - started, errors: [...new Set(errors)], note };
  }

  let pool = mergeResults([], main.pool);
  let split = relevanceSplit(pool, query);

  // 首个成功源可能只是噪声（Bing 常这样），而高质量源（JSON API）慢几百毫秒就被宽限期丢掉。
  // 相关结果为空时再等其余源落定一次，宁可多等一会儿也别让答案漏网。
  if (!split.kept.length && main.settled) {
    await Promise.race([main.settled, new Promise((resolve) => setTimeout(resolve, timeoutMs * 2))]);
    pool = mergeResults([], main.pool);
    split = relevanceSplit(pool, query);
  }

  // 相关结果太少（典型：中文长句被当成词典查询）才去打备用源，别让每次搜索都等它超时。
  if (split.kept.length < 3 && extraEngines.length) {
    const extra = await gather(extraEngines);
    pool = mergeResults(pool, extra.pool);
    split = relevanceSplit(pool, query);
  }

  // 全都对不上时：显式允许噪声就整池返回；否则给 2 条"最沾边"的线索并标注低相关。
  // 空手而归最伤人 —— 她只会换个说法再搜一遍，纯烧 token，还什么都拿不到。
  let ranked = split.kept;
  let lowConfidence = false;
  if (!ranked.length) {
    if (allowNoisyFallback) {
      ranked = pool.slice();
    } else if (pool.length) {
      ranked = split.scored
        .slice()
        .sort((a, b) => (b.score - a.score) || (a.i - b.i))
        .slice(0, 2)
        .map((s) => s.r);
      lowConfidence = ranked.length > 0;
    }
  }
  let note = '';
  if (!ranked.length) {
    note = failureHint(errors);
    failureMemo.set(cacheKey, { at: Date.now(), note });
  } else if (lowConfidence) {
    note = '相关度偏低，只是沾边的线索；想要更准就换成更短的实体词再搜。';
  }

  // 把"同一源另一个并发副本空手"这类噪音错误清掉，避免 errors 里一堆假警报。
  const engineNames = [...engines, ...extraEngines].map((e) => e.name).filter(Boolean);
  const noisy = engineNames.length
    ? new RegExp('^(?:' + engineNames.join('|') + ')#\\d+:\\s*(无有效结果|冷却中.*)', 'i')
    : null;
  const cleanErrors = [...new Set(errors)].filter((e) => !(noisy && noisy.test(e)) && !/: 冷却中/.test(e));

  // 标签要反映「结果实际来自哪些源」：首成功源可能只是噪声，真正答对的是后到的源。
  // [时效标注 2026-10-20] 每条结果抽发布时间；时效性查询若全是旧内容，明确警告。
  const dated = annotateDates(ranked, started);
  const usedSources = [...new Set(dated.map((r) => r.source).filter(Boolean))];
  const payload = {
    query,
    results: dated.slice(0, limit),
    source: usedSources.join('+') || main.firstSource,
    cached: false,
    tookMs: Date.now() - started,
    errors: cleanErrors
  };
  if (note) payload.note = note;
  if (lowConfidence) payload.lowConfidence = true;
  // 只有"时效性查询"（价格/比分/新闻…）才提示旧结果：问「这个梗哪来的」时
  // 五年前的百科条目完全正常，警告反而是噪音。
  if (ttlForQuery(query) === TTL_FAST_MS) {
    const stamped = payload.results.filter((r) => Number(r.dateTs) > 0);
    const staleAfter = 180 * 86400000;
    if (stamped.length && stamped.every((r) => started - Number(r.dateTs) > staleAfter)) {
      const oldest = stamped.reduce((a, r) => (Number(r.dateTs) < Number(a.dateTs) ? r : a), stamped[0]);
      payload.staleHint = `这批结果的日期都比较旧（最早 ${oldest.date}），可能不是最新情况。想要新的就换个更具体的词（加年份/月份/「最新」）再搜一次。`;
    }
  }
  // 只缓存"相关且非兜底"的结果：空结果是瞬时失败（限流/超时），低相关兜底也可能只是因为
  // 那一刻源被限流；两者缓存下来都会让她十分钟内反复收到同一批差结果，连重试的机会都没有。
  if (cache && payload.results.length && !lowConfidence) cache.set(cacheKey, { ...payload, tookMs: 0 });
  return payload;
}

/**
 * 从标题/摘要里抽发布时间。
 *
 * 为什么要做（2026-10-20）：引擎给的结果只有标题和摘要，**没有发布时间**。
 * 问她「最近那个事」，很可能拿回一篇三年前的页面当新闻答，而且看起来毫无破绽。
 * 抽出来标在结果上，至少能让她自己判断"这条是不是太旧了"。
 *
 * 只认两类：绝对日期（2023-05-12 / 2023年5月 / 2023/5/12）和相对时间（3天前 / 2小时前）。
 * 误判防护：年月必须合法、且不能晚于明天；「2000-3000元」这种会因月份非法被丢掉。
 */
export function extractDate(text, now = Date.now()) {
  const s = String(text || '');
  const abs = s.match(/(20\d{2})\s*[-/年.]\s*(\d{1,2})(?:\s*[-/月.]\s*(\d{1,2}))?/);
  if (abs) {
    const y = Number(abs[1]);
    const m = Number(abs[2]);
    const d = Number(abs[3] || 1);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const ts = Date.UTC(y, m - 1, d);
      if (ts <= now + 86400000) {
        const mm = String(m).padStart(2, '0');
        const label = abs[3] ? `${y}-${mm}-${String(d).padStart(2, '0')}` : `${y}-${mm}`;
        return { y, m, d, ts, label };
      }
    }
  }
  const rel = s.match(/(\d{1,3})\s*(分钟|小时|天|周|个?月|年)前/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const mult = unit === '分钟' ? 60000
      : unit === '小时' ? 3600000
        : unit === '天' ? 86400000
          : unit === '周' ? 7 * 86400000
            : unit.includes('月') ? 30 * 86400000 : 365 * 86400000;
    return { ts: now - n * mult, label: `${n}${unit}前` };
  }
  return null;
}

/** 给一批结果补上 date / dateTs（抽不到就原样留着，不编日期）。 */
export function annotateDates(list, now = Date.now()) {
  return (Array.isArray(list) ? list : []).map((r) => {
    if (!r) return r;
    const d = extractDate(`${r.title || ''} ${r.snippet || ''}`, now);
    return d ? { ...r, date: d.label, dateTs: d.ts } : r;
  });
}

/** 把搜索结果渲染成给模型看的紧凑文本（省 token：一行一条）。 */
export function renderSearchResult(payload, opts = {}) {
  const max = Math.max(1, Number(opts.max ?? 6) || 6);
  const list = Array.isArray(payload?.results) ? payload.results.slice(0, max) : [];
  if (!list.length) {
    // 不把每个引擎的私有报错甩给模型：她只需要知道"为什么"和"下一步"。
    // 原始 errors 仍留在 payload.errors 里，排障时可用。
    const hint = payload?.note
      || failureHint(payload?.errors)
      || '换个更短的词再试。';
    return `没搜到「${payload?.query ?? ''}」。${hint}`;
  }
  const head = `${payload.query}（来自 ${payload.source}${payload.cached ? '，缓存' : ''}）`;
  const lines = list.map((r, i) => {
    const sn = String(r.snippet || '').slice(0, 90);
    const dt = r.date ? `（${r.date}）` : '';
    return `${i + 1}. ${r.title}${dt}${sn ? ` — ${sn}` : ''}`;
  });
  const stale = payload?.staleHint ? `\n⚠ ${payload.staleHint}` : '';
  const note = payload?.note ? `\n⚠ ${payload.note}` : '';
  return `${head}\n${lines.join('\n')}${stale}${note}`;
}
