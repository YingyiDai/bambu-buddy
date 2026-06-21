// 统一打印机注册表：合并云端与本地(LAN)两类来源，纯逻辑、无 electron 依赖。

function mergePrinters(cloudPrinters = [], lanPrinters = []) {
  const bySerial = new Map();
  for (const c of cloudPrinters) {
    bySerial.set(c.serial, {
      serial: c.serial, name: c.name || c.serial, model: c.model || '',
      source: 'cloud', hasCloud: true, hasLan: false,
      online: c.online != null ? c.online : null,
      printStatus: c.printStatus != null ? c.printStatus : null,
      host: null,
    });
  }
  for (const l of lanPrinters) {
    const ex = bySerial.get(l.serial);
    if (ex) {
      ex.source = 'both'; ex.hasLan = true; ex.host = l.host;
      if (l.name) ex.name = l.name;          // LAN 自定义名优先
      if (l.model) ex.model = l.model;
    } else {
      bySerial.set(l.serial, {
        serial: l.serial, name: l.name || l.serial, model: l.model || '',
        source: 'lan', hasCloud: false, hasLan: true,
        online: null, printStatus: null, host: l.host,
      });
    }
  }
  const rank = { both: 0, cloud: 1, lan: 2 };
  return [...bySerial.values()].sort(
    (a, b) => (rank[a.source] - rank[b.source]) || a.name.localeCompare(b.name),
  );
}

function pickTransport(entry) {
  return entry && entry.hasLan ? 'lan' : 'cloud';
}

function addLan(lanList, printer) {
  const rest = (lanList || []).filter((p) => p.serial !== printer.serial);
  return [...rest, { ...printer }];
}

function removeLan(lanList, serial) {
  return (lanList || []).filter((p) => p.serial !== serial);
}

function renameInList(list, serial, name) {
  return (list || []).map((p) => (p.serial === serial ? { ...p, name } : p));
}

module.exports = { mergePrinters, pickTransport, addLan, removeLan, renameInList };
