// Electron 主进程：透明置顶窗口、托盘、IPC、位置记忆、数据源驱动（§5）。

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, safeStorage } = require('electron');
const path = require('path');
const Store = require('electron-store');

const { resolveState, extractTemps, formatRemainingTime } = require('./core/state-machine');
const { MockDataSource, SCENARIO_LABELS } = require('./core/mock');
const { BambuCloudDataSource, BambuLanDataSource } = require('./core/bambu-mqtt');
const bambuAuth = require('./core/bambu-auth');
const { t, STRINGS } = require('./config/locales');
const registry = require('./core/printer-registry');

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
        token: bambu.token,
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
let cloudPollTimer = null; // 云端粗粒度状态轮询定时器

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
  // 读回上次位置（§5.3）
  const saved = store.get('window.position');
  let x, y;
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
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
  win.setBounds({
    x: Math.round(cx - px / 2),
    y: Math.round(cy - px / 2),
    width: px,
    height: px,
  });
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

// 应用一份 report：保存原始报文/解析状态、推送、刷新托盘。
// 供 mock 路径（经 wireDataSource）与真机 live 路径（经 connect 内的 onState）共用。
function applyReport(report) {
  lastReport = report; // 保留原始报文供托盘菜单
  lastState = resolveState(report);
  pushState();
  rebuildTray();
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
    pushState();
    rebuildTray();
    return;
  }
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

// 构建托盘菜单中的实时指标行（温度 + 剩余时间）。
function getMetricsLabel(locale, report) {
  if (!report || !report.connected) return null;
  const temps = extractTemps(report);
  const parts = [];
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
  // formatRemainingTime returns Chinese strings — use locale-aware version instead
  if (temps.remainingTime != null && temps.remainingTime > 0) {
    const mins = temps.remainingTime;
    if (mins < 60) {
      parts.push(t(locale, 'tray.remainingMin', { n: mins }));
    } else {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      const timeStr = m > 0 ? `${h}h${m}m` : `${h}h`;
      parts.push(t(locale, 'tray.remaining', { time: timeStr }));
    }
  }
  return parts.length > 0 ? parts.join(' | ') : null;
}

function makeTrayIcon() {
  // 一个简单的 16x16 模板图标（圆点），避免依赖外部资源。
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const cx = 7.5, cy = 7.5, rad = 6;
  for (let yy = 0; yy < size; yy++) {
    for (let xx = 0; xx < size; xx++) {
      const i = (yy * size + xx) * 4;
      const d = Math.hypot(xx - cx, yy - cy);
      const a = d <= rad ? 255 : 0;
      buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = a;
    }
  }
  const img = nativeImage.createFromBuffer(buf, { width: size, height: size });
  img.setTemplateImage(true);
  return img;
}

// 构建菜单模板（托盘菜单与「右键宠物」上下文菜单共用，保证跨平台一致）。
function buildMenuTemplate() {
  const mode = store.get('dataSource', 'mock');
  const locale = store.get('locale', 'zh-CN');
  const statusLabel = lastState ? t(locale, lastState.labelKey, lastState.labelParams) : t(locale, 'tray.starting');
  const template = [];

  // ── 设备 / 账号 / 实时信息（Mock 模式不展示）──
  if (mode !== 'mock') {
    const printerLabel = getPrinterLabel(locale);
    if (printerLabel) template.push({ label: printerLabel, enabled: false });

    const accountLabel = getAccountLabel(locale);
    if (accountLabel) template.push({ label: accountLabel, enabled: false });
  }

  // 状态行（总是展示）
  template.push({ label: `${t(locale, 'tray.status')}：${statusLabel}`, enabled: false });

  // 实时指标（仅 Live 模式且已连接时）
  const metricsLabel = getMetricsLabel(locale, lastReport);
  if (metricsLabel) template.push({ label: metricsLabel, enabled: false });

  // Mock 模式：数据源标识
  if (mode === 'mock') {
    template.push({ label: t(locale, 'tray.dataSourceMock'), enabled: false });
  }

  template.push({ type: 'separator' });

  // ── 切换打印机（Live 模式，统一列表：云端 + 本地）──
  if (mode === 'live') {
    const unified = getUnified();
    const active = store.get('activePrinterSerial');
    if (unified.length > 0) {
      const items = unified.map((p) => ({
        label: `${p.name} · ${p.model || p.serial}`,
        type: 'radio',
        checked: p.serial === active,
        click: () => { store.set('activePrinterSerial', p.serial); buildDataSource(); },
      }));
      template.push({ label: t(locale, 'tray.switchPrinter'), submenu: items });
    }
  }

  // ── Mock 模式：手动切状态子菜单 ──
  if (mode === 'mock' && dataSource instanceof MockDataSource) {
    const MOCK_LABEL_KEYS = {
      offline: 'mock.offline', idle: 'mock.idle',
      prepare_preheat: 'mock.preparePreheat', prepare_leveling: 'mock.prepareLeveling',
      printing: 'mock.printing', changing_filament: 'mock.changingFilament',
      paused: 'mock.paused', paused_runout: 'mock.pausedRunout',
      door_open: 'mock.doorOpen', finished: 'mock.finished', failed: 'mock.failed',
    };
    const scenarioItems = Object.keys(SCENARIO_LABELS).map((key) => ({
      label: t(locale, MOCK_LABEL_KEYS[key] || `mock.${key}`),
      click: () => dataSource.setScenario(key),
    }));
    template.push({ label: t(locale, 'tray.mockSwitch'), submenu: scenarioItems });
    template.push({ label: t(locale, 'tray.mockAuto'), click: () => dataSource.startAutoCycle() });
    template.push({ type: 'separator' });
  }

  // ── 数据源 / 大小 / 设置 / 退出 ──
  template.push(
    {
      label: t(locale, 'tray.source'),
      submenu: [
        {
          label: t(locale, 'tray.sourceMock'), type: 'radio', checked: mode === 'mock',
          click: () => { store.set('dataSource', 'mock'); buildDataSource(); },
        },
        {
          label: t(locale, 'tray.sourceLive'), type: 'radio', checked: mode === 'live',
          click: () => {
            store.set('dataSource', 'live');
            if (store.get('activePrinterSerial')) buildDataSource();
            else createSettingsWindow();
          },
        },
      ],
    },
    { label: t(locale, 'tray.settings'), enabled: mode === 'live',
      click: () => createSettingsWindow() },
    {
      label: t(locale, 'tray.size'),
      submenu: [
        { label: t(locale, 'tray.sizeSmall'), click: () => setPetSizePx(160) },
        { label: t(locale, 'tray.sizeMedium'), click: () => setPetSizePx(220) },
        { label: t(locale, 'tray.sizeLarge'), click: () => setPetSizePx(280) },
      ],
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
      label: t(locale, 'tray.showInDock'),
      type: 'checkbox',
      checked: store.get('showInDock', true),
      click: (mi) => {
        store.set('showInDock', mi.checked);
        if (mi.checked && process.platform === 'darwin' && app.dock) {
          app.dock.show();
        } else if (!mi.checked && process.platform === 'darwin' && app.dock) {
          app.dock.hide();
        }
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

// ---- Bambu 连接设置窗 ----
function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 440,
    height: 600,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: t(store.get('locale', 'zh-CN'), 'settings.title'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings', 'index.html'));
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

// listDevices：优先用本次会话刚换到的 token，否则用已存的 token
ipcMain.handle('bambu:listDevices', async () => {
  const { region, token } = resolveActiveToken();
  if (!token) return { ok: false, error: '请先登录' };
  return bambuAuth.listDevices(region, token);
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
    rebuildTray();
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('printers:changed');
  }
}
function startCloudPoll() {
  if (cloudPollTimer) clearInterval(cloudPollTimer);
  cloudPollTimer = setInterval(refreshCloudPrinters, 45000);
}

ipcMain.handle('bambu:saveDevice', async (_e, serial, name, model) => {
  const { region, token, uid } = resolveActiveToken();
  if (!token) return { ok: false, error: '登录已失效，请重新登录' };

  // 存账号凭据
  const existingAccount = store.get('bambuAccount', {});
  store.set('bambuAccount', {
    region,
    account: (pendingAuth && pendingAuth.account) || existingAccount.account || '',
    uid,
    token: encryptSecret(token),
  });

  // 加入/更新打印机列表
  const printers = store.get('bambuPrinters', []);
  const idx = printers.findIndex(p => p.serial === serial);
  const entry = { serial, name: name || serial, model: model || '' };
  if (idx >= 0) printers[idx] = entry;
  else printers.push(entry);
  store.set('bambuPrinters', printers);
  store.set('bambuActivePrinter', serial);

  afterSave();
  return { ok: true };
});

// LAN 测试连接：临时建一个数据源探活，5 秒内收到报文即视为成功。
// 抽出为独立函数，供 `bambu:testLan` 与 `printer:addLan` 复用（DRY）。
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

ipcMain.handle('bambu:testLan', async (_e, host, accessCode, serial) => testLanConnection(host, accessCode, serial));

ipcMain.handle('bambu:saveLan', async (_e, host, accessCode, serial, name) => {
  store.set('bambuLan', {
    host,
    accessCode: encryptSecret(accessCode),
    serial,
    name: name || serial,
  });
  afterSave();
  return { ok: true };
});

// ---- 统一打印机列表管理（§Task 6）----
ipcMain.handle('printer:list', () => ({
  printers: getUnified(),
  activeSerial: store.get('activePrinterSerial') || null,
  liveLabelKey: lastState ? lastState.labelKey : null,
  liveLabelParams: lastState ? lastState.labelParams : null,
}));

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

// 返回脱敏状态给设置窗预填（永不回 token / accessCode 明文）
ipcMain.handle('bambu:getState', async () => {
  const mode = store.get('dataSource', 'mock');
  if (mode === 'lan') {
    const lan = store.get('bambuLan', {});
    return { mode: 'lan', host: lan.host, serial: lan.serial, name: lan.name };
  }
  const account = store.get('bambuAccount', {});
  const printers = store.get('bambuPrinters', []);
  const activePrinter = store.get('bambuActivePrinter');
  return {
    mode: 'cloud',
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
  store.delete('bambuActivePrinter');
  pendingAuth = null;
  if (dataSource) { dataSource.stop(); dataSource = null; }
  lastState = null;
  lastReport = null;
  if (win && !win.isDestroyed()) win.webContents.send('pet:state', { stateKey: 'offline', videoFile: 'offline.webm', labelKey: 'label.offline', labelParams: {} });
  rebuildTray();
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

// 保存成功后：清会话缓存、重建数据源、关窗、刷新托盘
function afterSave() {
  pendingAuth = null;
  buildDataSource();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  rebuildTray();
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
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !dragOffset) return;
    const p = screen.getCursorScreenPoint();
    win.setPosition(Math.round(p.x - dragOffset.dx), Math.round(p.y - dragOffset.dy));
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
  showInMenuBar: store.get('showInMenuBar', true),
  showInDock: store.get('showInDock', true),
  locale: store.get('locale', 'zh-CN'),
}));

ipcMain.handle('pref:set', (_e, key, value) => {
  store.set(key, value);
  if (key === 'sizePx') setPetSizePx(value);
  if (key === 'labelFontSize' || key === 'showLabel') pushPetPrefs();
  if (key === 'locale') { pushLocale(); resendState(); }
  if (key === 'showInMenuBar') {
    if (value) { if (!tray) createTray(); }
    else { if (tray) { tray.destroy(); tray = null; } }
  }
  if (key === 'showInDock' && process.platform === 'darwin' && app.dock) {
    if (value) app.dock.show(); else app.dock.hide();
  }
  if (key === 'labelFontSize' || key === 'locale' || key === 'showLabel') rebuildTray();
  return { ok: true };
});

// ---- 国际化 IPC ----
ipcMain.handle('locale:getStrings', () => STRINGS);
ipcMain.handle('locale:getCurrent', () => store.get('locale', 'zh-CN'));

ipcMain.handle('app:info', () => {
  const pkg = require('../package.json');
  return {
    name: 'BambuPet',
    version: pkg.version,
    description: 'Bambu 打印机桌面宠物',
  };
});

// ---- 生命周期 ----
app.whenReady().then(() => {
  // 根据用户偏好决定是否在程序坞/菜单栏显示
  if (process.platform === 'darwin' && app.dock) {
    if (store.get('showInDock', true)) {
      app.dock.show();
    } else {
      app.dock.hide();
    }
  }
  migrateStorage();
  createWindow();
  if (store.get('showInMenuBar', true)) createTray();
  buildDataSource();
  refreshCloudPrinters();
  startCloudPoll();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 桌面宠物：关闭所有窗口不退出（常驻托盘）
app.on('window-all-closed', () => {
  // 保持运行（托盘常驻）；用户从托盘退出。
});
