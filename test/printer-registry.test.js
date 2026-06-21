// test/printer-registry.test.js
const test = require('node:test');
const assert = require('node:assert');
const { mergePrinters, pickTransport } = require('../src/core/printer-registry');

test('仅云打印机 → source=cloud', () => {
  const r = mergePrinters([{ serial: 'A', name: 'a', model: 'X1', online: true, printStatus: 'IDLE' }], []);
  assert.equal(r.length, 1);
  assert.equal(r[0].source, 'cloud');
  assert.equal(r[0].hasCloud, true);
  assert.equal(r[0].hasLan, false);
  assert.equal(r[0].online, true);
});

test('仅 LAN 打印机 → source=lan, 带 host', () => {
  const r = mergePrinters([], [{ serial: 'B', name: 'b', model: '', host: '192.168.1.9', accessCode: 'c' }]);
  assert.equal(r[0].source, 'lan');
  assert.equal(r[0].hasLan, true);
  assert.equal(r[0].host, '192.168.1.9');
});

test('同序列号两边都有 → 合并为 both，host 保留，名称优先 LAN 自定义', () => {
  const cloud = [{ serial: 'S', name: '云名', model: 'N6', online: true, printStatus: 'RUNNING' }];
  const lan = [{ serial: 'S', name: '我的本地名', model: '', host: '10.0.0.5', accessCode: 'x' }];
  const r = mergePrinters(cloud, lan);
  assert.equal(r.length, 1);
  assert.equal(r[0].source, 'both');
  assert.equal(r[0].hasCloud, true);
  assert.equal(r[0].hasLan, true);
  assert.equal(r[0].name, '我的本地名');
  assert.equal(r[0].model, 'N6');        // LAN model 空 → 取云
  assert.equal(r[0].host, '10.0.0.5');
  assert.equal(r[0].online, true);
});

test('pickTransport: both/lan → lan, cloud → cloud', () => {
  assert.equal(pickTransport({ hasLan: true, hasCloud: true }), 'lan');
  assert.equal(pickTransport({ hasLan: true, hasCloud: false }), 'lan');
  assert.equal(pickTransport({ hasLan: false, hasCloud: true }), 'cloud');
});
