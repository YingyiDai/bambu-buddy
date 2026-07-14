// fullscreen-watch 纯函数部分的单测：多显示器下「只有熊猫所在显示器有全屏才隐藏」的判定。
// koffi/user32 的原生调用无法在 CI（Linux/macOS）上跑，这里只测采集快照后的纯判定逻辑
// decideHide 及其辅助函数——显示器比对的对错全部由它决定，原生层只是取数。
const test = require('node:test');
const assert = require('node:assert');

const { _internals } = require('../src/core/fullscreen-watch');
const { rectCoversMonitor, decodeHwnd, decideHide, eqPtr, anyWindowCoversDisplay } = _internals;

// 两块并排的 1920x1080 显示器：A 在左，B 在右
const MON_A_RECT = { left: 0, top: 0, right: 1920, bottom: 1080 };
const MON_B_RECT = { left: 1920, top: 0, right: 3840, bottom: 1080 };
const HMON_A = 0x10001;
const HMON_B = 0x10002;
const SHELL = 0x501;
const DESKTOP = 0x502;
const GAME = 0x777;

// 基准快照：A 屏上有个盖满整屏的前台窗口（无边框全屏游戏）
function fullscreenOnA(overrides) {
  return Object.assign({
    fg: GAME, shell: SHELL, desktop: DESKTOP, cls: 'UnityWndClass',
    winRect: { ...MON_A_RECT }, fgMon: HMON_A, monRect: MON_A_RECT, petMon: HMON_A,
  }, overrides);
}

test('A 屏全屏 + 熊猫在 A 屏 → 隐藏', () => {
  assert.equal(decideHide(fullscreenOnA()), true);
});

test('A 屏全屏 + 熊猫在 B 屏 → 不隐藏（多显示器修复的核心场景）', () => {
  assert.equal(decideHide(fullscreenOnA({ petMon: HMON_B })), false);
});

test('独占全屏矩形略大于显示器（负边框）同样判全屏', () => {
  const snap = fullscreenOnA({ winRect: { left: -8, top: -8, right: 1928, bottom: 1088 } });
  assert.equal(decideHide(snap), true);
});

test('最大化窗口未盖住任务栏区域（缺口远超容差）→ 不判全屏', () => {
  const snap = fullscreenOnA({ winRect: { left: 0, top: 0, right: 1920, bottom: 1032 } });
  assert.equal(decideHide(snap), false);
});

test('演示型全屏比显示器矩形略小几像素（缩放取整/隐形边框）→ 仍判全屏', () => {
  // WPS 放映、浏览器 F11 全屏等：每边内缩几像素，严格盖满会漏，容差内应判全屏
  const snap = fullscreenOnA({ winRect: { left: 2, top: 2, right: 1918, bottom: 1074 } });
  assert.equal(decideHide(snap), true);
});

test('前台是桌面壳（WorkerW/Progman/shell 句柄）盖满整屏 → 不判全屏', () => {
  assert.equal(decideHide(fullscreenOnA({ cls: 'WorkerW' })), false);
  assert.equal(decideHide(fullscreenOnA({ cls: 'Progman' })), false);
  assert.equal(decideHide(fullscreenOnA({ fg: SHELL })), false);
  assert.equal(decideHide(fullscreenOnA({ fg: DESKTOP })), false);
});

test('无前台窗口 / 取矩形失败 → 不隐藏（安全降级）', () => {
  assert.equal(decideHide(fullscreenOnA({ fg: 0 })), false);
  assert.equal(decideHide(fullscreenOnA({ fg: null })), false);
  assert.equal(decideHide(fullscreenOnA({ winRect: null })), false);
  assert.equal(decideHide(fullscreenOnA({ monRect: null })), false);
});

test('拿不到熊猫所在显示器 → 保守沿用旧全局行为（隐藏）', () => {
  assert.equal(decideHide(fullscreenOnA({ petMon: null })), true);
});

test('句柄 number 与 BigInt 混用可正确比对（koffi intptr_t 两种返回形态）', () => {
  assert.equal(decideHide(fullscreenOnA({ fgMon: BigInt(HMON_A), petMon: HMON_A })), true);
  assert.equal(decideHide(fullscreenOnA({ fgMon: BigInt(HMON_A), petMon: BigInt(HMON_B) })), false);
  assert.equal(eqPtr(5, 5n), true);
  assert.equal(eqPtr(null, 5), false);
});

test('rectCoversMonitor：恰好等于/略大于显示器算覆盖，小幅内缩（容差内）也算，大缺口不算', () => {
  const t = Math.min(16, Math.round(Math.min(1920, 1080) * 0.015)); // = 16
  assert.equal(rectCoversMonitor(MON_A_RECT, MON_A_RECT), true);
  // 容差边界内的内缩（演示型全屏的取整/隐形边框）→ 算覆盖
  assert.equal(rectCoversMonitor({ left: t, top: t, right: 1920 - t, bottom: 1080 - t }, MON_A_RECT), true);
  assert.equal(rectCoversMonitor({ left: 1, top: 0, right: 1920, bottom: 1080 }, MON_A_RECT), true);
  assert.equal(rectCoversMonitor({ left: 0, top: 0, right: 1919, bottom: 1080 }, MON_A_RECT), true);
  // 超出容差（任一边缺口 > tol）→ 不算覆盖
  assert.equal(rectCoversMonitor({ left: t + 1, top: 0, right: 1920, bottom: 1080 }, MON_A_RECT), false);
  assert.equal(rectCoversMonitor({ left: 0, top: 0, right: 1919 - t, bottom: 1080 }, MON_A_RECT), false);
});

// ── macOS 侧（CGWindowList 枚举 → 纯判定）──
// 枚举结果为 [{pid, rect}]。判定「有没有非自身窗口盖住熊猫所在屏」，不看图层：菜单栏(24)/
// Control Center(25) 等系统窗虽在列，但细条状盖不住整屏；演示型全屏可能在高图层，照样能抓。
const OWN_PID = 4242;
const R = (l, t, r, b) => ({ left: l, top: t, right: r, bottom: b });
const MENUBAR = { pid: 426, rect: R(0, 0, 1920, 33) };   // 全宽但仅 33px 高
const PANDA = { pid: OWN_PID, rect: R(100, 100, 355, 355) }; // 自身，须排除

test('mac：某 app 全屏盖满熊猫所在屏 → 隐藏（哪怕菜单栏/熊猫也在列）', () => {
  const wins = [PANDA, MENUBAR, { pid: 900, rect: { ...MON_A_RECT } }];
  assert.equal(anyWindowCoversDisplay(wins, OWN_PID, MON_A_RECT), true);
});

test('mac：全屏在 A 屏、熊猫在 B 屏 → 不隐藏（多显示器隔离）', () => {
  const wins = [{ pid: 900, rect: { ...MON_A_RECT } }];
  assert.equal(anyWindowCoversDisplay(wins, OWN_PID, MON_B_RECT), false);
});

test('mac：桌面态（只有菜单栏/熊猫，无覆盖窗口）→ 不隐藏', () => {
  assert.equal(anyWindowCoversDisplay([PANDA, MENUBAR], OWN_PID, MON_A_RECT), false);
});

test('mac：最大化窗口让出菜单栏(top=33) → 不算全屏 → 不隐藏（真机 Arc 实测形态）', () => {
  const maximized = { pid: 713, rect: R(0, 33, 1920, 1080) };
  assert.equal(anyWindowCoversDisplay([maximized], OWN_PID, MON_A_RECT), false);
});

test('mac：自身进程即便有盖满屏的窗口也须排除（不自我误判）', () => {
  const wins = [{ pid: OWN_PID, rect: { ...MON_A_RECT } }];
  assert.equal(anyWindowCoversDisplay(wins, OWN_PID, MON_A_RECT), false);
});

test('mac：取不到熊猫所在屏矩形 → 不隐藏（安全降级）', () => {
  assert.equal(anyWindowCoversDisplay([{ pid: 900, rect: { ...MON_A_RECT } }], OWN_PID, null), false);
});

test('decodeHwnd：8 字节（x64）与 4 字节（ia32）句柄 Buffer 均可解码', () => {
  const b8 = Buffer.alloc(8);
  b8.writeBigUInt64LE(0x1234_5678_9abcn, 0);
  assert.equal(decodeHwnd(b8), 0x1234_5678_9abcn);
  const b4 = Buffer.alloc(4);
  b4.writeUInt32LE(0xabcd, 0);
  assert.equal(decodeHwnd(b4), 0xabcdn);
  assert.equal(decodeHwnd(null), null);
  assert.equal(decodeHwnd(Buffer.alloc(2)), null);
});
