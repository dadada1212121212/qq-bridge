// 回合制小游戏核心逻辑。状态全部由调用方（bridge.js）持有在 st.turnGame，
// 本模块只负责「算出下一状态 + 渲染文案」，不碰存储、不碰网络、不碰鉴权。
//
// 为什么做成「服务端持状态」而不是让模型自己记：
//   1. 猜数字的答案/海龟汤的汤底如果放进提示词，模型会忍不住剧透；
//   2. 跨多条消息保持局面，模型不必在每轮把整局历史重新塞进上下文。
//
// 三个游戏：
//   guess  —— 我随机一个数让你猜（答案只在服务端，模型看不到）
//   twenty —— 你心里想一个东西，我来问 yes/no（模型驱动，工具只记账 + 数到 20）
//   soup   —— 我出题面，你问 yes/no，我按汤底答（汤底只在内部给模型判断用）

import { randomInt } from 'crypto';

// 海龟汤内置题库（汤面 surface + 汤底 bottom）。bot 当主持人。
const SOUP_PUZZLES = [
  {
    surface: '一个男人走进酒吧，向酒保要了一杯水。酒保却掏出一把枪指着他。男人说了声"谢谢"就走了。',
    bottom: '男人一直在打嗝，他本来是要水来止嗝。酒保用枪指着他是想吓他一跳把嗝止住——男人发现这招更管用，所以道谢走了。'
  },
  {
    surface: '一个女人回到家里，关了灯，睡了一觉。第二天醒来，她看向窗外，惊恐地跳楼自杀了。',
    bottom: '她是灯塔看守人的妻子。关灯导致一艘船撞礁沉没，她醒来看到海难现场，愧疚自杀。（经典海龟汤）'
  },
  {
    surface: '弟弟和哥哥在沙漠里迷路，哥哥死了。弟弟在沙上写下哥哥的名字，然后往反方向走，获救了。',
    bottom: '弟弟把哥哥的名字写成 SOS——从特定方向看是求救信号，搜救队因此找到并救了他。'
  },
  {
    surface: '一个人报案说自家被洗劫一空，警察赶到却看到满屋子的水和碎玻璃，那个人却笑了。',
    bottom: '他养的金鱼缸被打碎了，水是鱼缸里的。他笑是因为之前总被说"你家穷得只剩鱼缸"，这下连鱼缸都没了，反而释然。'
  }
];

// 成语接龙内置词库（用于校验与开题）。按首字索引，便于查一条"能接上"的成语。
// 只收常见四字成语，够接龙用；不是词典，不做权威性保证。
const IDIOM_POOL = [
  '一心一意', '意气风发', '发扬光大', '大器晚成', '成千上万', '万众一心',
  '心花怒放', '放虎归山', '山清水秀', '秀色可餐', '餐风露宿', '宿雨餐风',
  '风调雨顺', '顺手牵羊', '羊肠小道', '道听途说', '说三道四', '四海为家',
  '家喻户晓', '晓以大义', '义不容辞', '辞旧迎新', '新陈代谢', '谢天谢地',
  '地大物博', '博采众长', '长驱直入', '入木三分', '分道扬镳', '镳不及舌',
  '舌灿莲花', '花好月圆', '圆满成功', '功成名就', '就地取材', '材大难用',
  '用武之地', '地久天长', '长年累月', '月明星稀', '稀奇古怪', '怪诞不经',
  '经天纬地', '地动山摇', '摇头晃脑', '脑满肠肥', '肥头大耳', '耳聪目明',
  '明察秋毫', '毫不犹豫', '豫备不虞', '虞诈我欺', '欺上瞒下', '下不为例',
];

/** 找出所有以 ch 开头的成语。 */
function idiomsStartingWith(ch) {
  return IDIOM_POOL.filter((w) => w[0] === ch);
}

export function startTurnGame({ game, max = 100, puzzleIndex = null, start = null } = {}) {
  const now = Date.now();
  if (game === 'guess') {
    const m = Math.max(2, Math.min(1000000, Math.floor(Number(max) || 100)));
    const secret = randomInt(1, m + 1);
    const maxTries = Math.max(5, Math.ceil(Math.log2(m)) + 3);
    return { game: 'guess', startedAt: now, secret, max: m, maxTries, tries: 0, history: [], status: 'playing' };
  }
  if (game === 'twenty') {
    return { game: 'twenty', startedAt: now, maxQuestions: 20, questions: [], status: 'playing' };
  }
  if (game === 'soup') {
    const len = SOUP_PUZZLES.length;
    const idx = puzzleIndex == null
      ? randomInt(0, len)
      : ((Number(puzzleIndex) % len) + len) % len;
    const p = SOUP_PUZZLES[idx];
    return { game: 'soup', startedAt: now, puzzleIndex: idx, surface: p.surface, bottom: p.bottom, questions: [], status: 'playing' };
  }
  if (game === 'idiom') {
    // 成语接龙：给一个开头成语，之后每次 move 传新成语，校验它首字 == 上一个末字。
    // ⚠️ 不用「同音字也算」的宽松规则 —— 那需要拼音库，而且宽松规则在群里会引发
    //    "这也能算？"的争议。严格按字面首字匹配，规则清晰、谁都能自己验。
    let head = String(start || '').trim();
    if (!head) head = IDIOM_POOL[randomInt(0, IDIOM_POOL.length)];
    if (!/^[\u4e00-\u9fa5]{4}$/.test(head)) throw new Error('起始成语必须是 4 个汉字');
    return { game: 'idiom', startedAt: now, chain: [head], status: 'playing' };
  }
  throw new Error(`未知游戏类型：${game}（支持 guess 猜数字 / twenty 二十问 / soup 海龟汤 / idiom 成语接龙）`);
}

export function playTurnGame(state, { action = 'move', guess = null, question = null, answer = null } = {}) {
  if (action === 'state') return { ...state };
  if (!state || typeof state !== 'object') throw new Error('没有进行中的游戏，先用 action=start 开局');
  if (state.status !== 'playing') throw new Error(`这局已经结束了（${state.status}），用 action=start 开新的一局`);

  if (state.game === 'guess') {
    const n = Number(guess);
    if (!Number.isFinite(n)) throw new Error('guess 必须是数字');
    state.tries += 1;
    let cmp;
    if (n === state.secret) cmp = 'eq';
    else if (n < state.secret) cmp = 'low';
    else cmp = 'high';
    state.history.push({ guess: n, cmp });
    if (cmp === 'eq') state.status = 'won';
    else if (state.tries >= state.maxTries) state.status = 'lost';
    return state;
  }
  if (state.game === 'twenty') {
    const q = String(question ?? '').trim();
    if (!q) throw new Error('question 不能为空');
    const a = ['yes', 'no', 'unknown', 'na'].includes(String(answer)) ? String(answer) : 'unknown';
    state.questions.push({ q: q.slice(0, 200), a });
    if (state.questions.length >= state.maxQuestions) state.status = 'lost';
    return state;
  }
  if (state.game === 'soup') {
    const q = String(question ?? '').trim();
    if (!q) throw new Error('question 不能为空');
    const a = ['yes', 'no', 'unknown'].includes(String(answer)) ? String(answer) : 'unknown';
    state.questions.push({ q: q.slice(0, 200), a });
    return state;
  }
  if (state.game === 'idiom') {
    const word = String(guess ?? '').trim();
    if (!/^[\u4e00-\u9fa5]{4}$/.test(word)) throw new Error('要接的必须是 4 个汉字的成语');
    const last = state.chain[state.chain.length - 1];
    const need = last[last.length - 1];
    if (word[0] !== need) throw new Error(`接不上：上一个「${last}」的末字是「${need}」，你要接的得从「${need}」开头`);
    if (state.chain.includes(word)) throw new Error(`「${word}」这局已经用过了`);
    state.chain.push(word);
    if (state.chain.length >= 30) state.status = 'won';   // 接够 30 个算通关
    return state;
  }
  throw new Error(`不支持的游戏：${state.game}`);
}

export function renderTurnGame(state) {
  if (!state || typeof state !== 'object') return '（没有进行中的游戏）';
  if (state.game === 'guess') {
    const last = state.history[state.history.length - 1];
    const remain = state.maxTries - state.tries;
    if (state.status === 'won') return `🎉 猜中啦！答案就是 ${state.secret}，用了 ${state.tries} 次。`;
    if (state.status === 'lost') return `❌ 次数用完了，答案是 ${state.secret}。下次用二分法更快哦～`;
    const cmpText = !last ? '' :
      (last.cmp === 'low' ? `你猜 ${last.guess} → 太小了，往大猜` :
       last.cmp === 'high' ? `你猜 ${last.guess} → 太大了，往小猜` :
       `你猜 ${last.guess} → 中了`);
    return `【猜数字 1~${state.max}】${cmpText}（第 ${state.tries}/${state.maxTries} 次，剩 ${remain} 次）`;
  }
  if (state.game === 'twenty') {
    const n = state.questions.length;
    if (state.status === 'lost') return `🕐 20 问用完了！你心里想的是啥？揭晓吧～（已记录 ${n} 个问题）`;
    return `【二十问·你心里想一个东西，我来问】已问 ${n}/20 题。继续用 action=move 报下一题（question=你的问题, answer=yes/no/unknown）。`;
  }
  if (state.game === 'soup') {
    const n = state.questions.length;
    const tail = state.questions.slice(-1)[0];
    const lastQ = tail ? `上一题「${tail.q}」你答「${tail.a}」。` : '';
    // ⚠️ bottom 只在内部给模型判断用，模型绝不能主动告诉对方，除非对方说"揭晓/放弃"。
    return `【海龟汤】汤面：${state.surface}\n${lastQ}已问 ${n} 题。继续 action=move（question=问题, answer=yes/no/unknown）。\n【内部·汤底，仅你可见】${state.bottom}`;
  }
  if (state.game === 'idiom') {
    const last = state.chain[state.chain.length - 1];
    const need = last[last.length - 1];
    const chain = state.chain.join(' → ');
    if (state.status === 'won') return `🎉 接龙通关！一共接了 ${state.chain.length} 个：${chain}`;
    // 提示几个能接的候选，方便她在群里"提醒"一下（但别直接给答案，给思路）。
    const hints = idiomsStartingWith(need).slice(0, 2);
    const hintText = hints.length
      ? `（可接的比如「${hints[0]}」${hints[1] ? `「${hints[1]}」` : ''}——你心里有数就行，别急着报，看他能不能想出来）`
      : '（这个词库里没有以这个字开头的，可以宽松一点，或换开头重开）';
    return `【成语接龙】已接 ${state.chain.length} 个：${chain}\n下一句要以「${need}」开头。${hintText}`
      + `\n继续 action=move（guess=对方接的成语）。`;
  }
  return '（未知游戏状态）';
}
