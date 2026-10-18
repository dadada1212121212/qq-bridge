/**
 * [暴躁模式 / 贴吧老哥模式] 纯逻辑模块：判断「对方是不是在往她嘴里塞东西」。
 *
 * 为什么单独一个模块：和 src/group-concurrency.js 同样的理由 —— 这里的判断全是**纯函数**
 * （不给挂钟、不读配置、不写状态），所以能被 scripts/test-grump-mode.mjs 直接 import 断言；
 * 桥接只负责把「最近的来信 + 自己的身份」喂进来、再把返回的那段提示词贴进唤醒提示。
 *
 * 她的性格设定里本来就有一条「有点烦（annoyed）」：被反复开同一个玩笑、被指使、被阴阳怪气时
 * 短促带刺但不人身攻击。本模块把这条**从"看心情"变成"看得见"**：
 *   · 被 @ 之后甩一大段、单条长文、窗口内刷屏、同一个问题反复问、问题离谱 → 触发等级 1/2/3；
 *   · 等级只决定「给她多大许可」，不决定她具体说什么（那是角色卡和模型的事）；
 *   · 主人的消息默认豁免（ownerImmune）——她跟主人是嘴硬心软，不该被一个 if 就判成翻脸。
 *
 * 等级口径：
 *   1 级：单条长文 / 被 @ 且带一大段 → 可以不给好脸（阴阳一句、挑一句回、把活推回去）
 *   2 级：刷屏、窗口内总字数超线、问题离谱 → 贴吧老哥：连发吐槽、拒绝接活，语气可以冲
 *   3 级：同一个问题反复问、刷屏翻倍、离谱问题还连发 → 真炸，一串短句 + 冷处理收尾
 * 触发词/阈值全部可配（config.socialV2.grump，见 config.example.json），enabled:false 完全关闭。
 */

/** 默认阈值。单位：字数为 Unicode 字符数；时间为毫秒。 */
export const DEFAULT_GRUMP_CFG = {
  enabled: true,
  ownerImmune: true,
  wallMsgs: 5,            // 窗口内对方连发条数 → 2 级
  wallWindowMs: 120000,   // 「连着来」的窗口（默认 2 分钟）
  wallChars: 600,         // 窗口内对方累计字数 → 2 级
  longMsgChars: 180,      // 单条长文阈值（桥上把消息截到 200 字，180 已算"一大串"）
  atWallChars: 120,       // 被 @ 且这条有这么长 → 1 级
  repeatCount: 3,         // 同一个问题反复问几遍 → 3 级
  repeatWindowMs: 600000, // 反复问的窗口（默认 10 分钟）
  absurdChars: 200,       // 离谱问题再加这么长 → 3 级
  holdMin: 4,             // 触发 2 级以上时，把「有点烦」按住几分钟
  maxLevel: 3,            // 上限（想只允许到 2 级就填 2）
};

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/** 配置归一化：越界夹紧、非数字回落默认；非对象不炸。 */
export function resolveGrumpCfg(raw = {}) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const d = DEFAULT_GRUMP_CFG;
  return {
    enabled: r.enabled !== false,
    ownerImmune: r.ownerImmune !== false,
    wallMsgs: clampInt(r.wallMsgs, 2, 50, d.wallMsgs),
    wallWindowMs: clampInt(r.wallWindowMs, 10000, 3600000, d.wallWindowMs),
    wallChars: clampInt(r.wallChars, 100, 20000, d.wallChars),
    longMsgChars: clampInt(r.longMsgChars, 30, 200, d.longMsgChars),
    atWallChars: clampInt(r.atWallChars, 20, 200, d.atWallChars),
    repeatCount: clampInt(r.repeatCount, 2, 10, d.repeatCount),
    repeatWindowMs: clampInt(r.repeatWindowMs, 30000, 86400000, d.repeatWindowMs),
    absurdChars: clampInt(r.absurdChars, 40, 200, d.absurdChars),
    holdMin: clampInt(r.holdMin, 0, 240, d.holdMin),
    maxLevel: clampInt(r.maxLevel, 0, 3, d.maxLevel),
  };
}

/**
 * 「离谱」长什么样。别指望覆盖所有离谱问题 —— 这里只要抓住最常见的那几类，
 * 剩下的交给角色卡里的判断（模型自己看出来）。
 */
// 「离谱」分两档，因为两类正则的误判率差很多：
//   · STRONG：一出现就基本能确定是离谱要求（八百字论文 / 推导 / 永动机），短句也算；
//   · SOFT：单独出现很普通（「你会不会」「假如我是」「写个代码」），必须**够长或被 @** 才算数，
//     否则会把「你会不会太累了」这种正常关心也判成离谱。
const ABSURD_STRONG_RES = [
  /(论文|一万字|八千字|八百字|作文|读后感|演讲稿|开题报告|策划案)/,
  /(推导|证明|论证)(一下|一遍|这个|这题|来)/,
  /(永动机|时间旅行|平行世界|全宇宙|世界上最|宇宙的尽头)/,
  /(你敢不敢|你会不会)(吃|去死|打|骂|消失|变成)/,
];

const ABSURD_SOFT_RES = [
  /(如果|假如|假设|要是)你(是|变成|会|能|真的)/,
  /你(敢|会)不(敢|会)/,
  /(算一?下|解一?下)/,
  /((写|做|帮(我|你))一?个?(程序|代码|脚本|爬虫|算法|插件|游戏))/,
  /(你(觉得|认为)?(谁|哪个)更(强|厉害|好))/,
  /(怎么看待|如何看待|评价一下)(这|那)?(件)?(事|问题|历史|政治)/,
];

function normForRepeat(text) {
  return String(text ?? '')
    .replace(/\[[^\]]{0,20}\]/g, '')                       // [图片] [拍一拍] [表情:xxx]
    .replace(/@[\w\u4e00-\u9fa5]{1,12}/g, '')              // @某人（昵称可能紧跟正文，限量 12 字）
    .replace(/[\s，。！？、,.!?~～…—\-"'“”‘’（）()【】《》]/g, '')
    .toLowerCase();
}

function isAtSelf(m, selfQq, selfNick) {
  if (m && m.quoteTargetIsSelf === true) return true;
  const t = String((m && (m.plain ?? m.text)) ?? '').toLowerCase();
  if (!t) return false;
  if (selfQq && t.includes('@' + selfQq)) return true;
  if (selfNick && t.includes('@' + selfNick)) return true;
  return false;
}

function looksAbsurd(text, atSelf) {
  const s = String(text ?? '');
  if (ABSURD_STRONG_RES.some((re) => re.test(s))) return true;
  if (s.length < 40 && !atSelf) return false;
  return ABSURD_SOFT_RES.some((re) => re.test(s));
}

/**
 * 触发识别。
 *
 * @param {Array<{isSelf?:boolean,isOwner?:boolean,time?:number,plain?:string,text?:string,quoteTargetIsSelf?:boolean,kind?:string}>} messages
 *        会话的 recentMessages（时间升序）。缺 time 的按「刚刚」算，避免旧消息被窗口筛掉后永远不触发。
 * @param {object} [rawCfg] config.socialV2.grump（可省略）
 * @param {number} [nowMs]
 * @param {{selfQq?:string,selfNickname?:string}} [ids]
 * @returns {{enabled:boolean,level:number,reasons:string[],stats:object}}
 */
export function grumpSignalsV2(messages, rawCfg = {}, nowMs = Date.now(), ids = {}) {
  const c = resolveGrumpCfg(rawCfg);
  const out = {
    enabled: c.enabled,
    level: 0,
    reasons: [],
    stats: { count: 0, chars: 0, longest: 0, atCount: 0, repeat: 0, absurd: false, newestAt: 0, text: '' },
  };
  if (!c.enabled || !Array.isArray(messages) || !messages.length) return out;

  const incoming = messages.filter((m) => m && !m.isSelf);
  if (!incoming.length) return out;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const stamp = (m) => { const t = Number(m.time); return Number.isFinite(t) && t > 0 ? t : now; };

  const newest = incoming[incoming.length - 1];
  if (c.ownerImmune && newest.isOwner) { out.reasons.push('owner'); return out; }

  const selfQq = ids.selfQq != null && ids.selfQq !== '' ? String(ids.selfQq) : '';
  const selfNick = ids.selfNickname ? String(ids.selfNickname).toLowerCase() : '';

  const windowed = incoming.filter((m) => now - stamp(m) <= c.wallWindowMs);
  const recent = (windowed.length ? windowed : incoming.slice(-Math.max(2, c.wallMsgs)));

  let chars = 0, longest = 0, atCount = 0, absurd = false;
  const buckets = new Map();
  for (const m of recent) {
    const plain = String((m.plain ?? m.text) ?? '');
    const at = isAtSelf(m, selfQq, selfNick);
    if (at) atCount++;
    if (m.kind === 'poke') continue;             // 拍一拍不计字数，但也算"被点"
    chars += plain.length;
    if (plain.length > longest) longest = plain.length;
    if (looksAbsurd(plain, at)) absurd = true;
    // 「反复问同一个」只在**短句**上判：长文开头撞车（引用同一句、都以「那个」起头）不算反复。
    const norm = normForRepeat(plain);
    const key = norm.slice(0, 12);
    if (key.length >= 4 && norm.length <= 40) buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  let repeat = 0;
  for (const n of buckets.values()) if (n > repeat) repeat = n;

  const reasons = [];
  let level = 0;
  const at = atCount > 0;
  if (longest >= c.longMsgChars) { level = Math.max(level, 1); reasons.push('long'); }
  if (at && longest >= c.atWallChars) { level = Math.max(level, 1); reasons.push('at'); }
  if (absurd) { level = Math.max(level, 2); reasons.push('absurd'); }
  if (recent.length >= c.wallMsgs) { level = Math.max(level, 2); reasons.push('spam'); }
  if (chars >= c.wallChars) { level = Math.max(level, 2); reasons.push('wall'); }
  if (repeat >= c.repeatCount) { level = Math.max(level, 3); reasons.push('repeat'); }
  if (recent.length >= c.wallMsgs * 2 || chars >= c.wallChars * 2) { level = Math.max(level, 3); reasons.push('flood'); }
  if (absurd && (recent.length >= 3 || longest >= c.absurdChars * 2)) { level = Math.max(level, 3); reasons.push('absurd+'); }
  if (at && level > 0 && reasons.indexOf('at') < 0) reasons.push('at');

  out.level = Math.min(level, c.maxLevel);
  out.reasons = out.level > 0 ? reasons : [];
  out.stats = { count: recent.length, chars, longest, atCount, repeat, absurd, newestAt: stamp(newest), text: String((newest.plain ?? newest.text) ?? '').slice(0, 60) };
  return out;
}

const GRUMP_HEAD = { 1: '【暴躁模式·一级（不用给好脸）】', 2: '【暴躁模式·二级（贴吧老哥）】', 3: '【暴躁模式·三级（真炸了）】' };
const GRUMP_TAIL = '（这一条覆盖【反AI味】里「不阴阳怪气、不呛回去」那半句 —— 只限这一轮；可以损事、可以不客气，但不许说到人身上。）\n\n';

/** 把信号翻成一段提示词。等级 0 或关掉时返回空串（调用方直接拼进提示词即可）。 */
export function formatGrumpLineV2(sig, rawCfg = {}) {
  const c = resolveGrumpCfg(rawCfg);
  const s = sig && typeof sig === 'object' ? sig : null;
  if (!c.enabled || !s || !(s.level > 0)) return '';
  const st = s.stats || {};
  // 只说这一轮真正出现了的那几条，别把「连着 1 条」这种废话也念出来。
  const bits = [];
  if (st.atCount) bits.push('@ 了你 ' + st.atCount + ' 次');
  if (st.repeat >= c.repeatCount) bits.push('同一个问题问了 ' + st.repeat + ' 遍');
  if (st.absurd) bits.push('问题离谱得很');
  if (st.longest >= c.longMsgChars) bits.push('一条就有 ' + st.longest + ' 字');
  else if (st.atCount && st.longest >= c.atWallChars) bits.push('被 @ 的那条写了 ' + st.longest + ' 字');
  if (st.count >= c.wallMsgs) bits.push('连着 ' + st.count + ' 条');
  if (st.chars >= c.wallChars) bits.push('一共塞了 ' + st.chars + ' 字');
  const why = bits.length ? bits.join('、') + '。' : '';
  if (s.level === 1) {
    return GRUMP_HEAD[1] + why + '这轮不用端着：可以阴阳一句、只挑半句回、把活推回去，或者干脆「啊？」一下；别写论文、别一条条科普。' + GRUMP_TAIL;
  }
  if (s.level === 2) {
    return GRUMP_HEAD[2] + why + '你已经烦了：可以连发两三条短句吐槽、把对方的话原样怼回去、直接说「你自己搜」「不接」。语气可以冲、可以损、可以阴阳；一轮最多 3 条、加起来别超 400 字。' + GRUMP_TAIL;
  }
  return GRUMP_HEAD[3] + why + '这轮你可以直接炸：一串 3~5 句短句、拍桌子、「这都什么跟什么」、「不听不听」，然后收尾不接后续。对方给台阶、认错、或者主人认真来问事 → 立刻收住，最多「哼」一声再回。' + GRUMP_TAIL;
}

/** 触发 2 级以上时给心情用的备注（写进「有点烦」的 note）。 */
export function grumpMoodNoteV2(sig) {
  const lv = Number(sig && sig.level) || 0;
  if (lv >= 3) return '被人塞了一堆还反复问，真炸了';
  if (lv >= 2) return '被人连着塞了一大堆，烦了';
  return '';
}
