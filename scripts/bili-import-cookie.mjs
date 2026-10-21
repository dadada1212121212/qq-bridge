// [养鱼 2026-10-19] B 站登录 cookie 导入器。
//
// 用法（主人手动跑一次）：
//   1. 浏览器登录 B 站 → F12 → Network → 随便一个 api.bilibili.com 请求 → Request Headers
//      → 复制整行 Cookie: 的值（很长一串；带不带 "Cookie:" 前缀都行）。
//   2. node scripts/bili-import-cookie.mjs --stdin
//      粘贴后：Git Bash 按 Ctrl+D；cmd / PowerShell 按 Ctrl+Z 再回车。
//      （推荐 --stdin：cookie 不会进 shell 历史，也不会出现在进程命令行里。）
//      也可以直接：node scripts/bili-import-cookie.mjs "<整串 cookie>"
//   3. 写入 state/bili-account.json（.gitignore 已覆盖 state/，绝不入库），
//      并**自动验证一次登录态**，打印登录的账号名/UID 让你确认没导错号。
//   4. 之后随时可以：node scripts/bili-import-cookie.mjs --check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO_ROOT, 'state', 'bili-account.json');

const args = process.argv.slice(2);
const wantStdin = args.includes('--stdin');
const wantCheck = args.includes('--check');
const positional = args.filter((a) => !a.startsWith('--'));

/** 读整个 stdin（--stdin 用）。 */
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

/** 用已存 cookie 调 nav 接口验证登录态，成功时返回账号信息。 */
async function verify() {
  const { createBili } = await import('../src/bilibili-lib.js');
  const bili = createBili({ log: () => {} });
  bili._internal.setAuthLoader(async () => JSON.parse(fs.readFileSync(OUT, 'utf8')));
  return bili.me();
}

function printUsage() {
  console.error('用法：');
  console.error('  node scripts/bili-import-cookie.mjs --stdin      # 推荐：粘贴 cookie 后 Ctrl+D / Ctrl+Z 回车');
  console.error('  node scripts/bili-import-cookie.mjs "<cookie>"   # 直接给一串');
  console.error('  node scripts/bili-import-cookie.mjs --check      # 只验证已导入的登录态');
}

if (wantCheck) {
  if (!fs.existsSync(OUT)) {
    console.error('❌ 还没导入过：', OUT, '不存在。先跑 --stdin 导一次。');
    process.exit(1);
  }
  try {
    const m = await verify();
    console.log(`✅ 登录态有效：${m.uname}（Lv.${m.level}，mid=${m.mid}，硬币 ${m.coin}）`);
  } catch (e) {
    console.error('❌ 登录态无效：', e.message);
    process.exit(1);
  }
} else {
  let raw = positional.join(' ').trim();
  if (!raw && wantStdin) raw = (await readStdin()).trim();
  if (!raw) { printUsage(); process.exit(1); }

  // 允许直接粘贴 "Cookie: a=b; c=d" 整行，也允许被引号包着。
  raw = raw.replace(/^\s*cookie\s*:\s*/i, '').replace(/^["']|["']$/g, '').replace(/\r?\n/g, ' ');

  const pick = (name) => {
    const m = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return m ? m[1].trim() : '';
  };
  const account = {
    SESSDATA: pick('SESSDATA'),
    bili_jct: pick('bili_jct'),
    DedeUserID: pick('DedeUserID'),
  };
  const missing = Object.entries(account).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error('❌ 这串 Cookie 里缺字段：', missing.join(', '));
    console.error('   确认你复制的是**登录后**的 Cookie（必须含 SESSDATA / bili_jct / DedeUserID）。');
    console.error('   如果只看到 SESSDATA，说明账号没真正登录，或复制的是未登录状态的请求。');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(account, null, 2));
  console.log('✅ 已写入', OUT);
  console.log('   这个文件含账号凭据，.gitignore 已确保它不会被提交。');

  // 写完立刻验一次：导入成功 ≠ cookie 有效（可能过期/被风控），当场告诉你。
  try {
    const m = await verify();
    console.log(`✅ 登录态有效：${m.uname}（Lv.${m.level}，mid=${m.mid}，硬币 ${m.coin}）`);
    console.log('   确认上面的账号是你要用的那个；不对就重新导一次。');
  } catch (e) {
    console.error('⚠️ cookie 已保存，但验证失败：', e.message);
    console.error('   常见原因：SESSDATA 过期、复制时截断、或这个号还没在浏览器里完成登录。');
    process.exit(1);
  }
}
