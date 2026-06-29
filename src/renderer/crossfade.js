// 渲染层视频控制器：负责「状态 → 视频」的交叉淡入切换。
// 从 pet.js 抽出，修复探索→真机切换后熊猫卡在 offline 的 bug，并便于单测。
//
// 两个历史缺陷（与标签解耦导致显示对不上）：
//   1) 防抖被"饿死"：原实现每帧 clearTimeout+重置一次性定时器；真机 pushall
//      突发多帧（间隔 < holdMs）时，定时器被无限重置，crossfade 永不触发，
//      视频停在切换瞬间注入的 offline，而标签每帧同步刷新成"打印中"。
//      → 改为「突发内只调度一次、用最后一帧的目标」的尾沿防抖，不可被饿死。
//   2) crossfade 非并发安全：重入时复用同一 incoming 层却叠加多个 canplay 监听，
//      触发时 activeIndex 双翻转 / 监听泄漏；且只听 canplay 不听 error，
//      视频加载失败即永久卡死（currentVideoFile 已被提前占用，后续同名帧被去重跳过）。
//      → 改为：重入先 cancel 上一个挂起切换；只在切换真正完成时翻转 activeIndex；
//        监听 error 做恢复；目标文件仅在落定后才视为"已显示"。

function createVideoController(layers, opts = {}) {
  const base = opts.base || '';
  const holdMs = opts.holdMs != null ? opts.holdMs : 250;
  const fadeMs = opts.fadeMs != null ? opts.fadeMs : 400;
  const setT = opts.setTimeout || setTimeout;
  const clearT = opts.clearTimeout || clearTimeout;
  const onError = typeof opts.onError === 'function' ? opts.onError : null;

  let activeIndex = 0;
  let displayedFile = null; // 当前 active 层实际显示的文件
  let targetFile = null;    // 最新「已显示或正在切入」的目标文件（用于去重）
  let pending = null;       // 进行中的切换：{ teardown }
  let cleanupTimer = null;  // 切换完成后延迟清理「旧 outgoing」src 的定时器句柄
  let debounceTimer = null;
  let debounceTarget = null;

  if (layers[activeIndex] && layers[activeIndex].classList) {
    layers[activeIndex].classList.add('active');
  }

  function cancelPending() {
    if (pending) { pending.teardown(); pending = null; }
  }

  // 实际执行一次交叉淡入。并发安全：重入会先取消上一个挂起切换。
  function to(file) {
    if (file === targetFile) return; // 已显示 / 正在切入同一文件
    targetFile = file;
    cancelPending();
    // 取消上一次切换安排的延迟清理：incoming 即将被复用并写入新 src，
    // 若让陈旧 cleanup 触发会把正在加载的入场层 src 抹掉 → 视频卡死、与标签不同步。
    if (cleanupTimer != null) { clearT(cleanupTimer); cleanupTimer = null; }

    const incoming = layers[1 - activeIndex];
    const outgoing = layers[activeIndex];

    const teardown = () => {
      incoming.removeEventListener('canplay', onReady);
      incoming.removeEventListener('error', onErr);
    };
    const onReady = () => {
      teardown();
      pending = null;
      incoming.play && incoming.play().catch(() => {});
      incoming.classList.add('active');
      outgoing.classList.remove('active');
      activeIndex = 1 - activeIndex;
      displayedFile = file;
      cleanupTimer = setT(() => {
        cleanupTimer = null;
        if (!outgoing.classList.contains('active')) {
          outgoing.removeAttribute('src');
          outgoing.load();
        }
      }, fadeMs);
    };
    const onErr = () => {
      teardown();
      pending = null;
      // 加载失败：放开去重锁，让后续同名帧能重试，避免永久卡死。
      if (targetFile === file) targetFile = displayedFile;
      if (onError) onError(file);
    };

    incoming.addEventListener('canplay', onReady);
    incoming.addEventListener('error', onErr);
    pending = { teardown };
    incoming.src = base + file;
    incoming.load();
  }

  // 对外入口：尾沿防抖，突发内只调度一次、用最后一帧目标，不可被饿死。
  function request(file) {
    debounceTarget = file;
    if (debounceTimer != null) return;
    debounceTimer = setT(() => {
      debounceTimer = null;
      to(debounceTarget);
    }, holdMs);
  }

  return {
    request,
    // 测试/调试用
    getActiveIndex: () => activeIndex,
    getDisplayedFile: () => displayedFile,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createVideoController };
}
if (typeof window !== 'undefined') {
  window.createVideoController = createVideoController;
}
