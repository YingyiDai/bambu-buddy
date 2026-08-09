#!/usr/bin/env node
// 耗材跟色诊断：吃一份 BAMBU_DEBUG_REPORT=1 导出的日志，走**真实的**增量合并 + 取色链路，
// 逐帧说清「这一帧为什么解出/解不出耗材色」。
//
// 用户侧导日志（不需要装 node，也不用装新版）：
//   BAMBU_DEBUG_REPORT=1 "/Applications/Bambu Buddy.app/Contents/MacOS/Bambu Buddy" > ~/桌面/bambu.log 2>&1
//   打印中跑 30 秒即可，Ctrl+C 停止，把 bambu.log 发回来。
//
// 我们这边分析：
//   node scripts/diag-filament-color.js ~/Downloads/bambu.log
//   node scripts/diag-filament-color.js --sanitize ~/Downloads/bambu.log > capture.json   # 只留取色相关子树
//
// 为什么要这个脚本：跟色链路的协议假设（snow 的槽位拆法、stat 的语义）只在一台真机的
// 一种状态下验证过（见 PR #62「已知保留项」），其余状态全是外推。用户报「不跟随变色」时，
// 光看现象分不清是哪一环断的，逐帧打出中间量才能定位。

const fs = require('fs');
const path = require('path');
const { BambuLanDataSource } = require(path.join(__dirname, '..', 'src', 'core', 'bambu-mqtt'));
const { resolveFilamentColor } = require(path.join(__dirname, '..', 'src', 'core', 'filament-color'));

const SLOT_NONE = 0xffff;
const DECODERS = [
  { name: '字节拆分 >>8', fn: (s) => [(s >> 8) & 0xff, s & 0xff] },
  { name: '半字节 >>4', fn: (s) => [s >> 4, s & 0x0f] },
];

// v0.4.4（用户手上那版）的取色逻辑，原样内联一份做对照 —— 这样同一份日志能同时看到
// 「线上为什么变绿」和「改完是否解得出」，不用装两个版本对跑。
function resolveAsShipped(report) {
  const hex = (raw) => (typeof raw === 'string' && /^[0-9a-fA-F]{6}/.test(raw) ? '#' + raw.slice(0, 6).toLowerCase() : null);
  const at = (amsId, slotId) => {
    const units = (report.ams && Array.isArray(report.ams.ams)) ? report.ams.ams : [];
    const unit = units.find((u) => u && Number(u.id) === amsId) || units[amsId];
    const trays = unit && Array.isArray(unit.tray) ? unit.tray : [];
    const tray = trays.find((t) => t && Number(t.id) === slotId) || trays[slotId];
    return hex(tray && tray.tray_color);
  };
  if (!report || !report.ams) return null;
  const info = report.device && report.device.extruder && report.device.extruder.info;
  if (Array.isArray(info) && info.length >= 2) { // 双喷头分支：解不出即 null，不回落
    const active = info.find((e) => {
      const s = Number(e && e.snow);
      return Number.isFinite(s) && s !== SLOT_NONE && Number(e.stat);
    });
    if (!active) return null;
    const s = Number(active.snow);
    return at((s >> 8) & 0xff, s & 0xff);
  }
  const now = Number(report.ams.tray_now);
  if (!Number.isFinite(now) || now === 255) return null;
  if (now === 254) return hex(report.vt_tray && report.vt_tray.tray_color);
  return at(Math.floor(now / 4), now % 4);
}

const args = process.argv.slice(2);
const sanitize = args.includes('--sanitize');
const file = args.find((a) => !a.startsWith('--'));

const raw = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');

// 日志行形如：[bambu-mqtt] print: {...}
const frames = [];
for (const line of raw.split('\n')) {
  const i = line.indexOf('[bambu-mqtt] print:');
  if (i === -1) continue;
  const json = line.slice(i + '[bambu-mqtt] print:'.length).trim();
  try { frames.push(JSON.parse(json)); } catch { /* 半行/截断，跳过 */ }
}
if (!frames.length) {
  console.error('没在日志里找到任何 [bambu-mqtt] print: 帧。');
  console.error('确认导出时带了 BAMBU_DEBUG_REPORT=1，且导出期间打印机是连着的。');
  process.exit(1);
}

// 走真实的合并链路（深合并 ams / vt_tray / device 都在里面）
const src = new BambuLanDataSource({ host: '0.0.0.0', accessCode: 'x', serial: 'X' });
const merged = [];
src.onState((r) => merged.push(r));
for (const f of frames) src._onMessage(Buffer.from(JSON.stringify({ print: f })));

// 只保留取色相关子树 —— 发出来时不带序列号 / 任务名 / 文件名
if (sanitize) {
  const last = merged[merged.length - 1];
  console.log(JSON.stringify({
    ams: last.ams,
    vt_tray: last.vt_tray,
    device: { extruder: last.device && last.device.extruder },
    gcode_state: last.gcode_state,
  }, null, 2));
  process.exit(0);
}

function slotIds(report) {
  const units = (report.ams && Array.isArray(report.ams.ams)) ? report.ams.ams : [];
  return units.map((u) => `AMS${u && u.id}[${(u && Array.isArray(u.tray) ? u.tray : [])
    .map((t) => `${t && t.id}:${(t && t.tray_color) || '—'}`).join(' ')}]`).join('  ');
}

// 逐帧解释：为什么解出 / 解不出
function explain(report) {
  const info = report.device && report.device.extruder && report.device.extruder.info;
  if (!Array.isArray(info)) return '单喷头路径（报文无 device.extruder.info）→ 只看 tray_now';
  if (info.length < 2) return `单喷头路径（extruder.info 仅 ${info.length} 项）→ 只看 tray_now`;

  const desc = info.map((e) => `id${e && e.id}{snow:${e && e.snow}${Number(e && e.snow) === SLOT_NONE ? '(空槽)' : ''} stat:${e && e.stat}}`).join(' ');
  const loaded = info.filter((e) => {
    const s = Number(e && e.snow);
    return Number.isFinite(s) && s !== SLOT_NONE;
  });
  if (!loaded.length) return `双喷头路径 ${desc} → 两头都空槽，解不出，回落 tray_now`;

  const byStat = loaded.find((e) => Number(e.stat));
  const active = byStat || (loaded.length === 1 ? loaded[0] : null);
  if (!active) return `双喷头路径 ${desc} → ${loaded.length} 头都装着料但 stat 全为 0/缺失，认不出在打的那头，回落 tray_now`;

  const how = byStat ? 'stat≠0' : '唯一装料头';
  const snow = Number(active.snow);
  const tries = DECODERS.map((d) => {
    const [a, s] = d.fn(snow);
    const units = (report.ams && Array.isArray(report.ams.ams)) ? report.ams.ams : [];
    const unit = units.find((u) => u && Number(u.id) === a) || units[a];
    const trays = unit && Array.isArray(unit.tray) ? unit.tray : [];
    const tray = trays.find((t) => t && Number(t.id) === s) || trays[s];
    const color = tray && tray.tray_color;
    return `${d.name}→AMS${a}槽${s}:${color || '✗对不到槽'}`;
  }).join('  |  ');
  return `双喷头路径 ${desc} → 认 id${active.id}（${how}）snow=${snow}  ${tries}`;
}

let okShipped = 0;
let okFixed = 0;
const reasons = new Map();
console.log(`共 ${merged.length} 帧\n`);
console.log('帧号  gcode     tray_now   线上 v0.4.4   修复后');
merged.forEach((r, i) => {
  const shipped = resolveAsShipped(r);
  const fixed = resolveFilamentColor(r);
  if (shipped) okShipped++;
  if (fixed) okFixed++;
  const why = explain(r);
  reasons.set(why.split('→')[1] || why, (reasons.get(why.split('→')[1] || why) || 0) + 1);
  // 只打印前若干帧与每次结果变化，避免刷屏
  const prev = merged[i - 1];
  if (i < 8 || !prev || shipped !== resolveAsShipped(prev) || fixed !== resolveFilamentColor(prev)) {
    console.log(`#${String(i).padStart(4)} ${String(r.gcode_state).padEnd(9)} ${String(r.ams && r.ams.tray_now).padEnd(10)} ${(shipped || 'null(绿)').padEnd(13)} ${fixed || 'null(绿)'}`);
    console.log(`      ${why}`);
  }
});

console.log(`\n${'='.repeat(70)}`);
console.log(`线上 v0.4.4 解出耗材色：${okShipped}/${merged.length} 帧${okShipped ? '' : '  ← 用户看到的「一直是原始绿」'}`);
console.log(`修复后解出耗材色：      ${okFixed}/${merged.length} 帧`);
console.log(`\n最后一帧的 AMS 槽位：\n  ${slotIds(merged[merged.length - 1]) || '（无 AMS 单元）'}`);
console.log('\n分支归因：');
for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)} 帧  ${why.trim()}`);
}
