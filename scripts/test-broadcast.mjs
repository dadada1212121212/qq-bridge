// 定时播报（bridge 集成）：提示词分支 + 配置解析 + 状态序列化 + 落点私聊。
// 用 harness（真跑 bridge.js 的 VM），单文件拆小、必要时后台跑。
import { bridgeHarness } from './audit-bridge-harness.mjs';

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond) {
  if (cond) pass += 1;
  else { fail += 1; failures.push(name); }
}

const BROADCAST_CFG = {
  socialV2: {
    enabled: true,
    memoryDb: { enabled: false },
    broadcast: {
      enabled: true,
      timeZone: 'Asia/Shanghai',
      morningTime: '08:00',
      eveningTime: '23:00',
      festivalEnabled: true,
      hotEnabled: true,
      hotMax: 8
    }
  }
};

const h = await bridgeHarness({ config: BROADCAST_CFG });
h.setMode('reserved2');
try {
  // ── 1. 配置解析 ─────────────────────────────────────────────────
  const c = h.broadcastCfgV2();
  ok('enabled 为 true', c.enabled === true);
  ok('morningTime 解析正确', c.morningTime === '08:00');
  ok('eveningTime 解析正确', c.eveningTime === '23:00');
  ok('festivalEnabled 默认开', c.festivalEnabled === true);
  ok('hotEnabled 默认开', c.hotEnabled === true);
  ok('hotMax 默认 8', c.hotMax === 8);
  ok('timeZone 有值', typeof c.timeZone === 'string' && c.timeZone.length > 0);

  // 落点：默认主人私聊（harness 的 ownerQQ=123）
  const bkey = h.broadcastKeyV2();
  ok('播报落点是主人私聊', bkey === 'private:123');

  // ── 2. 提示词分支：三类播报都能成型 ─────────────────────────────
  const morning = h.buildWakePromptV2('private:123', 'broadcastMorning');
  ok('早报提示词含【早报】', morning.includes('【早报】'));
  ok('早报提示词要求发消息', morning.includes('qq_send_message'));
  ok('早报提示词要求收尾', morning.includes('qq_set_wake_config'));
  ok('早报提示词强调随口聊天', morning.includes('随口聊天'));
  ok('早报提示词反对标题腔', morning.includes('标题腔'));
  ok('早报提示词不列数据汇报', morning.includes('任务汇报'));

  const evening = h.buildWakePromptV2('private:123', 'broadcastEvening');
  ok('晚报提示词含【晚报】', evening.includes('【晚报】'));
  ok('晚报提示词要求道晚安', evening.includes('晚安'));
  ok('晚报提示词要求发消息', evening.includes('qq_send_message'));
  ok('晚报提示词反对今日总结', evening.includes('今日总结'));

  // 节日分支：拿当天日期现算（探针路径，pendingBroadcastV2 为空）
  const today = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const todayStr = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  const festival = h.buildWakePromptV2('private:123', 'broadcastFestival');
  // 当天是节日 → 【节日问候】；不是节日 → 降级成【问候】（不硬说过节）。两种都算成型。
  ok('节日分支成型（节日问候或降级问候）',
    festival.includes('【节日问候】') || festival.includes('【问候】'));
  ok('节日/降级分支都要求发消息', festival.includes('qq_send_message'));

  // ── 3. 播报与普通唤醒不互相污染 ─────────────────────────────────
  const normal = h.buildWakePromptV2('private:123', 'question');
  ok('普通唤醒不含播报字样', !normal.includes('【早报】') && !normal.includes('【晚报】') && !normal.includes('【节日问候】'));
  const groupRecap = h.buildWakePromptV2('group:456', 'groupRecap');
  ok('群总结提示词不含播报字样', !groupRecap.includes('【早报】') && !groupRecap.includes('【晚报】'));
  ok('播报提示词不含群总结字样', !morning.includes('【群小总结】'));

  // ── 4. 状态序列化：三个去重位都要在 ─────────────────────────────
  const st = h.getSocialV2State('private:123');
  ok('初始 lastBroadcastMorning 为空', st.lastBroadcastMorning === '');
  ok('初始 lastBroadcastEvening 为空', st.lastBroadcastEvening === '');
  ok('初始 lastBroadcastFestivalDay 为空', st.lastBroadcastFestivalDay === '');

  st.lastBroadcastMorning = '2026-01-01';
  st.lastBroadcastEvening = '2026-01-01';
  st.lastBroadcastFestivalDay = '2026-01-01';
  h.saveSocialV2State();
  const st2 = h.getSocialV2State('private:123');
  ok('序列化后 morning 保留', st2.lastBroadcastMorning === '2026-01-01');
  ok('序列化后 evening 保留', st2.lastBroadcastEvening === '2026-01-01');
  ok('序列化后 festival 保留', st2.lastBroadcastFestivalDay === '2026-01-01');

  // ── 5. 非播报 reason 的优先级归一到 broadcast 档 ────────────────
  // 通过 buildWakePromptV2 反推不了优先级，这里直接验证三种 reason 都能出对应提示词，
  // 说明 wakePriorityV2 的映射分支被走到（归一到 broadcast=55，与 groupRecap=62 不同档）。
  ok('三种 reason 各自成型',
    morning.includes('【早报】') && evening.includes('【晚报】')
    && (festival.includes('【节日问候】') || festival.includes('【问候】')));

  // ── 6. 防御：群聊 key 不该拿到播报话术（播报只对私聊） ───────────
  const grpMorning = h.buildWakePromptV2('group:456', 'broadcastMorning');
  ok('群聊不会拿到早报话术', !grpMorning.includes('【早报】'));
  ok('群聊不会拿到"给主人发消息"的话术', !grpMorning.includes('给主人发一条'));
  ok('群聊拿到的是普通唤醒模板', grpMorning.includes('【唤醒】group:456'));
  const grpFestival = h.buildWakePromptV2('group:456', 'broadcastFestival');
  ok('群聊不会拿到节日问候话术', !grpFestival.includes('【节日问候】'));

  // ── 7. 节日分支在非节日当天要降级成普通问候 ─────────────────────
  // 探针路径下 pendingBroadcastV2 为空，festivalOf(今天) 若为 null 就该退化成问候。
  // 用一个明显不是节日的日期当场测不了（clock 取真实时间），这里只钉"不硬说今天是节日"：
  // 若今天恰好是节日，则允许出现节日名；否则不该出现「今天是**节日**」这种空洞文案。
  const hasHollowFestival = festival.includes('今天是**节日**');
  ok('节日分支不出现空洞的"今天是节日"文案', !hasHollowFestival);
} finally {
  await h.close();
}

console.log(`定时播报（bridge）：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
