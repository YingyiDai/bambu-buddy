// 源码防线：透明窗口「变黑」的一整族缺陷。
//
// 熊猫是透明分层窗口 + 带 alpha 的循环视频，它的合成表面由 GPU 进程持有。这一族缺陷的共同
// 形态是：某个操作让合成表面被丢弃重建，而重建后的首帧早于渲染层交出带 alpha 的新帧 ——
// 整窗（或视频那块）就以不透明黑呈现，并**一直保持到下一次重绘**。它由用户那台机器的驱动
// 与合成路径决定，作者机上基本复现不出来，所以只能靠源码断言把防线钉死，不能靠回归测试。
//
// 这些断言都无法在单测里真跑 Electron 验证，故一律走源码文本。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_SRC = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const SWITCH = 'disable-direct-composition-video-overlays';

test('禁用视频硬件叠加层的开关必须存在（叠加平面不带窗口 alpha → 熊猫身上一块黑）', () => {
  assert.ok(
    MAIN_SRC.includes(SWITCH),
    `main.js 必须 appendSwitch('${SWITCH}')。\n`
    + '删掉它等于放任 Chromium 把熊猫视频提升为叠加层：叠加平面由系统直接合成、不携带窗口\n'
    + '逐像素 alpha，在部分显卡/驱动上表现为熊猫身上一块不透明黑，且只在那些机器上复现。',
  );
});

test('开关必须早于 app.whenReady —— ready 之后 appendSwitch 静默无效', () => {
  const at = MAIN_SRC.indexOf(SWITCH);
  const ready = MAIN_SRC.indexOf('app.whenReady(');
  assert.ok(at >= 0 && ready >= 0, '开关与 app.whenReady 都应存在于 main.js');
  assert.ok(
    at < ready,
    'appendSwitch 必须写在 app.whenReady 之前。命令行开关只在 GPU 进程启动前读取，\n'
    + 'ready 之后再附加不会报错、也不会生效——防护形同虚设且难以察觉。',
  );
});

test('窗口 resize 之后必须补一次重绘（Electron 文档：透明窗口本就不该 resize）', () => {
  // applyWinWidth 是 bounds 的唯一常规写入口；改熊猫尺寸、标签行数变化都会经它 resize。
  const fn = MAIN_SRC.slice(MAIN_SRC.indexOf('function applyWinWidth'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.ok(body.includes('win.setBounds('), '取到的应是 applyWinWidth 函数体');
  assert.ok(
    body.includes('forceRepaint()'),
    'applyWinWidth 里 setBounds 之后必须调用 forceRepaint()。\n'
    + 'resize 会让透明窗口的合成表面重建，重建后若没有新帧顶上就是一整块黑，且会一直黑到\n'
    + '下一次重绘为止（用户侧表现为「重启才好」）。',
  );
});

test('重新显示与显示环境变化都必须触发重绘（全屏退出、插拔显示器、改缩放/HDR）', () => {
  assert.ok(
    /win\.on\(\s*['"]show['"]\s*,\s*forceRepaint\s*\)/.test(MAIN_SRC),
    "必须挂 win.on('show', forceRepaint)：fullscreen-watch 会在全屏应用来去时自动 hide→show，\n"
    + '用户什么都不用做就会走到这条路径。挂事件而不是逐个 win.show() 调用点，才不会漏。',
  );
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) {
    assert.ok(
      MAIN_SRC.includes(`screen.on('${ev}', forceRepaint)`),
      `必须监听 screen 的 ${ev} 并重绘：插拔显示器、改分辨率/缩放/HDR 都会重建合成表面。`,
    );
  }
});

test('改尺寸走节流入口，避免滑杆连发把透明窗口 resize 上百次', () => {
  const fn = MAIN_SRC.slice(MAIN_SRC.indexOf('function setPetSizePx'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.ok(
    body.includes('scheduleApplyWinWidth()') && !body.includes('  applyWinWidth();'),
    'setPetSizePx 必须走 scheduleApplyWinWidth（首沿+尾沿节流）。\n'
    + '设置页尺寸滑杆是 input 事件驱动，一次拖动连发上百次；逐次 resize 透明窗口既浪费，\n'
    + '也把「重建后回不到透明」的概率放大两个数量级。',
  );
});
