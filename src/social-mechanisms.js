// 社交拟人机制的纯规则逻辑（事件跟进 / 对人冷场余波 / 纪念日，2026-10-19）。
// 为什么单独成文件：正则与日期判断要能脱离桥接单测（scripts/test-social-mechanisms.mjs），
// 且桥接里只做接线，规则改词表不动 1.2 万行主文件。

/** 事件词：有人「亲口」跟她提到、且值得事后问一句结果的事。 */
export const EVENT_WORDS_RE = /(考试|面试|比赛|答辩|体检|出成绩|搬家|入职|出差|手术|驾照|复试|生日聚会)/;

/** 未来时间词：和事件词同时出现才记跟进账（聊过去的考试不算）。日期允许数字和「号/日」之间有空格。 */
export const FUTURE_WORDS_RE = /(明天|后天|大后天|下周|下个?月|周[一二三四五六日天]|下?[12]?\d{1,2}\s*[号日])/;

/**
 * 从一句话里探测「值得跟进的事件」。
 * 返回 { event, dueAt, followUpAt } 或 null。followUpAt = 事件后过一天问结果。
 */
export function detectEventFollowUp(text, now = Date.now()) {
  const s = String(text || '').slice(0, 120);
  if (!s || !EVENT_WORDS_RE.test(s) || !FUTURE_WORDS_RE.test(s)) return null;
  let offsetH = 48; // 没说清时间就默认保守两天后到点
  if (/大后天/.test(s)) offsetH = 72;
  else if (/后天/.test(s)) offsetH = 48;
  else if (/明天/.test(s)) offsetH = 24;
  else if (/下周|下个?月/.test(s)) offsetH = 24 * 7;
  const dueAt = now + offsetH * 3600000;
  return { event: (s.match(EVENT_WORDS_RE) || ['事件'])[0], dueAt, followUpAt: dueAt + 86400000 };
}

/** 敌意词：对她说这些才记冷场（「滚呐」式玩梗不算，词面收得较紧）。 */
export const HOSTILE_RE = /(闭嘴|废物|蠢货|恶心死|滚远点|别跟我说话|懒得理你|拉黑你|讨厌死你|你烦不烦)/;
/** 和解词：说过这些就提前解除冷场。 */
export const PEACE_RE = /(对不起|抱歉|我的错|别生气|原谅我|是我不好|刚才是我不对)/;

/** 纪念日里程碑：认识满 N 天里真正值得提的节点。 */
const MILESTONES = [7, 30, 100, 200, 300, 365, 500, 730, 1000, 1095, 1460, 1825, 2190, 2555, 2920, 3285, 3650];
export function milestoneDays(days) {
  return MILESTONES.includes(Math.floor(days)) ? Math.floor(days) : 0;
}

// ── [养鱼·追更安利 2026-10-19] ────────────────────────────────────────────────
// 纯规则：拿配置里的关注名单 + 上次见过的最新投稿，和这次抓到的投稿列表对账。
// 放这里和事件跟进一个道理——规则要能脱离桥接单测，桥接只做接线。

/**
 * 对账一轮关注列表。
 * @param {Array} follows 配置名单 [{ mid, name }]
 * @param {Object} stateMap 会话里存的追更水位 { [mid]: { lastBvid, lastTitle, seeded } }
 * @param {Map|Object} results mid → userVideos 结果（{mid,name,count:[{bvid,title,pubdate,url}]}）或 null（抓失败）
 * @returns {{ updates: Array<{mid,name,video}>, state: Object, seeded: number }}
 *   updates = 本次要安利的新投稿；state = 写回会话的新水位；seeded = 首次建档数量。
 */
export function diffBiliFollowsV2(follows, stateMap, results) {
  const list = Array.isArray(follows) ? follows : [];
  const state = (stateMap && typeof stateMap === 'object') ? { ...stateMap } : {};
  const get = (mid) => (results instanceof Map ? results.get(mid) : results?.[String(mid)]) || null;
  const updates = [];
  let seeded = 0;
  for (const f of list) {
    const mid = String(f?.mid || '').trim();
    if (!mid) continue;
    const name = String(f.name || '').trim() || String(state[mid]?.name || '').trim();
    const r = get(mid);
    const newest = Array.isArray(r?.count) && r.count.length ? r.count[0] : null;
    if (!newest?.bvid) continue; // 抓失败/没投稿：水位不动，下次再说
    const prev = state[mid] || {};
    if (!prev.seeded) {
      // 首次建档只记水位不报更新——不然刚加关注就把人家半年的旧稿全安利一遍。
      state[mid] = { name, lastBvid: newest.bvid, lastTitle: newest.title, lastPubdate: Number(newest.pubdate) || 0, seeded: true };
      seeded++;
      continue;
    }
    if (prev.lastBvid && newest.bvid !== prev.lastBvid) {
      updates.push({ mid, name, video: newest });
      state[mid] = { name, lastBvid: newest.bvid, lastTitle: newest.title, lastPubdate: Number(newest.pubdate) || 0, seeded: true };
    }
  }
  return { updates, state, seeded };
}
