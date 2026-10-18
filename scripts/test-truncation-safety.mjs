// 截断安全回归（源码级防回归）。
//
// 背景（见 QQ-接入进度与下一步.md §0.21）：`text.slice(0, N) + '…'` 按 UTF-16 **码元**切，
// 切在 emoji / 生僻字的代理对中间会留下「孤代理项」—— 不是一个合法字符，JSON.stringify 把它
// 写成 "\ud83d" 发给 DeepSeek 就直接 400；更糟的是它会**存进会话帧**，之后每一步重发历史都再
// 400 一次，自愈换会话也没用（冻结的 recap 又把毒文本喂回来）。
//
// 所以：会进提示词 / 日志 / 落库的截断一律走 md-to-plain 的 truncateText（绝不切开代理对）。
// 本脚本扫描 src/ 下所有 .js，发现新的「裸 slice + 省略号」就失败 —— 这条线只准收窄不准放宽。
//
// 用法：node scripts/test-truncation-safety.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

// 唯一的白名单：日志里打 token 前缀。token 来自配置/接口，是 ASCII base64/hex，切不出代理对；
// 它也不进提示词、不落库。新增白名单必须在注释里说清「为什么这里不可能有代理对」。
const ALLOW = [
  { file: 'snowluma-conn.js', needle: "token.slice(0, 4) + '…'", why: '日志里的 token 前缀，ASCII，不进提示词' }
];

const BAD = /\.slice\([^)]*\)\s*\+\s*'…'/;

let fail = 0;
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
    if (e.name.endsWith('.js')) files.push(p);
  }
})(SRC);

console.log(`## 扫描 ${files.length} 个源文件：不许「裸 slice + 省略号」`);
for (const file of files) {
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!BAD.test(line)) continue;
    const allowed = ALLOW.find((a) => a.file === rel && line.includes(a.needle));
    if (allowed) {
      console.log(`  ⏭️  ${rel}:${i + 1} 已白名单（${allowed.why}）`);
      continue;
    }
    fail += 1;
    console.error(`  ❌ ${rel}:${i + 1} 裸 slice + 省略号：${line.trim()}`);
    console.error('     → 改成 truncateText(值, N) + \'…\'（或 truncateTextTail），绝不切开代理对');
  }
}
if (fail === 0) console.log('  ✅ 没有发现裸 slice 截断');

// 关键路径抽查：提示词投递与 QQ 发送两头都装了 stripLoneSurrogates 兜底。
console.log('## 投递/发送咽喉必须兜底 stripLoneSurrogates');
const bridge = fs.readFileSync(path.join(SRC, 'bridge.js'), 'utf8');
const checks = [
  ['提示词投递 withSlangContext 兜底', /function withSlangContext[\s\S]{0,900}?return stripLoneSurrogates\(/.test(bridge)],
  ['QQ 发送 sendToQQ 兜底', /function sendToQQ[\s\S]{0,400}?stripLoneSurrogates\(/.test(bridge)],
  ['冻结 recap 生成时洗净', /st\.recap = \{ text/.test(bridge) && /text = stripLoneSurrogates\(text\)/.test(bridge)],
  ['冻结 recap 读缓存时洗净（且把清洗结果就地写回，避免每轮重洗）', /const clean = stripLoneSurrogates\(rec\.text\)[\s\S]{0,600}?return clean;/.test(bridge) && /if \(clean !== rec\.text\)[\s\S]{0,300}?saveSocialV2State\(\)/.test(bridge)]
];
for (const [name, ok] of checks) {
  if (ok) console.log(`  ✅ ${name}`);
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

if (fail > 0) {
  console.log(`\n❌ ${fail} 项失败`);
  process.exit(1);
}
console.log('\n🎉 截断安全全部通过');
