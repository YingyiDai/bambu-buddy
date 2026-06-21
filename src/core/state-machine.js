// 状态机核心：数据报文 → { stateKey, videoFile, labelKey, labelParams }（纯函数，便于单测）
// 解析优先级见技术文档 §6.2，labelKey 映射见 §6.4。

const { STAGE, CHANGING_FILAMENT_STAGES, VIDEO, STAGE_VIDEO } = require('../config/state-map');

// 任一已知 stg_cur 的精确文案 key（取自 Bambu Studio，见 locales.js label.stage.<n>）。
// 未知 stage 返回 null，由调用方走大状态兜底。
function stageLabelKey(stg) {
  return STAGE_VIDEO[stg] != null ? `label.stage.${stg}` : null;
}

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

// PREPARE 阶段 stage → { labelKey, labelParams }
function stageLabel(stg) {
  switch (stg) {
    case STAGE.HEATBED_PREHEATING: return { labelKey: 'label.prepare.heatbed', labelParams: {} };
    case STAGE.HEATING_HOTEND: return { labelKey: 'label.prepare.hotend', labelParams: {} };
    case STAGE.AUTO_BED_LEVELING: return { labelKey: 'label.prepare.leveling', labelParams: {} };
    case STAGE.SCANNING_BED_SURFACE: return { labelKey: 'label.prepare.scanning', labelParams: {} };
    case STAGE.INSPECTING_FIRST_LAYER: return { labelKey: 'label.prepare.firstLayer', labelParams: {} };
    default: {
      // 其余所有 Bambu Studio 准备/校准/自检阶段：用精确文案，未知则兜底「准备中」
      const k = stageLabelKey(stg);
      return { labelKey: k || 'label.prepare', labelParams: {} };
    }
  }
}

// PAUSE 阶段 stage / 错误 → { labelKey, labelParams }
function pauseLabel(stg) {
  switch (stg) {
    case STAGE.USER_PAUSE: return { labelKey: 'label.paused', labelParams: {} };
    case STAGE.FILAMENT_RUNOUT: return { labelKey: 'label.paused.runout', labelParams: {} };
    case STAGE.NOZZLE_CLOG: return { labelKey: 'label.paused.clog', labelParams: {} };
    case STAGE.FIRST_LAYER_ERROR: return { labelKey: 'label.paused.firstLayerErr', labelParams: {} };
    case STAGE.HEATBED_TEMP_ABNORMAL:
    case STAGE.HOTEND_TEMP_ABNORMAL: return { labelKey: 'label.paused.tempAbnormal', labelParams: {} };
    default: {
      // 其余所有 Bambu Studio 暂停原因：用精确文案，未知则兜底「用户暂停」
      const k = stageLabelKey(stg);
      return { labelKey: k || 'label.paused', labelParams: {} };
    }
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
 * @returns {{ stateKey: string, videoFile: string, labelKey: string, labelParams: object }}
 */
function resolveState(report = {}) {
  const r = report || {};
  const gcode = r.gcode_state;
  const stg = r.stg_cur;
  const percent = r.mc_percent;
  const layer = r.layer_num;
  const totalLayer = r.total_layer_num;
  const hms = r.hms;

  // 0. 登录/会话失效（token 过期等）：区别于「打印机离线」——打印机大概率正常，是我们的
  //    会话失效了。复用 offline 动画，但文案提示「登录已失效，请重新登录」。优先级高于离线。
  if (r.authExpired) {
    return { stateKey: 'authExpired', videoFile: VIDEO.offline, labelKey: 'label.authExpired', labelParams: {} };
  }

  // 1. 连接断开 / 离线
  if (r.connected === false || gcode === GCODE.OFFLINE) {
    return { stateKey: 'offline', videoFile: VIDEO.offline, labelKey: 'label.offline', labelParams: {} };
  }

  // 2. 失败 / 终止报错（含瞬时事件、致命 HMS）
  if (gcode === GCODE.FAILED || r.print_error || r.print_canceled || hasFatalHms(hms)) {
    const code = firstHmsCode(hms);
    if (code) {
      return { stateKey: 'failed', videoFile: VIDEO.failed, labelKey: 'label.failed.hms', labelParams: { code } };
    }
    return { stateKey: 'failed', videoFile: VIDEO.failed, labelKey: 'label.failed', labelParams: {} };
  }

  // 3. 完成
  if (gcode === GCODE.FINISH) {
    return { stateKey: 'finished', videoFile: VIDEO.finished, labelKey: 'label.finished', labelParams: {} };
  }

  // 4. 暂停 / 可恢复错误
  if (gcode === GCODE.PAUSE) {
    if (r.door_open) {
      return { stateKey: 'paused', videoFile: VIDEO.paused, labelKey: 'label.doorOpen', labelParams: {} };
    }
    const pl = pauseLabel(stg);
    return { stateKey: 'paused', videoFile: VIDEO.paused, labelKey: pl.labelKey, labelParams: pl.labelParams };
  }

  // 舱门打开（非 PAUSE 也提示）
  if (r.door_open && gcode !== GCODE.RUNNING) {
    return { stateKey: 'paused', videoFile: VIDEO.paused, labelKey: 'label.doorOpen', labelParams: {} };
  }

  // 5. 准备中
  if (gcode === GCODE.PREPARE) {
    const sl = stageLabel(stg);
    return { stateKey: 'prepare', videoFile: VIDEO.prepare, labelKey: sl.labelKey, labelParams: sl.labelParams };
  }

  // 6. 打印中（RUNNING）。打印过程中 stg_cur 可能是换料 / 中途校准 / 各种自检，
  //    按 STAGE_VIDEO 归到最贴近的动画；正常打印（stg=0 或未知）按进度选档。
  if (gcode === GCODE.RUNNING) {
    if (CHANGING_FILAMENT_STAGES.has(stg)) {
      // stg=4 用通用「换料」文案（兼容旧行为）；22/24/68/77 用精确文案（退料/进料/…）
      const labelKey = stg === STAGE.CHANGING_FILAMENT ? 'label.changingFilament' : (stageLabelKey(stg) || 'label.changingFilament');
      return { stateKey: 'changing_filament', videoFile: VIDEO.changing_filament, labelKey, labelParams: {} };
    }
    const cat = STAGE_VIDEO[stg];
    if (cat === 'prepare') {
      // 打印中途的校准 / 自检等：归到准备动画 + 精确文案
      return { stateKey: 'prepare', videoFile: VIDEO.prepare, labelKey: stageLabelKey(stg), labelParams: {} };
    }
    if (cat === 'paused') {
      // 异常少见：RUNNING 却报暂停类 stage，按暂停处理
      return { stateKey: 'paused', videoFile: VIDEO.paused, labelKey: stageLabelKey(stg), labelParams: {} };
    }
    // cat === 'printing'（stg=0）或未知 → 正常打印，按进度选档
    const videoFile = printingVideoByPercent(percent);
    const p = Number(percent) || 0;
    const stateKey = videoFile.replace('.webm', '');
    if (Number.isFinite(layer) && Number.isFinite(totalLayer) && totalLayer > 0) {
      return { stateKey, videoFile, labelKey: 'label.printing.layer', labelParams: { p, layer, total: totalLayer } };
    }
    return { stateKey, videoFile, labelKey: 'label.printing', labelParams: { p } };
  }

  // 7. 空闲
  if (gcode === GCODE.IDLE) {
    return { stateKey: 'idle', videoFile: VIDEO.idle, labelKey: 'label.idle', labelParams: {} };
  }

  // 8. 兜底
  return { stateKey: 'idle', videoFile: VIDEO.idle, labelKey: 'label.idle', labelParams: {} };
}

/**
 * 从 MQTT 报文中提取温度等实时指标，兼容不同固件版本的字段名。
 * @param {object} report - MQTT print 对象（已合并的完整状态）
 * @returns {{ nozzleTemp: number|null, targetNozzleTemp: number|null, bedTemp: number|null, targetBedTemp: number|null, chamberTemp: number|null, remainingTime: number|null }}
 */
function extractTemps(report) {
  const r = report || {};
  const nozzleTemp = Array.isArray(r.nozzle_temps) ? r.nozzle_temps[0] : r.nozzle_temp;
  const bedTemp = Array.isArray(r.bed_temps) ? r.bed_temps[0] : r.bed_temp;
  return {
    nozzleTemp: Number.isFinite(nozzleTemp) ? Math.round(nozzleTemp) : null,
    targetNozzleTemp: Number.isFinite(r.target_nozzle_temp) ? Math.round(r.target_nozzle_temp) : null,
    bedTemp: Number.isFinite(bedTemp) ? Math.round(bedTemp) : null,
    targetBedTemp: Number.isFinite(r.target_bed_temp) ? Math.round(r.target_bed_temp) : null,
    chamberTemp: Number.isFinite(r.chamber_temp) ? Math.round(r.chamber_temp) : null,
    remainingTime: Number.isFinite(r.remaining_time) ? r.remaining_time : null,
  };
}

/**
 * 将剩余时间（分钟）格式化为用户可读字符串。
 * @param {number|null|undefined} minutes
 * @returns {string|null}
 */
function formatRemainingTime(minutes) {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes < 60) return `剩余 ${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `剩余 ${h}h${m}m` : `剩余 ${h}h`;
}

module.exports = { resolveState, stageLabel, pauseLabel, hasFatalHms, extractTemps, formatRemainingTime, GCODE };
