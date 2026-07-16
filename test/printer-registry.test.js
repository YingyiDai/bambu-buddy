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

const { addLan, removeLan, renameInList } = require('../src/core/printer-registry');

test('addLan 新增', () => {
  const r = addLan([], { serial: 'A', name: 'a', model: '', host: 'h', accessCode: 'c' });
  assert.equal(r.length, 1);
  assert.equal(r[0].serial, 'A');
});

test('addLan 同序列号替换而非重复', () => {
  const r = addLan([{ serial: 'A', name: 'old', host: 'h1', accessCode: 'c1' }],
                   { serial: 'A', name: 'new', host: 'h2', accessCode: 'c2' });
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'new');
  assert.equal(r[0].host, 'h2');
});

test('removeLan 删除', () => {
  const r = removeLan([{ serial: 'A' }, { serial: 'B' }], 'A');
  assert.deepEqual(r.map((x) => x.serial), ['B']);
});

test('renameInList 改名', () => {
  const r = renameInList([{ serial: 'A', name: 'a' }, { serial: 'B', name: 'b' }], 'B', 'BB');
  assert.equal(r.find((x) => x.serial === 'B').name, 'BB');
  assert.equal(r.find((x) => x.serial === 'A').name, 'a');
});

const { computeMigration } = require('../src/core/printer-registry');

test('迁移：旧单台 bambuLan → bambuLanPrinters[]', () => {
  const { set, del } = computeMigration({
    bambuLan: { host: '1.2.3.4', accessCode: 'enc', serial: 'S1', name: '机器' },
  });
  assert.deepEqual(set.bambuLanPrinters, [{ serial: 'S1', name: '机器', model: '', host: '1.2.3.4', accessCode: 'enc' }]);
  assert.ok(del.includes('bambuLan'));
});

test('迁移：dataSource cloud/lan → live；两代 active 键一律删除（多台常驻后无「当前」概念）', () => {
  const { set, del } = computeMigration({ dataSource: 'cloud', bambuActivePrinter: 'S9' });
  assert.equal(set.dataSource, 'live');
  assert.equal(set.activePrinterSerial, undefined);
  assert.ok(del.includes('bambuActivePrinter'));
});

test('迁移：残留的 activePrinterSerial 被删除', () => {
  const { set, del } = computeMigration({ dataSource: 'live', activePrinterSerial: 'X' });
  assert.deepEqual(set, {});
  assert.ok(del.includes('activePrinterSerial'));
});

test('迁移幂等：已是新结构则无操作', () => {
  const { set, del } = computeMigration({ dataSource: 'live', bambuLanPrinters: [] });
  assert.deepEqual(set, {});
  assert.deepEqual(del, []);
});

test('迁移：mock 保持 mock', () => {
  const { set } = computeMigration({ dataSource: 'mock' });
  assert.equal(set.dataSource, undefined);
});
