// 中英文 locale 字符串。所有 UI 文案集中管理，避免硬编码。
// 格式：{ 'zh-CN': { key: '中文' }, 'en': { key: 'English' } }
// 带 {param} 占位符的字符串用 t() 做模板替换。

const STRINGS = {
  'zh-CN': {
    // ── 宠物状态标签 ──
    'label.offline': '未连接打印机',
    'label.idle': '空闲',
    'label.prepare': '准备中',
    'label.prepare.heatbed': '预热热床',
    'label.prepare.hotend': '加热喷头',
    'label.prepare.leveling': '自动调平',
    'label.prepare.scanning': '扫描床面',
    'label.prepare.firstLayer': '检查首层',
    'label.printing': '打印中 {p}%',
    'label.printing.layer': '打印中 {p}% · 第{layer}/{total}层',
    'label.changingFilament': '换料中',
    'label.paused': '已暂停',
    'label.paused.runout': '缺料，等待续料',
    'label.paused.clog': '喷头堵塞，待处理',
    'label.paused.firstLayerErr': '首层异常，待确认',
    'label.paused.tempAbnormal': '温度异常，待处理',
    'label.doorOpen': '舱门已打开',
    'label.finished': '打印完成',
    'label.failed': '打印失败',
    'label.failed.hms': '打印失败 · {code}',

    // ── 托盘菜单 ──
    'tray.status': '状态',
    'tray.printer': '打印机',
    'tray.account': '账号',
    'tray.nozzle': '喷嘴',
    'tray.bed': '热床',
    'tray.remaining': '剩余 {time}',
    'tray.remainingMin': '剩余 {n} 分钟',
    'tray.dataSourceMock': '数据源：Mock',
    'tray.switchPrinter': '切换打印机',
    'tray.mockSwitch': 'Mock · 切换状态',
    'tray.mockAuto': 'Mock · 自动轮播 (demo)',
    'tray.source': '数据源',
    'tray.sourceMock': 'Mock 模式',
    'tray.sourceCloud': 'Bambu Cloud 真机',
    'tray.sourceLan': 'Bambu LAN 本地',
    'tray.settings': 'Bambu 设置…',
    'tray.size': '大小',
    'tray.sizeSmall': '小',
    'tray.sizeMedium': '中',
    'tray.sizeLarge': '大',
    'tray.exit': '退出',
    'tray.starting': '启动中…',
    'tray.tooltip': 'Bambu 桌面宠物',

    // ── 设置窗 ──
    'settings.title': 'Bambu 设置',
    'settings.tabConnection': '连接',
    'settings.tabAppearance': '外观',
    'settings.tabAbout': '关于',
    // 连接 Tab（保持原样，复用旧文案）
    'settings.region': '区域',
    'settings.account': '账号（邮箱）',
    'settings.password': '密码',
    'settings.login': '登录',
    'settings.verifyHint': '已向你的邮箱发送验证码，请输入：',
    'settings.verifyCode': '验证码',
    'settings.submit': '提交',
    'settings.backLogin': '← 返回登录',
    'settings.deviceHint': '选择要连接的打印机：',
    'settings.noDevices': '未发现绑定的打印机，请先在 Bambu Studio / 手机 App 中绑定设备。',
    'settings.deviceOnline': '在线',
    'settings.deviceOffline': '离线',
    'settings.saveClose': '保存并连接',
    'settings.logout': '退出登录',
    'settings.close': '关闭',
    'settings.testConn': '测试连接',
    'settings.lanIp': '打印机 IP 地址',
    'settings.lanCode': '访问码（Access Code）',
    'settings.lanSerial': '序列号',
    'settings.ipPlaceholder': '192.168.1.x',
    'settings.codePlaceholder': '机身屏幕可查',
    // 外观 Tab
    'settings.petSize': '宠物大小',
    'settings.textSize': '文字大小',
    'settings.showLabel': '显示文字',
    'settings.language': '语言',
    'settings.langZh': '中文',
    'settings.langEn': 'English',
    // 关于 Tab
    'settings.aboutName': 'BambuPet',
    'settings.aboutDesc': 'Bambu 打印机桌面宠物 — 一只熊猫常驻桌面，根据打印机状态播放对应动画。',
    'settings.aboutAuthor': '作者',
  },

  'en': {
    // ── Pet status labels ──
    'label.offline': 'Printer Offline',
    'label.idle': 'Idle',
    'label.prepare': 'Preparing',
    'label.prepare.heatbed': 'Heating Bed',
    'label.prepare.hotend': 'Heating Nozzle',
    'label.prepare.leveling': 'Auto Bed Leveling',
    'label.prepare.scanning': 'Scanning Bed',
    'label.prepare.firstLayer': 'Inspecting First Layer',
    'label.printing': 'Printing {p}%',
    'label.printing.layer': 'Printing {p}% · Layer {layer}/{total}',
    'label.changingFilament': 'Changing Filament',
    'label.paused': 'Paused',
    'label.paused.runout': 'Filament Runout',
    'label.paused.clog': 'Nozzle Clogged',
    'label.paused.firstLayerErr': 'First Layer Error',
    'label.paused.tempAbnormal': 'Temperature Abnormal',
    'label.doorOpen': 'Door Open',
    'label.finished': 'Print Finished',
    'label.failed': 'Print Failed',
    'label.failed.hms': 'Print Failed · {code}',

    // ── Tray menu ──
    'tray.status': 'Status',
    'tray.printer': 'Printer',
    'tray.account': 'Account',
    'tray.nozzle': 'Nozzle',
    'tray.bed': 'Bed',
    'tray.remaining': '{time} left',
    'tray.remainingMin': '{n} min left',
    'tray.dataSourceMock': 'Source: Mock',
    'tray.switchPrinter': 'Switch Printer',
    'tray.mockSwitch': 'Mock · Switch State',
    'tray.mockAuto': 'Mock · Auto Cycle (demo)',
    'tray.source': 'Data Source',
    'tray.sourceMock': 'Mock Mode',
    'tray.sourceCloud': 'Bambu Cloud',
    'tray.sourceLan': 'Bambu LAN',
    'tray.settings': 'Bambu Settings…',
    'tray.size': 'Size',
    'tray.sizeSmall': 'Small',
    'tray.sizeMedium': 'Medium',
    'tray.sizeLarge': 'Large',
    'tray.exit': 'Exit',
    'tray.starting': 'Starting…',
    'tray.tooltip': 'Bambu Desktop Pet',

    // ── Settings window ──
    'settings.title': 'Bambu Settings',
    'settings.tabConnection': 'Connection',
    'settings.tabAppearance': 'Appearance',
    'settings.tabAbout': 'About',
    'settings.region': 'Region',
    'settings.account': 'Account (Email)',
    'settings.password': 'Password',
    'settings.login': 'Login',
    'settings.verifyHint': 'A verification code has been sent to your email:',
    'settings.verifyCode': 'Verification Code',
    'settings.submit': 'Submit',
    'settings.backLogin': '← Back to Login',
    'settings.deviceHint': 'Select a printer:',
    'settings.noDevices': 'No bound printers found. Please bind a device in Bambu Studio or the mobile app first.',
    'settings.deviceOnline': 'Online',
    'settings.deviceOffline': 'Offline',
    'settings.saveClose': 'Save & Connect',
    'settings.logout': 'Logout',
    'settings.close': 'Close',
    'settings.testConn': 'Test Connection',
    'settings.lanIp': 'Printer IP Address',
    'settings.lanCode': 'Access Code',
    'settings.lanSerial': 'Serial Number',
    'settings.ipPlaceholder': '192.168.1.x',
    'settings.codePlaceholder': 'Check printer screen',
    // Appearance Tab
    'settings.petSize': 'Pet Size',
    'settings.textSize': 'Text Size',
    'settings.showLabel': 'Show Label',
    'settings.language': 'Language',
    'settings.langZh': '中文',
    'settings.langEn': 'English',
    // About Tab
    'settings.aboutName': 'BambuPet',
    'settings.aboutDesc': 'A desktop pet panda that lives on your screen and reacts to your Bambu Lab 3D printer status.',
    'settings.aboutAuthor': 'Author',
  },
};

/**
 * 模板替换：t('zh-CN', 'label.printing', { p: 50 }) → '打印中 50%'
 * 缺失的 key 返回 key 本身，方便调试。
 */
function t(locale, key, params = {}) {
  const map = STRINGS[locale] || STRINGS['zh-CN'];
  let template = map[key];
  if (template == null) return key; // fallback: show key name
  for (const [k, v] of Object.entries(params)) {
    template = template.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return template;
}

module.exports = { STRINGS, t };
