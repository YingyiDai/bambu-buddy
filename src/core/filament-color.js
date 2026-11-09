// 当前打印耗材颜色解析（纯函数，无 Electron 依赖）。
// 字段语义以 OpenBambuAPI mqtt.md / pybambu 为准（CLAUDE.md：逆向协议以 pybambu 为真相源）：
//   ams.tray_now: "255" 无耗材 | "254" 外挂料盘（vt_tray）| 其余 = ams_id*4 + tray_id
//   tray_color: RRGGBBAA 十六进制。⚠️ alpha **不是**恒 FF：真机把「这一槽没有颜色信息」
//     报成全零的 "00000000"（空槽、外挂料盘未设色、AMS 刚重读完 RFID 的过渡帧都见得到），
//     而真·黑色耗材是 "000000FF"。alpha 是区分二者的唯一线索，不可忽略。

const TRAY_NOW_EXTERNAL = 254; // 外挂料盘 → vt_tray
const TRAY_NOW_NONE = 255;     // 无耗材
const SLOT_NONE = 0xffff;      // extruder.snow 空槽哨兵（真机实测 65535）
// snow 高字节（ams_id 位）落在这两个值上 = 该喷头吃的是外挂料盘、不是 AMS 槽。
// 254 对齐 tray_now 的外挂哨兵；255 是双喷头机第二个外挂位（pybambu 的 deputy 外挂）。
const EXTERNAL_AMS_IDS = new Set([254, 255]);

/**
 * RRGGBBAA → '#rrggbb'；非法或「无颜色」返回 null。
 * alpha=00 = 无颜色哨兵，必须判 null 而不是取前 6 位：否则空槽/未设色的 "00000000"
 * 会被读成真·黑色，白料打印时熊猫叼一卷黑丝（真黑耗材是 "000000FF"，不受影响）。
 */
function parseTrayColor(raw) {
  if (typeof raw !== 'string' || raw.length < 6) return null;
  const rgb = raw.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(rgb)) return null;
  if (raw.slice(6, 8) === '00') return null; // alpha=00 → 无颜色，不是黑色
  return '#' + rgb.toLowerCase();
}

function amsUnits(report) {
  const ams = report.ams;
  return ams && Array.isArray(ams.ams) ? ams.ams : [];
}

/**
 * 从合并后的报文取 AMS 单元 amsId 的 slotId 槽颜色；缺 id 时按数组下标回退。
 * strict=true 只认 id、不按下标回退：换刀机（H3C）上单元/槽的 id 不是 0 起的连续下标，
 * 按下标兜底会落到别的槽上，宁可无结论。
 */
function colorAtSlot(report, amsId, slotId, strict = false) {
  const units = amsUnits(report);
  const unit = units.find((u) => u && Number(u.id) === amsId) || (strict ? null : units[amsId]);
  const trays = unit && Array.isArray(unit.tray) ? unit.tray : [];
  const tray = trays.find((t) => t && Number(t.id) === slotId) || (strict ? null : trays[slotId]);
  return parseTrayColor(tray && tray.tray_color);
}

// ── 直连式换刀机（H3C）──────────────────────────────────────────────
// 依据 BambuStudio 2.9.1 开源实现（DevNozzleSystem / DevNozzleRack / DevFilaSystem），H3C 尚无真机报文验证：
//   · device.holder.info2 位 1–4 = 工具架类型；>0（RackType_A/B/C）= 「直连式」工具架：每个打印头（PrintTool）
//     有自己的进料通道，AMS 槽 n 直通 addr_id=n 的打印头。H2C 的 Vortek 是 RackType_AB(0)，不算直连。
//   · AMS 单元 info（十六进制串）最低 4 位 = 类型；6/7 = ZMULTI_A/B（6 即 H3C 的 AMS 3H，9 槽）。
//   · device.nozzle.info[]：id 低 4 位 = 喷嘴号，次低 4 位 == 1 表示「挂在工具架上」；
//     不在架上的那项 = 当前装在挤出机上、正在用的打印头。其 snow = 高字节 ams_id | 低字节槽号（低字节 0xFF=空），
//     addr_id = 打印头编号（0–8），temp = 低 16 位当前 / 高 16 位目标温度。
//   · device.extruder.state 位 4–7 = 当前挤出机号。
const RACK_AMS_TYPES = new Set([6, 7]); // ZMULTI_A（AMS 3H）/ ZMULTI_B

/** AMS 单元类型：info 十六进制串的最低 4 位；取不到返回 null。 */
function amsUnitType(unit) {
  const hex = unit && typeof unit.info === 'string' ? unit.info.replace(/[^0-9a-fA-F]/g, '') : '';
  return hex ? parseInt(hex.slice(-1), 16) : null;
}

/** 是否「直连式工具架」换刀机（H3C 这一类）。只认 BambuStudio 明确给出的两个信号。 */
function isDirectRackPrinter(report) {
  if (!report) return false;
  const holder = report.device && report.device.holder;
  const info2 = holder && Number(holder.info2);
  if (Number.isFinite(info2) && ((info2 >> 1) & 0xf) > 0) return true;
  return amsUnits(report).some((u) => RACK_AMS_TYPES.has(amsUnitType(u)));
}

/**
 * 当前装在挤出机上的打印头（device.nozzle.info 里不在工具架上的那项）。
 * 有多项不在架上时按 extruder.state 的当前挤出机号挑；挑不出唯一一项返回 null。
 */
function mountedTool(report) {
  const dev = report && report.device;
  const info = dev && dev.nozzle && dev.nozzle.info;
  if (!Array.isArray(info)) return null;
  const mounted = info.filter((n) => n && Number.isFinite(Number(n.id)) && ((Number(n.id) >> 4) & 0xf) !== 1);
  if (mounted.length === 1) return mounted[0];
  const state = dev.extruder && Number(dev.extruder.state);
  if (mounted.length > 1 && Number.isFinite(state)) {
    const cur = (state >> 4) & 0xf;
    const hit = mounted.filter((n) => (Number(n.id) & 0xf) === cur);
    if (hit.length === 1) return hit[0];
  }
  return null;
}

/** 外挂料盘里 id 恰为 trayId 的那条的颜色（不兜底取第一条）。 */
function externalColorStrict(report, trayId) {
  const vt = report.vt_tray;
  const list = Array.isArray(vt) ? vt : (vt ? [vt] : []);
  const t = list.find((x) => x && Number(x.id) === trayId);
  return parseTrayColor(t && t.tray_color);
}

/**
 * 直连式换刀机取色：当前打印头 → 它的进料槽 → tray_color。
 * ⚠️ 这条路径**没有真机验证**，所以拿不到结论就返回 null（熊猫保持原色），
 *    不回落到 tray_now / 双喷头逻辑 —— 后两者的槽号编码（ams_id*4+槽）在 9 槽 AMS 上必然算错，
 *    「显示错色」比「不改色」更误导人。
 */
function resolveRackToolColor(report) {
  const tool = mountedTool(report);
  if (!tool) return null;

  // 1) snow：打印头当前装载的槽（与双喷头机的 extruder.snow 同一编码）。
  const snow = Number(tool.snow);
  if (Number.isFinite(snow) && (snow & 0xff) !== 0xff) {
    const amsId = (snow >> 8) & 0xff;
    const slotId = snow & 0xff;
    const c = EXTERNAL_AMS_IDS.has(amsId)
      ? externalColorStrict(report, slotId)
      : colorAtSlot(report, amsId, slotId, true);
    if (c) return c;
  }

  // 2) addr_id：直连式工具架上 AMS 3H 的槽 n 直通 n 号打印头；外挂料盘 id = 255 - n
  //    （BambuStudio DevAmsTray::get_nozzle_addr_id 的反向映射）。
  const addr = Number(tool.addr_id);
  if (!Number.isFinite(addr)) return null;
  for (const unit of amsUnits(report)) {
    if (!RACK_AMS_TYPES.has(amsUnitType(unit)) || !Array.isArray(unit.tray)) continue;
    const tray = unit.tray.find((t) => t && Number(t.id) === addr);
    const c = parseTrayColor(tray && tray.tray_color);
    if (c) return c;
  }
  return externalColorStrict(report, 255 - addr);
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
  // snow 可读的喷头。⚠️ 「snow 字段缺失」与「snow=0xFFFF 空槽」是两回事：前者只说明这一帧
  //    没带这个喷头的装载信息（增量报文常态），后者才是打印机明说「这个喷头没装料」。
  const known = info.filter((e) => Number.isFinite(Number(e && e.snow)));
  const loaded = known.filter((e) => Number(e.snow) !== SLOT_NONE);
  // stat 非 0 = 正在出料，优先按它认主喷头；但 stat 只在一台真机上验证过，缺失/恒 0 的机型
  // 不能因此判「没有喷头在打」—— 只有一个喷头装着料时它必然就是在打的那个，直接认它
  // （这一步救回 stat 语义不符的机型）。
  // 该兜底只在**每个喷头的 snow 都读得到**时才成立：若另一个喷头的 snow 缺失，「只有一个装料」
  // 是我们信息不全的假象而非事实，据此认主喷头会把闲置喷头的耗材色当成正在打的色
  // （白料熊猫叼黑丝的成因之一）。信息不全就交回 tray_now，别自作主张。
  const complete = known.length === info.length;
  // 两头同时出料时取第一个在打的即可。
  const active = loaded.find((e) => Number(e.stat))
    || (loaded.length === 1 && complete ? loaded[0] : null);
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

  // 直连式换刀机（H3C）走专用路径，解不出就是 null，不进下面按 4 槽编码的老路径。
  if (isDirectRackPrinter(report)) return resolveRackToolColor(report);

  // 双喷头精修：能定位到正在出料的喷头就用它的色，否则（含单喷头机）交回下面的 tray_now。
  const dual = resolveDualNozzleColor(report);
  if (dual) return dual;

  const ams = report.ams;
  if (!ams) return null;

  const now = Number(ams.tray_now);
  if (!Number.isFinite(now) || now === TRAY_NOW_NONE) return null;

  if (now === TRAY_NOW_EXTERNAL) return externalColor(report, TRAY_NOW_EXTERNAL);

  // AMS HT（单槽）：tray_now 0x80–0x87 直接就是单元 id，槽号恒 0
  // （BambuStudio DevExtruderSystem 解析 tray_now 的分支）。按 /4 拆会得到不存在的单元 32–33。
  if (now >= 0x80 && now <= 0x87) return colorAtSlot(report, now, 0, true);

  return colorAtSlot(report, Math.floor(now / 4), now % 4);
}

module.exports = { resolveFilamentColor, isDirectRackPrinter, mountedTool };
