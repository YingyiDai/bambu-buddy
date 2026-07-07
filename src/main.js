// Electron 主进程：透明置顶窗口、托盘、IPC、位置记忆、数据源驱动（§5）。

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, safeStorage, shell, dialog, net } = require('electron');
const path = require('path');
const Store = require('electron-store');

// 窗口图标：Windows 用 .ico（多尺寸），其余平台用 PNG。
const WINDOW_ICON = path.join(__dirname, '..', 'assets', 'icon', process.platform === 'win32' ? 'AppIcon.ico' : 'AppIcon.png');

const { resolveState, extractTemps, fmtRemain } = require('./core/state-machine');
const { buildLiveTelemetry } = require('./core/live-telemetry');
const { MockDataSource } = require('./core/mock');
const { BambuCloudDataSource, BambuLanDataSource } = require('./core/bambu-mqtt');
const bambuAuth = require('./core/bambu-auth');
const { t, STRINGS } = require('./config/locales');
const { checkForUpdates } = require('./core/updater');
const errorCodes = require('./core/bambu-error-codes');
const fs = require('fs');
const registry = require('./core/printer-registry');

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
const { clampToVisible } = require('./core/window-position');

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
      store.set('bambuActivePrinter', bambu.serial);
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
let dataSource = null;
let settingsWin = null; // Bambu 连接设置窗（Cloud 登录 / LAN 配置）
let lastState = null; // 最近一次 resolveState 结果，用于托盘展示
let lastReport = null; // 最近一次 MQTT 原始报文，供托盘菜单读取实时指标
let errorTable = null; // 当前机型+语言的官方错误码表（解析后）；打印失败时查它得原因文案，未加载则 null
let errorTableKey = null; // 已加载表的 "<lang>_<model>" 标识，避免重复加载
let cloudPollTimer = null; // 云端粗粒度状态轮询定时器
let liveNotifyTimer = null; // MQTT 实时状态 → 设置窗重绘的防抖定时器
let playPercent = 0; // 把玩页打印进度（滑杆位置，0–100）
let pendingUpdate = null; // 自动检查发现的新版本 { version, url }，供托盘菜单常驻高亮

// 自动检查更新的节奏：启动后延迟一次（给网络/系统代理就绪时间），之后每天复查一次。
// 个人项目更新不频繁，无需更密的轮询。
const AUTO_UPDATE_STARTUP_DELAY_MS = 8000;
const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function currentSizePx() {
  return store.get('sizePx', 220);
}

// ---- 单实例锁（§5.1）----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
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

  win = new BrowserWindow({
    width: sizePx,
    height: sizePx,
    x, y,
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
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 默认点击穿透，鼠标进入实体像素时由渲染层 IPC 关闭（§5.1）
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 渲染层加载完成后，补发最近一次状态（数据源可能在窗口 ready 前已 emit）
  win.webContents.on('did-finish-load', () => {
    if (lastState) win.webContents.send('pet:state', lastState);
    pushLocale();
    pushPetPrefs();
  });
  // 位置记忆在 pet:dragEnd 时保存（§5.3），避免拖拽过程中频繁写盘。
}

// 无极调整宠物窗口大小（80–400px），保持中心不动，持久化。
function setPetSizePx(px) {
  px = Math.max(80, Math.min(400, Math.round(px)));
  store.set('sizePx', px);
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  const cx = x + w / 2, cy = y + h / 2;
  // 保持中心不动；放大后若溢出屏幕，夹回可见范围（clamp 失败则退回原中心算法）。
  const desired = { x: Math.round(cx - px / 2), y: Math.round(cy - px / 2) };
  const safe = clampToVisible(desired, screen.getAllDisplays(), px) || desired;
  win.setBounds({ x: safe.x, y: safe.y, width: px, height: px });
  const [nx, ny] = win.getPosition();
  store.set('window.position', { x: nx, y: ny });
  rebuildTray();
}

// ---- 数据源装配 ----
// 推送最新状态给宠物窗口（提取自原 buildDataSource 内联逻辑）。
function pushState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:state', lastState);
  }
}

// 当前把玩场景 key（仅 mock 数据源时有值）。
function currentPlayScenario() {
  return (dataSource instanceof MockDataSource) ? (dataSource.getCurrent() || null) : null;
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

// 应用一份 report：保存原始报文/解析状态、推送、刷新托盘。
// 供 mock 路径（经 wireDataSource）与真机 live 路径（经 connect 内的 onState）共用。
function applyReport(report) {
  lastReport = report; // 保留原始报文供托盘菜单
  lastState = resolveState(report);
  // 打印失败：用官方码表把错误归到「大类」（断料/堵头/…），熊猫/托盘/卡片统一显示「打印失败 · 大类」。
  // 具体长句原因太专业，不在熊猫展示 —— 用户要细节请查 Bambu Studio。认不出大类则保持通用「打印失败」。
  if (lastState.stateKey === 'failed') {
    const cat = errorCodes.failureCategory(report, errorTable);
    if (cat) lastState = { ...lastState, labelKey: `label.failed.${cat}`, labelParams: {} };
  }
  pushState();
  rebuildTray();
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

// 给数据源接上统一的 onState 回调：保存原始报文/解析状态、推送、刷新托盘。
// （提取自原 buildDataSource 内联逻辑，行为不变）
function wireDataSource(ds) {
  ds.onState((report) => applyReport(report));
}

// 合并云端 + 本地 打印机为统一列表
function getUnified() {
  return registry.mergePrinters(store.get('bambuPrinters', []), store.get('bambuLanPrinters', []));
}
// 取当前选中的统一条目
function resolveActiveEntry() {
  const serial = store.get('activePrinterSerial');
  return getUnified().find((p) => p.serial === serial) || null;
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

// 官方错误码表：按当前机型（序列号前 3 位）+ 语言下载 BambuStudio 的 hms_<lang>_<model>.json，
// 缓存到 userData/error-codes/，解析后供托盘/卡片在「打印失败」时显示官方原因文案（与 Bambu Studio 同源）。
// 全程失败静默 —— 拿不到表只是不显示原因、回退通用「打印失败」，不影响主流程。命中磁盘缓存即用（码表极少变）。
async function ensureErrorTable(serial, locale) {
  const model = errorCodes.modelCodeFromSerial(serial);
  const lang = errorCodes.langForLocale(locale);
  if (!model) return;
  const key = `${lang}_${model}`;
  if (key === errorTableKey && errorTable) return; // 已加载同一张表
  const fileName = `hms_${lang}_${model}.json`;
  const cachePath = path.join(app.getPath('userData'), 'error-codes', fileName);
  try {
    if (fs.existsSync(cachePath)) {
      errorTable = errorCodes.parseErrorTable(JSON.parse(fs.readFileSync(cachePath, 'utf8')), lang);
      errorTableKey = key;
      rebuildTray();
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
    errorTable = errorCodes.parseErrorTable(json, lang);
    errorTableKey = key;
    rebuildTray();
  } catch (e) {
    console.error('[error-codes] 下载失败:', e && (e.message || e));
  }
}

function buildDataSource() {
  if (dataSource) { dataSource.stop(); dataSource = null; }
  const mode = store.get('dataSource', 'mock');
  if (mode === 'mock') {
    dataSource = new MockDataSource();
    wireDataSource(dataSource);
    dataSource.start();
    return;
  }
  // live：解析当前打印机
  const entry = resolveActiveEntry();
  if (!entry) {
    lastState = resolveState({ connected: false });
    lastReport = null; // 清掉上一台的遥测，避免 printer:list 误把旧进度当作当前机实时数据
    pushState();
    rebuildTray();
    return;
  }
  // 切换打印机时先把宠物重置为「离线」，再等新机首帧报文覆盖：
  //   - 在线机：pushall 回传后很快更新为真实状态；
  //   - 离线机：永远收不到报文，保持离线（修复切到离线机仍显示上一台状态的问题）。
  // 同时清空 lastReport：否则 printer:list 的 hasLive/liveProgress 仍取上一台报文，
  // 导致切换后活动卡片上串显上一台的进度/层数。
  lastState = resolveState({ connected: false });
  lastReport = null;
  pushState();
  rebuildTray();

  // 该机型的官方错误码表异步就绪（打印失败时用于显示官方原因文案）；不阻塞连接流程
  ensureErrorTable(entry.serial, store.get('locale', 'zh-CN'));

  const transport = registry.pickTransport(entry);
  let triedCloudFallback = false;
  const connect = (tp) => {
    dataSource = makeSourceFor(entry, tp);
    let everConnected = false;
    // LAN 从未连接成功且该机也在云端 → 回退云一次（仅一次）
    const maybeFallback = () => {
      if (tp === 'lan' && entry.hasCloud && !triedCloudFallback && !everConnected) {
        triedCloudFallback = true;
        if (dataSource) dataSource.stop();
        connect('cloud');
        return true;
      }
      return false;
    };
    // 启动期鉴权/配置失败（如云端 token 失效、登录异常）：仍走原逻辑提示重登。
    if (typeof dataSource.onAuthFailure === 'function') {
      dataSource.onAuthFailure(() => {
        if (maybeFallback()) return;
        // 非回退场景（如云端鉴权失效）：重新打开设置窗提示
        if (!settingsWin) createSettingsWindow();
        if (settingsWin) settingsWin.webContents.send('bambu:error', '连接已失效，请重新登录');
      });
    }
    // 运行期 onState：成功连接过一次后，瞬时 error/offline 只表现为离线，不再触发回退或弹窗。
    dataSource.onState((report) => {
      if (report && report.connected) everConnected = true;
      if (!(report && report.connected) && !everConnected && maybeFallback()) return;
      applyReport(report);
    });
    dataSource.start();
  };
  connect(transport);
}

// ---- 托盘（§5.2）----
// 构建托盘菜单中的打印机身份行。
function getPrinterLabel(locale) {
  const mode = store.get('dataSource', 'mock');
  if (mode === 'mock') return null;
  const active = store.get('activePrinterSerial');
  const printer = getUnified().find((p) => p.serial === active);
  if (!printer) return active ? `${t(locale, 'tray.printer')}：${active}` : null;
  const label = printer.model
    ? `${printer.model} · ${printer.serial}`
    : `${printer.name} · ${printer.serial}`;
  return `${t(locale, 'tray.printer')}：${label}`;
}

// 构建托盘菜单中的账号行（已登录时展示，Mock 模式不展示）。
function getAccountLabel(locale) {
  const mode = store.get('dataSource', 'mock');
  if (mode === 'mock') return null;
  const account = store.get('bambuAccount', {});
  if (!account.account) return null;
  const regionLabel = account.region === 'china'
    ? t(locale, 'settings.regionChina')
    : t(locale, 'settings.regionGlobal');
  return `${t(locale, 'tray.account')}：${account.account} [${regionLabel}]`;
}

// 构建托盘菜单中的实时指标行（层数 / 剩余时间 / 温度）。
// 返回实时指标的**多条**短文本，托盘菜单里每条各占一行，避免拼成一整行把菜单顶得很宽。
// 状态行（含百分比）在 buildMenuTemplate 单独展示，故这里从第 2 行起：层数 → 剩余时间 → 喷嘴 → 热床。
// 托盘始终全显，不受「显示层数 / 剩余时间」开关影响（那两个开关只作用于桌面熊猫标签）。
function getMetricsLines(locale, report) {
  if (!report || !report.connected) return [];
  const temps = extractTemps(report);
  const parts = [];
  // 层数：仅打印中（有 layer/total）时展示
  if (Number.isFinite(report.layer_num) && Number.isFinite(report.total_layer_num) && report.total_layer_num > 0) {
    parts.push(t(locale, 'label.layers', { layer: report.layer_num, total: report.total_layer_num }));
  }
  // 剩余时间：复用与熊猫标签一致的 fmtRemain 格式化，口径统一
  const remain = fmtRemain(temps.remainingTime);
  if (remain != null) parts.push(t(locale, 'label.remaining', { time: remain }));
  if (temps.nozzleTemp != null) {
    if (temps.targetNozzleTemp != null && temps.targetNozzleTemp > 0) {
      parts.push(`${t(locale, 'tray.nozzle')} ${temps.nozzleTemp}→${temps.targetNozzleTemp}°C`);
    } else {
      parts.push(`${t(locale, 'tray.nozzle')} ${temps.nozzleTemp}°C`);
    }
  }
  if (temps.bedTemp != null) {
    if (temps.targetBedTemp != null && temps.targetBedTemp > 0) {
      parts.push(`${t(locale, 'tray.bed')} ${temps.bedTemp}→${temps.targetBedTemp}°C`);
    } else {
      parts.push(`${t(locale, 'tray.bed')} ${temps.bedTemp}°C`);
    }
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

function buildMenuTemplate() {
  const mode = store.get('dataSource', 'mock');
  const locale = store.get('locale', 'zh-CN');
  const statusLabel = lastState ? t(locale, lastState.labelKey, lastState.labelParams) : t(locale, 'tray.starting');
  const template = [];


  // 状态行（总是展示）。失败时 statusLabel 已是「打印失败 · 大类」（applyReport 里按官方码表归类注入）。
  template.push({ label: `${t(locale, 'tray.status')}：${statusLabel}`, enabled: false });

  // 实时指标（已连接时）：层数 / 剩余时间 / 喷嘴 / 热床各占一行，接在状态行（百分比）之后，
  // 避免拼成一行撑宽菜单。托盘始终全显，不受「显示层数 / 剩余时间」开关影响。
  for (const line of getMetricsLines(locale, lastReport)) {
    template.push({ label: line, enabled: false });
  }

  // Mock 模式：数据源标识
  if (mode === 'mock') {
    template.push({ label: t(locale, 'tray.dataSourcePlay'), enabled: false });
  }

  template.push({ type: 'separator' });

  // ── 打印机（始终展示）：有打印机则列出可切换；无打印机则提示并支持跳转设置 ──
  {
    const unified = getUnified();
    const active = store.get('activePrinterSerial');
    let printerSubmenu;
    if (unified.length > 0) {
      printerSubmenu = unified.map((p) => ({
        label: `${p.name} · ${p.model || p.serial}`,
        type: 'radio',
        checked: mode === 'live' && p.serial === active,
        click: () => { store.set('activePrinterSerial', p.serial); store.set('dataSource', 'live'); buildDataSource(); },
      }));
    } else {
      printerSubmenu = [
        { label: t(locale, 'tray.noPrinter'), enabled: false },
        { label: t(locale, 'tray.addPrinter'), click: () => createSettingsWindow('printers') },
      ];
    }
    template.push({ label: t(locale, 'tray.printer'), submenu: printerSubmenu });
  }

  // ── 把玩模式 / 设置 / 大小 / 退出 ──
  template.push(
    { label: t(locale, 'tray.playMode'),
      click: () => createSettingsWindow('play') },
    { label: t(locale, 'tray.settings'),
      click: () => createSettingsWindow('printers') },
    {
      // 自动检查若发现新版本，这条菜单项常驻显示成「● 有新版本 vX.Y.Z」做安静提示（不弹系统通知）。
      label: pendingUpdate
        ? t(locale, 'tray.updateAvailable', { version: pendingUpdate.version })
        : t(locale, 'tray.checkUpdate'),
      // 托盘菜单点击后会立即关闭，若在此直接发网络请求，弹结果前的几秒没有任何反馈，像卡死。
      // 改为打开设置的「关于」页并自动触发页内的检查更新按钮 —— 用户能立刻看到「检查中…」状态与结果。
      click: () => createSettingsWindow('about', { autoCheckUpdate: true }),
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

function resendState() {
  if (win && !win.isDestroyed() && lastState) {
    win.webContents.send('pet:state', lastState);
  }
}

// 推送偏好设置给宠物窗口
function pushPetPrefs() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:prefs', {
      labelFontSize: store.get('labelFontSize', 12),
      showLabel: store.get('showLabel', true),
      showLayer: store.get('showLayer', false),
      showTime: store.get('showTime', false),
    });
  }
}

function rebuildTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  const locale = store.get('locale', 'zh-CN');
  const statusLabel = lastState ? t(locale, lastState.labelKey, lastState.labelParams) : t(locale, 'tray.starting');
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
  } catch { /* 自动检查静默失败，下次再试 */ }
}

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
  rebuildTray();
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
    const active = store.get('activePrinterSerial');
    const stillThere = r.devices.some((d) => d.serial === active);
    if (!stillThere && r.devices.length > 0) store.set('activePrinterSerial', r.devices[0].serial);
  }
  store.set('dataSource', 'live');
  pendingAuth = null;
  buildDataSource();
  rebuildTray();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('printers:changed');
  return { ok: true };
});

// LAN 测试连接：临时建一个数据源探活，6 秒内收到报文即视为成功。
// 供 `printer:addLan` 在落库前先探活复用。
async function testLanConnection(host, accessCode, serial) {
  return new Promise((resolve) => {
    const probe = new BambuLanDataSource({ host, accessCode, serial });
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); probe.stop(); resolve(r); };
    probe.onState((report) => { if (report.connected) finish({ ok: true }); });
    probe.start();
    const t = setTimeout(() => finish({ ok: false, error: '连接超时，请检查 IP / 访问码' }), 6000);
  });
}

// ---- 统一打印机列表管理（§Task 6）----
ipcMain.handle('printer:list', () => {
  // 把玩（mock）模式下 lastState/lastReport 是模拟场景，不能当作真机实时状态显示到卡片上。
  // 实时遥测派生见 core/live-telemetry.js（纯函数，含切换/重登后置空防串台的契约）。
  const liveMode = store.get('dataSource', 'mock') === 'live';
  return {
    printers: getUnified(),
    activeSerial: store.get('activePrinterSerial') || null,
    ...buildLiveTelemetry(liveMode, lastState, lastReport),
  };
});

ipcMain.handle('printer:setActive', (_e, serial) => {
  store.set('activePrinterSerial', serial);
  store.set('dataSource', 'live');
  buildDataSource();
  return { ok: true };
});

ipcMain.handle('printer:addLan', async (_e, host, accessCode, serial, name) => {
  const test = await testLanConnection(host, accessCode, serial);
  if (!test.ok) return test;
  const list = registry.addLan(store.get('bambuLanPrinters', []),
    { serial, name: name || serial, model: '', host, accessCode: encryptSecret(accessCode) });
  store.set('bambuLanPrinters', list);
  rebuildTray();
  return { ok: true };
});

ipcMain.handle('printer:removeLan', (_e, serial) => {
  store.set('bambuLanPrinters', registry.removeLan(store.get('bambuLanPrinters', []), serial));
  if (store.get('activePrinterSerial') === serial) {
    const next = getUnified()[0];
    store.set('activePrinterSerial', next ? next.serial : null);
    buildDataSource();
  }
  rebuildTray();
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
    buildDataSource();
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
  if (dataSource instanceof MockDataSource) dataSource.setScenario(key);
  pushPlayState();
  return { ok: true };
});

ipcMain.handle('play:setProgress', (_e, percent) => {
  ensurePlayMode();
  playPercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  if (dataSource instanceof MockDataSource) dataSource.setPrintingProgress(playPercent);
  pushPlayState();
  return { ok: true };
});

ipcMain.handle('play:autoTour', (_e, start) => {
  ensurePlayMode();
  if (dataSource instanceof MockDataSource) {
    if (start) dataSource.startAutoCycle(); else dataSource.stopAutoCycle();
  }
  pushPlayState();
  return { ok: true };
});

ipcMain.handle('play:returnToLive', () => {
  store.set('dataSource', 'live');
  buildDataSource();
  pushPlayState();
  return { ok: true };
});

// 返回脱敏状态给设置窗预填（永不回 token / accessCode 明文）
ipcMain.handle('bambu:getState', async () => {
  const account = store.get('bambuAccount', {});
  const printers = store.get('bambuPrinters', []);
  const activePrinter = store.get('activePrinterSerial');
  return {
    region: account.region,
    hasToken: !!account.token,
    account: account.account,
    uid: account.uid,
    printers,
    activePrinter,
    name: printers.find(p => p.serial === activePrinter)?.name || '',
  };
});

ipcMain.handle('bambu:logout', async () => {
  store.delete('bambuAccount');
  store.delete('bambuPrinters');
  pendingAuth = null;
  const stillActive = getUnified().some((p) => p.serial === store.get('activePrinterSerial'));
  if (!stillActive) store.set('activePrinterSerial', getUnified()[0]?.serial || null);
  buildDataSource();
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
  // 拖拽全程锁定为当前设定尺寸：分数 DPI 缩放下反复 setPosition 会因
  // DIP↔像素取整误差让窗口逐帧变大（熊猫随之被放大），每帧用 setBounds
  // 显式回写固定宽高即可杜绝这种累积（拖拽时大小不应改变）。
  const size = currentSizePx();
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !dragOffset) return;
    const p = screen.getCursorScreenPoint();
    win.setBounds({
      x: Math.round(p.x - dragOffset.dx),
      y: Math.round(p.y - dragOffset.dy),
      width: size,
      height: size,
    });
  }, 16);
});
ipcMain.on('pet:dragEnd', () => {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  dragOffset = null;
  if (win && !win.isDestroyed()) {
    const [px, py] = win.getPosition();
    store.set('window.position', { x: px, y: py });
  }
});

// ---- 偏好设置 IPC ----
ipcMain.handle('pref:getAll', () => ({
  sizePx: store.get('sizePx', 220),
  labelFontSize: store.get('labelFontSize', 12),
  showLabel: store.get('showLabel', true),
  showLayer: store.get('showLayer', false),
  showTime: store.get('showTime', false),
  showInMenuBar: store.get('showInMenuBar', true),
  showInDock: store.get('showInDock', true),
  locale: store.get('locale', 'zh-CN'),
  autoCheckUpdate: store.get('autoCheckUpdate', true),
}));

ipcMain.handle('pref:set', (_e, key, value) => {
  store.set(key, value);
  if (key === 'sizePx') setPetSizePx(value);
  if (key === 'labelFontSize' || key === 'showLabel' || key === 'showLayer' || key === 'showTime') pushPetPrefs();
  if (key === 'locale') {
    pushLocale(); resendState();
    // 语言变了 → 重新就绪对应语言的官方错误码表（新 "<lang>_<model>" key 会触发重载）
    if (store.get('dataSource', 'mock') === 'live') {
      const s = store.get('activePrinterSerial');
      if (s) ensureErrorTable(s, value);
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

app.whenReady().then(() => {
  // 移除 Electron 默认应用菜单（File/Edit/View/Window/Help）——本应用操作全在托盘/右键菜单，
  // Windows/Linux 窗口顶部不再显示这条菜单栏。
  Menu.setApplicationMenu(null);

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
  if (store.get('showInMenuBar', true)) createTray();
  buildDataSource();
  refreshCloudPrinters();
  startCloudPoll();

  // 自动检查更新：启动后延迟一次，之后每天复查一次（发现新版本仅在托盘菜单常驻高亮）。
  setTimeout(runAutoUpdateCheck, AUTO_UPDATE_STARTUP_DELAY_MS);
  setInterval(runAutoUpdateCheck, AUTO_UPDATE_INTERVAL_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 桌面宠物：关闭所有窗口不退出（常驻托盘）
app.on('window-all-closed', () => {
  // 保持运行（托盘常驻）；用户从托盘退出。
});
