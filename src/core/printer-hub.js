// 多打印机连接生命周期管理（依赖注入，无 electron / store 依赖，便于单测）。
// 每台打印机一个数据源实例（连接常驻），sync(entries) 以 diff 方式与目标列表对齐：
// 新增台建连接、消失台断连接、配置未变的台**不动**——尤其是云端 45s 轮询会整体重写
// bambuPrinters（仅刷新 online/printStatus/name），若无签名比对每次轮询都会重连全部台。
//
// 单台时代的 LAN→cloud 一次性回退逻辑（main.js 原 buildDataSource 内闭包）按台复刻：
// LAN 从未连接成功且该台也在云端 → 换云端重连一次（仅一次），此后瞬时掉线只表现为离线。

class PrinterHub {
  /**
   * @param {object} deps
   * @param {(entry: object, transport: 'lan'|'cloud') => object} deps.makeSource - 建数据源实例
   * @param {(serial: string, report: object) => void} deps.onReport - 某台的一帧报文
   * @param {(serial: string) => void} [deps.onAuthFailure] - 某台鉴权失败（回退不可行时才冒泡）
   * @param {(entry: object) => 'lan'|'cloud'} deps.pickTransport - 按台选传输
   */
  constructor({ makeSource, onReport, onAuthFailure, pickTransport }) {
    this._makeSource = makeSource;
    this._onReport = onReport;
    this._onAuthFailure = onAuthFailure || null;
    this._pickTransport = pickTransport;
    this._run = new Map(); // serial → { sig, source, everConnected, triedCloudFallback }
  }

  /**
   * 连接配置签名：签名变了才重建连接。刻意**不含** name/online/printStatus——
   * 重命名与云端轮询刷新不得触发重连（否则打印中的台每 45s 闪断一次）。
   */
  static configSignature(entry, transport) {
    return `${transport}|${entry.host || ''}|${entry.hasCloud ? 1 : 0}|${entry.hasLan ? 1 : 0}`;
  }

  /** 与目标列表对齐：新增→连，消失→断，签名变化→重连，未变→保持。 */
  sync(entries) {
    const desired = new Map();
    for (const e of entries || []) {
      if (e && e.serial) desired.set(e.serial, e);
    }
    for (const [serial, rt] of this._run) {
      if (!desired.has(serial)) {
        this._stopRuntime(rt);
        this._run.delete(serial);
      }
    }
    for (const [serial, entry] of desired) {
      const transport = this._pickTransport(entry);
      const sig = PrinterHub.configSignature(entry, transport);
      const cur = this._run.get(serial);
      if (cur && cur.sig === sig) continue;
      if (cur) this._stopRuntime(cur);
      this._run.set(serial, this._startRuntime(entry, transport, sig));
    }
  }

  _startRuntime(entry, transport, sig) {
    const rt = { sig, source: null, everConnected: false, triedCloudFallback: false };
    const connect = (tp) => {
      const source = this._makeSource(entry, tp);
      rt.source = source;
      // LAN 从未连接成功且该台也在云端 → 回退云端一次（仅一次）
      const maybeFallback = () => {
        if (tp === 'lan' && entry.hasCloud && !rt.triedCloudFallback && !rt.everConnected) {
          rt.triedCloudFallback = true;
          source.stop();
          connect('cloud');
          return true;
        }
        return false;
      };
      if (typeof source.onAuthFailure === 'function') {
        source.onAuthFailure(() => {
          if (maybeFallback()) return;
          if (this._onAuthFailure) this._onAuthFailure(entry.serial);
        });
      }
      // 成功连接过一次后，瞬时 error/offline 只表现为离线，不再触发回退。
      source.onState((report) => {
        if (report && report.connected) rt.everConnected = true;
        if (!(report && report.connected) && !rt.everConnected && maybeFallback()) return;
        this._onReport(entry.serial, report);
      });
      source.start();
    };
    connect(transport);
    return rt;
  }

  _stopRuntime(rt) {
    if (rt.source) rt.source.stop();
  }

  stopAll() {
    for (const rt of this._run.values()) this._stopRuntime(rt);
    this._run.clear();
  }

  serials() {
    return [...this._run.keys()];
  }

  has(serial) {
    return this._run.has(serial);
  }
}

module.exports = { PrinterHub };
