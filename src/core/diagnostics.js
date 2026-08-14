// 一键诊断报告的**纯格式化**层（无 electron 依赖，便于单测）。
// 主进程负责采集（app/screen/GPU 等），这里只负责把采集到的普通对象排成一段可直接
// 粘贴给作者的纯文本。
//
// 为什么需要它：熊猫是个透明窗口，「整窗变黑」这类缺陷几乎全部来自**用户那台机器的合成
// 路径**（GPU 驱动、显示器/缩放/HDR 变更、硬件视频叠加层、软件回退），而不是代码分支——
// 作者机上永远正常，光看截图无法分辨是哪一条。让用户在命令行里加 --disable-gpu 之类的开关
// 成本又太高（要会找安装路径、会改快捷方式）。于是把这些信息做成「设置 › 关于 › 复制诊断
// 信息」一个按钮：用户点一下、粘贴回来，上面每一行都对应一个可以被证伪的假设。

// 影响透明窗口合成的 GPU 特性优先排在前面，其余按字母序附在后面。
const KEY_FEATURES = ['gpu_compositing', 'video_decode', 'rasterization', 'multiple_raster_threads', 'opengl', 'vulkan'];

// 把 getGPUFeatureStatus() 的 { 特性: 状态 } 排成一行，重点特性在前。
function formatGpuFeatures(status) {
  if (!status || typeof status !== 'object') return '(未取到)';
  const keys = Object.keys(status);
  const head = KEY_FEATURES.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !head.includes(k)).sort();
  return [...head, ...rest].map((k) => `${k}=${status[k]}`).join(', ');
}

// 从 getGPUInfo() 的返回里挑出「哪块显卡 + 驱动版本」。不同平台/版本字段位置不一，
// 全部取值都做存在性兜底——诊断信息缺一行也不能让整个按钮报错。
function formatGpu(info) {
  if (!info || typeof info !== 'object') return '(未取到)';
  const aux = info.auxAttributes || {};
  const devices = Array.isArray(info.gpuDevice) ? info.gpuDevice : [];
  const active = devices.find((d) => d && d.active) || devices[0] || {};
  const hex = (n) => (Number.isFinite(n) ? '0x' + n.toString(16) : '?');
  const name = active.deviceString || aux.glRenderer || '(未知型号)';
  const parts = [`${name} [${hex(active.vendorId)}:${hex(active.deviceId)}]`];
  const driver = active.driverVersion || aux.driverVersion;
  if (driver) parts.push(`驱动 ${driver}`);
  // 混合显卡（笔记本核显+独显）本身就是透明窗口发黑的常见诱因，故显式标出有几块、谁在用。
  if (devices.length > 1) parts.push(`共 ${devices.length} 块显卡`);
  return parts.join(' · ');
}

// HDR / 高位深显示器会把 DWM 与 Chromium 的合成切到另一条路径（scRGB fp16），
// 是「某天突然变黑」的高嫌疑项，故单独标注出来而不是埋在色深数字里。
function isWideColor(display) {
  if (!display) return false;
  if (Number(display.depthPerComponent) > 8) return true;
  const cs = String(display.colorSpace || '').toLowerCase();
  return cs.includes('bt2020') || cs.includes('pq') || cs.includes('hdr') || cs.includes('scrgb');
}

function formatDisplay(display, isPetDisplay) {
  const b = display.bounds || {};
  const parts = [
    `${b.width}x${b.height}`,
    `@${display.scaleFactor}x`,
    `色深 ${display.colorDepth}/${display.depthPerComponent}`,
  ];
  if (isWideColor(display)) parts.push(`广色域/HDR? ${display.colorSpace || ''}`.trim());
  if (display.internal) parts.push('内置屏');
  if (display.detected === false) parts.push('未检测到(虚拟)');
  if (isPetDisplay) parts.push('← 熊猫在这块');
  return parts.join('  ');
}

/**
 * 把采集到的诊断数据排成一段可粘贴的纯文本。
 * 所有字段都可缺省——采集失败的项显示为 (未取到)，绝不抛错。
 * @param {object} d 采集结果，见 main.js 的 collectDiagnostics
 * @returns {string}
 */
function formatDiagnostics(d) {
  const o = d || {};
  const v = (x, fallback = '(未取到)') => (x === undefined || x === null || x === '' ? fallback : x);
  const yn = (x) => (x === undefined ? '?' : x ? '是' : '否');
  const lines = [];

  lines.push('Bambu Buddy 诊断信息');
  lines.push(`时间      ${v(o.now)}`);
  lines.push(`版本      v${v(o.appVersion)} · electron ${v(o.electron)} · chromium ${v(o.chrome)}`);
  lines.push(`系统      ${v(o.platform)} ${v(o.release)} (${v(o.arch)})`);
  lines.push(`显卡      ${formatGpu(o.gpuInfo)}`);
  lines.push(`GPU 特性  ${formatGpuFeatures(o.gpuFeatureStatus)}`);

  const displays = Array.isArray(o.displays) ? o.displays : [];
  if (displays.length === 0) {
    lines.push('显示器    (未取到)');
  } else {
    displays.forEach((disp, i) => {
      const head = i === 0 ? '显示器    ' : '          ';
      lines.push(`${head}${i + 1}. ${formatDisplay(disp, disp.id != null && disp.id === o.petDisplayId)}`);
    });
  }

  const w = o.window || {};
  lines.push(`熊猫窗口  ${v(w.x, '?')},${v(w.y, '?')} ${v(w.width, '?')}x${v(w.height, '?')}`
    + ` · 可见 ${yn(w.visible)} · 全屏隐藏中 ${yn(o.hiddenByFullscreen)}`);
  lines.push(`外观      sizePx=${v(o.sizePx)} · 标签字号 ${v(o.labelFontSize)} · 显示标签 ${yn(o.showLabel)}`
    + ` · 全屏自动隐藏 ${yn(o.hideOnFullscreen)}`);
  lines.push(`当前状态  ${v(o.state)} · 动画 ${v(o.anim)} · 耗材改色 ${v(o.filamentColor, '关')}`);
  lines.push(`打印机    ${v(o.printerCount, 0)} 台${o.mock ? '（把玩模式）' : ''}`);

  return lines.join('\n');
}

module.exports = { formatDiagnostics, formatGpuFeatures, formatGpu, isWideColor };
