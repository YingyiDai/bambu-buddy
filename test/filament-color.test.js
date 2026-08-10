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

// 双喷头（X2D / H2D）：两卷料同时在走，ams.tray_now 只反映其中一个喷头，
// 不能代表正在出料的主喷头。须认 device.extruder.info[].snow（真机抓包实证）：
//   snow = 高字节 ams_id | 低字节 tray_id，0xFFFF=空槽；stat 非 0 = 该喷头在出料。
// 下面这帧是真机 X2D 报文的精简还原：tray_now=1 指向 AMS0 槽1（紫 a03cf7，另一喷头选中的槽），
// 但实际在打的是 extruder id=1 → snow=257(0x0101)=AMS1 槽1（粉 f55a74）。
test('双喷头：按正在出料的 extruder.snow 取色，而非 tray_now 指向的另一喷头', () => {
  const report = {
    ams: {
      tray_now: '1', // AMS0 槽1 = 紫，另一喷头选中的槽，不是主打色
      ams: [
        { id: '0', tray: [
          { id: '0', tray_color: '959698FF' },
          { id: '1', tray_color: 'A03CF7FF' }, // 紫
          { id: '2', tray_color: '00AE42FF' },
          { id: '3', tray_color: '000000FF' },
        ] },
        { id: '1', tray: [
          { id: '0', tray_color: 'FEC600FF' },
          { id: '1', tray_color: 'F55A74FF' }, // 粉，主喷头正在打
          { id: '2', tray_color: 'DBC8B6FF' },
          { id: '3', tray_color: 'FFFFFFFF' },
        ] },
      ],
    },
    device: {
      extruder: {
        info: [
          { id: 0, snow: 65535, stat: 0 },      // 空槽、未出料
          { id: 1, snow: 257, stat: 197376 },   // AMS1 槽1，正在出料
        ],
      },
    },
  };
  assert.equal(resolveFilamentColor(report), '#f55a74');
});

test('双喷头：无 extruder.info 时回退到 tray_now（兼容单喷头报文形状）', () => {
  const report = {
    ams: {
      tray_now: '5',
      ams: [
        { id: '0', tray: [{ id: '0', tray_color: '000000FF' }] },
        { id: '1', tray: [{ id: '0', tray_color: '112233FF' }, { id: '1', tray_color: 'F95959FF' }] },
      ],
    },
    device: {},
  };
  assert.equal(resolveFilamentColor(report), '#f95959');
});

test('双喷头：两喷头都在出料时取任一在打的喷头（不回落到错误的 tray_now）', () => {
  const report = {
    ams: {
      tray_now: '0', // AMS0 槽0 = 黑，两喷头都不在这
      ams: [
        { id: '0', tray: [{ id: '0', tray_color: '000000FF' }, { id: '1', tray_color: 'A03CF7FF' }] },
        { id: '1', tray: [{ id: '0', tray_color: 'FEC600FF' }, { id: '1', tray_color: 'F55A74FF' }] },
      ],
    },
    device: {
      extruder: {
        info: [
          { id: 0, snow: 1, stat: 197376 },   // AMS0 槽1 = 紫，在出料
          { id: 1, snow: 257, stat: 197376 }, // AMS1 槽1 = 粉，在出料
        ],
      },
    },
  };
  // 两头都在打时取到其中一个装载的耗材色即可（这里是紫或粉），关键是不能回落到 tray_now 指向的黑
  assert.ok(['#a03cf7', '#f55a74'].includes(resolveFilamentColor(report)));
});

// ── 双喷头「解不出」时必须回落 tray_now，而不是让跟随耗材颜色整个失效 ──
// 早期实现在双喷头分支里一律 return null（宁可不改色也不显示错色），结果双喷头机只要走到
// 下面任一条岔路，熊猫就永远叼原始绿、开关看着像坏了；单喷头机却一切正常。回归用例锁死回落。

test('双喷头 + 外挂料盘：snow 指外挂哨兵时取 vt_tray，而不是解不出而不改色', () => {
  const report = {
    ams: { tray_now: '254', ams: [] }, // 不带 AMS 的 H2D：外挂料盘直接进喷头
    vt_tray: { tray_color: '00AE42FF' },
    device: {
      extruder: {
        info: [
          { id: 0, snow: 65024, stat: 197376 }, // 0xFE00 = 外挂(254) 位 0，正在出料
          { id: 1, snow: 65535, stat: 0 },      // 空槽
        ],
      },
    },
  };
  assert.equal(resolveFilamentColor(report), '#00ae42');
});

test('双喷头 + 两个外挂位：vt_tray 为数组时按 snow 低字节定位', () => {
  const frame = (snow) => ({
    ams: { tray_now: '254', ams: [] },
    // 双喷头机可能把两个外挂位列成数组（单喷头机是对象，见上一用例）
    vt_tray: [{ id: '0', tray_color: '00AE42FF' }, { id: '1', tray_color: 'F55A74FF' }],
    device: { extruder: { info: [{ id: 0, snow: 65535, stat: 0 }, { id: 1, snow, stat: 197376 }] } },
  });
  assert.equal(resolveFilamentColor(frame(0xfe00)), '#00ae42'); // 外挂(254) 位 0
  assert.equal(resolveFilamentColor(frame(0xfe01)), '#f55a74'); // 外挂(254) 位 1
});

test('双喷头：stat 缺失/恒 0 时，唯一装料的喷头即主喷头（不因此判无色）', () => {
  const report = {
    ams: {
      tray_now: '1', // AMS0 槽1 = 紫，另一喷头选中的槽
      ams: [
        { id: '0', tray: [{ id: '0', tray_color: '000000FF' }, { id: '1', tray_color: 'A03CF7FF' }] },
        { id: '1', tray: [{ id: '0', tray_color: 'FEC600FF' }, { id: '1', tray_color: 'F55A74FF' }] },
      ],
    },
    device: {
      extruder: {
        info: [
          { id: 0, snow: 65535 },     // 空槽，无 stat
          { id: 1, snow: 257 },       // AMS1 槽1 = 粉，唯一装着料的喷头，无 stat
        ],
      },
    },
  };
  assert.equal(resolveFilamentColor(report), '#f55a74');
});

test('双喷头：snow 指向不存在的 AMS 槽时回落 tray_now，不是返回 null', () => {
  const report = {
    ams: {
      tray_now: '5', // AMS1 槽1 = 红
      ams: [
        { id: '0', tray: [{ id: '0', tray_color: '000000FF' }] },
        { id: '1', tray: [{ id: '0', tray_color: '112233FF' }, { id: '1', tray_color: 'F95959FF' }] },
      ],
    },
    device: {
      extruder: {
        info: [
          { id: 0, snow: 0x0703, stat: 197376 }, // AMS7 槽3：报文里没有这台 AMS
          { id: 1, snow: 65535, stat: 0 },
        ],
      },
    },
  };
  assert.equal(resolveFilamentColor(report), '#f95959');
});

test('双喷头：两头都空槽（换料/待机）时回落 tray_now', () => {
  const report = {
    ams: {
      tray_now: '0',
      ams: [{ id: '0', tray: [{ id: '0', tray_color: '89C2FFFF' }] }],
    },
    device: { extruder: { info: [{ id: 0, snow: 65535, stat: 0 }, { id: 1, snow: 65535, stat: 0 }] } },
  };
  assert.equal(resolveFilamentColor(report), '#89c2ff');
});

test('无 ams 子树也能靠 extruder + vt_tray 取到外挂色', () => {
  const report = {
    vt_tray: { tray_color: '89C2FFFF' },
    device: { extruder: { info: [{ id: 0, snow: 0xfe00, stat: 1 }, { id: 1, snow: 65535, stat: 0 }] } },
  };
  assert.equal(resolveFilamentColor(report), '#89c2ff');
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
