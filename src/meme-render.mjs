// 梗图渲染：起一个本地 PowerShell 调 `qq-dsh-bridge\scripts\meme-make.ps1` 出图。
//
// ⚠️ 为什么单独一个文件（别把这几行搬回 mcp-host-server.js）：
//   `src/mcp-host-server.js` 是合规不变量 L6（SnowLuma EULA §5.4「只探测、不部署」）的落点，
//   `scripts/test-audit-setup-guards.mjs` 断言那个文件里**不得出现** `spawn(` /
//   `child_process` / `taskkill`（它历史上真有 `start_snowluma`/`stop_snowluma`，
//   默认关闭过，后来整段删掉了——那条断言的注释里写着「不得再出现」）。
//   梗图渲染要起一个本地进程，但跟 SnowLuma 的生命周期毫无关系，属于「本机执行能力」而不是
//   「SnowLuma 部署」。把起进程的代码收在这个显式命名的模块里，能同时满足两件事：
//     · 面向 SnowLuma 的那个 host server 继续零进程控制（断言原样保留，不是放宽）；
//     · 本机执行面只有一个可审计的入口，谁在用执行能力一眼可见。
//
// 另：仿真会话里**能不能**调到这个能力，不由此文件决定，而是 preset 守卫
// `qq-tool-restrict.mjs` 的 SAFE_PREFIXES —— 它显式放行 `mcp__snowluma-host__`
// （即她可以调 qq_make_meme，这是有意开的口子；对照铁律 L7 的讨论见进度文档 §0.30）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const QQ_DSH_BRIDGE = path.resolve(ROOT, '..', 'qq-dsh-bridge');
export const MEME_SCRIPT = path.join(QQ_DSH_BRIDGE, 'scripts', 'meme-make.ps1');
export const MEME_OUT_DIR = path.join(QQ_DSH_BRIDGE, 'memes', 'out');
export const MEME_TEMPLATES_DIR = path.join(QQ_DSH_BRIDGE, 'memes', 'templates');

/** 参数文件路径（中文/引号不走命令行，见调用方的说明）。 */
export function memeSpecPath() {
  return path.join(os.tmpdir(), `qq-meme-spec-${process.pid}-${Date.now()}.json`);
}

/**
 * 跑一次 PowerShell 并收集输出（不抛错：超时/启动失败都折成 `{code:-9|-1}`）。
 * `stdio` 走管道是刻意的：渲染器的成功标志是 stdout 里的 `OUT=<路径>` 行。
 */
export function runPowerShell(args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', args, { windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ code: -9, stdout, stderr: `${stderr}\n[mcp] 渲染超时`.trim() });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ code: -1, stdout, stderr: `${stderr}\n${String(error?.message ?? error)}`.trim() });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** 模板清单（`memes/templates/*.json` 的文件名，排序后返回；目录不在就空数组）。 */
export function listMemeTemplates() {
  try {
    return fs.readdirSync(MEME_TEMPLATES_DIR)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .map((f) => f.replace(/\.json$/i, ''))
      .sort();
  } catch {
    return [];
  }
}
