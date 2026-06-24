// 设置窗打印机卡片所需的实时遥测派生（纯函数，无 electron 依赖）。
// 抽自 main.js 的 printer:list 处理器，便于单测「切换打印机后旧遥测不串台」契约。
//
// 语义：
//   - liveMode=false（mock/把玩）：一律返回 null，卡片不显示真机遥测。
//   - lastReport=null：发生在切换打印机 / 重登时主进程重置之后 —— 必须返回空遥测，
//     否则会把上一台的进度、层数、温度串显到新活动卡片上（曾出现的 bug）。
//   - lastReport.connected=false：该帧表示离线，同样不可用作实时遥测。

const { extractTemps } = require('./state-machine');

function buildLiveTelemetry(liveMode, lastState, lastReport) {
  const hasLive = liveMode && lastReport && lastReport.connected !== false;
  return {
    liveLabelKey: liveMode && lastState ? lastState.labelKey : null,
    liveLabelParams: liveMode && lastState ? lastState.labelParams : null,
    liveTemps: hasLive ? extractTemps(lastReport) : null,
    liveProgress: hasLive ? {
      percent: Number.isFinite(lastReport.mc_percent) ? lastReport.mc_percent : null,
      layer: Number.isFinite(lastReport.layer_num) ? lastReport.layer_num : null,
      total: Number.isFinite(lastReport.total_layer_num) ? lastReport.total_layer_num : null,
    } : null,
  };
}

module.exports = { buildLiveTelemetry };
