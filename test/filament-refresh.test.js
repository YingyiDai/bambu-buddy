// shouldRefreshOnColorLoss：耗材色「已知 → 未知」时该不该主动补一次 pushall。
//
// 由来：数据源的合并快照是粘性的，某一帧把 tray_color / extruder 变成解不出的形状后，后续增量帧
// 几乎不重发这些字段 —— 熊猫要等 5 分钟一次的定时 pushall 才恢复（用户实测「打印中颜色不对，约
// 5 分钟后自己变回来」）。补拉把这个窗口压到秒级，但必须**只在跳变时开火**并限频，否则就变成
// 「提高 pushall 频次」，那是当初刻意不做的事。下面的用例逐条锁死这些边界。
const test = require('node:test');
const assert = require('node:assert');
const { shouldRefreshOnColorLoss, COLOR_LOSS_COOLDOWN_MS } = require('../src/core/filament-refresh');

const base = { printActive: true, lastRefreshAt: null, now: 1_000_000 };

test('打印中耗材色「已知 → 未知」：补拉一次', () => {
  assert.equal(shouldRefreshOnColorLoss({ ...base, prevColor: '#ffffff', nextColor: null }), true);
});

test('一直未知（本就取不到色的机器）：不补拉，否则会每帧都想补', () => {
  assert.equal(shouldRefreshOnColorLoss({ ...base, prevColor: null, nextColor: null }), false);
});

test('颜色仍然已知（保持 / 换槽换色）：不补拉', () => {
  assert.equal(shouldRefreshOnColorLoss({ ...base, prevColor: '#ffffff', nextColor: '#ffffff' }), false);
  assert.equal(shouldRefreshOnColorLoss({ ...base, prevColor: '#ffffff', nextColor: '#ff0000' }), false);
});

test('未知 → 已知（自己恢复了）：不补拉', () => {
  assert.equal(shouldRefreshOnColorLoss({ ...base, prevColor: null, nextColor: '#ffffff' }), false);
});

test('不在打印中：不补拉（不改色也无所谓，不值得打扰打印机）', () => {
  assert.equal(shouldRefreshOnColorLoss({
    ...base, prevColor: '#ffffff', nextColor: null, printActive: false,
  }), false);
});

test('冷却期内不重复补拉；过了冷却才放行（颜色反复丢失时的最坏频次上限）', () => {
  const loss = { prevColor: '#ffffff', nextColor: null, printActive: true };
  const t0 = 1_000_000;
  assert.equal(shouldRefreshOnColorLoss({ ...loss, lastRefreshAt: t0, now: t0 + 1 }), false);
  assert.equal(shouldRefreshOnColorLoss({
    ...loss, lastRefreshAt: t0, now: t0 + COLOR_LOSS_COOLDOWN_MS - 1,
  }), false, '差 1ms 也算冷却期内');
  assert.equal(shouldRefreshOnColorLoss({
    ...loss, lastRefreshAt: t0, now: t0 + COLOR_LOSS_COOLDOWN_MS,
  }), true);
});

test('冷却窗口默认 60s —— 恢复上限从定时 pushall 的 5 分钟压到 1 分钟', () => {
  assert.equal(COLOR_LOSS_COOLDOWN_MS, 60 * 1000);
});
