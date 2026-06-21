// 把玩探索：场景元数据（单一数据源）。
// 数组顺序 = 状态画廊展示顺序 = 自动巡演顺序。
// 每个 key 必须与 src/core/mock.js 的 SCENARIOS 键一一对应。
// 文案（友好名 / 说明）走 locales：play.<key>.name / play.<key>.desc。
const PLAY_SCENARIOS = [
  { key: 'printing',          icon: '🖨️', hasProgress: true  },
  { key: 'idle',              icon: '😴', hasProgress: false },
  { key: 'prepare_preheat',   icon: '🔥', hasProgress: false },
  { key: 'prepare_leveling',  icon: '📐', hasProgress: false },
  { key: 'changing_filament', icon: '🔄', hasProgress: false },
  { key: 'paused',            icon: '⏸️', hasProgress: false },
  { key: 'paused_runout',     icon: '🪹', hasProgress: false },
  { key: 'door_open',         icon: '🚪', hasProgress: false },
  { key: 'finished',          icon: '🎉', hasProgress: false },
  { key: 'failed',            icon: '😢', hasProgress: false },
  { key: 'offline',           icon: '🔌', hasProgress: false },
];

function playLabelKey(key) { return `play.${key}.name`; }
function playDescKey(key) { return `play.${key}.desc`; }

module.exports = { PLAY_SCENARIOS, playLabelKey, playDescKey };
