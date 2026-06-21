// 渲染层：状态 → 视频交叉淡入切换、locale 感知 label、点击穿透切换、去抖（§8）。
const ANIM_BASE = '../../assets/anim/';
const petEl = document.getElementById('pet');
const labelEl = document.getElementById('label');
const layers = [document.getElementById('videoA'), document.getElementById('videoB')];

let activeIndex = 0;
let currentVideoFile = null;
let switchTimer = null;

// Locale
let localeStrings = {};
let currentLocale = 'zh-CN';

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

layers[activeIndex].classList.add('active');

function crossfadeTo(videoFile) {
  if (videoFile === currentVideoFile) return;
  currentVideoFile = videoFile;
  const incoming = layers[1 - activeIndex];
  const outgoing = layers[activeIndex];
  incoming.src = ANIM_BASE + videoFile;
  incoming.load();
  const onReady = () => {
    incoming.removeEventListener('canplay', onReady);
    incoming.play().catch(() => {});
    incoming.classList.add('active');
    outgoing.classList.remove('active');
    activeIndex = 1 - activeIndex;
    setTimeout(() => {
      if (!outgoing.classList.contains('active')) { outgoing.removeAttribute('src'); outgoing.load(); }
    }, 400);
  };
  incoming.addEventListener('canplay', onReady);
}

function applyState(state) {
  if (!state) return;
  labelEl.textContent = t(currentLocale, state.labelKey, state.labelParams);
  if (switchTimer) clearTimeout(switchTimer);
  switchTimer = setTimeout(() => { crossfadeTo(state.videoFile); }, 250);
}

// Locale 更新
window.pet.onLocale((locale, strings) => {
  currentLocale = locale;
  localeStrings = { [locale]: strings };
});

// 偏好更新
window.pet.onPrefs((prefs) => {
  if (prefs.labelFontSize != null) {
    labelEl.style.setProperty('--label-font-size', prefs.labelFontSize + 'px');
  }
  if (prefs.showLabel != null) {
    labelEl.classList.toggle('hidden', !prefs.showLabel);
  }
});

// 初始状态
window.pet.onState(applyState);

// 交互
petEl.addEventListener('mouseenter', () => window.pet.setInteractive(true));
petEl.addEventListener('mouseleave', () => { if (!dragging) window.pet.setInteractive(false); });

let dragging = false;
petEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  window.pet.dragStart();
  e.preventDefault();
});
window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  window.pet.dragEnd();
});
petEl.addEventListener('contextmenu', (e) => { e.preventDefault(); window.pet.showMenu(); });

crossfadeTo('idle.webm');
