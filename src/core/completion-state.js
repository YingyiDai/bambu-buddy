const { VIDEO } = require('../config/state-map');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
// 成功动画（finished.webm）展示时长：结束后 1 小时内演庆祝动画，之后转空闲动画。
// 注意这只是**动画**的边界——完成时刻标签（相对时间）在整个完成记忆期内一直显示，与动画解耦。
const SUCCESS_DISPLAY_MS = 60 * MINUTE_MS;
const FINISHED_MEMORY_MS = 24 * 60 * MINUTE_MS;
const ACTIVE_GCODE_STATES = new Set(['PREPARE', 'RUNNING', 'PAUSE', 'SLICING']);
// 任务标识字段（用于识别「换了新任务」→ 重开 1 小时成功动画）。
// 云端任务 id（subtask_id/task_id/project_id）在联网打印时是全局唯一值，最可靠；
// 但 P1S/A1 等在**局域网直连**打印时这三者恒为占位符 "0"（真实 id 只在云端任务里生成，
// 经真机报文取证 + pybambu 佐证——pybambu 干脆不解析这三个字段），此时必须回落到
// 每份作业各异的 gcode_file / subtask_name / file 才能把两次不同的打印区分开。
const TASK_ID_FIELDS = ['subtask_id', 'task_id', 'project_id', 'gcode_file', 'subtask_name', 'file'];
// 占位符取值：局域网打印时云端 id 恒为 "0"，空串同理，都不能当作真实任务标识。
const PLACEHOLDER_TASK_IDS = new Set(['', '0']);

function taskIdFromReport(report) {
  for (const key of TASK_ID_FIELDS) {
    const value = report && report[key];
    if (value == null) continue;
    const str = String(value).trim();
    if (str !== '' && !PLACEHOLDER_TASK_IDS.has(str)) return str;
  }
  return null;
}

function normalizeRecord(record) {
  if (!record || !Number.isFinite(record.finishedAt)) return null;
  return {
    finishedAt: record.finishedAt,
    taskId: record.taskId == null ? null : String(record.taskId),
  };
}

function makeFinishedState(state, labelKey = 'label.finished', labelParams = {}) {
  return {
    ...state,
    stateKey: 'finished',
    videoFile: VIDEO.finished,
    labelKey,
    labelParams,
  };
}

// 相对完成时间「下一次跳字」的时刻：不足 1 小时按整分钟边界（"刚刚"→"1 分钟前"→…），
// 之后按整小时边界（"1 小时前"→"2 小时前"→…）。据此安排定时刷新，标签不靠报文重发也能及时更新。
// 键（分钟/小时）的最终选择留给渲染层在真正显示时按当时时间算，避免报文时刻算出的字面量到渲染时已过期。
function nextRelativeBoundary(finishedAt, now) {
  const age = Math.max(0, now - finishedAt);
  if (age < HOUR_MS) {
    return finishedAt + (Math.floor(age / MINUTE_MS) + 1) * MINUTE_MS;
  }
  return finishedAt + (Math.floor(age / HOUR_MS) + 1) * HOUR_MS;
}

function makeIdleState(state, labelKey = 'label.idle', labelParams = {}) {
  return {
    ...state,
    stateKey: 'idle',
    videoFile: VIDEO.idle,
    labelKey,
    labelParams,
  };
}

function applyCompletionState(report, state, savedRecord, now = Date.now()) {
  const gcode = report && report.gcode_state;
  let record = normalizeRecord(savedRecord);

  if (ACTIVE_GCODE_STATES.has(gcode)) {
    return { state, record: null, nextUpdateAt: null };
  }

  if (gcode === 'FINISH') {
    const taskId = taskIdFromReport(report);
    const isNewTask = !record || (taskId != null && record.taskId != null && taskId !== record.taskId);
    if (isNewTask) record = { finishedAt: now, taskId };
  }

  if (!record || (gcode !== 'FINISH' && gcode !== 'IDLE')) {
    return { state, record, nextUpdateAt: null };
  }

  const age = Math.max(0, now - record.finishedAt);

  if (age < FINISHED_MEMORY_MS) {
    // 完成时刻标签在整个记忆期内一直显示相对时间（刚刚/X 分钟前/X 小时前），与动画解耦。
    // 只传原始时间戳、不在此格式化：主进程 Node 读不到 macOS 的 24 小时制设置，且相对时间要按
    // 「渲染那一刻」的当前时间算才准；真正的相对文案由渲染进程/托盘就地生成（见 fmtFinishedRelative）。
    const labelParams = { finishedAt: record.finishedAt };
    // 定时刷新排到「相对时间下一次跳字」处；跨过 1 小时动画边界时也会命中（整分钟步进恰好落在 60 分钟），
    // 那一帧 age≥SUCCESS_DISPLAY_MS，自然从成功动画切到空闲动画。最迟不超过记忆过期点。
    const nextUpdateAt = Math.min(
      nextRelativeBoundary(record.finishedAt, now),
      record.finishedAt + FINISHED_MEMORY_MS,
    );
    // 结束后 1 小时内继续演成功动画（庆祝），标签同时显示相对完成时间；之后转空闲动画。
    const state2 = age < SUCCESS_DISPLAY_MS
      ? makeFinishedState(state, 'label.finishedAt', labelParams)
      : makeIdleState(state, 'label.finishedAt', labelParams);
    return { state: state2, record, nextUpdateAt };
  }

  return { state: makeIdleState(state), record, nextUpdateAt: null };
}

module.exports = {
  SUCCESS_DISPLAY_MS,
  FINISHED_MEMORY_MS,
  applyCompletionState,
  taskIdFromReport,
};
