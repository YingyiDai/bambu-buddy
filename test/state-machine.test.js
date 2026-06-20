// 纯函数单测：resolveState 的解析优先级与 label（技术文档 §6）。
// 用内置 node:test 运行：node --test test/

const test = require('node:test');
const assert = require('node:assert');
const { resolveState } = require('../src/core/state-machine');

test('连接断开 → offline', () => {
  const r = resolveState({ connected: false, gcode_state: 'RUNNING' });
  assert.equal(r.stateKey, 'offline');
  assert.equal(r.videoFile, 'offline.webm');
  assert.equal(r.label, '未连接打印机');
});

test('FAILED 优先于其它', () => {
  const r = resolveState({ connected: true, gcode_state: 'FAILED' });
  assert.equal(r.stateKey, 'failed');
});

test('致命 HMS → failed 且 label 带 code', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', hms: [{ code: 'HMS_0300', severity: 'fatal' }] });
  assert.equal(r.stateKey, 'failed');
  assert.match(r.label, /HMS_0300/);
});

test('可恢复 HMS（info）不进 failed', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 10, hms: [{ code: 'X', severity: 'info' }] });
  assert.equal(r.stateKey, 'printing_0');
});

test('FINISH → finished', () => {
  assert.equal(resolveState({ connected: true, gcode_state: 'FINISH' }).stateKey, 'finished');
});

test('PAUSE 断料 label', () => {
  const r = resolveState({ connected: true, gcode_state: 'PAUSE', stg_cur: 6 });
  assert.equal(r.videoFile, 'paused.webm');
  assert.equal(r.label, '缺料，等待续料');
});

test('PAUSE 舱门打开', () => {
  const r = resolveState({ connected: true, gcode_state: 'PAUSE', door_open: true });
  assert.equal(r.label, '舱门已打开');
});

test('PREPARE 预热热床 label', () => {
  const r = resolveState({ connected: true, gcode_state: 'PREPARE', stg_cur: 2 });
  assert.equal(r.stateKey, 'prepare');
  assert.equal(r.label, '预热热床');
});

test('RUNNING 换料 stage → changing_filament', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', stg_cur: 4 });
  assert.equal(r.stateKey, 'changing_filament');
  assert.equal(r.label, '换料中');
});

test('RUNNING 进度分档', () => {
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 0 }).videoFile, 'printing_0.webm');
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 24 }).videoFile, 'printing_0.webm');
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 25 }).videoFile, 'printing_25.webm');
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 50 }).videoFile, 'printing_50.webm');
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 75 }).videoFile, 'printing_75.webm');
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 99 }).videoFile, 'printing_75.webm');
});

test('RUNNING label 含进度与层数', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 50, layer_num: 100, total_layer_num: 200 });
  assert.equal(r.label, '打印中 50% · 第100/200层');
});

test('IDLE → idle', () => {
  assert.equal(resolveState({ connected: true, gcode_state: 'IDLE' }).stateKey, 'idle');
});

test('未知状态兜底 idle', () => {
  assert.equal(resolveState({ connected: true, gcode_state: 'WHATEVER' }).stateKey, 'idle');
});
