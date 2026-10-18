#!/usr/bin/env node
// 测试模式：把「解除时间闸门 + 提高对话上下文」写进 **config.testmode.json**。
//
// 为什么不用改 config.json：scripts/test-sleep.mjs / test-peak-quiet.mjs 会断言 config.json
// 的出厂值（夜间睡觉、高峰静默），直接改会把回归测试变红；而且桥接现在会在启动时把
// config.testmode.json 深合并进配置（见 src/bridge.js loadConfig 的 [测试模式] 段），
// 所以删掉这个文件就完整恢复出厂行为。
//
// 另有一个 config.local.json（个人长期偏好，例如睡前也想聊天）由 loadConfig 一并合并，
// 那个文件不归本脚本管：删掉它同样恢复出厂值。
//
// 用法：
//   node scripts/apply-test-mode.mjs            # 写入覆盖文件 + 确保 role.maxInjectChars
//   node scripts/apply-test-mode.mjs --dry      # 只看差异
//   node scripts/apply-test-mode.mjs --revert   # 删掉覆盖文件并还原 role.maxInjectChars
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const OVERLAY = path.resolve('config.testmode.json');
const CONFIG = path.resolve('config.json');
const PREV = path.resolve('config.testmode-prev.json');

// —— 1) 临时覆盖（写进 config.testmode.json，删文件即恢复）——
const OVERLAY_PATCHES = [
  // 解除时间闸门：测试期别让任何时间规则挡着她回话
  ['socialV2.wake.preSleepWaitEnabled', false, '沉睡前不再强制观察 5 分钟（和 recommendedHint 已写的一致）'],
  ['socialV2.wake.sleepMinMs', 10000, '最短潜水 60s → 10s'],
  ['socialV2.wake.batchWindowMs', 1000, '消息合批窗口 1200 → 1000ms（代码下限）'],
  ['socialV2.wake.maxWakePerMinute', 12, '每分钟唤醒 1 → 12'],
  ['socialV2.wake.maxWakePerHour', 240, '每小时唤醒 30 → 240'],
  ['socialV2.wake.maxWakePerHourPrivate', 240, '每小时私聊唤醒 30 → 240'],
  ['socialV2.wake.catchUpIntervalMs', 15000, '补拉消息检查 45s → 15s'],
  ['socialV2.wake.catchUpMinGapMs', 20000, '补拉最小间隔 60s → 20s'],
  ['socialV2.peakQuiet.enabled', false, '关闭白天高峰静默（09:00-12:00 / 14:00-18:00）'],
  ['socialV2.sleep.nightEnabled', false, '关闭夜间睡眠（不再受 23:30-08:00 限制）'],
  ['socialV2.wait.minQuietAfterNewMs', 500, '新消息后最小静默 3000 → 500ms'],
  ['socialV2.wait.defaultQuietMs', 1000, '默认静默 2500 → 1000ms'],
  ['socialV2.wait.minMs', 1000, '等待下限 5000 → 1000ms'],
  ['socialV2.wait.maxMs', 60000, '等待上限 600000 → 60000ms（代码还会再压到 ≤120s）'],
  ['socialV2.send.firstDelayEnabled', false, '关闭首条打字延迟（测试要快；改 true 恢复拟人延迟）'],
  ['socialV2.send.longGapProbability', 0, '取消偶发长间隔'],
  ['socialV2.mood.holdMs', 600000, '情绪保鲜期 15min → 10min（更容易观察到情绪变化）'],
  ['socialV2.proactive.checkIntervalMinMs', 600000, '主动冒泡检查下限 45min → 10min'],
  ['socialV2.proactive.checkIntervalMaxMs', 1800000, '主动冒泡检查上限 90min → 30min'],
  ['socialV2.proactive.idleThresholdMs', 300000, '主动冒泡空闲阈值 20min → 5min'],
  // 提高对话上下文：她能看到更多、记得更久
  ['socialV2.context.wakeMaxChars', 6000, '唤醒快照上限 1800 → 6000 字'],
  ['socialV2.context.wakeMessageLimit', 20, '快照条数 8 → 20'],
  ['socialV2.context.wakeRecentLimit', 12, '近期消息条数 4 → 12'],
  ['socialV2.context.recentLimit', 80, '会话近期消息 40 → 80'],
  ['socialV2.context.unreadLimit', 40, '未读上限 20 → 40'],
  ['socialV2.context.contextWindow', 40, '上下文窗口 12 → 40'],
  ['socialV2.context.rotateAfterTurns', 40, '会话轮换轮数 20 → 40（更少冷启动）'],
  ['socialV2.context.rotateAtContextTokens', 110000, '会话轮换阈值 80000 → 110000 token（给 128k 留余量）'],
  ['socialV2.context.recapMaxChars', 2000, '冻结摘要上限 1600 → 2000 字'],
  ['socialV2.context.recapMinNewMessages', 10, '摘要刷新阈值 20 → 10 条'],
  ['socialV2.context.wakeBudgetChars', 14000, '唤醒提示预算 9000 → 14000 字'],
  ['socialV2.memoryDb.maxChars', 1200, '记忆块上限 800 → 1200 字'],
  ['socialV2.memoryDb.interestMaxChars', 600, '兴趣块上限 420 → 600 字'],
  ['socialV2.memoryDb.recallMaxChars', 400, '回忆检索上限 300 → 400 字'],
  ['social.contextWindow', 40, '一代社交上下文窗口 20 → 40'],
];

// —— 2) 永久项（写 config.json：完整角色卡约 2.2 万字，需 30000 才不截断）——
const PERMANENT = [['role.maxInjectChars', 30000, '角色卡注入上限 6000 → 30000（完整卡不截断）']];

function getPath(obj, p) {
  let cur = obj;
  for (const key of p.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}
function setPath(obj, p, value) {
  const keys = p.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] === null || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}
const show = (v) => (v === undefined ? '(缺失)' : JSON.stringify(v));

const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

if (flags.has('--revert')) {
  const hadOverlay = fs.existsSync(OVERLAY);
  if (hadOverlay) fs.rmSync(OVERLAY);
  let restored = 0;
  if (fs.existsSync(PREV)) {
    const prev = JSON.parse(fs.readFileSync(PREV, 'utf8'));
    for (const [p, v] of Object.entries(prev)) { setPath(config, p, v); restored++; }
    fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n');
    fs.rmSync(PREV);
  }
  console.log((hadOverlay ? '已删除 config.testmode.json；' : '（本来就没有 config.testmode.json）；') + '还原 config.json ' + restored + ' 项');
  process.exit(0);
}

const rows = [];
const cfgOut = JSON.parse(JSON.stringify(config));
const prev = {};
for (const [p, value, why] of PERMANENT) {
  const before = getPath(config, p);
  prev[p] = before === undefined ? undefined : before;
  if (JSON.stringify(before) !== JSON.stringify(value)) rows.push([p, show(before), show(value), why]);
  setPath(cfgOut, p, value);
}

const overlay = {};
for (const [p, value] of OVERLAY_PATCHES) setPath(overlay, p, value);
const oldOverlay = fs.existsSync(OVERLAY) ? JSON.parse(fs.readFileSync(OVERLAY, 'utf8')) : null;
const overlayRows = OVERLAY_PATCHES.filter(([p, value]) => JSON.stringify(getPath(oldOverlay ?? {}, p)) !== JSON.stringify(value)).length;

console.log('config.testmode.json（' + OVERLAY_PATCHES.length + ' 项覆盖，' + overlayRows + ' 项与现状不同）');
console.log(JSON.stringify(overlay, null, 2));
for (const [p, b, a, why] of rows) console.log(p + '\n    ' + b + ' → ' + a + '   // ' + why);
if (flags.has('--dry')) {
  console.log('\n--dry：未写入');
  process.exit(0);
}
fs.writeFileSync(OVERLAY, JSON.stringify(overlay, null, 2) + '\n');
if (rows.length) {
  fs.copyFileSync(CONFIG, CONFIG + '.bak-testmode-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.writeFileSync(PREV, JSON.stringify(prev, null, 2) + '\n');
  fs.writeFileSync(CONFIG, JSON.stringify(cfgOut, null, 2) + '\n');
}
console.log('\n已写入 ' + OVERLAY + '（删掉它即恢复出厂时间规则）');
if (rows.length) console.log('已写入 ' + CONFIG + '：' + rows.map((r) => r[0]).join(', ') + '（--revert 可还原）');
