// 设置窗预加载：通过 contextBridge 暴露受控 API（window.bambu）。
// 全部走 ipcRenderer.invoke（请求/响应），适配登录流程的回值需要。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bambu', {
  // Cloud 登录 / 验证码 / 设备列表 / 保存选中设备
  submitCredentials: (region, account, password) =>
    ipcRenderer.invoke('bambu:login', region, account, password),
  submitVerifyCode: (region, account, password, tfaKey, code) =>
    ipcRenderer.invoke('bambu:verify', region, account, password, tfaKey, code),
  listDevices: () => ipcRenderer.invoke('bambu:listDevices'),
  saveDevice: (serial, name, model) => ipcRenderer.invoke('bambu:saveDevice', serial, name, model),

  // LAN 测试 / 保存
  testLan: (host, accessCode, serial) =>
    ipcRenderer.invoke('bambu:testLan', host, accessCode, serial),
  saveLan: (host, accessCode, serial, name) =>
    ipcRenderer.invoke('bambu:saveLan', host, accessCode, serial, name),

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

  // 主进程推送的后台错误（如 token 过期）
  onError: (cb) => ipcRenderer.on('bambu:error', (_e, msg) => cb(msg)),

  // 统一打印机列表管理
  listPrinters: () => ipcRenderer.invoke('printer:list'),
  setActivePrinter: (serial) => ipcRenderer.invoke('printer:setActive', serial),
  addLanPrinter: (host, accessCode, serial, name) =>
    ipcRenderer.invoke('printer:addLan', host, accessCode, serial, name),
  removeLanPrinter: (serial) => ipcRenderer.invoke('printer:removeLan', serial),
  renamePrinter: (serial, name) => ipcRenderer.invoke('printer:rename', serial, name),
  refreshCloud: () => ipcRenderer.invoke('printer:refreshCloud'),
  onPrintersChanged: (cb) => ipcRenderer.on('printers:changed', () => cb()),
});
