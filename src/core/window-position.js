// 桌宠窗口位置的可见性校验（纯函数，无 electron 依赖，便于单测）。
// 解决：保存的位置落在已断开/已变更的显示器上时，窗口会生成在不可见区域
// （用户以为程序丢了）。把保存位置夹回「它当时所在显示器」的可见范围内；
// 若整窗与任何显示器都不再相交，返回 null，由调用方回落默认位置。

// 矩形相交面积（无相交为 0）。
function intersectArea(ax, ay, aw, ah, bx, by, bw, bh) {
  const w = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
  const h = Math.min(ay + ah, by + bh) - Math.max(ay, by);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * 把保存的窗口位置夹取到仍可见的显示器范围内。
 * @param {{x:number,y:number}|null|undefined} saved - 保存的左上角坐标
 * @param {Array<{workArea:{x:number,y:number,width:number,height:number}}>} displays
 * @param {number} sizePx - 窗口边长（正方形）
 * @returns {{x:number,y:number}|null} 可用坐标；无法落在任何显示器上时返回 null
 */
function clampToVisible(saved, displays, sizePx) {
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null;
  if (!Array.isArray(displays) || displays.length === 0) return null;

  // 选与窗口矩形重叠面积最大的显示器
  let best = null;
  let bestArea = 0;
  for (const d of displays) {
    const wa = d && d.workArea;
    if (!wa) continue;
    const area = intersectArea(saved.x, saved.y, sizePx, sizePx, wa.x, wa.y, wa.width, wa.height);
    if (area > bestArea) { bestArea = area; best = wa; }
  }
  if (!best) return null; // 整窗不与任何显示器相交（如显示器已断开）

  const maxX = best.x + best.width - sizePx;
  const maxY = best.y + best.height - sizePx;
  return {
    x: Math.round(Math.max(best.x, Math.min(maxX, saved.x))),
    y: Math.round(Math.max(best.y, Math.min(maxY, saved.y))),
  };
}

/**
 * 据「熊猫方形中心」这一权威真源计算目标窗口 bounds：窗口按标签留白横向加宽，
 * 熊猫恒居中；高度恒为 sizePx。纯函数、**幂等**——同一 center+targetWidth+sizePx
 * 反复调用得到同一结果，绝不从 getBounds() 读回值再写回。
 *
 * 为何真源是「中心」而非「左上角」或「当前窗口 bounds」：
 *   1) 用当前 bounds 保持中心：从已漂移的 cur.x/y 反推再 Math.round，居中取整误差会
 *      随标签频繁变宽单向累积——熊猫右移（macOS 整数 DPI 也可见）；回写读回的 y/height
 *      在分数 DPI 下经 DIP↔像素往返累积——熊猫上移/变大（Windows 缩放屏可见）。
 *   2) 用「左上角」做真源：改尺寸时 newTopLeft=round(center-px/2) 再回存为真源，奇数
 *      尺寸令中心落在 .5、Math.round 有半整数偏置，逐次累积——改尺寸时熊猫走位。
 * 中心可为小数、且**改尺寸/改标签宽都不重算它**，故任何场景都零累积。中心仅在用户
 * 移动窗口（dragEnd）时更新一次。
 *
 * @param {{x:number,y:number}} center - 熊猫方形中心（权威真源，可为小数）
 * @param {number} targetWidth - 目标窗口宽度（含标签加宽）
 * @param {number} sizePx - 熊猫方形边长 = 窗口高度
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function petWindowBounds(center, targetWidth, sizePx) {
  return {
    x: Math.round(center.x - targetWidth / 2),
    y: Math.round(center.y - sizePx / 2),
    width: targetWidth,
    height: sizePx,
  };
}

/**
 * 目标窗口宽度：标签比熊猫方形（base）宽时，把「加宽量」量化到 step 台阶；否则就用 base。
 * 纯函数、单调台阶。为何量化：探索模式自动播放里剩余时间/进度变化很快，标签像素宽随之
 * 逐像素抖动；若窗口逐像素跟随，熊猫（居中于窗口）会因每次 setBounds 的重绘时序露出一帧
 * 位移，观感就是「熊猫一直在跳」。量化后同一台阶内的标签变化得到相同宽度 —— applyWinWidth
 * 里 bounds 相等便直接返回、根本不 setBounds，只有跨台阶才加宽一次，抖动几乎消失。
 * 结果落在 [max(base,labelPx), labelPx+step)，故标签必不被截断；多出的透明留白点击穿透。
 * @param {number} labelPx - 渲染层量出的标签实际像素宽（含留白）
 * @param {number} base - 宽度下限 = max(熊猫方形 sizePx, 透明窗口安全下限)
 * @param {number} step - 量化台阶像素
 * @returns {number} 目标窗口宽度
 */
function quantizeWinWidth(labelPx, base, step) {
  if (!(labelPx > base)) return base;
  return base + Math.ceil((labelPx - base) / step) * step;
}

module.exports = { clampToVisible, petWindowBounds, quantizeWinWidth };
