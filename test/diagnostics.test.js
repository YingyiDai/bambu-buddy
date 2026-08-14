// 诊断报告格式化单测。这段文本是排查「熊猫显示异常」时唯一的现场证据来源，
// 所以两件事必须钉死：① 采集缺项时绝不抛错（用户点了按钮就得有东西可粘贴）；
// ② 决定合成路径的关键项（GPU 合成、视频解码、缩放、HDR/色深、熊猫在哪块屏）必须出现在文本里。
const test = require('node:test');
const assert = require('node:assert');
const { formatDiagnostics, formatGpuFeatures, formatGpu, isWideColor } = require('../src/core/diagnostics');

test('缺项不抛错：空对象也能产出报告，缺的项标注「(未取到)」', () => {
  const out = formatDiagnostics({});
  assert.match(out, /Bambu Buddy 诊断信息/);
  assert.match(out, /\(未取到\)/);
});

test('缺项不抛错：null / undefined 入参同样安全', () => {
  assert.doesNotThrow(() => formatDiagnostics(null));
  assert.doesNotThrow(() => formatDiagnostics(undefined));
});

test('GPU 特性：影响透明窗口合成的项排在最前，便于一眼扫到', () => {
  const line = formatGpuFeatures({
    webgl: 'enabled', video_decode: 'enabled', gpu_compositing: 'disabled_software', vulkan: 'disabled_off',
  });
  assert.ok(line.indexOf('gpu_compositing=') < line.indexOf('webgl='), 'gpu_compositing 应在 webgl 之前');
  assert.ok(line.indexOf('video_decode=') < line.indexOf('webgl='), 'video_decode 应在 webgl 之前');
});

test('GPU 特性：非对象（未采集到）降级为「(未取到)」而不是崩', () => {
  assert.strictEqual(formatGpuFeatures(undefined), '(未取到)');
  assert.strictEqual(formatGpuFeatures('boom'), '(未取到)');
});

test('显卡：取 active 那块，带出型号、厂商/设备 id 与驱动版本', () => {
  const out = formatGpu({
    gpuDevice: [
      { vendorId: 0x8086, deviceId: 0x9bc4, active: false, deviceString: 'Intel UHD' },
      { vendorId: 0x10de, deviceId: 0x2503, active: true, deviceString: 'RTX 3060', driverVersion: '32.0.15.6636' },
    ],
    auxAttributes: {},
  });
  assert.match(out, /RTX 3060/);
  assert.match(out, /0x10de:0x2503/);
  assert.match(out, /32\.0\.15\.6636/);
});

test('显卡：混合显卡（笔记本核显+独显）显式标出块数——它本身就是发黑的高嫌疑项', () => {
  const out = formatGpu({
    gpuDevice: [{ vendorId: 1, deviceId: 2, active: true }, { vendorId: 3, deviceId: 4 }],
  });
  assert.match(out, /共 2 块显卡/);
});

test('显卡：未采集到时降级，不抛错', () => {
  assert.strictEqual(formatGpu(null), '(未取到)');
  assert.doesNotThrow(() => formatGpu({}));
});

test('HDR/广色域判定：高位深或 BT2020/PQ/scRGB 色彩空间都算命中', () => {
  assert.ok(isWideColor({ depthPerComponent: 10 }));
  assert.ok(isWideColor({ depthPerComponent: 8, colorSpace: '{primaries:BT2020, transfer:PQ}' }));
  assert.ok(isWideColor({ colorSpace: 'scRGB linear' }));
  assert.ok(!isWideColor({ depthPerComponent: 8, colorSpace: '{primaries:BT709}' }));
  assert.ok(!isWideColor(null));
});

test('报告含定位所需的关键现场：缩放、色深、熊猫在哪块屏、窗口几何、当前动画', () => {
  const out = formatDiagnostics({
    now: '2026-08-14 10:00',
    appVersion: '0.4.4',
    electron: '33.4.11',
    chrome: '130.0.0.0',
    platform: 'win32',
    release: '10.0.26100',
    arch: 'x64',
    gpuFeatureStatus: { gpu_compositing: 'enabled' },
    gpuInfo: { gpuDevice: [{ vendorId: 0x10de, deviceId: 0x2503, active: true, deviceString: 'RTX 3060' }] },
    displays: [
      { id: 1, bounds: { width: 2560, height: 1440 }, scaleFactor: 1.5, colorDepth: 24, depthPerComponent: 8 },
      { id: 2, bounds: { width: 1920, height: 1080 }, scaleFactor: 1, colorDepth: 30, depthPerComponent: 10 },
    ],
    petDisplayId: 2,
    window: { x: 100, y: 200, width: 380, height: 380, visible: true },
    sizePx: 380,
    state: 'printing',
    anim: 'printing_50.webm',
    filamentColor: '#1a1a1a',
    printerCount: 1,
  });
  assert.match(out, /v0\.4\.4/);
  assert.match(out, /win32 10\.0\.26100/);
  assert.match(out, /@1\.5x/, '缩放要在');
  assert.match(out, /色深 30\/10/, '色深/位深要在（HDR 线索）');
  assert.match(out, /广色域\/HDR\?/, '高位深屏要打上 HDR 标记');
  assert.match(out, /← 熊猫在这块/, '要标出熊猫落在哪块屏');
  assert.match(out, /100,200 380x380/, '窗口几何要在');
  assert.match(out, /printing_50\.webm/, '当前动画要在');
  assert.match(out, /#1a1a1a/, '耗材改色要在');
});

test('熊猫所在屏标记只打在匹配的那块上（id 为 undefined 时不误标）', () => {
  const out = formatDiagnostics({
    displays: [{ bounds: {}, scaleFactor: 1 }, { bounds: {}, scaleFactor: 1 }],
  });
  assert.strictEqual((out.match(/← 熊猫在这块/g) || []).length, 0, 'id 缺失时不应误标');
});
