// 当前打印耗材颜色解析（纯函数，无 Electron 依赖）。
// 字段语义以 OpenBambuAPI mqtt.md / pybambu 为准（CLAUDE.md：逆向协议以 pybambu 为真相源）：
//   ams.tray_now: "255" 无耗材 | "254" 外挂料盘（vt_tray）| 其余 = ams_id*4 + tray_id
//   tray_color: RRGGBBAA 十六进制（alpha 恒 FF，忽略）

const TRAY_NOW_EXTERNAL = 254; // 外挂料盘 → vt_tray
const TRAY_NOW_NONE = 255;     // 无耗材

/** RRGGBBAA → '#rrggbb'；非法返回 null。 */
function parseTrayColor(raw) {
  if (typeof raw !== 'string' || raw.length < 6) return null;
  const rgb = raw.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(rgb)) return null;
  return '#' + rgb.toLowerCase();
}

/**
 * 从合并后的报文取当前正在用的耗材颜色。
 * @returns {'#rrggbb'|null} 无法确定时返回 null（渲染层保持原始素材色）
 */
function resolveFilamentColor(report) {
  if (!report || !report.ams) return null;
  const now = Number(report.ams.tray_now);
  if (!Number.isFinite(now) || now === TRAY_NOW_NONE) return null;

  if (now === TRAY_NOW_EXTERNAL) {
    return parseTrayColor(report.vt_tray && report.vt_tray.tray_color);
  }

  const amsId = Math.floor(now / 4);
  const slotId = now % 4;
  const units = Array.isArray(report.ams.ams) ? report.ams.ams : [];
  // 优先按 id 字段匹配（报文里 id 为字符串），缺 id 时按数组下标回退
  const unit = units.find((u) => u && Number(u.id) === amsId) || units[amsId];
  const trays = unit && Array.isArray(unit.tray) ? unit.tray : [];
  const tray = trays.find((t) => t && Number(t.id) === slotId) || trays[slotId];
  return parseTrayColor(tray && tray.tray_color);
}

module.exports = { resolveFilamentColor };
