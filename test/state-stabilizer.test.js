// StateStabilizer 单测：验证「一帧级抖动抑制」与「低延迟提交 / 兜底提交」。
const test = require('node:test');
const assert = require('node:assert');
const { StateStabilizer, DEFAULT_SETTLE_MS } = require('../src/core/state-stabilizer');

const S = (key, extra = {}) => ({ stateKey: key, ...extra });

test('首帧立即显示（无初始延迟）', () => {
  const st = new StateStabilizer();
  const r = st.observe(S('prepare'), 0);
  assert.equal(r.state.stateKey, 'prepare');
  assert.equal(r.settleAt, null);
});

test('同态帧立即刷新内容（进度/文案实时更新，不延迟）', () => {
  const st = new StateStabilizer();
  st.observe(S('printing_50', { labelParams: { p: 50 } }), 0);
  const r = st.observe(S('printing_50', { labelParams: { p: 51 } }), 1000);
  assert.equal(r.state.labelParams.p, 51);
  assert.equal(r.settleAt, null);
});

// 核心：只闪 1 帧、随即改回原态的抖动不显示（准备中 → 打印中(闪) → 准备中）。
test('一帧级抖动被抑制：prepare → printing(1 帧) → prepare，全程只显示 prepare', () => {
  const st = new StateStabilizer();
  assert.equal(st.observe(S('prepare'), 0).state.stateKey, 'prepare');
  // 闪现的 printing 帧：待定，仍显示 prepare。
  const g = st.observe(S('printing_0'), 500);
  assert.equal(g.state.stateKey, 'prepare');
  assert.ok(Number.isFinite(g.settleAt));
  // 下一帧改回 prepare：待定的 printing 被丢弃，继续 prepare。
  const back = st.observe(S('prepare'), 1000);
  assert.equal(back.state.stateKey, 'prepare');
  assert.equal(back.settleAt, null);
});

// 同理：开印瞬间闪 finished / idle 一帧也被吃掉。
test('一帧级抖动被抑制：prepare → finished(1 帧) → prepare', () => {
  const st = new StateStabilizer();
  st.observe(S('prepare'), 0);
  assert.equal(st.observe(S('finished'), 300).state.stateKey, 'prepare');
  assert.equal(st.observe(S('prepare'), 800).state.stateKey, 'prepare');
});

// 真状态：连续两帧同 key → 第 2 帧即提交（低延迟，不必等满兜底窗口）。
test('新状态被第 2 帧确认 → 立即提交', () => {
  const st = new StateStabilizer();
  st.observe(S('prepare'), 0);
  const first = st.observe(S('printing_0'), 500);
  assert.equal(first.state.stateKey, 'prepare'); // 第 1 帧还不提交
  const second = st.observe(S('printing_0'), 1200);
  assert.equal(second.state.stateKey, 'printing_0'); // 第 2 帧确认 → 提交
  assert.equal(second.settleAt, null);
});

// 兜底：真状态只来 1 帧、之后打印机静默 → 窗口到点由 tick 提交。
test('待定态满兜底窗口后由 tick 提交', () => {
  const st = new StateStabilizer();
  st.observe(S('printing_50'), 0);
  const obs = st.observe(S('finished'), 1000);
  assert.equal(obs.state.stateKey, 'printing_50');
  assert.equal(obs.settleAt, 1000 + DEFAULT_SETTLE_MS);
  // 未到点：不提交。
  const early = st.tick(1000 + DEFAULT_SETTLE_MS - 1);
  assert.equal(early.changed, false);
  assert.equal(early.state.stateKey, 'printing_50');
  // 到点：提交 finished。
  const done = st.tick(1000 + DEFAULT_SETTLE_MS);
  assert.equal(done.changed, true);
  assert.equal(done.state.stateKey, 'finished');
  assert.equal(done.settleAt, null);
});

// 待定态被第三个新态改写：以最后一个为准，since 重置。
test('待定态可被更新的新态改写（取最后一个，重置窗口）', () => {
  const st = new StateStabilizer();
  st.observe(S('prepare'), 0);
  const a = st.observe(S('printing_0'), 500);
  assert.equal(a.settleAt, 500 + DEFAULT_SETTLE_MS);
  const b = st.observe(S('changing_filament'), 900);
  assert.equal(b.state.stateKey, 'prepare'); // 仍显示已确认的 prepare
  assert.equal(b.settleAt, 900 + DEFAULT_SETTLE_MS); // 窗口按新待定态重置
  // 之后 changing_filament 被确认。
  assert.equal(st.observe(S('changing_filament'), 1200).state.stateKey, 'changing_filament');
});

test('reset 后下一帧当作首帧立即显示', () => {
  const st = new StateStabilizer();
  st.observe(S('printing_50'), 0);
  st.reset();
  const r = st.observe(S('offline'), 100);
  assert.equal(r.state.stateKey, 'offline');
  assert.equal(r.settleAt, null);
});

// tick 在无待定态时是安全的空操作。
test('无待定态时 tick 不改变显示', () => {
  const st = new StateStabilizer();
  st.observe(S('idle'), 0);
  const r = st.tick(5000);
  assert.equal(r.changed, false);
  assert.equal(r.state.stateKey, 'idle');
  assert.equal(r.settleAt, null);
});
