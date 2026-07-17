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

// 预计完成时刻：当前时间 + 剩余分钟。用 toLocaleTimeString（不传 locale → 取系统默认
// locale）格式化为「时:分」，因此时区、以及 12 小时制(AM/PM) / 24 小时制的选择都跟随
// 运行电脑的系统设置——习惯 AM/PM 的用户会看到「2:30 PM」，24 小时制则是「14:30」。
function fmtFinishClock(remainMins) {
  if (!Number.isFinite(remainMins) || remainMins <= 0) return null;
  const d = new Date(Date.now() + remainMins * 60000);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// 拼一行的**状态文案**（不含打印机名）：主体是状态本身（打印中时即「打印中 {p}%」）；
// 打印中且开关开启时，用统一的「 · 」把层数段、剩余时间段平级追加，例：
//   中文 打印中 50% · 100/200 · 剩余45m    英文 Printing 50% · 100/200 · 45m left
// 「剩余」只贴在时间段上（层数是当前/总层，不属于「剩余」）。层数段在渲染层直接拼 {layer}/{total}；
// 时间段由 label.remainTime 定文案。打印机名由 renderLabel 单独渲染（带专属分隔符）。
// 数据由 resolveState 放进 labelParams（remain 已是 locale 无关的紧凑 token），切 locale / 切开关都能就地重绘。
function statusText(line) {
  const p = line.labelParams || {};
  const parts = [t(currentLocale, line.labelKey, p)];
  if (showLayer && p.layer != null && p.total != null) parts.push(`${p.layer}/${p.total}`);
  if (showTime && p.remain != null) parts.push(t(currentLocale, 'label.remainTime', { time: p.remain }));
  if (showFinishTime && p.remainMins != null) {
    const clock = fmtFinishClock(p.remainMins);
    if (clock) parts.push(t(currentLocale, 'label.finishTime', { time: clock }));
  }
  return parts.join(' · ');
}

// 「熊猫此刻演的是哪台」——注意力那台的状态若属需要处理类（失败/暂停/离线/登录失效），
// 高亮竖条取红色示警，否则取竹叶绿表「正常运转」。多台并存时用户扫一眼颜色即知要不要管。
const ERR_STATES = new Set(['failed', 'paused', 'offline', 'authExpired']);

// 渲染标签：每台打印机一行（state.lines，见 core/attention.js），单台时一行且不带名字
// —— 与单打印机时代观感一致。无 lines（过渡兼容）时回落用顶层 labelKey 拼单行。
// 多台时给「熊猫当前表达的那台」（activeSerial）加高亮竖条，其余行压暗——让用户看得出
// 熊猫的动画/表情说的是哪一台（否则多行长得一样、无从分辨）。
let lastLabelSig = null;
function renderLabel() {
  if (!lastPetState) return;
  const lines = Array.isArray(lastPetState.lines) && lastPetState.lines.length > 0
    ? lastPetState.lines
    : [{ name: null, labelKey: lastPetState.labelKey, labelParams: lastPetState.labelParams }];
  const multi = lines.length > 1;
  const activeSerial = lastPetState.activeSerial;
  // 渲染结果签名：决定标签显示的所有因素（各行名字/序列号/严重度/渲染文案 + 活动台 + locale）。
  // 内容未变则不重建 DOM —— 否则每次状态推送（打印中约每秒）都会重建、把 marquee 动画重置到
  // 起点，滚动永远滚不起来。相同即直接返回，保留现有 DOM 与正在进行的滚动。
  const sig = JSON.stringify(lines.map((l) => [
    l.name || null, l.serial || null, l.stateKey || null, statusText(l),
    multi && l.serial != null && l.serial === activeSerial,
  ]));
  if (sig === lastLabelSig) return;
  lastLabelSig = sig;
  labelEl.textContent = '';
  labelEl.classList.toggle('multi', multi);
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'label-line';
    if (multi && line.serial != null && line.serial === activeSerial) {
      div.classList.add('active');
      div.classList.add(ERR_STATES.has(line.stateKey) ? 'sev-err' : 'sev-ok');
    }
    // 行内容包两层：.line-vp 是**从左侧竖线右侧开始**的裁剪视口（竖线在视口之外的左槽里，
    // 内容永不进入其区域），.line-inner 是被裁部分做横向滚动（marquee）的内容层。窗口宽固定
    // 为熊猫宽，超宽的行由 applyMarquee 给 inner 加往返平移，滚出全貌而不撑宽窗口、不截断。
    const vp = document.createElement('span');
    vp.className = 'line-vp';
    const inner = document.createElement('span');
    inner.className = 'line-inner';
    // 打印机名与状态之间用专属分隔符（竖条），区别于状态内部用的「 · 」——
    // 否则名字和后面的状态段全用点串起来，一眼看不出名字到哪结束。
    if (line.name) {
      const nameEl = document.createElement('span');
      nameEl.className = 'label-name';
      nameEl.textContent = line.name;
      const sepEl = document.createElement('span');
      sepEl.className = 'label-sep';
      sepEl.textContent = '›';
      inner.append(nameEl, sepEl, document.createTextNode(statusText(line)));
    } else {
      inner.textContent = statusText(line);
    }
    vp.appendChild(inner);
    div.appendChild(vp);
    labelEl.appendChild(div);
  }
  reportLabelSize();
}

// 超宽的行做横向滚动（marquee）：窗口宽固定=熊猫宽，pill 经 CSS max-width 卡在窗口内，
// 视口 .line-vp 内容超出时给 .line-inner 施加往返平移，把被裁部分滚出来看全，不截断。
// 竖线在视口左侧的独立槽里、不在裁剪区内，故滚动内容不会与竖线重叠。
// 需在布局落定后测量（reportLabelSize 的 rAF 里调用）。滚动距离 = 视口内容溢出量。
//
// 时间轴：**起点停 REST(固定) → 滚出 tScroll(按最大距离) → 末端停 ENDPAUSE(固定) → 滚回 tScroll**，
// 循环。REST/ENDPAUSE 是固定秒数（不随内容长短变），故每轮之间在起点明显停一段再滚下一轮。
// 因固定停顿使关键帧百分比依赖动态的 tScroll，改由 JS 算好百分比注入 @keyframes（覆盖 css 里的
// 静态兜底那份）。多行共用同一 total 与同一注入 keyframes → **整体同步**（同时起/停/回，不漂移）。
const MARQUEE_SPEED = 45;      // px/s 滚动速度
const MARQUEE_REST = 2.2;      // s 起点停顿（每轮之间停这么久）
const MARQUEE_ENDPAUSE = 0.9;  // s 滚到底后的停顿
let marqueeStyleEl = null;
function applyMarquee() {
  const vps = [...labelEl.querySelectorAll('.line-vp')];
  const overs = vps.map((vp) => vp.scrollWidth - vp.clientWidth);
  const maxOver = Math.max(0, ...overs);
  const tScroll = maxOver / MARQUEE_SPEED;
  const total = MARQUEE_REST + tScroll + MARQUEE_ENDPAUSE + tScroll;
  const durStr = total.toFixed(2) + 's';
  vps.forEach((vp, i) => {
    const line = vp.parentElement;
    if (overs[i] > 1) {
      line.classList.add('scroll');
      line.style.setProperty('--dist', overs[i] + 'px');
      line.style.setProperty('--dur', durStr);
    } else {
      line.classList.remove('scroll');
      line.style.removeProperty('--dist');
      line.style.removeProperty('--dur');
    }
  });
  if (maxOver <= 1) return; // 无超宽行，无需注入动画
  const a = (MARQUEE_REST / total * 100).toFixed(2);
  const b = ((MARQUEE_REST + tScroll) / total * 100).toFixed(2);
  const c = ((MARQUEE_REST + tScroll + MARQUEE_ENDPAUSE) / total * 100).toFixed(2);
  if (!marqueeStyleEl) { marqueeStyleEl = document.createElement('style'); document.head.appendChild(marqueeStyleEl); }
  marqueeStyleEl.textContent =
    `@keyframes label-marquee{0%,${a}%{transform:translateX(0)}${b}%,${c}%{transform:translateX(calc(-1*var(--dist,0px)))}100%{transform:translateX(0)}}`;
}

// 量出标签实际像素尺寸，上报主进程按需加宽/向下加高窗口 —— 长标签完整显示、多行放得下，
// 既不缩小用户设定的字号，也不截断成「…」。隐藏标签时上报 0，窗口回落到熊猫本身尺寸。
// 宽度 +14px：给 pill 两侧留一点呼吸空隙（与 CSS max-width 的 12px 边距配合，确保不触发 ellipsis）。
const LABEL_WIN_MARGIN = 14;
function reportLabelSize() {
  const hidden = labelEl.classList.contains('hidden');
  // requestAnimationFrame：等本次文本改动完成布局后再量，scrollWidth/offsetHeight 才是真实尺寸
  requestAnimationFrame(() => {
    if (!hidden) applyMarquee(); // 布局落定后判定各行是否需横向滚动
    window.pet.setLabelSize({
      w: hidden ? 0 : Math.ceil(labelEl.scrollWidth) + LABEL_WIN_MARGIN,
      h: hidden ? 0 : Math.ceil(labelEl.offsetHeight),
    });
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
  lastLabelSig = null; // 强制重建（文案随语言变）
  renderLabel();
});

// 偏好更新
window.pet.onPrefs((prefs) => {
  if (prefs.sizePx != null) {
    // 熊猫方形边长（--pet-px）：窗口可因多行标签比方形更高，100vh 不再恒等于边长，
    // 熊猫几何（.pet 宽高、标签带位置）都以此变量为准。
    document.documentElement.style.setProperty('--pet-px', prefs.sizePx + 'px');
  }
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
  // 字号 / 熊猫尺寸变会改变标签宽与滚动上限，但不改文案签名 → 强制重建以重新测量 marquee。
  lastLabelSig = null;
  renderLabel();
  refreshOverlays(); // 开关变化就地生效，无需等下一帧状态
});

// 初始状态
window.pet.onState(applyState);

// —— 命中判断：覆盖熊猫身体的居中圆角矩形（拖动熊猫本身，见 style.css --hotzone-*） ——
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
// 核心：窗口默认点击穿透（main.js 启动即 setIgnoreMouseEvents(true,{forward:true})，故穿透
// 态下仍收到转发的 mousemove）。只有指针落在熊猫身体（insideHotzone，身体轮廓的圆角矩形）
// 上时才关闭穿透、可按住拖动/右键；离开身体立即恢复穿透，窗口的透明边距不遮挡下层点击。
// 与 clawd-on-desk 一致：拖动的是熊猫本身，命中区即身体 hitBox。
let dragging = false;
let cursorInHotzone = false;
let lastInteractive = false; // 去重：仅在穿透态变化时发 IPC，避免每帧 mousemove 刷屏

function applyInteractive(on) {
  if (on === lastInteractive) return;
  lastInteractive = on;
  window.pet.setInteractive(on);
}

function updateCursor(e) {
  const inZone = insideHotzone(e.offsetX, e.offsetY);
  if (inZone === cursorInHotzone) return;
  cursorInHotzone = inZone;
  if (dragging) return; // 拖拽中不切换光标/穿透（拖出身体也保持可交互，靠 dragTimer 跟随光标）
  applyInteractive(inZone); // 进入身体→关闭穿透可交互；离开→恢复穿透，点击落到下层
  petEl.style.cursor = inZone ? 'grab' : 'default';
}

petEl.addEventListener('mouseenter', updateCursor);
petEl.addEventListener('mousemove', updateCursor);
petEl.addEventListener('mouseleave', () => {
  cursorInHotzone = false;
  if (!dragging) { applyInteractive(false); petEl.style.cursor = 'default'; }
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
  // 拖拽落定：据当前是否仍在熊猫身体上恢复光标与穿透态
  petEl.style.cursor = cursorInHotzone ? 'grab' : 'default';
  applyInteractive(cursorInHotzone);
  window.pet.dragEnd();
});
petEl.addEventListener('contextmenu', (e) => {
  if (!insideHotzone(e.offsetX, e.offsetY)) return; // 身体外的右键让它穿透到下层
  e.preventDefault();
  window.pet.showMenu();
});

video.request('idle.webm');
