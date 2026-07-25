// 当前打印耗材颜色解析（纯函数，无 Electron 依赖）。
// 字段语义以 OpenBambuAPI mqtt.md / pybambu 为准（CLAUDE.md：逆向协议以 pybambu 为真相源）：
//   ams.tray_now: "255" 无耗材 | "254" 外挂料盘（vt_tray）| 其余 = ams_id*4 + tray_id
//   tray_color: RRGGBBAA 十六进制（alpha 恒 FF，忽略）

const TRAY_NOW_EXTERNAL = 254; // 外挂料盘 → vt_tray
const TRAY_NOW_NONE = 255;     // 无耗材
const SLOT_NONE = 0xffff;      // extruder.snow 空槽哨兵（真机实测 65535）

/** RRGGBBAA → '#rrggbb'；非法返回 null。 */
function parseTrayColor(raw) {
  if (typeof raw !== 'string' || raw.length < 6) return null;
  const rgb = raw.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(rgb)) return null;
  return '#' + rgb.toLowerCase();
}

/** 从合并后的报文取 AMS 单元 amsId 的 slotId 槽颜色；缺 id 时按数组下标回退。 */
function colorAtSlot(report, amsId, slotId) {
  const units = Array.isArray(report.ams.ams) ? report.ams.ams : [];
  const unit = units.find((u) => u && Number(u.id) === amsId) || units[amsId];
  const trays = unit && Array.isArray(unit.tray) ? unit.tray : [];
  const tray = trays.find((t) => t && Number(t.id) === slotId) || trays[slotId];
  return parseTrayColor(tray && tray.tray_color);
}

/**
 * 双喷头取色（H2D / H2C 等共用「双头挤出单元」的机型；本项目最初在一台双头机上验证）：
 * 两卷料同时在走，ams.tray_now 只反映其中一个喷头、无法代表正在出料的主喷头。改认
 * device.extruder.info[].snow（正在出料喷头的当前装载槽）：
 *   snow = 高字节 ams_id | 低字节 tray_id，0xFFFF=空槽；stat 非 0 = 该喷头正在出料。
 * ⚠️ 解码用「字节拆分」(>>8 / &0xFF) 是真机抓包实证的：一台双头机上 snow=257 → AMS1 槽1，
 *    与该帧 ams 数组里 id=1 槽 tray_color 的粉色对得上，全程 353 帧稳定。
 *    pybambu 对 snow 只有一句「bottom 4 bits is tray, remainder is ams index」的注释、无实现，
 *    且作者自注「not sure about ams HT 128+」；按其「半字节拆分」(>>4) 解码 257 会得 ams=16，
 *    在真机上对不到槽 → 与实测矛盾，故不采用。若拿到 AMS-HT（ams 索引 128+）真机再核实。
 *    非双头机（extruder.info < 2 项）走原 tray_now，不受影响。
 * 解不到槽时返回 null（保持原始素材色），绝不回落到会指错喷头的 tray_now，故不会显示错色。
 * @returns {'#rrggbb'|null|undefined} undefined = 非双喷头/无 extruder.info（交回单喷头逻辑）；
 *   否则返回正在出料喷头的颜色（拿不到则 null，不回落到会指错的 tray_now）。
 */
function resolveDualNozzleColor(report) {
  const info = report.device && report.device.extruder && report.device.extruder.info;
  if (!Array.isArray(info) || info.length < 2) return undefined; // 单喷头 → 走 tray_now
  // 正在出料 = snow 有效（非空槽）且 stat 非 0。两头同时出料时取第一个在打的即可。
  const active = info.find((e) => {
    const snow = Number(e && e.snow);
    return Number.isFinite(snow) && snow !== SLOT_NONE && Number(e.stat);
  });
  if (!active) return null;
  const snow = Number(active.snow);
  return colorAtSlot(report, (snow >> 8) & 0xff, snow & 0xff);
}

/**
 * 从合并后的报文取当前正在用的耗材颜色。
 * @returns {'#rrggbb'|null} 无法确定时返回 null（渲染层保持原始素材色）
 */
function resolveFilamentColor(report) {
  if (!report || !report.ams) return null;

  const dual = resolveDualNozzleColor(report);
  if (dual !== undefined) return dual; // 双喷头分支已定论（含拿不到 → null）

  const now = Number(report.ams.tray_now);
  if (!Number.isFinite(now) || now === TRAY_NOW_NONE) return null;

  if (now === TRAY_NOW_EXTERNAL) {
    return parseTrayColor(report.vt_tray && report.vt_tray.tray_color);
  }

  return colorAtSlot(report, Math.floor(now / 4), now % 4);
}

module.exports = { resolveFilamentColor };
