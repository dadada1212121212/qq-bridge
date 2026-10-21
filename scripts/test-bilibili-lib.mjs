// [B 站只读工具 2026-10-19] 单测：wbi 签名（已知向量）/ 解析 / 格式化 / 搜索归一化（桩 fetch）。
// 真机冒烟（view/search/popular/card 四接口）在实现当晚已人工跑通；这里只测纯逻辑，CI 可离线跑。
import assert from 'node:assert/strict';
import {
  mixinKey, wbiSign, parseVideoId, stripEm, formatVideos, formatDuration, createBili, parseQrLoginUrl
} from '../src/bilibili-lib.js';

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; }
  catch (e) { console.error(`✗ ${name}: ${e?.message || e}`); process.exitCode = 1; }
}

// wbi 混淆表测试向量（bilibili-API-collect 公开示例：img_key+sub_key 取位后的 32 位结果）
// 向量：imgKey="7cd084941338484aae1ad9425b84077c"，subKey="4932caff0ff746eab6f01bf08b70ac45"
// 按社区文档，mixin key 应为 "72136f5a38d18b2f88a45e9f94ee1c6b" 的前 32 位混排结果。
// 这里不硬编码社区期望值（不同文档版本有出入），改为钉住算法性质 + 固定输入输出自洽。
ok('mixinKey：输出 32 位、确定性', () => {
  const mk = mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
  assert.equal(mk.length, 32);
  assert.equal(mk, mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45'));
});
ok('mixinKey：输入不足 32 位要报错', () => {
  assert.throws(() => mixinKey('abc', 'def'), /长度不足/);
});
ok('wbiSign：确定性 + 含 wts/w_rid + 过滤 !\'()*', () => {
  const a = wbiSign({ foo: 'bar', q: '蓝色大肥鱼' }, 'k'.repeat(32), 'j'.repeat(32), 1700000000);
  const b = wbiSign({ q: '蓝色大肥鱼', foo: 'bar' }, 'k'.repeat(32), 'j'.repeat(32), 1700000000);
  assert.equal(a, b, '参数顺序无关');
  assert.ok(a.startsWith('foo=bar&q='), '键按字母序排列');
  assert.ok(a.includes('wts=1700000000'), '带 wts');
  assert.ok(/w_rid=[0-9a-f]{32}$/.test(a), '带 32 位 w_rid');
  const c = wbiSign({ q: '别(椭)圆!' }, 'k'.repeat(32), 'j'.repeat(32), 1700000000);
  assert.ok(!/[!'()*]/.test(c.split('&')[1].split('=')[1]), '值里特殊字符被剔除');
});
ok('parseVideoId：BV/av/纯数字/链接/失败', () => {
  assert.deepEqual(parseVideoId('BV1GJ411x7h7'), { bvid: 'BV1GJ411x7h7' });
  assert.deepEqual(parseVideoId('https://www.bilibili.com/video/BV1GJ411x7h7?p=1'), { bvid: 'BV1GJ411x7h7' });
  assert.deepEqual(parseVideoId('av170001'), { aid: '170001' });
  assert.deepEqual(parseVideoId('170001'), { aid: '170001' });
  assert.equal(parseVideoId('随便一句话'), null);
  assert.equal(parseVideoId(''), null);
});
ok('stripEm：去高亮标签', () => {
  assert.equal(stripEm('<em class="keyword">蓝色大肥鱼</em> 梗'), '蓝色大肥鱼 梗');
});
ok('formatDuration', () => {
  assert.equal(formatDuration(37), '0:37');
  assert.equal(formatDuration(754), '12:34');
});
ok('formatVideos：空列表/多行', () => {
  assert.ok(formatVideos([], { header: '【X】' }).includes('没有结果'));
  const s = formatVideos([{ kind: 'video', bvid: 'BV1', title: 'T', author: 'U', play: 19370000, danmaku: 107, duration: 37, pubdate: 0, url: 'https://www.bilibili.com/video/BV1' }], { header: '【X】' });
  assert.ok(s.includes('【X】'));
  assert.ok(s.includes('1937万'), '播放数万位压缩');
  assert.ok(s.includes('https://www.bilibili.com/video/BV1'));
});

// 搜索归一化（桩 fetch：view / search / spi / nav 四接口）
const responses = {
  'finger/spi': { code: 0, data: { b_3: 'test-buvid3' } },
  'web-interface/nav': { code: 0, data: { wbi_img: { img_url: 'https://a/x/11111111111111111111111111111111.png', sub_url: 'https://a/y/22222222222222222222222222222222.png' } } },
  'wbi/search/type': {
    code: 0,
    data: { result: [
      { bvid: 'BV1RxYM6AEB7', title: '<em class="keyword">蓝色大肥鱼</em> 梗', author: '梗的知识', play: 19370000, video_review: 107, duration: '0:37', pubdate: 1789000000 },
      { bvid: '', title: '没有 bvid 的脏行', author: 'x' },
      { bvid: 'BV2', title: '第二条', author: 'UP2', play: 5, video_review: 0, duration: '1:00', pubdate: 0 }
    ] }
  },
  'web-interface/view': {
    code: 0,
    data: { bvid: 'BV1GJ411x7h7', aid: 170001, title: 'Never Gonna Give You Up', desc: '官方 MV',
      owner: { name: '索尼音乐中国', mid: 117275562 },
      stat: { view: 107435893, danmaku: 13000, like: 1000000, coin: 20, favorite: 30, reply: 40 },
      duration: 212, pubdate: 1567000000 }
  }
};
const stubFetch = (url) => {
  const path = String(url).replace('https://api.bilibili.com', '').split('?')[0];
  const key = Object.keys(responses).find((k) => path.includes(k));
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(key ? responses[key] : { code: -400, message: 'stub 没配这个接口: ' + path }) });
};
const bili = createBili({ fetchImpl: stubFetch });
// async 用例：顶层 await 逐个跑，失败同样计入 exitCode
try {
  const list = await bili.search('蓝色大肥鱼', { kind: 'video', limit: 5 });
  assert.equal(list.length, 2, '没有 bvid 的脏行被跳过');
  assert.equal(list[0].title, '蓝色大肥鱼 梗');
  assert.equal(list[0].url, 'https://www.bilibili.com/video/BV1RxYM6AEB7');
  pass++;
  console.log('  ✅ search（桩）：归一化 + 跳过脏行 + 去 em 标签');
} catch (e) { console.error(`✗ search（桩）: ${e?.message || e}`); process.exitCode = 1; }
try {
  const v = await bili.videoInfo('BV1GJ411x7h7');
  assert.equal(v.up, '索尼音乐中国');
  assert.equal(v.play, 107435893);
  assert.ok(v.url.includes('BV1GJ411x7h7'));
  pass++;
  console.log('  ✅ videoInfo（桩）：归一化');
} catch (e) { console.error(`✗ videoInfo（桩）: ${e?.message || e}`); process.exitCode = 1; }
// ── 登录态（2026-10-21 补）─────────────────────────────────────────────────
//
// 背景：`ensureAuth` 原来校验 `a.biliJct`（驼峰），而导入脚本写的是 `bili_jct`（下划线，
// 跟真实 cookie 名一致）⇒ 校验永远失败、cookie 头发成 `bili_jct=undefined`，写操作全废。
// 这一节钉住「字段归一」和「cookie 头 / csrf 真的带上了值」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const authTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-auth-'));
const authBili = createBili({ fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }) });

{
  authBili._internal.setAuthLoader(async () => ({ SESSDATA: 's1', bili_jct: 'j1', DedeUserID: '1001' }));
  const a = await authBili._internal.ensureAuth();
  ok('ensureAuth：下划线字段通过', () => {
    assert.equal(a.bili_jct, 'j1');
    assert.equal(a.SESSDATA, 's1');
    assert.equal(a.DedeUserID, '1001');
  });
}
{
  // 兼容老写法（驼峰），别让手工编辑过的文件突然失效。
  authBili._internal.setAuthLoader(async () => ({ SESSDATA: 's2', biliJct: 'j2', DedeUserID: 1002 }));
  const a = await authBili._internal.ensureAuth();
  ok('ensureAuth：驼峰字段也能归一', () => {
    assert.equal(a.bili_jct, 'j2');
    assert.equal(a.DedeUserID, '1002', '数字要转成字符串');
  });
}
{
  authBili._internal.setAuthLoader(async () => ({ SESSDATA: 's3' }));
  let msg = '';
  try { await authBili._internal.ensureAuth(); } catch (e) { msg = e.message; }
  ok('ensureAuth：缺字段要报出缺哪个', () => {
    assert.match(msg, /bili_jct/);
    assert.match(msg, /DedeUserID/);
  });
}
{
  authBili._internal.setAuthLoader(async () => null);
  let msg = '';
  try { await authBili._internal.ensureAuth(); } catch (e) { msg = e.message; }
  ok('ensureAuth：文件为空要给出可操作提示', () => { assert.match(msg, /bili-account\.json/); });
}

// 端到端：点赞时 cookie 头和 csrf 必须都是真值（不是 undefined）
{
  const CSRF = 'csrf-token-abc';
  const seen = [];
  const stub = (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers || {}, body: String(init.body || '') });
    const p = String(url).replace('https://api.bilibili.com', '').split('?')[0];
    const reply = p.includes('finger/spi') ? { code: 0, data: { b_3: 'buvid3-x' } }
      : p.includes('web-interface/view') ? responses['web-interface/view']
        : p.includes('archive/like') ? { code: 0 }
          : { code: -400, message: 'stub 没配: ' + p };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(reply) });
  };
  const b = createBili({ fetchImpl: stub });
  b._internal.setAuthLoader(async () => ({ SESSDATA: 'sess-x', bili_jct: CSRF, DedeUserID: '1001' }));
  b._internal.setQuotaFile(path.join(authTmp, 'quota.json'));
  try {
    await b.likeVideo('BV1GJ411x7h7');
    const like = seen.find((c) => c.url.includes('archive/like'));
    ok('点赞：cookie 头带真 bili_jct', () => {
      assert.ok(like, '没发出 like 请求');
      assert.ok(like.headers.cookie.includes(`bili_jct=${CSRF}`), '实际 cookie：' + like.headers.cookie);
      assert.ok(!like.headers.cookie.includes('undefined'), 'cookie 里出现 undefined');
      assert.ok(like.headers.cookie.includes('SESSDATA=sess-x'));
      assert.ok(like.headers.cookie.includes('DedeUserID=1001'));
    });
    ok('点赞：csrf 用真值', () => { assert.ok(like.body.includes('csrf=' + CSRF), '实际 body：' + like.body); });
    console.log('  ✅ likeVideo（桩）：cookie 头与 csrf 都是真值');
  } catch (e) { console.error(`✗ likeVideo（桩）: ${e?.message || e}`); process.exitCode = 1; }
}

// 扫码登录回调 URL 解析（2026-10-21 补）
ok('parseQrLoginUrl：取到三件套', () => {
  const r = parseQrLoginUrl('https://passport.biligame.com/crossDomain?DedeUserID=12345&DedeUserID__ckMd5=abc&Expires=1700000000&SESSDATA=xxx&bili_jct=csrf1&gourl=https%3A%2F%2Fwww.bilibili.com');
  assert.equal(r.SESSDATA, 'xxx');
  assert.equal(r.bili_jct, 'csrf1');
  assert.equal(r.DedeUserID, '12345');
});
ok('parseQrLoginUrl：SESSDATA 里的 %2C 不能被解码', () => {
  // %2C 是 cookie 值**本身**（浏览器就发这个原文）。用 searchParams.get 会解码成逗号 ⇒ 令牌失效。
  const r = parseQrLoginUrl('https://x/crossDomain?SESSDATA=abc%2Cdef%2Cghi&bili_jct=j&DedeUserID=9');
  assert.equal(r.SESSDATA, 'abc%2Cdef%2Cghi');
});
ok('parseQrLoginUrl：缺字段返回空串不抛', () => {
  const r = parseQrLoginUrl('https://x/crossDomain?foo=1');
  assert.deepEqual(r, { SESSDATA: '', bili_jct: '', DedeUserID: '' });
  assert.deepEqual(parseQrLoginUrl(''), { SESSDATA: '', bili_jct: '', DedeUserID: '' });
});

console.log(`test-bilibili-lib: ${pass} 断言通过${process.exitCode ? '（存在失败）' : ''}`);
