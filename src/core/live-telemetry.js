// 设置窗打印机卡片所需的实时遥测派生（纯函数，无 electron 依赖）。
// 抽自 main.js 的 printer:list 处理器，便于单测「切换打印机后旧遥测不串台」契约。
//
// 语义：
//   - liveMode=false（mock/把玩）：一律返回 null，卡片不显示真机遥测。
//   - lastReport=null：发生在切换打印机 / 重登时主进程重置之后 —— 必须返回空遥测，
//     否则会把上一台的进度、层数、温度串显到新活动卡片上（曾出现的 bug）。
//   - lastReport.connected=false：该帧表示离线，同样不可用作实时遥测。

const { extractTemps } = require('./state-machine');

// 熊猫权威状态类别（resolveState 的 stateKey）→ 卡片状态胶囊大类。
// ⚠️ 单一事实来源：卡片分类必须由 stateKey 派生，绝不可由 labelKey 文案字符串再猜一遍
//    （历史上「用 labelKey 前缀匹配」导致熊猫/卡片状态反复对不上：failed 串成离线、
//     暂停类 stage / 舱门暂停 / 完成 串成打印中或在线）。新增 stateKey 时在此登记即可。
function statusClassFromStateKey(stateKey) {
  switch (stateKey) {
    case 'offline':
    case 'authExpired': return 'offline';
    case 'failed': return 'failed';
    case 'paused': return 'paused';
    case 'finished': return 'finished';
    case 'idle': return 'online';
    // prepare / changing_filament / printing_0|25|50|75 等「进行中」
    default: return stateKey ? 'printing' : 'unknown';
  }
}

function buildLiveTelemetry(liveMode, lastState, lastReport) {
  const hasLive = liveMode && lastReport && lastReport.connected !== false;
  return {
    liveStatusClass: liveMode && lastState ? statusClassFromStateKey(lastState.stateKey) : null,
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

module.exports = { buildLiveTelemetry, statusClassFromStateKey };
