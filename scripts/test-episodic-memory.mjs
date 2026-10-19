// 超长记忆库（情景记忆层）自检：node scripts/test-episodic-memory.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLongMemory, localDayString, extractKeywords, scoreImportance } from '../src/long-memory.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('✅ ' + name); }
  else { fail++; console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'longmem-'));
const file = path.join(dir, 'long.db');
const db = createLongMemory({ file, log: () => {} });
const db2 = createLongMemory({ file: path.join(dir, 'log.db'), log: () => {} });

try {
  // 1) 日期助手：本地时区字符串
  ok('localDayString 返回 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(localDayString(0)));
  ok('昨天 = 今天减一天', localDayString(1) !== localDayString(0));

  // 2) 固化：普通闲聊天 → 重要性 1；条数太少不记
  const day1 = localDayString(10);
  const r1 = db.consolidateDay('group:2000', day1, {
    messages: Array.from({ length: 12 }, (_, i) => ({ sender: ['纱雾酱', '阿明'][i % 2], is_self: false, text: `今天聊原神第${i}话`, at: Date.now() - i * 60000 })),
    facts: [], events: []
  });
  ok('固化普通闲聊天', r1 && r1.importance === 1, JSON.stringify(r1));
  ok('条数 <3 的天不固化', db.consolidateDay('group:2000', localDayString(9), { messages: [{ sender: 'a', is_self: false, text: '嗨' }], facts: [], events: [] }) === null);

  // 3) 幂等：同 key+day 重跑覆盖（episodes 仍只有一条，且内容更新）
  db.consolidateDay('group:2000', day1, {
    messages: Array.from({ length: 12 }, (_, i) => ({ sender: '纱雾酱', is_self: false, text: `改口：聊的是星穹铁道${i}`, at: Date.now() - i * 60000 })),
    facts: ['纱雾酱喜欢星穹铁道'], events: []
  });
  const s = db.stats();
  ok('同 key+day 幂等覆盖', s.episodes === 1, JSON.stringify(s));

  // 4) 重要性：事件/事实里出现约定 → 3；聊天原文明显冲突 → 3；有事实 → 2；
  //    聊天原文的「下次/明天」太常见不升级（防 500 条消息的日常天全部 imp3）
  ok('事件里的约定 → 重要性 3', scoreImportance({ messages: [{ text: '随便聊聊' }], facts: [], events: [{ kind: 'promise', summary: '约好周末一起看电影' }] }) === 3);
  ok('聊天原文明显冲突 → 重要性 3', scoreImportance({ messages: [{ text: '我们吵架了' }, { text: '对不起，是我不好' }], facts: [] }) === 3);
  ok('聊天原文的「下次」不升级', scoreImportance({ messages: [{ text: '说好了下次一起玩' }], facts: [] }) === 1);
  ok('有事实 → 重要性 2', scoreImportance({ messages: [{ text: '随便聊聊' }], facts: ['爱喝奶茶'] }) === 2);

  // 5) 检索：来信关键词命中旧 episode；不相关的不出
  const hit = db.recall({ key: 'group:2000', queryText: '星穹铁道新版本你们抽卡了吗' });
  ok('关键词命中旧情景', hit.includes('【很久以前】') && hit.includes('星穹铁道'), hit.slice(0, 80));
  const miss = db.recall({ key: 'group:2000', queryText: '今天天气怎么样' });
  ok('完全无关的来信不出记忆', miss === '', JSON.stringify(miss));

  // 6) 时间衰减：同样的关键词命中，更近的 episode 排在更前
  const dayNear = localDayString(5), dayFar = localDayString(80);
  db.consolidateDay('group:3000', dayNear, {
    messages: Array.from({ length: 8 }, (_, i) => ({ sender: '小明', is_self: false, text: `聊塞尔达传说第${i}天`, at: Date.now() - i * 60000 })), facts: [], events: []
  });
  db.consolidateDay('group:3000', dayFar, {
    messages: Array.from({ length: 8 }, (_, i) => ({ sender: '小明', is_self: false, text: `也在聊塞尔达传说第${i}话`, at: Date.now() - i * 60000 })), facts: [], events: []
  });
  const ranked = db.recall({ key: 'group:3000', queryText: '塞尔达传说好玩吗' });
  const md = (d) => d.slice(5).replace('-', '月') + '日';
  const nearIdx = ranked.indexOf(md(dayNear)), farIdx = ranked.indexOf(md(dayFar));
  ok('更近的情景排在更前', nearIdx >= 0 && nearIdx < farIdx, `near=${nearIdx} far=${farIdx}\n${ranked}`);

  // 7) 去年的今天：同 MM-DD、≥300 天前的 episode 会被特殊提起
  const now = new Date();
  const lastYear = `${now.getFullYear() - 1}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  db.consolidateDay('private:4000', lastYear, {
    messages: Array.from({ length: 8 }, (_, i) => ({ sender: '主人', is_self: false, text: `去年今天聊生日蛋糕第${i}句`, at: new Date(lastYear + 'T12:00:00').getTime() + i * 60000 })), facts: [], events: []
  });
  const flash = db.recall({ key: 'private:4000', queryText: '随便说点什么' });
  ok('去年的今天被时间感知提起', flash.includes('去年的今天'), flash.slice(0, 100));

  // 8) 遗忘：imp1 过 keepDays 删、imp2 留、imp3 永不删
  const keepDays = 120;
  const oldImp1 = localDayString(keepDays + 5);
  const oldImp2 = localDayString(keepDays + 5);
  const oldImp3 = localDayString(keepDays + 5);
  db.consolidateDay('group:5000', oldImp1, { messages: Array.from({ length: 5 }, (_, i) => ({ sender: 'a', is_self: false, text: `普通闲聊${i}`, at: 0 })), facts: [], events: [] });
  db.consolidateDay('group:5001', oldImp2, { messages: Array.from({ length: 5 }, (_, i) => ({ sender: 'a', is_self: false, text: `聊天${i}`, at: 0 })), facts: ['学了新梗'], events: [] });
  db.consolidateDay('group:5002', oldImp3, { messages: Array.from({ length: 5 }, (_, i) => ({ sender: 'a', is_self: false, text: `聊天${i}`, at: 0 })), facts: [], events: [{ kind: 'promise', summary: '答应了主人周末一起看电影' }] });
  const removed = db.prune({ keepDays });
  ok('过期 imp1 被清理（至少 1 条）', removed >= 1, `removed=${removed}`);
  ok('imp3（有约定）不被清理', db.hasEpisode('group:5002', oldImp3));
  ok('imp2 未到期不被清理', db.hasEpisode('group:5001', oldImp2));

  // 9) 预算截断：maxChars 很小时只保留一部分行
  const tiny = db.recall({ key: 'group:3000', queryText: '塞尔达传说', maxChars: 80 });
  ok('预算截断生效（≤80 字 + 标签）', tiny === '' || tiny.length <= 140, `len=${tiny.length}`);

  // 10) 关键词提取：停用词不进、英文小写化
  const kws = extractKeywords(['这个真的太好玩了 hello World', '真的好玩', 'hello world 是梗']);
  ok('停用词被过滤', !kws.includes('这个') && !kws.includes('真的'), JSON.stringify(kws));
  ok('英文小写化', kws.includes('hello'), JSON.stringify(kws));

  // 11) 每条 episode 的 summary 有上限（不撑爆注入预算）
  db2.consolidateDay('group:6000', localDayString(3), {
    messages: Array.from({ length: 40 }, (_, i) => ({ sender: '长名字' + i, is_self: false, text: `很长的消息内容重复很多遍很长的消息内容重复很多遍第${i}条`, at: Date.now() - i * 60000 })), facts: [], events: []
  });
  const longEp = db2.db.prepare('SELECT summary FROM episodes').get();
  ok('summary ≤ 260 字', longEp && longEp.summary.length <= 261, `len=${longEp?.summary?.length}`);
} finally {
  db.close();
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
