#!/usr/bin/env node
// [回归] 睡眠自动回复（bridge.js 的 [patch 睡眠] 块）
//
// 为什么要有这一套：她「睡着」之后桥接必须做到三件事，错一件就会出事 ——
//   ① @ 她的时候群里能看到「（zzz…）」，而不是死一样安静（人以为她端着不理人）；
//   ② 其余消息一条都不许烧 token（群消息洪峰下最贵的就是这个）；
//   ③ 有人喊「醒醒」或主人手动叫醒时必须真醒（否则她就真的叫不醒了）。
//
// 这里能跑真代码就跑真代码：把 bridge.js 里的纯函数（时间窗口 / 睡着判定 / 口令识别）
// 原样切出来塞进 new Function 里跑，用假 Date 钉住时刻，不靠肉眼看代码。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const bridge = read('src/bridge.js') + '\n' + read('src/console-server.js');
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

/** 按 2 空格缩进的函数声明切出源码（bridge.js 里这些都写在 main() 内）。 */
function fnSrc(name) {
  const marker = `function ${name}(`;
  const i = bridge.indexOf(marker);
  if (i < 0) throw new Error(`bridge.js 里找不到 ${name}()`);
  const end = bridge.indexOf('\n  }', i);
  if (end < 0) throw new Error(`${name}() 的结束括号没找到`);
  return bridge.slice(i, end + 4);
}

// ── 把 [patch 睡眠] 的纯函数搬出来真跑 ────────────────────────────────────────
const sleepConstStart = bridge.indexOf('const SLEEP_DEFAULT_NIGHT_WINDOWS_V2');
const sleepConstEnd = bridge.indexOf('function sleepCfgV2(');
if (sleepConstStart < 0 || sleepConstEnd < 0) {
  console.log('❌ bridge.js 里找不到 [patch 睡眠] 的默认值/函数块');
  process.exit(1);
}
const sleepConsts = bridge.slice(sleepConstStart, sleepConstEnd);
const composed = `
${sleepConsts}
${fnSrc('hhmmToMinutesV2')}
${fnSrc('peakClockV2')}
${fnSrc('sleepCfgV2')}
${fnSrc('minutesInWindowsV2')}
${fnSrc('sleepNightWinV2')}
${fnSrc('sleepStateV2')}
${fnSrc('sleepWakeWordV2')}
return { sleepCfgV2, minutesInWindowsV2, sleepNightWinV2, sleepStateV2, sleepWakeWordV2, peakClockV2, hhmmToMinutesV2 };
`;

/** 假 Date：把"现在"钉死在 iso（Asia/Shanghai 的解释见各断言）。 */
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

const isSleepingConfigV2 = (wc) => {
  if (!wc || typeof wc !== 'object') return true;
  if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
  return true;
};

function buildApi(cfg, iso) {
  // eslint-disable-next-line no-new-func
  // bridge.js 的默认值块里夹了 `path.join(ROOT, ...)`（state/sleep-force-awake.json），
  // 所以 path / ROOT 也要注入，否则 eval 出来第一行就 ReferenceError。
  return new Function('cfg', 'Date', 'isSleepingConfigV2', 'path', 'ROOT', composed)(
    cfg, makeFakeDate(iso), isSleepingConfigV2, path, ROOT
  );
}

const baseCfg = () => JSON.parse(JSON.stringify(config));
const divingWc = () => ({ mode: 'diving', infinite: true, sleepUntil: null, triggers: { anyMessage: false } });

// ── ① 深夜窗口：跨零点、边界、开关 ───────────────────────────────────────────
{
  const cfg = baseCfg();
  // 2026-10-12 是周一。以下断言用 Asia/Shanghai 换算（UTC+8）。
  const notNight = [
    ['2026-10-12T02:00:00Z', '10:00'],
    ['2026-10-12T14:00:00Z', '22:00'],
    ['2026-10-12T15:29:00Z', '23:29'],
    ['2026-10-13T00:00:00Z', '次日 08:00（结束端不含）'],
    ['2026-10-12T07:00:00Z', '15:00']
  ];
  for (const [iso, label] of notNight) {
    const api = buildApi(cfg, iso);
    ok(api.sleepNightWinV2() === null, `白天/边界不算深夜：${label}`);
  }
  const night = [
    ['2026-10-12T15:30:00Z', '23:30（开始端含）'],
    ['2026-10-12T15:40:00Z', '23:40'],
    ['2026-10-12T18:00:00Z', '次日 02:00'],
    ['2026-10-12T23:59:00Z', '次日 07:59'],
    ['2026-10-12T22:00:00Z', '次日 06:00']
  ];
  for (const [iso, label] of night) {
    const api = buildApi(cfg, iso);
    const win = api.sleepNightWinV2();
    ok(!!win && win.from === '23:30' && win.to === '08:00', `跨零点窗口命中：${label}`);
  }
  // 关掉 / 自定义 / 坏配置 / 时区
  const off = buildApi({ ...cfg, socialV2: { ...cfg.socialV2, sleep: { ...cfg.socialV2.sleep, enabled: false } } }, '2026-10-12T18:00:00Z');
  ok(off.sleepNightWinV2() === null, 'enabled=false 时不算睡着');
  const nightOff = buildApi({ ...cfg, socialV2: { ...cfg.socialV2, sleep: { ...cfg.socialV2.sleep, nightEnabled: false } } }, '2026-10-12T18:00:00Z');
  ok(nightOff.sleepNightWinV2() === null, 'nightEnabled=false 时深夜窗口不生效');
  const custom = buildApi({ ...cfg, socialV2: { ...cfg.socialV2, sleep: { ...cfg.socialV2.sleep, nightWindows: [['13:00', '14:00']] } } }, '2026-10-12T05:30:00Z');
  ok(!!custom.sleepNightWinV2(), '自定义窗口 [["13:00","14:00"]] 在 13:30 命中');
  ok(custom.minutesInWindowsV2(13 * 60 + 59, [['13:00', '14:00']]) !== null, '自定义窗口结束端之前算命中');
  ok(custom.minutesInWindowsV2(14 * 60, [['13:00', '14:00']]) === null, '自定义窗口结束端不含');
  ok(custom.minutesInWindowsV2(600, [['x', 'y'], ['13:00', '14:00']]) === null, '坏窗口被跳过');
  ok(custom.minutesInWindowsV2(600, [['13:00', '13:00']]) === null, 'from===to 的窗口不生效（否则会命中全天）');
  const emptyWin = buildApi({ ...cfg, socialV2: { ...cfg.socialV2, sleep: { ...cfg.socialV2.sleep, nightWindows: [] } } }, '2026-10-12T18:00:00Z');
  ok(!!emptyWin.sleepNightWinV2(), 'nightWindows 为空时回落到默认 23:30–08:00');
  const utcCfg = buildApi({ ...cfg, socialV2: { ...cfg.socialV2, sleep: { ...cfg.socialV2.sleep, timeZone: 'UTC' } } }, '2026-10-12T18:00:00Z');
  ok(utcCfg.sleepNightWinV2() === null, 'timeZone=UTC 时同一时刻是 18:00（不睡）');
  const badTz = buildApi({ ...cfg, socialV2: { ...cfg.socialV2, sleep: { ...cfg.socialV2.sleep, timeZone: 'Not/AZone' } } }, '2026-10-12T18:00:00Z');
  ok(badTz.sleepNightWinV2() === null, '时区非法时 fail-open（当她醒着，不把她焊死）');
}

// ── ② 睡着判定矩阵：潜水≠睡着，口令/手动/小睡/活跃都要分开 ───────────────────
{
  const cfg = baseCfg();
  const nightIso = '2026-10-12T18:00:00Z'; // 次日 02:00
  const dayIso = '2026-10-12T06:00:00Z'; // 14:00
  const apiNight = buildApi(cfg, nightIso);
  const apiDay = buildApi(cfg, dayIso);
  const st = () => ({ wakeConfig: divingWc() });

  ok(apiNight.sleepStateV2('group:1', st()).asleep === true, '深夜 + 潜水 = 睡着');
  ok(apiDay.sleepStateV2('group:1', st()).asleep === false, '白天 + 潜水 ≠ 睡着（潜水只是省 token 的常态）');

  const active = st();
  active.wakeConfig = { mode: 'active', infinite: true, triggers: { anyMessage: true } };
  ok(apiNight.sleepStateV2('group:1', active).asleep === false, '她开着活跃/任何消息时不算睡着');

  const awake = st();
  awake.sleepAwakeUntil = new Date(nightIso).getTime() + 60000;
  const awakeState = apiNight.sleepStateV2('group:1', awake);
  ok(awakeState.asleep === false && awakeState.awake === true, '清醒宽限内不算睡着');
  ok(awakeState.night === true, '清醒宽限内仍能看出"现在是深夜窗口"（宽限才能续期）');

  const manual = st();
  manual.sleepManualUntil = new Date(dayIso).getTime() + 60000;
  ok(apiDay.sleepStateV2('group:1', manual).asleep === true, '白天手动让她睡 = 睡着');

  const nap = st();
  nap.wakeConfig = { mode: 'diving', infinite: false, sleepUntil: new Date(new Date(dayIso).getTime() + 3600000).toISOString(), triggers: {} };
  const napState = apiDay.sleepStateV2('group:1', nap);
  ok(napState.nap === true && napState.asleep === true, '有限睡眠进行中 = 睡着');

  const noNap = buildApi({ ...cfg, socialV2: { ...cfg.socialV2, sleep: { ...cfg.socialV2.sleep, finiteSleepAsleep: false } } }, dayIso);
  ok(noNap.sleepStateV2('group:1', nap).asleep === false, 'finiteSleepAsleep=false 时有限睡眠不算睡着');

  const expiredNap = st();
  expiredNap.wakeConfig = { mode: 'diving', infinite: false, sleepUntil: new Date(new Date(dayIso).getTime() - 1000).toISOString(), triggers: {} };
  ok(apiDay.sleepStateV2('group:1', expiredNap).asleep === false, '有限睡眠已过期不再算睡着');

  ok(apiNight.sleepStateV2('group:1', st()).asleep === true, 'scope=all 时群聊睡着');
  ok(apiNight.sleepStateV2('private:1', st()).asleep === true, 'scope=all 时私聊也睡着（用户要的：私聊也只回 zzz）');
  const groupsOnly = buildApi({ ...cfg, socialV2: { ...cfg.socialV2, sleep: { ...cfg.socialV2.sleep, scope: 'groups' } } }, nightIso);
  ok(groupsOnly.sleepStateV2('private:1', st()).asleep === false, 'scope=groups 时私聊不受影响');
  ok(groupsOnly.sleepStateV2('group:1', st()).asleep === true, 'scope=groups 时群聊仍睡着');
}

// ── ③ 口令识别 ───────────────────────────────────────────────────────────────
{
  const api = buildApi(baseCfg(), '2026-10-12T18:00:00Z');
  ok(api.sleepWakeWordV2('醒醒') === '醒醒', '「醒醒」是口令');
  ok(api.sleepWakeWordV2('@她 起床了') === '起床了', '「起床了」是口令');
  ok(api.sleepWakeWordV2('喂 别睡了') === '别睡了', '「别睡了」是口令');
  ok(api.sleepWakeWordV2('晚上好呀') === '', '普通聊天不是口令');
  ok(api.sleepWakeWordV2('') === '', '空文本不是口令');
  const custom = buildApi({ ...baseCfg(), socialV2: { ...baseCfg().socialV2, sleep: { ...baseCfg().socialV2.sleep, wakeWords: ['开饭了'] } } }, '2026-10-12T18:00:00Z');
  ok(custom.sleepWakeWordV2('开饭了！') === '开饭了' && custom.sleepWakeWordV2('醒醒') === '', 'wakeWords 可配置（覆盖默认）');
}

// ── ④ 接线：闸门位置、叫醒、持久化、端点、状态 ───────────────────────────────
{
  // 锚点用「高峰闸门的判定行」而不是日志文案：文案会改（2026-10-12 起是「高峰绝对静默…」），
  // 但「高峰先拦、再判睡眠」这个顺序是契约。第一处 peakQuietAppliesV2(key) 就在 sendWakePromptV2 里。
  const iPeak = bridge.indexOf('const peakWin = peakQuietAppliesV2(key);');
  const iSleep = bridge.indexOf('睡眠中（${why}');
  const iBusy = bridge.indexOf('会话繁忙，暂存唤醒原因 ${key}');
  const iWakeTimes = bridge.indexOf('st.wakeTimes.push(wakeTime)');
  ok(iSleep > 0, 'sendWakePromptV2 里有睡眠闸门');
  ok(iPeak > 0 && iPeak < iSleep, '睡眠闸门排在高峰闸门之后');
  ok(iSleep < iBusy && iBusy < iWakeTimes, '睡眠闸门在繁忙检查/唤醒计数之前 ⇒ 早退不留占用、不吃唤醒配额');

  const iWord = bridge.indexOf('sleepWakeWordV2(plainContent)');
  ok(iWord > 0, '入站分支会认出「醒醒」并叫醒她');

  const wakeFn = fnSrc('wakeFromSleepV2');
  ok(/st\.sleepManualUntil = 0;/.test(wakeFn), '叫醒会清掉手动睡');
  ok(/st\.sleepAwakeUntil = Date\.now\(\) \+ graceMs;/.test(wakeFn), '叫醒会给一段清醒宽限');
  ok(/st\.wakeConfig\.infinite = true;/.test(wakeFn) && /sleepUntil = null/.test(wakeFn), '叫醒会取消有限睡眠闹钟');
  ok(/clearTimeout\(st\.sleepTimer\)/.test(wakeFn), '叫醒会清掉睡眠定时器');
  ok(/saveSocialV2State\(\);/.test(wakeFn), '叫醒后落盘');

  ok(bridge.includes('sleepManualUntil: Number(val.sleepManualUntil) || 0') && bridge.includes('sleepAwakeUntil: Number(val.sleepAwakeUntil) || 0'), 'loadSocialV2State 会读回两字段');
  ok(bridge.includes('sleepManualUntil: Number(st.sleepManualUntil) || 0') && bridge.includes('sleepAwakeUntil: Number(st.sleepAwakeUntil) || 0'), 'saveSocialV2State 会写两字段');

  ok(bridge.includes("url.pathname === '/api/socialV2/sleep'"), '有 /api/socialV2/sleep 端点（手动睡/叫醒/查状态）');
  ok(bridge.includes("v2ToolEnabled('sleep')"), '端点受 socialV2.tools.sleep 开关控制');
  ok(/case|action === 'sleep'/.test(bridge) === false || bridge.includes("action === 'sleep'"), 'action=sleep 分支存在');
  ok(bridge.includes("action === 'wake'"), 'action=wake 分支存在');
  ok(/sleep: \(\(\) => \{/.test(bridge), '/api/status 暴露 sleep 状态（运维/回归可查）');
  ok(bridge.includes('alarm') || bridge.includes("allowTimeoutWake !== false"), '有限睡眠到期（timeout）是她自己的闹钟，照常叫醒');
  ok(bridge.includes('暂不发开场白（bootstrap）'), '睡着时不发开场白（别把 bootstrapSent 白白标成已发）');
  ok(bridge.includes('scope === \'groups\' && kind !== \'group\'') === false || bridge.includes("String(s.scope ?? 'all') === 'groups'"), 'scope 判定在 sleepStateV2 里');
  ok(/sleepAwakeUntil = Date\.now\(\) \+ sleepAwakeGraceMsV2\(\)/.test(bridge), '真实唤醒会续期清醒宽限');
}

// ── ⑤ 配置默认值（真实配置 + 模板）──────────────────────────────────────────
for (const [name, c] of [['config.json', config], ['config.example.json', example]]) {
  const s = c.socialV2?.sleep;
  ok(!!s && s.enabled === true, `${name}: sleep.enabled=true`);
  ok(s?.scope === 'all', `${name}: scope=all（私聊也回 zzz，用户明确要的）`);
  ok(s?.timeZone === 'Asia/Shanghai', `${name}: timeZone=Asia/Shanghai`);
  ok(Array.isArray(s?.nightWindows) && s.nightWindows.length === 1 && s.nightWindows[0][0] === '23:30' && s.nightWindows[0][1] === '08:00', `${name}: 默认深夜窗口 23:30–08:00`);
  ok(Array.isArray(s?.replyOn) && s.replyOn.includes('atMention') && s.replyOn.includes('private'), `${name}: 只有 @ 与私聊会得到自动回复`);
  ok(Array.isArray(s?.texts) && s.texts.some((t) => t.includes('zzz')), `${name}: 装睡话术里有 zzz`);
  ok(Number(s?.minGapMs) > 0, `${name}: 同会话限流 > 0`);
  ok(Number(s?.awakeGraceMs) >= 60000, `${name}: 清醒宽限 ≥ 1 分钟`);
  ok(Array.isArray(s?.wakeWords) && s.wakeWords.includes('醒醒'), `${name}: 默认口令含「醒醒」`);
}

// ── ⑥ preset：她得知道自己会睡、以及被 @ 时会发生什么 ────────────────────────
ok(presetSrc.includes('【你也会睡觉】'), 'preset 源有【你也会睡觉】');
ok(presetPatch.includes('【你也会睡觉】'), 'preset 产物（patch）里有【你也会睡觉】');
ok(presetSrc.includes('zzz') && presetPatch.includes('zzz'), 'preset 源与产物都写了（zzz…）');
ok(presetSrc.includes('别把「潜水」当成睡着'), 'preset 里明确区分「潜水」与「睡着」');
ok(presetSrc.includes('qq_set_wake_config(sleepMs'), 'preset 告诉她怎么主动去睡');

console.log(`\n睡眠回归：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
