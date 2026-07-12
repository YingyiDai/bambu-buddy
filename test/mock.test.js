// MockDataSource.setPrintingProgress 静态发帧 + getCurrent。
const test = require('node:test');
const assert = require('node:assert');
const { MockDataSource } = require('../src/core/mock');

test('setPrintingProgress(50) 发一帧 RUNNING/50%，不再自动推进', async () => {
  const ds = new MockDataSource();
  const frames = [];
  ds.onState((r) => frames.push(r));
  ds.setPrintingProgress(50);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].gcode_state, 'RUNNING');
  assert.equal(frames[0].mc_percent, 50);
  // 等 1.8s 确认没有计时器继续推进
  await new Promise((res) => setTimeout(res, 1800));
  assert.equal(frames.length, 1);
  ds.stop();
});

test('setPrintingProgress 夹取越界值', () => {
  const ds = new MockDataSource();
  const frames = [];
  ds.onState((r) => frames.push(r));
  ds.setPrintingProgress(150);
  ds.setPrintingProgress(-10);
  assert.equal(frames[0].mc_percent, 100);
  assert.equal(frames[1].mc_percent, 0);
  ds.stop();
});

test('getCurrent 反映最近场景', () => {
  const ds = new MockDataSource();
  ds.onState(() => {});
  ds.setScenario('finished');
  assert.equal(ds.getCurrent(), 'finished');
  ds.setPrintingProgress(20);
  assert.equal(ds.getCurrent(), 'printing');
  ds.stop();
});

// ── Playground 耗材颜色注入：默认不注入（原始绿），设色后以真机同构形状（外挂料盘）注入 ──
test('setFilamentColor：默认 null 不注入 ams/vt_tray', () => {
  const ds = new MockDataSource();
  const frames = [];
  ds.onState((r) => frames.push(r));
  ds.setPrintingProgress(30);
  assert.equal(frames[0].ams, undefined);
  assert.equal(frames[0].vt_tray, undefined);
  ds.stop();
});

test('setFilamentColor：设色后报文经 resolveState 能解析出 filamentColor，且跨场景保持', () => {
  const { resolveState } = require('../src/core/state-machine');
  const ds = new MockDataSource();
  const frames = [];
  ds.onState((r) => frames.push(r));
  ds.setFilamentColor('#f95959');
  ds.setPrintingProgress(30);
  assert.equal(resolveState(frames.at(-1)).filamentColor, '#f95959');
  ds.setScenario('paused'); // 切场景颜色保持
  assert.equal(resolveState(frames.at(-1)).filamentColor, '#f95959');
  ds.stop();
});

test('setFilamentColor(null)：恢复原始绿（不再注入）', () => {
  const { resolveState } = require('../src/core/state-machine');
  const ds = new MockDataSource();
  const frames = [];
  ds.onState((r) => frames.push(r));
  ds.setFilamentColor('#f95959');
  ds.setFilamentColor(null);
  ds.setPrintingProgress(30);
  assert.equal(resolveState(frames.at(-1)).filamentColor, null);
  ds.stop();
});

test('setFilamentColor：静态场景下立即重发当前帧（不等下一次报文）', () => {
  const { resolveState } = require('../src/core/state-machine');
  const ds = new MockDataSource();
  const frames = [];
  ds.onState((r) => frames.push(r));
  ds.setPrintingProgress(30); // 静态一帧，无定时器
  const n = frames.length;
  ds.setFilamentColor('#00ae42');
  assert.equal(frames.length, n + 1, '应立即补发一帧');
  assert.equal(resolveState(frames.at(-1)).filamentColor, '#00ae42');
  assert.equal(frames.at(-1).mc_percent, 30, '重发帧应保持当前进度');
  ds.stop();
});
