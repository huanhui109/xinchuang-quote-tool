/* 硬件配置清单解析引擎 —— 单元测试
 * 运行： node tools/test-hcl.js
 * fixture 由两份真实供应商清单抽取（见 tools/fixtures/*.json）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../web/hcl-core.js');
const XR = require('../web/xlsx-read.js');

let pass = 0, fail = 0;
const groups = [];
function T(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a));
  }
}
function ok(v, msg) { if (!v) throw new Error(msg || '断言失败'); }
function near(a, b, tol, msg) { if (Math.abs(a - b) > (tol || 0.001)) throw new Error((msg || '') + ' 期望≈' + b + '，实际 ' + a); }
function group(name) { groups.push(name); console.log('\n# ' + name); }

const FX = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const WIDE = FX('sample-wide-spec.json');
const FREE = FX('sample-free-text.json');
const MACHINES = [
  { id: 1, brand: '海光', model: 'Hygon 5480', cpu_model: 'Hygon 5480', arch: '海光(C86/x86)', cpu_cores: 32, unit_price_cents: 100 },
  { id: 2, brand: '海光', model: 'Hygon 7470', cpu_model: 'Hygon 7470', arch: '海光(C86/x86)', cpu_cores: 48, unit_price_cents: 200 },
  { id: 3, brand: '鲲鹏', model: 'Kunpeng 920', cpu_model: 'Kunpeng 920', arch: '鲲鹏(ARM)', cpu_cores: 64, unit_price_cents: 300 },
];

const resWide = H.parseWorkbook(WIDE, { machines: MACHINES });
const resFree = H.parseWorkbook(FREE, { machines: MACHINES });
const row = (r, i) => (r.rows || []).filter(x => x.rowIndex === i)[0];

/* ---- 构造最小真实 xlsx（store 模式 zip + OOXML 部件），供 zip 解析器测试自包含使用 ---- */
function _crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function buildMinimalXlsx() {
  const enc = new TextEncoder();
  const u16 = n => [n & 255, (n >>> 8) & 255];
  const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>'],
    ['xl/sharedStrings.xml', '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>示例</t></si></sst>'],
  ];
  const parts = []; const central = []; let offset = 0;
  for (const [name, text] of files) {
    const nameB = enc.encode(name); const data = enc.encode(text); const crc = _crc32(data);
    const local = Buffer.from([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameB.length), ...u16(0),
    ].concat(Array.from(nameB), Array.from(data)));
    parts.push(local); const lo = offset; offset += local.length;
    // 中央目录固定头 46 字节：偏移字段必须放在文件名之前
    central.push(Buffer.from([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameB.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(lo),
    ].concat(Array.from(nameB))));
  }
  const cdStart = offset; let cdSize = 0;
  central.forEach(c => { parts.push(c); cdSize += c.length; });
  parts.push(Buffer.from([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(cdSize), ...u32(cdStart), ...u16(0),
  ]));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- 规则与选表
group('规则与工作表/表头识别');
T('默认规则含 3 条且字段完整', () => {
  const rs = H.defaultRules();
  eq(rs.length, 3);
  rs.forEach(r => { ok(r.id && r.name && r.header && r.columns, '规则缺字段：' + r.id); });
});
T('宽表样例命中宽表规则 + 正确的表与表头行', () => {
  ok(resWide.ok, '应解析成功：' + resWide.errorMsg);
  eq(resWide.rule.id, 'wide-spec-columns');
  ok(resWide.sheet.name.indexOf('硬件要求') >= 0, '工作表应对之外');
  eq(resWide.sheet.headerStart, 3);
  eq(resWide.sheet.headerHeight, 2);
  eq(resWide.tableCount, 2, '同一 Sheet 内的第二张表（客户端）应被切分出来');
});
T('自由文本样例命中自由文本规则 + 表头行 2', () => {
  ok(resFree.ok, '应解析成功');
  eq(resFree.rule.id, 'free-text-spec');
  eq(resFree.sheet.headerStart, 2);
});
T('「阅读指南/软件要求」等说明页不被选中', () => {
  ok(resWide.sheet.name.indexOf('阅读指南') < 0 && resWide.sheet.name.indexOf('软件要求') < 0);
});
T('列映射覆盖 CPU/内存/硬盘/网卡/数量/用途', () => {
  ['purpose', 'qty', 'cpuModel', 'cpuCores', 'cpuFreq', 'mem', 'disk', 'nic', 'entity', 'required', 'apps', 'specText']
    .forEach(f => ok(resWide.sheet.fields.indexOf(f) >= 0, '未映射字段：' + f));
});
T('可注入自定义规则（多供应商扩展点）', () => {
  const rules = [{
    id: 'mine', name: '我的供应商', enabled: true, priority: 200,
    sheet: { include: '', exclude: '' },
    header: { scanRows: 8, maxHeaderRows: 1, minScore: 2 },
    required: ['qty'], repeatColumns: [],
    columns: { qty: ['数量'], purpose: ['用途'], specText: ['配置'] },
    vm: { defaultStorageGB: 200, defaultQty: 1 },
  }];
  const wb = { name: 'x', sheets: [{ name: 'S1', rows: [
    ['用途', '数量', '配置'],
    ['数据库', '2', 'Hygon 5480 (32C/2.5GHz) *2 32G DDR4 RDIMM *4'],
  ] }] };
  const r = H.parseWorkbook(wb, { rules });
  ok(r.ok, '自定义规则应命中'); eq(r.rule.id, 'mine'); eq(r.rows[0].qty, 2);
  eq(r.rows[0].spec.memCapacityGB, 128);
});
T('人工指定表头行可纠偏（且保留 Sheet 内第二张表）', () => {
  const r = H.parseWorkbook(WIDE, { headerStart: 3, headerHeight: 2 });
  ok(r.ok);
  eq(r.rows.length, resWide.rows.length, '手动指定应与自动识别行数一致');
  ok(r.rows.some(x => x.purpose === '核心业务系统'), '应仍能解析出核心业务系统');
  eq(r.tableCount, 2, '第二张表应仍被切分');
});

// ---------------------------------------------------------------- 行提取
group('行提取 / 合并单元格继承 / 形态');
T('合并单元格：第 6 行继承用途「数据库」', () => {
  const r = row(resWide, 6);
  ok(r, '应有第 6 行'); eq(r.purpose, '数据库'); eq(r.system, '示例系统');
  eq(r.kind, 'vm'); eq(r.qty, 1); eq(r.spec.vmCpu, 8); eq(r.spec.vmMemGB, 32);
});
T('物理机行：第 5 行 2 台 鲲鹏920 64 核 128G', () => {
  const r = row(resWide, 5);
  eq(r.purpose, '数据库'); eq(r.kind, 'phys'); eq(r.qty, 2);
  eq(r.spec.cpuModel, '鲲鹏920'); eq(r.spec.cpuCores, 64);
  eq(r.spec.memCapacityGB, 128); eq(r.spec.arch, '鲲鹏(ARM)');
  near(r.spec.cpuFreqGHz, 3.0);
});
T('用途归一化与「所属系统」取值', () => {
  eq(row(resWide, 5).purposeNorm, '数据服务');
  eq(row(resWide, 8).purposeNorm, '应用服务');
  eq(row(resWide, 11).purposeNorm, '基础设施');
});
T('终端类（笔记本/台式机）标记 endpoint 且不进入物理机选型', () => {
  const eps = resWide.rows.filter(r => r.kind === 'endpoint');
  eq(eps.length, 2);
  const sels = H.buildSelections(resWide.rows, { machines: MACHINES });
  ok(sels.every(s => s.kind !== 'endpoint' ? true : false), 'endpoint 不应单独成行');
  eq(sels.filter(s => String(s.purpose).indexOf('客户端') >= 0).length, 0);
});
T('空行 / 小节标题被跳过', () => {
  ok(resWide.skippedRows.some(s => s.reason === '小节标题'), '应跳过「客户端配置要求」小节标题');
  ok(resWide.skippedRows.some(s => s.reason === '空行'));
});
T('数量非法时的兜底与告警齐全', () => {
  const cases = [
    ['', 1, 'EMPTY'], ['n', 1, 'UNKNOWN_TOKEN'], ['待定', 1, 'UNKNOWN_TOKEN'],
    ['3', 3, ''], ['2台', 2, ''], ['0', 1, 'NOT_POSITIVE'], ['-2', 1, 'NOT_POSITIVE'],
    ['2.4', 3, 'ROUND_UP'], ['abc', 1, 'NOT_NUMBER'],
  ];
  cases.forEach(([inp, exp, issue]) => {
    const p = H.parseQty(inp, { dflt: 1 });
    eq(p.qty, exp, '数量 ' + JSON.stringify(inp));
    eq(p.issue, issue, '告警码 ' + JSON.stringify(inp));
  });
});
T('「必选=否」的候选行被标记为 optional 且不进入默认选型', () => {
  eq(row(resWide, 6).optional, true);
  const sels = H.buildSelections(resWide.rows, { machines: MACHINES });
  ok(!sels.some(s => s.source.rowIndexes.indexOf(6) >= 0));
});
T('互斥候选（二选一）默认只取一项并给出冲突提示', () => {
  ok(row(resWide, 5).defaultPick === true, 'TDSQL 行默认选中');
  ok(row(resWide, 7).defaultPick === false, 'ob 行默认不选中');
  ok(resWide.warnings.some(w => w.code === 'ALT_CONFLICT'), '应给出互斥候选冲突告警');
});

// ---------------------------------------------------------------- 规格解析
group('规格解析（结构化列 + 自由文本）');
T('宽表：内存/硬盘/网卡/RAID 从列读取', () => {
  const s = row(resWide, 5).spec;
  eq(s.disks[0].sizeGB, 1000, '硬盘容量按十进制 TB 口径');
  eq(s.disks[0].type, 'SSD');
  eq(s.nics[0].count, 4);
  eq(s.raid, true);
});
T('自由文本：Hygon 7470 (48C/2.6GHz) *2 → 96 核 2 路', () => {
  const s = row(resFree, 4).spec;
  eq(s.cpuModel, 'Hygon 7470');
  eq(s.cpuPerSocket, 48); eq(s.cpuSockets, 2); eq(s.cpuCores, 96);
  near(s.cpuFreqGHz, 2.6);
});
T('自由文本：32G DDR4 *16 → 512G 内存', () => {
  eq(row(resFree, 4).spec.memCapacityGB, 512);
  eq(row(resFree, 4).spec.memGen, 'DDR4');
  eq(row(resFree, 4).spec.memSticks, 16);
});
T('自由文本：多块硬盘分别识别型号与数量', () => {
  const d = row(resFree, 4).spec.disks;
  eq(d.length, 2);
  eq(d[0].sizeGB, 480); eq(d[0].count, 2); eq(d[0].type, 'SSD_SATA');
  eq(d[1].sizeGB, 3840); eq(d[1].count, 6); eq(d[1].type, 'NVMe');
});
T('自由文本：1.92T SSD_SATA *2 → 2 块 1920G', () => {
  const d = row(resFree, 3).spec.disks;
  eq(d.length, 1); eq(d[0].sizeGB, 1920); eq(d[0].count, 2); eq(d[0].type, 'SSD_SATA');
  eq(row(resFree, 3).spec.memCapacityGB, 128);
});
T('网卡解析：端口数 × 速率 × 介质', () => {
  eq(H.parseNics('1GE（电口）*4')[0], { speed: '1GE', count: 4, media: '电口' });
  eq(H.parseNics('10GE（光口,含光模块）*2')[0].speed, '10GE');
  eq(H.parseNics('10GE（光口,含光模块）*2')[0].count, 2);
  eq(H.parseNics('2块2口\n10G网卡')[0].count, 4);
  eq(H.parseNics('2块2口\n10G网卡')[0].speed, '10GE');
  const wm = H.parseNics('2*万兆双光口/25GE/10GE光口（不含光模块）')[0];
  eq(wm.count, 2); eq(wm.media, '光口');
});
T('CPU 文本格式兼容：有无空格 / 有无 E 后缀', () => {
  const a = {}; H.parseCpuText('Hygon5480 (32C/2.5GHz) *2', a);
  eq([a.cpuModel, a.cpuPerSocket, a.cpuSockets], ['Hygon5480', 32, 2]);
  const b = {}; H.parseCpuText('Hygon 7470 (48C/2. 6GHz) *2', b);
  eq([b.cpuModel, b.cpuPerSocket, b.cpuSockets], ['Hygon 7470', 48, 2]);
  near(b.cpuFreqGHz, 2.6);
  const c = {}; H.parseCpuText('2*鲲鹏920 5220,32Core@3.0GHz', c);
  eq([c.cpuModel, c.cpuPerSocket, c.cpuSockets], ['鲲鹏920 5220', 32, 2]);
});
T('架构推定：鲲鹏(ARM) / 海光(C86/x86)', () => {
  eq(H.finalizeSpec({ cpuModel: '鲲鹏920', disks: [], nics: [] }).arch, '鲲鹏(ARM)');
  eq(H.finalizeSpec({ cpuModel: 'Hygon 5480', disks: [], nics: [] }).arch, '海光(C86/x86)');
});
T('虚拟机：缺存储时按规则默认值补齐并告警', () => {
  const wb = { name: 'v', sheets: [{ name: 'S', rows: [
    ['部署应用', '服务器配置', '服务器类型', '数量'],
    ['某服务', '8C 32G 的云主机', '虚拟机', '2'],
  ] }] };
  const r = H.parseWorkbook(wb);
  ok(r.ok);
  const r3 = r.rows[0];
  eq(r3.kind, 'vm');
  ok(r3.spec.vmStoGB > 0, '应补齐默认存储');
  ok(r3.issues.some(i => i.code === 'VM_STO_DFLT'));
});
T('用途缺失时由部署应用推导并告警', () => {
  eq(row(resFree, 4).purpose, '数据库集群');
  ok(row(resFree, 4).issues.some(i => i.code === 'PURPOSE_DERIVED'));
});
T('用途归一化字典与架构图口径一致', () => {
  eq(H.purposeOf('数据库'), '数据服务');
  eq(H.purposeOf('核心业务系统'), '应用服务');
  eq(H.purposeOf('ZooKeeper, Kafka'), '中间件');
  eq(H.purposeOf(''), '未分组');
  eq(H.purposeOfApps(['网关类', '资产中心', '极速订单']), '接入层');
});

// ---------------------------------------------------------------- 沉淀与去重
group('规格模板沉淀 / 默认已选配置 / 重复导入');
T('模板按「用途+规格签名」去重并累积使用次数', () => {
  const combos = H.buildCombos(resWide.rows);
  const keys = combos.map(c => c.key);
  eq(keys.length, new Set(keys).size, 'combo key 应唯一');
  ok(combos.length >= 4);
  const again = H.buildCombos(resWide.rows, combos);
  eq(again.length, combos.length, '二次沉淀不应新增条目');
  ok(again[0].useCount >= combos[0].useCount, '使用次数应累加');
});
T('默认已选配置包含 机型/规格 + 数量 + 用途', () => {
  const sels = H.buildSelections(resWide.rows, { machines: MACHINES, fileKey: 'k1', fileName: 'f1' });
  eq(sels.length, 5);
  const db = sels[0];
  eq(db.kind, 'phys'); eq(db.qty, 2); eq(db.purpose, '数据库');
  eq(db.machineId, 3, '鲲鹏920 64 核应匹配单价库 Kunpeng 920');
  ok(db.modelText.indexOf('鲲鹏920') >= 0);
  ok(sels.every(s => s.qty >= 1 && s.purpose && s.selKey));
});
T('自由文本样例全部 7 行进入默认选型且数量正确', () => {
  const sels = H.buildSelections(resFree.rows, { machines: MACHINES });
  eq(sels.length, 7);
  eq(sels.map(s => s.qty).join(','), '1,3,1,2,2,3,2');
  ok(sels.every(s => s.kind === 'phys'));
});
T('重复导入同一份清单：更新而非追加', () => {
  const first = H.buildSelections(resWide.rows, { machines: MACHINES, fileKey: 'k1', fileName: 'f' });
  const m1 = H.mergeSelections([], first, {});
  eq(m1.added, 5); eq(m1.updated, 0);
  const again = H.buildSelections(resWide.rows, { machines: MACHINES, fileKey: 'k1', fileName: 'f' });
  const m2 = H.mergeSelections(m1.items, again, {});
  eq(m2.added, 0, '不应新增');
  eq(m2.updated, 5, '应更新');
  eq(m2.items.length, 5, '总数不变');
  ok(m2.items[0].source.rowIndexes.length >= 1);
});
T('重导入时人工改过的行受保护（默认策略）', () => {
  const first = H.buildSelections(resWide.rows, { machines: MACHINES })[0];
  first.manual = true; first.qty = 99;
  const again = H.buildSelections(resWide.rows, { machines: MACHINES });
  const m = H.mergeSelections([first], again, { conflictPolicy: 'keep-manual' });
  eq(m.conflict, 1);
  eq(m.items[0].qty, 99, '应保留人工值');
  const m2 = H.mergeSelections([Object.assign({}, first, { manual: true })], again, { conflictPolicy: 'overwrite' });
  eq(m2.items[0].qty, 2, 'overwrite 策略应以新清单为准');
});
T('源清单中已删除的行会被移除（stalePolicy=remove，仅限同一文件内）', () => {
  // B-4：stale 判定按来源文件隔离，旧项 fileKey 与本轮一致时才会被清理
  const next = H.buildSelections(resWide.rows, { machines: MACHINES, fileKey: 'k', fileName: 'f' });
  const prevSameFile = [Object.assign({}, next[0], { id: 'x', selKey: 'phys|a|m1|0/0/0', qty: 1, manual: false, spec: {}, source: { fileKey: 'k', file: 'f', rowIndexes: [] } })];
  const m = H.mergeSelections(prevSameFile, next, { stalePolicy: 'remove' });
  eq(m.removed, 1, '同文件内未被消费的旧行应被移除');
  eq(m.items.length, next.length);
  const k = H.mergeSelections(prevSameFile, next, { stalePolicy: 'keep' });
  eq(k.items.length, next.length + 1);
});
T('多文件导入互不清空（B-4：fileKey 隔离）', () => {
  const sO = H.buildSelections(resWide.rows, { machines: MACHINES, fileKey: 'K-WIDE', fileName: 'wide.xlsx' });
  const sA = H.buildSelections(resFree.rows, { machines: MACHINES, fileKey: 'K-FREE', fileName: 'free.xlsx' });
  const m1 = H.mergeSelections([], sO, { stalePolicy: 'remove' });
  eq(m1.items.length, sO.length);
  const m2 = H.mergeSelections(m1.items, sA, { stalePolicy: 'remove' });
  eq(m2.removed, 0, '导入第二个文件不应删除第一个文件的数据');
  eq(m2.items.length, sO.length + sA.length, '两份清单的行应并存');
  eq(m2.items.filter(x => x.source.fileKey === 'K-WIDE').length, sO.length, '宽表行应仍在');
  eq(m2.items.filter(x => x.source.fileKey === 'K-FREE').length, sA.length, '自由文本行应已加入');
  // 重导入同一文件：只在该文件范围内做 stale，且已消费的行不会被删
  const m3 = H.mergeSelections(m2.items, sA, { stalePolicy: 'remove' });
  eq(m3.items.length, sO.length + sA.length, '重导入不应改变总数');
  eq(m3.removed, 0);
});
T('人工换机型后重导入：机型变更也要记冲突并保留人工值（B-5）', () => {
  const base = H.buildSelections(resFree.rows, { machines: MACHINES, fileKey: 'k2', fileName: 'f2' })[0];
  base.manual = true;
  base.qty = 99;
  base.modelText = '人工指定机型';
  base.spec = Object.assign({}, base.spec, { cpuModel: 'Hygon 7470' });
  const again = H.buildSelections(resFree.rows, { machines: MACHINES, fileKey: 'k2', fileName: 'f2' });
  const m = H.mergeSelections([base], again, { conflictPolicy: 'keep-manual' });
  eq(m.conflict, 1, '数量+机型同时变更应记 1 次冲突');
  eq(m.items[0].qty, 99, '人工数量应保留');
  eq(m.items[0].modelText, '人工指定机型', '人工机型应保留（原实现会静默丢弃）');
  ok(m.items[0].note.indexOf('机型') >= 0 || m.items[0].note.indexOf('规格') >= 0,
    'note 应说明机型/规格被保留，实际=' + m.items[0].note);
});
T('overwrite 后清除 manual 标记，避免策略粘滞（B-5）', () => {
  const base = H.buildSelections(resWide.rows, { machines: MACHINES, fileKey: 'k3', fileName: 'f3' })[0];
  base.manual = true; base.qty = 99;
  const again = H.buildSelections(resWide.rows, { machines: MACHINES, fileKey: 'k3', fileName: 'f3' });
  const m1 = H.mergeSelections([Object.assign({}, base)], again, { conflictPolicy: 'overwrite' });
  eq(m1.items[0].qty, again[0].qty, 'overwrite 应以新清单为准');
  eq(m1.items[0].manual, false, 'overwrite 后应解除人工保护');
  // 解除后，即使切回 keep-manual 也应跟随新清单
  const m2 = H.mergeSelections([Object.assign({}, m1.items[0])], again, { conflictPolicy: 'keep-manual' });
  eq(m2.items[0].qty, again[0].qty, 'manual 已清除，不应再被保护');
});
T('fileKey 对同一文件稳定、对不同文件不同', () => {
  eq(H.fileKeyOf(WIDE.name, WIDE.sheets), H.fileKeyOf(WIDE.name, WIDE.sheets));
  ok(H.fileKeyOf(WIDE.name, WIDE.sheets) !== H.fileKeyOf(FREE.name, FREE.sheets));
});
T('机型匹配：按 CPU 型号 + 核数命中单价库', () => {
  eq(H.matchMachine({ cpuModel: '鲲鹏920', cpuCores: 64 }, MACHINES).id, 3);
  eq(H.matchMachine({ cpuModel: 'Hygon 5480', cpuCores: 64 }, MACHINES).id, 1);
  eq(H.matchMachine({ cpuModel: '未知型号 X1', cpuCores: 8 }, MACHINES), null);
});

// ---------------------------------------------------------------- 边界与异常
group('边界条件与异常场景');
T('空工作簿 → EMPTY_WORKBOOK', () => {
  const r = H.parseWorkbook({ name: 'a', sheets: [] });
  eq(r.ok, false); eq(r.error, 'EMPTY_WORKBOOK'); ok(r.errorMsg);
});
T('无匹配表 → NO_MATCHED_TABLE 并返回预览供人工选表', () => {
  const r = H.parseWorkbook({ name: 'a', sheets: [{ name: 'Sheet1', rows: [['随便', '写点'], ['内容', '没有表头']] }] });
  eq(r.ok, false); eq(r.error, 'NO_MATCHED_TABLE');
  ok(r.sheetNames.length === 1); ok(r.preview[0].rows.length >= 1);
});
T('非法输入（null / 非数组 / 含异常行）不崩溃', () => {
  eq(H.parseWorkbook(null).ok, false);
  eq(H.parseWorkbook({ sheets: [null, undefined, 3] }).ok, false);
  const r = H.parseWorkbook({ name: 'x', sheets: [{ name: 'S', rows: [
    ['用途', '数量', '配置'], ['OK用途', '2', 'Hygon 5480 (32C/2.5GHz) *2 32G DDR4 *2'],
  ] }] }, { rules: H.defaultRules() });
  ok(true);
  ok(Array.isArray(r.rows));
});
T('超大表：超出上限的行被截断且不卡死', () => {
  const rows = [['用途', '数量', '配置']];
  for (let i = 0; i < 900; i++) rows.push(['压力' + i, '1', 'Hygon 5480 (32C/2.5GHz) *2 32G DDR4 *2']);
  const t0 = Date.now();
  const r = H.parseWorkbook({ name: 'big', sheets: [{ name: 'S', rows }] }, {
    rules: [{ id: 't', name: 't', enabled: true, priority: 100, sheet: { include: '', exclude: '' },
      header: { scanRows: 3, maxHeaderRows: 1, minScore: 2 }, required: ['qty'], repeatColumns: [],
      columns: { purpose: ['用途'], qty: ['数量'], specText: ['配置'] }, vm: { defaultStorageGB: 100 } }],
  });
  const ms = Date.now() - t0;
  ok(r.ok, '超大表应能解析');
  ok(ms < 4000, '解析耗时过长：' + ms + 'ms');
  ok(r.rows.length > 100, '应保留大部分行，实际 ' + r.rows.length);
});
T('单行解析异常被隔离，不影响其他行', () => {
  const rows = [['用途', '数量', '配置'], ['A', '2', '正常 32G DDR4 *2'], ['B', '3', 'Hygon 5480 (32C/2.5GHz) *2 16G DDR4 *1']];
  const r = H.parseWorkbook({ name: 'x', sheets: [{ name: 'S', rows }] }, {
    rules: [{ id: 't', name: 't', enabled: true, priority: 100, sheet: { include: '', exclude: '' },
      header: { scanRows: 3, maxHeaderRows: 1, minScore: 2 }, required: ['qty'], repeatColumns: [],
      columns: { purpose: ['用途'], qty: ['数量'], specText: ['配置'] }, vm: { defaultStorageGB: 100 } }],
  });
  ok(r.ok); eq(r.rows.length, 2);
});
T('i18n 符号：全角括号 / 中文乘号 / 各种写法都能解析', () => {
  const s = H.parseSpecText('鲲鹏920（48C／3.0GHz）×2 32G DDR4 ×4 1.92T（SSD_SATA）×2');
  eq(s.cpuModel, '鲲鹏920'); eq(s.cpuCores, 96); eq(s.memCapacityGB, 128);
});

// ---------------------------------------------------------------- 浏览器端读取
group('浏览器端读取（xlsx-read）');
T('列号换算 A1/AZ100', () => {
  eq(XR.colIndex('A1'), 0); eq(XR.colIndex('C5'), 2); eq(XR.colIndex('AA3'), 26);
});
T('CSV 解析支持引号与换行', () => {
  const rows = XR.parseCsvText('a,b\n"含,逗号","含""引号"""\n', 100, 60);
  eq(rows[0], ['a', 'b']);
  eq(rows[1], ['含,逗号', '含"引号"']);
});
T('真实 xlsx 的 zip 中央目录可解析并解压出 sharedStrings', async () => {
  // 现场构造一个最小但结构真实的 xlsx（store 模式 zip + OOXML 部件），
  // 不依赖任何外部文件：开源后测试可完全自包含。
  const zipBytes = buildMinimalXlsx();
  const zip = XR.readEntries(new Uint8Array(zipBytes));
  ok(Object.keys(zip.entries).length > 5, 'zip 条目数异常');
  ok(!!zip.entries['xl/sharedStrings.xml'], '缺少 sharedStrings');
  ok(!!zip.entries['xl/workbook.xml'], '缺少 workbook.xml');
  const bytes = zip.bytes.subarray.apply(zip.bytes, (function () {
    const dv = zip.dv, ent = zip.entries['xl/sharedStrings.xml'];
    const nameLen = dv.getUint16(ent.localOff + 26, true);
    const extraLen = dv.getUint16(ent.localOff + 28, true);
    const start = ent.localOff + 30 + nameLen + extraLen;
    return [start, start + ent.compSize];
  })());
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const text = new TextDecoder('utf-8').decode(raw);
  ok(text.indexOf('<sst') >= 0, '解压结果应为 sharedStrings XML');
  ok(text.indexOf('所属系统') >= 0, '应包含中文共享字符串');
});

// ---------------------------------------------------------------- 用途补录
group('用途「未分组」的识别与人工补录');
T('purposeGroups 返回全部可选分组', () => {
  const gs = H.purposeGroups();
  ok(Array.isArray(gs) && gs.length >= 6, '至少 6 个分组，实际 ' + gs.length);
  gs.forEach(g => {
    ok(g.name && Array.isArray(g.kws), '分组结构应含 name/kws：' + JSON.stringify(g));
  });
});
T('分组名本身可自命中（避免回填后仍是未分组）', () => {
  H.purposeGroups().forEach(g => {
    eq(H.purposeOf(g.name), g.name, '分组「' + g.name + '」回填后应归一化为自身');
  });
  eq(H.purposeOf('基础设施'), '基础设施');
  eq(H.purposeOf('存储备份'), '存储备份');
  eq(H.purposeOf('接入层'), '接入层');
});
T('空用途判为未分组', () => {
  eq(H.purposeOf(''), '未分组');
  eq(H.purposeOf(null), '未分组');
  eq(H.purposeOf('某某专有名词xyz'), '未分组');
});
T('明细行补录用途后归一化与签名同步刷新', () => {
  const r = row(resFree, 3) || resFree.rows[0];
  const before = r.purposeNorm;
  r.purpose = '数据库集群';
  const n1 = H.purposeOf(r.purpose);
  eq(n1, '数据服务', '「数据库集群」应归入数据服务');
  const sig = H.signatureOf(r.kind, n1, r.spec);
  ok(typeof sig === 'string' && sig.length > 0, '签名应可重算');
  ok(sig !== r.signature, '用途变化后签名应随之变化（模板去重键需重算）');
  r.purpose = '某某专有名词xyz';
  eq(H.purposeOf(r.purpose), '未分组', '无法识别的用途仍为未分组');
  r.purposeNorm = before; // 还原，避免影响后续用例
});
T('未分组行可统计出来（供 UI「只看未分组」）', () => {
  const wb = { name: 'x.xlsx', sheets: [{ name: '硬件清单', rows: [
    ['用途', '数量', '配置'],
    ['某某专有名词xyz', '2', 'Hygon 5480 (32C/2.5GHz) *2 32G DDR4 *4'],
    ['数据库服务器', '1', 'Hygon 5480 (32C/2.5GHz) *2 32G DDR4 *4'],
  ] }] };
  const res = H.parseWorkbook(wb, {});
  const un = (res.rows || []).filter(r => !r.purposeNorm || r.purposeNorm === '未分组');
  eq(un.length, 1, '应恰好 1 行未分组');
  eq(res.rows.filter(r => r.purposeNorm === '数据服务').length, 1, '数据库应归入数据服务');
});
T('行业扩展词提高召回（合规风控/云管操作机/AMO 不再落到未分组）', () => {
  eq(H.purposeOf('合规风控'), '应用服务');
  eq(H.purposeOf('云管操作机'), '基础设施');
  eq(H.purposeOf('AMO'), '应用服务');
  eq(H.purposeOf('结算服务器'), '应用服务');
  eq(H.purposeOf('统一运维平台'), '基础设施');
  // 分组集合必须与架构图严格一致，扩展词只允许扩召回、不允许新增分组名
  const ag = require('../web/arch-graph.js');
  const agNames = (ag.PURPOSE_RULES || []).map(r => r[1]).sort();
  const mine = H.purposeGroups().map(g => g.name).sort();
  eq(mine, agNames, '用途分组集合应与架构图模块一致');
});
T('用途文本未命中时回退用部署应用推导', () => {
  const res = H.parseWorkbook(WIDE, { machines: MACHINES });
  const r9 = row(res, 9);
  ok(r9, '宽表第 9 行应存在');
  eq(r9.purposeNorm, '基础设施', '「基础平台」经扩展词应归入基础设施');
  const r10 = row(res, 10);
  ok(r10.purposeNorm !== '未分组', '「资讯行情」应命中分组，实际=' + r10.purposeNorm);
});
T('终端机（笔记本/客户端）不计入待补录的未分组', () => {
  const res = H.parseWorkbook(WIDE, { machines: MACHINES });
  const eps = res.rows.filter(r => r.kind === 'endpoint');
  ok(eps.length >= 2, '应识别出终端行');
  eps.forEach(r => eq(r.kind, 'endpoint'));
  const pending = res.rows.filter(r => r.kind !== 'endpoint' && (!r.purposeNorm || r.purposeNorm === '未分组'));
  eq(pending.length, 0, '宽表参与选型的行应全部有分组（实际待补录 ' + pending.length + '）');
});
T('补录用途后重新构建已选配置会带上新用途', () => {
  const wb = { name: 'x.xlsx', sheets: [{ name: '硬件清单', rows: [
    ['用途', '数量', '配置'],
    ['某某专有名词xyz', '2', 'Hygon 5480 (32C/2.5GHz) *2 32G DDR4 *4'],
  ] }] };
  const res = H.parseWorkbook(wb, {});
  const r = res.rows[0];
  const k0 = H.selKeyOf(r.kind, r.purpose, null, r.spec);
  // 模拟人工归入「数据服务」
  r.purpose = '数据服务'; r.purposeNorm = H.purposeOf('数据服务');
  const sels = H.buildSelections([r], { machines: MACHINES, fileName: 'x.xlsx' });
  eq(sels.length, 1);
  eq(sels[0].purpose, '数据服务', '已选配置应带上人工补录的用途');
  ok(sels[0].selKey !== k0, '用途变化后 selKey 应不同（新行）');
  // 再次导入同一份（用途已修正）不应重复
  const merged = H.mergeSelections(sels, H.buildSelections([r], { machines: MACHINES, fileName: 'x.xlsx' }), { conflictPolicy: 'keep-manual' });
  eq(merged.added, 0, '同键重复导入不应新增');
});

console.log('\n' + '='.repeat(60));
console.log(`结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
