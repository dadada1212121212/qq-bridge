// [patch 高峰静默 + 群聊报错护栏] 回归网（离线，不需要 QQ 在线）。
//
// 为什么需要这个文件
// ------------------
// 这次加的两件事都属于「做错了也未必看得出来」的类型：
//   ① 高峰静默：DeepSeek 峰谷定价把北京时间工作日 9:00–12:00 / 14:00–18:00 定为高峰
//      （价格是空闲时段的两倍，详见 §0.29）。要求是——高峰里别人说话不叫她、被 @ 只回
//      一句不好意思、窗口结束再补看一眼未读。时区/星期/窗口边界判错，后果分别是「白烧钱」
//      或「该说话时一句话不说」，日志里都只表现为「她今天很安静」。所以这里把判定函数
//      **从 bridge.js 抽出来真跑**，并注入假 Date 覆盖周一/周末/节假日/边界分钟。
//   ② 群聊报错护栏：DSH / OneBot 的报错原文（余额不足、request_id、retcode、堆栈、
//      内部会话 id、⚠️）一个字都不许进群。判在三个文本出口（sendToQQ / sendBurstToQQ /
//      onebotSend），命中就换一句卡壳话术（默认）或整条不发。这里同样把 groupErrorLeakV2
//      抽出来真跑，并且同时钉住「正常聊天别被误判」——误判的代价是她突然不说话。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

const bridgeSrc = read('src/bridge.js') + '\n' + read('src/console-server.js');
const cfg = JSON.parse(read('config.json'));
const example = JSON.parse(read('config.example.json'));

/** 从 bridge.js 里切一段源码出来（找不到就报失败并返回空串）。 */
function sliceBetween(startAnchor, endAnchor, label) {
  const a = bridgeSrc.indexOf(startAnchor);
  const b = a < 0 ? -1 : bridgeSrc.indexOf(endAnchor, a);
  const found = a >= 0 && b > a;
  ok(found, `${label}能在 bridge.js 里定位（${startAnchor.slice(0, 46)}…）`);
  return found ? bridgeSrc.slice(a, b) : '';
}

// 假钟：把提取出来的源码里的 `new Date()` 固定到某个时刻，用于覆盖不同星期/时段。
function fixedDate(ms) {
  return class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(ms); }
    static now() { return ms; }
  };
}

// ── ① 高峰判定：抽源码真跑，注入固定时刻 ─────────────────────────────────────
console.log('## 高峰判定（抽源码真跑）');
const peakSrc = sliceBetween('const PEAK_DEFAULT_WINDOWS_V2', 'const peakResumeTimersV2', '高峰静默 helper 块');
const peakFactory = new Function('cfg', 'Date', `${peakSrc}\nreturn { peakWindowV2, peakQuietAppliesV2, hhmmToMinutesV2 };`);
const peakAt = (ms, peakCfg) => peakFactory({ socialV2: { peakQuiet: peakCfg } }, fixedDate(ms));

{
  // 事实自检：这三个时刻的星期必须是 Mon / Sat / Sun，否则下面的用例全都在测错的日期。
  const cstWeekday = (ms) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(ms));
    const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('weekday')} ${get('hour')}:${get('minute')}`;
  };
  const MON_10 = Date.parse('2026-10-12T02:00:00Z'); // 周一 10:00 北京时间
  const SAT_10 = Date.parse('2026-10-17T02:00:00Z'); // 周六 10:00
  const SUN_10 = Date.parse('2026-10-11T02:00:00Z'); // 周日 10:00
  ok(cstWeekday(MON_10).startsWith('Mon 10:00'), `固定时刻自检：${cstWeekday(MON_10)}（应为 Mon 10:00）`);
  ok(cstWeekday(SAT_10).startsWith('Sat 10:00'), `固定时刻自检：${cstWeekday(SAT_10)}（应为 Sat 10:00）`);
  ok(cstWeekday(SUN_10).startsWith('Sun 10:00'), `固定时刻自检：${cstWeekday(SUN_10)}（应为 Sun 10:00）`);

  const mon = (hh, mm = 0) => MON_10 + ((hh - 10) * 60 + mm) * 60000;
  const W = { windows: [['09:00', '12:00'], ['14:00', '18:00']] }; // 默认 weekdaysOnly / Asia/Shanghai
  const winAt = (ms, c = W) => {
    const w = peakAt(ms, c).peakWindowV2();
    return w ? `${w.from}-${w.to}` : 'null';
  };

  ok(winAt(mon(9)) === '09:00-12:00', '周一 09:00 → 高峰（左端含）');
  ok(winAt(mon(10)) === '09:00-12:00', '周一 10:00 → 高峰 09:00-12:00');
  ok(winAt(mon(11, 59)) === '09:00-12:00', '周一 11:59 → 高峰');
  ok(winAt(mon(12)) === 'null', '周一 12:00 → 不是高峰（右端不含，午休谷段）');
  ok(winAt(mon(13, 59)) === 'null', '周一 13:59 → 不是高峰');
  ok(winAt(mon(14)) === '14:00-18:00', '周一 14:00 → 高峰 14:00-18:00（左端含）');
  ok(winAt(mon(17, 59)) === '14:00-18:00', '周一 17:59 → 高峰');
  ok(winAt(mon(18)) === 'null', '周一 18:00 → 不是高峰（右端不含）');
  ok(winAt(mon(8, 59)) === 'null', '周一 08:59 → 不是高峰');
  ok(winAt(mon(23, 30)) === 'null', '周一 23:30 → 不是高峰（空闲时段便宜）');
  ok(winAt(SAT_10) === 'null', '周六 10:00 → 不是高峰（周末按空闲价）');
  ok(winAt(SUN_10) === 'null', '周日 10:00 → 不是高峰');
  ok(winAt(SAT_10, { ...W, weekdaysOnly: false }) === '09:00-12:00',
    'weekdaysOnly=false 时周六算高峰（开关真的接线了）');
  ok(winAt(mon(10), { ...W, holidays: ['2026-10-12'] }) === 'null',
    '法定节假日表命中当天 → 不是高峰（节假日按空闲价）');
  ok(winAt(mon(10), { ...W, enabled: false }) === 'null', 'enabled=false 时整体停用');
  ok(winAt(mon(10), { windows: [] }) === '09:00-12:00', 'windows 为空时退回内置默认窗口（不静默失效）');
  ok(winAt(mon(10), { windows: [['bad', '12:00'], ['09:00', '12:00']] }) === '09:00-12:00',
    '窗口写坏一条不影响另一条（跳过非法项而不是整个停摆）');
  ok(winAt(mon(15), { windows: [['09:00', '12:00']] }) === 'null', '自定义窗口被尊重（15:00 不在自定义窗口里）');
  ok(winAt(mon(0, 30), { windows: [['23:00', '01:00']] }) === '23:00-01:00', '跨零点窗口也认（23:00-01:00 里 00:30）');
  ok(winAt(Date.parse('2026-10-12T10:00:00Z'), { timeZone: 'UTC', windows: [['09:00', '12:00']] }) === '09:00-12:00',
    'timeZone 被真正使用（10:00 UTC 在 UTC 口径下是高峰）');
  ok(winAt(Date.parse('2026-10-12T10:00:00Z'), W) === 'null',
    '同一时刻用北京时间算是 18:00 → 不是高峰（时区没写死成 UTC）');
  ok(winAt(mon(10), { timeZone: 'Not/AZone' }) === 'null',
    '时区非法 → 判不了高峰（fail-open：宁可她说话，也不因为配置写错就永久静默）');

  const hhmm = (v) => peakAt(mon(10), {}).hhmmToMinutesV2(v);
  ok(hhmm('09:00') === 540 && hhmm('9:05') === 545, 'HH:MM 解析：09:00 → 540、9:05 → 545');
  ok(hhmm('24:00') === -1 && hhmm('12:60') === -1 && hhmm(null) === -1 && hhmm('abc') === -1,
    '非法 HH:MM 一律 -1（不会被当成合法窗口）');

  const applies = (ms, key, c = W) => !!peakAt(ms, c).peakQuietAppliesV2(key);
  ok(applies(mon(10), 'group:429626254') === true, '默认 scope=groups：高峰里群聊要静默');
  ok(applies(mon(10), 'private:10001') === false, '默认 scope=groups：主人私聊任何时候都能说话');
  ok(applies(mon(10), 'private:10001', { ...W, scope: 'all' }) === true, "scope='all' 时私聊也静默");
  ok(applies(mon(10), 'group:941963830', { ...W, exemptGroups: ['941963830'] }) === false,
    'exemptGroups 里的群豁免（默认只留私聊窗口，这里是在钉「豁免真的生效」）');
  ok(applies(mon(10), 'group:429626254', { ...W, exemptGroups: ['941963830'] }) === true,
    '豁免名单只影响列出的群');
  ok(applies(mon(12), 'group:429626254') === false, '谷段群里照常（静默只覆盖高峰窗口）');
}

// ── ② 唤醒闸门接线 ──────────────────────────────────────────────────────────
console.log('## 唤醒闸门接线');
{
  const at = bridgeSrc.indexOf('async function sendWakePromptV2(');
  ok(at > 0, '能找到 sendWakePromptV2（真的开回合的唯一入口）');
  // 窗口给足 6000 字符：sendWakePromptV2 里前半段是提示词拼装，闸门到 isConversationBusyV2
  // 之间早就不止 3000 字了 —— 窗口太小会把"顺序正确"误判成"顺序错了"。
  const body = at > 0 ? bridgeSrc.slice(at, at + 6000) : '';
  ok(/const peakWin = peakQuietAppliesV2\(key\);/.test(body), 'sendWakePromptV2 里先算高峰窗口');
  ok(/if \(peakWin\) \{/.test(body), '命中高峰就直接 return（不开回合 = 不烧 token）');
  ok(body.indexOf('if (peakWin)') >= 0 && body.indexOf('if (peakWin)') < body.indexOf('isConversationBusyV2'),
    '闸门排在「忙判定」之前（否则高峰里还会继续堆唤醒原因）');
  ok(/peakQuietCfgV2\(\)\.resumeAfter === true/.test(body), '静默时补唤醒被 resumeAfter 门禁挡住');
  ok(body.indexOf('resumeAfter === true') < body.indexOf('schedulePeakResumeV2(key, peakWin)'),
    '默认不排队补唤醒（用户 m03167：信息队列禁止、要绝对静默）');

  const wp = sliceBetween('const WAKE_PRIORITY = {', '  };', 'WAKE_PRIORITY 表');
  ok(/peakResume: 25/.test(wp), 'WAKE_PRIORITY 登记了 peakResume（否则补唤醒优先级算成 0）');

  const ingestAt = bridgeSrc.indexOf('const reason = evaluateWakeTriggerV2(');
  const ingest = ingestAt > 0 ? bridgeSrc.slice(ingestAt, ingestAt + 1400) : '';
  ok(/const peakWin = peakQuietAppliesV2\(key\);/.test(ingest), '入站消息先判高峰');
  ok(/高峰绝对静默（\$\{peakWin\.from\}/.test(ingest), '入站高峰时记「只入库不唤醒」');
  ok(/String\(reason\)\.split\(':'\)\[0\] === 'atMention'/.test(ingest), '只有被 @ 才触发罐头道歉（别人说话一律不理）');
  ok(/await sendPeakApologyV2\(key, event\)/.test(ingest), '被 @ 时走 sendPeakApologyV2');
  ok(/resumeAfter === true\) schedulePeakResumeV2\(key, peakWin\);/.test(ingest),
    '入站也不排队补唤醒（resumeAfter 默认关）');

  const clearAt = bridgeSrc.indexOf('function clearSocialV2Timers(');
  const clearBody = clearAt > 0 ? bridgeSrc.slice(clearAt, clearAt + 1500) : '';
  ok(/peakResumeTimersV2/.test(clearBody), 'clearSocialV2Timers 会清掉补看定时器（会话退役不留孤儿）');

  const statusAt = bridgeSrc.indexOf("url.pathname === '/api/status'");
  const statusBody = statusAt > 0 ? bridgeSrc.slice(statusAt, statusAt + 6000) : '';
  ok(/peakQuiet/.test(statusBody), '/api/status 暴露 peakQuiet（运维/回归能直接查现在是不是静默）');
}

// ── ③ 群聊报错护栏：抽源码真跑 ──────────────────────────────────────────────
console.log('## 群聊报错护栏（抽源码真跑）');
const guardSrc = sliceBetween('const GROUP_ERROR_LEAK_PATTERNS_V2', 'const groupLeakNotifyAtV2', '群聊报错护栏块');
const guardFactory = new Function('cfg', `${guardSrc}\nreturn { groupErrorLeakV2, groupSafetyCfg };`);
const guard = guardFactory({ socialV2: { groupSafety: {} } });
{
  const mustBlock = [
    '⚠️ agent 处理出错：Insufficient Balance (request_id: 7f3a1c)',
    'Error: DeepSeek Messages request failed (400)',
    'OneBot send_group_msg 失败: retcode 1200',
    'connect ECONNREFUSED 127.0.0.1:3000',
    'TypeError: x is not a function\n    at foo (/app/b.js:12:5)',
    '会话繁忙，暂存唤醒原因 group:429626254',
    '旧映射 session-cf50aef3-70da-4b14-bb48-20ce31224a5c 已退役重建',
    '未授权：请提供控制台访问令牌',
    '调用失败：api_key: sk-abc123',
    '调用失败，堆栈如下：',
    'DEEPSEEK_API_KEY 未配置',
    '[预算] 唤醒提示 9300 字 > 9000，裁到 8711 字',
    'DSH 不可用（重启中？），QQ 消息将入队等待',
    '⚠️ 消息未被接受：SESSION_BUSY: 会话忙',
  ];
  for (const text of mustBlock) {
    const label = guard.groupErrorLeakV2(text);
    ok(!!label, `拦下「${text.slice(0, 30)}${text.length > 30 ? '…' : ''}」（命中「${label}」）`);
  }
  ok(guard.groupErrorLeakV2(mustBlock[0]) === '余额不足', '最常见的那种（余额不足）命中的是最准的标签');
  ok(guard.groupErrorLeakV2('OneBot send_group_msg 失败: retcode 1200') === 'retcode', 'retcode 单独成标签（排查时要能一眼认出）');

  const mustPass = [
    '哈哈哈哈这个也太离谱了',
    '你在说什么呀？我刚刚在吃饭',
    '这个报错好像是因为没装依赖',
    '（雾汐卡了一下，等我缓过来再回你）',
    '明天见！',
    '我发的图怎么没上去',
    '🐟',
    '',
  ];
  for (const text of mustPass) {
    ok(!guard.groupErrorLeakV2(text), `不拦正常内容：${text === '' ? '(空串)' : `「${text}」`}`);
  }
  ok(!guard.groupErrorLeakV2('（雾汐卡了一下，等我缓过来再回你）'),
    '兜底话术本身能过关（否则护栏会自己拦自己，变成永久静默）');

  const guardOff = guardFactory({ socialV2: { groupSafety: { blockErrorText: false } } });
  ok(!guardOff.groupErrorLeakV2('⚠️ Insufficient Balance'), 'blockErrorText=false 时整体放行（应急开关真的接线了）');
}

// ── ④ 护栏接线：三个文本出口都要走它 ────────────────────────────────────────
console.log('## 护栏接线（三个文本出口）');
{
  const toqqAt = bridgeSrc.indexOf('function sendToQQ(key, msg) {');
  const toqq = toqqAt > 0 ? bridgeSrc.slice(toqqAt, toqqAt + 900) : '';
  ok(/guardGroupOutboundV2\(key, stripLoneSurrogates\(redactKnownTokensOnly\(msg\)\)\)/.test(toqq),
    'sendToQQ 走护栏（机械话术 / 兜底话术 / 「消息未被接受」都从这里出去）');
  const burstAt = bridgeSrc.indexOf('function sendBurstToQQ(');
  const burst = burstAt > 0 ? bridgeSrc.slice(burstAt, burstAt + 1400) : '';
  ok(/guardGroupOutboundV2\(key, redactKnownTokensOnly\(messages\[i\]\)\)/.test(burst),
    'sendBurstToQQ 走护栏（她真正的回复分条出口）');
  const oneAt = bridgeSrc.indexOf('async function onebotSend(');
  const one = oneAt > 0 ? bridgeSrc.slice(oneAt, oneAt + 1200) : '';
  ok(/guardGroupOutboundV2\(`\$\{kind\}:\$\{id\}`, rawMessage\)/.test(one),
    'onebotSend 走护栏（agent 主动发消息 / 命令结果出口）');
  ok(one.indexOf('guardGroupOutboundV2') > one.indexOf('发送内容包含会话令牌'),
    '护栏排在令牌拦截之后（先拦令牌，再判报错）');

  const helperAt = bridgeSrc.indexOf('function guardGroupOutboundV2(');
  const helper = helperAt > 0 ? bridgeSrc.slice(helperAt, helperAt + 1800) : '';
  ok(/if \(kind !== 'group'\) return \{ text: raw, dropped: false, leak: '' \};/.test(helper),
    '只拦群聊（主人私聊是运维窗口，报错要照实告诉他）');
  ok(/softFailLineV2\(\)/.test(helper) && /action === 'drop'/.test(helper),
    '命中后默认换卡壳话术；action=drop 时整条不发');
  ok(/notifyOwnerOfGroupLeakV2\(id, leak, raw\)/.test(helper), '命中后私聊通知主人（不静默吞掉）');

  const rawSends = [...bridgeSrc.matchAll(/bot\.sendGroupMessage\(/g)].map((m) => m.index);
  const testSendAt = bridgeSrc.indexOf("url.pathname === '/api/test-send'");
  const outside = rawSends.filter((idx) => !(idx > testSendAt && idx < testSendAt + 1200));
  ok(outside.length === 2,
    `绕过护栏的原始群发只剩控制台测试发送那一处（实测护栏外的裸群发 ${outside.length} 处，应为 2）`);
}

// ── ⑤ 配置默认值（用户拍板的四件事）─────────────────────────────────────────
console.log('## 配置默认值');
{
  const pq = cfg.socialV2?.peakQuiet ?? {};
  ok(pq.enabled !== false, 'config.json：peakQuiet 默认开');
  ok(pq.scope === 'groups', 'config.json：默认只管群（主人私聊任何时候都能说话）');
  ok(pq.timeZone === 'Asia/Shanghai', 'config.json：按北京时间判高峰');
  ok(Array.isArray(pq.windows) && pq.windows.length === 2
    && String(pq.windows[0]?.[0]) === '09:00' && String(pq.windows[0]?.[1]) === '12:00'
    && String(pq.windows[1]?.[0]) === '14:00' && String(pq.windows[1]?.[1]) === '18:00',
    'config.json：窗口 = 工作日 9–12 / 14–18（DeepSeek 官方峰谷定价）');
  ok(pq.weekdaysOnly !== false, 'config.json：只工作日静默（周末按空闲价）');
  ok(Array.isArray(pq.holidays) && pq.holidays.length === 0, 'config.json：节假日表留空（没瞎填，主人可自己补）');
  ok(Array.isArray(pq.apologyOn) && pq.apologyOn.length === 0,
    'config.json：高峰期一条道歉都不发（apologyOn 空 = 绝对静默）');
  ok(pq.resumeAfter === false, 'config.json：resumeAfter=false —— 高峰消息不排队、不补做（用户 m03167）');
  ok(typeof pq.apology === 'string' && pq.apology.includes('{name}'), 'config.json：道歉文本带 {name} 占位');
  ok(Number(pq.apologyMinGapMs) > 0, 'config.json：道歉有最小间隔（防刷屏）');

  const gs = cfg.socialV2?.groupSafety ?? {};
  ok(gs.blockErrorText !== false, 'config.json：群聊报错护栏默认开');
  ok(gs.action === 'soft', "config.json：命中后默认换卡壳话术（'drop' 才是整条不发）");
  ok(gs.notifyOwner !== false, 'config.json：拦下后私聊通知主人（不静默吞掉）');
  ok(Number(gs.notifyMinGapMs) > 0, 'config.json：通知有最小间隔');

  const epq = example.socialV2?.peakQuiet ?? {};
  const egs = example.socialV2?.groupSafety ?? {};
  ok(Array.isArray(epq.windows) && epq.windows.length === 2, 'config.example.json 也带 peakQuiet 窗口（模板对得上）');
  ok(egs.action === 'soft' && egs.blockErrorText !== false && egs.notifyOwner !== false,
    'config.example.json 也带 groupSafety 默认值');
  ok(epq.timeZone === 'Asia/Shanghai' && epq.scope === 'groups', 'config.example.json 与真实配置同口径');
  ok(Array.isArray(epq.apologyOn) && epq.apologyOn.length === 0 && epq.resumeAfter === false,
    'config.example.json 也是绝对静默（apologyOn 空 + resumeAfter false）');
}

// ── ⑥ preset：她要读的规矩得真落进产物 ─────────────────────────────────────
console.log('## preset 规矩');
{
  const presetSrc = read('dsh/agent-presets/qq-chat-v2/agent.cordis.yml');
  const patch = read('plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml');
  ok(/【群里绝不出现技术报错】/.test(presetSrc), 'preset 源有【群里绝不出现技术报错】这一条');
  ok(/【群里绝不出现技术报错】/.test(patch),
    'DSH 真正加载的 patch 产物里也有（只改源不重生成 = 她压根收不到）');
  ok(/别自己解释|别故意试/.test(presetSrc), 'preset 源写明「发失败就当没发生，别解释、别故意试」');
  ok(/【QQ空间（发说说）】/.test(patch), '原有的 QQ空间那条还在（没被这次改动挤掉）');
}

// ── ⑦ 信息队列禁用（用户 m03167：「信息队列不做，禁止」）──────────────────────
console.log('## 信息队列禁用');
{
  ok(/dshQueueEnabledV2 = \(\) =>/.test(bridgeSrc), '桥接里有 dshQueueEnabledV2 门禁');
  ok(/dshQueueNotifyV2 = \(\) =>/.test(bridgeSrc), '桥接里有 dshQueueNotifyV2 门禁');
  const gateAt = bridgeSrc.indexOf('if (!dshQueueEnabledV2()) {');
  const enqueueAt = bridgeSrc.indexOf('log(`DSH 不可用，消息入队 (${key})`)');
  ok(gateAt > 0 && enqueueAt > 0 && gateAt < enqueueAt,
    'DSH 不可用时先过门禁再入队（默认直接丢，不排队）');
  ok(/if \(dshQueueNotifyV2\(\) &&/.test(bridgeSrc), '「消息已排队」提示过 notify 门禁（默认不发 = 不弹窗）');
  ok(/丢弃 \$\{items\.length\} 条积压唤醒（信息队列已禁用）/.test(bridgeSrc), 'DSH 恢复后不补发积压唤醒');
  ok(/if \(dshQueueEnabledV2\(\)\) \{\s*\n\s*try \{ await flushQueue\(\);/.test(bridgeSrc),
    'DSH 恢复后默认不补投离线积压（直接丢弃）');
  const dq = cfg.socialV2?.dshQueue ?? {};
  ok(dq.enabled === false, 'config.json：dshQueue.enabled=false（信息队列关闭）');
  ok(dq.notify === false, 'config.json：dshQueue.notify=false（连「消息已排队」提示都不发）');
  const edq = example.socialV2?.dshQueue ?? {};
  ok(edq.enabled === false && edq.notify === false, 'config.example.json 也是关的');
}

console.log(`\n高峰静默 + 群聊护栏回归：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
