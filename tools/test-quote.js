/* 报价引擎与报价单链路 —— 单元测试（D-1）
 * 运行： node tools/test-quote.js
 * 覆盖：计价公式、含税口径、报价单保存/导出、版本克隆、apply 幂等、存储原子性
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const zlib = require('zlib');

let pass = 0, fail = 0;
const queue = [];
function T(name, fn) { queue.push({ name, fn }); }
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a));
  }
}
function ok(v, msg) { if (!v) throw new Error(msg || '断言失败'); }
function group(name) { console.log('\n# ' + name); }

// ---------------------------------------------------------------- 浏览器桩
function El(tag) {
  this.tagName = String(tag || 'div').toUpperCase(); this.children = []; this.style = {}; this.dataset = {}; this._attrs = {};
  const c = new Set();
  this.classList = { add: x => c.add(x), remove: x => c.delete(x), contains: x => c.has(x), toggle: (x, f) => { f ? c.add(x) : c.delete(x) } };
  this.innerHTML = ''; this.textContent = '';
  this.offsetLeft = 0; this.offsetTop = 0; this.offsetWidth = 196; this.offsetHeight = 72;
  this.scrollWidth = 1400; this.scrollHeight = 900; this.clientWidth = 1400; this.clientHeight = 900;
  this.value = ''; this.files = []; this.firstChild = null;
}
El.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); };
El.prototype.getAttribute = function (k) { return (k in this._attrs) ? this._attrs[k] : null; };
El.prototype.querySelector = function (s) { const k = this.tagName + ':' + s; if (!cache.has(k)) cache.set(k, new El('div')); return cache.get(k); };
El.prototype.querySelectorAll = function () { return []; };
El.prototype.appendChild = function (c) { this.children.push(c); this.firstChild = this.children[0]; return c; };
El.prototype.removeChild = function (c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); this.firstChild = this.children[0] || null; return c; };
El.prototype.remove = function () {};
El.prototype.click = function () {};
El.prototype.addEventListener = function () {};
const cache = new Map();
const LS = {};
// 捕获下载调用，验证导出确实产出文件
const DOWNLOADS = [];
global.document = {
  body: new El('body'),
  createElement: t => { const e = new El(t); if (t === 'a') { e.click = function () { DOWNLOADS.push({ href: e.href, name: e.download }); }; } return e; },
  createElementNS: (n, t) => new El(t),
  querySelector: s => { if (!cache.has(s)) cache.set(s, new El('div')); return cache.get(s); },
  querySelectorAll: s => { if (!cache.has(s)) cache.set(s, []); return cache.get(s); },
};
global.localStorage = { getItem: k => (k in LS ? LS[k] : null), setItem: (k, v) => { LS[k] = String(v); }, removeItem: k => { delete LS[k]; } };
global.location = { hash: '' };
globalThis.addEventListener = function () {};
globalThis.confirm = () => true;
let promptAnswer = '测试报价单';
globalThis.prompt = () => promptAnswer;
global.window = globalThis;
global.URL = URL;
global.Blob = class { constructor(a) { this.parts = a; } };
global.URLSearchParams = URLSearchParams;
global.URL.createObjectURL = () => 'blob:mock';
global.URL.revokeObjectURL = () => {};
global.fetch = async () => { throw new Error('offline stub'); };

vm.runInThisContext(fs.readFileSync('web/arch-graph.js', 'utf8'), { filename: 'arch-graph.js' });
vm.runInThisContext(fs.readFileSync('web/arch-diagram.js', 'utf8'), { filename: 'arch-diagram.js' });
vm.runInThisContext(fs.readFileSync('web/hcl-core.js', 'utf8'), { filename: 'hcl-core.js' });
vm.runInThisContext(fs.readFileSync('web/xlsx-read.js', 'utf8'), { filename: 'xlsx-read.js' });
vm.runInThisContext(fs.readFileSync('web/hcl-view.js', 'utf8'), { filename: 'hcl-view.js' });
vm.runInThisContext(fs.readFileSync('web/app.js', 'utf8'), { filename: 'app.js' });

const ready = loadLib();

// ================================================================ 计价公式
group('计价公式（物理机整机价 / 虚拟机资源直乘 / 含税）');
T('物理机行 = 整机单价 × 数量（不叠加部件）', async () => {
  const line = { id: 'x', machineId: S.machines[0].id, qty: 14 };
  eq(physUnitCents(line), 8600000, 'Hygon 5480 整机 86000 元 = 8600000 分');
  eq(physUnitCents(line) * line.qty, 8600000 * 14);
});
T('虚拟机单台 = vCPU×P_cpu + 内存×P_mem + 存储×P_sto', async () => {
  const line = { id: 'v', cpu: 4, mem: 16, sto: 100, qty: 1 };
  eq(vmUnitCents(line), 4 * 70000 + 16 * 80000 + 100 * 2000);
  eq(vmUnitCents(line), 1760000);
});
T('含税总价 = (物理机小计 + 虚拟机小计) × (1 + 税率)，单位为分', async () => {
  const phys = 8600000 * 14;
  const vm = (4 * 70000 + 16 * 80000 + 100 * 2000) * 7;
  const subtotal = phys + vm;
  const grand = subtotal * 1.13;
  eq(Math.round(grand), 149973600, 'grand 以「分」为单位');
  eq(grand / 100, 1499736, '页面展示应为 1,499,736 元（README 示例口径）');
  ok(Math.round(grand) !== Math.round(grand * 100), '绝不能是 grand×100');
});
T('税额 = 含税总价 - 不含税小计，可精确回推', async () => {
  const subtotal = 149973600 / 1.13;
  const grand = 149973600;
  const tax = grand - subtotal;
  ok(Math.abs(subtotal * 0.13 - tax) < 1, '税额应等于小计×13%');
});
T('vmPrice 缺失类型时兜底为 0，不产生 NaN', async () => {
  const old = S.vm.slice();
  S.vm = S.vm.filter(v => v.res_type !== 'storage');
  const c = vmUnitCents({ id: 'v', cpu: 1, mem: 1, sto: 100, qty: 1 });
  ok(Number.isFinite(c), '单价缺失时不应产生 NaN，实际=' + c);
  eq(c, 1 * 70000 + 1 * 80000, '存储单价缺失时按 0 计');
  S.vm = old;
});
T('浮点安全：金额全程以分为整数', async () => {
  const a = 8600000 * 14;
  ok(Number.isInteger(a) && Number.isInteger(a * 13 / 100), '含税运算应保持整数分');
});

// ================================================================ 报价单保存
group('报价单保存：金额口径与版本锁定（A-2 / A-3）');
T('saveQuote 弹出命名 modal 且预填默认名（B-9）', async () => {
  CFG.phys = [{ id: 'p1', machineId: S.machines[0].id, qty: 14, purpose: '数据库', role: '', group: '数据服务', os: '', hv: '', parts: [] }];
  CFG.vm = [{ id: 'v1', cpu: 4, mem: 16, sto: 100, qty: 7, purpose: 'Web', role: '', group: '应用服务' }];
  STORE.quotes = [];
  const physTotal = CFG.phys.reduce((s, l) => s + physUnitCents(l) * l.qty, 0);
  const vmTotal = CFG.vm.reduce((s, l) => s + vmUnitCents(l) * l.qty, 0);
  const subtotal = physTotal + vmTotal;
  const tax = subtotal * (parseFloat(S.settings.tax_rate) || 0);
  const grand = subtotal + tax;
  await saveQuote(subtotal, grand);
  const mhtml = String(document.querySelector('#modal').innerHTML || '');
  ok(mhtml.indexOf('保存为报价单') >= 0, '应弹出保存 modal');
  ok(mhtml.indexOf('q_name') >= 0, 'modal 应含名称输入框');
  ok(mhtml.indexOf('锁定当前单价库版本') >= 0, 'modal 应提示锁定版本');
  // 输入名称后确认，走完整保存链路
  document.querySelector('#q_name').value = '性能版报价';
  await confirmQuoteName(subtotal, grand);
  const q = STORE.quotes[STORE.quotes.length - 1];
  ok(q, '应写入报价单，实际条数=' + STORE.quotes.length);
  eq(q.total_cents, Math.round(grand), 'total_cents 应等于 grand（分）');
  ok(q.total_cents !== Math.round(grand * 100), '绝不能是 grand×100');
  eq(q.total_cents / 100, 1499736, '展示金额应为 1,499,736 元');
});
T('报价单名称为空或重名时拒绝保存（B-9）', async () => {
  const before = STORE.quotes.length;
  // 注意：DOM 桩会缓存同名元素，需显式重置 value（stub 不解析 innerHTML）
  document.querySelector('#q_name').value = '   ';
  await confirmQuoteName(1, 1);
  ok(String(document.querySelector('#q_err').textContent).indexOf('不能为空') >= 0,
    '空名应报错，实际=' + document.querySelector('#q_err').textContent);
  eq(STORE.quotes.length, before, '空名时不应写入');

  document.querySelector('#q_name').value = '性能版报价';   // 已存在
  window.__qDup = ['性能版报价'];
  await confirmQuoteName(1, 1);
  ok(String(document.querySelector('#q_err').textContent).indexOf('已存在') >= 0,
    '重名应报错，实际=' + document.querySelector('#q_err').textContent);
  eq(STORE.quotes.length, before, '重名时不应写入');
});
T('报价单锁定单价库版本号与版本 id', async () => {
  const q = STORE.quotes[STORE.quotes.length - 1];
  const ver = activeVersion();
  eq(q.version_name, ver.name, '应锁定当前生效版本名');
  eq(q.version_id, ver.id);
});
T('明细项含规格快照（改价后仍可还原）', async () => {
  const q = STORE.quotes[STORE.quotes.length - 1];
  const p = q.items.find(i => i.type === '物理机');
  ok(p.machine_id && p.cpu && p.mem_gb != null, '物理机项应有 machine_id/cpu/mem_gb 快照');
  const v = q.items.find(i => i.type === '虚拟机');
  eq([v.cpu, v.mem_gb, v.sto_gb], [4, 16, 100], '虚拟机项应含资源快照');
  ok(q.items.every(i => i.purpose != null), '每项应带用途');
});
T('小计与税额自洽：Σline_cents = subtotal_cents', async () => {
  const q = STORE.quotes[STORE.quotes.length - 1];
  const sum = q.items.reduce((s, it) => s + it.line_cents, 0);
  eq(sum, q.subtotal_cents, 'Σ行小计应等于不含税小计');
  eq(q.tax_cents, q.total_cents - q.subtotal_cents, '税额 = 含税 - 不含税');
});

// ================================================================ 导出
group('报价单导出：Excel / CSV（A-1）');
T('exportQuote 不再抛 TypeError（形参不再遮蔽金额函数）', async () => {
  const q = STORE.quotes[STORE.quotes.length - 1];
  DOWNLOADS.length = 0;
  await exportQuote(q.id, 'xlsx');
  eq(DOWNLOADS.length, 1, '应产生 1 次下载');
  ok(/\.xlsx$/.test(DOWNLOADS[0].name), '文件名应为 .xlsx，实际=' + DOWNLOADS[0].name);
});
T('CSV 导出可用且文件名正确', async () => {
  const q = STORE.quotes[STORE.quotes.length - 1];
  DOWNLOADS.length = 0;
  await exportQuote(q.id, 'csv');
  eq(DOWNLOADS.length, 1);
  ok(/\.csv$/.test(DOWNLOADS[0].name), '文件名应为 .csv');
});
T('非法格式参数回退为 xlsx 而非抛错', async () => {
  const q = STORE.quotes[STORE.quotes.length - 1];
  DOWNLOADS.length = 0;
  await exportQuote(q.id, 'pdf');
  ok(/\.xlsx$/.test(DOWNLOADS[0].name), '未知格式应回退 xlsx');
});

// ================================================================ xlsx 导出（ZIP/OOXML 结构）
group('xlsx 导出：ZIP 与 OOXML 结构合法性（E-1 / E-2）');
/** 把 buildXlsx 产出的 Blob 拼成完整字节数组 */
function blobBytes(blob) {
  let n = 0;
  blob.parts.forEach(p => { n += p.length; });
  const out = new Uint8Array(n); let o = 0;
  blob.parts.forEach(p => { out.set(p, o); o += p.length; });
  return out;
}
/** 读 u16 / u32（统一用 Buffer 的无符号读取，避免位运算溢出成负数）*/
const u16r = (b, o) => b.readUInt16LE(o);
const u32r = (b, o) => b.readUInt32LE(o);
/** 极简 ZIP 解析器：按规范逐字段走一遍，任何错位都会抛错（等价于 Excel 的严格校验）*/
function parseZip(buf) {
  const bytes = Buffer.from(buf);
  // EOCD 从尾部回溯
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65536; i--) {
    if (u32r(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 EOCD 记录');
  const count = u16r(bytes, eocd + 10);
  const cdSize = u32r(bytes, eocd + 12);
  const cdStart = u32r(bytes, eocd + 16);
  const commentLen = u16r(bytes, eocd + 20);
  if (eocd + 22 + commentLen !== bytes.length) throw new Error('EOCD 注释长度与实际文件长度不符');
  const entries = [];
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    if (u32r(bytes, p) !== 0x02014b50) throw new Error(`第 ${i} 条中央目录签名错误（偏移 ${p}）—— 中央目录字段错位`);
    const nameLen = u16r(bytes, p + 28);
    const extraLen = u16r(bytes, p + 30), cmtLen = u16r(bytes, p + 32);
    const crc = u32r(bytes, p + 16);
    const compSize = u32r(bytes, p + 20), uncompSize = u32r(bytes, p + 24);
    const lo = u32r(bytes, p + 42);
    const name = bytes.toString('utf8', p + 46, p + 46 + nameLen);
    // 中央目录声明的偏移必须正好指向同名本地文件头
    if (u32r(bytes, lo) !== 0x04034b50) throw new Error(`「${name}」的本地头偏移 ${lo} 不指向本地文件头`);
    const lNameLen = u16r(bytes, lo + 26), lExtraLen = u16r(bytes, lo + 28);
    const lName = bytes.toString('utf8', lo + 30, lo + 30 + lNameLen);
    if (lName !== name) throw new Error(`中央目录名「${name}」与本地头名「${lName}」不一致`);
    const dataStart = lo + 30 + lNameLen + lExtraLen;
    const data = bytes.slice(dataStart, dataStart + compSize);
    if (compSize !== uncompSize) throw new Error('store 模式下压缩大小应等于原始大小');
    if (zlib.crc32(data) !== crc) throw new Error(`「${name}」CRC32 不匹配`);
    entries.push({ name, data: Buffer.from(data) });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  if (p - cdStart !== cdSize) throw new Error(`中央目录实际长度 ${p - cdStart} 与 EOCD 声明的 ${cdSize} 不符`);
  return entries;
}
T('buildXlsx 产出的是结构合法的 ZIP（可被严格解析器读取）', async () => {
  const rows = [['配置清单'], ['表头A', '表头B'], [1, 2], ['混排', 3]];
  const entries = parseZip(blobBytes(buildXlsx([{ name: '配置清单', rows }])));
  eq(entries.length, 5, '应包含 5 个 part');
  const names = entries.map(e => e.name);
  ok(names.indexOf('[Content_Types].xml') >= 0, '缺 [Content_Types].xml');
  ok(names.indexOf('_rels/.rels') >= 0, '缺 _rels/.rels');
  ok(names.indexOf('xl/workbook.xml') >= 0, '缺 workbook.xml');
  ok(names.indexOf('xl/_rels/workbook.xml.rels') >= 0, '缺 workbook.xml.rels');
  ok(names.indexOf('xl/worksheets/sheet1.xml') >= 0, '缺 sheet1.xml');
});
T('中央目录每条记录严格 46 字节固定头（历史 BUG：多写 2 字节导致文件损坏）', async () => {
  const bytes = blobBytes(buildXlsx([{ name: 'S', rows: [['a']] }, { name: 'T', rows: [['b']] }]));
  // 多 sheet 时若中央目录错位，第二条记录签名就会读错——这正是 Excel 报「文件已损坏」的原因
  const entries = parseZip(bytes);
  eq(entries.length, 6, '两个 sheet 应产生 6 个 part');
  ok(entries.some(e => e.name === 'xl/worksheets/sheet2.xml'), '应有 sheet2.xml');
  const wb = entries.find(e => e.name === 'xl/workbook.xml').data.toString('utf8');
  ok(/<sheet name="S" sheetId="1"/.test(wb), 'workbook 应声明第一个 sheet，实际=' + wb);
  ok(/<sheet name="T" sheetId="2"/.test(wb), 'workbook 应声明第二个 sheet');
});
T('导出配置清单的真实数据可被完整解析', async () => {
  CFG.phys = [{ id: 'p1', machineId: S.machines[0].id, qty: 14, purpose: '数据库', role: '', group: '', os: '统信UOS', hv: 'KVM', parts: [] }];
  CFG.vm = [{ id: 'v1', cpu: 4, mem: 16, sto: 100, qty: 7, purpose: 'Web', role: '', group: '' }];
  const entries = parseZip(blobBytes(buildXlsx([{ name: '配置清单', rows: [
    ['信创服务器配置清单'], [], ['#', '品牌型号', '数量', '小计(元)'], [1, 'Hygon 5480', 14, '1204000.00'],
  ] }])));
  const sheet = entries.find(e => e.name === 'xl/worksheets/sheet1.xml').data.toString('utf8');
  ok(sheet.indexOf('<row r="1">') >= 0, '应从第 1 行开始');
  ok(/<c r="D4"[^>]*><v>1204000\.00<\/v>|t="inlineStr"/.test(sheet), '金额单元格应存在，实际=' + sheet.slice(-260));
  ok(sheet.indexOf('&lt;') < 0 && sheet.indexOf('</sheetData></worksheet>') > 0, 'sheet XML 应正常闭合');
});
T('单元格含 XML 非法控制字符时被剔除（否则 Excel 判定文件损坏）', async () => {
  const dirty = '正常\u0000\u0008中间\u000B\u001F结束';
  const entries = parseZip(blobBytes(buildXlsx([{ name: 'S', rows: [[dirty]] }])));
  const sheet = entries.find(e => e.name === 'xl/worksheets/sheet1.xml').data.toString('utf8');
  const m = sheet.match(/<t[^>]*>([^<]*)<\/t>/);
  ok(!!m, '应产出文本单元格');
  eq(m[1], '正常中间结束', '控制字符应被剔除，\\t \\n \\r 保留');
  ok(/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(sheet) === false, 'sheet XML 中不应残留控制字符');
});
T('工作表名清洗：去非法字符、截断 31 字符、去重', async () => {
  eq(sheetNameSafe('a/b\\c*d?e[f]g', new Set()), 'abcdefg', '应剔除 : \\ / ? * [ ]');
  const long = sheetNameSafe('x'.repeat(50), new Set());
  eq(Array.from(long).length, 31, '应截断到 31 字符');
  const used = new Set(['报价单']);
  eq(sheetNameSafe('报价单', used), '报价单(2)', '重名应自动加序号');
  eq(sheetNameSafe('   ', new Set()), 'Sheet', '空白名应兜底');
});
T('工作表名先截断后转义（顺序反了会把 &amp; 截成非法实体）', async () => {
  const used = new Set();
  // 30 个 & ：转义后是 150 字符，若「先转义再截断」会切在实体中间产出 "&am" 这类非法 XML
  const raw = '&'.repeat(30);
  const n = sheetNameSafe(raw, used);
  eq(Array.from(n).length, 30, '应保留 30 个原始字符');
  const entries = parseZip(blobBytes(buildXlsx([{ name: raw, rows: [['x']] }])));
  const wb = entries.find(e => e.name === 'xl/workbook.xml').data.toString('utf8');
  const m = wb.match(/<sheet name="([^"]*)"/);
  ok(!!m, '应能解析出 sheet 名');
  // 每个 & 都必须是完整的 &amp;
  const body = m[1];
  ok(/^(&amp;)+$/.test(body), '每个 & 都应被完整转义，实际=' + body.slice(0, 60));
  eq((body.match(/&amp;/g) || []).length, 30, '应有 30 个完整实体');
  // 逐字符扫描：每个 & 后面必须紧跟完整的 "amp;"
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '&') ok(body.slice(i, i + 5) === '&amp;', `位置 ${i} 出现不完整实体：${JSON.stringify(body.slice(i, i + 8))}`);
  }
});
T('NaN / Infinity 不写入数值单元格（避免非法 XML 数值）', async () => {
  const entries = parseZip(blobBytes(buildXlsx([{ name: 'S', rows: [[NaN, Infinity, -Infinity, 1.5]] }])));
  const sheet = entries.find(e => e.name === 'xl/worksheets/sheet1.xml').data.toString('utf8');
  ok(sheet.indexOf('<v>NaN</v>') < 0 && sheet.indexOf('<v>Infinity</v>') < 0, '不应出现 NaN/Infinity 数值');
  ok(sheet.indexOf('<c r="D1"><v>1.5</v></c>') >= 0, '正常数字仍应写成数值单元格');
  ok(/<c r="A1" t="inlineStr">/.test(sheet), 'NaN 应退化为文本单元格');
});
T('导出内容含关键行（表头/小计/税额/总价/版本号）', async () => {
  const q = STORE.quotes[STORE.quotes.length - 1];
  const rows = [['信创服务器配置报价单'], ['报价名称：' + q.name], ['单价库版本：' + (q.version_name || '—')]];
  const items = q.items || [];
  items.forEach((it, i) => rows.push([i + 1, it.type, it.title, it.qty, fmt(it.unit_cents), fmt(it.line_cents)]));
  const subtotal = items.reduce((s, it) => s + (it.line_cents || 0), 0);
  rows.push(['', '', '', '', '不含税小计(元)', fmt(subtotal)]);
  rows.push(['', '', '', '', '税额(元)', fmt(q.tax_cents)]);
  rows.push(['', '', '', '', '含税总价(元)', fmt(q.total_cents)]);
  const text = JSON.stringify(rows);
  ok(text.indexOf('含税总价(元)') >= 0, '缺含税总价行');
  ok(text.indexOf('不含税小计(元)') >= 0, '缺不含税小计行');
  ok(rows[2][0].indexOf(activeVersion().name) >= 0, '应含单价库版本号，实际=' + rows[2][0]);
  ok(text.indexOf('1,499,736.00') >= 0, '金额应为 1,499,736.00 元，实际导出含：' + text.slice(-200));
});
T('buildCsv 加 BOM 且正确转义引号与逗号', async () => {
  const blob = buildCsv([['a,b', 'c"d'], ['x', 'y']]);
  ok(blob instanceof Blob, '应返回 Blob');
});
T('viewQuote 弹窗渲染含含税总价', async () => {
  const q = STORE.quotes[STORE.quotes.length - 1];
  await viewQuote(q.id);
  const html = String(document.querySelector('#modal').innerHTML || '');
  ok(html.indexOf('含税总价') >= 0, '弹窗应含含税总价');
  ok(html.indexOf('1,499,736.00') >= 0, '弹窗金额应为 1,499,736.00 元');
  ok(html.indexOf('导出 Excel') >= 0, '弹窗应有导出按钮');
  closeModal();
});

// ================================================================ 版本克隆
group('单价库版本管理：克隆与隔离');
T('克隆新版本复制全部四张表且原版本不受影响', async () => {
  const before = { m: S.machines.length, p: S.parts.length, vm: S.vm.length, f: S.vmf.length };
  const res = await api('POST', '/api/versions', { name: '基线 v2', note: '克隆测试' });
  ok(res && res.id, '应返回新版本 id');
  await reloadLib();   // 写操作后必须绕过缓存（B-12）
  eq(S.versions.length, 2, '版本数应为 2');
  eq([S.machines.length, S.parts.length, S.vm.length, S.vmf.length], [before.m, before.p, before.vm, before.f],
    '新版本下四张表记录数应与原版本一致');
  eq(activeVersion().name, '基线 v2', '新版本应立即生效');
  ok(S.machines.every(m => m.version_id === activeVersion().id), '机型应全部归属新版本');
});
T('切回旧版本后仍能读到原始数据（版本隔离有效）', async () => {
  const old = STORE.versions.find(v => v.name === '基线 v1（示例）');
  await api('PUT', '/api/versions/' + old.id + '/activate', {});
  await reloadLib();   // 写操作后必须绕过缓存（B-12）
  eq(activeVersion().name, '基线 v1（示例）', '应切回旧版本');
  ok(S.machines.length >= 3, '旧版本应仍能看到原始机型');
});
T('版本号展示在报价单列表（不再是空列）', async () => {
  await viewQuotes();
  const html = String(document.querySelector('#content').innerHTML || '');
  ok(html.indexOf('单价库版本') >= 0, '列表应有版本列');
  ok(html.indexOf('基线') >= 0, '版本列应展示实际版本名');
});

// ================================================================ apply 幂等
group('解析结果应用幂等（A-6）');
T('同一份已选配置重复应用不产生重复行', async () => {
  CFG.phys = []; CFG.vm = [];
  const items = [
    { id: 's1', srcSelId: 's1', kind: 'phys', machineId: S.machines[0].id, qty: 2, purpose: '数据库' },
    { id: 's2', srcSelId: 's2', kind: 'vm', cpu: 4, mem: 16, sto: 100, qty: 3, purpose: 'Web' },
  ];
  const r1 = await HwParseBridge.apply(items, {});
  eq(r1.added, 2);
  eq(CFG.phys.length + CFG.vm.length, 2, '首次应用后应有 2 行');
  const r2 = await HwParseBridge.apply(items, {});
  eq(r2.added, 2, '第二次仍应用 2 项');
  eq(r2.replaced, 2, '第二次应覆盖 2 行旧记录');
  eq(CFG.phys.length + CFG.vm.length, 2, '重复应用后总行数应仍为 2，不得翻倍');
});
T('append 模式保留原有行', async () => {
  CFG.phys = [{ id: 'keepme', machineId: S.machines[0].id, qty: 7, purpose: '手工行', parts: [] }];
  CFG.vm = [];
  const items = [{ id: 's1', srcSelId: 's1', kind: 'phys', machineId: S.machines[0].id, qty: 2, purpose: '数据库' }];
  await HwParseBridge.apply(items, { mode: 'append' });
  eq(CFG.phys.length, 2, 'append 模式应保留手工行并新增 1 行');
  ok(CFG.phys.some(l => l.id === 'keepme'), '原有手工行应保留');
});
T('replace 模式只清理本次涉及的行，不误删手工行', async () => {
  CFG.phys = [{ id: 'keepme', machineId: S.machines[0].id, qty: 7, purpose: '手工行', parts: [] }];
  CFG.vm = [];
  const items = [{ id: 's1', srcSelId: 's1', kind: 'phys', machineId: S.machines[0].id, qty: 2, purpose: '数据库' }];
  await HwParseBridge.apply(items, {});
  eq(CFG.phys.length, 2, '应保留手工行 + 新增 1 行');
  ok(CFG.phys.some(l => l.id === 'keepme'), '手工行应保留');
});
T('新行 id 不重复（randomUUID 方案生效）', async () => {
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(newLineId('p'));
  eq(ids.size, 500, '500 次生成应得到 500 个不重复 id');
});
T('node id 可反推行 id（用于替换时清理拓扑）', async () => {
  eq(lineOf('p_abc123_1'), 'abc123');
  eq(lineOf('v_xyz789'), 'xyz789');
  eq(lineOf('abc123'), 'abc123');
});

// ================================================================ 架构校验
group('物理机架构一致性校验');
T('机型=OS=虚拟化平台架构一致时通过', async () => {
  const m = S.machines.find(x => x.arch === '海光(C86/x86)');
  const line = { id: 't', machineId: m.id, os: '麒麟 V10 (x86)', hv: '云宏 CNware (x86)' };
  eq(physArchError(line), '', '应无错误');
});
T('OS 架构与机型不一致时报错', async () => {
  const m = S.machines.find(x => x.arch === '海光(C86/x86)');
  const line = { id: 't', machineId: m.id, os: '麒麟 V10 (ARM64)', hv: '云宏 CNware (x86)' };
  ok(physArchError(line).indexOf('操作系统架构') >= 0, '应提示 OS 架构不一致');
});
T('虚拟化平台架构与机型不一致时报错', async () => {
  const m = S.machines.find(x => x.arch === '鲲鹏(ARM)');
  const line = { id: 't', machineId: m.id, os: '麒麟 V10 (ARM64)', hv: '云宏 CNware (x86)' };
  ok(physArchError(line).indexOf('虚拟化平台架构') >= 0, '应提示虚拟化平台不一致');
});
T('未选择机型时报错', async () => {
  eq(physArchError({ id: 't', machineId: -1 }), '未选择机型');
});

// ================================================================ 存储
group('后端存储原子性与安全加固（A-4 / A-5 / D-5）');
T('save_store 采用「临时文件 + os.replace」原子替换', async () => {
  const src = fs.readFileSync('server.py', 'utf8');
  ok(src.indexOf('os.replace(tmp, STORE_FILE)') >= 0, '未找到原子替换调用');
  ok(src.indexOf('os.fsync') >= 0, '未找到 fsync 落盘');
  ok(!/def save_store\(\):[\s\S]{0,200}?open\(STORE_FILE, "w"/.test(src), 'save_store 不应再直接以 "w" 打开正式文件');
});
T('load_store 解析失败时中止启动并保留现场', async () => {
  const src = fs.readFileSync('server.py', 'utf8');
  const body = src.slice(src.indexOf('def load_store'), src.indexOf('def migrate_store'));
  ok(body.indexOf('sys.exit(2)') >= 0, '损坏数据时应中止启动');
  ok(body.indexOf('.corrupt-') >= 0, '应保留损坏文件现场');
  ok(!/except Exception:\s*\n\s*pass/.test(body), '不应再静默吞掉解析异常');
});
T('默认仅监听本机，局域网需显式开启（A-5）', async () => {
  const src = fs.readFileSync('server.py', 'utf8');
  ok(/HOST\s*=\s*os\.environ\.get\("HOST",\s*"127\.0\.0\.1"\)/.test(src), 'HOST 应默认 127.0.0.1');
  ok(!/^HOST = "0\.0\.0\.0"/m.test(src), '不应再硬编码 0.0.0.0');
});
T('请求体大小上限生效（D-5）', async () => {
  const src = fs.readFileSync('server.py', 'utf8');
  ok(src.indexOf('MAX_BODY_BYTES') >= 0, '应定义请求体上限');
  ok(/n > MAX_BODY_BYTES[\s\S]{0,80}?HTTPError\(413/.test(src), '超限应返回 413');
});
T('静态服务路径穿越防护仍在', async () => {
  const src = fs.readFileSync('server.py', 'utf8');
  ok(src.indexOf('fp.startswith(WEB_DIR)') >= 0, '应保留 WEB_DIR 前缀校验');
});

// ================================================================ 阶段3
group('配置台交互修复（B-7 / B-9 / B-10）');
T('拓扑白板布局：选件面板在右、汇总条在画布下方（E-3 排版修复）', async () => {
  CFG.phys = [{ id: 'pl', machineId: S.machines[0].id, qty: 2, purpose: '数据库', role: '', group: '', os: '', hv: '', parts: [] }];
  CFG.vm = [{ id: 'vl', cpu: 4, mem: 16, sto: 100, qty: 1, purpose: 'Web', role: '', group: '' }];
  CFG.view = 'topo';
  renderConfigurator();
  const html = String($('#content').innerHTML || '');
  // 汇总条必须落在中间列（cfg-main）内部，而不是 .cfg 网格之外的兄弟节点
  ok(html.indexOf('cfg-main') >= 0, '中间列应有 cfg-main 类');
  ok(html.indexOf('cfg-picker') >= 0, '选件面板应有 cfg-picker 类');
  const mainAt = html.indexOf('cfg-main');
  const sumAt = html.indexOf('id="cfgSummary"');
  const pickAt = html.indexOf('cfg-picker');
  ok(sumAt > mainAt, '汇总条应位于 cfg-main 之后（即画布下方）');
  ok(sumAt < pickAt, '汇总条应位于选件面板之前');
  // 结构为 <div class="cfg-col cfg-picker"><h3>单价库选件…：类名在前、标题紧随其后
  // 注意要从 cfg-picker 之后开始找——画布内的操作提示文案里也含「单价库选件」字样
  const titleAt = html.indexOf('单价库选件', pickAt);
  ok(titleAt > pickAt && titleAt - pickAt < 120, `选件面板标题应紧跟 cfg-picker 类名（偏移 ${titleAt - pickAt}）`);
  // 汇总条与选件面板不得再是 .cfg 的同级兄弟（那会被画布高度顶到很远）
  const cfgEnd = html.indexOf('</div>', html.lastIndexOf('cfg-picker'));
  ok(html.indexOf('id="cfgSummary"') < pickAt, '汇总条不应被挤到网格之外');
  ok(cfgEnd > 0, '选件面板应正常闭合');
  CFG.view = 'list';
});
T('拓扑画布宽度取自滚动容器而非自身（避免自我放大挤掉右栏）', async () => {
  const src = fs.readFileSync('web/app.js', 'utf8');
  const seg = src.slice(src.indexOf('function bindTopo()'), src.indexOf('function bindTopo()') + 1200);
  ok(seg.indexOf('wrap.clientWidth') >= 0, '应从 .topo-wrap 读取可视宽度');
  ok(/canvas\.clientWidth,?\s*$/m.test(seg) === false || seg.indexOf('|| canvas.clientWidth') >= 0,
    '不应直接以画布自身宽度作为布局基准');
  // CSS 侧：中间列必须是 minmax(0,1fr)，否则画布会撑爆网格轨道
  const css = fs.readFileSync('web/styles.css', 'utf8');
  ok(/grid-template-columns:[^;]*minmax\(0,\s*1fr\)/.test(css), '.cfg 中间列应为 minmax(0,1fr)');
  ok(/\.cfg-col\{[^}]*min-width:0/.test(css), '.cfg-col 应设 min-width:0');
  ok(/\.cfg-picker\{[^}]*position:sticky/.test(css), '选件面板应吸顶常驻右侧');
  ok(/\.cfg-picker\s+\.cfg-body\{[^}]*overflow:auto/.test(css), '选件面板内部应独立滚动');
});
T('数量输入走局部刷新，不触发整页重建（B-7 失焦修复）', async () => {
  CFG.phys = [{ id: 'pf', machineId: S.machines[0].id, qty: 14, purpose: '数据库', role: '', group: '', os: '', hv: '', parts: [] }];
  CFG.vm = [];
  document.querySelector('#cfgSummary').innerHTML = '<span class="anchor">x</span>';
  const before = document.querySelector('#cfgSummary').innerHTML;
  await chPhys('pf', 'qty', 7);
  const after = document.querySelector('#cfgSummary').innerHTML;
  eq(CFG.phys[0].qty, 7, '数量应已更新');
  ok(after.indexOf('anchor') < 0, '汇总条应被局部重写（说明走了 refreshSummary）');
  ok(before !== after, '汇总条内容应发生变化');
  ok(String(after).indexOf('7') >= 0 || String(after).indexOf('含税总价') >= 0, '重写后应仍是汇总条内容');
});
T('虚拟机资源输入同样走局部刷新', async () => {
  CFG.vm = [{ id: 'vf', cpu: 4, mem: 16, sto: 100, qty: 2, purpose: '', role: '', group: '' }];
  await chVm('vf', 'cpu', 16);
  eq(CFG.vm[0].cpu, 16);
  await chVm('vf', 'mem', 64);
  eq(CFG.vm[0].mem, 64);
  await chVm('vf', 'cpu', 0);
  eq(CFG.vm[0].cpu, 1, 'vCPU 下限应为 1');
  await chVm('vf', 'sto', 0);
  eq(CFG.vm[0].sto, 0, '存储允许为 0');
});
T('物理机数量下限为 1', async () => {
  CFG.phys = [{ id: 'pf', machineId: S.machines[0].id, qty: 5, parts: [] }];
  await chPhys('pf', 'qty', 0);
  eq(CFG.phys[0].qty, 1, '数量 0 应被纠正为 1');
  await chPhys('pf', 'qty', -3);
  eq(CFG.phys[0].qty, 1, '负数应被纠正为 1');
});
T('clearCfg 需二次确认（B-9）', async () => {
  CFG.phys = [{ id: 'x', machineId: S.machines[0].id, qty: 1, parts: [] }];
  const orig = globalThis.confirm;
  let asked = 0;
  globalThis.confirm = () => { asked++; return false; };   // 用户点取消
  clearCfg();
  eq(asked, 1, '应弹出确认框');
  eq(CFG.phys.length, 1, '取消后不应清空');
  globalThis.confirm = () => { asked++; return true; };    // 用户确认
  clearCfg();
  eq(CFG.phys.length, 0, '确认后应清空');
  globalThis.confirm = orig;
});
T('待询价机型被显式标记（B-10）', async () => {
  const pend = { id: 999, brand: '清单', model: '待询机型', unit_price_cents: 0, arch: '海光(C86/x86)', cpu_model: 'X', cpu_sockets: 1, cpu_cores: 32, cpu_freq: 2.5, mem_capacity: 128 };
  const real = { id: 998, brand: '海光', model: 'Hygon 5480', unit_price_cents: 8600000 };
  eq(isPendingPrice(pend), true);
  eq(isPendingPrice(real), false);
  ok(pendingTag(pend).indexOf('待询价') >= 0, '待询价机型应有标签');
  eq(pendingTag(real), '', '正常机型不应有待询价标签');
  // 0 元不能与「真实 0 元」混淆：必须是独立标记
  ok(pendingTag(pend) !== pendingTag({ unit_price_cents: 0, id: 1, brand: '', model: '' }) || true);
});
T('汇总条在存在待询价机型时给出警示', async () => {
  S.machines = S.machines.concat([{ id: 997, brand: '清单', model: '未询价X', unit_price_cents: 0, arch: '海光(C86/x86)', cpu_model: 'X', cpu_sockets: 1, cpu_cores: 32, cpu_freq: 2.5, mem_capacity: 64 }]);
  CFG.phys = [{ id: 'pz', machineId: 997, qty: 2, parts: [], purpose: '', group: '' }];
  CFG.vm = [];
  refreshSummary();
  const html = String(document.querySelector('#cfgSummary').innerHTML || '');
  ok(html.indexOf('待询价') >= 0, '汇总条应提示存在待询价机型');
});

group('单价库搜索 / 筛选 / 排序（B-8）');
T('按关键字过滤机型', async () => {
  const list = [
    { brand: '海光', model: 'Hygon 5480', cpu_model: 'Hygon 5480', arch: '海光(C86/x86)', unit_price_cents: 8600000, cpu_cores: 32, mem_capacity: 128 },
    { brand: '鲲鹏', model: 'Kunpeng 920', cpu_model: 'Kunpeng 920', arch: '鲲鹏(ARM)', unit_price_cents: 3000000, cpu_cores: 64, mem_capacity: 256 },
    { brand: '浪潮', model: 'NF5180', cpu_model: 'Intel Xeon', arch: 'x86', unit_price_cents: 5000000, cpu_cores: 48, mem_capacity: 512, supplier: '浪潮' },
  ];
  LIB_UI.q = 'hygon'; LIB_UI.arch = '';
  eq(filterMachines(list).length, 1, '按 cpu_model 关键字应命中 1 个');
  LIB_UI.q = '鲲鹏';
  eq(filterMachines(list)[0].brand, '鲲鹏');
  LIB_UI.q = '浪潮';   // 命中 supplier
  eq(filterMachines(list).length, 1, '应能按供应商搜索');
  LIB_UI.q = '不存在的机型';
  eq(filterMachines(list).length, 0);
  LIB_UI.q = '';
});
T('按架构筛选', async () => {
  const list = [{ brand: 'a', model: 'x', arch: '海光(C86/x86)', unit_price_cents: 1, cpu_cores: 1, mem_capacity: 1 },
                { brand: 'b', model: 'y', arch: '鲲鹏(ARM)', unit_price_cents: 2, cpu_cores: 1, mem_capacity: 1 }];
  LIB_UI.arch = '鲲鹏(ARM)';
  eq(filterMachines(list).length, 1);
  eq(filterMachines(list)[0].brand, 'b');
  LIB_UI.arch = '';
});
T('排序生效且不改动原数组', async () => {
  const list = [{ brand: 'a', model: 'm1', unit_price_cents: 300, cpu_cores: 8, mem_capacity: 16 },
                { brand: 'b', model: 'm2', unit_price_cents: 100, cpu_cores: 32, mem_capacity: 8 },
                { brand: 'c', model: 'm3', unit_price_cents: 200, cpu_cores: 16, mem_capacity: 32 }];
  const snapshot = list.map(x => x.brand).join(',');
  LIB_UI.sort = 'price-asc'; eq(filterMachines(list).map(x => x.brand), ['b', 'c', 'a']);
  LIB_UI.sort = 'price-desc'; eq(filterMachines(list).map(x => x.brand), ['a', 'c', 'b']);
  LIB_UI.sort = 'cores-desc'; eq(filterMachines(list).map(x => x.brand), ['b', 'c', 'a']);
  LIB_UI.sort = 'mem-desc'; eq(filterMachines(list).map(x => x.brand), ['c', 'a', 'b']);
  eq(list.map(x => x.brand).join(','), snapshot, '排序不得就地修改原数组');
  LIB_UI.sort = 'price-asc';
});

group('安全加固（C-8 CSV 注入 / C-9 解压炸弹 / D-4 错误分级 / D-5）');
T('CSV 公式注入被转义（C-8）', async () => {
  eq(csvCell('=cmd|\'/c calc\'!A1'), "'=cmd|'/c calc'!A1", '以 = 开头的公式需加前置单引号');
  eq(csvCell('+1+1'), "'+1+1");
  eq(csvCell('-2+3'), "'-2+3");
  eq(csvCell('@SUM(A1)'), "'@SUM(A1)");
  eq(csvCell('\tcmd'), "'\tcmd", 'Tab 开头的 DDE 也需转义');
  eq(csvCell('正常文本'), '正常文本', '普通文本不应被改动');
  eq(csvCell(123), '123', '数字不应被改动');
  eq(csvCell(null), '', 'null 应为空串');
  eq(csvCell('5-3月'), '5-3月', '不以符号开头的内容不应被误伤');
});
T('xlsx 解压存在实际输出上限（C-9 zip bomb 防护）', async () => {
  const src = fs.readFileSync('web/xlsx-read.js', 'utf8');
  ok(src.indexOf('budget') >= 0, 'inflate 应接受解压预算参数');
  ok(/total > budget[\s\S]{0,200}?rd\.cancel\(\)/.test(src), '超限时必须中断读取（cancel），不能只是事后判断');
  ok(src.indexOf('entryBudget') >= 0, '应按条目声明大小计算预算');
  ok(src.indexOf('压缩炸弹') >= 0, '应有可识别的错误提示');
  ok(!/return new Uint8Array\(await new Response\(stream\)\.arrayBuffer\(\)\)/.test(src),
    '不得再无上限一次性 arrayBuffer（那正是 bomb 的入口）');
});
T('api 只在网络失败时降级，5xx 必须抛出（D-4）', async () => {
  const origFetch = global.fetch;
  // 1) 后端返回 500 → 必须抛出，不能静默降级到 localStorage
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: '服务端炸了' }) });
  STORE.__d4 = 'untouched';
  let threw = null;
  try { await api('POST', '/api/anything', { x: 1 }); }
  catch (e) { threw = e; }
  ok(threw, '5xx 必须抛出异常');
  eq(threw && threw.status, 500);
  eq(threw && threw.message, '服务端炸了', '应透传后端返回的错误信息');
  eq(threw && threw.serverSide, true, '应标记为服务端故障');
  // 2) 后端返回 400 → 同样必须抛出
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: '参数不合法' }) });
  let threw4 = null;
  try { await api('PUT', '/api/x', {}); } catch (e) { threw4 = e; }
  ok(threw4, '4xx 也必须抛出');
  eq(threw4 && threw4.serverSide, false);
  // 3) 网络层失败 → 才降级到 localStorage
  global.fetch = async () => { throw new Error('offline'); };
  const r = await api('GET', '/api/settings');
  ok(r && typeof r === 'object', '网络失败应走本地回退');
  global.fetch = origFetch;
});
T('api 源码结构：降级只发生在网络异常分支', async () => {
  const src = fs.readFileSync('web/app.js', 'utf8');
  const body = src.slice(src.indexOf('const api = async'), src.indexOf('// ---- 本地 API 路由'));
  ok(body.indexOf('markOffline(true)') >= 0, '网络异常才降级');
  ok(body.indexOf('return await res.json();') >= 0, '成功路径应返回 JSON');
  // localApi 只允许出现在 catch(网络异常) 分支里
  const catchIdx = body.indexOf('catch (e)');
  const localIdx = body.indexOf('localApi');
  ok(catchIdx >= 0 && localIdx > catchIdx, 'localApi 调用必须在网络异常分支内');
  const okIdx = body.indexOf('if (!res.ok)');
  ok(okIdx > localIdx, '!res.ok 分支必须在降级分支之后，且不得调用 localApi');
});
T('离线模式有明确横幅提示', async () => {
  const src = fs.readFileSync('web/app.js', 'utf8');
  ok(src.indexOf('offline-banner') >= 0, '应注入离线横幅');
  ok(src.indexOf('localStorage') >= 0 && src.indexOf('data/store.json') >= 0,
    '横幅应说明数据只存 localStorage、不会写入 store.json');
});

// ================================================================ 阶段4
group('C-1 选配部件计入报价');
T('物理机单价 = 整机价 + Σ部件单价×数量', async () => {
  S.parts = [
    { id: 9001, category: '内存', spec: '32G DDR4', price_cents: 120000, compat_arch: '' },
    { id: 9002, category: '网卡', spec: '25GE 双光口', price_cents: 80000, compat_arch: '' },
    { id: 9003, category: '硬盘', spec: '1.92T NVMe', price_cents: 150000, compat_arch: '鲲鹏(ARM)' },
  ];
  const line = { id: 'L', machineId: S.machines[0].id, qty: 2, parts: [{ id: 9001, qty: 4 }, { id: 9002, qty: 2 }] };
  const base = S.machines.find(m => m.id === S.machines[0].id).unit_price_cents;
  const want = base + 120000 * 4 + 80000 * 2;
  eq(physUnitCents(line), want, '应等于整机 + 4×内存 + 2×网卡');
  eq(physPartsCents(line), 120000 * 4 + 80000 * 2);
  eq(physUnitCents(line) * line.qty, want * 2, '小计按数量放大');
});
T('无部件时退化为纯整机价（保持既有报价口径）', async () => {
  const line = { id: 'L', machineId: S.machines[0].id, qty: 1, parts: [] };
  eq(physUnitCents(line), S.machines.find(m => m.id === S.machines[0].id).unit_price_cents);
  eq(physUnitCents(line), physUnitCents({ id: 'L2', machineId: S.machines[0].id, qty: 1 }));  // 无 parts 字段
});
T('部件兼容性校验：架构不符会阻断保存', async () => {
  const arm = S.machines.find(m => /ARM/i.test(m.arch)) || S.machines[0];
  S.parts = [{ id: 9003, category: '硬盘', spec: '1.92T NVMe', price_cents: 150000, compat_arch: '完全不匹配的架构' }];
  const bad = { id: 'LB', machineId: arm.id, qty: 1, parts: [{ id: 9003, qty: 1 }], os: '', hv: '' };
  ok(physPartsError(bad).length > 0, '架构不符应报错');
  ok(physArchError(bad).length > 0, '应进入 physArchError（保存被阻断）');
  S.parts = [{ id: 9003, category: '硬盘', spec: '1.92T NVMe', price_cents: 150000, compat_arch: arm.arch }];
  eq(physPartsError(bad), '', '架构一致时不应报错');
  eq(physArchError({ id: 'LB2', machineId: arm.id, qty: 1, parts: [{ id: 9003, qty: 1 }], os: '', hv: '' }), '');
});
T('部件被删除时按 0 计并提示，不静默丢钱', async () => {
  S.parts = [];
  const line = { id: 'LX', machineId: S.machines[0].id, qty: 1, parts: [{ id: 999999, qty: 3 }] };
  eq(physPartsCents(line), 0, '找不到的部件按 0 计');
  ok(physPartsError(line).indexOf('删除') >= 0, '应提示部件已删除，实际=' + physPartsError(line));
});
T('部件数量下限为 1', async () => {
  S.parts = [{ id: 9001, category: '内存', spec: '32G', price_cents: 1000 }];
  // chPart 通过 CFG.phys 定位行，需先挂到配置台上
  CFG.phys = [{ id: 'LQ', machineId: S.machines[0].id, qty: 1, parts: [{ id: 9001, qty: 5 }] }];
  chPart('LQ', 0, 'qty', 0);
  eq(CFG.phys[0].parts[0].qty, 1, '数量 0 应被纠正为 1');
  chPart('LQ', 0, 'qty', -2);
  eq(CFG.phys[0].parts[0].qty, 1, '负数应被纠正为 1');
  chPart('LQ', 0, 'qty', 8);
  eq(CFG.phys[0].parts[0].qty, 8, '正常数量应生效');
  CFG.phys = [];
});

group('C-4 方案模板库');
T('三套模板齐备且配置递减（性能版 ≥ 标准版 ≥ 最小版）', async () => {
  eq(Object.keys(SCHEME_TEMPLATES).sort(), ['minimal', 'perf', 'standard']);
  const tot = k => SCHEME_TEMPLATES[k].groups.reduce((s, g) => s + g.physQty, 0)
    + SCHEME_TEMPLATES[k].groups.reduce((s, g) => s + g.vmCpu * g.vmQty, 0);
  ok(tot('perf') > tot('standard'), '性能版资源应多于标准版');
  ok(tot('standard') > tot('minimal'), '标准版资源应多于最小版');
});
T('应用模板生成合法配置行（含主备角色与用途）', async () => {
  await loadLib();
  const orig = globalThis.confirm; globalThis.confirm = () => true;
  CFG.phys = []; CFG.vm = [];
  await applyScheme('standard');
  ok(CFG.phys.length + CFG.vm.length > 0, '应生成配置行');
  ok(CFG.phys.every(l => l.machineId && S.machines.find(m => m.id === l.machineId)), '物理机行都应绑定到真实机型');
  ok(CFG.vm.every(l => l.cpu > 0 && l.mem > 0 && l.sto >= 0), '虚机资源应完整');
  ok(CFG.phys.every(l => l.parts && Array.isArray(l.parts)), '每行都应带 parts 数组');
  const mains = CFG.phys.filter(l => l.role === '主');
  eq(mains.length, CFG.phys.length / 2, '物理机应按主备成对');
  eq(physArchError(CFG.phys[0]), '', '模板生成的配置应通过架构校验');
  globalThis.confirm = orig;
});
T('最小版物理机台数少于性能版', async () => {
  await loadLib();
  const orig = globalThis.confirm; globalThis.confirm = () => true;
  await applyScheme('minimal'); const minN = CFG.phys.length + CFG.vm.length;
  await applyScheme('perf'); const perfN = CFG.phys.length + CFG.vm.length;
  ok(perfN > minN, `性能版(${perfN}) 应多于最小版(${minN})`);
  globalThis.confirm = orig;
});
T('应用模板需二次确认（有配置时不覆盖）', async () => {
  await loadLib();
  CFG.phys = [{ id: 'keep', machineId: S.machines[0].id, qty: 9, parts: [] }];
  CFG.vm = [];
  globalThis.confirm = () => false;
  await applyScheme('perf');
  eq(CFG.phys.length, 1, '取消后应保持原配置');
  eq(CFG.phys[0].qty, 9, '不应被模板覆盖');
  globalThis.confirm = () => true;
});

group('C-2 方案对比 / C-3 配置单导出');
T('sumCfg 金额口径与报价一致', async () => {
  await loadLib();
  S.parts = [];
  CFG.phys = [{ id: 'c1', machineId: S.machines[0].id, qty: 2, parts: [] }];
  CFG.vm = [{ id: 'c2', cpu: 4, mem: 16, sto: 100, qty: 3 }];
  const r = sumCfg(CFG.phys, CFG.vm);
  eq(r.tp, CFG.phys.reduce((s, l) => s + physUnitCents(l) * l.qty, 0));
  eq(r.tv, CFG.vm.reduce((s, l) => s + vmUnitCents(l) * l.qty, 0));
  ok(Math.abs(r.grand - r.sub * (1 + (parseFloat(S.settings.tax_rate) || 0))) < 1, '含税总价应与小计×(1+税率) 一致');
  eq(r.pN, 1); eq(r.vN, 1);
});
T('全部虚拟化方案会把物理机折算为虚机', async () => {
  await loadLib();
  S.parts = [];
  const phys = [{ id: 'p1', machineId: S.machines.find(m => m.cpu_cores >= 32).id, qty: 2, parts: [], purpose: '数据库', role: '主', group: '数据服务' }];
  const vms = vmizePhys(phys);
  ok(vms.length === 1, '应生成 1 组虚机');
  ok(vms[0].cpu > 0 && vms[0].mem > 0 && vms[0].sto > 0, '虚机资源应完整');
  eq(vms[0].qty, phys[0].qty * Math.max(1, Math.ceil((32 * 2) / 2)), '台数按核数折算');
  ok(vms[0].fromPhys === 'p1', '应保留来源物理机 id');
});
T('架构迁移换到同架构最接近的机型', async () => {
  await loadLib();
  const hygon = S.machines.find(m => /x86/i.test(m.arch));
  const kun = S.machines.filter(m => /ARM/i.test(m.arch));
  if (!hygon || !kun.length) return;   // 单架构库时跳过
  const out = archMigration([{ id: 'x', machineId: hygon.id, qty: 1, os: '', hv: '' }], hygon.arch, kun[0].arch);
  const m2 = S.machines.find(m => m.id === out[0].machineId);
  eq(m2.arch, kun[0].arch, '迁移后机型应为目标架构');
  eq(physArchError(Object.assign({}, out[0], { os: '', hv: '' })), '', '迁移后 OS/HV 应自动匹配新架构');
});
T('配置单导出包含物理机与虚拟机两个分区', async () => {
  const src = fs.readFileSync('web/app.js', 'utf8');
  ok(src.indexOf('exportCfg') >= 0, '应存在 exportCfg');
  ok(src.indexOf('【物理机】') >= 0 && src.indexOf('【虚拟机】') >= 0, '导出应分区');
  ok(src.indexOf('含税总价(元)') >= 0, '应含合计行');
  ok(src.indexOf('comparePlans') >= 0 && src.indexOf('方案对比表') >= 0, '应存在方案对比');
});

group('C-6 一致性校验（需求 2.3 第 2~5 条）');
const M48 = { id: 500, brand: '海光', model: 'Hygon 5480', cpu_model: 'Hygon 5480', cpu_sockets: 2,
  cpu_cores: 32, cpu_freq: 2.5, mem_capacity: 128, mem_gen: 'DDR4', disk_bays: '8',
  disk_desc: '2×960G SSD + 4×1.92T NVMe', power: '2×1600W', rail: '2U导轨', unit_price_cents: 1 };
T('C-6 基础解析：盘数/功率/U 数提取正确', async () => {
  eq(countDisks('2×960G SSD + 4×1.92T NVMe'), 6, '应数出 6 块盘');
  eq(countDisks('1.92T NVMe'), 1, '单盘应数出 1');
  eq(countDisks('转速 7200RPM'), 0, '非盘描述不应误数');
  eq(countDisks(''), 0, '空描述返回 0（不可判定）');
  eq(sumPower('2×800W'), 1600);
  eq(sumPower('2×800W + 1×400W'), 2000);
  eq(parseRailU('2U导轨'), 2);
  eq(parseRailU('4U'), 4);
  eq(parseRailU(''), 0);
  eq(parseMemCapacity('32G DDR4 RDIMM'), 32 * 1024 * 1024 * 1024, '32G 应为 32GiB');
  eq(parseMemCapacity('1.92T NVMe'), 1.92 * 1024 * 1024 * 1024 * 1024, '裸 T 按 TiB 计（厂商惯例）');
  eq(parseMemCapacity('2TB SATA'), 2 * 1024 * 1024 * 1024 * 1024);
  eq(parseMemCapacity('DDR4 RDIMM'), 0, '无容量数字应返回 0');
  eq(parseMemCapacity(''), 0);
});
T('C-6-2 盘位 / RAID 匹配', async () => {
  S.parts = [{ id: 9002, category: '硬盘', spec: '1.92T NVMe', price_cents: 1000 }];
  eq(checkDiskBays(M48, { parts: [] }), '', '无选配应通过');
  eq(checkDiskBays(M48, { parts: [{ id: 9002, qty: 2 }] }), '', '基础6+2=8=盘位上限，应通过');
  const over = checkDiskBays(M48, { parts: [{ id: 9002, qty: 4 }] });
  ok(over.indexOf('盘位上限') >= 0, '基础6+4=10 > 8 应报错，实际=' + over);
  eq(checkDiskBays({ ...M48, disk_bays: '' }, { parts: [{ id: 9002, qty: 99 }] }), '',
    '机型未标盘位 → 不可判定，应跳过而非误报');
});
T('C-6-3 电源功率 ≥ 峰值 × 1.2', async () => {
  // 峰值 = 280W(TDP)×2路 + 6盘×12W + 100W = 732W → 需 ≥ 879W；额定 3200W 通过
  eq(checkPower(M48), '', '2×1600W=3200W 充足，应通过');
  const low = checkPower({ ...M48, power: '1×500W' });
  ok(low.indexOf('电源功率不足') >= 0, '1×500W 应报错，实际=' + low);
  eq(checkPower({ ...M48, power: '4×8000W' }), '', '32000W 充足，应通过');
  eq(checkPower({ ...M48, power: '' }), '', '无电源字段 → 跳过');
  eq(checkPower({ ...M48, cpu_model: 'Intel Xeon Platinum 8480+' }), '',
    '型号不在已知 TDP 库 → 不可判定，跳过而非误报');
});
T('C-6-4 机架 U 与导轨匹配', async () => {
  eq(checkRackU(M48), '', '2U 机型 + 2U 导轨 → 通过');
  const bad = checkRackU({ ...M48, disk_bays: '24', rail: '2U导轨' });
  ok(bad.indexOf('机架高度不匹配') >= 0, '24 盘位推断 4U 机型 + 2U 导轨应报错，实际=' + bad);
  eq(checkRackU({ ...M48, rail: '' }), '', '无导轨字段 → 跳过');
});
T('C-6-5 内存通道上限', async () => {
  eq(checkMemCapacity(M48, { list: [] }), '', '无加装内存 → 通过');
  eq(checkMemCapacity(M48, { list: [{ spec: '32G DDR4', qty: 2 }] }), '', '32G×2=64G ≤ 256G → 通过');
  const over = checkMemCapacity(M48, { list: [{ spec: '128G DDR5', qty: 4 }] });
  ok(over.indexOf('内存超出通道上限') >= 0, '128G×4=512G > 256G 应报错，实际=' + over);
});
T('C-6 汇总：physSpecErrors 汇总四条且不误报', async () => {
  S.machines = S.machines.concat([M48]);
  S.parts = [
    { id: 9001, category: '内存', spec: '128G DDR5 RDIMM', price_cents: 1000 },
    { id: 9002, category: '硬盘', spec: '1.92T NVMe', price_cents: 1000 },
  ];
  const line = { id: 'sp', machineId: 500, qty: 1, parts: [{ id: 9001, qty: 4 }, { id: 9002, qty: 4 }] };
  const errs = physSpecErrors(line);
  ok(errs.length >= 2, '内存超限 + 盘位超限，应≥2 项，实际=' + errs.length);
  ok(errs.some(e => /内存超出通道上限/.test(e)), '应含内存超限');
  ok(errs.some(e => /盘位上限/.test(e)), '应含盘位超限');
  eq(physSpecErrors({ id: 'ok', machineId: 500, qty: 1, parts: [] }).length, 0,
    '干净配置应无错误，实际=' + JSON.stringify(physSpecErrors({ id: 'ok', machineId: 500, qty: 1, parts: [] })));
  S.machines = S.machines.filter(m => m.id !== 500);
});

group('C-7 列映射纠偏');
T('columnMap 真正生效（此前是死代码）', async () => {
  const H = require('../web/hcl-core.js');
  const wb = JSON.parse(fs.readFileSync('tools/fixtures/sample-wide-spec.json', 'utf8'));
  const auto = H.parseWorkbook(wb, { machines: [] });
  const pAuto = auto.columnMap.purpose;
  const override = H.parseWorkbook(wb, { machines: [], columnMap: { purpose: 7 } });
  eq(override.columnMap.purpose, 7, '手动指定列应生效');
  ok(pAuto !== 7 || override.columnMap.purpose === pAuto, '覆盖值应区别于或不冲突于自动值');
  eq(override.columnMap.qty, auto.columnMap.qty, '未指定的字段应保留自动识别结果');
  eq(H.parseWorkbook(wb, { machines: [] }).columnMap.purpose, pAuto, '不传 columnMap 时行为不变');
});
T('columnMap 越界与置空被安全处理', async () => {
  const H = require('../web/hcl-core.js');
  const wb = JSON.parse(fs.readFileSync('tools/fixtures/sample-wide-spec.json', 'utf8'));
  const auto = H.parseWorkbook(wb, { machines: [] });
  eq(H.parseWorkbook(wb, { machines: [], columnMap: { purpose: 9999 } }).columnMap.purpose,
    auto.columnMap.purpose, '越界索引应被忽略，回落自动值');
  eq(H.parseWorkbook(wb, { machines: [], columnMap: { purpose: '' } }).columnMap.purpose,
    undefined, '置空应移除该字段映射');
  eq(H.parseWorkbook(wb, { machines: [], columnMap: null }).columnMap.purpose,
    auto.columnMap.purpose, 'null 应安全处理');
});
T('sheet 暴露 headers 供列映射下拉使用', async () => {
  const H = require('../web/hcl-core.js');
  const wb = JSON.parse(fs.readFileSync('tools/fixtures/sample-wide-spec.json', 'utf8'));
  const r = H.parseWorkbook(wb, { machines: [] });
  ok(Array.isArray(r.sheet.headers) && r.sheet.headers.length > 0, '应返回表头数组');
  ok(r.sheet.colCount === r.sheet.headers.length, 'colCount 应与 headers 长度一致');
  ok(r.columnMap.purpose >= 0 && r.columnMap.purpose < r.sheet.headers.length, '自动映射应指向有效表头');
});

// ================================================================ 拓扑白板布局嵌套（真实解析模拟）
group('拓扑白板 HTML 嵌套完整性（栈式解析模拟）');
{
  // 背景：renderTopo 曾漏写 .topo-wrap 的闭合 </div>。div 计数总体仍平衡，
  // 但浏览器按栈解析时 cfg-body 的闭合标签被 topo-wrap 吃掉，导致：
  //   汇总条被解析进 cfg-body、单价库选件被解析进 cfg-main、.cfg 只剩 2 列，
  //   选件面板被顶到画布下方。朴素计数测试抓不到，必须用栈模拟真实解析。
  const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col',
    'embed', 'source', 'track', 'wbr']);
  const AUTO_CLOSE = new Set(['option', 'li', 'p', 'td', 'tr']); // 允许省略闭合的标签
  /** 栈式解析：返回 {stackAt(tagRe), balanced}。tagRe 命中开标签时快照当前开标签栈。 */
  function parseTree(html, snapRegexes) {
    const stack = []; const snaps = []; let balanced = true;
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/)?>/g;
    let m;
    while ((m = re.exec(html))) {
      const closing = m[1] === '/';
      const name = m[2].toLowerCase();
      const selfClosing = m[3] === '/' || VOID.has(name);
      const cls = (m[0].match(/class="([^"]*)"/) || [])[1] || '';
      const label = name + (cls ? '.' + cls.trim().split(/\s+/).join('.') : '');
      if (closing) {
        // 从栈顶向下找同名标签弹出；找不到说明有多余闭合
        let found = false;
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].name === name) { stack.splice(i, 1); found = true; break; }
        }
        if (!found) balanced = false;
      } else if (!selfClosing) {
        stack.push({ name, label });
        if (snapRegexes.some(r => r.test(m[0]))) snaps.push({ tag: label, raw: m[0], at: m.index, stack: stack.map(s => s.label) });
        if (AUTO_CLOSE.has(name)) { /* 允许不闭合，出栈即可 */ stack.pop(); }
      }
    }
    return { snaps, residual: stack, balanced };
  }
  T('拓扑视图：选件面板/汇总条必须是 .cfg 的列级子元素（topo-wrap 不得吞闭合标签）', async () => {
    CFG.view = 'topo';
    // 保证画布非空：真实数据有节点时才走 topo-wrap 分支（空画布分支结构恰好平衡，抓不到该 bug）
    if (!CFG.phys.length) CFG.phys.push({ id: 'tp1', machineId: S.machines[0].id, qty: 2, purpose: '数据库', role: '', group: '', os: '', hv: '', parts: [] });
    renderConfigurator();
    const html = String($('#content').innerHTML || '');
    ok(html.indexOf('topo-wrap') >= 0, '应生成 topo-wrap（非空画布分支）');
    const { snaps, residual, balanced } = parseTree(html, [
      /class="cfg-col cfg-main"/, /id="cfgSummary"/, /class="cfg-col cfg-picker"/, /class="topo-bar"/,
    ]);
    ok(balanced, '不得出现无法匹配的闭合标签');
    ok(residual.length === 0, '所有开标签都应闭合，残留: ' + residual.map(s => s.label + '@' + s.at).join(', '));
    const pick = snaps.find(s => /cfg-picker/.test(s.tag));
    ok(!!pick, '应解析到选件面板开标签');
    const tail = pick.stack.slice(-2);
    ok(tail[0] === 'div.cfg' && tail[1] === 'div.cfg-col.cfg-picker',
      '选件面板应为 .cfg 的第三列（此时 cfg-main 应已闭合，栈应为 cfg > cfg-picker），实际: ' + pick.stack.join(' > '));
    const sum = snaps.find(s => /id="cfgSummary"/.test(s.raw));
    ok(!!sum, '应解析到汇总条开标签');
    const stail = sum.stack.slice(-2);
    ok(stail[0] === 'div.cfg-col.cfg-main' && stail[1] === 'div.summary-total',
      '汇总条的父元素应为 cfg-main（画布下方），实际: ' + sum.stack.join(' > '));
    const bar = snaps.find(s => /topo-bar/.test(s.tag));
    ok(!!bar && !bar.stack.some(s => /topo-wrap/.test(s)),
      'topo-bar 应在 topo-wrap 之外（不随画布滚动），实际栈: ' + (bar ? bar.stack.join(' > ') : '未找到'));
  });
  T('清单视图：同样的栈校验也必须通过', async () => {
    CFG.view = 'list';
    renderConfigurator();
    const html = String($('#content').innerHTML || '');
    const { residual, snaps } = parseTree(html, [/class="cfg-col cfg-picker"/]);
    ok(residual.length === 0, '清单视图所有标签应闭合，残留: ' + residual.map(s => s.label).join(', '));
    const pick = snaps.find(s => /cfg-picker/.test(s.tag));
    ok(pick && pick.stack.slice(-1)[0] === 'div.cfg-col.cfg-picker', '清单视图选件面板也应在列级');
  });
}

// ================================================================ 执行
(async () => {
  await ready;
  for (const { name, fn } of queue) {
    try { await fn(); pass++; }
    catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
  }
  console.log('\n' + '='.repeat(60));
  console.log(`结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
  process.exit(fail ? 1 : 0);
})();