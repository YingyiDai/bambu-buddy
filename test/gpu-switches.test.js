// 源码防线：熊猫是透明窗口 + 带 alpha 的循环视频，硬件叠加层（DirectComposition overlay）
// 由系统直接合成、不携带窗口逐像素 alpha —— 一旦视频被提升上去，窗口上就会出现一块不透明的
// 黑。该开关必须一直在，且必须在 app ready 之前附加（之后再加是静默无效的，比不加更糟：
// 看着有防护、实际没有）。这两条都无法在单测里真跑 Electron 验证，故用源码断言钉住。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_SRC = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const SWITCH = 'disable-direct-composition-video-overlays';

test('禁用视频硬件叠加层的开关必须存在（透明窗口整窗/局部变黑的一整族根因）', () => {
  assert.ok(
    MAIN_SRC.includes(SWITCH),
    `main.js 必须 appendSwitch('${SWITCH}')。\n`
    + '删掉它等于放任 Chromium 把熊猫视频提升为叠加层：叠加平面不带窗口 alpha，\n'
    + '在部分显卡/驱动上表现为熊猫身上一块不透明黑，且只在那些机器上复现。',
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
