// recolorImageData：把视频帧里的「绿色系耗材/竹子」像素重着色为目标耗材色，
// 其余像素输出全透明（overlay 只画被改色的部分，叠在原视频上方）。
// 契约：
//   - 命中（绿色系）像素：色相/饱和取目标色，明度按像素相对参考耗材色的比例缩放（保留明暗）；
//   - 低于饱和阈值但仍带绿的抗锯齿边像素：压平多余绿分量（despill），不留绿圈；
//   - 非绿色（无绿溢色）像素、全透明像素：输出 alpha=0（露出下层原视频）；
//   - 白/黑目标色同样成立（白→保留明暗的灰白，黑→深色）。
const test = require('node:test');
const assert = require('node:assert');
const { recolorImageData, createRecolorOverlay } = require('../src/renderer/recolor');

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

// ── 绿边回归：耗材边缘的抗锯齿像素（绿与白肚/背景混色）饱和度低于命中阈值，
//    此前保持透明露出下层淡绿；改白色耗材时肉眼可见绿圈。 ──
test('低饱和残绿边像素：多余绿分量被压平（不再露绿圈）', () => {
  // 绿耗材与白色身体的抗锯齿混色：sat≈0.13 < SAT_MIN，但 g 明显高于 r/b
  const img = makeImage([[210, 235, 205, 255]]);
  const out = recolorImageData(img, '#ffffff');
  const [r, g, b, a] = px(out, 0);
  assert.ok(a > 200, `残绿边应被覆盖，got alpha=${a}`);
  assert.ok(g <= Math.max(r, b) + 1, `绿分量应压平到 max(r,b)，got rgb(${r},${g},${b})`);
});

test('软化带像素：不透明输出且不偏绿（不再靠半透明露下层绿）', () => {
  // sat≈0.25，落在 [SAT_MIN, SAT_MIN+SAT_SOFT) 软化带内
  const img = makeImage([[180, 230, 172, 255]]);
  const out = recolorImageData(img, '#ffffff');
  const [r, g, b, a] = px(out, 0);
  assert.equal(a, 255, `软化带像素应不透明输出，got alpha=${a}`);
  assert.ok(g <= Math.max(r, b) + 1, `输出不应偏绿，got rgb(${r},${g},${b})`);
});

test('目标为绿色系时不做去溢色（绿边即目标色边）', () => {
  const img = makeImage([[210, 235, 205, 255]]);
  const out = recolorImageData(img, '#3fa02a');
  assert.equal(px(out, 0)[3], 0, '绿色目标下残绿边应保持透明不动');
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

// ── 驱动层回归：逐帧必须先清空 canvas，否则动画移动后上一帧的绿色改色像素残留在
//    视频透明区，被下一帧的绿色过滤再次保留 → 熊猫绿色周围出现绿/黑重影（仅绿色目标可见，
//    因为非绿残留会被色相过滤擦除）。见真机复现。 ──
function makeMockCanvasVideo(w, h) {
  const buf = new Uint8ClampedArray(w * h * 4); // 模拟 canvas 像素缓冲
  const ctx = {
    // source-over：视频不透明处覆盖，透明处保留原缓冲（正是残留重影的来源）
    drawImage(video) {
      const f = video.frame;
      for (let i = 0; i < buf.length; i += 4) {
        const sa = f[i + 3] / 255;
        if (sa === 0) continue; // 透明源 → 目标不变（残留！）
        for (let k = 0; k < 3; k++) buf[i + k] = Math.round(f[i + k] * sa + buf[i + k] * (1 - sa));
        buf[i + 3] = Math.round(f[i + 3] + buf[i + 3] * (1 - sa));
      }
    },
    clearRect() { buf.fill(0); },
    getImageData() { return { data: new Uint8ClampedArray(buf), width: w, height: h }; },
    putImageData(img) { buf.set(img.data); },
  };
  const canvas = { width: w, height: h, clientWidth: 100, clientHeight: 100, getContext: () => ctx };
  let cb = null;
  const video = {
    videoWidth: w, videoHeight: h, frame: new Uint8ClampedArray(w * h * 4),
    play() {}, requestVideoFrameCallback(fn) { cb = fn; return 1; }, cancelVideoFrameCallback() { cb = null; },
  };
  return { canvas, video, buf, tickFrame: () => { const f = cb; cb = null; if (f) f(); } };
}

test('逐帧清空 canvas：动画移动后不残留上一帧绿色改色像素（黑/绿重影回归）', () => {
  const { canvas, video, buf, tickFrame } = makeMockCanvasVideo(2, 1);
  const ov = createRecolorOverlay(video, canvas);
  ov.setColor('#3fa02a'); // 非原始绿目标

  // 帧1：像素0=竹子绿（不透明），像素1=背景（透明）
  video.frame.set([128, 174, 59, 255, 0, 0, 0, 0]);
  tickFrame();
  assert.ok(buf[3] > 0, '帧1 竹子像素应被改色（不透明）');

  // 帧2：竹子移走 → 像素0 变成背景（视频透明）
  video.frame.set([0, 0, 0, 0, 0, 0, 0, 0]);
  tickFrame();
  assert.equal(buf[3], 0, '帧2 竹子移走后该处不应残留改色像素（否则即绿色重影）');
});
