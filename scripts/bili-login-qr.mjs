// [养鱼 2026-10-21] B 站扫码登录器。
//
// 用法（主人手动跑）：
//   node scripts/bili-login-qr.mjs --serve          # 【推荐】起一个本地页面，二维码自动续期
//   node scripts/bili-login-qr.mjs                  # 一次性：终端 + PNG，轮询到成功或超时
//   node scripts/bili-login-qr.mjs --timeout 300    # 一次性模式的自定义超时（秒）
//   node scripts/bili-login-qr.mjs --check          # 只验证已导入的登录态
//
// 和 bili-import-cookie.mjs 的关系：两条路写的是同一个文件 state/bili-account.json。
// 扫码更省事（不用翻 F12 复制长串）；cookie 导入适合扫码不方便时。
//
// 为什么要 --serve：B 站二维码只有约 3 分钟寿命，一次性模式经常"发出去人还没准备好就过期了"。
// --serve 起个本地页面，二维码快过期就自动换新的，页面跟着刷新，什么时候扫都行。
import fs from 'node:fs';
import http from 'node:http';
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

// B 站二维码寿命约 180s，留 15s 余量提前换。
const QR_TTL_MS = 165 * 1000;

const args = process.argv.slice(2);
const wantCheck = args.includes('--check');
const serveIdx = args.indexOf('--serve');
const wantServe = serveIdx >= 0;
const timeoutIdx = args.indexOf('--timeout');
const timeoutSec = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) || 180 : 180;

async function call(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  // ⚠️ 扫码成功后，cookie 有**两种**下发方式，取决于 B 站这边的实现/灰度：
  //   ① 塞进 data.url 的 query（crossDomain?SESSDATA=...&bili_jct=...）
  //   ② 直接作为响应头 Set-Cookie 下发（此时 data.url 只是 https://www.bilibili.com/）
  // 只认 ① 的话，遇到 ② 就会「登录成功但回调里缺字段」。两条都收。
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { body, setCookies };
}

/** 从 Set-Cookie 头里抠出 name=value（值保持原文，不解码）。 */
function cookiesFromSetCookie(list) {
  const out = {};
  for (const line of list || []) {
    const pair = String(line).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

/** 把 poll 结果归一成 cookie 三件套（两种下发方式都认）。 */
function pickAccount(d) {
  const fromUrl = parseQrLoginUrl(d.url);
  const fromCookie = cookiesFromSetCookie(d.__setCookies);
  return {
    SESSDATA: fromUrl.SESSDATA || fromCookie.SESSDATA || '',
    bili_jct: fromUrl.bili_jct || fromCookie.bili_jct || '',
    DedeUserID: fromUrl.DedeUserID || fromCookie.DedeUserID || '',
  };
}

async function generate() {
  const { body: j } = await call('https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header');
  if (j.code !== 0 || !j.data?.url) throw new Error(`生成二维码失败：code=${j.code} ${j.message || ''}`);
  return { url: j.data.url, key: j.data.qrcode_key };
}

async function poll(key) {
  const { body: j, setCookies } = await call('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key='
    + encodeURIComponent(key) + '&source=main-fe-header');
  if (j.code !== 0) throw new Error(`轮询失败：code=${j.code} ${j.message || ''}`);
  return { ...(j.data || {}), __setCookies: setCookies };
}

async function verify() {
  const bili = createBili({ log: () => {} });
  bili._internal.setAuthLoader(async () => JSON.parse(fs.readFileSync(OUT, 'utf8')));
  return bili.me();
}

function saveAccount(account) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(account, null, 2));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 扫码成功后的收尾：写文件 + 验证 + 打印。返回 { ok, message }。 */
async function finishLogin(account) {
  saveAccount(account);
  try {
    const m = await verify();
    return { ok: true, message: `✅ 登录态有效：${m.uname}（Lv.${m.level}，mid=${m.mid}，硬币 ${m.coin}）` };
  } catch (e) {
    return { ok: false, message: `⚠️ 凭证已保存，但验证失败：${e.message}` };
  }
}

// ── 模式一：只验证 ──────────────────────────────────────────────────────────
if (wantCheck) {
  if (!fs.existsSync(OUT)) {
    console.error('❌ 还没登录过：', OUT, '不存在。跑一次 node scripts/bili-login-qr.mjs --serve');
    process.exit(1);
  }
  try {
    const m = await verify();
    console.log(`✅ 登录态有效：${m.uname}（Lv.${m.level}，mid=${m.mid}，硬币 ${m.coin}）`);
  } catch (e) {
    console.error('❌ 登录态无效：', e.message);
    process.exit(1);
  }
} else if (wantServe) {
  // ── 模式二：本地页面（二维码自动续期）────────────────────────────────────
  const port = Number(args[serveIdx + 1]) || 3110;
  let cur = null; // { url, key, png, expiresAt, seq }
  let qrSeq = 0;
  let status = { state: 'waiting', message: '等待扫码', account: null };
  let stopping = false;

  async function refreshQr() {
    const g = await generate();
    const png = await QRCode.toBuffer(g.url, { width: 480, margin: 2, errorCorrectionLevel: 'M' });
    qrSeq += 1;
    cur = { url: g.url, key: g.key, png, expiresAt: Date.now() + QR_TTL_MS, seq: qrSeq };
    if (status.state !== 'ok') status = { state: 'waiting', message: '等待扫码', account: null };
    console.log(`[qr] 第 ${qrSeq} 张已生成（${Math.round(QR_TTL_MS / 1000)}s 后自动更换）`);
  }

  await refreshQr();

  let server = null; // 先声明：下面的轮询闭包会用到，避免 TDZ

  // 后台轮询：二维码快过期就换新的；扫上就收 cookie 落盘。
  (async () => {
    while (!stopping) {
      await sleep(2000);
      if (stopping) return;
      if (status.state === 'ok') { await sleep(3000); continue; }
      try {
        if (!cur || Date.now() > cur.expiresAt) { await refreshQr(); continue; }
        const d = await poll(cur.key);
        if (d.code === 86090) {
          status = { state: 'scanned', message: '已扫码，请在手机上点「确认登录」', account: null };
        } else if (d.code === 86038) {
          await refreshQr();
        } else if (d.code === 0) {
          const account = pickAccount(d);
          const missing = Object.entries(account).filter(([, v]) => !v).map(([k]) => k);
          if (missing.length) {
            status = { state: 'error', message: '扫码成功但没拿到 cookie 字段：' + missing.join(', '), account: null };
            console.error('❌ 扫码成功了，但没拿到 cookie 字段：' + missing.join(', '));
            console.error('   回调 url        =', String(d.url || '(空)').slice(0, 90));
            console.error('   Set-Cookie 条数 =', (d.__setCookies || []).length,
              '｜名字 =', Object.keys(cookiesFromSetCookie(d.__setCookies)).join(',') || '(无)');
            console.error('   响应字段        =', Object.keys(d).filter((k) => k !== '__setCookies').join(','));
          } else {
            const r = await finishLogin(account);
            status = { state: r.ok ? 'ok' : 'error', message: r.message, account: { mid: account.DedeUserID } };
            console.log(r.message);
            if (r.ok) {
              try { fs.unlinkSync(QR_PNG); } catch { /* 没生成过就算了 */ }
              stopping = true;
              setTimeout(() => { server.close(); process.exit(0); }, 1500);
            }
          }
        }
      } catch (e) {
        console.error('[qr] 轮询出错（稍后重试）：', e.message);
      }
    }
  })();

  const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>B 站扫码登录</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center;
         font: 15px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; gap:14px; padding:24px; }
  h1 { font-size: 17px; font-weight: 600; margin: 0; }
  #qr { width: 320px; height: 320px; image-rendering: pixelated; border-radius: 10px; background:#fff; padding:8px; }
  #msg { min-height: 1.6em; font-size: 15px; }
  .ok { color: #18a058; font-weight: 600; }
  .err { color: #d03050; }
  .hint { opacity: .6; font-size: 13px; text-align: center; max-width: 380px; }
</style>
<h1>用「哔哩哔哩」App 扫码登录</h1>
<img id="qr" alt="登录二维码">
<div id="msg">加载中…</div>
<div class="hint">二维码过期会自动更换，不用刷新页面。<br>扫完记得在手机上点「确认登录」。</div>
<script>
let seq = -1;
async function tick() {
  try {
    const r = await fetch('/status', { cache: 'no-store' });
    const s = await r.json();
    const img = document.getElementById('qr');
    if (s.seq !== seq) { seq = s.seq; img.src = '/qr.png?t=' + Date.now(); }
    const m = document.getElementById('msg');
    m.textContent = s.message || '';
    m.className = s.state === 'ok' ? 'ok' : (s.state === 'error' ? 'err' : '');
    if (s.state === 'ok') return; // 成功后不再轮询
  } catch (e) { /* 服务已退出 */ }
  setTimeout(tick, 1500);
}
tick();
</script>
</html>`;

  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    if (u.pathname === '/qr.png') {
      if (!cur) { res.writeHead(503); res.end('no qr'); return; }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(cur.png);
      return;
    }
    if (u.pathname === '/status') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...status, seq: cur ? cur.seq : 0 }));
      return;
    }
    res.writeHead(404); res.end('not found');
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`\n👉 打开 http://127.0.0.1:${port} 扫码（这个页面会自己续二维码）`);
    console.log('   登录成功后会自动写 state/bili-account.json 并关闭服务。\n');
  });
} else {
  // ── 模式三：一次性（终端 + PNG）────────────────────────────────────────────
  let qr = await generate();
  const deadline = Date.now() + timeoutSec * 1000;
  let lastNote = '';
  let regenerated = 0;

  const show = async () => {
    fs.mkdirSync(path.dirname(QR_PNG), { recursive: true });
    await QRCode.toFile(QR_PNG, qr.url, { width: 480, margin: 2, errorCorrectionLevel: 'M' });
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
      const account = pickAccount(d);
      const missing = Object.entries(account).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length) {
        console.error('❌ 扫码成功了，但没拿到 cookie 字段：' + missing.join(', '));
        console.error('   回调 url        =', String(d.url || '(空)').slice(0, 90));
        console.error('   Set-Cookie 条数 =', (d.__setCookies || []).length,
          '｜名字 =', Object.keys(cookiesFromSetCookie(d.__setCookies)).join(',') || '(无)');
        console.error('   响应字段        =', Object.keys(d).filter((k) => k !== '__setCookies').join(','));
        console.error('   把上面几行发我，我按实际形态再调。');
        process.exit(1);
      }
      console.log('\n✅ 扫码成功，已写入 ' + OUT);
      const r = await finishLogin(account);
      console.log(r.message);
      try { fs.unlinkSync(QR_PNG); } catch { /* 二维码已用完 */ }
      process.exit(r.ok ? 0 : 1);
    }
    if (d.code === 86090 && lastNote !== 'scanned') {
      lastNote = 'scanned';
      console.log('📱 已扫码，请在手机上点「确认登录」。');
    } else if (d.code === 86038) {
      if (regenerated >= 2) {
        console.error('❌ 二维码连续过期，先不登了。建议改用 --serve 模式。');
        process.exit(1);
      }
      regenerated++;
      console.log('⌛ 二维码过期，换一张…');
      qr = await generate();
      lastNote = '';
      await show();
    }
  }
  console.error(`❌ 等了 ${timeoutSec} 秒没扫上，已放弃。建议改用 --serve 模式（二维码自动续期）。`);
  process.exit(1);
}
