// [养鱼 2026-10-21] B 站扫码登录器。
//
// 用法（主人手动跑）：
//   node scripts/bili-login-qr.mjs              # 生成二维码（终端 + PNG），轮询到扫码成功
//   node scripts/bili-login-qr.mjs --timeout 300
//   node scripts/bili-login-qr.mjs --check      # 只验证已导入的登录态
//
// 和 bili-import-cookie.mjs 的关系：两条路写的是同一个文件 state/bili-account.json。
// 扫码更省事（不用翻 F12 复制长串）；cookie 导入适合扫码不方便时。
//
// 二维码会存成 state/bili-login-qr.png（state/ 已被 .gitignore 覆盖），
// 终端里也会画一份，方便直接在命令行扫。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { createBili, parseQrLoginUrl } from '../src/bilibili-lib.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO_ROOT, 'state', 'bili-account.json');
const QR_PNG = path.join(REPO_ROOT, 'state', 'bili-login-qr.png');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, referer: 'https://www.bilibili.com/' };

const args = process.argv.slice(2);
const wantCheck = args.includes('--check');
const timeoutIdx = args.indexOf('--timeout');
const timeoutSec = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) || 180 : 180;

async function json(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function generate() {
  const j = await json('https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header');
  if (j.code !== 0 || !j.data?.url) throw new Error(`生成二维码失败：code=${j.code} ${j.message || ''}`);
  return { url: j.data.url, key: j.data.qrcode_key };
}

async function poll(key) {
  const j = await json('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key='
    + encodeURIComponent(key) + '&source=main-fe-header');
  if (j.code !== 0) throw new Error(`轮询失败：code=${j.code} ${j.message || ''}`);
  return j.data || {};
}

async function verify() {
  const bili = createBili({ log: () => {} });
  bili._internal.setAuthLoader(async () => JSON.parse(fs.readFileSync(OUT, 'utf8')));
  return bili.me();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

if (wantCheck) {
  if (!fs.existsSync(OUT)) {
    console.error('❌ 还没登录过：', OUT, '不存在。跑一次 node scripts/bili-login-qr.mjs');
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
  let qr = await generate();
  const deadline = Date.now() + timeoutSec * 1000;
  let lastNote = '';
  let regenerated = 0;

  const show = async () => {
    fs.mkdirSync(path.dirname(QR_PNG), { recursive: true });
    await QRCode.toFile(QR_PNG, qr.url, { width: 480, margin: 2, errorCorrectionLevel: 'M' });
    // 终端也画一份（用户在自己终端跑时可以直接扫）
    try { console.log(await QRCode.toString(qr.url, { type: 'terminal', small: true })); }
    catch { /* 终端太小/不支持时不阻塞流程 */ }
    console.log('二维码图片：' + QR_PNG);
    console.log(`请在 ${timeoutSec} 秒内用「哔哩哔哩」App 扫码，并在手机上点确认。`);
  };

  await show();

  while (Date.now() < deadline) {
    await sleep(2000);
    let d;
    try { d = await poll(qr.key); }
    catch (e) { console.log('  （轮询出错，稍后重试：' + e.message + '）'); continue; }

    // B 站把「扫码进度」放在 data.code 里：0 成功 / 86101 未扫码 / 86090 已扫待确认 / 86038 已失效
    if (d.code === 0) {
      const account = parseQrLoginUrl(d.url);
      const missing = Object.entries(account).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length) {
        console.error('❌ 登录成功但回调里缺字段：' + missing.join(', '));
        process.exit(1);
      }
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(account, null, 2));
      try { fs.unlinkSync(QR_PNG); } catch { /* 二维码已用完，删不掉也无所谓 */ }
      console.log('\n✅ 扫码成功，已写入 ' + OUT);
      try {
        const m = await verify();
        console.log(`✅ 登录态有效：${m.uname}（Lv.${m.level}，mid=${m.mid}，硬币 ${m.coin}）`);
        console.log('   确认是你要用的号；不对就重跑一次。');
      } catch (e) {
        console.error('⚠️ 凭证已保存，但验证失败：', e.message);
        process.exit(1);
      }
      process.exit(0);
    }
    if (d.code === 86090 && lastNote !== 'scanned') {
      lastNote = 'scanned';
      console.log('📱 已扫码，请在手机上点「确认登录」。');
    } else if (d.code === 86038) {
      // 二维码过期（约 3 分钟）：自动换一张，不用让人重跑
      if (regenerated >= 2) {
        console.error('❌ 二维码连续过期，先不登了。重跑一次即可。');
        process.exit(1);
      }
      regenerated++;
      console.log('⌛ 二维码过期，换一张…');
      qr = await generate();
      lastNote = '';
      await show();
    }
  }
  console.error(`❌ 等了 ${timeoutSec} 秒没扫上，已放弃。重跑一次即可。`);
  process.exit(1);
}
