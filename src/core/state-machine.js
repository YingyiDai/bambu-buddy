// 状态机核心：数据报文 → { stateKey, videoFile, labelKey, labelParams }（纯函数，便于单测）
// 解析优先级见技术文档 §6.2，labelKey 映射见 §6.4。

const { STAGE, CHANGING_FILAMENT_STAGES, VIDEO, STAGE_VIDEO } = require('../config/state-map');

// 任一已知 stg_cur 的精确文案 key（取自 Bambu Studio，见 locales.js label.stage.<n>）。
// 未知 stage 返回 null，由调用方走大状态兜底。
function stageLabelKey(stg) {
  return STAGE_VIDEO[stg] != null ? `label.stage.${stg}` : null;
}

// 「用户主动取消打印」的 fail_reason 码。取消一个任务后 gcode_state 会粘滞在 FAILED（与真正
// 故障无法从 gcode_state 区分），但打印机会把持续字段 fail_reason 置为此码 —— 真机取证 + Bambu
// 论坛 "Printing Was Cancelled [0300 400C]" 均证实 0x0300400C=50348044 即「打印被取消」。
// 因是持续字段（pushall 也带），即便应用在取消之后才启动、只能收到残留状态，也能据此判定为取消。
const FAIL_REASON_USER_CANCELED = 50348044; // 0x0300400C

// 本次终止是否为用户主动取消：持续字段 fail_reason（冷启动也可靠）优先，
// 兼收数据源透出的瞬时/持久 print_canceled 事件（应用在线时更早响应）。
function isUserCanceled(r) {
  return r.print_canceled === true || Number(r.fail_reason) === FAIL_REASON_USER_CANCELED;
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
      // 仅当该 stg 本身属于「暂停类」阶段时才用精确文案；否则兜底通用「暂停」。
      // ⚠️ 真机断料暂停常给 stg_cur=0（无细分子阶段），而 label.stage.0 文案是「打印中」——
      //    若直接用 stageLabelKey(0) 会让暂停熊猫下方错显「打印中」、卡片状态也串成打印中。
      //    故非暂停类 stg（0=打印 / 校准 / 准备等）一律兜底 label.paused。
      const k = STAGE_VIDEO[stg] === 'paused' ? stageLabelKey(stg) : null;
      return { labelKey: k || 'label.paused.generic', labelParams: {} };
    }
  }
}

// AMS 自身状态 ams_status（pybambu/BambuStudio）。高字节 main==1 = 换料中
//（AMS_STATUS_MAIN_FILAMENT_CHANGE，解码见 DeviceManager.cpp _parse_ams_status）。
// P1/A1 打印中换料常停在 stg_cur=0，只能靠此识别；X 系列另给 stg_cur=4/22/24，两信号并存不冲突。
// 字段位置按机型/固件可能在顶层 ams_status 或嵌套 ams.ams_status，两处都兜。
function amsChangingFilament(r) {
  const raw = r.ams_status != null ? r.ams_status : (r.ams && r.ams.ams_status);
  return Number.isFinite(raw) && ((raw & 0xff00) >> 8) === 1;
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
// ⚠️ 未经真机验证：真机 HMS 多半把严重度编码在 code 位里而非 severity 字段，
//    拿到真实 HMS 报文样本后需对照 pybambu 重新校正此判定。
function hasFatalHms(hms) {
  if (!Array.isArray(hms)) return false;
  return hms.some((h) => {
    if (!h) return false;
    const sev = (h.severity || h.level || '').toString().toLowerCase();
    return sev === 'fatal' || sev === 'serious';
  });
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

  // 2. 完成
  if (gcode === GCODE.FINISH) {
    return { stateKey: 'finished', videoFile: VIDEO.finished, labelKey: 'label.finished', labelParams: {} };
  }

  // 2.5 用户主动取消。取消一个任务时打印机同样把 gcode_state 置为 FAILED（与真正故障无法从
  //     gcode_state 区分），且该 FAILED 会一直残留到下次开印 —— 若据此显示「打印失败」，取消后
  //     熊猫会一直挂着「打印失败 · <残留 HMS code>」，而 Bambu Studio 早已回到空闲，造成状态不符。
  //     用 fail_reason=0x0300400C（持续字段，冷启动也可靠）判定取消，命中即视作普通结束 → 空闲。
  if (isUserCanceled(r)) {
    return { stateKey: 'idle', videoFile: VIDEO.idle, labelKey: 'label.idle', labelParams: {} };
  }

  // 3. 暂停 / 可恢复错误。gcode_state 是权威生命周期信号：打印机报 PAUSE 即「可恢复暂停」
  //    （断料、堵头、舱门等），必须先于失败判定。断料时 print_error 会被置为非零诊断码，
  //    若失败判定在前会把可恢复暂停误升级为「打印失败」（曾出现卡片「离线」+ 熊猫「失败」的状态不符 bug）。
  if (gcode === GCODE.PAUSE) {
    if (r.door_open) {
      return { stateKey: 'paused', videoFile: VIDEO.paused, labelKey: 'label.doorOpen', labelParams: {} };
    }
    const pl = pauseLabel(stg);
    return { stateKey: 'paused', videoFile: VIDEO.paused, labelKey: pl.labelKey, labelParams: pl.labelParams };
  }

  // 4. 失败 / 终止报错。仅以权威信号判定终止失败：gcode_state=FAILED、致命 HMS。
  //    （用户取消已在第 2.5 步分流为空闲，不会走到这里。）
  //    ⚠️ 不把 print_error 当作失败依据 —— 它是持续型诊断码，断料等可恢复情形也会置非零，
  //    且在增量报文合并后会跨帧残留，据此判失败会让状态长期卡在「失败」。
  if (gcode === GCODE.FAILED || hasFatalHms(hms)) {
    // 统一返回通用 label.failed；「打印失败 · 大类」的大类由主进程用官方码表在此之上注入
    // （state-machine 是纯函数、拿不到需异步下载的官方表，故大类增强放主进程，见 main.js#applyReport）。
    return { stateKey: 'failed', videoFile: VIDEO.failed, labelKey: 'label.failed', labelParams: {} };
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
    if (CHANGING_FILAMENT_STAGES.has(stg) || amsChangingFilament(r)) {
      // stg 命中：stg=4 用通用「换料」文案（兼容旧行为），22/24/68/77 用精确文案（退料/进料/…）。
      // 仅 AMS 命中（P1/A1 换料常停在 stg_cur=0，无细分子阶段）：用通用「换料」文案。
      const labelKey = !CHANGING_FILAMENT_STAGES.has(stg)
        ? 'label.changingFilament'
        : (stg === STAGE.CHANGING_FILAMENT ? 'label.changingFilament' : (stageLabelKey(stg) || 'label.changingFilament'));
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

// 取参数里第一个有限数；都不是数字则 null。
function firstNum(...vals) {
  for (const v of vals) if (Number.isFinite(v)) return v;
  return null;
}

/**
 * 从 MQTT 报文中提取温度等实时指标，兼容多代固件字段名（pybambu 为事实来源）。
 * 优先级：新固件嵌套 device.*（一个 int 打包，低 16 位=当前 / 高 16 位=目标）
 *        → 旧固件扁平 *_temper（真机权威名）→ 本仓早期兜底字段名。
 * ⚠️ 历史上此处读的是 nozzle_temp / bed_temp / target_* / remaining_time —— 与真机
 *    实际字段（nozzle_temper / bed_temper / mc_remaining_time…）都对不上，导致老机型
 *    （X1/P1）卡片温度、剩余时间长期为空。
 * @param {object} report - MQTT print 对象（已合并的完整状态）
 * @returns {{ nozzleTemp: number|null, targetNozzleTemp: number|null, bedTemp: number|null, targetBedTemp: number|null, chamberTemp: number|null, remainingTime: number|null }}
 */
function extractTemps(report) {
  const r = report || {};
  const dev = r.device || {};

  // 新固件：温度嵌套在 device.* 且用一个 int 打包（低 16 位=当前，高 16 位=目标）。
  const extInfo = dev.extruder && Array.isArray(dev.extruder.info) ? dev.extruder.info : null;
  const extEntry = extInfo ? (extInfo.find((e) => e && (e.id === 0 || e.id === 1)) || extInfo[0]) : null;
  const extPacked = extEntry && Number.isFinite(extEntry.temp) ? extEntry.temp : null;
  const bedPacked = dev.bed && dev.bed.info && Number.isFinite(dev.bed.info.temp) ? dev.bed.info.temp : null;
  const ctcPacked = dev.ctc && dev.ctc.info && Number.isFinite(dev.ctc.info.temp) ? dev.ctc.info.temp : null;

  const nozzleCur = firstNum(extPacked != null ? (extPacked & 0xffff) : NaN, r.nozzle_temper,
    Array.isArray(r.nozzle_temps) ? r.nozzle_temps[0] : r.nozzle_temp);
  const nozzleTar = firstNum(extPacked != null ? ((extPacked >> 16) & 0xffff) : NaN,
    r.nozzle_target_temper, r.target_nozzle_temp);
  const bedCur = firstNum(bedPacked != null ? (bedPacked & 0xffff) : NaN, r.bed_temper,
    Array.isArray(r.bed_temps) ? r.bed_temps[0] : r.bed_temp);
  const bedTar = firstNum(bedPacked != null ? ((bedPacked >> 16) & 0xffff) : NaN,
    r.bed_target_temper, r.target_bed_temp);
  const chamberCur = firstNum(ctcPacked != null ? (ctcPacked & 0xffff) : NaN, r.chamber_temper, r.chamber_temp);

  return {
    nozzleTemp: nozzleCur != null ? Math.round(nozzleCur) : null,
    targetNozzleTemp: nozzleTar != null ? Math.round(nozzleTar) : null,
    bedTemp: bedCur != null ? Math.round(bedCur) : null,
    targetBedTemp: bedTar != null ? Math.round(bedTar) : null,
    chamberTemp: chamberCur != null ? Math.round(chamberCur) : null,
    remainingTime: firstNum(r.mc_remaining_time, r.remaining_time),
  };
}

module.exports = { resolveState, stageLabel, pauseLabel, hasFatalHms, extractTemps, GCODE };
