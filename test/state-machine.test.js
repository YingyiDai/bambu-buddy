// 纯函数单测：resolveState 的解析优先级与 labelKey / labelParams。
// 用内置 node:test 运行：node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { resolveState, extractTemps, formatRemainingTime } = require('../src/core/state-machine');

test('连接断开 → offline', () => {
  const r = resolveState({ connected: false, gcode_state: 'RUNNING' });
  assert.equal(r.stateKey, 'offline');
  assert.equal(r.videoFile, 'offline.webm');
  assert.equal(r.labelKey, 'label.offline');
  assert.deepStrictEqual(r.labelParams, {});
});

test('FAILED 优先于其它', () => {
  const r = resolveState({ connected: true, gcode_state: 'FAILED' });
  assert.equal(r.stateKey, 'failed');
  assert.equal(r.labelKey, 'label.failed');
});

test('致命 HMS → failed 且 labelKey 带 code', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', hms: [{ code: 'HMS_0300', severity: 'fatal' }] });
  assert.equal(r.stateKey, 'failed');
  assert.equal(r.labelKey, 'label.failed.hms');
  assert.equal(r.labelParams.code, 'HMS_0300');
});

test('可恢复 HMS（info）不进 failed', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 10, hms: [{ code: 'X', severity: 'info' }] });
  assert.equal(r.stateKey, 'printing_0');
});

test('FINISH → finished', () => {
  const r = resolveState({ connected: true, gcode_state: 'FINISH' });
  assert.equal(r.stateKey, 'finished');
  assert.equal(r.labelKey, 'label.finished');
});

test('PAUSE 断料 labelKey', () => {
  const r = resolveState({ connected: true, gcode_state: 'PAUSE', stg_cur: 6 });
  assert.equal(r.videoFile, 'paused.webm');
  assert.equal(r.labelKey, 'label.paused.runout');
});

test('PAUSE 舱门打开', () => {
  const r = resolveState({ connected: true, gcode_state: 'PAUSE', door_open: true });
  assert.equal(r.labelKey, 'label.doorOpen');
});

test('PREPARE 预热热床 labelKey', () => {
  const r = resolveState({ connected: true, gcode_state: 'PREPARE', stg_cur: 2 });
  assert.equal(r.stateKey, 'prepare');
  assert.equal(r.labelKey, 'label.prepare.heatbed');
});

test('RUNNING 换料 stage → changing_filament', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', stg_cur: 4 });
  assert.equal(r.stateKey, 'changing_filament');
  assert.equal(r.labelKey, 'label.changingFilament');
});

test('RUNNING 进度分档', () => {
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 0 }).videoFile, 'printing_0.webm');
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 24 }).videoFile, 'printing_0.webm');
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 25 }).videoFile, 'printing_25.webm');
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 50 }).videoFile, 'printing_50.webm');
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 75 }).videoFile, 'printing_75.webm');
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 99 }).videoFile, 'printing_75.webm');
});

test('RUNNING labelKey 含进度与层数', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 50, layer_num: 100, total_layer_num: 200 });
  assert.equal(r.labelKey, 'label.printing.layer');
  assert.equal(r.labelParams.p, 50);
  assert.equal(r.labelParams.layer, 100);
  assert.equal(r.labelParams.total, 200);
});

test('RUNNING labelKey 仅进度（无层数）', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 30 });
  assert.equal(r.labelKey, 'label.printing');
  assert.equal(r.labelParams.p, 30);
});

test('IDLE → idle', () => {
  const r = resolveState({ connected: true, gcode_state: 'IDLE' });
  assert.equal(r.stateKey, 'idle');
  assert.equal(r.labelKey, 'label.idle');
});

test('未知状态兜底 idle', () => {
  const r = resolveState({ connected: true, gcode_state: 'WHATEVER' });
  assert.equal(r.stateKey, 'idle');
  assert.equal(r.labelKey, 'label.idle');
});

// extractTemps + formatRemainingTime tests (unchanged from Task 1, keep all 10)
test('extractTemps 取 nozzle_temps 数组第一个元素', () => {
  const r = extractTemps({ nozzle_temps: [220, 0], bed_temps: [55, 0], target_nozzle_temp: 220, target_bed_temp: 55 });
  assert.equal(r.nozzleTemp, 220);
  assert.equal(r.bedTemp, 55);
  assert.equal(r.targetNozzleTemp, 220);
  assert.equal(r.targetBedTemp, 55);
});

test('extractTemps 兼容 nozzle_temp 标量字段', () => {
  const r = extractTemps({ nozzle_temp: 210, bed_temp: 60 });
  assert.equal(r.nozzleTemp, 210);
  assert.equal(r.bedTemp, 60);
});

test('extractTemps 数组优先于标量', () => {
  const r = extractTemps({ nozzle_temps: [230, 0], nozzle_temp: 210 });
  assert.equal(r.nozzleTemp, 230);
});

test('extractTemps 缺失字段返回 null', () => {
  const r = extractTemps({});
  assert.equal(r.nozzleTemp, null);
  assert.equal(r.bedTemp, null);
  assert.equal(r.targetNozzleTemp, null);
  assert.equal(r.targetBedTemp, null);
  assert.equal(r.chamberTemp, null);
  assert.equal(r.remainingTime, null);
});

test('extractTemps chamber_temp 通过', () => {
  const r = extractTemps({ chamber_temp: 35 });
  assert.equal(r.chamberTemp, 35);
});

test('extractTemps remaining_time 通过', () => {
  const r = extractTemps({ remaining_time: 83 });
  assert.equal(r.remainingTime, 83);
});

test('extractTemps 非数字容错', () => {
  const r = extractTemps({ nozzle_temp: 'abc', bed_temps: null });
  assert.equal(r.nozzleTemp, null);
  assert.equal(r.bedTemp, null);
});

test('formatRemainingTime 小于 60 分钟', () => {
  assert.equal(formatRemainingTime(5), '剩余 5 分钟');
  assert.equal(formatRemainingTime(59), '剩余 59 分钟');
});

test('formatRemainingTime 大于等于 60 分钟', () => {
  assert.equal(formatRemainingTime(60), '剩余 1h');
  assert.equal(formatRemainingTime(83), '剩余 1h23m');
  assert.equal(formatRemainingTime(120), '剩余 2h');
});

test('formatRemainingTime 边界值返回 null', () => {
  assert.equal(formatRemainingTime(null), null);
  assert.equal(formatRemainingTime(0), null);
  assert.equal(formatRemainingTime(-1), null);
  assert.equal(formatRemainingTime(undefined), null);
});

// ── Bambu Studio 全阶段富集（stg_cur → 最贴近动画 + 精确文案）──
test('PREPARE 长尾阶段 → prepare 动画 + 精确 stage 文案', () => {
  const r = resolveState({ connected: true, gcode_state: 'PREPARE', stg_cur: 11 }); // 识别打印板类型
  assert.equal(r.videoFile, 'prepare.webm');
  assert.equal(r.labelKey, 'label.stage.11');
});

test('RUNNING 中途校准 → prepare 动画', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', stg_cur: 8 }); // 动态流量校准
  assert.equal(r.videoFile, 'prepare.webm');
  assert.equal(r.labelKey, 'label.stage.8');
});

test('RUNNING 退料 → changing_filament 动画 + 精确文案', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', stg_cur: 22 }); // 退料中
  assert.equal(r.videoFile, 'changing_filament.webm');
  assert.equal(r.labelKey, 'label.stage.22');
});

test('PAUSE 长尾原因 → paused 动画 + 精确文案', () => {
  const r = resolveState({ connected: true, gcode_state: 'PAUSE', stg_cur: 26 }); // AMS 离线
  assert.equal(r.videoFile, 'paused.webm');
  assert.equal(r.labelKey, 'label.stage.26');
});

test('RUNNING 正常打印（stg=0）仍按进度选档', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', stg_cur: 0, mc_percent: 60 });
  assert.equal(r.videoFile, 'printing_50.webm');
  assert.equal(r.labelKey, 'label.printing');
});
