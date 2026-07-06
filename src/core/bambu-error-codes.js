// 官方错误码表（BambuStudio resources/hms/hms_<lang>_<model>.json）的解析与按码查文案。
// 纯逻辑、无 electron 依赖 —— 下载 / 缓存 / 文件 IO 由 main.js 负责，本模块只做解析与查表，便于单测。
//
// 数据结构（真机取证 hms_zh-cn_20P.json）：
//   { data: { device_error: { ver, "<lang>": [{ ecode, intro }] },
//             device_hms:   { ver, "<lang>": [{ ecode, intro }] } } }
//   - device_error：8 hex 设备错误码，对应报文 fail_reason（如 0300400C = 任务已取消）。
//   - device_hms：  16 hex HMS 码，对应报文 hms[].attr(高 8 hex) + code(低 8 hex)。
// 事实来源与 bambu-mqtt/state-machine 一致：字段以真机报文 + BambuStudio 官方文件为准。

function listOf(section, lang) {
  return section && Array.isArray(section[lang]) ? section[lang] : [];
}

// 解析成 { deviceError: Map, deviceHms: Map, ver }；ecode 统一大写归一以便查表。
function parseErrorTable(json, lang) {
  const data = (json && json.data) || {};
  const toMap = (section) => {
    const m = new Map();
    for (const e of listOf(section, lang)) {
      if (e && e.ecode) m.set(String(e.ecode).toUpperCase(), e.intro || '');
    }
    return m;
  };
  return {
    deviceError: toMap(data.device_error),
    deviceHms: toMap(data.device_hms),
    ver: (data.device_error && data.device_error.ver) || 0,
  };
}

const hex8 = (n) => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

// 报文 → 官方失败原因文案；查不到返回 null（调用方回退通用「打印失败」）。仅在熊猫已判定 failed 时调用。
// 优先用 fail_reason 查 device_error（失败主因，如取消/断料/堵头）；无文案再用 hms[0] 查 device_hms 兜底。
// intro 为空串视作「无可显示文案」，继续兜底 / 返回 null。
function lookupFailureReason(report, table) {
  if (!report || !table) return null;
  const fr = Number(report.fail_reason);
  if (Number.isFinite(fr) && fr !== 0) {
    const intro = table.deviceError.get(hex8(fr));
    if (intro) return intro;
  }
  const h = Array.isArray(report.hms) ? report.hms[0] : null;
  if (h && Number.isFinite(h.attr) && Number.isFinite(h.code)) {
    const intro = table.deviceHms.get(hex8(h.attr) + hex8(h.code));
    if (intro) return intro;
  }
  return null;
}

// 官方原因文本 → 熊猫展示的「大类」key。熊猫只显示粗粒度大类（断料/堵头/…），具体长句请去 Bambu Studio 看。
// 关键词按特异性排序：越具体越靠前（如「耗材用尽」归 runout，不被更泛的 nozzle/ams 抢先）。中英关键词合并匹配。
const FAILURE_CATEGORIES = [
  ['runout', ['断料', '耗材用尽', '无耗材', '缺料', 'run out', 'runout', 'ran out']],
  ['clog', ['堵头', '堵塞', '卡料', '卡住', '冲刷旧料', '缠绕', 'clog', 'tangl', 'jam', 'stuck']],
  ['temp', ['温度', '过热', '热失控', '热端温度', 'temperature', 'thermal', 'overheat']],
  ['motion', ['撞', '碰撞', '丢步', '掉步', '错层', '电机', '过载', 'collision', 'step loss', 'motor', 'overload']],
  ['calibration', ['校准', '调平', 'calibrat', 'leveling']],
  ['plate', ['打印板', '热床', '前盖脱落', '编码板', 'build plate', 'heatbed', 'plate']],
  ['nozzle', ['喷嘴', '挤出机', 'ptfe', '切刀', 'nozzle', 'extruder']],
  ['ams', ['ams']],
];

function matchKw(text, low, kw) {
  return /[一-龥]/.test(kw) ? text.includes(kw) : low.includes(kw.toLowerCase());
}

// 官方原因文本 → 大类 key（如 'clog'）；认不出返回 null（熊猫回退通用「打印失败」）。
function categorizeFailure(intro) {
  if (!intro) return null;
  const text = String(intro);
  const low = text.toLowerCase();
  for (const [cat, kws] of FAILURE_CATEGORIES) {
    if (kws.some((k) => matchKw(text, low, k))) return cat;
  }
  return null;
}

// 报文 + 官方码表 → 失败大类 key（失败时用）。查不到官方文案 / 认不出大类 → null。
function failureCategory(report, table) {
  return categorizeFailure(lookupFailureReason(report, table));
}

// 序列号前三位即 BambuStudio 码表文件的机型代号（真机取证：20P6BJ...→20P；文件名 hms_<lang>_<model>.json）。
function modelCodeFromSerial(serial) {
  if (!serial) return null;
  const s = String(serial).trim();
  return s.length >= 3 ? s.slice(0, 3).toUpperCase() : null;
}

// app locale → 码表语言 key（也是文件名里的 <lang> 段）。中文统一简中，其余英文兜底。
function langForLocale(locale) {
  return /^zh/i.test(String(locale || '')) ? 'zh-cn' : 'en';
}

module.exports = {
  parseErrorTable, lookupFailureReason, categorizeFailure, failureCategory,
  modelCodeFromSerial, langForLocale,
};
