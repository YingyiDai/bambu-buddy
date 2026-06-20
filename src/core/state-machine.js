// 状态机核心：数据报文 → { stateKey, videoFile, label }（纯函数，便于单测）
// 解析优先级见技术文档 §6.2，label 映射见 §6.4。

const { STAGE, CHANGING_FILAMENT_STAGES, VIDEO } = require('../config/state-map');

// 大状态字符串（gcode_state）。OFFLINE 为本应用内部约定（连接断开时注入）。
const GCODE = {
  IDLE: 'IDLE',
  PREPARE: 'PREPARE',
  RUNNING: 'RUNNING',
  PAUSE: 'PAUSE',
  FINISH: 'FINISH',
  FAILED: 'FAILED',
  OFFLINE: 'OFFLINE',
};

// PREPARE 阶段 stage → 文本
function stageLabel(stg) {
  switch (stg) {
    case STAGE.HEATBED_PREHEATING: return '预热热床';
    case STAGE.HEATING_HOTEND: return '加热喷头';
    case STAGE.AUTO_BED_LEVELING: return '自动调平';
    case STAGE.SCANNING_BED_SURFACE: return '扫描床面';
    case STAGE.INSPECTING_FIRST_LAYER: return '检查首层';
    default: return '准备中';
  }
}

// PAUSE 阶段 stage / 错误 → 文本
function pauseLabel(stg) {
  switch (stg) {
    case STAGE.USER_PAUSE: return '已暂停';
    case STAGE.FILAMENT_RUNOUT: return '缺料，等待续料';
    case STAGE.NOZZLE_CLOG: return '喷头堵塞，待处理';
    case STAGE.FIRST_LAYER_ERROR: return '首层异常，待确认';
    case STAGE.HEATBED_TEMP_ABNORMAL:
    case STAGE.HOTEND_TEMP_ABNORMAL: return '温度异常，待处理';
    default: return '已暂停';
  }
}

// RUNNING 正常打印时按 mc_percent 选视频档
function printingVideoByPercent(percent) {
  const p = Number(percent) || 0;
  if (p < 25) return VIDEO.printing_0;
  if (p < 50) return VIDEO.printing_25;
  if (p < 75) return VIDEO.printing_50;
  return VIDEO.printing_75;
}

// HMS 严重度判定：fatal/serious → 终止失败；common/info → 可恢复
// pybambu 中 HMS code 的严重度位通常编码在高位；这里做宽松判定，
// 兼容 { code, severity } 或纯字符串两种形态。
function hasFatalHms(hms) {
  if (!Array.isArray(hms)) return false;
  return hms.some((h) => {
    if (!h) return false;
    const sev = (h.severity || h.level || '').toString().toLowerCase();
    return sev === 'fatal' || sev === 'serious';
  });
}

function firstHmsCode(hms) {
  if (!Array.isArray(hms) || hms.length === 0) return null;
  const h = hms[0];
  if (typeof h === 'string') return h;
  return h.code || h.attr || null;
}

/**
 * 把打印机报文（或 mock 注入）解析为宠物状态。
 * @param {object} report - 含 gcode_state, mc_percent, stg_cur, layer_num,
 *   total_layer_num, hms, door_open, print_error/print_canceled（瞬时事件）等。
 * @returns {{ stateKey: string, videoFile: string, label: string }}
 */
function resolveState(report = {}) {
  const r = report || {};
  const gcode = r.gcode_state;
  const stg = r.stg_cur;
  const percent = r.mc_percent;
  const layer = r.layer_num;
  const totalLayer = r.total_layer_num;
  const hms = r.hms;

  // 1. 连接断开 / 离线
  if (r.connected === false || gcode === GCODE.OFFLINE) {
    return { stateKey: 'offline', videoFile: VIDEO.offline, label: '未连接打印机' };
  }

  // 2. 失败 / 终止报错（含瞬时事件、致命 HMS）
  if (gcode === GCODE.FAILED || r.print_error || r.print_canceled || hasFatalHms(hms)) {
    const code = firstHmsCode(hms);
    const label = code ? `打印失败 · ${code}` : '打印失败';
    return { stateKey: 'failed', videoFile: VIDEO.failed, label };
  }

  // 3. 完成
  if (gcode === GCODE.FINISH) {
    return { stateKey: 'finished', videoFile: VIDEO.finished, label: '打印完成' };
  }

  // 4. 暂停 / 可恢复错误 / 断料 / 开门（当前统一 paused.webm）
  if (gcode === GCODE.PAUSE) {
    if (r.door_open) {
      return { stateKey: 'paused', videoFile: VIDEO.paused, label: '舱门已打开' };
    }
    return { stateKey: 'paused', videoFile: VIDEO.paused, label: pauseLabel(stg) };
  }

  // 舱门打开（非 PAUSE 也提示，归到 paused 视频）
  if (r.door_open && gcode !== GCODE.RUNNING) {
    return { stateKey: 'paused', videoFile: VIDEO.paused, label: '舱门已打开' };
  }

  // 5. 准备中
  if (gcode === GCODE.PREPARE) {
    return { stateKey: 'prepare', videoFile: VIDEO.prepare, label: stageLabel(stg) };
  }

  // 6. 打印中
  if (gcode === GCODE.RUNNING) {
    if (CHANGING_FILAMENT_STAGES.has(stg)) {
      return { stateKey: 'changing_filament', videoFile: VIDEO.changing_filament, label: '换料中' };
    }
    const videoFile = printingVideoByPercent(percent);
    const p = Number(percent) || 0;
    let label = `打印中 ${p}%`;
    if (Number.isFinite(layer) && Number.isFinite(totalLayer) && totalLayer > 0) {
      label += ` · 第${layer}/${totalLayer}层`;
    }
    // stateKey 用具体进度档，便于渲染层判断是否跨档切换
    const stateKey = videoFile.replace('.webm', '');
    return { stateKey, videoFile, label };
  }

  // 7. 空闲
  if (gcode === GCODE.IDLE) {
    return { stateKey: 'idle', videoFile: VIDEO.idle, label: '空闲' };
  }

  // 8. 兜底
  return { stateKey: 'idle', videoFile: VIDEO.idle, label: '空闲' };
}

module.exports = { resolveState, stageLabel, pauseLabel, hasFatalHms, GCODE };
