// [省步 nudge 2026-10-19] 回归网：回合内连续 N 步没发消息才补一句收尾 nudge。
// 纯判定函数 stepNudgeDueV2 / stepNudgeCfgV2 从 bridge.js 源码里抽出来真跑（同 test-thinking-filler 的路数）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ✅ ' + name); }
  else { fail += 1; console.error('  ❌ ' + name); }
}

function sliceFn(name) {
  const start = bridgeSrc.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const end = bridgeSrc.indexOf('\n  }', start);
  return end > 0 ? bridgeSrc.slice(start, end + 4) : '';
}

const dueSrc = sliceFn('stepNudgeDueV2');
const cfgSrc = sliceFn('stepNudgeCfgV2');
ok(dueSrc.length > 0, '在 bridge.js 里找到了 stepNudgeDueV2 的完整函数体');
ok(cfgSrc.length > 0, '在 bridge.js 里找到了 stepNudgeCfgV2 的完整函数体');

let due = null;
let makeCfg = null;
try {
  due = new Function(dueSrc + '\n    return stepNudgeDueV2;')();
  makeCfg = (c) => new Function('cfg', cfgSrc + '\n    return stepNudgeCfgV2;')({ socialV2: { stepNudge: c } })();
} catch (error) {
  ok(false, '函数体可编译（' + (error?.message ?? error) + '）');
}

if (due) {
  ok(due({ enabled: true, steps: 3, afterSteps: 3, nudged: false, sentOrPending: false, turnMatches: true }) === true, '3 步没发消息 → 触发 nudge');
  ok(due({ enabled: true, steps: 2, afterSteps: 3, nudged: false, sentOrPending: false, turnMatches: true }) === false, '步数没到 → 不触发');
  ok(due({ enabled: true, steps: 5, afterSteps: 3, nudged: true, sentOrPending: false, turnMatches: true }) === false, '本回合已 nudge 过 → 不重复');
  ok(due({ enabled: true, steps: 5, afterSteps: 3, nudged: false, sentOrPending: true, turnMatches: true }) === false, '已发过消息/有发送在途 → 不触发');
  ok(due({ enabled: true, steps: 5, afterSteps: 3, nudged: false, sentOrPending: false, turnMatches: false }) === false, 'turn 已换代（旧计数）→ 不触发');
  ok(due(null) === false, '空信息 → 不触发');
  ok(due({ enabled: false, steps: 9, afterSteps: 3, nudged: false, sentOrPending: false, turnMatches: true }) === false, '开关关闭 → 不触发');
}
if (makeCfg) {
  ok(makeCfg(undefined).enabled === true && makeCfg(undefined).afterSteps === 3, '缺省：开、3 步');
  ok(makeCfg({ afterSteps: 99 }).afterSteps === 8, 'afterSteps 上限钳到 8');
  ok(makeCfg({ afterSteps: 1 }).afterSteps === 2, 'afterSteps 下限钳到 2');
  ok(makeCfg({ enabled: false }).enabled === false, '可显式关闭');
}

console.log(`test-step-nudge: ${pass} 过 / ${fail} 败`);
process.exitCode = fail ? 1 : 0;
