// Electron 主进程：透明置顶窗口、托盘、IPC、位置记忆、数据源驱动（§5）。

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, safeStorage, shell, dialog, net } = require('electron');
const path = require('path');
const Store = require('electron-store');

// 窗口图标：Windows 用 .ico（多尺寸），其余平台用 PNG。
const WINDOW_ICON = path.join(__dirname, '..', 'assets', 'icon', process.platform === 'win32' ? 'AppIcon.ico' : 'AppIcon.png');

const { resolveState, extractTemps, fmtRemain, isPrintActive } = require('./core/state-machine');
const { applyCompletionState } = require('./core/completion-state');
const { buildLiveTelemetry } = require('./core/live-telemetry');
const { MockDataSource } = require('./core/mock');
const { BambuCloudDataSource, BambuLanDataSource, classifyLanProbe } = require('./core/bambu-mqtt');
const bambuAuth = require('./core/bambu-auth');
const { t, STRINGS } = require('./config/locales');
const { checkForUpdates, compareSemver, humanizeError } = require('./core/updater');
const { autoUpdater } = require('electron-updater');
const errorCodes = require('./core/bambu-error-codes');
const fs = require('fs');
const registry = require('./core/printer-registry');
const fullscreenWatch = require('./core/fullscreen-watch');
const { PrinterHub } = require('./core/printer-hub');
const { pickAttentionItem, buildLabelLines } = require('./core/attention');

// 走 Electron net 的底层 GET：net 会尊重系统代理（macOS 网络设置 / Clash 系统代理等），
// 因此在需要代理才能访问 GitHub 的网络里（如中国大陆），检查更新也能连上 api.github.com。
// 注入给 updater.checkForUpdates，替代其默认的 Node https（后者不走系统代理）。
function netGetRaw(host, path) {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', protocol: 'https:', hostname: host, path });
    request.setHeader('User-Agent', 'bambu-buddy/0.1');
    request.setHeader('Accept', 'application/vnd.github.v3+json');
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { request.abort(); } catch { /* ignore */ }
      reject(new Error('请求超时'));
    }, 15000);
    request.on('response', (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    });
    request.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    request.end();
  });
}
const { clampToVisible, petWindowBounds, quantizeWinWidth } = require('./core/window-position');

const store = new Store();

// 将旧版 bambu 存储格式迁移到新版（账号与打印机解耦）。
// 幂等：检测到旧格式才迁移，已迁移则跳过。
function migrateStorage() {
  const bambu = store.get('bambu');
  if (bambu && bambu.mode) {
    if (bambu.mode === 'cloud' && bambu.token) {
      store.set('bambuAccount', {
        region: bambu.region || 'global',
        account: bambu.account || '',
        // 旧格式 token 为明文；迁移时一并加密，与其余写入路径保持一致，
        // 避免凭据长期以明文留存。decryptSecret 读取时对明文/密文都有兜底。
        token: encryptSecret(bambu.token),
        uid: bambu.uid,
      });
      store.set('bambuPrinters', [{
        serial: bambu.serial,
        name: bambu.name || bambu.serial,
        model: bambu.model || '',
      }]);
    } else if (bambu.mode === 'lan') {
      store.set('bambuLan', {
        host: bambu.host,
        accessCode: bambu.accessCode,
        serial: bambu.serial,
        name: bambu.name || bambu.serial,
      });
    }
    store.delete('bambu');
  }

  // 迁移旧 size 预设 → sizePx
  if (store.get('size') !== undefined) {
    const SIZE_PRESETS = { small: 160, medium: 220, large: 280 };
    const oldSize = store.get('size', 'medium');
    store.set('sizePx', SIZE_PRESETS[oldSize] || 220);
    store.delete('size');
  }

  // 多打印机：旧存储结构 → 统一注册表
  const { set, del } = registry.computeMigration(store.store);
  for (const [k, v] of Object.entries(set)) store.set(k, v);
  for (const k of del) store.delete(k);
}

let win = null;
let tray = null;
let settingsWin = null; // Bambu 连接设置窗（Cloud 登录 / LAN 配置）
let cloudPollTimer = null; // 云端粗粒度状态轮询定时器
let liveNotifyTimer = null; // MQTT 实时状态 → 设置窗重绘的防抖定时器
let playPercent = 0; // 把玩页打印进度（滑杆位置，0–100）
let pendingUpdate = null; // 自动检查发现的新版本 { version, url }，供托盘菜单常驻高亮

// ── 多打印机运行时 ──
// 所有已添加的打印机常驻连接（每台一个数据源实例，生命周期由 PrinterHub diff 管理），
// 各台的最近状态按 serial 存在 runtimes；桌面只有一只熊猫，动画演「最需要关注」的台
// （见 core/attention.js），标签逐台一行堆叠。
// mock（把玩）模式仍是全局单源：挂在伪 serial MOCK_SERIAL 下，聚合天然退化为单台。
const MOCK_SERIAL = '__mock__';
const runtimes = new Map(); // serial → { lastReport, lastState, completionTimer }
let mockSource = null; // 仅 mock 模式非空（MockDataSource）
const errorTables = new Map(); // "<lang>_<model>" → 解析后的官方错误码表（打印失败时查大类）
const errorTablePending = new Set(); // 正在下载中的表 key，避免并发重复下载

// 鉴权失败提示去抖：云端 token 失效会同时命中所有云端台，避免每台都弹一次设置窗提示。
let lastAuthNotifyAt = 0;

function getRuntime(serial) {
  let rt = runtimes.get(serial);
  if (!rt) {
    rt = { lastReport: null, lastState: null, completionTimer: null };
    runtimes.set(serial, rt);
  }
  return rt;
}

// 自动检查更新的节奏：启动后延迟一次（给网络/系统代理就绪时间），之后每 6 小时复查一次。
// 复查同时也是后台下载失败的自动重试点（见 runAutoUpdateCheck → startUpdateDownload）。
const AUTO_UPDATE_STARTUP_DELAY_MS = 8000;
const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

function currentSizePx() {
  return store.get('sizePx', 220);
}

// ---- 单实例锁（§5.1）----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  });
}

function createWindow() {
  const sizePx = currentSizePx();
  // 读回上次位置（§5.3）。先夹到当前仍可见的显示器范围内：
  // 外接显示器断开 / 分辨率变更后，旧坐标可能落在不可见区域（用户以为程序丢了）。
  const saved = clampToVisible(store.get('window.position'), screen.getAllDisplays(), sizePx);
  let x, y;
  if (saved) {
    x = saved.x; y = saved.y;
  } else {
    // 默认放到主屏右下角
    const { workArea } = screen.getPrimaryDisplay();
    x = workArea.x + workArea.width - sizePx - 40;
    y = workArea.y + workArea.height - sizePx - 40;
  }
  // 记下熊猫方形中心为权威真源（applyWinWidth 据此算窗口 bounds，见 petCenter 注释）。
  petCenter = { x: x + sizePx / 2, y: y + sizePx / 2 };

  // 初始宽度同样走 targetWinWidth（启动时 labelSize.w=0，即 max(sizePx, 宽度下限)）；
  // x 按「熊猫方形居中」反推窗口左缘，保证熊猫落在记忆位置上。
  const winW = targetWinWidth();
  // 【allow-direct-setBounds：sanctioned exception ①】构造用一次性权威值，非 getBounds 回写。
  win = new BrowserWindow({
    width: winW,
    height: sizePx,
    x: Math.round(x - (winW - sizePx) / 2),
    y,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  // visibleOnFullScreen 跟随「全屏时自动隐藏」开关：开启（默认）时置 false，macOS 上熊猫
  // 就不会跟进别的 app 的原生全屏 Space —— 无需任何检测即自动让开（方案1）。
  // 关闭开关则置 true，恢复「浮在全屏之上」的旧行为。Windows 侧另由 fullscreen-watch 处理。
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: !store.get('hideOnFullscreen', true) });

  // 默认点击穿透，鼠标进入实体像素时由渲染层 IPC 关闭（§5.1）
  win.setIgnoreMouseEvents(true, { forward: true });

  // 窗口销毁后清空引用，避免留下「已销毁但非 null」的悬空引用（对齐 settingsWin 的 closed 处理）。
  win.on('closed', () => { win = null; });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 渲染层加载完成后，补发偏好/语言/最近状态（数据源可能在窗口 ready 前已 emit）。
  // 顺序：先偏好（渲染层几何依赖 sizePx）再状态，避免多行标签在几何就绪前上报错误尺寸。
  win.webContents.on('did-finish-load', () => {
    pushPetPrefs();
    pushLocale();
    pushState();
  });
  // 位置记忆在 pet:dragEnd 时保存（§5.3），避免拖拽过程中频繁写盘。
}

// ── 全屏时自动隐藏熊猫（主动检测）──
// macOS & Windows 都靠 fullscreen-watch 轮询「熊猫所在显示器」上是否有前台全屏应用，仅同屏
//   全屏才 win.hide()、退出 win.show()——多显示器下 A 屏全屏不影响 B 屏上的熊猫。
//   · Windows：把熊猫窗口句柄交给它算所在显示器（getPetHwnd）。
//   · macOS：把熊猫所在显示器矩形交给它（getPetDisplayRect）。被动的 visibleOnFullScreen:false
//     在本 app 里被 screen-saver 顶层顶掉、且管不着演示型全屏，故 macOS 也需主动检测。
// 只恢复「我们自己因全屏而隐的」窗口（hiddenByFullscreen 标记），不与其它显隐逻辑打架。
let hiddenByFullscreen = false;

// 用户从托盘「显示熊猫」手动隐藏的意图（仅内存，不持久化——每次启动都默认显示）。
// 窗口可见 = 用户想显示 且 未被全屏自动隐藏；两者独立，互不覆盖。
let userHidPanda = false;

function onFullscreenChange(shouldHide) {
  if (!win || win.isDestroyed()) return;
  if (!store.get('hideOnFullscreen', true)) return; // 双保险：开关已关时不动窗口
  if (shouldHide) {
    if (win.isVisible()) { win.hide(); hiddenByFullscreen = true; }
  } else if (hiddenByFullscreen) {
    hiddenByFullscreen = false;
    if (!userHidPanda) win.show(); // 用户主动隐藏的熊猫，退出全屏也不自作主张地恢复
  }
}

// 托盘「显示熊猫」开关：只反映用户意图，隐藏中的全屏（hiddenByFullscreen）不被它当作可显。
function applyPetUserVisibility() {
  if (!win || win.isDestroyed()) return;
  if (userHidPanda) {
    if (win.isVisible()) win.hide();
  } else if (!hiddenByFullscreen && !win.isVisible()) {
    win.show(); // 全屏正压着时不弹出，交给 onFullscreenChange 在退出全屏时恢复
  }
}

// 按开关启停：macOS 更新 Space 可见性；Windows 启停轮询；关闭时若正隐着立即恢复显示。
function applyHideOnFullscreen(enabled) {
  if (win && !win.isDestroyed()) {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: !enabled });
  }
  if (enabled) {
    fullscreenWatch.start(onFullscreenChange, {
      // Windows：熊猫窗口句柄，轮询侧据此算熊猫在哪块显示器（隐藏中的窗口仍保有位置，照常可算）
      getPetHwnd: () => (win && !win.isDestroyed()) ? win.getNativeWindowHandle() : null,
      // macOS：熊猫所在显示器的矩形（点坐标，同 CGWindowList bounds），前台窗口盖住它才隐藏
      getPetDisplayRect: () => {
        if (!win || win.isDestroyed()) return null;
        const b = screen.getDisplayMatching(win.getBounds()).bounds; // {x,y,width,height}，左上原点
        return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
      },
    });
  } else {
    fullscreenWatch.stop();
    if (hiddenByFullscreen && win && !win.isDestroyed()) { win.show(); hiddenByFullscreen = false; }
  }
}

// 渲染层上报的标签实际像素尺寸：窗口据宽度加宽以完整显示长标签（不缩字号、不截断），
// 据高度向下加高以容纳多行标签（多台打印机每台一行，见 core/attention.js）。
const labelSize = { w: 0, h: 0 };

// 熊猫方形**中心**的权威坐标（运行时唯一真源，可为小数）。窗口比熊猫方形宽（标签留白），
// 故不能用窗口 bounds 反推位置——applyWinWidth 一律据此中心算 bounds，保证幂等、不因
// getBounds↔setBounds 往返或居中取整累积（熊猫右移/上移/走位）。**只在用户移动窗口
// （dragEnd）时更新一次**；改尺寸/改标签宽都不重算它（改尺寸溢出屏幕被夹回时例外）。
// 持久化仍走 store('window.position')（存熊猫方形左上角，与历史口径一致）。
let petCenter = null;

// macOS 上宽度小于约 162px 的透明窗口会整窗变成不透明白底（Electron 已知缺陷，官方标记不修：
// electron/electron#44884，Apple Silicon + 缩放显示器上必现）。实际用户反馈的阈值与 162 吻合：
// 熊猫尺寸 <160 时空闲态（短标签、窗口不加宽）白底，打印中（长标签把窗口撑宽越过阈值）正常，
// 也证明该缺陷只受宽度影响、与高度无关。给窗口宽度设下限兜底：熊猫仍按用户尺寸居中渲染，
// 两侧多出的透明留白与「标签加宽」共用同一机制 —— 点击穿透，不影响交互/热区/位置记忆。
const MIN_WIN_WIDTH = 170;

// 标签比熊猫方形还宽时，窗口加宽量量化到该台阶（见 quantizeWinWidth 注释：消除自动播放
// 时剩余时间快速变化导致的熊猫抖动）。
const LABEL_WIDTH_STEP = 40;

// 目标窗口宽度：至少容纳熊猫方形（sizePx），标签更宽时按标签宽（量化到台阶），且不低于
// 透明窗口安全下限。两侧多出的透明留白点击穿透、可溢出屏幕边缘，熊猫始终居中方形
//（CSS width:--pet-px），故窗口变宽不改变熊猫位置/大小/热区。
function targetWinWidth() {
  return quantizeWinWidth(labelSize.w, Math.max(currentSizePx(), MIN_WIN_WIDTH), LABEL_WIDTH_STEP);
}

// 窗口预留给标签带的高度是 34px（.pet 的 bottom 内缩）里去掉 8px 间距后的 26px。
// 单行默认字号的标签 ≈25px 恰好放下（extraHeight=0，窗口高恒为 sizePx——与单台时代
// 完全一致）；多行/大字号超出的部分向下加高窗口，熊猫方形顶部锚定纹丝不动。
const LABEL_BASE_PX = 26;
function targetExtraHeight() {
  return Math.max(0, labelSize.h - LABEL_BASE_PX);
}

// ★ 窗口 bounds 的**唯一常规写入口**（choke point）。凡「熊猫应待在原地、仅尺寸/标签
// 尺寸变化」的场景都必须走这里，绝不在别处直接 win.setBounds。全程据权威源真相
// （petCenter + currentSizePx + labelSize）计算，从不回写 getBounds() 读回值 —— 这是杜绝
// 「熊猫越变越大 / 右移 / 上移 / 走位」这类 DIP↔像素 & 居中取整累积缺陷再次出现的结构性保证。
// 仅两处允许直接 setBounds：① 窗口构造（new BrowserWindow，一次性权威值）；
// ② 拖拽跟随光标的 dragTimer（写光标绝对位置 + 起始锁定的固定宽高，不累积）。
// 见 test/window-position.test.js 的「源码防线」用例——新增 setBounds 调用会使其失败。
function applyWinWidth() {
  if (!win || win.isDestroyed() || !petCenter) return;
  // 拖拽中窗口 bounds 由 dragTimer 每帧独占跟随光标，此时中心尚未落定（dragEnd 才更新），
  // 若在此据陈旧中心 setBounds 会把窗口拽回拖拽前的位置。拖拽结束会再 applyWinWidth 收敛。
  if (dragOffset) return;
  // 一律据权威中心算 bounds（幂等、不累积，见 petWindowBounds 注释）：熊猫恒居中、
  // 多行标签只向下加高——彻底消除拖进度滑杆/拖尺寸时熊猫右移/上移/变大/走位。
  const next = petWindowBounds(petCenter, targetWinWidth(), currentSizePx(), targetExtraHeight());
  const b = win.getBounds();
  if (b.x === next.x && b.y === next.y && b.width === next.width && b.height === next.height) return;
  win.setBounds(next);
}

// 无极调整宠物窗口大小（80–400px），保持中心不动，持久化。
function setPetSizePx(px) {
  px = Math.max(80, Math.min(400, Math.round(px)));
  store.set('sizePx', px);
  if (!win || win.isDestroyed() || !petCenter) return;
  // 保持熊猫中心不动——中心是权威真源、**改尺寸不重算它**，故连续拖尺寸滑杆零累积。
  // 仅当放大后熊猫方形溢出屏幕、被夹回可见范围时，中心才随之平移（更新真源、且收敛不发散）。
  const desiredTopLeft = { x: Math.round(petCenter.x - px / 2), y: Math.round(petCenter.y - px / 2) };
  const petTopLeft = clampToVisible(desiredTopLeft, screen.getAllDisplays(), px) || desiredTopLeft;
  if (petTopLeft.x !== desiredTopLeft.x || petTopLeft.y !== desiredTopLeft.y) {
    petCenter = { x: petTopLeft.x + px / 2, y: petTopLeft.y + px / 2 };
  }
  // 记忆熊猫方形左上角（历史口径），再经唯一入口 applyWinWidth 幂等落定窗口 bounds。
  store.set('window.position', petTopLeft);
  applyWinWidth();
  rebuildTray();
}

// ---- 数据源装配 ----

// 「在桌面显示」黑名单：hiddenPrinters 存被隐藏台的 serial 列表（默认空 = 全显）。
// 黑名单语义故新导入的云端台自动出现；独立于 bambuPrinters（云轮询会整体重写它，不能存这儿）。
function isHidden(serial) {
  const list = store.get('hiddenPrinters', []);
  return Array.isArray(list) && list.includes(serial);
}
function setHidden(serial, hidden) {
  const list = (store.get('hiddenPrinters', []) || []).filter((s) => s !== serial);
  if (hidden) list.push(serial);
  store.set('hiddenPrinters', list);
}

// 各台的 { serial, name, state, report } 列表（统一列表序），供聚合与标签行生成。
// mock 模式退化为单台（伪 serial、不带名字 → 单行标签，与真机单台观感一致）。
// 「未上桌面」（hiddenPrinters）的台在此就被排除——下游 pickAttentionItem/buildLabelLines
// 都吃这个列表，故隐藏台既不占标签行、也不参与熊猫的注意力切换（但仍常驻连接，托盘/设置照常）。
function currentPetItems() {
  if (store.get('dataSource', 'mock') === 'mock') {
    const rt = runtimes.get(MOCK_SERIAL);
    return rt && rt.lastState
      ? [{ serial: MOCK_SERIAL, name: null, state: rt.lastState, report: rt.lastReport }]
      : [];
  }
  const items = [];
  for (const p of getUnified()) {
    if (isHidden(p.serial)) continue;
    const rt = runtimes.get(p.serial);
    if (rt && rt.lastState) items.push({ serial: p.serial, name: p.name, state: rt.lastState, report: rt.lastReport });
  }
  return items;
}

// 聚合出给宠物窗口的载荷：顶层沿用单台时代的 state 形状（视频/换色路径零改动），
// 额外带 lines（逐台标签行）与 activeSerial（熊猫当前表达的那台，渲染层据此高亮对应行）。
// items 已排除「未上桌面」的台；只剩一台可见时 buildLabelLines 自然给单行无名（回到单台观感）。
// 无任何台可显示时（含全部被隐藏）回落「离线」熊猫。
function buildPetPayload() {
  const items = currentPetItems();
  const top = pickAttentionItem(items);
  if (!top) return { ...resolveState({ connected: false }), lines: [], activeSerial: null };
  return { ...top.state, lines: buildLabelLines(items), activeSerial: top.serial };
}

// 推送聚合状态给宠物窗口。
function pushState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:state', buildPetPayload());
  }
}

// 宠物推送节流（首沿 + 尾沿）：N 台同时打印时每台约 1 帧/秒，逐帧推送渲染层是无谓开销。
// 首沿保住把玩页进度滑杆的即时响应（拖动即推），尾沿把突发帧合并到 300ms 一次。
const PET_PUSH_MS = 300;
let petPushTimer = null;
let lastPetPushAt = 0;
function schedulePetPush() {
  if (petPushTimer) return;
  const wait = PET_PUSH_MS - (Date.now() - lastPetPushAt);
  if (wait <= 0) {
    lastPetPushAt = Date.now();
    pushState();
    return;
  }
  petPushTimer = setTimeout(() => {
    petPushTimer = null;
    lastPetPushAt = Date.now();
    pushState();
  }, wait);
}

// 托盘重建节流（尾沿合并）：托盘每台都有状态/温度行，N 台打印中逐帧重建整份菜单
// 既浪费也可能引起菜单闪烁。用户操作路径（切语言、点开关等）仍直调 rebuildTray() 即时生效。
const TRAY_REBUILD_MS = 1500;
let trayRebuildTimer = null;
function scheduleTrayRebuild() {
  if (trayRebuildTimer) return;
  trayRebuildTimer = setTimeout(() => {
    trayRebuildTimer = null;
    rebuildTray();
  }, TRAY_REBUILD_MS);
}

// 当前把玩场景 key（仅 mock 数据源时有值）。
function currentPlayScenario() {
  return mockSource ? (mockSource.getCurrent() || null) : null;
}

// 把玩状态推送给设置窗（驱动"当前正在演示"卡片刷新）。
function pushPlayState() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('play:stateChanged', {
      isPlaying: store.get('dataSource', 'mock') === 'mock',
      currentScenario: currentPlayScenario(),
      percent: playPercent,
    });
  }
}

const COMPLETION_HISTORY_KEY = 'printCompletionHistory';

function completionRecord(serial) {
  if (!serial) return null;
  const history = store.get(COMPLETION_HISTORY_KEY, {});
  return history && typeof history === 'object' ? history[serial] || null : null;
}

function saveCompletionRecord(serial, record) {
  if (!serial) return;
  const history = store.get(COMPLETION_HISTORY_KEY, {});
  const next = history && typeof history === 'object' ? { ...history } : {};
  const previous = next[serial] || null;
  if (JSON.stringify(previous) === JSON.stringify(record)) return;
  if (record) next[serial] = record; else delete next[serial];
  store.set(COMPLETION_HISTORY_KEY, next);
}

function clearCompletionTimer(rt) {
  if (!rt || !rt.completionTimer) return;
  clearTimeout(rt.completionTimer);
  rt.completionTimer = null;
}

// 完成态展示边界（20 分钟成功动画 / 24 小时完成时刻）的定时刷新——按台各自一个定时器。
function scheduleCompletionUpdate(serial, rt, nextUpdateAt) {
  clearCompletionTimer(rt);
  if (!Number.isFinite(nextUpdateAt)) return;
  rt.completionTimer = setTimeout(() => {
    rt.completionTimer = null;
    if (rt.lastReport) applyReport(serial, rt.lastReport);
  }, Math.max(0, nextUpdateAt - Date.now()));
}

// 该台错误码表的缓存 key（按当前语言 + 机型；见 errorTables）。
function errorTableKeyFor(serial) {
  const model = errorCodes.modelCodeFromSerial(serial);
  const lang = errorCodes.langForLocale(store.get('locale', 'zh-CN'));
  return model ? `${lang}_${model}` : null;
}

// 应用某台的一帧 report：按 serial 存原始报文/解析状态，节流推送与托盘重建。
// mock 路径（MOCK_SERIAL）与真机 live 路径（PrinterHub onReport）共用。
function applyReport(serial, report) {
  const rt = getRuntime(serial);
  rt.lastReport = report; // 保留原始报文供托盘菜单
  let state = resolveState(report);
  // 打印失败：用官方码表把错误归到「大类」（断料/堵头/…），熊猫/托盘/卡片统一显示「打印失败 · 大类」。
  // 具体长句原因太专业，不在熊猫展示 —— 用户要细节请查 Bambu Studio。认不出大类则保持通用「打印失败」。
  if (state.stateKey === 'failed') {
    const key = errorTableKeyFor(serial);
    const cat = errorCodes.failureCategory(report, key ? errorTables.get(key) || null : null);
    if (cat) state = { ...state, labelKey: `label.failed.${cat}`, labelParams: {} };
  }

  if (serial !== MOCK_SERIAL && store.get('dataSource', 'mock') === 'live') {
    const completion = applyCompletionState(
      report, state, completionRecord(serial), Date.now(),
    );
    saveCompletionRecord(serial, completion.record);
    state = completion.state;
    scheduleCompletionUpdate(serial, rt, completion.nextUpdateAt);
  } else {
    clearCompletionTimer(rt);
  }

  rt.lastState = state;
  schedulePetPush();
  scheduleTrayRebuild();
  notifySettingsLive(); // MQTT 实时状态变化 → 刷新设置窗打印机卡片
}

// MQTT 报文频次较高（打印中每秒量级），防抖后再通知设置窗重绘，避免高频刷新。
// 仅 live 模式通知；mock 模式的卡片状态由 play:stateChanged 单独驱动。
function notifySettingsLive() {
  if (!settingsWin || settingsWin.isDestroyed()) return;
  if (store.get('dataSource', 'mock') !== 'live') return;
  if (liveNotifyTimer) return;
  liveNotifyTimer = setTimeout(() => {
    liveNotifyTimer = null;
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('printers:changed');
  }, 1000);
}

// 合并云端 + 本地 打印机为统一列表
function getUnified() {
  return registry.mergePrinters(store.get('bambuPrinters', []), store.get('bambuLanPrinters', []));
}
// 用某条目建数据源；transport 指定 'lan'|'cloud'
function makeSourceFor(entry, transport) {
  if (transport === 'lan') {
    const lan = store.get('bambuLanPrinters', []).find((p) => p.serial === entry.serial);
    return new BambuLanDataSource({ host: lan.host, accessCode: decryptSecret(lan.accessCode), serial: entry.serial });
  }
  const account = store.get('bambuAccount');
  return new BambuCloudDataSource({
    region: account.region, token: decryptSecret(account.token), uid: account.uid, serial: entry.serial,
  });
}

// 官方错误码表：按机型（序列号前 3 位）+ 语言下载 BambuStudio 的 hms_<lang>_<model>.json，
// 缓存到 userData/error-codes/，解析后供托盘/卡片在「打印失败」时显示官方原因文案（与 Bambu Studio 同源）。
// 多台可能是不同机型 → 表按 "<lang>_<model>" 缓存在 errorTables Map，errorTablePending 挡并发重复下载。
// 全程失败静默 —— 拿不到表只是不显示原因、回退通用「打印失败」，不影响主流程。命中磁盘缓存即用（码表极少变）。
async function ensureErrorTable(serial, locale) {
  const model = errorCodes.modelCodeFromSerial(serial);
  const lang = errorCodes.langForLocale(locale);
  if (!model) return;
  const key = `${lang}_${model}`;
  if (errorTables.has(key) || errorTablePending.has(key)) return; // 已加载 / 下载中
  errorTablePending.add(key);
  try {
    const fileName = `hms_${lang}_${model}.json`;
    const cachePath = path.join(app.getPath('userData'), 'error-codes', fileName);
    try {
      if (fs.existsSync(cachePath)) {
        errorTables.set(key, errorCodes.parseErrorTable(JSON.parse(fs.readFileSync(cachePath, 'utf8')), lang));
        scheduleTrayRebuild();
        return;
      }
    } catch { /* 缓存损坏 → 走下载 */ }
    try {
      const res = await netGetRaw('raw.githubusercontent.com',
        `/bambulab/BambuStudio/master/resources/hms/${fileName}`);
      if (res.statusCode !== 200) return; // 该机型/语言无对应文件时静默
      const json = JSON.parse(res.body);
      try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, res.body);
      } catch { /* 缓存写失败不影响本次使用 */ }
      errorTables.set(key, errorCodes.parseErrorTable(json, lang));
      scheduleTrayRebuild();
    } catch (e) {
      console.error('[error-codes] 下载失败:', e && (e.message || e));
    }
  } finally {
    errorTablePending.delete(key);
  }
}

// 连接生命周期交给 PrinterHub（diff 式：新增建连、消失断连、配置未变不动）。
// onAuthFailure：云端 token 失效会同时命中所有云端台，去抖后只提示一次。
const hub = new PrinterHub({
  makeSource: makeSourceFor,
  onReport: applyReport,
  onAuthFailure: () => {
    const now = Date.now();
    if (now - lastAuthNotifyAt < 5000) return;
    lastAuthNotifyAt = now;
    if (!settingsWin) createSettingsWindow();
    if (settingsWin) settingsWin.webContents.send('bambu:error', '连接已失效，请重新登录');
  },
  pickTransport: registry.pickTransport,
});

// 数据源与统一列表对齐（替代单台时代的 buildDataSource）：
//   - mock：断开全部真机连接，单个 MockDataSource 挂在 MOCK_SERIAL 下；
//   - live：hub.sync 全量对齐（配置签名未变的台不重连——云端 45s 轮询安全），
//     清掉已不在列表里的台的残留状态，逐台就绪错误码表。
function rebuildDataSources() {
  const mode = store.get('dataSource', 'mock');
  if (mode === 'mock') {
    hub.stopAll();
    for (const rt of runtimes.values()) clearCompletionTimer(rt);
    runtimes.clear();
    if (mockSource) mockSource.stop();
    mockSource = new MockDataSource();
    mockSource.onState((report) => applyReport(MOCK_SERIAL, report));
    mockSource.start();
    return;
  }
  // live
  if (mockSource) { mockSource.stop(); mockSource = null; }
  const unified = getUnified();
  const valid = new Set(unified.map((p) => p.serial));
  for (const [serial, rt] of runtimes) {
    if (!valid.has(serial)) { // 含 MOCK_SERIAL 与已删除的台：清掉避免状态/遥测串台
      clearCompletionTimer(rt);
      runtimes.delete(serial);
    }
  }
  hub.sync(unified);
  const locale = store.get('locale', 'zh-CN');
  for (const p of unified) ensureErrorTable(p.serial, locale);
  pushState();
  rebuildTray();
}

// ---- 托盘（§5.2）----
// 构建托盘菜单中的实时指标行（层数 / 剩余时间）。
// 返回实时指标的**多条**短文本，托盘菜单里每条各占一行，避免拼成一整行把菜单顶得很宽。
// 状态行（含百分比）在 buildMenuTemplate 单独展示，故这里从第 2 行起：层数 → 剩余时间。
// 温度（喷嘴/热床）已去除：打印稳定进行时温度恒定在目标值、不可操作，属低价值信息，不再展示。
// 托盘始终全显，不受「显示层数 / 剩余时间」开关影响（那两个开关只作用于桌面熊猫标签）。
function getMetricsLines(locale, report) {
  if (!report || !report.connected) return [];
  const parts = [];
  // 层数 / 剩余时间是任务级指标，仅打印任务进行中（RUNNING/PAUSE/PREPARE）展示：
  // 真机空闲时报文仍残留上一任务的 layer/total（如 0/400），只判 total>0 会在「空闲」下误显层数行。
  if (isPrintActive(report)) {
    if (Number.isFinite(report.layer_num) && Number.isFinite(report.total_layer_num) && report.total_layer_num > 0) {
      parts.push(t(locale, 'label.layers', { layer: report.layer_num, total: report.total_layer_num }));
    }
    // 剩余时间：复用与熊猫标签一致的 fmtRemain 格式化，口径统一
    const remain = fmtRemain(extractTemps(report).remainingTime);
    if (remain != null) parts.push(t(locale, 'label.remaining', { time: remain }));
  }
  return parts;
}

function makeTrayIcon() {
  // 使用 PNG 图标素材（1x / 2x），支持明暗模式。
  // Template 模式下 macOS 自动根据菜单栏明暗反色。
  const iconPath = path.join(__dirname, '..', 'assets', 'icon', 'TrayIcon.png');
  const iconPath2x = path.join(__dirname, '..', 'assets', 'icon', 'TrayIcon@2x.png');
  const img = nativeImage.createFromPath(iconPath2x);
  img.setTemplateImage(true);
  // 返回 2x 图片，macOS 自动适配 1x 场景
  return img;
}

// 构建菜单模板（托盘菜单与「右键宠物」上下文菜单共用，保证跨平台一致）。
// 「在程序坞/任务栏显示」的跨平台落地：
// - macOS：切换程序坞图标显隐（app.dock）
// - Windows：无程序坞，以任务栏为等价物 —— 切换宠物窗口是否出现在任务栏
// - Linux：无对应概念，忽略
function applyDockVisibility(visible) {
  if (process.platform === 'darwin' && app.dock) {
    if (visible) app.dock.show(); else app.dock.hide();
  } else if (process.platform === 'win32' && win && !win.isDestroyed()) {
    win.setSkipTaskbar(!visible);
  }
}

// 某台的托盘状态文案（未收到首帧时为「启动中…」）。
function trayStatusLabel(locale, rt) {
  const st = rt && rt.lastState;
  return st ? t(locale, st.labelKey, st.labelParams) : t(locale, 'tray.starting');
}

function buildMenuTemplate() {
  const mode = store.get('dataSource', 'mock');
  const locale = store.get('locale', 'zh-CN');
  const template = [];

  // ── 状态区：全部台常驻连接，逐台展示 ──
  // 单台 / mock：沿用单打印机时代布局（一条状态行 + 指标行，不带名字头）。
  // 多台：每台一块——名字头 → 状态行 → 指标行，块间分隔线。
  // 失败时状态文案已是「打印失败 · 大类」（applyReport 里按官方码表归类注入）。
  const unified = mode === 'live' ? getUnified() : [];
  if (unified.length > 1) {
    unified.forEach((p, i) => {
      if (i > 0) template.push({ type: 'separator' });
      const rt = runtimes.get(p.serial);
      template.push({ label: `${p.name} · ${p.model || p.serial}`, enabled: false });
      template.push({ label: `${t(locale, 'tray.status')}：${trayStatusLabel(locale, rt)}`, enabled: false });
      for (const line of getMetricsLines(locale, rt && rt.lastReport)) {
        template.push({ label: line, enabled: false });
      }
    });
  } else {
    const rt = mode === 'mock'
      ? runtimes.get(MOCK_SERIAL)
      : (unified[0] && runtimes.get(unified[0].serial));
    template.push({ label: `${t(locale, 'tray.status')}：${trayStatusLabel(locale, rt)}`, enabled: false });
    // 实时指标（已连接时）：层数 / 剩余时间 / 喷嘴 / 热床各占一行，接在状态行（百分比）之后，
    // 避免拼成一行撑宽菜单。托盘始终全显，不受「显示层数 / 剩余时间」开关影响。
    for (const line of getMetricsLines(locale, rt && rt.lastReport)) {
      template.push({ label: line, enabled: false });
    }
  }

  // Mock 模式：数据源标识
  if (mode === 'mock') {
    template.push({ label: t(locale, 'tray.dataSourcePlay'), enabled: false });
  }

  template.push({ type: 'separator' });

  // ── 打印机入口 ──
  // 全部台常驻连接后无需「切换当前」；保留两类入口：
  //   - mock 模式且已有打印机：「回到真机」（原 radio 点击兼具此职能）；
  //   - live 模式但没有打印机：「添加打印机…」跳设置。
  if (mode === 'mock' && getUnified().length > 0) {
    template.push({
      label: t(locale, 'play.returnToLive'),
      click: () => {
        store.set('dataSource', 'live');
        rebuildDataSources();
        pushPlayState();
      },
    });
  } else if (mode === 'live' && unified.length === 0) {
    template.push({ label: t(locale, 'tray.addPrinter'), click: () => createSettingsWindow('printers') });
  }

  // ── 把玩模式 / 设置 / 大小 / 退出 ──
  template.push(
    { label: t(locale, 'tray.playMode'),
      click: () => createSettingsWindow('play') },
    { label: t(locale, 'tray.settings'),
      click: () => createSettingsWindow('printers') },
    {
      // 更新提示的三态（不弹系统通知，全在这条菜单项上安静完成）：
      //   无新版本 → 「检查更新…」；发现新版本（后台下载中/失败）→ 「新版本 vX ⬆️」；
      //   已下载就绪 → 「重启并更新到 vX」，点击直接装完重启，一步完成。
      label: updatePhase === 'downloaded'
        ? t(locale, 'tray.updateReady', { version: updateVersion })
        : pendingUpdate
          ? t(locale, 'tray.updateAvailable', { version: pendingUpdate.version })
          : t(locale, 'tray.checkUpdate'),
      // 未就绪时点击不直接发网络请求（托盘菜单关闭后几秒无反馈像卡死），
      // 而是打开设置的「关于」页并自动触发页内检查 —— 用户能立刻看到「检查中…」状态与结果。
      click: updatePhase === 'downloaded'
        ? () => autoUpdater.quitAndInstall()
        : () => createSettingsWindow('about', { autoCheckUpdate: true }),
    },
    { type: 'separator' },
    {
      label: t(locale, 'tray.showInMenuBar'),
      type: 'checkbox',
      checked: store.get('showInMenuBar', true),
      click: (mi) => {
        store.set('showInMenuBar', mi.checked);
        if (mi.checked) {
          if (!tray) createTray();
        } else {
          if (tray) { tray.destroy(); tray = null; }
        }
      },
    },
    {
      // Windows 没有程序坞，标签改用「任务栏」以贴合平台语义
      label: t(locale, process.platform === 'win32' ? 'tray.showInTaskbar' : 'tray.showInDock'),
      type: 'checkbox',
      checked: store.get('showInDock', true),
      click: (mi) => {
        store.set('showInDock', mi.checked);
        applyDockVisibility(mi.checked);
      },
    },
    { type: 'separator' },
    {
      // 临时显示/隐藏熊猫，不必退出整个应用。文字随当前状态翻转（显示中→「隐藏熊猫」）。
      // 点击后 rebuildTray() 让托盘菜单也刷新，与熊猫右键菜单（每次弹出重建）保持同步。
      label: t(locale, userHidPanda ? 'tray.showPanda' : 'tray.hidePanda'),
      click: () => {
        userHidPanda = !userHidPanda;
        applyPetUserVisibility();
        rebuildTray();
      },
    },
    {
      // 进入全屏应用（游戏 / 全屏视频 / 演示）时自动隐藏熊猫，退出全屏再出现。
      label: t(locale, 'tray.hideOnFullscreen'),
      type: 'checkbox',
      checked: store.get('hideOnFullscreen', true),
      click: (mi) => {
        store.set('hideOnFullscreen', mi.checked);
        applyHideOnFullscreen(mi.checked);
      },
    },
    { type: 'separator' },
    { label: t(locale, 'tray.exit'), click: () => app.quit() },
  );

  return template;
}

// 推送当前 locale 字符串包给宠物窗口
function pushLocale() {
  const locale = store.get('locale', 'zh-CN');
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:locale', locale, STRINGS[locale]);
  }
}

// 推送偏好设置给宠物窗口
function pushPetPrefs() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:prefs', {
      // 渲染层几何需要 sizePx（CSS 变量 --pet-px）：窗口可因多行标签比熊猫方形更高，
      // 100vh 不再恒等于熊猫边长，熊猫方形必须用显式像素锁定。
      sizePx: currentSizePx(),
      labelFontSize: store.get('labelFontSize', 12),
      showLabel: store.get('showLabel', true),
      showLayer: store.get('showLayer', false),
      showTime: store.get('showTime', false),
      showFinishTime: store.get('showFinishTime', false),
      matchFilamentColor: store.get('matchFilamentColor', true),
    });
  }
}

function rebuildTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  const locale = store.get('locale', 'zh-CN');
  // tooltip 用聚合后的「最需要关注」台的状态（与熊猫演的一致）
  const top = pickAttentionItem(currentPetItems());
  const statusLabel = top ? t(locale, top.state.labelKey, top.state.labelParams) : t(locale, 'tray.starting');
  tray.setToolTip(`${t(locale, 'tray.tooltip')} · ${statusLabel}`);
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  rebuildTray();
}

// 自动检查更新：复用 core/updater 的检测逻辑与 netGetRaw（走系统代理，国内也能连 api.github.com）。
// 发现新版本时只更新托盘菜单常驻高亮，不弹系统通知（用户不希望被打扰）。
// 检测失败静默处理，下次再试；手动「检查更新」按钮仍会在关于页展示错误。
async function runAutoUpdateCheck() {
  if (!store.get('autoCheckUpdate', true)) return;
  try {
    const pkg = require('../package.json');
    const r = await checkForUpdates(pkg.version, undefined, netGetRaw);
    if (r.error || !r.hasUpdate) return;
    pendingUpdate = { version: r.latestVersion, url: r.releaseUrl };
    rebuildTray();
    // 发现新版本即后台静默下载（主流桌面应用策略），就绪后托盘项变「重启并更新」。
    // 失败不打扰：返回值忽略，托盘保持「新版本 ⬆️」，用户仍可走关于页手动路径。
    await startUpdateDownload();
  } catch { /* 自动检查静默失败，下次再试 */ }
}

// ---- 应用内自动更新（后台下载 + 重启安装）----
// 「有没有新版本」的检测仍走 core/updater（GitHub API + 系统代理，见 runAutoUpdateCheck / app:checkUpdate）；
// electron-updater 负责下载与安装：读取 Release 附带的 latest*.yml、校验 sha512、
// 下载安装包（同样走 Electron net → 尊重系统代理），完成后重启安装。
// 下载时机采用主流桌面应用（Chrome / VS Code / Claude Code）的策略：自动检查发现新版本
// 即后台静默下载，就绪后托盘常驻项变「重启并更新」，用户一步完成；后台下载失败静默，
// 托盘退回「新版本 ⬆️」提示，由用户走关于页手动下载/发布页兜底。
// 仅打包后的应用可用（开发模式无安装形态，关于页不展示下载入口）；
// macOS 依赖 CI 的 Developer ID 签名 + zip 产物，Windows 未签名亦可静默更新。
let updatePhase = 'idle'; // idle | downloading | downloaded
let updatePercent = 0; // 最近一次下载进度（设置窗重开时恢复展示用）
let updateVersion = null; // 已下载/下载中的目标版本号

function pushUpdateState(payload) {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update:state', payload);
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = false; // 下载统一由 startUpdateDownload 显式发起（自动检查后/手动点击），便于状态管理
  autoUpdater.autoInstallOnAppQuit = true; // 已下载但没点「重启安装」→ 退出时静默完成安装
  autoUpdater.on('download-progress', (p) => {
    updatePercent = Math.round(p.percent || 0);
    pushUpdateState({ phase: 'downloading', percent: updatePercent });
  });
  autoUpdater.on('update-downloaded', (info) => {
    updatePhase = 'downloaded';
    updateVersion = info.version;
    pushUpdateState({ phase: 'downloaded', version: info.version });
    rebuildTray(); // 托盘常驻项升级为「重启并更新到 vX」
  });
  // 必须挂 error 监听：electron-updater 以 EventEmitter 抛错，无监听会变成未捕获异常。
  autoUpdater.on('error', (e) => {
    if (updatePhase === 'downloading') { updatePhase = 'idle'; updatePercent = 0; }
    pushUpdateState({ phase: 'error', message: humanizeError(e && e.message ? e.message : String(e)) });
  });
}

// 发起一次后台下载（幂等：下载中/已下载只重推状态不重复发起）。
// 自动路径（runAutoUpdateCheck）忽略返回值——失败静默；手动路径（update:download）把返回值给关于页展示。
async function startUpdateDownload() {
  if (!app.isPackaged) return { ok: false, reason: 'unsupported' };
  if (updatePhase === 'downloading') { pushUpdateState({ phase: 'downloading', percent: updatePercent }); return { ok: true }; }
  if (updatePhase === 'downloaded') { pushUpdateState({ phase: 'downloaded', version: updateVersion }); return { ok: true }; }
  try {
    // electron-updater 要求先 checkForUpdates 再 downloadUpdate。它读的是最新 Release 的
    // latest*.yml；老版本 Release 没有该文件时这里会抛错，关于页回退展示「查看发布页」手动下载。
    const r = await autoUpdater.checkForUpdates();
    const latest = r && r.updateInfo && r.updateInfo.version;
    if (!latest || compareSemver(app.getVersion(), latest) >= 0) return { ok: false, reason: 'noUpdate' };
    updatePhase = 'downloading';
    updatePercent = 0;
    updateVersion = latest;
    pushUpdateState({ phase: 'downloading', percent: 0 });
    // 失败经由上面的 error 监听推给设置窗；这里兜掉 rejection 防未处理异常。
    autoUpdater.downloadUpdate().catch(() => { /* 已由 error 事件处理 */ });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'error', message: humanizeError(e && e.message ? e.message : String(e)) };
  }
}

ipcMain.handle('update:getState', () => ({
  supported: app.isPackaged,
  phase: updatePhase,
  percent: updatePercent,
  version: updateVersion,
}));

ipcMain.handle('update:download', () => startUpdateDownload());

ipcMain.handle('update:install', () => {
  if (updatePhase !== 'downloaded') return { ok: false };
  autoUpdater.quitAndInstall();
  return { ok: true };
});

// ---- Bambu 连接设置窗 ----
function createSettingsWindow(section = 'printers', opts = {}) {
  const { autoCheckUpdate = false } = opts;
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    settingsWin.webContents.send('settings:navigate', section);
    if (autoCheckUpdate) settingsWin.webContents.send('settings:checkUpdate');
    return;
  }
  settingsWin = new BrowserWindow({
    width: 740,
    height: 574,
    minWidth: 640,
    minHeight: 520,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: t(store.get('locale', 'zh-CN'), 'settings.title'),
    icon: WINDOW_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings', 'index.html'), { hash: section });
  // 新建窗口时，等渲染进程加载完（监听器就绪）再发自动检查信号。
  if (autoCheckUpdate) {
    settingsWin.webContents.once('did-finish-load', () => {
      settingsWin.webContents.send('settings:checkUpdate');
    });
  }
  settingsWin.on('closed', () => { settingsWin = null; });
}

// 凭据安全存储：能加密则加密（OS keychain），否则回退明文并告警。
function encryptSecret(plain) {
  if (plain == null) return null;
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(plain).toString('base64');
  console.warn('[bambu] safeStorage 不可用，凭据以明文存储');
  return String(plain);
}
function decryptSecret(secret) {
  if (secret == null || secret === '') return undefined;
  if (safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(secret, 'base64')); }
    catch (e) { console.warn('[bambu] 解密失败，回退明文', e.message); }
  }
  return String(secret);
}

// ---- Bambu IPC（设置窗 ↔ 主进程）----
// 本次会话刚换到的 token（验证码登录后 / 直接登录后缓存）
let pendingAuth = null;

ipcMain.handle('bambu:login', async (_e, region, account, password) => {
  const r = await bambuAuth.login(region, account, password);
  if (r.ok) {
    pendingAuth = { region, account, password, token: r.token, uid: r.uid };
  }
  return r;
});

ipcMain.handle('bambu:verify', async (_e, region, account, password, tfaKey, code) => {
  const r = await bambuAuth.sendVerifyCode(region, account, password, tfaKey, code);
  if (r.ok) {
    pendingAuth = { region, account, password, token: r.token, uid: r.uid };
  }
  return r;
});

// 短信验证码登录（中国区）：发码（无需鉴权），再用码换 token（无密码）。
ipcMain.handle('bambu:requestSmsCode', async (_e, region, phone) =>
  bambuAuth.requestSmsCode(region, phone));

ipcMain.handle('bambu:loginWithCode', async (_e, region, account, code, tfaKey) => {
  const r = await bambuAuth.loginWithCode(region, account, code, tfaKey);
  if (r.ok) {
    pendingAuth = { region, account, token: r.token, uid: r.uid };
  }
  return r;
});

// ---- 云端粗粒度状态轮询（§Task 5）----
// 定期刷新 bambuPrinters 的 online/printStatus，驱动托盘与设置窗展示。
async function refreshCloudPrinters() {
  const account = store.get('bambuAccount');
  if (!account || !account.token) return;
  const r = await bambuAuth.listDevices(account.region, decryptSecret(account.token));
  if (r.ok) {
    // 保留用户重命名过的名称：轮询刷新只更新 model/online/printStatus，不覆盖已存的 name。
    const prevBySerial = new Map(store.get('bambuPrinters', []).map((p) => [p.serial, p]));
    store.set('bambuPrinters', r.devices.map((d) => ({
      serial: d.serial,
      name: prevBySerial.get(d.serial)?.name || d.name,
      model: d.model, online: d.online, printStatus: d.printStatus || null,
    })));
  } else {
    // token 过期等鉴权失败 → 清空所有打印机的在线/打印状态，避免显示过期快照
    const printers = store.get('bambuPrinters', []);
    store.set('bambuPrinters', printers.map((p) => ({ ...p, online: null, printStatus: null })));
  }
  // 列表可能新增/减少了台子 → 与常驻连接对齐（配置签名未变的台不重连，轮询不会闪断）。
  // rebuildDataSources 内部会 rebuildTray；mock 模式只刷托盘展示、不动 mock 源。
  if (store.get('dataSource', 'mock') === 'live') rebuildDataSources();
  else rebuildTray();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('printers:changed');
}
function startCloudPoll() {
  if (cloudPollTimer) clearInterval(cloudPollTimer);
  cloudPollTimer = setInterval(refreshCloudPrinters, 45000);
}

// 合并登录流程：登录成功后一次性持久化账号 + 拉取全部云端打印机进统一列表，
// 设一台为当前并切到 live —— 不关闭设置窗（用户停留在「打印机」区域看到已同步的列表）。
ipcMain.handle('bambu:completeCloudLogin', async () => {
  const { region, token, uid } = resolveActiveToken();
  if (!token) return { ok: false, error: '登录已失效，请重新登录' };
  const existingAccount = store.get('bambuAccount', {});
  store.set('bambuAccount', {
    region,
    account: (pendingAuth && pendingAuth.account) || existingAccount.account || '',
    uid,
    token: encryptSecret(token),
  });
  const r = await bambuAuth.listDevices(region, token);
  if (r.ok) {
    const prevBySerial = new Map(store.get('bambuPrinters', []).map((p) => [p.serial, p]));
    store.set('bambuPrinters', r.devices.map((d) => ({
      serial: d.serial,
      name: prevBySerial.get(d.serial)?.name || d.name,
      model: d.model, online: d.online, printStatus: d.printStatus || null,
    })));
  }
  store.set('dataSource', 'live');
  pendingAuth = null;
  rebuildDataSources();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('printers:changed');
  return { ok: true };
});

// LAN 测试连接：临时建一个数据源探活，6 秒内收到报文即视为成功。
// 供 `printer:addLan` 在落库前先探活复用。
// 超时/失败时按 classifyLanProbe 给出精准原因（网络不通 / 访问码错 / 序列号错），
// 而非笼统的「连接超时」——后者对三类完全不同的故障都是同一句话，误导排障。
async function testLanConnection(host, accessCode, serial) {
  const locale = store.get('locale', 'zh-CN');
  const ERR_KEY = { serial: 'settings.errLanSerial', auth: 'settings.errLanAuth',
    network: 'settings.errLanNetwork', timeout: 'settings.errLanTimeout' };
  return new Promise((resolve) => {
    const probe = new BambuLanDataSource({ host, accessCode, serial });
    let done = false;
    let gotConnect = false;
    let lastError = null;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); probe.stop(); resolve(r); };
    probe.onDiagnostic((evt) => {
      if (evt.type === 'connect') gotConnect = true;
      else if (evt.type === 'error') lastError = evt.error;
    });
    probe.onState((report) => { if (report.connected) finish({ ok: true }); });
    probe.start();
    const timer = setTimeout(() => {
      const reason = classifyLanProbe({ gotConnect, error: lastError });
      finish({ ok: false, error: t(locale, ERR_KEY[reason]) });
    }, 6000);
  });
}

// ---- 统一打印机列表管理（§Task 6）----
ipcMain.handle('printer:list', () => {
  // 把玩（mock）模式下 runtimes 是模拟场景，不能当作真机实时状态显示到卡片上。
  // 实时遥测派生见 core/live-telemetry.js（纯函数，含删机/重登后置空防串台的契约）。
  // 全部台常驻连接：逐台给出实时遥测（telemetry[serial]），不再只有「当前」一台有数据。
  const liveMode = store.get('dataSource', 'mock') === 'live';
  const telemetry = {};
  const printers = getUnified().map((p) => ({ ...p, hidden: isHidden(p.serial) }));
  for (const p of printers) {
    const rt = runtimes.get(p.serial);
    telemetry[p.serial] = buildLiveTelemetry(liveMode, rt ? rt.lastState : null, rt ? rt.lastReport : null);
  }
  return { printers, telemetry };
});

// 「在桌面显示」开关：隐藏台仍常驻连接（托盘/设置照常），只是不上桌面熊猫、不参与注意力。
// 改后立即重推一帧让桌面即时生效，并刷新托盘与设置窗。
ipcMain.handle('printer:setHidden', (_e, serial, hidden) => {
  setHidden(serial, hidden);
  pushState();
  rebuildTray();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('printers:changed');
  return { ok: true };
});

ipcMain.handle('printer:addLan', async (_e, host, accessCode, serial, name) => {
  const test = await testLanConnection(host, accessCode, serial);
  if (!test.ok) return test;
  const list = registry.addLan(store.get('bambuLanPrinters', []),
    { serial, name: name || serial, model: '', host, accessCode: encryptSecret(accessCode) });
  store.set('bambuLanPrinters', list);
  // 新添加的台立即接入常驻连接（也顺带从 mock 切回 live——添加即想看真机）
  store.set('dataSource', 'live');
  rebuildDataSources();
  return { ok: true };
});

ipcMain.handle('printer:removeLan', (_e, serial) => {
  store.set('bambuLanPrinters', registry.removeLan(store.get('bambuLanPrinters', []), serial));
  if (store.get('dataSource', 'mock') === 'live') rebuildDataSources(); // 断开该台连接并清残留状态
  else rebuildTray();
  return { ok: true };
});

ipcMain.handle('printer:rename', (_e, serial, name) => {
  store.set('bambuLanPrinters', registry.renameInList(store.get('bambuLanPrinters', []), serial, name));
  store.set('bambuPrinters', registry.renameInList(store.get('bambuPrinters', []), serial, name));
  rebuildTray();
  return { ok: true };
});

ipcMain.handle('printer:refreshCloud', async () => {
  await refreshCloudPrinters();
  return { ok: true };
});

// ---- 把玩探索（设置窗）----
function ensurePlayMode() {
  if (store.get('dataSource', 'mock') !== 'mock') {
    store.set('dataSource', 'mock');
    rebuildDataSources();
  }
}

ipcMain.handle('play:getState', () => ({
  isPlaying: store.get('dataSource', 'mock') === 'mock',
  currentScenario: currentPlayScenario(),
  percent: playPercent,
}));

ipcMain.handle('play:setScenario', (_e, key) => {
  ensurePlayMode();
  if (key !== 'printing') playPercent = 0;
  if (mockSource) mockSource.setScenario(key);
  pushPlayState();
  return { ok: true };
});

ipcMain.handle('play:setProgress', (_e, percent) => {
  ensurePlayMode();
  playPercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  if (mockSource) mockSource.setPrintingProgress(playPercent);
  pushPlayState();
  return { ok: true };
});

// 把玩页「耗材颜色（测试）」：仅 mock 数据源生效；null = 恢复原始素材绿。不持久化。
ipcMain.handle('play:setFilamentColor', (_e, hexOrNull) => {
  ensurePlayMode();
  if (mockSource) mockSource.setFilamentColor(hexOrNull);
  return { ok: true };
});

ipcMain.handle('play:autoTour', (_e, start) => {
  ensurePlayMode();
  if (mockSource) {
    if (start) mockSource.startAutoCycle(); else mockSource.stopAutoCycle();
  }
  pushPlayState();
  return { ok: true };
});

ipcMain.handle('play:returnToLive', () => {
  store.set('dataSource', 'live');
  rebuildDataSources();
  pushPlayState();
  return { ok: true };
});

// 返回脱敏状态给设置窗预填（永不回 token / accessCode 明文）
ipcMain.handle('bambu:getState', async () => {
  const account = store.get('bambuAccount', {});
  return {
    region: account.region,
    hasToken: !!account.token,
    account: account.account,
    uid: account.uid,
    printers: store.get('bambuPrinters', []),
  };
});

ipcMain.handle('bambu:logout', async () => {
  store.delete('bambuAccount');
  store.delete('bambuPrinters');
  pendingAuth = null;
  if (store.get('dataSource', 'mock') === 'live') rebuildDataSources(); // 断开云端台，仅剩 LAN 台
  return { ok: true };
});

ipcMain.on('bambu:close', () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); });

// 取当前可用 token：优先会话内 pendingAuth，回退已存凭据
function resolveActiveToken() {
  if (pendingAuth) {
    return { region: pendingAuth.region, token: pendingAuth.token, uid: pendingAuth.uid };
  }
  const account = store.get('bambuAccount', {});
  if (account.token) {
    return { region: account.region, token: decryptSecret(account.token), uid: account.uid };
  }
  return { region: account.region, token: null, uid: account.uid };
}

// ---- IPC：右键宠物弹出上下文菜单（跨平台主入口，§5.2）----
// Windows 没有 macOS 顶部菜单栏；右键宠物本体取菜单在三大平台行为一致。
ipcMain.on('pet:contextmenu', () => {
  if (!win || win.isDestroyed()) return;
  const menu = Menu.buildFromTemplate(buildMenuTemplate());
  menu.popup({ window: win });
});

// ---- IPC：点击穿透切换（§5.1）----
ipcMain.on('pet:setInteractive', (_e, interactive) => {
  if (!win || win.isDestroyed()) return;
  if (interactive) {
    win.setIgnoreMouseEvents(false);
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
  }
});

// ---- IPC：手动拖拽（§5.1 / §9）----
// 透明 frameless 窗上 -webkit-app-region:drag 不可靠，改为跟随光标。
let dragTimer = null;
let dragOffset = null; // 光标与窗口左上角的初始偏移
ipcMain.on('pet:dragStart', () => {
  if (!win || win.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  dragOffset = { dx: cursor.x - wx, dy: cursor.y - wy };
  // 【allow-direct-setBounds：sanctioned exception ②】拖拽跟随光标。
  // 拖拽全程锁定为当前尺寸：分数 DPI 缩放下反复 setPosition 会因 DIP↔像素取整误差
  // 让窗口逐帧变大（熊猫随之被放大），每帧用 setBounds 显式回写固定宽高即可杜绝累积。
  // 写的是「光标绝对位置 + 起始锁定的固定宽高」，不回写 getBounds()，故不累积。
  // 宽高都锁定为起始值（含标签加宽/多行标签加高的部分），避免拖拽时窗口回落、
  // 标签被截断或多行标签突然缩没。起始值一次性读取、拖拽期间恒定，不构成读回累积。
  const startBounds = win.getBounds();
  const width = startBounds.width;
  const height = startBounds.height;
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !dragOffset) return;
    const p = screen.getCursorScreenPoint();
    win.setBounds({
      x: Math.round(p.x - dragOffset.dx),
      y: Math.round(p.y - dragOffset.dy),
      width,
      height,
    });
  }, 16);
});
ipcMain.on('pet:dragEnd', () => {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  dragOffset = null;
  if (win && !win.isDestroyed()) {
    // 拖拽落定：据最终窗口 bounds 一次性算出熊猫方形中心作为新权威真源（单次读取、不循环，
    // 故不累积）。熊猫居中于窗口，窗口中心即熊猫中心；窗口高 == sizePx，故熊猫中心 y = 顶 + 半高。
    const b = win.getBounds();
    const px = currentSizePx();
    petCenter = { x: b.x + b.width / 2, y: b.y + px / 2 };
    // 持久化熊猫方形左上角（历史口径：正方形、margin=0，窗口两侧透明留白不计入）。
    store.set('window.position', { x: Math.round(petCenter.x - px / 2), y: b.y });
    // 拖拽期间窗口宽度被冻结（dragTimer 用起始宽），此处据新中心把宽度收敛回当前标签目标。
    applyWinWidth();
  }
});

// 渲染层量出标签实际宽高 → 按需加宽/向下加高窗口（保持中心不动，熊猫不移动）。
// 变大立即生效（长标签要完整显示、多出的行要能放下）；变小延迟落定（滞回）。为何滞回、
// 为何要「久」：探索模式自动播放里剩余时间/完成时间/进度会同时快速跳变，标签宽度既可能在
// 某个台阶边界±抖动（量化后目标宽 260↔300 反复拉锯），也会在「打印中 ↔ 换料中」之间来回切
// （宽↔窄）；多台时某台瞬时掉线/重连也会让行数±1 抖动。只要一次变大在延时窗口内到来，就
// 撤销待收缩、窗口维持在近期较大值——熊猫不动。
// 因此延时必须 **大于数据推送/自动播放的刷新间隔**（自动播放 1.5s/帧、真机 MQTT 约 1s/帧），
// 这样相邻两帧间的抖动/短暂换料插帧都会被下一帧的变大吃掉，绝不触发收缩；只有标签真正稳定
// 地变小（如打印结束回到空闲）超过该时长，才收缩一次落定。取 2000ms 留足余量。
// 宽高各自独立滞回：一次状态变化可能同时「某行变宽 + 行数变少」，两维不能互相绑架。
const LABEL_SHRINK_DELAY_MS = 2000;
const labelShrinkTimers = { w: null, h: null };
function applyLabelDim(dim, raw) {
  const v = Math.max(0, Math.round(Number(raw) || 0));
  if (v > labelSize[dim]) {
    // 变大：取消待收缩，立即生效
    if (labelShrinkTimers[dim]) { clearTimeout(labelShrinkTimers[dim]); labelShrinkTimers[dim] = null; }
    labelSize[dim] = v;
    applyWinWidth();
  } else if (v < labelSize[dim]) {
    // 变小：重置延时；快速抖动期间不断被推后，故不会反复收缩
    if (labelShrinkTimers[dim]) clearTimeout(labelShrinkTimers[dim]);
    labelShrinkTimers[dim] = setTimeout(() => {
      labelShrinkTimers[dim] = null;
      labelSize[dim] = v;
      applyWinWidth();
    }, LABEL_SHRINK_DELAY_MS);
  } else if (labelShrinkTimers[dim]) {
    // 标签稳定回到当前尺寸：撤销待收缩
    clearTimeout(labelShrinkTimers[dim]);
    labelShrinkTimers[dim] = null;
  }
}
ipcMain.on('pet:labelSize', (_e, size) => {
  applyLabelDim('w', size && size.w);
  applyLabelDim('h', size && size.h);
});

// ---- 偏好设置 IPC ----
ipcMain.handle('pref:getAll', () => ({
  sizePx: store.get('sizePx', 220),
  labelFontSize: store.get('labelFontSize', 12),
  showLabel: store.get('showLabel', true),
  showLayer: store.get('showLayer', false),
  showTime: store.get('showTime', false),
  showFinishTime: store.get('showFinishTime', false),
  matchFilamentColor: store.get('matchFilamentColor', true),
  showInMenuBar: store.get('showInMenuBar', true),
  showInDock: store.get('showInDock', true),
  locale: store.get('locale', 'zh-CN'),
  autoCheckUpdate: store.get('autoCheckUpdate', true),
}));

ipcMain.handle('pref:set', (_e, key, value) => {
  store.set(key, value);
  if (key === 'sizePx') setPetSizePx(value);
  if (key === 'sizePx' || key === 'labelFontSize' || key === 'showLabel' || key === 'showLayer' || key === 'showTime' || key === 'showFinishTime' || key === 'matchFilamentColor') pushPetPrefs();
  if (key === 'locale') {
    pushLocale();
    // 各台按新语言重解析（失败大类文案等依赖 locale 对应的码表 key）
    for (const [serial, rt] of runtimes) {
      if (rt.lastReport) applyReport(serial, rt.lastReport);
    }
    pushState(); // 没有任何报文时（如启动中）也立即用新语言重发
    // 语言变了 → 逐台就绪对应语言的官方错误码表（新 "<lang>_<model>" key 会触发加载）
    if (store.get('dataSource', 'mock') === 'live') {
      for (const p of getUnified()) ensureErrorTable(p.serial, value);
    }
  }
  if (key === 'showInMenuBar') {
    if (value) { if (!tray) createTray(); }
    else { if (tray) { tray.destroy(); tray = null; } }
  }
  if (key === 'showInDock') applyDockVisibility(value);
  if (key === 'labelFontSize' || key === 'locale' || key === 'showLabel') rebuildTray();
  return { ok: true };
});

// ---- 国际化 IPC ----
ipcMain.handle('locale:getStrings', () => STRINGS);
ipcMain.handle('locale:getCurrent', () => store.get('locale', 'zh-CN'));

ipcMain.handle('app:info', () => {
  const pkg = require('../package.json');
  return {
    name: 'Bambu Buddy',
    version: pkg.version,
    description: 'Bambu Buddy',
  };
});

ipcMain.handle('app:checkUpdate', async () => {
  const pkg = require('../package.json');
  return checkForUpdates(pkg.version, undefined, netGetRaw);
});

ipcMain.handle('app:openExternal', (_e, url) => {
  return shell.openExternal(url);
});

// ---- 生命周期 ----
app.setName('Bambu Buddy');

// 首启默认语言按系统语言决定：中文系统 → zh-CN，其它 → en。只支持这两种 locale。
function systemDefaultLocale() {
  let sys = '';
  try { sys = (app.getLocale() || '').toLowerCase(); } catch (e) { sys = ''; }
  return sys.startsWith('zh') ? 'zh-CN' : 'en';
}

app.whenReady().then(() => {
  // 移除 Electron 默认应用菜单（File/Edit/View/Window/Help）——本应用操作全在托盘/右键菜单，
  // Windows/Linux 窗口顶部不再显示这条菜单栏。
  Menu.setApplicationMenu(null);

  // 首次启动（尚未存过 locale）：按系统语言初始化默认语言并持久化，之后用户可在设置里改。
  // 需在 createWindow / createTray 之前，保证首帧文案即为正确语言。
  if (store.get('locale') == null) store.set('locale', systemDefaultLocale());

  // 设置 Dock 图标（开发模式下 Electron 默认图标会被替换）
  if (process.platform === 'darwin' && app.dock) {
    const appIconPath = path.join(__dirname, '..', 'assets', 'icon', 'AppIcon.png');
    try { app.dock.setIcon(appIconPath); } catch (e) { /* 开发模式下可能失败，忽略 */ }
  }

  migrateStorage();
  createWindow();
  // 根据用户偏好决定是否在程序坞（macOS）/任务栏（Windows）显示。
  // 需在 createWindow 之后：Windows 分支要操作宠物窗口的任务栏可见性。
  applyDockVisibility(store.get('showInDock', true));
  // 全屏时自动隐藏：默认开启。Windows 启动轮询；macOS 已在 createWindow 设好 Space 可见性。
  applyHideOnFullscreen(store.get('hideOnFullscreen', true));
  if (store.get('showInMenuBar', true)) createTray();
  rebuildDataSources();
  refreshCloudPrinters();
  startCloudPoll();

  // 自动检查更新：启动后延迟一次，之后每天复查一次（发现新版本仅在托盘菜单常驻高亮）。
  setTimeout(runAutoUpdateCheck, AUTO_UPDATE_STARTUP_DELAY_MS);
  setInterval(runAutoUpdateCheck, AUTO_UPDATE_INTERVAL_MS);
  // 应用内更新（下载 + 重启安装）事件接线；开发模式内部直接跳过。
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 桌面宠物：关闭所有窗口不退出（常驻托盘）
app.on('window-all-closed', () => {
  // 保持运行（托盘常驻）；用户从托盘退出。
});
