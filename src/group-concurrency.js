// 群聊并发 / 点名台账 / 出站节奏 —— 纯逻辑，零依赖，可单测。
//
// 背景（用户 m02240）：群里一热闹，好几个人同时 @ 她时，一个 DSH 会话一轮只能跑一个回合，
// 后面的 @ 只能排队等；而群聊提示词里那句「挑最相关的一句回，不要逐一回应」又让她主动漏人。
// 这个模块提供三样东西，让「一个都不落下」和「省 token」同时成立：
//   1) 点名台账（ask ledger）：把「谁在等回话」记成一条条可追踪的账，跨回合、跨会话槽位共享；
//   2) 台账提示块（formatAskBlock）：把未回的点名编号写进提示词，并明确要求分人逐条回；
//   3) 出站节奏（createPacer）：每个会话一条发送链 + 全局最小间隔，别让一条慢发送挡住所有群。
//
// 台账条目字段：
//   id       稳定标识（群内本地 seq 唯一；没有 seq 时用 发送者@时间 兜底）
//   seq      本地消息序号（用于和 unread/recent 对齐，可能是 0）
//   time     消息时间（ms）
//   sender   发送者显示名
//   senderId 发送者 QQ 号（群聊 @ 用）
//   reason   唤醒原因（atMention / nameMention / keyword:xx / question / speaker:xx …）
//   text     那条消息的正文（截断到 askTextMax）
//   slot     被哪个槽位认领（'' = 还没人管 | 'a' = 主会话 | 'b' = 并发补答会话）
//   claimAt  认领时刻；tries 已经带着它唤醒过几次；done 0 | 'answered' | 'dropped'

export const DEFAULT_CONCURRENCY_CFG = {
  // 总开关。关掉就退回「一个群一个会话」的老行为，其余逻辑全部不参与。
  enabled: true,
  // 攒够几个「还没人认领的点名」就值得开第二个会话。
  auxMinAsks: 2,
  // 一条点名等这么久还没人管，就算只有一个也开第二个会话。
  auxAfterMs: 25000,
  // 第二槽位一轮最多带几条点名（带太多会写成长篇，违背群聊口径）。
  auxMaxAsks: 3,
  // 主槽位一轮最多认领几条点名。
  mainMaxAsks: 4,
  // 点名账的保鲜期：超过就当作过期，不再催。
  askMaxAgeMs: 3600000,
  // 账本上限（含少量已结清的尾巴，用于去重）。
  askMax: 40,
  // 写进提示词的每条点名正文上限。
  askTextMax: 60,
  // 同一条点名最多催几次；催不动就放弃，避免热点循环。
  askTryMax: 3,
  // 两次催单之间的最小间隔。
  askRetryMs: 60000,
  // 发给同一个人的上下文里，每条点名的字数上限。
  askReplyChars: 40,
  // 第二槽位空转这么久就回收（下次要用再建）。
  auxIdleRotateMs: 1800000,
  // 全局出站最小间隔（毫秒）—— 防两路并发把 QQ 打爆。
  sendGapMs: 200,
  // [省token] 会话正热时（窗口内被唤醒够多次）改用瘦提示词：砍掉摘要/回放/动漫库/清单等段落。
  slimWhenHot: true,
  // [省token] 群聊一律用瘦提示词（2026-10-15 起默认开）：群聊提示词实测 ≈5000 字/轮，
  // 瘦身版砍掉回放/关系/口癖/动漫库/表情清单/参与感/用量/账号 ≈2600 字，私聊永远给全。
  // 关掉（false）就退回「只在正热时瘦」的老行为。
  slimAlways: true,
  // [省token] 瘦身时仍然带上「她记得谁」那一段（【你脑子里的事】【你记得的人】
  // 【你记着的事】【对群友的印象】≈650 字）—— 砍了省钱有限，但她在群里会变成记不住人的陌生人。
  slimKeepMemory: true,
  hotWindowMs: 180000,
  hotMinWakes: 4,
};

function clampNum(value, dflt, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** 把 config 里的 socialV2.concurrency 归一化成一个完整的配置对象。 */
export function resolveConcurrencyCfg(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const d = DEFAULT_CONCURRENCY_CFG;
  return {
    enabled: r.enabled !== false,
    auxMinAsks: Math.round(clampNum(r.auxMinAsks, d.auxMinAsks, 1, 10)),
    auxAfterMs: Math.round(clampNum(r.auxAfterMs, d.auxAfterMs, 0, 600000)),
    auxMaxAsks: Math.round(clampNum(r.auxMaxAsks, d.auxMaxAsks, 1, 8)),
    mainMaxAsks: Math.round(clampNum(r.mainMaxAsks, d.mainMaxAsks, 1, 8)),
    askMaxAgeMs: Math.round(clampNum(r.askMaxAgeMs, d.askMaxAgeMs, 60000, 86400000)),
    askMax: Math.round(clampNum(r.askMax, d.askMax, 1, 200)),
    askTextMax: Math.round(clampNum(r.askTextMax, d.askTextMax, 10, 200)),
    askTryMax: Math.round(clampNum(r.askTryMax, d.askTryMax, 1, 10)),
    askRetryMs: Math.round(clampNum(r.askRetryMs, d.askRetryMs, 5000, 1800000)),
    askReplyChars: Math.round(clampNum(r.askReplyChars, d.askReplyChars, 10, 120)),
    auxIdleRotateMs: Math.round(clampNum(r.auxIdleRotateMs, d.auxIdleRotateMs, 60000, 86400000)),
    sendGapMs: Math.round(clampNum(r.sendGapMs, d.sendGapMs, 0, 5000)),
    slimWhenHot: r.slimWhenHot !== false,
    slimAlways: r.slimAlways !== false,
    slimKeepMemory: r.slimKeepMemory !== false,
    hotWindowMs: Math.round(clampNum(r.hotWindowMs, d.hotWindowMs, 30000, 3600000)),
    hotMinWakes: Math.round(clampNum(r.hotMinWakes, d.hotMinWakes, 2, 50)),
  };
}

/** 哪些唤醒原因是「有人点名/直接找她」——只有这些才值得进台账。 */
const DIRECT_REASON_BASES = new Set([
  'atMention', 'nameMention', 'question', 'poke', 'private', 'admin', 'speaker', 'keyword',
]);

export function isDirectedReason(reason) {
  const base = String(reason ?? '').split(':')[0];
  if (base === 'asks') return false; // 自己催单，不是新点名
  return DIRECT_REASON_BASES.has(base);
}

/** 提示词里引用的正文：单行、去 CQ 码、限长。 */
export function cleanAskText(text, max = DEFAULT_CONCURRENCY_CFG.askTextMax) {
  let s = String(text ?? '');
  s = s.replace(/\[CQ:[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (max > 0 && s.length > max) s = s.slice(0, max) + '…';
  return s;
}

export function askIdOf(seq, senderId, time, sender) {
  const n = Number(seq);
  if (Number.isFinite(n) && n > 0) return 's' + n;
  return String(senderId || sender || '?') + '@' + (Number(time) || 0);
}

/** 造一条台账条目；正文为空（纯图片/表情）时返回 null，不入账。 */
export function makeAskEntry(input = {}, cfg = DEFAULT_CONCURRENCY_CFG) {
  const now = Number(input.now) || Date.now();
  const time = Number(input.time) || now;
  const text = cleanAskText(input.text, cfg.askTextMax ?? DEFAULT_CONCURRENCY_CFG.askTextMax);
  if (!text) return null;
  const seq = Number(input.seq) || 0;
  const senderId = String(input.senderId ?? '').trim();
  return {
    id: askIdOf(seq, senderId, time, input.sender),
    seq,
    time,
    sender: String(input.sender ?? '').slice(0, 40),
    senderId,
    reason: String(input.reason ?? ''),
    text,
    slot: '',
    claimAt: 0,
    tries: 0,
    done: 0,
  };
}

function timeOf(x) {
  return Number(x && x.time) || 0;
}

/** 过期清理 + 去重 + 排序 + 封顶。返回新数组，不改原数组。 */
export function pruneAsks(list, { now = Date.now(), cfg = DEFAULT_CONCURRENCY_CFG } = {}) {
  const arr = (Array.isArray(list) ? list : []).filter((x) => x && typeof x === 'object' && x.id);
  const fresh = [];
  const settled = [];
  for (const x of arr) {
    const expired = now - timeOf(x) > cfg.askMaxAgeMs;
    if (x.done || expired) settled.push(x);
    else fresh.push(x);
  }
  fresh.sort((a, b) => timeOf(a) - timeOf(b));
  // 已结清的只留最近 8 条：用来防止同一条消息被重复入账，不需要长期保留。
  settled.sort((a, b) => timeOf(a) - timeOf(b));
  const out = fresh.concat(settled.slice(-8));
  const max = cfg.askMax ?? DEFAULT_CONCURRENCY_CFG.askMax;
  return out.length > max ? out.slice(out.length - max) : out;
}

/** 入账一条点名；同一条消息（同 id）只记一次。 */
export function recordAsk(list, entry, { now = Date.now(), cfg = DEFAULT_CONCURRENCY_CFG } = {}) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (!entry || !entry.id) return arr;
  if (arr.some((x) => x && x.id === entry.id)) return pruneAsks(arr, { now, cfg });
  arr.push(entry);
  return pruneAsks(arr, { now, cfg });
}

/**
 * 还没回完的点名（时间升序）。
 * slot 传值表示「只看这个槽位能接的」（未认领 + 本槽位已认领）；不传则只看未认领的。
 */
export function openAsks(list, { now = Date.now(), slot = null, includeClaimed = false, cfg = DEFAULT_CONCURRENCY_CFG } = {}) {
  const maxTries = cfg.askTryMax ?? DEFAULT_CONCURRENCY_CFG.askTryMax;
  return (Array.isArray(list) ? list : [])
    .filter((x) => x && !x.done)
    .filter((x) => now - timeOf(x) <= cfg.askMaxAgeMs)
    .filter((x) => (Number(x.tries) || 0) < maxTries)
    .filter((x) => includeClaimed || !x.slot || (slot != null && x.slot === slot))
    .sort((a, b) => timeOf(a) - timeOf(b));
}

/** 认领若干条点名给某个槽位：返回 { list, claimed }。 */
export function claimAsks(list, { ids = [], slot = 'a', now = Date.now() } = {}) {
  const want = new Set(ids);
  const claimed = [];
  const out = (Array.isArray(list) ? list : []).map((x) => {
    if (!x || x.done) return x;
    if (!want.has(x.id)) return x;
    if (x.slot && x.slot !== slot) return x; // 已被另一个槽位接走
    const next = { ...x, slot, claimAt: now, tries: (Number(x.tries) || 0) + 1 };
    claimed.push(next);
    return next;
  });
  return { list: out, claimed };
}

/** 放掉某个槽位的认领（回合失败 / 重启后残留）：ids 为空表示放掉该槽位全部。 */
export function releaseAsks(list, { ids = null, slot = '', now = Date.now() } = {}) {
  const want = ids ? new Set(ids) : null;
  return (Array.isArray(list) ? list : []).map((x) => {
    if (!x || x.done) return x;
    if (x.slot !== slot) return x;
    if (want && !want.has(x.id)) return x;
    return { ...x, slot: '', claimAt: 0 };
  });
}

/** 结清若干条点名：status = 'answered' | 'dropped'。 */
export function resolveAsks(list, { ids = [], now = Date.now(), status = 'answered' } = {}) {
  const want = new Set(ids);
  return (Array.isArray(list) ? list : []).map((x) => {
    if (!x || x.done) return x;
    if (!want.has(x.id)) return x;
    return { ...x, slot: '', done: status, doneAt: now };
  });
}

/** 台账统计：给调度和提示词用。 */
export function askStats(list, { now = Date.now(), cfg = DEFAULT_CONCURRENCY_CFG } = {}) {
  const open = openAsks(list, { now, cfg, includeClaimed: true });
  const unclaimed = open.filter((x) => !x.slot);
  const oldestOpen = open.length ? timeOf(open[0]) : 0;
  const oldestUnclaimed = unclaimed.length ? timeOf(unclaimed[0]) : 0;
  return {
    open: open.length,
    unclaimed: unclaimed.length,
    oldestWaitMs: oldestOpen ? now - oldestOpen : 0,
    oldestUnclaimedWaitMs: oldestUnclaimed ? now - oldestUnclaimed : 0,
    senders: [...new Set(open.map((x) => x.sender || x.senderId || '有人'))].slice(0, 6),
  };
}

/**
 * 要不要开第二个会话（并发补答槽）。
 * 只有「已经有人被晾着」且「主会话正忙」时才值得开 —— 开着不用反而更贵（会话本身有固定前缀成本）。
 */
export function shouldSpawnAux({ stats, auxBusy = false, cfg = DEFAULT_CONCURRENCY_CFG, now = Date.now(), urgent = false } = {}) {
  if (!cfg.enabled) return false;
  if (auxBusy) return false;
  if (!stats || !stats.unclaimed) return false;
  // [并发补齐 2026-10-19] 紧急模式：主会话正忙时来了「直接点名」（@/叫名/提问），
  // 只要台账里有 ≥3 秒的未接点名就立刻开第二槽位 —— 不再等「攒够 2 条」或「最老等 50s」。
  // 3 秒下限是防止刚记完账的同一瞬间重复派发。
  if (urgent && stats.oldestUnclaimedWaitMs >= 3000) return true;
  if (stats.unclaimed >= cfg.auxMinAsks) return true;
  return stats.oldestUnclaimedWaitMs >= cfg.auxAfterMs * 2;
}

/**
 * 提示词里的「等你回的人」块。
 * 关键不是罗列，而是给出一条可执行的回复方式：一人一次发送调用、一人一句、别并成一句。
 */
export function formatAskBlock(list, { now = Date.now(), cfg = DEFAULT_CONCURRENCY_CFG, group = true, includeClaimed = true, max = 6 } = {}) {
  const asks = openAsks(list, { now, cfg, includeClaimed }).slice(0, Math.max(1, max));
  if (!asks.length) return '';
  const perMax = cfg.askReplyChars ?? DEFAULT_CONCURRENCY_CFG.askReplyChars;
  const totalMax = Math.max(60, asks.length * (perMax + 8));
  const head = asks.length > 1
    ? '【等你回的人】' + asks.length + ' 个人点了你的名，一个都不能落下'
    : '【等你回的人】有 1 个人在等你回话';
  const rows = asks.map((a, i) => {
    const who = a.sender || (a.senderId ? 'QQ' + a.senderId : '有人');
    const idPart = a.senderId ? '（QQ ' + a.senderId + '）' : '';
    const mine = a.slot === 'b' ? '※' : '';
    return (i + 1) + '. ' + who + idPart + '：' + String(a.text || '').slice(0, cfg.askTextMax) + mine;
  });
  const how = group
    ? '怎么回：**每个人单独发一次 qq_send_message**（群聊传 atUserId=<他的QQ号>，一次只 @ 一个人），一人一句、一句不超过 ' + perMax + ' 字；别把他们并成一句「你们」，也别只答最新那一个。'
      + (asks.length > 1 ? '一共 ' + asks.length + ' 条，就发 ' + asks.length + ' 次，中间不用等。' : '')
      + '这一轮合计不超过 ' + totalMax + ' 字，其余热闹挑着接，不要写长篇。'
    : '怎么回：直接回他，一句不超过 ' + perMax + ' 字，别写长篇。';
  return head + '\n' + rows.join('\n') + '\n' + how + '\n\n';
}

/** 点名催单/补答回合的收尾说明（这种回合不设唤醒条件，由主槽位负责收尾）。 */
export function askTurnFooter({ group = true } = {}) {
  return group
    ? '【补答回合】这一轮只干一件事：把上面点名的人一个一个答完。答完直接停（qq_set_wake_config 交给主回合去做，你不用管）；没被点名的新消息这轮不用管，也别写总结、别写列表。\n\n'
    : '【补答回合】把上面等你的人答完就停，不用设置唤醒条件。\n\n';
}

/**
 * 全局发送节奏：所有会话共用一个最小间隔，避免两路并发把 QQ 打爆。
 * take() 返回一个 Promise，resolve 时表示「现在可以发了」。
 */
export function createPacer(gapMs, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let gap = Math.max(0, Number(gapMs) || 0);
  let nextAt = 0;
  let chain = Promise.resolve();
  return {
    take() {
      chain = chain.then(async () => {
        const wait = Math.max(0, nextAt - now());
        if (wait > 0) await sleep(wait);
        nextAt = now() + gap;
      });
      return chain;
    },
    setGap(ms) { gap = Math.max(0, Number(ms) || 0); },
    get gap() { return gap; },
    get nextAt() { return nextAt; },
  };
}
