// 联网搜索的磁盘层（2026-10-20 新增）：
//   ① 结果缓存落盘 —— 原来 SearchCache 只活在 MCP 进程内存里，进程一退（DSH 重启/
//      空闲回收）全清零，她第二天问同一个梗还得重新打一趟网络。
//   ② 源健康度落盘 —— 哪个源最近恒失败、冷却到什么时候，跨重启记住，启动就别白等 3.5s。
//   ③ 当日统计 —— 搜了几次、命中几次缓存、平均耗时，控制台要看。
//   ④ 查询卡片台账（JSONL）—— 搜过的词压成一张卡，既供 MCP 做"以前查过"的模糊召回，
//      也供桥接进程 ingest 进记忆库（跨进程只走文件，不碰 sqlite，避免并发写）。
//
// 设计约束：
//   - 全部读文件用同步（启动一次、量很小），写文件去抖 + 原子替换（tmp → rename），
//     崩溃最多丢最后不到一秒的写入，不会留半截 JSON。
//   - 任何写失败只记日志、绝不抛给搜索链路 —— 缓存坏了不该让搜索坏掉。
import fs from 'node:fs';
import path from 'node:path';

/** 读 JSON；文件不存在/损坏都返回 fallback（并顺手把坏文件挪走，免得反复读坏）。 */
export function readJsonSafe(file, fallback = null, log = () => {}) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    if (!txt.trim()) return fallback;
    return JSON.parse(txt);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log(`[搜索存储] 读 ${path.basename(file)} 失败：${error?.message ?? error}`);
      try { fs.renameSync(file, `${file}.bad`); } catch { /* 挪不动就算了 */ }
    }
    return fallback;
  }
}

/** 原子写：先写 .tmp 再 rename，避免读到的半截文件。 */
export function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 去抖写入器。`debounceMs <= 0` 表示同步立即写。
 *
 * ⚠️ 为什么默认要同步写（2026-10-20 实测）：MCP 是短命进程，客户端一断就被杀；
 * Windows 上 child.kill() 走的是 TerminateProcess，**不会派发 SIGTERM**，
 * 所以 process.on('exit') 的收尾 flush 根本来不及跑 —— 去抖中的写入整批丢失
 * （第一次跑只落了 searches=1，net/缓存全没了）。这些文件都只有几 KB，
 * 同步写一次 1ms 以内，不值得为它冒险。
 */
export function createDebouncedWriter(file, { debounceMs = 0, log = () => {} } = {}) {
  const immediate = !(Number(debounceMs) > 0);
  let timer = null;
  let pending = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pending == null) return;
    const data = pending;
    pending = null;
    try { writeJsonAtomic(file, data); } catch (error) { log(`[搜索存储] 写 ${path.basename(file)} 失败：${error?.message ?? error}`); }
  };
  return {
    schedule(data) {
      pending = data;
      if (immediate) { flush(); return; }
      if (timer) return;
      timer = setTimeout(() => { timer = null; flush(); }, debounceMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    flush
  };
}

/**
 * 落盘的结果缓存：内存 LRU 在前、JSON 文件在后。
 * 每条自带 TTL（新闻 30 分钟 / 梗 24 小时，见 web-search-lib 的 ttlForQuery），
 * 不做统一过期 —— 用一个 TTL 管所有查询，要么梗过期太快、要么新闻过期太慢。
 */
export function createDiskCache({ file, maxEntries = 300, log = () => {}, now = () => Date.now() } = {}) {
  const entries = new Map(); // key -> { at, ttl, value }
  const raw = readJsonSafe(file, null, log);
  const src = raw && raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  for (const [k, e] of Object.entries(src)) {
    if (!e || typeof e !== 'object') continue;
    const at = Number(e.at) || 0;
    const ttl = Number(e.ttl) || 0;
    if (!at || ttl <= 0) continue;
    if (now() - at > ttl) continue;
    entries.set(k, { at, ttl, value: e.value });
  }

  function trim() {
    const t = now();
    for (const [k, e] of [...entries]) if (t - e.at > e.ttl) entries.delete(k);
    // 超上限就按写入时间丢最老的（Map 插入序天然近似 LRU）。
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
  }
  trim();

  const writer = createDebouncedWriter(file, { log });
  const persist = () => writer.schedule({
    v: 1,
    at: now(),
    entries: Object.fromEntries([...entries].map(([k, e]) => [k, { at: e.at, ttl: e.ttl, value: e.value }]))
  });

  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return null;
      if (now() - hit.at > hit.ttl) { entries.delete(key); return null; }
      // 命中后挪到末尾，维持近似 LRU 顺序。
      entries.delete(key);
      entries.set(key, hit);
      return hit.value;
    },
    set(key, value, ttl) {
      const ms = Number(ttl) || 0;
      if (ms <= 0) return;
      entries.set(key, { at: now(), ttl: ms, value });
      trim();
      persist();
    },
    delete(key) { if (entries.delete(key)) persist(); },
    get size() { return entries.size; },
    flush: writer.flush
  };
}

/**
 * 源健康度：跨重启记住"哪个源最近在挂、冷却到什么时候"。
 * 判定要保守 —— 只跳过「样本足够多且成功率极低」的源，且 3 天内没成功过；
 * 宁可多等一个慢源，也别因为某天网络抖动把可用源永久拉黑。
 */
export function createSourceHealth({
  file, log = () => {}, now = () => Date.now(),
  minSamples = 6, minRate = 0.15, skipMs = 6 * 3600 * 1000
} = {}) {
  const raw = readJsonSafe(file, null, log);
  const data = {
    v: 1,
    engines: (raw && raw.engines && typeof raw.engines === 'object') ? raw.engines : {},
    probe: (raw && raw.probe && typeof raw.probe === 'object') ? raw.probe : { at: 0, ok: {} }
  };
  const writer = createDebouncedWriter(file, { log });
  const persist = () => writer.schedule(data);

  function stat(name) {
    const k = String(name || '');
    if (!data.engines[k]) data.engines[k] = { ok: 0, fail: 0, lastOkAt: 0, lastFailAt: 0, cooldownUntil: 0 };
    return data.engines[k];
  }

  return {
    /** 记一次结果；只在"拿到有效结果"和"明确失败"时调，冷却跳过不记。 */
    record(name, ok) {
      const s = stat(name);
      const t = now();
      if (ok) { s.ok += 1; s.lastOkAt = t; s.cooldownUntil = 0; }
      else { s.fail += 1; s.lastFailAt = t; }
      persist();
    },
    /** 撞风控/403 时由调用方给一个冷却截止时间（进程内 cooldown 同步落盘）。 */
    markCooldown(name, untilMs) {
      const s = stat(name);
      s.cooldownUntil = Math.max(Number(s.cooldownUntil) || 0, Number(untilMs) || 0);
      persist();
    },
    /** 启动时播种：返回 name → 冷却截止时间戳 的 Map。 */
    cooldownMap() {
      const t = now();
      const m = new Map();
      for (const [name, s] of Object.entries(data.engines)) {
        if (!s || typeof s !== 'object') continue;
        const until = Number(s.cooldownUntil) || 0;
        if (until > t) { m.set(name, until); continue; }
        const ok = Number(s.ok) || 0;
        const fail = Number(s.fail) || 0;
        const total = ok + fail;
        const lastOk = Number(s.lastOkAt) || 0;
        const lastFail = Number(s.lastFailAt) || 0;
        // 从来没成功过（lastOk=0）也算"3 天内没成功过"，否则全新部署里一个从没通过的源
        // 要等三天才会被跳过 —— 这三天每次搜索都白等它超时。
        const noRecentOk = !lastOk || (t - lastOk > 3 * 86400000);
        // ⚠️ 必须要求"最近还在失败"：只按累计成功率判死会让一个早就挂掉的源**永远**进不来 ——
        // 跳过之后不会再有新样本，成功率永远停在低位，等于把这个源永久拉黑（网络好了也回不来）。
        // 加上这条之后：失败 3 天后允许再试一次，通了自动恢复，还挂就继续冷却。
        const recentFail = lastFail > 0 && (t - lastFail < 3 * 86400000);
        if (total >= minSamples && ok / total < minRate && noRecentOk && recentFail) {
          m.set(name, t + skipMs);
        }
      }
      return m;
    },
    /** 24 小时内的出口探测结果；没有就返回 null（调用方自己探）。 */
    probeCache(ttlMs = 24 * 3600 * 1000) {
      const at = Number(data.probe?.at) || 0;
      if (!at || now() - at > ttlMs) return null;
      return data.probe.ok && typeof data.probe.ok === 'object' ? data.probe.ok : {};
    },
    setProbe(ok) {
      data.probe = { at: now(), ok: ok && typeof ok === 'object' ? ok : {} };
      persist();
    },
    snapshot() { return { engines: { ...data.engines }, probe: { ...data.probe } }; },
    flush: writer.flush
  };
}

/** 本地日期键（YYYY-MM-DD）。不能用 toISOString：那是 UTC，北京时间 0~8 点的数据会算到"昨天"。 */
export function localDayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 按天累计的搜索统计（保留最近 keepDays 天）。 */
export function createStats({ file, log = () => {}, now = () => Date.now(), keepDays = 14 } = {}) {
  const raw = readJsonSafe(file, null, log);
  const data = { v: 1, days: (raw && raw.days && typeof raw.days === 'object') ? raw.days : {} };
  const writer = createDebouncedWriter(file, { log });
  const dayKey = (t) => localDayKey(t);

  function bucket() {
    const d = dayKey(now());
    if (!data.days[d]) {
      data.days[d] = { searches: 0, memHits: 0, diskHits: 0, net: 0, empty: 0, fetches: 0, fetchFails: 0, ms: 0, n: 0 };
    }
    return data.days[d];
  }

  return {
    /** field: searches / memHits / diskHits / net / empty / fetches / fetchFails；ms 只对搜索计。 */
    bump(field, ms) {
      const b = bucket();
      if (typeof b[field] === 'number') b[field] += 1;
      if (Number.isFinite(ms) && ms >= 0) { b.ms += Number(ms); b.n += 1; }
      // 顺手裁掉过期天（只在跨天第一次写时命中，成本可忽略）。
      const keys = Object.keys(data.days).sort();
      while (keys.length > keepDays) delete data.days[keys.shift()];
      writer.schedule(data);
    },
    snapshot(days = 7) {
      const keys = Object.keys(data.days).sort().slice(-days);
      return keys.map((d) => ({ day: d, ...data.days[d] }));
    },
    flush: writer.flush
  };
}

/**
 * 查询卡片台账（JSONL）：每搜一次追加一行。
 * 卡片 = 这个查询的"结论快照"，两个消费者：
 *   - MCP：下次问同一个/近似问题，按 token 重叠先看这里（零网络、零成本）；
 *   - 桥接：ingest 进记忆库，让"她查过什么"能进对话上下文。
 */
export function createCardLog({ file, log = () => {}, maxBytes = 400 * 1024, keepLines = 300 } = {}) {
  function readLines() {
    try {
      const txt = fs.readFileSync(file, 'utf8');
      return txt.split('\n').filter((l) => l.trim());
    } catch { return []; }
  }
  return {
    append(card) {
      if (!card || !card.query) return;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(card)}\n`, 'utf8');
        // 超体积就整体重写，只留最后 keepLines 行（卡片很小，300 行 ≈ 100KB）。
        const st = fs.statSync(file);
        if (st.size > maxBytes) {
          const lines = readLines().slice(-keepLines);
          fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
        }
      } catch (error) { log(`[搜索存储] 写卡片失败：${error?.message ?? error}`); }
    },
    /** 最近 N 张卡（新的在后）。 */
    recent(limit = 200) {
      return readLines().slice(-Math.max(1, limit)).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    },
    /**
     * 按 token 重叠做"以前查过吗"的模糊召回。
     * 阈值默认 0.6：低于这个值容易把「原神卡池」和「原神剧情」混成一件事。
     */
    findByTokens(tokens, { minOverlap = 0.6, maxAgeMs = 7 * 86400000, now = Date.now() } = {}) {
      const want = Array.isArray(tokens) ? tokens.filter(Boolean) : [];
      if (!want.length) return null;
      let best = null;
      for (const c of this.recent(200)) {
        if (!c || !Array.isArray(c.tokens) || !c.tokens.length) continue;
        if (now - (Number(c.at) || 0) > maxAgeMs) continue;
        if (c.lowConfidence) continue; // 低相关兜底不值得复用
        const set = new Set(c.tokens);
        const hit = want.filter((t) => set.has(t)).length;
        const overlap = hit / want.length;
        if (overlap >= minOverlap && (!best || overlap > best.overlap)) best = { card: c, overlap };
      }
      return best;
    }
  };
}
