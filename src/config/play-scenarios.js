// 把玩探索：场景元数据（单一数据源，与 src/settings/settings.js 内的副本保持一致）。
// printing 拆成 0/25/50/75 四档进度，各自独立可抽/可选（对应 state-map.js 的 printing_0/25/50/75）。
// 每个 scenario 必须与 src/core/mock.js 的 SCENARIOS 键一一对应；progress 走 play:setProgress。
// 文案走 locales：play.<id>.name/.desc；printing 档用 play.printing.progressLabel。
const PLAY_SCENARIOS = [
  { id: 'printing_0',  scenario: 'printing', progress: 0,  icon: '🖨️' },
  { id: 'printing_25', scenario: 'printing', progress: 25, icon: '🖨️' },
  { id: 'printing_50', scenario: 'printing', progress: 50, icon: '🖨️' },
  { id: 'printing_75', scenario: 'printing', progress: 75, icon: '🖨️' },
  { id: 'idle',              scenario: 'idle',              icon: '😴' },
  { id: 'prepare_leveling',  scenario: 'prepare_leveling',  icon: '📐' },
  { id: 'changing_filament', scenario: 'changing_filament', icon: '🔄' },
  { id: 'paused',            scenario: 'paused',            icon: '⏸️' },
  { id: 'finished',          scenario: 'finished',          icon: '🎉' },
  { id: 'failed',            scenario: 'failed',            icon: '😢' },
  { id: 'offline',           scenario: 'offline',           icon: '🔌' },
];

function playLabelKey(e) { return e.scenario === 'printing' ? 'play.printing.progressLabel' : `play.${e.id}.name`; }
function playDescKey(e) { return `play.${e.scenario === 'printing' ? 'printing' : e.id}.desc`; }

module.exports = { PLAY_SCENARIOS, playLabelKey, playDescKey };
