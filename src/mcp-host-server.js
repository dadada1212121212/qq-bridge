// SnowLuma 网关状态查询 MCP server（stdio）。
// 由 DSH 的 MCP 客户端 spawn（cordis.patch.yml 里 mcp-snowluma-host 行）。
//
// 工具：
//   snowluma_status   —— 检查网关是否在线（只读：HTTP get_login_info）与账号信息
//   qq_make_meme      —— 用本地梗图模板渲染一张图（可选直接发给 QQ）
//
// ── 为什么这里**没有**启停 SnowLuma 的工具（2026-09-20 移除，不要加回来）────────────
//
// 曾经有 `start_snowluma` / `stop_snowluma`（`spawn launcher.bat` / `taskkill`），默认关闭、
// 需要 `snowluma.allowProcessControl: true` 才注册。它们被移除，理由不是"危险"，而是**许可**：
//
//   SnowLuma EULA §5.4（中文为准）：「除事先取得著作权人的书面授权外，您仅可为 LICENSE 允许的
//   非商业用途，以专有组件随本软件提供的形式运行该组件；不得复制、修改、单独再分发或再许可该组件。
//   **将其并入第三方安装包或 Docker 镜像、通过自动化脚本部署**，或者将其用于任何商业用途，
//   均须事先取得书面授权。」
//
// 原生组件是**专有组件**；由本程序**程序化启动/结束**它，落在"通过自动化脚本部署"的射程内。
// 即便是"用户已装好、我们帮忙拉起"，也不值得为这点便利去踩一条需要书面授权的条款。
//
// 设计不变量 L6（见规划集 QSH_PLAN.md §6.0）：**QSH 只探测、不部署**——
// 永不安装、复制、打包或自动部署 SnowLuma 及其原生组件，也不程序化启停其进程。
// 用户在 QQ 侧不可用时得到的应该是**可操作的提示**（"请自行启动 SnowLuma"），而不是被代劳。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// 梗图渲染（起本地 PowerShell）刻意放在独立模块里：本文件是合规不变量 L6
// （SnowLuma EULA §5.4「只探测、不部署」，见 test-audit-setup-guards.mjs）的落点，
// 不得出现 spawn( / child_process / taskkill。详见 src/meme-render.mjs 顶部说明。
import {
  MEME_SCRIPT,
  MEME_OUT_DIR,
  MEME_TEMPLATES_DIR,
  memeSpecPath,
  runPowerShell,
  listMemeTemplates
} from './meme-render.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function getConfig() {
  return loadConfig();
}

function getHostConfig() {
  const c = getConfig();
  const httpUrl = (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const homeDir = c.snowluma?.homeDir ?? (c.snowluma?.launcherPath ? path.dirname(c.snowluma.launcherPath) : '');
  return { httpUrl, homeDir, token: c.snowluma?.accessToken ?? '' };
}

async function gatewayInfo() {
  const { httpUrl, token } = getHostConfig();
  try {
    const res = await fetch(`${httpUrl}/get_login_info`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请改为 OneBot HTTP API 地址）' : '';
      return { reachable: false, httpStatus: res.status, ...(hint ? { hint } : {}) };
    }
    const body = await res.json();
    if (body?.status === 'ok' && body?.retcode === 0) {
      return { reachable: true, online: true, user_id: body.data?.user_id, nickname: body.data?.nickname };
    }
    return { reachable: true, online: false, retcode: body?.retcode, wording: body?.wording };
  } catch (error) {
    return { reachable: false, error: String(error?.message ?? error) };
  }
}

// ── 梗图渲染（本地模板 + 文字 → PNG）──────────────────────────────────────────
//
// 渲染器是 PowerShell 脚本 `…\qq-dsh-bridge\scripts\meme-make.ps1`，模板与 JSON 描述在
// `…\qq-dsh-bridge\memes\templates\`。**起进程的那几行在 src/meme-render.mjs**：
// 本文件是 L6 合规断言（不得出现 spawn( / child_process）的落点，不在本文件里起进程。
// 这里只保留「参数怎么传」的口径：中文参数走一份 UTF-8 JSON 参数文件（-SpecFile），
// 免得引号/编码在 Windows 命令行上出事。

async function sendOneBotImage({ httpUrl, token, filePath, groupId, userId }) {
  // 重要：SnowLuma 跑在 WSL 里，它 stat 不到 Windows 的 C:\ 路径
  // （实测 file:///C:/... 会回 retcode 100 / ENOENT）。
  // bridge.js 里所有发图都走 `base64://`（v1.14.9 确认 record/image 段的 file 接受
  // 本地路径 / file:// / http(s):// / base64://），这里照抄同一条路。
  let fileField;
  try {
    const buf = fs.readFileSync(filePath);
    fileField = 'base64://' + buf.toString('base64');
  } catch (error) {
    return { sent: false, error: `读图失败：${String(error?.message ?? error)}` };
  }
  const endpoint = groupId
    ? `${httpUrl}/send_group_msg`
    : `${httpUrl}/send_private_msg`;
  const body = groupId
    ? { group_id: Number(groupId), message: [{ type: 'image', data: { file: fileField } }] }
    : { user_id: Number(userId), message: [{ type: 'image', data: { file: fileField } }] };
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
    return {
      sent: res.ok && (parsed ? parsed.retcode === 0 : true),
      httpStatus: res.status,
      retcode: parsed?.retcode,
      wording: parsed?.wording
    };
  } catch (error) {
    return { sent: false, error: String(error?.message ?? error) };
  }
}

const server = new McpServer({ name: 'snowluma-host', version: '0.2.0-r3' });
server.tool(
  'snowluma_status',
  '检查 SnowLuma OneBot 网关是否在线（只读探活 get_login_info）。返回网关可达性、QQ 在线状态与账号信息。网关不可达时返回可操作的提示（本程序不会代你启动 SnowLuma）。',
  {},
  async () => {
    const hc = getHostConfig();
    const info = await gatewayInfo();
    // 只读工具：不再暴露本机路径/PID（那需要进程控制能力，而该能力已被移除）。
    const payload = { ...info };
    if (info.reachable === false) {
      payload.hint = 'SnowLuma 网关不可达。请自行启动 SnowLuma（本程序不代装、不代启，原因见项目文档的合规说明 L6）。'
        + (hc.homeDir ? '' : ' 若 config.json 的 snowluma.httpUrl 与实际端口不一致，也请一并检查。');
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
);

server.tool(
  'qq_make_meme',
  [
    '用本地梗图模板把文字渲染成一张梗图 PNG，可选择立刻通过 QQ 发出去。',
    'template 传模板名（先用 list_only 看有哪些）；top/bottom 是上下字幕；text 是给居中文字框用的一串段落。',
    '默认只渲染不发送（send 省略或 false）；send=true 时必须给 group_id 或 user_id，否则拒绝发送。',
    '不填 template 但 send=true 时，必须给 top/title（或 bottom），否则拒绝——防止发出一张空白模板。'
  ].join(''),
  {
    template: z.string().optional().describe('模板名，例如 classic-white / blank-smile / whale-girl-happy；省略用 classic-white'),
    top: z.string().optional().describe('上字幕'),
    bottom: z.string().optional().describe('下字幕'),
    text: z.union([z.string(), z.array(z.string())]).optional().describe('居中文字框内容，可多段'),
    send: z.boolean().optional().describe('true 则渲染后立刻发出；默认 false 只渲染'),
    group_id: z.union([z.string(), z.number()]).optional().describe('发到群（与 user_id 二选一，优先 group）'),
    user_id: z.union([z.string(), z.number()]).optional().describe('发到私聊'),
    dry_run: z.boolean().optional().describe('true 时即使 send=true 也不真发，只报告将要发什么'),
    out: z.string().optional().describe('输出路径（省略则自动放到 memes/out/）'),
    format: z.enum(['png', 'jpg']).optional().describe('输出格式，默认 png；jpg 体积小很多、发 QQ 更快'),
    font_size: z.number().optional().describe('覆盖模板的字号上限'),
    list_only: z.boolean().optional().describe('true 则只返回模板清单，不渲染')
  },
  async ({ template, top, bottom, text, send, group_id, user_id, dry_run, out, format, font_size, list_only }) => {
    const asText = (value) => {
      if (value === undefined || value === null) return null;
      const s = String(value).trim();
      return s === '' ? null : s;
    };
    const tpl = asText(template) ?? 'classic-white';
    const topText = asText(top);
    const bottomText = asText(bottom);
    const textList = text === undefined || text === null
      ? []
      : (Array.isArray(text) ? text : [text]).map((s) => String(s)).filter((s) => s.trim() !== '');
    const groupId = asText(group_id);
    const userId = asText(user_id);

    if (list_only) {
      const names = listMemeTemplates();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ok: true, count: names.length, templates: names, dir: MEME_TEMPLATES_DIR }, null, 2)
        }]
      };
    }

    if (!fs.existsSync(MEME_SCRIPT)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `找不到渲染脚本：${MEME_SCRIPT}` }, null, 2) }],
        isError: true
      };
    }

    // 安全闸：不发送、或发送前必须有真实内容
    if (send && !dry_run) {
      if (!groupId && !userId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'send=true 必须给 group_id 或 user_id，已拒绝发送。' }, null, 2) }],
          isError: true
        };
      }
      if (topText === null && bottomText === null && textList.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'send=true 但没有任何文字内容，会发出一张空白模板，已拒绝。' }, null, 2) }],
          isError: true
        };
      }
    }

    // 参数走 JSON 文件，中文/引号不过命令行
    const spec = { template: tpl };
    if (topText !== null) spec.top = topText;
    if (bottomText !== null) spec.bottom = bottomText;
    if (textList.length > 0) spec.text = textList;
    if (out) spec.out = out;
    if (font_size && Number(font_size) > 0) spec.fontSize = Number(font_size);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const specPath = memeSpecPath();
    const ext = format === 'jpg' ? '.jpg' : '.png';
    const outPath = out
      ? path.resolve(out)
      : path.join(MEME_OUT_DIR, `meme-${tpl}-${stamp}${ext}`);
    try {
      fs.writeFileSync(specPath, JSON.stringify(spec), 'utf8');
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `写参数文件失败：${String(error?.message ?? error)}` }, null, 2) }],
        isError: true
      };
    }

    let render;
    try {
      render = await runPowerShell([
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', MEME_SCRIPT,
        '-SpecFile', specPath,
        '-Out', outPath
      ]);
    } finally {
      try { fs.unlinkSync(specPath); } catch { /* ignore */ }
    }

    const combined = `${render.stdout}\n${render.stderr}`;
    const outMatch = render.stdout.match(/^OUT=(.+)$/m);
    const generatedPath = outMatch ? outMatch[1].trim() : null;
    const notFit = (combined.match(/放不下/g) ?? []).length;
    const hasTemplate = !/找不到模板/.test(combined);

    const payload = {
      ok: render.code === 0 && generatedPath !== null,
      template: tpl,
      path: generatedPath ?? outPath,
      render: {
        exitCode: render.code,
        notFitCount: notFit,
        log: combined.trim().split(/\r?\n/).filter(Boolean).slice(-12)
      }
    };

    if (!hasTemplate) {
      payload.hint = `没有这个模板。可用模板：${listMemeTemplates().join(' / ')}`;
    }

    if (send && render.code === 0 && generatedPath) {
      if (dry_run) {
        payload.dryRun = true;
        payload.wouldSendTo = groupId ? { group_id: Number(groupId) } : { user_id: Number(userId) };
      } else {
        const hc = getHostConfig();
        payload.send = await sendOneBotImage({
          httpUrl: hc.httpUrl,
          token: hc.token,
          filePath: generatedPath,
          groupId,
          userId
        });
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      ...(payload.ok ? {} : { isError: true })
    };
  }
);

await server.connect(new StdioServerTransport());