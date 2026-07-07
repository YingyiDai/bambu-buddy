// 渲染层：状态 → 视频交叉淡入切换、locale 感知 label、点击穿透切换、去抖（§8）。
const ANIM_BASE = '../../assets/anim/';
const petEl = document.getElementById('pet');
const labelEl = document.getElementById('label');
const layers = [document.getElementById('videoA'), document.getElementById('videoB')];

// 视频切换由并发安全、防抖不可饿死的控制器统一负责（见 crossfade.js）。
const video = createVideoController(layers, { base: ANIM_BASE });

// Locale
let localeStrings = {};
let currentLocale = 'zh-CN';
let lastPetState = null; // 最近一次 printer state，用于 locale / 偏好切换时重绘

// 「显示层数 / 显示剩余时间」开关（外观页，默认关）——决定标签是否拼出第 2、3 行。
let showLayer = false;
let showTime = false;

function t(locale, key, params) {
  const map = localeStrings[locale] || localeStrings['zh-CN'] || {};
  let template = map[key];
  if (template == null) return key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      template = template.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return template;
}

// 拼单行标签：主体是状态本身（打印中时即「打印中 {p}%」）；打印中且开关开启时，
// 用「 · 」把层数、剩余时间横向追加到同一行——保持标签始终一行、不向上生长盖住熊猫。
// 数据由 resolveState 放进 labelParams（remain 已是 locale 无关的紧凑 token），
// 故切 locale / 切开关都能就地重绘。
function renderLabel() {
  if (!lastPetState) return;
  const p = lastPetState.labelParams || {};
  const parts = [t(currentLocale, lastPetState.labelKey, p)];
  if (showLayer && p.layer != null && p.total != null) {
    parts.push(t(currentLocale, 'label.layers', p));
  }
  if (showTime && p.remain != null) {
    parts.push(t(currentLocale, 'label.remaining', { time: p.remain }));
  }
  labelEl.textContent = parts.join(' · ');
}

function applyState(state) {
  if (!state) return;
  lastPetState = state;
  // 标签同步刷新；视频经控制器切换（去重 + 尾沿防抖 + 并发安全）。
  renderLabel();
  video.request(state.videoFile);
}

// Locale 更新 → 立即重绘标签
window.pet.onLocale((locale, strings) => {
  currentLocale = locale;
  localeStrings[locale] = strings;
  renderLabel();
});

// 偏好更新
window.pet.onPrefs((prefs) => {
  if (prefs.labelFontSize != null) {
    labelEl.style.setProperty('--label-font-size', prefs.labelFontSize + 'px');
  }
  if (prefs.showLabel != null) {
    labelEl.classList.toggle('hidden', !prefs.showLabel);
  }
  if (prefs.showLayer != null) showLayer = prefs.showLayer;
  if (prefs.showTime != null) showTime = prefs.showTime;
  renderLabel();
});

// 初始状态
window.pet.onState(applyState);

// —— 热区命中判断：居中圆角矩形 ——
const hotzoneCS = getComputedStyle(document.documentElement);

function insideHotzone(px, py) {
  const w = petEl.clientWidth;
  const h = petEl.clientHeight;

  const hl = parseFloat(hotzoneCS.getPropertyValue('--hotzone-left')) / 100 * w;
  const hr = parseFloat(hotzoneCS.getPropertyValue('--hotzone-right')) / 100 * w;
  const ht = parseFloat(hotzoneCS.getPropertyValue('--hotzone-top')) / 100 * h;
  const hb = parseFloat(hotzoneCS.getPropertyValue('--hotzone-bottom')) / 100 * h;
  const r  = parseFloat(hotzoneCS.getPropertyValue('--hotzone-radius')) / 100 * (w - hl - hr);

  const left   = hl;
  const right  = w - hr;
  const top    = ht;
  const bottom = h - hb;

  // 在矩形外
  if (px < left || px > right || py < top || py > bottom) return false;

  // 四个圆角区域检测
  if (px < left + r && py < top + r) {
    const dx = px - (left + r), dy = py - (top + r);
    if (dx * dx + dy * dy > r * r) return false;
  }
  if (px > right - r && py < top + r) {
    const dx = px - (right - r), dy = py - (top + r);
    if (dx * dx + dy * dy > r * r) return false;
  }
  if (px < left + r && py > bottom - r) {
    const dx = px - (left + r), dy = py - (bottom - r);
    if (dx * dx + dy * dy > r * r) return false;
  }
  if (px > right - r && py > bottom - r) {
    const dx = px - (right - r), dy = py - (bottom - r);
    if (dx * dx + dy * dy > r * r) return false;
  }

  return true;
}

// 交互（点击穿透、光标、拖拽）
let dragging = false;
let cursorInHotzone = false;

function updateCursor(e) {
  const inZone = insideHotzone(e.offsetX, e.offsetY);
  if (inZone === cursorInHotzone) return;
  cursorInHotzone = inZone;
  if (dragging) return; // 拖拽中不切换光标
  petEl.style.cursor = inZone ? 'grab' : 'default';
}

petEl.addEventListener('mouseenter', (e) => {
  window.pet.setInteractive(true);
  updateCursor(e);
});
petEl.addEventListener('mousemove', updateCursor);
petEl.addEventListener('mouseleave', () => {
  cursorInHotzone = false;
  if (!dragging) window.pet.setInteractive(false);
});

petEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (!insideHotzone(e.offsetX, e.offsetY)) return;
  dragging = true;
  petEl.style.cursor = 'grabbing';
  window.pet.dragStart();
  e.preventDefault();
});
window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  petEl.style.cursor = cursorInHotzone ? 'grab' : 'default';
  window.pet.dragEnd();
});
petEl.addEventListener('contextmenu', (e) => { e.preventDefault(); window.pet.showMenu(); });

video.request('idle.webm');
