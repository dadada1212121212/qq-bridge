// 群聊并发紧急槽位判定自检：node scripts/test-concurrency-urgent.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldSpawnAux, DEFAULT_CONCURRENCY_CFG } from '../src/group-concurrency.js';

const cfg = DEFAULT_CONCURRENCY_CFG;

const stats = (unclaimed, oldestWaitMs) => ({ unclaimed, oldestUnclaimedWaitMs: oldestWaitMs });

test('紧急路径：主会话忙时单条点名 ≥3s 即开槽', () => {
  assert.equal(shouldSpawnAux({ stats: stats(1, 3000), auxBusy: false, cfg, urgent: true }), true);
  assert.equal(shouldSpawnAux({ stats: stats(1, 10000), auxBusy: false, cfg, urgent: true }), true);
});

test('紧急路径：点名刚记 3 秒内不重复派发', () => {
  assert.equal(shouldSpawnAux({ stats: stats(1, 0), auxBusy: false, cfg, urgent: true }), false);
  assert.equal(shouldSpawnAux({ stats: stats(1, 2999), auxBusy: false, cfg, urgent: true }), false);
});

test('紧急路径：第二槽位已在跑则不开（保底靠主回合）', () => {
  assert.equal(shouldSpawnAux({ stats: stats(3, 60000), auxBusy: true, cfg, urgent: true }), false);
});

test('紧急路径：台账为空不开槽', () => {
  assert.equal(shouldSpawnAux({ stats: stats(0, 60000), auxBusy: false, cfg, urgent: true }), false);
});

test('普通路径回归：攒够 auxMinAsks 或最老等 auxAfterMs*2 才开', () => {
  assert.equal(shouldSpawnAux({ stats: stats(2, 0), auxBusy: false, cfg, urgent: false }), true);
  assert.equal(shouldSpawnAux({ stats: stats(1, 25000), auxBusy: false, cfg, urgent: false }), false);
  assert.equal(shouldSpawnAux({ stats: stats(1, 50000), auxBusy: false, cfg, urgent: false }), true);
  assert.equal(shouldSpawnAux({ stats: stats(1, 50000), auxBusy: false, cfg, urgent: undefined }), true);
});
