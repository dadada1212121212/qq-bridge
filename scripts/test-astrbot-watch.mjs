// AstrBot 看门狗的判定回归（纯函数，无外部依赖）。
//
// 钉住两件今天凌晨实录换来的教训：
//   ① 系统待机恢复（kernel-power 507）后的「事件循环卡死」是假警报，不许重启 ——
//      05:08:45 进 S0 待机、09:08:03 唤醒，AstrBot 诊断在唤醒后 1 秒记下 12583s，
//      而进程其实健康（WS 自己重连了）。乱重启的代价是每次待机醒来都白打断一次。
//   ② 按命令行匹配杀进程会误伤（实测任何命令行里带 astrbot 字样的进程都匹配），
//      新路必须按端口占用者杀，且脚本里不能再出现 astrbot 字样。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  astrbotStandbyResumeScript,
  shouldSkipAstrbotRestartOnResume,
  astrbotKillByPortScript,
} from '../src/astrbot-watch-lib.js';

test('待机恢复探针：查 kernel-power 507、窗口取绝对值分钟', () => {
  const s = astrbotStandbyResumeScript(10);
  assert.match(s, /Id=507/);
  assert.match(s, /AddMinutes\(-10\)/);
  assert.match(s, /LogName='System'/);
  assert.throws(() => astrbotStandbyResumeScript(0));
  assert.throws(() => astrbotStandbyResumeScript(-5));
  assert.throws(() => astrbotStandbyResumeScript('x'));
});

test('假警报豁免：只有「卡死」+ 最近退出过待机才跳过', () => {
  // 卡死 + 有待机退出 → 跳过（进程健康，重启是白打断）
  assert.equal(shouldSkipAstrbotRestartOnResume('事件循环卡死 12583s（最近 10 分钟内）', 2), true);
  // 卡死 + 没待机退出 → 照旧重启（可能是真冻死）
  assert.equal(shouldSkipAstrbotRestartOnResume('事件循环卡死 12583s（最近 10 分钟内）', 0), false);
  // 端口探活失败不算待机假警报，再多待机退出也照旧重启（进程可能真死了）
  assert.equal(shouldSkipAstrbotRestartOnResume('端口探活失败（fetch failed）', 5), false);
  // 没异常不许跳过；resumeCount 非数字按 0 算
  assert.equal(shouldSkipAstrbotRestartOnResume('', 5), false);
  assert.equal(shouldSkipAstrbotRestartOnResume('事件循环卡死 30s', 'NaN'), false);
});

test('按端口占用者杀：脚本命中端口与 Stop-Process，且不含命令行匹配', () => {
  const s = astrbotKillByPortScript(6185);
  assert.match(s, /-LocalPort 6185/);
  assert.match(s, /Stop-Process -Id \$_ -Force/);
  assert.match(s, /OwningProcess/);
  // 不能退回按命令行匹配的老路：那会误伤命令行里带 astrbot 字样的任意进程
  assert.ok(!s.includes('astrbot'), '杀进程脚本里不许出现 astrbot 字样（防误伤）');
  assert.ok(!s.includes('CommandLine'), '不许按命令行匹配杀进程');
  assert.throws(() => astrbotKillByPortScript(0));
  assert.throws(() => astrbotKillByPortScript('x'));
});
