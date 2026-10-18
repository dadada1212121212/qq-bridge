// 定时播报的纯逻辑：节日判定 + 热点解析。**不碰网络、不碰 state**，方便单测。
//
// 为什么把节日表内置而不是查接口：播报是"到点必须开口"的功能，外部接口挂掉就会整个哑火。
// 公历节日直接写死；农历节日没有内置换算库（引一个农历库要几百 KB 且容易算错），
// 所以用**查表**：把 2025–2035 这几个高频农历节日（春节/元宵/端午/七夕/中秋/重阳）的
// 公历日期逐年列出。表外年份就只认公历节日 —— 宁可少说一句，也不乱说一句。

/** 公历固定日期节日：'MM-DD' -> 名称。用 `月-日` 两位补零。 */
export const SOLAR_FESTIVALS = {
  '01-01': '元旦',
  '02-14': '情人节',
  '03-08': '妇女节',
  '03-12': '植树节',
  '04-01': '愚人节',
  '05-01': '劳动节',
  '05-04': '青年节',
  '06-01': '儿童节',
  '07-01': '建党节',
  '08-01': '建军节',
  '09-10': '教师节',
  '10-01': '国庆节',
  '12-24': '平安夜',
  '12-25': '圣诞节'
};

/**
 * 农历节日查表：'YYYY-MM-DD'（公历）-> 名称。
 * 来源为公开万年历，覆盖 2025–2035。查不到就不判，不猜。
 */
export const LUNAR_FESTIVALS = {
  // 春节（正月初一）
  '2025-01-29': '春节', '2026-02-17': '春节', '2027-02-06': '春节', '2028-01-26': '春节',
  '2029-02-13': '春节', '2030-02-03': '春节', '2031-01-23': '春节', '2032-02-11': '春节',
  '2033-01-31': '春节', '2034-02-19': '春节', '2035-02-08': '春节',
  // 元宵节（正月十五）
  '2025-02-12': '元宵节', '2026-03-03': '元宵节', '2027-02-20': '元宵节', '2028-02-09': '元宵节',
  '2029-02-27': '元宵节', '2030-02-17': '元宵节', '2031-02-06': '元宵节', '2032-02-25': '元宵节',
  '2033-02-14': '元宵节', '2034-03-05': '元宵节', '2035-02-22': '元宵节',
  // 端午节（五月初五）
  '2025-05-31': '端午节', '2026-06-19': '端午节', '2027-06-09': '端午节', '2028-05-28': '端午节',
  '2029-06-16': '端午节', '2030-06-05': '端午节', '2031-06-24': '端午节', '2032-06-12': '端午节',
  '2033-06-01': '端午节', '2034-06-20': '端午节', '2035-06-10': '端午节',
  // 七夕（七月初七）
  '2025-08-29': '七夕', '2026-08-19': '七夕', '2027-08-08': '七夕', '2028-08-26': '七夕',
  '2029-08-16': '七夕', '2030-08-05': '七夕', '2031-08-24': '七夕', '2032-08-12': '七夕',
  '2033-08-02': '七夕', '2034-08-20': '七夕', '2035-08-09': '七夕',
  // 中秋节（八月十五）
  '2025-10-06': '中秋节', '2026-09-25': '中秋节', '2027-09-15': '中秋节', '2028-10-03': '中秋节',
  '2029-09-22': '中秋节', '2030-09-12': '中秋节', '2031-10-01': '中秋节', '2032-09-19': '中秋节',
  '2033-09-08': '中秋节', '2034-09-27': '中秋节', '2035-09-16': '中秋节',
  // 重阳节（九月初九）
  '2025-10-29': '重阳节', '2026-10-18': '重阳节', '2027-10-08': '重阳节', '2028-10-26': '重阳节',
  '2029-10-16': '重阳节', '2030-10-05': '重阳节', '2031-10-24': '重阳节', '2032-10-12': '重阳节',
  '2033-10-01': '重阳节', '2034-10-20': '重阳节', '2035-10-09': '重阳节'
};

/** 春节/中秋这类大节，值得多说一句；其余小节日按普通节处理。 */
export const MAJOR_FESTIVALS = new Set(['春节', '中秋节', '国庆节', '元旦', '端午节', '元宵节']);

/**
 * 判断某天是什么节日。返回 `{ name, major, kind }` 或 `null`。
 * 农历优先级高于公历：中秋和国庆同天的年份（如 2031-10-01），报"中秋节"更贴切。
 */
export function festivalOf(dateStr) {
  const s = String(dateStr ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const lunar = LUNAR_FESTIVALS[s];
  if (lunar) return { name: lunar, major: MAJOR_FESTIVALS.has(lunar), kind: 'lunar' };
  const solar = SOLAR_FESTIVALS[s.slice(5)];
  if (solar) return { name: solar, major: MAJOR_FESTIVALS.has(solar), kind: 'solar' };
  return null;
}

/** 元旦/春节/国庆当天额外给一句"新年/生日快乐"式的祝福语气提示。 */
export function festivalGreeting(name) {
  switch (name) {
    case '元旦': return '新的一年第一天，可以给主人道个新年好';
    case '春节': return '过年了，说句吉利话（别太正式，按你的口气）';
    case '中秋节': return '中秋，可以提一句月亮/团圆/吃月饼';
    case '国庆节': return '国庆，可以顺口说句假期愉快';
    case '元宵节': return '元宵，可以提一句汤圆/看灯';
    case '端午节': return '端午，可以提一句粽子';
    case '七夕': return '七夕，可以皮一句（但别过头）';
    case '圣诞节': return '圣诞，可以顺口说句圣诞快乐';
    case '平安夜': return '平安夜，可以顺口说句平安夜快乐';
    case '儿童节': return '儿童节，可以顺势卖个萌';
    default: return '';
  }
}

/** 标题字段的常见名字，按优先级。 */
const TITLE_KEYS = ['word', 'title', 'name', 'query', 'hotword', 'keyword', 'content', 'text'];

/** 从一个对象里取标题字段（空字符串表示没取到）。 */
function titleOf(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    for (const k of TITLE_KEYS) {
      const v = item[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  return '';
}

/**
 * 从一个数组里抽标题（元素可以是字符串或对象）。
 * 返回 `{ titles, objectCount }`：objectCount 表示"看起来是条目对象"的个数，
 * 用来判断这一层到底是不是真正的标题列表（而不是一层包装）。
 */
function collectTitles(arr, cap) {
  const titles = [];
  let objectCount = 0;
  for (const item of arr) {
    if (item && typeof item === 'object' && !Array.isArray(item)) objectCount += 1;
    const t = titleOf(item);
    if (t) titles.push(t);
    if (titles.length >= cap) break;
  }
  return { titles, objectCount };
}

/**
 * 递归找"最像标题列表"的那一层数组。
 * 为什么需要递归：热榜接口的包装层数不固定 —— 百度是
 * `data.cards[0].content[0].content[]`，别的可能是 `data[]` / `result.list[]`。
 * 策略：深度优先，**优先选层级最深**、且元素带标题字段的数组（越深越可能是真正的条目）；
 * 同深度取条数多的。找不到就返回空数组。
 */
function findTitleArray(node, depth, cap, best) {
  if (depth > 6 || !node) return best;
  if (Array.isArray(node)) {
    const { titles, objectCount } = collectTitles(node, cap);
    // 这一层有实打实的标题条目 → 成为候选；层级更深者优先。
    if (titles.length && (objectCount > 0 || node.some((x) => typeof x === 'string'))) {
      if (!best || depth > best.depth || (depth === best.depth && titles.length > best.titles.length)) {
        best = { depth, titles };
      }
    }
    for (const item of node) best = findTitleArray(item, depth + 1, cap, best);
    return best;
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) best = findTitleArray(node[k], depth + 1, cap, best);
  }
  return best;
}

/**
 * 从热榜接口返回的 JSON 里抠出「标题列表」。
 * 结构容忍两层：先按常见包装键（data/result/list…）直接取，取不到就递归深挖最深的那层标题数组。
 * **取不到就返回 []，绝不抛**。
 */
export function extractHotTitles(json, limit = 8) {
  const max = Math.max(0, Number(limit) || 0);
  if (!max) return [];
  if (json === null || json === undefined) return [];

  // 快路径：裸数组 / 常见包装键直接命中。
  let fast = null;
  if (Array.isArray(json)) fast = json;
  else if (typeof json === 'object') {
    for (const k of ['data', 'result', 'list', 'items', 'hots', 'trends', 'topics']) {
      if (Array.isArray(json[k])) { fast = json[k]; break; }
    }
  }
  const fastTried = fast ? collectTitles(fast, max) : null;
  // 只有在快路径确实拿到标题时才用它；否则走递归（应对比百度那种多层包装）。
  const picked = fastTried && fastTried.titles.length ? fastTried.titles : null;

  // 过滤 + 去重 + 截断（两条路径共用）
  const finish = (arr) => {
    const out = [];
    const seen = new Set();
    for (const raw of arr) {
      const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t.slice(0, 60));
      if (out.length >= max) break;
    }
    return out;
  };

  if (picked) return finish(picked);
  const deep = findTitleArray(json, 0, max, null);
  return finish(deep?.titles || []);
}

/**
 * 从 HTML 里抠热榜标题（有些热榜接口直接吐 HTML 片段）。
 * 同样宽容：取 `>标题<` 里的可见文本，过滤纯符号/过短/明显是标签名的。
 */
export function extractHotTitlesFromHtml(html, limit = 8) {
  const max = Math.max(0, Number(limit) || 0);
  if (!max) return [];
  const text = String(html ?? '');
  const out = [];
  const seen = new Set();
  const re = />([^<>{}]{2,60})</g;
  let m;
  while ((m = re.exec(text)) && out.length < max) {
    const t = m[1].replace(/\s+/g, ' ').trim();
    if (!t) continue;
    // 过滤明显不是标题的：纯数字/符号、含 CSS/JS 关键字、像文件名的。
    if (!/[\u4e00-\u9fa5]/.test(t)) continue;
    if (/[{}=;]|function|var |window\.|https?:/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t.slice(0, 60));
  }
  return out;
}

/**
 * 热点播报的措辞（喂给模型的引导语）。热门条目只是"参考素材"，
 * 明确要求她自己挑、别照抄、别当新闻播报，保持闲聊口气。
 */
export function buildHotTopicHint(titles) {
  const list = Array.isArray(titles) ? titles.filter((t) => String(t || '').trim()) : [];
  if (!list.length) return '';
  return `\n【今天网上在聊的（只是给你个由头，别照着念、别像播新闻）】\n${list.map((t) => `- ${t}`).join('\n')}\n`;
}
