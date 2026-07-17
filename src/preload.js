// 预加载脚本：通过 contextBridge 暴露受控 API 给渲染层（§5.1）。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  // 主进程推送的状态：{ stateKey, videoFile, labelKey, labelParams, lines }
  // lines：多打印机逐台标签行 [{ serial, name, stateKey, labelKey, labelParams }]（可为空）
  onState: (cb) => {
    ipcRenderer.on('pet:state', (_e, state) => cb(state));
  },
  // 主进程推送的 locale 字符串包：{ locale, strings }
  onLocale: (cb) => {
    ipcRenderer.on('pet:locale', (_e, locale, strings) => cb(locale, strings));
  },
  // 主进程推送的偏好变更：{ labelFontSize, showLabel, showLayer, showTime, showFinishTime, matchFilamentColor, hour12 }
  onPrefs: (cb) => {
    ipcRenderer.on('pet:prefs', (_e, prefs) => cb(prefs));
  },
  // 鼠标进入/离开熊猫实体像素 → 切换点击穿透
  setInteractive: (interactive) => {
    ipcRenderer.send('pet:setInteractive', !!interactive);
  },
  // 上报标签实际像素尺寸 {w,h} → 主进程按需加宽（长标签完整显示）/向下加高（多行标签）
  setLabelSize: (size) => ipcRenderer.send('pet:labelSize', size),
  // 手动拖拽：开始跟随光标 / 结束
  dragStart: () => ipcRenderer.send('pet:dragStart'),
  dragEnd: () => ipcRenderer.send('pet:dragEnd'),
  // 右键宠物 → 弹出上下文菜单
  showMenu: () => ipcRenderer.send('pet:contextmenu'),
});
