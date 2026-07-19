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
// macOS 侧（同样需要主动检测）：主窗口的 visibleOnFullScreen:false 在本 app 里失效——熊猫被
// setAlwaysOnTop(screen-saver) 顶到 FullScreenAuxiliary 层，连原生全屏 Space 都盖不住；而
// Preview 幻灯片、视频元素全屏等「演示型全屏」压根不新建 Space，被动方案本就管不着。所以
// macOS 也走轮询：CGWindowListCopyWindowInfo 取「最前面的普通层窗口」，其矩形盖住熊猫所在
// 显示器即隐藏。只跟熊猫那块屏的矩形比，别的屏全屏天然不触发（多显示器隔离，同 Windows）。
//
// koffi 懒加载并 try/catch 兜底：任何平台/加载/调用失败都安全降级为「永不判为全屏」，绝不
// 影响主流程。Windows out 参数一律传 Buffer 按字节解码（RECT = 4×int32，MONITORINFO =
// cbSize + 2×RECT + dwFlags）；macOS 同样手工解码 CFNumber(int32)/CGRect(4×double)，不依赖
// koffi 的 struct 编解码。CGWindowList 的 bounds 与 Electron Display.bounds 同为「点、左上原
// 点、主屏 (0,0)」坐标系，可直接比对。

const POLL_MS = 1500; // 全屏进/出不是低延迟场景，1.5s 足够；单次几个系统调用开销可忽略。

const MONITOR_DEFAULTTONEAREST = 2;
const CLASSNAME_CHARS = 64; // Progman / WorkerW 远短于此，够用

// macOS / CoreGraphics 常量
const CG_ONSCREEN_ONLY = 1;   // kCGWindowListOptionOnScreenOnly
const CG_EXCLUDE_DESKTOP = 16; // kCGWindowListExcludeDesktopElements
const CF_UTF8 = 0x08000100;   // kCFStringEncodingUTF8
const CF_NUMBER_SINT32 = 3;   // kCFNumberSInt32Type

let native = null;      // 懒加载的 user32 绑定；加载失败为 false（区别于「未尝试」的 null）
let macNative = null;   // 懒加载的 CoreGraphics/CoreFoundation 绑定；加载失败为 false
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

// 懒加载 koffi 并绑定 CoreGraphics/CoreFoundation（macOS）。失败返回 null → 功能降级。
// 字典键就用它们自己的名字：CGWindowList 的键 kCGWindow* 其 CFString 内容即字面量，故直接
// 用 CFStringCreateWithCString 造出来，无需读取框架导出的符号。两个键一次造好复用整个生命周期。
function loadMacNative() {
  try {
    const koffi = require('koffi');
    const CG = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const CF = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    const libSystem = koffi.load('/usr/lib/libSystem.B.dylib');
    const b = {
      // 系统 UI 判别用：pid → 可执行路径（真机验证对他人进程如 WindowServer 也可用）
      proc_pidpath: libSystem.func('proc_pidpath', 'int', ['int32', 'void *', 'uint32']),
      CGWindowListCopyWindowInfo: CG.func('CGWindowListCopyWindowInfo', 'void *', ['uint32', 'uint32']),
      CGRectMakeWithDictionaryRepresentation: CG.func('CGRectMakeWithDictionaryRepresentation', 'bool', ['void *', 'void *']),
      CFArrayGetCount: CF.func('CFArrayGetCount', 'long', ['void *']),
      CFArrayGetValueAtIndex: CF.func('CFArrayGetValueAtIndex', 'void *', ['void *', 'long']),
      CFDictionaryGetValue: CF.func('CFDictionaryGetValue', 'void *', ['void *', 'void *']),
      CFNumberGetValue: CF.func('CFNumberGetValue', 'bool', ['void *', 'int', 'void *']),
      CFStringCreateWithCString: CF.func('CFStringCreateWithCString', 'void *', ['void *', 'str', 'uint32']),
      CFStringGetCString: CF.func('CFStringGetCString', 'bool', ['void *', 'void *', 'long', 'uint32']),
      CFRelease: CF.func('CFRelease', 'void', ['void *']),
    };
    b.keyBounds = b.CFStringCreateWithCString(null, 'kCGWindowBounds', CF_UTF8);
    b.keyPID = b.CFStringCreateWithCString(null, 'kCGWindowOwnerPID', CF_UTF8);
    b.keyOwner = b.CFStringCreateWithCString(null, 'kCGWindowOwnerName', CF_UTF8);
    if (!b.keyBounds || !b.keyPID || !b.keyOwner) return null;
    return b;
  } catch (e) {
    console.warn('[fullscreen-watch] CoreGraphics 加载失败，全屏自动隐藏在本机不可用：', e && e.message);
    return null;
  }
}

// ── 纯函数（可单测，见 test/fullscreen-watch.test.js） ──

// 句柄相等：koffi 的 intptr_t 返回值可能是 number 或 BigInt，归一后比较
function eqPtr(a, b) {
  if (a == null || b == null) return false;
  return BigInt(a) === BigInt(b);
}

// 窗口矩形是否完整覆盖显示器矩形（= 该窗口在这块屏上全屏）。严格「盖满」而不留容差：演示型
// 全屏（WPS 放映等）本就会盖满整屏，只是放映窗口在用户点击进焦前尚非前台窗口、检测才暂不触发，
// 点击进焦后即隐藏——那是前台窗口机制的固有特性，非矩形差几像素所致，故无需放宽此判定。留容差
// 反而会把「差一点没盖满」的近全屏窗口误判为全屏。
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

// 系统 UI 进程：它们不是「全屏的 app」，即便某个窗口盖满整屏也不该据此隐藏熊猫。这是一整类
// 问题——真机实测显示 Dock 时 Dock 进程造 layer 20 盖屏窗口，弹通知横幅时 NotificationCenter
// 进程造 layer 21、alpha 1 的盖屏宿主窗口（横幅只是画在其中一角）——逐个按名字排除是打地鼠。
// 通用判别：系统 UI 的可执行文件都在 /System/Library/ 下（Dock/NotificationCenter/ControlCenter
// 位于 CoreServices，WindowServer 位于 PrivateFrameworks/SkyLight，均真机验证）；而用户能全屏的
// app 都在 /Applications、/System/Applications、/System/Cryptexes（Safari）等处，不会误伤。
// owner 名单仅作 proc_pidpath 失败时的兜底：owner 名取自 kCGWindowOwnerName，是**进程名**
// （真机实测跨语言恒为英文，中文系统仍显示 "Dock"），按名精确匹配可靠。
const SYSTEM_UI_OWNERS = new Set(['Dock', 'Window Server', 'Control Center', 'Notification Center', 'Spotlight', 'Siri']);
const SYSTEM_UI_PATH_PREFIX = '/System/Library/';

// macOS 判定：屏上是否存在盖住熊猫所在显示器的「非自身、非系统 UI」窗口（= 有 app 在这块屏全屏）。
// 关键是**不看图层**：原生全屏在 0 层，而 Preview 幻灯片 / 视频元素全屏等「演示型全屏」常在
// 更高图层——按图层过滤反而会漏掉正是要抓的场景。菜单栏(24)/Control Center(25) 等系统窗虽也在
// 列，但它们细条状盖不住整屏（rectCoversMonitor 要求 top<=0 且盖满四边）；Dock、通知横幅宿主窗
// 等系统 UI 却会盖满整屏，故按可执行路径 /System/Library/ 归类排除（owner 名单兜底，见
// SYSTEM_UI_OWNERS）。最大化窗口因让出菜单栏(top=
// 菜单栏高)同样不算全屏。只跟熊猫那块屏的矩形比，别屏全屏不会盖住此矩形 → 多显示器天然隔离。
// 排除自身 pid（熊猫窗在 screen-saver 层、设置窗等）。
// windows: [{ pid, rect, owner }]，rect 为 {left,top,right,bottom} 或 null。取不到熊猫屏矩形则不隐藏。
// getOwnerPath: (pid) => 可执行路径|null，仅对「已盖屏」的候选调用（每轮至多几次，开销可忽略）；
// 解析失败/未提供时退回 owner 名单兜底。
function anyWindowCoversDisplay(windows, ownPid, petDisplayRect, getOwnerPath) {
  if (!petDisplayRect) return false;
  for (const w of windows) {
    if (ownPid != null && w.pid === ownPid) continue;
    if (!w.rect || !rectCoversMonitor(w.rect, petDisplayRect)) continue;
    if (SYSTEM_UI_OWNERS.has(w.owner)) continue;
    if (getOwnerPath && w.pid != null) {
      let p = null;
      try { p = getOwnerPath(w.pid); } catch (_) { /* 解析失败 → 按普通 app 对待 */ }
      if (p && p.startsWith(SYSTEM_UI_PATH_PREFIX)) continue;
    }
    return true;
  }
  return false;
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

// ── macOS 原生调用包装（各自 try/catch，失败向「不隐藏」降级） ──

// 取字典里某 CFNumber 键的 int32 值（layer / pid）。
function cfInt(b, dict, key) {
  const v = b.CFDictionaryGetValue(dict, key);
  if (!v) return null;
  const buf = Buffer.alloc(4);
  if (!b.CFNumberGetValue(v, CF_NUMBER_SINT32, buf)) return null;
  return buf.readInt32LE(0);
}

// 取字典里某 CFString 键的 JS 字符串（owner 名）。取不到返回 null（→ 不在系统 UI 名单，照常判定）。
function cfStr(b, dict, key) {
  const v = b.CFDictionaryGetValue(dict, key);
  if (!v) return null;
  const buf = Buffer.alloc(256); // 进程名远短于此，够用；失败/截断都无碍（只用于精确名匹配）
  if (!b.CFStringGetCString(v, buf, buf.length, CF_UTF8)) return null;
  const z = buf.indexOf(0);
  return buf.toString('utf8', 0, z < 0 ? buf.length : z);
}

// 取窗口 bounds（kCGWindowBounds 是 {X,Y,Width,Height} 字典）→ {left,top,right,bottom}。
function cfRect(b, dict) {
  const bd = b.CFDictionaryGetValue(dict, b.keyBounds);
  if (!bd) return null;
  const out = Buffer.alloc(32); // CGRect = 4 × double（x, y, width, height）
  if (!b.CGRectMakeWithDictionaryRepresentation(bd, out)) return null;
  const x = out.readDoubleLE(0), y = out.readDoubleLE(8);
  const w = out.readDoubleLE(16), h = out.readDoubleLE(24);
  return { left: x, top: y, right: x + w, bottom: y + h };
}

// 枚举当前 Space 屏上的窗口，解析出 [{pid, rect, owner}]（不看图层，见 anyWindowCoversDisplay）。
// OnScreenOnly 只含当前 Space，故别的 Space 的全屏 app 不会被误算。任何失败返回 []。
function enumWindows(b) {
  const arr = b.CGWindowListCopyWindowInfo(CG_ONSCREEN_ONLY | CG_EXCLUDE_DESKTOP, 0);
  if (!arr) return [];
  try {
    const n = Number(b.CFArrayGetCount(arr));
    const out = [];
    for (let i = 0; i < n; i++) {
      const dict = b.CFArrayGetValueAtIndex(arr, i);
      if (!dict) continue;
      out.push({ pid: cfInt(b, dict, b.keyPID), rect: cfRect(b, dict), owner: cfStr(b, dict, b.keyOwner) });
    }
    return out;
  } finally {
    b.CFRelease(arr); // Copy 出来的数组归我们所有，必须释放（键在加载期常驻，不在此释放）
  }
}

// pid → 可执行路径（proc_pidpath）。失败返回 null → anyWindowCoversDisplay 退回名单兜底。
function pidPath(b, pid) {
  try {
    const buf = Buffer.alloc(4096); // PROC_PIDPATHINFO_MAXSIZE
    const n = b.proc_pidpath(pid, buf, buf.length);
    return n > 0 ? buf.toString('utf8', 0, n) : null;
  } catch (_) { return null; }
}

// 单次轮询（macOS）：枚举 → 是否有非自身、非系统 UI 的窗口盖住熊猫所在屏。失败向「不隐藏」降级。
function pollOnceMac(getPetDisplayRect) {
  const petRect = getPetDisplayRect ? getPetDisplayRect() : null;
  if (!petRect) return false;
  return anyWindowCoversDisplay(enumWindows(macNative), process.pid, petRect, (pid) => pidPath(macNative, pid));
}

// 开始轮询。onChange(shouldHide) 仅在判定翻转时回调一次。
// opts.getPetHwnd（Windows）：() => Buffer|null，熊猫窗口的 getNativeWindowHandle()，用于比对
//   「全屏在哪块屏」与「熊猫在哪块屏」；不传则退化为全局隐藏。
// opts.getPetDisplayRect（macOS）：() => {left,top,right,bottom}|null，熊猫所在显示器的矩形
//   （点坐标，同 CGWindowList），前台窗口盖住它才隐藏；不传则永不隐藏。
// 返回是否成功启动（不支持的平台 / 加载失败 → false，此时功能静默降级）。
function start(onChange, opts) {
  if (timer) return true; // 已在运行
  let poll;
  if (process.platform === 'win32') {
    if (native == null) native = loadNative() || false;
    if (!native) return false;
    const getPetHwnd = opts && opts.getPetHwnd;
    poll = () => pollOnce(getPetHwnd);
  } else if (process.platform === 'darwin') {
    if (macNative == null) macNative = loadMacNative() || false;
    if (!macNative) return false;
    const getPetDisplayRect = opts && opts.getPetDisplayRect;
    poll = () => pollOnceMac(getPetDisplayRect);
  } else {
    return false; // 其它平台不支持
  }
  lastHide = false;
  timer = setInterval(() => {
    let hide;
    try { hide = poll(); } catch (_) { return; } // 单次失败跳过本轮
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

module.exports = {
  start, stop,
  _internals: { rectCoversMonitor, decodeHwnd, decideHide, eqPtr, anyWindowCoversDisplay },
};
