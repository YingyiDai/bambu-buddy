// 当前打印耗材颜色解析（纯函数，无 Electron 依赖）。
// 字段语义以 OpenBambuAPI mqtt.md / pybambu 为准（CLAUDE.md：逆向协议以 pybambu 为真相源）：
//   ams.tray_now: "255" 无耗材 | "254" 外挂料盘（vt_tray）| 其余 = ams_id*4 + tray_id
//   tray_color: RRGGBBAA 十六进制（alpha 恒 FF，忽略）

const TRAY_NOW_EXTERNAL = 254; // 外挂料盘 → vt_tray
const TRAY_NOW_NONE = 255;     // 无耗材
const SLOT_NONE = 0xffff;      // extruder.snow 空槽哨兵（真机实测 65535）
// snow 高字节（ams_id 位）落在这两个值上 = 该喷头吃的是外挂料盘、不是 AMS 槽。
// 254 对齐 tray_now 的外挂哨兵；255 是双喷头机第二个外挂位（pybambu 的 deputy 外挂）。
const EXTERNAL_AMS_IDS = new Set([254, 255]);

/** RRGGBBAA → '#rrggbb'；非法返回 null。 */
function parseTrayColor(raw) {
  if (typeof raw !== 'string' || raw.length < 6) return null;
  const rgb = raw.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(rgb)) return null;
  return '#' + rgb.toLowerCase();
}

/** 从合并后的报文取 AMS 单元 amsId 的 slotId 槽颜色；缺 id 时按数组下标回退。 */
function colorAtSlot(report, amsId, slotId) {
  const ams = report.ams;
  const units = ams && Array.isArray(ams.ams) ? ams.ams : [];
  const unit = units.find((u) => u && Number(u.id) === amsId) || units[amsId];
  const trays = unit && Array.isArray(unit.tray) ? unit.tray : [];
  const tray = trays.find((t) => t && Number(t.id) === slotId) || trays[slotId];
  return parseTrayColor(tray && tray.tray_color);
}

/**
 * 外挂料盘颜色。单喷头机 vt_tray 是对象；双喷头机可能给两个外挂位 → 数组（按 id 定位，
 * 定位不到取第一条）。两种形状都吃，避免只认对象形状时双喷头外挂取不到色。
 */
function externalColor(report, slotId) {
  const vt = report.vt_tray;
  if (Array.isArray(vt)) {
    const t = vt.find((x) => x && Number(x.id) === slotId) || vt[0];
    return parseTrayColor(t && t.tray_color);
  }
  return parseTrayColor(vt && vt.tray_color);
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
 *
 * ⚠️ 本分支只做「加法」：拿不到结论一律返回 null 交回 tray_now 老路径，绝不代替它下结论。
 *    早期实现在双喷头分支里直接 return null（有意「宁可不改色也不显示错色」），把「解不出」
 *    与「确定无色」混为一谈 —— 双喷头机只要走到解不出的岔路（下面两条都是真机常态），
 *    跟随耗材颜色就整个失效、熊猫永远叼原始绿，而单喷头机一切正常：
 *      · 用外挂料盘打印（H2D 不带 AMS 是常见配置）：snow 的 ams 字节是外挂哨兵，
 *        在 ams.ams 里永远找不到对应单元 → 老实现 null；而 tray_now=254 走 vt_tray 本来是对的。
 *      · stat 缺失或恒为 0（该字段语义只在一台机器上验证过）→ 无「正在出料」的喷头 → 老实现 null。
 *    现在：外挂显式认 vt_tray；实在解不出就回落 tray_now。回落可能在「真双色打印」时取到
 *    另一喷头的色（这正是当初 null 想规避的），但那是「颜色偏了」，用户仍看得出功能活着；
 *    而返回 null 是「功能死了」——两害相权，取前者。
 *
 * @returns {'#rrggbb'|null} null = 无结论（非双喷头 / 解不出），调用方回落单喷头逻辑。
 */
function resolveDualNozzleColor(report) {
  const info = report.device && report.device.extruder && report.device.extruder.info;
  if (!Array.isArray(info) || info.length < 2) return null; // 单喷头 → 走 tray_now
  // 装着料的喷头（snow 非空槽哨兵）。stat 非 0 = 正在出料，优先按它认主喷头；
  // 但 stat 只在一台真机上验证过，缺失/恒 0 的机型不能因此判「没有喷头在打」——
  // 只有一个喷头装着料时它必然就是在打的那个，直接认它（这一步救回 stat 语义不符的机型）。
  const loaded = info.filter((e) => {
    const snow = Number(e && e.snow);
    return Number.isFinite(snow) && snow !== SLOT_NONE;
  });
  // 两头同时出料时取第一个在打的即可。
  const active = loaded.find((e) => Number(e.stat)) || (loaded.length === 1 ? loaded[0] : null);
  if (!active) return null;

  const snow = Number(active.snow);
  const amsId = (snow >> 8) & 0xff;
  const slotId = snow & 0xff;
  if (EXTERNAL_AMS_IDS.has(amsId)) return externalColor(report, slotId);
  return colorAtSlot(report, amsId, slotId);
}

/**
 * 从合并后的报文取当前正在用的耗材颜色。
 * @returns {'#rrggbb'|null} 无法确定时返回 null（渲染层保持原始素材色）
 */
function resolveFilamentColor(report) {
  if (!report) return null;

  // 双喷头精修：能定位到正在出料的喷头就用它的色，否则（含单喷头机）交回下面的 tray_now。
  const dual = resolveDualNozzleColor(report);
  if (dual) return dual;

  const ams = report.ams;
  if (!ams) return null;

  const now = Number(ams.tray_now);
  if (!Number.isFinite(now) || now === TRAY_NOW_NONE) return null;

  if (now === TRAY_NOW_EXTERNAL) return externalColor(report, TRAY_NOW_EXTERNAL);

  return colorAtSlot(report, Math.floor(now / 4), now % 4);
}

module.exports = { resolveFilamentColor };
