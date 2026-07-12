// 耗材颜色重着色：把打印动画帧里的「绿色系」像素（耗材丝/料盘/竹子）改成
// 当前打印耗材的颜色，画到叠加在视频上方的 overlay canvas 上。
// 纯逻辑核心（recolorImageData）无 DOM 依赖，便于单测；驱动层负责
// video → canvas 的逐帧搬运（requestVideoFrameCallback，仅新帧触发）。

// ── 绿色判定与参考色（阈值来自素材实测：耗材/竹子 hue 80–107，饱和 0.6–1.0）──
const HUE_MIN = 60;        // 命中色相下限（度）
const HUE_MAX = 170;       // 命中色相上限（度）
const SAT_MIN = 0.18;      // 低于此饱和度视为非绿（白肚/灰阴影）
const SAT_SOFT = 0.14;     // 边缘软化带宽：sat 在 [SAT_MIN, SAT_MIN+SAT_SOFT] 间渐入，抗锯齿边不留绿圈
const VAL_MIN = 0.06;      // 过暗像素不动（近黑轮廓线）
const REF_VAL = 0.68;      // 素材耗材绿的参考明度，用于按比例迁移明暗

// r,g,b ∈ [0,255] → { h(度), s, v ∈ [0,1] }
function rgbToHsv(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

// h(度), s, v ∈ [0,1] → [r,g,b] ∈ [0,255]
function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rn = 0, gn = 0, bn = 0;
  if (h < 60) { rn = c; gn = x; }
  else if (h < 120) { rn = x; gn = c; }
  else if (h < 180) { gn = c; bn = x; }
  else if (h < 240) { gn = x; bn = c; }
  else if (h < 300) { rn = x; bn = c; }
  else { rn = c; bn = x; }
  return [Math.round((rn + m) * 255), Math.round((gn + m) * 255), Math.round((bn + m) * 255)];
}

// '#rrggbb' → { h, s, v }；非法返回 null
function parseTarget(hex) {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return rgbToHsv((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}

/**
 * 把帧内绿色系像素重着色为目标色，其余像素输出全透明。
 * 不修改源；返回 { data, width, height }（新缓冲）。
 * @param {{data: Uint8ClampedArray, width: number, height: number}} imageData
 * @param {string} targetHex - '#rrggbb'
 */
function recolorImageData(imageData, targetHex) {
  const target = parseTarget(targetHex);
  const src = imageData.data;
  const out = new Uint8ClampedArray(src.length);
  if (!target) return { data: out, width: imageData.width, height: imageData.height };

  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 0) continue;
    const { h, s, v } = rgbToHsv(src[i], src[i + 1], src[i + 2]);
    if (h < HUE_MIN || h > HUE_MAX || s < SAT_MIN || v < VAL_MIN) continue;

    // 明暗迁移：像素明度相对参考耗材绿按比例映射到目标色明度上（clamp 到 1）
    const vOut = Math.min(1, target.v * (v / REF_VAL));
    // 饱和取目标色，但高光（低饱和）区按像素饱和衰减，保留高光质感
    const sOut = target.s * Math.min(1, s / 0.6);
    const [r, g, b] = hsvToRgb(target.h, sOut, vOut);

    // 边缘软化：刚过饱和阈值的抗锯齿像素部分覆盖，避免留绿边/硬边
    const coverage = Math.min(1, (s - SAT_MIN) / SAT_SOFT);
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
    out[i + 3] = Math.round(a * coverage);
  }
  return { data: out, width: imageData.width, height: imageData.height };
}

/**
 * 驱动层：绑定一个 <video> 与其 overlay <canvas>，按视频帧节奏重着色。
 * setColor('#rrggbb') 开始/更新；setColor(null) 停止并清空画布。
 * 仅浏览器环境可用（依赖 requestVideoFrameCallback / 2d context）。
 */
function createRecolorOverlay(video, canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let color = null;
  let vfcHandle = null;

  function clear() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // 画布内部分辨率：不超过视频原始尺寸，也不超过实际显示像素（小窗口时降采样省 CPU）。
  // 保持视频宽高比不变，object-fit:contain 下与视频几何重合。
  function targetSize() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const cssMax = Math.max(canvas.clientWidth || 0, canvas.clientHeight || 0);
    const cap = cssMax > 0 ? Math.ceil(cssMax * dpr) : Infinity;
    const scale = Math.min(1, cap / Math.max(video.videoWidth, video.videoHeight));
    return {
      w: Math.max(1, Math.round(video.videoWidth * scale)),
      h: Math.max(1, Math.round(video.videoHeight * scale)),
    };
  }

  function drawFrame() {
    if (!color || !video.videoWidth) return;
    const { w, h } = targetSize();
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const re = recolorImageData(frame, color);
    frame.data.set(re.data);
    ctx.putImageData(frame, 0, 0);
  }

  function tick() {
    vfcHandle = null;
    if (!color) return;
    drawFrame();
    schedule();
  }

  function schedule() {
    if (vfcHandle != null || !color) return;
    // 仅在视频出新帧时重绘；暂停/无帧时不空转
    vfcHandle = video.requestVideoFrameCallback(tick);
  }

  return {
    setColor(next) {
      const changed = next !== color;
      color = next || null;
      if (!color) {
        if (vfcHandle != null) { video.cancelVideoFrameCallback(vfcHandle); vfcHandle = null; }
        clear();
        return;
      }
      if (changed) drawFrame(); // 颜色切换立即重绘当前帧，不等下一视频帧
      schedule();
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { recolorImageData, createRecolorOverlay };
}
if (typeof window !== 'undefined') {
  window.recolorImageData = recolorImageData;
  window.createRecolorOverlay = createRecolorOverlay;
}
