const test = require('node:test');
const assert = require('node:assert');
const {
  SUCCESS_DISPLAY_MS,
  FINISHED_MEMORY_MS,
  applyCompletionState,
  taskIdFromReport,
} = require('../src/core/completion-state');
const { resolveState } = require('../src/core/state-machine');
const { STRINGS } = require('../src/config/locales');

const START = new Date(2025, 0, 1, 14, 30).getTime();

function apply(report, record, now = START) {
  return applyCompletionState(report, resolveState(report), record, now);
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

test('完成 20 分钟后切为空闲动画并回传完成时刻的原始时间戳', () => {
  // 时间戳保持原始值传出（与 remainMins 同理），格式化留给能读到系统 24/12 小时设置的
  // 渲染进程（Chromium）与托盘——纯模块里不做本地化格式化。
  const record = { finishedAt: START, taskId: 'job-1' };
  const report = { connected: true, gcode_state: 'FINISH', subtask_id: 'job-1' };
  const result = apply(report, record, START + SUCCESS_DISPLAY_MS);

  assert.equal(result.state.stateKey, 'idle');
  assert.equal(result.state.videoFile, 'idle.webm');
  assert.equal(result.state.labelKey, 'label.finishedAt');
  assert.deepStrictEqual(result.state.labelParams, { finishedAt: START });
  assert.equal(result.nextUpdateAt, START + FINISHED_MEMORY_MS);
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

test('P1S 局域网直连：云端 id 恒为占位符 "0"，回落到 gcode_file 作任务标识', () => {
  // 真机取证：P1S/A1 在 LAN 直连打印时 subtask_id/task_id/project_id 恒为 "0"
  // （真实 id 只在云端任务里生成）。占位符必须跳过，否则每份作业都被当成同一任务。
  const report = {
    connected: true, gcode_state: 'FINISH',
    subtask_id: '0', task_id: '0', project_id: '0',
    gcode_file: 'plate_1.gcode', subtask_name: '螺丝盒',
  };
  assert.equal(taskIdFromReport(report), 'plate_1.gcode');
});

test('P1S 局域网：全部占位符 + 仅 subtask_name / file 可用时也能识别任务', () => {
  assert.equal(
    taskIdFromReport({ subtask_id: '0', task_id: '0', project_id: '0', subtask_name: 'test' }),
    'test',
  );
  assert.equal(
    taskIdFromReport({ subtask_id: 0, task_id: 0, project_id: 0, file: 'model.3mf/plate_5.g' }),
    'model.3mf/plate_5.g',
  );
  // 完全没有可用标识（全占位/缺失）→ null
  assert.equal(taskIdFromReport({ subtask_id: '0', task_id: '', project_id: null }), null);
});

test('P1S 局域网：应用未在线时换了新作业完成，占位 id 不再误判为同一任务', () => {
  // 旧作业记录已老化（>24h），期间应用离线（没观测到 RUNNING，记录未被清空）。
  // 修复前：两次作业 taskId 都是 "0" → 被当成同一任务 → 新完成被误按旧完成时刻算龄 → 直接空闲、
  //         既不庆祝也不显示完成时刻（P1S 用户实测的「完成状态不对/不显示完成时间」）。
  const staleRecord = { finishedAt: START, taskId: 'jobA.gcode' };
  const reconnectAt = START + FINISHED_MEMORY_MS + 60 * 60 * 1000; // 25 小时后
  const jobBFinish = {
    connected: true, gcode_state: 'FINISH',
    subtask_id: '0', task_id: '0', project_id: '0', gcode_file: 'jobB.gcode',
  };
  const result = apply(jobBFinish, staleRecord, reconnectAt);
  assert.equal(result.state.stateKey, 'finished');
  assert.deepStrictEqual(result.record, { finishedAt: reconnectAt, taskId: 'jobB.gcode' });
  assert.equal(result.nextUpdateAt, reconnectAt + SUCCESS_DISPLAY_MS);
});

test('同一作业的连续 FINISH 帧（gcode_file 稳定）不重置完成时刻', () => {
  const report = { connected: true, gcode_state: 'FINISH', subtask_id: '0', gcode_file: 'plate_1.gcode' };
  const first = apply(report, null);
  assert.deepStrictEqual(first.record, { finishedAt: START, taskId: 'plate_1.gcode' });
  // 21 分钟后同一份作业仍在 FINISH：完成时刻保持不变，正常降级到「完成时刻」
  const later = apply(report, first.record, START + SUCCESS_DISPLAY_MS + 60 * 1000);
  assert.equal(later.state.labelKey, 'label.finishedAt');
  assert.equal(later.record.finishedAt, START);
});

test('完成文案符合中英文产品文案', () => {
  assert.equal(STRINGS['zh-CN']['label.finished'], '打印成功');
  assert.equal(STRINGS.en['label.finished'], 'Print successful');
  assert.equal(STRINGS['zh-CN']['label.finishedAt'], '完成于 {time}');
  assert.equal(STRINGS.en['label.finishedAt'], 'Finished at {time}');
});

