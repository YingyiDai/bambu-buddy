// Windows「前台全屏检测」：轮询 shell32 的 SHQueryUserNotificationState —— 这正是 Windows
// 自己在全屏时抑制通知（专注助手）所用的信号。返回 QUNS_BUSY / RUNNING_D3D_FULL_SCREEN /
// PRESENTATION_MODE 时判为「有全屏应用在前台」。关键点：无边框窗口化全屏（现代游戏的常见默认）
// 走全屏优化路径时返回 QUNS_BUSY，故这套判定同时覆盖独占全屏与无边框全屏。
//
// 仅 Windows 生效（macOS 由主窗口的 visibleOnFullScreen:false 覆盖原生全屏 Space，无需检测）。
// koffi 懒加载并 try/catch 兜底：任何平台/加载/调用失败都安全降级为「永不判为全屏」，绝不影响主流程。

const POLL_MS = 1500; // 全屏进/出不是低延迟场景，1.5s 足够；单次系统调用开销可忽略。

// QUERY_USER_NOTIFICATION_STATE 枚举（shellapi.h）
const QUNS_BUSY = 2;                    // 有全屏应用在运行 / 已应用演示设置（含无边框全屏）
const QUNS_RUNNING_D3D_FULL_SCREEN = 3; // 独占模式 D3D 全屏
const QUNS_PRESENTATION_MODE = 4;       // 演示模式

let query = null;          // () => number | null（HRESULT 非 S_OK 时返回 null）
let timer = null;
let lastFullscreen = false;

// 懒加载 koffi 并绑定 SHQueryUserNotificationState。任何失败返回 null → 功能降级不可用（但不崩）。
function loadQuery() {
  try {
    const koffi = require('koffi');
    const shell32 = koffi.load('shell32.dll');
    // int SHQueryUserNotificationState(QUERY_USER_NOTIFICATION_STATE *pquns)
    // 输出参数走 koffi.out(pointer)：传入 1 元素数组，调用后读回 out[0]。
    const fn = shell32.func('SHQueryUserNotificationState', 'int', [koffi.out(koffi.pointer('int'))]);
    return () => {
      const out = [0];
      const hr = fn(out);          // S_OK === 0
      return hr === 0 ? out[0] : null;
    };
  } catch (e) {
    console.warn('[fullscreen-watch] koffi 加载失败，全屏自动隐藏在本机不可用：', e && e.message);
    return null;
  }
}

function isFullscreenState(s) {
  return s === QUNS_BUSY || s === QUNS_RUNNING_D3D_FULL_SCREEN || s === QUNS_PRESENTATION_MODE;
}

// 开始轮询。onChange(isFullscreen) 仅在状态翻转（非全屏↔全屏）时回调一次。
// 返回是否成功启动（非 Windows / 加载失败 → false，此时功能静默降级）。
function start(onChange) {
  if (process.platform !== 'win32') return false; // macOS 由 visibleOnFullScreen:false 覆盖
  if (timer) return true;                          // 已在运行
  if (!query) query = loadQuery();
  if (!query) return false;
  lastFullscreen = false;
  timer = setInterval(() => {
    const s = query();
    if (s == null) return;
    const fs = isFullscreenState(s);
    if (fs === lastFullscreen) return;
    lastFullscreen = fs;
    try { onChange(fs); } catch (_) { /* 回调异常不影响轮询 */ }
  }, POLL_MS);
  if (timer.unref) timer.unref(); // 不因该定时器独自阻止进程退出
  return true;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  lastFullscreen = false;
}

module.exports = { start, stop };
