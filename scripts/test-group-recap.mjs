#!/usr/bin/env node
// [回归] 群聊小总结（bridge.js 的 [patch 群聊小总结] 块 + memory-db.js 的按群取数）
//
// 为什么要有这一套：群总结和日记长得很像、错法却很不一样 ——
//   ① 按**全库**取数（dayStats）而不是按群取（keyStats）⇒ 把别的群/私聊的事发到群里，
//      是隐私事故，比不总结严重得多；
//   ② 目标群/日期算错 ⇒ 要么天天刷屏，要么永远不发；
//   ③ 去重漏了 ⇒ 重启后同一份总结连发两次；
//   ④ 消息量太少也发 ⇒ 群里没人说话还要尬总结。
//
// 这里尽量跑真代码：把纯函数（配置解析 / 目标群 / 目标日）切出来塞进 new Function 用假 Date 钉时刻；
// 接线与取数口径直接查源码。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const bridge = read('src/bridge.js') + '\n' + read('src/wake-prompt.js');
const memdb = read('src/memory-db.js');
const config = JSON.parse(read('config.json'));
const example = JSON.parse(read('config.example.json'));

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

function topFnSrc(name) {
  const marker = `function ${name}(`;
  const i = bridge.indexOf(marker);
  if (i < 0) throw new Error(`bridge.js 里找不到 ${name}()`);
  const end = bridge.indexOf('\n}', i);
  if (end < 0) throw new Error(`${name}() 的结束括号没找到`);
  return bridge.slice(i, end + 2);
}

// ── 把 [patch 群聊小总结] 的纯函数搬出来真跑 ─────────────────────────────────
const recapConstStart = bridge.indexOf('const GROUP_RECAP_INTERVAL_MS_V2');
const recapConstEnd = bridge.indexOf('function groupRecapNumV2(');
if (recapConstStart < 0 || recapConstEnd < 0) {
  console.log('❌ bridge.js 里找不到 [patch 群聊小总结] 的默认值/函数块');
  process.exit(1);
}
const recapConsts = bridge.slice(recapConstStart, recapConstEnd);
const composed = `
${recapConsts}
${topFnSrc('canonicalV2Key')}
${fnSrc('hhmmToMinutesV2')}
${fnSrc('peakClockV2')}
${fnSrc('sleepCfgV2')}
${fnSrc('diaryWeekdayNumV2')}
${fnSrc('diaryWeekIdV2')}
${fnSrc('diaryDateMinusV2')}
${fnSrc('diaryClockV2')}
${fnSrc('groupRecapNumV2')}
${fnSrc('groupRecapCfgV2')}
${fnSrc('groupRecapTargetsV2')}
${fnSrc('groupRecapTargetDayV2')}
return { groupRecapCfgV2, groupRecapNumV2, groupRecapTargetsV2, groupRecapTargetDayV2, diaryWeekIdV2, diaryDateMinusV2, diaryClockV2 };
`;

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

// 目标群筛选依赖 socialV2.conversations（Map）与 isSessionAllowedInCurrentMode —— 用最小桩塞进去。
function safeIds(ids) {
  return new Set(ids);
}

function buildApi(cfg, iso, { convKeys = [], allowed = null } = {}) {
  const socialV2 = { conversations: new Map(convKeys.map((k) => [k, {}])) };
  const allowedSet = allowed === null ? new Set(convKeys) : safeIds(allowed);
  const isSessionAllowedInCurrentMode = (k) => allowedSet.has(k);
  // eslint-disable-next-line no-new-func
  return new Function('cfg', 'Date', 'socialV2', 'isSessionAllowedInCurrentMode', composed)(
    cfg, makeFakeDate(iso), socialV2, isSessionAllowedInCurrentMode
  );
}

const baseCfg = () => JSON.parse(JSON.stringify(config));
const withRecap = (patch, base = baseCfg()) => ({
  ...base,
  socialV2: { ...base.socialV2, groupRecap: { ...base.socialV2.groupRecap, ...patch } }
});

// ── ① 配置解析与夹取 ────────────────────────────────────────────────────────
{
  const api = buildApi(baseCfg(), '2026-10-12T18:00:00Z');
  const c = api.groupRecapCfgV2();
  ok(c.enabled === false, '默认关闭（不显式打开就不发群总结）');
  ok(c.time === '22:00', '默认 22:00 发日总结');
  ok(c.weeklyEnabled === true && c.weeklyWeekday === 'Sun' && c.weeklyTime === '21:00', '默认周日 21:00 发周总结');
  ok(c.timeZone === 'Asia/Shanghai', '默认时区跟睡眠一致');
  ok(Array.isArray(c.keys) && c.keys.length === 0, 'keys 默认空（= 所有当前模式允许的群）');
  ok(c.minMessages === 8 && c.topSpeakers === 5 && c.selfLines === 8, '默认规模：8 条起发 / 5 个活跃 / 8 句自己说过的话');
  ok(c.weeklyMinMessages === 30, '周总结默认门槛 30 条（一周太少不值得发）');
  ok(c.weeklyWeekday === 'Sun' && c.weeklyTime === '21:00', '周总结默认周日 21:00（解析后是平铺字段）');
  ok(c.maxGroupsPerTick === 3, '一次最多处理 3 个群（别同时炸一堆回合）');

  const clamp = buildApi(withRecap({
    minMessages: 0, topSpeakers: 99, selfLines: -5, maxGroupsPerTick: 999,
    weekly: { minMessages: 99999 }
  }), '2026-10-12T18:00:00Z').groupRecapCfgV2();
  ok(clamp.minMessages === 1, 'minMessages 下限 1（不能设成 0 天天发）');
  ok(clamp.topSpeakers === 10, 'topSpeakers 上限 10');
  ok(clamp.selfLines === 0, 'selfLines 下限 0（可以不带"自己说过的话"）');
  ok(clamp.maxGroupsPerTick === 10, 'maxGroupsPerTick 上限 10');
  ok(clamp.weeklyMinMessages === 2000, 'weekly.minMessages 上限 2000');

  const off = buildApi(withRecap({ enabled: true, weekly: { enabled: false } }), '2026-10-12T18:00:00Z').groupRecapCfgV2();
  ok(off.enabled === true && off.weeklyEnabled === false, '日总结与周总结可各自开关');

  const bad = buildApi({ ...baseCfg(), socialV2: { ...baseCfg().socialV2, groupRecap: 'oops' } }, '2026-10-12T18:00:00Z').groupRecapCfgV2();
  ok(bad.time === '22:00' && bad.enabled === false, 'groupRecap 配置写成非对象也回默认（不抛）');
}

// ── ② 目标群筛选（显式 keys 优先；否则只挑当前模式允许的群聊） ────────────────
{
  const keys = ['group:111', 'group:222', 'private:999'];
  const api = buildApi(baseCfg(), '2026-10-12T18:00:00Z', { convKeys: keys });
  const t = api.groupRecapTargetsV2();
  ok(t.length === 2 && t.includes('group:111') && t.includes('group:222'), '未配 keys：所有群聊都是目标（私聊不算）');
  ok(!t.includes('private:999'), '私聊永远不做群总结');

  const only = buildApi(withRecap({ keys: ['group:222'] }), '2026-10-12T18:00:00Z', { convKeys: keys });
  ok(JSON.stringify(only.groupRecapTargetsV2()) === JSON.stringify(['group:222']), '配了 keys 就只听 keys');

  const bogus = buildApi(withRecap({ keys: ['hello', 'group:111'] }), '2026-10-12T18:00:00Z', { convKeys: keys });
  ok(JSON.stringify(bogus.groupRecapTargetsV2()) === JSON.stringify(['group:111']), 'keys 里非法的条目被丢掉（不作怪）');

  const notAllowed = buildApi(baseCfg(), '2026-10-12T18:00:00Z', { convKeys: keys, allowed: ['group:111'] });
  ok(JSON.stringify(notAllowed.groupRecapTargetsV2()) === JSON.stringify(['group:111']), '不在当前模式允许范围内的群不总结');

  const missing = buildApi(withRecap({ keys: ['group:777'] }), '2026-10-12T18:00:00Z', { convKeys: keys });
  ok(missing.groupRecapTargetsV2().length === 0, 'keys 指向一个不存在的会话 → 空（不瞎发）');
}

// ── ③ 目标日：过点算今天、没过点补昨天（和日记同一套口径） ────────────────────
{
  const api = buildApi(withRecap({ time: '22:00' }), '2026-10-12T18:00:00Z');
  ok(api.groupRecapTargetDayV2({ date: '2026-10-12', minutes: 22 * 60 + 5 }) === '2026-10-12', '过点（22:05）→ 总结今天');
  ok(api.groupRecapTargetDayV2({ date: '2026-10-13', minutes: 30 }) === '2026-10-12', '刚跨零点（00:30）→ 补昨天那份');
  ok(api.groupRecapTargetDayV2({ date: '', minutes: 0 }) === '', '没有日期就不动手');
  ok(api.groupRecapTargetDayV2(null) === '', '钟都没取到就返回空');

  const badTime = buildApi(withRecap({ time: '25:99' }), '2026-10-12T18:00:00Z');
  ok(badTime.groupRecapTargetDayV2({ date: '2026-10-12', minutes: 0 }) === '', '时间配置写坏了 → 不算目标日（看门狗安静）');

  ok(api.groupRecapNumV2(undefined, 8, 1, 30) === 8, 'groupRecapNumV2：没写 → 默认');
  ok(api.groupRecapNumV2(0, 8, 1, 30) === 1, 'groupRecapNumV2：写了 0 → 夹到下限');
  ok(api.groupRecapNumV2('oops', 8, 1, 30) === 8, 'groupRecapNumV2：写坏了 → 默认值');
}

// ── ④ 接线：看门狗 / 闸门顺序 / 去重 / 任务话术 / 持久化 ─────────────────────
{
  const blockStart = bridge.indexOf('// ── [patch 群聊小总结]');
  const blockEnd = bridge.indexOf('const WAKE_PRIORITY = {');
  ok(blockStart > 0 && blockEnd > blockStart, '[patch 群聊小总结] 块在 WAKE_PRIORITY 之前');
  const block = bridge.slice(blockStart, blockEnd);

  ok(bridge.includes('function startGroupRecapWatchV2()') && bridge.includes('startGroupRecapWatchV2();'), '看门狗有定义且在启动流程里被调用');
  ok(bridge.includes('GROUP_RECAP_INTERVAL_MS_V2).unref?.()'), '定时器 unref（不挡进程退出）');
  ok(/const GROUP_RECAP_INTERVAL_MS_V2 = 60000;/.test(bridge), '一分钟核对一次');
  ok(block.includes("sendWakePromptV2(key, 'groupRecap')"), '到点走 sendWakePromptV2（复用睡眠/高峰/限流全部闸门）');
  ok(block.includes("sendWakePromptV2(key, 'groupRecapWeekly')"), '周总结同样走 sendWakePromptV2');
  ok(block.includes('if (groupRecapTickBusy) return;'), '有重入保护（不会同时开两个总结回合）');
  ok(block.includes("currentMode !== 'reserved2' || socialV2.paused"), '暂停/非二代模式时看门狗不动');

  // 顺序：先判睡着再叫醒（深夜别把她叫起来发总结）
  ok(block.includes('sleepStateV2(key, st).asleep'), '看门狗里先判睡着');
  ok(block.indexOf('sleepStateV2(key, st).asleep') < block.indexOf("sendWakePromptV2(key, 'groupRecap')"), '判睡在叫醒之前');

  // 去重
  ok(block.includes('st.lastGroupRecapDay !== dueDay'), '同一天只发一次（按目标日去重）');
  ok(block.includes('st.lastGroupRecapWeek !== weekId'), '同一周只发一次（按周号去重）');
  ok(block.includes('st.lastGroupRecapWeek = weekId;') && block.includes('st.lastGroupRecapDay = dueDay;'), '触发前先落标记（重启不重复发）');

  // 门槛
  ok(block.includes('if (msgs < c.minMessages)'), '消息量不够就不总结（群里没人说话别尬总结）');
  ok(block.includes('if (weekMsgs < c.weeklyMinMessages)'), '周总结也有门槛');
  ok(block.includes('monIdx(todayNum) > monIdx(wNum)'), '周总结：过点之后同周内还能补（睡过周日不丢）');
  // 一周一次优先于一天一次，避免周总结被日总结永远挤掉
  ok(block.indexOf('st.lastGroupRecapWeek !== weekId') < block.indexOf('st.lastGroupRecapDay !== dueDay'), '周总结先于日总结判定（不会被日总结饿死）');

  // 任务话术
  ok(block.includes('function buildGroupRecapTaskV2(key, kind, dayArg)'), '任务话术有独立函数（能指定哪天/哪个群）');
  ok(block.includes('qq_send_group_message'), '话术里明确让她用 qq_send_group_message 发到群里');
  ok(block.includes('qq_set_wake_config'), '话术里要求收尾（别让回合挂着）');
  ok(block.includes('不要列数据') && block.includes('随口聊天'), '话术里禁止写成报表，要求口语化');
  ok(block.includes('补发：现在才补'), '补发时话术会说明补的是哪天');
  // 只带本群数据（这是隐私红线）
  ok(block.includes('keyStats(dueDay, key)'), '按群取数（keyStats），不是全库 dayStats');
  ok(block.includes('keyTopSpeakers(dayStr, key'), '活跃成员也按群取');
  ok(block.includes('只属于这个群'), '数据段明确标注"只属于这个群"');
  ok(!/dayStats\(dayStr\)/.test(block), '总结块里没有用到全库 dayStats（防止跨群串味）');
}

// ── ⑤ 提示词分支 + 优先级 + 持久化字段 ──────────────────────────────────────
{
  ok(bridge.includes("if (reason === 'groupRecap' || reason === 'groupRecapWeekly')"), 'buildWakePromptV2 有群总结分支');
  ok(bridge.includes("buildGroupRecapTaskV2(key, weekly ? 'groupRecapWeekly' : 'groupRecap', dayArg)"), '分支里拼任务话术并把目标日传下去');
  ok(bridge.includes('groupRecap: 62,'), 'WAKE_PRIORITY 有 groupRecap 档');
  ok(/groupRecap: 62,[\s\S]{0,200}?keyword: 60,/.test(bridge), 'groupRecap 比普通概率唤醒高、比点名(nameMention:70)低');
  ok(bridge.includes("if (base === 'groupRecapWeekly') return WAKE_PRIORITY.groupRecap;"), '周总结归到 groupRecap 同一档');

  ok(bridge.includes("lastGroupRecapDay: '',"), '状态默认值里有 lastGroupRecapDay');
  ok(bridge.includes("lastGroupRecapWeek: '',"), '状态默认值里有 lastGroupRecapWeek');
  ok(bridge.includes("lastGroupRecapDay: String(val.lastGroupRecapDay || '')"), 'loadSocialV2State 读回 lastGroupRecapDay');
  ok(bridge.includes("lastGroupRecapWeek: String(val.lastGroupRecapWeek || '')"), 'loadSocialV2State 读回 lastGroupRecapWeek');
  ok(bridge.includes("lastGroupRecapDay: st.lastGroupRecapDay || ''"), 'saveSocialV2State 写出 lastGroupRecapDay');
  ok(bridge.includes("lastGroupRecapWeek: st.lastGroupRecapWeek || ''"), 'saveSocialV2State 写出 lastGroupRecapWeek');
  ok(bridge.indexOf('startPromiseWatchV2();') < bridge.indexOf('startGroupRecapWatchV2();'), '挂在启动序列里（promise 看门狗之后）');
}

// ── ⑥ memory-db：按群取数（这是"只看得见本群"的底层保证） ───────────────────
{
  ok(memdb.includes('function keyStats(dayStr, key)'), '有 keyStats（按会话取数）');
  ok(memdb.includes('function keyTopSpeakers(dayStr, key, limit)'), '有 keyTopSpeakers');
  ok(memdb.includes('function keySelfLines(dayStr, key, limit)'), '有 keySelfLines');
  ok(/FROM messages WHERE day = \? AND key = \?/.test(memdb) || /day = \? AND key = \?/.test(memdb), 'keyStats 按 day + key 双条件过滤（真按群）');
  ok(/AND key = \? AND is_self = 0 AND sender IS NOT NULL/.test(memdb), 'keyTopSpeakers 只数别人说的话');
  ok(/AND key = \? AND is_self = 1/.test(memdb), 'keySelfLines 只取她自己说过的话');
  ok(['keyStats', 'keyTopSpeakers', 'keySelfLines'].every((n) => new RegExp(`\\n    ${n},`).test(memdb)), '工厂导出这三个函数');
  ok(/CREATE INDEX IF NOT EXISTS idx_messages_key_at ON messages\(key, at\)/.test(memdb), 'messages 有 (key, at) 索引（按群取数不慢）');
  ok(/if \(!k\) return null;/.test(memdb), 'key 为空就返回 null（不把整个库当某个群）');
}

// ── ⑦ 配置两处默认值（默认关，避免误发） ────────────────────────────────────
for (const [name, c] of [['config.json', config], ['config.example.json', example]]) {
  const g = c.socialV2?.groupRecap;
  ok(!!g, `${name}: 有 socialV2.groupRecap 段`);
  ok(g?.enabled === false, `${name}: groupRecap.enabled=false（默认关，防止误发到群）`);
  ok(g?.time === '22:00', `${name}: 日总结 22:00`);
  ok(g?.timeZone === 'Asia/Shanghai', `${name}: timeZone=Asia/Shanghai`);
  ok(Array.isArray(g?.keys), `${name}: keys 是数组（空 = 所有群）`);
  ok(g?.weekly?.enabled === true && g.weekly.weekday === 'Sun' && g.weekly.time === '21:00', `${name}: 周总结默认周日 21:00`);
  ok(Number(g?.weekly?.minMessages) >= 1, `${name}: weekly.minMessages 是正数`);
}

console.log(`\n群聊小总结回归：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
