// 多打印机聚合（纯函数，无 electron 依赖，便于单测）。
// 桌面只有一只熊猫：动画演「最需要关注」的那台，标签则逐台一行堆叠展示。
// 本模块负责这两个决策：pickAttentionItem 选出熊猫要演的台，buildLabelLines 生成标签行。
//
// item 形状：{ serial, name, state, report }
//   - state：resolveState 输出（主进程富化后，含 stateKey/labelKey/labelParams/videoFile/filamentColor）
//   - report：该台最近一帧原始报文（打印进度平手判定用 mc_percent）
// items 按统一列表序（printer-registry.mergePrinters 的排序）传入，平手时列表序在前者胜出（稳定）。

// rank 越小越优先。设计取舍：
//   - failed/paused 是「需要人去处理」的状态，压过一切进行中状态；
//   - changing_filament 比 printing 高一档：任一台换料时专属动画优先播放；
//   - authExpired 排在 idle 之后：登录失效是账号级故障、会同时命中所有云端台，
//     不应压过一台正常工作的 LAN 台；全部台都失效时熊猫自然演它；
//   - offline 垫底：离线台永远不抢正常台的戏。
const ATTENTION_RANK = {
  failed: 0,
  paused: 1,
  changing_filament: 2,
  printing_0: 3,
  printing_25: 3,
  printing_50: 3,
  printing_75: 3,
  finished: 4,
  prepare: 5,
  idle: 6,
  authExpired: 7,
  offline: 8,
};

const RANK_PRINTING = 3;

function rankOf(item) {
  const r = ATTENTION_RANK[item && item.state && item.state.stateKey];
  return Number.isFinite(r) ? r : ATTENTION_RANK.idle; // 未知 stateKey 按空闲对待
}

/**
 * 选出熊猫要演的那台：取 rank 最小者；多台同为打印中时取进度更高者（更接近完成、
 * 也更接近需要取件）；其余平手取列表序在前者（稳定，避免熊猫在两台之间来回跳）。
 * @param {Array<{serial:string,name:?string,state:object,report:?object}>} items
 * @returns {object|null} 命中的 item；空列表返回 null
 */
function pickAttentionItem(items) {
  let best = null;
  let bestRank = Infinity;
  for (const it of items || []) {
    if (!it || !it.state) continue;
    const r = rankOf(it);
    if (r < bestRank) { best = it; bestRank = r; continue; }
    if (r === bestRank && r === RANK_PRINTING) {
      const bp = Number(best.report && best.report.mc_percent) || 0;
      const ip = Number(it.report && it.report.mc_percent) || 0;
      if (ip > bp) best = it;
    }
  }
  return best;
}

// 离线/登录失效台不占标签行（有任一台活着时）：多台里挂一两台离线是常态，
// 逐台列「离线」会把标签变成墓碑堆；托盘菜单里仍逐台全列，细节去那里看。
function isDarkItem(it) {
  const k = it.state.stateKey;
  return k === 'offline' || k === 'authExpired';
}

function lineOf(it, showName) {
  return {
    serial: it.serial,
    name: showName ? (it.name || it.serial) : null,
    stateKey: it.state.stateKey,
    labelKey: it.state.labelKey,
    labelParams: it.state.labelParams || {},
  };
}

/**
 * 生成标签行（每台一行，渲染层逐行拼文案）：
 *   - 单台：一行、不带名字前缀 —— 与单打印机时代观感完全一致；
 *   - 多台：每台一行、带名字前缀；离线/登录失效台隐藏（见 isDarkItem）；
 *   - 全部离线/失效：折叠为一条不带名字的行（取 pickAttentionItem 命中台的文案），
 *     避免 N 台全挂时堆 N 行「离线」。
 * @returns {Array<{serial:string,name:?string,stateKey:string,labelKey:string,labelParams:object}>}
 */
function buildLabelLines(items) {
  const valid = (items || []).filter((it) => it && it.state);
  if (valid.length === 0) return [];
  const visible = valid.filter((it) => !isDarkItem(it));
  if (visible.length === 0) return [lineOf(pickAttentionItem(valid), false)];
  const showName = valid.length > 1;
  return visible.map((it) => lineOf(it, showName));
}

module.exports = { ATTENTION_RANK, pickAttentionItem, buildLabelLines };
