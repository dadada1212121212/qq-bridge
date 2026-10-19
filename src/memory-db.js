// 蓝色大肥鱼的长期记忆库（SQLite）。
//
// 为什么要有它：桥接原本的记忆是「每个会话一份」的轻量 JSON（activeTopics /
// pendingThoughts / memberImpressions，见 bridge.js 的 formatMemoryV2），三个问题：
//   1. 只有印象、没有事实：她记不住「主人爱发 DeepSeek 二创表情包」这种可复述的东西；
//   2. 只有当下、没有时间线：会话轮换 / 重启后事件全丢，角色扮演因此显得"没有过去"；
//   3. 每个群、每个私聊各记一份：同一个人换到群里她就不认识了。
// 这个库把「人 / 事 / 梗 / 她自己的状态」存成跨会话的单一事实源，每次唤醒按当前
// 对话对象生成一段很短的摘要注入提示词（默认 <=800 字），让她记得住人、接得上旧话题。
//
// 设计约束（省 token 是硬要求）：
//   - 注入的摘要有硬上限，只挑当前对话相关的几个人 + 最近几条事实；
//   - 所有写入都是同步、幂等、无网络；写失败只记日志，绝不影响消息收发；
//   - 表结构演进靠 CREATE TABLE IF NOT EXISTS，坏了就跳过 DB 功能。

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ANIME_SEED, MEME_SEED } from './acg-seed.js';
import { CHIME_LEXICON } from './chime-seed.js';
import { truncateText } from './md-to-plain.js';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT \'user\', scope TEXT, nickname TEXT, aliases TEXT, relation TEXT, traits TEXT, note TEXT, msg_count INTEGER NOT NULL DEFAULT 0, self_sent INTEGER NOT NULL DEFAULT 0, first_seen INTEGER, last_seen INTEGER)',
  'CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, seq INTEGER, message_id TEXT, user_id TEXT, sender TEXT, is_self INTEGER NOT NULL DEFAULT 0, kind TEXT, text TEXT, at INTEGER, day TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_messages_key_at ON messages(key, at)',
  'CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, at)',
  'CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL DEFAULT \'global\', subject TEXT, text TEXT NOT NULL, tags TEXT, source TEXT, hits INTEGER NOT NULL DEFAULT 0, created_at INTEGER, updated_at INTEGER, UNIQUE(scope, subject, text))',
  'CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject, updated_at)',
  'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, key TEXT, kind TEXT, summary TEXT, participants TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_events_key_at ON events(key, at)',
  // [patch 日记] 她自己的小记（第一人称、按天归档）。刻意不复用 facts：facts 是"事实/印象"，
  // 日记是"她自己的口吻 + 时间线"，周报要按天/按周取；而 facts 有 UNIQUE(scope,subject,text)
  // 与 tags 混装，塞进去既会去重掉相似的日记，也会污染 digest 的"你记着的事"。
  'CREATE TABLE IF NOT EXISTS diary (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, day TEXT, key TEXT, scope TEXT, text TEXT NOT NULL, tags TEXT, source TEXT, mood TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_diary_at ON diary(at)',
  'CREATE INDEX IF NOT EXISTS idx_diary_day ON diary(day)',
  'CREATE TABLE IF NOT EXISTS lexicon (term TEXT PRIMARY KEY, meaning TEXT, usage TEXT, source TEXT, examples TEXT, variants TEXT, hits INTEGER NOT NULL DEFAULT 0, updated_at INTEGER)',
  'CREATE TABLE IF NOT EXISTS anime (title TEXT PRIMARY KEY, aliases TEXT, kind TEXT, tags TEXT, summary TEXT, moments TEXT, take TEXT, hits INTEGER NOT NULL DEFAULT 0, updated_at INTEGER)',
  'CREATE TABLE IF NOT EXISTS self_state (id INTEGER PRIMARY KEY CHECK (id = 1), day TEXT, bowls_today REAL DEFAULT 0, bowls_total REAL DEFAULT 0, turns_total INTEGER DEFAULT 0, last_meal_at INTEGER, mood TEXT)',
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
  // [patch 关系系统] 朋友档位 + 恋爱线。单独一张表而不是塞进 people：
  // people 是「客观档案」（谁、说过多少话、昵称），relations 是「她对某个人的主观关系」
  // （好感度、阶段、昵称、约定、共同回忆）。两者更新频率和读取方都不同，混在一起会让
  // people 的行被恋爱字段频繁重写，也让 people 的语义变糊。
  'CREATE TABLE IF NOT EXISTS relations (pid TEXT PRIMARY KEY, name TEXT, scope TEXT, love INTEGER NOT NULL DEFAULT 0, stage TEXT NOT NULL DEFAULT \'\', pet_name TEXT NOT NULL DEFAULT \'\', promise TEXT NOT NULL DEFAULT \'\', moments TEXT NOT NULL DEFAULT \'[]\', note TEXT NOT NULL DEFAULT \'\', up_count INTEGER NOT NULL DEFAULT 0, first_at INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL DEFAULT 0)'
];

const SEED_LEXICON = [
  ['鱼片', '她对群友的统一称呼（鱼的粉丝那种自称）', '谢谢鱼片～'],
  ['本鲸', '她自称（和"我"换着用）', '本鲸舍不得'],
  ['摸鱼外包', '把不想干的活推出去', '这活我早外包出去了'],
  ['吃token', '消耗上下文=吃饭；上下文塞满=吃撑了', '今天吃撑了'],
  ['草', '通用震惊/无语', '草'],
  ['乐', '觉得好笑但懒得解释', '乐'],
  ['典', '很典型的发言，带点嘲', '典'],
  ['急了', '对方急了，用来戳一下', '别急别急'],
  ['绷不住了', '忍不住笑了', '绷不住了'],
  ['awsl', '太可爱了，接不住了', 'awsl'],
  ['破防', '被戳到心里', '破防了'],
  ['贴贴', '亲密互动', '贴贴'],
  ['抽象', '看不懂但很离谱', '这也太抽象了'],
  ['开摆', '不想努力了', '本鲸开摆了'],
  ['yyds', '永远的神，用来极度推崇某人或某物', '这碗饭yyds', '拼音缩写，全网通用'],
  ['xswl', '笑死我了的拼音缩写', '这图xswl', 'B站和群聊常见'],
  ['润', 'run 的谐音，溜了、跑路或移民', '本鲸先润了', '也有润出去的说法'],
  ['op', '多义词，既指片头曲 opening，也指游戏里过强', '这首op好听', '看语境判断是哪个意思'],
  ['纯爱', '纯粹真挚的爱情题材，不掺杂质', '这是一部纯爱番', '对应日语「純愛」'],
  ['寄', 'GG 的谐音，表示完蛋、没救了', '这局直接寄', '由游戏圈扩散开来'],
  ['麻了', '麻木到无话可说', '一天改八版，本鲸麻了', '表示已经没脾气了'],
  ['唐', '网络上用来吐槽人言行离谱', '这话说得有点唐', '带冒犯性，对群友慎用'],
  ['退！退！退！', '驱赶霉运或拒绝某人，配挥手动作', '霉运退！退！退！', '来自短视频'],
  ['赢麻了', '一直赢，赢到麻木，多用于自嘲或反讽', '这波本鲸赢麻了', '反话居多'],
  ['双厨狂喜', '两个都喜欢的人看到联动时的狂喜', '这波联动，双厨狂喜', '厨指死忠粉'],
  ['现充', '现实生活过得很充实的人，常与宅相对', '周末约会的现充', '源自日语「リア充」'],
  ['中二病', '初中二年级式自我设定，觉得自己很特别', '本鲸的中二病又犯了', '源自日语'],
  ['傲娇', '嘴硬心软，明明在意却装作不在乎', '典型的傲娇发言', '源自日语「ツンデレ」'],
  ['病娇', '爱意极端到危险的类型', '这个角色是病娇', '源自日语「ヤンデレ」'],
  ['纸片人', '二次元里的虚拟角色', '本鲸只爱纸片人', '二次元圈子通用'],
  ['吃谷', '买周边商品，谷是 goods 的谐音', '这个月又吃谷了', '谷＝周边'],
  ['厨', '极度痴迷某个角色或作品的人', '本鲸是雷姆厨', '源自日语，略带调侃'],
  ['单推', '只支持一个角色或偶像', '本鲸单推一辈子', '推＝支持'],
  ['本命', '最喜欢的那个角色或作品', '这是本鲸的本命', '来自日语'],
  ['生草', '太好笑了，草得活了过来', '这段太生草了', '源自日语的「草」'],
  ['社死', '社会性死亡，公开丢脸到极点', '当众喊错名字，社死了', '中文互联网'],
  ['拉满', '做到极致、直接到顶', '情绪价值拉满', '常搭配属性词'],
  ['狗粮', '情侣秀恩爱，让单身的人吃醋', '又发狗粮了', '二次元圈子通用'],
  ['修罗场', '多人感情纠缠的尴尬场面', '现场一片修罗场', '源自日语'],
];

function dayOf(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function today() {
  return dayOf(Date.now());
}

// 桥接快照里私聊/群聊的 sender 常是「私聊」这类会话标签而不是人名（OneBot 私聊不给昵称）。
// 这类值绝不能当昵称写进 people，否则会把「纱雾酱最可爱了」冲成「私聊」。
const GENERIC_SENDER_LABELS = ['私聊', '群聊', '群消息', '群成员', '未知', 'unknown', 'anonymous', '系统', '某人', '我', '对方'];

function realNickname(value, fallbackId) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  if (GENERIC_SENDER_LABELS.includes(raw)) return '';
  if (/^(private|group|name):/.test(raw)) return '';
  if (String(fallbackId || '').trim() === raw) return '';
  return raw.slice(0, 40);
}

const TITLE_NOISE_RE = /^[\s《》「」『』【】（）()!！?？。.,，、~～…・·\-—_]+|[\s《》「」『』【】（）()!！?？。.,，、~～…・·\-—_]+$/g;

// 番剧标题在库里带装饰（《孤独摇滚！》《【我推的孩子】》），但用户打字常常没有 → 两种形态都拿来匹配。
function titleVariants(value) {
  const out = [];
  for (const part of String(value == null ? '' : value).split(',')) {
    const raw = part.trim();
    if (raw.length >= 2 && out.indexOf(raw) < 0) out.push(raw);
    const clean = raw.replace(TITLE_NOISE_RE, '').trim();
    if (clean.length >= 2 && out.indexOf(clean) < 0) out.push(clean);
  }
  return out;
}

function parseJsonArray(v) {
  try {
    const a = JSON.parse(String(v || '[]'));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

// 关系系统 · 朋友档位：只按互动句数分档，和好感度（恋爱线）是两个正交维度。
// 放在数据库模块里当纯函数导出，是为了让提示词渲染 / 角色卡 / 单测共用同一口径，
// 不必为了分档去起一个 DB。
export function friendTier(msgCount) {
  const n = Number(msgCount);
  // 非数字、负数、Infinity 一律当 0 ⇒ 陌生人，绝不因为脏数据落到更高的档位。
  const c = Number.isFinite(n) && n > 0 ? n : 0;
  if (c < 3) return '陌生人';
  if (c < 15) return '眼熟';
  if (c < 50) return '熟人';
  if (c < 150) return '朋友';
  if (c < 400) return '好朋友';
  return '自己人';
}

// 关系系统 · 恋爱阶段名：把 0-100 的好感度翻成人话。
// 超界按 100、非数字按 0 处理，保证调用方拿到的一定是合法档位而不是 undefined。
export function loveStageName(love) {
  const raw = Number(love);
  const n = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
  if (n < 10) return '刚认识';
  if (n < 25) return '有点在意';
  if (n < 45) return '有点喜欢';
  if (n < 65) return '很喜欢';
  if (n < 80) return '心动';
  if (n < 95) return '暧昧期';
  return '在一起了';
}

// 显式「忘掉这个」的说法：调用方想说清空时用它们比逼它传空串自然。
// 比较时统一小写，让 none / NONE / None 等价。
const RELATION_CLEAR_WORDS = ['无', '没有', '清除', '清空', '-', 'none'];

function clampLove(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

// 单次好感度变化上限 ±10：一次对话再怎么甜也不该一步从陌生人跳到在一起。
function clampLoveDelta(value) {
  const n = Math.round(Number(value) || 0);
  return Math.max(-10, Math.min(10, n));
}

// name / scope 这类「有就换、没有就留」的文本：空 / undefined 保留原值。
// max<=0 表示不截断。
function pickText(value, oldValue, max) {
  const s = value == null ? '' : String(value).trim();
  if (!s) return oldValue == null ? '' : String(oldValue);
  return max > 0 ? truncateText(s, max) : s;
}

// stage / petName / promise / note：undefined / null / 空串不动，显式清除词置空，其它覆盖。
function pickClearable(value, oldValue, max) {
  if (value == null) return oldValue == null ? '' : String(oldValue);
  const s = String(value).trim();
  if (!s) return oldValue == null ? '' : String(oldValue);
  if (RELATION_CLEAR_WORDS.indexOf(s.toLowerCase()) >= 0) return '';
  return truncateText(s, max);
}

// ── [patch 口癖画像 / 情绪事件] ─────────────────────────────────────────────
// 为什么要有口癖画像：提示词里"像不像她"原来全靠模型自由发挥，而她的历史自发消息里
// 其实有很硬的个人特征（爱用词、句尾收束）。这里抽成**结构化数据**（top/tails/avgLen/count）
// 而不是成品句子——拼句子是提示词层的事，特征抽取留在 DB 层，两边以后各改各的。
// 情绪事件复用 events 表（kind = "mood:<mood>"）：为它单开一张表要迁移，而前缀足够区分，
// 也不影响 recordEvent / listEventsSince 的既有语义。

/** 情绪白名单：和 noteMood 的自由文本不同，情绪事件必须可枚举、可按 mood 精确过滤。 */
const MOOD_KINDS = ['happy', 'excited', 'calm', 'tired', 'sleepy', 'sad', 'annoyed'];

/** 口癖停用词表：这些词人人都用，出现条数再高也说明不了"她的口癖"。
 *  显式写在代码里而不是从语料统计，是为了让画像结果可解释、可复现（想调画像口味就改这里）。 */
const STYLE_STOP_WORDS = new Set([
  '什么', '这样', '这个', '那个', '现在', '时候', '因为', '所以', '但是', '如果',
  '可以', '我们', '你们', '他们', '自己', '一下', '一个', '不是', '没有', '就是',
  '真的', '已经', '应该', '还是', '这么', '怎么', '然后', '其实', '可能', '只是',
  '还有', '不过'
]);

/** 口癖子串的黑名单：空白 / 英文标点 / 这些中文标点。子串只要命中一个字符就整条作废。 */
const STYLE_BAD_CHARS = ' \t\r\n!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~，。！？、；：…—～·「」『』【】《》（）〈〉“”‘’';
const STYLE_BAD_CHAR_SET = new Set(STYLE_BAD_CHARS.split(''));

/** 句尾标点：末字命中它就往前多取一字，让"啊。""呀～"这类语气收尾也能进统计。 */
const STYLE_TAIL_PUNCT = '。！？…～，、；：!?.,;:~';

/** 只认 CJK 汉字（扩展A / 基本区 / 兼容表意）。 */
function isPlainHanChar(ch) {
  const code = ch.codePointAt(0);
  return (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff);
}

// 口癖子串的「普通汉字」判据 = 黑名单 + 汉字白名单两道。只靠黑名单会漏掉全角字母、
// 颜文字、Emoji 这些"不是标点的噪声"，那会把「awa」「😭😭」当成口癖抽出来；
// 白名单把它们一并挡掉（代理对 codePointAt 不落进汉字区，也自动被拒）。
function isStyleFragment(s) {
  for (const ch of s) {
    if (STYLE_BAD_CHAR_SET.has(ch)) return false;
    if (ch >= '0' && ch <= '9') return false;
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) return false;
    if (!isPlainHanChar(ch)) return false;
  }
  return true;
}

// 她自己的消息写入代数：styleProfile 的缓存靠它失效（写成功一次 +1）。
// 放模块作用域而不是每个 DB 实例一份：它只是"表内容变了"的信号，别的实例多 bump 一次
// 最多让缓存多扫一次表，不会返回错数据。
let styleMsgGen = 0;

export function createMemoryDb({ file, tokenUsageFile = '', log = () => {}, maxFactChars = 120, maxDiaryChars = 300 } = {}) {
  if (!file) throw new Error('memory-db needs file');
  fs.mkdirSync(file.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 4000');
  for (const sql of SCHEMA) db.exec(sql);
  try {
    db.prepare('INSERT OR IGNORE INTO self_state (id, day, mood) VALUES (1, ?, ?)').run(today(), '正常');
  } catch (error) {
    log('self_state init failed', error?.message || error);
  }
  for (const sql of ['ALTER TABLE lexicon ADD COLUMN source TEXT', 'ALTER TABLE lexicon ADD COLUMN examples TEXT', 'ALTER TABLE lexicon ADD COLUMN variants TEXT']) {
    try {
      db.exec(sql);
    } catch {
      /* 列已存在 */
    }
  }
  // 梗库 / 动漫库种子：内容按种子覆盖（保留 hits），方便以后改种子文案后自动同步。
  const seedLex = db.prepare('INSERT INTO lexicon (term, meaning, usage, source, examples, variants, hits, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT(term) DO UPDATE SET meaning = excluded.meaning, usage = excluded.usage, source = excluded.source, variants = excluded.variants');
  const now0 = Date.now();
  for (const item of SEED_LEXICON) seedLex.run(item[0], item[1], item[2], '角色设定', item[2], '', now0);
  for (const item of MEME_SEED) seedLex.run(item[0], item[1], item[3], item[2], '', item[4], now0);
  // chime 中文网络梗词典（MIT）：[梗, 含义, 例句, 出处] → 只按需检索注入，不整表进 prompt。
  for (const item of CHIME_LEXICON) seedLex.run(item[0], item[1], item[2], 'chime', item[2], item[3], now0);
  const seedAnime = db.prepare('INSERT INTO anime (title, aliases, kind, tags, summary, moments, take, hits, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT(title) DO UPDATE SET aliases = excluded.aliases, kind = excluded.kind, tags = excluded.tags, summary = excluded.summary, moments = excluded.moments, take = excluded.take');
  for (const a of ANIME_SEED) seedAnime.run(a[0], a[1], a[2], a[3], a[4], a[5], a[6], now0);

  let riceCache = null;
  let riceReadAt = 0;

  function syncRice(force = false) {
    if (!tokenUsageFile) return null;
    try {
      const s = fs.statSync(tokenUsageFile);
      const stamp = s.size + ':' + s.mtimeMs;
      if (!force && riceCache && riceCache.stamp === stamp) return riceCache;
      // [省 CPU] token-usage.jsonl 每轮都在追加，stamp 必然变 ⇒ 旧实现每轮都全量 parse 683KB
      // （实测 8.2ms；每窗口 800+ 次 buildDigest ≈ 7s 纯 CPU，而且全卡在主线程上）。
      // 体重这个梗变化极慢，30 秒重算一次足够。
      if (!force && riceCache && Date.now() - riceReadAt < 30000) return riceCache;
      const text = fs.readFileSync(tokenUsageFile, 'utf8');
      const todayStr = today();
      let total = 0;
      let todayTokens = 0;
      let turns = 0;
      for (const line of text.split('\n')) {
        if (!line) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        const b = o && o.b;
        if (!b) continue;
        const n = Number(b.cacheMiss || 0) + Number(b.cacheHit || 0) + Number(b.cacheWrite || 0) + Number(b.output || 0) + Number(b.reasoning || 0);
        total += n;
        if (o.k === 'turn' && o.step === 1) turns += 1;
        if (o.k === 'turn' && dayOf(o.t) === todayStr) todayTokens += n;
      }
      riceCache = { stamp, total, todayTokens, bowlsTotal: total / 1000000, bowlsToday: todayTokens / 1000000, turnsTotal: turns };
      riceReadAt = Date.now();
      if (force) {
        db.prepare('UPDATE self_state SET day = ?, bowls_today = ?, bowls_total = ?, turns_total = ? WHERE id = 1')
          .run(todayStr, riceCache.bowlsToday, riceCache.bowlsTotal, riceCache.turnsTotal);
      }
      return riceCache;
    } catch (error) {
      log('rice stats failed', error?.message || error);
      return null;
    }
  }

  function ensurePerson(id, kind, scope, nickname, relation) {
    const pid = String(id || '').trim();
    if (!pid || ['__proto__', 'constructor', 'prototype'].includes(pid)) return null;
    const now = Date.now();
    const nick = realNickname(nickname, pid);
    const existing = db.prepare('SELECT id FROM people WHERE id = ?').get(pid);
    if (!existing) {
      db.prepare('INSERT INTO people (id, kind, scope, nickname, aliases, relation, traits, note, msg_count, self_sent, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)')
        .run(pid, kind || 'user', scope || null, nick || pid, '[]', relation || (kind === 'group' ? '群' : '群友'), '[]', '', now, now);
    } else {
      const sets = ['last_seen = ?'];
      const args = [now];
      if (nick) { sets.push('nickname = ?'); args.push(nick); }
      if (relation) { sets.push('relation = ?'); args.push(relation); }
      args.push(pid);
      const upd = db.prepare('UPDATE people SET ' + sets.join(', ') + ' WHERE id = ?');
      upd.run(...args);
    }
    return pid;
  }

  function bumpPerson(pid, opts) {
    const o = opts || {};
    if (!pid) return;
    try {
      if (o.alias) {
        const row = db.prepare('SELECT aliases FROM people WHERE id = ?').get(pid);
        const list = parseJsonArray(row && row.aliases);
        const name = String(o.alias).slice(0, 40);
        if (name && list.indexOf(name) < 0) {
          list.push(name);
          db.prepare('UPDATE people SET aliases = ? WHERE id = ?').run(JSON.stringify(list.slice(-8)), pid);
        }
      }
      db.prepare('UPDATE people SET msg_count = msg_count + ?, self_sent = self_sent + ?, last_seen = ? WHERE id = ?')
        .run(Number(o.addMsg) || 0, Number(o.addSelf) || 0, Date.now(), pid);
    } catch (error) {
      log('bumpPerson failed', error?.message || error);
    }
  }

  // 同一个人在「只有昵称」和「有 QQ 号」两种记录之间做合并：只在同一个会话里合并，
  // 避免把不同群重名的人搅在一起。合并后消息的 user_id 也一起改指过去。
  function mergePerson(toId, fromId) {
    if (!toId || !fromId || toId === fromId) return;
    try {
      const from = db.prepare('SELECT * FROM people WHERE id = ?').get(fromId);
      if (!from) return;
      const to = ensurePerson(toId, from.kind || 'user', from.scope, from.nickname, from.relation);
      const cur = db.prepare('SELECT * FROM people WHERE id = ?').get(to);
      if (!cur) return;
      const traits = [];
      for (const x of parseJsonArray(cur.traits).concat(parseJsonArray(from.traits))) if (traits.indexOf(x) < 0) traits.push(x);
      const aliases = [];
      for (const x of parseJsonArray(cur.aliases).concat(parseJsonArray(from.aliases)).concat([from.nickname])) if (x && aliases.indexOf(x) < 0) aliases.push(x);
      const note = [cur.note, from.note].filter(Boolean).join('；').slice(-600);
      const firstSeen = Number(from.first_seen) || Date.now();
      db.prepare('UPDATE people SET traits = ?, note = ?, aliases = ?, msg_count = msg_count + ?, self_sent = self_sent + ?, first_seen = CASE WHEN first_seen IS NULL OR first_seen > ? THEN ? ELSE first_seen END WHERE id = ?')
        .run(JSON.stringify(traits.slice(-10)), note, JSON.stringify(aliases.slice(-8)), Number(from.msg_count) || 0, Number(from.self_sent) || 0, firstSeen, firstSeen, to);
      db.prepare('UPDATE messages SET user_id = ? WHERE user_id = ?').run(to, fromId);
      db.prepare('DELETE FROM people WHERE id = ?').run(fromId);
    } catch (error) {
      log('mergePerson failed', error?.message || error);
    }
  }

  function recordMessage(key, msg) {
    if (!key || !msg || msg.isSelf) return;
    try {
      const uid = msg.userId ? String(msg.userId) : '';
      const senderName = realNickname(msg.sender, uid) || '未知';
      const pid = uid || ('name:' + senderName);
      const relation = msg.isOwner ? '主人（管理员）' : '群友';
      ensurePerson(pid, 'user', key, senderName, relation);
      if (uid) {
        const nameId = 'name:' + senderName;
        const stray = db.prepare('SELECT scope FROM people WHERE id = ?').get(nameId);
        if (stray && stray.scope === key) mergePerson(pid, nameId);
      }
      bumpPerson(pid, { addMsg: 1, alias: realNickname(msg.sender, uid) });
      if (key.indexOf('group:') === 0) {
        ensurePerson(key, 'group', key, null, '群');
        bumpPerson(key, { addMsg: 1 });
      }
      const text = String(msg.text != null ? msg.text : (msg.plain || '')).slice(0, 400);
      const at = Number(msg.time) || Date.now();
      const dup = db.prepare('SELECT id FROM messages WHERE key = ? AND is_self = 0 AND text = ? AND at = ?').get(key, text, at);
      if (dup) return;
      db.prepare('INSERT INTO messages (key, seq, message_id, user_id, sender, is_self, kind, text, at, day) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)')
        .run(key, Number(msg.seq) || null, msg.messageId ? String(msg.messageId) : null, uid || null, String(msg.sender || '').slice(0, 40), String(msg.kind || 'text'), text, at, dayOf(at));
    } catch (error) {
      log('recordMessage failed', error?.message || error);
    }
  }

  function recordSelfMessages(key, texts, at) {
    if (!key) return;
    try {
      const list = Array.isArray(texts) ? texts : [texts];
      const now = Number(at) || Date.now();
      let n = 0;
      for (let i = 0; i < list.length; i++) {
        const text = String(list[i] == null ? '' : list[i]).slice(0, 400);
        if (!text) continue;
        const at = now + i * 1000;
        const dup = db.prepare('SELECT id FROM messages WHERE key = ? AND is_self = 1 AND text = ? AND at = ?').get(key, text, at);
        if (dup) continue;
        n += 1;
        db.prepare('INSERT INTO messages (key, seq, message_id, user_id, sender, is_self, kind, text, at, day) VALUES (?, NULL, NULL, NULL, ?, 1, ?, ?, ?, ?)')
          .run(key, '我', 'text', text, at, dayOf(at));
      }
      // [口癖画像] 有真实写入才让画像缓存失效：整批都是重复消息时数据没变，缓存继续用。
      if (n > 0) styleMsgGen += 1;
      if (key.indexOf('group:') === 0) {
        ensurePerson(key, 'group', key, null, '群');
        bumpPerson(key, { addSelf: n });
      }
      for (const one of list) bumpInterestsFromSelf(String(one == null ? '' : one));
    } catch (error) {
      log('recordSelfMessages failed', error?.message || error);
    }
  }

  function recordFact(opts) {
    const o = opts || {};
    // [patch 代理对] 这些文本会进提示词、也会落库：一律用 truncateText，绝不切开 emoji 代理对
    // （裸 slice 切出的半个 emoji 会让投递请求 400，还会被存进会话帧反复复发）。
    const body = truncateText(String(o.text || '').trim(), maxFactChars);
    if (!body) return null;
    try {
      const now = Date.now();
      const scope = String(o.scope || 'global');
      const subject = String(o.subject || '');
      const existing = db.prepare('SELECT id FROM facts WHERE scope = ? AND subject = ? AND text = ?').get(scope, subject, body);
      if (existing) {
        if (!o.onlyIfNew) db.prepare('UPDATE facts SET updated_at = ?, hits = hits + 1 WHERE id = ?').run(now, existing.id);
        return existing.id;
      }
      const stmt = db.prepare('INSERT INTO facts (scope, subject, text, tags, source, hits, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)');
      const r = stmt.run(scope, subject, body, String(o.tags || ''), String(o.source || 'bridge'), now, now);
      return r.lastInsertRowid;
    } catch (error) {
      log('recordFact failed', error?.message || error);
      return null;
    }
  }

  function rememberImpression(target, text, countOnly, personId) {
    const name = String(target || '').trim();
    if (!name) return;
    try {
      // personId：调用方已经知道这是谁（例如「主人」折回 ownerQQ）时直接用它，
      // 省掉昵称猜测，也避免再长出 name: 开头的僵尸 people 行。
      const explicit = String(personId || '').trim();
      const pid = explicit || ('name:' + name.slice(0, 40));
      let row = db.prepare('SELECT id, traits FROM people WHERE id = ?').get(pid);
      if (!row && !explicit) row = db.prepare('SELECT id, traits FROM people WHERE nickname = ? LIMIT 1').get(name.slice(0, 40));
      const id = (row && row.id) || ensurePerson(pid, 'user', null, name.slice(0, 40), explicit ? '主人' : '群友');
      if (!id) return;
      const traits = parseJsonArray(row && row.traits);
      const t = truncateText(String(text || '').trim(), maxFactChars);
      if (t && !countOnly && traits.indexOf(t) < 0) traits.push(t);
      db.prepare('UPDATE people SET traits = ?, last_seen = ? WHERE id = ?').run(JSON.stringify(traits.slice(-10)), Date.now(), id);
      if (t) recordFact({ scope: 'person', subject: id, text: t, tags: 'impression', source: 'self', onlyIfNew: true });
    } catch (error) {
      log('rememberImpression failed', error?.message || error);
    }
  }

  function recordEvent(opts) {
    const o = opts || {};
    const body = String(o.summary || '').trim().slice(0, 200);
    if (!body) return null;
    try {
      const r = db.prepare('INSERT INTO events (at, key, kind, summary, participants) VALUES (?, ?, ?, ?, ?)')
        .run(Date.now(), String(o.key || ''), String(o.kind || 'note'), body, JSON.stringify(Array.isArray(o.participants) ? o.participants.slice(0, 6) : []));
      db.prepare('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY at DESC LIMIT 500)').run();
      return r.lastInsertRowid;
    } catch (error) {
      log('recordEvent failed', error?.message || error);
      return null;
    }
  }

  function recordTopic(text, participants) {
    recordFact({ scope: 'topic', subject: '', text, tags: 'topic', source: 'self' });
    if (participants && participants.length) recordEvent({ kind: 'topic', summary: String(text || '').slice(0, 120), participants });
  }

  // ── [长记忆 2026-10-18] 自动提炼 / 定期整理 / 相关性检索 ─────────────────────
  //
  // 为什么需要这三件：库里 8052 条消息只长出 24 条 facts，而且几乎全是她手动调工具写进去的
  // —— 也就是说「长期记忆」实际靠她现场想不起来时的自觉，聊得越多越不记得。
  // 这里补上闭环：每轮从新消息里**规则式**提炼候选事实（不花任何模型调用），
  // 每天合并去重/清理过期，注入时按当前话题做相关性排序。
  //
  // 刻意不做的事：不调 LLM 总结（每轮多一次模型调用 = 钱和延迟），只用正则 + 去重 + 时间衰减；
  // 提炼错一条的代价只是提示词里多一句废话，而漏记的代价是她当场失忆。
  const FACT_RULES = [
    // 自我介绍 / 身份：这些一旦说了基本长期有效
    { re: /(?:我叫|我是|我是做|我在|我住|我来自|我今年|我生日|我姓)([^。！？!?\n]{1,40})/, tag: 'identity', scope: 'person' },
    // 喜好：吃什么、玩什么、讨厌什么
    { re: /(?:我喜欢|我超喜欢|我最喜欢|我爱吃|我爱玩|我讨厌|我不喜欢|我受不了|我看不下去)([^。！？!?\n]{1,40})/, tag: 'preference', scope: 'person' },
    // 作息 / 习惯
    { re: /(?:我一般|我每天|我通常|我习惯|我老是)([^。！？!?\n]{1,40})/, tag: 'habit', scope: 'person' },
    // 约定 / 承诺 / 待办：跨天要记得的那种
    { re: /(?:说好|答应|约好|改天|下次|明天|记得)([^。！？!?\n]{1,40})/, tag: 'promise', scope: 'topic' },
  ];
  const LEARN_MAX_PER_CALL = 4;

  /**
   * 从一批消息里规则式提炼事实并入库（幂等：同一条文本重复出现只加 hits）。
   *
   * @param {{sender?:string,userId?:string,text?:string,plain?:string,isSelf?:boolean,time?:number}[]} list
   * @param {{key?:string,maxPerCall?:number}} [opts]
   * @returns {number} 新写入条数
   */
  function learnFacts(list, opts) {
    const o = opts || {};
    const cap = Math.max(1, Number(o.maxPerCall) || LEARN_MAX_PER_CALL);
    const key = String(o.key || '');
    let wrote = 0;
    try {
      const items = Array.isArray(list) ? list : [];
      const seen = new Set();
      for (const m of items) {
        if (!m || m.isSelf) continue;
        const raw = String(m.text != null ? m.text : (m.plain || '')).trim();
        if (!raw || raw.length < 4 || raw.length > 200) continue;
        for (const rule of FACT_RULES) {
          const hit = rule.re.exec(raw);
          if (!hit) continue;
          // 句子裁剪：只留命中短语所在的那一小段，别把整段聊天塞进记忆
          const tail = String(hit[0]).replace(/\s+/g, ' ').trim();
          if (tail.length < 3) continue;
          const pid = m.userId ? String(m.userId) : '';
          const subject = rule.scope === 'person'
            ? (pid || 'name:' + String(m.sender || '').slice(0, 40))
            : key;
          if (!subject) continue;
          const text = truncateText(tail, maxFactChars);
          const k = subject + '\u0000' + text;
          if (seen.has(k)) continue;
          seen.add(k);
          const who = String(m.sender || pid || '').slice(0, 20);
          const body = rule.scope === 'person' ? who + '：' + text : text;
          // 已经记过同一条 → 只把 hits +1（说明这条事实反复被提到，更该留着），
          // 不算「新写入」，否则日志和返回值会把重复当成功。
          const dup = db.prepare('SELECT id FROM facts WHERE scope = ? AND subject = ? AND text = ?').get(rule.scope, subject, truncateText(body, maxFactChars));
          if (dup) {
            try { db.prepare('UPDATE facts SET hits = hits + 1, updated_at = ? WHERE id = ?').run(Date.now(), dup.id); } catch { /* 忽略 */ }
            continue;
          }
          const id = recordFact({
            scope: rule.scope,
            subject,
            text: body,
            tags: 'auto,' + rule.tag,
            source: 'auto',
            onlyIfNew: true,
          });
          if (id != null) wrote += 1;
          if (wrote >= cap) return wrote;
        }
      }
      return wrote;
    } catch (error) {
      log('learnFacts failed', error?.message || error);
      return wrote;
    }
  }

  const normFact = (text) => String(text || '')
    .replace(/^[^：:]{1,20}[：:]/, '')          // 去掉「昵称：」前缀再比
    .replace(/[\s，。,.!！?？~～、'"“”‘’]/g, '')
    .toLowerCase();

  /**
   * 定期整理：同一主体下近似重复的事实合并（留新的）、清掉久未命中的自动事实、
   * 每个主体最多留 maxPerSubject 条。纯本地、幂等、可反复跑。
   *
   * @param {{maxAgeDays?:number,maxPerSubject?:number}} [opts]
   * @returns {{merged:number,expired:number,trimmed:number}}
   */
  function consolidateFacts(opts) {
    const o = opts || {};
    const maxAgeDays = Math.max(1, Number(o.maxAgeDays) || 120);
    const maxPerSubject = Math.max(3, Number(o.maxPerSubject) || 10);
    const out = { merged: 0, expired: 0, trimmed: 0 };
    try {
      const rows = db.prepare('SELECT id, scope, subject, text, updated_at, hits FROM facts ORDER BY updated_at DESC').all();
      const bySubject = new Map();
      for (const r of rows) {
        const k = r.scope + '\u0000' + r.subject;
        const arr = bySubject.get(k) || [];
        arr.push(r);
        bySubject.set(k, arr);
      }
      const del = db.prepare('DELETE FROM facts WHERE id = ?');
      const cutoff = Date.now() - maxAgeDays * 86400000;
      for (const [, arr] of bySubject) {
        // 1) 近似重复：规范化后互相包含 → 留 updated_at 更新的那条
        const kept = [];
        for (const r of arr) {
          const n = normFact(r.text);
          const dupe = kept.find((x) => {
            const xm = normFact(x.text);
            return n && xm && (xm === n || xm.includes(n) || n.includes(xm));
          });
          if (dupe) {
            del.run(Number(r.id));
            out.merged += 1;
            continue;
          }
          kept.push(r);
        }
        // 2) 过期：自动提炼的、且从未再被提到、且很久没更新 → 删
        for (const r of kept) {
          if (Number(r.updated_at) >= cutoff || Number(r.hits) > 0) continue;
          if (String(r.tags || '').indexOf('auto') < 0) continue;
          del.run(Number(r.id));
          out.expired += 1;
        }
        // 3) 每个主体限量（按 updated_at DESC 已排好）
        const live = kept.filter((r) => Number(r.updated_at) >= cutoff || Number(r.hits) > 0);
        for (const r of live.slice(maxPerSubject)) {
          del.run(Number(r.id));
          out.trimmed += 1;
        }
      }
      return out;
    } catch (error) {
      log('consolidateFacts failed', error?.message || error);
      return out;
    }
  }

  /** 事实与当前话题的词面相关度（中文按 2 字滑窗 + 英文词），用于注入排序。 */
  function factScore(text, tokens) {
    if (!tokens || !tokens.size) return 0;
    const t = String(text || '').toLowerCase();
    let s = 0;
    for (const tk of tokens) if (tk && t.indexOf(tk) >= 0) s += tk.length >= 2 ? 2 : 1;
    return s;
  }

  function setPerson(opts) {
    const o = opts || {};
    const pid = ensurePerson(o.id, 'user', null, o.nickname || null, o.relation || null);
    if (!pid) return null;
    try {
      if (o.note) {
        const row = db.prepare('SELECT note FROM people WHERE id = ?').get(pid);
        const old = String((row && row.note) || '');
        const add = String(o.note).slice(0, 200);
        if (add && old.indexOf(add) < 0) {
          const merged = [old, add].filter(Boolean).join('；').slice(-600);
          db.prepare('UPDATE people SET note = ? WHERE id = ?').run(merged, pid);
        }
      }
    } catch (error) {
      log('setPerson note failed', error?.message || error);
    }
    return pid;
  }

  function addLexicon(term, meaning, usage, extra) {
    const t = String(term || '').trim().slice(0, 20);
    if (!t) return null;
    const ex = extra && typeof extra === 'object' ? extra : {};
    try {
      db.prepare('INSERT INTO lexicon (term, meaning, usage, source, examples, variants, hits, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT(term) DO UPDATE SET meaning = excluded.meaning, usage = excluded.usage, source = excluded.source, examples = excluded.examples, variants = excluded.variants, updated_at = excluded.updated_at')
        .run(t, String(meaning || '').slice(0, 120), String(usage || '').slice(0, 120), String(ex.source || '').slice(0, 80), String(ex.examples || '').slice(0, 160), String(ex.variants || '').slice(0, 80), Date.now());
      dictGen += 1;   // 词表快照立刻失效
      return t;
    } catch (error) {
      log('addLexicon failed', error?.message || error);
      return null;
    }
  }

  function noteMood(mood) {
    try {
      db.prepare('UPDATE self_state SET mood = ? WHERE id = 1').run(String(mood || '正常').slice(0, 20));
    } catch (error) {
      log('noteMood failed', error?.message || error);
    }
  }

  // [省 CPU] 词表快照。matchInterests / bumpInterestsFromSelf 每轮都要扫 lexicon(1400+) 和
  // anime(100+)，而每次 db.prepare(...).all() 都把整表物化一遍（实测 3.7~19ms，每轮两次）。
  // 词表内容几乎不变（hits 会变，但排序滞后几分钟没关系），所以缓存 5 分钟；
  // addLexicon / addAnime 一写就让缓存失效，新梗立刻可用。
  let lexSnapshot = null;
  let animeSnapshot = null;
  let dictGen = 0;
  const DICT_TTL_MS = 5 * 60 * 1000;
  const snapshotStale = (s) => !s || s.gen !== dictGen || Date.now() - s.at > DICT_TTL_MS;
  function lexiconRows() {
    if (snapshotStale(lexSnapshot)) {
      lexSnapshot = { gen: dictGen, at: Date.now(), rows: db.prepare('SELECT term, meaning, usage FROM lexicon WHERE length(term) >= 2 ORDER BY hits DESC, length(term) DESC').all() };
    }
    return lexSnapshot.rows;
  }
  function animeRows() {
    if (snapshotStale(animeSnapshot)) {
      animeSnapshot = { gen: dictGen, at: Date.now(), rows: db.prepare('SELECT title, aliases, kind, tags, summary, moments, take FROM anime').all() };
    }
    return animeSnapshot.rows;
  }
  function animeTermRows() {
    animeRows();
    if (!animeSnapshot.terms) {
      animeSnapshot.terms = animeSnapshot.rows.map((a) => ({ title: a.title, terms: titleVariants(String(a.title || '') + ',' + String(a.aliases || '')) }));
    }
    return animeSnapshot.terms;
  }

  // [省 CPU] hits 只是「哪些梗更常用」的排序依据，不值得为它每轮都在主线程同步写库：
  // node:sqlite 单条 UPDATE 实测 2~4ms（WAL + synchronous=FULL），一次唤醒命中两个梗就是 8ms，
  // 而她每次自发消息还会再扫一遍（544 条 × 2.3~19ms）。现在只记在内存里，
  // 攒够 20 条或过 20 秒才用一个事务刷一次；close() 前也会刷。
  const pendingHits = new Map();
  let hitFlushAt = 0;
  function bumpHits(table, key) {
    if (!key) return;
    const k = table + ':' + String(key);
    pendingHits.set(k, (pendingHits.get(k) || 0) + 1);
    if (pendingHits.size >= 20 || Date.now() - hitFlushAt > 20000) flushHits();
  }
  function flushHits() {
    hitFlushAt = Date.now();
    if (!pendingHits.size) return;
    try {
      db.exec('BEGIN');
      try {
        for (const [k, n] of pendingHits) {
          const i = k.indexOf(':');
          const table = k.slice(0, i);
          const term = k.slice(i + 1);
          if (table === 'lexicon') db.prepare('UPDATE lexicon SET hits = hits + ?, updated_at = ? WHERE term = ?').run(n, Date.now(), term);
          else db.prepare('UPDATE anime SET hits = hits + ?, updated_at = ? WHERE title = ?').run(n, Date.now(), term);
        }
        db.exec('COMMIT');
        pendingHits.clear();
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      log('flushHits failed', error?.message || error);
    }
  }

  // 从一段聊天文本里找「她库里有、且对方提到了」的番和梗。
  function matchInterests(text, opts) {
    const o = opts || {};
    const t = String(text || '');
    const found = { anime: [], memes: [] };
    if (!t) return found;
    try {
      const maxAnime = Number(o.maxAnime) || 2;
      const maxMeme = Number(o.maxMeme) || 3;
      for (const r of animeRows()) {
        const terms = titleVariants(String(r.title || '') + ',' + String(r.aliases || ''));
        if (terms.some((x) => t.indexOf(x) >= 0)) {
          found.anime.push(r);
          bumpHits('anime', r.title);
          if (found.anime.length >= maxAnime) break;
        }
      }
      // 全库扫（不设 LIMIT）：早先写死 LIMIT 600 + 按 hits/长度排序，而冷库里几乎全是 0 命中，
      // 排序就完全由 term 长度决定 ⇒ 1400 多条里只有最长的 600 条**永远有机会**被匹配到，短梗根本进不来。
      for (const l of lexiconRows()) {
        if (t.indexOf(String(l.term)) >= 0) {
          found.memes.push(l);
          bumpHits('lexicon', l.term);
          if (found.memes.length >= maxMeme) break;
        }
      }
    } catch (error) {
      log('matchInterests failed', error?.message || error);
    }
    return found;
  }

  // 她自己在聊天里用了某个梗/聊到某部番 → hits++，梗库按她的真实用法排序。
  function bumpInterestsFromSelf(text) {
    const t = String(text || '');
    if (!t) return;
    try {
      // 同上：不设 LIMIT，否则她自己说的话也只能给库里的前 600 条记命中。
      // 用快照遍历（不再每次物化 lexicon/anime 全表），只有真命中才写 UPDATE。
      for (const l of lexiconRows()) {
        if (t.indexOf(String(l.term)) >= 0) bumpHits('lexicon', l.term);
      }
      for (const a of animeTermRows()) {
        if (a.terms.some((x) => t.indexOf(x) >= 0)) bumpHits('anime', a.title);
      }
    } catch (error) {
      log('bumpInterestsFromSelf failed', error?.message || error);
    }
  }

  function dailyPick(seed, limit) {
    try {
      const d = new Date();
      const h = (d.getFullYear() * 372 + d.getMonth() * 31 + d.getDate()) % 9973;
      const rows = db.prepare('SELECT title, aliases, summary, take FROM anime ORDER BY title').all();
      if (!rows.length) return [];
      const out = [];
      for (let i = 0; i < (limit || 1); i++) out.push(rows[(h + i * 37) % rows.length]);
      return out;
    } catch {
      return [];
    }
  }

  function buildInterestBlock(opts) {
    const o = opts || {};
    const maxChars = Number(o.maxChars) || 420;
    try {
      const found = matchInterests(o.text, { maxAnime: o.maxAnime, maxMeme: o.maxMeme });
      const lines = [];
      for (const a of found.anime) {
        const alias = String(a.aliases || '').split(',')[0].trim();
        lines.push('《' + a.title + '》' + (alias ? '（' + alias + '）' : '') + '：' + String(a.summary || '').slice(0, 90) + '；名场面：' + String(a.moments || '').slice(0, 60) + '；本鲸的看法：' + String(a.take || '').slice(0, 70));
      }
      for (const l of found.memes) lines.push('「' + l.term + '」' + String(l.meaning || '').slice(0, 50) + '（例：' + String(l.usage || '').slice(0, 30) + '）');
      if (!lines.length) {
        for (const a of dailyPick(o.daySeed, 1)) {
          lines.push('今天想聊的番：《' + a.title + '》' + String(a.summary || '').slice(0, 70) + '（本鲸的看法：' + String(a.take || '').slice(0, 60) + '）');
        }
        const top = db.prepare('SELECT term FROM lexicon WHERE length(term) >= 2 ORDER BY RANDOM() LIMIT 3').all();
        if (top.length) lines.push('随手能用的梗：' + top.map((x) => x.term).join(' / ') + '（顺口带一个就行）');
      }
      if (!lines.length) return '';
      let body = lines.join('\n');
      if (body.length > maxChars) body = truncateText(body, maxChars) + '…';
      return '【动漫库 / 梗库（只有对方真的提到才给你，顺口用，别背简介、别硬塞）】\n' + body;
    } catch (error) {
      log('buildInterestBlock failed', error?.message || error);
      return '';
    }
  }

  function addAnime(opts) {
    const o = opts || {};
    const title = String(o.title || '').trim().slice(0, 60);
    if (!title) return null;
    try {
      db.prepare('INSERT INTO anime (title, aliases, kind, tags, summary, moments, take, hits, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT(title) DO UPDATE SET aliases = excluded.aliases, kind = excluded.kind, tags = excluded.tags, summary = excluded.summary, moments = excluded.moments, take = excluded.take')
        .run(title, String(o.aliases || '').slice(0, 120), String(o.kind || '').slice(0, 20), String(o.tags || '').slice(0, 120), String(o.summary || '').slice(0, 300), String(o.moments || '').slice(0, 200), String(o.take || '').slice(0, 200), Date.now());
      dictGen += 1;   // 词表快照立刻失效
      return title;
    } catch (error) {
      log('addAnime failed', error?.message || error);
      return null;
    }
  }

  function listAnime(limit) {
    try {
      return db.prepare('SELECT title, aliases, kind, tags, summary, take, hits FROM anime ORDER BY hits DESC, title LIMIT ?').all(Number(limit) || 200);
    } catch {
      return [];
    }
  }

  function searchAnime(q, limit) {
    const kw = String(q || '').trim();
    try {
      if (!kw) return db.prepare('SELECT title, aliases, kind, tags, summary, moments, take, hits FROM anime ORDER BY hits DESC, title LIMIT ?').all(Number(limit) || 200);
      const like = '%' + kw + '%';
      return db.prepare('SELECT title, aliases, kind, tags, summary, moments, take, hits FROM anime WHERE title LIKE ? OR aliases LIKE ? OR tags LIKE ? OR summary LIKE ? ORDER BY hits DESC, title LIMIT ?').all(like, like, like, like, Number(limit) || 100);
    } catch (error) {
      log('searchAnime failed', error?.message || error);
      return [];
    }
  }

  function listLexicon(limit) {
    try {
      return db.prepare('SELECT term, meaning, usage, source, variants, hits FROM lexicon ORDER BY hits DESC, term LIMIT ?').all(Number(limit) || 300);
    } catch {
      return [];
    }
  }

  function buildDigest(opts) {
    const o = opts || {};
    const key = String(o.key || '');
    const st = o.st || null;
    // [长记忆] 注入预算 800 → 1500：自动提炼之后事实条数会涨，800 字装不下
    const maxChars = Number(o.maxChars) || 1500;
    try {
      const lines = [];
      const recent = st && Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const unread = st && Array.isArray(st.unread) ? st.unread : [];
      // [记忆命中率] 旧实现只取「最新 22 条消息里最先出现的 3 个发言人」——实测 6 个会话里
      // 只有 25% 的名额落在真有人格档案的人身上，聊了一周的人常常一句印象都进不去。
      // 现在先收集最近 8 个不同发言人当候选，再按「有印象 > 聊得多 > 更新」排序，
      // 同时硬保留「主人」和「最近一个发言人」的名额，保证当前对话永远有人在场。
      const seen = {};
      const cands = [];
      const pool = unread.slice(-8).concat(recent.slice(-14)).reverse();
      for (const m of pool) {
        if (!m || m.isSelf) continue;
        const uid = m.userId ? String(m.userId) : '';
        const pid = uid || ('name:' + String(m.sender || '').slice(0, 40));
        if (seen[pid]) continue;
        seen[pid] = true;
        cands.push({ pid, name: String(m.sender || uid || '未知'), isOwner: !!m.isOwner, recency: cands.length });
        if (cands.length >= 8) break;
      }
      const byId = new Map();
      if (cands.length) {
        const ph = cands.map(() => '?').join(',');
        for (const row of db.prepare('SELECT id, nickname, relation, traits, note, msg_count FROM people WHERE id IN (' + ph + ')').all(...cands.map((c) => c.pid))) byId.set(row.id, row);
        for (const c of cands) {
          if (byId.has(c.pid) || c.pid.indexOf('name:') === 0) continue;
          const row = db.prepare('SELECT id, nickname, relation, traits, note, msg_count FROM people WHERE nickname = ? LIMIT 1').get(c.name.slice(0, 40));
          if (row) byId.set(c.pid, row);
        }
      }
      const rank = cands.filter((c) => byId.has(c.pid)).map((c) => {
        const row = byId.get(c.pid);
        const traits = parseJsonArray(row.traits);
        return { ...c, row, hasKnown: traits.length || row.note ? 1 : 0, msgCount: Number(row.msg_count) || 0 };
      });
      const chosen = [];
      const take = (x) => { if (x && chosen.indexOf(x) < 0 && chosen.length < 3) chosen.push(x); };
      take(rank.find((x) => x.isOwner));
      take(rank.find((x) => x.recency === 0));
      const rest = rank.filter((x) => chosen.indexOf(x) < 0)
        .sort((a, b) => (b.hasKnown - a.hasKnown) || (b.msgCount - a.msgCount) || (a.recency - b.recency));
      for (const x of rest) take(x);
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const chosenIds = chosen.map((x) => x.row.id);
      const todayById = new Map();
      if (chosenIds.length) {
        const ph2 = chosenIds.map(() => '?').join(',');
        for (const t of db.prepare('SELECT user_id, COUNT(*) AS c FROM messages WHERE at >= ? AND user_id IN (' + ph2 + ') GROUP BY user_id').all(dayStart.getTime(), ...chosenIds)) todayById.set(t.user_id, Number(t.c) || 0);
      }
      const rows = [];
      for (const item of chosen) {
        const traits = parseJsonArray(item.row.traits);
        const known = traits.concat(item.row.note ? [String(item.row.note)] : []).filter(Boolean).join('；');
        rows.push({ id: item.row.id, label: item.row.nickname || item.name, relation: item.row.relation || '', known, msgCount: item.msgCount, todayCount: todayById.get(item.row.id) || 0 });
      }
      if (rows.length) {
        lines.push('【你记得的人】');
        for (const r of rows) {
          let label = r.label;
          if (r.relation) {
            if (r.relation.indexOf('主人') >= 0) label = (r.label === '主人' ? '主人' : '主人 ' + r.label) + '（管理员）';
            else if (label.indexOf(r.relation.slice(0, 2)) < 0) label = label + '（' + r.relation + '）';
          }
          lines.push('- ' + label + '：' + (r.known || '印象还不多') + '（聊过 ' + r.msgCount + ' 句' + (r.todayCount ? '，今天 ' + r.todayCount + ' 句' : '') + '）');
        }
      }
      if (key.indexOf('group:') === 0) {
        const g = db.prepare('SELECT self_sent FROM people WHERE id = ?').get(key);
        if (g && Number(g.self_sent) > 0) lines.push('- 这个群：你在这里说过 ' + Number(g.self_sent) + ' 句话');
      }
      // [长记忆] 先多取（20 条）、再按「跟当前话题的相关度 + 新鲜度」排序，
      // 最后整段仍受 maxChars 硬上限约束 —— 让「记得住旧事」和「省 token」共存。
      // [长记忆] 除「有档案的人」之外，也把当前对话里出现过的 userId 都算作候选 ——
      // 新来的人往往还没建档，只按 people 行取会漏掉他刚说过的事实。
      const subjectIdSet = new Set(rows.map((r) => String(r.id || '')).filter(Boolean));
      for (const m of pool) {
        if (m && m.userId) subjectIdSet.add(String(m.userId));
      }
      const subjectIds = [...subjectIdSet];
      let facts = [];
      if (subjectIds.length) {
        const ph = subjectIds.map(() => '?').join(',');
        const fstmt = db.prepare('SELECT text, updated_at, hits FROM facts WHERE (scope = \'person\' AND subject IN (' + ph + ')) OR scope IN (\'global\', ?, \'topic\') ORDER BY updated_at DESC LIMIT 24');
        facts = fstmt.all(...subjectIds, key);
      } else {
        facts = db.prepare('SELECT text, updated_at, hits FROM facts WHERE scope IN (\'global\', ?, \'topic\') ORDER BY updated_at DESC LIMIT 12').all(key);
      }
      if (facts.length) {
        const tokens = new Set();
        for (const m of unread.slice(-6).concat(recent.slice(-10))) {
          if (!m || m.isSelf) continue;
          const txt = String(m.text != null ? m.text : (m.plain || '')).toLowerCase().replace(/[\s，。,.!！?？~～、]/g, '');
          for (let i = 0; i + 2 <= txt.length; i += 2) tokens.add(txt.slice(i, i + 2));
        }
        const ranked = facts
          .map((f) => ({ text: f.text, score: factScore(f.text, tokens), at: Number(f.updated_at) || 0 }))
          .sort((a, b) => (b.score - a.score) || (b.at - a.at));
        const picked = ranked.slice(0, 10);
        lines.push('【你记着的事】');
        for (const f of picked) lines.push('- ' + f.text);
      }
      const events = db.prepare('SELECT at, summary FROM events WHERE key = ? ORDER BY at DESC LIMIT 3').all(key);
      if (events.length) {
        lines.push('【最近发生的事】');
        for (const e of events.slice().reverse()) {
          const d = new Date(Number(e.at));
          const p = (n) => String(n).padStart(2, '0');
          lines.push('- ' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ' ' + e.summary);
        }
      }
      // [patch 去白饭] 以前这里把 token 数当成"今天吃了 N 碗白饭"注入——那会让她每轮都惦记白饭。
      // 现在只保留"偷称体重"这个梗（她从不承认那个数字），不再提饭。
      const rice = syncRice();
      if (rice) {
        const weight = Math.min(88, 45 + rice.bowlsTotal / 25);
        lines.push('【你自己】体重计显示 ' + weight.toFixed(1) + ' 公斤——这数字你从来不承认，被问就说"本鲸这是骨架大"。');
      }
      const chatText = truncateText((unread.slice(-8).concat(recent.slice(-12)).filter((x) => x && !x.isSelf)
        .map((x) => String(x.text != null ? x.text : (x.plain || '')))
        .join(' ')), 1500);
      const interest = buildInterestBlock({ text: chatText, maxChars: Number(o.interestMaxChars) || 420, maxAnime: Number(o.maxAnime) || 2, maxMeme: Number(o.maxMeme) || 3 });
      if (interest) lines.push(interest);
      if (!lines.length) return '';
      let body = lines.join('\n');
      if (body.length > maxChars) body = truncateText(body, maxChars) + '…';
      return '【你脑子里的事（长期记忆：模糊印象，顺口提起就好；记不清就说"我记性不好"）】\n' + body;
    } catch (error) {
      log('buildDigest failed', error?.message || error);
      return '';
    }
  }

  function recount() {
    try {
      db.prepare('UPDATE people SET msg_count = (SELECT COUNT(*) FROM messages WHERE messages.user_id = people.id AND messages.is_self = 0) WHERE kind = \'user\'').run();
      db.prepare('UPDATE people SET self_sent = (SELECT COUNT(*) FROM messages WHERE messages.user_id = people.id AND messages.is_self = 1) WHERE kind = \'group\'').run();
      db.prepare('UPDATE people SET msg_count = (SELECT COUNT(*) FROM messages WHERE messages.user_id = people.id AND messages.is_self = 0) WHERE kind = \'group\'').run();
      return true;
    } catch (error) {
      log('recount failed', error?.message || error);
      return false;
    }
  }

  // ── [patch 日记] 她的小记 + 按天/按周取数（睡前小记、周末周报都用这几个） ──────
  // 约定：写失败只记日志、读失败返空，绝不抛给消息链路。
  function addDiary(opts) {
    const o = opts || {};
    const body = truncateText(String(o.text || '').trim(), maxDiaryChars);
    if (!body) return null;
    try {
      const now = Date.now();
      const day = dayOf(now);
      const r = db.prepare('INSERT INTO diary (at, day, key, scope, text, tags, source, mood) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(now, day, String(o.key || ''), String(o.scope || 'self'), body, String(o.tags || ''), String(o.source || 'self'), String(o.mood || ''));
      // 只留最近 4000 条（一天 1~2 条 ⇒ 够写五年多）。跟 events 一样顺手清，别让它无界长大。
      try {
        db.prepare('DELETE FROM diary WHERE id NOT IN (SELECT id FROM diary ORDER BY at DESC LIMIT 4000)').run();
      } catch { /* 清理失败不影响这次写入 */ }
      return { id: Number(r.lastInsertRowid), at: now, day, text: body };
    } catch (error) {
      log('addDiary failed', error?.message || error);
      return null;
    }
  }

  function listDiary(opts) {
    const o = opts || {};
    try {
      const limit = Math.min(Math.max(Number(o.limit) || 10, 1), 200);
      const where = [];
      const args = [];
      if (Number(o.since)) { where.push('at >= ?'); args.push(Number(o.since)); }
      if (Number(o.until)) { where.push('at <= ?'); args.push(Number(o.until)); }
      if (o.key) { where.push('key = ?'); args.push(String(o.key)); }
      if (o.q) { where.push('text LIKE ?'); args.push('%' + String(o.q).slice(0, 60) + '%'); }
      const rows = db.prepare('SELECT id, at, day, key, text, tags, mood FROM diary'
        + (where.length ? ' WHERE ' + where.join(' AND ') : '')
        + ' ORDER BY at DESC LIMIT ?').all(...args, limit);
      // 返回时间正序：写提示词时"最近的"放后面读起来才顺。
      return rows.slice().reverse();
    } catch (error) {
      log('listDiary failed', error?.message || error);
      return [];
    }
  }

  /** 'YYYY-MM-DD' 的本地起止毫秒；非法/缺省就退回今天。 */
  function dayWindow(dayStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayStr || '').trim());
    if (!m) return dayWindow(dayOf(Date.now()));
    const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
    return { day: `${m[1]}-${m[2]}-${m[3]}`, since: start, until: start + 86400000 - 1 };
  }

  /** 某天的消息量/说话人数/新事实/日记条数——写小记时给她一份"今天的数字"。 */
  function dayStats(dayStr, sinceTs) {
    const win = dayWindow(dayStr);
    const since = Number(sinceTs) || win.since;
    try {
      const one = (sql, ...a) => db.prepare(sql).get(...a) || {};
      const msg = one('SELECT COUNT(*) AS c, SUM(CASE WHEN is_self = 1 THEN 1 ELSE 0 END) AS s FROM messages WHERE day = ?', win.day);
      const ppl = one('SELECT COUNT(DISTINCT sender) AS c FROM messages WHERE day = ? AND is_self = 0 AND sender IS NOT NULL', win.day);
      const facts = one('SELECT COUNT(*) AS c FROM facts WHERE created_at >= ?', since);
      const diary = one('SELECT COUNT(*) AS c FROM diary WHERE day = ?', win.day);
      return {
        day: win.day,
        messages: Number(msg.c) || 0,
        selfMessages: Number(msg.s) || 0,
        people: Number(ppl.c) || 0,
        newFacts: Number(facts.c) || 0,
        diary: Number(diary.c) || 0
      };
    } catch (error) {
      log('dayStats failed', error?.message || error);
      return null;
    }
  }

  // ── [patch 群聊小总结] 按单个会话取数：dayStats 是全库口径（跨群+私聊混在一起），
  // 往群里发总结必须"只算这个群自己的"，否则会把别的群/私聊的事说漏嘴。
  // 约定同 dayStats：取不到就返 null，绝不抛给消息链路。
  function keyStats(dayStr, key) {
    const win = dayWindow(dayStr);
    const k = String(key || '').trim();
    if (!k) return null;
    try {
      const one = (sql, ...a) => db.prepare(sql).get(...a) || {};
      const msg = one('SELECT COUNT(*) AS c, SUM(CASE WHEN is_self = 1 THEN 1 ELSE 0 END) AS s FROM messages WHERE day = ? AND key = ?', win.day, k);
      const ppl = one('SELECT COUNT(DISTINCT sender) AS c FROM messages WHERE day = ? AND key = ? AND is_self = 0 AND sender IS NOT NULL', win.day, k);
      return {
        day: win.day,
        key: k,
        messages: Number(msg.c) || 0,
        selfMessages: Number(msg.s) || 0,
        people: Number(ppl.c) || 0
      };
    } catch (error) {
      log('keyStats failed', error?.message || error);
      return null;
    }
  }

  /** 某会话某天谁最活跃（按发言条数降序）——群总结要"点名今天最闹的那几个"。 */
  function keyTopSpeakers(dayStr, key, limit) {
    const win = dayWindow(dayStr);
    const k = String(key || '').trim();
    if (!k) return [];
    const n = Math.min(Math.max(Number(limit) || 5, 1), 20);
    try {
      return db.prepare('SELECT sender AS name, COUNT(*) AS c FROM messages WHERE day = ? AND key = ? AND is_self = 0 AND sender IS NOT NULL AND sender != \'\' GROUP BY sender ORDER BY c DESC LIMIT ?')
        .all(win.day, k, n);
    } catch (error) {
      log('keyTopSpeakers failed', error?.message || error);
      return [];
    }
  }

  /** 某会话某天她说过的话（给她"我今天在这个群里说过什么"的抓手，别重复、别说岔）。 */
  function keySelfLines(dayStr, key, limit) {
    const win = dayWindow(dayStr);
    const k = String(key || '').trim();
    if (!k) return [];
    const n = Math.min(Math.max(Number(limit) || 10, 1), 50);
    try {
      return db.prepare('SELECT text, at FROM messages WHERE day = ? AND key = ? AND is_self = 1 AND text IS NOT NULL AND text != \'\' ORDER BY at DESC LIMIT ?')
        .all(win.day, k, n).slice().reverse();
    } catch (error) {
      log('keySelfLines failed', error?.message || error);
      return [];
    }
  }

  /** 某时刻之后的事件（跨会话）——周报要"这周发生过什么"。 */
  function listEventsSince(sinceTs, limit) {
    try {
      const since = Number(sinceTs) || 0;
      const n = Math.min(Math.max(Number(limit) || 10, 1), 100);
      return db.prepare('SELECT at, key, kind, summary FROM events WHERE at >= ? ORDER BY at DESC LIMIT ?').all(since, n);
    } catch (error) {
      log('listEventsSince failed', error?.message || error);
      return [];
    }
  }

  function diaryStats() {
    try {
      const one = (sql) => db.prepare(sql).get() || {};
      return {
        total: Number(one('SELECT COUNT(*) AS c FROM diary').c) || 0,
        days: Number(one('SELECT COUNT(DISTINCT day) AS c FROM diary').c) || 0,
        lastAt: Number(one('SELECT at FROM diary ORDER BY at DESC LIMIT 1').at) || 0
      };
    } catch (error) {
      log('diaryStats failed', error?.message || error);
      return { total: 0, days: 0, lastAt: 0 };
    }
  }

  function stats() {
    try {
      const one = (sql) => db.prepare(sql).get() || {};
      return {
        file,
        people: one('SELECT COUNT(*) AS c FROM people').c || 0,
        messages: one('SELECT COUNT(*) AS c FROM messages').c || 0,
        facts: one('SELECT COUNT(*) AS c FROM facts').c || 0,
        events: one('SELECT COUNT(*) AS c FROM events').c || 0,
        lexicon: one('SELECT COUNT(*) AS c FROM lexicon').c || 0,
        anime: one('SELECT COUNT(*) AS c FROM anime').c || 0,
        diary: one('SELECT COUNT(*) AS c FROM diary').c || 0,
        rice: syncRice()
      };
    } catch (error) {
      log('stats failed', error?.message || error);
      return { file, error: String(error?.message || error) };
    }
  }

  function search(opts) {
    const o = opts || {};
    try {
      const like = '%' + String(o.q || '').slice(0, 60) + '%';
      const limit = Number(o.limit) || 20;
      if (o.key) return db.prepare('SELECT key, sender, is_self, text, at FROM messages WHERE key = ? AND text LIKE ? ORDER BY at DESC LIMIT ?').all(o.key, like, limit);
      return db.prepare('SELECT key, sender, is_self, text, at FROM messages WHERE text LIKE ? ORDER BY at DESC LIMIT ?').all(like, limit);
    } catch (error) {
      log('search failed', error?.message || error);
      return [];
    }
  }

  // [超长记忆 2026-10-19] 按天取固化信号：某会话某天的消息流水 + 当天新学的事实 + 事件。
  // 供 long-memory.js 的每日固化（episodic 记忆编码）使用，零 LLM token。
  function daySignals(key, day) {
    try {
      const start = new Date(`${day}T00:00:00`).getTime();
      const end = start + 86400000;
      const messages = db.prepare('SELECT sender, is_self, text, at FROM messages WHERE key = ? AND at >= ? AND at < ? ORDER BY at ASC LIMIT 500').all(key, start, end);
      const facts = db.prepare('SELECT text FROM facts WHERE created_at >= ? AND created_at < ? ORDER BY id DESC LIMIT 20').all(start, end).map((r) => r.text);
      const events = db.prepare('SELECT kind, summary FROM events WHERE at >= ? AND at < ? ORDER BY id ASC LIMIT 50').all(start, end);
      return { messages, facts, events };
    } catch (error) {
      log('daySignals failed', error?.message || error);
      return { messages: [], facts: [], events: [] };
    }
  }

  function recentPeople(limit) {
    try {
      return db.prepare('SELECT id, nickname, relation, msg_count, last_seen FROM people WHERE kind = \'user\' ORDER BY last_seen DESC LIMIT ?').all(Number(limit) || 30);
    } catch (error) {
      return [];
    }
  }

  // 按昵称反查 pid：relations 表存的是 pid，但模型只会说人名。
  // 同名时优先「消息多、最近出现」的那个，避免把常聊的人记到小号上。
  function personIdByName(name) {
    const n = String(name == null ? '' : name).trim();
    if (!n) return '';
    try {
      const row = db.prepare('SELECT id FROM people WHERE nickname = ? ORDER BY msg_count DESC, last_seen DESC LIMIT 1').get(n);
      return row ? String(row.id) : '';
    } catch (error) {
      log('personIdByName failed', error?.message || error);
      return '';
    }
  }

  function peopleByIds(ids) {
    const out = {};
    if (!Array.isArray(ids) || !ids.length) return out;
    const seen = [];
    for (const raw of ids) {
      const id = String(raw == null ? '' : raw).trim();
      if (!id || seen.indexOf(id) >= 0) continue;
      if (seen.length >= 20) break;
      seen.push(id);
    }
    if (!seen.length) return out;
    try {
      const marks = seen.map(() => '?').join(',');
      const rows = db.prepare('SELECT id, nickname, msg_count, self_sent FROM people WHERE id IN (' + marks + ')').all(...seen);
      for (const row of rows) out[String(row.id)] = row;
    } catch (error) {
      log('peopleByIds failed', error?.message || error);
    }
    return out;
  }

  // —— 关系系统（朋友档位 + 恋爱线）——
  // 全部返回「表里的蛇形字段 + 解析后的 moments 数组」，让调用方拿到就能用，
  // 不必关心 moments 在库里其实是 JSON 字符串。

  function getRelation(pid) {
    try {
      const row = db.prepare('SELECT pid, name, scope, love, stage, pet_name, promise, moments, note, up_count, first_at, last_at FROM relations WHERE pid = ?').get(String(pid == null ? '' : pid));
      // 解析放在这一层：坏 JSON 退化成 []，不会把读取方炸掉。
      return row ? Object.assign({}, row, { moments: parseJsonArray(row.moments) }) : null;
    } catch (error) {
      log('getRelation failed', error?.message || error);
      return null;
    }
  }

  function relationsFor(pids) {
    const out = {};
    if (!Array.isArray(pids) || !pids.length) return out;
    try {
      // 人数很少（生成提示词时最多十来人），一条条查最简单也最好读；顺便去重。
      const seen = [];
      for (const raw of pids) {
        const pid = String(raw == null ? '' : raw).trim();
        if (!pid || seen.indexOf(pid) >= 0) continue;
        if (seen.length >= 10) break;
        seen.push(pid);
      }
      for (const pid of seen) {
        const row = getRelation(pid);
        if (row) out[pid] = row;
      }
    } catch (error) {
      log('relationsFor failed', error?.message || error);
    }
    return out;
  }

  function listRelations(opts) {
    const o = opts || {};
    try {
      const limit = Number(o.limit) || 20;
      const minLove = Number(o.minLove) || 0;
      return db.prepare('SELECT pid, name, scope, love, stage, pet_name, promise, moments, note, up_count, first_at, last_at FROM relations WHERE love >= ? ORDER BY love DESC, last_at DESC LIMIT ?')
        .all(minLove, limit)
        .map((row) => Object.assign({}, row, { moments: parseJsonArray(row.moments) }));
    } catch (error) {
      log('listRelations failed', error?.message || error);
      return [];
    }
  }

  function upsertRelation(opts) {
    const o = opts || {};
    // pid 是唯一键，没有它就无从落库：直接返回 null，绝不写一条无名僵尸行。
    const pid = typeof o.pid === 'string' ? o.pid.trim() : '';
    if (!pid) return null;
    try {
      const now = Date.now();
      const old = db.prepare('SELECT * FROM relations WHERE pid = ?').get(pid);
      const delta = clampLoveDelta(o.loveDelta);
      // 共同回忆：文本和最后一条相同就不追加，避免同一句被反复刷进来；只留最新 12 条。
      const moments = parseJsonArray(old && old.moments);
      const momentRaw = o.moment == null ? '' : String(o.moment).trim();
      if (momentRaw) {
        const text = truncateText(momentRaw, 80);
        const last = moments[moments.length - 1];
        const lastText = last && typeof last === 'object' ? last.text : '';
        if (text && text !== lastText) moments.push({ at: now, text });
      }
      const next = {
        name: pickText(o.name, old && old.name, 0),
        scope: pickText(o.scope, old && old.scope, 0),
        love: clampLove((old ? Number(old.love) || 0 : 0) + delta),
        stage: pickClearable(o.stage, old && old.stage, 20),
        pet_name: pickClearable(o.petName, old && old.pet_name, 20),
        promise: pickClearable(o.promise, old && old.promise, 200),
        note: pickClearable(o.note, old && old.note, 200),
        up_count: (old ? Number(old.up_count) || 0 : 0) + (delta > 0 ? 1 : 0)
      };
      // 先读旧行、再算出终值、最后一条 UPSERT 落库：单进程同步 SQLite 下够稳，
      // 也让「保留原值 / 截断 / 去重」这些规则集中在一处，不用堆一串 SQL CASE。
      db.prepare('INSERT INTO relations (pid, name, scope, love, stage, pet_name, promise, moments, note, up_count, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(pid) DO UPDATE SET name = excluded.name, scope = excluded.scope, love = excluded.love, stage = excluded.stage, pet_name = excluded.pet_name, promise = excluded.promise, moments = excluded.moments, note = excluded.note, up_count = excluded.up_count, first_at = relations.first_at, last_at = excluded.last_at')
        .run(pid, next.name, next.scope, next.love, next.stage, next.pet_name, next.promise, JSON.stringify(moments.slice(-12)), next.note, next.up_count, old ? Number(old.first_at) || now : now, now);
      return getRelation(pid);
    } catch (error) {
      log('upsertRelation failed', error?.message || error);
      return null;
    }
  }

  /** 忘掉跟某个人的关系（整行删除）。pid 空则什么都不做，绝不误删全表。 */
  function removeRelation(pid) {
    const key = typeof pid === 'string' ? pid.trim() : '';
    if (!key) return false;
    try {
      db.prepare('DELETE FROM relations WHERE pid = ?').run(key);
      return true;
    } catch (error) {
      log('removeRelation failed', error?.message || error);
      return false;
    }
  }

  // ── [patch 口癖画像 / 情绪事件] ───────────────────────────────────────────
  // 画像缓存：TTL 10 分钟 + "她自己的消息写入"代数失效。为什么不用每轮重算：
  // 这里要扫最多 400 条消息、枚举每条消息的 2~4 字子串（实测 4ms 起步），
  // 而提示词一轮可能问好几次；画像本身变化极慢，10 分钟足够新鲜。
  const STYLE_TTL_MS = 10 * 60 * 1000;
  let styleCache = null;
  let styleRowsStmt = null;

  /**
   * 口癖画像（纯读）：返回结构化数据 { top, tails, avgLen, count }，不返回成品句子。
   *   top   —— 口头禅：2~4 字、只由普通汉字组成，按"出现在多少条不同消息里"计数；
   *   tails —— 句尾习惯：每条消息末尾 2 字（末字是标点则取 3 字）；
   *   avgLen—— 去首尾空白后的平均字数（1 位小数）；count——参与统计的消息条数。
   * 任何异常都吞掉返回 null：它只喂提示词，绝不能把消息链路炸掉。
   */
  function styleProfile(opts) {
    const o = opts || {};
    const limit = Math.min(Math.max(Number(o.limit) || 400, 50), 2000);
    try {
      if (styleCache && styleCache.gen === styleMsgGen && styleCache.limit === limit && Date.now() - styleCache.at < STYLE_TTL_MS) {
        // 返回副本：调用方拿到手想怎么改怎么改，不能污染缓存里那一份。
        return { top: styleCache.data.top.slice(), tails: styleCache.data.tails.slice(), avgLen: styleCache.data.avgLen, count: styleCache.data.count };
      }
      // 语句缓存在闭包内：同一批数据重复调用不再重新 prepare（node:sqlite 的 prepare 不便宜）。
      if (!styleRowsStmt) styleRowsStmt = db.prepare('SELECT text FROM messages WHERE is_self = 1 AND text IS NOT NULL AND text <> \'\' ORDER BY at DESC LIMIT ?');
      const texts = [];
      let sum = 0;
      for (const row of styleRowsStmt.all(limit)) {
        const t = String(row.text == null ? '' : row.text).trim();
        if (!t) continue;
        texts.push(t);
        sum += t.length;
      }
      const count = texts.length;
      // 一句都没说过就没有画像。刻意不缓存 null：她下一句写进来就能立刻用上。
      if (!count) return null;
      const avgLen = Math.round((sum / count) * 10) / 10;

      // 口头禅：2~4 字滑窗。同一条消息里同一子串只算一次（Set），所以统计口径是
      // "有多少条不同消息用过它"——避免她一句话里连说三遍就把这个词顶上榜首。
      const topCounts = new Map();
      for (const t of texts) {
        const seen = new Set();
        for (let n = 2; n <= 4; n++) {
          for (let i = 0; i + n <= t.length; i++) {
            const sub = t.slice(i, i + n);
            if (!isStyleFragment(sub)) continue;
            seen.add(sub);
          }
        }
        for (const sub of seen) topCounts.set(sub, (topCounts.get(sub) || 0) + 1);
      }
      // 门槛：至少 3 条消息用过（1~2 条是偶然），且不能超过一半消息都用（那是人人都会的词，
      // 不是她个人的口癖）；再用 2% 兜住长语料，免得 400 条里 3 条就进榜。
      const minTop = Math.max(3, Math.ceil(count * 0.02));
      const maxTop = count * 0.5;
      const cands = [];
      for (const [word, c] of topCounts) {
        if (c < minTop || c > maxTop) continue;
        if (STYLE_STOP_WORDS.has(word)) continue;
        cands.push({ word, count: c });
      }
      // 排序：出现条数 desc → 子串长度 desc（长的更具体）→ 字典序（保证结果可复现）。
      cands.sort((a, b) => (b.count - a.count) || (b.word.length - a.word.length) || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
      // 冗余抑制：短候选若是某个更长候选的子串、且长候选条数达到它的 60%（"相差不多"），
      // 就只留长的——「好啦」只是「好啦好啦」的碎片，两个都留画像读起来像复读机。
      const kept = cands.filter((a) => !cands.some((b) => b !== a && b.word.length > a.word.length && b.word.indexOf(a.word) >= 0 && b.count >= a.count * 0.6));
      const top = kept.slice(0, 3).map((x) => x.word);

      // 句尾习惯：末尾 2 字；末字是标点就往前多取一字（"啊。""呀～"这类语气收尾一起留住）。
      const tailCounts = new Map();
      for (const t of texts) {
        if (t.length < 3) continue;
        const tail = STYLE_TAIL_PUNCT.indexOf(t[t.length - 1]) >= 0 ? t.slice(-3) : t.slice(-2);
        tailCounts.set(tail, (tailCounts.get(tail) || 0) + 1);
      }
      const tails = [];
      for (const [word, c] of tailCounts) {
        // 上限 60%：句尾习惯本来就该有几种，一个结尾占了大半说明语料太单一，没有信息量。
        if (c < 3 || c > count * 0.6) continue;
        tails.push({ word, count: c });
      }
      tails.sort((a, b) => (b.count - a.count) || (b.word.length - a.word.length) || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));

      const data = { top, tails: tails.slice(0, 2).map((x) => x.word), avgLen, count };
      styleCache = { gen: styleMsgGen, limit, at: Date.now(), data };
      return { top: data.top.slice(), tails: data.tails.slice(), avgLen: data.avgLen, count: data.count };
    } catch (error) {
      log('styleProfile failed', error?.message || error);
      return null;
    }
  }

  /**
   * 写一条情绪事件（kind = "mood:<mood>"，复用 events 表，不动表结构）。
   * mood 不在白名单、或 summary 为空 → 返回 null 且不落库（宁可没有情绪，也不要有脏数据）。
   * 写成功后只清理 mood 事件自己的 500 条上限——绝不碰 topic/note 这类别的 events 行：
   * recordEvent 的 500 条是全局上限，这里若复用那条 SQL，一次情绪写入就会顺手挤掉别人的老事件。
   */
  function recordMoodEvent(opts) {
    const o = opts || {};
    const mood = String(o.mood == null ? '' : o.mood).trim();
    if (MOOD_KINDS.indexOf(mood) < 0) return null;
    const body = truncateText(String(o.summary == null ? '' : o.summary).trim(), 160);
    if (!body) return null;
    try {
      const at = Number(o.at) || Date.now();
      const kind = 'mood:' + mood;
      db.prepare('INSERT INTO events (at, key, kind, summary, participants) VALUES (?, ?, ?, ?, ?)')
        .run(at, String(o.key || ''), kind, body, JSON.stringify(Array.isArray(o.participants) ? o.participants.slice(0, 6) : []));
      db.prepare('DELETE FROM events WHERE kind LIKE \'mood:%\' AND id NOT IN (SELECT id FROM events WHERE kind LIKE \'mood:%\' ORDER BY at DESC, id DESC LIMIT 500)').run();
      return { at, kind, mood, summary: body };
    } catch (error) {
      log('recordMoodEvent failed', error?.message || error);
      return null;
    }
  }

  /**
   * 读情绪事件：时间倒序 [{ at, key, mood, summary, participants }]。
   * mood 从 kind 解析；kind 里没有合法 mood（空 / 脏值）的行直接跳过，不把 undefined 抛给调用方。
   */
  function recentMoodEvents(opts) {
    const o = opts || {};
    try {
      const limit = Math.min(Math.max(Number(o.limit) || 5, 1), 50);
      const where = ["kind LIKE 'mood:%'"];
      const args = [];
      if (Number(o.sinceMs)) { where.push('at >= ?'); args.push(Number(o.sinceMs)); }
      if (o.mood) { where.push('kind = ?'); args.push('mood:' + String(o.mood)); }
      const rows = db.prepare('SELECT at, key, kind, summary, participants FROM events WHERE ' + where.join(' AND ') + ' ORDER BY at DESC, id DESC LIMIT ?').all(...args, limit);
      const out = [];
      for (const r of rows) {
        const mood = String(r.kind || '').slice('mood:'.length);
        if (MOOD_KINDS.indexOf(mood) < 0) continue;
        out.push({ at: Number(r.at) || 0, key: r.key, mood, summary: r.summary, participants: parseJsonArray(r.participants) });
      }
      return out;
    } catch (error) {
      log('recentMoodEvents failed', error?.message || error);
      return [];
    }
  }

  // ── [patch 心情打卡/树洞] 群友的心情记录 ────────────────────────────────────
  // 复用 events 表（kind='mood:<mood>'），但**按人**读：谁在什么时候说了自己什么心情。
  // 和 recentMoodEvents 的区别：那个读的是"她自己的心情"，这个是"群里谁今天怎么了"，
  // 树洞要不要接话、要不要记着关心一下，靠这个。
  /** 某会话近 N 小时里群友的心情打卡（按人聚合，最新的在前）。 */
  function listMemberMoods(key, opts) {
    const o = opts || {};
    const k = String(key || '').trim();
    if (!k) return [];
    const hours = Math.min(Math.max(Number(o.hours) || 24, 1), 24 * 30);
    const limit = Math.min(Math.max(Number(o.limit) || 30, 1), 200);
    try {
      const since = Number(o.sinceMs) || (Date.now() - hours * 3600 * 1000);
      const rows = db.prepare('SELECT at, kind, summary, participants FROM events WHERE key = ? AND kind LIKE \'mood:%\' AND at >= ? ORDER BY at DESC, id DESC LIMIT ?')
        .all(k, since, limit);
      const out = [];
      for (const r of rows) {
        const mood = String(r.kind || '').slice('mood:'.length);
        if (MOOD_KINDS.indexOf(mood) < 0) continue;
        const who = parseJsonArray(r.participants);
        out.push({ at: Number(r.at) || 0, mood, summary: r.summary, who });
      }
      return out;
    } catch (error) {
      log('listMemberMoods failed', error?.message || error);
      return [];
    }
  }

  /** 某会话今天的树洞/心情条数（看门狗用它判"今天有没有人打卡"）。 */
  function moodBoardStats(dayStr, key) {
    const win = dayWindow(dayStr);
    const k = String(key || '').trim();
    if (!k) return null;
    try {
      const one = (sql, ...a) => db.prepare(sql).get(...a) || {};
      const total = one('SELECT COUNT(*) AS c FROM events WHERE key = ? AND kind LIKE \'mood:%\' AND at >= ? AND at <= ?', k, win.since, win.until);
      const ppl = one('SELECT COUNT(DISTINCT participants) AS c FROM events WHERE key = ? AND kind LIKE \'mood:%\' AND at >= ? AND at <= ?', k, win.since, win.until);
      return { day: win.day, key: k, entries: Number(total.c) || 0, people: Number(ppl.c) || 0 };
    } catch (error) {
      log('moodBoardStats failed', error?.message || error);
      return null;
    }
  }

  function close() {
    try {
      syncRice(true);
      flushHits();
      db.close();
    } catch {
      /* ignore */
    }
  }

  return {
    file,
    db,
    mergePerson,
    recount,
    matchInterests,
    bumpInterestsFromSelf,
    buildInterestBlock,
    addAnime,
    listAnime,
    listLexicon,
    searchAnime,
    recordMessage,
    recordSelfMessages,
    rememberImpression,
    recordFact,
    learnFacts,
    consolidateFacts,
    recordEvent,
    recordTopic,
    addDiary,
    listDiary,
    dayWindow,
    dayStats,
    keyStats,
    keyTopSpeakers,
    keySelfLines,
    listEventsSince,
    diaryStats,
    setPerson,
    addLexicon,
    noteMood,
    buildDigest,
    stats,
    search,
    daySignals,
    recentPeople,
    personIdByName,
    peopleByIds,
    friendTier,
    loveStageName,
    getRelation,
    relationsFor,
    listRelations,
    upsertRelation,
    removeRelation,
    styleProfile,
    recordMoodEvent,
    recentMoodEvents,
    listMemberMoods,
    moodBoardStats,
    syncRice,
    close
  };
}

export default createMemoryDb;
