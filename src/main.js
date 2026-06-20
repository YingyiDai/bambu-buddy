// Electron 主进程：透明置顶窗口、托盘、IPC、位置记忆、数据源驱动（§5）。

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, safeStorage } = require('electron');
const path = require('path');
const Store = require('electron-store');

const { resolveState } = require('./core/state-machine');
const { MockDataSource, SCENARIO_LABELS } = require('./core/mock');
const { BambuCloudDataSource, BambuLanDataSource } = require('./core/bambu-mqtt');
const bambuAuth = require('./core/bambu-auth');

const store = new Store();

let win = null;
let tray = null;
let dataSource = null;
let settingsWin = null; // Bambu 连接设置窗（Cloud 登录 / LAN 配置）
let lastState = null; // 最近一次 resolveState 结果，用于托盘展示

// 尺寸预设（窗口为正方形，熊猫随窗口缩放）。可在右键菜单「大小」切换。
const SIZE_PRESETS = { small: 160, medium: 220, large: 280 };
const SIZE_LABELS = { small: '小', medium: '中', large: '大' };
const DEFAULT_SIZE = 'medium';

function currentSizePx() {
  const key = store.get('size', DEFAULT_SIZE);
  return SIZE_PRESETS[key] || SIZE_PRESETS[DEFAULT_SIZE];
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
  });
  // 位置记忆在 pet:dragEnd 时保存（§5.3），避免拖拽过程中频繁写盘。
}

// 切换尺寸：调整窗口大小，保持中心不动（熊猫不跳位），持久化。
function setPetSize(key) {
  if (!SIZE_PRESETS[key]) return;
  store.set('size', key);
  if (!win || win.isDestroyed()) return;
  const px = SIZE_PRESETS[key];
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
function buildDataSource() {
  if (dataSource) { dataSource.stop(); dataSource = null; }
  const mode = store.get('dataSource', 'mock');
  if (mode === 'cloud') {
    const bambu = store.get('bambu', {});
    if (bambu.mode !== 'cloud' || !bambu.token || !bambu.serial) {
      // 未配置账号/设备 → 弹登录窗，而不是用空凭据建一个必然失败的连接
      createSettingsWindow();
      return;
    }
    const token = decryptSecret(bambu.token);
    dataSource = new BambuCloudDataSource({
      region: bambu.region,
      token,
      uid: bambu.uid,
      serial: bambu.serial,
    });
  } else if (mode === 'lan') {
    const bambu = store.get('bambu', {});
    if (bambu.mode !== 'lan' || !bambu.host || !bambu.accessCode || !bambu.serial) {
      createSettingsWindow();
      return;
    }
    const accessCode = decryptSecret(bambu.accessCode);
    dataSource = new BambuLanDataSource({
      host: bambu.host,
      accessCode,
      serial: bambu.serial,
    });
  } else {
    dataSource = new MockDataSource();
  }
  // 鉴权/连接失效 → 重新打开设置窗
  if (typeof dataSource.onAuthFailure === 'function') {
    dataSource.onAuthFailure(() => {
      if (!settingsWin) createSettingsWindow();
      if (settingsWin) settingsWin.webContents.send('bambu:error', '连接已失效，请重新登录');
    });
  }
  dataSource.onState((report) => {
    const resolved = resolveState(report);
    lastState = resolved;
    if (win && !win.isDestroyed()) {
      win.webContents.send('pet:state', resolved);
    }
    rebuildTray();
  });
  dataSource.start();
}

// ---- 托盘（§5.2）----
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
  const statusLabel = lastState ? lastState.label : '启动中…';

  const template = [
    { label: `状态：${statusLabel}`, enabled: false },
    { label: `数据源：${mode === 'cloud' ? 'Bambu Cloud' : (mode === 'lan' ? 'Bambu LAN' : 'Mock')}`, enabled: false },
    { type: 'separator' },
  ];

  // Mock 模式：手动切状态子菜单
  if (mode === 'mock' && dataSource instanceof MockDataSource) {
    const scenarioItems = Object.keys(SCENARIO_LABELS).map((key) => ({
      label: SCENARIO_LABELS[key],
      click: () => dataSource.setScenario(key),
    }));
    template.push({ label: 'Mock · 切换状态', submenu: scenarioItems });
    template.push({ label: 'Mock · 自动轮播 (demo)', click: () => dataSource.startAutoCycle() });
    template.push({ type: 'separator' });
  }

  template.push(
    {
      label: '数据源',
      submenu: [
        {
          label: 'Mock 模式', type: 'radio', checked: mode === 'mock',
          click: () => { store.set('dataSource', 'mock'); buildDataSource(); },
        },
        {
          label: 'Bambu Cloud 真机', type: 'radio', checked: mode === 'cloud',
          click: () => {
            store.set('dataSource', 'cloud');
            const bambu = store.get('bambu', {});
            if (bambu.mode === 'cloud' && bambu.token && bambu.serial) buildDataSource();
            else createSettingsWindow();
          },
        },
        {
          label: 'Bambu LAN 本地', type: 'radio', checked: mode === 'lan',
          click: () => {
            store.set('dataSource', 'lan');
            const bambu = store.get('bambu', {});
            if (bambu.mode === 'lan' && bambu.host && bambu.accessCode && bambu.serial) buildDataSource();
            else createSettingsWindow();
          },
        },
      ],
    },
    {
      label: 'Bambu 设置…',
      enabled: mode === 'cloud' || mode === 'lan',
      click: () => createSettingsWindow(),
    },
    {
      label: '大小',
      submenu: Object.keys(SIZE_PRESETS).map((key) => ({
        label: SIZE_LABELS[key],
        type: 'radio',
        checked: store.get('size', DEFAULT_SIZE) === key,
        click: () => setPetSize(key),
      })),
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  );

  return template;
}

function rebuildTray() {
  if (!tray) return;
  const statusLabel = lastState ? lastState.label : '启动中…';
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  tray.setToolTip(`Bambu 桌面宠物 · ${statusLabel}`);
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
    height: 580,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Bambu 连接设置',
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

ipcMain.handle('bambu:saveDevice', async (_e, serial, name) => {
  const { region, token, uid } = resolveActiveToken();
  if (!token) return { ok: false, error: '登录已失效，请重新登录' };
  store.set('bambu', {
    mode: 'cloud',
    region,
    uid,
    token: encryptSecret(token),
    serial,
    name,
    updatedAt: Date.now(),
  });
  afterSave();
  return { ok: true };
});

// LAN 测试连接：临时建一个数据源探活，5 秒内收到报文即视为成功。
ipcMain.handle('bambu:testLan', async (_e, host, accessCode, serial) => {
  return new Promise((resolve) => {
    const probe = new BambuLanDataSource({ host, accessCode, serial });
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); probe.stop(); resolve(r); };
    probe.onState((report) => { if (report.connected) finish({ ok: true }); });
    probe.start();
    const t = setTimeout(() => finish({ ok: false, error: '连接超时，请检查 IP / 访问码' }), 6000);
  });
});

ipcMain.handle('bambu:saveLan', async (_e, host, accessCode, serial, name) => {
  store.set('bambu', {
    mode: 'lan',
    host,
    accessCode: encryptSecret(accessCode),
    serial,
    name,
    updatedAt: Date.now(),
  });
  afterSave();
  return { ok: true };
});

// 返回脱敏状态给设置窗预填（永不回 token / accessCode 明文）
ipcMain.handle('bambu:getState', async () => {
  const mode = store.get('dataSource', 'mock');
  const bambu = store.get('bambu', {});
  if (bambu.mode === 'lan') {
    return { mode: 'lan', host: bambu.host, serial: bambu.serial, name: bambu.name };
  }
  return {
    mode: 'cloud',
    region: bambu.region,
    hasToken: !!bambu.token,
    uid: bambu.uid,
    serial: bambu.serial,
    name: bambu.name,
    activeMode: mode,
  };
});

ipcMain.handle('bambu:logout', async () => {
  store.delete('bambu');
  pendingAuth = null;
  if (dataSource) { dataSource.stop(); dataSource = null; }
  lastState = null;
  if (win && !win.isDestroyed()) win.webContents.send('pet:state', { stateKey: 'offline', label: '未连接打印机' });
  rebuildTray();
  return { ok: true };
});

ipcMain.on('bambu:close', () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); });

// 取当前可用 token：优先会话内 pendingAuth，回退已存凭据
function resolveActiveToken() {
  if (pendingAuth) {
    return { region: pendingAuth.region, token: pendingAuth.token, uid: pendingAuth.uid };
  }
  const bambu = store.get('bambu', {});
  if (bambu.mode === 'cloud' && bambu.token) {
    return { region: bambu.region, token: decryptSecret(bambu.token), uid: bambu.uid };
  }
  return { region: bambu.region, token: null, uid: bambu.uid };
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

// ---- 生命周期 ----
app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  createWindow();
  createTray();
  buildDataSource();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 桌面宠物：关闭所有窗口不退出（常驻托盘）
app.on('window-all-closed', () => {
  // 保持运行（托盘常驻）；用户从托盘退出。
});
