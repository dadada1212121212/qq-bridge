// 静默失败台账（2026-10-20 新增，质量体检 P1-3）。
//
// 为什么需要：桥接里有 70+ 处 `catch {}`，绝大多数是**刻意**吞掉的（"缓存坏了不该让搜索坏掉"），
// 这本身没问题 —— 问题是吞掉之后**没有任何痕迹**。真实事故：
//   `getSocialV2State()` 不带会话 key 必抛，而调用方套在 `try/catch` 里 ⇒ 每 60 秒静默失败一次、
//   功能永不生效，日志里连一行都没有，藏了很久才被翻代码发现。
//
// 这个模块把"吞掉"变成"记账 + 记一行日志"：
//   · 按 tag 计数（`巡园 tick` / `链接摘要` / `搜索卡片入库` …），带首次/最近时间与最后一条错误；
//   · 落盘到 `state/silent-failures.json`，重启不清零（否则每次重启都从 0 开始，等于没记）；
//   · 控制台 `/api/silent-failures` + 运维页一格「静默失败」直接看。
//
// 设计约束：
//   - **绝不抛错**：这层本身要是坏了，也不能把正常链路带崩（写盘失败只打日志）。
//   - 写盘去抖：可能一秒内失败几十次，不能每次都写文件；但最多只丢最后两秒的计数。
//   - tag 数量封顶：防止有人把用户输入拼进 tag 造成文件无限增长。

import { readJsonFile, writeJsonAtomic } from './json-file.js';
import { truncateText } from './md-to-plain.js';

const MAX_TAGS = 60;
const MAX_MSG_CHARS = 180;

/**
 * @param {{ file?: string, log?: Function, now?: Function, flushMs?: number, maxTags?: number }} opts
 */
export function createSilentFailures({
  file = null,
  log = () => {},
  now = () => Date.now(),
  flushMs = 2000,
  maxTags = MAX_TAGS,
} = {}) {
  const loaded = file ? readJsonFile(file, null, { quarantine: true }) : null;
  const data = {
    v: 1,
    tags: (loaded && loaded.tags && typeof loaded.tags === 'object') ? loaded.tags : {},
  };

  let timer = null;
  let dirty = false;

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty || !file) return;
    dirty = false;
    try { writeJsonAtomic(file, data); } catch (error) {
      // 记账失败只打日志：不能因为"记失败"这件事本身失败而影响主链路。
      try { log(`[静默失败] 落盘失败：${error?.message ?? error}`); } catch { /* */ }
    }
  };

  const schedule = () => {
    dirty = true;
    if (!file) return;
    // flushMs <= 0 = 同步立即写（测试与短命进程用；语义与 search-store 的去抖写入器一致）。
    if (!(Number(flushMs) > 0)) { flush(); return; }
    if (timer) return;
    timer = setTimeout(flush, Math.max(0, Number(flushMs) || 0));
    timer.unref?.();
  };

  return {
    /**
     * 记一次被吞掉的失败。**同时**打一行日志（保持原来 `log(...)` 的可见性），
     * 再按 tag 累加计数 —— 这样"偶发一次"和"每 60 秒一次"在控制台能区分开。
     */
    swallow(tag, error, detail = '') {
      const name = truncateText(String(tag || 'unknown'), 60) || 'unknown';
      const raw = detail
        ? `${detail}：${error?.message ?? error}`
        : String(error?.message ?? error ?? '');
      const msg = truncateText(raw.replace(/\s+/g, ' ').trim(), MAX_MSG_CHARS);
      const t = now();
      try {
        let row = data.tags[name];
        if (!row) {
          // 封顶：超出就丢掉"最久没出现且次数最少"的那条，别让文件无限长。
          const names = Object.keys(data.tags);
          if (names.length >= maxTags) {
            names.sort((a, b) => {
              const A = data.tags[a] || {};
              const B = data.tags[b] || {};
              return (Number(A.count) || 0) - (Number(B.count) || 0)
                || (Number(A.lastAt) || 0) - (Number(B.lastAt) || 0);
            });
            delete data.tags[names[0]];
          }
          row = { count: 0, firstAt: t, lastAt: 0, lastMsg: '' };
          data.tags[name] = row;
        }
        row.count = (Number(row.count) || 0) + 1;
        row.lastAt = t;
        if (msg) row.lastMsg = msg;
        schedule();
      } catch { /* 记账本身绝不抛 */ }
      // 日志要限流：这类失败可能一秒几十次（每条消息都踩一次），全打出来会把日志刷爆，
      // 反而没人看。前 3 次必打（让人知道它开始了），之后每 100 次打一次（证明还在发生）。
      try {
        const n = Number(data.tags[name]?.count) || 1;
        if (n <= 3 || n % 100 === 0) log(`[静默失败] ${name}${msg ? '：' + msg : ''}（累计 ${n} 次）`);
      } catch { /* */ }
      return true;
    },

    /** 控制台/接口用：按次数倒序，附带"多久以前"。 */
    snapshot({ top = 20 } = {}) {
      const t = now();
      const list = Object.entries(data.tags).map(([tag, row]) => ({
        tag,
        count: Number(row?.count) || 0,
        firstAt: Number(row?.firstAt) || 0,
        lastAt: Number(row?.lastAt) || 0,
        agoMs: Number(row?.lastAt) ? Math.max(0, t - Number(row.lastAt)) : 0,
        lastMsg: String(row?.lastMsg || ''),
      }));
      list.sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
      return {
        total: list.reduce((sum, r) => sum + r.count, 0),
        tags: list.length,
        top: list.slice(0, Math.max(1, Number(top) || 20)),
      };
    },

    /** 清空（控制台按钮用）。 */
    reset() {
      data.tags = {};
      dirty = true;
      flush();
    },

    flush,
  };
}
