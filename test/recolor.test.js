// recolorImageData：把视频帧里的「绿色系耗材/竹子」像素重着色为目标耗材色，
// 其余像素输出全透明（overlay 只画被改色的部分，叠在原视频上方）。
// 契约：
//   - 命中（绿色系）像素：色相/饱和取目标色，明度按像素相对参考耗材色的比例缩放（保留明暗）；
//   - 非绿色像素、全透明像素：输出 alpha=0（露出下层原视频）；
//   - 白/黑目标色同样成立（白→保留明暗的灰白，黑→深色）。
const test = require('node:test');
const assert = require('node:assert');
const { recolorImageData } = require('../src/renderer/recolor');

// 造一个 1xN 的 ImageData 形状对象（Node 无 ImageData 构造器）
function makeImage(pixels) {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b, a], i) => {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
  });
  return { data, width: pixels.length, height: 1 };
}
function px(img, i) {
  const d = img.data;
  return [d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]];
}

// 素材实测色：竹笋/耗材绿 rgb(128,174,59)，暗部绿 rgb(45,70,20)
const GREEN_BRIGHT = [128, 174, 59, 255];
const GREEN_DARK = [45, 70, 20, 255];

test('绿色像素改为目标红色，且亮绿输出比暗绿输出亮（明暗保留）', () => {
  const img = makeImage([GREEN_BRIGHT, GREEN_DARK]);
  const out = recolorImageData(img, '#f95959');
  const [r1, g1, b1, a1] = px(out, 0);
  const [r2, , , a2] = px(out, 1);
  assert.ok(a1 > 200, `亮绿应被完全覆盖，got alpha=${a1}`);
  assert.ok(a2 > 200, `暗绿应被完全覆盖，got alpha=${a2}`);
  assert.ok(r1 > g1 && r1 > b1, `输出应偏红，got rgb(${r1},${g1},${b1})`);
  assert.ok(r1 > r2, `亮绿输出应比暗绿亮：${r1} vs ${r2}`);
});

test('目标白色：绿色像素变为近灰白（r≈g≈b）且保留明暗', () => {
  const img = makeImage([GREEN_BRIGHT, GREEN_DARK]);
  const out = recolorImageData(img, '#ffffff');
  const [r1, g1, b1] = px(out, 0);
  const [r2] = px(out, 1);
  assert.ok(Math.abs(r1 - g1) <= 2 && Math.abs(g1 - b1) <= 2, `应为中性灰白，got rgb(${r1},${g1},${b1})`);
  assert.ok(r1 > 180, `亮绿→白应偏亮，got ${r1}`);
  assert.ok(r2 < r1, '暗部仍应比亮部暗');
});

test('目标黑色：绿色像素变为深色', () => {
  const img = makeImage([GREEN_BRIGHT]);
  const out = recolorImageData(img, '#000000');
  const [r, g, b, a] = px(out, 0);
  assert.ok(a > 200);
  assert.ok(r < 40 && g < 40 && b < 40, `应接近黑色，got rgb(${r},${g},${b})`);
});

test('非绿色像素输出全透明（白肚、黑耳、蓝汗滴都不动）', () => {
  const img = makeImage([
    [239, 239, 236, 255], // 白肚
    [20, 20, 20, 255],    // 黑耳
    [120, 180, 240, 255], // 蓝汗滴
  ]);
  const out = recolorImageData(img, '#f95959');
  for (let i = 0; i < 3; i++) {
    assert.equal(px(out, i)[3], 0, `第 ${i} 个非绿像素应透明`);
  }
});

test('源全透明像素输出 alpha=0', () => {
  const img = makeImage([[128, 174, 59, 0]]);
  const out = recolorImageData(img, '#f95959');
  assert.equal(px(out, 0)[3], 0);
});

test('不修改源数据（写入独立输出缓冲）', () => {
  const img = makeImage([GREEN_BRIGHT]);
  const before = Array.from(img.data);
  recolorImageData(img, '#f95959');
  assert.deepEqual(Array.from(img.data), before);
});
