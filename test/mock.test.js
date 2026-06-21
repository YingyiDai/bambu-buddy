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
