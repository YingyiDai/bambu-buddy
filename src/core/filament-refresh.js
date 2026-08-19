// 「耗材色刚丢失 → 立刻补一次完整状态（pushall）」的纯决策（无 electron 依赖，时间由外部传入，便于单测）。
//
// 背景：数据源维护的是**粘性合并快照**（见 bambu-mqtt 的 deepMergePatch）。某一帧把 tray_color /
// extruder.snow 变成解不出的形状之后，后续增量帧几乎不会重发这些字段 —— 熊猫就一直不改色（或叼着
// 错色），直到 5 分钟一次的定时 pushall 送来完整快照才自愈。用户实测过这个窗口：「打印中颜色不对，
// 约 5 分钟后自己变回来」。于是在「已知 → 未知」这一跳变上主动补一次 pushall，把恢复窗口从分钟级
// 压到秒级。
//
// 成本可忽略，且与「云端 REST 轮询不宜低于 ~20s」的限流权衡（见 main.js CLOUD_POLL_MS）不是同一条
// 通道：
//   · 只在跳变时开火 —— 颜色解得出来时一次都不发，永远解不出的机器（如外挂料盘从没设过色）也不发；
//   · 打印中本就是每秒一帧增量（~3600 帧/小时），冷却打满也只多 ~60 帧/小时；
//   · LAN 直连的 pushall 全程在局域网内，零外部成本。
// 同一模式已有先例：云端轮询检出打印机上线的上升沿 → hub.refresh(serial)。

const COLOR_LOSS_COOLDOWN_MS = 60 * 1000;

/**
 * 该不该为「耗材色丢失」补一次 pushall。
 * @param {object} o
 * @param {string|null} o.prevColor - 上一帧解析出的耗材色（null = 当时就不知道）
 * @param {string|null} o.nextColor - 本帧解析出的耗材色（null = 现在不知道了）
 * @param {boolean} o.printActive - 是否在打印中（不打印时改不改色都无所谓，不值得打扰打印机）
 * @param {number} [o.lastRefreshAt] - 上次因本原因补拉的时刻（未补过时留空）
 * @param {number} o.now
 * @param {number} [o.cooldownMs]
 * @returns {boolean}
 */
function shouldRefreshOnColorLoss({
  prevColor, nextColor, printActive, lastRefreshAt, now, cooldownMs = COLOR_LOSS_COOLDOWN_MS,
}) {
  // 只认「已知 → 未知」这一跳：一直未知说明这台本就取不到色（补拉也没用，且会每帧都想补），
  // 换色/保持已知则本来就是对的。
  if (!prevColor || nextColor) return false;
  if (!printActive) return false;
  // 颜色反复丢失/恢复时按冷却限频，给出最坏频次的硬上限。
  if (Number.isFinite(lastRefreshAt) && now - lastRefreshAt < cooldownMs) return false;
  return true;
}

module.exports = { shouldRefreshOnColorLoss, COLOR_LOSS_COOLDOWN_MS };
