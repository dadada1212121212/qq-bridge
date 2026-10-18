#!/usr/bin/env node
/**
 * 音乐分享链接构造器测试。
 *
 * 重点验证：
 *   1. 各平台都生成**真实可点**的 URL（含域名），不伪造卡片、不返回假 scheme。
 *   2. 只给歌名 / 歌名+歌手 / 歌曲 id 三种输入路径都通。
 *   3. 未知平台回落到网易云，不抛错。
 *   4. 歌名/歌手正确做 URL 编码（含中文、空格）。
 *   5. 啥都没给必须抛错，而不是静默返回空链接。
 *
 * 运行：node scripts/test-music-links.mjs
 */

import assert from 'node:assert/strict';
import { buildMusicShare, renderMusicShare } from '../src/music-links.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e?.message || e)); }
}
function throws(fn, re, note) {
  try { fn(); }
  catch (e) {
    if (re && !re.test(e.message)) { fail++; console.log('  FAIL throws(' + note + ') 信息不符: ' + e.message); return; }
    pass++; console.log('  PASS throws(' + note + ')'); return;
  }
  fail++; console.log('  FAIL throws(' + note + ') 没抛错');
}

t('netease 搜索链接正确编码中文歌名', () => {
  const r = buildMusicShare({ platform: 'netease', song: '稻香', artist: '周杰伦' });
  assert.equal(r.platform, 'netease');
  assert.ok(r.url.startsWith('https://music.163.com/'), '域名不对: ' + r.url);
  assert.ok(r.url.includes(encodeURIComponent('稻香')), '歌名没编码');
  assert.ok(r.url.includes(encodeURIComponent('周杰伦')), '歌手没编码');
  assert.ok(r.label.includes('稻香') && r.label.includes('周杰伦'));
});

t('qq 平台 song id 直跳播放页', () => {
  const r = buildMusicShare({ platform: 'qq', id: '123456' });
  assert.ok(r.url.includes('songDetail/123456'), 'id 没进链接: ' + r.url);
  assert.equal(r.platformName, 'QQ音乐');
});

t('kugou 搜索链接', () => {
  const r = buildMusicShare({ platform: 'kugou', song: '晴天' });
  assert.ok(r.url.includes('kugou.com'), '域名不对: ' + r.url);
  assert.ok(r.url.includes(encodeURIComponent('晴天')));
});

t('spotify 搜索链接', () => {
  const r = buildMusicShare({ platform: 'spotify', song: 'Shape of You' });
  assert.ok(r.url.includes('open.spotify.com/search/'), '域名不对: ' + r.url);
});

t('apple 搜索链接', () => {
  const r = buildMusicShare({ platform: 'apple', song: 'Hello' });
  assert.ok(r.url.includes('music.apple.com'), '域名不对: ' + r.url);
});

t('未知平台回落到 netease 不抛错', () => {
  const r = buildMusicShare({ platform: 'xxx', song: '测试' });
  assert.equal(r.platform, 'netease');
  assert.ok(r.url.includes('music.163.com'));
});

t('只给歌名也能出链接', () => {
  const r = buildMusicShare({ song: '孤勇者' });
  assert.ok(r.url.length > 0);
  assert.equal(r.platform, 'netease');
});

t('啥都没给抛错', () => {
  throws(() => buildMusicShare({}), /song|id/, '空输入');
  throws(() => buildMusicShare({ platform: 'netease' }), /song|id/, '只有 platform');
});

t('render 文案含链接和平台名', () => {
  const r = buildMusicShare({ song: '稻香', artist: '周杰伦' });
  const txt = renderMusicShare(r);
  assert.ok(txt.includes(r.url), '文案漏了链接');
  assert.ok(txt.includes('网易云音乐'), '文案漏了平台名');
});

console.log(`\n# tests ${pass + fail}`);
console.log(`# pass  ${pass}`);
console.log(`# fail  ${fail}`);
process.exit(fail ? 1 : 0);
