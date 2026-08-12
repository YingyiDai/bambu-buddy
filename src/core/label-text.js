// 熊猫标签一行的**状态文案**拼接（纯函数，无 DOM / 无 electron，便于单测）。
//
// 为什么要独立成模块：这段文案有两个消费方——桌面熊猫下方的真标签（renderer/pet.js），
// 以及设置窗「外观」页里的效果预览（settings/settings.js）。两处必须逐字一致，否则用户
// 按预览调好了开关，回到桌面发现长得不一样。共享同一个函数是唯一不会漂移的做法。
//
// 输入是 resolveState 产出的 line（labelKey + labelParams）加一份「此刻的上下文」；
// 输出是整串文案。不碰 DOM、不读全局，故可在 Node 里直接单测（见 test/label-text.test.js）。
//
// 浏览器侧经 <script> 标签加载（renderer/index.html 与 settings/index.html 各引一次），
// 挂到 window 上；Node 侧走 module.exports。dayOffset 同理，故下面按环境取用。

function resolveDayOffset() {
  // 浏览器：core/day-offset.js 先于本文件加载，函数已在全局。
  if (typeof dayOffset === 'function') return dayOffset;
  // Node（单测 / 主进程）：直接 require 同目录那份。
  return require('./day-offset').dayOffset;
}

function translate(strings, locale, key, params) {
  const map = (strings && (strings[locale] || strings['zh-CN'])) || {};
  let template = map[key];
  if (template == null) return key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      template = template.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return template;
}

// 把毫秒时间戳格式化为「时:分」。时区跟随系统 locale；12/24 小时制用主进程下发的 hour12
// 显式指定（Chromium 的 Intl 读不到 macOS 的「24 小时制」开关，只认 locale → 需显式传入）。
// 未下发时回落到 locale 默认：习惯 AM/PM 的用户看到「2:30 PM」，24 小时制则是「14:30」。
function formatClock(ms, hour12) {
  const opts = { hour: '2-digit', minute: '2-digit' };
  if (hour12 !== undefined) opts.hour12 = hour12;
  return new Date(ms).toLocaleTimeString(undefined, opts);
}

// 预计完成时刻：当前时间 + 剩余分钟。只显示「时:分」，故跨自然日时补 +1 / +2 …… 后缀
// （见 day-offset.js）——否则今晚 23:00 起打 9 小时和打 33 小时都写作「完成 08:00」，
// 字面一模一样。天数不设上限：打一星期的长件会如实显示「完成 08:00+7」。
function formatFinishClock(remainMins, ctx) {
  if (!Number.isFinite(remainMins) || remainMins <= 0) return null;
  const now = ctx.now;
  const finishAt = now + remainMins * 60000;
  const clock = formatClock(finishAt, ctx.hour12);
  const days = resolveDayOffset()(now, finishAt);
  if (days <= 0) return clock;
  return translate(ctx.strings, ctx.locale, 'label.finishTimeDayOffset', { time: clock, d: days });
}

// 已完成的**相对时间**：刚刚 / X 分钟前 / X 小时前（跟随 locale）。完成记忆上限 24 小时，
// 故最多「23 小时前」。与打印中那行的绝对「完成 {时刻}」在格式上区分，避免看错时态。
function formatFinishedRelative(finishedAt, ctx) {
  const sec = Math.max(0, Math.floor((ctx.now - finishedAt) / 1000));
  if (sec < 60) return translate(ctx.strings, ctx.locale, 'label.finishedJustNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return translate(ctx.strings, ctx.locale, 'label.finishedMinAgo', { m: min });
  return translate(ctx.strings, ctx.locale, 'label.finishedHourAgo', { h: Math.floor(min / 60) });
}

/**
 * 拼一行的状态文案（不含打印机名，名字由调用方单独渲染并加专属分隔符）。
 * 主体是状态本身（打印中时即「打印中 {p}%」）；打印中且开关开启时，用统一的「 · 」把
 * 层数段、剩余时间段、完成时间段平级追加，例：
 *   中文 打印中 50% · 100/200 · 剩余45m    英文 Printing 50% · 100/200 · 45m left
 * 「剩余」只贴在时间段上（层数是当前/总层，不属于「剩余」）。层数段直接拼 {layer}/{total}；
 * 时间段由 label.remainTime 定文案。
 *
 * @param {{labelKey:string, labelParams:object}} line resolveState 产出的一行
 * @param {object} ctx
 *   @param {object} ctx.strings  全量 locale 表（{ 'zh-CN': {...}, en: {...} }）
 *   @param {string} ctx.locale   当前语言
 *   @param {boolean} ctx.showLayer / ctx.showTime / ctx.showFinishTime  外观页三个开关
 *   @param {boolean|undefined} ctx.hour12  12/24 小时制（undefined = 跟随 locale）
 *   @param {number} ctx.now      「此刻」的毫秒时间戳（显式传入，便于单测与预览钉住时间）
 * @returns {string}
 */
function buildStatusText(line, ctx) {
  const p = (line && line.labelParams) || {};
  // 完成态携带原始时间戳 finishedAt：就地生成相对完成文案（刚刚/X 分钟前/X 小时前），无后续指标段。
  if (p.finishedAt != null) return formatFinishedRelative(p.finishedAt, ctx);
  const parts = [translate(ctx.strings, ctx.locale, line.labelKey, p)];
  if (ctx.showLayer && p.layer != null && p.total != null) parts.push(`${p.layer}/${p.total}`);
  if (ctx.showTime && p.remain != null) {
    parts.push(translate(ctx.strings, ctx.locale, 'label.remainTime', { time: p.remain }));
  }
  if (ctx.showFinishTime && p.remainMins != null) {
    const clock = formatFinishClock(p.remainMins, ctx);
    if (clock) parts.push(translate(ctx.strings, ctx.locale, 'label.finishTime', { time: clock }));
  }
  return parts.join(' · ');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildStatusText };
}
if (typeof window !== 'undefined') {
  window.buildStatusText = buildStatusText;
}
