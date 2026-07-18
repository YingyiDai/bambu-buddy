const { VIDEO } = require('../config/state-map');

const SUCCESS_DISPLAY_MS = 20 * 60 * 1000;
const FINISHED_MEMORY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_GCODE_STATES = new Set(['PREPARE', 'RUNNING', 'PAUSE', 'SLICING']);
// 任务标识字段（用于识别「换了新任务」→ 重开 20 分钟成功动画）。
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

function makeFinishedState(state) {
  return {
    ...state,
    stateKey: 'finished',
    videoFile: VIDEO.finished,
    labelKey: 'label.finished',
    labelParams: {},
  };
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
  if (age < SUCCESS_DISPLAY_MS) {
    return {
      state: makeFinishedState(state),
      record,
      nextUpdateAt: record.finishedAt + SUCCESS_DISPLAY_MS,
    };
  }

  if (age < FINISHED_MEMORY_MS) {
    return {
      state: makeIdleState(state, 'label.finishedAt', {
        // 传原始时间戳，不在此格式化：主进程 Node 读不到 macOS 的 24 小时制设置
        // （会回落 en-US → 12 小时）。真正的「时:分」由渲染进程/托盘按系统设置格式化。
        finishedAt: record.finishedAt,
      }),
      record,
      nextUpdateAt: record.finishedAt + FINISHED_MEMORY_MS,
    };
  }

  return { state: makeIdleState(state), record, nextUpdateAt: null };
}

module.exports = {
  SUCCESS_DISPLAY_MS,
  FINISHED_MEMORY_MS,
  applyCompletionState,
  taskIdFromReport,
};
