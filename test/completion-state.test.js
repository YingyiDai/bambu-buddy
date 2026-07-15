const test = require('node:test');
const assert = require('node:assert');
const {
  SUCCESS_DISPLAY_MS,
  FINISHED_MEMORY_MS,
  applyCompletionState,
  formatFinishedTime,
} = require('../src/core/completion-state');
const { resolveState } = require('../src/core/state-machine');
const { STRINGS } = require('../src/config/locales');

const START = new Date(2025, 0, 1, 14, 30).getTime();

function apply(report, record, now = START, locale = 'zh-CN') {
  return applyCompletionState(report, resolveState(report), record, now, locale);
}

test('首次收到 FINISH 时记录完成时间并保持成功动画 20 分钟', () => {
  const report = { connected: true, gcode_state: 'FINISH', subtask_id: 'job-1' };
  const first = apply(report, null);
  assert.deepStrictEqual(first.record, { finishedAt: START, taskId: 'job-1' });
  assert.equal(first.state.stateKey, 'finished');
  assert.equal(first.state.videoFile, 'finished.webm');
  assert.equal(first.state.labelKey, 'label.finished');
  assert.equal(first.nextUpdateAt, START + SUCCESS_DISPLAY_MS);

  const beforeBoundary = apply(report, first.record, START + SUCCESS_DISPLAY_MS - 1);
  assert.equal(beforeBoundary.state.stateKey, 'finished');
  assert.equal(beforeBoundary.state.labelKey, 'label.finished');
});

test('完成 20 分钟后切为空闲动画并显示本地化完成时间', () => {
  const record = { finishedAt: START, taskId: 'job-1' };
  const report = { connected: true, gcode_state: 'FINISH', subtask_id: 'job-1' };

  const zh = apply(report, record, START + SUCCESS_DISPLAY_MS, 'zh-CN');
  assert.equal(zh.state.stateKey, 'idle');
  assert.equal(zh.state.videoFile, 'idle.webm');
  assert.equal(zh.state.labelKey, 'label.finishedAt');
  assert.deepStrictEqual(zh.state.labelParams, { time: '14:30' });
  assert.equal(zh.nextUpdateAt, START + FINISHED_MEMORY_MS);

  const en = apply(report, record, START + SUCCESS_DISPLAY_MS, 'en');
  assert.deepStrictEqual(en.state.labelParams, { time: '2:30 PM' });
});

test('完成记录在打印机转为 IDLE 后仍显示到 24 小时', () => {
  const record = { finishedAt: START, taskId: 'job-1' };
  const result = apply({ connected: true, gcode_state: 'IDLE' }, record, START + SUCCESS_DISPLAY_MS);
  assert.equal(result.state.stateKey, 'idle');
  assert.equal(result.state.labelKey, 'label.finishedAt');
  assert.deepStrictEqual(result.record, record);
});

test('完成满 24 小时后恢复普通空闲且不重新触发成功动画', () => {
  const record = { finishedAt: START, taskId: 'job-1' };
  const report = { connected: true, gcode_state: 'FINISH', subtask_id: 'job-1' };
  const result = apply(report, record, START + FINISHED_MEMORY_MS);
  assert.equal(result.state.stateKey, 'idle');
  assert.equal(result.state.videoFile, 'idle.webm');
  assert.equal(result.state.labelKey, 'label.idle');
  assert.deepStrictEqual(result.record, record);
  assert.equal(result.nextUpdateAt, null);
});

test('下一次打印开始时清除上次完成记录', () => {
  const record = { finishedAt: START, taskId: 'job-1' };
  const result = apply({ connected: true, gcode_state: 'RUNNING', mc_percent: 10 }, record, START + SUCCESS_DISPLAY_MS);
  assert.equal(result.state.stateKey, 'printing_0');
  assert.equal(result.record, null);
  assert.equal(result.nextUpdateAt, null);
});

test('不同任务完成时会创建新的 20 分钟成功状态', () => {
  const oldRecord = { finishedAt: START, taskId: 'job-1' };
  const nextFinish = START + FINISHED_MEMORY_MS + 1000;
  const result = apply(
    { connected: true, gcode_state: 'FINISH', subtask_id: 'job-2' },
    oldRecord,
    nextFinish,
  );
  assert.deepStrictEqual(result.record, { finishedAt: nextFinish, taskId: 'job-2' });
  assert.equal(result.state.stateKey, 'finished');
  assert.equal(result.nextUpdateAt, nextFinish + SUCCESS_DISPLAY_MS);
});

test('完成文案与时间格式符合中英文产品文案', () => {
  assert.equal(STRINGS['zh-CN']['label.finished'], '打印成功');
  assert.equal(STRINGS.en['label.finished'], 'Print successful');
  assert.equal(STRINGS['zh-CN']['label.finishedAt'], '完成于 {time}');
  assert.equal(STRINGS.en['label.finishedAt'], 'Finished at {time}');
  assert.equal(formatFinishedTime(START, 'zh-CN'), '14:30');
  assert.equal(formatFinishedTime(START, 'en'), '2:30 PM');
});
