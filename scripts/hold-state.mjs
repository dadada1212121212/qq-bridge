// 「人工维护 hold」状态判定 —— run-qqbridge.cmd 的重启循环在拉起新实例前调用它。
//
// 为什么必须有这个文件
// --------------------
// 2026-10-19：主号桥接的启动器只跑一遍 node 就退出，桥接进程一崩，要等 3 分钟
// 一次的保活任务才发现（实际空窗最长 ~4.5 分钟）。fish 号的启动器 10-18 就加了
// 5 秒重启循环（起因是它崩过一次 0xC0000374 堆损坏），主号一直没补。
//
// 补循环有一条不能破的语义：/stop 停机。bridge-control.ps1 的 stop 只杀 node
// 监听进程、不杀 cmd 外壳，再写一个 hold 文件告诉保活任务「别拉我」。如果重启
// 循环无条件拉起，主人用 QQ 发的 /stop 就再也关不掉机器人了。
//
// 因此循环每轮重启前问一次本模块。判定语义与 qq-dsh-bridge/start-services.ps1
// （保活任务那一侧）逐条对齐，三条同时成立才算「生效中」：
//   ① hold 文件存在且能解析成对象；
//   ② services 数组含 'qqbridge' 或通配符 '*'；
//   ③ until 时间戳还没过。
// 解析失败按**未生效**处理——与 start-services.ps1 的 catch { $held = $false }
// 一致：宁可多拉一次桥接，不可因为一次读失败就永久躺平（保活任务还在兜底）。
//
// CLI 退出码：0 = 未生效（循环继续重启）；1 = 生效中（循环应退出）。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** bridge-control.ps1 写、start-services.ps1 / watchdog.mjs 读的那个 hold 文件。 */
export const DEFAULT_HOLD_FILE =
  'C:/Users/ASUS/.dsh/ungrouped/qq-dsh-bridge/state/watchdog-hold.json';

/**
 * 判断一份 hold 文件内容此刻是否命中「别拉 qqbridge」。
 *
 * @param {string | null | undefined} raw - hold 文件原文；读不到/空串都算未生效。
 * @param {number} [now] - 当前时刻（毫秒），测试可注入。
 * @returns {boolean} true = 生效中，循环不该重启桥接。
 */
export function isHoldActive(raw, now = Date.now()) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  let hold;
  try {
    hold = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!hold || typeof hold !== 'object' || Array.isArray(hold)) return false;
  const services = Array.isArray(hold.services) ? hold.services : [];
  const scoped = services.includes('qqbridge') || services.includes('*');
  if (!scoped) return false;
  const until = Number(hold.until);
  if (!Number.isFinite(until)) return false;
  return until > now;
}

// 直跑判定用仓库统一惯用法：手拼 file:// URL 在 Windows 上会少一根斜杠
// （file://C:/… ≠ file:///C:/…），踩过一次。
const isMain =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const file = process.argv[2] || DEFAULT_HOLD_FILE;
  let active = false;
  try {
    active = isHoldActive(readFileSync(file, 'utf8'));
  } catch (error) {
    // ENOENT = 没有停机意图，最正常的路径；其余错误保守按未生效，由保活任务兜底。
    if (error?.code !== 'ENOENT') {
      process.stderr.write(`[hold-state] 读取 ${file} 失败：${error?.message ?? error}\n`);
    }
  }
  process.stdout.write(active ? 'held\n' : 'free\n');
  process.exit(active ? 1 : 0);
}
