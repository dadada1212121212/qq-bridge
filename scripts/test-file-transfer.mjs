// 文件收发核心模块单测：路径转换 / action 选择 / 大小限制 / 未知 notice 落盘 / 正常接收+读取
import { createFileTransfer } from '../src/file-transfer.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-test-'));
const STATE = path.join(tmp, 'state');
fs.mkdirSync(STATE, { recursive: true });

function makeFt(oneBotCall) {
  return createFileTransfer({
    oneBotCall,
    cfg: { socialV2: { files: { maxBytes: 1024 } } },
    ROOT: tmp,
    STATE_DIR: STATE,
    log: () => {},
  });
}

function findInDir(dir, suffix) {
  if (!fs.existsSync(dir)) return false;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (findInDir(p, suffix)) return true; }
    else if (e.name.endsWith(suffix)) return true;
  }
  return false;
}

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name + (extra ? `（${extra}）` : '')); }
  else { fail++; console.log('  ✗', name + (extra ? `（${extra}）` : '')); }
}

// 1. 路径转换 + 私聊 action
{
  const f = path.join(tmp, '报告.txt'); fs.writeFileSync(f, 'hi');
  let cap = null;
  const ft = makeFt(async (a, p) => { cap = { a, p }; return { file_id: 'FID1' }; });
  const r = await ft.sendFile({ key: 'private:3796180411', filePath: f });
  ok('sendFile 返回 ok', r.ok === true);
  ok('私聊用 upload_private_file', cap.a === 'upload_private_file');
  ok('file 转 WSL 路径', typeof cap.p.file === 'string' && cap.p.file.startsWith('file:///mnt/') && cap.p.file.includes('报告.txt'));
  ok('name 缺省取原文件名', cap.p.name === '报告.txt');
}

// 2. 群聊 action
{
  const f = path.join(tmp, 'g.txt'); fs.writeFileSync(f, 'x');
  let cap = null;
  const ft = makeFt(async (a, p) => { cap = { a, p }; return { file_id: 'F2' }; });
  await ft.sendFile({ key: 'group:123', filePath: f });
  ok('群聊用 upload_group_file', cap.a === 'upload_group_file');
}

// 3. 文件不存在抛错
{
  const ft = makeFt(async () => ({}));
  let threw = false;
  try { await ft.sendFile({ key: 'private:1', filePath: path.join(tmp, 'nope.txt') }); } catch { threw = true; }
  ok('不存在文件抛错', threw);
}

// 4. 大小超限抛错
{
  const f = path.join(tmp, 'big.txt'); fs.writeFileSync(f, 'a'.repeat(5000));
  const ft = makeFt(async () => ({ file_id: 'x' }));
  let threw = false;
  try { await ft.sendFile({ key: 'private:1', filePath: f }); } catch { threw = true; }
  ok('超限抛错', threw);
}

// 5. 网络 URL 不支持
{
  const ft = makeFt(async () => ({}));
  let threw = false;
  try { await ft.sendFile({ key: 'private:1', filePath: 'http://x/y.txt' }); } catch { threw = true; }
  ok('网络 URL 抛错', threw);
}

// 6. 未知 notice 结构 → dump 不丢数据
{
  const ft = makeFt(async () => ({}));
  const r = await ft.handleFileNotice({ notice_type: 'weird', foo: 1 });
  ok('未知结构 ok=false', r.ok === false && r.reason === 'unrecognized-notice');
  ok('未知结构已 dump 原始事件', findInDir(path.join(STATE, 'files', 'inbox'), '.unknown-event.json'));
}

// 7. 正常接收（get_file base64 兜底）+ 查询 + 读取
{
  const ft = makeFt(async (a) => {
    if (a === 'get_private_file_url') return {}; // 无 url，走兜底
    if (a === 'get_file') return { base64: Buffer.from('hello-file').toString('base64') };
    return {};
  });
  const r = await ft.handleFileNotice({ notice_type: 'offline_file', user_id: '3796180411', file_id: 'FIDX', file_name: '../../evil.txt', file_size: 10, file_hash: 'H' });
  ok('接收 ok', r.ok === true);
  ok('文件名被清洗（无路径分隔符/未穿越）', !r.meta.name.includes('/') && !r.meta.name.includes('\\'));
  ok('落盘未逃逸出 inbox 目录', r.savedPath.startsWith(path.join(STATE, 'files', 'inbox')));
  ok('落盘内容正确', fs.readFileSync(r.savedPath, 'utf8') === 'hello-file');
  const list = ft.listInbox();
  ok('收件箱能列出', list.count >= 1);
  const rd = await ft.readInboxText(r.meta.seq);
  ok('读取文本内容正确', rd.ok === true && rd.text === 'hello-file');
}

// 8. 收件目录：默认 / 配置 / AI 指定 三级优先级 + 自定义目录平铺存放
{
  // 8a. 默认目录 = state/files/inbox/<日期>
  const ft = makeFt(async () => ({}));
  const def = ft.getInboxDir();
  ok('默认收件目录落在 state/files/inbox', def.inboxDir.startsWith(path.join(STATE, 'files', 'inbox')) && def.withDate === true);

  // 8b. 配置 socialV2.files.inboxDir 覆盖默认
  const cfgDir = path.join(tmp, 'cfg-inbox');
  const ft2 = createFileTransfer({ oneBotCall: async () => ({}), cfg: { socialV2: { files: { inboxDir: cfgDir } } }, ROOT: tmp, STATE_DIR: STATE, log: () => {} });
  const c = ft2.getInboxDir();
  ok('配置 inboxDir 生效', c.inboxDir === cfgDir && c.withDate === true);

  // 8c. AI 指定目录覆盖一切，且平铺存放（withDate=false）
  const custom = path.join(tmp, 'my-custom');
  const r = ft.setInboxDir(custom);
  ok('setInboxDir 返回 ok 且写入绝对路径', r.ok === true && r.inboxDir === custom);
  const g = ft.getInboxDir();
  ok('指定目录生效（withDate=false）', g.inboxDir === custom && g.withDate === false);

  // 8d. 收到的文件直接存进指定目录（不套日期子目录）
  const ft3 = makeFt(async (a) => {
    if (a === 'get_private_file_url') return {};
    if (a === 'get_file') return { base64: Buffer.from('into-custom').toString('base64') };
    return {};
  });
  ft3.setInboxDir(custom); // 注意：状态文件按 STATE_DIR 共享，fts 已写过，这里再确认
  const rr = await ft3.handleFileNotice({ notice_type: 'offline_file', user_id: '3796180411', file_id: 'FX', file_name: 'a.txt', file_size: 10, file_hash: 'H' });
  ok('指定目录下平铺落盘', rr.ok === true && rr.savedPath.startsWith(custom) && !rr.savedPath.includes(path.join(custom, '20')));
  ok('指定目录内容正确', fs.readFileSync(rr.savedPath, 'utf8') === 'into-custom');

  // 8e. 非法目录（相对路径）被拒绝
  let threw = false;
  try { ft.setInboxDir('relative/path'); } catch { threw = true; }
  ok('相对路径被拒绝', threw);

  // 8f. 传空恢复默认
  const clr = ft.setInboxDir('');
  ok('传空恢复默认', clr.ok === true && clr.cleared === true && clr.inboxDir.startsWith(path.join(STATE, 'files', 'inbox')));
}

// 9. 真实 notice 结构回归（2026-10-21 补）
//
// ⚠️ 第 7 节用的是**扁平**结构（顶层 file_id / file_name），那是早期按文档臆造的。
// 真实 QQ 报文把文件字段**嵌在 `file` 对象里**，而且 id 的键名各家不同：
//   go-cqhttp / NapCat：file.id、file.uuid；标准群文件：file.busid。
// 之前只读顶层，导致三种真实结构**全部解析成 null**，线上真收到文件只会走 dump 分支
// （数据不丢，但永远下不下来）。这一节钉住这些结构。
{
  const PAYLOAD = '真实报文下载的内容\n第二行\n';
  const server = http.createServer((req, res) => { res.writeHead(200); res.end(Buffer.from(PAYLOAD, 'utf8')); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dlUrl = `http://127.0.0.1:${server.address().port}/f`;

  // 9a. go-cqhttp 私聊：file:{ id, name, size, url }，自带直链 ⇒ 不该再调 API
  {
    let apiCalls = 0;
    const ft = createFileTransfer({
      oneBotCall: async () => { apiCalls++; return {}; },
      cfg: {}, ROOT: tmp, STATE_DIR: STATE, log: () => {},
    });
    const r = await ft.handleFileNotice({
      post_type: 'notice', notice_type: 'offline_file', self_id: 3901900049, user_id: 3796180411,
      file: { id: 'abc123', name: '嵌套 报告~1.txt', size: Buffer.byteLength(PAYLOAD), url: dlUrl },
    });
    ok('嵌套 file.id 能解析并下载', r.ok === true && r.meta.downloaded === true);
    ok('嵌套结构下内容正确', fs.readFileSync(r.savedPath, 'utf8') === PAYLOAD);
    ok('事件自带 url 时不再调 API', apiCalls === 0);
    ok('文件名保留 ~ 与中文（不被误替换）', r.meta.name === '嵌套 报告~1.txt');
    ok('索引记录了 noticeType', ft.listInbox(1).items[0]?.noticeType === 'offline_file');
  }

  // 9b. NapCat 私聊：file:{ uuid, ... }
  {
    const ft = createFileTransfer({
      oneBotCall: async (a) => (a === 'get_private_file_url' ? { url: dlUrl } : {}),
      cfg: {}, ROOT: tmp, STATE_DIR: STATE, log: () => {},
    });
    const r = await ft.handleFileNotice({
      notice_type: 'offline_file', user_id: 3796180411,
      file: { uuid: 'uuid-999', name: 'napcat.txt', size: 10 },
    });
    ok('嵌套 file.uuid 能解析', r.ok === true && r.meta.downloaded === true);
  }

  // 9c. 标准群文件：file:{ id, busid } ⇒ 走 get_group_file_url 且带上 busid
  {
    let seen = null;
    const ft = createFileTransfer({
      oneBotCall: async (a, p) => { if (a === 'get_group_file_url') { seen = { a, p }; return { url: dlUrl }; } return {}; },
      cfg: {}, ROOT: tmp, STATE_DIR: STATE, log: () => {},
    });
    const r = await ft.handleFileNotice({
      notice_type: 'group_upload', group_id: 429626254, user_id: 111,
      file: { id: 'gid1', name: '群文件.zip', size: 999, busid: 102 },
    });
    ok('群文件走 get_group_file_url', seen?.a === 'get_group_file_url');
    ok('busid 从嵌套 file 里取到', seen?.p?.busid === 102);
    ok('群文件接收 ok', r.ok === true && r.meta.downloaded === true);
  }

  // 9d. file 直接是字符串（只有 id，没有 url）
  {
    let seen = null;
    const ft = createFileTransfer({
      oneBotCall: async (a, p) => { if (a === 'get_private_file_url') { seen = p; return { url: dlUrl }; } return {}; },
      cfg: {}, ROOT: tmp, STATE_DIR: STATE, log: () => {},
    });
    const r = await ft.handleFileNotice({ notice_type: 'offline_file', user_id: 3796180411, file: 'str-id-1' });
    ok('file 为字符串时按 id 取链', seen?.file_id === 'str-id-1' && r.meta.downloaded === true);
  }

  // 9e. 同一毫秒连收三个：seq 必须严格递增（否则按 seq 取件会取错）
  // ⚠️ 必须用**不同** fileId：相同 fileId 会被幂等逻辑判成重复投递（见 10b），返回的还是旧 seq。
  {
    const ft = createFileTransfer({
      oneBotCall: async () => ({ base64: Buffer.from('x').toString('base64') }),
      cfg: {}, ROOT: tmp, STATE_DIR: STATE, log: () => {},
    });
    const mk = (id) => ({ notice_type: 'offline_file', user_id: 3796180411, file: { id, name: 's.txt', url: dlUrl } });
    const a = await ft.handleFileNotice(mk('SEQ-A'));
    const b = await ft.handleFileNotice(mk('SEQ-B'));
    const c = await ft.handleFileNotice(mk('SEQ-C'));
    ok('连收三份 seq 严格递增', a.meta.seq < b.meta.seq && b.meta.seq < c.meta.seq, `${a.meta.seq}/${b.meta.seq}/${c.meta.seq}`);
  }

  server.close();
}

// 10. 质量加固（2026-10-21）：接收侧限额 / 幂等 / 系统目录保护 / file:// 限额 / 吞异常记账
{
  // 10a. 接收超限：Content-Length 已经超了 → 写盘前就拒绝，不留半个文件
  {
    const BIG = Buffer.alloc(4096, 0x61);
    const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Length': String(BIG.length) }); res.end(BIG); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const u = `http://127.0.0.1:${srv.address().port}/big`;
    const ft = createFileTransfer({
      oneBotCall: async () => ({}),
      cfg: { socialV2: { files: { maxBytes: 1024 } } }, // 1KB 上限，文件 4KB
      ROOT: tmp, STATE_DIR: STATE, log: () => {},
    });
    const r = await ft.handleFileNotice({ notice_type: 'offline_file', user_id: 3796180411, file: { id: 'BIG1', name: 'big.bin', url: u } });
    ok('超限文件不被标记为已下载', r.meta.downloaded === false);
    ok('超限落成 .download-failed 元信息', r.savedPath.endsWith('.download-failed'));
    ok('超限不留半截文件', !fs.existsSync(r.savedPath.replace(/\.download-failed$/, '')));
    srv.close();
  }

  // 10b. 幂等：同一个 fileId 投两次，只落一份
  {
    const srv = http.createServer((req, res) => { res.writeHead(200); res.end('once'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const u = `http://127.0.0.1:${srv.address().port}/x`;
    const ft = createFileTransfer({ oneBotCall: async () => ({}), cfg: {}, ROOT: tmp, STATE_DIR: STATE, log: () => {} });
    const ev = { notice_type: 'offline_file', user_id: 3796180411, file: { id: 'DUP-1', name: 'dup.txt', url: u } };
    const a = await ft.handleFileNotice(ev);
    const b = await ft.handleFileNotice(ev);
    ok('首次接收正常', a.ok === true && a.meta.downloaded === true);
    ok('重复投递被识别为 duplicate', b.ok === true && b.duplicate === true);
    ok('重复投递返回原路径（不新建文件）', b.savedPath === a.savedPath);
    const rows = ft.listInbox(200).items.filter((x) => x.fileId === 'DUP-1');
    ok('索引里只有一条 DUP-1', rows.length === 1, 'count=' + rows.length);
    srv.close();
  }

  // 10c. 收件目录保护：拒绝系统目录
  {
    const ft = createFileTransfer({ oneBotCall: async () => ({}), cfg: {}, ROOT: tmp, STATE_DIR: STATE, log: () => {} });
    const bad = ['C:\\', 'D:/', 'C:\\Windows', 'C:\\Windows\\System32', 'C:\\Program Files', 'C:\\ProgramData'];
    let rejected = 0;
    for (const d of bad) { try { ft.setInboxDir(d); } catch { rejected++; } }
    ok('系统目录全部被拒绝', rejected === bad.length, `${rejected}/${bad.length}`);
    // 正常用户目录仍然可以设
    const goodDir = path.join(tmp, 'ok-dir');
    let okGood = false;
    try { okGood = ft.setInboxDir(goodDir).ok === true; } catch { okGood = false; }
    ok('普通目录仍可设置', okGood);
    ft.setInboxDir(''); // 复位
  }

  // 10d. file:// 引用也要过大小检查（原来只有非 file:// 才检查，等于留了绕过口子）
  {
    const big = path.join(tmp, 'huge.bin');
    fs.writeFileSync(big, Buffer.alloc(5000, 0x62));
    const ref = 'file:///mnt/' + big.replace(/^([A-Za-z]):[\\/]/, (_, d) => d.toLowerCase() + '/').replace(/\\/g, '/');
    const ft = createFileTransfer({ oneBotCall: async () => ({}), cfg: { socialV2: { files: { maxBytes: 1024 } } }, ROOT: tmp, STATE_DIR: STATE, log: () => {} });
    let threw = null;
    try { await ft.sendFile({ key: 'private:1', filePath: ref }); } catch (e) { threw = e?.message || String(e); }
    ok('file:// 引用超限被拒', typeof threw === 'string' && threw.includes('过大'), threw || '未抛错');
  }

  // 10e. 吞异常要走记账（注入的 swallow 必须真的被调用）
  {
    const tags = [];
    const ft = createFileTransfer({
      oneBotCall: async () => ({}),
      cfg: { socialV2: { files: { maxBytes: 1024 } } },
      ROOT: tmp, STATE_DIR: STATE, log: () => {},
      swallow: (tag) => tags.push(tag),
    });
    await ft.handleFileNotice({ notice_type: 'offline_file', user_id: 3796180411, file: { id: 'SW-1', name: 'sw.bin', url: 'http://127.0.0.1:1/none' } });
    ok('下载失败走 swallow 记账', tags.includes('文件接收'), tags.join(','));
  }
}

console.log(`\n结果：${pass} 通过, ${fail} 失败`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
