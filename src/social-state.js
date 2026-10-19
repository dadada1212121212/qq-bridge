// 社交状态机（从 bridge.js 抽出，2026-10-18）。
//
// 为什么单独成模块：会话状态（wakeConfig / 未读 / 令牌 / 轮换计数 / 点名台账…）是整套桥接
// 的中心数据结构，读盘、兜底补字段、落盘三件事原先散在 1.2 万行的 main() 里。抽出来以后
// 「状态长什么样、缺字段怎么补、什么时候落盘」集中在一处，改字段不用再翻全文件。
//
// 依赖注入约定：函数与 const 传引用；可变变量走 S.xxx 的 getter/setter，保证拿到实时值。
// 注意 socialV2 本身是 const 对象（只改内部字段、从不整体重新赋值），按引用注入是安全的。
import fs from 'node:fs';
import crypto from 'node:crypto';

export function createSocialState(S) {
  const {
    SOCIAL_V2_FILE,
    atomicWriteJson,
    canonicalV2Key,
    concurrencyCfgV2,
    log,
    pruneAsks,
    readJsonSafe,
    rememberAgentToken,
    sanitizeForwardId,
    text,
    truncateText,
    cfg,
    defaultWakeConfigV2,
    ensureWakeableV2,
    normalizeSpeakerIdsV2,
    refreshDefaultWakeConfigV2,
    scheduleProactiveCheckV2,
    seenForwardIds,
    setupSleepTimerV2,
    socialV2,
  } = S;
  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        // [patch 主动保底] 上次向主人投放主动机会的时间（跨重启保留）。
        lastProactiveAt: 0,
        lastIncomingAt: 0,
        // [patch 日记] 上一次写小记/周报的日期（'YYYY-MM-DD' / 'YYYY-Www'）：重启不丢，同一天不重复触发。
        lastDiaryDay: '',
        lastDiaryWeek: '',
        // [patch 群聊小总结] 上一次往这个群发日总结/周总结的日期：同一群同一天/周只发一次，重启不丢。
        lastGroupRecapDay: '',
        lastGroupRecapWeek: '',
        // [patch 定时播报] 早报/晚报/节日上次播报的日期：同一天各只发一次，重启不丢。
        lastBroadcastMorning: '',
        lastBroadcastEvening: '',
        lastBroadcastFestivalDay: '',
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        roleCardMtime: 0,
        // [省token] 静态段「本会话已整条发过」的标记：{ sessionId, at }；会话变了就重发。
        wakeStaticSent: null,
        recap: null,
        modelSeenSeqs: new Set(),
        activeTopics: [],
        pendingThoughts: [],
        // [承诺/待办] 你答应过谁什么事、什么时候该兑现。和 activeTopics 分开：
        // 话题是"聊到哪儿了"，承诺是"我欠他一个交代" —— 生命周期更长、到期要主动提。
        promises: [],
        memberImpressions: {},
        // [并发] 点名台账：谁在等她回话。跨回合、跨槽位共享，答完才结清。
        asks: [],
        // [拟人四件套] 事件跟进台账 / 对人冷场余波 / 超长记忆自检水位。
        followUps: [],
        coldShoulder: {},
        lastMemorySelfCheckAt: 0,
        // [养鱼] 每日 B 站巡园：该 key（主人私聊）最近一次领任务的日期。
        lastBiliStrollDay: '',
        // [养鱼·追更] 关注的 UP 主最新投稿水位 { [mid]: { name, lastBvid, lastTitle, lastPubdate, seeded } }。
        biliFollowState: {}
      };
      rememberAgentToken(key, st.agentToken);
      socialV2.conversations.set(key, st);
      scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  function loadSocialV2State() {
    try {
      // 记下读取时刻的文件指纹。加载末尾会统一落盘一次（为了让 ensureWakeableV2
      // 中途的改动不丢），但如果这期间**别的进程**已经写过这个文件，我们手上的
      // 内存态就是旧的 —— 再写回去等于把它那份更新的状态覆盖掉。
      // 这不是假想：日志里出现过两个桥接实例同时启动，第二个实例在加载后立刻回写，
      // 把第一个实例刚更新的读水位/唤醒时间/转发 id 全部退回旧值。
      const fileStamp = (() => {
        try {
          const s = fs.statSync(SOCIAL_V2_FILE);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return null;
        }
      })();
      const raw = readJsonSafe(SOCIAL_V2_FILE, null);
      socialV2.paused = raw?.paused === true;
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              triggers: { ...defaultWc.triggers, ...((val.wakeConfig?.triggers) ?? {}) }
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            // [patch 主动保底]
            lastProactiveAt: Number(val.lastProactiveAt) || 0,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            lastDiaryDay: String(val.lastDiaryDay || ''),
            lastDiaryWeek: String(val.lastDiaryWeek || ''),
            lastGroupRecapDay: String(val.lastGroupRecapDay || ''),
            lastGroupRecapWeek: String(val.lastGroupRecapWeek || ''),
            lastBroadcastMorning: String(val.lastBroadcastMorning || ''),
            lastBroadcastEvening: String(val.lastBroadcastEvening || ''),
            lastBroadcastFestivalDay: String(val.lastBroadcastFestivalDay || ''),
            // [patch 睡眠] 手动睡 / 清醒宽限要跨重启保留，否则重启就把「让她睡」丢了。
            sleepManualUntil: Number(val.sleepManualUntil) || 0,
            sleepAwakeUntil: Number(val.sleepAwakeUntil) || 0,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            // [patch 省token] 跨重启保留轮换计数 / 潜水宽限 / 繁忙期暂存的唤醒原因
            turnCount: Number(val.turnCount) || 0,
            turnSentCount: Number(val.turnSentCount) || 0,
            sleepGraceUntil: Number(val.sleepGraceUntil) || 0,
            pendingWakeReasons: Array.isArray(val.pendingWakeReasons) ? val.pendingWakeReasons.filter((x) => x && typeof x === 'object').slice(-20) : [],
            // [并发] 台账归一化：丢掉没有 id 的脏条目 + 过期清理 + 去重 + 封顶。
            // 认领表（pendingAskClaimsV2）只在内存里：上个进程崩了/重启了，被认领的条目
            // 就再也没人来结算 —— 不清理的话这些人永远停在「有人管」状态、谁也答不上。
            // 载入时把 slot/claimAt 清掉，让它们回到「没人管」，下一轮照样能被接住。
            asks: pruneAsks(val.asks, { cfg: concurrencyCfgV2() }).map((a) => ({ ...a, slot: '', claimAt: 0 })),
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
              ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0) : 0,
            roleCardMtime: Number(val.roleCardMtime) || 0,
            wakeStaticSent: (val.wakeStaticSent && typeof val.wakeStaticSent === 'object'
              && typeof val.wakeStaticSent.sessionId === 'string' && val.wakeStaticSent.sessionId)
              ? { sessionId: val.wakeStaticSent.sessionId, at: Number(val.wakeStaticSent.at) || 0 } : null,
            recap: val.recap && typeof val.recap === 'object'
              ? { text: String(val.recap.text ?? '').slice(0, 8000), at: Number(val.recap.at) || 0, uptoSeq: Number(val.recap.uptoSeq) || 0 }
              : null,
            modelSeenSeqs: new Set(),
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            // [承诺/待办] 归一化：只保留结构完整的条目，防止旧数据/手改的 JSON 污染。
            promises: Array.isArray(val.promises)
              ? val.promises.filter((p) => p && typeof p === 'object' && String(p.text || '').trim()).slice(-40)
              : [],
            // [回合制游戏] 整局状态是个对象；非对象（手改/旧格式）一律当没有进行中的局。
            turnGame: (val.turnGame && typeof val.turnGame === 'object' && typeof val.turnGame.game === 'string')
              ? val.turnGame : null,
            // [群内工具] 投票状态：结构不完整的（手改/旧格式）当没有投票。
            poll: (val.poll && typeof val.poll === 'object' && Array.isArray(val.poll.options) && val.poll.options.length >= 2)
              ? val.poll : null,
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })(),
            // [拟人四件套] 归一化：followUps 只留结构完整的；coldShoulder 只留数字水位。
            followUps: Array.isArray(val.followUps)
              ? val.followUps.filter((f) => f && typeof f === 'object' && String(f.event || '').trim() && Number(f.followUpAt) > 0).slice(-20)
              : [],
            coldShoulder: (() => {
              const rawCs = (val.coldShoulder && typeof val.coldShoulder === 'object') ? val.coldShoulder : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawCs)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = { at: Number(v?.at) || 0, hostile: !!v?.hostile };
              }
              return clean;
            })(),
            lastMemorySelfCheckAt: Number(val.lastMemorySelfCheckAt) || 0,
            lastBiliStrollDay: String(val.lastBiliStrollDay || ''),
            // [养鱼·追更] 水位归一化：只留结构完整的条目，键名挡掉原型链污染。
            biliFollowState: (() => {
              const raw = (val.biliFollowState && typeof val.biliFollowState === 'object') ? val.biliFollowState : {};
              const clean = {};
              for (const [k, v] of Object.entries(raw)) {
                if (!/^\d{5,}$/.test(k) || !v || typeof v !== 'object') continue;
                if (!String(v.lastBvid || '').trim()) continue;
                clean[k] = {
                  name: String(v.name || '').slice(0, 60),
                  lastBvid: String(v.lastBvid).slice(0, 20),
                  lastTitle: String(v.lastTitle || '').slice(0, 120),
                  lastPubdate: Number(v.lastPubdate) || 0,
                  seeded: v.seeded !== false
                };
              }
              return clean;
            })()
          };
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          rememberAgentToken(key, st.agentToken);
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          scheduleProactiveCheckV2(key);
        }
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        // 但只有在文件仍是「我们读到的那一份」时才写：否则说明有另一个进程写过它，
        // 我们手里的内存态已经过时，回写会静默吞掉对方的新数据。
        const nowStamp = (() => {
          try {
            const s = fs.statSync(SOCIAL_V2_FILE);
            return `${s.size}:${s.mtimeMs}`;
          } catch {
            return null;
          }
        })();
        if (fileStamp !== null && nowStamp !== null && fileStamp !== nowStamp) {
          log('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
        } else {
          saveSocialV2State();
        }
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function saveSocialV2State() {
    try {
      const obj = { paused: socialV2.paused, conversations: Object.create(null) };
      for (const [key, st] of socialV2.conversations) {
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          lastActionAt: st.lastActionAt,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          // [patch 主动保底]
          lastProactiveAt: Number(st.lastProactiveAt) || 0,
          lastIncomingAt: st.lastIncomingAt || 0,
          lastDiaryDay: st.lastDiaryDay || '',
          lastDiaryWeek: st.lastDiaryWeek || '',
          lastGroupRecapDay: st.lastGroupRecapDay || '',
          lastGroupRecapWeek: st.lastGroupRecapWeek || '',
          lastBroadcastMorning: st.lastBroadcastMorning || '',
          lastBroadcastEvening: st.lastBroadcastEvening || '',
          lastBroadcastFestivalDay: st.lastBroadcastFestivalDay || '',
          // [patch 睡眠] 手动睡 / 清醒宽限跨重启保留。
          sleepManualUntil: Number(st.sleepManualUntil) || 0,
          sleepAwakeUntil: Number(st.sleepAwakeUntil) || 0,
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
          preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
          lastUnreadSeq: st.lastUnreadSeq || 0,
          lastReadThroughSeq: st.lastReadThroughSeq || 0,
          roleCardMtime: Number(st.roleCardMtime) || 0,
          wakeStaticSent: (st.wakeStaticSent && typeof st.wakeStaticSent === 'object'
            && typeof st.wakeStaticSent.sessionId === 'string' && st.wakeStaticSent.sessionId)
            ? { sessionId: st.wakeStaticSent.sessionId, at: Number(st.wakeStaticSent.at) || 0 } : null,
          recap: st.recap && typeof st.recap === 'object'
            ? { text: truncateText(st.recap.text ?? '', 8000), at: Number(st.recap.at) || 0, uptoSeq: Number(st.recap.uptoSeq) || 0 }
            : null,
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
          // [承诺/待办] 跨重启保留：答应的期限可能是几天后，重启就忘等于没记。
          promises: Array.isArray(st.promises) ? st.promises.slice(-60) : [],
          // [回合制游戏 / 群内工具] 局面跨重启保留（之前 turnGame 漏了这行，重启即丢局）。
          turnGame: st.turnGame && typeof st.turnGame === 'object' ? st.turnGame : null,
          poll: st.poll && typeof st.poll === 'object' ? st.poll : null,
          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000),
          // [patch 省token] 轮换计数、潜水宽限、繁忙期暂存的唤醒原因必须跨重启保留，否则重启即归零。
          turnCount: Number(st.turnCount) || 0,
          turnSentCount: Number(st.turnSentCount) || 0,
          sleepGraceUntil: Number(st.sleepGraceUntil) || 0,
          pendingWakeReasons: Array.isArray(st.pendingWakeReasons) ? st.pendingWakeReasons.filter((x) => x && typeof x === 'object').slice(-20) : [],
          // [并发] 点名台账跨重启保留：重启后还认得「谁在等她」，不会把人晾在那儿。
          asks: pruneAsks(st.asks, { cfg: concurrencyCfgV2() }),
          // [拟人四件套] 事件可能好几天后才到期，冷场余波、自检水位同理，都得跨重启。
          followUps: Array.isArray(st.followUps) ? st.followUps.slice(-20) : [],
          coldShoulder: st.coldShoulder && typeof st.coldShoulder === 'object' ? st.coldShoulder : {},
          lastMemorySelfCheckAt: Number(st.lastMemorySelfCheckAt) || 0,
          lastBiliStrollDay: String(st.lastBiliStrollDay || ''),
          // [养鱼·追更] 水位跨重启保留（lastBvid 判新就靠它）。
          biliFollowState: st.biliFollowState && typeof st.biliFollowState === 'object' ? st.biliFollowState : {}
        };
      }
      atomicWriteJson(SOCIAL_V2_FILE, obj);
    } catch (error) {
      log('保存 socialV2 状态失败:', error?.message ?? error);
    }
  }


  return { getSocialV2State, loadSocialV2State, saveSocialV2State };
}
