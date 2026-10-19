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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const bili = createBili({
  log: (...a) => console.error('[bilibili]', ...a) // stderr：stdout 是 MCP 协议通道，日志必须走 stderr
});

const server = new McpServer({ name: 'bilibili-safe', version: '0.1.0' });

server.tool(
  'bili_search',
  '只读搜索 B 站视频或 UP 主（官方公开接口，1-3 秒）。搜视频标题、UP 主昵称都行；结果一行一条带链接、播放数。不执行任何本地操作。',
  {
    query: z.string().describe('要搜的关键词'),
    kind: z.enum(['video', 'user']).optional().describe('搜什么：video=视频（默认），user=UP 主'),
    limit: z.number().int().min(1).max(10).optional().describe('要几条结果，默认 6')
  },
  async ({ query, kind, limit }) => {
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
  { video: z.string().describe('BV 号、av 号或 bilibili 视频链接（能从中认出 BV/av 即可）') },
  async ({ video }) => {
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
  { user: z.string().describe('UP 主昵称或 mid（纯数字）') },
  async ({ user }) => {
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
    video: z.string().describe('BV 号、av 号或 bilibili 视频链接'),
    sort: z.enum(['hot', 'time']).optional().describe('排序：hot=最热（默认），time=最新'),
    limit: z.number().int().min(1).max(15).optional().describe('要几条，默认 8')
  },
  async ({ video, sort, limit }) => {
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

await server.connect(new StdioServerTransport());
