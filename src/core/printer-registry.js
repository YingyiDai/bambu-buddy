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

// 云端轮询检出「打印机重新上线」的上升沿：online 从「非 true」（false/null/缺省）升到 true。
// 主进程据此立刻让对应 MQTT 源重发 pushall——否则打印机上线后要干等 _requestPushAll 的
// 5 分钟定时才恢复，熊猫长时间卡在离线（真机重启/早上开机场景的核心痛点）。
// 掉线（true→false）不在此列；prev 里没有的台按「非 true」处理，故首帧上线也算上升沿。
function onlineRoseSerials(prev = [], next = []) {
  const wasOnline = new Map((prev || []).map((p) => [p.serial, p.online === true]));
  const rose = [];
  for (const d of next || []) {
    if (d && d.online === true && !wasOnline.get(d.serial)) rose.push(d.serial);
  }
  return rose;
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

function computeMigration(s = {}) {
  const set = {}; const del = [];
  if (s.bambuLan && s.bambuLan.host && !s.bambuLanPrinters) {
    set.bambuLanPrinters = [{
      serial: s.bambuLan.serial, name: s.bambuLan.name || s.bambuLan.serial,
      model: '', host: s.bambuLan.host, accessCode: s.bambuLan.accessCode,
    }];
    del.push('bambuLan');
  }
  // 全部打印机常驻连接后不再有「当前打印机」概念：新旧两代 active 键都直接删除。
  if (s.bambuActivePrinter !== undefined) del.push('bambuActivePrinter');
  if (s.activePrinterSerial !== undefined) del.push('activePrinterSerial');
  if (s.dataSource === 'cloud' || s.dataSource === 'lan') {
    set.dataSource = 'live';
  }
  return { set, del };
}

module.exports = { mergePrinters, pickTransport, onlineRoseSerials, addLan, removeLan, renameInList, computeMigration };
