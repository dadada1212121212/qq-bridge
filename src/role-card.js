// 人格卡（roles/<名称>.md）的解析与「按仿真模式取用」。
//
// 为什么要分模式：
//   一代仿真（reserved）用空格分条、用 [SILENT] 表示沉默；
//   二代仿真（reserved2）必须用工具发言（qq_send_message 的数组分条），没有 [SILENT]。
//   同一张人格卡被两种模式共用时，一代专属指令会与二代工具协议冲突。
// 以前靠 currentRoleHintV2() 对正文做「逐行猜测 + 正则过滤」，既容易误伤又说不清边界。
//
// 现在改为显式标记：在标题里写模式，桥接只取当前模式适用的小节。
//   ## 表情包体系 〔二代〕      → 只在 reserved2 注入
//   ## 分条方式 〔一代〕        → 只在 reserved/chat 注入
//   ## 你是谁                   → 两种模式都注入
// 标记会在注入前从标题里去掉，模型看到的始终是干净的小节标题。
export const ROLE_INJECT_MODES = ['v1', 'v2'];

// 模式标记：`〔二代〕` / `[v2]` / `（reserved2）` 等写法都认。
const MODE_TAGS = [
  { mode: 'v2', re: /[\[〔（(]\s*(?:二代|2\s*代|v2|reserved2)\s*[\]〕）)]/gi },
  { mode: 'v1', re: /[\[〔（(]\s*(?:一代|1\s*代|v1|reserved)\s*[\]〕）)]/gi },
];

function detectMode(heading) {
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    if (tag.re.test(heading)) return tag.mode;
  }
  return 'all';
}

function stripModeTags(heading) {
  let out = String(heading);
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    out = out.replace(tag.re, '');
  }
  return out.replace(/[ \t]+$/, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 按标题把人格卡拆成小节。
 * @returns {{mode: 'all'|'v1'|'v2', heading: string|null, lines: string[]}[]}
 */
export function parseRoleSections(text) {
  const sections = [];
  let current = null;
  for (const rawLine of String(text ?? '').split('\n')) {
    // 去掉行尾 \r：Windows 换行会把每行尾巴带上 \r，而非 multiline 的正则
    // `/^(#{1,6})\s+(.*)$/` 里 `.` 不匹配 \r、`$` 又不认中间的 \r，
    // 结果「## 标题\r」整行不匹配、被当成正文——所有小节会塌成一整块。
    const line = rawLine.replace(/\r+$/, '');
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) {
      if (!current) {
        current = { mode: 'all', heading: null, lines: [] };
        sections.push(current);
      }
      current.lines.push(line);
      continue;
    }
    const title = stripModeTags(heading[2]);
    current = { mode: detectMode(heading[2]), heading: title, lines: [`${heading[1]} ${title}`] };
    sections.push(current);
  }
  return sections;
}

/**
 * 取出某次仿真真正要注入的人格文本（已去掉模式标记）。
 * @param {'v1'|'v2'} mode
 */
export function selectRoleText(text, mode) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  return parseRoleSections(text)
    .filter((section) => section.mode === 'all' || section.mode === want)
    .map((section) => section.lines.join('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 按小节贪心填充，把人格文本裁到 maxChars 以内。
 *
 * 为什么不直接 slice：硬切字符会把一句话、甚至一个标题切成半截，
 * 模型看到的是残缺语义（比如「## 九、你记得的东」）。改成「整个小节要么进、
 * 要么不进」之后，任何一次注入都是完整的语义块。
 *
 * 规则：
 *   - 从第 1 个小节往下累加，只要「已用 + 本小节（含分隔符）」不超预算就收下；
 *   - 一旦某个小节放不下，**跳过它继续试后面的小些小节**（不直接 break）——
 *     否则一个超长小节会把后面所有小节一起挡在门外；
 *   - 若连第一个小节都放不下（超长单节兜底），退化为按字符硬切（保留原语义下限）。
 *
 * @param {string} text  selectRoleText 的输出
 * @param {number} maxChars
 * @returns {{text: string, truncated: boolean, droppedHeadings: string[], usedChars: number}}
 */
export function fitRoleText(text, maxChars) {
  const source = String(text ?? '');
  const limit = Number.isFinite(Number(maxChars)) ? Math.max(0, Math.floor(Number(maxChars))) : 0;
  if (limit === 0) return { text: '', truncated: source.length > 0, droppedHeadings: [], usedChars: 0 };
  if (source.length <= limit) return { text: source, truncated: false, droppedHeadings: [], usedChars: source.length };

  const sections = parseRoleSections(source)
    .map((section) => ({ heading: section.heading, mode: section.mode, body: section.lines.join('\n').trim() }))
    .filter((section) => section.mode === 'all' || section.mode === 'v1' || section.mode === 'v2')
    .filter((section) => section.body.length > 0);

  const kept = [];
  const droppedHeadings = [];
  let used = 0;
  for (const section of sections) {
    const cost = section.body.length + (kept.length > 0 ? 2 : 0); // 小节之间补空行
    if (used + cost > limit) {
      droppedHeadings.push(section.heading ?? '(开头部分)');
      continue; // 跳过这个、继续试后面更小的，避免一个长节挡死全部
    }
    kept.push(section.body);
    used += cost;
  }

  if (kept.length === 0) {
    // 兜底：单个小节就超预算。宁可交出不完整的单节，也不能整段空白。
    const head = sections[0].body;
    const fit = (function (s) {
      let cut = limit;
      const code = s.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
      return s.slice(0, Math.max(1, cut));
    })(head);
    return { text: fit, truncated: true, droppedHeadings: droppedHeadings.slice(1), usedChars: fit.length };
  }

  return { text: kept.join('\n\n'), truncated: true, droppedHeadings, usedChars: used };
}

/**
 * 报告每个小节在当前模式下是否会被注入，供控制台预览。
 * @param {'v1'|'v2'} mode
 */
export function roleSectionReport(text, mode) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  return parseRoleSections(text).map((section) => ({
    heading: section.heading ?? '(开头部分)',
    mode: section.mode,
    injected: section.mode === 'all' || section.mode === want,
    chars: section.lines.join('\n').trim().length,
  }));
}

/** 统计各模式的字符数，用于控制台提示「去掉另一模式的专属小节后还剩多少」。 */
export function roleCharStats(text) {
  const source = String(text ?? '');
  const sections = parseRoleSections(source);
  const sum = (list) => list.reduce((total, section) => total + section.lines.join('\n').trim().length, 0);
  return {
    total: source.length,
    common: sum(sections.filter((section) => section.mode === 'all')),
    v1Only: sum(sections.filter((section) => section.mode === 'v1')),
    v2Only: sum(sections.filter((section) => section.mode === 'v2')),
    v1: selectRoleText(source, 'v1').length,
    v2: selectRoleText(source, 'v2').length,
  };
}

// 一代仿真遗留指令：未加模式标记时，这些行在二代下会被兜底过滤。
// 正确做法是给所在小节加上 〔一代〕 标记。
export const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;
