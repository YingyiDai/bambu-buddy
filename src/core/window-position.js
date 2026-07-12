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
 * 计算「只横向加宽/收窄、保持中心不动」的目标窗口 bounds（纯函数，便于单测）。
 * 关键不变量：height 恒为权威的 sizePx，绝不回写当前 bounds 的 height——
 * 分数 DPI 下 getBounds→setBounds 的 DIP↔像素取整误差会让 height 逐帧累积变大，
 * 而熊猫 CSS 为 width:100vh，会随窗口高度「越变越大」。拖动进度滑杆时标签宽度
 * 频繁变化，本逻辑被高频触发，累积尤为明显。
 * @param {{x:number,y:number,width:number,height:number}} cur - 当前窗口 bounds
 * @param {number} targetWidth - 目标宽度（含标签加宽）
 * @param {number} sizePx - 熊猫方形边长 = 权威窗口高度
 * @returns {{x:number,y:number,width:number,height:number}|null} 需要变更时返回新
 *   bounds；宽度与 x 都无需变化时返回 null（调用方跳过 setBounds）。
 */
function horizontalResizeBounds(cur, targetWidth, sizePx) {
  const cx = cur.x + Math.round(cur.width / 2);
  const x = Math.round(cx - targetWidth / 2);
  if (cur.width === targetWidth && cur.x === x) return null;
  return { x, y: cur.y, width: targetWidth, height: sizePx };
}

module.exports = { clampToVisible, horizontalResizeBounds };
