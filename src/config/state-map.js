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

module.exports = { STAGE, CHANGING_FILAMENT_STAGES, VIDEO };
