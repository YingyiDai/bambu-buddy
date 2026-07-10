// BambuMQTTBase 报文合并契约的单测：不连真机，直接喂 _onMessage 原始 payload。
// 重点回归「取消标记的持久化」：取消事件瞬时，但 gcode_state=FAILED 会残留到下次开印，
// 数据源须把 print_canceled 持续透出到下次开印，避免熊猫取消后一直「打印失败」。
const test = require('node:test');
const assert = require('node:assert');
const { BambuMQTTBase, classifyLanProbe } = require('../src/core/bambu-mqtt');

// 造一帧 device/<serial>/report 的 payload，并返回该帧解析出的 report。
function feed(base, print) {
  let out = null;
  base.onState((r) => { out = r; });
  base._onMessage(Buffer.from(JSON.stringify({ print })));
  return out;
}

test('取消事件后，残留的 FAILED 帧持续带 print_canceled', () => {
  const base = new BambuMQTTBase();
  // 1) 打印中
  feed(base, { command: 'push_status', gcode_state: 'RUNNING', mc_percent: 40 });
  // 2) 取消事件（瞬时命令）
  let r = feed(base, { command: 'print_canceled' });
  assert.equal(r.print_canceled, true);
  // 3) 之后打印机残留 gcode_state=FAILED（增量帧里不再带取消命令）
  r = feed(base, { gcode_state: 'FAILED', hms: [{ code: 131184 }] });
  assert.equal(r.print_canceled, true, '取消标记应持久到下次开印');
});

test('下次开印（RUNNING/PREPARE）清除取消标记', () => {
  const base = new BambuMQTTBase();
  feed(base, { command: 'print_canceled' });
  let r = feed(base, { gcode_state: 'FAILED' });
  assert.equal(r.print_canceled, true);
  // 新任务开始
  r = feed(base, { gcode_state: 'PREPARE' });
  assert.ok(!r.print_canceled, 'PREPARE 应清除取消标记');
  r = feed(base, { gcode_state: 'RUNNING', mc_percent: 1 });
  assert.ok(!r.print_canceled);
});

test('未取消的真正失败不会被误标记为取消', () => {
  const base = new BambuMQTTBase();
  feed(base, { command: 'push_status', gcode_state: 'RUNNING', mc_percent: 40 });
  const r = feed(base, { gcode_state: 'FAILED', hms: [{ code: 131184 }] });
  assert.ok(!r.print_canceled, '无取消事件时不应带 print_canceled');
});

// ── LAN 探活结果分类（classifyLanProbe）──
// 现文案「连接超时，请检查 IP / 访问码」对鉴权失败/序列号错误/网络不通全都一个样，误导排障。
// 分类器把探活期间观测到的事件映射成更精准的原因码，仅在超时（未收到 report）时调用。

test('连上打印机（鉴权通过）却收不到 report → 序列号可疑', () => {
  // mqtt connect 事件已触发（TLS+CONNACK 通过），说明 IP/访问码都对，
  // 唯独订阅 device/<serial>/report 收不到数据 → 多半是序列号填错。
  assert.equal(classifyLanProbe({ gotConnect: true, error: null }), 'serial');
});

test('CONNACK 拒绝（访问码错）→ auth', () => {
  const err = new Error('Connection refused: Bad username or password');
  assert.equal(classifyLanProbe({ gotConnect: false, error: err }), 'auth');
  const err2 = new Error('Connection refused: Not authorized');
  assert.equal(classifyLanProbe({ gotConnect: false, error: err2 }), 'auth');
});

test('网络类错误（拒绝/DNS 解析失败）→ network', () => {
  assert.equal(classifyLanProbe({ gotConnect: false, error: { code: 'ECONNREFUSED' } }), 'network');
  assert.equal(classifyLanProbe({ gotConnect: false, error: { code: 'EHOSTUNREACH' } }), 'network');
  assert.equal(classifyLanProbe({ gotConnect: false, error: new Error('getaddrinfo ENOTFOUND printer') }), 'network');
});

test('全程无事件（SYN 被静默丢弃，如 AP 隔离/跨网段）→ timeout', () => {
  assert.equal(classifyLanProbe({ gotConnect: false, error: null }), 'timeout');
});
