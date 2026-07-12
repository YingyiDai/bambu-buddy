// 预加载脚本：通过 contextBridge 暴露受控 API 给渲染层（§5.1）。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  // 主进程推送的状态：{ stateKey, videoFile, labelKey, labelParams }
  onState: (cb) => {
    ipcRenderer.on('pet:state', (_e, state) => cb(state));
  },
  // 主进程推送的 locale 字符串包：{ locale, strings }
  onLocale: (cb) => {
    ipcRenderer.on('pet:locale', (_e, locale, strings) => cb(locale, strings));
  },
  // 主进程推送的偏好变更：{ labelFontSize, showLabel, showLayer, showTime, showFinishTime, matchFilamentColor }
  onPrefs: (cb) => {
    ipcRenderer.on('pet:prefs', (_e, prefs) => cb(prefs));
  },
  // 鼠标进入/离开熊猫实体像素 → 切换点击穿透
  setInteractive: (interactive) => {
    ipcRenderer.send('pet:setInteractive', !!interactive);
  },
  // 上报标签实际像素宽度 → 主进程按需加宽窗口，长标签完整显示
  setLabelWidth: (px) => ipcRenderer.send('pet:labelWidth', px),
  // 手动拖拽：开始跟随光标 / 结束
  dragStart: () => ipcRenderer.send('pet:dragStart'),
  dragEnd: () => ipcRenderer.send('pet:dragEnd'),
  // 右键宠物 → 弹出上下文菜单
  showMenu: () => ipcRenderer.send('pet:contextmenu'),
});
