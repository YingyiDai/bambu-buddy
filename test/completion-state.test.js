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

test('首次收到 FINISH：记录完成时间，演成功动画 1 小时，标签即为相对完成时间', () => {
  const report = { connected: true, gcode_state: 'FINISH', subtask_id: 'job-1' };
  const first = apply(report, null);
  assert.deepStrictEqual(first.record, { finishedAt: START, taskId: 'job-1' });
  assert.equal(first.state.stateKey, 'finished');
  assert.equal(first.state.videoFile, 'finished.webm');
  // 与成功动画解耦：标签从结束起就是相对完成时间（携带原始时间戳，文案由渲染层就地生成）。
  assert.equal(first.state.labelKey, 'label.finishedAt');
  assert.deepStrictEqual(first.state.labelParams, { finishedAt: START });
  // 刷新排到相对时间下一次跳字（1 分钟后 "刚刚"→"1 分钟前"）。
  assert.equal(first.nextUpdateAt, START + 60 * 1000);

  // 动画边界前一刻仍是成功动画。
  const beforeBoundary = apply(report, first.record, START + SUCCESS_DISPLAY_MS - 1);
  assert.equal(beforeBoundary.state.stateKey, 'finished');
  assert.equal(beforeBoundary.state.videoFile, 'finished.webm');
  assert.equal(beforeBoundary.state.labelKey, 'label.finishedAt');
});

test('相对时间在 1 小时内按整分钟边界安排刷新', () => {
  const record = { finishedAt: START, taskId: 'job-1' };
  const report = { connected: true, gcode_state: 'FINISH', subtask_id: 'job-1' };
  // 结束 5 分 30 秒：下一次跳字排到第 6 分钟整。
  const result = apply(report, record, START + 5 * 60 * 1000 + 30 * 1000);
  assert.equal(result.state.stateKey, 'finished');
  assert.equal(result.nextUpdateAt, START + 6 * 60 * 1000);
});

test('完成满 1 小时后切为空闲动画，标签仍为相对完成时间并按整小时刷新', () => {
  // 时间戳保持原始值传出（与 remainMins 同理），相对文案留给渲染进程/托盘按当前时间就地生成。
  const record = { finishedAt: START, taskId: 'job-1' };
  const report = { connected: true, gcode_state: 'FINISH', subtask_id: 'job-1' };
  const result = apply(report, record, START + SUCCESS_DISPLAY_MS);

  assert.equal(result.state.stateKey, 'idle');
  assert.equal(result.state.videoFile, 'idle.webm');
  assert.equal(result.state.labelKey, 'label.finishedAt');
  assert.deepStrictEqual(result.state.labelParams, { finishedAt: START });
  // 已过 1 小时 → 按整小时步进：下一次跳字在第 2 小时整。
  assert.equal(result.nextUpdateAt, START + 2 * 60 * 60 * 1000);
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

test('不同任务完成时会创建新的成功状态（重开 1 小时动画 + 相对时间从"刚刚"起）', () => {
  const oldRecord = { finishedAt: START, taskId: 'job-1' };
  const nextFinish = START + FINISHED_MEMORY_MS + 1000;
  const result = apply(
    { connected: true, gcode_state: 'FINISH', subtask_id: 'job-2' },
    oldRecord,
    nextFinish,
  );
  assert.deepStrictEqual(result.record, { finishedAt: nextFinish, taskId: 'job-2' });
  assert.equal(result.state.stateKey, 'finished');
  // age=0 → 首次跳字排到第 1 分钟整（而非动画边界）。
  assert.equal(result.nextUpdateAt, nextFinish + 60 * 1000);
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
  assert.equal(result.nextUpdateAt, reconnectAt + 60 * 1000);
});

test('同一作业的连续 FINISH 帧（gcode_file 稳定）不重置完成时刻', () => {
  const report = { connected: true, gcode_state: 'FINISH', subtask_id: '0', gcode_file: 'plate_1.gcode' };
  const first = apply(report, null);
  assert.deepStrictEqual(first.record, { finishedAt: START, taskId: 'plate_1.gcode' });
  // 1 小时零 1 分钟后同一份作业仍在 FINISH：完成时刻保持不变，转空闲动画但仍显示相对完成时间。
  const later = apply(report, first.record, START + SUCCESS_DISPLAY_MS + 60 * 1000);
  assert.equal(later.state.stateKey, 'idle');
  assert.equal(later.state.labelKey, 'label.finishedAt');
  assert.equal(later.record.finishedAt, START);
});

test('完成文案符合中英文产品文案（相对时间）', () => {
  assert.equal(STRINGS['zh-CN']['label.finished'], '打印成功');
  assert.equal(STRINGS.en['label.finished'], 'Print successful');
  assert.equal(STRINGS['zh-CN']['label.finishedJustNow'], '刚刚完成');
  assert.equal(STRINGS['zh-CN']['label.finishedMinAgo'], '{m} 分钟前完成');
  assert.equal(STRINGS['zh-CN']['label.finishedHourAgo'], '{h} 小时前完成');
  assert.equal(STRINGS.en['label.finishedJustNow'], 'Finished just now');
  assert.equal(STRINGS.en['label.finishedMinAgo'], 'Finished {m}m ago');
  assert.equal(STRINGS.en['label.finishedHourAgo'], 'Finished {h}h ago');
});

