// 本地控制台 HTTP 服务（从 bridge.js 抽出，2026-10-18）。
//
// 为什么单独成模块：它原本是 bridge.js 里 5500 行的单个函数，把「鉴权 / 路由 / 业务动作」
// 全挤在一起，改一个端点要在 1.8 万行里找。现在这里只保留 HTTP 层（Host 校验、控制台令牌、
// 智能体调用隔离、CSRF、路由分发），业务动作全部通过 deps 注入。
//
// 依赖注入约定：
//   · 绝大多数 deps 是**函数或 const 对象**（身份稳定）→ 构造时解构一次即可。
//   · 少量可变变量（当前模式、会话代际、表情库、模块级 let 等）会随时间变化 → 一律走
//     S.xxx 读写，由 bridge.js 用 getter/setter 提供实时值，否则会读到启动时的快照。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { priceUsage, resolvePriceTable } from './model-prices.js';

// ── 配置文件投递（新后台「配置文件」模块）：识别 / 差异 / 深合并 / 历史 ──────
// 设计：文件丢进来 → 自动识别归属（config 合并 / 人设替换 / 关键词清单）→ 先备份再写。
// 原则：consoleToken 等安全字段拒绝经此通道修改；人设替换必须显式确认（confirmRole）；
//       历史只追加不覆盖；config 类变更写入后尽力热更内存 cfg（与白名单编辑同一做法），
//       但启动时读一次的字段要重启桥接才完整生效 —— 返回值里用 needsRestart 如实标注。
const CFGMOD_CONFIG_KEYS = new Set(['dsh', 'socialV2', 'social', 'allow', 'deny', 'ownerQQ', 'role', 'snowluma', 'consolePort', 'sessionCwd', 'agentPreset', 'workspaceTitle', 'allowAllWhenEmpty', 'ackMessage', 'sendDelayMs', 'questionTimeoutMs', 'pricing', 'security', 'slang']);
const CFGMOD_V2_KEYS = new Set(['enabled', 'autoReplyCheckMs', 'agentPreset', 'provideRecommendations', 'tools', 'wake', 'thinkingFiller', 'send', 'wait', 'sticker', 'memes', 'qzone', 'peakQuiet', 'dshQueue', 'groupSafety', 'sleep', 'diary', 'mood', 'groupRecap', 'broadcast', 'voice', 'proactive', 'feedback', 'memoryDb', 'context', 'account', 'moe', 'express', 'usage', 'grump', 'concurrency', 'slang', 'security']);

function cfgmodIdentify(name, text) {
  const t = String(text ?? '');
  const trimmed = t.trim();
  if (!trimmed) return { target: 'empty', ok: false, error: '空文件' };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let obj;
    try { obj = JSON.parse(trimmed); } catch (e) { return { target: 'invalid-json', ok: false, error: 'JSON 解析失败：' + e.message }; }
    if (Array.isArray(obj) || !obj || typeof obj !== 'object') return { target: 'unknown-json', ok: false, error: '不支持顶层数组/标量的 JSON' };
    const top = Object.keys(obj);
    if (top.includes('consoleToken')) return { target: 'refused', ok: false, error: '拒绝：文件试图修改 consoleToken（安全字段请走「白名单与安全」页）' };
    const direct = top.filter((k) => CFGMOD_CONFIG_KEYS.has(k));
    const v2only = top.length > 0 && top.every((k) => CFGMOD_V2_KEYS.has(k));
    if (direct.length || v2only) return { target: 'config-merge', ok: true, topKeys: top, scope: (v2only && !direct.length) ? 'socialV2' : 'root' };
    return { target: 'unknown-json', ok: false, error: '无法识别的 JSON：顶层键（' + top.slice(0, 8).join(', ') + '）不属于 config.json / socialV2 结构' };
  }
  const mdHeadings = (trimmed.match(/^#{1,3}\s+\S/gm) || []).length;
  if (/\.(md|markdown)$/i.test(name) || mdHeadings >= 1) return { target: 'role-md', ok: true, needsConfirm: true };
  const lines = trimmed.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length && lines.length <= 60 && lines.every((l) => l.length <= 30 && !/[；;{}]/.test(l))) return { target: 'keywords-list', ok: true, count: lines.length };
  return { target: 'unknown-text', ok: false, error: '无法识别：不是 config JSON、人设 Markdown，也不是关键词清单（每行一个、≤30 字）' };
}

function cfgmodDeepMerge(base, patch) {
  const out = (base && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = cfgmodDeepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function cfgmodDeepMergeInto(target, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) cfgmodDeepMergeInto(target[k], v);
    else target[k] = v;
  }
  return target;
}

function cfgmodDiff(a, b, prefix = '', out = [], depth = 0) {
  if (depth > 6) return out;
  for (const k of Object.keys(b || {})) {
    if (out.length >= 40) { out.push('…（更多变更省略）'); return out; }
    const p = prefix ? prefix + '.' + k : k;
    const bv = b[k];
    const av = a ? a[k] : undefined;
    if (JSON.stringify(av) === JSON.stringify(bv)) continue;
    if (bv && typeof bv === 'object' && !Array.isArray(bv) && av && typeof av === 'object' && !Array.isArray(av)) cfgmodDiff(av, bv, p, out, depth + 1);
    else out.push(p + '：' + (av === undefined ? '（新增）' : JSON.stringify(av)) + ' → ' + JSON.stringify(bv).slice(0, 80));
  }
  return out;
}

function cfgmodReadHistory(file) {
  try { const a = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}

function cfgmodWriteHistory(file, arr) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(arr.slice(-60), null, 2) + '\n', 'utf8');
}

export function createConsoleServer(S) {
  const {
    ACTIVITY_LOG,
    CONVERSATION_TOKENS,
    FEEDBACK_FILE,
    KNOWN_AGENT_TOKENS,
    MEME_MAX_BYTES,
    MEME_MOODS,
    MEME_MOOD_DICT,
    PRESET_BACKUP_DIR,
    PRESET_NAMES,
    REASONING_EFFORT_DEFAULT,
    REASONING_EFFORT_OPTIONS,
    ROLE_CONTENT_MAX_BYTES,
    ROLE_NAME_MAX,
    ROOT,
    SENSITIVE_RE,
    SLANG_STATUS,
    SOCIAL_V2_FILE,
    STATE_DIR,
    TOKEN_USAGE_FILE,
    TOOL_LOG_FILE,
    VALID_MODES,
    allowed,
    appendActivity,
    applyRoleInjectLimit,
    atomicWriteJson,
    atomicWriteText,
    backupPresetFile,
    buildMusicShare,
    buildSlangContext,
    buildStickerContext,
    buildStickerStrategyHint,
    canonicalV2Key,
    castVote,
    closePoll,
    convKey,
    createSlangEntry,
    decideAmong,
    describeAudio,
    escapeCqText,
    extractPresetPrefix,
    festivalOf,
    forgetAgentToken,
    formatForwardResponse,
    formatStickerList,
    hardenStateDirAcl,
    inspectAudio,
    installedPresetYaml,
    listAudioFiles,
    listPresetBackups,
    loadOrCreateConsoleToken,
    log,
    looksLikeUnfinished,
    manualDirCommand,
    memeMoodNames,
    mergeEvidence,
    normalizeModeInput,
    normalizeOwnerQQ,
    normalizeReasoningEffort,
    parseTargetKey,
    playLightGame,
    playTurnGame,
    presetPromptBlockers,
    presetPromptWarnings,
    presetSourceYaml,
    presetStatus,
    priceUsage,
    readActivityTail,
    readConfigObject,
    readJsonSafe,
    readPresetPromptText,
    readRoleContent,
    readRoleState,
    releaseLock,
    renderDecide,
    renderLightGame,
    renderMusicShare,
    renderPoll,
    renderPresetPromptYaml,
    renderTurnGame,
    resolveAudioProcessing,
    roleCharStats,
    roleFilePath,
    roleSectionReport,
    roleSummaries,
    roleWarnings,
    safeFetchBuffer,
    sanitizeRoleName,
    saveState,
    sleep,
    startPoll,
    startTurnGame,
    tallyPoll,
    text,
    truncateText,
    unquoteJsonString,
    unwrap,
    validateRoleContent,
    validateRoleName,
    withTimeout,
    writeRoleContent,
    writeRoleState,
    ACCOUNT_ACTION_LEVELS,
    ACCOUNT_LEVEL_RANK,
    ACTIVE_WAIT_LEASE_MS,
    MAX_MEDIA_BYTES,
    MAX_MEDIA_PIXELS,
    MOOD_KINDS_V2,
    MOOD_LABELS,
    MOOD_LABELS_V2,
    PLUGIN_DSH_BIN,
    PLUGIN_PROFILE_DIR,
    RETIRED_TOKEN_GRACE_MS,
    SLEEP_DEFAULT_NIGHT_WINDOWS_V2,
    SLEEP_DEFAULT_REPLY_ON_V2,
    SLEEP_DEFAULT_WAKE_WORDS_V2,
    SLEEP_FORCE_AWAKE_FILE_V2,
    accountEnabled,
    accountLevel,
    acknowledgeMessagesV2,
    activeWaits,
    allowSlangSubmit,
    api,
    appendFeedbackEntry,
    appendMemoryV2,
    applyMemeOverrides,
    applyStickerNoteV2,
    assertGroupMember,
    bot,
    broadcastCfgV2,
    broadcastKeyV2,
    buildUsageReportV2,
    buildWakePromptV2,
    buildWakeSnapshotV2,
    cancelAllSocialTimers,
    cancelPendingEntry,
    cancelReplyCheckV2,
    cancelSocialTimers,
    cfg,
    cleanupSocialForModeChange,
    clearAllPendingWakeLeases,
    clearAllSocialV2Timers,
    clearSocialV2Timers,
    collectStickerV2,
    collectors,
    computeGapsV2,
    computeWakeSafetyV2,
    confirmedSlangListV2,
    currentRoleHint,
    currentRoleHintV2,
    deliverPrompt,
    diaryCfgV2,
    diaryClockV2,
    diaryKeyV2,
    diaryWeekIdV2,
    downloadGithubTarball,
    drainAllPromptQueues,
    drainPromptQueue,
    ensureSession,
    ensureWakeableV2,
    enterActive,
    feedbackTimes,
    fetchMediaData,
    fetchModelCatalog,
    findCjkSpaceWarning,
    findMessageMedia,
    findSplitBoundaryWarning,
    flushSummaries,
    forgetConversationCaches,
    formatMemoryV2,
    formatParticipationV2,
    getImageDimensions,
    getMemeStore,
    getSocialV2State,
    getStickerImageData,
    groupRecapCfgV2,
    groupRecapTargetsV2,
    groupToolsTimes,
    invalidateSlangLearnerSession,
    isSessionAllowedInCurrentMode,
    isSleepingConfigV2,
    leaveActive,
    lightGameTimes,
    listNewModules,
    markReadCalledKeys,
    memeLastSentAt,
    memeMoodOfTag,
    memeOverrides,
    memeRootDir,
    memesEnabled,
    memoryDb,
    memoryDbEnabled,
    messageMediaStore,
    mimeFromBuffer,
    mimeFromUrl,
    modeAllowed,
    modelAppliedSessions,
    modelCatalogErrorLogged,
    moodTimes,
    normalizeImpressionTarget,
    normalizePluginSpec,
    normalizeSpeakerIdsV2,
    noteModelMessagesV2,
    noteSleepGraceV2,
    oneBotCall,
    peakQuietCfgV2,
    peakWindowV2,
    pending,
    pendingAskClaimsV2,
    pendingSendToolCalls,
    pendingWakeKeys,
    pickImpressionField,
    pickOneMemeV2,
    pinnedMemeRowV2,
    pluginJobSnapshot,
    pluginJobs,
    preSleepWaitBlockedV2,
    priceTable,
    publicSlangEntry,
    queueSlangTask,
    queued,
    queuedHintAt,
    qzoneEnabled,
    qzoneImageRef,
    qzonePostLog,
    reactToMessageV2,
    readFeedbackEntries,
    readMoodState,
    readProfilePackage,
    readThroughSeqV2,
    readToolLog,
    reconcileSessionPolicies,
    recordSentMessagesV2,
    redactKnownTokensOnly,
    refreshAllDefaultWakeConfigsV2,
    relationLineV2,
    relationPidForV2,
    replyTimingV2,
    requestedReadThroughSeqV2,
    resolvePresetName,
    resolveReplyInfo,
    resolveReplyTargetV2,
    resolveVoicePathForOperator,
    resolveVoicePathForV2,
    retiredAgentTokens,
    reverse,
    runProfilePnpm,
    runSlangExtraction,
    runSlangResearch,
    saveMemeOverrides,
    saveMoodState,
    saveProfilePackage,
    saveSlangStore,
    saveSocialV2State,
    scheduleProactiveCheckV2,
    scheduleReplyCheckV2,
    scheduleSegmentAt,
    seenForwardIds,
    sendMemeV2,
    sendMessagesV2,
    sendStickerV2,
    sendToolSucceededSessions,
    sendVoiceForV2,
    sendVoiceV2,
    sendWakePromptV2,
    sessionModels,
    sessionPromises,
    setStickerRemarkV2,
    setupSleepTimerV2,
    shouldBlockSilentReply,
    slangExtractionCooldowns,
    slangInjectChars,
    slangInjectMax,
    slangResearchingIds,
    slangSubmitTimes,
    slangWindows,
    sleepCfgV2,
    sleepNightWinV2,
    sleepStateV2,
    snowlumaHealthSnapshot,
    social,
    socialState,
    socialV2,
    startPluginJob,
    stickerEnabled,
    stopRetiredSessionWork,
    suggestQuietMsV2,
    summarizeAccountResult,
    syncStickerLibrary,
    tickMood,
    tokenLedger,
    toolCallNames,
    turnGameTimes,
    usageLineV2,
    v2ToolEnabled,
    v2TurnStartAt,
    verifyVoiceMessageSent,
    voiceBudgetCheck,
    voiceBudgetCommit,
    voiceCfg,
    voiceLibrary,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
    wakeFromSleepV2,
  } = S;
    const port = cfg.consolePort ?? 3100;
    // 控制台鉴权：优先用 config.consoleToken，未配置则自动生成并持久化，不再默认无鉴权。
    // 使用 let 以便控制台内手动修改令牌后热更新。
    const configuredToken = String(cfg.consoleToken ?? '').trim();
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
    let consoleToken = tokenValid ? configuredToken : loadOrCreateConsoleToken();
    // 令牌必须非空才继续。下面鉴权处原来的写法是「令牌为空 ⇒ return true（放行）」，
    // 注释写着"启动时已自动生成并持久化"—— 等于承认那一行不可达，可它是一条**失败开放**的分支：
    // 一旦真的空了（写盘异常被吞、以后新增"关闭鉴权"之类的配置），控制台上那些
    // 改配置 / 发消息 / 读聊天记录的接口会变成完全免鉴权，而 Host 白名单只挡跨机访问、
    // 挡不住本机进程。这里改成失败关闭：宁可启动时报错，也不要静默开着一个无鉴权的管理 API。
    if (!consoleToken) throw new Error('控制台令牌为空：拒绝以无鉴权方式启动控制台 API');
    if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    if (!configuredToken) log(`控制台未配置 consoleToken，已自动生成：${String(consoleToken).slice(0, 6)}…（完整值保存在 state/console-token）`);
    // 二代会话级隔离：MCP 工具调用时若带 x-agent-token，则必须匹配该会话的 agentToken。
    // 控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
    //
    // 定长比较：会话令牌同样是凭据，`===` 会在首个不同字符处短路，本机进程理论上
    // 可用响应时延逐字节试探。与控制台令牌（见下方 timingSafeEqual）保持一致。
    const tokenEq = (a, b) => {
      if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
      const x = Buffer.from(a, 'utf8');
      const y = Buffer.from(b, 'utf8');
      return x.length === y.length && crypto.timingSafeEqual(x, y);
    };
    // [patch 令牌宽限] 会话轮换（上下文超限 / 毒会话自愈 / 权限变化）会换新 agentToken，
    // 但**在途的那一条唤醒提示词里写的是旧 token**：那一轮里她调任何工具都会被
    // 「agent token 无效」挡住，模型只能反复试、最后放弃（用户 2026-10-18 反馈的整屏报错）。
    // 轮换时把旧 token 记进宽限表，同 key 最近 6 代旧 token 在 60 分钟内仍然可用；过期自动作废。
    const retiredTokenOk = (key, token) => {
      const list = retiredAgentTokens.get(key);
      if (!Array.isArray(list) || list.length === 0) return false;
      const now = Date.now();
      const alive = list.filter((r) => r && now <= r.until);
      if (alive.length !== list.length) {
        if (alive.length === 0) retiredAgentTokens.delete(key);
        else retiredAgentTokens.set(key, alive);
      }
      return alive.some((r) => tokenEq(token, r.token));
    };
    const tokenMismatchLogAt = new Map();
    const agentTokenOk = (key, token) => {
      const canonical = canonicalV2Key(key);
      const k = canonical ?? key;
      const st = socialV2.conversations.get(k);
      if (st && st.agentToken && tokenEq(token, st.agentToken)) return true;
      if (retiredTokenOk(k, token)) {
        log(`[auth] ${k} 用的是轮换前的旧令牌（${Math.round(RETIRED_TOKEN_GRACE_MS / 60000)} 分钟宽限内，已放行）`);
        return true;
      }
      const now = Date.now();
      if (now - (tokenMismatchLogAt.get(k) || 0) > 60000) {
        tokenMismatchLogAt.set(k, now);
        const given = String(token ?? '');
        log(`[auth] ${k} agent token 不匹配（收到 ${given ? given.slice(0, 8) + '…' : '空'}，当前 ${String(st?.agentToken || '').slice(0, 8)}…）`);
      }
      return false;
    };
    /**
     * 令牌是否匹配**任意**一个活跃二代会话。
     *
     * 用途是集中式纵深防御（见下方 x-agent-call 关卡）：各端点自己那套
     * `if (x-agent-token && !agentTokenOk(key, token))` 把关的是「这个令牌能不能动这个
     * 会话」；这里把关的是「这到底是不是一次智能体调用」。两层都需要，因为前者在
     * 端点漏写时会整个失效。
     */
    const isLiveAgentToken = (token) => {
      if (typeof token !== 'string' || !token) return false;
      for (const st of socialV2.conversations.values()) {
        if (st?.agentToken && tokenEq(token, st.agentToken)) return true;
      }
      // [patch 令牌宽限] 轮换前的旧令牌在宽限期内也算「活跃智能体调用」，否则集中关卡会先把它 403 掉。
      const now = Date.now();
      for (const list of retiredAgentTokens.values()) {
        for (const rec of list ?? []) {
          if (rec && now <= rec.until && tokenEq(token, rec.token)) return true;
        }
      }
      return false;
    };
    // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
    const v2SessionAllowed = isSessionAllowedInCurrentMode;
    // [patch key 误填 2026-10-18] 模型有时把**会话令牌**填进 `key` 参数（实测 439 次带 key 的调用里 9 次），
    // 于是 agentTokenOk(key, token) 必然 false，报出来的却是「agent token 无效」——诊断方向完全错。
    // 起因是唤醒提示里那句「每次都要把这串同时填进 key 和 token」（已改掉），但**历史回合的上下文里
    // 那句还在**，所以桥接侧也要能自愈：令牌本身只对应唯一一个会话，用它反查 key 不会越权
    // （拿 A 会话的令牌换不出 B 会话）。返回 null 表示「这不是令牌」，按原样往下走。
    // 令牌两种长度都见过：首次铸造 `randomBytes(16)` = 32 位，轮换后 `randomBytes(24)` = 48 位
    // （用户实测报错里那串就是 48 位）。别只认 48 位，否则新会话的自愈会失效。
    const TOKEN_SHAPED_RE = /^[0-9a-f]{32,64}$/i;
    function keyFromTokenShaped(rawKey, token) {
      const k = String(rawKey ?? '').trim();
      if (!TOKEN_SHAPED_RE.test(k)) return null;
      // 必须与请求自带的令牌逐字节相同：否则「key 填了别人的令牌」这种组合不能放行。
      if (!token || !tokenEq(k, String(token))) return null;
      for (const [convKey, convSt] of socialV2.conversations) {
        if (convSt?.agentToken && tokenEq(k, convSt.agentToken)) return convKey;
      }
      return null;
    }
    /** 请求体里的 key 被误填成令牌时改回真实 key；改了就记一行日志，便于发现提示词回归。 */
    function repairAgentKeyInBody(body, token, where) {
      if (!body || typeof body !== 'object') return false;
      let changed = false;
      const fixed = keyFromTokenShaped(body?.key, token);
      if (fixed) {
        log(`[patch key 误填] ${where || ''} 的 key 是会话令牌，已按令牌反查为 ${fixed}`);
        body.key = fixed;
        changed = true;
      }
      // [patch key 误填 2026-10-19] 新场景：**整个填反** —— key 填了令牌、token 填了会话 key。
      // 上面的分支只修 key，token 还是错的（报「未授权：智能体调用必须携带有效的会话令牌」）。
      // token 位置出现的是合法会话 key 时，直接按 key 反查该会话的真令牌补上（同会话内自愈，不越权）。
      const tk = String(body?.token ?? '').trim();
      if (/^(group|private):\d+$/.test(tk)) {
        const st = socialV2.conversations.get(tk);
        if (st?.agentToken) {
          log(`[patch key 误填] ${where || ''} 的 token 填成了会话 key（${tk}），已补回该会话真令牌`);
          body.token = st.agentToken;
          changed = true;
        }
      }
      return changed;
    }
    const server = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
        res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
        return;
      }
      // [patch key 误填 2026-10-18] GET 端点（qq_get_prompt / qq_get_unread_messages / qq_social_state
      // / qq_wait_for_messages 等）从 query 读 key，POST 那套 readBody 自愈覆盖不到，这里补一处。
      if (url.searchParams.has('key')) {
        try {
          const fixedQueryKey = keyFromTokenShaped(url.searchParams.get('key'), req.headers['x-agent-token']);
          if (fixedQueryKey) {
            log(`[patch key 误填] ${url.pathname} 的 query key 是会话令牌，已按令牌反查为 ${fixedQueryKey}`);
            url.searchParams.set('key', fixedQueryKey);
          }
        } catch { /* 自愈失败不影响主流程 */ }
      }
      const SECURITY_HEADERS = {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      };
      const sendJson = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        res.end(JSON.stringify(obj, null, 2));
      };
      const readBody = () => new Promise((resolve, reject) => {
        const MAX_BODY_BYTES = 1_000_000;
        const chunks = [];
        let total = 0;
        let settled = false;
        let bodyTimer = null;
        const fail = (status, message) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          const err = new Error(message);
          err.statusCode = status;
          reject(err);
        };
        const done = (val) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          resolve(val);
        };
        // 提前按 Content-Length 拒绝超限请求体
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
        req.on('data', (c) => {
          if (settled) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += buf.length;
          if (total > MAX_BODY_BYTES) {
            req.pause();
            fail(413, '请求体过大（超过 1MB）');
            return;
          }
          chunks.push(buf);
        });
        req.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf8');
          if (!data.trim()) { done({}); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fail(400, '请求体必须是 JSON 对象');
            return;
          }
          // [patch key 误填 2026-10-18] 在**解析入口**统一自愈，而不是 40 多个端点各写一遍：
          // 模型可能把会话令牌填进 `key`（见 keyFromTokenShaped 的注释），这里按令牌反查回真实 key。
          // 控制台请求带的是 x-console-token、不是 x-agent-token，因此不会被这条逻辑影响。
          try { repairAgentKeyInBody(parsed, req.headers['x-agent-token'], url?.pathname); } catch { /* 自愈失败不影响主流程 */ }
          done(parsed);
        });
        // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
        req.on('error', () => fail(400, '请求体读取失败'));
        req.on('aborted', () => fail(400, '请求体读取中断'));
      });
      // 浏览器会自动请求 /favicon.ico，且**不带控制台令牌**。若让它落到下面的鉴权分支，
      // 每次打开控制台都会在 DevTools 里留一条 401 噪音（离线预览 fixture 早已用 204 处理，
      // 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉。
      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')) {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }
      // Host 头校验（DNS rebinding 硬化）：控制台只监听 127.0.0.1，因此合法请求的 Host
      // 只可能是 127.0.0.1 / localhost / [::1] 加本端口。攻击者用一个 TTL=0 的域名解析到
      // 127.0.0.1 时，浏览器会把 evil.com:3100 当作同源，Origin 校验随之失效；卡住 Host
      // 这一层后，这类请求在进入任何业务分支之前就被拒掉。
      // 反代/端口转发场景会被一并拒绝——这是有意的（要远程访问请用 SSH 隧道并自行承担）。
      const hostHeader = String(req.headers.host ?? '');
      // 用**实际绑定端口**而不是配置值：测试夹具用 consolePort: 0 让系统分配端口，
      // 配置里那个 0 不是请求里的 Host 端口。请求必然发生在 listen 之后，所以这里拿得到。
      const boundPort = server.address()?.port ?? port;
      const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
      if (!allowedHosts.includes(hostHeader.toLowerCase())) {
        sendJson({ ok: false, error: `Host 头不被允许（${hostHeader || '缺失'}）：控制台只接受本机回环访问` }, 403);
        return;
      }
      // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
      // 定长比较：`!==` 会在第一个不同的字符处短路，理论上可被本机进程用响应时延逐字节试探。
      // 令牌是 192 bit 随机值且只监听回环，所以这是纵深防御而非在野漏洞。
      // [patch 令牌记住] 除了 ?token= 与 x-console-token，也认 cookie：刷新时浏览器自动带上，
      // 这样 localStorage 被隐私模式/清理掉也不至于每次刷新都重新输令牌。
      const adminCookieName = 'qq_admin_' + boundPort;
      const cookieToken = (() => {
        const raw = String(req.headers.cookie ?? '');
        for (const part of raw.split(';')) {
          const eq = part.indexOf('=');
          if (eq < 0) continue;
          if (part.slice(0, eq).trim() !== adminCookieName) continue;
          try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return ''; }
        }
        return '';
      })();
      const suppliedToken = String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? cookieToken ?? '');
      const tokenMatches = (() => {
        if (!consoleToken) return false; // 上面已拒绝空令牌；真出现也只许失败关闭，绝不 return true
        const a = Buffer.from(suppliedToken, 'utf8');
        const b = Buffer.from(consoleToken, 'utf8');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
      })();
      if (consoleToken && !tokenMatches) {
        // [patch 令牌记住] 页面 HTML 本身不含机密，允许直接打开：由页面用 localStorage / cookie 里
        // 记着的令牌去调 API。这样刷新不会被浏览器的 prompt() 再拦一次；真没有令牌时页面自己弹框。
        const isPageRequest = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin' || url.pathname === '/admin.html');
        if (!isPageRequest) {
          sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
          return;
        }
      }
      // 智能体调用隔离（集中关卡）。
      //
      // 背景：控制台令牌是「管理端全权」，会话令牌是「只能动自己这个会话」。MCP 工具进程
      // 两者都持有，所以「这次请求到底是智能体发的还是管理端发的」必须由请求自己声明。
      // 各端点用 `if (x-agent-token && !agentTokenOk(...))` 做会话绑定校验，但那个写法在
      // **头缺失时整条跳过** —— 而头缺失恰恰是模型没传 token 时的自然结果
      // （旧版 mcp-snowluma-safe.js 用 `...(token ? {...} : {})` 直接省略了这个头）。
      // 于是「漏传令牌」不是被拒绝，而是**升级成控制台全权**：典型的 confused deputy。
      //
      // 现在 MCP 端一律带上 x-agent-call: 1（缺令牌时 x-agent-token 为空串），这里只要看到
      // 这个声明就要求令牌必须命中某个活跃会话，端点自己漏写校验也不会退回管理端。
      if (req.headers['x-agent-call'] !== undefined) {
        if (!isLiveAgentToken(req.headers['x-agent-token'])) {
          sendJson({ ok: false, error: '未授权：智能体调用必须携带有效的会话令牌' }, 403);
          return;
        }
      }
      // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
      // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
      // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
      if (req.method !== 'GET') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!ctype.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers['origin'];
        if (origin) {
          let originHost = '';
          try { originHost = new URL(String(origin)).host; } catch {}
          if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(originHost)) {
            sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        }
      }
      try {
        // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
        if (req.headers['x-agent-token'] === '') {
          sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
          return;
        }
        // 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝
        if (socialV2.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理）
        if (cfg.socialV2?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用
        if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && S.currentMode !== 'reserved2') {
          sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
          return;
        }
        // 管理端专用 v2 接口：带 agent token 的请求一律拒绝，防止 MCP 工具越权访问控制台功能
        const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states', '/api/socialV2/wake', '/api/socialV2/sleep-toggle'];
        if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库）
        if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
        // 因此仅靠控制台令牌挡不住 AI。这里改成白名单：只有 AI 真正需要的面放行，
        // 其余（人格/提示词/思考强度/白名单/重启…）一律 403——避免以后新增管理端点时忘记拉黑。
        if (req.headers['x-agent-token']) {
          const agentAllowed = url.pathname === '/api/status'
            || url.pathname.startsWith('/api/socialV2/')
            || url.pathname.startsWith('/api/send/')
            || url.pathname.startsWith('/api/images/')
            || url.pathname === '/api/authorize/read';
          if (!agentAllowed) {
            sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
            return;
          }
        }
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin.html')) {
          // [patch 令牌记住] 带 ?token= 打开过一次就种成 cookie（SameSite=Strict、30 天），
          // 之后刷新浏览器自动带上，不用再输。
          if (tokenMatches) {
            res.setHeader('set-cookie', 'qq_admin_' + boundPort + '=' + encodeURIComponent(consoleToken) + '; Path=/; Max-Age=2592000; SameSite=Strict');
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8'));
          } catch {
            res.end('后台页面缺失：qq-bridge/public/admin.html');
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const rs = readRoleState();
          // 带 agent token 的调用来自 QQ 群里的 AI：只能拿到它自己该知道的运行状态。
          // activity 是**全局**收发摘要（含其它群的发言片段与告警），ownerQQ/白名单属于管理信息，
          // 都不能给到会话级主体，否则 A 群的 AI 能读到 B 群的内容。
          // 判定「是不是智能体调用」必须同时看 x-agent-call：无令牌的智能体调用
          // （旧只读工具的模式探测）不带 x-agent-token，但它同样**绝不能**拿到管理端字段
          // —— ownerQQ / 白名单 / activity（含其它群的发言片段）是跨群管理信息。
          // 只认 token 会让这类请求落到下面的完整对象上，等于把 A 群的 AI 变成管理端。
          if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) {
            sendJson({
              mode: S.currentMode,
              role: rs.role ?? null,
              roleMode: rs.mode ?? 'active',
              dshReady: S.dshReady,
              socialV2Paused: socialV2.paused,
            });
            return;
          }
          sendJson({
            mode: S.currentMode,
            closedAgentPreset: S.closedAgentPreset,
            role: rs.role ?? null,
            roleMode: rs.mode ?? 'active',
            dshReady: S.dshReady,
            ownerQQ: cfg.ownerQQ ?? null,
            allowGroups: cfg.allow?.groups ?? [],
            // 高峰静默现在是不是生效（运维/回归用；配置本身在 config.json 的 socialV2.peakQuiet）
            peakQuiet: (() => {
              const win = peakWindowV2();
              return win
                ? { active: true, from: win.from, to: win.to, scope: peakQuietCfgV2().scope ?? 'groups' }
                : { active: false, scope: peakQuietCfgV2().scope ?? 'groups' };
            })(),
            // 睡眠状态（运维/回归用；配置在 config.json 的 socialV2.sleep）
            sleep: (() => {
              const s = sleepCfgV2();
              const win = sleepNightWinV2();
              const asleepKeys = [];
              for (const [k, stx] of socialV2.conversations) {
                if (sleepStateV2(k, stx).asleep) asleepKeys.push(k);
              }
              return {
                enabled: s.enabled !== false,
                nightActive: !!win && !S.sleepForceAwakeV2,
                forceAwake: S.sleepForceAwakeV2,
                window: win ? `${win.from}-${win.to}` : null,
                scope: s.scope ?? 'all',
                replyOn: Array.isArray(s.replyOn) && s.replyOn.length ? s.replyOn : SLEEP_DEFAULT_REPLY_ON_V2,
                wakeWords: Array.isArray(s.wakeWords) && s.wakeWords.length ? s.wakeWords : SLEEP_DEFAULT_WAKE_WORDS_V2,
                asleepKeys
              };
            })(),
            // 日记（运维/回归用；配置在 config.json 的 socialV2.diary）
            diary: (() => {
              const d = diaryCfgV2();
              const clock = diaryClockV2();
              const dkey = diaryKeyV2();
              const dst = dkey ? socialV2.conversations.get(dkey) : null;
              const mdbRef = memoryDbEnabled() ? memoryDb() : null;
              return {
                enabled: d.enabled !== false,
                key: dkey || null,
                time: d.time,
                weekly: { enabled: d.weeklyEnabled !== false, weekday: d.weeklyWeekday, time: d.weeklyTime },
                weekId: diaryWeekIdV2(clock.date),
                now: clock.date
                  ? `${clock.date} ${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}`
                  : null,
                lastDiaryDay: dst ? dst.lastDiaryDay || '' : '',
                lastDiaryWeek: dst ? dst.lastDiaryWeek || '' : '',
                includeInPrompt: d.includeInPrompt !== false,
                stats: mdbRef && typeof mdbRef.diaryStats === 'function' ? mdbRef.diaryStats() : null
              };
            })(),
            // [群聊小总结] 运维能看到"开了没 / 发哪些群 / 上次发到哪天"。
            groupRecap: (() => {
              const g = groupRecapCfgV2();
              const clock = diaryClockV2();
              const targets = g.enabled ? groupRecapTargetsV2() : [];
              return {
                enabled: g.enabled,
                time: g.time,
                weekly: { enabled: g.weeklyEnabled, weekday: g.weeklyWeekday, time: g.weeklyTime },
                minMessages: g.minMessages,
                weeklyMinMessages: g.weeklyMinMessages,
                keys: g.keys,
                targets: targets.map((k) => ({
                  key: k,
                  lastGroupRecapDay: socialV2.conversations.get(k)?.lastGroupRecapDay || '',
                  lastGroupRecapWeek: socialV2.conversations.get(k)?.lastGroupRecapWeek || ''
                })),
                now: clock.date
                  ? `${clock.date} ${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}`
                  : null
              };
            })(),
            // [定时播报] 运维能看到"开了没 / 早晚报时间 / 上次播到哪天 / 有没有节日"。
            broadcast: (() => {
              const b = broadcastCfgV2();
              const clock = diaryClockV2();
              const bkey = broadcastKeyV2();
              const bst = bkey ? socialV2.conversations.get(bkey) : null;
              return {
                enabled: b.enabled,
                key: bkey || null,
                timeZone: b.timeZone,
                morning: { enabled: b.morningEnabled, time: b.morningTime },
                evening: { enabled: b.eveningEnabled, time: b.eveningTime },
                festival: { enabled: b.festivalEnabled, today: clock.date ? (festivalOf(clock.date)?.name || '') : '' },
                hot: { enabled: b.hotEnabled, url: b.hotUrl, max: b.hotMax, cached: S.hotTopicCacheV2.titles.length || 0 },
                lastMorning: bst ? bst.lastBroadcastMorning || '' : '',
                lastEvening: bst ? bst.lastBroadcastEvening || '' : '',
                lastFestival: bst ? bst.lastBroadcastFestivalDay || '' : '',
                now: clock.date
                  ? `${clock.date} ${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}`
                  : null
              };
            })(),

            socialV2Paused: socialV2.paused,
            // 上游健康只给操作者看：它包含网关诊断信息（good/hint），
            // 属于管理侧观测，不该进 QQ 会话里那个受限的智能体视图。
            snowluma: snowlumaHealthSnapshot(),
            activity: readActivityTail(100)
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/presets') {
          let presets = [];
          try {
            const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
            presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
          } catch {}
          sendJson({ presets });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/mode') {
          const body = await readBody();
          // 规范名与历史名都接受，落盘的始终是内部拼写（见 MODE_INPUT_ALIASES）。
          const requestedMode = normalizeModeInput(body.mode);
          if (!requestedMode) {
            sendJson({ ok: false, error: `mode 必须是 ${VALID_MODES.join(' / ')}（simulation 为 reserved2 的规范名）` }, 400);
            return;
          }
          const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
          const next = {
            mode: requestedMode,
            // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
            ...(body.closedAgentPreset !== undefined
              ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
              : { closedAgentPreset: String(existing.closedAgentPreset ?? '') })
          };
          atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
          // 用字符串判断而非真值判断：空串是「显式清空 preset」，也要生效。
          S.closedAgentPreset = next.closedAgentPreset;
          // 写穿到 DSH 设置。refreshMode() 每 5 秒跑一次且以 DSH 的值为准（插件的 base 保证
          // 该命名空间永远有值），所以只写本地 state/mode.json 会在下一次轮询时被静默回滚。
          // 写穿的是**内部拼写**（`simulation` 会写成 `reserved2`）：DSH 里那份值会被 refreshMode
          // 读回来当 `currentMode` 用，存规范名会让下游那些 `=== 'reserved2'` 判断失效。
          let dshSynced = false;
          try {
            // unwrap() 在 result.ok 为 false 时直接抛错，所以能执行到下一行即代表写穿已成功
            // （不要在这里再判断 updated?.ok —— 解包后的值恒为真，那样的分支是死代码）。
            unwrap(await api.settings.update({ ns: 'qq-mode', patch: { mode: requestedMode } }), 'settings.update');
            dshSynced = true;
          } catch (error) {
            log(`控制台：模式写穿 DSH 设置失败（${error?.message ?? error}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
          }
          // 下面这两个判断比较的是「模式真的变了吗」。必须用归一后的值：拿 `body.mode` 比，
          // 把 `simulation` 与 `reserved2` 当成两种模式，会在模式其实没变时清掉二代定时器与排队投递。
          if (S.currentMode === 'reserved' && requestedMode !== 'reserved') {
            cleanupSocialForModeChange();
            log('控制台：模式离开一代仿真模式，清理社交状态');
          }
          if (S.currentMode === 'reserved2' && requestedMode !== 'reserved2') {
            clearAllSocialV2Timers();
            drainAllPromptQueues('模式切换，已取消排队中的投递');
            log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
          }
          S.currentMode = requestedMode;
          S.lastMode = requestedMode;
          reconcileSessionPolicies();
          if (requestedMode === 'reserved2') {
            for (const key of socialV2.conversations.keys()) {
              setupSleepTimerV2(key);
              scheduleProactiveCheckV2(key);
            }
            log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
          }
          log(`控制台：模式已设置为 ${requestedMode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
          sendJson({ ok: true, mode: requestedMode, closedAgentPreset: next.closedAgentPreset, dshSynced });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role') {
          const body = await readBody();
          const rs = readRoleState();
          if (body.role && typeof body.role === 'string') {
            const name = sanitizeRoleName(body.role);
            if (!fs.existsSync(path.join(ROOT, 'roles', name + '.md'))) {
              sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
              return;
            }
            writeRoleState(name, rs.mode);
            log(`控制台：角色已设置为 ${name}`);
            sendJson({ ok: true, role: name });
          } else {
            writeRoleState(null, rs.mode);
            log('控制台：角色已清除');
            sendJson({ ok: true, role: null });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role-mode') {
          const body = await readBody();
          const rs = readRoleState();
          const mode = body.mode === 'silent' ? 'silent' : 'active';
          writeRoleState(rs.role, mode);
          log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
          sendJson({ ok: true, roleMode: mode });
          return;
        }
        // ── 人格管理 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/roles') {
          const rs = readRoleState();
          const summaries = roleSummaries();
          sendJson({
            // roles 保持「人格名字符串数组」的既有契约（scripts/test-console.mjs 等调用方依赖它）；
            // 富信息放在 summaries 里，新老调用方互不影响。
            roles: summaries.map((role) => role.name),
            summaries,
            current: rs.role ?? null,
            limits: { nameMax: ROLE_NAME_MAX, contentMaxBytes: ROLE_CONTENT_MAX_BYTES, injectMaxChars: S.roleInjectMaxChars },
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/roles/content') {
          let name;
          try { name = validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          const content = readRoleContent(name);
          sendJson({
            ok: true,
            name,
            content,
            chars: content.length,
            bytes: Buffer.byteLength(content, 'utf8'),
            warnings: roleWarnings(content),
            limits: { injectMaxChars: S.roleInjectMaxChars },
            stats: roleCharStats(content),
            // 每个小节在各模式下是否会被注入，供控制台预览「这条规则到底生不生效」
            sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/limit') {
          const body = await readBody();
          const next = applyRoleInjectLimit(body.maxInjectChars);
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          file.role = { ...(file.role ?? {}), maxInjectChars: next };
          atomicWriteJson(configFile, file);
          cfg.role = { ...(cfg.role ?? {}), maxInjectChars: next };
          S.roleInjectMaxChars = next;
          log(`控制台：人格注入上限已设为 ${next} 字符（下一条消息生效）`);
          sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/create') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return; }
          writeRoleContent(name, content);
          log(`控制台：创建人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/update') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          writeRoleContent(name, content);
          log(`控制台：更新人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, chars: content.length, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/rename') {
          const body = await readBody();
          let from; let to;
          try { from = validateRoleName(body.from); to = validateRoleName(body.to); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (from === to) { sendJson({ ok: true, role: to, renamed: false }); return; }
          if (!fs.existsSync(roleFilePath(from))) { sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return; }
          if (fs.existsSync(roleFilePath(to))) { sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return; }
          fs.renameSync(roleFilePath(from), roleFilePath(to));
          const rs = readRoleState();
          const switched = rs.role === from;
          if (switched) writeRoleState(to, rs.mode);
          log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
          sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/delete') {
          const body = await readBody();
          let name;
          try { name = validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          fs.rmSync(roleFilePath(name));
          const rs = readRoleState();
          const cleared = rs.role === name;
          if (cleared) writeRoleState(null, rs.mode);
          log(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
          sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
          return;
        }

        // ── 仿真提示词（一代 / 二代各自的预设内置提示词）──────────────────────
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt') {
          const preset = resolvePresetName(url.searchParams.get('preset'));
          try {
            const { prefix } = readPresetPromptText(preset);
            sendJson({
              ok: true,
              content: prefix,
              chars: prefix.length,
              bytes: Buffer.byteLength(prefix, 'utf8'),
              warnings: presetPromptWarnings(prefix),
              status: presetStatus(preset),
              presets: Object.values(PRESET_NAMES).map((n) => presetStatus(n)),
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: presetStatus(preset) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt') {
          const body = await readBody();
          const preset = resolvePresetName(body.preset);
          let nextText;
          try {
            const { text, prefix } = readPresetPromptText(preset);
            // 内容没变就不要写：写回会把折叠块规整成字面量块（值不变但排版变化），
            // 让一次"打开又保存"把整个提示词块变成全删全加的 diff，失去可复审性。
            const normalized = String(body.content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
            if (normalized === prefix) {
              sendJson({ ok: true, unchanged: true, chars: prefix.length, warnings: presetPromptWarnings(prefix), synced: fs.existsSync(installedPresetYaml(preset)), requiresRestart: false, status: presetStatus(preset) });
              return;
            }
            nextText = renderPresetPromptYaml(text, body.content, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '校验失败' }, 400);
            return;
          }
          const warnings = presetPromptWarnings(body.content);
          let sourceBackup = null;
          try {
            sourceBackup = backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), nextText);
            // 同步到 DSH 实际读取的安装目录。
            // 注意：安装副本**不做仓库内备份**——它的内容与刚写好的源文件一致，
            // 备份它等于把含本机绝对路径的快照塞进仓库工作区，没有额外价值。
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) {
              fs.copyFileSync(presetSourceYaml(preset), installed);
            }
          } catch (error) {
            // 尽力回滚源文件，避免留下半截状态
            if (sourceBackup && fs.existsSync(sourceBackup)) {
              try { fs.copyFileSync(sourceBackup, presetSourceYaml(preset)); } catch {}
            }
            sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
            return;
          }
          log(`控制台：${preset} 仿真提示词已更新（${String(body.content ?? '').length} 字符）${warnings.length ? `，${warnings.length} 条警告` : ''}；需重启 DSH 生效`);
          sendJson({
            ok: true,
            chars: String(body.content ?? '').length,
            warnings,
            synced: fs.existsSync(installedPresetYaml(preset)),
            requiresRestart: true,
            status: presetStatus(preset),
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt/backups') {
          try {
            sendJson({ ok: true, backups: listPresetBackups(resolvePresetName(url.searchParams.get('preset'))) });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt/restore') {
          const body = await readBody();
          const preset = resolvePresetName(body.preset);
          try {
            const requested = String(body.file ?? '').trim();
            const candidates = listPresetBackups(preset).map((b) => b.file);
            const target = requested || candidates[0];
            // 只允许还原本预设目录下的备份文件，拒绝任何路径穿越
            if (!target || !candidates.includes(target)) { sendJson({ ok: false, error: '没有可用的备份' }, 400); return; }
            const backupPath = path.join(PRESET_BACKUP_DIR, target);
            const restored = fs.readFileSync(backupPath, 'utf8');
            const restoredPrefix = extractPresetPrefix(restored);
            if (restoredPrefix === null) { sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return; }
            // 还原路径必须与保存路径同样严格：旧备份可能来自安全基线加入之前，
            // 直接还原会把弱化版提示词（缺「你没有本地工具」等不变量）写回去。
            // 不变量清单**按预设取**：一代本来就没有「你没有本地工具」这类工具面表述。
            const blockers = presetPromptBlockers(restoredPrefix, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
            if (blockers.length) {
              sendJson({ ok: false, error: `该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}` }, 400);
              return;
            }
            backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), restored);
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) fs.copyFileSync(presetSourceYaml(preset), installed);
            log(`控制台：${preset} 仿真提示词已还原自备份 ${target}；需重启 DSH 生效`);
            sendJson({ ok: true, restoredFrom: target, requiresRestart: true });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
          }
          return;
        }

        // ── 黑话库管理 ──────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/slang') {
          const status = url.searchParams.get('status') || '';
          const list = status ? S.slangEntries.filter((e) => e.status === status) : S.slangEntries;
          sendJson({ entries: list, config: cfg.slang });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang') {
          const body = await readBody();
          const content = String(body.content ?? '').trim();
          if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          if (S.slangEntries.some((e) => e.content === content)) { sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return; }
          const entry = createSlangEntry({
            content,
            meaning: String(body.meaning ?? '').trim(),
            usage: String(body.usage ?? '').trim(),
            example: String(body.example ?? '').trim(),
            risk: String(body.risk ?? '').trim(),
            sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
            status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
            source: 'manual',
            evidence: Array.isArray(body.evidence) ? body.evidence : []
          });
          S.slangEntries.push(entry);
          saveSlangStore();
          log(`控制台：新增黑话「${content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
          const body = await readBody();
          const status = String(body.status ?? '').trim();
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
            return;
          }
          let removedCount = 0;
          if (status) {
            removedCount = S.slangEntries.filter((e) => e.status === status).length;
            S.slangEntries = S.slangEntries.filter((e) => e.status !== status);
          } else {
            removedCount = S.slangEntries.length;
            S.slangEntries = [];
            // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
            slangWindows.clear();
            slangExtractionCooldowns.clear();
            slangSubmitTimes.clear();
            slangResearchingIds.clear();
          }
          saveSlangStore();
          log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          const status = String(body.status ?? '').trim();
          if (ids.length) {
            const idSet = new Set(ids);
            const before = S.slangEntries.length;
            S.slangEntries = S.slangEntries.filter((e) => !idSet.has(e.id));
            const removedCount = before - S.slangEntries.length;
            if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return; }
            saveSlangStore();
            log(`控制台：批量删除黑话 ${removedCount} 条`);
            sendJson({ ok: true, removedCount });
            return;
          }
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
            return;
          }
          if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return; }
          const removedCount = S.slangEntries.filter((e) => e.status === status).length;
          S.slangEntries = S.slangEntries.filter((e) => e.status !== status);
          saveSlangStore();
          log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return; }
          let confirmedCount = 0;
          let skippedCount = 0;
          const skipped = [];
          for (const id of ids) {
            const idx = S.slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
            const entry = S.slangEntries[idx];
            if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
            if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
            entry.status = SLANG_STATUS.CONFIRMED;
            entry.updatedAt = new Date().toISOString();
            confirmedCount++;
          }
          if (confirmedCount) saveSlangStore();
          log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
          sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return; }
          let rejectedCount = 0;
          for (const id of ids) {
            const idx = S.slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) continue;
            const entry = S.slangEntries[idx];
            if (entry.status === SLANG_STATUS.REJECTED) continue;
            entry.status = SLANG_STATUS.REJECTED;
            entry.updatedAt = new Date().toISOString();
            rejectedCount++;
          }
          if (rejectedCount) saveSlangStore();
          log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
          sendJson({ ok: true, rejectedCount });
          return;
        }
        const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
        if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = S.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = { ...slangEntries[idx] };
          if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
          if (body.content !== undefined && S.slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
            sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
            return;
          }
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
          if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          entry.updatedAt = new Date().toISOString();
          S.slangEntries[idx] = entry;
          saveSlangStore();
          log(`控制台：更新黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
          const id = slangMatch[1];
          const idx = S.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = S.slangEntries[idx];
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (!entry.meaning) {
            sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
            return;
          }
          entry.status = SLANG_STATUS.CONFIRMED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：确认黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
          const id = slangMatch[1];
          const idx = S.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const entry = S.slangEntries[idx];
          entry.status = SLANG_STATUS.REJECTED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：拒绝黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = S.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const [removed] = S.slangEntries.splice(idx, 1);
          saveSlangStore();
          log(`控制台：删除黑话「${removed.content}」`);
          sendJson({ ok: true, removed });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (key && slangWindows.has(key)) {
            queueSlangTask(() => runSlangExtraction(key));
            sendJson({ ok: true, key });
          } else {
            const firstKey = slangWindows.keys().next().value;
            if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return; }
            queueSlangTask(() => runSlangExtraction(firstKey));
            sendJson({ ok: true, key: firstKey });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/research') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          const candidates = ids.length
            ? S.slangEntries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
            : S.slangEntries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
          if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return; }
          queueSlangTask(() => runSlangResearch(candidates));
          sendJson({ ok: true, count: candidates.length });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/config') {
          const body = await readBody();
          const oldPreset = cfg.slang?.learnerPreset;
          const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const merged = { ...(file.slang ?? {}), ...body };
          if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
          else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
          if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
          if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
          if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
          if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
          if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
          if (body.inferenceThresholds !== undefined) {
            const raw = Array.isArray(body.inferenceThresholds)
              ? body.inferenceThresholds
              : String(body.inferenceThresholds).split(/[,，\s]+/);
            merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
            if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
          }
          file.slang = merged;
          atomicWriteJson(configFile, file);
          cfg.slang = { ...cfg.slang, ...merged };
          if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习 preset 已变更，已重置学习会话');
          } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习工作区名已变更，已重置学习会话');
          }
          log('控制台：黑话系统配置已更新');
          sendJson({ ok: true, config: cfg.slang });
          return;
        }
        // ── 会话查看 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          const list = [];
          for (const [key, sessionId] of Object.entries(S.state.sessions)) {
            list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
          }
          sendJson({ sessions: list });
          return;
        }
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/pending') {
          const list = [];
          for (const [key, p] of pending.entries()) {
            list.push({
              key,
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }
          sendJson({ pending: list });
          return;
        }
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
        if (req.method === 'GET' && url.pathname === '/api/whitelist') {
          sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/whitelist') {
          const body = await readBody();
          const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = readConfigObject(configFile);
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = normalizeOwnerQQ(body.ownerQQ);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return;
            }
          }
          file.allow = allow;
          file.deny = deny;
          file.ownerQQ = ownerQQ;
          atomicWriteJson(configFile, file);
          cfg.allow = { private: allow.private, groups: allow.groups };
          cfg.deny = { private: deny.private, groups: deny.groups };
          cfg.ownerQQ = ownerQQ;
          reconcileSessionPolicies();
          log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
          sendJson({ ok: true, allow, deny, ownerQQ });
          return;
        }

        // ── DSH 模型与思考强度 ───────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/dsh/model') {
          const provider = String(cfg.dsh?.provider || 'deepseek-official');
          const model = String(cfg.dsh?.model || 'longcat-2.5-preview-free');
          // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
          let options = REASONING_EFFORT_OPTIONS.slice();
          let labels = {};
          let providerDefault = null;
          let catalogSource = 'fallback';
          try {
            if (!S.modelCatalogInFlight) {
              S.modelCatalogInFlight = withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
                .finally(() => { S.modelCatalogInFlight = null; });
            }
            const catalog = unwrap(await S.modelCatalogInFlight, 'session.modelCatalog');
            const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
            const entry = (group?.models ?? []).find((m) => m?.id === model);
            const efforts = entry?.reasoning?.efforts ?? [];
            const advertised = efforts.map((e) => String(e?.id ?? '')).filter((id) => REASONING_EFFORT_OPTIONS.includes(id));
            if (advertised.length) {
              options = advertised;
              labels = Object.fromEntries(efforts.map((e) => [String(e.id), { name: e.name ?? '', description: e.description ?? '' }]));
              providerDefault = entry.reasoning.defaultEffort ?? null;
              catalogSource = 'dsh';
            }
          } catch (error) {
            // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
            const reason = String(error?.message ?? error);
            if (!modelCatalogErrorLogged.has(reason)) {
              modelCatalogErrorLogged.add(reason);
              log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
            }
          }
          sendJson({
            provider,
            model,
            reasoningEffort: String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT),
            options,
            labels,
            default: REASONING_EFFORT_DEFAULT,
            providerDefault,
            catalogSource,
            // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
            // 控制台要把这点明确告诉管理员，避免「只想调 QQ 助手却改了 Web GUI 新会话默认」的意外。
            globalSideEffect: true,
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/dsh/effort') {
          const body = await readBody();
          let effort;
          try { effort = normalizeReasoningEffort(body.reasoningEffort); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return; }
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
          const file = readConfigObject(configFile);
          file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
          atomicWriteJson(configFile, file);
          cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
          // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
          S.modelSelectionEpoch += 1;
          log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
          sendJson({ ok: true, reasoningEffort: effort });
          return;
        }

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/security') {
          sendJson({
            security: cfg.security ?? { interceptNotify: true },
            // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
            // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
            // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
            // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
            stateDir: {
              hardened: S.stateDirHardened,
              path: STATE_DIR,
              manualCommand: process.platform === 'win32'
                ? manualDirCommand(STATE_DIR)
                : `chmod 700 "${STATE_DIR}"`
            }
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/security') {
          const body = await readBody();
          // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
          if (body.rehardenStateDir === true) {
            S.stateDirHardened = null;
            hardenStateDirAcl();
            sendJson({ ok: S.stateDirHardened === true, hardened: S.stateDirHardened, path: STATE_DIR });
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const next = { ...(file.security ?? {}), ...body };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          atomicWriteJson(configFile, file);
          cfg.security = { ...(cfg.security ?? {}), ...next };
          log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
          sendJson({ ok: true, security: cfg.security });
          return;
        }
        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/token') {
          const body = await readBody();
          let newToken = String(body.token ?? '').trim();
          const generated = !newToken;
          if (generated) {
            newToken = crypto.randomBytes(24).toString('hex');
          }
          if (newToken.length < 16) {
            sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
            return;
          }
          if (newToken.length > 128) {
            sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
            return;
          }
          if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
            sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
          file.consoleToken = generated ? '' : newToken;
          atomicWriteJson(configFile, file);
          cfg.consoleToken = generated ? '' : newToken;
          atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
          consoleToken = newToken;
          log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
          sendJson({ ok: true, token: newToken, generated });
          return;
        }
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/test-send') {
          const body = await readBody();
          const kind = body.kind === 'private' ? 'private' : 'group';
          const id = Number(body.id);
          const message = String(body.message ?? '').trim();
          if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
          if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
          if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, S.currentMode)) { sendJson({ ok: false, error: `当前模式（${S.currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
          try {
            const safeMessage = escapeCqText(redactKnownTokensOnly(message));
            const result = kind === 'private'
              ? await bot.sendPrivateMessage(id, text(safeMessage))
              : await bot.sendGroupMessage(id, text(safeMessage));
            log(`控制台：测试发送 ${kind}:${id} 成功`);
            sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
          } catch (error) {
            sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/state') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const phase = body.phase;
          if (phase === 'active') {
            // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
            enterActive(key);
            log(`控制台：手动将 ${key} 设为活跃`);
            sendJson({ ok: true, key, phase: 'active' });
          } else if (phase === 'idle') {
            leaveActive(key);
            log(`控制台：手动将 ${key} 设为观望`);
            sendJson({ ok: true, key, phase: 'idle' });
          } else {
            sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
          }
          return;
        }
        // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/social') {
          const stats = {};
          for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
          const states = {};
          const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
          for (const k of keys) {
            const st = social.states.get(k);
            states[k] = { phase: st?.phase ?? 'idle' };
          }
          sendJson({ config: cfg.social, pendingSummaries: stats, states });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
          const file = readConfigObject(configFile);
          const merged = { ...(file.social ?? {}), ...body };
          // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
          for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
            delete merged[k];
          }
          for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) {
              const n = Number(merged[k]);
              if (Number.isFinite(n) && n >= 0) merged[k] = n;
            }
          }
          // 分条间隔 clamp 到非负
          for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
          }
          // 概率字段 clamp 到 0~1
          for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
            if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
          }
          // contextWindow 限制 1~100
          if (merged.contextWindow !== undefined) {
            merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
          }
          // 布尔字段
          for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
            if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
          }
          // 范围字段保证 min <= max
          for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
            if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
              [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
            }
          }
          if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
          file.social = merged;
          atomicWriteJson(configFile, file);
          cfg.social = { ...cfg.social, ...merged };
          log('控制台：社交配置已更新');
          sendJson({ ok: true, config: cfg.social });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/flush') {
          const body = await readBody();
          await flushSummaries(body.key || null);
          sendJson({ ok: true });
          return;
        }
        // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const message = String(body.message ?? '').trim();
          if (!key || !message) {
            sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0) {
            sendJson({ ok: false, error: 'id 无效' }, 400);
            return;
          }
          if (!modeAllowed(key, kind, id, cfg, S.currentMode)) {
            sendJson({ ok: false, error: `该会话不在当前模式（${S.currentMode}）允许范围内` }, 403);
            return;
          }
          if (!S.state.sessions[key] && !allowed(kind, id, cfg)) {
            sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
            return;
          }
          if (!S.dshReady) {
            sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
            return;
          }
          const isV2 = S.currentMode === 'reserved2';
          const roleState = readRoleState();
          const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
          // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
          let tokenLine = '';
          if (isV2) {
            const stV2 = getSocialV2State(key);
            tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
          }
          const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message）。如果不需要发言，直接 qq_set_wake_config 收尾即可。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
          let sessionId = null;
          let popSilent = null;
          try {
            sessionId = await ensureSession(key);
            const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            const arr = social.silentTurns.get(sessionId) ?? [];
            social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
            popSilent = () => {
              const list = social.silentTurns.get(sessionId) ?? [];
              const next = list.filter((x) => x.id !== silentId);
              if (next.length > 0) social.silentTurns.set(sessionId, next);
              else social.silentTurns.delete(sessionId);
            };
            const result = await deliverPrompt(key, promptText, { silent: true });
            if (result.ok) {
              log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
              appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
              sendJson({ ok: true, key, sessionId });
            } else {
              popSilent();
              sendJson({ ok: false, error: result.error || '投递失败' }, 500);
            }
          } catch (error) {
            if (popSilent) popSilent();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
        // ── 配置文件投递（新后台「配置文件」模块）────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/cfgmods/inspect') {
          const body = await readBody();
          const files = Array.isArray(body?.files) ? body.files.slice(0, 10) : [];
          const results = files.map((f) => {
            const name = String(f?.name || 'file');
            const content = String(f?.content ?? '');
            const id = cfgmodIdentify(name, content);
            const r = { name, ...id, chars: content.length };
            if (id.ok && id.target === 'config-merge') {
              let patch;
              try { patch = JSON.parse(content.trim()); } catch (e) { r.ok = false; r.error = 'JSON 解析失败：' + e.message; return r; }
              const cur = readConfigObject(path.join(ROOT, 'config.json'));
              const base = id.scope === 'socialV2' ? (cur.socialV2 ?? {}) : cur;
              r.effect = '深合并进 config.json' + (id.scope === 'socialV2' ? ' 的 socialV2 段' : '') + '；已尽力热更内存，重启桥接后完整生效';
              r.changes = cfgmodDiff(base, patch).map((s) => s.startsWith('…') ? s : (id.scope === 'socialV2' ? 'socialV2.' + s : s));
              if (!r.changes.length) r.changes = ['（与当前配置无差异）'];
            } else if (id.ok && id.target === 'role-md') {
              const lf = content.replace(/\r\n/g, '\n');
              const sections = (lf.match(/^##\s/gm) || []).length;
              r.sections = sections;
              r.charsAfter = lf.length;
              r.effect = '替换 roles 人设文件（CRLF 自动规范化为 LF），热生效';
              if (/\r\n/.test(content)) r.note = '已自动把 CRLF 规范化为 LF（人设解析依赖 LF）';
              if (sections < 1) { r.ok = false; r.error = '人设至少需要 1 个 "## " 小节（parseRoleSections 依赖），当前 0 个'; }
              else if (lf.length > 30000) { r.ok = false; r.error = '超过 role.maxInjectChars=30000 注入上限（当前 ' + lf.length + ' 字符）'; }
            } else if (id.ok && id.target === 'keywords-list') {
              const lines = content.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
              const cur = (cfg.socialV2?.wake?.recommendedKeywords) || [];
              r.effect = '合并进 socialV2.wake.recommendedKeywords（去重，上限 40）';
              const fresh = lines.filter((l) => !cur.includes(l));
              r.changes = fresh.length ? ['将新增 ' + fresh.length + ' 个关键词：' + fresh.join('、')] : ['（关键词均已存在，无变化）'];
            }
            return r;
          });
          sendJson({ ok: results.every((r) => r.ok), results });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/cfgmods/apply') {
          const body = await readBody();
          const files = Array.isArray(body?.files) ? body.files.slice(0, 10) : [];
          const confirmRole = body?.confirmRole === true;
          const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + String(Date.now()).slice(-4);
          const configFile = path.join(ROOT, 'config.json');
          const results = [];
          for (const f of files) {
            const name = String(f?.name || 'file');
            const content = String(f?.content ?? '');
            const id = cfgmodIdentify(name, content);
            const r = { name, target: id.target, ok: false };
            try {
              if (!id.ok) { r.error = id.error; results.push(r); continue; }
              if (id.target === 'config-merge') {
                const file = readConfigObject(configFile); // fail-fast：配置损坏绝不回写
                const patch = JSON.parse(content.trim());
                const backup = configFile + '.bak-cfgmod-' + stamp;
                fs.writeFileSync(backup, JSON.stringify(file, null, 2) + '\n', 'utf8');
                const merged = cfgmodDeepMerge(file, patch);
                atomicWriteJson(configFile, merged);
                const livePatch = id.scope === 'socialV2' ? { socialV2: cfgmodDeepMerge(cfg.socialV2 ?? {}, patch) } : patch;
                cfgmodDeepMergeInto(cfg, livePatch);
                r.ok = true; r.backup = backup; r.targetPath = configFile;
                r.changes = cfgmodDiff(file, merged);
                if (!r.changes.length) r.changes = ['（与当前配置无差异，仅刷新落盘）'];
                r.effect = '已写入 config.json 并尽力热更内存；启动时读一次的字段需重启桥接';
                r.needsRestart = true;
              } else if (id.target === 'keywords-list') {
                const file = readConfigObject(configFile);
                const cur = file.socialV2?.wake?.recommendedKeywords;
                if (!Array.isArray(cur)) throw new Error('config.json 缺少 socialV2.wake.recommendedKeywords 数组，无法合并');
                const lines = content.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
                const merged = [...cur];
                for (const l of lines) if (!merged.includes(l) && merged.length < 40) merged.push(l);
                const backup = configFile + '.bak-cfgmod-' + stamp;
                fs.writeFileSync(backup, JSON.stringify(file, null, 2) + '\n', 'utf8');
                file.socialV2.wake.recommendedKeywords = merged;
                atomicWriteJson(configFile, file);
                if (cfg.socialV2?.wake) cfg.socialV2.wake.recommendedKeywords = merged;
                r.ok = true; r.backup = backup; r.targetPath = configFile;
                const fresh = lines.filter((l) => !cur.includes(l));
                r.changes = fresh.length ? ['新增 ' + fresh.length + ' 个关键词：' + fresh.join('、')] : ['（关键词均已存在）'];
                r.effect = '已合并进 socialV2.wake.recommendedKeywords；重启桥接后完整生效';
                r.needsRestart = true;
              } else if (id.target === 'role-md') {
                if (!confirmRole) throw new Error('替换人设需要显式确认（勾选「我确认替换人设文件」）');
                const rolesDir = path.join(ROOT, 'roles');
                let rf = null;
                const want = String(f?.roleFile || '').trim();
                if (want) {
                  const cand = path.join(rolesDir, path.basename(want));
                  if (!cand.startsWith(rolesDir + path.sep) || !/\.md$/i.test(cand)) throw new Error('roleFile 非法：' + want);
                  if (!fs.existsSync(cand)) throw new Error('roles/ 下不存在 ' + path.basename(want));
                  rf = cand;
                } else {
                  let mds = [];
                  try { mds = fs.readdirSync(rolesDir).filter((x) => /^[^.].*\.md$/i.test(x)); } catch { }
                  if (mds.length === 1) rf = path.join(rolesDir, mds[0]);
                  else rf = mds.length ? path.join(rolesDir, mds.find((x) => x.includes('蓝色大肥鱼')) || '') : null;
                }
                if (!rf || !fs.existsSync(rf)) throw new Error('无法定位人设文件（roles/ 下有多个 .md 时请在文件项指定 roleFile）');
                const lf = content.replace(/\r\n/g, '\n');
                if ((lf.match(/^##\s/gm) || []).length < 1) throw new Error('人设至少需要 1 个 "## " 小节');
                if (lf.length > 30000) throw new Error('超过 role.maxInjectChars=30000 注入上限');
                const backup = rf + '.bak-cfgmod-' + stamp;
                fs.writeFileSync(backup, fs.readFileSync(rf, 'utf8'), 'utf8');
                fs.writeFileSync(rf, lf, 'utf8');
                r.ok = true; r.backup = backup; r.targetPath = rf;
                r.changes = ['人设 ' + path.basename(rf) + ' 已替换（' + lf.length + ' 字符，LF 规范化）'];
                r.effect = '人设已替换，热生效（下一回合起使用新人设）';
                r.needsRestart = false;
              } else {
                r.error = id.error || '未支持的目标';
              }
            } catch (error) {
              r.error = error?.message ?? String(error);
            }
            results.push(r);
          }
          const okAll = results.every((r) => r.ok);
          let historyId = null;
          if (results.some((r) => r.ok)) {
            historyId = 'cfgmod-' + Date.now();
            const h = cfgmodReadHistory(path.join(ROOT, 'state', 'cfgmods-history.json'));
            h.push({ id: historyId, time: new Date().toISOString(), files: results.map((r) => ({ name: r.name, target: r.target, targetPath: r.targetPath || null, backup: r.backup || null, ok: r.ok })) });
            cfgmodWriteHistory(path.join(ROOT, 'state', 'cfgmods-history.json'), h);
          }
          log(`控制台：配置文件投递 ${results.filter((r) => r.ok).length}/${results.length} 成功（${results.map((r) => r.name + '→' + r.target).join('; ')}）`);
          sendJson({ ok: okAll, results, historyId, needsRestart: results.some((r) => r.ok && r.needsRestart) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/costs') {
          // [成本面板 2026-10-19] 按 (sid) ≈ 对话回合聚合（freshSessionPerTurn 下每回合新会话），
          // 逐条按 model+时间用 model-prices 价目表计价；days 参数控制窗口（默认 14，上限 60）。
          const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days')) || 14));
          try {
            const file = path.join(ROOT, 'state', 'token-usage.jsonl');
            const raw = fs.readFileSync(file, 'utf8');
            const table = resolvePriceTable(cfg?.pricing);
            const dayCut = new Date(); dayCut.setHours(0, 0, 0, 0);
            const startMs = dayCut.getTime() - (days - 1) * 86400000;
            const byDay = new Map(); const byKey = new Map();
            const roundDay = new Map();
            const roundKey = new Map(); // sid -> key：回合归属唯一会话，per-key 回合计数用
            const total = { cost: 0, rounds: 0, miss: 0, hit: 0, out: 0 };
            for (const line of raw.split('\n')) {
              if (!line) continue;
              let j; try { j = JSON.parse(line); } catch { continue; }
              const t = Number(j.t || 0);
              if (!t || t < startMs) continue;
              const b = j.b || {};
              const buckets = { cacheMiss: b.cacheMiss || 0, cacheHit: b.cacheHit || 0, cacheWrite: b.cacheWrite || 0, output: b.output || 0, reasoning: b.reasoning || 0 };
              const priced = priceUsage(buckets, { model: j.model, at: t, table });
              // priceUsage 返回 { rates, cost: {cacheHit.., total} } —— 取 cost.total（数值，单位元）
              const cost = Number(priced?.cost?.total) || 0;
              const dt = new Date(t);
              const dayStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
              let d = byDay.get(dayStr);
              if (!d) { d = { day: dayStr, rounds: 0, cost: 0, miss: 0, hit: 0, out: 0 }; byDay.set(dayStr, d); }
              d.cost += cost; d.miss += buckets.cacheMiss; d.hit += buckets.cacheHit; d.out += buckets.output + buckets.reasoning;
              if (j.sid && !roundDay.has(j.sid)) { roundDay.set(j.sid, dayStr); d.rounds += 1; }
              const kKey = j.key || '(未知)';
              let k = byKey.get(kKey);
              if (!k) { k = { key: kKey, rounds: 0, cost: 0, miss: 0 }; byKey.set(kKey, k); }
              k.cost += cost; k.miss += buckets.cacheMiss;
              if (j.sid && !roundKey.has(j.sid)) {
                roundKey.set(j.sid, kKey);
                k.rounds += 1;
              }
              total.cost += cost; total.miss += buckets.cacheMiss; total.hit += buckets.cacheHit; total.out += buckets.output + buckets.reasoning;
            }
            const daysArr = [...byDay.values()].map((d) => ({ ...d, cost: Math.round(d.cost * 100) / 100 })).sort((a, b) => (a.day < b.day ? -1 : 1));
            const keysArr = [...byKey.values()].map((k) => ({ ...k, cost: Math.round(k.cost * 100) / 100 })).sort((a, b) => b.cost - a.cost).slice(0, 12);
            total.rounds = roundDay.size;
            total.cost = Math.round(total.cost * 100) / 100;
            sendJson({ ok: true, days: daysArr, keys: keysArr, total, generatedAt: new Date().toISOString() });
          } catch (error) {
            sendJson({ ok: false, error: error?.message || String(error) });
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/bili/status') {
          // [养鱼面板 2026-10-19] B 站肥鱼号状态：账号是否已接入 + 今日额度用量 + 上次巡园日。
          // 只读本地文件（不碰网络、不查 B 站），控制台随时能刷。
          const CAPS = { comments: 5, likes: 20, coins: 2 };
          const today = new Date().toISOString().slice(0, 10);
          let account = false;
          try {
            const a = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'bili-account.json'), 'utf8'));
            account = !!(a?.SESSDATA && a?.bili_jct && a?.DedeUserID);
          } catch { /* 还没导入 cookie */ }
          const quota = { day: today, comments: 0, likes: 0, coins: 0 };
          try {
            const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'bili-quota.json'), 'utf8'));
            if (j?.day === today) {
              quota.comments = Array.isArray(j.comments) ? j.comments.length : 0;
              quota.likes = Array.isArray(j.likes) ? j.likes.length : 0;
              quota.coins = Array.isArray(j.coins) ? j.coins.length : 0;
            }
          } catch { /* 今天还没动过 */ }
          let lastStroll = '还没巡过园';
          try {
            const sv = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
            lastStroll = String(sv?.conversations?.[`private:${cfg?.ownerQQ ?? ''}`]?.lastBiliStrollDay || '') || lastStroll;
          } catch { /* */ }
          sendJson({ ok: true, account, quota: { ...quota, caps: CAPS }, lastStroll });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/cfgmods/history') {
          const h = cfgmodReadHistory(path.join(ROOT, 'state', 'cfgmods-history.json'));
          sendJson({ ok: true, history: h.slice(-40).reverse() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/cfgmods/rollback') {
          const body = await readBody();
          const id = String(body?.id || '');
          const histFile = path.join(ROOT, 'state', 'cfgmods-history.json');
          const h = cfgmodReadHistory(histFile);
          const entry = h.find((e) => e.id === id);
          if (!entry) { sendJson({ ok: false, error: '没有这条历史记录：' + id }, 404); return; }
          const results = [];
          for (const f of entry.files) {
            if (!f.ok || !f.backup || !f.targetPath) { results.push({ name: f.name, ok: false, error: '该条没有可回滚的备份' }); continue; }
            try {
              const bak = fs.readFileSync(f.backup, 'utf8');
              if (f.target === 'role-md') fs.writeFileSync(f.targetPath, bak.replace(/\r\n/g, '\n'), 'utf8');
              else atomicWriteJson(f.targetPath, JSON.parse(bak));
              results.push({ name: f.name, ok: true, targetPath: f.targetPath });
            } catch (error) {
              results.push({ name: f.name, ok: false, error: error?.message ?? String(error) });
            }
          }
          h.push({ id: 'rollback-' + Date.now(), time: new Date().toISOString(), rollbackOf: id, files: results.map((r) => ({ name: r.name, target: 'rollback', targetPath: null, backup: null, ok: r.ok })) });
          cfgmodWriteHistory(histFile, h);
          log(`控制台：配置文件回滚 ${id}（${results.filter((r) => r.ok).length}/${results.length} 成功）`);
          sendJson({ ok: results.every((r) => r.ok), results, needsRestart: true });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
          sendJson({ ok: true, config: cfg.socialV2 ?? {} });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // current 必须是「当前**生效**的 socialV2」，而不是文件里恰好写着的那一份。
          //
          // config.json 里没有 socialV2 段（或该段不是普通对象）时，旧写法 current={} 会让下面所有
          // `current.xxx ?? 默认` 的兜底全部落空，并把只剩本次提交字段的段落盘。最危险的一处是工具开关
          // 归一化：`typeof merged.tools[k] !== 'boolean'` 时写的是 `current.tools?.[k] !== false` ——
          // current 为空 → undefined !== false → true，于是**一次控制台保存就把默认关闭的
          // setStickerRemark / sendVoice 静默打开**（它们默认 false 是有意的：一个是风险操作，
          // 一个是需要先准备语音库的强表达）。cfg.socialV2 是「文件 + 默认值」深度合并后的运行时配置，
          // 用它兜底才和真正生效的设置一致（也就不会再出现"文件里没有 → 保存一次就变了"）。
          const fileV2 = (file.socialV2 && typeof file.socialV2 === 'object' && !Array.isArray(file.socialV2))
            ? file.socialV2
            : null;
          const current = fileV2 ?? ((cfg.socialV2 && typeof cfg.socialV2 === 'object') ? cfg.socialV2 : {});
          const merged = { ...current, ...body };
          // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
          for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context']) {
            if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
              merged[sub] = current[sub] ?? {};
            }
          }
          if (merged.autoReplyCheckMs !== undefined) {
            const n = Number(merged.autoReplyCheckMs);
            merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
          }
          // tools：只接受布尔开关
          const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'setWakeConfig', 'markRead', 'memory', 'slangQuery', 'slangSubmit', 'getImages', 'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'getSelfImage', 'sendVoice'];
          if (body.tools && typeof body.tools === 'object') {
            merged.tools = { ...(current.tools ?? {}), ...body.tools };
            for (const k of toolFlags) {
              if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
            }
          }
          // wake：数值与字符串数组归一化
          if (body.wake && typeof body.wake === 'object') {
            merged.wake = { ...(current.wake ?? {}), ...body.wake };
            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'maxWakePerHourPrivate', 'maxWakePerHourAtMention', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
              if (merged.wake[k] !== undefined) {
                const n = Number(merged.wake[k]);
                merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
                // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
              }
            }
            if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
            if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
            if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
            if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
            if (merged.wake.recommendedKeywords !== undefined) {
              merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
            }
            if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
            if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
          }
          // send：数值归一化
          if (body.send && typeof body.send === 'object') {
            merged.send = { ...(current.send ?? {}), ...body.send };
            for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs', 'maxMessagesPerTurn', 'maxMessagesPerTurnGroup']) {
              if (merged.send[k] !== undefined) {
                const n = Number(merged.send[k]);
                merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
              }
            }
            if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
            if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
            if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
          }
          // wait：数值归一化
          if (body.wait && typeof body.wait === 'object') {
            merged.wait = { ...(current.wait ?? {}), ...body.wait };
            for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
              if (merged.wait[k] !== undefined) {
                const n = Number(merged.wait[k]);
                merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
              }
            }
          }
          // proactive：主动机会参数
          if (body.proactive && typeof body.proactive === 'object') {
            merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
            for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability', 'ownerProactiveMinIntervalMs']) {
              if (merged.proactive[k] !== undefined) {
                const n = Number(merged.proactive[k]);
                merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
                // 毫秒类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
              }
            }
            if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
            if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
          }
          // sticker：表情包体系参数归一化
          if (body.sticker && typeof body.sticker === 'object') {
            merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
            if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
            for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
              if (merged.sticker[k] !== undefined) {
                const n = Number(merged.sticker[k]);
                merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
              }
            }
            if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
            if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
            if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
            if (body.sticker.collect && typeof body.sticker.collect === 'object') {
              merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
              if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
              for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
                if (merged.sticker.collect[k] !== undefined) {
                  const n = Number(merged.sticker.collect[k]);
                  merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
                }
              }
            }
          }
          // feedback：数值/布尔归一化
          if (body.feedback && typeof body.feedback === 'object') {
            merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
            if (merged.feedback.maxLength !== undefined) {
              const n = Number(merged.feedback.maxLength);
              merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
            }
            if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
          }
          // context：数值归一化
          if (body.context && typeof body.context === 'object') {
            merged.context = { ...(current.context ?? {}), ...body.context };
            for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
              if (merged.context[k] !== undefined) {
                const n = Number(merged.context[k]);
                merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
              }
            }
            for (const [name, fallback, min, max] of [['wakeMessageLimit', 12, 1, 100], ['wakeRecentLimit', 4, 0, 20], ['wakeMaxChars', 6000, 500, 20000]]) {
              const n = Number(merged.context[name] ?? fallback);
              merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
            }
            if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
          }
          if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
          if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
          file.socialV2 = merged;
          atomicWriteJson(configFile, file);
          cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
          // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
          // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
          const WAKE_DEFAULT_KEYS = [
            'defaultMode', 'recommendedDefaultInfinite',
            'recommendedSleepMinMs', 'recommendedSleepMaxMs',
            'recommendedProbability', 'recommendedKeywords',
            'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
            'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
          ];
          const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
            WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
          if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
          log('控制台：二代仿真配置已更新');
          sendJson({ ok: true, config: cfg.socialV2 });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
          const body = await readBody();
          const paused = body.paused === true;
          socialV2.paused = paused;
          if (paused) {
            clearAllSocialV2Timers();
            log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
          } else {
            log('控制台：二代 AI 已恢复');
            for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          }
          saveSocialV2State();
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
          // [patch 按会话重置] 这个端点原来**没有 key 处理**：控制台的「重置这个会话」按钮
          // 带 key 调过来，会把全部会话、全部 agentToken 一起清空——正在跑的会话立刻
          // 全部变成「agent token 无效」，连上下文一起没了（2026-10-18 实锤）。
          // 现在带 key = 只重置这一个会话；不带 key 才是原来的全局重置。
          const resetBody = await readBody().catch(() => ({}));
          const onlyKey = String(resetBody?.key ?? '').trim();
          if (onlyKey) {
            if (!canonicalV2Key(onlyKey)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
            S.sessionEpoch++;
            const sidOnly = S.state.sessions[onlyKey];
            if (sidOnly) {
              delete S.state.sessions[onlyKey];
              stopRetiredSessionWork(sidOnly, onlyKey);
              sessionModels.delete(sidOnly);
              modelAppliedSessions.delete(sidOnly);
              reverse.delete(sidOnly);
              collectors.delete(sidOnly);
              v2TurnStartAt.delete(sidOnly);
              toolCallNames.delete(sidOnly);
              pendingSendToolCalls.delete(sidOnly);
              sendToolSucceededSessions.delete(sidOnly);
              api.events.forget?.(sidOnly);
            }
            delete S.state.sessionPolicies[onlyKey];
            forgetAgentToken(onlyKey);
            socialV2.conversations.delete(onlyKey);
            seenForwardIds.delete(onlyKey);
            clearSocialV2Timers(onlyKey);
            cancelSocialTimers(onlyKey);
            forgetConversationCaches(onlyKey);
            saveState();
            saveSocialV2State();
            log(`控制台：已重置会话 ${onlyKey}（只清这一个，其余不动）`);
            sendJson({ ok: true, key: onlyKey });
            return;
          }
          S.sessionEpoch++;
          sessionPromises.clear();
          clearAllSocialV2Timers();
          drainAllPromptQueues('二代状态已重置');
          for (const key of [...socialV2.conversations.keys()]) {
            const sid = S.state.sessions[key];
            if (sid) {
              delete S.state.sessions[key];
              // 与 retireSession / session-reset / workspace-reset 一致：先让 DSH 停下这个会话的活。
              // 少了这一步，DSH 会继续跑完在途/排队的 turn（token 照烧、副作用照做），
              // 而桥接这边已经把所有映射删掉 —— 输出被静默丢弃，agentToken 也已轮换（它的 MCP 发送全部 403）。
              stopRetiredSessionWork(sid, key);
              sessionModels.delete(sid);
              modelAppliedSessions.delete(sid);
              reverse.delete(sid);
              collectors.delete(sid);
              v2TurnStartAt.delete(sid);
              toolCallNames.delete(sid);
              pendingSendToolCalls.delete(sid);
              sendToolSucceededSessions.delete(sid);
              // 订阅也要退掉，否则它会在每次重连时被重新 follow 并重发整份快照。
              api.events.forget?.(sid);
            }
            delete S.state.sessionPolicies[key];
            forgetAgentToken(key);
            socialV2.conversations.delete(key);
            seenForwardIds.delete(key);
          }
          saveState();
          pendingWakeKeys.clear();
          clearAllPendingWakeLeases();
          wakeConfigUpdatedKeys.clear();
          markReadCalledKeys.clear();
          wakeConfigMissCount.clear();
          socialV2.paused = false;
          try { atomicWriteJson(SOCIAL_V2_FILE, { conversations: {} }); } catch (error) { log('重置二代状态：写空状态文件失败:', error?.message ?? error); }
          log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return; }
          const st = getSocialV2State(key);
          sendJson({
            ok: true,
            key,
            wakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return; }
          const st = getSocialV2State(key);
          // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
          if (cfg.socialV2?.sticker?.enabled !== false) {
            try { await syncStickerLibrary(false); } catch {}
          }
          const roleState = readRoleState();
          const toolMap = {
            getPrompt: 'qq_get_prompt',
            getUnread: 'qq_get_unread_messages',
            getRecent: 'qq_get_recent_messages',
            socialState: 'qq_social_state',
            sendGroup: 'qq_send_group_message',
            sendPrivate: 'qq_send_private_message',
            reply: 'qq_reply',
            sendBurst: 'qq_send_burst',
            sendMessage: 'qq_send_message',
            waitMessages: 'qq_wait_for_messages',
            feedback: 'qq_report_feedback',
            lightGame: 'qq_light_game',
            turnGame: 'qq_turn_game',
            musicShare: 'qq_music_share',
            groupTools: 'qq_group_tools',
            moodLog: 'qq_mood_log',
            getMyRecent: 'qq_get_my_recent_messages',
            getMessageDetail: 'qq_get_message_detail',
            getActiveMembers: 'qq_get_active_members',
            setWakeConfig: 'qq_set_wake_config',
            markRead: 'qq_mark_read',
            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
            diary: 'qq_diary',
            slangQuery: 'qq_slang_query',
            slangSubmit: 'qq_slang_submit',
            getImages: 'qq_get_message_images',
            getForwardMsg: 'qq_get_forward_msg',
            sendPoke: 'qq_send_poke',
            listStickers: 'qq_list_stickers',
            getStickerImage: 'qq_get_sticker_image',
            sendSticker: 'qq_send_sticker',
            setStickerRemark: 'qq_set_sticker_remark',
            stickerNote: 'qq_sticker_note',
            collectSticker: 'qq_collect_sticker',
            getSelfImage: 'qq_get_self_image',
            sendVoice: 'qq_send_voice / qq_list_voices',
            webSearch: 'mcp__web-search-safe__web_search（联网搜索）/ mcp__web-search-safe__web_fetch（抓正文）'
          };
          const tools = cfg.socialV2?.tools ?? {};
          const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
          const enabledTools = [];
          for (const [flag, name] of Object.entries(toolMap)) {
            if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
          }
          sendJson({
            ok: true,
            key,
            time: new Date().toISOString(),
            role: { name: roleState.role ?? null, hint: S.currentMode === 'reserved2' ? currentRoleHintV2() : currentRoleHint() },
            recommended: cfg.socialV2?.provideRecommendations === false ? null : {
              wake: cfg.socialV2?.wake ?? {},
              send: cfg.socialV2?.send ?? {},
              wait: cfg.socialV2?.wait ?? {},
              proactive: cfg.socialV2?.proactive ?? {}
            },
            enabledTools,
            replyTiming: replyTimingV2(st),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            currentWakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            memory: formatMemoryV2(st),
            // [关系/情绪] 她主动问起时（qq_get_prompt）能直接看到自己的好感刻度与此刻心情。
            relations: relationLineV2(key, 12).trim(),
            mood: (() => {
              try {
                const ms = tickMood();
                return { mood: ms.mood, label: MOOD_LABELS[ms.mood] || ms.mood, energy: Math.round(Number(ms.energy) || 0), note: ms.note || '', holdUntil: Number(ms.holdUntil) || 0 };
              } catch { return null; }
            })(),
            participation: formatParticipationV2(st),
            slang: {
              enabled: cfg.slang?.enabled !== false,
              entries: confirmedSlangListV2(),
              block: buildSlangContext(S.slangEntries, slangInjectMax, slangInjectChars)
            },
            stickers: {
              enabled: cfg.socialV2?.sticker?.enabled !== false,
              total: S.stickerEntries.length,
              context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(S.stickerEntries, cfg.socialV2?.sticker?.promptMaxStickers ?? 8) : '',
              strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint(key.startsWith('group:') ? { group: true } : {}) : ''
            },
            // 语音库摘要：让 AI 一开始就知道有哪些语音可发（真发之前用 qq_list_voices 看详情）。
            voices: cfg.socialV2?.voice?.enabled === false ? { enabled: false } : {
              enabled: true,
              total: voiceLibrary().length,
              names: voiceLibrary().slice(0, 12).map((v) => v.name),
              maxSeconds: voiceCfg().maxSeconds,
              hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去'
            }
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return; }
          const afterRaw = url.searchParams.get('afterSeq');
          const afterSeq = afterRaw === null ? null : Number(afterRaw);
          if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
            sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          // Preserve the old tail read by default; cursor paging lets a backlog
          // larger than one response be read completely, even outside recent.
          const messages = afterSeq === null ? st.unread.slice(-limit)
            : st.unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          sendJson({ ok: true, key, unreadCount: st.unread.length, messages, readThroughSeq });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const start = Math.max(0, st.recentMessages.length - offset - limit);
          const end = Math.max(0, st.recentMessages.length - offset);
          const messages = st.recentMessages.slice(start, end);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          sendJson({ ok: true, key, messages, readThroughSeq });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return; }
          const st = getSocialV2State(key);
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
          // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
          if (isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = acknowledgeMessagesV2(st, throughSeq);
          st.lastActionAt = Date.now();
          st.wakeConfig.noActionCount = 0;
          // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
          if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
            st.wakeConfig.infinite = true;
          }
          ensureWakeableV2(st, { key });
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'mark_read';
          markReadCalledKeys.add(key);
          noteSleepGraceV2(st);
          saveSocialV2State();
          log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
          const st = getSocialV2State(key);
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // Preserve the deployed behavior: with markRead disabled, update wake configuration only.
          const acknowledgeOnClose = throughSeq !== null && v2ToolEnabled('markRead');
          const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              ...current.triggers,
              ...inputTriggers,
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
              return;
            }
          }
          // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
          if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = acknowledgeOnClose ? acknowledgeMessagesV2(st, throughSeq) : 0;
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          st.lastActionAt = Date.now();
          noteSleepGraceV2(st);
          // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialV2State();
          wakeConfigUpdatedKeys.add(key);
          wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
          setupSleepTimerV2(key);
          log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
          const list = [];
          for (const [key, st] of socialV2.conversations) {
            list.push({
              key,
              wakeConfig: st.wakeConfig,
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              lastWakeReason: st.lastWakeReason,
              lastAiReplyAt: st.lastAiReplyAt,
              noActionCount: st.wakeConfig.noActionCount || 0
            });
          }
          sendJson({ ok: true, conversations: list });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const reason = String(body.reason ?? 'admin').trim() || 'admin';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (S.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, S.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const st = getSocialV2State(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          if (!st.bootstrapSent) st.bootstrapSent = true;
          saveSocialV2State();
          // 和其它唤醒入口保持一致：sendWakePromptV2 是异步的，这里不 await（不能让 HTTP 回复
          // 等一个可能卡几十秒的模型回合），但必须挂 catch。裸调用一旦 reject 就是
          // unhandledRejection：Node 会打警告甚至按配置退出进程，而 HTTP 那边已经回了 {ok:true}，
          // 表面上"唤醒成功"，实际上谁也不知道它失败了。
          void sendWakePromptV2(key, reason).catch((error) => log(`[reserved2] 手动唤醒异常 ${key}:`, error?.message ?? error));
          log(`控制台：手动唤醒 ${key}（${reason}）`);
          // [patch 静默可见] 唤醒接口如实告知角色是否静默：静默时群里唤醒会被直接忽略，
          // 控制台不能只回一个 ok，否则用户以为叫起来了、实际没人接话。
          const roleModeNow = readRoleState().mode ?? 'active';
          sendJson({
            ok: true,
            key,
            reason,
            roleMode: roleModeNow,
            // 静默时这个唤醒会被 sendWakePromptV2 顶部的闸门挡掉（不开回合、不烧 token），
            // 控制台据此提示「已跳过」，而不是假装排了一次队。
            skipped: roleModeNow === 'silent' && kind === 'group',
            note: roleModeNow === 'silent' && kind === 'group' ? '当前角色是静默状态：这次唤醒已跳过，不会消耗 token（只回主人私聊）' : undefined
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
            return;
          }
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return; }
          if (S.currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, S.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          try {
            const st = getSocialV2State(key);
            const now = Date.now();
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            // 先预占发送额度，避免并发绕过限频
            for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await sendMessagesV2(key, messages, delays);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            // 群聊「一轮最多一条」比私聊更严：群里连发最招人烦。阈值来自 socialV2.send.maxMessagesPerTurnGroup（默认 1）。
            const isGroupTurn = String(key).startsWith('group:');
            // 0 = 不限条数（群里放开时用）：既不给条数提示，也不拦。
            const rawMaxPerTurn = isGroupTurn ? (sendCfg.maxMessagesPerTurnGroup ?? 1) : sendCfg.maxMessagesPerTurn;
            const maxPerTurn = Number(rawMaxPerTurn) === 0 ? 0 : Math.max(1, Number(rawMaxPerTurn) || 4);
            const turnSentCount = (Number(st.turnSentCount) || 0) + messages.length;
            st.turnSentCount = turnSentCount;
            const turnHint = maxPerTurn > 0 && turnSentCount > maxPerTurn ? `本轮你已经发了 ${turnSentCount} 条，够了：直接调用 qq_set_wake_config 收尾，不要再等待、不要再补发。` : undefined;
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(turnHint ? { turnHint } : {}), ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const isRawString = typeof rawMessages === 'string';
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // 二代不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
          // 旧写法是 `(isRawString && messages.length > 1) ? 'auto' : ...` —— 上面 messages 的构造
          // 保证 isRawString 为真时 length 恒为 1，这个分支永远不可达，留着只会让人以为
          // "字符串多段时有特殊间隔策略"。
          const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
          if (S.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, S.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) {
            sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = getSocialV2State(key);
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          // 先预占发送额度，避免并发绕过限频
          for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              for (let i = 0; i < messages.length; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              saveSocialV2State();
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          try {
            const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            // 群聊「一轮最多一条」比私聊更严：群里连发最招人烦。阈值来自 socialV2.send.maxMessagesPerTurnGroup（默认 1）。
            const isGroupTurn = String(key).startsWith('group:');
            // 0 = 不限条数（群里放开时用）：既不给条数提示，也不拦。
            const rawMaxPerTurn = isGroupTurn ? (sendCfg.maxMessagesPerTurnGroup ?? 1) : sendCfg.maxMessagesPerTurn;
            const maxPerTurn = Number(rawMaxPerTurn) === 0 ? 0 : Math.max(1, Number(rawMaxPerTurn) || 4);
            const turnSentCount = (Number(st.turnSentCount) || 0) + messages.length;
            st.turnSentCount = turnSentCount;
            const turnHint = maxPerTurn > 0 && turnSentCount > maxPerTurn ? `本轮你已经发了 ${turnSentCount} 条，够了：直接调用 qq_set_wake_config 收尾，不要再等待、不要再补发。` : undefined;
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(turnHint ? { turnHint } : {}), ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (S.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, S.currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
          if (kind === 'group' && !targetUserId) {
            sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
            return;
          }
          if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
            sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
            return;
          }
          // 群聊必须确认目标确实是本群成员（私聊天然只有双方，无需校验）。
          if (kind === 'group') {
            const memberError = await assertGroupMember(id, targetUserId);
            if (memberError) { sendJson({ ok: false, error: memberError }, 403); return; }
          }
          const st = getSocialV2State(key);
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          try {
            if (kind === 'group') {
              await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
            } else {
              // 私聊拍一拍：send_poke 自动路由到当前私聊对象
              await bot.raw('send_poke', { user_id: id });
            }
            st.lastActionAt = now;
            st.lastAiReplyAt = now;
            st.wakeConfig.noActionCount = 0;
            const pokeText = kind === 'group'
              ? `[拍一拍] 我拍了拍 ${targetUserId}`
              : '[拍一拍] 我拍了拍你';
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: pokeText,
              plain: pokeText,
              tail: pokeText,
              kind: 'poke',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
          } catch (error) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 表情包体系（reserved2） ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
          try {
            const entry = await getStickerImageData(stickerId);
            const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
              return;
            }
            const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
            if (String(url.searchParams.get('raw') ?? '') === '1') {
              // raw=1：给后台 <img> 用，直接吐字节（同源），绕开 CSP 对 data:/blob: 的限制。
              res.writeHead(200, { 'content-type': mimeType || 'application/octet-stream', 'cache-control': 'no-store', 'content-length': fetched.buffer.length, ...SECURITY_HEADERS });
              res.end(fetched.buffer);
              return;
            }
            sendJson({
              ok: true,
              key,
              sticker: {
                id: entry.id,
                desc: entry.desc || '',
                localNote: entry.localNote || '',
                tags: entry.tags || [],
                url: entry.url,
                md5: entry.md5
              },
              image: { mimeType, data: fetched.buffer.toString('base64') }
            });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/self-image') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return; }
          const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
          try {
            if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return; }
            const buf = fs.readFileSync(selfPath);
            const mimeType = mimeFromBuffer(buf) || 'image/png';
            sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
          } catch (error) {
            sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return; }
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
          sendJson({ ok: true, key, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
            sendJson({ ok: true, key, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 语音发送（操作者通道：CLI / 控制台，凭 consoleToken） ──────────────
        //
        // 与 /api/send/* 的 agent 通道分开：操作者可能不在任何 QQ 会话里，
        // 所以不套「会话/模式」闸门，但白名单 + 语音限流 + 文件名审计一个都不少。
        if (req.method === 'POST' && (url.pathname === '/api/voice/send' || url.pathname === '/api/send/voice')) {
          const body = await readBody();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const voice = voiceCfg();
          // 注意：这里是**操作者通道**（CLI / 控制台面板 / 图形界面），由控制台令牌鉴权。
          // socialV2.voice.enabled 是「AI 能不能发语音」的总闸，不该连你手动试发一起关掉——
          // 否则"默认不启用"会变成"谁都发不了"，连放音频试一下都做不到。
          // AI 通道的开关在 /api/socialV2/send-voice 里单独判定。
          // /api/send/voice 是 AI 工具入口：带 agent token 时一律按 agent 规则走，
          // 避免 AI 借用操作者通道绕过「只能发自己会话」的限制。
          if (url.pathname === '/api/send/voice' && agentToken) {
            sendJson({
              ok: false,
              error: 'AI 请改用 /api/socialV2/send-voice（带 key + token）'
            }, 403);
            return;
          }
          const key = String(body.target ?? body.key ?? '').trim();
          const parsedTarget = parseTargetKey(key);
          if (!parsedTarget) { sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!modeAllowed(key, parsedTarget.kind, Number(parsedTarget.id), cfg, S.currentMode)) {
            const a = cfg.allow ?? {};
            sendJson({
              ok: false,
              error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`
            }, 403);
            return;
          }
          let resolved;
          try {
            resolved = resolveVoicePathForOperator(body.file ?? body.path ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          // 音量参数先校验（写错了当场告诉你，不要等到发的时候才炸）
          try {
            resolveAudioProcessing({
              volume: body.volume ?? voice.defaultVolume,
              normalize: body.normalize === true,
              loudness: body.loudness ?? voice.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error.message }, 400);
            return;
          }
          const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
          if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
          const preview = {
            key,
            file: resolved.path,
            via: resolved.via,
            bytes: probe.size,
            duration: probe.duration,
            codec: probe.codec,
            detail: describeAudio(probe),
            warnings: probe.warnings ?? [],
            limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour }
          };
          if (body.dryRun === true) { sendJson({ ok: true, dryRun: true, ...preview }); return; }
          const now = Date.now();
          try {
            voiceBudgetCheck('operator:cli', voice);
            const sent = await sendVoiceV2(key, resolved.path, {
              guard: false,
              audit: true,
              audio: {
                volume: body.volume ?? voice.defaultVolume,
                normalize: body.normalize === true,
                loudness: body.loudness ?? voice.loudness
              }
            });
            voiceBudgetCommit('operator:cli', now);
            log(`[voice] (操作者) ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}${sent.audioMode === 'original' ? '' : '，' + sent.audioProcessing}, messageId=${sent.messageId ?? '?'})`);
            appendActivity(`${key} [voice] (操作者) 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
            // CLI 默认要落地校验（--verify 之外也能给出可信证据）；readback 仅在做"收到的语音"实验时用。
            const verification = body.verify === false ? null : await verifyVoiceMessageSent(sent.messageId);
            let readbackText = null;
            if (body.readback === true && sent.messageId) {
              try {
                const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
                const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
                  },
                  body: JSON.stringify({ message_id: String(sent.messageId) }),
                  signal: AbortSignal.timeout(30000)
                });
                const rb = await res.json().catch(() => ({}));
                if (res.ok && rb.status === 'ok' && rb.retcode === 0) readbackText = rb.data?.text ?? '';
              } catch (error) {
                log(`[voice] 转写回读失败：${error?.message ?? error}`);
              }
            }
            sendJson({
              ok: true,
              ...preview,
              messageId: sent.messageId,
              verified: verification?.confirmed === true,
              readback: readbackText,
              audioProcessing: sent.audioProcessing,
              volume: sent.volume,
              loudness: sent.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 语音发送（AI 通道：reserved2 + agent token，只能发自己那个会话） ────
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-voice') {
          const body = await readBody();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const key = String(body.key ?? body.target ?? '').trim();
          const voice = voiceCfg();
          if (!voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return; }
          if (S.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, S.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          // 只要名字（解析）不要内容（预览）：dry-run 也必须经过与真发相同的解析与校验。
          let resolved;
          try {
            resolved = resolveVoicePathForV2(body.voice ?? body.file ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          try {
            voiceBudgetCheck(key, voice);
            if (body.dryRun === true) {
              const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
              if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
              sendJson({ ok: true, dryRun: true, key, file: resolved.path, detail: describeAudio(probe) });
              return;
            }
            const sent = await sendVoiceForV2(key, body.voice ?? body.file, {
              label: body.label ? String(body.label).slice(0, 100) : '',
              verify: body.verify,
              readback: body.readback === true,
              // AI 也可以调音量（默认走 config 的 defaultVolume）
              audio: (body.volume !== undefined || body.normalize === true || body.loudness !== undefined)
                ? { volume: body.volume, normalize: body.normalize === true, loudness: body.loudness }
                : null
            });
            sendJson({
              ok: true,
              key,
              messageId: sent.messageId,
              file: path.basename(sent.file),
              detail: sent.detail,
              audioProcessing: sent.audioProcessing,
              // verified=true 表示已用 get_msg 回读到这条消息的 record 段（"真的发出去了"的硬证据）
              verified: sent.verification?.confirmed === true,
              readback: sent.readback,
              warnings: sent.warnings
            });
          } catch (error) {
            // 额度只在真正发出后才记账（voiceBudgetCommit），所以失败路径无需回滚。
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
          if (caption) {
            sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
          if (S.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, S.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          try {
            const st = getSocialV2State(key);
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendStickerV2(key, stickerId, {
              replyToMessageId: actualReplyToMessageId,
              atUserId
            });
            // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
            const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
            const text = `[表情包:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: truncateText(text, 200),
              plain: truncateText(text, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            scheduleReplyCheckV2(key);
            log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
            appendActivity(`${key} [sticker] 工具发送表情：${label}`);
            sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = getSocialV2State(key);
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 账号自主操作（她完全接管自己的 QQ 号）────────────────────────────
        // GET  /api/socialV2/account         → 当前等级 + 可用动作清单
        // POST /api/socialV2/account { action, params?, key? }
        // 边界：等级 = socialV2.account.level；动作白名单 = ACCOUNT_ACTION_LEVELS；
        // get_cookies / set_restart / clean_cache 永不暴露；发消息不在这里。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/account') {
          if (req.headers['x-agent-token']) {
            const keyParam = String(url.searchParams.get('key') ?? '').trim();
            if (!agentTokenOk(keyParam, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (!v2SessionAllowed(keyParam)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (!v2ToolEnabled('accountAction')) { sendJson({ ok: false, error: '工具未启用：qq_account' }, 403); return; }
          }
          sendJson({
            ok: true,
            enabled: accountEnabled(),
            level: accountLevel(),
            levels: 'read 只读 < self 自我资料与轻量互动 < admin 群管理与好友增删（含不可逆）',
            actions: Object.keys(ACCOUNT_ACTION_LEVELS).map((a) => ({ action: a, level: ACCOUNT_ACTION_LEVELS[a] })),
            blocked: ['get_cookies', 'set_restart', 'clean_cache'],
            hint: 'POST /api/socialV2/account {action, params}；params 用 OneBot 原始参数名'
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/account') {
          const isAgent = !!req.headers['x-agent-token'];
          const body = await readBody();
          const action = String(body.action ?? '').trim();
          let key = String(body.key ?? '').trim();
          if (!key && !isAgent) key = S.lastActiveChatKey;
          if (body.params !== undefined && body.params !== null && (typeof body.params !== 'object' || Array.isArray(body.params))) {
            sendJson({ ok: false, error: 'params 必须是对象（OneBot 参数名 → 值）' }, 400); return;
          }
          const params = body.params && typeof body.params === 'object' ? body.params : {};
          if (JSON.stringify(params).length > 20000) { sendJson({ ok: false, error: 'params 过大（>20KB）' }, 400); return; }
          if (!accountEnabled()) { sendJson({ ok: false, error: '账号自主操作已关闭（socialV2.account.enabled=false 或 level=off）' }, 403); return; }
          if (!action) { sendJson({ ok: false, error: '缺少 action（GET 本端点可拿动作清单）' }, 400); return; }
          const need = ACCOUNT_ACTION_LEVELS[action];
          if (!need) {
            sendJson({ ok: false, error: '不支持的动作：' + action, actions: Object.keys(ACCOUNT_ACTION_LEVELS), blocked: ['get_cookies', 'set_restart', 'clean_cache'] }, 400);
            return;
          }
          const lvl = accountLevel();
          if ((ACCOUNT_LEVEL_RANK[need] ?? 9) > (ACCOUNT_LEVEL_RANK[lvl] ?? 0)) {
            sendJson({ ok: false, error: '动作 ' + action + ' 需要更高权限：当前 level=' + lvl + '，该动作属于 ' + need }, 403);
            return;
          }
          if (isAgent) {
            if (!key) { sendJson({ ok: false, error: '缺少 key' }, 400); return; }
            if (!canonicalV2Key(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
            if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (!v2ToolEnabled('accountAction')) { sendJson({ ok: false, error: '工具未启用：qq_account' }, 403); return; }
          }
          if (S.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const who = isAgent ? key : '控制台';
          try {
            const data = await oneBotCall(action, params);
            const brief = summarizeAccountResult(action, data);
            appendActivity('[账号] ' + who + ' 执行 ' + action + (brief ? ' → ' + brief : ''));
            log('[account] ' + who + ' ' + action + ' ok', brief);
            sendJson({ ok: true, action, level: need, data });
          } catch (error) {
            appendActivity('[账号] ' + who + ' 执行 ' + action + ' 失败：' + (error?.message ?? error));
            log('[account] ' + who + ' ' + action + ' 失败:', error?.message || error);
            sendJson({ ok: false, action, error: String(error?.message ?? error) }, 502);
          }
          return;
        }

        // POST /api/socialV2/react { key, messageId, emoji, set? }
        // 给一条**群**消息贴表情回应。做成独立端点而不是让模型自己拼 qq_account 的原因是
        // emoji 参数：模型记不住系统表情的数字 id，这里用 faceNameCache 反查中文名（"笑哭" → 9）。
        // 私聊会带明确原因失败 —— QQ 协议不支持私聊消息表态，不是权限没开。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/react') {
          const isAgent = !!req.headers['x-agent-token'];
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!accountEnabled()) { sendJson({ ok: false, error: '账号自主操作已关闭（socialV2.account.enabled=false 或 level=off）' }, 403); return; }
          if (S.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!canonicalV2Key(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (isAgent) {
            if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (!v2ToolEnabled('reactMessage')) { sendJson({ ok: false, error: '工具未启用：qq_react_message' }, 403); return; }
          }
          const messageId = Number(body.messageId ?? body.message_id ?? 0);
          if (!Number.isFinite(messageId) || messageId === 0) { sendJson({ ok: false, error: '缺少 messageId（要回应哪条消息）' }, 400); return; }
          const setFlag = body.set !== false;
          try {
            const out = await reactToMessageV2(key, messageId, body.emoji ?? body.emojiId ?? body.emoji_id, setFlag);
            appendActivity(`[表达] ${isAgent ? key : '控制台'} ${setFlag ? '贴了' : '取消了'}表情 ${out.name}(${out.emojiId}) @${messageId}`);
            log(`[express] ${isAgent ? key : 'console'} react ok emoji=${out.emojiId}(${out.name}) msg=${messageId} set=${setFlag}`);
            sendJson({ ok: true, messageId, emojiId: out.emojiId, emojiType: out.emojiType, emojiName: out.name, set: setFlag });
          } catch (error) {
            appendActivity('[表达] 贴表情失败：' + (error?.message ?? error));
            log('[express] react 失败:', error?.message || error);
            sendJson({ ok: false, error: String(error?.message ?? error) }, 502);
          }
          return;
        }

        // [patch QQ空间] POST /api/socialV2/qzone { key, action?, content?, images?, ugcRight?, tid? }
        //                    GET  /api/socialV2/qzone?key=…&limit=…
        // 她自己发/删 QQ空间说说，或者看看刚发过什么。做成专用端点而不是让她裸调 OneBot 动作名：
        // ① images 需要把 Windows 路径转成 WSL 能读的 file:///mnt/<盘>/…（SnowLuma 跑在 WSL 里）；
        // ② 可见范围、字数上限、同名去重这些规矩在桥接侧统一兜住，不指望模型记参数。
        if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/api/socialV2/qzone') {
          if (!qzoneEnabled()) { sendJson({ ok: false, error: 'QQ空间功能已关闭（socialV2.qzone.enabled=false）' }, 403); return; }
          if (!accountEnabled()) { sendJson({ ok: false, error: '账号自主操作已关闭（socialV2.account.enabled=false 或 level=off）' }, 403); return; }
          if (S.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          // 判定「是不是智能体调用」要连 x-agent-call 一起看：MCP 端一律带这个头，漏传令牌时它是空串。
          const isAgent = req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined;
          const body = req.method === 'POST' ? await readBody() : {};
          const key = String((req.method === 'POST' ? body.key : url.searchParams.get('key')) ?? '').trim();
          if (!canonicalV2Key(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (isAgent) {
            if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (!v2ToolEnabled('qzone')) { sendJson({ ok: false, error: '工具未启用：qq_post_qzone' }, 403); return; }
          }
          const qcfg = cfg.socialV2?.qzone ?? {};
          if (req.method === 'GET') {
            const limitRaw = Number(url.searchParams.get('limit'));
            const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 20) : 5;
            try {
              const data = await oneBotCall('get_qzone_msg_list', {});
              const list = Array.isArray(data?.msglist) ? data.msglist : [];
              sendJson({
                ok: true,
                total: Number(data?.total) || list.length,
                count: Math.min(list.length, limit),
                posts: list.slice(0, limit).map((m) => ({
                  tid: String(m?.tid ?? ''),
                  content: String(m?.content ?? ''),
                  time: Number(m?.time) || 0,
                  comments: Number(m?.comment_num) || 0,
                  private: m?.is_private === true,
                  images: Array.isArray(m?.images) ? m.images.length : 0
                })),
                hint: '她自己空间里的说说（最新在前）。tid 可用于 action=delete 删除。'
              });
            } catch (error) {
              log('[qzone] list 失败:', error?.message || error);
              sendJson({ ok: false, error: String(error?.message ?? error) }, 502);
            }
            return;
          }
          const action = String(body.action ?? 'post').trim().toLowerCase() || 'post';
          if (action === 'delete') {
            const tid = String(body.tid ?? '').trim();
            if (!/^[0-9a-f]{8,}$/i.test(tid)) { sendJson({ ok: false, error: '缺少 tid（要删哪条说说；先 GET /api/socialV2/qzone 拿）' }, 400); return; }
            try {
              await oneBotCall('delete_qzone_msg', { tid });
              const at = qzonePostLog.findIndex((p) => p.tid === tid);
              const gone = at >= 0 ? qzonePostLog.splice(at, 1)[0] : null;
              appendActivity(`[空间] ${isAgent ? key : '控制台'} 删了一条说说 ${tid}`);
              log(`[qzone] delete ok tid=${tid}`);
              sendJson({ ok: true, action: 'delete', tid, content: gone?.content ?? null });
            } catch (error) {
              appendActivity('[空间] 删说说失败：' + (error?.message ?? error));
              log('[qzone] delete 失败:', error?.message || error);
              sendJson({ ok: false, error: String(error?.message ?? error) }, 502);
            }
            return;
          }
          const content = String(body.content ?? '').trim();
          if (!content) { sendJson({ ok: false, error: 'content 不能为空（说说正文）' }, 400); return; }
          const maxChars = Math.max(1, Number(qcfg.maxChars) || 600);
          if (content.length > maxChars) { sendJson({ ok: false, error: `说说太长（${content.length} 字 > 上限 ${maxChars} 字）` }, 400); return; }
          const rawImages = body.images === undefined || body.images === null
            ? []
            : (Array.isArray(body.images) ? body.images : [body.images]).filter((s) => String(s ?? '').trim() !== '');
          const maxImages = Math.max(1, Math.min(9, Number(qcfg.maxImages) || 4));
          let images = [];
          if (rawImages.length > 0) {
            if (qcfg.allowImages === false) { sendJson({ ok: false, error: '带图已关闭（socialV2.qzone.allowImages=false）：这条只说文字' }, 403); return; }
            if (rawImages.length > maxImages) { sendJson({ ok: false, error: `最多带 ${maxImages} 张图（收到 ${rawImages.length} 张）` }, 400); return; }
            try {
              images = rawImages.map(qzoneImageRef).filter(Boolean);
            } catch (error) {
              sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
              return;
            }
          }
          const rightRaw = body.ugcRight ?? body.ugc_right;
          const right = rightRaw === undefined || rightRaw === null || String(rightRaw).trim() === ''
            ? (Number(qcfg.ugcRight) || 1)
            : Number(rightRaw);
          if (![1, 4, 64].includes(right)) {
            sendJson({ ok: false, error: 'ugcRight 只支持 1（所有人可见）/4（好友可见）/64（仅自己可见）；16/128 要名单，暂不支持' }, 400);
            return;
          }
          const dedupeMs = Math.max(0, Number(qcfg.dedupeWindowMs) || 21600000);
          if (dedupeMs > 0) {
            const now = Date.now();
            const dup = qzonePostLog.find((p) => p.content === content && now - p.at < dedupeMs);
            if (dup) {
              sendJson({ ok: false, error: `刚发过一模一样的说说（${new Date(dup.at).toLocaleString('zh-CN')}，tid=${dup.tid}）：想重发就改几个字，或 action=delete 删掉旧的` }, 409);
              return;
            }
          }
          try {
            const params = { content, ugc_right: right };
            if (images.length > 0) params.images = images;
            const data = await oneBotCall('send_qzone_msg', params);
            const tid = String(data?.tid ?? '');
            const time = Number(data?.time) || Math.floor(Date.now() / 1000);
            qzonePostLog.unshift({ tid, content, images: images.length, ugcRight: right, at: Date.now(), key });
            while (qzonePostLog.length > 50) qzonePostLog.pop();
            appendActivity(`[空间] ${isAgent ? key : '控制台'} 发了说说${images.length ? `（带 ${images.length} 张图）` : ''}：${content.slice(0, 80)}`);
            log(`[qzone] post ok tid=${tid} right=${right} images=${images.length} chars=${content.length}`);
            sendJson({
              ok: true,
              action: 'post',
              tid,
              time,
              ugcRight: right,
              visibility: right === 1 ? '所有人可见' : right === 4 ? '好友可见' : '仅自己可见',
              images: images.length,
              content,
              hint: '已经发到 QQ空间了。别连着刷；下次想发之前可以先 GET 看看刚发过什么。'
            });
          } catch (error) {
            appendActivity('[空间] 发说说失败：' + (error?.message ?? error));
            log('[qzone] post 失败:', error?.message || error);
            sendJson({ ok: false, error: String(error?.message ?? error) }, 502);
          }
          return;
        }

        // [patch 免睡眠] GET/POST /api/socialV2/sleep-toggle
        // 控制台「睡眠与叫醒」的免睡眠开关：打开后深夜窗口内也能被叫醒（手动睡/有限睡眠照旧）。
        // 只给控制台：路径已登记进 adminOnlyV2Paths，带 agent token 的调用会被 403。
        if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/api/socialV2/sleep-toggle') {
          if (S.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const sleepBody = req.method === 'POST' ? await readBody() : {};
          const hasToggle = req.method === 'POST'
            ? (sleepBody.forceAwake !== undefined || sleepBody.on !== undefined)
            : url.searchParams.has('on');
          if (hasToggle) {
            const rawOn = req.method === 'POST' ? (sleepBody.forceAwake ?? sleepBody.on) : url.searchParams.get('on');
            const on = rawOn === true || rawOn === 'true' || rawOn === '1' || rawOn === 1;
            const woke = [];
            if (on) {
              for (const [k, stx] of socialV2.conversations) {
                const now = sleepStateV2(k, stx);
                if (now.asleep && now.night) { wakeFromSleepV2(k, stx, '免睡眠开关'); woke.push(k); }
              }
            }
            S.sleepForceAwakeV2 = on;
            try {
              fs.mkdirSync(path.dirname(SLEEP_FORCE_AWAKE_FILE_V2), { recursive: true });
              fs.writeFileSync(SLEEP_FORCE_AWAKE_FILE_V2, JSON.stringify({ forceAwake: on, at: new Date().toISOString() }, null, 2) + '\n', 'utf8');
            } catch (error) { log('[免睡眠] 落盘失败：' + (error?.message ?? error)); }
            appendActivity('[睡眠] 控制台' + (on ? '打开' : '关闭') + '免睡眠' + (woke.length ? ('，叫醒 ' + woke.length + ' 个会话') : ''));
            log('[sleep] force-awake=' + on + ' woke=' + woke.length);
          }
          const sc = sleepCfgV2();
          const nightWin = sleepNightWinV2();
          const sleepAsleepKeys = [];
          for (const [k, stx] of socialV2.conversations) { if (sleepStateV2(k, stx).asleep) sleepAsleepKeys.push(k); }
          sendJson({
            ok: true,
            forceAwake: S.sleepForceAwakeV2,
            nightActive: !!nightWin && !S.sleepForceAwakeV2,
            window: nightWin ? (nightWin.from + '-' + nightWin.to) : null,
            enabled: sc.enabled !== false,
            asleepKeys: sleepAsleepKeys
          });
          return;
        }

        // [patch 睡眠] POST /api/socialV2/sleep { key, action: 'sleep'|'wake', minutes? }
        //                  GET  /api/socialV2/sleep?key=…
        // 手动让她睡 / 把她叫醒（深夜窗口之外也用得上）。睡着时的行为见 bridge.js 的
        // [patch 睡眠] 块：群里只有被 @ 会由桥接自动回一句（zzz…），其余一律只入未读、不烧 token。
        if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/api/socialV2/sleep') {
          if (sleepCfgV2().enabled === false) { sendJson({ ok: false, error: '睡眠功能已关闭（socialV2.sleep.enabled=false）' }, 403); return; }
          if (S.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const isAgent = req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined;
          const body = req.method === 'POST' ? await readBody() : {};
          const key = String((req.method === 'POST' ? body.key : url.searchParams.get('key')) ?? '').trim();
          if (!canonicalV2Key(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (isAgent) {
            if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (!v2ToolEnabled('sleep')) { sendJson({ ok: false, error: '睡眠控制未启用（socialV2.tools.sleep / socialV2.sleep.enabled）' }, 403); return; }
          }
          const st = getSocialV2State(key);
          const action = String((req.method === 'POST' ? body.action : (url.searchParams.get('action') ?? 'status')) ?? 'status').trim().toLowerCase() || 'status';
          if (action === 'sleep') {
            // [patch 免睡眠] 手动睡 = 明确要她睡，先关掉免睡眠开关，否则刚睡下就被旁路叫醒。
            if (!isAgent && S.sleepForceAwakeV2) {
              S.sleepForceAwakeV2 = false;
              try {
                fs.writeFileSync(SLEEP_FORCE_AWAKE_FILE_V2, JSON.stringify({ forceAwake: false, at: new Date().toISOString() }, null, 2) + '\n', 'utf8');
              } catch { /* ignore */ }
              appendActivity('[睡眠] 手动睡：免睡眠开关已自动关闭');
            }
            const rawMin = Number(req.method === 'POST' ? (body.minutes ?? body.min) : url.searchParams.get('minutes'));
            const minutes = Number.isFinite(rawMin) && rawMin > 0 ? Math.min(Math.floor(rawMin), 24 * 60) : (Number(sleepCfgV2().manualDefaultMin) || 480);
            st.sleepManualUntil = Date.now() + minutes * 60000;
            st.sleepAwakeUntil = 0;
            saveSocialV2State();
            appendActivity(`[睡眠] ${isAgent ? key : '控制台'} 手动让她睡 ${minutes} 分钟`);
            log(`[sleep] manual sleep ${key} ${minutes}min`);
            sendJson({ ok: true, action: 'sleep', key, minutes, manualUntil: st.sleepManualUntil, state: sleepStateV2(key, st) });
            return;
          }
          if (action === 'wake') {
            wakeFromSleepV2(key, st, isAgent ? `agent 叫醒（${key}）` : '控制台叫醒');
            sendJson({ ok: true, action: 'wake', key, awakeUntil: st.sleepAwakeUntil, state: sleepStateV2(key, st) });
            return;
          }
          const s = sleepCfgV2();
          sendJson({
            ok: true,
            action: 'status',
            key,
            state: sleepStateV2(key, st),
            config: {
              enabled: s.enabled !== false,
              nightWindows: Array.isArray(s.nightWindows) && s.nightWindows.length ? s.nightWindows : SLEEP_DEFAULT_NIGHT_WINDOWS_V2,
              timeZone: s.timeZone || 'Asia/Shanghai',
              replyOn: Array.isArray(s.replyOn) && s.replyOn.length ? s.replyOn : SLEEP_DEFAULT_REPLY_ON_V2,
              wakeWords: Array.isArray(s.wakeWords) && s.wakeWords.length ? s.wakeWords : SLEEP_DEFAULT_WAKE_WORDS_V2,
              minGapMs: Number.isFinite(Number(s.minGapMs)) ? Number(s.minGapMs) : 600000
            }
          });
          return;
        }


        // ── 心情与日程（只读）───────────────────────────────────────────────
        // GET /api/socialV2/mood —— 她此刻的心情 / 精力 / 作息段。
        // 心情状态原本只在记忆与唤醒逻辑内部流转，没有任何对外出口，后台只能新增。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/mood') {
          const ms = readMoodState();
          const seg = scheduleSegmentAt();
          const holdUntil = Number(ms.holdUntil) || 0;
          const now = Date.now();
          sendJson({
            ok: true,
            mood: {
              mood: ms.mood,
              label: MOOD_LABELS[ms.mood] ?? ms.mood,
              energy: ms.energy,
              note: ms.note || '',
              since: Number(ms.since) || 0,
              updatedAt: Number(ms.updatedAt) || 0,
              lastInteractAt: Number(ms.lastInteractAt) || 0,
              holdUntil,
              holdActive: holdUntil > now,
              holdMs: holdUntil > now ? holdUntil - now : 0
            },
            labels: MOOD_LABELS,
            schedule: {
              name: seg.name,
              energy: seg.energy,
              note: seg.note,
              at: now,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
            }
          });
          return;
        }

        // GET /api/socialV2/usage?key=… —— **她自己**的 token 用量 / 花费 / 上下文占用
        // 和 /api/tokens/*（全机器账本，含别的群烧的钱，明确拒绝 agent token）不同：
        // 这里只返回 key 自己那个 QQ 会话的累计 + 她自己 24 小时的失败次数，
        // 所以给持有该会话 agent token 的 AI 看是安全的（跨群花费仍然看不到）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/usage') {
          // 判定「是不是智能体调用」必须连 x-agent-call 一起看：MCP 端一律带这个头，
          // 漏传令牌时它是 **空串**，只看 x-agent-token 会把「模型忘传」当成控制台放行。
          const isAgent = req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined;
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!canonicalV2Key(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (isAgent) {
            if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (!v2ToolEnabled('usage')) { sendJson({ ok: false, error: '工具未启用：qq_usage' }, 403); return; }
          }
          const report = buildUsageReportV2(key);
          if (!report) { sendJson({ ok: false, error: '用量账本读取失败' }, 500); return; }
          // 带上现成的一行文本：模型侧直接转述，省得它自己把数字拼错。
          sendJson({ ...report, line: usageLineV2(key).trim() || null });
          return;
        }


        // GET /api/socialV2/meme-image?path=… —— 直接吐表情图原始字节，供后台 <img> 使用。
        // 页面 CSP 是 default-src 'self'（没有 img-src），外链 / data: / blob: 都不可靠，
        // 所以图片本体只能由本机路由送出。path 用 meme-candidates 返回的相对路径。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/meme-image') {
          if (!memesEnabled()) { sendJson({ ok: false, error: '表情包图库已关闭' }, 403); return; }
          const rel = String(url.searchParams.get('path') ?? '').trim();
          if (!rel) { sendJson({ ok: false, error: 'path 不能为空' }, 400); return; }
          try {
            const root = path.resolve(memeRootDir());
            const abs = path.resolve(root, rel);
            if (abs !== root && !abs.startsWith(root + path.sep)) { sendJson({ ok: false, error: '表情路径越界' }, 403); return; }
            const st = fs.statSync(abs);
            if (!st.isFile()) { sendJson({ ok: false, error: '表情路径不是文件' }, 400); return; }
            if (st.size > MEME_MAX_BYTES) { sendJson({ ok: false, error: `表情文件过大（>${Math.round(MEME_MAX_BYTES / 1048576)}MB）` }, 400); return; }
            const buf = fs.readFileSync(abs);
            const mime = mimeFromUrl(abs) || mimeFromBuffer(buf) || 'application/octet-stream';
            res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', 'content-length': buf.length, ...SECURITY_HEADERS });
            res.end(buf);
          } catch (error) {
            sendJson({ ok: false, error: `读取表情图失败：${error?.message ?? error}` }, 404);
          }
          return;
        }

        // ── [patch 插件管理] 后台「插件」：列表 / 从链接安装 / 卸载 / 组合包启停 / 重启 DSH ──
        if (url.pathname === '/api/plugins' || url.pathname.startsWith('/api/plugins/')) {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
        }
        if (req.method === 'GET' && url.pathname === '/api/plugins') {
          try {
            const { file, pkg } = readProfilePackage();
            const bundles = Array.isArray(pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
            const deps = Object.entries(pkg.dependencies || {}).map(([name, spec]) => {
              let version = '';
              let hasBundle = false;
              let description = '';
              try {
                const pj = JSON.parse(fs.readFileSync(path.join(PLUGIN_PROFILE_DIR, 'node_modules', name, 'package.json'), 'utf8'));
                version = pj.version || '';
                hasBundle = !!(pj.dsh && pj.dsh.bundle);
                description = String(pj.description || '').slice(0, 120);
              } catch { /* 没装好就是空 */ }
              let source = '';
              if (/^github:/i.test(spec)) source = 'https://github.com/' + String(spec).slice(7).split('#')[0];
              else if (/^link:/i.test(spec)) source = spec;
              return { name, spec, version, hasBundle, enabled: bundles.includes(name), source, description };
            }).filter((d) => d && d.name); // [patch 插件列表] 直接依赖全列出来（含非组合包，例如 dsh-google-chrome-search 这种只提供 MCP/技能、不声明 dsh.bundle 的包），否则刚装完在页面上看不见
            sendJson({
              ok: true,
              profile: PLUGIN_PROFILE_DIR,
              profileFile: file,
              pnpmReady: fs.existsSync(PLUGIN_DSH_BIN),
              bundles,
              deps,
              jobs: [...pluginJobs.values()].map(pluginJobSnapshot).sort((a, b) => b.startedAt - a.startedAt).slice(0, 5)
            });
          } catch (error) {
            sendJson({ ok: false, error: '读取 profile 失败：' + (error?.message ?? error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/plugins/install') {
          const body = await readBody();
          const raw = String(body.url ?? body.spec ?? '').trim();
          let info;
          try { info = normalizePluginSpec(raw); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          const job = startPluginJob('install', async (push) => {
            push('目标：' + JSON.stringify(info));
            const spec = info.kind === 'github' ? await downloadGithubTarball(info, push) : info.spec;
            const nm = path.join(PLUGIN_PROFILE_DIR, 'node_modules');
            const before = new Set(fs.existsSync(nm) ? fs.readdirSync(nm) : []);
            const code = await runProfilePnpm(['add', spec], push);
            if (code !== 0) return { ok: false, error: 'pnpm add 退出码 ' + code };
            const added = listNewModules(before);
            push('新增依赖目录：' + (added.join(', ') || '（无 / 可能覆盖了同名包）'));
            const { pkg } = readProfilePackage();
            pkg.dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {};
            pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === 'object' ? pkg.dsh.profile : {};
            if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
            let bundleName = '';
            for (const mod of added) {
              try {
                const pj = JSON.parse(fs.readFileSync(path.join(nm, mod, 'package.json'), 'utf8'));
                const hasBundle = !!(pj.dsh && pj.dsh.bundle);
                push('包：' + (pj.name || mod) + '@' + (pj.version || '?') + (hasBundle ? '（组合包，已加入启用列表）' : '（不是组合包，只装了依赖）'));
                if (hasBundle && pj.name) {
                  bundleName = pj.name;
                  if (!pkg.dsh.profile.bundles.includes(pj.name)) pkg.dsh.profile.bundles.push(pj.name);
                }
              } catch {}
            }
            if (added.length) saveProfilePackage(pkg);
            push('已更新 ' + path.basename(PLUGIN_PROFILE_DIR) + '/package.json' + (bundleName ? '，组合包 ' + bundleName + ' 默认启用' : ''));
            push('⚠️ 需要重启 DSH 才能生效。');
            return { ok: true, bundle: bundleName || null, added };
          });
          sendJson({ ok: true, jobId: job.id });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/plugins/job') {
          const id = String(url.searchParams.get('id') ?? '').trim();
          const job = pluginJobs.get(id);
          if (!job) { sendJson({ ok: false, error: '没有这个任务（或已过期）' }, 404); return; }
          sendJson({ ok: true, job: pluginJobSnapshot(job) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/plugins/remove') {
          const body = await readBody();
          const name = String(body.name ?? '').trim();
          if (!name) { sendJson({ ok: false, error: 'name 不能为空' }, 400); return; }
          const job = startPluginJob('remove', async (push) => {
            const { pkg } = readProfilePackage();
            const bundles = Array.isArray(pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
            if (bundles.includes(name)) {
              pkg.dsh.profile.bundles = bundles.filter((n) => n !== name);
              saveProfilePackage(pkg);
              push('已从组合包启用列表移除');
            }
            const code = await runProfilePnpm(['remove', name], push);
            if (code !== 0) return { ok: false, error: 'pnpm remove 退出码 ' + code };
            push('已卸载 ' + name + '，重启 DSH 后生效');
            return { ok: true, name };
          });
          sendJson({ ok: true, jobId: job.id });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/plugins/bundle') {
          const body = await readBody();
          const name = String(body.name ?? '').trim();
          const enabled = body.enabled !== false;
          if (!name) { sendJson({ ok: false, error: 'name 不能为空' }, 400); return; }
          try {
            const { pkg } = readProfilePackage();
            pkg.dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {};
            pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === 'object' ? pkg.dsh.profile : {};
            const list = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles.slice() : [];
            const has = list.includes(name);
            if (enabled && !has) list.push(name);
            if (!enabled && has) list.splice(list.indexOf(name), 1);
            pkg.dsh.profile.bundles = list;
            saveProfilePackage(pkg);
            log('[plugin] 组合包 ' + name + ' → ' + (enabled ? '启用' : '关闭'));
            sendJson({ ok: true, name, enabled, bundles: list });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/plugins/restart-dsh') {
          try {
            const script = path.join(ROOT, 'tmp', 'restart-dsh-admin.ps1');
            fs.mkdirSync(path.dirname(script), { recursive: true });
            const lines = [
              "$ErrorActionPreference = 'SilentlyContinue'",
              'Start-Sleep -Seconds 2',
              "$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dsh' -and $_.CommandLine -match '--port 3080' }",
              'foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force }',
              ''
            ];
            fs.writeFileSync(script, lines.join('\r\n'), 'utf8');
            const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { detached: true, stdio: 'ignore', windowsHide: true });
            child.unref();
            log('[plugin] 已请求重启 DSH');
            sendJson({ ok: true, hint: 'DSH 会重启，桌面端通常 10~20 秒后自动拉起；当前会话会中断。' });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
          }
          return;
        }

        // ── [patch 表情仓库] 后台「表情包仓库」：列表 / 添加（文件或 GitHub 链接）/ 启用停用 / 置顶 / 删除 ──
        // 这些是管理操作，只给控制台：MCP 的 AI 调用带 x-agent-token，一律 403。
        if ((url.pathname === '/api/socialV2/memes' || url.pathname.startsWith('/api/socialV2/memes/')) && req.headers['x-agent-token']) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memes') {
          if (!memesEnabled()) { sendJson({ ok: false, error: '表情包图库已关闭（socialV2.memes.enabled=false）' }, 403); return; }
          try {
            const store = getMemeStore();
            const root = path.resolve(memeRootDir());
            const ov = memeOverrides();
            const tagReq = String(url.searchParams.get('tag') ?? '').trim();
            const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
            const limit = Math.min(120, Math.max(1, Number(url.searchParams.get('limit')) || 48));
            const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
            const allRows = store.rows();
            const moodFilter = memeMoodOfTag(tagReq);
            const fine = moodFilter ? MEME_MOODS[moodFilter] : (tagReq ? [tagReq] : null);
            let rows = allRows;
            if (fine) rows = rows.filter((m) => fine.includes(m.tag));
            if (q) rows = rows.filter((m) => (m.tag + ' ' + (m.caption || '') + ' ' + (m.keywords || '') + ' ' + (m.path || '')).toLowerCase().includes(q));
            const counts = {};
            for (const m of allRows) {
              const md = memeMoodOfTag(m.tag) || 'other';
              counts[md] = (counts[md] || 0) + 1;
            }
            const items = rows.slice(offset, offset + limit).map((m) => {
              let size = 0;
              try { size = fs.statSync(path.resolve(root, m.path)).size; } catch { size = 0; }
              const mood = memeMoodOfTag(m.tag);
              return {
                path: m.path,
                tag: m.tag,
                mood,
                file_name: m.file_name,
                caption: m.caption || '',
                keywords: m.keywords || '',
                enabled: !ov.disabled[m.path],
                pinned: !!mood && ov.pinned[mood] === m.path,
                size
              };
            });
            let enabledCount = 0;
            for (const m of allRows) if (!ov.disabled[m.path]) enabledCount += 1;
            sendJson({
              ok: true,
              root,
              total: allRows.length,
              enabled: enabledCount,
              disabled: allRows.length - enabledCount,
              matched: rows.length,
              offset,
              limit,
              counts,
              moods: memeMoodNames(),
              moodDict: MEME_MOOD_DICT,
              pinned: ov.pinned,
              items
            });
          } catch (error) {
            sendJson({ ok: false, error: '读取表情包图库失败：' + (error?.message ?? error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memes/add') {
          if (!memesEnabled()) { sendJson({ ok: false, error: '表情包图库已关闭（socialV2.memes.enabled=false）' }, 403); return; }
          const body = await readBody();
          const tag = String(body.tag ?? '').trim();
          if (!MEME_MOODS[tag]) { sendJson({ ok: false, error: 'tag 必须是 happy / angry / sad / shy / confused / daily 之一' }, 400); return; }
          const caption = String(body.caption ?? '').trim().slice(0, 300);
          const keywords = String(body.keywords ?? '').trim().slice(0, 300);
          let nameHint = String(body.filename ?? '').trim();
          let buf = null;
          const urlRaw = String(body.url ?? '').trim();
          try {
            if (urlRaw) {
              // GitHub 直连在国内经常不通：按「raw → jsDelivr CDN → ghproxy 镜像」依次尝试，
              // 任一条成功就用它。非 GitHub 的普通图片链接只直连一次。
              const gh = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw|tree)\/([^/]+)\/(.+)$/i.exec(urlRaw);
              const candidates = [];
              let nameFrom = urlRaw;
              if (gh) {
                const rawUrl = 'https://raw.githubusercontent.com/' + gh[1] + '/' + gh[2] + '/' + gh[3] + '/' + gh[4];
                nameFrom = rawUrl;
                candidates.push(rawUrl);
                candidates.push('https://cdn.jsdelivr.net/gh/' + gh[1] + '/' + gh[2] + '@' + gh[3] + '/' + gh[4]);
                candidates.push('https://ghproxy.net/' + rawUrl);
                candidates.push('https://gh-proxy.com/' + rawUrl);
              } else {
                candidates.push(urlRaw);
              }
              let resp = null;
              let lastErr = '';
              let usedUrl = '';
              for (const cand of candidates) {
                if (!/^https?:\/\//i.test(cand)) { lastErr = '链接必须是 http(s)'; continue; }
                try {
                  const r = await fetch(cand, { redirect: 'follow' });
                  if (!r.ok) { lastErr = 'HTTP ' + r.status + '（' + cand.slice(0, 60) + '）'; continue; }
                  resp = r;
                  usedUrl = cand;
                  break;
                } catch (error) {
                  lastErr = (error?.message ?? String(error)) + '（' + cand.slice(0, 60) + '）';
                }
              }
              if (!resp) {
                sendJson({ ok: false, error: '下载失败：' + (lastErr || '未知错误') + '；GitHub 直连不通时会依次尝试 jsDelivr / ghproxy 镜像' }, 502);
                return;
              }
              if (usedUrl !== candidates[0]) log('[meme] GitHub 直连不通，改用镜像：' + usedUrl.slice(0, 80));
              const len = Number(resp.headers.get('content-length') || 0);
              if (len > MEME_MAX_BYTES) { sendJson({ ok: false, error: '图片超过上限（' + Math.round(MEME_MAX_BYTES / 1048576) + 'MB）' }, 413); return; }
              const ab = await resp.arrayBuffer();
              buf = Buffer.from(ab);
              if (buf.length > MEME_MAX_BYTES) { sendJson({ ok: false, error: '图片超过上限（' + Math.round(MEME_MAX_BYTES / 1048576) + 'MB）' }, 413); return; }
              if (!nameHint) { try { nameHint = decodeURIComponent(new URL(nameFrom).pathname.split('/').pop() || ''); } catch { nameHint = ''; } }
              const ctype = String(resp.headers.get('content-type') || '');
              if (!/^image\//i.test(ctype) && !/\.(jpe?g|png|gif|webp)$/i.test(nameHint)) {
                sendJson({ ok: false, error: '这个链接不像图片（content-type=' + (ctype || '未知') + '）' }, 400);
                return;
              }
            } else if (body.contentBase64) {
              const b64 = String(body.contentBase64).replace(/^data:[^;]+;base64,/, '');
              buf = Buffer.from(b64, 'base64');
              if (!buf.length) { sendJson({ ok: false, error: '文件内容为空' }, 400); return; }
              if (buf.length > MEME_MAX_BYTES) { sendJson({ ok: false, error: '图片超过上限（' + Math.round(MEME_MAX_BYTES / 1048576) + 'MB）' }, 413); return; }
            } else {
              sendJson({ ok: false, error: '需要 url（GitHub 链接）或 contentBase64' }, 400);
              return;
            }
          } catch (error) {
            sendJson({ ok: false, error: '获取图片失败：' + (error?.message ?? error) }, 502);
            return;
          }
          let ext = (path.extname(nameHint || '') || '').toLowerCase().replace('.', '');
          if (!/^(jpe?g|png|gif|webp)$/.test(ext)) {
            const mime = mimeFromBuffer(buf) || '';
            ext = mime.includes('png') ? 'png' : mime.includes('gif') ? 'gif' : mime.includes('webp') ? 'webp' : 'jpg';
          }
          if (ext === 'jpeg') ext = 'jpg';
          const root = path.resolve(memeRootDir());
          const dir = path.join(root, 'memes', tag);
          fs.mkdirSync(dir, { recursive: true });
          const safeBase = (path.basename(nameHint || 'meme').replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 40) || 'meme');
          const fileName = 'admin__' + Date.now() + '__' + safeBase + '.' + ext;
          const abs = path.join(dir, fileName);
          fs.writeFileSync(abs, buf);
          const rel = 'memes/' + tag + '/' + fileName;
          const db = new DatabaseSync(path.join(root, 'index.db'));
          try {
            db.prepare('INSERT OR REPLACE INTO memes(path, tag, file_name, file_hash, caption, keywords, mtime, captioned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(rel, tag, fileName, null, caption, keywords, Date.now() / 1000, null);
            try { db.prepare('INSERT INTO memes_fts(path, tag, caption, keywords, file_name) VALUES (?, ?, ?, ?, ?)').run(rel, tag, caption, keywords, fileName); } catch { /* FTS 已存在就跳过 */ }
          } finally {
            db.close();
          }
          S.memeStore = null;
          S.memeStoreRoot = '';
          log('[meme] 后台新增表情包：' + rel + '（' + buf.length + 'B）');
          sendJson({ ok: true, path: rel, tag, caption, keywords, bytes: buf.length });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memes/toggle') {
          const body = await readBody();
          const rel = String(body.path ?? '').trim();
          if (!rel) { sendJson({ ok: false, error: 'path 不能为空' }, 400); return; }
          const ov = memeOverrides();
          const next = { disabled: Object.assign({}, ov.disabled || {}), pinned: Object.assign({}, ov.pinned || {}) };
          const enabled = body.enabled !== false;
          if (enabled) delete next.disabled[rel]; else next.disabled[rel] = true;
          saveMemeOverrides(next);
          log('[meme] 后台' + (enabled ? '启用' : '停用') + '表情包：' + rel);
          sendJson({ ok: true, path: rel, enabled });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memes/pin') {
          const body = await readBody();
          const rel = String(body.path ?? '').trim();
          if (!rel) { sendJson({ ok: false, error: 'path 不能为空' }, 400); return; }
          const store = getMemeStore();
          const row = store.rows().find((m) => m.path === rel);
          if (!row) { sendJson({ ok: false, error: '图库里没有这条记录：' + rel }, 404); return; }
          const mood = memeMoodOfTag(row.tag);
          if (!mood) { sendJson({ ok: false, error: '这张图的 tag 不属于任何情绪桶' }, 400); return; }
          const ov = memeOverrides();
          const next = { disabled: Object.assign({}, ov.disabled || {}), pinned: Object.assign({}, ov.pinned || {}) };
          const pin = body.pinned !== false;
          if (pin) next.pinned[mood] = rel; else if (next.pinned[mood] === rel) delete next.pinned[mood];
          saveMemeOverrides(next);
          log('[meme] 后台' + (pin ? '置顶' : '取消置顶') + '：' + mood + ' → ' + rel);
          sendJson({ ok: true, path: rel, mood, pinned: pin });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memes/delete') {
          const body = await readBody();
          const rel = String(body.path ?? '').trim();
          if (!rel) { sendJson({ ok: false, error: 'path 不能为空' }, 400); return; }
          const root = path.resolve(memeRootDir());
          const abs = path.resolve(root, rel);
          if (abs !== root && !abs.startsWith(root + path.sep)) { sendJson({ ok: false, error: '表情路径越界' }, 403); return; }
          const db = new DatabaseSync(path.join(root, 'index.db'));
          try {
            db.prepare('DELETE FROM memes WHERE path = ?').run(rel);
            try { db.prepare('DELETE FROM memes_fts WHERE path = ?').run(rel); } catch { /* 忽略 */ }
          } finally {
            db.close();
          }
          try { if (fs.existsSync(abs) && fs.statSync(abs).isFile()) fs.unlinkSync(abs); } catch (error) { log('[meme] 删除文件失败：' + (error?.message ?? error)); }
          const ov = memeOverrides();
          const next = { disabled: Object.assign({}, ov.disabled || {}), pinned: Object.assign({}, ov.pinned || {}) };
          delete next.disabled[rel];
          for (const [m, p] of Object.entries(next.pinned)) if (p === rel) delete next.pinned[m];
          saveMemeOverrides(next);
          S.memeStore = null;
          S.memeStoreRoot = '';
          log('[meme] 后台删除表情包：' + rel);
          sendJson({ ok: true, path: rel });
          return;
        }

        // ── 表情包图库（本地，DSH 生态格式）─────────────────────────────────
        // GET /api/socialV2/meme-candidates?tag=happy&query=…&limit=8[&key=…]
        // 返回候选（path + tag + caption），不带图片本体，省 token。tag 可用情绪桶
        // (happy/angry/sad/shy/confused/daily) 或细分类；都不给则随机抽。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/meme-candidates') {
          if (!memesEnabled()) { sendJson({ ok: false, error: '表情包图库已关闭' }, 403); return; }
          const memeCfg = cfg.socialV2?.memes ?? {};
          const maxList = Math.max(1, Number(memeCfg.maxListCount) || 12);
          const wantTag = String(url.searchParams.get('tag') ?? '').trim();
          const wantQuery = String(url.searchParams.get('query') ?? '').trim();
          const keyParam = String(url.searchParams.get('key') ?? '').trim();
          if (req.headers['x-agent-token']) {
            if (!agentTokenOk(keyParam, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (!v2SessionAllowed(keyParam)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (!v2ToolEnabled('sendMeme')) { sendJson({ ok: false, error: '工具未启用：qq_send_meme' }, 403); return; }
          }
          const limitRaw = Number(url.searchParams.get('limit'));
          const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), maxList) : Math.min(8, maxList);
          try {
            const store = getMemeStore();
            let mood = null;
            let samples = [];
            if (wantTag || wantQuery) {
              const picked = store.sampleMood(wantTag || null, wantQuery || null, limit);
              mood = picked.mood;
              samples = picked.memes;
              if (!mood) samples = store.list(wantTag || null, wantQuery || null).memes.slice(0, limit);
            } else {
              samples = store.sampleAny(limit);
            }
            // [patch 表情仓库] 后台停用的不给她看见；该情绪桶「置顶」的那张排最前。
            samples = applyMemeOverrides(samples, mood, limit);
            const pinnedSample = pinnedMemeRowV2(mood);
            if (pinnedSample && !samples.some((m) => m && m.path === pinnedSample.path)) {
              samples = [pinnedSample].concat(samples).slice(0, limit);
            }
            sendJson({
              ok: true,
              mood,
              moods: memeMoodNames(),
              moodDict: MEME_MOOD_DICT,
              total: store.total(),
              count: samples.length,
              candidates: samples.map((m) => ({ path: m.path, tag: m.tag, caption: m.caption ?? '', keywords: m.keywords ?? '' })),
              hint: '挑一张后调用 qq_send_meme(path=…)：表情单独一条气泡，不要在同一气泡里附文字'
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取表情包图库失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // POST /api/socialV2/send-meme { key, path, replyToMessageId?, atUserId? }
        // 控制台调用（不带 x-agent-call / x-agent-token）时 key 可省略 → 用最近有入站消息的会话。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-meme') {
          if (!memesEnabled()) { sendJson({ ok: false, error: '表情包图库已关闭' }, 403); return; }
          const body = await readBody();
          const isAgent = !!req.headers['x-agent-token'];
          let key = String(body.key ?? '').trim();
          if (!key && !isAgent) key = S.lastActiveChatKey;
          let memePath = String(body.path ?? body.memePath ?? '').trim();
          const memeTag = String(body.tag ?? '').trim();
          const memeQuery = String(body.query ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key) { sendJson({ ok: false, error: '缺少 key：控制台可省略 key（用最近活跃会话），但当前还没有任何入站会话' }, 400); return; }
          // [patch 高频表情包] 没给 path 时用 tag/query 现挑一张（下面做），不再强制两步走。
          if (isAgent && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (isAgent && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (isAgent && !v2ToolEnabled('sendMeme')) { sendJson({ ok: false, error: '工具未启用：qq_send_meme' }, 403); return; }
          if (S.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, S.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          const memeCfg = cfg.socialV2?.memes ?? {};
          const cooldownMs = Math.max(0, Number(memeCfg.cooldownMs) || 0);
          const now = Date.now();
          const lastMemeAt = memeLastSentAt.get(key) || 0;
          if (cooldownMs > 0 && isAgent && now - lastMemeAt < cooldownMs) {
            sendJson({ ok: false, error: `刚发过表情包，${Math.ceil((cooldownMs - (now - lastMemeAt)) / 1000)} 秒后才能再发（防刷屏）` }, 429);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          if (!memePath) {
            try {
              // [patch 表情仓库] 现挑一张时跳过停用的，并优先用该情绪桶置顶的那张。
              const first = pickOneMemeV2(memeTag, memeQuery);
              memePath = first ? String(first.path ?? '') : '';
            } catch (error) {
              sendJson({ ok: false, error: `挑选表情包失败：${error?.message ?? error}` }, 500);
              return;
            }
            if (!memePath) { sendJson({ ok: false, error: '图库里没有可用的表情包' }, 400); return; }
          }
          // [patch 表情仓库] 她在旧上下文里记住的 path 可能已经被后台停用：不报错打断她，
          // 直接换成另一张可用的（免得她卡在一张「被藏起来」的图上反复重试）。
          if (memePath && memeOverrides().disabled[memePath]) {
            const alt = pickOneMemeV2(memeTag, memeQuery);
            if (alt) {
              log('[meme] ' + key + ' 指定的表情已停用，改用 ' + alt.path);
              memePath = String(alt.path);
            }
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          try {
            const st = getSocialV2State(key);
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendMemeV2(key, memePath, { replyToMessageId: actualReplyToMessageId, atUserId });
            // 记录到二代会话的 recentMessages，让 AI 知道自己发过这张表情包
            const label = String(sent.caption || sent.tag || '表情包').slice(0, 60);
            const text = `[表情包:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: truncateText(text, 200),
              plain: truncateText(text, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              meme: { path: sent.path, tag: sent.tag, caption: sent.caption },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            scheduleReplyCheckV2(key);
            log(`[meme] 工具发送表情包 ${key}: ${sent.path} | ${label}`);
            appendActivity(`${key} [meme] 工具发送表情包：${label}`);
            sendJson({ ok: true, key, meme: { path: sent.path, tag: sent.tag, caption: sent.caption }, messageId: sent.messageId ?? null, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = getSocialV2State(key);
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            log(`[meme] 工具发送表情包失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送表情包失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const st = getSocialV2State(key);
          const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return;
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await collectStickerV2(key, messageRef, remark);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
            sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 语音库列表。两条通道共用：
        //   - 带 agent token（AI 的 qq_list_voices）→ 必须带 key，校验会话白名单/工具开关；
        //   - 不带 agent token（控制台调试面板 / CLI）→ 只需控制台令牌，不需要 key。
        // 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析）。
        if (req.method === 'GET' && (url.pathname === '/api/socialV2/voices' || url.pathname === '/api/voice/list')) {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const voice = voiceCfg();
          const agentCall = Boolean(req.headers['x-agent-token']);
          // 与发送接口同样的分层：voice.enabled 只关 AI 通道；操作者（控制台面板）仍可列语音库。
          if (agentCall && !voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (agentCall && !key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (agentCall && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          const wantProbe = url.searchParams.get('probe') !== '0';
          try {
            const files = listAudioFiles(voice.dir);
            const items = [];
            for (const f of files.slice(0, 100)) {
              const entry = { name: path.relative(voice.dir, f).split(path.sep).join('/') };
              if (wantProbe) {
                const info = await inspectAudio(f, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
                entry.ok = info.ok;
                entry.bytes = info.size;
                entry.detail = info.ok ? describeAudio(info) : null;
                entry.seconds = info.duration ?? null;
                if (!info.ok) entry.error = info.error;
              }
              items.push(entry);
            }
            sendJson({
              ok: true,
              key: key || null,
              dir: agentCall ? undefined : voice.dir,
              count: items.length,
              voices: items,
              limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour },
              // ⚠️ 提示语里也不能出现绝对路径：AI 通道下同样要脱敏（dir 字段已经抑制了，
              // 但这里的模板字符串曾无条件插值 voice.dir —— 等于从旁边的字段又漏出去一次）。
              hint: items.length
                ? '用 qq_send_voice 传 name 即可把其中一个当语音发出去'
                : (agentCall ? '语音库为空：请让管理员先把音频放进语音库' : `语音库为空：把音频文件放进 ${voice.dir} 后重试`)
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取语音库失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 上**不再支持** refresh：强制同步是有副作用的写操作（拉 OneBot 收藏表情并落盘），
          // 挂在 GET 上会绕开「非 GET 必须 application/json + 同源 Origin」的 CSRF 防护。
          // 需要强制同步时请用同一路径的 POST，或控制台的 POST /api/stickers/sync。
          const force = false;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? S.stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? S.stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const query = String(body.query ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
          let force = body.refresh === true;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
          if (req.headers['x-agent-token'] && force) {
            const now = Date.now();
            if (now - S.lastForcedAgentStickerSync < 10000) force = false;
            else S.lastForcedAgentStickerSync = now;
          }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? S.stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? S.stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 管理端表情库接口（控制台）
        if (req.method === 'GET' && url.pathname === '/api/stickers') {
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 不再触发强制同步（写副作用不能挂在读接口上）：请用 POST /api/stickers/sync。
          try {
            const synced = await syncStickerLibrary(false);
            const list = formatStickerList(synced?.entries ?? S.stickerEntries, query, count);
            sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? S.stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
          try {
            const synced = await syncStickerLibrary(true);
            sendJson({ ok: true, total: synced?.entries?.length ?? S.stickerEntries.length, syncedAt: synced?.syncedAt ?? S.stickerSyncedAt });
          } catch (error) {
            sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          sendJson({ ok: true, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            sendJson({ ok: true, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (body.purpose !== undefined && !['messages', 'reply'].includes(body.purpose)) {
            sendJson({ ok: false, error: 'purpose 必须是 messages（等后续消息）或 reply（回复前短静默）' }, 400);
            return;
          }
          const replyWait = body.purpose === 'reply';
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
          if (socialV2.paused) {
            const st = getSocialV2State(key);
            sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], readThroughSeq: readThroughSeqV2(st), unreadCount: st.unread.length });
            return;
          }
          const waitCfg = cfg.socialV2?.wait ?? {};
          const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
          const defaultMs = Number(waitCfg.defaultMs) || 30000;
          const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
          const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
          const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
          const st = getSocialV2State(key);
          // [patch 令牌宽限 v2 2026-10-18] 宽限表让「轮换前发出去的那一轮」还能调工具收尾，
          // 但**长轮询把新消息交出去**这件事不能跟着放宽：retireSession 的安全不变量是
          // 「令牌一旦作废，这个会话就不能再认领新到达」。所以按入场状态分两种口径：
          // - 入场时用的就是当前令牌 ⇒ 结束时必须仍是当前令牌（等待期间被轮换 = 立刻 403）；
          // - 入场时本来就是宽限旧令牌 ⇒ 只要它还留在宽限表里就放行（否则在途回合的
          //   qq_wait_for_messages 会整轮失败，等于把要修的问题换个地方复现）。
          const waitToken = req.headers['x-agent-token'];
          const waitTokenLiveAtEntry = !waitToken || (st.agentToken ? tokenEq(waitToken, st.agentToken) : false);
          const waitTokenStillOk = () => {
            if (waitTokenLiveAtEntry) return Boolean(st.agentToken) && tokenEq(waitToken, st.agentToken);
            return agentTokenOk(key, waitToken);
          };
          // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
          // 租约过期则视为残留（handler 异常退出没清干净），允许接管而不是永久 429。
          if (activeWaits.has(key) && Date.now() - activeWaits.get(key) < ACTIVE_WAIT_LEASE_MS) {
            sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
            return;
          }
          activeWaits.set(key, Date.now());
          const finishWait = () => activeWaits.delete(key);
          req.on('close', finishWait);
          const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
          const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
          const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
          // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
          // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
          // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
          const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
          const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
          // A reply wait must also include messages received while the model
          // was reading/thinking after its snapshot, before this HTTP request.
          const requestSeq = st.lastUnreadSeq || 0;
          const baseline = replyWait && (v2ToolEnabled('getUnread') || v2ToolEnabled('getRecent')) ? readThroughSeqV2(st) : requestSeq;
          const start = Date.now();
          let arrived = false;
          let lastNewAt = 0;
          let aborted = false;
          req.on('close', () => { aborted = true; });
          if (replyWait) {
            const incomingAt = () => {
              const value = Number(st.lastIncomingAt);
              return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : start;
            };
            lastNewAt = incomingAt();
            let observedSeq = st.lastUnreadSeq || 0;
            // Batch delay and model reading time already count towards quiet.
            // New arrivals restart quiet, but timeoutMs remains a hard budget.
            while (!aborted && Date.now() - start < timeoutMs) {
              if ((st.lastUnreadSeq || 0) !== observedSeq) {
                observedSeq = st.lastUnreadSeq || 0;
                lastNewAt = incomingAt();
              }
              const remaining = quietMs - (Date.now() - lastNewAt);
              if (remaining <= 0) break;
              await sleep(Math.max(1, Math.min(100, remaining, timeoutMs - (Date.now() - start))));
            }
            // A message may arrive during the final sleep, exactly at timeout.
            // Its timestamp must still invalidate the previous quiet window.
            lastNewAt = incomingAt();
            arrived = (st.lastUnreadSeq || 0) > baseline;
          } else while (Date.now() - start < timeoutMs && !aborted) {
            let nowSeq = st.lastUnreadSeq || 0;
            if (nowSeq - baseline >= minNew) {
              arrived = true;
              lastNewAt = Date.now();
              // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
              // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
              while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
                if ((st.lastUnreadSeq || 0) > nowSeq) {
                  nowSeq = st.lastUnreadSeq || 0;
                  lastNewAt = Date.now();
                }
                await sleep(200);
              }
              break;
            }
            await sleep(300);
          }
          const waitedMs = Date.now() - start;
          if (socialV2.conversations.get(canonicalV2Key(key)) !== st ||
              (waitToken && (S.currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false
                || !waitTokenStillOk() || !v2SessionAllowed(key) || !v2ToolEnabled('waitMessages')))) {
            finishWait();
            sendJson({ ok: false, error: '等待期间会话已重置或权限已变化，请重新读取会话' }, 403);
            return;
          }
          const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
          const preSleepRemainingMs = preSleepWaitBlockedV2(st)
            ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
            : 0;
          const quiet = (replyWait || (arrived && quietMs > 0)) && (Date.now() - lastNewAt >= quietMs);
          // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
          // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
          const preSleepAttempt = !replyWait && timeoutMs >= preSleepWaitMs;
          // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
          // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
          const preSleepSatisfiedNow = !replyWait && (!arrived
            ? waitedMs >= preSleepWaitMs
            : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs));
          if (preSleepSatisfiedNow) {
            st.preSleepWaitSatisfiedAt = Date.now();
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait && !arrived) {
            // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait) {
            // 等待期间有新消息：
            // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
            // - 否则只清空累计，不算完成沉睡前观察。
            if (preSleepAttempt) {
              st.preSleepWaitObservedAt = Date.now();
            }
            st.preSleepWaitAccumMs = 0;
          }
          if (!replyWait) saveSocialV2State();
          // Each buffer is governed by its own tool switch: the unread buffer by
          // getUnread, the recent buffer by getRecent. A disabled switch must not leak
          // through either newMessages or the watermark, so the buffer is dropped
          // before arrival is judged -- not filtered afterwards.
          const history = replyWait
            ? [...(v2ToolEnabled('getUnread') ? st.unread : []),
              ...(v2ToolEnabled('getRecent') ? st.recentMessages : [])]
            : (Array.isArray(st.recentMessages) ? st.recentMessages : []);
          const pending = [...new Map(history
            .filter((m) => m && !m.isSelf && (m.seq || 0) > baseline)
            .map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);
          // `arrived` is recomputed against what this request may actually hand over,
          // so a suppressed buffer cannot report an arrival it is not allowed to show.
          const newMessages = replyWait ? pending : (arrived ? pending : []);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, newMessages) : readThroughSeqV2(st);
          const lastNew = newMessages.length ? newMessages[newMessages.length - 1]
            : replyWait ? [...st.recentMessages].reverse().find((m) => m && !m.isSelf) : null;
          const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
          finishWait();
          sendJson({
            ok: true,
            key,
            purpose: replyWait ? 'reply' : 'messages',
            arrived,
            quiet,
            quietMs,
            suggestedQuietMs,
            speakerLikelyDone: quiet,
            lastMessageUnfinished,
            timeout: replyWait ? !quiet : !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
            waitedMs,
            preSleepWaitSatisfied: preSleepSatisfiedNow,
            preSleepWaitObserved: !replyWait && !!st.preSleepWaitObservedAt,
            // A reply check has no sleep countdown; showing one here suggests
            // the model should complete sleep observation before its first reply.
            ...(!replyWait ? { preSleepWaitMs, preSleepWaitRemainingMs: preSleepRemainingMs } : {}),
            newMessages,
            readThroughSeq,
            unreadCount: st.unread.length
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const tool = String(body.tool ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!key || !tool || !token) {
            sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
            return;
          }
          if (!agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (!v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
          const flag = flagMap[tool];
          if (!flag) {
            sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
            return;
          }
          if (!v2ToolEnabled(flag)) {
            sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
            return;
          }
          sendJson({ ok: true, key, tool });
          return;
        }
        // ── Token 用量 / 花费（控制台专用） ──────────────────────────────────
        // 路径刻意不放在 /api/socialV2/ 下：那一整个前缀对持有 x-agent-token 的
        // QQ 侧 AI 是放行的（见上方 agentAllowed 白名单），而跨群花费属于管理信息，
        // 不应让某个群里的 AI 读到别的群烧了多少钱。这里再显式拒绝一次做双保险。
        if (url.pathname === '/api/tokens/summary' || url.pathname.startsWith('/api/tokens/')) {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          if (req.method === 'GET' && url.pathname === '/api/tokens/summary') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            sendJson({ ...tokenLedger.summary({ limit }), ledger: tokenLedger.stats() });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/series') {
            const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
            const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
            sendJson(tokenLedger.series({ hours, maxBuckets }));
            return;
          }
          // [patch 花费快查] 单日 / 单月花费汇总：直接扫 state/token-usage.jsonl 的逐轮采样，
          // 逐条按「采样时刻 + 当时的模型」用价目表折算（高峰/空闲价自动区分）。
          // 只统计 k:"turn" 行；k:"base" 是接入账本前的历史基线，没有时间归属，不算进某一天。
          if (req.method === 'GET' && url.pathname === '/api/tokens/report') {
            const period = String(url.searchParams.get('period') ?? 'day').toLowerCase() === 'month' ? 'month' : 'day';
            const nowDate = new Date();
            let fromMs = 0;
            let toMs = 0;
            let label = '';
            let granularity = 'hour';
            if (period === 'month') {
              const m = /^(\d{4})-(\d{1,2})$/.exec(String(url.searchParams.get('month') ?? ''));
              const y = m ? Number(m[1]) : nowDate.getFullYear();
              const mo = m ? Number(m[2]) - 1 : nowDate.getMonth();
              fromMs = new Date(y, mo, 1).getTime();
              toMs = new Date(y, mo + 1, 1).getTime();
              label = y + '-' + String(mo + 1).padStart(2, '0');
              granularity = 'day';
            } else {
              const d = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(url.searchParams.get('date') ?? ''));
              const y = d ? Number(d[1]) : nowDate.getFullYear();
              const mo = d ? Number(d[2]) - 1 : nowDate.getMonth();
              const day = d ? Number(d[3]) : nowDate.getDate();
              fromMs = new Date(y, mo, day).getTime();
              toMs = new Date(y, mo, day + 1).getTime();
              label = y + '-' + String(mo + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
            }
            const totals = { cost: 0, cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0, steps: 0 };
            const bucketMap = new Map();
            const byKey = new Map();
            const byModel = new Map();
            const turnSet = new Set();
            let raw = '';
            try { raw = fs.readFileSync(TOKEN_USAGE_FILE, 'utf8'); } catch (error) { log('[花费快查] 读账本失败：' + (error?.message ?? error)); }
            for (const line of raw.split('\n')) {
              if (!line) continue;
              let rec = null;
              try { rec = JSON.parse(line); } catch { continue; }
              if (!rec || rec.k !== 'turn') continue;
              const at = Number(rec.t) || 0;
              if (at < fromMs || at >= toMs) continue;
              const b = rec.b || {};
              let cost = 0;
              try { cost = Number(priceUsage(b, { model: rec.model, at, table: priceTable }).cost?.total) || 0; } catch { cost = 0; }
              const tokens = (Number(b.cacheMiss) || 0) + (Number(b.cacheHit) || 0) + (Number(b.cacheWrite) || 0) + (Number(b.output) || 0) + (Number(b.reasoning) || 0);
              totals.cost += cost;
              totals.cacheMiss += Number(b.cacheMiss) || 0;
              totals.cacheHit += Number(b.cacheHit) || 0;
              totals.cacheWrite += Number(b.cacheWrite) || 0;
              totals.output += Number(b.output) || 0;
              totals.reasoning += Number(b.reasoning) || 0;
              totals.steps += 1;
              if (rec.sid && rec.turn !== undefined) turnSet.add(rec.sid + '#' + rec.turn);
              const dObj = new Date(at);
              const bi = granularity === 'day' ? dObj.getDate() - 1 : dObj.getHours();
              const cur = bucketMap.get(bi) || { cost: 0, tokens: 0, steps: 0 };
              cur.cost += cost; cur.tokens += tokens; cur.steps += 1;
              bucketMap.set(bi, cur);
              const kName = rec.key || '未归属';
              const kb = byKey.get(kName) || { key: kName, cost: 0, tokens: 0, steps: 0 };
              kb.cost += cost; kb.tokens += tokens; kb.steps += 1;
              byKey.set(kName, kb);
              const mName = rec.model || '未知';
              const mb = byModel.get(mName) || { model: mName, cost: 0, tokens: 0, steps: 0 };
              mb.cost += cost; mb.tokens += tokens; mb.steps += 1;
              byModel.set(mName, mb);
            }
            const bucketCount = granularity === 'day' ? Math.round((toMs - fromMs) / 86400000) : 24;
            const series = Array.from({ length: bucketCount }, (_, i) => ({
              // 按天：i=0 是 1 号；按小时：i=0 是 00 点。标签别统一 +1，否则小时图整体错一格。
              label: granularity === 'day' ? String(i + 1).padStart(2, '0') : String(i).padStart(2, '0'),
              ...(bucketMap.get(i) || { cost: 0, tokens: 0, steps: 0 })
            }));
            const inputTokens = totals.cacheMiss + totals.cacheHit + totals.cacheWrite;
            sendJson({
              ok: true,
              period,
              label,
              granularity,
              from: new Date(fromMs).toISOString(),
              to: new Date(toMs).toISOString(),
              totals: {
                ...totals,
                tokens: inputTokens + totals.output + totals.reasoning,
                inputTokens,
                turns: turnSet.size,
                cacheHitRate: inputTokens > 0 ? totals.cacheHit / inputTokens : 0
              },
              series,
              byKey: [...byKey.values()].sort((a, b) => b.cost - a.cost),
              byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost)
            });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/turns') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            const detail = tokenLedger.conversation(key, { turnLimit: limit });
            if (!detail) { sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return; }
            sendJson(detail);
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/recent') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
            sendJson({ ok: true, symbol: priceTable.symbol, entries: tokenLedger.recent(limit) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/tokens/reset') {
            tokenLedger.reset();
            log('控制台：token 用量账本已重置');
            sendJson({ ok: true });
            return;
          }
          sendJson({ ok: false, error: 'not found' }, 404);
          return;
        }
        // ── 工具调用日志 ─────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
          sendJson({ ok: true, entries: readToolLog(limit) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
          log('控制台：工具调用日志已清空');
          sendJson({ ok: true });
          return;
        }
        // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
        // ── 轻量随机游戏（抽签 / 掷骰 / 猜拳 / 投币）─────────────────────
        // POST /api/socialV2/light-game { game, spec?, mine?, hers?, pool? }
        //
        // 为什么放在服务端而不是让模型自己随机：LLM 模拟随机性很差
        // （偏好 7 / 26 / 42，骰子容易连着出同一面），群里几轮就会被看出是假的。
        // 这里用 crypto 真随机，模型只负责把结果说得有趣。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/light-game') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('lightGame')) { sendJson({ ok: false, error: '工具未启用：qq_light_game' }, 403); return; }
          // 限频：游戏是娱乐性质，不需要也不可能一秒几十次。防的是循环里
          // 反复调（模型有时候会"多抽几次挑一个喜欢的"，那本质是在作弊）。
          const gNow = Date.now();
          const gTimes = lightGameTimes.get(key) || [];
          const gRecentMinute = gTimes.filter((t) => gNow - t < 60000).length;
          if (gRecentMinute >= 30) {
            sendJson({ ok: false, error: '玩得太频繁了，缓一缓（每分钟最多 30 次）' }, 429);
            return;
          }
          gTimes.push(gNow);
          lightGameTimes.set(key, gTimes.slice(-200));
          try {
            const result = playLightGame(body.game, {
              spec: body.spec,
              mine: body.mine,
              hers: body.hers,
              pool: body.pool,
            });
            const text = renderLightGame(result);
            appendActivity(`${key} [游戏] ${body.game} → ${text}`);
            log(`[light-game] ${key} ${body.game} → ${text}`);
            sendJson({ ok: true, key, game: String(body.game ?? ''), result, text });
          } catch (error) {
            sendJson({ ok: false, error: error?.message || String(error) }, 400);
          }
          return;
        }
        // ── 回合制小游戏（猜数字 / 二十问 / 海龟汤）──────────────────────
        // POST /api/socialV2/turn-game { action, game?, max?, guess?, question?, answer?, puzzleIndex? }
        // 状态存在 st.turnGame，跨消息保留。为什么放服务端而不是让模型自己记：
        // 猜数字答案/海龟汤汤底一旦进提示词，模型会忍不住剧透。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/turn-game') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('turnGame')) { sendJson({ ok: false, error: '工具未启用：qq_turn_game' }, 403); return; }
          // 限频：防模型在循环里反复 move（刷问/刷猜）把一局瞬间跑完。
          const tgNow = Date.now();
          const tgTimes = turnGameTimes.get(key) || [];
          if (tgTimes.filter((t) => tgNow - t < 60000).length >= 60) {
            sendJson({ ok: false, error: '操作太频繁，缓一缓（每分钟最多 60 次）' }, 429);
            return;
          }
          tgTimes.push(tgNow);
          turnGameTimes.set(key, tgTimes.slice(-300));
          const st = getSocialV2State(key);
          try {
            const action = String(body.action || 'move');
            let result;
            if (action === 'start') {
              st.turnGame = startTurnGame({ game: body.game, max: body.max, puzzleIndex: body.puzzleIndex });
              result = { ok: true, action, state: st.turnGame, text: renderTurnGame(st.turnGame) };
            } else if (action === 'quit') {
              const prev = st.turnGame;
              st.turnGame = null;
              result = { ok: true, action: 'quit', text: '已结束本局游戏。', surface: prev?.surface };
            } else if (action === 'state') {
              result = { ok: true, action: 'state', state: st.turnGame || null, text: st.turnGame ? renderTurnGame(st.turnGame) : '（没有进行中的游戏）' };
            } else {
              if (!st.turnGame) { sendJson({ ok: false, error: '没有进行中的游戏，先用 action=start 开局' }, 400); return; }
              st.turnGame = playTurnGame(st.turnGame, { action: 'move', guess: body.guess, question: body.question, answer: body.answer });
              result = { ok: true, action: 'move', state: st.turnGame, text: renderTurnGame(st.turnGame) };
            }
            saveSocialV2State();
            appendActivity(`${key} [回合游戏] ${action} → ${result.text}`);
            sendJson(result);
          } catch (error) {
            sendJson({ ok: false, error: error?.message || String(error) }, 400);
          }
          return;
        }
        // ── 群内小工具（投票 / 抽签决定）────────────────────────────────
        // POST /api/socialV2/group-tools { action, ... }
        //   action=start_poll  { options:[...], title?, dueMs? }  开投票
        //   action=vote        { choice:1..N, voter }             投票/改票
        //   action=close_poll                                      结束并计票
        //   action=tally                                           看当前票数
        //   action=decide      { options:[...] }                   抽签决定
        // 计票与随机都在服务端算 —— 交给模型会漏票、算错、"2:2 说她赢了"。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/group-tools') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('groupTools')) { sendJson({ ok: false, error: '工具未启用：qq_group_tools' }, 403); return; }
          const gtNow = Date.now();
          const gtTimes = groupToolsTimes.get(key) || [];
          if (gtTimes.filter((t) => gtNow - t < 60000).length >= 40) {
            sendJson({ ok: false, error: '操作太频繁，缓一缓（每分钟最多 40 次）' }, 429);
            return;
          }
          gtTimes.push(gtNow);
          groupToolsTimes.set(key, gtTimes.slice(-200));
          const st = getSocialV2State(key);
          try {
            const action = String(body.action || '').trim();
            let result;
            if (action === 'start_poll') {
              st.poll = startPoll({ options: body.options, title: body.title, dueMs: body.dueMs });
              result = { ok: true, action, poll: st.poll, text: renderPoll(st.poll) };
            } else if (action === 'vote') {
              const r = castVote(st.poll, { choice: body.choice, voter: body.voter });
              result = { ok: true, action, changed: r.changed, first: r.wasFirst, poll: st.poll, text: renderPoll(st.poll) };
            } else if (action === 'close_poll') {
              const t = closePoll(st.poll);
              result = { ok: true, action, tally: t, text: renderPoll(st.poll, t) };
            } else if (action === 'tally') {
              const t = tallyPoll(st.poll);
              result = { ok: true, action, tally: t, text: renderPoll(st.poll, t) };
            } else if (action === 'decide') {
              const r = decideAmong(body.options);
              result = { ok: true, action, result: r, text: renderDecide(r) };
            } else {
              sendJson({ ok: false, error: 'action 必须是 start_poll / vote / close_poll / tally / decide' }, 400);
              return;
            }
            saveSocialV2State();
            appendActivity(`${key} [群内工具] ${action} → ${result.text}`);
            sendJson(result);
          } catch (error) {
            sendJson({ ok: false, error: error?.message || String(error) }, 400);
          }
          return;
        }
        // ── 音乐分享链接（给音乐 app 的真实跳转/搜索链接，不伪造卡片）────────
        // POST /api/socialV2/music-share { platform?, song?, artist?, id? }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/music-share') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('musicShare')) { sendJson({ ok: false, error: '工具未启用：qq_music_share' }, 403); return; }
          try {
            const r = buildMusicShare({ platform: body.platform, song: body.song, artist: body.artist, id: body.id });
            appendActivity(`${key} [音乐分享] ${r.platform} ${r.label}`);
            sendJson({ ok: true, key, ...r, text: renderMusicShare(r) });
          } catch (error) {
            sendJson({ ok: false, error: error?.message || String(error) }, 400);
          }
          return;
        }
        // POST /api/socialV2/mood-log { key, who, mood, note?, anonymous? } —— 心情打卡 / 树洞
        // 群友在群里说"今天好累""有点开心"时，她顺手替对方记一笔；之后树洞/关心都靠这个。
        // 树洞（anonymous=true）只记 content、不记名：连她自己回头看也只能看到"有人说过"。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mood-log') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('moodLog')) { sendJson({ ok: false, error: '工具未启用：qq_mood_log' }, 403); return; }
          const mood = String(body.mood ?? '').trim();
          if (!MOOD_KINDS_V2.includes(mood)) {
            sendJson({ ok: false, error: `mood 必须是：${MOOD_KINDS_V2.join(' / ')}` }, 400);
            return;
          }
          const note = truncateText(String(body.note ?? '').trim(), 160);
          if (!note) { sendJson({ ok: false, error: 'note 不能为空（写点具体的事）' }, 400); return; }
          const anonymous = body.anonymous === true;
          const who = anonymous ? '' : String(body.who ?? '').trim().slice(0, 40);
          // 限频：防止刷磁盘/日志。
          const mNow = Date.now();
          const mTimes = moodTimes.get(key) || [];
          if (mTimes.filter((t) => mNow - t < 60000).length >= 20) { sendJson({ ok: false, error: '心情打卡过于频繁，请稍后再试' }, 429); return; }
          mTimes.push(mNow);
          moodTimes.set(key, mTimes.slice(-100));
          const mdbRef = memoryDbEnabled() ? memoryDb() : null;
          if (!mdbRef || typeof mdbRef.recordMoodEvent !== 'function') { sendJson({ ok: false, error: '记忆库未启用' }, 503); return; }
          const rec = mdbRef.recordMoodEvent({
            key,
            mood,
            summary: anonymous ? note : (who ? `${who}：${note}` : note),
            participants: anonymous ? [] : (who ? [who] : []),
            at: mNow
          });
          if (!rec) { sendJson({ ok: false, error: '记录失败' }, 500); return; }
          appendActivity(`${key} [心情] ${MOOD_LABELS_V2[mood] || mood}${anonymous ? '（树洞）' : (who ? ` by ${who}` : '')}`);
          log(`[心情] ${key} 记一笔 ${mood}${anonymous ? '（匿名）' : ''}`);
          sendJson({ ok: true, key, mood, label: MOOD_LABELS_V2[mood] || mood, anonymous, who: anonymous ? '' : who, at: rec.at });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
          sendJson({ ok: true, entries: readFeedbackEntries() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          atomicWriteJson(FEEDBACK_FILE, []);
          log('控制台：清空 AI 反馈');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
          const rawMessage = String(body.message ?? '').trim();
          if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
          // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
          const fNow = Date.now();
          const fTimes = feedbackTimes.get(key) || [];
          const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
          const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
          if (fRecentMinute >= 5 || fRecentHour >= 20) {
            sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
            return;
          }
          fTimes.push(fNow);
          feedbackTimes.set(key, fTimes.slice(-100));
          const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
          const message = truncateText(rawMessage, maxLength);
          appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
          log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
          appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
          if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
            log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
          }
          sendJson({ ok: true, key, level, message });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
          sendJson({ ok: true, key, messages: mine, readThroughSeq: readThroughSeqV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          try {
            const st = getSocialV2State(key);
            const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
            const forwardFields = found ? {
              forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
              hasForward: !!found.hasForward
            } : {};
            let info = null;
            // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
            if (found && found.messageId && String(found.messageId) !== messageId) {
              info = {
                sender: String(found.sender || ''),
                text: String(found.text || found.plain || '').slice(0, 200),
                userId: found.userId ? String(found.userId) : null,
                messageId: String(found.messageId),
                seq: found.seq
              };
            } else {
              info = await resolveReplyInfo(kind, id, messageId);
              if (!info && found) {
                info = {
                  sender: String(found.sender || ''),
                  text: String(found.text || found.plain || '').slice(0, 200),
                  userId: found.userId ? String(found.userId) : null,
                  messageId: found.messageId ? String(found.messageId) : null,
                  seq: found.seq
                };
              }
            }
            // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
            if (info && found) Object.assign(info, forwardFields);
            // 正文本就是 200 字符预览；显式告知截断，避免模型把预览当成全文。
            if (info) info.textTruncated = String(info.text ?? '').length >= 200;
            sendJson({ ok: true, key, messageId, info });
          } catch (error) {
            sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const id = String(url.searchParams.get('id') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          if (S.currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
            return;
          }
          if (!agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const num = Number(keyMatch[2]);
          if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, S.currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (!v2ToolEnabled('getForwardMsg')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
            return;
          }
          // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
          const st = getSocialV2State(key);
          const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
          if (!seenInRecent && !seenInUnread && !seenInMemory) {
            sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
            return;
          }
          try {
            const data = await bot.raw('get_forward_msg', { id });
            const formatted = formatForwardResponse(data);
            const remember = (fid) => {
              if (!fid) return;
              let set = seenForwardIds.get(key);
              if (!set) {
                set = new Set();
                seenForwardIds.set(key, set);
              }
              set.add(fid);
              if (set.size > 1000) {
                for (const old of set) {
                  set.delete(old);
                  if (set.size <= 1000) break;
                }
              }
            };
            // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) remember(fid);
            }
            // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
            const nestedPreviews = [];
            const nestedIds = [];
            const seenNested = new Set();
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) {
                if (!seenNested.has(fid) && nestedIds.length < 5) {
                  seenNested.add(fid);
                  nestedIds.push(fid);
                }
              }
            }
            for (const fid of nestedIds) {
              try {
                const ndata = await bot.raw('get_forward_msg', { id: fid });
                const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                for (const nm of nfmt.messages || []) {
                  for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                }
                nestedPreviews.push({ id: fid, ...nfmt });
              } catch (error) {
                log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
                nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
              }
            }
            sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
          } catch (error) {
            log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const media = Array.isArray(body.media) ? body.media : [];
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return; }
          if (S.currentMode !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return; }
          if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, key, media, images });
          } catch (error) {
            log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return; }
          const st = getSocialV2State(key);
          const map = new Map();
          for (const m of st.recentMessages) {
            if (!m || m.isSelf) continue;
            const uid = m.userId ? String(m.userId) : '';
            const key2 = uid || String(m.sender || '未知');
            const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
            if (!cur.userId && uid) cur.userId = uid;
            cur.count += 1;
            if (m.time > cur.lastTime) cur.lastTime = m.time;
            if (m.isOwner) cur.isOwner = true;
            map.set(key2, cur);
          }
          const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
          sendJson({ ok: true, key, members });
          return;
        }
        if (url.pathname === '/api/socialV2/db' && req.method === 'GET') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const mdb = memoryDb();
          if (!mdb) { sendJson({ ok: false, error: '长期记忆库未启用' }, 503); return; }
          const st = key ? getSocialV2State(key) : null;
          const digest = key ? mdb.buildDigest({ key, st, maxChars: Number(cfg.socialV2?.memoryDb?.maxChars) || 800 }) : '';
          const interest = key && st
            ? mdb.buildInterestBlock({
                text: (st.recentMessages || []).filter((x) => x && !x.isSelf).slice(-12).map((x) => String(x.text ?? '')).join(' ').slice(0, 1500),
                maxChars: Number(cfg.socialV2?.memoryDb?.interestMaxChars) || 420
              })
            : '';
          sendJson({ ok: true, key, stats: mdb.stats(), people: mdb.recentPeople(30), digest, interest });
          return;
        }
        if (url.pathname === '/api/socialV2/db-search' && req.method === 'GET') {
          const mdb = memoryDb();
          if (!mdb) { sendJson({ ok: false, error: '长期记忆库未启用' }, 503); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          sendJson({ ok: true, key, q, results: mdb.search({ key, q, limit }) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/db-note') {
          const body = await readBody();
          const mdb = memoryDb();
          if (!mdb) { sendJson({ ok: false, error: '长期记忆库未启用' }, 503); return; }
          const text = redactKnownTokensOnly(String(body.text ?? '')).trim();
          if (!text) { sendJson({ ok: false, error: 'text 不能为空' }, 400); return; }
          const id = mdb.recordFact({
            scope: String(body.scope ?? (body.subject ? 'person' : 'global')),
            subject: String(body.subject ?? ''),
            text,
            tags: String(body.tags ?? 'manual'),
            source: 'console'
          });
          sendJson({ ok: true, id, stats: mdb.stats() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/db-person') {
          const body = await readBody();
          const mdb = memoryDb();
          if (!mdb) { sendJson({ ok: false, error: '长期记忆库未启用' }, 503); return; }
          const idRaw = String(body.id ?? '').trim();
          if (!idRaw) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          const pid = mdb.setPerson({ id: idRaw, nickname: body.nickname ? String(body.nickname) : null, relation: body.relation ? String(body.relation) : null, note: body.note ? redactKnownTokensOnly(String(body.note)) : null });
          if (body.fact) mdb.recordFact({ scope: 'person', subject: pid, text: redactKnownTokensOnly(String(body.fact)), tags: 'manual', source: 'console' });
          sendJson({ ok: true, id: pid, stats: mdb.stats() });
          return;
        }
        if (url.pathname === '/api/socialV2/db-lexicon' && req.method === 'GET') {
          const mdb = memoryDb();
          if (!mdb) { sendJson({ ok: false, error: '长期记忆库未启用' }, 503); return; }
          sendJson({ ok: true, lexicon: mdb.listLexicon(Math.min(1000, Number(url.searchParams.get('limit')) || 400)) });
          return;
        }
        if (url.pathname === '/api/socialV2/db-anime') {
          const mdb = memoryDb();
          if (!mdb) { sendJson({ ok: false, error: '长期记忆库未启用' }, 503); return; }
          if (req.method === 'GET') {
            const q = String(url.searchParams.get('q') ?? '').trim();
            const limit = Math.min(1000, Number(url.searchParams.get('limit')) || 300);
            sendJson({ ok: true, q, anime: q ? mdb.searchAnime(q, limit) : mdb.listAnime(limit) });
            return;
          }
          const abody = await readBody();
          const title = mdb.addAnime({
            title: String(abody.title ?? ''),
            aliases: String(abody.aliases ?? ''),
            kind: String(abody.kind ?? ''),
            tags: String(abody.tags ?? ''),
            summary: String(abody.summary ?? ''),
            moments: String(abody.moments ?? ''),
            take: String(abody.take ?? '')
          });
          sendJson({ ok: !!title, title });
          return;
        }
        // [patch 日记] 她的小记：GET 翻/搜，POST 写一条。工具 qq_diary 直接打这里。
        if (url.pathname === '/api/socialV2/db-diary') {
          if (req.headers['x-agent-token'] && !v2ToolEnabled('diary')) { sendJson({ ok: false, error: '工具未启用：qq_diary' }, 403); return; }
          const mdb = memoryDb();
          if (!mdb) { sendJson({ ok: false, error: '长期记忆库未启用' }, 503); return; }
          if (req.method === 'GET') {
            const q = String(url.searchParams.get('q') ?? '').trim();
            const key = String(url.searchParams.get('key') ?? '').trim();
            const limit = Math.min(200, Number(url.searchParams.get('limit')) || 20);
            const rows = mdb.listDiary({ key, q, limit });
            sendJson({ ok: true, q, key, day: diaryClockV2().date, stats: mdb.diaryStats(), diary: rows });
            return;
          }
          const dbody = await readBody();
          const action = String(dbody.action ?? 'append').trim().toLowerCase();
          if (action !== 'append') { sendJson({ ok: false, error: `不支持的动作：${action}（只有 append；翻/搜用 GET）` }, 400); return; }
          const text = String(dbody.text ?? '').trim();
          if (!text) { sendJson({ ok: false, error: 'text 不能为空' }, 400); return; }
          const entry = mdb.addDiary({
            key: canonicalV2Key(String(dbody.key ?? '').trim()) || '',
            text,
            tags: dbody.tags === undefined ? '日记' : String(dbody.tags),
            mood: String(dbody.mood ?? ''),
            source: 'self'
          });
          if (!entry) { sendJson({ ok: false, error: '写入失败（内容为空或数据库错误）' }, 500); return; }
          appendActivity(`日记：${entry.day} 写了一条小记（${entry.text.length} 字）`);
          log(`[日记] 她自己写了一条小记（${entry.day}，${entry.text.length} 字）`);
          sendJson({ ok: true, id: entry.id, day: entry.day, chars: entry.text.length, stats: mdb.diaryStats() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/db-lexicon') {
          const body = await readBody();
          const mdb = memoryDb();
          if (!mdb) { sendJson({ ok: false, error: '长期记忆库未启用' }, 503); return; }
          const term = mdb.addLexicon(String(body.term ?? ''), String(body.meaning ?? ''), String(body.usage ?? ''), {
            source: String(body.source ?? ''),
            examples: String(body.examples ?? ''),
            variants: String(body.variants ?? '')
          });
          sendJson({ ok: !!term, term });
          return;
        }
        if (url.pathname === '/api/socialV2/wake-preview' && req.method === 'GET') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!S.state.sessions || !S.state.sessions[key]) { sendJson({ ok: false, error: '该会话还没有映射的 DSH 会话' }, 404); return; }
          const reason = String(url.searchParams.get('reason') ?? '预览：只是为了看提示词').slice(0, 200);
          const askSlot = url.searchParams.get('slot') === 'b' ? 'b' : 'a';
          const slim = url.searchParams.get('slim') === '1';
          const prompt = buildWakePromptV2(key, reason, { slim, askSlot });
          const snapshot = buildWakeSnapshotV2(key);
          sendJson({ ok: true, key, chars: prompt.length, slim, askSlot, prompt, snapshot });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression', 'relation', 'mood', 'promise'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression / relation / mood / promise' }, 400); return; }
          if ((category === 'memberImpression' || category === 'relation') && !String(extra.target || '').trim()) { sendJson({ ok: false, error: category + ' 需要 extra.target 指定是谁' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
          const st = getSocialV2State(key);
          appendMemoryV2(st, category, content, extra, key);
          sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const oldContent = String(body.oldContent ?? '').trim();
          const target = redactKnownTokensOnly(String(body.target ?? '').trim());
          const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
          const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
          const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
          const cleanNewExtra = {
            ...newExtra,
            pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
            participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
            motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
            target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined,
            // [印象档案] 结构化字段同样过一遍脱敏（模型可能不小心把令牌写进来）
            birthday: newExtra.birthday !== undefined ? redactExtra(newExtra.birthday) : undefined,
            preferName: newExtra.preferName !== undefined ? redactExtra(newExtra.preferName) : undefined,
            avoid: newExtra.avoid !== undefined ? redactExtra(newExtra.avoid) : undefined
          };
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
            if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
            if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
            if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
            if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            const oldTarget = target;
            if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            const im = st.memberImpressions[oldTarget] || {};
            const newTarget = String(cleanNewExtra.target || oldTarget).trim();
            if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            if (newContent !== undefined) {
              im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
            }
            if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
            // [印象档案] 结构化字段也允许直接编辑（模型想改生日/称呼/雷点，不用删了重建）
            if (cleanNewExtra.birthday !== undefined) im.birthday = pickImpressionField(cleanNewExtra.birthday, im.birthday, 10);
            if (cleanNewExtra.preferName !== undefined) im.preferName = pickImpressionField(cleanNewExtra.preferName, im.preferName, 20);
            if (cleanNewExtra.avoid !== undefined) im.avoid = pickImpressionField(cleanNewExtra.avoid, im.avoid, 40);
            if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
            st.memberImpressions[newTarget] = im;
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const category = String(url.searchParams.get('category') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
          const st = getSocialV2State(key);
          const raw = {
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
            pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
            memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
            promises: Array.isArray(st.promises) ? st.promises.slice(-40) : []
          };
          if (category === 'activeTopic') {
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
            raw.promises = [];
          } else if (category === 'pendingThought') {
            raw.activeTopics = [];
            raw.memberImpressions = {};
            raw.promises = [];
          } else if (category === 'memberImpression') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
            raw.promises = [];
          } else if (category === 'promise') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
          }
          sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }), raw });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression', 'relation', 'mood', 'promise'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression / relation / mood / promise' }, 400); return; }
          if ((category === 'memberImpression' || category === 'relation') && !target) { sendJson({ ok: false, error: category + ' 需要 target 指定是谁' }, 400); return; }
          if ((category === 'memberImpression' || category === 'relation') && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的名字' }, 400); return; }
          if (!['memberImpression', 'relation', 'mood'].includes(category) && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            delete st.memberImpressions[target];
          } else if (category === 'promise' && Array.isArray(st.promises)) {
            st.promises = st.promises.filter((p) => String(p?.text ?? '') !== content);
          } else if (category === 'relation') {
            // 忘掉跟某一个人的关系：镜像和 relations 表一起删。
            const relName = normalizeImpressionTarget(target).name;
            if (relName && st.relations && typeof st.relations === 'object') delete st.relations[relName];
            const mdbRel = memoryDb();
            if (mdbRel && relName && typeof mdbRel.removeRelation === 'function') mdbRel.removeRelation(relationPidForV2(relName));
          } else if (category === 'mood') {
            // 「这条心情过去了」：清掉备注与按压，交回作息。
            const ms = readMoodState();
            ms.note = '';
            ms.holdUntil = 0;
            ms.updatedAt = Date.now();
            saveMoodState();
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression', 'promise', 'mood'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression / promise / mood' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }
          const st = getSocialV2State(key);
          if (!category || category === 'activeTopic') st.activeTopics = [];
          if (!category || category === 'pendingThought') st.pendingThoughts = [];
          if (!category || category === 'memberImpression') st.memberImpressions = {};
          if (!category || category === 'promise') st.promises = [];
          if (category === 'mood') {
            const ms = readMoodState();
            ms.note = '';
            ms.holdUntil = 0;
            ms.updatedAt = Date.now();
            saveMoodState();
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st), relations: relationLineV2(key, 12).trim() });
          return;
        }
        // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return; }
          const list = confirmedSlangListV2().filter((e) => {
            if (!q) return true;
            return e.content.toLowerCase().includes(q)
              || e.meaning.toLowerCase().includes(q)
              || e.usage.toLowerCase().includes(q)
              || e.example.toLowerCase().includes(q);
          });
          sendJson({
            ok: true,
            key,
            total: list.length,
            entries: list,
            block: buildSlangContext(S.slangEntries, slangInjectMax, slangInjectChars)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
          const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return; }
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return; }
          if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
          if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return; }
          if (!allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return; }
          const existing = S.slangEntries.find((e) => e.content === content);
          if (existing) {
            if (existing.status === SLANG_STATUS.CONFIRMED) {
              sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing) });
              return;
            }
            if (existing.status === SLANG_STATUS.REJECTED) {
              sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
              return;
            }
            // candidate：累计出现次数并追加语境证据
            existing.count = (Number(existing.count) || 0) + 1;
            if (context) {
              existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
            }
            existing.updatedAt = new Date().toISOString();
            saveSlangStore();
            if (cfg.slang?.autoResearch !== false) {
              const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
              if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
                queueSlangTask(() => runSlangResearch([existing]));
              }
            }
            log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
            sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing) });
            return;
          }
          const entry = createSlangEntry({
            content,
            source: 'ai',
            status: SLANG_STATUS.CANDIDATE,
            evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
          });
          S.slangEntries.push(entry);
          saveSlangStore();
          if (cfg.slang?.autoResearch !== false) {
            queueSlangTask(() => runSlangResearch([entry]));
          }
          log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
          appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
          sendJson({ ok: true, entry: publicSlangEntry(entry) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!token || !agentTokenOk(key, token)) {
            // 空 token 一律拒绝：该端点对 agent 流量开放（见 startConsoleServer 里的
            // agent 白名单），而 MCP 的 agentApi 总是带着真实控制台令牌，
            // 所以「不传 token 就跳过校验」等于把它变成免鉴权端点。
            sendJson({ ok: false, error: token ? 'agent token 无效' : '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的 v2 读工具' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, S.currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          sendJson({ ok: true, key });
          return;
        }
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/images/message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (S.currentMode === 'reserved2' && !agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
            return;
          }
          if (S.currentMode === 'chat' || S.currentMode === 'reserved') {
            sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
            return;
          }
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, S.currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (agentToken && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          if (!agentToken && S.currentMode === 'closed-agent' && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          const media = findMessageMedia(key, messageId);
          if (!media.length) {
            sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
            return;
          }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, messageId, media, images });
          } catch (error) {
            log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
        if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
          const body = await readBody();
          const token = String(body.token ?? '').trim();
          const isPrivate = url.pathname === '/api/send/private';
          const isReply = url.pathname === '/api/send/reply';
          const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
          const message = unquoteJsonString(String(body.message ?? '').trim());
          // 引用 id 与端点无关：/api/send/reply 与另两个端点都允许带（是否真的引用由下游按 id 判断）。
          // 旧写法 `isReply ? body.replyToMessageId : body.replyToMessageId` 两个分支一模一样，
          // 保留 isReply 变量只是为了下面的端点语义判断，别再让人以为这里有过分支逻辑。
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
          // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用；
          // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
          if (S.currentMode === 'chat' || S.currentMode === 'reserved') {
            sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
            return;
          }
          if (socialV2.paused && token) {
            sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
            return;
          }
          if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
          if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
            sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
            return;
          }
          if (S.currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
          if (token && !v2ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return; }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, S.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          try {
            const st = getSocialV2State(key);
            const now = Date.now();
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
            appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, 1 - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/session/reset') {
          const body = await readBody();
          const key = String(body.key ?? '');
          if (!key || !S.state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
          S.sessionEpoch++;
          const oldSessionId = S.state.sessions[key];
          delete S.state.sessions[key];
          modelAppliedSessions.delete(oldSessionId);
          // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
          delete S.state.sessionPolicies[key];
          reverse.delete(oldSessionId);
          collectors.delete(oldSessionId);
          sendToolSucceededSessions.delete(oldSessionId);
          pendingSendToolCalls.delete(oldSessionId);
          v2TurnStartAt.delete(oldSessionId);
          toolCallNames.delete(oldSessionId);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          social.silentTurns.delete(oldSessionId);
          social.exitingSessions.delete(oldSessionId);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          forgetAgentToken(key);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
          try { await api.stopSessionWork(oldSessionId); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await api.workspace.archiveSession({ sessionId: oldSessionId }); } catch {}
          log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
          sendJson({ ok: true, key, archived: oldSessionId });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
          S.sessionEpoch++;
          let archivedCount = 0;
          let stoppedCount = 0;
          try {
            // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
            // 只处理 cwd 位于 qq-bridge state/ 下的根会话；子代理会话由父会话管理，不能误归档。
            const list = unwrap(await api.sessions.list({}), 'session.list');
            const stateDir = path.resolve(STATE_DIR);
            const statePrefix = path.normalize(stateDir + path.sep);
            const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
            const isUnderState = (cwd) => process.platform === 'win32'
              ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
              : cwd.startsWith(statePrefix);
            for (const item of list.items ?? []) {
              if (item.origin === 'subagent' || item.parentSessionId) continue;
              const cwd = normPath(item.cwd);
              if (isUnderState(cwd)) {
                // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
                try { await api.stopSessionWork(item.sessionId); stoppedCount += 1; }
                catch (error) { log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
                try { await api.workspace.archiveSession({ sessionId: item.sessionId }); archivedCount += 1; } catch {}
              }
            }
          } catch {}
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            cancelPendingEntry(entry).catch(() => {});
          }
          pending.clear();
          queued.clear();
          queuedHintAt.clear();
          sessionPromises.clear();
          drainAllPromptQueues('工作区已清空');
          social.states.clear();
          social.recentMessages.clear();
          messageMediaStore.clear();
          seenForwardIds.clear();
          social.pendingSummaries.clear();
          social.silentContext.clear();
          social.silentTurns.clear();
          social.exitingSessions.clear();
          slangWindows.clear();
          slangExtractionCooldowns.clear();
          slangSubmitTimes.clear();
          cancelAllSocialTimers();
          clearAllSocialV2Timers();
          // 清空工作区 = 所有会话连同 token 一起作废，两张表整体清掉（比逐会话摘除更不容易漏）。
          socialV2.conversations.clear();
          CONVERSATION_TOKENS.clear();
          KNOWN_AGENT_TOKENS.clear();
          saveSocialV2State();
          S.state.sessions = {};
          S.state.sessionPolicies = {};
          // [并发] 第二槽位会话也在同一个工作区里，一起作废（否则会留着旧 cwd 的会话）。
          S.state.auxSessions = {};
          pendingAskClaimsV2.clear();
          reverse.clear();
          collectors.clear();
          sendToolSucceededSessions.clear();
          pendingSendToolCalls.clear();
          v2TurnStartAt.clear();
          toolCallNames.clear();
          saveState();
          try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch {}
          log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
          sendJson({ ok: true, archivedCount, stoppedCount });
          return;
        }
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/restart') {
          sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
          setTimeout(() => {
            log('控制台：重启桥接');
            // 退出前落盘：SIGINT/SIGTERM 的收尾路径会 saveState()/saveSocialV2State()，
            // 而重启这条路径以前直接 process.exit，500ms 窗口内改动的唤醒配置/计数器会丢。
            try { saveState(); } catch (error) { log('重启前保存会话映射失败:', error?.message ?? error); }
            try { saveSocialV2State(); } catch (error) { log('重启前保存二代会话状态失败:', error?.message ?? error); }
            releaseLock();
            process.exit(0);
          }, 500);
          return;
        }
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      log(`本地控制台已启动：http://127.0.0.1:${port}`);
    });
    // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
    server.on('error', (error) => {
      log(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      process.exit(1);
    });
    return server;
}
