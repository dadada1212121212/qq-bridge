// AstrBot 看门狗的判定与命令构造（纯函数，桥接与测试共用）。
//
// 为什么单独拆一个文件
// --------------------
// 这段逻辑三次改需求都踩了同一类坑：判定条件散在 bridge.js 的看门狗闭包里，
// 改一次没法回归。2026-10-19 两条修正都来自今天凌晨的实录：
//
//   ① 「事件循环卡死 3.5 小时」几乎总是假警报：本机只有 S0 新型待机，机器一空闲
//      整个桌面栈（桥接/DSH/AstrBot/QQ）一起冻结。实录：05:08:45 进待机
//      （kernel-power 506 Idle Timeout）→ 09:08:03 鼠标唤醒（507 Input Mouse），
//      AstrBot 的事件循环诊断在唤醒后第 1 秒记下 lag 12583s。进程是健康的，
//      WS 自己会重连 —— 所以检测到最近退出过待机就只记账、不重启。
//   ② 老重启路径「detached 盲 spawn ps1 + 脚本里 SilentlyContinue」：失败了桥接
//      只看到「已发起」。实录：09:08 点了重启，真身（python.exe）其实没被杀掉。
//      新路径按「端口占用者」杀 —— 顺带避开一个实测误伤：按命令行匹配
//      '*astrbot.exe*' 会命中任何命令行里带这串的进程（探针会话就中过）。

/**
 * 查「最近 N 分钟内有没有退出新型待机」的 PowerShell 探针。
 * kernel-power 507 = 系统正在退出新型待机状态；506 是进入。
 * 返回一段输出计数的脚本，桥接侧跑完取 stdout 当数字用。
 *
 * @param {number} minutes - 回看窗口（分钟）。
 * @returns {string} PowerShell -Command 用的脚本。
 */
export function astrbotStandbyResumeScript(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) throw new Error('minutes 必须是正数');
  return '@(Get-WinEvent -FilterHashtable @{LogName=\'System\'; Id=507; StartTime=(Get-Date).AddMinutes(-'
    + m + ')} -ErrorAction SilentlyContinue).Count';
}

/**
 * 这次「异常」该不该因为「系统刚从待机恢复」而跳过重启。
 *
 * 只放行「事件循环卡死」这一类：端口探活失败可能是进程真死了，照旧重启。
 * 拿不准时（bad 为空）一律不跳过。
 *
 * @param {string} bad - 异常描述（空串 = 没异常）。
 * @param {number} resumeCount - 最近窗口内退出待机事件的条数。
 * @returns {boolean} true = 跳过重启。
 */
export function shouldSkipAstrbotRestartOnResume(bad, resumeCount) {
  if (!bad) return false;
  if (!String(bad).includes('卡死')) return false;
  const n = Number(resumeCount);
  return Number.isFinite(n) && n > 0;
}

/**
 * 按「谁占着 AstrBot 端口」杀进程的 PowerShell。
 * 相比按命令行匹配：精准命中真身，且不会误伤命令行里恰好带 astrbot 字样的
 * 其它进程（编辑器、日志查看器、探针会话都中过招）。
 * 脚本会把杀掉的 pid 打到 stdout，桥接侧记账用。
 *
 * @param {number} port - AstrBot 的 HTTP 端口（默认 6185）。
 * @returns {string} PowerShell -Command 用的脚本。
 */
export function astrbotKillByPortScript(port) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) throw new Error('port 必须是正数');
  return 'Get-NetTCPConnection -LocalPort ' + p
    + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique'
    + ' | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue; $_ }';
}
