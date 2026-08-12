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
// 24/12 小时制：由主进程读 macOS「AppleICUForce24HourTime」下发（false=24 小时、true=12 小时、
// undefined=跟随 locale）。Chromium 的 Intl 读不到该系统开关，必须显式传入才能跟随系统。
let sysHour12;

// locale 表在渲染层只用于**状态文案拼接**，那段逻辑与设置窗的效果预览共用同一份纯函数
// （core/label-text.js，经 <script> 挂在 window 上）。这里只负责把「此刻的上下文」凑齐。
function statusText(line) {
  return buildStatusText(line, {
    strings: localeStrings,   // 形状本就是 { 'zh-CN': {...}, en: {...} }，与 buildStatusText 期望一致
    locale: currentLocale,
    showLayer,
    showTime,
    showFinishTime,
    hour12: sysHour12,
    now: Date.now(),
  });
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
  // 内容未变则不重建 DOM —— 打印中状态约每秒推一次，逐帧重建整块标签纯属无谓开销。
  // 相同即直接返回，保留现有 DOM。
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
    // 行内容装两层：.line-vp 是**从左侧竖线右侧开始**的单行裁剪视口（竖线在视口之外的左槽里，
    // 文本永不进入其区域），窗口宽固定为熊猫宽，放不下就在这里以「…」收尾 —— 不折行、
    // 不撑宽窗口，也不缩用户设定的字号。
    // .line-inner 平时是 display:inline、对布局完全透明（省略号照常由 vp 那层出），只有悬停
    // 轮播时才变成 inline-block 承载横向平移 —— marquee 需要一个能整体 transform 的元素。
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
      inner.append(nameEl, sepEl);
    }
    inner.appendChild(document.createTextNode(statusText(line)));
    vp.appendChild(inner);
    div.appendChild(vp);
    labelEl.appendChild(div);
  }
  // 滚动中重建（文案变了）：新 DOM 是收拢态，重新摘省略号接着滚，否则滚动会中途消失；
  // 没在滚则问一次——自动档下这是首帧起滚的入口。
  if (scrolling) applyScroll(); else refreshScroll();
  reportLabelSize();
}

// ============ 文案放不下时怎么滚 ============
// 标签恒每台一行，放不下就以「…」收尾。被截掉的那半句怎么补回来，由外观页的
// 「文案放不下时」二选一决定（labelScroll）：
//   'hover'（默认）—— 平时纹丝不动，指针停在熊猫身体或标签上才滚一遍，移开立刻停。
//                      桌宠常驻视野边缘，默认就该安静；想看时把鼠标放上去即可。
//   'auto'          —— 常驻轮播，自己一直滚。给「就想瞟一眼、不想动鼠标」的人。
// 两档共用同一套摊开 + marquee 实现，只是「什么时候该滚」的判定不同（wantScroll）。
//
// 悬停判定用「熊猫身体热区（insideHotzone）」或「标签 pill 的矩形」，两者都算数——
// 用户想看文案时最自然的动作就是把鼠标挪到文案上，而 pill 是 pointer-events:none 且整窗
// 默认点击穿透，收不到自己的 mouseenter，只能靠 document 上转发来的 mousemove + 矩形判定。
// 全程不碰点击穿透状态：滚动只改观感，不该让标签开始拦下层应用的点击。
let labelScroll = 'hover';
const HOVER_INTENT_MS = 250;   // 停留这么久才起滚：路过熊猫不该触发（否则又变成到处在动）
// 离开后的宽限：熊猫与标签是两块独立热区，指针从熊猫滑到标签上时会先收到熊猫的 mouseleave、
// 再收到落在标签上的 mousemove。没有宽限就会「停一下再从头滚」，白白打断正在看的那一轮。
const HOVER_LEAVE_GRACE_MS = 120;
let labelRect = null;          // pill 的窗口内矩形，随每次量尺寸更新（避免每帧 getBoundingClientRect）
let hoverOnPet = false;        // 指针在熊猫身体热区内（由 updateCursor 维护）
let hoverOnLabel = false;      // 指针在标签 pill 矩形内
let startTimer = null;         // 停留计时（未到点就离开则作废）
let leaveTimer = null;         // 离开宽限计时（宽限内回来则继续滚，不重启动画）
let scrolling = false;         // 已进入滚动态

function pointerInLabel(e) {
  if (!labelRect || labelEl.classList.contains('hidden')) return false;
  return e.clientX >= labelRect.left && e.clientX <= labelRect.right
    && e.clientY >= labelRect.top && e.clientY <= labelRect.bottom;
}

// 这行是否真被 text-overflow 截掉了尾巴。没被截断的行悬停时保持原样不动 —— 全看得见
// 还滚，纯属多余的动。
// 名字要单独查：它有自己的 max-width（半行宽），可能名字已经截成「X1-Carbon-St…」
// 而整行并不溢出——只看 vp 会漏判，悬停时名字就还原不回来。
function isTruncated(vp) {
  if (vp.scrollWidth > vp.clientWidth + 1) return true;
  const name = vp.querySelector('.label-name');
  return name != null && name.scrollWidth > name.clientWidth + 1;
}

// 此刻该不该滚：自动档永远该滚；悬停档看指针在不在熊猫或标签上。
function wantScroll() {
  return labelScroll === 'auto' || hoverOnPet || hoverOnLabel;
}

function refreshScroll() {
  if (wantScroll()) {
    if (leaveTimer != null) { clearTimeout(leaveTimer); leaveTimer = null; }
    if (scrolling || startTimer != null) return;
    // 自动档没有「误触」可言，立刻起滚；悬停档要先确认这不是路过。
    if (labelScroll === 'auto') { startScroll(); return; }
    startTimer = setTimeout(() => { startTimer = null; startScroll(); }, HOVER_INTENT_MS);
  } else {
    if (startTimer != null) { clearTimeout(startTimer); startTimer = null; }
    if (scrolling && leaveTimer == null) {
      leaveTimer = setTimeout(() => { leaveTimer = null; stopScroll(); }, HOVER_LEAVE_GRACE_MS);
    }
  }
}

// 给被截断的行摘掉省略号 → 下一帧量溢出、起动画。测量必须等布局落定，故隔一帧。
function applyScroll() {
  let any = false;
  for (const line of labelEl.querySelectorAll('.label-line')) {
    const truncated = isTruncated(line.firstElementChild);
    line.classList.toggle('reveal', truncated);
    any = any || truncated;
  }
  // 一行都没被截断（例：单台且文案短）就当无事发生：不加提亮、不起动画。
  // 提亮只在悬停档给——那是「你的动作生效了」的反馈；自动档没人在等反馈，提亮反而是无谓的变化。
  labelEl.classList.toggle('hover', any && labelScroll === 'hover');
  if (!any) return;
  requestAnimationFrame(() => {
    if (!scrolling) return; // 这一帧之内指针已经走了
    applyMarquee();
    // 标签高度不会因滚动改变（恒每台一行），但名字还原后 pill 可能变宽 —— 重量一次好让
    // 悬停判定用的矩形跟上（labelRect 在这里更新）。
    reportLabelSize();
  });
}

function startScroll() {
  scrolling = true;
  applyScroll();
}

function stopScroll() {
  scrolling = false;
  labelEl.classList.remove('hover');
  for (const line of labelEl.querySelectorAll('.label-line')) {
    line.classList.remove('reveal', 'scroll');
    line.style.removeProperty('--dist');
    line.style.removeProperty('--dur');
  }
  reportLabelSize();
}

// 摊平后的超宽行做横向滚动（marquee）：视口 .line-vp 内容超出时给 .line-inner 施加往返平移，
// 把被裁部分滚出来看全。竖线在视口左侧的独立槽里、不在裁剪区内，故滚动内容不会与竖线重叠。
//
// 时间轴：**起点停 REST(固定) → 滚出 tScroll(按最大距离) → 末端停 ENDPAUSE(固定) → 滚回 tScroll**，
// 循环。REST/ENDPAUSE 是固定秒数（不随内容长短变），故每轮之间在起点明显停一段再滚下一轮。
// 因固定停顿使关键帧百分比依赖动态的 tScroll，改由 JS 算好百分比注入 @keyframes（覆盖 css 里的
// 静态兜底那份）。多行共用同一 total 与同一注入 keyframes → **整体同步**（同时起/停/回，不漂移）。
const MARQUEE_SPEED = 45;      // px/s 滚动速度
// 两档的节奏不一样：悬停是用户主动要看，起滚该快、末端该多停一会儿好把结尾看清；
// 自动档一直在跑，起点多停一段才不至于显得一刻不停。
const MARQUEE_TIMING = {
  hover: { rest: 1.0, endPause: 1.2 },
  auto: { rest: 2.2, endPause: 0.9 },
};
// 溢出小于该阈值不滚：几像素的微溢出去滚一圈毫无意义（观感是无谓抽动），
// 宁可裁掉那一点点（多为半个字符的边缘）也不做无意义动画。
const MARQUEE_MIN_OVER = 10;   // px
let marqueeStyleEl = null;
function applyMarquee() {
  const { rest, endPause } = MARQUEE_TIMING[labelScroll] || MARQUEE_TIMING.hover;
  const vps = [...labelEl.querySelectorAll('.label-line.reveal > .line-vp')];
  const overs = vps.map((vp) => vp.scrollWidth - vp.clientWidth);
  // 只有超过阈值的行才算「需要滚」；统一周期按这些行里的最大溢出定（同步）。
  const scrollOvers = overs.filter((o) => o >= MARQUEE_MIN_OVER);
  const maxOver = scrollOvers.length ? Math.max(...scrollOvers) : 0;
  const tScroll = maxOver / MARQUEE_SPEED;
  const total = rest + tScroll + endPause + tScroll;
  const durStr = total.toFixed(2) + 's';
  vps.forEach((vp, i) => {
    const line = vp.parentElement;
    if (overs[i] >= MARQUEE_MIN_OVER) {
      line.classList.add('scroll');
      line.style.setProperty('--dist', overs[i] + 'px');
      line.style.setProperty('--dur', durStr);
    } else {
      line.classList.remove('scroll');
      line.style.removeProperty('--dist');
      line.style.removeProperty('--dur');
    }
  });
  if (maxOver <= 0) return; // 无需滚动的行，不注入动画
  const a = (rest / total * 100).toFixed(2);
  const b = ((rest + tScroll) / total * 100).toFixed(2);
  const c = ((rest + tScroll + endPause) / total * 100).toFixed(2);
  if (!marqueeStyleEl) { marqueeStyleEl = document.createElement('style'); document.head.appendChild(marqueeStyleEl); }
  marqueeStyleEl.textContent =
    `@keyframes label-marquee{0%,${a}%{transform:translateX(0)}${b}%,${c}%{transform:translateX(calc(-1*var(--dist,0px)))}100%{transform:translateX(0)}}`;
}

// 指针在标签上与否要靠矩形判定（pill 收不到自己的鼠标事件，见上）。整窗默认点击穿透，
// 但 forward:true 会把 mousemove 转发进来，故 document 上拿得到。
document.addEventListener('mousemove', (e) => {
  const on = pointerInLabel(e);
  if (on === hoverOnLabel) return;
  hoverOnLabel = on;
  refreshScroll();
});
// 指针离开整个窗口：熊猫上的 mouseleave 只覆盖熊猫方形，从标签那侧移出去要靠这个收尾。
document.addEventListener('mouseleave', () => {
  hoverOnLabel = false;
  hoverOnPet = false;
  refreshScroll();
});

// 量出标签实际像素尺寸，上报主进程按需向下加高窗口 —— 多台时逐台一行、pill 向下生长，
// 加高才放得下（既不缩小用户设定的字号，也不让末行跑到窗口外被裁掉）。
// 单台恒一行，高度回落到熊猫方形本身预留的那条带里，窗口高与单打印机时代完全一致。
// 隐藏标签时上报 0，窗口回落到熊猫本身尺寸。
// 宽度 +14px：给 pill 两侧留一点呼吸空隙（主进程现已不据宽加宽窗口，保留上报仅为兼容）。
const LABEL_WIN_MARGIN = 14;
function reportLabelSize() {
  const hidden = labelEl.classList.contains('hidden');
  // requestAnimationFrame：等本次文本改动完成布局后再量，scrollWidth/offsetHeight 才是真实尺寸
  requestAnimationFrame(() => {
    // 顺手缓存 pill 矩形：悬停判定每次 mousemove 都要用它，不能每帧现算（会强制回流）。
    labelRect = hidden ? null : labelEl.getBoundingClientRect();
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
  if (prefs.labelScroll != null && prefs.labelScroll !== labelScroll) {
    labelScroll = prefs.labelScroll;
    // 换档时**立刻**收干净再按新档重来，不走离开宽限：用户在设置页点一下就该马上看到新样子，
    // 且旧档注入的 marquee 节奏（起点/末端停顿）必须作废。这段要赶在下面的 renderLabel 之前，
    // 否则重建后 scrolling 还是 true，会照着旧档再摊开一次。
    if (startTimer != null) { clearTimeout(startTimer); startTimer = null; }
    if (leaveTimer != null) { clearTimeout(leaveTimer); leaveTimer = null; }
    if (scrolling) stopScroll();
    refreshScroll(); // 自动档就地起滚；悬停档若指针正停在熊猫上也会起
  }
  if (prefs.matchFilamentColor != null) matchFilamentColor = prefs.matchFilamentColor;
  // hour12 可正当为 undefined（跟随 locale），用 'in' 判定而非 != null。
  if ('hour12' in prefs) sysHour12 = prefs.hour12;
  // 字号变会改变每行高度（进而标签总高与 pill 矩形），熊猫尺寸变会改变标签的可用宽度，
  // 但两者都不改文案签名 → 强制重建，好让 reportLabelSize 重新量一次把新高度报给主进程
  // （否则签名相同会直接返回，窗口高度停在旧字号上、末行被裁），顺带刷新悬停判定用的矩形。
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
  hoverOnPet = inZone;      // 指到熊猫身上 = 想看它，标签跟着起滚（见 refreshScroll）
  refreshScroll();
  if (dragging) return; // 拖拽中不切换光标/穿透（拖出身体也保持可交互，靠 dragTimer 跟随光标）
  applyInteractive(inZone); // 进入身体→关闭穿透可交互；离开→恢复穿透，点击落到下层
  petEl.style.cursor = inZone ? 'grab' : 'default';
}

petEl.addEventListener('mouseenter', updateCursor);
petEl.addEventListener('mousemove', updateCursor);
petEl.addEventListener('mouseleave', () => {
  cursorInHotzone = false;
  hoverOnPet = false;
  refreshScroll();
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
