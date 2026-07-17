// PrinterHub 单测：sync 的 diff 语义（增/删/留/签名变更重连）与按台 LAN→cloud 一次性回退。
const test = require('node:test');
const assert = require('node:assert');
const { PrinterHub } = require('../src/core/printer-hub');

// 假数据源：记录生命周期，暴露 emit 手动注入报文（仿 bambu-mqtt.test.js 的假源手法）。
class FakeSource {
  constructor(entry, transport) {
    this.entry = entry;
    this.transport = transport;
    this.started = false;
    this.stopped = false;
    this._cb = null;
    this._authCb = null;
  }
  onState(cb) { this._cb = cb; }
  onAuthFailure(cb) { this._authCb = cb; }
  start() { this.started = true; }
  stop() { this.stopped = true; this._cb = null; }
  emit(report) { if (this._cb) this._cb(report); }
  emitAuthFailure() { if (this._authCb) this._authCb(); }
}

// 建 hub + 记录所有创建过的假源与收到的报文。
function makeHub() {
  const created = []; // 按创建序的 FakeSource
  const reports = []; // [serial, report]
  const authFailures = []; // serial
  const hub = new PrinterHub({
    makeSource: (entry, transport) => {
      const s = new FakeSource(entry, transport);
      created.push(s);
      return s;
    },
    onReport: (serial, report) => reports.push([serial, report]),
    onAuthFailure: (serial) => authFailures.push(serial),
    pickTransport: (entry) => (entry.hasLan ? 'lan' : 'cloud'),
  });
  return { hub, created, reports, authFailures };
}

const cloudEntry = (serial, extra = {}) => ({ serial, name: serial, hasCloud: true, hasLan: false, host: null, ...extra });
const lanEntry = (serial, host, extra = {}) => ({ serial, name: serial, hasCloud: false, hasLan: true, host, ...extra });

test('sync 新增：每台建一个源并 start，报文带 serial 回调', () => {
  const { hub, created, reports } = makeHub();
  hub.sync([cloudEntry('A'), lanEntry('B', '10.0.0.5')]);
  assert.strictEqual(created.length, 2);
  assert.ok(created.every((s) => s.started));
  assert.strictEqual(created[0].transport, 'cloud');
  assert.strictEqual(created[1].transport, 'lan');
  created[0].emit({ connected: true, gcode_state: 'IDLE' });
  assert.deepStrictEqual(reports[0][0], 'A');
  assert.deepStrictEqual(hub.serials().sort(), ['A', 'B']);
});

test('sync 移除：消失的台 stop 并从 hub 删除', () => {
  const { hub, created } = makeHub();
  hub.sync([cloudEntry('A'), cloudEntry('B')]);
  hub.sync([cloudEntry('A')]);
  const b = created.find((s) => s.entry.serial === 'B');
  assert.ok(b.stopped);
  assert.strictEqual(hub.has('B'), false);
  assert.strictEqual(hub.has('A'), true);
});

test('保留台配置未变：不重连（重命名 / 云端轮询刷新 online 不得闪断）', () => {
  const { hub, created } = makeHub();
  hub.sync([cloudEntry('A', { name: '旧名', online: false })]);
  assert.strictEqual(created.length, 1);
  // 云端 45s 轮询重写列表：name/online/printStatus 变化，连接配置没变
  hub.sync([cloudEntry('A', { name: '新名', online: true, printStatus: 'RUNNING' })]);
  assert.strictEqual(created.length, 1, '不得新建源');
  assert.strictEqual(created[0].stopped, false, '不得断开旧源');
});

test('保留台签名变化（host 变了）：断旧连新', () => {
  const { hub, created } = makeHub();
  hub.sync([lanEntry('A', '10.0.0.5')]);
  hub.sync([lanEntry('A', '10.0.0.9')]);
  assert.strictEqual(created.length, 2);
  assert.ok(created[0].stopped);
  assert.strictEqual(created[1].entry.host, '10.0.0.9');
});

test('保留台签名变化（新增 LAN 通道 → 传输从 cloud 变 lan）：重连', () => {
  const { hub, created } = makeHub();
  hub.sync([cloudEntry('A')]);
  hub.sync([{ serial: 'A', name: 'A', hasCloud: true, hasLan: true, host: '10.0.0.5' }]);
  assert.strictEqual(created.length, 2);
  assert.strictEqual(created[1].transport, 'lan');
});

test('LAN→cloud 回退：从未连上就收到离线帧 → 换云端重连恰一次，离线帧不外泄', () => {
  const { hub, created, reports } = makeHub();
  hub.sync([{ serial: 'A', name: 'A', hasCloud: true, hasLan: true, host: '10.0.0.5' }]);
  assert.strictEqual(created[0].transport, 'lan');
  created[0].emit({ connected: false });
  assert.strictEqual(created.length, 2, '回退建了云端源');
  assert.ok(created[0].stopped);
  assert.strictEqual(created[1].transport, 'cloud');
  assert.strictEqual(reports.length, 0, '触发回退的那帧离线不外泄');
  // 云端也没连上 → 不再二次回退，离线帧正常外泄
  created[1].emit({ connected: false });
  assert.strictEqual(created.length, 2, '回退仅一次');
  assert.strictEqual(reports.length, 1);
});

test('LAN 连上过一次后掉线：不回退，离线帧正常外泄', () => {
  const { hub, created, reports } = makeHub();
  hub.sync([{ serial: 'A', name: 'A', hasCloud: true, hasLan: true, host: '10.0.0.5' }]);
  created[0].emit({ connected: true, gcode_state: 'RUNNING' });
  created[0].emit({ connected: false });
  assert.strictEqual(created.length, 1, '连上过就不再回退');
  assert.strictEqual(reports.length, 2);
});

test('纯 LAN 台（无云端通道）离线：不回退', () => {
  const { hub, created, reports } = makeHub();
  hub.sync([lanEntry('A', '10.0.0.5')]);
  created[0].emit({ connected: false });
  assert.strictEqual(created.length, 1);
  assert.strictEqual(reports.length, 1);
});

test('鉴权失败：LAN 台先尝试回退云端；云端台直接冒泡 onAuthFailure(serial)', () => {
  const { hub, created, authFailures } = makeHub();
  hub.sync([
    { serial: 'L', name: 'L', hasCloud: true, hasLan: true, host: '10.0.0.5' },
    cloudEntry('C'),
  ]);
  created[0].emitAuthFailure(); // LAN 鉴权失败 → 回退云端，不冒泡
  assert.strictEqual(authFailures.length, 0);
  assert.strictEqual(created.length, 3, 'L 回退建了云端源');
  created[1].emitAuthFailure(); // 云端台 → 冒泡
  assert.deepStrictEqual(authFailures, ['C']);
});

test('stopAll：全部断开清空', () => {
  const { hub, created } = makeHub();
  hub.sync([cloudEntry('A'), cloudEntry('B')]);
  hub.stopAll();
  assert.ok(created.every((s) => s.stopped));
  assert.deepStrictEqual(hub.serials(), []);
});
