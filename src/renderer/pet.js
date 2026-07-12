// 渲染层：状态 → 视频交叉淡入切换、locale 感知 label、点击穿透切换、去抖（§8）。
const ANIM_BASE = '../../assets/anim/';
const petEl = document.getElementById('pet');
const labelEl = document.getElementById('label');
const layers = [document.getElementById('videoA'), document.getElementById('videoB')];

// 耗材改色 overlay：每个视频层各配一个（见 recolor.js / index.html 的 video+canvas 配对）。
const overlays = [
  createRecolorOverlay(layers[0], document.getElementById('overlayA')),
  createRecolorOverlay(layers[1], document.getElementById('overlayB')),
];

// 视频切换由并发安全、防抖不可饿死的控制器统一负责（见 crossfade.js）。
// onLayerChange：某层装载新视频时，据该层的文件配置它自己的 overlay —— 这样改色跟随
// 「各层实际显示的视频」，切换时机与视频完全一致（不会因 state 提前变化而露出原始绿）。
const video = createVideoController(layers, {
  base: ANIM_BASE,
  onLayerChange: (idx, file) => setOverlayForLayer(idx, file),
});

// Locale
let localeStrings = {};
let currentLocale = 'zh-CN';
let lastPetState = null; // 最近一次 printer state，用于 locale / 偏好切换时重绘

// 「显示层数 / 显示剩余时间」开关（外观页，默认关）——决定标签是否拼出第 2、3 行。
let showLayer = false;
let showTime = false;
// 「显示完成时间」开关（外观页，默认关）——打印中按本机时区显示预计完成时刻。
let showFinishTime = false;
// 「跟随耗材颜色」开关（外观页，默认开）——打印中动画的绿色耗材/竹子改成当前耗材色。
let matchFilamentColor = true;

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

// 预计完成时刻：当前时间 + 剩余分钟，按本机时区格式化为 24 小时制 HH:MM。
// getHours/getMinutes 天然使用运行电脑的本地时区，符合「按用户电脑时区展示」的诉求。
function fmtFinishClock(remainMins) {
  if (!Number.isFinite(remainMins) || remainMins <= 0) return null;
  const d = new Date(Date.now() + remainMins * 60000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// 拼单行标签，紧凑平级：主体是状态本身（打印中时即「打印中 {p}%」）；打印中且开关开启时，
// 用统一的「 · 」把层数段、剩余时间段平级追加，例：
//   中文 打印中 50% · 100/200 · 剩余45m    英文 Printing 50% · 100/200 · 45m left
// 「剩余」只贴在时间段上（层数是当前/总层，不属于「剩余」）。层数段在渲染层直接拼 {layer}/{total}；
// 时间段由 label.remainTime 定文案。标签恒为一行、不向上生长盖住熊猫。
// 数据由 resolveState 放进 labelParams（remain 已是 locale 无关的紧凑 token），切 locale / 切开关都能就地重绘。
function renderLabel() {
  if (!lastPetState) return;
  const p = lastPetState.labelParams || {};
  const parts = [t(currentLocale, lastPetState.labelKey, p)];
  if (showLayer && p.layer != null && p.total != null) parts.push(`${p.layer}/${p.total}`);
  if (showTime && p.remain != null) parts.push(t(currentLocale, 'label.remainTime', { time: p.remain }));
  if (showFinishTime && p.remainMins != null) {
    const clock = fmtFinishClock(p.remainMins);
    if (clock) parts.push(t(currentLocale, 'label.finishTime', { time: clock }));
  }
  labelEl.textContent = parts.join(' · ');
  reportLabelWidth();
}

// 量出标签实际像素宽度，上报主进程按需加宽窗口 —— 这样长标签能完整显示，
// 既不缩小用户设定的字号，也不截断成「…」。隐藏标签时上报 0，窗口回落到熊猫本身宽度。
// +14px：给 pill 两侧留一点呼吸空隙（与 CSS max-width 的 12px 边距配合，确保不触发 ellipsis）。
const LABEL_WIN_MARGIN = 14;
function reportLabelWidth() {
  const hidden = labelEl.classList.contains('hidden');
  // requestAnimationFrame：等本次文本改动完成布局后再量，scrollWidth 才是真实内容宽
  requestAnimationFrame(() => {
    const w = hidden ? 0 : Math.ceil(labelEl.scrollWidth) + LABEL_WIN_MARGIN;
    window.pet.setLabelWidth(w);
  });
}

function applyState(state) {
  if (!state) return;
  lastPetState = state;
  // 标签同步刷新；视频经控制器切换（去重 + 尾沿防抖 + 并发安全）。
  renderLabel();
  video.request(state.videoFile);
  refreshOverlays();
}

// 给某个视频层的 overlay 定色：仅当「跟随开关开 + 该层是打印动画 + 已知耗材色」时着色，
// 否则清空（露出原始素材）。file 用该层实际装载的视频，保证改色与视频显示严格同步。
function setOverlayForLayer(idx, file) {
  const s = lastPetState;
  const on = matchFilamentColor && s && s.filamentColor
    && typeof file === 'string' && file.startsWith('printing_');
  overlays[idx].setColor(on ? s.filamentColor : null);
}

// 按各层当前装载的文件刷新两个 overlay。用于耗材色/开关变化（视频未切换）时就地生效；
// 视频切换的时机由 onLayerChange 单独驱动。
function refreshOverlays() {
  for (let i = 0; i < layers.length; i++) setOverlayForLayer(i, video.getLayerFile(i));
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
  if (prefs.showFinishTime != null) showFinishTime = prefs.showFinishTime;
  if (prefs.matchFilamentColor != null) matchFilamentColor = prefs.matchFilamentColor;
  renderLabel();
  refreshOverlays(); // 开关变化就地生效，无需等下一帧状态
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
