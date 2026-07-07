// 回归测试：printer:list 的实时遥测派生。
// 锁住「切换打印机 / 重登后，上一台的进度、层数、温度不得串显到新活动卡片」契约。
// 内置 node:test 运行：node --test 'test/**/*.test.js'
const test = require('node:test');
const assert = require('node:assert');
const { buildLiveTelemetry, statusClassFromStateKey } = require('../src/core/live-telemetry');
const { resolveState } = require('../src/core/state-machine');

test('mock 模式不输出任何实时遥测', () => {
  const t = buildLiveTelemetry(false, { stateKey: 'idle', labelKey: 'label.idle', labelParams: {} },
    { connected: true, mc_percent: 50 });
  assert.equal(t.liveStatusClass, null);
  assert.equal(t.liveLabelKey, null);
  assert.equal(t.liveProgress, null);
  assert.equal(t.liveTemps, null);
});

// ── 整类护栏：熊猫状态（stateKey）与卡片状态类别必须一致 ──
// 历史上「卡片按 labelKey 文案字符串再猜一遍类别」导致三次「熊猫/卡片对不上」bug
// （failed 串离线、暂停类 stage / 舱门暂停串打印中、完成串在线）。改为卡片一律由
// stateKey 派生后，穷举所有真机可达状态，任一矛盾即失败 —— 上线前就能拦住整类回归。
test('熊猫 stateKey → 卡片类别对所有 gcode×stg 一致（整类回归护栏）', () => {
  const allowed = {
    offline: 'offline', authExpired: 'offline', failed: 'failed', finished: 'finished',
    paused: 'paused', idle: 'online', prepare: 'printing', changing_filament: 'printing',
    printing_0: 'printing', printing_25: 'printing', printing_50: 'printing', printing_75: 'printing',
  };
  const reps = [];
  for (const g of ['IDLE', 'PREPARE', 'RUNNING', 'PAUSE', 'FINISH', 'FAILED', 'OFFLINE']) {
    for (let stg = 0; stg <= 80; stg++) reps.push({ connected: true, gcode_state: g, stg_cur: stg, mc_percent: 50 });
  }
  reps.push({ connected: false }, { authExpired: true },
    { connected: true, gcode_state: 'PAUSE', door_open: true },
    { connected: true, gcode_state: 'FINISH' });

  const bad = [];
  for (const rep of reps) {
    const s = resolveState(rep);
    const cls = statusClassFromStateKey(s.stateKey);
    if (!(s.stateKey in allowed)) bad.push(`未登记 stateKey=${s.stateKey}（${JSON.stringify(rep)} label=${s.labelKey}）`);
    else if (cls !== allowed[s.stateKey]) bad.push(`矛盾 熊猫=${s.stateKey} 卡片=${cls}（${JSON.stringify(rep)} label=${s.labelKey}）`);
  }
  assert.deepStrictEqual(bad, [], '\n' + bad.join('\n'));
});

test('live + 已连接报文 → 输出进度/层数/温度', () => {
  const lastState = { stateKey: 'printing_50', labelKey: 'label.printing', labelParams: { p: 50, layer: 100, total: 200 } };
  const lastReport = {
    connected: true, gcode_state: 'RUNNING',
    mc_percent: 50, layer_num: 100, total_layer_num: 200,
    nozzle_temps: [220], bed_temps: [60], remaining_time: 120,
  };
  const t = buildLiveTelemetry(true, lastState, lastReport);
  assert.equal(t.liveStatusClass, 'printing');
  assert.equal(t.liveLabelKey, 'label.printing');
  assert.deepStrictEqual(t.liveProgress, { percent: 50, layer: 100, total: 200 });
  assert.equal(t.liveTemps.nozzleTemp, 220);
  assert.equal(t.liveTemps.bedTemp, 60);
});

test('切换打印机后 lastReport=null → 不串显上一台进度（核心回归）', () => {
  // 上一台曾打印到 50% / 100 层；切换时主进程把 lastReport 置 null、lastState 重置为离线。
  const lastState = { stateKey: 'offline', labelKey: 'label.offline', labelParams: {} };
  const t = buildLiveTelemetry(true, lastState, null);
  assert.equal(t.liveProgress, null, '切换后不应残留上一台的进度');
  assert.equal(t.liveTemps, null, '切换后不应残留上一台的温度');
  assert.equal(t.liveStatusClass, 'offline');
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
