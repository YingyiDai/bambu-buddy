// Windows「按显示器的前台全屏检测」：轮询 user32，判断**熊猫所在的那块显示器**上是否有
// 全屏应用，是才通知隐藏。多显示器下 A 屏全屏游戏不影响 B 屏上的熊猫（此前用
// SHQueryUserNotificationState 是全局信号、不分显示器，导致任一屏全屏就把所有屏的熊猫藏掉）。
//
// 判定方法（PowerToys 等同类工具的通行做法）：
//   1. GetForegroundWindow 取前台窗口；
//   2. 排除桌面壳（Progman / WorkerW / GetShellWindow / GetDesktopWindow——点击桌面空白处时
//      前台会变成它们，且矩形盖满整屏，不排除会误判为全屏）；
//   3. GetWindowRect 完整覆盖 MonitorFromWindow 所在显示器的 rcMonitor 即视为全屏——
//      同时覆盖独占全屏与无边框窗口化全屏（现代游戏常见默认），全屏视频/演示同理；
//   4. MonitorFromWindow(熊猫窗口) 与全屏窗口的显示器句柄相同才判「需要隐藏」。
//
// 已知取舍：检测基于前台窗口——A 屏无边框全屏游戏失焦（用户去点 B 屏的窗口）时，A 屏的
// 熊猫会重新出现在游戏画面之上；重新聚焦游戏后 1.5s 内再次隐藏。独占全屏失焦本就会退出
// 全屏，不受影响。
//
// 仅 Windows 生效（macOS 由主窗口的 visibleOnFullScreen:false 覆盖原生全屏 Space，且按
// Space/显示器天然隔离，无需检测）。koffi 懒加载并 try/catch 兜底：任何平台/加载/调用失败
// 都安全降级为「永不判为全屏」，绝不影响主流程。out 参数一律传 Buffer 按字节解码（RECT =
// 4×int32，MONITORINFO = cbSize + 2×RECT + dwFlags），不依赖 koffi 的 struct 编解码。

const POLL_MS = 1500; // 全屏进/出不是低延迟场景，1.5s 足够；单次几个系统调用开销可忽略。

const MONITOR_DEFAULTTONEAREST = 2;
const CLASSNAME_CHARS = 64; // Progman / WorkerW 远短于此，够用

let native = null;      // 懒加载的 user32 绑定；加载失败为 false（区别于「未尝试」的 null）
let timer = null;
let lastHide = false;

// 懒加载 koffi 并绑定 user32。任何失败返回 null → 功能降级不可用（但不崩）。
function loadNative() {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    return {
      // 句柄一律按 intptr_t 数值处理（比较用 eqPtr 归一为 BigInt），不走 koffi 指针对象
      GetForegroundWindow: user32.func('GetForegroundWindow', 'intptr_t', []),
      GetShellWindow:      user32.func('GetShellWindow', 'intptr_t', []),
      GetDesktopWindow:    user32.func('GetDesktopWindow', 'intptr_t', []),
      // out 缓冲区按 'void *' 传 Buffer，调用后手工解码
      GetWindowRect:       user32.func('GetWindowRect', 'bool', ['intptr_t', 'void *']),
      GetClassNameW:       user32.func('GetClassNameW', 'int', ['intptr_t', 'void *', 'int']),
      MonitorFromWindow:   user32.func('MonitorFromWindow', 'intptr_t', ['intptr_t', 'uint32']),
      GetMonitorInfoW:     user32.func('GetMonitorInfoW', 'bool', ['intptr_t', 'void *']),
    };
  } catch (e) {
    console.warn('[fullscreen-watch] koffi 加载失败，全屏自动隐藏在本机不可用：', e && e.message);
    return null;
  }
}

// ── 纯函数（可单测，见 test/fullscreen-watch.test.js） ──

// 句柄相等：koffi 的 intptr_t 返回值可能是 number 或 BigInt，归一后比较
function eqPtr(a, b) {
  if (a == null || b == null) return false;
  return BigInt(a) === BigInt(b);
}

// 窗口矩形是否完整覆盖显示器矩形（= 该窗口在这块屏上全屏）
function rectCoversMonitor(w, m) {
  return w.left <= m.left && w.top <= m.top && w.right >= m.right && w.bottom >= m.bottom;
}

// win.getNativeWindowHandle() 的 Buffer → HWND 数值（x64 为 8 字节，ia32 为 4 字节）
function decodeHwnd(buf) {
  if (!buf || typeof buf.length !== 'number' || buf.length < 4) return null;
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

// 据一次轮询采集的快照判定「熊猫是否该隐藏」。字段可为 null 表示对应调用失败。
// snap: { fg, shell, desktop, cls, winRect, fgMon, monRect, petMon }
function decideHide(snap) {
  if (!snap.fg || !BigInt(snap.fg)) return false;               // 无前台窗口
  if (eqPtr(snap.fg, snap.shell) || eqPtr(snap.fg, snap.desktop)) return false;
  if (snap.cls === 'Progman' || snap.cls === 'WorkerW') return false; // 桌面壳
  if (!snap.winRect || !snap.monRect) return false;
  if (!rectCoversMonitor(snap.winRect, snap.monRect)) return false;   // 前台没全屏
  if (snap.petMon == null) return true;  // 拿不到熊猫所在显示器 → 保守沿用旧的全局隐藏行为
  return eqPtr(snap.fgMon, snap.petMon); // 只有全屏发生在熊猫那块屏上才隐藏
}

// ── 原生调用包装（各自 try/catch，失败返回 null 交由 decideHide 兜底） ──

function windowRect(hwnd) {
  try {
    const buf = Buffer.alloc(16); // RECT: left/top/right/bottom 各 int32
    if (!native.GetWindowRect(hwnd, buf)) return null;
    return {
      left: buf.readInt32LE(0), top: buf.readInt32LE(4),
      right: buf.readInt32LE(8), bottom: buf.readInt32LE(12),
    };
  } catch (_) { return null; }
}

function monitorRect(hmon) {
  try {
    const buf = Buffer.alloc(40); // MONITORINFO: cbSize u32 + rcMonitor RECT + rcWork RECT + dwFlags u32
    buf.writeUInt32LE(40, 0);     // cbSize 必须先填好（in/out 参数）
    if (!native.GetMonitorInfoW(hmon, buf)) return null;
    return {
      left: buf.readInt32LE(4), top: buf.readInt32LE(8),
      right: buf.readInt32LE(12), bottom: buf.readInt32LE(16),
    };
  } catch (_) { return null; }
}

function className(hwnd) {
  try {
    const buf = Buffer.alloc(CLASSNAME_CHARS * 2);
    const n = native.GetClassNameW(hwnd, buf, CLASSNAME_CHARS);
    return n > 0 ? buf.toString('utf16le', 0, n * 2) : null;
  } catch (_) { return null; }
}

// 单次轮询：采集快照 → 纯函数判定。任何一步失败都向「不隐藏」降级。
function pollOnce(getPetHwnd) {
  const fg = native.GetForegroundWindow();
  const snap = {
    fg, shell: null, desktop: null, cls: null,
    winRect: null, fgMon: null, monRect: null, petMon: null,
  };
  if (fg && BigInt(fg)) {
    snap.shell = native.GetShellWindow();
    snap.desktop = native.GetDesktopWindow();
    snap.cls = className(fg);
    snap.winRect = windowRect(fg);
    snap.fgMon = native.MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
    snap.monRect = snap.fgMon ? monitorRect(snap.fgMon) : null;
    const petHwnd = decodeHwnd(getPetHwnd ? getPetHwnd() : null);
    // 隐藏中的窗口仍保有位置，MonitorFromWindow 对其照常生效——熊猫被藏后仍能算出所在屏
    snap.petMon = petHwnd != null ? native.MonitorFromWindow(petHwnd, MONITOR_DEFAULTTONEAREST) : null;
    if (snap.petMon != null && !BigInt(snap.petMon)) snap.petMon = null;
  }
  return decideHide(snap);
}

// 开始轮询。onChange(shouldHide) 仅在判定翻转时回调一次。
// opts.getPetHwnd：() => Buffer|null，返回熊猫窗口的 getNativeWindowHandle()——
// 用于把「全屏发生在哪块显示器」与「熊猫在哪块显示器」比对；不传则退化为全局隐藏（旧行为）。
// 返回是否成功启动（非 Windows / 加载失败 → false，此时功能静默降级）。
function start(onChange, opts) {
  if (process.platform !== 'win32') return false; // macOS 由 visibleOnFullScreen:false 覆盖
  if (timer) return true;                          // 已在运行
  if (native == null) native = loadNative() || false;
  if (!native) return false;
  const getPetHwnd = opts && opts.getPetHwnd;
  lastHide = false;
  timer = setInterval(() => {
    let hide;
    try { hide = pollOnce(getPetHwnd); } catch (_) { return; } // 单次失败跳过本轮
    if (hide === lastHide) return;
    lastHide = hide;
    try { onChange(hide); } catch (_) { /* 回调异常不影响轮询 */ }
  }, POLL_MS);
  if (timer.unref) timer.unref(); // 不因该定时器独自阻止进程退出
  return true;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  lastHide = false;
}

module.exports = { start, stop, _internals: { rectCoversMonitor, decodeHwnd, decideHide, eqPtr } };
