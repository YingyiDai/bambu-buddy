// 「差几个自然日」：按**本机时区的日历天**比较，不是按 24 小时整除。
// 用途：打印中那行的预计完成时刻只有「时:分」，今晚 23:00 起打 9 小时和打 33 小时，
// 算出的时刻可能都是 08:00，字面完全一样。跨天时用本函数拿到 +1 / +2 …… 标出来。
//
// 为什么不用 (to - from) / 86400000：
//   1) 今晚 23:00 → 明早 08:00 只差 9 小时，整除得 0，但对用户就是「明天」——必须记 +1；
//   2) 夏令时切换当天只有 23 或 25 小时，固定除 86400000 会在长任务上累积偏差。
// 做法：把两侧各自归到当天 00:00 再相减。跨 DST 时两个零点的间隔是 23/25 小时的整数倍加减，
// 除以 24 小时后 Math.round 即可还原成准确的天数（偏差远小于半天）。
function dayOffset(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  const from = new Date(fromMs);
  from.setHours(0, 0, 0, 0);
  const to = new Date(toMs);
  to.setHours(0, 0, 0, 0);
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { dayOffset };
}
if (typeof window !== 'undefined') {
  window.dayOffset = dayOffset;
}
