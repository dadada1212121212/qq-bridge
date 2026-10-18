// Exercise MCP callbacks with a fake transport: no network, config or stdio server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { z } from 'zod';
import { searchWeb, renderSearchResult, SearchCache, SOURCE_TIMEOUT_MS } from '../src/web-search-lib.js';

function loadWebTools(safeFetch) {
  const tools = new Map();
  const source = fs.readFileSync(new URL('../src/mcp-web-search-safe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  class McpServer {
    tool(name, description, schema, callback) { tools.set(name, { schema, callback }); }
    connect() {}
  }
  // web_search 的实现依赖 web-search-lib 的这几个导出 —— VM 里必须注入，
  // 否则 ReferenceError（这两行与 mcp-web-search-safe.js 的 import 保持一致）。
  vm.runInNewContext(source, {
    safeFetch, McpServer, StdioServerTransport: class {}, z, URL,
    // anysearch 直连 JSON API，不走 safeFetch；测试里必须把它也钉死，
    // 否则这些用例会偷偷打真网络（慢，而且结果随线上变化，断言就不稳了）。
    fetch: async () => { throw new Error('fixture: no network in tests'); },
    AbortController, setTimeout, clearTimeout,
    searchWeb, renderSearchResult, SearchCache, SOURCE_TIMEOUT_MS
  });
  return async (name, arguments_) => {
    const tool = tools.get(name);
    return tool.callback(z.object(tool.schema).parse(arguments_));
  };
}

test('MCP search uses bounded shared safeFetch after query sanitization', async () => {
  const calls = [];
  const callTool = loadWebTools(async (url, maxChars, opts) => {
    calls.push({ url, maxChars, opts });
    return { statusCode: 200, body: '<li class="b_algo"><h2><a href="https://example.com/">Fixture title</a></h2><p>Fixture summary</p></li>' };
  });
  const result = await callTool('web_search', { query: '  fixture [CQ:at,qq=1]\n phrase  ' });
  // 新契约：返回**渲染后的紧凑文本**（省 token），不再是 JSON。
  const text = result.content[0].text;
  assert.match(text, /fixture phrase/, '渲染结果里应出现清洗后的查询词');
  assert.match(text, /Fixture title/, '渲染结果里应出现结果标题');
  // 安全断言：查询词先清洗（去 CQ 码、压空白）再进 URL。
  // 不同源的参数名不一样（bing/q、sogou/query），这里按"任一参数等于清洗后的词"断言。
  const firstUrl = new URL(calls[0].url);
  const sentQuery = firstUrl.searchParams.get('q') || firstUrl.searchParams.get('query') || firstUrl.searchParams.get('word');
  assert.equal(sentQuery, 'fixture phrase');
  // 安全断言：仍然走受限传输、仍然限量。
  assert.equal(calls[0].maxChars, 512000);
  // 提速断言：每源请求带独立短超时（不再是 20s 默认）。
  assert.equal(typeof calls[0].opts?.timeoutMs, 'number');
  assert.ok(calls[0].opts.timeoutMs > 0 && calls[0].opts.timeoutMs <= SOURCE_TIMEOUT_MS);
});

test('MCP fetch uses shared transport and exposes rejection as a tool error', async () => {
  const callTool = loadWebTools(async () => { throw new Error('fixture: internal redirect rejected'); });
  // web_fetch 把 safeFetch 的拒绝作为工具错误抛出。
  const fetched = await callTool('web_fetch', { url: 'http://example.com' });
  assert.equal(fetched.isError, true);
  assert.match(fetched.content[0].text, /internal redirect rejected/);
  // web_search 全源失败时也要优雅地标成错误（不是抛异常），并把原因带给模型。
  const searched = await callTool('web_search', { query: 'fixture' });
  assert.equal(searched.isError, true);
  assert.match(searched.content[0].text, /没搜到|internal redirect rejected/);
});

test('empty searches are rejected without calling the transport', async () => {
  const callTool = loadWebTools(async () => { assert.fail('Unexpected transport call'); });
  const result = await callTool('web_search', { query: '[CQ:at,qq=1]\n ' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /查询词为空/);
});

/**
 * 用假 transport 加载 mcp-snowluma-safe.js，拿到它的工具回调。
 * 只需要把 fetch（桥接 API / OneBot HTTP）、McpServer、zod、两个本地纯模块塞进上下文。
 */
function loadSnowlumaTools(fetchImpl, fixtureConfig = null) {
  const tools = new Map();
  // vm 里没有 ESM 的 import.meta，把模块顶部的 __dirname 推导整段替换成固定值。
  const source = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace("const __dirname = path.dirname(fileURLToPath(import.meta.url));", "const __dirname = '/fixture/src';")
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  class McpServer {
    constructor() { this.tool = (name, description, schema, callback) => tools.set(name, { schema, callback }); }
    connect() {}
  }
  const fixtureFs = fixtureConfig === null ? fs : {
    ...fs,
    readFileSync(file, ...args) {
      if (path.basename(String(file)) === 'config.json' && String(file).includes('fixture')) {
        return JSON.stringify(fixtureConfig);
      }
      return fs.readFileSync(file, ...args);
    },
  };
  vm.runInNewContext(source, {
    McpServer,
    StdioServerTransport: class {},
    z,
    URL,
    URLSearchParams,
    fetch: fetchImpl,
    AbortSignal,
    process,
    setTimeout,
    clearTimeout,
    console,
    Buffer,
    path,
    fs: fixtureFs,
    SENSITIVE_RE: { test: () => false },
    serializeModelData: (value) => JSON.stringify(value),
  });
  return async (name, arguments_ = {}) => {
    const tool = tools.get(name);
    assert.ok(tool, `tool ${name} should be registered`);
    return tool.callback(z.object(tool.schema).parse(arguments_));
  };
}

// 回归：桥接用 200 + {ok:false} 表达业务失败（例如发送被安全审计拦截）。
// agentApi 若不检查 body.ok，就会把「被拦截」当成「发送成功」报给模型 ——
// 模型据此认为消息已发出，既不再重试也不告诉用户，是典型的静默错误。
test('a bridge 200 with ok:false is reported to the model as a failure', async () => {
  const callTool = loadSnowlumaTools(async () => Response.json(
    { ok: false, error: '消息含敏感信息，已阻止发送' },
    { status: 200 },
  ));
  const result = await callTool('qq_send_group_message', { groupId: '456', message: 'fixture' });
  assert.equal(result.isError, true, 'ok:false 必须作为工具错误返回');
  assert.match(result.content[0].text, /阻止发送/);
});

// 回归：旧只读工具没有会话令牌，只能用在封闭 agent（管理员私聊）里。
// 桥接的 /api/status 对「带 agent 令牌」的调用返回最小对象（不含 mode 字段），
// 于是「看到 reserved2 才拒绝」的黑名单写法会判定为假 ⇒ 在二代仿真模式下放行，
// 把白名单群名、群成员名单注入模型上下文。
test('legacy read tools fail closed unless the bridge reports closed-agent', async () => {
  for (const status of [
    { mode: 'reserved2' }, { mode: 'chat' }, { mode: 'reserved' },
    {},                       // 无 mode 字段（桥接对 agent 流量返回的最小状态）
  ]) {
    const callTool = loadSnowlumaTools(async () => Response.json(status));
    const result = await callTool('qq_list_groups', {});
    assert.equal(result.isError, true, `mode=${status.mode ?? '(缺失)'} 时旧只读工具必须拒绝`);
  }
  // 只有确认是 closed-agent 才放行
  const callTool = loadSnowlumaTools(async (url) => {
    if (String(url).includes('/api/status')) return Response.json({ mode: 'closed-agent' });
    return Response.json({ status: 'ok', retcode: 0, data: [{ group_id: 456, group_name: 'fixture' }] });
  });
  const result = await callTool('qq_list_groups', {});
  assert.notEqual(result.isError, true, 'closed-agent 下应放行');
});

test('denied legacy group reads never reveal the group allowlist', async () => {
  const fixtureConfig = { allow: { groups: ['111111', '222222'] } };
  for (const mode of ['reserved2', 'closed-agent']) {
    const calls = [];
    const callTool = loadSnowlumaTools(async (url) => {
      calls.push(String(url));
      if (String(url).includes('/api/status')) return Response.json({ mode });
      assert.fail('denied group read must not call OneBot');
    }, fixtureConfig);
    for (const name of ['qq_get_group_members', 'qq_get_group_history']) {
      const result = await callTool(name, { groupId: '999999' });
      assert.equal(result.isError, true, `${name} in ${mode} must fail`);
      assert.doesNotMatch(result.content[0].text, /111111|222222/);
    }
    assert.equal(calls.length, 2, 'only the two authorization checks should reach the bridge');
  }
});
