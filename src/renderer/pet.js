// 渲染层：状态 → 视频交叉淡入切换、label 更新、点击穿透切换、去抖（§8）。

const ANIM_BASE = '../../assets/anim/';

const petEl = document.getElementById('pet');
const labelEl = document.getElementById('label');
const layers = [document.getElementById('videoA'), document.getElementById('videoB')];

let activeIndex = 0;        // 当前显示中的 layer
let currentVideoFile = null; // 当前正在播的 webm 文件名
let switchTimer = null;     // 去抖定时器

// 预设第一个 layer 为 active（透明视频，等首帧）
layers[activeIndex].classList.add('active');

/**
 * 交叉淡入切换到新视频。若与当前同一文件则跳过（避免重载打断 loop）。
 */
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
    // 旧层淡出后清空 src 释放解码资源
    setTimeout(() => {
      if (!outgoing.classList.contains('active')) {
        outgoing.removeAttribute('src');
        outgoing.load();
      }
    }, 400);
  };
  incoming.addEventListener('canplay', onReady);
}

/**
 * 收到状态：更新 label（即时），视频切换走去抖（避免临界进度抖动，§8）。
 */
function applyState(state) {
  if (!state) return;
  // label 即时更新（信息通道，不去抖）
  labelEl.textContent = state.label;

  // 视频切换去抖：250ms 内的连续切换只取最后一次
  if (switchTimer) clearTimeout(switchTimer);
  switchTimer = setTimeout(() => {
    crossfadeTo(state.videoFile);
  }, 250);
}

window.pet.onState(applyState);

// ---- 点击穿透切换（§5.1）----
// 鼠标进入熊猫实体区 → 关闭穿透（可拖拽/点击）；离开 → 恢复穿透。
let dragging = false;
petEl.addEventListener('mouseenter', () => window.pet.setInteractive(true));
petEl.addEventListener('mouseleave', () => {
  if (!dragging) window.pet.setInteractive(false);
});

// ---- 拖拽（§5.1 / §9）----
// 透明 frameless 窗上 -webkit-app-region:drag 不可靠，改为手动拖拽：
// mousedown 通知主进程开始跟随光标，mouseup 结束并记忆位置。
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

// ---- 右键宠物 → 上下文菜单（跨平台主入口，§5.2）----
petEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.pet.showMenu();
});

// 启动兜底：若主进程尚未推状态，先显示离线占位视频（若存在）
crossfadeTo('idle.webm');
