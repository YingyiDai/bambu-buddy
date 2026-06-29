// 窗口位置可见性校验单测：保存的位置落在已断开/变更的显示器上时，
// 必须夹回可见范围或回落 null，避免桌宠生成在不可见区域。
const test = require('node:test');
const assert = require('node:assert');
const { clampToVisible } = require('../src/core/window-position');

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
