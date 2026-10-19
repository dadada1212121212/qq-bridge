// [养鱼 2026-10-19] B 站登录 cookie 导入器。
//
// 用法（主人手动跑一次）：
//   1. 浏览器登录 B 站 → F12 → Network → 随便一个 api.bilibili.com 请求 → Request Headers
//      → 复制整行 Cookie: 的值（很长一串）。
//   2. node scripts/bili-import-cookie.mjs "把整串粘在这里"
//   3. 会生成 state/bili-account.json（gitignore 已覆盖 state/，绝不入库）。
//      之后可以跑：node scripts/bili-import-cookie.mjs --check 验证登录态。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO_ROOT, 'state', 'bili-account.json');

const raw = process.argv[2] || '';
if (!raw || raw === '--check') {
  // --check：直接调 nav 验证已存的 cookie
  if (raw === '--check') {
    const { createBili } = await import('../src/bilibili-lib.js');
    const bili = createBili({ log: () => {} });
    bili._internal.setAuthLoader(async () => JSON.parse(fs.readFileSync(OUT, 'utf8')));
    try {
      const m = await bili.me();
      console.log(`✅ 登录态有效：${m.uname}（Lv.${m.level}，mid=${m.mid}，硬币 ${m.coin}）`);
    } catch (e) {
      console.error('❌ 登录态无效：', e.message);
      process.exit(1);
    }
  } else {
    console.error('用法：node scripts/bili-import-cookie.mjs "<整串 Cookie 值>"   或   --check 验证已导入的');
    process.exit(1);
  }
} else {
  const pick = (name) => {
    const m = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return m ? m[1].trim() : '';
  };
  const account = { SESSDATA: pick('SESSDATA'), bili_jct: pick('bili_jct'), DedeUserID: pick('DedeUserID') };
  const missing = Object.entries(account).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error('❌ 这串 Cookie 里缺字段：', missing.join(', '), '——确认你复制的是**登录后**的 Cookie（要包含 SESSDATA）');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(account, null, 2));
  console.log('✅ 已写入', OUT);
  console.log('   现在跑 node scripts/bili-import-cookie.mjs --check 验证登录态。');
  console.log('   注意：这个文件含账号凭据，.gitignore 已确保它不会被提交。');
}
