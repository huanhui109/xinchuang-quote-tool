/* 部署架构图单元测试：引擎算法 + 视图冒烟（Node 运行，零依赖）
 * 运行： node tools/test-arch.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const fails = [];
let passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('[PASS] ' + name + (extra ? '  ' + extra : '')); }
  else { fails.push(name); console.log('[FAIL] ' + name + (extra ? '  ' + extra : '')); }
}

const A = require(path.join(ROOT, 'web', 'arch-graph.js'));

console.log('========== 一、自动布局引擎 ==========');

// 1. 空清单
{
  const g = A.layout({ components: [] });
  check('空清单 -> empty=true', g.empty === true);
  check('空清单 -> 告警 EMPTY_LIST', (g.warnings[0] || {}).code === 'EMPTY_LIST');
  const xml = A.toDrawioXml(g);
  check('空清单 -> 生成占位提示图', xml.indexOf('暂无部署组件') >= 0 && xml.indexOf('mxfile') >= 0);
}

// 2. 自环 / 悬挂引用
{
  const m = {
    components: [
      { id: 'a', name: '交易网关', depends_on: ['a', 'ghost'], connects: ['ghost'] },
      { id: 'b', name: 'Oracle数据库' }
    ]
  };
  const g = A.layout(m);
  const codes = g.warnings.map(w => w.code);
  check('自环被忽略并告警', codes.indexOf('SELF_LOOP') >= 0);
  check('悬挂引用被忽略并告警', codes.indexOf('DANGLING_REF') >= 0);
  check('布局仍产出节点', g.nodes.length === 2, 'nodes=' + g.nodes.length);
}

// 3. 循环依赖
{
  const m = {
    components: [
      { id: 'a', name: 'A服务', purpose: '应用服务', depends_on: ['b'] },
      { id: 'b', name: 'B服务', purpose: '中间件', depends_on: ['c'] },
      { id: 'c', name: 'C服务', purpose: '数据服务', depends_on: ['a'] }
    ]
  };
  const t0 = Date.now();
  const g = A.layout(m);
  const cost = Date.now() - t0;
  const codes = g.warnings.map(w => w.code);
  check('循环依赖 -> CYCLE_DEP 告警', codes.indexOf('CYCLE_DEP') >= 0);
  check('循环依赖 -> 布局可收敛', g.stats.layers > 0 && cost < 1000, 'layers=' + g.stats.layers + ' cost=' + cost + 'ms');
  check('回边被降级为互联', g.edges.some(e => e.kind === 'connects'));
}

// 4. 超大图截断
{
  const comps = [];
  for (let i = 0; i < 800; i++) comps.push({ id: 'c' + i, name: '组件' + i, purpose: '应用服务', qty: 1 });
  const t0 = Date.now();
  const g = A.layout({ components: comps }, { maxNodes: 300 });
  const cost = Date.now() - t0;
  check('超大图 -> 节点被截断到 300', g.nodes.length === 300, 'nodes=' + g.nodes.length);
  check('超大图 -> TRUNCATED 告警', g.warnings.some(w => w.code === 'TRUNCATED'));
  check('超大图 -> 3 秒内完成布局', cost < 3000, cost + 'ms');
}

// 5. 层级与分组：上层依赖下层，节点不能重叠
{
  const m = {
    components: [
      { id: 'gw', name: '负载均衡', purpose: '接入层', qty: 2, depends_on: ['app'] },
      { id: 'app', name: '交易应用', purpose: '应用服务', qty: 4, depends_on: ['db'] },
      { id: 'app2', name: '柜面应用', purpose: '应用服务', qty: 3, depends_on: ['db'] },
      { id: 'db', name: 'Oracle数据库', purpose: '数据服务', qty: 1 }
    ]
  };
  const g = A.layout(m);
  const layer = {}; g.nodes.forEach(n => layer[n.id] = n.layer);
  check('层级：接入层(0) < 应用(1) < 数据(2)', layer.gw === 0 && layer.app === 1 && layer.db === 2,
    JSON.stringify(layer));
  check('同用途聚合进同一分组', g.groups.some(gr => gr.purpose === '应用服务' && gr.members.length === 2));
  const overlap = [];
  for (let i = 0; i < g.nodes.length; i++) {
    for (let j = i + 1; j < g.nodes.length; j++) {
      const a = g.nodes[i], b = g.nodes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlap.push(a.id + '/' + b.id);
    }
  }
  check('节点互不重叠', overlap.length === 0, overlap.join(','));
  const qtys = {}; g.nodes.forEach(n => qtys[n.id] = n.qty);
  check('数量关系保留（2/4/3/1）', qtys.gw === 2 && qtys.app === 4 && qtys.app2 === 3 && qtys.db === 1, JSON.stringify(qtys));
  check('依赖边方向自上而下', g.edges.filter(e => e.kind === 'depends')
    .every(e => layer[e.source] < layer[e.target]));
}

// 6. XML 往返：导出 -> 回解析 -> 重建 model -> 再布局
{
  const cfg = {
    phys: [{ id: 'a', machineId: 1, qty: 2, deploy: '交易网关' }, { id: 'b', machineId: 3, qty: 1, deploy: 'Oracle数据库' }],
    vm: [{ id: 'c', cpu: 8, mem: 16, sto: 200, qty: 4, deploy: 'Redis缓存' }],
    links: [['p_a_1', 'p_b_1'], ['p_a_1', 'v_c']]
  };
  const lib = {
    machines: [
      { id: 1, brand: '海光', model: 'Hygon 5480', arch: '海光(C86/x86)', cpu_sockets: 2, cpu_cores: 32, mem_capacity: 256, unit_price_cents: 8600000 },
      { id: 3, brand: '鲲鹏', model: 'Kunpeng 920', arch: '鲲鹏(ARM)', cpu_sockets: 2, cpu_cores: 64, mem_capacity: 512, unit_price_cents: 14200000 }
    ]
  };
  const model = A.deriveModel(cfg, lib);
  check('派生组件数=3', model.components.length === 3, String(model.components.length));
  check('用途分类正确', model.components.map(c => c.purpose).join(',') === '接入层,数据服务,中间件',
    model.components.map(c => c.purpose).join(','));
  check('数量聚合正确（x2/x1/x4）', model.components.map(c => c.qty).join(',').includes('2') &&
    model.components.find(c => c.purpose === '中间件').qty === 4);

  const g1 = A.layout(model);
  const xml = A.toDrawioXml(g1);
  check('XML 含 mxfile/mxGraphModel', xml.indexOf('<mxfile') === 0 && xml.includes('mxGraphModel'));
  check('XML 含自定义语义属性', xml.includes('xcpurpose=') && xml.includes('xcqty=') && xml.includes('xckind='));

  const parsed = A.fromDrawioXml(xml);
  check('回解析节点数一致', parsed.nodes.length === g1.nodes.length, parsed.nodes.length + '/' + g1.nodes.length);
  check('回解析连线数一致', parsed.edges.length === g1.edges.length, parsed.edges.length + '/' + g1.edges.length);
  const pur = parsed.nodes.map(n => n.purpose).sort().join(',');
  const pur1 = g1.nodes.map(n => n.purpose).sort().join(',');
  check('回解析用途一致', pur === pur1, pur + ' vs ' + pur1);
  check('回解析数量一致', parsed.nodes.map(n => n.qty).sort().join(',') === g1.nodes.map(n => n.qty).sort().join(','));

  const m2 = A.modelFromParsed(parsed, model);
  const g2 = A.layout(m2);
  check('再次自动布局一致', g2.stats.nodes === g1.stats.nodes && g2.stats.edges === g1.stats.edges,
    JSON.stringify(g2.stats) + ' vs ' + JSON.stringify(g1.stats));
  check('重排后规格/单价不丢失', m2.components.every(c => c.spec === (model.components.find(x => x.id === c.id) || {}).spec));
}

// 7. 手工新增节点后回解析
{
  const g = A.layout({ components: [{ id: 'a', name: '交易网关', purpose: '接入层' }] });
  let xml = A.toDrawioXml(g);
  xml = xml.replace('</root>',
    '<object id="m1" label="防火墙"><mxCell style="rounded=1;html=1;" vertex="1" parent="1">' +
    '<mxGeometry x="600" y="60" width="196" height="72" as="geometry"/></mxCell></object></root>');
  const parsed = A.fromDrawioXml(xml);
  check('手工节点被识别', parsed.nodes.length === 2 && parsed.nodes.some(n => n.manual));
  check('手工节点触发 MANUAL_NODE 告警', parsed.warnings.some(w => w.code === 'MANUAL_NODE'));
  const m = A.modelFromParsed(parsed, { components: [{ id: 'a', name: '交易网关' }] });
  const g2 = A.layout(m);
  check('含手工节点仍可重排', g2.nodes.length === 2, String(g2.nodes.length));
}

// 8. 非法输入
{
  const p = A.fromDrawioXml('<html><body>nope</body></html>');
  check('非 draw.io XML -> PARSE_BAD_FORMAT', p.warnings.some(w => w.code === 'PARSE_BAD_FORMAT'));
  const p2 = A.fromDrawioXml('');
  check('空字符串 -> PARSE_EMPTY', p2.warnings.some(w => w.code === 'PARSE_EMPTY'));
  const g = A.layout(null);
  check('layout(null) 不崩溃', g.empty === true);
}

console.log('\n========== 二、架构图视图（DOM 桩冒烟） ==========');
runViewTest();

function runViewTest() {
  // ---- 最小 DOM / 环境桩 ----
  function El(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = []; this.style = {}; this.dataset = {}; this._attrs = {};
    const cls = new Set();
    this.classList = {
      add: function (c) { cls.add(c); }, remove: function (c) { cls.delete(c); },
      contains: function (c) { return cls.has(c); },
      toggle: function (c, f) { if (f) cls.add(c); else cls.delete(c); }
    };
    this.innerHTML = ''; this.textContent = '';
    this.offsetLeft = 0; this.offsetTop = 0; this.offsetWidth = 196; this.offsetHeight = 72;
    this.scrollWidth = 1400; this.scrollHeight = 900;
    this.clientWidth = 1400; this.clientHeight = 900;
    this.firstChild = null;
  }
  El.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); };
  El.prototype.getAttribute = function (k) { return (k in this._attrs) ? this._attrs[k] : null; };
  El.prototype.appendChild = function (c) { this.children.push(c); this.firstChild = this.children[0]; return c; };
  El.prototype.removeChild = function (c) {
    const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1);
    this.firstChild = this.children[0] || null; return c;
  };
  El.prototype.remove = function () { };
  El.prototype.click = function () { };

  const cache = new Map();
  function mkBtn(ed) { const b = new El('button'); b.dataset.ed = ed; return b; }
  global.document = {
    body: new El('body'),
    createElement: function (t) { return new El(t); },
    createElementNS: function (ns, t) { return new El(t); },
    querySelector: function (sel) {
      if (!cache.has(sel)) cache.set(sel, new El('div'));
      return cache.get(sel);
    },
    querySelectorAll: function (sel) {
      if (sel.indexOf('#adSwitch button') >= 0) {
        if (!cache.has(sel)) cache.set(sel, [mkBtn('drawio'), mkBtn('local')]);
        return cache.get(sel);
      }
      return [];
    }
  };
  const lsData = {};
  global.localStorage = {
    getItem: k => (k in lsData ? lsData[k] : null),
    setItem: (k, v) => { lsData[k] = String(v); },
    removeItem: k => { delete lsData[k]; }
  };
  global.window = {
    addEventListener: function () { }, confirm: () => true, prompt: () => '测试',
    _has: true
  };

  const mem = { options: {}, model: null, graph: null, xml: null, source: 'topo', updated_at: null };
  global.api = async function (m, p, b) {
    if (p === '/api/arch/config') return { embedUrl: 'https://embed.diagrams.net/', loadTimeoutMs: 300, options: {} };
    if (p === '/api/arch/diagram') {
      if (m === 'GET') return Object.assign({}, mem, { has_xml: !!mem.xml });
      if (m === 'PUT') {
        mem.xml = b.xml; mem.model = b.model; mem.graph = b.graph; mem.source = b.source;
        mem.updated_at = '2026-01-01 00:00'; return { ok: true, updated_at: mem.updated_at };
      }
      if (m === 'DELETE') { mem.xml = null; mem.graph = null; mem.model = null; return { ok: true }; }
    }
    return { ok: true };
  };
  global.toast = () => { };
  global.esc = s => String(s == null ? '' : s);
  global.download = (n, b) => { global.__lastDownload = n; };
  global.loadLib = async () => { };
  global.ARCH_OPTIONS_DEFAULT = () => ({
    layout: 'layered-purpose', groupBy: 'purpose', aggregate: true,
    inferDependency: true, breakCycle: true, stackReplicas: true, legend: true, maxNodes: 300, maxEdges: 800
  });
  global.S = {
    machines: [
      { id: 1, brand: '海光', model: 'Hygon 5480', arch: '海光(C86/x86)', cpu_sockets: 2, cpu_cores: 32, mem_capacity: 256, unit_price_cents: 8600000 },
      { id: 3, brand: '鲲鹏', model: 'Kunpeng 920', arch: '鲲鹏(ARM)', cpu_sockets: 2, cpu_cores: 64, mem_capacity: 512, unit_price_cents: 14200000 }
    ]
  };
  global.CFG = {
    phys: [{ id: 'a', machineId: 1, qty: 2, deploy: '交易网关' }, { id: 'b', machineId: 3, qty: 1, deploy: 'Oracle数据库' }],
    vm: [{ id: 'c', cpu: 8, mem: 16, sto: 200, qty: 4, deploy: 'Redis缓存' }],
    links: [['p_a_1', 'p_b_1'], ['p_a_1', 'v_c']]
  };
  global.ArchGraph = A;

  const code = fs.readFileSync(path.join(ROOT, 'web', 'arch-diagram.js'), 'utf-8');
  vm.runInThisContext(code, { filename: 'arch-diagram.js' });

  (async () => {
    try {
      await global.ArchDiagramView.render();
      check('视图首次渲染不抛错', true);
      const st = global.ArchDiagramView.getState();
      check('自动派生出 3 个图节点', st.graph && st.graph.nodes.length === 3, 'nodes=' + (st.graph ? st.graph.nodes.length : 'n/a'));
      check('生成了 draw.io XML', !!st.xml && st.xml.indexOf('<mxfile') === 0);

      // 模拟点击「重新生成」
      document.querySelector('#adGen').onclick();
      check('点击「重新生成」不抛错', !!ArchDiagramView.getState().xml);

      // 模拟点击「保存」
      await document.querySelector('#adSave').onclick();
      check('保存后后端已收到 xml', !!mem.xml && mem.xml.indexOf('<mxfile') === 0);
      check('保存后状态标记为已保存', ArchDiagramView.getState().savedAt !== null);

      // 模拟「解析并重排」
      document.querySelector('#adReparse').onclick();
      const st2 = ArchDiagramView.getState();
      check('解析并重排后仍有 3 节点', st2.graph.nodes.length === 3, 'nodes=' + st2.graph.nodes.length);
      check('重排后来源标记为 drawio', st2.source === 'drawio');

      // 模拟切到内置离线编辑器
      const btns = document.querySelectorAll('#adSwitch button');
      btns[1].onclick();
      const st3 = ArchDiagramView.getState();
      check('切换到内置离线编辑器', st3.editor === 'local');
      check('内置编辑器继承了节点', st3.local.nodes.length === 3, 'local nodes=' + st3.local.nodes.length);
      check('内置编辑器继承了连线', st3.local.edges.length > 0, 'local edges=' + st3.local.edges.length);

      // 内置编辑器 -> XML 序列化 -> 再解析
      const xmlLocal = ArchDiagramView.getState().xml;
      const p = A.fromDrawioXml(xmlLocal);
      check('内置编辑器产出的 XML 可被解析', p.nodes.length === 3, 'parsed=' + p.nodes.length);

      // 导出
      document.querySelector('#adExport').onclick();
      check('导出 .drawio 触发下载', global.__lastDownload === '部署架构图.drawio', String(global.__lastDownload));

      report();
    } catch (e) {
      check('视图渲染/交互未抛异常', false, e && e.stack ? e.stack.split('\n')[0] : String(e));
      report();
    }
  })();
}

function report() {
  console.log('\n================ 结果 ================');
  console.log('通过 ' + passed + ' 项，失败 ' + fails.length + ' 项');
  if (fails.length) { fails.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  else { console.log('全部通过'); }
}
