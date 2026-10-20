// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
//
// 2026-10-20 架构升级（A~G）：
//   A 结果缓存落盘：内存 LRU + state/search-cache.json，进程重启不再清零；
//     每条按查询类型给 TTL（新闻 30 分钟 / 梗 24 小时 / 其它 6 小时）。
//   B 查询卡片台账：每次搜索压成一张卡（state/search-cards.jsonl），
//     下次问近似问题先按 token 重叠召回（零网络）；桥接进程再把卡片 ingest 进记忆库。
//   C web_fetch 支持 offset 续读 + 智能截断（保头保尾、切点落在句子边界）。
//   D 源健康度落盘：长期失败的源跨重启继续跳过，不再每次白等 3.5s。
//   E 出口探测：DDG/百度探通就自动并入源池，不用手改代码。
//   F 合并去重按规范化 URL + 标题指纹（三个源给同一条只留一条）。
//   G 当日统计落盘：搜了几次、命中几次缓存、平均耗时，控制台可看。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFetch } from './safe-fetch.js';
import {
  searchWeb, renderSearchResult, SearchCache, SOURCE_TIMEOUT_MS,
  SEARCH_ENGINES, SEARCH_ENGINES_EXTRA, PROBE_ENGINE_DEFS,
  setSourceHealth, ttlForQuery, queryTokens, sanitizeQuery, smartTruncate,
  TTL_FAST_MS
} from './web-search-lib.js';
import { createDiskCache, createSourceHealth, createStats, createCardLog } from './search-store.js';
import { htmlToText } from './link-digest.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(REPO_ROOT, 'state');
const CACHE_FILE = path.join(STATE_DIR, 'search-cache.json');
const HEALTH_FILE = path.join(STATE_DIR, 'search-sources.json');
const STATS_FILE = path.join(STATE_DIR, 'search-stats.json');
const CARD_FILE = path.join(STATE_DIR, 'search-cards.jsonl');

/** stdio 传输下 stdout 是协议通道，日志一律走 stderr。 */
const log = (...args) => { try { console.error('[web-search]', ...args); } catch { /* */ } };

// ── 存储层 ────────────────────────────────────────────────────────────────
const memCache = new SearchCache();
const diskCache = createDiskCache({ file: CACHE_FILE, maxEntries: 300, log });
const health = createSourceHealth({ file: HEALTH_FILE, log });
setSourceHealth(health);
const stats = createStats({ file: STATS_FILE, log });
const cards = createCardLog({ file: CARD_FILE, log });

/**
 * 退出前把去抖中的写入落盘。
 * ⚠️ 实测踩到：MCP 是短命进程，客户端一断就被杀；800ms 去抖还没到点，
 * "最后一次搜索"的统计/缓存/健康度就整批丢了（第一次跑只留下 searches=1，net 和缓存全没写）。
 */
const flushers = [diskCache, health, stats];
const flushAll = () => { for (const f of flushers) { try { f.flush(); } catch { /* */ } } };
process.on('exit', flushAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  try { process.on(sig, () => { flushAll(); process.exit(0); }); } catch { /* 平台不支持就算了 */ }
}

/**
 * 两级缓存：内存（10 分钟）→ 磁盘（按查询类型 30 分钟~24 小时）。
 * `lastLayer` 给统计用：区分"命中的是内存还是落盘缓存"。
 */
const cache = {
  lastLayer: '',
  get(key) {
    const mem = memCache.get(key);
    if (mem) { this.lastLayer = 'mem'; return mem; }
    const disk = diskCache.get(key);
    if (disk) { this.lastLayer = 'disk'; memCache.set(key, disk); return disk; }
    this.lastLayer = '';
    return null;
  },
  set(key, value) {
    memCache.set(key, value);
    diskCache.set(key, value, ttlForQuery(value?.query || key));
  },
  get size() { return memCache.size; }
};

// ── 源池：出口探测通过就自动并入 ──────────────────────────────────────────
let activeEngines = SEARCH_ENGINES.slice();

function applyProbe(ok) {
  if (!ok || typeof ok !== 'object') return;
  for (const [key, passed] of Object.entries(ok)) {
    if (!passed) continue;
    const def = PROBE_ENGINE_DEFS[key];
    if (!def) continue;
    if (activeEngines.some((e) => e.name === def.name)) continue;
    // 换新数组而不是 push：正在进行的搜索持有的是旧引用，别让它在迭代中变长。
    activeEngines = activeEngines.concat([def]);
    log(`出口探测：${key} 可用，已并入源池（共 ${activeEngines.length} 个源）`);
  }
}

async function probeExits() {
  const out = {};
  for (const [key, def] of Object.entries(PROBE_ENGINE_DEFS)) {
    try {
      const res = await safeFetch(def.buildUrl('测试'), 20000, { timeoutMs: 4000 });
      const body = String(res?.body || '');
      out[key] = res?.statusCode === 200 && body.length > 8000
        && !/安全验证|captcha|访问异常|Forbidden/i.test(body.slice(0, 3000));
    } catch { out[key] = false; }
  }
  try { health.setProbe(out); } catch { /* 落盘失败不影响 */ }
  return out;
}

const probed = (() => { try { return health.probeCache(); } catch { return null; } })();
if (probed) applyProbe(probed);
else probeExits().then(applyProbe).catch((error) => log('出口探测失败：', error?.message ?? error));

// ── 工具函数 ──────────────────────────────────────────────────────────────
/** 把 safeFetch 包成 web-search-lib 需要的 `fetchText(url, timeoutMs, opts)`。 */
async function fetchText(url, timeoutMs, opts = {}) {
  // ⚠️ 2026-10-20 修：原来第三个参数（搜狗手机版必须的 mobile UA）在这里被丢掉，
  // 导致带 headers 的源实际用桌面 UA 请求 → 403 → 一直被冷却。
  const res = await safeFetch(url, 512000, {
    timeoutMs: timeoutMs || SOURCE_TIMEOUT_MS,
    headers: opts?.headers && typeof opts.headers === 'object' ? opts.headers : undefined
  });
  return { statusCode: res.statusCode, body: res.body };
}

/** 把一批结果压成一句话要点，供卡片/记忆使用。 */
function summarizeResults(results) {
  const r = results[0] || {};
  const t = String(r.title || '').replace(/\s+/g, ' ').trim();
  const s = String(r.snippet || '').replace(/\s+/g, ' ').trim();
  return (s ? `${t}：${s}` : t).slice(0, 90);
}

function agoText(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

/** 只显示"像正常网址"的链接：搜狗/360 的跳转链是一长串乱码，贴出来只会占地方。 */
function prettyUrl(u) {
  const s = String(u || '').trim();
  if (!s || s.length > 120) return '';
  if (/\/link\?url=|[?&]url=[A-Za-z0-9_-]{40,}/.test(s)) return '';
  try {
    const x = new URL(s);
    return x.hostname.includes('.') ? s : '';
  } catch { return ''; }
}

/** 把"以前查过"的卡片渲染成给模型看的文本。 */
function renderRecall(query, card) {
  const top = Array.isArray(card.top) ? card.top.slice(0, 5) : [];
  const lines = top.map((r, i) => {
    const u = prettyUrl(r.url);
    return `${i + 1}. ${r.title}${u ? ` — ${u}` : ''}`;
  });
  const when = card.at ? agoText(Date.now() - Number(card.at)) : '';
  return `${query}（以前查过${when ? `，${when}` : ''}）\n${lines.join('\n')}`
    + `${card.summary ? `\n要点：${card.summary}` : ''}`
    + '\n（这是我自己记着的旧结论，不是刚搜的；要最新信息就再搜一次。）';
}

const server = new McpServer({ name: 'web-search-safe', version: '0.4.0' });

server.tool(
  'web_search',
  '只读联网搜索（AnySearch + 搜狗/360/Bing 多源并行 + 相关度过滤 + 两级缓存，通常 1-2 秒）。搜网络用语、梗、黑话、新闻、教程、事实都行；问过的问题会先查我自己的记录，命中就直接给旧结论。不执行任何本地操作。',
  {
    query: z.string().describe('要搜索确认的网络用语/黑话/梗/事实'),
    limit: z.number().int().min(1).max(10).optional().describe('要几条结果，默认 6')
  },
  async ({ query, limit }) => {
    const started = Date.now();
    try {
      stats.bump('searches');
      const q = sanitizeQuery(query);
      const fetchLimit = limit ?? 8;

      // ① 两级缓存（内存 → 磁盘）：同一个词第二次问几乎都是这一步命中。
      const exact = cache.get(`${q}::${fetchLimit}`);
      if (exact) {
        stats.bump(cache.lastLayer === 'disk' ? 'diskHits' : 'memHits');
        return {
          content: [{ type: 'text', text: renderSearchResult({ ...exact, cached: true }, { max: limit ?? 6 }) }]
        };
      }

      // ② 卡片召回：近似问题（token 重叠 ≥60%）直接复用旧结论。
      //    时效性查询（价格/比分/新闻）不召回 —— 旧结论在这种问题上就是错的。
      if (q && ttlForQuery(q) !== TTL_FAST_MS) {
        const hit = cards.findByTokens(queryTokens(q), { maxAgeMs: 3 * 86400000 });
        if (hit) {
          stats.bump('memHits');
          return { content: [{ type: 'text', text: renderRecall(q, hit.card) }] };
        }
      }

      // ③ 真打网络。
      const payload = await searchWeb(q, {
        fetchText, cache, limit: fetchLimit,
        engines: activeEngines, extraEngines: SEARCH_ENGINES_EXTRA,
        fetchImpl: typeof fetch === 'function' ? fetch : null
      });
      const ms = Date.now() - started;
      stats.bump(payload.results.length ? 'net' : 'empty', ms);

      // ④ 结果压成卡片（低相关兜底不记 —— 那批线索不值得下次复用）。
      if (payload.results.length && !payload.lowConfidence) {
        cards.append({
          at: Date.now(),
          query: q,
          tokens: queryTokens(q),
          summary: summarizeResults(payload.results),
          top: payload.results.slice(0, 5).map((r) => ({
            title: String(r.title || '').slice(0, 80),
            url: String(r.url || '').slice(0, 200),
            source: String(r.source || '')
          }))
        });
      }

      return {
        content: [{ type: 'text', text: renderSearchResult(payload, { max: limit ?? 6 }) }],
        isError: payload.results.length === 0
      };
    } catch (error) {
      stats.bump('empty');
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true
      };
    }
  }
);

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，返回纯文本约 8000 字（长文保头保尾、中间省略）。正文很长时可以传 offset 接着往后读。禁止访问内网/本机地址，不执行任何本地操作。',
  {
    url: z.string().describe('要抓取的 http(s) URL'),
    offset: z.number().int().min(0).optional().describe('从正文第几个字符开始读（默认 0；用于接着读长文）')
  },
  async ({ url, offset }) => {
    // [省token 2026-10-19] 原实现把整个 safeFetch 结果 JSON.stringify（上限 50000 字符）
    // 塞进上下文：一次抓取 = 2.5 万+ token。8000 字封顶 + 纯文本，砍掉 80%+。
    // [2026-10-20] 硬截断改成智能截断：保头 68% + 保尾 32%，切点落在句子边界；
    // 中间省略的部分给 offset，想读就续读，不再"答案在尾部却永远看不到"。
    const FETCH_CHARS = 8000;
    // ⚠️ 单次最多从正文第 52000 字往后读：再往后要下载十几万字才够，不值当。
    // 原来是「from 夹到 200000、下载量夹到 60000」——两个上限不一致，offset 一大就
    // 必然拿到空串，然后对用户说"已经到正文末尾了"（其实是被自己的上限截住了）。
    const MAX_READ_CHARS = 52000;
    const asked = Math.max(0, Number(offset) || 0);
    if (asked > MAX_READ_CHARS) {
      return {
        content: [{
          type: 'text',
          text: `这一页太长了：单次最多只能从第 ${MAX_READ_CHARS} 字往后读（你要的是第 ${asked} 字）。换成更具体的来源，或者用 web_search 拿摘要。`
        }]
      };
    }
    const from = asked;
    // HTML 页面里标签/脚本占比很高（B 站首页 11000 字原始 HTML 只能换出几百字正文），
    // 所以按 3 倍抓原始内容，才够换出 8000 字正文。上限 20 万字，别把进程拖死。
    const want = Math.min((from + FETCH_CHARS + 3000) * 3, 200000);
    try {
      stats.bump('fetches');
      const result = await safeFetch(url, want);
      const rawBody = typeof result?.body === 'string' ? result.body : '';
      // ⚠️ 2026-10-20 修：这个工具一直号称"返回纯文本"，实际把**原始 HTML** 直接塞给模型。
      // 实测 B 站首页前 8000 字全是 <head>/<script>，正文一个字都没有 ——
      // 也就是说 8000 字预算基本全浪费在标签上，"抓正文"这个功能等于没生效。
      // 现在先判是不是 HTML，是就转纯文本；转完太短（纯 JS 渲染的空壳）才退回原始内容。
      const looksHtml = /^\s*(?:<!doctype|<html)|<body[\s>]|<div[\s>]|<p[\s>]|<article[\s>]/i.test(rawBody.slice(0, 2000));
      // 不做"转完太短就退回原始 HTML"那种兜底：8000 字标签对模型毫无价值，
      // 不如老实给几百字正文 + 一句"这页靠 JS 渲染"。
      const body = looksHtml ? htmlToText(rawBody) : rawBody;
      const slice = body.slice(from);
      const head = `【HTTP ${result?.statusCode ?? '?'}】${result?.url ?? url}${from > 0 ? `（从第 ${from} 字开始）` : ''}`;
      if (!slice.trim()) {
        return {
          content: [{
            type: 'text',
            text: `${head}\n（这里已经没内容了：读到第 ${body.length} 字${result?.truncated ? '，源站响应过长已按上限截断' : ''}）`
          }]
        };
      }
      const tr = smartTruncate(slice, FETCH_CHARS, from);
      // 页面是纯 JS 渲染时，转出来的正文只有导航栏几十个字 —— 直说，别让她对着几行菜单硬编。
      // ⚠️ 判据不能只看"短"：example.com 全文就 235 字但内容完整，说它"抓不到正文"是撒谎，
      // 模型会因此丢下手里的正文改去搜。加一条"原始 HTML 比正文大 8 倍以上"（标签/脚本占绝对多数）。
      const jsOnly = looksHtml && body.trim().length < 300 && rawBody.length > body.length * 8;
      // 续读入口要一直给：智能截断时指向被省略的中间段；被安全上限截断时指向读到的末尾。
      const tail = jsOnly
        ? '\n…（这页主要靠 JS 渲染，抓不到正文。换更具体的来源，或者用 web_search 拿摘要）'
        : (tr.truncated
          ? `\n…（${result?.truncated ? '至少 ' : '正文共 '}${body.length} 字；中间省略的部分用 offset=${tr.nextOffset} 续读）`
          : (result?.truncated ? `\n…（只读到第 ${body.length} 字，后面还有；继续读用 offset=${body.length}）` : ''));
      return { content: [{ type: 'text', text: `${head}\n${tr.text}${tail}` }] };
    } catch (error) {
      stats.bump('fetchFails');
      // 报错也要说人话：DNS 超时/被墙是最常见的一类，直接把"别在同一地址上重试、
      // 换镜像或改用 web_search"写进去，免得她换个 URL 再撞一次。
      const raw = String(error?.message ?? error);
      let host = '';
      try { host = new URL(url).host; } catch { host = ''; }
      const unreachable = /DNS 解析|ENOTFOUND|EAI_AGAIN|getaddrinfo|超时|timeout|Timed out/i.test(raw);
      const text = unreachable
        ? `抓取失败：本机连不上 ${host || url}（DNS 解析超时/被墙）。别在同一地址上重试；换镜像站，或者直接用 web_search 拿摘要。`
        : `抓取失败：${raw}`;
      return { content: [{ type: 'text', text }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
