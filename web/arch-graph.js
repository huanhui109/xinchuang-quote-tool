/* ==========================================================================
 * 部署架构图引擎（纯函数 · 零依赖 · 可在 Node 下单测）
 *   model  -> layout  -> draw.io XML   （自动拓扑绘制）
 *   draw.io XML -> parsed -> model     （回解析 / 再次自动布局）
 * 浏览器挂载为全局 ArchGraph，同时支持 CommonJS require（便于单测）。
 * ========================================================================*/
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  if (root) { root.ArchGraph = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------- 用途分类字典（顺序即层级顺序，索引越小越靠上层） ----------
  var PURPOSE_ORDER = ['接入层', '应用服务', '中间件', '数据服务', '存储备份', '基础设施', '未分组'];
  var PURPOSE_LAYER = {};
  PURPOSE_ORDER.forEach(function (p, i) { PURPOSE_LAYER[p] = i; });

  var PURPOSE_RULES = [
    [['网关', '接入', '负载', '均衡', 'gateway', 'gw', 'lb', 'nginx', 'f5', 'proxy', '反向代理', 'cdn', 'slb'], '接入层'],
    [['web', '门户', '前端', '应用', 'app', '交易', '柜面', '前置', 'tomcat', 'spring', '业务'], '应用服务'],
    [['中间件', 'redis', '缓存', 'cache', 'kafka', 'mq', '消息', 'rabbit', 'rocketmq', 'zookeeper'], '中间件'],
    [['数据', 'db', 'oracle', 'mysql', '达梦', 'gauss', 'postgre', '报表', '数仓', '数据库'], '数据服务'],
    [['存储', 'nas', '备份', 'ceph', '对象存储', 'oss', '磁带', 'minio', '分布式文件'], '存储备份'],
    [['管理', '监控', '运维', '堡垒', '日志', '审计', 'zabbix', 'prometheus', 'k8s', 'kubernetes', '云管', '虚拟化'], '基础设施']
  ];

  // ---------- 默认布局/渲染配置（可被 ARCH_DIAGRAM_CONFIG 覆盖） ----------
  var DEFAULTS = {
    version: 1,
    layout: 'layered-purpose',   // 分层 + 用途分组
    groupBy: 'purpose',          // purpose | none
    aggregate: true,             // 同用途同规格聚合为一个节点（体现副本数）
    inferDependency: true,       // 跨用途的连通关系按用途层级推导为依赖
    breakCycle: true,            // 检测到循环依赖时，将反向边降级为“互联”
    stackReplicas: true,         // 副本堆叠效果
    maxStack: 4,                 // 最多绘制几层堆叠
    maxNodes: 300,               // 节点上限（超出截断并告警）
    maxEdges: 800,
    legend: true,                // 生成图例
    nodeWidth: 196,
    nodeHeight: 72,
    hGap: 38,                    // 同组内节点水平间距
    vGap: 104,                   // 层级间距
    groupGap: 52,                // 同层不同分组之间的间距
    groupPad: 22,
    groupHead: 30,
    marginX: 48,
    marginY: 48,
    pageWidth: 1600,
    pageHeight: 1100
  };

  var COLORS = {
    '接入层': '#1d4fb0', '应用服务': '#2563eb', '中间件': '#7c3aed',
    '数据服务': '#b45309', '存储备份': '#0f766e', '基础设施': '#475569', '未分组': '#64748b',
    ghost: '#94a3b8', group: '#f1f5f9', groupLine: '#cbd5e1', legend: '#e2e8f0'
  };
  var FILLS = {
    '接入层': '#e8f0ff', '应用服务': '#eff6ff', '中间件': '#f5f3ff',
    '数据服务': '#fef3c7', '存储备份': '#ccfbf1', '基础设施': '#e2e8f0', '未分组': '#f1f5f9'
  };

  // ---------------- 通用工具 ----------------
  function opts_(o) { var x = {}; for (var k in DEFAULTS) x[k] = DEFAULTS[k]; for (var k2 in (o || {})) x[k2] = o[k2]; return x; }
  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function clampInt(v, lo, hi, dft) { var n = parseInt(v, 10); if (isNaN(n)) n = dft; return Math.min(hi, Math.max(lo, n)); }
  function xmlEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function htmlEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  /** 安全 id：中文等会被替换成等长下划线，导致「核心层」与「汇聚层」冲突（P-19）。
   *  改为「可读前缀 + 稳定短哈希」，既可读又保证唯一。 */
  function safeId(s) {
    var raw = String(s == null ? '' : s);
    // draw.io 保留 id（root 层 "0"/"1"）必须保持字面值，否则 parent 指向不存在的 cell（P-21）
    if (raw === '0' || raw === '1') return raw;
    var readable = raw.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 24);
    return readable + '_' + hashString(raw);
  }
  /** 轻量稳定哈希（FNV-1a 32bit，转 36 进制），用于生成无碰撞后缀 */
  function hashString(s) {
    var str = String(s == null ? '' : s), h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }
  function uniqPush(arr, v) { if (v != null && v !== '' && arr.indexOf(v) < 0) arr.push(v); }

  /** 依据部署组件名称推断用途分类 */
  function normalizePurpose(text) {
    var s = String(text == null ? '' : text).toLowerCase();
    if (!s.trim()) return '未分组';
    for (var i = 0; i < PURPOSE_RULES.length; i++) {
      var kws = PURPOSE_RULES[i][0];
      for (var j = 0; j < kws.length; j++) {
        if (s.indexOf(String(kws[j]).toLowerCase()) >= 0) return PURPOSE_RULES[i][1];
      }
    }
    return '未分组';
  }
  function purposeLayer(p) {
    var n = PURPOSE_LAYER[p];
    return (n == null ? PURPOSE_ORDER.length - 1 : n);
  }

  /** 归一化 model：补齐字段、去重、校验引用 */
  function normalizeModel(model, options) {
    var opts = opts_(options);
    var raw = (model && isArr(model.components)) ? model.components : [];
    var warnings = [];
    var comps = [];
    var byId = {};
    raw.forEach(function (c, i) {
      if (!c) return;
      var id = String(c.id || ('cmp_' + (i + 1)));
      if (byId[id]) { warnings.push({ code: 'DUP_ID', msg: '重复的组件 id ' + id + '，已自动改名' }); id = id + '_' + i; }
      var name = String(c.name || '').trim() || ('组件' + (i + 1));
      var purpose = String(c.purpose || '').trim() || normalizePurpose(name);
      var q = clampInt(c.qty, 1, 100000, 1);
      var node = {
        id: id, name: name, purpose: purpose,
        type: String(c.type || '未分类'),
        spec: String(c.spec || ''),
        arch: String(c.arch || ''),
        qty: q,
        unit_cents: c.unit_cents || 0,
        members: isArr(c.members) ? c.members.slice() : [],
        depends_on: isArr(c.depends_on) ? c.depends_on.slice() : [],
        connects: isArr(c.connects) ? c.connects.slice() : []
      };
      byId[id] = node; comps.push(node);
    });
    if (!comps.length) {
      return { empty: true, components: [], warnings: [{ code: 'EMPTY_LIST', msg: '部署组件清单为空：请先在「配置台 → 拓扑白板」中为服务器填写部署组件' }], options: opts };
    }
    // 校验引用
    comps.forEach(function (c) {
      c.depends_on = c.depends_on.filter(function (t) {
        if (t === c.id) { warnings.push({ code: 'SELF_LOOP', msg: c.name + ' 依赖自身，已忽略' }); return false; }
        if (!byId[t]) { warnings.push({ code: 'DANGLING_REF', msg: c.name + ' 的依赖目标 ' + t + ' 不存在，已忽略' }); return false; }
        return true;
      });
      c.connects = c.connects.filter(function (t) {
        if (t === c.id) { warnings.push({ code: 'SELF_LOOP', msg: c.name + ' 自连通，已忽略' }); return false; }
        if (!byId[t]) { warnings.push({ code: 'DANGLING_REF', msg: c.name + ' 的互联目标 ' + t + ' 不存在，已忽略' }); return false; }
        return true;
      });
    });
    var truncated = false;
    if (comps.length > opts.maxNodes) {
      comps = comps.slice(0, opts.maxNodes);
      truncated = true;
      warnings.push({ code: 'TRUNCATED', msg: '组件数超过上限 ' + opts.maxNodes + '，仅绘制前 ' + opts.maxNodes + ' 个' });
    }
    return { empty: false, components: comps, warnings: warnings, options: opts, truncated: truncated };
  }

  // ---------------- 由拓扑白板 CFG 派生部署组件清单 ----------------
  /**
   * @param {Object} cfg  STORE.cfg（含 phys / vm / links）
   * @param {Object} lib  { machines: [], vmPrices: {cpu,mem,storage}, currency }
   * @returns model { components: [...] }
   */
  function deriveModel(cfg, lib, options) {
    cfg = cfg || {}; lib = lib || {};
    var opts = opts_(options);
    var machines = {}; (lib.machines || []).forEach(function (m) { machines[m.id] = m; });
    var units = []; // 展开成“台”：物理机按 qty 逐台，虚拟机按行聚合

    (cfg.phys || []).forEach(function (l) {
      var m = machines[l.machineId];
      if (!m) return;
      var q = clampInt(l.qty, 1, 100000, 1);
      for (var u = 1; u <= q; u++) {
        units.push({
          id: 'p_' + l.id + '_' + u, kind: 'phys', lineId: l.id, index: u,
          name: (l.deploy || '').trim(),
          // P-16：把用户在「架构梳理」页显式填写的用途/分组透传给 normalizeModel，
          // 否则用户的填写被丢弃、架构图仍靠关键字猜。
          purpose: (l.purpose || l.group || '').trim(),
          group: (l.group || '').trim(),
          spec: (m.brand + ' ' + m.model) + ' ' + (m.cpu_sockets || 0) + '路' + (m.cpu_cores || 0) + '核/' + (m.mem_capacity || 0) + 'G',
          type: '物理机', arch: m.arch || '', unit_cents: (m.unit_price_cents || 0)
        });
      }
    });
    (cfg.vm || []).forEach(function (l) {
      var q = clampInt(l.qty, 1, 100000, 1);
      units.push({
        id: 'v_' + l.id, kind: 'vm', lineId: l.id, index: 0,
        name: (l.deploy || '').trim(),
        purpose: (l.purpose || l.group || '').trim(),   // P-16
        group: (l.group || '').trim(),
        spec: (l.cpu || 0) + 'C/' + (l.mem || 0) + 'G/' + (l.sto || 0) + 'G',
        type: '虚拟机', arch: '虚拟化', unit_cents: 0, qty: q
      });
    });

    // 组件聚合键：用途 + 类型 + 规格
    var comps = {}, order = [];
    units.forEach(function (u) {
      // P-16：优先采用用户显式填写的用途（purpose/group），其次才是 deploy 关键字推断。
      // 原实现只读 u.name(deploy)，导致用户在「架构梳理」页精选的用途完全失效。
      var explicit = u.purpose || u.group || '';
      var purpose = explicit ? (normalizePurpose(explicit) || explicit) : normalizePurpose(u.name);
      if (!purpose || purpose === '未分组') purpose = normalizePurpose(u.name);
      // P-17：aggregate 此前是死开关（opts.aggregate 全文件零引用）。
      // 现在 aggregate=false 时不按「用途|类型|规格」合并，每个实例独立成节点。
      var key = opts.aggregate
        ? (purpose + '|' + u.type + '|' + u.spec)
        : ('__solo__' + u.id + '|' + u.type + '|' + u.spec);
      var c = comps[key];
      if (!c) {
        c = {
          id: 'cmp_' + (order.length + 1),
          name: u.name || purpose, purpose: purpose, type: u.type, spec: u.spec,
          arch: u.arch, qty: 0, unit_cents: u.unit_cents, members: [],
          depends_on: [], connects: []
        };
        comps[key] = c; order.push(key);
      }
      c.qty += (u.qty || 1);
      c.members.push(u.id);
      if (u.arch) c.arch = u.arch;
    });

    // 依据拓扑连线建立「依赖 / 互联」
    var unitToComp = {};
    order.forEach(function (k) { comps[k].members.forEach(function (mid) { unitToComp[mid] = comps[k].id; }); });
    var pairSeen = {};
    var links = cfg.links || [];
    var warnings = [];
    var dangling = 0;
    links.forEach(function (pair) {
      if (!isArr(pair) && pair !== Object(pair)) return;
      var a = pair[0], b = pair[1];
      if (a == null || b == null) return;
      var ca = unitToComp[a], cb = unitToComp[b];
      if (!ca || !cb) { dangling++; return; }
      if (ca === cb) return; // 组内实例之间不画连线
      var key = ca < cb ? (ca + '|' + cb) : (cb + '|' + ca);
      if (pairSeen[key]) return;
      pairSeen[key] = true;
      var A = findComp(order, comps, ca), B = findComp(order, comps, cb);
      if (!A || !B) return;
      var depends = false;
      if (opts.inferDependency && purposeLayer(A.purpose) !== purposeLayer(B.purpose)) depends = true;
      if (!depends) { uniqPush(A.connects, B.id); uniqPush(B.connects, A.id); }
      else {
        // 层级浅的（更靠上层/接入侧）依赖层级深的
        if (purposeLayer(A.purpose) < purposeLayer(B.purpose)) uniqPush(A.depends_on, B.id);
        else uniqPush(B.depends_on, A.id);
      }
    });
    if (dangling) warnings.push({ code: 'LINK_DANGLING', msg: '有 ' + dangling + ' 条连线无法映射到组件（端点未标注部署组件），已忽略' });
    if (!order.length) warnings.push({ code: 'EMPTY_LIST', msg: '部署组件清单为空：请先在「配置台 → 拓扑白板」中为服务器填写部署组件' });

    return {
      version: 1, source: 'topo', generatedAt: new Date().toISOString(),
      options: opts, warnings: warnings,
      components: order.map(function (k) { return comps[k]; })
    };
  }
  function findComp(order, comps, id) {
    for (var i = 0; i < order.length; i++) { if (comps[order[i]].id === id) return comps[order[i]]; }
    return null;
  }

  // ---------------- 关系构建 / 循环检测 / 分层 ----------------
  function pairKey(a, b) { return a < b ? (a + '||' + b) : (b + '||' + a); }

  function buildRelations(comps, opts) {
    var byId = {}; comps.forEach(function (c) { byId[c.id] = c; });
    var depends = {}, connects = {};
    comps.forEach(function (c) {
      (c.depends_on || []).forEach(function (t) { if (byId[t]) depends[pairKey(c.id, t)] = { a: c.id, b: t }; });
    });
    comps.forEach(function (c) {
      (c.connects || []).forEach(function (t) {
        if (!byId[t]) return;
        var k = pairKey(c.id, t);
        if (depends[k]) return;
        connects[k] = { a: c.id, b: t };
      });
    });
    if (opts.inferDependency) {
      Object.keys(connects).forEach(function (k) {
        var e = connects[k], A = byId[e.a], B = byId[e.b];
        if (!A || !B) return;
        var la = purposeLayer(A.purpose), lb = purposeLayer(B.purpose);
        if (la !== lb) {
          delete connects[k];
          depends[k] = (la < lb) ? { a: A.id, b: B.id } : { a: B.id, b: A.id };
        }
      });
    }
    return { depends: depends, connects: connects };
  }

  /** DFS 找出所有反向边（回边），用于打断循环依赖 */
  function findBackEdges(comps, depends) {
    var adj = {}; comps.forEach(function (c) { adj[c.id] = []; });
    Object.keys(depends).forEach(function (k) { var e = depends[k]; if (adj[e.a]) adj[e.a].push({ to: e.b, key: k }); });
    var color = {}, backs = {};
    function dfsVisit(u) {
      color[u] = 1;
      (adj[u] || []).forEach(function (e) {
        if (!color[e.to]) dfsVisit(e.to);
        else if (color[e.to] === 1) backs[e.key] = true;
      });
      color[u] = 2;
    }
    comps.forEach(function (c) { if (!color[c.id]) dfsVisit(c.id); });
    return backs;
  }

  /** 分层：初始按用途层级，再按依赖关系松弛（依赖方层级必须小于被依赖方） */
  function computeLayers(comps, depends) {
    var layer = {};
    comps.forEach(function (c) { layer[c.id] = purposeLayer(c.purpose); });
    var keys = Object.keys(depends);
    var changed = true, iter = 0, maxIter = comps.length + 2;
    while (changed && iter < maxIter) {
      changed = false; iter++;
      keys.forEach(function (k) {
        var e = depends[k];
        var need = layer[e.a] + 1;
        if (layer[e.b] < need) { layer[e.b] = need; changed = true; }
      });
    }
    var uniq = [];
    comps.forEach(function (c) { if (uniq.indexOf(layer[c.id]) < 0) uniq.push(layer[c.id]); });
    uniq.sort(function (x, y) { return x - y; });
    var mp = {}; uniq.forEach(function (v, i) { mp[v] = i; });
    comps.forEach(function (c) { layer[c.id] = mp[layer[c.id]]; });
    return layer;
  }

  // ---------------- 自动布局 ----------------
  function emptyGraph(opts, warnings) {
    return {
      version: 1, layout: opts.layout, options: opts, empty: true,
      nodes: [], groups: [], edges: [], bounds: { w: 640, h: 240 },
      stats: { nodes: 0, edges: 0, groups: 0, layers: 0, instances: 0, truncated: false },
      warnings: warnings || []
    };
  }

  function layout(model, options) {
    var nm = normalizeModel(model, options);
    var opts = nm.options;
    if (nm.empty) return emptyGraph(opts, nm.warnings);

    var comps = nm.components;
    // P-20：deriveModel 产生的 warnings（如 LINK_DANGLING）此前在此被丢弃，
    // 导致用户手工连线端点写错时没有任何提示。这里合并两侧告警。
    var warnings = nm.warnings.slice();
    (model && model.warnings ? model.warnings : []).forEach(function (w) {
      if (w && w.code && !warnings.some(function (x) { return x.code === w.code && x.msg === w.msg; })) {
        warnings.push(w);
      }
    });
    var rel = buildRelations(comps, opts);

    if (opts.breakCycle) {
      var backs = findBackEdges(comps, rel.depends);
      var bk = Object.keys(backs);
      if (bk.length) {
        bk.forEach(function (k) { var e = rel.depends[k]; delete rel.depends[k]; rel.connects[k] = e; });
        warnings.push({ code: 'CYCLE_DEP', msg: '检测到循环依赖（' + bk.length + ' 条），已将其中的回边降级为「互联」，避免布局无法收敛' });
      }
    }

    var layer = computeLayers(comps, rel.depends);
    var layerCount = 0;
    comps.forEach(function (c) { layerCount = Math.max(layerCount, layer[c.id] + 1); });
    var layers = [];
    for (var i = 0; i < layerCount; i++) layers.push([]);
    comps.forEach(function (c) { layers[layer[c.id]].push(c); });

    var nodes = [], groups = [], maxRight = 0;
    var y = opts.marginY;
    layers.forEach(function (list, li) {
      var gmap = {}, gorder = [];
      list.forEach(function (c) {
        var gname = (opts.groupBy === 'purpose') ? c.purpose : ('第 ' + (li + 1) + ' 层');
        if (!gmap[gname]) { gmap[gname] = []; gorder.push(gname); }
        gmap[gname].push(c);
      });
      gorder.forEach(function (gname) {
        gmap[gname].sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh'); });
      });
      var rowH = 0, x = opts.marginX;
      gorder.forEach(function (gname) {
        var members = gmap[gname];
        var innerW = members.length * opts.nodeWidth + (members.length - 1) * opts.hGap;
        var gw = opts.groupPad * 2 + innerW;
        var gh = opts.groupHead + opts.nodeHeight + opts.groupPad;
        var gid = 'grp_' + li + '_' + safeId(gname);
        if (opts.groupBy === 'purpose') {
          groups.push({ id: gid, name: gname, purpose: gname, layer: li, x: x, y: y, w: gw, h: gh, members: [] });
        }
        var lastGroup = groups[groups.length - 1];
        members.forEach(function (c, mi) {
          var nx = x + opts.groupPad + mi * (opts.nodeWidth + opts.hGap);
          var ny = y + opts.groupHead + Math.round(opts.groupPad / 2);
          nodes.push({
            id: c.id, name: c.name, purpose: c.purpose, type: c.type, spec: c.spec, arch: c.arch,
            qty: c.qty, members: c.members.slice(), layer: li,
            // P-21：groupBy !== 'purpose' 时 groups 不会 push，node.group 若仍写 gid
            // 会生成指向不存在 cell 的 parent，导致 draw.io 加载后节点丢失。此处显式置空。
            group: (opts.groupBy === 'purpose') ? gid : null,
            x: nx, y: ny, w: opts.nodeWidth, h: opts.nodeHeight
          });
          if (lastGroup && opts.groupBy === 'purpose') lastGroup.members.push(c.id);
        });
        x += gw + opts.groupGap;
        rowH = Math.max(rowH, gh);
      });
      maxRight = Math.max(maxRight, x - opts.groupGap);
      y += rowH + opts.vGap;
    });

    // 边
    var edges = [], eIdx = 0;
    var dk = Object.keys(rel.depends), ck = Object.keys(rel.connects);
    var nameOf = {}; comps.forEach(function (c) { nameOf[c.id] = c.name; });
    function mkEdge(k, e, kind) {
      return { id: 'e_' + (++eIdx), source: e.a, target: e.b, kind: kind,
        label: (kind === 'depends' ? '依赖' : '互联'), sourceName: nameOf[e.a], targetName: nameOf[e.b] };
    }
    dk.forEach(function (k) { edges.push(mkEdge(k, rel.depends[k], 'depends')); });
    ck.forEach(function (k) { edges.push(mkEdge(k, rel.connects[k], 'connects')); });
    var edgesTruncated = false;
    if (edges.length > opts.maxEdges) {
      edges = edges.slice(0, opts.maxEdges);
      edgesTruncated = true;
      warnings.push({ code: 'EDGE_TRUNCATED', msg: '连线数超过上限 ' + opts.maxEdges + '，仅绘制前 ' + opts.maxEdges + ' 条' });
    }

    var instances = comps.reduce(function (s, c) { return s + c.qty; }, 0);
    var boundsY = y;
    if (opts.legend) boundsY += 150;
    return {
      version: 1, layout: opts.layout, options: opts, empty: false,
      generatedAt: new Date().toISOString(),
      nodes: nodes, groups: groups, edges: edges,
      bounds: { w: Math.max(maxRight + opts.marginX, 900), h: Math.max(boundsY + opts.marginY, 500) },
      legendY: y,
      stats: {
        nodes: nodes.length, edges: edges.length, groups: groups.length, layers: layerCount,
        instances: instances, truncated: !!nm.truncated || edgesTruncated
      },
      warnings: warnings
    };
  }

  // ---------------- draw.io XML 生成 ----------------
  var STYLE_NODE = 'rounded=1;whiteSpace=wrap;html=1;verticalAlign=middle;align=center;arcSize=8;strokeWidth=2;shadow=0;fontSize=12;fontColor=#0f172a;';
  var STYLE_GROUP = 'rounded=1;arcSize=6;whiteSpace=wrap;html=1;verticalAlign=top;align=left;dashed=0;container=0;' +
    'startSize=30;spacingLeft=14;spacingTop=2;fontSize=11;fontStyle=1;fontColor=#334155;opacity=70;swimlane=0;';
  var STYLE_EDGE_DEP = 'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=blockThin;endFill=1;' +
    'strokeColor=#2563eb;strokeWidth=2;fontSize=10;fontColor=#1d4fb0;labelBackgroundColor=#ffffff;exitX=0.5;exitY=1;entryX=0.5;entryY=0;';
  var STYLE_EDGE_CON = 'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;dashed=1;endArrow=open;startArrow=open;' +
    'strokeColor=#94a3b8;strokeWidth=1.5;fontSize=10;fontColor=#64748b;labelBackgroundColor=#ffffff;';

  function nodeLabelHtml(n) {
    var head = htmlEsc(n.name || n.id);
    var mid = htmlEsc((n.type || '') + ((n.spec && n.spec !== n.type) ? (' · ' + n.spec) : ''));
    var tail = '实例 x' + (n.qty || 1);
    return '<b>' + head + '</b><br><font style="font-size:10px">' + mid + '</font>' +
      '<br><font style="font-size:10px" color="#b45309">' + tail + '</font>';
  }
  function ghostCell(num, n) {
    var off = num * 7;
    return '<mxCell id="gh_' + safeId(n.id) + '_' + num + '" value="" style="rounded=1;html=1;fillColor=#ffffff;' +
      'strokeColor=' + COLORS.ghost + ';strokeWidth=1;dashed=1;opacity=55;" vertex="1" parent="1">' +
      '<mxGeometry x="' + (n.x + off) + '" y="' + (n.y - off) + '" width="' + n.w + '" height="' + n.h + '" as="geometry"/></mxCell>';
  }
  function groupCell(g) {
    return '<mxCell id="' + safeId(g.id) + '" value="' + xmlEsc(g.name) + '" style="' + STYLE_GROUP +
      'fillColor=' + COLORS.group + ';strokeColor=' + COLORS.groupLine + ';" vertex="1" parent="1">' +
      '<mxGeometry x="' + g.x + '" y="' + g.y + '" width="' + g.w + '" height="' + g.h + '" as="geometry"/></mxCell>';
  }
  function nodeCell(n) {
    var color = COLORS[n.purpose] || COLORS['未分组'];
    var fill = FILLS[n.purpose] || FILLS['未分组'];
    var cid = safeId('n_' + n.id);
    var a = ' id="' + cid + '" label="' + xmlEsc(nodeLabelHtml(n)) + '"';
    a += ' xcid="' + xmlEsc(n.id) + '" xcname="' + xmlEsc(n.name) + '"';
    a += ' xcpurpose="' + xmlEsc(n.purpose) + '" xctype="' + xmlEsc(n.type) + '"';
    a += ' xcqty="' + (n.qty || 1) + '" xcspec="' + xmlEsc(n.spec) + '"';
    a += ' xcarch="' + xmlEsc(n.arch || '') + '"';
    a += ' xcmembers="' + xmlEsc((n.members || []).join(',')) + '"';
    a += ' xclayer="' + n.layer + '"';
    return '<object' + a + '><mxCell style="' + STYLE_NODE + 'fillColor=' + fill + ';strokeColor=' + color +
      ';" vertex="1" parent="' + safeId(n.group || '1') + '">' +
      '<mxGeometry x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + n.h + '" as="geometry"/></mxCell></object>';
  }
  function edgeCell(e, cellOf, opts) {
    var s = cellOf[e.source], t = cellOf[e.target];
    if (!s || !t) return '';
    var cid = safeId('e_' + e.id);
    var style = e.kind === 'depends' ? STYLE_EDGE_DEP : STYLE_EDGE_CON;
    if (e.kind === 'depends') style += 'jumpStyle=arc;';
    var a = ' id="' + cid + '" label="' + xmlEsc(e.label || '') + '"';
    a += ' xckind="' + xmlEsc(e.kind) + '" xcid="' + xmlEsc(e.id) + '"';
    a += ' xcsrc="' + xmlEsc(e.source) + '" xcdst="' + xmlEsc(e.target) + '"';
    return '<object' + a + '><mxCell style="' + style + '" edge="1" parent="1" source="' + s + '" target="' + t + '">' +
      '<mxGeometry relative="1" as="geometry"/></mxCell></object>';
  }
  function legendCells(g) {
    // P-22：原实现只读 g.options.legend，而 toDrawioXml 的 opts 是合并后的入参，
    // 导致 layout(model,{legend:false}) 生效、toDrawioXml(g,{legend:false}) 却仍出图例。
    // 优先取调用方显式合并后的 g._opts。
    var o = (g && g._opts) || (g && g.options) || {};
    if (!o.legend) return '';
    var x = o.marginX, y = g.legendY || (g.bounds.h - 150);
    var used = [];
    (g.nodes || []).forEach(function (n) { uniqPush(used, n.purpose); });
    if (!used.length) return '';
    var items = used.map(function (p) {
      return '<font color="' + (COLORS[p] || COLORS['未分组']) + '" style="font-size:11px">■ ' + htmlEsc(p) + '</font>';
    }).join('  ');
    var rows = [
      '<b>图例</b>',
      items,
      '<font style="font-size:10px" color="#1d4fb0">━▶ 依赖（实线箭头，自上而下：上层依赖下层）</font>',
      '<font style="font-size:10px" color="#64748b">┅ 互联（虚线，双向网络连通）</font>',
      '<font style="font-size:10px" color="#b45309">节点第三行「实例 xN」= 该组件的服务器副本数</font>'
    ];
    return '<mxCell id="legend" value="' + xmlEsc(rows.join('<br>')) + '" style="rounded=1;html=1;whiteSpace=wrap;' +
      'verticalAlign=top;align=left;fillColor=' + COLORS.legend + ';strokeColor=' + COLORS.groupLine +
      ';dashed=1;spacingLeft=12;spacingTop=8;fontSize=11;" vertex="1" parent="1">' +
      '<mxGeometry x="' + x + '" y="' + y + '" width="620" height="120" as="geometry"/></mxCell>';
  }

  function toDrawioXml(graph, options) {
    var opts = opts_(options || (graph && graph.options) || {});
    // P-22：把合并后的 opts 挂到 graph 副本上，供 legendCells 等下游读取显式入参
    var g = graph;
    if (graph && typeof graph === 'object') {
      g = {};
      for (var k in graph) { if (Object.prototype.hasOwnProperty.call(graph, k)) g[k] = graph[k]; }
      g._opts = opts;
      g.options = opts;
    }
    if (!g || g.empty || !(g.nodes || []).length) {
      return '<mxfile host="server-config-workbench" agent="arch-graph.js" type="device">' +
        '<diagram id="arch" name="部署架构图"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" page="1" pageWidth="1100" pageHeight="850"><root>' +
        '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
        '<mxCell id="note" value="' + xmlEsc('暂无部署组件' + '<br>' + '请先在「配置台 → 拓扑白板」中为服务器填写部署组件，再回到本页生成架构图') +
        '" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#f1f5f9;strokeColor=#94a3b8;dashed=1;fontSize=13;verticalAlign=middle;align=center;" vertex="1" parent="1">' +
        '<mxGeometry x="160" y="160" width="420" height="100" as="geometry"/></mxCell>' +
        '</root></mxGraphModel></diagram></mxfile>';
    }
    var cellOf = {};
    (g.nodes || []).forEach(function (n) { cellOf[n.id] = safeId('n_' + n.id); });
    var out = [];
    if (opts.stackReplicas) {
      (g.nodes || []).forEach(function (n) {
        var layers = Math.min((n.qty || 1) - 1, Math.max(opts.maxStack - 1, 0));
        for (var i = layers; i >= 1; i--) out.push(ghostCell(i, n));
      });
    }
    (g.groups || []).forEach(function (grp) { out.push(groupCell(grp)); });
    var eOut = [];
    (g.edges || []).forEach(function (e) { var c = edgeCell(e, cellOf, opts); if (c) eOut.push(c); });
    out = out.concat(eOut);
    (g.nodes || []).forEach(function (n) { out.push(nodeCell(n)); });
    out.push(legendCells(g));

    var pw = Math.max(g.bounds.w + 80, opts.pageWidth || 1200);
    var ph = Math.max(g.bounds.h + 80, opts.pageHeight || 800);
    return '<mxfile host="server-config-workbench" agent="arch-graph.js" type="device">' +
      '<diagram id="arch" name="部署架构图">' +
      '<mxGraphModel dx="1100" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" ' +
      'page="1" pageScale="1" pageWidth="' + pw + '" pageHeight="' + ph + '" math="0" shadow="0">' +
      '<root><mxCell id="0"/><mxCell id="1" parent="0"/>' + out.join('') + '</root>' +
      '</mxGraphModel></diagram></mxfile>';
  }

  // ---------------- draw.io XML 回解析 ----------------
  function decodeXml(s) {
    return String(s == null ? '' : s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&#10;/g, ' ').replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }
  function stripHtml(s) {
    return String(s == null ? '' : s)
      .replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|div|font|b|i|u)>/gi, ' ')
      .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }
  function parseAttrs(str) {
    var out = {}, re = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g, m;
    while ((m = re.exec(str))) out[m[1]] = decodeXml(m[2]);
    return out;
  }
  function firstTag(block, name) {
    var m = new RegExp('<' + name + '\\b([^>]*?)/?>').exec(block);
    return m ? parseAttrs(m[1]) : null;
  }

  function scanCells(xml) {
    var cells = [], ranges = [];
    var objRe = /<(object|UserObject)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi, m;
    while ((m = objRe.exec(xml))) {
      ranges.push([m.index, m.index + m[0].length]);
      var wrap = parseAttrs(m[2]);
      var cell = firstTag(m[3], 'mxCell') || {};
      var geom = firstTag(m[3], 'mxGeometry') || {};
      cells.push({ id: wrap.id || cell.id, wrapper: wrap, cell: cell, geom: geom, wrapped: true });
    }
    var bareRe = /<mxCell\b([^>]*?)(\/?)>/g, m2;
    while ((m2 = bareRe.exec(xml))) {
      var inside = ranges.some(function (r) { return m2.index >= r[0] && m2.index < r[1]; });
      if (inside) continue;
      var cellAttrs = parseAttrs(m2[1]);
      // P-18：原实现固定截取 400 字符窗口找 mxGeometry。STYLE_NODE 本身就有 168 字符，
      // 用户在 draw.io 里编辑后 label 常超过 200 字符，几何标签落在窗口外 →
      // 所有节点坐标归零并堆叠到左上角。改为定位到该 cell 的真实结束标签。
      var nextOpen = xml.indexOf('<mxCell', m2.index + m2[0].length);
      var closeIdx2 = xml.indexOf('</mxCell>', m2.index);
      var tailEnd = closeIdx2 > 0 ? closeIdx2 + 9 : (nextOpen > 0 ? nextOpen : xml.length);
      var tail = xml.slice(m2.index, tailEnd);
      var geom2 = firstTag(tail, 'mxGeometry') || {};
      var closeIdx = tail.indexOf('</mxCell>');
      var selfClose = /\/\s*>$/.test(m2[0]);
      if (!selfClose && closeIdx > 0) ranges.push([m2.index, m2.index + closeIdx + 9]);
      cells.push({ id: cellAttrs.id, wrapper: {}, cell: cellAttrs, geom: geom2, wrapped: false, noGeom: !geom2.x });
    }
    return cells;
  }

  function guessType(label) {
    var s = String(label || '').toLowerCase();
    if (/虚拟机|vm|虚机/.test(s)) return '虚拟机';
    if (/物理机|服务器|裸金属/.test(s)) return '物理机';
    return '未分类';
  }

  function fromDrawioXml(xml) {
    var warnings = [];
    var text = String(xml || '');
    if (!text.trim()) return { nodes: [], edges: [], warnings: [{ code: 'PARSE_EMPTY', msg: '待解析内容为空' }] };
    if (text.indexOf('mxGraphModel') < 0 && text.indexOf('mxCell') < 0) {
      return { nodes: [], edges: [], warnings: [{ code: 'PARSE_BAD_FORMAT', msg: '不是有效的 draw.io XML（未找到 mxGraphModel / mxCell）' }] };
    }
    var cells = scanCells(text);
    var nodes = [], edges = [], cellToComp = {};
    cells.forEach(function (c) {
      var cid = c.id;
      if (!cid || cid === '0' || cid === '1') return;
      if (/^gh_/.test(cid) || cid === 'legend' || /^grp_/.test(String(cid))) return;
      if (c.cell.edge === '1') return;
      if (c.cell.vertex !== '1' && !c.wrapped) {
        if (!c.geom.width) return;
      }
      var w = c.wrapper || {};
      var label = stripHtml(w.label != null ? w.label : c.cell.value);
      if (!label && !w.xcid) return;
      var purpose = w.xcpurpose || normalizePurpose(label);
      var node = {
        cid: w.xcid || cid,
        cellId: cid,
        label: label,
        name: w.xcname || label || w.xcid || cid,
        purpose: purpose,
        type: w.xctype || guessType(label),
        spec: w.xcspec || '',
        arch: w.xcarch || '',
        qty: clampInt(w.xcqty, 1, 100000, 1),
        members: (w.xcmembers || '').split(',').filter(Boolean),
        layer: clampInt(w.xclayer, 0, 99, 0),
        x: parseFloat(c.geom.x) || 0, y: parseFloat(c.geom.y) || 0,
        w: parseFloat(c.geom.width) || DEFAULTS.nodeWidth, h: parseFloat(c.geom.height) || DEFAULTS.nodeHeight,
        manual: !w.xcid
      };
      if (node.manual) warnings.push({ code: 'MANUAL_NODE', msg: '检测到手工新增节点「' + node.name + '」，已按标签推断用途，数量记为 1' });
      nodes.push(node);
      cellToComp[cid] = node.cid;
    });
    var byCid = {}; nodes.forEach(function (n) { byCid[n.cid] = n; });
    cells.forEach(function (c) {
      if (c.cell.edge !== '1') return;
      var w = c.wrapper || {};
      var src = w.xcsrc || cellToComp[c.cell.source];
      var dst = w.xcdst || cellToComp[c.cell.target];
      if (!src || !dst) { warnings.push({ code: 'PARSE_EDGE_DROP', msg: '有一条连线的端点无法定位，已忽略' }); return; }
      if (src === dst) return;
      var kind = w.xckind || (/dashed=1/.test(String(c.cell.style || '')) ? 'connects' : 'depends');
      edges.push({ cellId: c.id, source: src, target: dst, kind: kind, label: w.label != null ? stripHtml(w.label) : '' });
    });
    if (!nodes.length) warnings.push({ code: 'PARSE_NO_NODE', msg: '未在图中识别到任何节点' });
    return { nodes: nodes, edges: edges, warnings: warnings, stats: { nodes: nodes.length, edges: edges.length } };
  }

  /** 由回解析结果重建 model，可直接再次交给 layout() 重新自动布局 */
  function modelFromParsed(parsed, prevModel) {
    var prev = {};
    ((prevModel && prevModel.components) || []).forEach(function (c) { prev[c.id] = c; });
    parsed = parsed || {};
    var nodes = parsed.nodes || [];
    var comps = nodes.map(function (n) {
      var old = prev[n.cid];
      var comp = {
        id: n.cid,
        name: n.name,
        purpose: n.purpose || normalizePurpose(n.name),
        type: n.type || (old ? old.type : '未分类'),
        spec: n.spec || (old ? old.spec : ''),
        arch: n.arch || (old ? old.arch : ''),
        qty: clampInt(n.qty, 1, 100000, 1),
        unit_cents: old ? old.unit_cents : 0,
        members: (n.members && n.members.length) ? n.members : (old ? old.members : []),
        depends_on: [], connects: []
      };
      if (n.manual) comp.manual = true;
      return comp;
    });
    var seen = {};
    (parsed.edges || []).forEach(function (e) {
      var key = e.source < e.target ? (e.source + '||' + e.target) : (e.target + '||' + e.source);
      if (e.kind === 'depends') {
        if (seen['d:' + key] || seen['d:' + (e.target + '||' + e.source)]) return;
        seen['d:' + key] = true;
        pushRef(comps, e.source, 'depends_on', e.target);
      } else {
        var revKey = e.target + '||' + e.source;
        if (seen['c:' + key] || seen['c:' + revKey] || seen['d:' + key] || seen['d:' + revKey]) return;
        seen['c:' + key] = true;
        pushRef(comps, e.source, 'connects', e.target);
        pushRef(comps, e.target, 'connects', e.source);
      }
    });
    return {
      version: 1, source: 'drawio', generatedAt: new Date().toISOString(),
      warnings: parsed.warnings || [], components: comps
    };
  }
  function pushRef(comps, id, field, target) {
    for (var i = 0; i < comps.length; i++) {
      if (comps[i].id === id) { uniqPush(comps[i][field], target); return; }
    }
  }

  // ---------------- 导出 ----------------
  return {
    PURPOSE_ORDER: PURPOSE_ORDER,
    PURPOSE_LAYER: PURPOSE_LAYER,
    PURPOSE_RULES: PURPOSE_RULES,
    DEFAULTS: DEFAULTS,
    COLORS: COLORS,
    FILLS: FILLS,
    normalizePurpose: normalizePurpose,
    purposeLayer: purposeLayer,
    deriveModel: deriveModel,
    normalizeModel: normalizeModel,
    layout: layout,
    toDrawioXml: toDrawioXml,
    fromDrawioXml: fromDrawioXml,
    modelFromParsed: modelFromParsed,
    decodeXml: decodeXml,
    stripHtml: stripHtml,
    safeId: safeId,
    opts: opts_
  };
});
