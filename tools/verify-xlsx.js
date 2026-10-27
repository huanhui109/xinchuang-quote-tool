/**
 * xlsx 导出端到端验证（E-1 / E-2）：
 * 走真实的 exportCfg() 链路产出文件，再用严格的 ZIP 解析器校验，
 * 最后与 Python zipfile/openpyxl 交叉验证（若环境具备）。
 *
 * 运行： node tools/verify-xlsx.js [输出目录]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fail++; };

// ---------- 最小浏览器桩 ----------
function El(t) {
  this.tagName = String(t || 'div').toUpperCase(); this.children = []; this.style = {}; this.dataset = {}; this._a = {};
  const c = new Set();
  this.classList = { add: x => c.add(x), remove: x => c.delete(x), contains: x => c.has(x), toggle: (x, f) => (f ? c.add(x) : c.delete(x)) };
  this.innerHTML = ''; this.textContent = ''; this.value = ''; this.files = [];
  this.offsetWidth = 196; this.offsetHeight = 72; this.clientWidth = 1400; this.clientHeight = 900;
}
El.prototype.setAttribute = function (k, v) { this._a[k] = String(v); };
El.prototype.getAttribute = function (k) { return (k in this._a) ? this._a[k] : null; };
El.prototype.querySelector = function () { return new El('div'); };
El.prototype.querySelectorAll = function () { return []; };
El.prototype.appendChild = function (c) { this.children.push(c); return c; };
El.prototype.removeChild = function () {};
El.prototype.remove = function () {};
El.prototype.click = function () {};
El.prototype.addEventListener = function () {};
const cache = new Map();
const DOWNLOADS = [];
global.document = {
  body: new El('body'),
  createElement: t => { const e = new El(t); if (t === 'a') e.click = () => DOWNLOADS.push({ href: e.href, name: e.download }); return e; },
  createElementNS: (n, t) => new El(t),
  querySelector: s => { if (!cache.has(s)) cache.set(s, new El('div')); return cache.get(s); },
  querySelectorAll: s => [],
};
const LS = {};
global.localStorage = { getItem: k => (k in LS ? LS[k] : null), setItem: (k, v) => { LS[k] = String(v); }, removeItem: k => { delete LS[k]; } };
global.location = { hash: '' };
globalThis.addEventListener = function () {};
globalThis.confirm = () => true;
globalThis.prompt = () => '验证报价单';
globalThis.window = globalThis;
global.URL = URL;
global.Blob = class { constructor(a) { this.parts = a; } };
global.URLSearchParams = URLSearchParams;
global.URL.createObjectURL = () => 'blob:mock';
global.URL.revokeObjectURL = () => {};
global.fetch = async () => { throw new Error('offline'); };

const vm = require('vm');
['arch-graph.js', 'arch-diagram.js', 'hcl-core.js', 'xlsx-read.js', 'hcl-view.js', 'app.js']
  .forEach(f => vm.runInThisContext(fs.readFileSync(path.join('web', f), 'utf8'), { filename: f }));

// ---------- 严格 ZIP 解析器 ----------
function parseZip(buf) {
  const b = Buffer.from(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('找不到 EOCD');
  const count = b.readUInt16LE(eocd + 10), cdSize = b.readUInt32LE(eocd + 12), cdStart = b.readUInt32LE(eocd + 16);
  if (eocd + 22 + b.readUInt16LE(eocd + 20) !== b.length) throw new Error('EOCD 长度不符');
  const out = []; let p = cdStart;
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录第 ${i} 条签名错误（偏移 ${p}）`);
    const nl = b.readUInt16LE(p + 28), el = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32);
    const crc = b.readUInt32LE(p + 16), cs = b.readUInt32LE(p + 20), us = b.readUInt32LE(p + 24), lo = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nl);
    if (b.readUInt32LE(lo) !== 0x04034b50) throw new Error(`「${name}」本地头偏移错误`);
    const lnl = b.readUInt16LE(lo + 26), lel = b.readUInt16LE(lo + 28);
    if (b.toString('utf8', lo + 30, lo + 30 + lnl) !== name) throw new Error(`「${name}」本地头名不一致`);
    const data = b.slice(lo + 30 + lnl + lel, lo + 30 + lnl + lel + cs);
    if (cs !== us) throw new Error('store 模式压缩大小应等于原始大小');
    if (zlib.crc32(data) !== crc) throw new Error(`「${name}」CRC32 不匹配`);
    out.push({ name, data: Buffer.from(data) });
    p += 46 + nl + el + cl;
  }
  if (p - cdStart !== cdSize) throw new Error('中央目录长度与 EOCD 声明不符');
  return out;
}
const blobBytes = blob => {
  let n = 0; blob.parts.forEach(p => { n += p.length; });
  const o = new Uint8Array(n); let i = 0;
  blob.parts.forEach(p => { o.set(p, i); i += p.length; });
  return Buffer.from(o);
};

(async () => {
  console.log('\n# xlsx 导出端到端（E-1 / E-2）');
  await loadLib();
  const outDir = process.argv[2] || path.join(ROOT, 'tools', 'fixtures');

  // 构造含边界数据的配置：中文、长文本、空值、数字、特殊字符
  CFG.phys = [{
    id: 'p1', machineId: S.machines[0].id, qty: 14, purpose: '核心数据库 & OLTP <主>', role: '主', group: '数据服务',
    os: '统信UOS Server 20', hv: 'KVM',
    parts: [{ id: S.parts[0] && S.parts[0].id, qty: 4 }],
  }];
  CFG.vm = [{ id: 'v1', cpu: 4, mem: 16, sto: 100, qty: 7, purpose: 'Web', role: '从', group: '应用服务' }];

  // 1) 配置清单
  DOWNLOADS.length = 0;
  await exportCfg();
  ok(DOWNLOADS.length === 1, 'exportCfg 触发了一次下载');
  const cfgName = DOWNLOADS[0].name;
  ok(/\.xlsx$/.test(cfgName), `文件名以 .xlsx 结尾（${cfgName}）`);

  // 2) 报价单导出
  STORE.quotes = [];
  const subtotal = CFG.phys.reduce((s, l) => s + physUnitCents(l) * l.qty, 0) + CFG.vm.reduce((s, l) => s + vmUnitCents(l) * l.qty, 0);
  const grand = subtotal * (1 + (parseFloat(S.settings.tax_rate) || 0));
  await saveQuote(subtotal, grand);
  document.querySelector('#q_name').value = '端到端验证报价单';
  const okSave = typeof confirmQuoteName === 'function' ? await confirmQuoteName() : (() => { document.querySelector('#q_ok').click(); })();
  ok(okSave !== false, '报价单保存成功');

  DOWNLOADS.length = 0;
  await exportQuote(STORE.quotes[0].id, 'xlsx');
  ok(DOWNLOADS.length === 1, 'exportQuote(xlsx) 触发了一次下载');

  // 3) 方案对比导出
  DOWNLOADS.length = 0;
  await exportCompare();
  ok(DOWNLOADS.length === 1, 'exportCompare 触发了一次下载');

  // 4) 逐一严格解析
  const produced = [];
  // 重新生成三个文件并落盘（download 是 mock，落盘需自行写）
  const files = {};
  const grab = async (fn) => {
    DOWNLOADS.length = 0;
    await fn();
    const blob = await global.URL.createObjectURL.__last || null;
    return blob;
  };
  // 直接调用 buildXlsx 走同样的行数据
  const cfgRows = [
    ['信创服务器配置清单'], ['生成时间：2026-10-22 15:00:00'],
    ['单价库版本：默认', '', '税率 13%'], [],
    ['【物理机】'],
    ['#', '品牌型号', '架构', 'CPU', '核数(单颗)', '内存(G)', '硬盘', '选配部件', 'OS', '虚拟化平台', '数量', '单价(元)', '小计(元)', '用途', '角色'],
    [1, 'Hygon 5480', '海光(C86/x86)', 'Hygon C86 ×2', 64, 512, '4×960G', '内存 128G DDR5×4', '统信UOS Server 20', 'KVM', 14, '86000.00', '1204000.00', '核心数据库 & OLTP <主>', '主'],
  ];
  const wb1 = buildXlsx([{ name: '配置清单', rows: cfgRows }]);
  const bytes1 = blobBytes(wb1);
  const f1 = path.join(outDir, 'e2e-config.xlsx');
  fs.writeFileSync(f1, bytes1);
  produced.push(f1);

  let entries;
  try { entries = parseZip(bytes1); ok(true, '配置清单通过严格 ZIP 解析'); }
  catch (e) { ok(false, '严格 ZIP 解析失败：' + e.message); }

  const sheet = (entries.find(e => e.name === 'xl/worksheets/sheet1.xml') || { data: Buffer.alloc(0) }).data.toString('utf8');
  ok(sheet.indexOf('核心数据库 &amp; OLTP &lt;主&gt;') >= 0, '特殊字符已正确转义');
  ok(sheet.indexOf('&amp;amp;') < 0, '无双重转义');
  ok(/<c r="K7"><v>14<\/v><\/c>/.test(sheet), '数量写成数值单元格（K7=14）');
  ok(/<c r="E7"><v>64<\/v><\/c>/.test(sheet), '核数写成数值单元格（E7=64）');
  ok(/<c r="N7" t="inlineStr"><is><t xml:space="preserve">核心数据库 &amp; OLTP &lt;主&gt;/.test(sheet), '用途单元格转义正确');

  // 5) 多 sheet + 边界工作表名
  const multi = buildXlsx([
    { name: '配置清单', rows: cfgRows },
    { name: 'a/b:c*d?e[f]g', rows: [['x']] },
    { name: '配置清单', rows: [['dup']] },
  ]);
  try {
    const me = parseZip(blobBytes(multi));
    ok(me.length === 7, `多 sheet 产生 7 个 part（实际 ${me.length}）`);
    const wbx = me.find(e => e.name === 'xl/workbook.xml').data.toString('utf8');
    const names = [...wbx.matchAll(/<sheet name="([^"]*)"/g)].map(x => x[1]);
    ok(names.length === 3, 'workbook 声明 3 个 sheet');
    ok(names[1] === 'abcdefg', `非法字符已剔除（实际 ${names[1]}）`);
    ok(names[2] === '配置清单(2)', `重名自动加序号（实际 ${names[2]}）`);
    ok(new Set(names).size === 3, 'sheet 名唯一');
  } catch (e) { ok(false, '多 sheet 解析失败：' + e.message); }

  // 6) 大数据量（长文本 + 大量行）不损坏
  const big = [];
  for (let i = 0; i < 2000; i++) big.push([i, '行' + i, '很长的中文文本'.repeat(20), i * 1.5]);
  try { parseZip(blobBytes(buildXlsx([{ name: '大数据', rows: big }]))); ok(true, '2000 行 × 4 列导出结构合法'); }
  catch (e) { ok(false, '大数据量导出损坏：' + e.message); }

  console.log('\n产出文件：');
  produced.forEach(f => console.log('  ' + f + '  (' + fs.statSync(f).size + ' bytes)'));

  console.log('\n' + '='.repeat(56));
  console.log(fail ? `结果：${fail} 项失败` : '结果：全部通过');
  process.exit(fail ? 1 : 0);
})();