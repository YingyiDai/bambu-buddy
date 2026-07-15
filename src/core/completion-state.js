const { VIDEO } = require('../config/state-map');

const SUCCESS_DISPLAY_MS = 20 * 60 * 1000;
const FINISHED_MEMORY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_GCODE_STATES = new Set(['PREPARE', 'RUNNING', 'PAUSE', 'SLICING']);
const TASK_ID_FIELDS = ['subtask_id', 'task_id', 'project_id', 'gcode_file'];

function taskIdFromReport(report) {
  for (const key of TASK_ID_FIELDS) {
    const value = report && report[key];
    if (value != null && value !== '') return String(value);
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

function formatFinishedTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
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
        time: formatFinishedTime(record.finishedAt),
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
  formatFinishedTime,
  taskIdFromReport,
};
