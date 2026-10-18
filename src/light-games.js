/**
 * 轻量随机游戏 —— 服务端真随机。
 *
 * 为什么必须放在服务端
 * ====================
 * 如果让模型自己"想一个随机数"，它会系统性地偏向某些值（LLM 对随机性的
 * 模拟很差：喜欢 7、26、42，骰子容易连着出同样的数）。群里几轮下来
 * 立刻会被看出来是假的 —— 而这个机器人的立身之本就是"像个真人"。
 *
 * 所以：**随机数一律由这里生成，模型只负责把结果说得有趣。**
 * 工具返回的 text 里带着结果，模型照着念就行，不需要（也不允许）自己编。
 *
 * 设计要点
 * ========
 * - 用 `crypto.randomInt` 而不是 `Math.random`：后者是可预测的伪随机，
 *   虽然群里没人会去预测，但既然成本一样，就用真随机源。
 * - **每次结果都记进流水**（`appendActivity` 由调用方做），这样"她刚才
 *   说抽到凶，现在又说抽到凶"这类事后对不上账的情况可以被发现。
 * - 支持"自定义抽签池"：群友可以让她从自己给的列表里抽，比固定的
 *   大吉/中吉/小吉有意思得多。
 */

import crypto from 'node:crypto';

/** 取 [min, max] 闭区间内的整数。 */
function randInt(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) {
    throw new Error(`随机区间不合法：${min}..${max}`);
  }
  return crypto.randomInt(lo, hi + 1);
}

/** 从数组里取一个元素。 */
function pick(arr) {
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('待抽列表为空');
  return arr[randInt(0, arr.length - 1)];
}

// ---------- 骰子 ----------

/**
 * 掷骰。语法对齐常见的 TRPG 记法：`2d6` / `1d100` / `d20`。
 *
 * 为什么支持 `NdM` 而不是只支持一个数字：群里发「2d6」是很自然的写法，
 * 而且多骰能顺便给出"每颗分别多少"（便于她描述得更有画面感）。
 */
export function rollDice(spec) {
  const s = String(spec ?? '1d6').trim().toLowerCase().replace(/\s+/g, '');
  // ⚠️ 面数允许 2~1000，所以是 `\d{1,4}`。早先写成 `\d{1,3}` 时
  // 「1d1000」会在正则这一关就被判成"格式不对"，而下面的范围校验写的是
  // 「2~1000」—— 两处对不上，用户看到的报错会指向格式而不是范围。
  const m = /^(\d{0,2})d(\d{1,4})$/.exec(s);
  if (!m) throw new Error(`骰子格式不对：${spec}（正确写法如 2d6 / d20 / 1d100）`);
  const n = m[1] === '' ? 1 : Number(m[1]);
  const faces = Number(m[2]);
  if (n < 1 || n > 20) throw new Error(`骰子颗数要在 1~20 之间（收到 ${n}）`);
  if (faces < 2 || faces > 1000) throw new Error(`骰面要在 2~1000 之间（收到 ${faces}）`);
  const rolls = Array.from({ length: n }, () => randInt(1, faces));
  const sum = rolls.reduce((a, b) => a + b, 0);
  return { kind: 'dice', n, faces, rolls, total: sum };
}

// ---------- 猜拳 ----------

const RPS = ['石头', '剪刀', '布'];
/** 猜拳的胜负表：key 赢 value。 */
const RPS_BEATS = { 石头: '剪刀', 剪刀: '布', 布: '石头' };
/** 出拳归一化表：把各种写法收敛到三种标准名。 */
const RPS_ALIAS = {
  石头: '石头', 石: '石头', rock: '石头', r: '石头', 拳头: '石头',
  剪刀: '剪刀', 剪: '剪刀', scissors: '剪刀', scissor: '剪刀', s: '剪刀',
  布: '布', paper: '布', p: '布', 包袱: '布',
};

/** 把任意写法的出拳归一化；不认识返回 null。 */
function normalizeRps(v) {
  if (v == null) return null;
  const k = String(v).trim().toLowerCase();
  if (k === '') return null;
  return RPS_ALIAS[k] ?? null;
}

/**
 * 猜拳。`mine` 是群友出的（可选），`hers` 是指定她出的（可选，不给则真随机）。
 *
 * ⚠️ 关于 `hers` 为什么需要：直觉上"她出什么应该永远随机"，但有两个
 *    真实场景必须能指定 —— ①群友说「你出剪刀」，②测试要验证胜负判定。
 *    不给 `hers` 时仍然是 crypto 真随机，行为不变。
 *
 * ⚠️ 返回值里 `outcome` 是**从群友角度**说的：
 *    'win' = 群友赢，'lose' = **她赢**，'draw' = 平局，'unknown' = 群友没出。
 *    这个视角必须在返回里写清楚，否则模型会把"我赢了"说反 ——
 *    这类口误在群里非常显眼。
 */
export function rockPaperScissors(mine, hers) {
  const forced = hers == null ? null : normalizeRps(hers);
  if (hers != null && forced == null) {
    throw new Error(`「她出的拳」只能是石头/剪刀/布（收到「${hers}」）`);
  }
  const her = forced ?? pick(RPS);

  const raw = mine == null ? null : String(mine).trim();
  if (raw == null || raw === '') {
    return { kind: 'rps', her, mine: null, outcome: 'unknown' };
  }
  const normalized = normalizeRps(raw);
  if (!normalized) throw new Error(`猜拳只能出石头/剪刀/布（收到「${raw}」）`);

  let outcome;
  if (normalized === her) outcome = 'draw';
  else if (RPS_BEATS[normalized] === her) outcome = 'win';   // 群友赢
  else outcome = 'lose';                                      // 她赢
  return { kind: 'rps', her, mine: normalized, outcome };
}

// ---------- 抽签 ----------

const DEFAULT_FORTUNE = [
  '大吉', '中吉', '小吉', '末吉', '吉', '平', '凶', '大凶',
];

/**
 * 抽签。`pool` 可自定义（群友让她从指定选项里抽）。
 *
 * `labels` 用于给每个签配一句"解释"——不是必需的，但能让结果有意思：
 * 她可以自己根据签位发挥，所以这里不硬编码解释文案。
 */
export function drawFortune(pool) {
  let list;
  let custom = false;
  // ⚠️ 必须区分「没传 pool」和「传了空数组」。
  // 早先只判断 `Array.isArray(pool) && pool.length > 0`，于是 `drawFortune([])`
  // 会掉进 else 分支**悄悄用默认池** —— 调用方以为在用自定义池，
  // 实际拿到的是大吉/中吉/凶。这种静默降级比抛错更难查。
  if (pool !== undefined && pool !== null) {
    if (!Array.isArray(pool)) throw new Error('自定义签池必须是数组');
    if (pool.length === 0) throw new Error('自定义签池是空的，没法抽');
    list = pool.map((x) => String(x).trim()).filter(Boolean);
    if (list.length === 0) throw new Error('自定义签池里没有有效选项（全是空白）');
    if (list.length > 100) throw new Error(`自定义签池最多 100 项（收到 ${list.length}）`);
    custom = true;
  } else {
    // 默认签池带权重感：吉类多、凶类少，更接近真抽签的手感。
    list = ['大吉', '中吉', '中吉', '小吉', '小吉', '小吉', '末吉', '吉',
      '吉', '平', '平', '凶'];
  }
  const result = pick(list);
  return {
    kind: 'fortune', result, custom,
    poolSize: list.length,
    // 给出同池里的"稀有度"，她可以据此说"这个很难抽的"
    rarity: custom ? null : (result === '大吉' ? '极稀有' : result === '凶' ? '少见' : null),
  };
}

// ---------- 投硬币 ----------

export function flipCoin() {
  const heads = randInt(0, 1) === 0;
  return { kind: 'coin', result: heads ? '正面' : '反面' };
}

// ---------- 统一入口 ----------

/**
 * 执行一个轻量游戏。
 *
 * `game` 取值：dice / rps / fortune / coin
 * 其余参数按游戏类型取用（dice: spec；rps: mine；fortune: pool）。
 */
export function playLightGame(game, opts = {}) {
  const g = String(game ?? '').trim().toLowerCase();
  switch (g) {
    case 'dice':
    case 'roll':
    case '骰子':
      return rollDice(opts.spec);
    case 'rps':
    case '猜拳':
    case '石头剪刀布':
      return rockPaperScissors(opts.mine, opts.hers);
    case 'fortune':
    case 'draw':
    case '抽签':
      return drawFortune(opts.pool);
    case 'coin':
    case 'flip':
    case '投币':
    case '硬币':
      return flipCoin();
    default:
      throw new Error(`不认识的游戏「${game}」（支持：dice 骰子 / rps 猜拳 / `
        + 'fortune 抽签 / coin 投币）');
  }
}

/** 把结果渲染成给模型看的一句话（模型照此转述，不要自己改数字）。 */
export function renderLightGame(r) {
  switch (r.kind) {
    case 'dice':
      return r.n === 1
        ? `掷出了 ${r.total}（1d${r.faces}）`
        : `掷出了 ${r.total}（${r.n}d${r.faces}，各颗：${r.rolls.join(' + ')}）`;
    case 'rps':
      if (r.outcome === 'unknown') return `她出了「${r.her}」（群友没给出自己的拳）`;
      return `她出了「${r.her}」，对方出「${r.mine}」→ `
        + `从**对方**角度是 ${r.outcome === 'win' ? '对方赢' : r.outcome === 'lose' ? '对方输（她赢）' : '平局'}`;
    case 'fortune':
      return `抽到「${r.result}」${r.rarity ? `（${r.rarity}）` : ''}`
        + `${r.custom ? `，从自定义的 ${r.poolSize} 个选项里抽的` : ''}`;
    case 'coin':
      return `硬币是${r.result}`;
    default:
      return '（未知游戏结果）';
  }
}
