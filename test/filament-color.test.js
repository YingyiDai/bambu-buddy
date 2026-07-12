// resolveFilamentColor：从原始报文取「当前正在打印的耗材颜色」。
// 字段语义以 OpenBambuAPI mqtt.md / pybambu 为准：
//   ams.tray_now = "255" 无耗材 | "254" 外挂料盘（vt_tray）| 其余 = ams_id*4 + tray_id。
//   tray_color 为 RRGGBBAA 十六进制。
const test = require('node:test');
const assert = require('node:assert');
const { resolveFilamentColor } = require('../src/core/filament-color');

test('AMS 槽位：tray_now 指向 ams_id*4+tray_id，取 RRGGBBAA 前 6 位', () => {
  const report = {
    ams: {
      tray_now: '5', // ams 1（第二台）槽 1（第二槽）
      ams: [
        { id: '0', tray: [{ id: '0', tray_color: '000000FF' }] },
        { id: '1', tray: [{ id: '0', tray_color: '112233FF' }, { id: '1', tray_color: 'F95959FF' }] },
      ],
    },
  };
  assert.equal(resolveFilamentColor(report), '#f95959');
});

test('外挂料盘：tray_now=254 时读 vt_tray.tray_color', () => {
  const report = {
    ams: { tray_now: '254', ams: [] },
    vt_tray: { tray_color: '00AE42FF' },
  };
  assert.equal(resolveFilamentColor(report), '#00ae42');
});

test('无耗材：tray_now=255 返回 null', () => {
  const report = {
    ams: { tray_now: '255', ams: [{ id: '0', tray: [{ id: '0', tray_color: 'FFFFFFFF' }] }] },
  };
  assert.equal(resolveFilamentColor(report), null);
});

test('字段缺失：无 ams / 无 tray_now / 槽位不存在 / 颜色缺失均返回 null', () => {
  assert.equal(resolveFilamentColor({}), null);
  assert.equal(resolveFilamentColor(null), null);
  assert.equal(resolveFilamentColor({ ams: {} }), null);
  // 指向不存在的槽位
  assert.equal(resolveFilamentColor({ ams: { tray_now: '7', ams: [{ id: '0', tray: [] }] } }), null);
  // 槽位存在但没有颜色字段
  assert.equal(resolveFilamentColor({ ams: { tray_now: '0', ams: [{ id: '0', tray: [{ id: '0' }] }] } }), null);
  // 外挂但 vt_tray 缺失
  assert.equal(resolveFilamentColor({ ams: { tray_now: '254' } }), null);
});

test('非法颜色值返回 null（长度不足 / 非十六进制）', () => {
  assert.equal(resolveFilamentColor({ ams: { tray_now: '254' }, vt_tray: { tray_color: '0AE' } }), null);
  assert.equal(resolveFilamentColor({ ams: { tray_now: '254' }, vt_tray: { tray_color: 'GGHHIIFF' } }), null);
});

test('tray 缺 id 字段时按数组下标回退定位槽位', () => {
  const report = {
    ams: {
      tray_now: '1',
      ams: [{ tray: [{ tray_color: '000000FF' }, { tray_color: '89C2FFFF' }] }],
    },
  };
  assert.equal(resolveFilamentColor(report), '#89c2ff');
});
