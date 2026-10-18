// 把 agent 的 Markdown 回复转成适合 QQ 发送的纯文本。
export function mdToPlain(md) {
  let s = String(md ?? '');
  // 代码块：保留内容，去掉围栏（内容尾部换行去掉，围栏后的换行自然保留一个分隔）
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, body) => body.replace(/\n+$/, ''));
  // 行内代码
  s = s.replace(/`([^`\n]+)`/g, '$1');
  // 图片/链接：保留文字，链接附在括号里（QQ 可点）
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => (alt || url));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
  // 粗体/斜体/删除线标记
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  // 标题符
  s = s.replace(/^#{1,6}\s+/gm, '');
  // 引用符
  s = s.replace(/^>\s?/gm, '');
  // 列表符
  s = s.replace(/^\s*[-*+]\s+/gm, '• ');
  s = s.replace(/^\s*\d+\.\s+/gm, (m) => m.trim() + ' ');
  // 表格：按行保留文本
  s = s.split('\n').filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line) || line.includes('|') === false || /\S/.test(line.replace(/[\s:|-]/g, ''))).join('\n');
  s = s.replace(/^\s*\|/gm, '').replace(/\|\s*$/gm, '');
  // 折叠的连续空行
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 按 QQ 单条消息长度上限切分（群消息一般 ≤ 4500 字，留余量）。 */
export function splitForQQ(text, max = 4000) {
  const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 4000;
  const parts = [];
  let rest = text;
  while (rest.length > safeMax) {
    let cut = rest.lastIndexOf('\n', safeMax - 1);
    let eat = 0;
    if (cut <= 0) {
      cut = safeMax; // 硬切
    } else {
      eat = 1; // 换行符保留给前一段，避免拼接后丢换行
    }
    // 若切点正好落在代理对中间（emoji 等会被切成乱码），把切点前移一个码元
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    // 防止 max=1 且开头是 emoji 代理对时零进度死循环：至少推进一个完整码点。
    if (cut <= 0) {
      const first = rest.charCodeAt(0);
      const second = rest.charCodeAt(1);
      cut = (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) ? 2 : 1;
      eat = 0;
    }
    parts.push(rest.slice(0, cut + eat));
    rest = rest.slice(cut + eat);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/**
 * 截断到最多 `max` 个字符，**绝不切开代理对**。
 *
 * 为什么不直接用 `text.slice(0, max)`：`String.prototype.slice` 按 UTF-16 **码元**切，
 * 而 QQ 里常见的 emoji / 生僻字占**两个**码元。切点正好落在中间时会留下一个孤立高代理
 * ——它不是一个合法字符，写进 JSON、日志、提示词后一律渲染成替换符（�）。
 * 桥接里"截断给人看"的地方很多（记忆、旁观窗口、消息详情、角色卡），全部中招。
 *
 * 语义：上限按**码点**算（对纯 BMP 文本与 slice 完全一致；对含 emoji 的文本只多留不切坏）。
 * 判据与同文件的 splitForQQ、以及 src/forward.js 的预览截断保持一致。
 * `max` 非有限数时返回空串 —— 与 `slice(0, NaN)` 的既有行为一致，不做静默放宽。
 */
export function truncateText(value, max) {
  const s = String(value ?? '');
  const limit = Number.isFinite(Number(max)) ? Math.max(0, Math.floor(Number(max))) : 0;
  if (limit === 0) return '';
  if (s.length <= limit) return s;
  let cut = limit;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // 切在高代理上：前移一个码元
  if (cut <= 0) { // limit=1 且开头就是代理对：至少保留一个完整码点
    const first = s.charCodeAt(0);
    const second = s.charCodeAt(1);
    cut = (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) ? 2 : 1;
  }
  return s.slice(0, cut);
}

/**
 * {@link truncateText} 的尾部版本：保留**最后** `max` 个字符。
 *
 * 对应 `text.slice(-max)` —— 它同样按码元切，只是切点落在**低**代理上：
 * 结果开头会多出一个孤立低代理，同样是坏字符。判据镜像处理。
 */
export function truncateTextTail(value, max) {
  const s = String(value ?? '');
  const limit = Number.isFinite(Number(max)) ? Math.max(0, Math.floor(Number(max))) : 0;
  if (limit === 0) return '';
  if (s.length <= limit) return s;
  let start = s.length - limit;
  const code = s.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) { // 切点在低代理上
    const before = s.charCodeAt(start - 1);
    // 前面是高代理 ⇒ 这对是一个完整字符，一起留下（宁可多一个码元，也不留孤立代理）；
    // 否则是畸形输入里的孤儿低代理，丢掉它。
    start = (start > 0 && before >= 0xd800 && before <= 0xdbff) ? start - 1 : start + 1;
  }
  return s.slice(start);
}

/**
 * 删掉字符串里的**孤立代理项**（lone surrogate）。
 *
 * 为什么必须有这一层：`String.prototype.slice` 按 UTF-16 **码元**切，切在代理对中间会留下
 * 半个 emoji（U+D800–U+DBFF 高代理 / U+DC00–U+DFFF 低代理）。它不是一个合法字符，
 * `JSON.stringify` 会把它写成 `"\ud83d"` 形式的转义原样发出去，于是：
 *   - DeepSeek / Anthropic 兼容端点解析请求体时直接 400（`... request failed (400)`）；
 *   - 更糟的是它会**存进会话帧**：之后每一步重发历史都再 400 一次，换新会话也没用
 *     —— 冻结的 recap 存在按会话的状态里，重新生成时又把毒文本喂回去（见 bridge.js 的 buildRecapV2）。
 * 所以桥接在两头都设闸：截断处一律用 {@link truncateText} / {@link truncateTextTail}（不制造坏码元），
 * 提示词投递前与 QQ 发送前再用本函数兜掉任何来源（QQ 消息、记忆库、第三方 JSON…）的坏码元。
 *
 * 语义：完整代理对原样保留，孤立的那一个直接丢弃（丢弃不会引入新的坏码元）。
 */
export function stripLoneSurrogates(value) {
  const s = String(value ?? '');
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { // 高代理：后面必须紧跟低代理
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) { out += s[i] + s[i + 1]; i += 1; }
      continue; // 孤高代理：丢掉
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue; // 孤低代理：丢掉
    out += s[i];
  }
  return out;
}
