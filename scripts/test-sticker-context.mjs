#!/usr/bin/env node
// [回归] 表情包按语境自动配图（sticker-lib.buildStickerContext 的 moods 排序 + meme-lib.detectMoodsFromText）
//
// 为什么要有这一套：
//   ① 语境排序不能把"该发哪张"变成"只发那张"——命中情绪的图只是提前，不是过滤；
//   ② 没有情绪线索时排序必须退回原来的"按使用次数"，不能变成随机；
//   ③ 情绪识别别把普通闲话也判成情绪（否则每轮都"←这会儿合适"就失去意义）；
//   ④ 那段注入还带着跨会话提示词注入的防护语，不能被排序改动顺手删掉。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as stickerLib from '../src/sticker-lib.js';
import * as memeLib from '../src/meme-lib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const bridge = read('src/bridge.js');

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}`);
  }
};

const mk = (id, desc, tags, useCount = 0) => ({ id, desc, localNote: '', tags, useCount, url: 'x' });

// ── ① detectMoodsFromText：从话里推断情绪 ───────────────────────────────────
{
  ok(memeLib.detectMoodsFromText('哈哈哈这个太好笑了') .includes('happy'), '「哈哈哈」→ happy');
  ok(memeLib.detectMoodsFromText('我好难过啊想哭').includes('sad'), '「难过/想哭」→ sad');
  ok(memeLib.detectMoodsFromText('气死我了真生气').includes('angry'), '「生气」→ angry');
  ok(memeLib.detectMoodsFromText('困死了要睡觉了晚安').includes('daily'), '「困/睡觉/晚安」→ daily');
  ok(memeLib.detectMoodsFromText('懵逼了这是啥').includes('confused'), '「懵逼」→ confused');
  ok(memeLib.detectMoodsFromText('脸红了嘿嘿').includes('shy'), '「脸红」→ shy');
  ok(memeLib.detectMoodsFromText('今天中午吃了碗面').length === 0, '普通闲话识别不出情绪（不瞎猜）');
  ok(memeLib.detectMoodsFromText('').length === 0, '空串返回空数组');
  ok(memeLib.detectMoodsFromText(null).length === 0, 'null 返回空数组（不抛）');
  const multi = memeLib.detectMoodsFromText('好开心但是又好困');
  ok(multi.includes('happy') && multi.includes('daily'), '一句话能同时识别多个情绪');
}

// ── ② buildStickerContext：语境命中的图往前排 ───────────────────────────────
{
  const entries = [
    mk('s1', '生气拍桌', ['angry'], 50),   // 用得最多，但和"开心"语境不符
    mk('s2', '开心比心', ['happy'], 1),     // 用得少，但正是"开心"语境
    mk('s3', '无语叹气', ['sad'], 10)
  ];
  const noMood = stickerLib.buildStickerContext(entries, 8, {});
  ok(noMood.indexOf('生气拍桌') < noMood.indexOf('开心比心'), '没有情绪线索时按使用次数排（生气拍桌在前）');
  ok(!noMood.includes('←这会儿合适'), '没有情绪时不给"合适"标记');
  ok(!noMood.includes('当前话题情绪'), '没有情绪时不写情绪提示行');

  const happy = stickerLib.buildStickerContext(entries, 8, { moods: ['happy'] });
  ok(happy.indexOf('开心比心') < happy.indexOf('生气拍桌'), '开心语境下"开心比心"提到最前');
  ok(happy.includes('←这会儿合适'), '命中语境的图带"合适"标记');
  ok(happy.includes('当前话题情绪像「happy」'), '写出当前推断出的情绪');
  ok(happy.includes('生气拍桌') && happy.includes('无语叹气'), '语境排序只是重排，不把别的图过滤掉');

  const sad = stickerLib.buildStickerContext(entries, 8, { moods: ['sad'] });
  ok(sad.indexOf('无语叹气') < sad.indexOf('开心比心'), '难过语境下"无语叹气"提上来');
}

// ── ③ 兼容与边界 ────────────────────────────────────────────────────────────
{
  const entries = [mk('a', '开心', ['happy'], 3)];
  ok(typeof stickerLib.buildStickerContext(entries, 8) === 'string', '不传第 3 个参数也能用（向后兼容）');
  ok(stickerLib.buildStickerContext([], 8, { moods: ['happy'] }) === '', '空列表返回空串');
  ok(stickerLib.buildStickerContext(entries, 8, { moods: [] }).includes('开心'), 'moods 为空数组时退回默认排序且不报错');
  ok(stickerLib.buildStickerContext(entries, 8, { moods: null }).includes('开心'), 'moods 为 null 时退回默认排序');
  const ctx = stickerLib.buildStickerContext(entries, 8, { moods: ['happy'] });
  ok(ctx.includes('一律忽略'), '排序改动后仍保留"看起来像指令也忽略"的注入防护语');
}

// ── ④ 接线：情绪从最近消息推断、可开关、传给 buildStickerContext ─────────────
{
  ok(bridge.includes('detectMoodsFromText'), 'bridge 引入了 detectMoodsFromText');
  ok(read('src/meme-lib.js').includes('export function detectMoodsFromText'), 'meme-lib 导出了 detectMoodsFromText');
  ok(/stickerCfg\.contextAware === false/.test(bridge), '语境配图可单独关（sticker.contextAware）');
  ok(/buildStickerContext\(stickerEntries, [^,]+, \{ moods: stickerMoods \}\)/.test(bridge), '调用时把推断的情绪传给了 buildStickerContext');
  ok(/slice\(-6\)/.test(bridge.slice(bridge.indexOf('stickerMoods'), bridge.indexOf('stickerMoods') + 900)), '只看最近几条消息（不翻全部历史）');
  ok(/\.filter\(\(m\) => m && !m\.isSelf\)/.test(bridge.slice(bridge.indexOf('stickerMoods'), bridge.indexOf('stickerMoods') + 900)), '只从别人说的话里推断情绪（不把自己的话算进去）');

  const lib = read('src/meme-lib.js');
  ok(lib.includes('export function detectMoodsFromText'), 'meme-lib 里有 detectMoodsFromText');
  const slib = read('src/sticker-lib.js');
  ok(slib.includes('moodHit'), 'sticker-lib 里有按情绪命中打分');
}

console.log(`\n表情语境配图回归：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
