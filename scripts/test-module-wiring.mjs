// 模块接线回归（2026-10-18）：**桥接引用了某个模块的导出，就必须真的 import 它**。
//
// 为什么需要这条网：把 bridge.js 拆成多个模块时，VM 夹具会把 import 行整体剥掉、
// 改成往 context 里注入 `...moduleLib`，于是「生产缺 import」在测试里完全看不见 ——
// 2026-10-18 三个模块（console-server / wake-prompt / social-state）全都没加 import，
// 测试 52/53 全绿，真实进程一启动就 `ReferenceError: createSocialState is not defined`。
//
// 断言方式：扫 src/*.js 的导出，凡是 bridge.js 里出现「标识符(」的，都必须在
// bridge.js 的 import 语句里出现过。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const bridge = fs.readFileSync(path.join(SRC, 'bridge.js'), 'utf8');

/** 取某个文件里所有 `import { a, b as c } from '...'` 的本地名 */
function importedNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'([^']+)'/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (n) names.add(n);
    }
  }
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s*'([^']+)'/g)) names.add(m[1]);
  return names;
}

const bridgeImports = importedNames(bridge);
// bridge.js 自己声明的名字（main / loadConfig 这类通用名在别的模块里也有导出，
// 不能算成「用了别人的」）
const bridgeOwn = new Set([
  ...bridge.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm),
  ...bridge.matchAll(/^(?:export\s+)?(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm),
  ...bridge.matchAll(/^ {2}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm),
  ...bridge.matchAll(/^ {2}(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm),
].map((m) => m[1]));
let checked = 0;
const missing = [];

for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.js'))) {
  if (file === 'bridge.js') continue;
  const code = fs.readFileSync(path.join(SRC, file), 'utf8');
  const exports = [
    ...code.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm),
    ...code.matchAll(/^export\s+(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm),
  ].map((m) => m[1]);
  for (const name of exports) {
    if (bridgeOwn.has(name)) continue; // bridge.js 自己有同名声明，不是跨模块依赖
    // 只在「被当作函数调用」时才算硬依赖（纯字符串/注释里出现不算）
    if (!new RegExp(`(^|[^\\w$.])${name}\\s*\\(`, 'm').test(bridge)) continue;
    checked++;
    if (!bridgeImports.has(name)) missing.push(`${name}（来自 src/${file}）`);
  }
}

assert.equal(missing.length, 0, `bridge.js 用了但没 import：${missing.join('、')}`);
assert.ok(checked >= 5, `扫描到的跨模块调用太少（${checked} 个），这条网可能失效了`);

// 拆分出来的模块自己也不能漏 import：对 src 下每个模块跑同一套规则。
const selfMissing = [];
for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.js'))) {
  const code = fs.readFileSync(path.join(SRC, file), 'utf8');
  const names = importedNames(code);
  const local = new Set([
    ...code.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm),
    ...code.matchAll(/^ {2}(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm),
  ].map((m) => m[1]));
  // 工厂顶部 `const { a, b } = S;` 解构出来的依赖也算「本地已有」
  for (const m of code.matchAll(/const\s*\{([\s\S]*?)\}\s*=\s*S\s*;/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':').pop()?.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n || '')) local.add(n);
    }
  }
  for (const m of code.matchAll(/(^|[^\w$.])(create[A-Z][\w$]*)\s*\(/gm)) {
    const name = m[2];
    if (local.has(name) || names.has(name)) continue;
    selfMissing.push(`${file}: ${name}`);
  }
}
assert.equal(selfMissing.length, 0, `模块内调用了未导入的工厂：${[...new Set(selfMissing)].join('、')}`);

console.log(`模块接线回归：${checked} 个跨模块调用全部有 import，模块内部工厂调用无遗漏`);
