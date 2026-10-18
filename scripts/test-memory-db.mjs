// 长期记忆库自检：node scripts/test-memory-db.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryDb, friendTier, loveStageName } from '../src/memory-db.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('✅ ' + name); }
  else { fail++; console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memdb-'));
const file = path.join(dir, 'test.db');
const db = createMemoryDb({ file, log: () => {} });
const at = Date.now();

// 18~20 单独开一个库：口癖画像要精确控制语料（主库里前面已经替她写过话），
// 情绪事件要钉死时间戳、还要灌 500 条以上做清理验证（不能污染主库的 events）。
const cacheLogs = [];
const db2 = createMemoryDb({ file: path.join(dir, 'style-mood.db'), log: (m, e) => cacheLogs.push(String(m) + ' ' + String(e)) });

try {
  // 1) 私聊快照的 sender 是「私聊」这类会话标签，不能当昵称写进 people
  db.recordMessage('private:1000', { sender: '私聊', userId: '1000', isSelf: false, text: '在吗', at });
  let person = db.recentPeople(10).find((p) => p.id === '1000');
  ok('私聊标签不会成为昵称', person && person.nickname !== '私聊', JSON.stringify(person));
  ok('没有真名字时昵称退回 QQ 号', person && person.nickname === '1000', JSON.stringify(person));

  // 2) 之后拿到真名字要能补上
  db.recordMessage('group:2000', { sender: '纱雾酱', userId: '1000', isSelf: false, text: '你好', at: at + 1000 });
  person = db.recentPeople(10).find((p) => p.id === '1000');
  ok('后来的真名字会覆盖占位昵称', person && person.nickname === '纱雾酱', JSON.stringify(person));
  ok('同名跨会话合并成一个人', db.recentPeople(10).filter((p) => p.nickname === '纱雾酱').length === 1, JSON.stringify(db.recentPeople(10)));

  // 3) 自己的消息去重（同 key+text+at 只落一条）
  db.recordSelfMessages('private:1000', ['本鲸在干饭', '本鲸在干饭'], at + 2000);
  db.recordSelfMessages('private:1000', ['本鲸在干饭'], at + 2000);
  const selfRows = db.search({ key: 'private:1000', q: '本鲸在干饭', limit: 20 }).filter((r) => r.is_self);
  // 一条消息一个时间戳（同一批间隔 1 秒），第二次重复调用不应再插入
  ok('重复记录自己的话会去重', selfRows.length === 2, JSON.stringify(selfRows));

  // 4) 梗库 / 动漫库命中与兜底
  const hit = db.matchInterests('你看孤独摇滚了吗，我直接破防了');
  ok('梗库命中破防', JSON.stringify(hit.memes).includes('破防'), JSON.stringify(hit.memes));
  ok('动漫库命中孤独摇滚（标题带「！」也能中）', JSON.stringify(hit.anime).includes('孤独摇滚'), JSON.stringify(hit.anime));
  const hit2 = db.matchInterests('最近在补【我推的孩子】');
  ok('书名号标题也能命中', JSON.stringify(hit2.anime).includes('我推'), JSON.stringify(hit2.anime));
  const block = db.buildInterestBlock({ text: '随便聊点啥', maxChars: 400 });
  ok('没命中时给今日番 + 随手梗', block.includes('今天想聊的番') && block.includes('随手能用的梗'), block.slice(0, 60));

  // 5) 种子库 / 手工增改
  ok('动漫种子已灌入', db.listAnime(1000).length >= 50, String(db.listAnime(1000).length));
  ok('梗库种子已灌入', db.listLexicon(1000).length >= 50, String(db.listLexicon(1000).length));
  db.addAnime({ title: '自检番', aliases: 'selftest', kind: '动画', tags: '测试', summary: 's', moments: 'm', take: 't' });
  ok('新增动漫可查', db.searchAnime('自检番').length === 1);
  db.addLexicon('自检梗', '测试用', '自检梗一下', { source: '自检', variants: '自检梗梗' });
  // 注意：梗库种子有 1400+ 条，而 listLexicon 是按 hits 排序后截断 ⇒ 这里取整库（5000）才看得到刚加的那条。
  ok('新增梗可查', db.listLexicon(5000).filter((x) => x.term === '自检梗').length === 1);

  // 6) 事实 / 印象 / digest
  db.recordFact({ scope: 'global', subject: '管理员', text: '喜欢看她吐槽', tags: '偏好' });
  db.rememberImpression('1000', '爱发二创表情包');
  const digest = db.buildDigest({ key: 'private:1000', st: { recentMessages: [{ sender: '纱雾酱', userId: '1000', text: '在吗', at, isSelf: false }] }, maxChars: 900 });
  ok('digest 含长期记忆块', digest.includes('你脑子里的事'), digest.slice(0, 40));
  ok('digest 含提到的人', digest.includes('纱雾酱'), digest.slice(0, 200));
  ok('digest 含动漫/梗库块', digest.includes('动漫库 / 梗库'), digest.slice(0, 200));
  ok('digest 不超过预算', digest.length <= 900 + 40, String(digest.length));

  // 7) 统计
  const stats = db.stats();
  ok('stats 有库计数', stats.people >= 1 && stats.anime >= 50 && stats.lexicon >= 50, JSON.stringify({ p: stats.people, a: stats.anime, l: stats.lexicon }));

  // 8) 关系系统 · friendTier 档位边界（含脏数据兜底）
  ok('friendTier 0/2 → 陌生人', friendTier(0) === '陌生人' && friendTier(2) === '陌生人');
  ok('friendTier 3/14 → 眼熟', friendTier(3) === '眼熟' && friendTier(14) === '眼熟');
  ok('friendTier 15/49 → 熟人', friendTier(15) === '熟人' && friendTier(49) === '熟人');
  ok('friendTier 50/149 → 朋友', friendTier(50) === '朋友' && friendTier(149) === '朋友');
  ok('friendTier 150/399 → 好朋友', friendTier(150) === '好朋友' && friendTier(399) === '好朋友');
  ok('friendTier 400/1000 → 自己人', friendTier(400) === '自己人' && friendTier(1000) === '自己人');
  ok('friendTier NaN/undefined/负数 → 陌生人', [NaN, undefined, -5, 'abc', null].every((v) => friendTier(v) === '陌生人'));

  // 9) 关系系统 · loveStageName 档位边界（含超界与脏数据）
  ok('loveStageName 0/9 → 刚认识', loveStageName(0) === '刚认识' && loveStageName(9) === '刚认识');
  ok('loveStageName 10/24 → 有点在意', loveStageName(10) === '有点在意' && loveStageName(24) === '有点在意');
  ok('loveStageName 25/44 → 有点喜欢', loveStageName(25) === '有点喜欢' && loveStageName(44) === '有点喜欢');
  ok('loveStageName 45/64 → 很喜欢', loveStageName(45) === '很喜欢' && loveStageName(64) === '很喜欢');
  ok('loveStageName 65/79 → 心动', loveStageName(65) === '心动' && loveStageName(79) === '心动');
  ok('loveStageName 80/94 → 暧昧期', loveStageName(80) === '暧昧期' && loveStageName(94) === '暧昧期');
  ok('loveStageName 95/100 → 在一起了', loveStageName(95) === '在一起了' && loveStageName(100) === '在一起了');
  ok('loveStageName 超 100 按 100 → 在一起了', loveStageName(120) === '在一起了');
  ok('loveStageName NaN → 刚认识', loveStageName(NaN) === '刚认识');

  // 10) 关系系统 · 首次插入 / 空 pid / 查不到
  const rel1 = db.upsertRelation({ pid: 'rel:1', name: '纱雾酱', scope: 'private:1000' });
  ok('upsertRelation 首次插入 love=0', !!rel1 && rel1.love === 0, JSON.stringify(rel1));
  ok('upsertRelation 首次插入 first_at/last_at > 0', !!rel1 && rel1.first_at > 0 && rel1.last_at > 0, JSON.stringify(rel1));
  ok('upsertRelation 首次插入 moments=[]', !!rel1 && Array.isArray(rel1.moments) && rel1.moments.length === 0, JSON.stringify(rel1 && rel1.moments));
  ok('upsertRelation 空 pid / 非字符串 pid 返回 null 且不落库', db.upsertRelation({ pid: '   ' }) === null && db.upsertRelation({}) === null && db.upsertRelation({ pid: 123 }) === null);
  ok('getRelation 查不到返回 null', db.getRelation('rel:not-exist') === null);

  // 11) 关系系统 · loveDelta 的 clamp 与封顶
  let rel2 = db.upsertRelation({ pid: 'rel:2', loveDelta: 99 });
  ok('loveDelta +99 被 clamp 到 +10', !!rel2 && rel2.love === 10, JSON.stringify(rel2 && rel2.love));
  rel2 = db.upsertRelation({ pid: 'rel:2', loveDelta: -99 });
  ok('loveDelta -99 被 clamp 到 -10（触底 0）', !!rel2 && rel2.love === 0, JSON.stringify(rel2 && rel2.love));
  for (let i = 0; i < 20; i++) db.upsertRelation({ pid: 'rel:3', loveDelta: 99 });
  ok('连点 20 次 +99 封顶在 100', db.getRelation('rel:3').love === 100, String(db.getRelation('rel:3').love));
  rel2 = db.upsertRelation({ pid: 'rel:3', loveDelta: -99 });
  ok('封顶后一次 -99 降到 90（不越界）', !!rel2 && rel2.love === 90, JSON.stringify(rel2 && rel2.love));
  rel2 = db.upsertRelation({ pid: 'rel:3', loveDelta: 'abc' });
  ok('loveDelta 非数字当 0（love 不变）', !!rel2 && rel2.love === 90, JSON.stringify(rel2 && rel2.love));

  // 12) 关系系统 · 第二次只传 note 不能覆盖既有字段
  db.upsertRelation({ pid: 'rel:4', name: '甲', stage: '暧昧期', petName: '小甲', moment: '第一次见面', loveDelta: 5 });
  const relBefore = db.getRelation('rel:4');
  const relAfter = db.upsertRelation({ pid: 'rel:4', note: 'x' });
  ok('只传 note：love/stage/pet_name/moments/first_at 都不变', !!relAfter &&
    relAfter.love === relBefore.love && relAfter.stage === relBefore.stage && relAfter.pet_name === relBefore.pet_name &&
    relAfter.first_at === relBefore.first_at && JSON.stringify(relAfter.moments) === JSON.stringify(relBefore.moments),
    JSON.stringify(relAfter));
  ok('只传 note：note 被写上', !!relAfter && relAfter.note === 'x', JSON.stringify(relAfter && relAfter.note));
  ok('只传 note：last_at 不倒退', !!relAfter && relAfter.last_at >= relBefore.last_at, JSON.stringify({ b: relBefore.last_at, a: relAfter.last_at }));

  // 13) 关系系统 · petName / stage 的「清空 / 保留 / 覆盖 / 截断」
  db.upsertRelation({ pid: 'rel:5', petName: '小甜甜' });
  ok('petName 传新值覆盖', db.getRelation('rel:5').pet_name === '小甜甜');
  db.upsertRelation({ pid: 'rel:5', petName: '无' });
  ok('petName 传「无」清空', db.getRelation('rel:5').pet_name === '');
  db.upsertRelation({ pid: 'rel:5', petName: '小甜甜' });
  db.upsertRelation({ pid: 'rel:5', petName: '' });
  ok('petName 传空串保留原值', db.getRelation('rel:5').pet_name === '小甜甜');
  db.upsertRelation({ pid: 'rel:5', promise: '一起看番' });
  db.upsertRelation({ pid: 'rel:5', promise: 'NONE' });
  ok('promise 传 NONE（忽略大小写）清空', db.getRelation('rel:5').promise === '');
  db.upsertRelation({ pid: 'rel:5', stage: '阶'.repeat(30) });
  ok('stage 截断到 20 字', db.getRelation('rel:5').stage.length === 20, String(db.getRelation('rel:5').stage.length));

  // 14) 关系系统 · moments 追加 / 去重 / 只留 12 条
  for (let i = 0; i < 15; i++) db.upsertRelation({ pid: 'rel:6', moment: '回忆' + i });
  let relMoments = db.getRelation('rel:6').moments;
  ok('moments 只保留最新 12 条', relMoments.length === 12, String(relMoments.length));
  ok('moments 保留的是最后 12 条', relMoments[0].text === '回忆3' && relMoments[11].text === '回忆14', JSON.stringify(relMoments.map((m) => m.text)));
  ok('moments 每条都带 at 时间戳', relMoments.every((m) => typeof m.at === 'number' && m.at > 0), JSON.stringify(relMoments[0]));
  db.upsertRelation({ pid: 'rel:6', moment: '回忆14' });
  relMoments = db.getRelation('rel:6').moments;
  ok('连续追加相同文本不重复', relMoments.length === 12 && relMoments[11].text === '回忆14', JSON.stringify(relMoments.length));
  db.db.prepare('UPDATE relations SET moments = ? WHERE pid = ?').run('不是 JSON', 'rel:6');
  ok('moments 坏 JSON 读出来是 []（不抛）', Array.isArray(db.getRelation('rel:6').moments) && db.getRelation('rel:6').moments.length === 0);

  // 15) 关系系统 · up_count 只在正 delta 时 +1
  const upA = db.upsertRelation({ pid: 'rel:7', loveDelta: -3 });
  ok('首次插入只传负 delta：up_count=0', !!upA && upA.up_count === 0, JSON.stringify(upA && upA.up_count));
  const upB = db.upsertRelation({ pid: 'rel:7', loveDelta: 3 });
  ok('传正 delta：up_count +1', !!upB && upB.up_count === 1, JSON.stringify(upB && upB.up_count));
  const upC = db.upsertRelation({ pid: 'rel:7', note: '再来' });
  ok('不传 delta：up_count 不变', !!upC && upC.up_count === 1, JSON.stringify(upC && upC.up_count));

  // 16) 关系系统 · listRelations 排序与 minLove 过滤
  db.upsertRelation({ pid: 'rel:list:a', loveDelta: 5 });
  db.upsertRelation({ pid: 'rel:list:b', loveDelta: 10 });
  db.upsertRelation({ pid: 'rel:list:c', loveDelta: 10 });
  db.upsertRelation({ pid: 'rel:list:d' });
  // 同 love 时看 last_at；两次插入可能在同一毫秒，这里把时间戳钉死才有确定顺序。
  db.db.prepare('UPDATE relations SET last_at = ? WHERE pid = ?').run(5000, 'rel:list:b');
  db.db.prepare('UPDATE relations SET last_at = ? WHERE pid = ?').run(9000, 'rel:list:c');
  const ranked = db.listRelations({ limit: 100 }).filter((r) => r.pid.indexOf('rel:list:') === 0);
  ok('listRelations 按 love 降序', ranked.map((r) => r.love).join(',') === '10,10,5,0', JSON.stringify(ranked.map((r) => [r.pid, r.love])));
  ok('listRelations 同 love 按 last_at 降序', ranked[0].pid === 'rel:list:c' && ranked[1].pid === 'rel:list:b', JSON.stringify(ranked.map((r) => r.pid)));
  const allRel = db.listRelations({ limit: 100 });
  const filteredRel = db.listRelations({ minLove: 6, limit: 100 });
  ok('listRelations minLove 只留 love >= 6', filteredRel.length === allRel.filter((r) => r.love >= 6).length && filteredRel.every((r) => r.love >= 6), JSON.stringify(filteredRel.map((r) => r.love)));

  // 17) 关系系统 · relationsFor 批量取
  const relMap = db.relationsFor(['rel:1', 'rel:list:b', 'rel:不存在']);
  ok('relationsFor 只返回存在的 pid', Object.keys(relMap).length === 2 && !!relMap['rel:1'] && !!relMap['rel:list:b'] && !relMap['rel:不存在'], JSON.stringify(Object.keys(relMap)));
  ok('relationsFor 的行里 moments 是数组', Array.isArray(relMap['rel:1'].moments), JSON.stringify(relMap['rel:1'].moments));
  ok('relationsFor 空数组返回 {}', Object.keys(db.relationsFor([])).length === 0);

  // 18) 口癖画像 styleProfile（纯读、结构化、带缓存）
  // 语料是精心排的：咕噜 8 条、好啦好啦 6 条（另有 1 条只说「好啦」，用来验证冗余抑制）、
  // 「嗯嗯。」4 条做句尾、喵喵 2 条做"条数不够"的反例、什么 4 条做停用词反例。
  const SELF_CORPUS = [
    '今天好想摸鱼咕噜', '明天也要加油咕噜', '这个番真好看咕噜', '肚子有点饿了咕噜',
    '早点休息吧咕噜', '外面风好大咕噜', '刚刚打了个盹咕噜', '晚上想吃面咕噜',
    '好啦好啦这就去', '好啦好啦别催了', '好啦好啦本鲸知道了', '好啦好啦马上就来',
    '好啦好啦马上马上', '好啦好啦放心啦', '行吧好啦',
    '知道了嗯嗯。', '明白了嗯嗯。', '真行嗯嗯。', '可以的嗯嗯。',
    '喵喵快看我', '喵喵在这儿',
    '你在说什么呢', '今天吃什么好呢', '什么番好看呢', '这到底是什么呀',
    '  本鲸超厉害的  ', '  摸鱼最快乐  ',
    '雨停了云散了', '窗外的风很凉', '泡杯热茶暖暖手', '键盘敲得飞快', '屏幕亮度调低了',
    '耳机里放着老歌', '桌上的杯子空了', '写完这段就睡', '楼下的猫在叫', '路灯有点昏黄',
    '背包还挂在椅背', '闹钟设了七点', '阳台的花开了'
  ];
  ok('styleProfile 没有自发消息时返回 null', db2.styleProfile() === null);
  const corpusAt = 1700000000000;
  SELF_CORPUS.forEach((t, i) => { db2.recordSelfMessages('private:9', [t], corpusAt + i * 1000); });
  ok('语料落库 40 条自发消息', db2.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE is_self = 1').get().c === 40);
  const p1 = db2.styleProfile();
  const expectedAvg = Math.round(SELF_CORPUS.map((t) => t.trim()).reduce((a, t) => a + t.length, 0) / SELF_CORPUS.length * 10) / 10;
  ok('styleProfile count = 40', !!p1 && p1.count === 40, JSON.stringify(p1));
  ok('styleProfile avgLen 去掉首尾空白后保留 1 位小数', !!p1 && p1.avgLen === expectedAvg, JSON.stringify({ got: p1 && p1.avgLen, want: expectedAvg }));
  ok('styleProfile top 含口头禅「咕噜」', !!p1 && p1.top.indexOf('咕噜') >= 0, JSON.stringify(p1 && p1.top));
  ok('styleProfile top 含「好啦好啦」', !!p1 && p1.top.indexOf('好啦好啦') >= 0, JSON.stringify(p1 && p1.top));
  ok('styleProfile top 不含「好啦」（被更长的「好啦好啦」吃掉）', !!p1 && p1.top.indexOf('好啦') < 0, JSON.stringify(p1 && p1.top));
  ok('styleProfile top 不含停用词「什么」', !!p1 && p1.top.indexOf('什么') < 0, JSON.stringify(p1 && p1.top));
  ok('styleProfile top 不含只出现 2 条的「喵喵」', !!p1 && p1.top.indexOf('喵喵') < 0, JSON.stringify(p1 && p1.top));
  ok('styleProfile top 最多 3 个且都是非空字符串', !!p1 && p1.top.length > 0 && p1.top.length <= 3 && p1.top.every((x) => typeof x === 'string' && x.length >= 2), JSON.stringify(p1 && p1.top));
  ok('styleProfile tails 含句尾「咕噜」', !!p1 && p1.tails.indexOf('咕噜') >= 0, JSON.stringify(p1 && p1.tails));
  ok('styleProfile tails 含带标点的句尾「嗯嗯。」', !!p1 && p1.tails.indexOf('嗯嗯。') >= 0, JSON.stringify(p1 && p1.tails));
  ok('styleProfile tails 不含只出现 2 条的「喵喵」', !!p1 && p1.tails.indexOf('喵喵') < 0, JSON.stringify(p1 && p1.tails));

  // 缓存：绕开 recordSelfMessages 直接往表里塞 10 条，数据变了但 gen 没变 ⇒ 应命中缓存
  const rawIns = db2.db.prepare('INSERT INTO messages (key, seq, message_id, user_id, sender, is_self, kind, text, at, day) VALUES (?, NULL, NULL, NULL, ?, 1, ?, ?, ?, ?)');
  for (let i = 0; i < 10; i++) rawIns.run('private:9', '我', 'text', '缓存缓存缓存', corpusAt + 500000 + i * 1000, '2023-11-15');
  const p2 = db2.styleProfile();
  ok('styleProfile 缓存命中（表里多了 10 条仍返回旧画像）', !!p2 && JSON.stringify(p2) === JSON.stringify(p1), JSON.stringify({ p2, p1 }));
  db2.recordSelfMessages('private:9', ['刚写的一句'], corpusAt + 900000);
  const p3 = db2.styleProfile();
  ok('styleProfile 走写入口后缓存失效（count 变 51）', !!p3 && p3.count === 51, JSON.stringify(p3 && p3.count));
  const p4 = db2.styleProfile({ limit: 1 });
  ok('styleProfile limit 1 被 clamp 到 50', !!p4 && p4.count === 50, JSON.stringify(p4 && p4.count));
  ok('styleProfile limit 99999 被 clamp 到 2000', db2.styleProfile({ limit: 99999 }).count === 51);

  // 异常路径：把表删掉，styleProfile 必须吞掉异常返回 null（日志里留一句），绝不抛给调用方
  db2.db.exec('DROP TABLE messages');
  ok('styleProfile 表坏掉时返回 null 且不抛', db2.styleProfile() === null && cacheLogs.some((l) => l.indexOf('styleProfile failed') >= 0), JSON.stringify(cacheLogs));

  // 19) 情绪事件 recordMoodEvent（复用 events 表，kind = "mood:<mood>"）
  const t0 = 1800000000000;
  ok('recordMoodEvent 非法 mood 返回 null', db2.recordMoodEvent({ at: t0, mood: 'angry', summary: '气死了' }) === null);
  ok('recordMoodEvent 非法 mood 不落库', db2.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind LIKE 'mood:%'").get().c === 0);
  ok('recordMoodEvent 空 summary 返回 null', db2.recordMoodEvent({ at: t0, mood: 'sad', summary: '   ' }) === null);
  const moodSad = db2.recordMoodEvent({ at: t0 + 1000, key: 'private:9', mood: 'sad', summary: '被说破防了', participants: ['1000'] });
  ok('recordMoodEvent 合法 mood 落库且 kind = mood:sad', !!moodSad && moodSad.kind === 'mood:sad' && moodSad.mood === 'sad' && moodSad.summary === '被说破防了', JSON.stringify(moodSad));
  const moodLong = db2.recordMoodEvent({ at: t0 + 2000, mood: 'happy', summary: '长'.repeat(300) });
  ok('recordMoodEvent summary 超长截到 160（返回值）', !!moodLong && moodLong.summary.length === 160, String(moodLong && moodLong.summary.length));
  ok('recordMoodEvent summary 超长截到 160（落库值）', db2.db.prepare("SELECT summary FROM events WHERE kind = 'mood:happy'").get().summary.length === 160);

  // 20) 情绪事件 recentMoodEvents（倒序 / sinceMs / mood / limit）
  const base = t0 + 100000;
  for (let i = 0; i < 7; i++) db2.recordMoodEvent({ at: base + i * 1000, key: 'private:9', mood: i % 2 ? 'calm' : 'happy', summary: '情绪' + i });
  const recentDefault = db2.recentMoodEvents();
  ok('recentMoodEvents 默认 limit = 5', recentDefault.length === 5, String(recentDefault.length));
  ok('recentMoodEvents 时间倒序（最新是 base+6000）', recentDefault[0].at === base + 6000 && recentDefault.every((r, i) => i === 0 || recentDefault[i - 1].at > r.at), JSON.stringify(recentDefault.map((r) => r.at)));
  const sinceList = db2.recentMoodEvents({ sinceMs: base + 3000, limit: 50 });
  ok('recentMoodEvents sinceMs 只留之后的', sinceList.length === 4 && sinceList.every((r) => r.at >= base + 3000), JSON.stringify(sinceList.map((r) => r.at)));
  const calmList = db2.recentMoodEvents({ mood: 'calm', limit: 50 });
  ok('recentMoodEvents mood 精确过滤', calmList.length === 3 && calmList.every((r) => r.mood === 'calm'), JSON.stringify(calmList.map((r) => r.mood)));
  ok('recentMoodEvents limit 999 被 clamp 到 50（共 9 条全返回）', db2.recentMoodEvents({ limit: 999 }).length === 9, String(db2.recentMoodEvents({ limit: 999 }).length));
  ok('recentMoodEvents limit = 0 退回默认 5', db2.recentMoodEvents({ limit: 0 }).length === 5);
  ok('recentMoodEvents participants 解析成数组', JSON.stringify(db2.recentMoodEvents({ limit: 50 }).find((r) => r.mood === 'sad').participants) === '["1000"]');
  const dirtyIns = db2.db.prepare('INSERT INTO events (at, key, kind, summary, participants) VALUES (?, ?, ?, ?, ?)');
  dirtyIns.run(base + 7000, 'private:9', 'mood:', '空 mood', '[]');
  dirtyIns.run(base + 8000, 'private:9', 'mood:weird', '脏 mood', '[]');
  const afterDirty = db2.recentMoodEvents({ limit: 50 });
  const MOODS = ['happy', 'excited', 'calm', 'tired', 'sleepy', 'sad', 'annoyed'];
  ok('kind 解析不出合法 mood 的行被跳过', afterDirty.length === 9 && afterDirty.every((r) => MOODS.indexOf(r.mood) >= 0), JSON.stringify(afterDirty.map((r) => r.mood)));

  // 21) 情绪事件的 500 条上限：只清 mood 自己的，绝不碰别的 events
  const flood = db2.db.prepare('INSERT INTO events (at, key, kind, summary, participants) VALUES (?, ?, ?, ?, ?)');
  db2.db.exec('BEGIN');
  for (let i = 0; i < 500; i++) flood.run(t0 - 1000000 + i, 'private:9', 'mood:calm', '旧情绪' + i, '[]');
  db2.db.exec('COMMIT');
  db2.db.prepare("INSERT INTO events (at, key, kind, summary, participants) VALUES (?, ?, 'note', ?, '[]')").run(t0, 'private:9', '别删我');
  const otherBefore = db2.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'note'").get().c;
  const moodWrote = db2.recordMoodEvent({ at: base + 99999, mood: 'excited', summary: '新的情绪' });
  const moodCount = db2.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind LIKE 'mood:%'").get().c;
  const otherAfter = db2.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'note'").get().c;
  ok('mood 事件超过 500 条时只留最新 500 条', !!moodWrote && moodCount === 500, JSON.stringify({ wrote: !!moodWrote, moodCount }));
  ok('mood 清理删掉的是最旧那条', db2.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'mood:calm' AND at = ?").get(t0 - 1000000).c === 0);
  ok('mood 清理保留最新的旧 mood', db2.db.prepare('SELECT COUNT(*) AS c FROM events WHERE at = ?').get(t0 - 1000000 + 499).c === 1);
  ok('mood 清理不碰非 mood 事件', otherBefore >= 1 && otherAfter === otherBefore, JSON.stringify({ otherBefore, otherAfter }));
} finally {
  db.close();
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log(pass + ' 项通过' + (fail ? '，' + fail + ' 项失败' : '，全部通过'));
process.exit(fail ? 1 : 0);
