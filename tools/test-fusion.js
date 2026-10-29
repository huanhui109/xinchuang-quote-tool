/* 融合模型单测 —— 报价工具 × DCIM 机房设备管理（M1.0 地基 + M0–M7）
 *
 * 运行： node tools/test-fusion.js
 *
 * 设计要点：
 *  1) DOM 桩刻意用「最严格」版本 —— 没有 addEventListener、没有 getElementById、
 *     querySelector 永不返回 null、querySelectorAll 恒返回 []、innerHTML 不解析 HTML。
 *     这样任何新代码若用 UI.el(tag,{onclick}) 或 DataTable.render() 会立刻抛错暴露，
 *     而不是等到真实浏览器里才炸。
 *  2) fetch 恒抛错 → 强制走 localApi 离线回退分支，顺带验证「离线不白屏」。
 *  3) 断言一律用字符串 indexOf / 纯函数比较，不用 DOM 查询（桩里查不出东西）。
 */
'use strict';
const fs = require('fs');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function ok(v, msg) {
  if (v) { pass++; console.log('  [PASS] ' + msg); }
  else { fail++; failures.push(msg); console.log('  [FAIL] ' + msg); }
}
function eq(a, b, msg) {
  ok(JSON.stringify(a) === JSON.stringify(b),
    msg + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）');
}
function group(n) { console.log('\n# ' + n); }

// ================================================================ 浏览器桩
function El(tag) {
  this.tagName = String(tag || 'div').toUpperCase(); this.children = []; this.style = {}; this.dataset = {}; this._attrs = {};
  const c = new Set();
  this.classList = { add: x => c.add(x), remove: x => c.delete(x), contains: x => c.has(x), toggle: (x, f) => { f ? c.add(x) : c.delete(x); } };
  this.innerHTML = ''; this.textContent = '';
  this.offsetLeft = 0; this.offsetTop = 0; this.offsetWidth = 196; this.offsetHeight = 72;
  this.scrollWidth = 1400; this.scrollHeight = 900; this.clientWidth = 1400; this.clientHeight = 900; this.firstChild = null;
  this.value = ''; this.files = []; this.checked = false; this.disabled = false;
}
El.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); };
El.prototype.getAttribute = function (k) { return (k in this._attrs) ? this._attrs[k] : null; };
El.prototype.querySelector = function (s) { const k = this.tagName + ':' + s; if (!cache.has(k)) cache.set(k, new El('div')); return cache.get(k); };
El.prototype.querySelectorAll = function () { return []; };
El.prototype.appendChild = function (c) { this.children.push(c); this.firstChild = this.children[0]; return c; };
El.prototype.removeChild = function (c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); this.firstChild = this.children[0] || null; } return c; };
El.prototype.remove = function () {};
El.prototype.click = function () {};
// 刻意不提供 addEventListener —— 与 test-app-smoke.js 保持同样的严格度
const cache = new Map();
global.document = {
  body: new El('body'),
  createElement: t => new El(t),
  createElementNS: (n, t) => new El(t),
  querySelector: s => { if (!cache.has(s)) cache.set(s, new El('div')); return cache.get(s); },
  querySelectorAll: s => { if (!cache.has(s)) cache.set(s, []); return cache.get(s); },
};
const LS = {};
global.localStorage = { getItem: k => (k in LS ? LS[k] : null), setItem: (k, v) => { LS[k] = String(v); }, removeItem: k => { delete LS[k]; } };
global.location = { hash: '' };
globalThis.addEventListener = function () {};
globalThis.confirm = () => true;
globalThis.prompt = () => '测试';
global.window = globalThis;
global.URL = URL;
global.Blob = class { constructor(a) { this.parts = a; } };
global.URLSearchParams = URLSearchParams;
global.URL.createObjectURL = () => 'blob:mock';
global.URL.revokeObjectURL = () => {};
// 强制离线 → 走 localApi 回退分支
global.fetch = async () => { throw new Error('offline stub'); };

vm.runInThisContext(fs.readFileSync('web/arch-graph.js', 'utf8'), { filename: 'arch-graph.js' });
vm.runInThisContext(fs.readFileSync('web/arch-diagram.js', 'utf8'), { filename: 'arch-diagram.js' });
vm.runInThisContext(fs.readFileSync('web/hcl-core.js', 'utf8'), { filename: 'hcl-core.js' });
vm.runInThisContext(fs.readFileSync('web/xlsx-read.js', 'utf8'), { filename: 'xlsx-read.js' });
vm.runInThisContext(fs.readFileSync('web/hcl-view.js', 'utf8'), { filename: 'hcl-view.js' });
vm.runInThisContext(fs.readFileSync('web/ui.js', 'utf8'), { filename: 'ui.js' });

// ================================================================ 基础事实
group('基础：图标与样式定义');
ok(typeof Icons !== 'undefined' && !!Icons.arrow, 'Icons.arrow 已定义（仪表盘箭头此前渲染 undefined）');
ok(String(Icons.arrow || '').indexOf('svg') >= 0, 'Icons.arrow 是 inline SVG');
ok(Object.keys(Icons || {}).every(k => String(Icons[k]).indexOf('<svg') >= 0), '全部 Icons 均为 inline SVG');

group('基础：前端脚本顶层执行');
try {
  vm.runInThisContext(fs.readFileSync('web/app.js', 'utf8'), { filename: 'app.js' });
  ok(true, 'app.js 顶层执行无异常（离线回退模式）');
} catch (e) {
  ok(false, 'app.js 顶层异常：' + (e.stack || e));
}

// NAV_ICONS 定义在 app.js（导航专用图标集合，与 ui.js 的通用 Icons 是两套）
ok(typeof NAV_ICONS !== 'undefined', 'NAV_ICONS 存在（导航图标集合）');
if (typeof NAV_ICONS !== 'undefined') {
  const need = ['devices', 'space', 'rackview', 'delivery'];
  const miss = need.filter(k => !NAV_ICONS[k]);
  eq(miss, [], 'NAV_ICONS 含资产侧 4 个图标');
  ok(need.every(k => String(NAV_ICONS[k] || '').indexOf('<svg') >= 0), '资产侧图标均为 inline SVG');
  ok(Object.keys(NAV_ICONS).every(k => String(NAV_ICONS[k]).indexOf('<svg') >= 0),
    '全部 NAV_ICONS 均为 inline SVG（禁用 emoji）');
}

group('基础：融合常量与角色机制');
ok(typeof ROLE_OPTIONS !== 'undefined' && ROLE_OPTIONS.length === 4, 'ROLE_OPTIONS 有 4 个角色');
if (typeof ROLE_OPTIONS !== 'undefined') {
  const vs = ROLE_OPTIONS.map(o => o.v);
  eq(vs.slice().sort(), ['delivery', 'ops', 'sales', 'viewer'], '角色取值 = sales/delivery/ops/viewer');
}
ok(typeof currentRole === 'function', 'currentRole() 存在');
ok(typeof setRole === 'function', 'setRole() 存在');
ok(String(typeof currentRole === 'function' ? currentRole() : '') === 'sales', '缺省角色为 sales（向后兼容）');

group('基础：资产侧存储结构');
ok(typeof S !== 'undefined' && !!S.assets, 'S.assets 存在');
if (typeof S !== 'undefined' && S.assets) {
  const need = ['devices', 'rooms', 'racks', 'rack_units', 'deliveries', 'links', 'price_feedback'];
  const miss = need.filter(k => !(k in S.assets));
  eq(miss, [], 'S.assets 含全部 7 个子集合');
}
ok(typeof STORE !== 'undefined' && !!STORE.assets, 'STORE.assets 存在（localStorage 持久化骨架）');

/* ================================================================
 * 以下为异步断言（需要 await）
 * ================================================================ */
(async () => {
  try {
    group('M1.0-e：applyScheme 资产侧隔离');
    // 造资产侧数据：切换模板不得影响它们
    STORE.assets = STORE.assets || {};
    STORE.assets.devices = [{ id: 9001, code: 'ASSET-KEEP', state: 'planned' }];
    STORE.assets.rack_units = [{ id: 9002, rack_id: 1, u_index: 0, device_id: 9001 }];
    STORE.assets.deliveries = [{ id: 9003, quote_id: 1, device_count: 14 }];
    const beforeDevices = STORE.assets.devices.length;
    const beforeUnits = STORE.assets.rack_units.length;
    const beforeDeliveries = STORE.assets.deliveries.length;
    const beforeLinks = (STORE.assets.links || []).length;
    // applyScheme 只清空 CFG（规划态），不动资产侧
    global.confirm = () => true;
    await applyScheme(Object.keys(SCHEME_TEMPLATES)[0]);
    eq(STORE.assets.devices.length, beforeDevices, 'applyScheme 后资产侧 devices 数量不变');
    eq(STORE.assets.rack_units.length, beforeUnits, 'applyScheme 后资产侧 rack_units 数量不变');
    eq(STORE.assets.deliveries.length, beforeDeliveries, 'applyScheme 后资产侧 deliveries 数量不变');
    eq((STORE.assets.links || []).length, beforeLinks, 'applyScheme 后资产侧 links 数量不变');
    ok(true, 'applyScheme 只作用于规划态 CFG，未波及运行态资产侧');

    group('M5：角色菜单级隔离');
    await setRole('ops');
    eq(currentRole(), 'ops', 'setRole(ops) 生效');
    renderNav();
    const navOps = String(document.querySelector('#nav').innerHTML || '');
    ok(navOps.indexOf('单价库') < 0, 'ops 导航不含「单价库」');
    ok(navOps.indexOf('报价单') < 0, 'ops 导航不含「报价单」');
    ok(navOps.indexOf('设备台账') >= 0, 'ops 导航含「设备台账」');
    ok(navOps.indexOf('机房') >= 0, 'ops 导航含「机房」');
    ok(navOps.indexOf('交付批次') >= 0, 'ops 导航含「交付批次」');
    await setRole('sales');
    renderNav();
    const navSales = String(document.querySelector('#nav').innerHTML || '');
    ok(navSales.indexOf('单价库') >= 0, 'sales 导航含「单价库」');
    ok(navSales.indexOf('报价单') >= 0, 'sales 导航含「报价单」');
    ok(navSales.indexOf('设备台账') >= 0, 'sales 导航含「设备台账」');

    group('M5：localApi 角色裁剪（离线也必须裁剪）');
    await setRole('ops');
    let threw = null;
    try { await localApi('GET', '/api/quotes'); } catch (e) { threw = e; }
    ok(threw && threw.status === 403, '离线 ops 请求 /api/quotes 抛 403 风格错误');
    threw = null;
    try { await localApi('GET', '/api/machines'); } catch (e) { threw = e; }
    ok(threw && threw.status === 403, '离线 ops 请求 /api/machines 抛 403');
    threw = null;
    try { await localApi('POST', '/api/versions', { name: 'x' }); } catch (e) { threw = e; }
    ok(threw && threw.status === 403, '离线非 sales 新建定价版本被拒（发布权仅 sales）');
    // settings 用字段裁剪而非 403（否则 loadLib 会炸）
    const stOff = await localApi('GET', '/api/settings');
    ok(!('tax_rate' in stOff), '离线 ops 的 settings 已剥离 tax_rate（用裁剪而非 403）');
    await setRole('sales');
    const stOn = await localApi('GET', '/api/settings');
    ok('tax_rate' in stOn, '离线 sales 的 settings 保留 tax_rate');

    group('M5：localApi 资产侧端点离线可调用（不白屏）');
    const heads = [
      ['GET', '/api/devices'], ['GET', '/api/rooms'], ['GET', '/api/racks'],
      ['GET', '/api/rack_units'], ['GET', '/api/deliveries'], ['GET', '/api/links'],
      ['GET', '/api/asset_changes'], ['GET', '/api/reconciliations'],
      ['GET', '/api/whoami'], ['GET', '/api/events/health'],
      ['GET', '/api/assets/export'],
    ];
    for (const [m, p] of heads) {
      let r = null, err = null;
      try { r = await localApi(m, p); } catch (e) { err = e; }
      ok(!err, '离线 ' + m + ' ' + p + ' 不抛异常' + (err ? '（' + err.message + '）' : ''));
      ok(r !== undefined && r !== null, '离线 ' + m + ' ' + p + ' 返回非空结果');
    }
    // 脱敏导出：7 列，无价格
    const exp = await localApi('GET', '/api/assets/export');
    eq(exp.columns, ['资产编号', '型号', 'SN', '机房', '机柜', 'U位', '状态'], '离线脱敏导出列头为 7 列');
    const expText = JSON.stringify(exp);
    ok(expText.indexOf('单价') < 0 && expText.indexOf('金额') < 0 && expText.indexOf('税率') < 0 && expText.indexOf('含税') < 0,
      '离线脱敏导出不含任何价格字样');

    group('M5：price_feedback 本人可见（采价权 ≠ 发布权）');
    await setRole('delivery');
    await localApi('POST', '/api/price_feedback', { sku_id: 1, actual_price_cents: 1000, source: 'supplier' });
    const mine = await localApi('GET', '/api/price_feedback');
    eq(mine.length, 1, 'delivery 可见自己提交的 1 条');
    await setRole('ops');
    const others = await localApi('GET', '/api/price_feedback');
    eq(others.length, 0, 'ops 看不到 delivery 提交的记录（本人可见原则）');
    await setRole('sales');
    const all = await localApi('GET', '/api/price_feedback');
    eq(all.length, 1, 'sales 可见全部 price_feedback');
    await setRole('viewer');
    threw = null;
    try { await localApi('GET', '/api/price_feedback'); } catch (e) { threw = e; }
    ok(threw && threw.status === 403, 'viewer 访问 price_feedback 被拒');

    group('M1.0：报价条目锚点字段');
    await setRole('sales');
    CFG.phys = [{ id: 'x1', machineId: S.machines[0].id, qty: 14, parts: [], purpose: '数据库', role: '主' }];
    CFG.vm = [{ id: 'v1', cpu: 4, mem: 8, sto: 100, qty: 2 }];
    await doSaveQuote('锚点测试单', 1000, 1130);
    const lastQuote = STORE.quotes[STORE.quotes.length - 1];
    const its = lastQuote.items || [];
    ok(its.length >= 2, '报价单含条目（物理机 + 虚机）');
    eq(its[0].item_no, 1, 'items[0].item_no = 1');
    eq(its[1].item_no, 2, 'items[1].item_no = 2');
    eq(its[0].legacy, 0, '新单 items[0].legacy = 0（强锚点）');
    ok(its[0].line_uid === `q_${lastQuote.id}_1`, 'items[0].line_uid = q_<quoteId>_1（实际 ' + its[0].line_uid + '）');
    ok(its[1].line_uid === `q_${lastQuote.id}_2`, 'items[1].line_uid = q_<quoteId>_2');

    group('离线健壮性：4 个新路由不白屏');
    // ⚠ 不能只断言「无加载失败」：ROUTES 里没注册的 key 会回落到 viewDashboard，
    // 那样也会渲染出几千字符 —— 属于假通过。必须同时验证确实渲染了资产侧视图。
    const routeChecks = [
      ['#/assets/devices', ['设备台账', '资产编号']],
      ['#/assets/space', ['机房', '机柜']],
      ['#/assets/rackview', ['U 位', '机柜']],
      ['#/assets/deliveries', ['交付批次', '报价单']],
    ];
    for (const [h, markers] of routeChecks) {
      global.location.hash = h;
      await route();
      const html = String(document.querySelector('#content').innerHTML || '');
      ok(html.indexOf('加载失败') < 0, '路由 ' + h + ' 无「加载失败」');
      ok(html.length > 20, '路由 ' + h + ' 渲染出内容（长度 ' + html.length + '）');
      const hit = markers.filter(m => html.indexOf(m) >= 0);
      eq(hit.length, markers.length,
        '路由 ' + h + ' 渲染的是资产侧视图而非回落的概览页（命中 ' + hit.join('/') + '）');
    }
  } catch (e) {
    ok(false, '断言执行异常：' + (e.stack || e));
  }

  console.log('\n' + '='.repeat(60));
  console.log('结果：%d 通过 / %d 失败（共 %d 项）', pass, fail, pass + fail);
  if (failures) {
    console.log('失败项：');
    failures.forEach(f => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
})();
