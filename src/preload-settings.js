// 设置窗预加载：通过 contextBridge 暴露受控 API（window.bambu）。
// 全部走 ipcRenderer.invoke（请求/响应），适配登录流程的回值需要。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bambu', {
  // Cloud 登录 / 验证码 → 登录成功后由 completeCloudLogin 一次性同步设备列表
  submitCredentials: (region, account, password) =>
    ipcRenderer.invoke('bambu:login', region, account, password),
  submitVerifyCode: (region, account, password, tfaKey, code) =>
    ipcRenderer.invoke('bambu:verify', region, account, password, tfaKey, code),
  // 短信验证码登录（中国区）：发码 → 码登录（无密码）
  requestSmsCode: (region, phone) =>
    ipcRenderer.invoke('bambu:requestSmsCode', region, phone),
  loginWithCode: (region, account, code, tfaKey) =>
    ipcRenderer.invoke('bambu:loginWithCode', region, account, code, tfaKey),
  completeCloudLogin: () => ipcRenderer.invoke('bambu:completeCloudLogin'),

  // 主进程请求设置窗切到某个子页面（printers / play / appearance / about）
  onNavigate: (cb) => ipcRenderer.on('settings:navigate', (_e, section) => cb(section)),

  // 主进程请求自动触发「检查更新」（托盘菜单点检查更新时）
  onCheckUpdate: (cb) => ipcRenderer.on('settings:checkUpdate', () => cb()),

  // 状态 / 登出 / 关闭
  getStoredState: () => ipcRenderer.invoke('bambu:getState'),
  logout: () => ipcRenderer.invoke('bambu:logout'),
  close: () => ipcRenderer.send('bambu:close'),

  // 偏好设置
  getPreferences: () => ipcRenderer.invoke('pref:getAll'),
  setPreference: (key, value) => ipcRenderer.invoke('pref:set', key, value),

  // 国际化
  getLocaleStrings: () => ipcRenderer.invoke('locale:getStrings'),
  getCurrentLocale: () => ipcRenderer.invoke('locale:getCurrent'),

  // 关于信息
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  // 检查更新
  checkForUpdates: () => ipcRenderer.invoke('app:checkUpdate'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // 应用内更新：下载 / 重启安装 / 状态（进度经 update:state 推送）
  getUpdateState: () => ipcRenderer.invoke('update:getState'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (cb) => ipcRenderer.on('update:state', (_e, st) => cb(st)),

  // 主进程推送的后台错误（如 token 过期）
  onError: (cb) => ipcRenderer.on('bambu:error', (_e, msg) => cb(msg)),

  // 统一打印机列表管理（全部台常驻连接，printer:list 逐台带实时遥测）
  listPrinters: () => ipcRenderer.invoke('printer:list'),
  addLanPrinter: (host, accessCode, serial, name) =>
    ipcRenderer.invoke('printer:addLan', host, accessCode, serial, name),
  removeLanPrinter: (serial) => ipcRenderer.invoke('printer:removeLan', serial),
  renamePrinter: (serial, name) => ipcRenderer.invoke('printer:rename', serial, name),
  refreshCloud: () => ipcRenderer.invoke('printer:refreshCloud'),
  onPrintersChanged: (cb) => ipcRenderer.on('printers:changed', () => cb()),

  // 把玩探索
  playGetState: () => ipcRenderer.invoke('play:getState'),
  playSetScenario: (key) => ipcRenderer.invoke('play:setScenario', key),
  playSetProgress: (percent) => ipcRenderer.invoke('play:setProgress', percent),
  playAutoTour: (start) => ipcRenderer.invoke('play:autoTour', start),
  playSetFilamentColor: (hexOrNull) => ipcRenderer.invoke('play:setFilamentColor', hexOrNull),
  playReturnToLive: () => ipcRenderer.invoke('play:returnToLive'),
  onPlayStateChanged: (cb) => ipcRenderer.on('play:stateChanged', (_e, st) => cb(st)),
});
