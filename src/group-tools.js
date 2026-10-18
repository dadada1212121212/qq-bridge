/**
 * 群内小工具 —— 投票 / 抽签决定。
 *
 * 为什么放在服务端
 * ================
 * 和 light-games 同理：**随机与计数必须由服务端算**。让模型自己"随机选一个"
 * 会明显偏向它熟悉的选项；投票计数更是不能交给模型（它会漏、会算错、
 * 会把两个人说成三票）。模型只负责把结果说得像群里的人在起哄。
 *
 * 设计要点
 * ========
 * - 投票状态持久在 st.poll（由调用方 bridge.js 持有），本模块只算「下一状态 + 文案」。
 * - 一人一票：同一投票人重复投，算**改票**而不是加一票（群里改主意很常见）。
 * - 计票平局不擅自拍板：`tie: true` 如实告诉模型，让她自己决定要不要再投一轮，
 *   而不是悄悄选一个——那样群友看到"明明 2:2 却说她赢了"会立刻不信。
 */

import crypto from 'node:crypto';

/** 取 [min, max] 闭区间内的整数（真随机）。 */
function randInt(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) {
    throw new Error(`随机区间不合法：${min}..${max}`);
  }
  return crypto.randomInt(lo, hi + 1);
}

const MAX_OPTIONS = 10;

/**
 * 开一个投票。
 * @param {string[]} options 选项列表（2~10 个）
 * @param {string} title 投票主题
 * @param {number} dueMs 多久后自动结束（毫秒，可选；不传就不限时）
 */
export function startPoll({ options, title = '', dueMs = 0 } = {}) {
  if (!Array.isArray(options)) throw new Error('投票选项必须是数组');
  const clean = options.map((o) => String(o ?? '').trim()).filter(Boolean);
  if (clean.length < 2) throw new Error('投票至少要 2 个选项');
  if (clean.length > MAX_OPTIONS) throw new Error(`投票最多 ${MAX_OPTIONS} 个选项（收到 ${clean.length}）`);
  const uniq = [...new Set(clean)];
  if (uniq.length !== clean.length) throw new Error('投票选项不能重复');
  const now = Date.now();
  return {
    title: String(title || '').trim().slice(0, 100),
    options: uniq,
    ballots: {},            // voterKey -> optionIndex
    startedAt: now,
    endsAt: dueMs > 0 ? now + dueMs : 0,
    status: 'open'
  };
}

/**
 * 投票 / 改票。
 * @param {number} choice 选项序号（从 1 开始，便于群友说"我投 2"）
 * @param {string} voter 投票人标识（如昵称或 QQ 号）
 */
export function castVote(poll, { choice, voter } = {}) {
  if (!poll || typeof poll !== 'object') throw new Error('没有进行中的投票');
  if (poll.status !== 'open') throw new Error('投票已经结束了');
  if (poll.endsAt && Date.now() > poll.endsAt) {
    poll.status = 'closed';
    throw new Error('投票时间到了，已经结束');
  }
  const who = String(voter ?? '').trim();
  if (!who) throw new Error('投票人不能为空');
  const idx = Number(choice);
  if (!Number.isInteger(idx) || idx < 1 || idx > poll.options.length) {
    throw new Error(`选项序号要在 1~${poll.options.length} 之间（收到 ${choice}）`);
  }
  const prev = poll.ballots[who];
  poll.ballots[who] = idx - 1;
  return { poll, changed: prev !== undefined && prev !== idx - 1, wasFirst: prev === undefined };
}

/** 结束投票并计票。 */
export function closePoll(poll) {
  if (!poll || typeof poll !== 'object') throw new Error('没有进行中的投票');
  poll.status = 'closed';
  return tallyPoll(poll);
}

/** 计票（可中途看，也可以结束后看）。 */
export function tallyPoll(poll) {
  if (!poll || typeof poll !== 'object') throw new Error('没有进行中的投票');
  const counts = poll.options.map(() => 0);
  for (const v of Object.values(poll.ballots || {})) {
    if (Number.isInteger(v) && v >= 0 && v < counts.length) counts[v] += 1;
  }
  const total = counts.reduce((a, b) => a + b, 0);
  const max = counts.length ? Math.max(...counts) : 0;
  const winners = max > 0 ? counts.map((c, i) => (c === max ? i : -1)).filter((i) => i >= 0) : [];
  const tie = max > 0 && winners.length > 1;
  return {
    counts,
    total,
    tie,
    winners,
    winner: !tie && winners.length === 1 ? winners[0] : null,
    status: poll.status
  };
}

/**
 * 抽签决定：从多个选项里随机选一个（"决定去哪吃"这种）。
 * ⚠️ 与 light-games 的 drawFortune 不同：那个是"吉凶签"，这个是"帮你在几个
 *    具体选项里做决定"，返回值只给选中的那一个 + 序号，不掺吉凶语义。
 */
export function decideAmong(options) {
  if (!Array.isArray(options)) throw new Error('选项必须是数组');
  const clean = options.map((o) => String(o ?? '').trim()).filter(Boolean);
  if (clean.length === 0) throw new Error('选项列表是空的，没法决定');
  if (clean.length > MAX_OPTIONS * 5) throw new Error(`选项太多了（最多 ${MAX_OPTIONS * 5} 个）`);
  const idx = randInt(0, clean.length - 1);
  return { kind: 'decide', options: clean, index: idx, picked: clean[idx] };
}

/** 把投票渲染成给模型看的一句话。 */
export function renderPoll(poll, tally = null) {
  if (!poll || typeof poll !== 'object') return '（没有进行中的投票）';
  const t = tally || tallyPoll(poll);
  const head = poll.title ? `【投票：${poll.title}】` : '【投票】';
  const list = poll.options
    .map((o, i) => `${i + 1}. ${o}${t.counts[i] ? `（${t.counts[i]} 票）` : ''}`)
    .join('　');
  if (t.status === 'closed' || t.status !== 'open') {
    if (t.total === 0) return `${head}结束了，但没人投票。`;
    if (t.tie) {
      const names = t.winners.map((i) => `${i + 1}. ${poll.options[i]}`).join(' 和 ');
      return `${head}结束，${names} **打平了（各 ${t.counts[t.winners[0]]} 票）**——别自己拍板，再投一轮或想别的办法。`;
    }
    return `${head}结束，**「${poll.options[t.winner]}」赢了**（${t.counts[t.winner]} 票，共 ${t.total} 人投票）。`;
  }
  return `${head}${list}。已投 ${t.total} 人${t.tie ? '（目前打平）' : ''}。`;
}

/** 把"抽签决定"渲染成给模型看的一句话。 */
export function renderDecide(r) {
  if (!r || r.kind !== 'decide') return '（没有可决定的结果）';
  return `从 ${r.options.length} 个选项里抽中了「${r.picked}」（第 ${r.index + 1} 个）`;
}
