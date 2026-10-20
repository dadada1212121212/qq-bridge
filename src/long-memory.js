// 超长记忆库（情景记忆层，2026-10-19）。
//
// 为什么单独成模块：memory-db.js 已有「人/事实/梗/日记」的语义层，但缺**时间线上的情景记忆**
// ——「上个月和谁聊了什么」「很久以前的某个约定」「去年的今天」。现有的历史回想只是对
// messages 表做 300 字 LIKE 检索，超过 recentMessages 窗口的对话等于没发生过。
//
// 设计（2026-10-19 调研结论落地）：
//   - 分层记忆四分法（working/episodic/semantic/procedural）里补 episodic 层；
//     semantic 层复用 memory-db 的 facts，不重复建设。
//   - 编码-存储-检索-更新-遗忘生命周期：
//       编码 = 每天一次本地固化（零 LLM token）：从 memory-db 取当天的消息/事实/事件信号，
//              规则式拼成一段情景摘要（参与人 + 话题 + 新事实 + 心情 + 首末对话摘录）；
//       存储 = episodes 表（key + day 唯一，重跑幂等覆盖）；
//       检索 = 来信关键词 × 时间衰减 × 重要性 排序取 top，外加「去年的今天」时间感知；
//       遗忘 = importance=1 过期清理，importance 越高留得越久（3 = 有约定/冲突，永不自动删）。
//   - 省 token 是硬要求：固化/检索全在本地 SQLite 上跑，不加网络、不加延迟、不烧模型；
//     注入预算默认 ≤400 字，只挑最相关的 1~3 段。
//   - 不引向量库/embedding：中文 2 字滑窗 + 词面匹配对这个量级（每天 ≤N 条 episode）足够，
//     与 memory-db.js 既有检索路线一致（AstrBot 稀疏检索那一半）。
import { DatabaseSync } from 'node:sqlite';
import { truncateText } from './md-to-plain.js';

const LM_STOP_WORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '在', '有', '和', '就', '不', '也', '都', '这', '那',
  '什么', '怎么', '可以', '一个', '我们', '你们', '他们', '没有', '就是', '还是', '不是', '一下',
  '吗', '呢', '啊', '吧', '呀', '哦', '嗯', '哈', '嘛', '啦', '诶', '嘿嘿', '哈哈',
  '觉得', '知道', '现在', '时候', '因为', '所以', '但是', '然后', '这个', '那个', '自己',
  '真的', '有点', '一点', '今天', '昨天', '明天', '大家', '什么'
]);

/**
 * 本地时区的 YYYY-MM-DD。offsetDays=1 就是昨天。
 * 实现已统一到 `day-key.js`（2026-10-20）：这个函数原来在 4 个文件里各有一份，
 * 而"UTC 还是本地"改漏一处就会让统计/控制台对不上日期。
 */
import { localDayString, daysAgoOf } from './day-key.js';
export { localDayString };

/** 时间描述：7 天内 → N天前；否则 N周前/N个月前/N年前。 */
function agoLabel(day, now) {
  const days = daysAgoOf(day, now);
  if (days <= 1) return '昨天';
  if (days <= 7) return `${days}天前`;
  if (days <= 45) return `${Math.round(days / 7)}周前`;
  const months = Math.round(days / 30);
  if (months < 12) return `${Math.max(1, months)}个月前`;
  return `${Math.round(days / 365)}年前`;
}

/** 从一组文本提取检索关键词：中文 2 字滑窗按频次 + 英文/数字词，过滤停用词。 */
export function extractKeywords(texts, limit = 6) {
  const freq = new Map();
  const push = (w) => {
    if (!w || w.length < 2 || LM_STOP_WORDS.has(w)) return;
    freq.set(w, (freq.get(w) || 0) + 1);
  };
  for (const raw of Array.isArray(texts) ? texts : []) {
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) continue;
    for (const w of s.match(/[A-Za-z0-9_]{2,}/g) || []) push(w.toLowerCase());
    const cjk = s.replace(/[^\u4e00-\u9fa5]/g, ' ');
    for (const seg of cjk.split(' ')) {
      for (let i = 0; i + 2 <= seg.length; i++) push(seg.slice(i, i + 2));
    }
  }
  return [...freq.entries()]
    .filter(([w, n]) => n >= 2 || w.length >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

const PROMISE_RE = /答应|约定|约好|拉钩|说定了|说好了/;
const CONFLICT_RE = /吵架|拉黑|闹翻|讨厌你|不理你|对不起|原谅我/;
const MOODS = ['开心', '兴奋', '平静', '无聊', '烦躁', '难过', '困', '戳', '满足', 'annoyed', 'happy', 'sad', 'tired'];

/** 重要性评分（1~3）。3 = 有约定/冲突/重感情事件，永不自动遗忘。 */
export function scoreImportance({ facts = [], messages = [], events = [] } = {}) {
  let imp = 1;
  if (Array.isArray(facts) && facts.length >= 1) imp = 2;
  // 事件/事实层面出现约定或冲突 → imp3（这些是模型主动写下的，可信度高）
  const formal = [
    ...(Array.isArray(events) ? events.map((e) => `${e?.kind || ''}${e?.summary || ''}`) : []),
    ...(Array.isArray(facts) ? facts : [])
  ].join('\n');
  if (PROMISE_RE.test(formal) || CONFLICT_RE.test(formal)) imp = 3;
  if (Array.isArray(events) && events.some((e) => /up|love|relation/i.test(String(e?.kind || '')))) imp = Math.max(imp, 3);
  // 消息原文只认「明显冲突」：聊天里「下次/明天」这类词太常见，不能作为升级依据
  const chatText = (Array.isArray(messages) ? messages : []).map((m) => String(m?.text || '')).join('\n');
  if (CONFLICT_RE.test(chatText)) imp = Math.max(imp, 3);
  return Math.min(3, Math.max(1, imp));
}

export function createLongMemory({ file, log = () => {}, maxSummaryChars = 260 } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      day TEXT NOT NULL,
      participants TEXT NOT NULL DEFAULT '',
      topics TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL,
      mood TEXT NOT NULL DEFAULT '',
      importance INTEGER NOT NULL DEFAULT 1,
      keywords TEXT NOT NULL DEFAULT '[]',
      hits INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER,
      UNIQUE(key, day)
    );
    CREATE TABLE IF NOT EXISTS lm_meta (k TEXT PRIMARY KEY, v TEXT);
  `);

  const stmts = {
    upsert: db.prepare(`INSERT INTO episodes (key, day, participants, topics, summary, mood, importance, keywords, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key, day) DO UPDATE SET participants=excluded.participants, topics=excluded.topics,
        summary=excluded.summary, mood=excluded.mood, importance=excluded.importance, keywords=excluded.keywords, updated_at=excluded.updated_at`),
    all: db.prepare('SELECT * FROM episodes WHERE key = ? ORDER BY day DESC'),
    allByKeyDay: db.prepare('SELECT id FROM episodes WHERE key = ? AND day = ?'),
    metaGet: db.prepare('SELECT v FROM lm_meta WHERE k = ?'),
    metaSet: db.prepare('INSERT INTO lm_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    bump: db.prepare('UPDATE episodes SET hits = hits + 1 WHERE id = ?'),
    pruneImp1: db.prepare('DELETE FROM episodes WHERE importance <= ? AND day < ?'),
    stats: db.prepare('SELECT COUNT(*) AS n, MIN(day) AS oldest, MAX(day) AS newest FROM episodes')
  };

  function keywordsOf(row) {
    try { return JSON.parse(row.keywords || '[]'); } catch { return []; }
  }
  function topicsOf(row) {
    try { return JSON.parse(row.topics || '[]'); } catch { return []; }
  }

  /**
   * 固化一天的情景记忆（幂等：同 key+day 重跑覆盖）。
   * signals 由调用方从 memory-db.daySignals(key, day) 取得：
   *   { messages: [{sender, is_self, text, at}], facts: [text], events: [{kind, summary}] }
   * participants/topics 可选传入（调用方若已知人名/话题），否则从消息里提取。
   */
  function consolidateDay(key, day, signals = {}) {
    const now = Date.now();
    const messages = Array.isArray(signals.messages) ? signals.messages : [];
    if (messages.length < 3) return null; // 几乎没聊的天不值得记
    const facts = (Array.isArray(signals.facts) ? signals.facts : []).map((f) => String(f || '').trim()).filter(Boolean).slice(0, 5);
    const events = Array.isArray(signals.events) ? signals.events : [];
    const others = messages.filter((m) => m && !Number(m.is_self));
    const participants = (Array.isArray(signals.participants) && signals.participants.length)
      ? signals.participants.slice(0, 4)
      : [...new Set(others.map((m) => String(m?.sender || '')).filter((s) => s && !['私聊', '群聊', '未知'].includes(s)))].slice(0, 4);
    const topics = (Array.isArray(signals.topics) && signals.topics.length)
      ? signals.topics.slice(0, 6)
      : extractKeywords(messages.map((m) => String(m?.text || '')), 6);
    const mood = String(signals.mood || '').slice(0, 12);
    const selfName = '我';
    const firstLine = String(messages[0]?.text || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    const lastLine = String(messages[messages.length - 1]?.text || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    const parts = [];
    parts.push(participants.length ? `和${participants.join('、')}` : '一个人待着');
    if (topics.length) parts.push(`聊${topics.slice(0, 3).join('、')}`);
    if (facts.length) parts.push(`记住${facts.length}件新事`);
    if (mood) parts.push(`心情偏${mood}`);
    let summary = `${parts.join('，')}`;
    if (firstLine) summary += `。开头在聊「${firstLine}」`;
    if (lastLine && lastLine !== firstLine) summary += `，后来聊到「${lastLine}」`;
    summary += '。';
    // 摘要是从群聊原文里摘的，emoji 很常见；裸 slice 会切出孤代理 ⇒ 落库/进提示词都成毒文本。
    if (summary.length > maxSummaryChars) summary = truncateText(summary, maxSummaryChars - 1) + '…';
    const importance = signals.importanceHint || scoreImportance({ facts, messages, events, participants });
    const keywords = [...new Set([...participants, ...topics, ...extractKeywords([summary], 4)])];
    stmts.upsert.run(String(key), String(day), participants.join('、'), JSON.stringify(topics), summary, mood, importance, JSON.stringify(keywords), now, now);
    log(`[long-memory] 固化 ${key} ${day}（${messages.length} 条消息，重要性 ${importance}）：${summary.slice(0, 60)}`);
    return { key, day, summary, importance };
  }

  /** 检索：来信关键词 × 时间衰减 × 重要性。返回注入文本（可能为空串）。 */
  function recall({ key, queryText, maxChars = 400, now = Date.now() }) {
    let rows = [];
    try { rows = stmts.all.all(String(key)).slice(0, 400); } catch { return ''; }
    if (!rows.length) return '';
    const s = String(queryText || '').replace(/\s+/g, ' ').trim();
    const qk = [];
    if (s) {
      for (const w of s.match(/[A-Za-z0-9_]{2,}/g) || []) if (!LM_STOP_WORDS.has(w.toLowerCase())) qk.push(w.toLowerCase());
      const cjk = s.replace(/[^\u4e00-\u9fa5]/g, ' ');
      outer: for (const seg of cjk.split(' ')) {
        for (let i = 0; i + 2 <= seg.length; i++) {
          const w = seg.slice(i, i + 2);
          if (!LM_STOP_WORDS.has(w) && !qk.includes(w)) qk.push(w);
          if (qk.length >= 6) break outer;
        }
      }
    }
    const todayMMdd = localDayString(0, now).slice(5);
    const scored = [];
    for (const row of rows) {
      const kw = keywordsOf(row);
      const topics = topicsOf(row);
      const hay = `${row.participants || ''}|${kw.join('|')}|${topics.join('|')}|${row.summary || ''}`.toLowerCase();
      let match = 0;
      for (const w of qk) if (hay.includes(w)) match += 1;
      for (const p of (row.participants || '').split('、')) {
        if (p && s && s.includes(p)) match += 2; // 来信里直接提到老熟人
      }
      if (match <= 0) continue;
      const decay = Math.pow(0.5, daysAgoOf(row.day, now) / 45);
      scored.push({ row, score: match * decay * (Number(row.importance) || 1) });
    }
    scored.sort((a, b) => b.score - a.score);
    const lines = [];
    let used = 0;
    for (const { row } of scored) {
      const label = `${agoLabel(row.day, now)}（${row.day.slice(5).replace('-', '月')}日）`;
      const line = `- ${label}${row.participants ? `和${row.participants}` : ''}：${row.summary}`;
      if (used + line.length + 1 > Math.max(80, maxChars)) break;
      lines.push(line);
      used += line.length + 1;
      try { stmts.bump.run(row.id); } catch { /* 命中计数失败不影响注入 */ }
      if (lines.length >= 3) break;
    }
    // [时间感知] 去年的今天：同 MM-DD 的旧 episode（哪怕没命中关键词也值得提）
    for (const row of rows) {
      if (row.day.slice(5) !== todayMMdd || daysAgoOf(row.day, now) < 300) continue;
      if (lines.some((l) => l.includes(row.day))) continue;
      const line = `- 去年的今天（${row.day}）：${row.summary}`;
      if (used + line.length + 1 > Math.max(80, maxChars) + 120) break; // 这段给一点额外预算
      lines.push(line);
      try { stmts.bump.run(row.id); } catch { /* */ }
      break;
    }
    if (!lines.length) return '';
    return `【很久以前】\n${lines.join('\n')}`;
  }

  function hasEpisode(key, day) {
    try { return !!stmts.allByKeyDay.get(String(key), String(day)); } catch { return false; }
  }

  // [记忆自检 2026-10-19] 随机抽一条该会话的旧情景，给她当「顺势求证记忆」的素材。
  function sampleEpisode(key) {
    try {
      const rows = stmts.all.all(String(key)).filter((r) => r && r.summary);
      if (!rows.length) return null;
      return rows[Math.floor(Math.random() * Math.min(rows.length, 10))];
    } catch { return null; }
  }

  function lastConsolidateDay() {
    try { return stmts.metaGet.get('lastConsolidateDay')?.v || ''; } catch { return ''; }
  }
  function setLastConsolidateDay(day) {
    try { stmts.metaSet.run('lastConsolidateDay', String(day)); } catch { /* */ }
  }

  /**
   * 遗忘：importance=1 的超过 keepDays 删、importance=2 的超过 keepDays*3 删、
   * importance=3（有约定/冲突）永不自动删。返回删除条数。
   */
  function prune({ keepDays = 120 } = {}) {
    const now = Date.now();
    let removed = 0;
    try {
      const r1 = stmts.pruneImp1.run(1, localDayString(keepDays, now));
      const r2 = stmts.pruneImp1.run(2, localDayString(keepDays * 3, now));
      removed = Number(r1?.changes || 0) + Number(r2?.changes || 0);
    } catch (error) {
      log('[long-memory] 清理失败', error?.message || error);
    }
    return removed;
  }

  function stats() {
    try {
      const r = stmts.stats.get() || {};
      return { episodes: Number(r.n) || 0, oldest: r.oldest || '', newest: r.newest || '' };
    } catch { return { episodes: 0, oldest: '', newest: '' }; }
  }

  function close() { try { db.close(); } catch { /* */ } }

  return { file, db, consolidateDay, recall, hasEpisode, sampleEpisode, lastConsolidateDay, setLastConsolidateDay, prune, stats, close };
}

export default createLongMemory;
