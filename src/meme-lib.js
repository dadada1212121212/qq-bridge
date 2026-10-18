// 表情包图库（本地，只读）——沿用 DSH 生态 / dsh-expression 的图库格式：
//   <root>/index.db               表 memes(path, tag, file_name, file_hash, caption, keywords, …)（含 FTS）
//   <root>/memes/<tag>/<file>     图片本体
// 图库根可用 config.socialV2.memes.root 覆盖；默认为 assets/memes/official-001
//（DSH 官方表情包1号，92 张，来源 anka-afk/astrbot-meme-pack-official-01）。
//
// 这里只做「查图 / 抽图 / 解析路径」三件事，发送由 bridge.js 负责（sendMemeV2）。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { truncateText } from './md-to-plain.js';

/** 6 个情绪桶 → 细分类 tag（与 dsh-expression 保持一致，换图库也通用）。 */
export const MEME_MOODS = {
  happy: ['happy', 'like', 'meow', 'givemoney', 'color'],
  angry: ['angry', 'fool', 'baka'],
  sad: ['sad', 'sigh'],
  shy: ['shy'],
  confused: ['confused', 'surprised', 'see'],
  daily: ['daily', 'sleep', 'morning', 'work', 'cpu', 'reply']
};

export const MEME_MOOD_DICT =
  'happy 开心(卖萌/可爱/喜欢) / angry 生气 / sad 难过(无语/求饶) / shy 害羞 / confused 困惑惊讶 / daily 日常(睡觉/上班/早上好)';

const MOOD_WORDS = {
  happy: '开心 高兴 兴奋 喜欢 卖萌 可爱 比心 哈哈 欢迎 好耶',
  angry: '生气 愤怒 暴躁 笨蛋 傻瓜 嫌弃 逮',
  sad: '难过 哭 委屈 叹气 无语 求饶 怂',
  shy: '害羞 腼腆 脸红',
  confused: '困惑 疑惑 惊讶 问号 懵',
  daily: '困 睡觉 晚安 早上好 打招呼 你好 上班 下班 摸鱼 工作 熬夜'
};

/** 单张表情最大字节数（超过就不发，避免把大图 base64 塞进 OneBot）。 */
export const MEME_MAX_BYTES = 8 * 1024 * 1024;

export function memeMoodNames() {
  return Object.keys(MEME_MOODS);
}

/**
 * [patch 表情包按语境配图] 从一段话里推断情绪（可能多个），给"该发哪类图"当提示。
 * 返回的 mood 名与 MEME_MOODS / MEME_MOOD_DICT 一致（happy/angry/sad/shy/confused/daily）。
 * 没有命中就返回 []——宁可让她自己判断，也不瞎猜一个情绪。
 */
export function detectMoodsFromText(text) {
  return moodsFromQuery(text);
}

function fineTagsFor(tag) {
  const t = String(tag || '').trim().toLowerCase();
  if (!t) return null;
  if (MEME_MOODS[t]) return MEME_MOODS[t];
  for (const fine of Object.values(MEME_MOODS)) {
    if (fine.includes(t)) return [t];
  }
  return [t];
}

function moodsFromQuery(text) {
  const hit = [];
  const t = String(text || '');
  for (const [mood, words] of Object.entries(MOOD_WORDS)) {
    if (words.split(/\s+/).some((w) => w && t.includes(w))) hit.push(mood);
  }
  return hit;
}

/** tag 优先；否则用 query 里的口语词推断情绪。返回 null 表示没识别出来。 */
export function resolveMemeMood(tag, query) {
  const t = String(tag || '').trim().toLowerCase();
  if (t) {
    if (MEME_MOODS[t]) return t;
    for (const [mood, fine] of Object.entries(MEME_MOODS)) {
      if (fine.includes(t)) return mood;
    }
  }
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  if (MEME_MOODS[q]) return q;
  return moodsFromQuery(q)[0] || null;
}

function pickRandom(rows, n) {
  const copy = rows.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy.slice(0, n);
}

function clip(s, n = 60) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  // [patch 代理对] 梗图描述会进提示词：用 truncateText，裸 slice 切出半个 emoji 会让投递 400。
  return t.length > n ? truncateText(t, n - 1) + '…' : t;
}

export class MemeStore {
  constructor(root) {
    this.root = path.resolve(String(root));
    const indexPath = path.join(this.root, 'index.db');
    if (!fs.existsSync(indexPath)) throw new Error('缺少表情包索引：' + indexPath);
    this.db = new DatabaseSync(indexPath, { readOnly: true });
    this._rows = null;
  }

  /** 全库行缓存（92~几百行量级，进程内缓存一份就够）。 */
  rows() {
    if (this._rows) return this._rows;
    this._rows = this.db
      .prepare("SELECT path, tag, file_name, caption, COALESCE(keywords, '') AS keywords FROM memes")
      .all();
    return this._rows;
  }

  total() {
    return this.rows().length;
  }

  /** tag 为情绪桶或细分类；query 只做 tag/caption/keywords 子串过滤。 */
  list(tag, query) {
    const rows = this.rows();
    const fine = fineTagsFor(tag);
    let memes = fine ? rows.filter((m) => fine.includes(m.tag)) : rows;
    const q = String(query || '').trim().toLowerCase();
    if (q) {
      const tokens = q.split(/\s+/).filter(Boolean);
      memes = memes.filter((m) => {
        const hay = (m.tag + ' ' + (m.caption ?? '') + ' ' + (m.keywords ?? '')).toLowerCase();
        return tokens.some((t) => hay.includes(t));
      });
    }
    return { memes, tags: memeMoodNames() };
  }

  /** 按情绪取池，随机抽 n 张（带 caption）给模型挑。 */
  sampleMood(tag, query, n = 8) {
    const mood = resolveMemeMood(tag, query);
    if (!mood) return { mood: null, memes: [], tags: memeMoodNames() };
    const { memes } = this.list(mood);
    return { mood, memes: pickRandom(memes, n), tags: memeMoodNames() };
  }

  /** 全库随机抽 n 张（没给情绪线索时用）。 */
  sampleAny(n = 8) {
    return pickRandom(this.rows(), n);
  }

  /** 把索引里的相对路径解析成绝对路径；不允许逃出图库根，文件必须存在。 */
  resolveStored(stored) {
    const rel = String(stored ?? '').trim();
    if (!rel) throw new Error('表情路径为空');
    const target = path.resolve(this.root, rel);
    if (target !== this.root && !target.startsWith(this.root + path.sep)) {
      throw new Error('表情路径超出图库目录');
    }
    if (!fs.existsSync(target)) throw new Error('表情文件不存在：' + rel);
    const st = fs.statSync(target);
    if (!st.isFile()) throw new Error('表情路径不是文件：' + rel);
    if (st.size > MEME_MAX_BYTES) throw new Error('表情文件过大（>' + Math.round(MEME_MAX_BYTES / 1048576) + 'MB）：' + rel);
    return target;
  }

  /** 绝对路径 → 图库相对路径（不在库里返回 null）。 */
  toStored(absPath) {
    const abs = path.resolve(String(absPath ?? ''));
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) return null;
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  /** 按 caption/keywords 模糊找图（给「把 [表情: 描述] 变成真图」的安全网用）。 */
  searchCaptions(text, limit = 3) {
    const q = String(text || '').trim().toLowerCase();
    if (!q) return [];
    const tokens = q.split(/[\s，,。.、!！?？~～]/).filter((t) => t.length >= 2);
    if (!tokens.length) return [];
    const scored = [];
    for (const m of this.rows()) {
      const hay = ((m.caption ?? '') + ' ' + (m.keywords ?? '')).toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (hay.includes(t)) score += t.length;
      }
      if (score > 0) scored.push({ row: m, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.row);
  }

  /** 给模型看的候选清单（不含图片本体，省 token）。 */
  formatCandidates(rows) {
    return rows.map((m, i) => {
      const tag = String(m.tag || '?');
      return (i + 1) + '. path=' + m.path + ' | [' + tag + '] ' + clip(m.caption || m.file_name, 70);
    });
  }
}
