// 状态稳定器：抑制「开印 / 状态切换瞬间」多字段错位产生的一帧级抖动（纯逻辑，时间由外部传入，便于单测）。
//
// 背景：真机 MQTT 是**增量报文**，开印时 gcode_state / stg_cur / layer_num / mc_percent 等顶层字段
// 在相邻帧间先后翻转，中间会出现「部分字段已更新、部分仍残留上一次的值」的自相矛盾帧，被 resolveState
// 解析成一闪而过的错误状态。已知三例都属此类：
//   · 准备中 → 打印中(闪) → 准备中（stg_cur 短暂回落 0）
//   · 开印瞬间闪现「完成」（gcode_state 残留上一次 FINISH）
//   · SLICING 未处理时闪「空闲」
// 这些错状态都只持续约 1 帧。逐个用「物理不可能性」在纯函数里兜是一层防线；这里再加一层统一的
// 时间维度防抖，兜住尚未枚举到的同类变体。
//
// 策略（低延迟去抖）：
//   1. 与当前显示**同 stateKey** 的帧 → 立即刷新（进度百分比 / 剩余时间 / 准备子阶段文案照常实时更新，无延迟）。
//   2. 出现一个**不同**的新 stateKey → 先置为「待定」，暂不显示；需要被下一帧**再次确认**（连续两帧同 key）
//      才提交。只闪 1 帧、随即被改回原态的抖动因此不会显示。
//   3. 为兼顾「真状态出现后打印机随即静默、不再发帧」的情形，另设兜底窗口 settleMs：待定态持续到窗口结束
//      即提交（由调用方在 settleAt 时刻回调 tick）。
//   4. 首帧立即显示，不引入初始延迟。
//
// 注意：仅用于**真机 live** 路径。mock（把玩）演示要即时忠实地反映所选场景，不走稳定器。

const DEFAULT_SETTLE_MS = 2000;

class StateStabilizer {
  constructor({ settleMs = DEFAULT_SETTLE_MS } = {}) {
    this._settleMs = settleMs;
    this._shown = null; // { key, state } 当前对外显示
    this._pending = null; // { key, state, since } 待确认的新状态
  }

  _keyOf(state) {
    return state && state.stateKey != null ? state.stateKey : null;
  }

  /**
   * 记录一帧新解析状态。
   * @returns {{ state: object, settleAt: (number|null) }}
   *   state    —— 当前应显示的状态对象
   *   settleAt —— 若存在待定态，调用方需在该时刻回调 tick() 兜底提交；否则 null
   */
  observe(state, now) {
    const key = this._keyOf(state);

    // 首帧：立即显示，不延迟初始渲染。
    if (!this._shown) {
      this._shown = { key, state };
      this._pending = null;
      return { state, settleAt: null };
    }

    // 与当前显示同态：仅刷新内容（百分比 / 文案 / 耗材色），立即生效。
    if (key === this._shown.key) {
      this._shown = { key, state };
      this._pending = null;
      return { state, settleAt: null };
    }

    // 与待定态同 key：第 2 帧确认 → 立即提交。
    if (this._pending && this._pending.key === key) {
      this._shown = { key, state };
      this._pending = null;
      return { state, settleAt: null };
    }

    // 出现一个新的不同态（或改写了原待定态）：置为待定，暂不显示；设兜底窗口。
    this._pending = { key, state, since: now };
    return { state: this._shown.state, settleAt: now + this._settleMs };
  }

  /**
   * 兜底提交：窗口到点仍待定则提交待定态。调用方在 observe 返回的 settleAt 时刻调用。
   * @returns {{ state: (object|null), changed: boolean, settleAt: (number|null) }}
   */
  tick(now) {
    if (this._pending && now - this._pending.since >= this._settleMs) {
      this._shown = { key: this._pending.key, state: this._pending.state };
      this._pending = null;
      return { state: this._shown.state, changed: true, settleAt: null };
    }
    const settleAt = this._pending ? this._pending.since + this._settleMs : null;
    return { state: this._shown ? this._shown.state : null, changed: false, settleAt };
  }

  /** 断连 / 切换数据源 / 切台时重置，避免跨会话把旧状态当作「当前显示」误抑制新首帧。 */
  reset() {
    this._shown = null;
    this._pending = null;
  }
}

module.exports = { StateStabilizer, DEFAULT_SETTLE_MS };
