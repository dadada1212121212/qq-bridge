// B 站只读 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn —— 注册方式与 mcp-web-search-safe 相同
// （scripts/setup-dsh.mjs 的 servers 表 + cordis.patch.yml 的 mcp-bilibili 条目）。
//
// 安全设计：
// - 只暴露 4 个只读工具：bili_search / bili_video / bili_hot / bili_user。
// - 不带登录 cookie（不碰任何账号数据），不做任何写操作（点赞/投币/关注/发弹幕一概没有）。
// - 域名白名单在 bilibili-lib.js 里写死为 api.bilibili.com。
//
// 数据层在 src/bilibili-lib.js（wbi 签名 / 风控兜底 / 格式化），这里只做工具壳。
import { createBili, formatVideos } from './bilibili-lib.js';
import { pickStr, missingArgHint, aliasFields } from './mcp-args.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// [养鱼 2026-10-21] 参数别名：模型对同一个东西的叫法不固定，实测它先猜 keyword
// 再猜 bvid，每次都撞在 zod 的「expected string at query」上白跑一轮。
// 这里把常见叫法一并声明成可选，handler 里按优先级取——见 src/mcp-args.js。
const Q_NAMES = ['query', 'keyword', 'keywords', 'q', 'text'];
const V_NAMES = ['video', 'bvid', 'bv', 'url', 'link', 'videoId'];
const U_NAMES = ['user', 'up', 'name', 'mid', 'uid'];
const MSG_NAMES = ['message', 'content', 'text', 'comment', 'msg'];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT_FILE = path.join(REPO_ROOT, 'state', 'bili-account.json');
const QUOTA_FILE = path.join(REPO_ROOT, 'state', 'bili-quota.json');

const bili = createBili({
  log: (...a) => console.error('[bilibili]', ...a) // stderr：stdout 是 MCP 协议通道，日志必须走 stderr
});
// [养鱼 2026-10-19] 登录态与频控都落在桥接 state/ 下（gitignore 覆盖，不入库）。
// state/bili-account.json 格式：{ "SESSDATA": "...", "bili_jct": "...", "DedeUserID": "..." }
bili._internal.setAuthLoader(async () => {
  try { return JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8')); }
  catch { return null; }
});
bili._internal.setQuotaFile(QUOTA_FILE);

function accountConfigured() {
  try {
    const a = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
    return !!(a?.SESSDATA && a?.bili_jct && a?.DedeUserID);
  } catch { return false; }
}

// [养鱼·评论区互动 2026-10-19] 她发过的顶层评论台账：MCP 只在发评论成功时追加，
// 桥接的 biliReplyTickV2 定期回来看有没有人回复（并回写 myRcount / lastCheckedAt）。
// 格式：{ entries: [{ aid, bvid, title, myRpid, myRcount, at, lastCheckedAt? }] }，上限 30 条。
const WATCH_FILE = path.join(REPO_ROOT, 'state', 'bili-comment-watch.json');
function loadWatch() {
  try {
    const j = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8'));
    if (Array.isArray(j?.entries)) return j;
  } catch { /* 新文件 */ }
  return { entries: [] };
}
function recordWatch(entry) {
  try {
    const w = loadWatch();
    if (!w.entries.some((e) => e.aid === entry.aid && e.myRpid === entry.myRpid)) w.entries.push(entry);
    if (w.entries.length > 30) w.entries = w.entries.slice(-30);
    fs.writeFileSync(WATCH_FILE, JSON.stringify(w));
  } catch (e) { console.error('[bilibili] watch 台账写入失败:', e?.message || e); }
}

const server = new McpServer({ name: 'bilibili-safe', version: '0.1.0' });

server.tool(
  'bili_search',
  '只读搜索 B 站视频或 UP 主（官方公开接口，1-3 秒）。搜视频标题、UP 主昵称都行；结果一行一条带链接、播放数。不执行任何本地操作。',
  {
    query: z.string().optional().describe('要搜的关键词（必填；传 keyword / q 也认）'),
    ...aliasFields(z, Q_NAMES, 'query'),
    kind: z.enum(['video', 'user']).optional().describe('搜什么：video=视频（默认），user=UP 主'),
    limit: z.number().int().min(1).max(10).optional().describe('要几条结果，默认 6')
  },
  async (args) => {
    const query = pickStr(args, Q_NAMES);
    if (!query) return { content: [{ type: 'text', text: missingArgHint('bili_search', 'query', '要搜的关键词，比如「DeepSeek」', args) }], isError: true };
    const { kind, limit } = args;
    try {
      const list = await bili.search(query, { kind: kind ?? 'video', limit: limit ?? 6 });
      const header = kind === 'user' ? '【B 站·UP 主搜索】' : '【B 站·视频搜索】';
      const text = list.length
        ? (kind === 'user'
          ? header + '\n' + list.map((u, i) => `${i + 1}. ${u.name}（mid=${u.mid}）｜${u.fans}粉丝·${u.videos}投稿${u.sign ? '｜' + u.sign.slice(0, 40) : ''}`).join('\n')
          : formatVideos(list, { header }))
        : `${header}没搜到「${query}」，换个更短的关键词试试`;
      return { content: [{ type: 'text', text }], isError: list.length === 0 };
    } catch (error) {
      return { content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'bili_video',
  '只读查 B 站视频详情：给 BV 号、av 号或 bilibili 视频链接，返回标题/UP主/播放/点赞/时长/简介。不执行任何本地操作。',
  { video: z.string().optional().describe('BV 号、av 号或 bilibili 视频链接（能从中认出 BV/av 即可）'), ...aliasFields(z, V_NAMES, 'video') },
  async (args) => {
    const video = pickStr(args, V_NAMES);
    if (!video) return { content: [{ type: 'text', text: missingArgHint('bili_video', 'video', 'BV 号 / av 号 / 视频链接，比如 BV1JaJo6jEqH', args) }], isError: true };
    try {
      const v = await bili.videoInfo(video);
      const date = v.pubdate ? new Date(v.pubdate * 1000).toISOString().slice(0, 10) : '';
      const text = `【B 站·视频】${v.title}\nUP：${v.up}｜发布：${date}｜时长 ${Math.floor(v.duration / 60)}分${v.duration % 60}秒\n`
        + `播放 ${v.play}｜弹幕 ${v.danmaku}｜点赞 ${v.like}｜投币 ${v.coin}｜收藏 ${v.favorite}｜评论 ${v.reply}\n`
        + `${v.desc ? '简介：' + v.desc + '\n' : ''}${v.url}`;
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'bili_hot',
  '只读拉取 B 站当前综合热门榜（前 10 条）。想聊最近什么视频火、找话题时用。不执行任何本地操作。',
  { limit: z.number().int().min(1).max(10).optional().describe('要几条，默认 6') },
  async ({ limit }) => {
    try {
      const list = await bili.popular({ limit: limit ?? 6 });
      return { content: [{ type: 'text', text: formatVideos(list, { header: '【B 站·当前热门】' }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取热门失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'bili_user',
  '只读查 B 站 UP 主信息：给昵称（会先搜人）或 mid，返回粉丝数/投稿数/签名。不执行任何本地操作。',
  { user: z.string().optional().describe('UP 主昵称或 mid（纯数字）'), ...aliasFields(z, U_NAMES, 'user') },
  async (args) => {
    const user = pickStr(args, U_NAMES);
    if (!user) return { content: [{ type: 'text', text: missingArgHint('bili_user', 'user', 'UP 主昵称或 mid', args) }], isError: true };
    try {
      const u = await bili.userInfo(user);
      const text = `【B 站·UP 主】${u.name}（mid=${u.mid}）\n粉丝 ${u.fans}｜投稿 ${u.videos}${u.sign ? '\n签名：' + u.sign.slice(0, 80) : ''}`;
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'bili_comments',
  '只读拉取 B 站视频的热门评论：给 BV 号或链接，返回评论人、内容、点赞数。想聊「大家怎么看这个视频」时用。不执行任何本地操作，不替你发评论。',
  {
    video: z.string().optional().describe('BV 号、av 号或 bilibili 视频链接'),
    ...aliasFields(z, V_NAMES, 'video'),
    sort: z.enum(['hot', 'time']).optional().describe('排序：hot=最热（默认），time=最新'),
    limit: z.number().int().min(1).max(15).optional().describe('要几条，默认 8')
  },
  async (args) => {
    const video = pickStr(args, V_NAMES);
    if (!video) return { content: [{ type: 'text', text: missingArgHint('bili_comments', 'video', 'BV 号 / av 号 / 视频链接', args) }], isError: true };
    const { sort, limit } = args;
    try {
      const r = await bili.comments(video, { sort: sort ?? 'hot', limit: limit ?? 8 });
      const head = `【B 站·评论】${r.title || '视频 ' + r.aid}（共 ${r.total} 条）\n`;
      const body = r.comments.length
        ? r.comments.map((c, i) => `${i + 1}. ${c.user}（赞${c.like}）：${c.text}`).join('\n')
        : '（这条视频还没有评论）';
      return { content: [{ type: 'text', text: head + body }], isError: r.comments.length === 0 };
    } catch (error) {
      return { content: [{ type: 'text', text: `拉评论失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'bili_user_videos',
  '只读拉取 B 站 UP 主的最近投稿列表：给昵称或 mid，返回最新几条视频。想追某个 UP 的更新时用。不执行任何本地操作。',
  {
    user: z.string().optional().describe('UP 主昵称或 mid（纯数字）'),
    ...aliasFields(z, U_NAMES, 'user'),
    limit: z.number().int().min(1).max(10).optional().describe('要几条，默认 5')
  },
  async (args) => {
    const user = pickStr(args, U_NAMES);
    if (!user) return { content: [{ type: 'text', text: missingArgHint('bili_user_videos', 'user', 'UP 主昵称或 mid', args) }], isError: true };
    const { limit } = args;
    try {
      const r = await bili.userVideos(user, { limit: limit ?? 5 });
      const header = `【B 站·${r.name || user} 的最近投稿】`;
      const text = r.count.length
        ? formatVideos(r.count, { header })
        : header + '\n（这个 UP 最近没有投稿）';
      return { content: [{ type: 'text', text }], isError: r.count.length === 0 };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'bili_anime',
  '只读搜索 B 站的番剧/国创/纪录片/影视条目：给名字（支持别名，比如「葬送的芙莉莲」），返回年份/类型/简介/观看链接。不执行任何本地操作。',
  {
    query: z.string().optional().describe('番剧或影视名'),
    ...aliasFields(z, Q_NAMES, 'query'),
    limit: z.number().int().min(1).max(8).optional().describe('要几条，默认 5')
  },
  async (args) => {
    const query = pickStr(args, Q_NAMES);
    if (!query) return { content: [{ type: 'text', text: missingArgHint('bili_anime', 'query', '番剧或影视名', args) }], isError: true };
    const { limit } = args;
    try {
      const list = await bili.animeSearch(query, { limit: limit ?? 5 });
      const text = list.length
        ? '【B 站·番剧/影视】\n' + list.map((a, i) => {
          const meta = [a.year, a.styles, a.areas].filter(Boolean).join('·');
          return `${i + 1}. ${a.title}${meta ? '｜' + meta : ''}${a.eval ? '｜' + a.eval : ''}${a.url ? '｜' + a.url : ''}`;
        }).join('\n')
        : `【B 站·番剧/影视】没搜到「${query}」，试试更正式的译名`;
      return { content: [{ type: 'text', text }], isError: list.length === 0 };
    } catch (error) {
      return { content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── [养鱼 2026-10-19] 写操作：以「肥鱼号」身份活动 ─────────────────────────
// 前提：state/bili-account.json 有完整 cookie（主人导入）。全部硬频控（评论 5/天、
// 点赞 20/天、投币 2/天、同类间隔 ≥30min、同视频只动一次）——养号像人，细水长流。
server.tool(
  'bili_whoami',
  '确认 B 站肥鱼号登录态：返回当前账号昵称/等级/硬币数。发评论前先确认一次，报「cookie 已失效」就提醒主人重新导 cookie。',
  {},
  async () => {
    if (!accountConfigured()) {
      return { content: [{ type: 'text', text: '【B 站】账号还没接入：请主人把浏览器登录后的 cookie 存到 state/bili-account.json（字段 SESSDATA / bili_jct / DedeUserID）。' }], isError: true };
    }
    try {
      const m = await bili.me();
      return { content: [{ type: 'text', text: `【B 站·肥鱼号】已登录：${m.uname}（Lv.${m.level}，硬币 ${m.coin}）——可以用 bili_post_comment / bili_like / bili_coin 了。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `登录态检查失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'bili_post_comment',
  '以肥鱼号身份在 B 站视频下发一条评论。**先用你自己的口吻写**（你是蓝色大肥鱼，评论也要像你），别复制别人的、别引战辱骂。硬频控：每天 5 条、同类间隔 30 分钟、同视频只评一次。要回复别人的评论（比如你的评论收到了回复）时传 root=那条评论的 rpid，这时不限「同视频一次」但仍占每日额度。',
  {
    video: z.string().optional().describe('BV 号、av 号或 bilibili 视频链接'),
    ...aliasFields(z, V_NAMES, 'video'),
    message: z.string().optional().describe('评论内容（用你的口吻，短句最好，≤500 字）'),
    ...aliasFields(z, MSG_NAMES, 'message'),
    root: z.string().optional().describe('要回复的评论 rpid（盖楼回复时传，普通评论不传）')
  },
  async (args) => {
    const video = pickStr(args, V_NAMES);
    const message = pickStr(args, MSG_NAMES);
    const { root } = args;
    if (!video) return { content: [{ type: 'text', text: missingArgHint('bili_post_comment', 'video', 'BV 号 / av 号 / 视频链接', args) }], isError: true };
    if (!message) return { content: [{ type: 'text', text: missingArgHint('bili_post_comment', 'message', '评论正文', args) }], isError: true };
    if (!accountConfigured()) {
      return { content: [{ type: 'text', text: '【B 站】账号还没接入，发不了评论：请主人导一次登录 cookie 到 state/bili-account.json。' }], isError: true };
    }
    try {
      const r = await bili.postComment(video, message, { root });
      // [评论区互动] 顶层评论记进 watch 台账，桥接会定期回来看有没有人回复。
      if (r.rpid && !r.root) recordWatch({ aid: r.aid, bvid: r.bvid, title: r.title, myRpid: r.rpid, myRcount: 0, at: Date.now() });
      return { content: [{ type: 'text', text: `【B 站】评论已发出（${r.title}）：\n「${r.text}」\n${r.url}${r.root ? `\n（这是对 ${r.root} 的楼中楼回复）` : ''}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发评论失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'bili_like',
  '以肥鱼号身份给一个视频点赞。硬频控：每天 20 次、同视频只一次。觉得视频真的不错再点，别乱点。',
  { video: z.string().describe('BV 号、av 号或 bilibili 视频链接') },
  async ({ video }) => {
    if (!accountConfigured()) {
      return { content: [{ type: 'text', text: '【B 站】账号还没接入：请主人导一次登录 cookie 到 state/bili-account.json。' }], isError: true };
    }
    try {
      const r = await bili.likeVideo(video);
      return { content: [{ type: 'text', text: `【B 站】已点赞：${r.title}（${r.bvid}）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `点赞失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'bili_coin',
  '以肥鱼号身份给一个视频投 1 枚硬币（硬币很珍贵，一天全站也就赚几枚；给真喜欢的视频）。硬频控：每天 2 次。',
  { video: z.string().describe('BV 号、av 号或 bilibili 视频链接') },
  async ({ video }) => {
    if (!accountConfigured()) {
      return { content: [{ type: 'text', text: '【B 站】账号还没接入：请主人导一次登录 cookie 到 state/bili-account.json。' }], isError: true };
    }
    try {
      const r = await bili.coinVideo(video);
      return { content: [{ type: 'text', text: `【B 站】已投 1 硬币：${r.title}（${r.bvid}）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `投币失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
