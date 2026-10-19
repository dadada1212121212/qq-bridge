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
// 响应提速（2026-10-15 重写 web_search 的数据层）：
//   原实现只抓 Bing 一个源，实测 Bing 在两种页面形态间随机切换（约 50% 的请求
//   一条结果都没有），且解析依赖精确字符串、Bing 一改 class 就全废。
//   现在改为 src/web-search-lib.js 的 **多源并行竞速 + 每源短超时 + 结果缓存**：
//   Bing / DuckDuckGo Lite / 百度同时打，谁先给出有效结果就用谁；
//   每源 3.5s 超时（不再等 20s）；同一个词第二次搜是零网络延迟。
import { safeFetch } from './safe-fetch.js';
import { searchWeb, renderSearchResult, SearchCache, SOURCE_TIMEOUT_MS } from './web-search-lib.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// 进程级搜索缓存：同一个词在她反复问"这是啥梗"时几乎都是命中，省下整趟网络往返。
const searchCache = new SearchCache();

/** 把 safeFetch 包成 web-search-lib 需要的 `fetchText(url, timeoutMs)`。 */
async function fetchText(url, timeoutMs) {
  const res = await safeFetch(url, 512000, { timeoutMs: timeoutMs || SOURCE_TIMEOUT_MS });
  return { statusCode: res.statusCode, body: res.body };
}

const server = new McpServer({ name: 'web-search-safe', version: '0.3.0-r1' });

server.tool(
  'web_search',
  '只读联网搜索（搜狗/360/Bing 多源并行 + 相关度过滤 + 缓存，通常 1-2 秒）。搜网络用语、梗、黑话、新闻、教程、事实都行；结果已按查询词过滤掉不相关条目，为空时会说明原因。不执行任何本地操作。',
  {
    query: z.string().describe('要搜索确认的网络用语/黑话/梗'),
    limit: z.number().int().min(1).max(10).optional().describe('要几条结果，默认 6')
  },
  async ({ query, limit }) => {
    try {
      const payload = await searchWeb(query, {
        fetchText, cache: searchCache, limit: limit ?? 8,
        // 直接透传当前 realm 的 fetch：生产是全局 fetch，测试里是 vm 注入的桩。
        fetchImpl: typeof fetch === 'function' ? fetch : null
      });
      const text = renderSearchResult(payload, { max: limit ?? 6 });
      return { content: [{ type: 'text', text }], isError: payload.results.length === 0 };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，返回纯文本前 8000 字符（超出会截断并注明总长）。禁止访问内网/本机地址，不执行任何本地操作。',
  { url: z.string().describe('要抓取的 http(s) URL') },
  async ({ url }) => {
    // [省token 2026-10-19] 原实现把整个 safeFetch 结果 JSON.stringify（正文上限 50000 字符）
    // 直接塞进上下文：一次抓取 = 2.5 万+ token，几轮就把会话撑到退役线（60k），
    // 下一轮全价重读。查证其实只需要正文开头 —— 8000 字封顶 + 纯文本，砍掉 80%+。
    const WEB_FETCH_MAX_CHARS = 8000;
    try {
      const result = await safeFetch(url, WEB_FETCH_MAX_CHARS + 4000);
      const body = typeof result?.body === 'string' ? result.body : '';
      const head = body.slice(0, WEB_FETCH_MAX_CHARS);
      const more = body.length > WEB_FETCH_MAX_CHARS
        ? `\n…（正文共 ${body.length} 字符，已截断到前 ${WEB_FETCH_MAX_CHARS}。要更多细节就换更具体的来源再 fetch，或用 web_search 拿摘要）`
        : (result?.truncated ? '\n…（源站响应过长，已按安全上限截断）' : '');
      const text = `【HTTP ${result?.statusCode ?? '?'}】${result?.url ?? url}\n${head}${more}`;
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      // 报错也要说人话：DNS 超时/被墙是最常见的一类，直接把"别在同一地址上重试、
      // 换镜像或改用 web_search"写进去，免得她换个 URL 再撞一次。
      const raw = String(error?.message ?? error);
      let host = '';
      try { host = new URL(url).host; } catch { host = ''; }
      const unreachable = /DNS 解析|ENOTFOUND|EAI_AGAIN|getaddrinfo|超时|timeout|Timed out/i.test(raw);
      const text = unreachable
        ? `抓取失败：本机连不上 ${host || url}（DNS 解析超时/被墙）。别在同一地址上重试；换镜像站，或者直接用 web_search 拿摘要。`
        : `抓取失败：${raw}`;
      return {
        content: [{ type: 'text', text }],
        isError: true,
      };
    }
  }
);

await server.connect(new StdioServerTransport());
