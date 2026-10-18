#!/usr/bin/env node
// [回归] 她的小记与周报（bridge.js 的 [patch 日记] 块 + memory-db.js 的 diary 表）
//
// 为什么要有这一套：日记这条链路一旦错，错法都很隐蔽 ——
//   ① 日期算错 ⇒ 小记天天写两份，或者一周都不写一次；
//   ② 周号/星期算错 ⇒ 周报永远不触发（或者在错误的星期触发）；
//   ③ 看门狗绕过睡眠/高峰闸门 ⇒ 深夜把她叫起来写日记，白烧 token；
//   ④ 小记注错会话 ⇒ 主人私聊里的私人内容被带进群里。
//
// 这里尽量跑真代码：把 bridge.js 里的纯函数（日期、周号、时区钟、配置夹取）原样切出来
// 塞进 new Function，用假 Date 钉住时刻；接线部分直接查源码里的关键位置与顺序。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const bridge = read('src/bridge.js') + '\n' + read('src/console-server.js');
const memdb = read('src/memory-db.js');
const mcp = read('src/mcp-snowluma-safe.js');
const config = JSON.parse(read('config.json'));
const example = JSON.parse(read('config.example.json'));
const presetSrc = read('dsh/agent-presets/qq-chat-v2/agent.cordis.yml');
const presetPatch = read('plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml');

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

/** 按 2 空格缩进的函数声明切出源码（bridge.js 里大多写在 main() 内）。 */
function fnSrc(name) {
  const marker = `function ${name}(`;
  const i = bridge.indexOf(marker);
  if (i < 0) throw new Error(`bridge.js 里找不到 ${name}()`);
  const end = bridge.indexOf('\n  }', i);
  if (end < 0) throw new Error(`${name}() 的结束括号没找到`);
  return bridge.slice(i, end + 4);
}

/** 顶层（无缩进）函数：canonicalV2Key 这类写在 main() 外面。 */
function topFnSrc(name) {
  const marker = `function ${name}(`;
  const i = bridge.indexOf(marker);
  if (i < 0) throw new Error(`bridge.js 里找不到 ${name}()`);
  const end = bridge.indexOf('\n}', i);
  if (end < 0) throw new Error(`${name}() 的结束括号没找到`);
  return bridge.slice(i, end + 2);
}

// ── 把 [patch 日记] 的纯函数搬出来真跑 ──────────────────────────────────────
const diaryConstStart = bridge.indexOf('const DIARY_DEFAULT_TIME_V2');
const diaryConstEnd = bridge.indexOf('function diaryCfgV2(');
if (diaryConstStart < 0 || diaryConstEnd < 0) {
  console.log('❌ bridge.js 里找不到 [patch 日记] 的默认值/函数块');
  process.exit(1);
}
const diaryConsts = bridge.slice(diaryConstStart, diaryConstEnd);
const composed = `
${diaryConsts}
${topFnSrc('canonicalV2Key')}
${fnSrc('hhmmToMinutesV2')}
${fnSrc('peakClockV2')}
${fnSrc('sleepCfgV2')}
${fnSrc('diaryCfgV2')}
${fnSrc('diaryKeyV2')}
${fnSrc('diaryWeekdayNumV2')}
${fnSrc('diaryWeekIdV2')}
${fnSrc('diaryDateMinusV2')}
${fnSrc('diaryClockV2')}
${fnSrc('diaryHhmmV2')}
${fnSrc('diaryTargetDayV2')}
return { diaryCfgV2, diaryKeyV2, diaryWeekdayNumV2, diaryWeekIdV2, diaryDateMinusV2, diaryClockV2, diaryHhmmV2, diaryTargetDayV2, diaryNumV2 };
`;

/** 假 Date：把"现在"钉死在 iso。 */
function makeFakeDate(iso) {
  const fixed = new Date(iso).getTime();
  return class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  };
}

function buildApi(cfg, iso) {
  // eslint-disable-next-line no-new-func
  return new Function('cfg', 'Date', composed)(cfg, makeFakeDate(iso));
}

const baseCfg = () => JSON.parse(JSON.stringify(config));
const withDiary = (patch, base = baseCfg()) => ({
  ...base,
  socialV2: { ...base.socialV2, diary: { ...base.socialV2.diary, ...patch } }
});

// ── ① 日期与周号（算错就是"天天写"或"永远不写"） ────────────────────────────
{
  const api = buildApi(baseCfg(), '2026-10-12T18:00:00Z');
  ok(api.diaryDateMinusV2('2026-10-12', 0) === '2026-10-12', '日期回退 0 天不动');
  ok(api.diaryDateMinusV2('2026-10-12', 6) === '2026-10-06', '日期回退 6 天（本周起点）');
  ok(api.diaryDateMinusV2('2026-11-02', 3) === '2026-10-30', '跨月回退（11-02 往前 3 天）');
  ok(api.diaryDateMinusV2('2027-01-02', 5) === '2026-12-28', '跨年回退');
  ok(api.diaryDateMinusV2('2026-10-12', 400) === '2025-09-07', '大跨度回退');
  ok(api.diaryDateMinusV2('', 1) === '' && api.diaryDateMinusV2('2026/10/12', 1) === '', '格式不对回空串（不瞎猜）');

  // 2026-10-12 是周一。ISO 周号：周一 ~ 周日 属同一周。
  ok(api.diaryWeekIdV2('2026-10-12') === '2026-W42', '周一 → 2026-W42');
  ok(api.diaryWeekIdV2('2026-10-18') === '2026-W42', '同周周日 → 同一周号（否则周报会写两次）');
  ok(api.diaryWeekIdV2('2026-10-05') === '2026-W41', '上一周 → 2026-W41');
  ok(api.diaryWeekIdV2('2026-01-01') === '2026-W01', '年初落在第 1 周（ISO：1/1 是周四）');
  ok(api.diaryWeekIdV2('2027-01-01') === '2026-W53', '年末跨年周归到上一年的周号');
  ok(api.diaryWeekIdV2('nope') === '' && api.diaryWeekIdV2('') === '', '周号：格式不对回空串');

  ok(api.diaryWeekdayNumV2('Fri') === 5, 'weekday 短名 Fri → 5');
  ok(api.diaryWeekdayNumV2('sun') === 0, 'weekday 小写 sun → 0');
  ok(api.diaryWeekdayNumV2(3) === 3, 'weekday 直接给数字 3 也能用');
  ok(api.diaryWeekdayNumV2(9) === null, '越界数字不是星期');
  ok(api.diaryWeekdayNumV2('xx') === null && api.diaryWeekdayNumV2(undefined) === null, '认不出来回 null（宁可不动手）');
}

// ── ② 时区钟：日记按自己的时区算"今天" ──────────────────────────────────────
{
  // 2026-10-12T15:20:00Z = 上海 23:20（周一）
  const api = buildApi(baseCfg(), '2026-10-12T15:20:00Z');
  const clock = api.diaryClockV2();
  ok(clock.date === '2026-10-12', '上海 23:20 的日期是 10-12');
  ok(clock.weekday === 'Mon', '上海 23:20 是周一');
  ok(clock.minutes === 23 * 60 + 20, '上海 23:20 → 1400 分钟');
  ok(api.diaryHhmmV2(clock) === '23:20', 'HH:mm 格式化');

  const utc = buildApi(withDiary({ timeZone: 'UTC' }), '2026-10-12T15:20:00Z');
  ok(utc.diaryClockV2().minutes === 15 * 60 + 20, 'timeZone=UTC 时同一时刻是 15:20（不是 23:20）');

  const bad = buildApi(withDiary({ timeZone: 'Not/AZone' }), '2026-10-12T15:20:00Z');
  ok(bad.diaryClockV2().date !== '', '时区非法时回落到上海（看门狗不能因此瘫痪）');

  // 跨零点：上海 00:10 = 前一天 16:10Z，日期必须是当天的 10-13
  const midnight = buildApi(baseCfg(), '2026-10-12T16:10:00Z');
  ok(midnight.diaryClockV2().date === '2026-10-13', '上海 00:10 属于第二天（跨零点日期要翻）');
  ok(api.diaryHhmmV2({ date: '', minutes: 0 }) === '', '没有日期就不给 HH:mm');
}

// ── ②bis "该写哪一天"：过点写今天、没过点补昨天（她把昨天那份睡过去了也得补上） ──
{
  const api = buildApi(baseCfg(), '2026-10-12T18:00:00Z'); // 默认 23:20
  ok(api.diaryTargetDayV2({ date: '2026-10-12', minutes: 23 * 60 + 25 }) === '2026-10-12', '过点（23:25）→ 写今天那份');
  ok(api.diaryTargetDayV2({ date: '2026-10-13', minutes: 30 }) === '2026-10-12', '刚跨零点（00:30）→ 补昨天那份');
  ok(api.diaryTargetDayV2({ date: '2026-10-13', minutes: 23 * 60 + 25 }) === '2026-10-13', '第二天过点 → 写第二天那份');
  ok(api.diaryTargetDayV2({ date: '', minutes: 0 }) === '', '没有日期就不动手');
  ok(api.diaryTargetDayV2(null) === '', '钟都没取到就返回空（不瞎猜日期）');
  const badTime = buildApi(withDiary({ time: '25:99' }), '2026-10-12T18:00:00Z');
  ok(badTime.diaryTargetDayV2({ date: '2026-10-12', minutes: 0 }) === '', '配置时间写坏了 → 不算目标日（看门狗安静）');

  // 0 是"真的有意义的 0"（promptMaxDiary=0 表示不往提示词里塞小记），只有没写才落默认
  ok(api.diaryNumV2(undefined, 8, 1, 30) === 8, 'diaryNumV2：没写 → 默认 8');
  ok(api.diaryNumV2('', 2, 0, 6) === 2, 'diaryNumV2：空串 → 默认 2');
  ok(api.diaryNumV2(0, 8, 1, 30) === 1, 'diaryNumV2：写了 0 → 按 0 夹到下限 1');
  ok(api.diaryNumV2(0, 2, 0, 6) === 0, 'diaryNumV2：写了 0 但下限是 0 → 就是 0（能关掉注入）');
  ok(api.diaryNumV2('oops', 2, 0, 6) === 2, 'diaryNumV2：写坏了 → 默认值');
  ok(api.diaryNumV2(99, 2, 0, 6) === 6, 'diaryNumV2：超上限 → 夹到 6');
}

// ── ③ 配置默认值与夹取（防止有人写 promptMaxDiary: 99 把提示词撑爆） ─────────
{
  const api = buildApi(baseCfg(), '2026-10-12T18:00:00Z');
  const d = api.diaryCfgV2();
  ok(d.enabled === true, '默认开启');
  ok(d.time === '23:20', '默认 23:20 写小记');
  ok(d.weeklyEnabled === true && d.weeklyWeekday === 'Fri' && d.weeklyTime === '21:00', '默认周五 21:00 写周报');
  ok(d.timeZone === 'Asia/Shanghai', '默认时区跟睡眠一致');
  ok(d.includeInPrompt === true, '默认把最近小记注入她的提示词');
  ok(d.promptMaxDiary === 2 && d.eventsMax === 8 && d.lookbackDiary === 3, '默认注入规模：2 条小记 / 8 条事件 / 回看 3 条');

  const clamp = buildApi(withDiary({ promptMaxDiary: 99, promptMaxChars: 1, eventsMax: 0, lookbackDiary: 999 }), '2026-10-12T18:00:00Z').diaryCfgV2();
  ok(clamp.promptMaxDiary === 6, 'promptMaxDiary 上限 6');
  ok(clamp.promptMaxChars === 40, 'promptMaxChars 下限 40');
  ok(clamp.eventsMax === 1, 'eventsMax 下限 1');
  ok(clamp.lookbackDiary === 10, 'lookbackDiary 上限 10');

  const off = buildApi(withDiary({ enabled: false }), '2026-10-12T18:00:00Z').diaryCfgV2();
  ok(off.enabled === false, 'enabled=false 能关掉');
  const noWeekly = buildApi(withDiary({ weekly: { enabled: false } }), '2026-10-12T18:00:00Z').diaryCfgV2();
  ok(noWeekly.weeklyEnabled === false && noWeekly.enabled === true, '周报可以单独关（小记照写）');
  const sunday0 = buildApi(withDiary({ weekly: { weekday: 0 } }), '2026-10-12T18:00:00Z').diaryCfgV2();
  ok(sunday0.weeklyWeekday === 0, 'weekly.weekday=0 是有效值（不能当成"没配置"）');
  const badDiary = buildApi({ ...baseCfg(), socialV2: { ...baseCfg().socialV2, diary: 'oops' } }, '2026-10-12T18:00:00Z').diaryCfgV2();
  ok(badDiary.time === '23:20', 'diary 配置写成非对象也回默认（不抛）');
}

// ── ④ 小记落在哪个会话（私人内容不能进群） ──────────────────────────────────
{
  const api = buildApi(baseCfg(), '2026-10-12T18:00:00Z');
  ok(api.diaryKeyV2() === `private:${baseCfg().ownerQQ}`, '默认落在主人私聊');
  const group = buildApi(withDiary({ key: 'group:429626254' }), '2026-10-12T18:00:00Z');
  ok(group.diaryKeyV2() === 'group:429626254', '配置了 key 就听配置');
  const bogus = buildApi(withDiary({ key: 'hello' }), '2026-10-12T18:00:00Z');
  ok(bogus.diaryKeyV2() === `private:${baseCfg().ownerQQ}`, 'key 非法就回落主人私聊');
  const noOwner = buildApi({ ...withDiary({ key: '' }), ownerQQ: '' }, '2026-10-12T18:00:00Z');
  ok(noOwner.diaryKeyV2() === '', '没有 ownerQQ 且没配 key → 空（看门狗会安静不动）');
}

// ── ⑤ 接线：看门狗 / 闸门顺序 / 提示词 / 持久化（查源码位置与顺序） ──────────
{
  const blockStart = bridge.indexOf('// ── [patch 日记]');
  const blockEnd = bridge.indexOf('const WAKE_PRIORITY = {');
  ok(blockStart > 0 && blockEnd > blockStart, '[patch 日记] 块在 WAKE_PRIORITY 之前');
  const block = bridge.slice(blockStart, blockEnd);

  const calls = (bridge.match(/startDiaryWatchV2\(\);/g) || []).length;
  ok(calls >= 1 && bridge.includes('startDiaryWatchV2();') && bridge.includes('function startDiaryWatchV2()'), '看门狗在启动流程里被调用（调用点 + 定义都在）');
  ok(bridge.indexOf('startCatchUpWatch();') < bridge.indexOf('\n  startDiaryWatchV2();'), '挂在启动序列里（startCatchUpWatch 之后）');
  ok(bridge.includes('DIARY_INTERVAL_MS_V2).unref?.()'), '定时器 unref（不挡进程退出）');
  ok(/const DIARY_INTERVAL_MS_V2 = 60000;/.test(bridge), '一分钟核对一次');
  ok(block.includes("sendWakePromptV2(key, 'diary')"), '到点走 sendWakePromptV2（复用全部闸门）');
  ok(block.includes("sendWakePromptV2(key, 'diaryWeekly')"), '周报同样走 sendWakePromptV2');
  // 顺序：先判睡着再叫醒（否则深夜把她叫起来写日记）
  ok(block.indexOf('sleepStateV2(key, st).asleep') > 0, '看门狗里先判睡着');
  ok(block.indexOf('sleepStateV2(key, st).asleep') < block.indexOf("sendWakePromptV2(key, 'diary')"), '判睡在叫醒之前');
  ok(block.includes('st.lastDiaryDay !== targetDay'), '同一天只写一次（按"目标日"去重）');
  ok(block.includes('st.lastDiaryWeek !== weekId'), '同一周只写一次（按周号去重）');
  ok(block.includes('st.lastDiaryDay = targetDay;') && block.includes('st.lastDiaryWeek = weekId;'), '触发前先落标记（重启不重复写）');
  ok(block.includes('const targetDay = diaryTargetDayV2(clock)'), '目标日由 diaryTargetDayV2 统一算（提示词分支也用它，口径一致）');
  ok(block.includes('(clock.minutes >= due || st.lastDiaryDay)'), '首跑只在当天到点后写（刚装好不补一份空的昨天）');
  ok(block.includes('function diaryNumV2(') && block.includes('diaryNumV2(d.promptMaxDiary, 2, 0, 6)'), '数字配置走 diaryNumV2（显式 0 有意义）');
  ok(block.includes('cfg.socialV2?.enabled === false || currentMode !== \'reserved2\' || socialV2.paused'), '暂停/非二代模式时看门狗不动');
  ok(block.includes('if (diaryTickBusy) return;'), '有重入保护（不会同时开两个日记回合）');
  ok(block.includes('monIdx(todayNum) > monIdx(wNum)'), '周报：过点之后同周内还能补（周一=0 的顺序比较，睡过周五不丢周报）');
  ok(block.includes('function buildDiaryTaskV2(key, kind, dayArg)'), '任务话术有独立函数（能指定写哪一天）');
  ok(block.includes('qq_diary(action="append"') && block.includes('qq_set_wake_config'), '话术里明确让她用 qq_diary 写、然后收尾');
  ok(block.includes('别写流水账') || block.includes('别写成总结报告') || block.includes('别写成总结'), '话术里禁止写成总结报告');
  ok(block.includes('dayStats(dayStr, sinceTs)') || block.includes('newFacts'), '带上了"今天的数字"');
  ok(block.includes('listEventsSince'), '带上了"今天/本周发生过的事"');
  ok(block.includes('listDiary({ until:'), '带上"你之前写过的小记"（避免重复写同一件事）');
  ok(block.includes("kind === 'weekly'") && block.includes('const dayWord = isToday ? \'今天\' : \'昨天\''), '小记/周报走同一段话术的两种口径');
  ok(block.includes('补记：现在才补写') && block.includes('dayWord'), '补写时话术会说清写的是哪一天（不然她会写成今天）');

  // 提示词分支
  ok(bridge.includes("if (reason === 'diary' || reason === 'diaryWeekly')"), 'buildWakePromptV2 有 diary 分支');
  ok(bridge.includes("buildDiaryTaskV2(key, weekly ? 'weekly' : 'daily', dayArg)"), '分支里拼任务话术（并把目标日传下去）');
  ok(bridge.includes('if (String(key) === diaryKeyV2()) diaryLine = diaryPromptLineV2();'), '小记只注入她自己的那个会话（不往群里带）');
  // 意图：diaryLine 必须接进 base 提示词（允许分段重组，故按 Seg 声明块匹配而非字面串）
  ok(/const (?:stable|slow|volatile)Seg =[^;]*diaryLine/.test(bridge), 'diaryLine 接进了 base 提示词');
  ok(bridge.includes('【你自己写过的小记'), '注入小记时注明了"别念出来"');
  ok(bridge.includes('diaryPromptLineV2') && bridge.includes('function diaryPromptLineV2()'), '小记读取函数存在');

  // 持久化
  ok(bridge.includes("lastDiaryDay: '',"), '状态默认值里有 lastDiaryDay');
  ok(bridge.includes('lastDiaryDay: String(val.lastDiaryDay || \'\')'), 'loadSocialV2State 读回 lastDiaryDay');
  ok(bridge.includes('lastDiaryWeek: String(val.lastDiaryWeek || \'\')'), 'loadSocialV2State 读回 lastDiaryWeek');
  ok(bridge.includes("lastDiaryDay: st.lastDiaryDay || ''"), 'saveSocialV2State 写出 lastDiaryDay');
  ok(bridge.includes("lastDiaryWeek: st.lastDiaryWeek || ''"), 'saveSocialV2State 写出 lastDiaryWeek');

  // 端点与状态
  ok(bridge.includes("url.pathname === '/api/socialV2/db-diary'"), '有 /api/socialV2/db-diary 端点');
  ok(bridge.includes("v2ToolEnabled('diary')"), '端点受 socialV2.tools.diary 开关控制');
  ok(bridge.includes('mdb.addDiary({'), '端点写入走 memory-db 的 addDiary');
  ok(bridge.includes("diary: 'qq_diary'"), '/api/socialV2/prompt 的可用工具表里有 qq_diary');
  ok(bridge.includes('diary: (() => {'), '/api/status 暴露 diary 状态（运维/回归可查）');
}

// ── ⑥ memory-db：diary 表与读写函数 ─────────────────────────────────────────
{
  ok(memdb.includes('CREATE TABLE IF NOT EXISTS diary'), 'memory-db 建了 diary 表');
  ok(/day\s+TEXT/.test(memdb) && /mood\s+TEXT/.test(memdb), 'diary 表有 day / mood 字段');
  ok(memdb.includes('function addDiary(opts)'), '有 addDiary');
  ok(memdb.includes('function listDiary(opts)'), '有 listDiary');
  ok(memdb.includes('function dayWindow(dayStr)'), '有 dayWindow（按天取区间）');
  ok(memdb.includes('function dayStats(dayStr, sinceTs)'), '有 dayStats（今天的数字）');
  ok(memdb.includes('function listEventsSince(sinceTs, limit)'), '有 listEventsSince（今天/本周发生过什么）');
  ok(memdb.includes('function diaryStats()'), '有 diaryStats');
  ok(/diary: one\('SELECT COUNT\(\*\) AS c FROM diary'\)/.test(memdb), 'stats() 里带上 diary 计数');
  ok(memdb.includes('truncateText(String(o.text || \'\').trim(), maxDiaryChars)'), 'addDiary 会按 maxDiaryChars 截断（也防切碎 emoji）');
  ok(memdb.includes('ORDER BY at DESC LIMIT ?') && memdb.includes('rows.slice().reverse()'), 'listDiary 倒序取、正序返回（读起来顺）');
  ok(memdb.includes('if (o.q) { where.push(\'text LIKE ?\')'), 'listDiary 支持关键词');
  ok(['addDiary', 'listDiary', 'dayWindow', 'dayStats', 'listEventsSince', 'diaryStats'].every((n) => new RegExp(`\\n    ${n},`).test(memdb)), '工厂导出这些函数');
  ok(memdb.includes("maxDiaryChars = 300") || /maxDiaryChars/.test(memdb), '有 maxDiaryChars 上限');
}

// ── ⑦ 她的工具：qq_diary 注册 + 开关 ────────────────────────────────────────
{
  ok(mcp.includes("'qq_diary'"), 'MCP 注册了 qq_diary');
  ok(mcp.includes("qq_diary: ['memory', 'diary']"), 'qq_diary 同时受 memory 总开关与 diary 开关管');
  ok(/qq_diary[\s\S]{0,900}?action=append/.test(mcp) || mcp.includes('action="append"'), '工具说明里写明 action=append');
  ok(mcp.includes("'/api/socialV2/db-diary'"), '工具打的是桥接的 db-diary 端点');
}

// ── ⑧ 配置两处默认值 ────────────────────────────────────────────────────────
for (const [name, c] of [['config.json', config], ['config.example.json', example]]) {
  const d = c.socialV2?.diary;
  ok(!!d && d.enabled === true, `${name}: diary.enabled=true`);
  ok(d?.time === '23:20', `${name}: 小记 23:20`);
  ok(d?.timeZone === 'Asia/Shanghai', `${name}: timeZone=Asia/Shanghai`);
  ok(d?.weekly?.enabled === true && d.weekly.weekday === 'Fri' && d.weekly.time === '21:00', `${name}: 周报周五 21:00`);
  ok(d?.includeInPrompt === true && Number(d?.promptMaxDiary) > 0, `${name}: 会把小记喂回她的提示词`);
  ok(c.socialV2?.tools?.diary === true, `${name}: socialV2.tools.diary=true`);
}

// ── ⑨ preset：她得知道小记怎么用、以及别往群里念 ────────────────────────────
ok(presetSrc.includes('【你自己的小记】'), 'preset 源有【你自己的小记】');
ok(presetPatch.includes('【你自己的小记】'), 'preset 产物（patch）里有【你自己的小记】');
ok(presetSrc.includes('qq_diary(action="append"') && presetPatch.includes('qq_diary(action="append"'), 'preset 里给了 append 写法');
ok(presetSrc.includes('别往群里念'), 'preset 明确"别往群里念"');
ok(presetSrc.includes('qq_diary(action="list")'), 'preset 告诉她怎么回头看');

console.log(`\n日记回归：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
