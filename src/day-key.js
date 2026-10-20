// 本地日期键 —— 全仓唯一实现（2026-10-20 统一）。
//
// 为什么单独一个文件：这个"今天几号"的小函数原来有 **4 份**独立实现
// （`long-memory.localDayString` / `search-store.localDayKey` / `console-server` 里两处内联）。
// 2026-10-20 踩过一次：统计层从 `toISOString()`（UTC）改成"本地日期"时只改了统计那一份，
// 控制台还是 UTC ⇒ 北京时间 0~8 点的数据被算到"昨天"，面板上当天数字是空的。
//
// ⚠️ 绝不能放进 `long-memory.js` 再让别处 import：那个文件 import 了 `node:sqlite`，
// 而 MCP 子进程（web-search / snowluma）只需要一行日期函数，不该为此拖一个数据库进来。
//
// 也绝不能再用 `toISOString().slice(0, 10)`：那是 UTC 日期。本机在北京时间（UTC+8），
// 每天 0:00–8:00 的写入都会落到前一天。

/** 本地时区的 YYYY-MM-DD。`offsetDays = 1` 就是昨天。 */
export function localDayString(offsetDays = 0, base = null) {
  const d = base == null ? new Date() : new Date(base);
  if (offsetDays) d.setDate(d.getDate() - Number(offsetDays));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** {@link localDayString} 的同义写法：给一个时间戳（默认现在），要它那天的本地日期键。 */
export function localDayKey(t = Date.now()) {
  return localDayString(0, t);
}

/** 本地某天 00:00 的时间戳（`day` 形如 `2026-10-20`）。解析不出来返回 NaN。 */
export function dayStartTs(day) {
  return new Date(`${String(day)}T00:00:00`).getTime();
}

/** 距今几天：`2026-10-18` 在 10-20 返回 2（按本地日切，不是按 24 小时）。 */
export function daysAgoOf(day, now = Date.now()) {
  const ts = dayStartTs(day);
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, Math.round((now - ts) / 86400000));
}
