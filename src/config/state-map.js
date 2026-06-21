// 宠物状态 → 视频文件 映射，以及 stage 枚举常量（见技术文档 §6.3 / §4.2）
// CommonJS 导出，供主进程与渲染层共用。

// current stage 枚举（来自 pybambu CURRENT_STAGE_IDS 的子集，仅取本应用关心的）
const STAGE = {
  // 准备阶段（PREPARE 时细化 label）
  AUTO_BED_LEVELING: 1,
  HEATBED_PREHEATING: 2,
  HEATING_HOTEND: 7,
  SCANNING_BED_SURFACE: 9,
  INSPECTING_FIRST_LAYER: 10,
  // 换料相关（RUNNING 时切到 changing_filament）
  CHANGING_FILAMENT: 4,
  UNLOADING: 22,
  LOADING: 24,
  PURGE_CHUTE: 68,
  PREPARING_AMS: 77,
  // 暂停原因（PAUSE 时细化 label）
  FILAMENT_RUNOUT: 6,
  USER_PAUSE: 16,
  FIRST_LAYER_ERROR: 34,
  NOZZLE_CLOG: 35,
  HEATBED_TEMP_ABNORMAL: 20,
  HOTEND_TEMP_ABNORMAL: 21,
};

// 触发 changing_filament 视频的 stage 集合
const CHANGING_FILAMENT_STAGES = new Set([
  STAGE.CHANGING_FILAMENT,
  STAGE.UNLOADING,
  STAGE.LOADING,
  STAGE.PURGE_CHUTE,
  STAGE.PREPARING_AMS,
]);

// 宠物状态 key → webm 文件名
const VIDEO = {
  offline: 'offline.webm',
  idle: 'idle.webm',
  prepare: 'prepare.webm',
  printing_0: 'printing_0.webm',
  printing_25: 'printing_25.webm',
  printing_50: 'printing_50.webm',
  printing_75: 'printing_75.webm',
  changing_filament: 'changing_filament.webm',
  paused: 'paused.webm',
  finished: 'finished.webm',
  failed: 'failed.webm',
};

// 全部 Bambu Studio stg_cur（0–77）→ 最贴近的动画类别。
// 来源：BambuStudio DeviceManager.cpp get_stage_string()。文案见 locales.js
// 的 label.stage.<n>（中英文取自 Bambu Studio 官方）。没有专属动画的阶段
// （加热/调平/校准/各种自检等）按含义归到 prepare；暂停类归 paused；
// 进退料/换料/AMS 归 changing_filament；正常打印归 printing（按进度选档）。
const STAGE_VIDEO = {
  0: 'printing',
  1: 'prepare', 2: 'prepare', 3: 'prepare', 4: 'changing_filament', 5: 'paused',
  6: 'paused', 7: 'prepare', 8: 'prepare', 9: 'prepare', 10: 'prepare',
  11: 'prepare', 12: 'prepare', 13: 'prepare', 14: 'prepare', 15: 'prepare',
  16: 'paused', 17: 'paused', 18: 'prepare', 19: 'prepare', 20: 'paused',
  21: 'paused', 22: 'changing_filament', 23: 'paused', 24: 'changing_filament', 25: 'prepare',
  26: 'paused', 27: 'paused', 28: 'paused', 29: 'prepare', 30: 'paused',
  31: 'prepare', 32: 'paused', 33: 'paused', 34: 'paused', 35: 'paused',
  36: 'prepare', 37: 'prepare', 38: 'prepare', 39: 'prepare', 40: 'prepare',
  41: 'prepare', 42: 'prepare', 43: 'prepare', 44: 'prepare', 45: 'prepare',
  46: 'prepare', 47: 'prepare', 48: 'prepare', 49: 'prepare', 50: 'prepare',
  51: 'prepare', 52: 'prepare', 53: 'prepare', 54: 'prepare', 55: 'prepare',
  56: 'prepare', 57: 'prepare', 58: 'prepare', 59: 'prepare', 60: 'prepare',
  61: 'prepare', 62: 'prepare', 63: 'prepare', 64: 'prepare', 65: 'prepare',
  66: 'prepare', 67: 'prepare', 68: 'changing_filament', 69: 'prepare', 70: 'prepare',
  71: 'prepare', 72: 'prepare', 73: 'prepare', 74: 'prepare', 75: 'prepare',
  76: 'prepare', 77: 'changing_filament',
};

module.exports = { STAGE, CHANGING_FILAMENT_STAGES, VIDEO, STAGE_VIDEO };
