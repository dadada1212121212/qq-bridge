// B 站只读数据层（给 mcp-bilibili.js 用，也可脱离 MCP 单测）。
//
// 为什么单独成文件：wbi 签名、风控兜底、输出格式都是纯逻辑，要在 scripts/test-bilibili-lib.mjs
// 里脱离 MCP 进程真跑/单测；MCP 服务器文件只做工具壳。
//
// 安全边界：只有只读的公开数据接口（搜索/视频信息/热门/用户信息）。
// 不带登录 cookie、不做任何写操作（点赞/投币/发弹幕一概没有）。
//
// 接口风控现状（2026-10）：
//   · x/web-interface/view、x/web-interface/popular、x/web-interface/card：公开，无需签名；
//   · x/web-interface/wbi/search/*：需要 wbi 签名（w_rid/wts）+ buvid3 cookie，否则 -412。
// buvid3 用公开的 finger/spi 接口现取（无需登录），wbi key 用 nav 接口现取（缓存 1h）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const API = 'https://api.bilibili.com';

// wbi 混淆表（bilibili-API-collect 社区维护的公开常量）。
const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

/** 按混淆表从 img_key+sub_key 取出 32 位 mixin key。 */
export function mixinKey(imgKey, subKey) {
  const raw = String(imgKey || '') + String(subKey || '');
  if (raw.length < 32) throw new Error('wbi key 长度不足');
  return MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
}

/** 给参数加 wts 并签名，返回可拼接的 query（含 w_rid）。值里的 !'()* 按 wbi 规范去除。 */
export function wbiSign(params, imgKey, subKey, wts = Math.floor(Date.now() / 1000)) {
  const mk = mixinKey(imgKey, subKey);
  const clean = { ...params, wts };
  const query = Object.keys(clean)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(clean[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const w_rid = crypto.createHash('md5').update(query + mk).digest('hex');
  return `${query}&w_rid=${w_rid}`;
}

/** 从「BV 号 / av 号 / 纯数字 / 完整链接」里解析视频标识；解析不出返回 null。 */
export function parseVideoId(input) {
  const s = String(input || '').trim();
  let m = s.match(/BV[0-9A-Za-z]{10}/);
  if (m) return { bvid: m[0] };
  m = s.match(/av(\d{3,})/i) || s.match(/^(\d{6,})$/);
  if (m) return { aid: m[1] };
  return null;
}

export function createBili({ fetchImpl, log = () => {} } = {}) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('没有可用的 fetch（node 18+ 或显式传入 fetchImpl）');
  let wbiCache = null; // { imgKey, subKey, at }
  let buvidCache = null; // { buvid3, at }

  async function rawJson(url, { timeoutMs = 8000, method = 'GET', body = null, auth = false } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = {
        'user-agent': UA,
        referer: 'https://www.bilibili.com/',
        origin: 'https://www.bilibili.com'
      };
      // [养鱼 2026-10-19] 写操作带登录 cookie。auth 的三件套来自 state/bili-account.json
      // （主人导出，不入库不进 git）。写操作的 referer 必须是具体页面路径，这里用主站兜底。
      if (auth) {
        const a = await ensureAuth();
        headers.cookie = `SESSDATA=${a.SESSDATA}; bili_jct=${a.bili_jct}; DedeUserID=${a.DedeUserID}`;
      }
      const init = { signal: ctrl.signal, headers };
      if (method !== 'GET') {
        init.method = method;
        init.headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        init.body = body;
      }
      const res = await f(url, init);
      if (!res.ok) throw new Error(`HTTP ${res.status ?? res.statusCode}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // [养鱼 2026-10-19] 登录态：{ SESSDATA, bili_jct, DedeUserID }。authLoader 由 MCP 壳注入
  // （读 state/bili-account.json），库层不碰文件系统，方便单测。
  //
  // ⚠️ 字段名统一用**真实 cookie 名**（下划线 bili_jct），因为导入脚本是直接按 cookie 名
  // 抓的、写进文件的也是 bili_jct。早期这里读的是 `a.biliJct`（驼峰）⇒ 校验永远失败、
  // cookie 头发成 `bili_jct=undefined`，写操作全废。归一放在这一处，下游一律用 bili_jct。
  let authLoader = null;
  function setAuthLoader(loader) { authLoader = loader; }
  async function ensureAuth() {
    if (!authLoader) throw new Error('B 站账号还没接入：这是写操作，需要先导入登录 cookie（见 bili-account.json 的导入说明）');
    const raw = await authLoader();
    if (!raw || typeof raw !== 'object') throw new Error('B 站账号文件读不出来：state/bili-account.json 不是合法 JSON，重新导一次');
    const a = {
      SESSDATA: String(raw.SESSDATA || '').trim(),
      // 兼容驼峰写法：老版本测试/手工编辑的文件里可能只有 biliJct。
      bili_jct: String(raw.bili_jct || raw.biliJct || '').trim(),
      DedeUserID: String(raw.DedeUserID || raw.dedeUserId || '').trim(),
    };
    const missing = ['SESSDATA', 'bili_jct', 'DedeUserID'].filter((k) => !a[k]);
    if (missing.length) {
      throw new Error(`B 站 cookie 不完整（缺 ${missing.join(' / ')}），重新导一次：node scripts/bili-import-cookie.mjs --stdin`);
    }
    return a;
  }

  async function getBuvid3() {
    if (buvidCache && Date.now() - buvidCache.at < 6 * 3600000) return buvidCache.buvid3;
    try {
      const j = await rawJson(`${API}/x/frontend/finger/spi`);
      const b3 = j?.data?.b_3;
      if (b3) { buvidCache = { buvid3: b3, at: Date.now() }; return b3; }
    } catch (e) { log('[bilibili] 取 buvid3 失败（兜底用随机值）:', e?.message || e); }
    const fallback = crypto.randomUUID();
    buvidCache = { buvid3: fallback, at: Date.now() };
    return fallback;
  }

  async function getWbiKeys() {
    if (wbiCache && Date.now() - wbiCache.at < 3600000) return wbiCache;
    const j = await rawJson(`${API}/x/web-interface/nav`);
    const img = String(j?.data?.wbi_img?.img_url || '');
    const sub = String(j?.data?.wbi_img?.sub_url || '');
    const imgKey = img.split('/').pop()?.replace(/\.\w+$/, '');
    const subKey = sub.split('/').pop()?.replace(/\.\w+$/, '');
    if (!imgKey || !subKey) throw new Error('nav 接口没给出 wbi key');
    wbiCache = { imgKey, subKey, at: Date.now() };
    return wbiCache;
  }

  async function biliGet(pathAndQuery, { signed = false } = {}) {
    const buvid3 = await getBuvid3();
    let url = API + pathAndQuery;
    if (signed) {
      const { imgKey, subKey } = await getWbiKeys();
      const [path, qs] = pathAndQuery.split('?');
      const params = Object.fromEntries(new URLSearchParams(qs || ''));
      url = `${API}${path}?${wbiSign(params, imgKey, subKey)}`;
    }
    const j = await rawJson(url, { });
    if (j?.code === -412) throw new Error('B 站风控（-412）：稍等几分钟再试，或换个说法再搜');
    if (j?.code !== 0) throw new Error(`B 站接口返回 ${j?.code ?? '?'}：${j?.message || j?.msg || '未知原因'}`);
    return j.data;
  }

  /** 搜视频/用户。kind: 'video' | 'user'。返回归一化数组（不格式化，格式化交给 formatXxx）。 */
  async function search(keyword, { kind = 'video', limit = 6 } = {}) {
    const st = kind === 'user' ? 'bili_user' : 'video';
    const data = await biliGet(`/x/web-interface/wbi/search/type?search_type=${st}&keyword=${encodeURIComponent(String(keyword || '').slice(0, 60))}&page=1`, { signed: true });
    const list = Array.isArray(data?.result) ? data.result : [];
    const out = [];
    for (const r of list) {
      if (kind === 'user') {
        const mid = r.mid != null ? String(r.mid) : '';
        if (!mid) continue;
        out.push({ kind: 'user', mid, name: stripEm(r.uname), sign: stripEm(r.usign || ''), fans: Number(r.fans) || 0, videos: Number(r.videos) || 0 });
      } else {
        const bvid = r.bvid;
        if (!bvid) continue;
        out.push({
          kind: 'video', bvid,
          title: stripEm(r.title),
          author: stripEm(r.author || ''),
          play: Number(r.play) || 0, danmaku: Number(r.video_review) || Number(r.danmaku) || 0,
          duration: String(r.duration || ''), pubdate: Number(r.pubdate) || 0,
          url: `https://www.bilibili.com/video/${bvid}`
        });
      }
      if (out.length >= Math.min(10, Math.max(1, limit))) break;
    }
    return out;
  }

  /** 视频详情。input 支持 BV 号 / av 号 / 纯数字 / 完整链接。 */
  async function videoInfo(input) {
    const id = parseVideoId(input);
    if (!id) throw new Error('认不出视频标识：给 BV 号、av 号或 bilibili 视频链接');
    const q = id.bvid ? `bvid=${id.bvid}` : `aid=${id.aid}`;
    const d = await biliGet(`/x/web-interface/view?${q}`);
    return {
      bvid: d.bvid, aid: d.aid, title: stripEm(d.title),
      up: stripEm(d.owner?.name || ''), mid: d.owner?.mid != null ? String(d.owner.mid) : '',
      play: Number(d.stat?.view) || 0, danmaku: Number(d.stat?.danmaku) || 0,
      like: Number(d.stat?.like) || 0, coin: Number(d.stat?.coin) || 0, favorite: Number(d.stat?.favorite) || 0,
      reply: Number(d.stat?.reply) || 0, duration: Number(d.duration) || 0,
      pubdate: Number(d.pubdate) || 0, desc: stripEm(String(d.desc || '')).slice(0, 160),
      url: `https://www.bilibili.com/video/${d.bvid}`
    };
  }

  /** 当前热门（综合热门页）。 */
  async function popular({ limit = 6 } = {}) {
    const d = await biliGet('/x/web-interface/popular?ps=20&pn=1');
    const list = Array.isArray(d?.list) ? d.list : [];
    return list.slice(0, Math.min(10, Math.max(1, limit))).map((v) => ({
      kind: 'video', bvid: v.bvid, title: stripEm(v.title), author: stripEm(v.owner?.name || ''),
      play: Number(v.stat?.view) || 0, danmaku: Number(v.stat?.danmaku) || 0,
      duration: Number(v.duration) || 0, pubdate: Number(v.pubdate) || 0,
      url: `https://www.bilibili.com/video/${v.bvid}`
    }));
  }

  /** 用户信息。input 支持 mid 或昵称（昵称先搜人再取卡片）。 */
  async function userInfo(input) {
    const s = String(input || '').trim();
    let mid = /^\d{5,}$/.test(s) ? s : '';
    let searched = null;
    if (!mid) {
      searched = await search(s, { kind: 'user', limit: 3 });
      if (!searched.length) throw new Error('没搜到这个 UP 主，换个名字试试');
      mid = searched[0].mid;
    }
    const d = await biliGet(`/x/web-interface/card?mid=${mid}`);
    return {
      mid: String(d.card?.mid ?? mid),
      name: stripEm(d.card?.name || (searched?.[0]?.name) || ''),
      sign: stripEm(d.card?.sign || ''),
      fans: Number(d.card?.fans) || 0, videos: Number(d.card?.archive_count) || (searched?.[0]?.videos) || 0
    };
  }

  /** 视频评论区。input 支持 BV 号 / av 号 / 链接。sort: 'hot'=最热(默认) | 'time'=最新。只读。 */
  async function comments(input, { sort = 'hot', limit = 8 } = {}) {
    // 评论区接口 oid 用 aid：给的是 bvid 时用 view 接口换（实测 archive/stat 被 WAF 挡回 HTML 404，
    // view 带同样的头是通的 —— 2026-10-19 真机验证）。
    const id = parseVideoId(input);
    if (!id) throw new Error('认不出视频标识：给 BV 号、av 号或 bilibili 视频链接');
    let aid = id.aid;
    let title = '';
    if (!aid) {
      const v = await biliGet(`/x/web-interface/view?bvid=${id.bvid}`);
      aid = v?.aid;
      title = stripEm(v?.title || '');
    }
    if (!aid) throw new Error('换 aid 失败：B 站接口没给出这个视频的 aid');
    const sn = sort === 'time' ? 0 : 2; // 官方 sort：0=时间 2=热度（1=点赞，这里只暴露两档）
    const d = await biliGet(`/x/v2/reply?type=1&oid=${aid}&pn=1&ps=20&sort=${sn}`);
    const out = [];
    for (const r of (Array.isArray(d?.replies) ? d.replies : [])) {
      const text = stripEm(String(r?.content?.message || '')).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      out.push({
        user: stripEm(r?.member?.uname || '?'),
        like: Number(r?.like) || 0,
        ctime: Number(r?.ctime) || 0,
        text: text.slice(0, 120),
        replies: Number(r?.rcount) || 0
      });
      if (out.length >= Math.min(15, Math.max(1, limit))) break;
    }
    return { aid, title, comments: out, total: String(d?.page?.acount || d?.page?.count || '?') };
  }

  /** UP 主的最近投稿。input 支持 mid 或昵称（昵称先搜人）。 */
  async function userVideos(input, { limit = 5 } = {}) {
    const s = String(input || '').trim();
    let mid = /^\d{5,}$/.test(s) ? s : '';
    let upName = '';
    if (!mid) {
      const found = await search(s, { kind: 'user', limit: 1 });
      if (!found.length) throw new Error('没搜到这个 UP 主，换个名字试试');
      mid = found[0].mid;
      upName = found[0].name;
    }
    // 空间投稿列表要 wbi 签名（x/space/wbi/arc/search）
    const d = await biliGet(`/x/space/wbi/arc/search?mid=${mid}&ps=15&pn=1&order=pubdate`, { signed: true });
    const list = Array.isArray(d?.list?.vlist) ? d.list.vlist : [];
    return {
      mid, name: upName || stripEm(d?.list?.vlist?.[0]?.author || ''),
      count: list.slice(0, Math.min(10, Math.max(1, limit))).map((v) => ({
        bvid: v.bvid, title: stripEm(v.title), play: Number(v.play) || 0,
        danmaku: Number(v.video_review) || 0, duration: String(v.length || ''),
        pubdate: Number(v.created) || 0,
        url: `https://www.bilibili.com/video/${v.bvid}`
      }))
    };
  }

  /** 番剧/影视搜索（media_bangumi：番剧+国创+纪录片+电影电视剧条目）。 */
  async function animeSearch(keyword, { limit = 5 } = {}) {
    const data = await biliGet(`/x/web-interface/wbi/search/type?search_type=media_bangumi&keyword=${encodeURIComponent(String(keyword || '').slice(0, 60))}&page=1`, { signed: true });
    const list = Array.isArray(data?.result) ? data.result : [];
    return list.slice(0, Math.min(8, Math.max(1, limit))).map((r) => ({
      title: stripEm(r.title),
      seasonId: r.season_id != null ? String(r.season_id) : '',
      styles: Array.isArray(r.styles) ? r.styles.join('/') : '',
      areas: Array.isArray(r.areas) ? r.areas.map((a) => a.name).join('/') : '',
      year: Number(r.pubtime) ? new Date(r.pubtime * 1000).toISOString().slice(0, 10) : '',
      eval: stripEm(r.desc || '').slice(0, 80),
      url: r.url ? String(r.url) : (r.season_id ? `https://www.bilibili.com/bangumi/play/ss${r.season_id}` : '')
    }));
  }

  // ── [养鱼 2026-10-19] 写操作（发评论/点赞/投币）—— 全部过持久频控 ──────────
  // 频控为什么持久化在文件：MCP server 是 stdio 短命进程，DSH 一重启内存计数就清零，
  // 那频控等于没有。状态文件放桥接 state/ 下（gitignore 覆盖，不入库）。
  // 硬限：评论 5 条/天、点赞 20 次/天、投币 2 个/天，同类操作间隔 ≥30 分钟，同视频只评一次。
  let quotaPath = null;
  function setQuotaFile(p) { quotaPath = p; }
  const QUOTA_CAPS = { comments: 5, likes: 20, coins: 2 };
  const QUOTA_NAMES = { comments: '评论', likes: '点赞', coins: '投币' };
  const QUOTA_GAP_MS = 30 * 60000;

  function loadQuota() {
    const day = new Date().toISOString().slice(0, 10);
    try {
      const j = JSON.parse(fs.readFileSync(quotaPath, 'utf8'));
      if (j?.day === day) return j;
    } catch { /* 新文件/损坏：按空额度开始 */ }
    return { day, comments: [], likes: [], coins: [], videoSeen: [] };
  }
  function saveQuota(q) {
    try {
      fs.mkdirSync(path.dirname(quotaPath), { recursive: true });
      fs.writeFileSync(quotaPath, JSON.stringify(q));
    } catch (e) { log('[bilibili] 频控文件写入失败:', e?.message || e); }
  }
  function quotaTake(q, kind) {
    const now = Date.now();
    const arr = (q[kind] || []).filter((t) => now - t < 86400000);
    if (arr.length >= QUOTA_CAPS[kind]) {
      throw new Error(`今日${QUOTA_NAMES[kind]}额度已用完（${QUOTA_CAPS[kind]} 次/天，防风控硬限）——养号像人，细水长流`);
    }
    if (arr.length && now - arr[arr.length - 1] < QUOTA_GAP_MS) {
      throw new Error(`距上一次${QUOTA_NAMES[kind]}不到 30 分钟，歇一会再动（防风控）`);
    }
    arr.push(now);
    q[kind] = arr;
  }
  function quotaCheckVideoOnce(q, aid) {
    if ((q.videoSeen || []).includes(aid)) throw new Error('这个视频今天已经互动过了，换一个（同一视频反复操作是最典型的机器人特征）');
    (q.videoSeen = q.videoSeen || []).push(aid);
    if (q.videoSeen.length > 50) q.videoSeen = q.videoSeen.slice(-50);
  }

  /** 我是谁（验证 cookie 是否有效）：带 auth 调 nav。 */
  async function me() {
    const j = await rawJson(`${API}/x/web-interface/nav`, { auth: true });
    if (j?.code === -101) throw new Error('cookie 已失效（B 站把这次请求当游客了）——重新导出一次登录 cookie');
    if (j?.code !== 0) throw new Error(`nav 返回 ${j?.code}: ${j?.message || ''}`);
    return parseNavAccount(j.data);
  }

  /** 以她的名义发一条评论（频控内）。input 支持 BV/av/链接。 */
  // [养鱼·评论区互动 2026-10-19] 以她的名义发评论（频控内）。
  // input 支持 BV/av/链接；opts.root = 要回复的评论 rpid（给别人评论盖楼用）。
  // 回复场景豁免「同视频只动一次」（在自己评论底下跟帖是正常人行为），但仍占每日评论额度。
  async function postComment(input, message, opts = {}) {
    const text = String(message || '').replace(/\s+/g, ' ').trim();
    if (!text) throw new Error('评论内容是空的');
    if (text.length > 500) throw new Error('评论太长（B 站上限约 500 字），说短点');
    const id = parseVideoId(input);
    if (!id) throw new Error('认不出视频标识：给 BV 号、av 号或 bilibili 视频链接');
    const v = await biliGet(`/x/web-interface/view?${id.bvid ? `bvid=${id.bvid}` : `aid=${id.aid}`}`);
    const q = loadQuota();
    const rootRpid = String(opts.root || '').replace(/\D/g, '');
    if (!rootRpid) quotaCheckVideoOnce(q, v.aid); // 盖楼回复不限「同视频一次」，顶层评论才限
    quotaTake(q, 'comments'); // 先占额度：写入失败也不返还，比超发安全
    const a = await ensureAuth();
    const body = new URLSearchParams({ oid: String(v.aid), type: '1', message: text, plat: '1', csrf: a.bili_jct });
    if (rootRpid) { body.set('root', rootRpid); body.set('parent', rootRpid); }
    const j = await rawJson(`${API}/x/v2/reply/add`, { method: 'POST', body: body.toString(), auth: true });
    if (j?.code !== 0) {
      const human = j?.code === -111 ? 'csrf 失效，重新导 cookie' : j?.code === -509 || j?.code === 12061 ? '触发风控/评论太快，今天先歇了' : j?.message || j?.msg || '未知原因';
      saveQuota(q);
      throw new Error(`评论失败（code ${j?.code}）：${human}`);
    }
    saveQuota(q);
    const myRpid = String(j?.data?.rpid || '');
    log(`[bilibili] 已评论 aid=${v.aid}${rootRpid ? `（回复 ${rootRpid}）` : ''}：${text.slice(0, 40)}`);
    return { ok: true, aid: v.aid, bvid: v.bvid, title: stripEm(v.title), text, rpid: myRpid, root: rootRpid || undefined, url: `https://www.bilibili.com/video/${v.bvid}` };
  }

  // ── [养鱼·评论区互动 2026-10-19] 读侧：找到她自己的评论、看别人回了什么 ──────
  /** 在视频评论区里找「她发的」评论（按账号 mid 匹配，时间序翻前两页）。 */
  async function myComments(input, myMid) {
    const id = parseVideoId(input);
    if (!id) throw new Error('认不出视频标识：给 BV 号、av 号或 bilibili 视频链接');
    let aid = id.aid;
    let title = '';
    if (!aid) {
      const v = await biliGet(`/x/web-interface/view?bvid=${id.bvid}`);
      aid = v?.aid;
      title = stripEm(v?.title || '');
    }
    if (!aid) throw new Error('换 aid 失败：B 站接口没给出这个视频的 aid');
    const midStr = String(myMid || '').replace(/\D/g, '');
    if (!midStr) throw new Error('没有账号 mid，没法认出哪条是她发的');
    const found = [];
    for (let pn = 1; pn <= 2 && found.length < 5; pn++) {
      // 时间序（sort=0）才翻得到自己的旧评论，热度序会被顶走
      const d = await biliGet(`/x/v2/reply?type=1&oid=${aid}&pn=${pn}&ps=49&sort=0`);
      const list = Array.isArray(d?.replies) ? d.replies : [];
      if (!list.length) break;
      for (const r of list) {
        if (String(r?.member?.mid) !== midStr) continue;
        found.push({
          rpid: String(r?.rpid || ''),
          text: stripEm(String(r?.content?.message || '')).slice(0, 120),
          like: Number(r?.like) || 0,
          rcount: Number(r?.rcount) || 0,
          ctime: Number(r?.ctime) || 0
        });
      }
    }
    return { aid, bvid: id.bvid || '', title, comments: found };
  }

  /** 拉某条评论（rootRpid）楼里的回复，第一页最新 20 条。 */
  async function commentReplies(input, rootRpid) {
    const id = parseVideoId(input);
    if (!id) throw new Error('认不出视频标识：给 BV 号、av 号或 bilibili 视频链接');
    let aid = id.aid;
    if (!aid) {
      const v = await biliGet(`/x/web-interface/view?bvid=${id.bvid}`);
      aid = v?.aid;
    }
    const root = String(rootRpid || '').replace(/\D/g, '');
    if (!aid || !root) throw new Error('需要视频标识和楼中楼的 rpid');
    const d = await biliGet(`/x/v2/reply/reply?type=1&oid=${aid}&root=${root}&pn=1&ps=20&sort=0`);
    const out = (Array.isArray(d?.replies) ? d.replies : []).map((r) => ({
      rpid: String(r?.rpid || ''),
      user: stripEm(r?.member?.uname || '?'),
      text: stripEm(String(r?.content?.message || '')).slice(0, 120),
      ctime: Number(r?.ctime) || 0
    }));
    return { aid, root, replies: out, total: String(d?.page?.count || out.length) };
  }

  /** 点赞（频控内）。 */
  async function likeVideo(input) {
    const id = parseVideoId(input);
    if (!id) throw new Error('认不出视频标识：给 BV 号、av 号或 bilibili 视频链接');
    const v = await biliGet(`/x/web-interface/view?${id.bvid ? `bvid=${id.bvid}` : `aid=${id.aid}`}`);
    const q = loadQuota();
    quotaCheckVideoOnce(q, v.aid);
    quotaTake(q, 'likes');
    const a = await ensureAuth();
    const body = new URLSearchParams({ aid: String(v.aid), like: '1', csrf: a.bili_jct });
    const j = await rawJson(`${API}/x/web-interface/archive/like`, { method: 'POST', body: body.toString(), auth: true });
    if (j?.code !== 0) { saveQuota(q); throw new Error(`点赞失败（code ${j?.code}）：${j?.message || j?.msg || '未知原因'}`); }
    saveQuota(q);
    return { ok: true, bvid: v.bvid, title: stripEm(v.title) };
  }

  /** 投 1 枚硬币（频控内，默认不同时点赞）。 */
  async function coinVideo(input) {
    const id = parseVideoId(input);
    if (!id) throw new Error('认不出视频标识：给 BV 号、av 号或 bilibili 视频链接');
    const v = await biliGet(`/x/web-interface/view?${id.bvid ? `bvid=${id.bvid}` : `aid=${id.aid}`}`);
    const q = loadQuota();
    quotaCheckVideoOnce(q, v.aid);
    quotaTake(q, 'coins');
    const a = await ensureAuth();
    const body = new URLSearchParams({ oid: String(v.aid), bvid: v.bvid, multiply: '1', select_like: '0', csrf: a.bili_jct });
    const j = await rawJson(`${API}/x/web-interface/coin/add`, { method: 'POST', body: body.toString(), auth: true });
    if (j?.code !== 0) { saveQuota(q); throw new Error(`投币失败（code ${j?.code}）：${j?.message || j?.msg || '未知原因（硬币不足/自己视频/风控）'}`); }
    saveQuota(q);
    return { ok: true, bvid: v.bvid, title: stripEm(v.title) };
  }

  return {
    search, videoInfo, popular, userInfo, comments, userVideos, animeSearch,
    postComment, likeVideo, coinVideo, me, myComments, commentReplies,
    _internal: { getBuvid3, getWbiKeys, biliGet, setAuthLoader, ensureAuth, setQuotaFile, loadQuota }
  };
}

/** 去掉搜索结果标题里的 <em class="keyword"> 高亮标签。 */
/**
 * nav 接口的 `data` → 统一的账号信息。
 *
 * ⚠️ 等级在 `level_info.current_level`，**不是** `data.level`（后者不存在）。
 * 原来直接读 `d.level` ⇒ 打印出来是 "Lv.undefined"。老版本接口可能有 data.level，留作兜底。
 */
export function parseNavAccount(d) {
  const data = d || {};
  return {
    mid: String(data.mid ?? ''),
    uname: String(data.uname ?? ''),
    level: Number(data.level_info?.current_level ?? data.level ?? 0) || 0,
    coin: Number(data.money ?? 0) || 0,
    isLogin: !!data.isLogin,
  };
}

/**
 * 从「扫码登录成功后 B 站回调的那个 URL」里取出 cookie 三件套。
 *
 * 回调形如：
 *   https://passport.biligame.com/crossDomain?DedeUserID=123&DedeUserID__ckMd5=abc
 *     &Expires=1700000000&SESSDATA=xxxx%2Cyyyy&bili_jct=csrf&gourl=...
 *
 * ⚠️ **绝不能**用 `new URL(u).searchParams.get('SESSDATA')`：那会把 `%2C` 解码成逗号。
 * 而 SESSDATA 里的 `%2C` 是 cookie 值**本身**（浏览器发出去就是带 %2C 的原文），
 * 解码后再当 cookie 用，B 站会认为令牌无效。所以这里按原文取，不解码。
 */
export function parseQrLoginUrl(url) {
  const s = String(url || '');
  const qs = s.includes('?') ? s.slice(s.indexOf('?') + 1) : s;
  const raw = (name) => {
    const m = new RegExp(`(?:^|&)${name}=([^&]*)`).exec(qs);
    return m ? m[1].trim() : '';
  };
  return { SESSDATA: raw('SESSDATA'), bili_jct: raw('bili_jct'), DedeUserID: raw('DedeUserID') };
}

export function stripEm(s) {
  return String(s ?? '').replace(/<em[^>]*>/g, '').replace(/<\/em>/g, '');
}

export function formatDuration(sec) {
  const n = Number(sec) || 0;
  const m = Math.floor(n / 60), r = Math.floor(n % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function compactCount(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(v);
}

/** 一条视频 → 一行紧凑文本（给模型看，也方便她直接转述）。 */
export function formatVideo(v, i) {
  const idx = i != null ? `${i}. ` : '';
  const date = v.pubdate ? new Date(v.pubdate * 1000).toISOString().slice(0, 10) : '';
  const dur = v.duration ? ` ${typeof v.duration === 'string' ? v.duration : formatDuration(v.duration)}` : '';
  return `${idx}${v.title}｜UP:${v.author || '?'}｜${compactCount(v.play)}播放·${compactCount(v.danmaku)}弹幕${dur}${date ? '｜' + date : ''}｜${v.url}`;
}

export function formatVideos(list, { header } = {}) {
  if (!Array.isArray(list) || !list.length) return String(header || '') + '（没有结果）'.trim();
  const lines = list.map((v, i) => formatVideo(v, i + 1));
  return (header ? header + '\n' : '') + lines.join('\n');
}
