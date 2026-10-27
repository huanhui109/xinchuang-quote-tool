/* ==========================================================================
 * 架构图视图：菜单「架构梳理 → 架构图 · draw.io」
 *   - 依赖全局：ArchGraph（arch-graph.js）、app.js 的 $ / esc / toast / api / download / S / CFG / loadLib
 *   - 双编辑器：draw.io 官方 embed iframe（联网）/ 内置离线 SVG 编辑器（降级）
 *   - 两端产出同一种 draw.io XML，因此互相可导入、可重新解析、可再自动布局
 * ========================================================================*/
var ArchDiagramView = (function () {
  'use strict';

  var DEFAULT_EMBED = 'https://embed.diagrams.net/';
  var ST = {
    config: { embedUrl: DEFAULT_EMBED, loadTimeoutMs: 12000, options: {} },
    options: {}, model: null, graph: null, xml: '', savedAt: null, source: 'topo',
    editor: 'drawio', drawioReady: false, drawioAlive: false, dirty: false, busy: false,
    local: { nodes: [], edges: [], sel: null, connecting: false, seq: 1 },
    msgBound: false
  };

  // ---------------- 基础工具 ----------------
  function tp(m) { try { toast(m); } catch (e) { if (typeof console !== 'undefined') console.log(m); } }
  function q(s) { return document.querySelector(s); }
  function qa(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function optOrDefault() {
    try { return Object.assign({}, ARCH_OPTIONS_DEFAULT()); } catch (e) { return { layout: 'layered-purpose', groupBy: 'purpose', aggregate: true, inferDependency: true, breakCycle: true, stackReplicas: true, legend: true, maxNodes: 300, maxEdges: 800 }; }
  }
  function syncCfgFromStore() {
    // 若上层 CFG 尚未装载（纯静态首次进入），尝试从 localStorage 兜底读取
    try {
      if (typeof CFG !== 'undefined' && CFG && CFG.phys) return CFG;
      var raw = localStorage.getItem('xcq_store_v1');
      if (raw) { var st = JSON.parse(raw); if (st && st.cfg) return st.cfg; }
    } catch (e) { }
    return { phys: [], vm: [], links: [] };
  }

  // ---------------- 数据读写 ----------------
  async function loadConfig() {
    try { ST.config = await api('GET', '/api/arch/config'); }
    catch (e) { ST.config = { embedUrl: DEFAULT_EMBED, loadTimeoutMs: 12000, options: {} }; }
    ST.options = Object.assign(optOrDefault(), ST.config.options || {});
  }
  async function loadDiagram() {
    try {
      var d = await api('GET', '/api/arch/diagram');
      ST.options = Object.assign(ST.options, d.options || {});
      ST.model = d.model || null; ST.graph = d.graph || null;
      ST.xml = d.xml || ''; ST.savedAt = d.updated_at || null;
      ST.source = d.source || (ST.xml ? 'drawio' : 'topo');
    } catch (e) { /* 后端不可用：纯本地 */ }
  }
  async function saveDiagram(extra) {
    var payload = {
      options: ST.options, model: ST.model, graph: ST.graph,
      xml: ST.xml, source: ST.source
    };
    Object.assign(payload, extra || {});
    try {
      var r = await api('PUT', '/api/arch/diagram', payload);
      ST.savedAt = (r && r.updated_at) || new Date().toISOString();
      ST.dirty = false;
      renderPanel();
      tp('架构图已保存');
    } catch (e) { tp('保存失败：' + e.message); }
  }

  // ---------------- 自动布局主流程 ----------------
  function buildModelFromTopo() {
    var cfg = syncCfgFromStore();
    var lib = { machines: (typeof S !== 'undefined' && S.machines) ? S.machines : [] };
    return ArchGraph.deriveModel(cfg, lib, ST.options);
  }
  function regenerate(useTopo) {
    var model = useTopo ? buildModelFromTopo() : (ST.model || buildModelFromTopo());
    ST.model = model;
    var g = ArchGraph.layout(model, ST.options);
    ST.graph = g;
    ST.xml = ArchGraph.toDrawioXml(g, ST.options);
    ST.source = 'topo';
    ST.dirty = true;
    graphToLocal(g);
    if (ST.editor === 'drawio' && ST.drawioReady) sendToDrawio(ST.xml);
    renderPanel();
    tp(g.empty ? '暂无部署组件，已生成占位图' : ('已重新生成：' + g.stats.nodes + ' 个节点 / ' + g.stats.edges + ' 条连线'));
  }
  function reparseAndRelayout() {
    var xml = currentXml();
    if (!xml) { tp('当前没有可解析的图，请先生成'); return; }
    var parsed = ArchGraph.fromDrawioXml(xml);
    if (!parsed.nodes || !parsed.nodes.length) {
      tp('未能从图中解析出节点');
      ST.graph = ST.graph || {};
      renderPanel();
      return;
    }
    var model = ArchGraph.modelFromParsed(parsed, ST.model);
    ST.model = model;
    var g = ArchGraph.layout(model, ST.options);
    ST.graph = g;
    ST.xml = ArchGraph.toDrawioXml(g, ST.options);
    ST.source = 'drawio';
    ST.dirty = true;
    graphToLocal(g);
    if (ST.editor === 'drawio' && ST.drawioReady) sendToDrawio(ST.xml);
    renderPanel();
    tp('已重新解析并自动布局：' + g.stats.nodes + ' 个节点 / ' + g.stats.edges + ' 条连线');
  }

  // ---------------- 面板渲染 ----------------
  function labelOf(e) { return e.label || (e.kind === 'depends' ? '依赖' : '互联'); }

  function statsHTML() {
    var g = ST.graph || {};
    var s = g.stats || { nodes: 0, edges: 0, groups: 0, layers: 0, instances: 0 };
    var chip = function (n, l) { return '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>'; };
    return '<div class="grid-3" style="margin:12px 0">' +
      chip(s.nodes || 0, '图节点（已聚合）') +
      chip(s.instances || 0, '服务器总台数') +
      chip(s.edges || 0, '依赖/互联连线') +
      '</div><div class="grid-3">' +
      chip(s.groups || 0, '用途分组') +
      chip(s.layers || 0, '依赖层级') +
      chip((ST.xml ? '有' : '无'), 'draw.io 图数据') +
      '</div>';
  }
  function warningsHTML() {
    var g = ST.graph || {}, ws = g.warnings || [];
    if (ST.graph && ST.graph.empty && (!ws || !ws.length)) {
      ws = [{ code: 'EMPTY_LIST', msg: '部署组件清单为空' }];
    }
    if (!ws.length) return '';
    return '<div class="ad-warn"><b>处理提示</b><ul>' + ws.map(function (w) {
      return '<li><span class="tag warn">' + esc(w.code) + '</span> ' + esc(w.msg) + '</li>';
    }).join('') + '</ul></div>';
  }
  function statusHTML() {
    return '<span class="muted">最后保存：' + esc(ST.savedAt || '未保存') +
      (ST.dirty ? '　·　<b style="color:var(--danger)">有未保存修改</b>' : '') +
      '　·　来源：' + esc(ST.source === 'drawio' ? '手工图（draw.io）' : '拓扑自动派生') + '</span>';
  }
  function optionsHTML() {
    var o = ST.options;
    var ck = function (k, label, tip) {
      return '<label class="ad-opt"><input type="checkbox" data-opt="' + k + '" ' + (o[k] ? 'checked' : '') + '> ' +
        esc(label) + (tip ? '<span class="muted"> — ' + esc(tip) + '</span>' : '') + '</label>';
    };
    return '<details class="ad-opts"><summary>布局选项与配置项</summary><div class="ad-opts-body">' +
      ck('aggregate', '多实例聚合', '同用途同规格合并为一个节点，数量以「实例 xN」表示') +
      ck('inferDependency', '推导依赖方向', '跨用途的连线按用途层级推导为有向依赖') +
      ck('breakCycle', '打断循环依赖', '检测到环时把回边降级为无向「互联」') +
      ck('stackReplicas', '副本堆叠效果', '用层叠阴影表示副本数量') +
      ck('legend', '生成图例', '在图右下角输出颜色与线型说明') +
      '<label class="ad-opt">分组方式 <select data-opt="groupBy">' +
      '<option value="purpose"' + (o.groupBy === 'purpose' ? ' selected' : '') + '>按用途分组</option>' +
      '<option value="none"' + (o.groupBy === 'none' ? ' selected' : '') + '>不分组（仅分层）</option></select></label>' +
      '<label class="ad-opt">节点上限 <input type="number" min="10" max="2000" step="10" data-opt="maxNodes" value="' + (o.maxNodes || 300) + '"></label>' +
      '<label class="ad-opt">连线上限 <input type="number" min="10" max="5000" step="50" data-opt="maxEdges" value="' + (o.maxEdges || 800) + '"></label>' +
      '<div class="muted" style="margin-top:6px">draw.io 服务地址：<span class="code">' + esc(ST.config.embedUrl || DEFAULT_EMBED) +
      '</span>（可用环境变量 DRAWIO_EMBED_URL 指向自建实例）</div>' +
      '</div></details>';
  }
  function renderPanel() {
    var s = q('#adStats'); if (s) s.innerHTML = statsHTML();
    var w = q('#adWarn'); if (w) w.innerHTML = warningsHTML();
    var t = q('#adStatus'); if (t) t.innerHTML = statusHTML();
    var o = q('#adOpts'); if (o) o.innerHTML = optionsHTML();
    bindOpts();
  }
  function bindOpts() {
    qa('#adOpts [data-opt]').forEach(function (el) {
      el.onchange = function () {
        var k = el.dataset.opt;
        if (el.type === 'checkbox') ST.options[k] = el.checked;
        else if (el.type === 'number') ST.options[k] = parseInt(el.value, 10) || 0;
        else ST.options[k] = el.value;
        ST.dirty = true;
      };
    });
  }

  // ---------------- draw.io embed 集成 ----------------
  function frameHTML() {
    var p = new URLSearchParams({
      embed: '1', proto: 'json', spin: '1', ui: 'kennedy', lang: 'zh',
      libraries: '1', saveAndExit: '0', noSaveBtn: '1', noExitBtn: '1', configure: '0', stealth: '0'
    });
    return '<div class="ad-frame-wrap"><iframe id="adFrame" class="ad-frame" title="draw.io 部署架构图编辑器" ' +
      'src="' + esc((ST.config.embedUrl || DEFAULT_EMBED) + '?' + p.toString()) + '"></iframe></div>';
  }
  function canvasHTML() {
    return '<div class="ad-bar">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn sm" id="adAdd">新增节点</button>' +
      '<button class="btn sm" id="adConn">连线模式</button>' +
      '<button class="btn sm danger" id="adDel">删除选中</button>' +
      '<button class="btn sm" id="adClear">清空连线</button>' +
      '</div><span class="muted">内置离线编辑器：拖动节点调整位置；双击节点修改名称/用途/数量；连线模式下点两个节点建立连接（点连线可删除）。</span></div>' +
      '<div class="ad-canvas" id="adCanvas"><svg class="ad-svg" id="adSvg"></svg>' +
      ST.local.nodes.map(function (n) {
        return '<div class="ad-node" data-id="' + esc(n.id) + '" style="left:' + n.x + 'px;top:' + n.y + 'px;width:' + n.w + 'px;min-height:' + n.h + 'px">' +
          '<div class="ad-node-h"><b>' + esc(n.name) + '</b><span class="ad-rm" data-rm="' + esc(n.id) + '" title="删除">x</span></div>' +
          '<div class="ad-node-b">' +
          '<div>' + esc(n.type || '未分类') + (n.spec ? ' · ' + esc(n.spec) : '') + '</div>' +
          '<div class="ad-purpose">' + esc(n.purpose || '未分组') + '</div>' +
          '<div class="ad-qty">实例 x' + (n.qty || 1) + '</div>' +
          '</div></div>';
      }).join('') + '</div>';
  }
  function mountEditor() {
    var host = q('#adHost'); if (!host) return;
    if (ST.editor === 'drawio') { host.innerHTML = frameHTML(); bindDrawio(); }
    else { host.innerHTML = canvasHTML(); bindLocal(); }
  }
  function sendToDrawio(xml) {
    var f = q('#adFrame'); if (!f || !f.contentWindow) return;
    try { f.contentWindow.postMessage(JSON.stringify({ action: 'load', xml: xml, autosave: 1 }), '*'); }
    catch (e) { }
  }
  function bindDrawio() {
    if (!ST.msgBound) { window.addEventListener('message', onDrawioMessage); ST.msgBound = true; }
    ST.drawioReady = false; ST.drawioAlive = false;
    clearTimeout(ST.loadTimer);
    ST.loadTimer = setTimeout(function () {
      if (!ST.drawioReady && q('#adFrame')) fallbackToLocal('draw.io 加载超时（可能无外网），已切换到内置离线编辑器');
    }, ST.config.loadTimeoutMs || 12000);
  }
  function onDrawioMessage(evt) {
    var f = q('#adFrame');
    if (!f || evt.source !== f.contentWindow) return;
    var msg = evt.data;
    if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return; } }
    if (!msg || !msg.event) return;
    if (msg.event === 'init') {
      ST.drawioReady = true; ST.drawioAlive = true;
      clearTimeout(ST.loadTimer);
      sendToDrawio(currentXml());
    } else if (msg.event === 'autosave' || msg.event === 'save') {
      if (msg.xml) { ST.xml = msg.xml; ST.dirty = true; var t = q('#adStatus'); if (t) t.innerHTML = statusHTML(); }
    } else if (msg.event === 'export') {
      var data = msg.data || msg.xml;
      if (typeof data === 'string' && data.indexOf('data:image') === 0) downloadDrawioPng(data);
    }
  }
  function fallbackToLocal(reason) {
    ST.editor = 'local';
    if (!ST.local.nodes.length) {
      localFromXml(ST.xml);
      if (!ST.local.nodes.length && ST.graph) graphToLocal(ST.graph);
    }
    mountEditor();
    renderPanel();
    tp(reason);
  }
  function exportPng() {
    var f = q('#adFrame');
    if (ST.editor !== 'drawio' || !f || !f.contentWindow) { tp('请先切换到 draw.io 编辑器'); return; }
    try { f.contentWindow.postMessage(JSON.stringify({ action: 'export', format: 'png' }), '*'); tp('已请求导出 PNG'); }
    catch (e) { tp('导出失败'); }
  }
  function downloadDrawioPng(dataUrl) {
    try {
      var a = document.createElement('a');
      a.href = dataUrl; a.download = '部署架构图.png';
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { tp('PNG 下载失败'); }
  }
  function downloadXml() {
    var xml = currentXml();
    if (!xml) { tp('当前没有图数据'); return; }
    try {
      download('部署架构图.drawio', new Blob([xml], { type: 'application/xml' }));
      tp('已导出 .drawio 文件');
    } catch (e) { tp('导出失败：' + e.message); }
  }
  function currentXml() {
    if (ST.editor === 'local') {
      try { return ArchGraph.toDrawioXml(localToGraph(), ST.options); } catch (e) { return ST.xml || ''; }
    }
    return ST.xml || ArchGraph.toDrawioXml(ST.graph || {}, ST.options);
  }

  // ---------------- 内置离线编辑器 ----------------
  function graphToLocal(g) {
    ST.local.nodes = (g.nodes || []).map(function (n) {
      return {
        id: n.id, name: n.name, purpose: n.purpose, type: n.type, spec: n.spec,
        arch: n.arch || '', qty: n.qty || 1, members: (n.members || []).slice(),
        x: Math.round(n.x || 0), y: Math.round(n.y || 0),
        w: Math.round(n.w || 196), h: Math.round(n.h || 72)
      };
    });
    ST.local.edges = (g.edges || []).map(function (e, i) {
      return { id: e.id || ('e_' + (i + 1)), source: e.source, target: e.target, kind: e.kind || 'depends', label: e.label };
    });
    ST.local.sel = null; ST.local.connecting = false;
  }
  function localFromXml(xml) {
    if (!xml) return false;
    var p = ArchGraph.fromDrawioXml(xml);
    if (!p.nodes || !p.nodes.length) return false;
    ST.local.nodes = p.nodes.map(function (n) {
      return {
        id: n.cid, name: n.name, purpose: n.purpose, type: n.type, spec: n.spec,
        arch: n.arch || '', qty: n.qty || 1, members: n.members || [],
        x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.w) , h: Math.round(n.h)
      };
    });
    ST.local.edges = (p.edges || []).map(function (e, i) {
      return { id: 'e_' + (i + 1), source: e.source, target: e.target, kind: e.kind, label: e.label };
    });
    ST.local.sel = null; ST.local.connecting = false;
    return true;
  }
  function localToGraph() {
    var maxX = 0, maxY = 0;
    ST.local.nodes.forEach(function (n) { maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h); });
    var instances = ST.local.nodes.reduce(function (s, n) { return s + (n.qty || 1); }, 0);
    var purposes = {};
    ST.local.nodes.forEach(function (n) { purposes[n.purpose || '未分组'] = 1; });
    return {
      version: 1, layout: 'manual', empty: ST.local.nodes.length === 0, options: ST.options,
      nodes: ST.local.nodes.map(function (n) {
        return {
          id: n.id, name: n.name, purpose: n.purpose || '未分组', type: n.type, spec: n.spec,
          arch: n.arch, qty: n.qty || 1, members: n.members, layer: 0, group: null,
          x: n.x, y: n.y, w: n.w, h: n.h
        };
      }),
      groups: [],
      edges: ST.local.edges.map(function (e) {
        return { id: e.id, source: e.source, target: e.target, kind: e.kind, label: labelOf(e) };
      }),
      bounds: { w: Math.max(maxX + 80, 900), h: Math.max(maxY + 120, 500) },
      legendY: Math.max(maxY + 24, 60),
      stats: {
        nodes: ST.local.nodes.length, edges: ST.local.edges.length, groups: Object.keys(purposes).length,
        layers: 0, instances: instances, truncated: false
      },
      warnings: []
    };
  }
  function touchLocal() {
    var g = localToGraph();
    ST.graph = g; ST.xml = ArchGraph.toDrawioXml(g, ST.options); ST.source = 'drawio'; ST.dirty = true;
    var t = q('#adStatus'); if (t) t.innerHTML = statusHTML();
    var s = q('#adStats'); if (s) s.innerHTML = statsHTML();
  }
  function drawLocalEdges() {
    var svg = q('#adSvg'), canvas = q('#adCanvas');
    if (!svg || !canvas) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var W = canvas.scrollWidth, H = canvas.scrollHeight;
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    ST.local.edges.forEach(function (e, i) {
      var ea = q('.ad-node[data-id="' + cssEsc(e.source) + '"]');
      var eb = q('.ad-node[data-id="' + cssEsc(e.target) + '"]');
      if (!ea || !eb) return;
      var ax = ea.offsetLeft + ea.offsetWidth / 2, ay = ea.offsetTop + ea.offsetHeight / 2;
      var bx = eb.offsetLeft + eb.offsetWidth / 2, by = eb.offsetTop + eb.offsetHeight / 2;
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', ax); line.setAttribute('y1', ay);
      line.setAttribute('x2', bx); line.setAttribute('y2', by);
      line.setAttribute('class', 'ad-edge' + (e.kind === 'depends' ? ' dep' : ' con'));
      line.setAttribute('data-i', i);
      var lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      lbl.setAttribute('x', (ax + bx) / 2); lbl.setAttribute('y', (ay + by) / 2 - 4);
      lbl.setAttribute('class', 'ad-edge-label');
      lbl.textContent = labelOf(e);
      svg.appendChild(line); svg.appendChild(lbl);
    });
  }
  function cssEsc(s) { return String(s == null ? '' : s).replace(/["\\]/g, '\\$&'); }
  function bindLocal() {
    var canvas = q('#adCanvas'); if (!canvas) return;
    var add = q('#adAdd'), conn = q('#adConn'), del = q('#adDel'), clr = q('#adClear');
    if (add) add.onclick = function () {
      var name = (window.prompt('新节点名称（部署组件名）：', '新组件') || '').trim();
      if (!name) return;
      ST.local.seq++;
      ST.local.nodes.push({
        id: 'man_' + Date.now(), name: name, purpose: ArchGraph.normalizePurpose(name),
        type: '未分类', spec: '', arch: '', qty: 1, members: [],
        x: 40 + ((ST.local.nodes.length % 6) * 220), y: 40 + Math.floor(ST.local.nodes.length / 6) * 140,
        w: 196, h: 72
      });
      var host = q('#adHost'); host.innerHTML = canvasHTML(); bindLocal(); touchLocal();
    };
    if (conn) conn.onclick = function () { ST.local.connecting = !ST.local.connecting; ST.local.sel = null; bindLocal(); };
    if (del) del.onclick = function () {
      if (!ST.local.sel) { tp('请先点选一个节点'); return; }
      var id = ST.local.sel;
      ST.local.nodes = ST.local.nodes.filter(function (n) { return n.id !== id; });
      ST.local.edges = ST.local.edges.filter(function (e) { return e.source !== id && e.target !== id; });
      ST.local.sel = null;
      q('#adHost').innerHTML = canvasHTML(); bindLocal(); touchLocal(); tp('已删除节点');
    };
    if (clr) clr.onclick = function () { ST.local.edges = []; q('#adHost').innerHTML = canvasHTML(); bindLocal(); touchLocal(); };
    qa('#adCanvas .ad-node').forEach(function (el) {
      el.onclick = function (e) {
        if (e.target.classList.contains('ad-rm')) {
          var rid = e.target.dataset.rm;
          ST.local.nodes = ST.local.nodes.filter(function (n) { return n.id !== rid; });
          ST.local.edges = ST.local.edges.filter(function (x) { return x.source !== rid && x.target !== rid; });
          q('#adHost').innerHTML = canvasHTML(); bindLocal(); touchLocal(); return;
        }
        if (ST.local.connecting) {
          if (!ST.local.sel) ST.local.sel = el.dataset.id;
          else if (ST.local.sel !== el.dataset.id) {
            var sid = ST.local.sel;
            var dup = ST.local.edges.some(function (x) {
              return (x.source === sid && x.target === el.dataset.id) || (x.source === el.dataset.id && x.target === sid);
            });
            if (!dup) ST.local.edges.push({ id: 'e_' + (ST.local.edges.length + 1), source: sid, target: el.dataset.id, kind: 'depends', label: '依赖' });
            ST.local.sel = null;
          }
          q('#adHost').innerHTML = canvasHTML(); bindLocal(); touchLocal();
          return;
        }
      };
      el.ondblclick = function () {
        var id = el.dataset.id;
        var n = ST.local.nodes.filter(function (x) { return x.id === id; })[0];
        if (!n) return;
        var name = window.prompt('名称：', n.name); if (name == null) return;
        var purpose = window.prompt('用途分类：', n.purpose || ArchGraph.normalizePurpose(name));
        var qtyStr = window.prompt('实例数量：', String(n.qty || 1));
        n.name = name.trim() || n.name;
        n.purpose = (purpose || '').trim() || ArchGraph.normalizePurpose(n.name);
        n.qty = Math.max(1, parseInt(qtyStr, 10) || 1);
        q('#adHost').innerHTML = canvasHTML(); bindLocal(); touchLocal();
      };
      el.onmousedown = function (e) {
        if (e.target.classList.contains('ad-rm')) return;
        e.preventDefault();
        var sx = e.clientX, sy = e.clientY;
        var ox = parseFloat(el.style.left), oy = parseFloat(el.style.top);
        function move(ev) {
          el.style.left = Math.max(0, ox + ev.clientX - sx) + 'px';
          el.style.top = Math.max(0, oy + ev.clientY - sy) + 'px';
          drawLocalEdges();
        }
        function up(ev) {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          var id = el.dataset.id;
          ST.local.nodes.forEach(function (n) {
            if (n.id === id) { n.x = parseFloat(el.style.left); n.y = parseFloat(el.style.top); }
          });
          touchLocal();
        }
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      };
    });
    var svg = q('#adSvg');
    if (svg) svg.onclick = function (e) {
      if (e.target.tagName === 'line') {
        var i = parseInt(e.target.getAttribute('data-i'), 10);
        if (!isNaN(i) && window.confirm('删除这条连线？')) {
          ST.local.edges.splice(i, 1);
          q('#adHost').innerHTML = canvasHTML(); bindLocal(); touchLocal();
        }
      }
    };
    drawLocalEdges();
  }

  // ---------------- 入口 ----------------
  function shellHTML() {
    return '<div class="card card-pad">' +
      '<div class="toolbar"><div><h2 class="h2">架构图 · draw.io</h2>' +
      '<p class="hint">由「架构梳理」的部署组件清单自动生成分层拓扑图，可接入开源 draw.io 组件在线手工编辑（增删节点、调整连线、分组与样式），保存后再解析重排。</p></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn primary" id="adGen">重新生成</button>' +
      '<button class="btn" id="adReparse">解析并重排</button>' +
      '<button class="btn" id="adSave">保存</button>' +
      '<button class="btn" id="adExport">导出 .drawio</button>' +
      '<button class="btn" id="adPng">导出 PNG</button>' +
      '<button class="btn danger" id="adReset">重置</button>' +
      '</div></div>' +
      '<div class="seg" id="adSwitch">' +
      '<button data-ed="drawio">draw.io 在线编辑器</button>' +
      '<button data-ed="local">内置离线编辑器</button></div>' +
      '<div id="adStatus" style="margin-top:8px"></div>' +
      '<div id="adStats"></div>' +
      '<div id="adWarn"></div>' +
      '<div id="adHost"></div>' +
      '<div id="adOpts"></div>' +
      '</div>';
  }
  function bindShell() {
    var g = q('#adGen'); if (g) g.onclick = function () { regenerate(true); };
    var r = q('#adReparse'); if (r) r.onclick = reparseAndRelayout;
    var s = q('#adSave'); if (s) s.onclick = function () { saveDiagram({ xml: currentXml() }); };
    var e = q('#adExport'); if (e) e.onclick = downloadXml;
    var p = q('#adPng'); if (p) p.onclick = exportPng;
    var rs = q('#adReset'); if (rs) rs.onclick = async function () {
      if (!window.confirm('确认清空已保存的架构图（不改动配置台的服务器清单）？')) return;
      try { await api('DELETE', '/api/arch/diagram'); } catch (err) { }
      ST.xml = ''; ST.graph = null; ST.model = null; ST.savedAt = null; ST.source = 'topo';
      ST.local = { nodes: [], edges: [], sel: null, connecting: false, seq: 1 };
      regenerate(true); tp('已重置');
    };
    qa('#adSwitch button').forEach(function (b) {
      b.onclick = function () {
        var ed = b.dataset.ed;
        if (ed === ST.editor) return;
        if (ed === 'local' && ST.xml && !ST.local.nodes.length) localFromXml(ST.xml);
        ST.editor = ed;
        mountEditor(); renderPanel();
        tp(ed === 'drawio' ? '已切换到 draw.io 在线编辑器' : '已切换到内置离线编辑器');
      };
    });
  }
  function syncSwitchUI() {
    qa('#adSwitch button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.ed === ST.editor);
    });
  }

  async function render() {
    try { await loadLib(); } catch (e) { }
    await loadConfig();
    await loadDiagram();
    var host = q('#content');
    host.innerHTML = shellHTML();
    bindShell();
    if (!ST.xml) {
      regenerate(false);
    } else if (ST.graph && (!ST.local.nodes.length)) {
      localFromXml(ST.xml);
    }
    if (ST.editor === 'local' && !ST.local.nodes.length) {
      if (ST.graph) graphToLocal(ST.graph);
    }
    syncSwitchUI();
    mountEditor();
    renderPanel();
  }

  return {
    render: render,
    regenerate: regenerate,
    reparseAndRelayout: reparseAndRelayout,
    getState: function () { return ST; },
    _localToGraph: localToGraph,
    _localFromXml: localFromXml
  };
})();
