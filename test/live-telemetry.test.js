// 回归测试：printer:list 的实时遥测派生。
// 锁住「切换打印机 / 重登后，上一台的进度、层数、温度不得串显到新活动卡片」契约。
// 内置 node:test 运行：node --test 'test/**/*.test.js'
const test = require('node:test');
const assert = require('node:assert');
const { buildLiveTelemetry } = require('../src/core/live-telemetry');

test('mock 模式不输出任何实时遥测', () => {
  const t = buildLiveTelemetry(false, { labelKey: 'label.idle', labelParams: {} },
    { connected: true, mc_percent: 50 });
  assert.equal(t.liveLabelKey, null);
  assert.equal(t.liveProgress, null);
  assert.equal(t.liveTemps, null);
});

test('live + 已连接报文 → 输出进度/层数/温度', () => {
  const lastState = { labelKey: 'label.printing.layer', labelParams: { p: 50, layer: 100, total: 200 } };
  const lastReport = {
    connected: true, gcode_state: 'RUNNING',
    mc_percent: 50, layer_num: 100, total_layer_num: 200,
    nozzle_temps: [220], bed_temps: [60], remaining_time: 120,
  };
  const t = buildLiveTelemetry(true, lastState, lastReport);
  assert.equal(t.liveLabelKey, 'label.printing.layer');
  assert.deepStrictEqual(t.liveProgress, { percent: 50, layer: 100, total: 200 });
  assert.equal(t.liveTemps.nozzleTemp, 220);
  assert.equal(t.liveTemps.bedTemp, 60);
});

test('切换打印机后 lastReport=null → 不串显上一台进度（核心回归）', () => {
  // 上一台曾打印到 50% / 100 层；切换时主进程把 lastReport 置 null、lastState 重置为离线。
  const lastState = { labelKey: 'label.offline', labelParams: {} };
  const t = buildLiveTelemetry(true, lastState, null);
  assert.equal(t.liveProgress, null, '切换后不应残留上一台的进度');
  assert.equal(t.liveTemps, null, '切换后不应残留上一台的温度');
  assert.equal(t.liveLabelKey, 'label.offline');
});

test('重登后 lastReport 残留旧帧但 connected:false → 仍不输出遥测', () => {
  // 即便 lastReport 还带着上一台的旧字段，connected:false 表示该帧不可用
  const lastState = { labelKey: 'label.offline', labelParams: {} };
  const lastReport = { connected: false, mc_percent: 50, layer_num: 100, total_layer_num: 200 };
  const t = buildLiveTelemetry(true, lastState, lastReport);
  assert.equal(t.liveProgress, null);
  assert.equal(t.liveTemps, null);
});

test('live 模式但 lastState 为 null → labelKey 为 null，进度仍可取', () => {
  const t = buildLiveTelemetry(true, null, { connected: true, mc_percent: 10, layer_num: 2, total_layer_num: 50 });
  assert.equal(t.liveLabelKey, null);
  assert.deepStrictEqual(t.liveProgress, { percent: 10, layer: 2, total: 50 });
});
