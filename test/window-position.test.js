// 窗口位置可见性校验单测：保存的位置落在已断开/变更的显示器上时，
// 必须夹回可见范围或回落 null，避免桌宠生成在不可见区域。
const test = require('node:test');
const assert = require('node:assert');
const { clampToVisible, horizontalResizeBounds } = require('../src/core/window-position');

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

// ── horizontalResizeBounds：只横向变化、高度恒为权威 sizePx ──

test('回归：高度恒为 sizePx，绝不继承已漂移的当前高度（拖进度滑杆熊猫越变越大）', () => {
  // 模拟分数 DPI 下 setBounds 取整误差：当前 bounds 的 height 已从 220 漂到 223。
  // 若回写 b.height，误差会逐帧累积；必须写回权威 sizePx=220。
  const drifted = { x: 100, y: 100, width: 220, height: 223 };
  const next = horizontalResizeBounds(drifted, 300, 220);
  assert.strictEqual(next.height, 220, 'height 必须回到 sizePx，而非漂移后的 223');
});

test('横向加宽保持中心不动', () => {
  // 中心 = 100 + 220/2 = 210；宽变 300 → x = 210 - 150 = 60
  assert.deepStrictEqual(
    horizontalResizeBounds({ x: 100, y: 100, width: 220, height: 220 }, 300, 220),
    { x: 60, y: 100, width: 300, height: 220 },
  );
});

test('宽度与 x 都无需变化 → 返回 null（跳过 setBounds）', () => {
  // 当前已是目标宽度且中心对齐 → x 不变 → null
  assert.strictEqual(
    horizontalResizeBounds({ x: 60, y: 100, width: 300, height: 220 }, 300, 220),
    null,
  );
});
