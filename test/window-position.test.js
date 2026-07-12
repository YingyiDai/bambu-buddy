// 窗口位置可见性校验单测：保存的位置落在已断开/变更的显示器上时，
// 必须夹回可见范围或回落 null，避免桌宠生成在不可见区域。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { clampToVisible, petWindowBounds } = require('../src/core/window-position');

const PRIMARY = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
const SECONDARY = { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } };

test('完全可见的位置原样保留', () => {
  assert.deepStrictEqual(clampToVisible({ x: 100, y: 100 }, [PRIMARY], 220), { x: 100, y: 100 });
});

test('右下溢出的位置被夹回完全可见', () => {
  // 窗口 220px，落在 (1900,1000) 会溢出右/下边 → 夹到 (1700,860)
  assert.deepStrictEqual(clampToVisible({ x: 1900, y: 1000 }, [PRIMARY], 220), { x: 1700, y: 860 });
});

test('落在已断开显示器（不与任何 workArea 相交）→ 返回 null', () => {
  // 曾在副屏 x≈3000，现仅剩主屏 0..1920 → 整窗无交集
  assert.strictEqual(clampToVisible({ x: 3000, y: 100 }, [PRIMARY], 220), null);
});

test('非法 saved（null / NaN）→ 返回 null', () => {
  assert.strictEqual(clampToVisible(null, [PRIMARY], 220), null);
  assert.strictEqual(clampToVisible({ x: NaN, y: 10 }, [PRIMARY], 220), null);
  assert.strictEqual(clampToVisible(undefined, [PRIMARY], 220), null);
});

test('空显示器列表 → 返回 null', () => {
  assert.strictEqual(clampToVisible({ x: 10, y: 10 }, [], 220), null);
});

test('多显示器：夹到重叠最多的那个显示器，不被拉回主屏', () => {
  // 主要落在副屏但右溢出 → 夹在副屏内 (3620,500)，而不是移到主屏
  assert.deepStrictEqual(
    clampToVisible({ x: 3800, y: 500 }, [PRIMARY, SECONDARY], 220),
    { x: 3620, y: 500 },
  );
});

// ── petWindowBounds：据熊猫中心算窗口 bounds，幂等、任何场景零累积 ──

test('据熊猫中心算窗口 bounds：熊猫居中，高恒为 sizePx', () => {
  // 中心 (210,210)，sizePx=220，宽 300 →
  //   x = round(210 - 300/2) = 60；y = round(210 - 220/2) = 100
  assert.deepStrictEqual(
    petWindowBounds({ x: 210, y: 210 }, 300, 220),
    { x: 60, y: 100, width: 300, height: 220 },
  );
});

test('回归：中心固定，反复变宽不漂移（拖进度滑杆右移/上移/变大）', () => {
  // 复现缺陷场景：拖进度滑杆时标签像素宽反复变化，applyWinWidth 高频触发。
  // 中心是权威真源、恒定，故无论 targetWidth 怎么变，熊猫中心与高度都不能漂。
  const center = { x: 1110, y: 610 };
  const sizePx = 220;
  for (const tw of [220, 313, 320, 313, 327, 341, 313, 220, 334, 313]) {
    const b = petWindowBounds(center, tw, sizePx);
    assert.strictEqual(b.height, sizePx, 'height 恒为 sizePx，不变大');
    assert.ok(Math.abs((b.x + b.width / 2) - center.x) <= 0.5, 'x 居中，不右移');
    assert.ok(Math.abs((b.y + b.height / 2) - center.y) <= 0.5, 'y 居中，不上移');
  }
});

test('回归：中心固定，反复改尺寸熊猫不走位（拖尺寸滑杆曾 ±120px 走位）', () => {
  // 第 4 个实例：拖尺寸滑杆连续 input。只要中心是稳定真源、改尺寸不重算它，
  // 无论尺寸来回怎么变，熊猫始终居中于同一点，仅亚像素取整、绝不累积。
  const center = { x: 1110, y: 610 };
  for (let pass = 0; pass < 6; pass++) {
    for (let px = 220; px <= 260; px++) {
      const b = petWindowBounds(center, Math.max(px, 170), px);
      assert.strictEqual(b.height, px);
      assert.ok(Math.abs((b.x + b.width / 2) - center.x) <= 0.5, 'x 居中');
      assert.ok(Math.abs((b.y + b.height / 2) - center.y) <= 0.5, 'y 居中');
    }
  }
});

test('幂等：同一 center+width+sizePx 反复调用得完全相同结果', () => {
  const center = { x: 1110, y: 610 };
  assert.deepStrictEqual(
    petWindowBounds(center, 313, 220),
    petWindowBounds(center, 313, 220),
  );
});

// ── 源码防线：结构性杜绝「熊猫越变越大 / 右移 / 上移 / 走位」这类累积缺陷复发 ──
// 该类缺陷四度出现，根因都是「从 win.getBounds() 读回尺寸/位置再写回 setBounds，
// 分数 DPI 的 DIP↔像素往返 + 居中 Math.round 逐帧累积」。防线：把 bounds 写入收敛到
// 唯一 choke point（applyWinWidth，据权威 petCenter 计算），并用下列源码断言拦住回潮。
const MAIN_SRC = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

test('源码防线：win.setBounds 仅限 2 个受控点（applyWinWidth + dragTimer）', () => {
  const n = (MAIN_SRC.match(/win\.setBounds\(/g) || []).length;
  assert.strictEqual(
    n, 2,
    `win.setBounds 调用数应为 2（applyWinWidth 唯一常规入口 + dragTimer 跟随光标），实为 ${n}。\n`
    + '新增窗口 bounds 变更请改走 applyWinWidth（更新 petCenter 后调用），勿直接 setBounds——\n'
    + '直接写会绕过「据权威锚点计算、不回写 getBounds」的不变量，导致熊猫走位/变大缺陷复发。',
  );
});

test('源码防线：禁止把 getBounds 读回的宽/高再写回（历史「越变越大」根因）', () => {
  assert.ok(!/height:\s*b\.height/.test(MAIN_SRC), '不得出现 height: b.height（回写读回高度会逐帧变大）');
  assert.ok(!/width:\s*b\.width/.test(MAIN_SRC), '不得出现 width: b.width（回写读回宽度会累积）');
});

test('源码防线：不得再有 win.setPosition（历史累积根因，已全部改用受控 setBounds）', () => {
  assert.ok(!/win\.setPosition\(/.test(MAIN_SRC), 'win.setPosition 会累积 DIP 取整误差，禁止使用');
});
