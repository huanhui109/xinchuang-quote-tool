/* 硬件配置清单解析引擎（可配置规则 + 多供应商适配）
 * 纯函数实现：不依赖 DOM / 后端，既可在浏览器 <script> 中直接使用，
 * 也可被 Node 加载做单元测试（UMD）。
 *
 * 输入：{ name, sheets: [{ name, rows: [[cell,...],...] }] }
 * 输出：{ ok, rule, sheet, rows, skippedRows, combos, selections, stats, warnings }
 */
;(function (root, factory) {
  var ag = null;
  try { ag = require('../web/arch-graph.js'); } catch (e) { /* 浏览器环境无 require */ }
  if (typeof module === 'object' && module.exports) module.exports = factory(ag);
  else root.HclCore = factory(root.ArchGraph || null);
})(typeof self !== 'undefined' ? self : this, function (AG) {
  'use strict';

  var VERSION = '1.0.0';

  // ---------------- 资源上限（与后端保持一致） ----------------
  var LIMITS = {
    maxSheets: 8, maxRows: 5000, maxCols: 60,
    scanRows: 12, maxHeaderRows: 3, maxRowsPerTable: 500,
  };

  // ---------------- 归一化用途字典（与架构图模块保持口径一致） ----------------
  var PURPOSE_RULES = (AG && AG.PURPOSE_RULES) || [
    [['网关', '接入', '负载', '均衡', 'gateway', 'gw', 'lb', 'nginx', 'f5', 'proxy', '反向代理', 'cdn', 'slb', '前置'], '接入层'],
    [['web', '门户', '前端', '应用', 'app', '交易', '柜面', 'tomcat', 'spring', '业务', '委托', '清算', '资管', '风控', '订单', '报盘', 'ufx', 'uft'], '应用服务'],
    [['中间件', 'redis', '缓存', 'cache', 'kafka', 'mq', '消息', 'rabbit', 'rocketmq', 'zookeeper', 'bes'], '中间件'],
    [['数据', 'db', 'oracle', 'mysql', '达梦', 'gauss', 'postgre', '报表', '数仓', '数据库', 'tdsql', 'oceanbase', 'goldendb'], '数据服务'],
    [['存储', 'nas', '备份', 'ceph', '对象存储', 'oss', '磁带', 'minio', '分布式文件'], '存储备份'],
    [['管理', '监控', '运维', '堡垒', '日志', '审计', 'zabbix', 'prometheus', 'k8s', 'kubernetes', '云管', '虚拟化', 'ocp'], '基础设施'],
  ];

  // ---------------- 默认解析规则（可配置 / 可扩展） ----------------
  function defaultRules() {
    return [
      {
        id: 'wide-spec-columns',
        name: '宽表式硬件清单（CPU/内存/硬盘/网卡分列）',
        vendor: '通用 · 适配宽表式清单',
        enabled: true, priority: 100,
        sheet: { include: '硬件|配置清单|服务器配置|主机|资源需求', exclude: '阅读指南|软件要求|封面|变更记录|目录' },
        header: { scanRows: 12, maxHeaderRows: 3, minScore: 5 },
        required: [],
        repeatColumns: ['system', 'hwType', 'purpose', 'required', 'raid', 'remark'],
        columns: {
          system: ['所属系统', '系统'],
          purpose: ['硬件用途', '用途', '功能描述', '服务器用途', '部署用途'],
          hwType: ['硬件类型', '设备类型'],
          apps: ['部署应用', '部署服务', '应用软件', '组件'],
          entity: ['实体机/虚拟机', '实虚', '资源形态'],
          required: ['必选', '是否必选'],
          qty: ['数量', '台数', '服务器数量'],
          model: ['机型', '型号'],
          cpuModel: ['CPU型号', 'cpu型号', 'cpu', '处理器'],
          cpuCores: ['物理核', '核数', 'cpu核数', '物理核心'],
          cpuFreq: ['主频', '频率'],
          mem: ['内存', '内存容量'],
          disk: ['硬盘', '容量', '本地盘'],
          diskType: ['转速', '介质'],
          raid: ['灾备', 'raid'],
          nic: ['网卡'],
          remark: ['备注'],
          specText: ['服务器配置', '配置说明', '硬件服务器配置', '配置参考', '参考配置', '规格'],
        },
        vm: { defaultStorageGB: 100, defaultQty: 1 },
      },
      {
        id: 'free-text-spec',
        name: '紧凑式清单（部署应用 + 整段规格文本）',
        vendor: '通用 · 适配自由文本式清单',
        enabled: true, priority: 90,
        sheet: { include: '配置清单|服务器配置|主机|硬件|部署', exclude: '阅读指南|软件要求|封面|变更记录|目录' },
        header: { scanRows: 12, maxHeaderRows: 3, minScore: 3 },
        required: ['specText', 'qty'],
        repeatColumns: ['system', 'purpose'],
        columns: {
          purpose: ['硬件用途', '用途', '功能'],
          apps: ['部署应用', '部署服务', '应用', '业务模块'],
          entity: ['服务器类型', '类型', '资源类型'],
          required: ['必选'],
          qty: ['数量', '台数'],
          specText: ['服务器配置', '配置说明', '规格', '配置'],
          remark: ['备注'],
        },
        vm: { defaultStorageGB: 100, defaultQty: 1 },
      },
      {
        id: 'generic',
        name: '通用兜底（纯关键字猜列）',
        vendor: '通用',
        enabled: true, priority: 1,
        sheet: { include: '', exclude: '阅读指南|封面|目录' },
        header: { scanRows: 12, maxHeaderRows: 2, minScore: 2 },
        required: [],
        repeatColumns: ['system', 'purpose'],
        columns: {
          purpose: ['用途', '用途说明'],
          apps: ['部署应用', '应用', '说明'],
          entity: ['服务器类型', '类型'],
          qty: ['数量'],
          cpuModel: ['cpu', '处理器'],
          mem: ['内存'],
          disk: ['硬盘'],
          nic: ['网卡'],
          specText: ['配置', '规格'],
          remark: ['备注'],
        },
        vm: { defaultStorageGB: 100, defaultQty: 1 },
      },
    ];
  }

  // ---------------- 基础工具 ----------------
  function trim(s) { return String(s == null ? '' : s).trim(); }
  function nz(s) { return trim(s) || ''; }

  /** C-7：把用户手动指定的列映射覆盖到自动识别结果上。
   *  只覆盖用户显式给出的字段，其余字段保留自动识别值；越界或非法值忽略。 */
  function applyColumnMap(autoMap, columnMap, colCount) {
    var out = Object.assign({}, autoMap || {});
    if (!columnMap || typeof columnMap !== 'object') return out;
    Object.keys(columnMap).forEach(function (field) {
      var v = columnMap[field];
      if (v === '' || v == null) { delete out[field]; return; }
      var idx = parseInt(v, 10);
      if (isNaN(idx) || idx < 0) return;
      if (colCount && idx >= colCount) return;   // 越界忽略，避免解析期读 undefined
      out[field] = idx;
    });
    return out;
  }
  /** 取表头文本数组（供 C-7 列映射 UI 使用）；跨表头行时用 | 连接 */
  function headersOf(pick) {
    var hs = (pick && pick.plan && pick.plan.heads) || [];
    return hs.map(function (h) {
      if (typeof h === 'string') return h;
      return (h && (h.all || h.key)) || '';
    });
  }

  function normalizeText(s) {
    var t = String(s == null ? '' : s);
    t = t.replace(/\r\n?/g, '\n');
    t = t.replace(/[（(]/g, '(').replace(/[）)]/g, ')');
    t = t.replace(/[×✕]/g, '*');
    t = t.replace(/\uff0f/g, '/');
    t = t.replace(/[\u00A0\u2007\u202F]/g, ' ');
    // 供应商常有 "2. 6GHz" 这类被空格拆开的数字，先合并再解析
    t = t.replace(/(\d)\.\s+(\d)/g, '$1.$2');
    t = t.replace(/[ \t]+/g, ' ');
    return t.replace(/\n{2,}/g, '\n').trim();
  }
  function compact(s) { return normalizeText(s).replace(/[\s,，、;；]/g, '').toLowerCase(); }
  function hashKey(s) {
    var h = 2166136261;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h.toString(36);
  }
  function cellText(v) {
    if (v == null) return '';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return normalizeText(v);
  }
  function splitApps(s) {
    var out = [];
    normalizeText(s).split(/[,，、\/;；\n]+/).forEach(function (p) {
      p = trim(p).replace(/^[-•·\d.)\]]+/, '').trim();
      if (p && p.length < 80) out.push(p);
    });
    return out.filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 12);
  }

  // ---------------- 值解析：数量 / 布尔 / 容量 ----------------
  function parseQty(raw, opt) {
    opt = opt || {};
    var s = nz(cellText(raw));
    if (!s) return { qty: opt.dflt || 1, unknown: true, issue: 'EMPTY' };
    if (/^n(\.?)(\s*台)?$/i.test(s) || /待定|未知|按需|根据实际|视情况/i.test(s)) return { qty: opt.dflt || 1, unknown: true, issue: 'UNKNOWN_TOKEN' };
    var m = s.match(/(-?\d+(?:\.\d+)?)/);
    if (!m) return { qty: opt.dflt || 1, unknown: true, issue: 'NOT_NUMBER' };
    var n = parseFloat(m[1]);
    if (!isFinite(n) || n <= 0) return { qty: opt.dflt || 1, unknown: false, issue: 'NOT_POSITIVE' };
    if (Math.abs(n - Math.round(n)) > 1e-9) return { qty: Math.ceil(n), unknown: false, issue: 'ROUND_UP' };
    return { qty: Math.round(n), unknown: false, issue: '' };
  }
  function parseTruthy(raw) {
    var s = compact(raw);
    if (!s) return null;
    if (/^(是|y|yes|true|√|✓|必须|必配|1)$/.test(s)) return true;
    if (/^(否|n|no|false|×|x|可选|0)$/.test(s)) return false;
    return null;
  }
  // 说明：T/TB 采用硬盘厂商的十进制口径（1T=1000G，3.84T=3840G）；GB 沿用 GB
  var UNIT_GB = { t: 1000, tb: 1000, g: 1, gb: 1, m: 1 / 1024, mb: 1 / 1024 };
  function parseGB(text) {
    var m = String(text || '').match(/(\d+(?:\.\d+)?)\s*(tb|t|gb|g|mb|m)(\b|$)/i);
    if (!m) return null;
    var u = String(m[2]).toLowerCase();
    return Math.round(parseFloat(m[1]) * (UNIT_GB[u] || 1));
  }
  function gbText(gb) {
    if (gb == null) return '';
    if (gb >= 1000) return (Math.round((gb / 1000) * 100) / 100) + 'T';
    return gb + 'G';
  }

  var MEM_KW = ['内存', 'DDR', 'RDIMM', 'ECC'];
  var DISK_KW = ['SSD', 'NVMe', 'SATA', 'SAS', 'HDD', '硬盘', '固态', '机械'];
  var CPU_KW = ['Core', 'GHz', 'CPU', '主频', '处理器'];
  /** 关键词到某个 token 的最近距离（距离近者优先，避免同一行里内存与硬盘互相误判） */
  function nearestKw(l, tokenStart, tokenEnd, kws) {
    var best = Infinity, lower = l.toLowerCase();
    (kws || []).forEach(function (kw) {
      var k = String(kw).toLowerCase(), p = 0;
      while ((p = lower.indexOf(k, p)) >= 0) {
        var center = p + k.length / 2;
        var d = Math.min(Math.abs(center - tokenEnd), Math.abs(center - tokenStart));
        if (d < best) best = d;
        p += k.length;
      }
    });
    return best;
  }
  /** 速率单位（如 SATA-6G / 6Gb/s）不是容量，需在容量正则中排除（B-2）。
   *  注意不能单看 sata/sas 字样——「4*1T-SAS」里的 SAS 是盘型，必须要求紧跟容量数字。 */
  function isRateContext(ctx) {
    if (/gb\s*\/\s*s|gbps|gigabit|mb\s*\/\s*s|mbps/i.test(ctx)) return true;
    // SATA-6G / SAS-12G：接口名 + 短横 + 数字G，且数字紧邻 G
    return /(sata|sas|scsi|pcie|usb|sfp)\s*-\s*\d{1,4}\s*g\b/i.test(ctx);
  }
  /**
   * 虚拟机三段式规格「aC/bG/cG」识别（B-1）。
   * 无任何中文关键词时，原兜底逻辑会把三段容量全部判为内存（8C/32G/100G → 8C/132G/100G），
   * 造成报价虚高。此处只判断「本行是否为 核数/容量/容量 三段式」，具体分配在 capByContext。
   */
  function vmTripletRoles(l) {
    // 形如 8C/32G/100G、8核/32G/100G（允许 vCPU 前缀与小数）
    var m = l.match(/(?:^|[^0-9a-z.])(\d{1,3})\s*(?:c\b|核|cpu)/i);
    if (!m) return null;
    var after = l.slice(m.index + m[0].length);
    var caps = [], re = /(\d+(?:\.\d+)?)\s*(tb|t|gb|g|mb|m)\b/gi, g;
    while ((g = re.exec(after)) && caps.length < 4) caps.push(g);
    // 至少两个容量段才可能是「核/内存/存储」三段式
    if (caps.length < 2) return null;
    return { capCount: caps.length };
  }
  /** 依据上下文判断某个「数字+单位」属于内存还是硬盘 */
  function roleOfToken(l, start, end) {
    var dMem = nearestKw(l, start, end, MEM_KW);
    var dDisk = nearestKw(l, start, end, DISK_KW);
    var dCpu = nearestKw(l, start, end, CPU_KW);
    if (dCpu < dMem && dCpu < dDisk) return 'cpu';
    if (dMem === Infinity && dDisk === Infinity) {
      return /t\b|tb/i.test(l.slice(start, end)) ? 'disk' : 'mem';
    }
    return dMem <= dDisk ? 'mem' : 'disk';
  }

  // ---------------- CPU 识别 ----------------
  var CPU_BRAND = [
    [/(hygon|海光)/i, '海光', '海光(C86/x86)'],
    [/(kunpeng|鲲鹏)/i, '鲲鹏', '鲲鹏(ARM)'],
    [/(飞腾|phytium)/i, '飞腾', '飞腾(ARM)'],
    [/(龙芯|loongson)/i, '龙芯', '龙芯(LoongArch)'],
    [/(兆芯|zhaoxin)/i, '兆芯', '兆芯(x86)'],
    [/(intel|xeon|至强)/i, 'Intel', 'x86'],
    [/(amd|epyc)/i, 'AMD', 'x86'],
  ];
  function cpuBrand(name) {
    for (var i = 0; i < CPU_BRAND.length; i++) if (CPU_BRAND[i][0].test(name)) return CPU_BRAND[i];
    return ['', '', ''];
  }
  function cleanCpuModel(s) {
    return trim(s)
      .replace(/\s*\b(arm|x86|x86_64|64位|处理器|CPU)\b\s*/gi, ' ')
      .replace(/[\s,，]+$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // ---------------- 用途归一化 ----------------
  var UNASSIGNED = '未分组';
  /* 行业扩展关键字（二级字典）：只扩召回，不新增分组名，
   * 保证与架构图模块的分组集合严格一致。金融/交易系统常见词。 */
  var EXTRA_PURPOSE_RULES = [
    [['风控', '合规', '清算', '委托', '资管', '估值', 'ta', '直销', '登记', '过户', 'ufx', 'uft', '报盘', '行情', '做市', '两融', '期权', '结算'], '应用服务'],
    [['ocp', '基础平台', '基础组件', '跳板', '发布', 'cmdb', '自动化'], '基础设施'],
    [['网关', 'f5', 'slb', '接入', '均衡', '反向代理'], '接入层'],
    [['达梦', 'goldendb', 'tdsql', 'oceanbase', 'gaussdb', '人大金仓', 'kingbase'], '数据服务'],
    [['amo', 'amo平台'], '应用服务'],
  ];
  function matchRules(s, rules) {
    for (var i = 0; i < rules.length; i++) {
      var name = compact(rules[i][1]);
      // 分组名本身即命中：避免「基础设施 / 存储备份」这类分组名反查不到自己
      if (name && (s === name || s.indexOf(name) >= 0)) return rules[i][1];
      for (var j = 0; j < rules[i][0].length; j++) {
        var kw = compact(rules[i][0][j]);
        if (kw && s.indexOf(kw) >= 0) return rules[i][1];
      }
    }
    return '';
  }
  function purposeOf(text) {
    if (AG && typeof AG.normalizePurpose === 'function') {
      var g = AG.normalizePurpose(text);
      if (g && g !== UNASSIGNED) return g;
    }
    var s = compact(text);
    if (!s) return UNASSIGNED;
    // 1) 主字典（与架构图同源） 2) 行业扩展字典 3) 未分组
    return matchRules(s, PURPOSE_RULES) || matchRules(s, EXTRA_PURPOSE_RULES) || UNASSIGNED;
  }
  /** 可选用途分组（供人工补录下拉 / 输入建议）：{ name, kws, fill } */
  function purposeGroups() {
    return PURPOSE_RULES.map(function (r) {
      var name = r[1];
      return { name: name, kws: r[0].slice(0), fill: purposeOf(name) === name ? name : (r[0][0] || name) };
    });
  }
  function purposeOfApps(apps) {
    var tally = {}, order = [];
    (apps || []).forEach(function (a) {
      var p = purposeOf(a);
      if (p === '未分组') return;
      if (!tally[p]) { tally[p] = 0; order.push(p); }
      tally[p]++;
    });
    var best = '', bn = 0;
    order.forEach(function (p) { if (tally[p] > bn) { bn = tally[p]; best = p; } });
    return best;
  }

  // ---------------- 网卡 ----------------
  var CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 八: 8, 十: 10 };
  function cnNum(s) { return CN_NUM[s] != null ? CN_NUM[s] : parseInt(s, 10); }

  function parseNics(text) {
    var l = normalizeText(text);
    if (!l) return [];
    var media = '';
    if (/光口|光模块|sfp|光纤/i.test(l)) media = '光口';
    else if (/电口|rj45|双绞线/i.test(l)) media = '电口';

    var speeds = [], seen = {};
    function addSpeed(s) { if (s && !seen[s]) { seen[s] = 1; speeds.push(s); } }
    // 「4*GE」「8DIMM/4*GE」这类前缀式写法也要识别为网卡行（B-2）
    var isNicLine = /网卡|网口|以太网|sfp|光模块|万兆|千兆|百兆|\d\s*[*xX×]?\s*GE\b/i.test(l);
    if (!isNicLine) return [];
    // 前缀式「4*GE」：前置数字是数量，速率缺省按 1GE 处理
    var prefixCnt = l.match(/(\d+)\s*[*xX×]\s*(?=(?:\d{0,3}\s*)?(?:G|F)E\b)/i);
    // 把前缀数量摘掉后再提取速率，避免「4*GE」被读成 4GE
    var l2 = prefixCnt ? l.replace(prefixCnt[0], ' ') : l;
    if (/十万兆|100GE/i.test(l2)) addSpeed('100GE');
    else if (/万兆|40GE|25GE/i.test(l2)) {
      var mx = l2.match(/(\d{2,3})\s*GE\b/i);
      addSpeed((mx ? mx[1] : '10') + 'GE');
    } else if (/千兆|1GE/i.test(l2)) addSpeed('1GE');
    else if (/百兆/i.test(l2)) addSpeed('FE');
    var re = /(\d+)\s*GE\b/gi, mm;
    while ((mm = re.exec(l2))) addSpeed(mm[1] + 'GE');
    if (!speeds.length) {
      // 兜底：写作 "10G网卡" 这类没有 E 后缀的写法
      var gs = l2.match(/(\d+)\s*G(?:E)?(?![A-Za-z])/i);
      if (gs) addSpeed(gs[1] + 'GE');
    }
    // 「4*GE」摘掉数量后速率无从判断，缺省为千兆
    if (!speeds.length && prefixCnt) addSpeed('1GE');
    if (!speeds.length) addSpeed('');

    var counts = [];
    (l.match(/(\d+)\s*块\s*(\d+)\s*口/g) || []).forEach(function (b) {
      var m = b.match(/(\d+)\s*块\s*(\d+)\s*口/);
      if (m) counts.push((+m[1]) * (+m[2]));
    });
    if (!counts.length) {
      (l.match(/([一二两三四五六八十]|\d+)\s*[电光]口/g) || []).forEach(function (seg) {
        var m2 = seg.match(/([一二两三四五六八十]|\d+)/);
        if (m2) counts.push(cnNum(m2[1]));
      });
    }
    if (!counts.length) {
      var pm = l.match(/(\d+)\s*ports/i);
      if (pm) counts.push(+pm[1]);
    }
    if (!counts.length) {
      // 后缀式：1GE *4
      var suf = l.match(/[*xX×]\s*(\d+)(?=$|[\s,，;；)])/);
      if (suf) counts.push(+suf[1]);
      else if (prefixCnt) counts.push(+prefixCnt[1]);   // 前缀式：4*GE
      else {
        // 通用前缀数量：2*万兆双光口/25GE…、8DIMM/4*GE
        var st = l.match(/(?:^|[\s,，/])(\d+)\s*[*xX×]/);
        counts.push(st ? +st[1] : 1);
      }
    }
    if (!counts.length) counts.push(1);

    var n = Math.max(speeds.length, counts.length);
    var out = [];
    for (var i = 0; i < n && i < 4; i++) {
      out.push({ speed: speeds[i] || speeds[0] || '', count: counts[i] || counts[0] || 1, media: media });
    }
    return out;
  }
  function nicDesc(nics) {
    return (nics || []).filter(function (n) { return n.speed || n.count; })
      .map(function (n) { return (n.count > 1 ? n.count + '×' : '') + (n.speed || '网卡') + (n.media ? '(' + n.media + ')' : ''); })
      .join(' + ');
  }

  // ---------------- 内存 / 硬盘 ----------------
  function parseCapItems(text, role) {
    var l = normalizeText(text);
    if (!l) return [];
    if (role === 'disk' || role === 'mem') return capByRole(l, role);
    return capByContext(l);
  }
  /** 紧跟在某数值之后、到下一个「数字+单位」为止的片段 */
  function afterSegment(l, endIdx) {
    var seg = l.slice(endIdx, endIdx + 40);
    var stop = seg.search(/(\d+(?:\.\d+)?)\s*(tb|t|gb|g|mb|m)(\b|$)/i);
    return stop > 0 ? seg.slice(0, stop) : seg;
  }
  /** 数量：优先向前找「N*」前缀式，其次向后找「*N / ×N」后缀式（B-2） */
  function countAfter(l, startIdx, endIdx) {
    // 前缀式：2*480G SSD / 4*32GB DDR4 —— 数量写在容量之前
    var pre = l.slice(Math.max(0, startIdx - 6), startIdx).match(/(\d+)\s*[\*xX×]\s*$/);
    if (pre) return +pre[1];
    var seg = afterSegment(l, endIdx);
    var c = seg.match(/[\*xX×]\s*(\d+)/);
    return c ? +c[1] : 1;
  }
  function capByRole(l, role) {
    var out = [];
    var re = /(\d+(?:\.\d+)?)\s*(tb|t|gb|g|mb|m)(\b|$)/gi, m;
    while ((m = re.exec(l))) {
      var u = String(m[2]).toLowerCase();
      var gb = Math.round(parseFloat(m[1]) * (UNIT_GB[u] || 1));
      if (!gb) continue;
      var endIdx = m.index + m[0].length;
      var cnt = countAfter(l, m.index, endIdx);
      var type = '';
      var after = afterSegment(l, endIdx);
      var before = l.slice(Math.max(0, m.index - 22), m.index);
      var ctx = after + ' ' + before;
      // 速率单位（SATA-6G / 6Gb/s）不是容量，跳过（B-2）
      if (isRateContext(l.slice(Math.max(0, m.index - 12), endIdx + 8))) continue;
      if (role === 'disk') {
        if (/nvme/i.test(ctx)) type = 'NVMe';
        else if (/ssd_sata|sata[_ ]?ssd/i.test(ctx)) type = 'SSD_SATA';
        else if (/sata/i.test(ctx)) type = /ssd/i.test(ctx) ? 'SSD_SATA' : 'SATA';
        else if (/ssd/i.test(ctx)) type = 'SSD';
        else if (/sas|10k|15k|7\.2k/i.test(ctx)) type = 'SAS';
        else if (/hdd|机械/i.test(ctx)) type = 'HDD';
      } else {
        var g = ctx.match(/DDR\s*(\d)/i);
        if (g) type = 'DDR' + g[1];
      }
      out.push({ sizeGB: gb, count: cnt, type: type, raw: trim(m[0]) });
    }
    return dedupeItems(out);
  }
  function capByContext(l, opt) {
    var out = [];
    var vmTriplet = (opt && opt.kind === 'vm') ? vmTripletRoles(l) : null;
    var re = /(\d+(?:\.\d+)?)\s*(tb|t|gb|g|mb|m)(\b|$)/gi, m;
    while ((m = re.exec(l))) {
      var u = String(m[2]).toLowerCase();
      var gb = Math.round(parseFloat(m[1]) * (UNIT_GB[u] || 1));
      if (!gb) continue;
      var start = m.index, end = m.index + m[0].length;
      // 速率单位（如 SATA-6G / 6Gb/s）不是容量，跳过（B-2）
      if (isRateContext(l.slice(Math.max(0, start - 12), end + 8))) continue;
      var role = null;
      if (vmTriplet) {
        // 虚拟机三段式：按「第一个容量→内存、第二个及以后→存储」分配（B-1）
        var ord = out.length;
        role = (ord === 0 && u !== 't' && u !== 'tb') ? 'mem' : 'disk';
      }
      if (!role) role = roleOfToken(l, start, end);
      if (role === 'cpu') continue;
      var frag = l.slice(Math.max(0, start - 30), end + 30);
      var hit = capByRole(frag, role).filter(function (it) { return Math.abs(it.sizeGB - gb) <= Math.max(1, gb * 0.5); });
      if (hit.length) out.push({ sizeGB: gb, count: hit[0].count, type: hit[0].type, role: role, raw: trim(m[0]) });
      else out.push({ sizeGB: gb, count: countAfter(l, start, end), type: '', role: role, raw: trim(m[0]) });
    }
    return dedupeItems(out, function (it) { return it.sizeGB + '/' + it.count + '/' + it.type + '/' + it.role; });
  }
  function dedupeItems(list, keyFn) {
    var seen = {}, out = [];
    list.forEach(function (it) {
      var k = keyFn ? keyFn(it) : (it.sizeGB + '/' + it.count + '/' + it.type);
      if (seen[k]) return;
      seen[k] = 1; out.push(it);
    });
    return out;
  }
  function diskDesc(disks) {
    return (disks || []).map(function (d) {
      return (d.count > 1 ? d.count + '×' : '') + gbText(d.sizeGB) + (d.type ? ' ' + d.type : '');
    }).join(' + ');
  }

  // ---------------- CPU 文本解析 ----------------
  function parseCpuText(text, out, opt) {
    var l = normalizeText(text);
    if (!l) return;
    // 虚拟机三段式「8C/32G/100G」「8核/32G/100G」→ 核数 8（B-1）。
    // 必须限定 kind==='vm'，否则物理机的「Hygon 7470 (48C/2.6GHz) *2」会被误判。
    if (opt && opt.kind === 'vm') {
      var mv = l.match(/(\d{1,3})\s*(?:c\b|核|cpu|vcpu)/i);
      if (mv) {
        out.cpuPerSocket = +mv[1];
        out.cpuCores = +mv[1];
        out.cpuSockets = 1;
        out.isVmCpuOnly = true;
        return;
      }
    }
    var reA = /([A-Za-z\u4e00-\u9fef][A-Za-z0-9\u4e00-\u9fef.\- ]{0,24}?)\s*\(?\s*(\d+)\s*[Cc][Oo]?[Rr]?[Ee]?[Ss]?\s*[\/|]?\s*([\d.]+)\s*GHz\s*\)?\s*\*\s*(\d+)/i;
    var m = l.match(reA);
    if (m) {
      out.cpuModel = cleanCpuModel(m[1]);
      out.cpuPerSocket = +m[2];
      out.cpuFreqGHz = parseFloat(m[3]);
      out.cpuSockets = +m[4];
      return;
    }
    var reB = /(\d+)\s*\*\s*([^\n,，]{2,30}?)\s*[,，]?\s*(\d+)\s*[Cc]ore\s*@\s*([\d.]+)\s*GHz/i;
    m = l.match(reB);
    if (m) {
      out.cpuModel = cleanCpuModel(m[2]);
      out.cpuPerSocket = +m[3];
      out.cpuFreqGHz = parseFloat(m[4]);
      out.cpuSockets = +m[1];
      return;
    }
    var reC = /([A-Za-z\u4e00-\u9fef][A-Za-z0-9\u4e00-\u9fef.\-]{1,28}?)\s*\*\s*(\d+)/;
    // 前缀式路数 + 逗号核数：2*Intel Xeon Gold 6248,32Core@2.5GHz（B-3）
    var reP = /(\d+)\s*[*x×]\s*([A-Za-z一-龥][A-Za-z0-9一-龥.\- ]{2,30}?)\s*[,，]?\s*(\d+)\s*[Cc]ore/i;
    m = l.match(reP);
    if (m) {
      out.cpuModel = cleanCpuModel(m[2]);
      out.cpuSockets = +m[1];
      out.cpuPerSocket = +m[3];
      return;
    }
    // 前缀式路数 + 括号核数：2*Intel Xeon Gold 6248 (32C) / 2*Hygon 5480（32Core）
    var reP2 = /(\d+)\s*[*x×]\s*([A-Za-z一-龥][A-Za-z0-9一-龥.\- ]{2,30}?)\s*[（(]\s*(\d+)\s*[Cc]ore/i;
    m = l.match(reP2);
    if (m) {
      out.cpuModel = cleanCpuModel(m[2]);
      out.cpuSockets = +m[1];
      out.cpuPerSocket = +m[3];
      return;
    }
    m = l.match(reC);
    if (m && /(hygon|海光|kunpeng|鲲鹏|飞腾|龙芯|兆芯|xeon|至强|intel|amd|处理器|cpu|\d{4})/i.test(m[1])) {
      out.cpuModel = cleanCpuModel(m[1]);
      out.cpuSockets = +m[2];
    }
  }

  // ---------------- 规格对象 ----------------
  function emptySpec() {
    return {
      cpuModel: '', cpuSockets: 0, cpuPerSocket: 0, cpuCores: 0, cpuFreqGHz: 0,
      memSticks: 0, memStickGB: 0, memCapacityGB: 0, memGen: '',
      disks: [], diskDesc: '', nics: [], nicDesc: '',
      raid: false, raidDesc: '', psuCount: 0,
      brand: '', arch: '', sourceText: '',
      vmCpu: 0, vmMemGB: 0, vmStoGB: 0,
    };
  }

  function specFromColumns(map, base) {
    var s = base || emptySpec();
    var src = [];
    if (map.cpuModel) {
      var cm = cleanCpuModel(cellText(map.cpuModel));
      if (cm) {
        var sm = cm.match(/\*\s*(\d+)\s*$/);
        if (sm) { s.cpuSockets = +sm[1]; cm = cleanCpuModel(cm.replace(/\*\s*\d+\s*$/, '')); }
        s.cpuModel = cm;
        src.push('CPU:' + cm);
      }
    }
    if (map.cpuCores != null && trim(cellText(map.cpuCores)) !== '') {
      var cores = parseInt(cellText(map.cpuCores).replace(/[^\d.]/g, ''), 10);
      if (cores > 0) s.cpuCores = cores;
    }
    if (map.cpuFreq != null && trim(cellText(map.cpuFreq)) !== '') {
      var f = parseFloat(cellText(map.cpuFreq).replace(/[^\d.]/g, ''));
      if (f > 0 && f < 10) s.cpuFreqGHz = Math.round(f * 100) / 100;
    }
    if (map.mem) {
      var it = capByRole(normalizeText(map.mem), 'mem');
      if (it.length) {
        var total = it.reduce(function (a, x) { return a + x.sizeGB * x.count; }, 0);
        if (total > 0) {
          s.memCapacityGB = total;
          if (it.length === 1) { s.memSticks = it[0].count; s.memStickGB = it[0].sizeGB; }
          s.memGen = it[0].type || '';
        }
        src.push('内存:' + it.map(function (x) { return x.count + '×' + x.sizeGB; }).join('+'));
      }
    }
    if (map.disk) {
      var dd = capByRole(normalizeText(map.disk), 'disk');
      if (dd.length) { s.disks = dd; s.diskDesc = diskDesc(dd); src.push('硬盘:' + s.diskDesc); }
    }
    if (map.diskType && s.disks.length) {
      var dt = normalizeText(map.diskType);
      var t = /nvme/i.test(dt) ? 'NVMe' : /ssd/i.test(dt) ? 'SSD' : /sas|15k|10k/i.test(dt) ? 'SAS' : dt.slice(0, 12);
      s.disks = s.disks.map(function (d) { return assign({}, d, { type: d.type || t }); });
      s.diskDesc = diskDesc(s.disks);
    }
    if (map.raid) {
      var rt = normalizeText(map.raid);
      if (rt && /raid|是|y|需要/i.test(rt)) { s.raid = true; s.raidDesc = rt.slice(0, 20); }
    }
    if (map.nic) {
      var nc = parseNics(cellText(map.nic));
      if (nc.length) { s.nics = nc; s.nicDesc = nicDesc(nc); src.push('网卡:' + s.nicDesc); }
    }
    if (src.length) s.sourceText = src.join(' | ');
    return s;
  }

  function parseSpecText(text, base, opt) {
    var s = base || emptySpec();
    var l = normalizeText(text);
    if (!l) return s;
    l.split('\n').map(trim).filter(Boolean).forEach(function (line) {
      var probe = {};
      parseCpuText(line, probe, opt);
      if (probe.isVmCpuOnly) {
        // 虚拟机：核数直接来自三段式首段，型号留空（B-1）
        if (!s.cpuCores) { s.cpuCores = probe.cpuCores; s.cpuPerSocket = probe.cpuCores; s.cpuSockets = 1; }
      } else if (probe.cpuModel && !s.cpuModel) {
        s.cpuModel = probe.cpuModel;
        if (probe.cpuSockets) s.cpuSockets = probe.cpuSockets;
        if (probe.cpuPerSocket) s.cpuPerSocket = probe.cpuPerSocket;
        if (probe.cpuFreqGHz) s.cpuFreqGHz = probe.cpuFreqGHz;
      }
      // 按上下文把同一行的容量项分拣到「内存 / 硬盘」，避免占错位置（B-1：虚拟机走三段式分流）
      var caps = capByContext(line, opt);
      if (!s.memCapacityGB) {
        var mems = caps.filter(function (x) { return x.role === 'mem'; });
        if (mems.length) {
          s.memCapacityGB = mems.reduce(function (a, x) { return a + x.sizeGB * x.count; }, 0);
          s.memSticks = mems[0].count; s.memStickGB = mems[0].sizeGB;
          if (mems[0].type) s.memGen = mems[0].type;
        }
      }
      if (!s.disks.length) {
        var disks = caps.filter(function (x) { return x.role === 'disk'; })
          .map(function (x) { return { sizeGB: x.sizeGB, count: x.count, type: x.type, raw: x.raw }; });
        if (disks.length) { s.disks = disks; s.diskDesc = diskDesc(disks); }
      }
      if (/网卡|网口|以太网|GE|SFP|光模块|万兆|千兆|百兆/i.test(line)) {
        var ni = parseNics(line);
        if (ni.length && !s.nics.length) { s.nics = ni; s.nicDesc = nicDesc(ni); }
      }
      if (!s.raid && /RAID|阵列卡|超级电容|级存/i.test(line)) {
        s.raid = true;
        var rm = line.match(/RAID\s*([0-9,\/.、]+)/i);
        s.raidDesc = rm ? ('RAID ' + rm[1].replace(/\s/g, '')) : '支持 RAID';
      }
      if (!s.psuCount && /电源|白金|铂金|钛金/i.test(line)) {
        var pm = line.match(/\*\s*(\d+)\s*$/);
        s.psuCount = pm ? +pm[1] : (/冗余|热插拔/i.test(line) ? 2 : 1);
      }
    });
    s.sourceText = s.sourceText ? (s.sourceText + ' | 文本:' + l.slice(0, 160)) : ('文本:' + l.slice(0, 160));
    return finalizeSpec(s);
  }
  function finalizeSpec(s) {
    if (!s.cpuCores && s.cpuPerSocket && s.cpuSockets) s.cpuCores = s.cpuPerSocket * s.cpuSockets;
    if (!s.cpuCores && s.cpuPerSocket) s.cpuCores = s.cpuPerSocket * (s.cpuSockets || 1);
    var b = cpuBrand(s.cpuModel || '');
    s.brand = b[1]; s.arch = b[2];
    s.disks = s.disks || []; s.nics = s.nics || [];
    s.diskDesc = s.diskDesc || diskDesc(s.disks);
    s.nicDesc = s.nicDesc || nicDesc(s.nics);
    return s;
  }
  function assign() {
    var t = arguments[0];
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      if (s) Object.keys(s).forEach(function (k) { t[k] = s[k]; });
    }
    return t;
  }

  // ---------------- 签名 ----------------
  function signatureOf(kind, purposeNorm, spec) {
    var disk = (spec.disks || []).map(function (d) { return d.count + '*' + d.sizeGB + (d.type ? ':' + d.type : ''); }).join(',');
    var nic = (spec.nics || []).map(function (n) { return n.count + '*' + n.speed; }).join(',');
    var vm = kind === 'vm' ? (spec.vmCpu + '/' + spec.vmMemGB + '/' + spec.vmStoGB) : '';
    return [kind, purposeNorm, compact(spec.cpuModel), spec.cpuCores, spec.cpuFreqGHz,
      spec.memCapacityGB, disk, nic, vm].join('|');
  }

  // ---------------- 表头 / 列映射 ----------------
  function headerCells(rows, start, height, colCount) {
    var heads = [];
    for (var c = 0; c < colCount; c++) {
      var parts = [];
      for (var r = start; r < Math.min(start + height, rows.length); r++) {
        var t = cellText((rows[r] || [])[c]);
        if (t && parts.indexOf(t) < 0) parts.push(t.replace(/\s+/g, ''));
      }
      heads.push({ parts: parts, key: parts.join(''), all: parts.join('|') });
    }
    return heads;
  }
  function fieldScore(head, kw) {
    var h = compact(head.key), all = compact(head.all), k = compact(kw);
    if (!k || (!h && !all)) return 0;
    if (h === k) return 100;
    if (all === k) return 92;
    if (h && h.indexOf(k) === 0) return 76;
    if (h && h.indexOf(k) >= 0) return 60;
    if (all && all.indexOf(k) >= 0) return 52;
    if (k.indexOf(h) === 0 && h.length >= 2) return 40;
    return 0;
  }
  function mapColumns(heads, rule) {
    var claim = {};
    heads.forEach(function (h, c) {
      if (!h.key) return;
      Object.keys(rule.columns).forEach(function (f) {
        var best = 0;
        (rule.columns[f] || []).forEach(function (kw) { best = Math.max(best, fieldScore(h, kw)); });
        if (best <= 0) return;
        if (!claim[f] || best > claim[f].score) claim[f] = { score: best, col: c };
      });
    });
    var used = {}, final = {}, hit = [];
    Object.keys(claim).sort(function (a, b) { return claim[b].score - claim[a].score; }).forEach(function (f) {
      var col = claim[f].col;
      if (used[col]) return;
      used[col] = f; final[f] = col; hit.push(f);
    });
    return { map: final, fields: hit, score: hit.length };
  }
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /** 表头行启发式：≥3 个非空单元格、均为短文本、无纯数字/换行/句号 —— 用于排除说明行与数据行 */
  function isHeaderRow(row, colCount) {
    var nonEmpty = 0, bad = 0;
    for (var c = 0; c < colCount; c++) {
      var t = trim(cellText((row || [])[c])).replace(/\s+/g, '');
      if (!t) continue;
      nonEmpty++;
      if (t.length > 24 || /^[0-9.,、；;]+$/.test(t) || /[。；;]/.test(t)) bad++;
    }
    return nonEmpty >= 3 && bad === 0;
  }
  function sheetExcluded(name, rule) {
    if (!rule.sheet || !rule.sheet.exclude) return false;
    return new RegExp(rule.sheet.exclude.split('|').map(escapeRe).join('|'), 'i').test(nz(name));
  }
  function sheetIncluded(name, rule) {
    if (!rule.sheet || !rule.sheet.include) return false;
    return new RegExp(rule.sheet.include.split('|').map(escapeRe).join('|'), 'i').test(nz(name));
  }
  function evaluateSheet(sheet, rule) {
    if (!sheet || !sheet.rows || !sheet.rows.length) return null;
    var rows = sheet.rows.slice(0, LIMITS.maxRows);
    var scan = Math.min(rule.header.scanRows || LIMITS.scanRows, rows.length);
    var maxH = Math.min(rule.header.maxHeaderRows || LIMITS.maxHeaderRows, scan);
    var colCount = Math.min(LIMITS.maxCols, Math.max.apply(null, rows.map(function (r) { return (r || []).length; })));
    var nameOk = sheetIncluded(sheet.name, rule);
    var best = null;
    for (var s = 0; s < scan; s++) {
      if (!isHeaderRow(rows[s], colCount)) continue;
      for (var h = 1; h <= maxH && s + h <= scan; h++) {
        var heads = headerCells(rows, s, h, colCount);
        var mp = mapColumns(heads, rule);
        if (!mp.score) continue;
        var reqOk = (rule.required || []).every(function (f) { return mp.fields.indexOf(f) >= 0; });
        if (mp.score < (rule.header.minScore || 3) || !reqOk) continue;
        var score = mp.score + (nameOk ? 2 : 0) - (h > 1 ? 0.2 : 0);
        if (!best || score > best.score) {
          best = { score: score, headerStart: s, headerHeight: h, heads: heads, map: mp.map, fields: mp.fields, colCount: colCount };
        }
      }
    }
    return best;
  }

  function pickPlan(sheets, rules, opts) {
    opts = opts || {};
    var cands = [];
    (sheets || []).slice(0, LIMITS.maxSheets).forEach(function (sh) {
      if (!sh || !Array.isArray(sh.rows)) return;
      (rules || []).forEach(function (rule) {
        if (rule.enabled === false) return;
        if (sheetExcluded(sh.name, rule)) return;
        var r;
        try { r = evaluateSheet(sh, rule); } catch (e) { r = null; }
        if (!r) return;
        cands.push({ rule: rule, sheet: sh, plan: r, weight: r.score + (rule.priority || 0) / 100 });
      });
    });
    if (!cands.length) return null;
    cands.sort(function (a, b) { return b.weight - a.weight; });
    if (opts.sheetName) {
      var forced = cands.filter(function (c) { return c.sheet.name === opts.sheetName; });
      if (forced.length) cands = forced.concat(cands.filter(function (c) { return c.sheet.name !== opts.sheetName; }));
    }
    if (opts.ruleId) {
      var byRule = cands.filter(function (c) { return c.rule.id === opts.ruleId; });
      if (byRule.length) cands = byRule.concat(cands.filter(function (c) { return c.rule.id !== opts.ruleId; }));
    }
    return cands[0];
  }

  // ---------------- 一个 Sheet 内的多张表 ----------------
  function detectTables(sheet, pick) {
    var rows = sheet.rows.slice(0, LIMITS.maxRows);
    var rule = pick.rule, first = pick.plan;
    var tables = [{ start: first.headerStart, headerHeight: first.headerHeight, heads: first.heads, map: first.map, fields: first.fields, colCount: first.colCount }];
    var endGuess = Math.min(rows.length, first.headerStart + first.headerHeight + LIMITS.maxRowsPerTable);
    for (var s = first.headerStart + first.headerHeight + 2; s < endGuess; s++) {
      var row = rows[s] || [];
      if (!row.some(function (v) { return trim(cellText(v)); })) continue;
      if (!isHeaderRow(row, first.colCount)) continue;
      var found = false;
      for (var h = 1; h <= (rule.header.maxHeaderRows || 2) && !found; h++) {
        var heads = headerCells(rows, s, h, first.colCount);
        var mp = mapColumns(heads, rule);
        var reqOk = (rule.required || []).every(function (f) { return mp.fields.indexOf(f) >= 0; });
        if (mp.score < Math.max(3, (rule.header.minScore || 3) - 1) || !reqOk) continue;
        var next = rows[s + h] || [];
        if (!next.some(function (v) { return trim(cellText(v)); })) continue;
        tables.push({ start: s, headerHeight: h, heads: heads, map: mp.map, fields: mp.fields, colCount: first.colCount });
        found = true;
        s += h;
      }
    }
    return { rows: rows, tables: tables };
  }

  // ---------------- 行提取 ----------------
  var SKIP_TITLE = /^(提示|注|说明|阅读指南|客户端配置要求|变更记录|目录|附|备注)[:：]?/;
  var ENDPOINT_KW = /笔记本|台式机|瘦终端|云桌面|终端机|PC机/i;

  function buildRows(ctx) {
    var out = [], skipped = [];
    ctx.tables.forEach(function (t, ti) {
      var start = t.start + t.headerHeight;
      var end = ti + 1 < ctx.tables.length
        ? ctx.tables[ti + 1].start
        : Math.min(ctx.rows.length, t.start + t.headerHeight + LIMITS.maxRowsPerTable);
      var prev = {};
      for (var r = start; r < end; r++) {
        var rawRow = ctx.rows[r] || [];
        var filled = 0;
        for (var c = 0; c < t.colCount; c++) if (trim(cellText(rawRow[c]))) filled++;
        if (!filled) { skipped.push({ sheet: ctx.sheetName, row: r + 1, reason: '空行' }); continue; }
        var cells = {};
        Object.keys(t.map).forEach(function (f) {
          var v = trim(cellText(rawRow[t.map[f]]));
          if (v) cells[f] = v;
          else if ((ctx.rule.repeatColumns || []).indexOf(f) >= 0 && prev[f]) cells[f] = prev[f];
          else cells[f] = '';
        });
        Object.keys(cells).forEach(function (f) { if (cells[f]) prev[f] = cells[f]; });

        var joined = Object.keys(cells).map(function (f) { return cells[f]; }).join('');
        if (SKIP_TITLE.test(joined) && filled <= 2) { skipped.push({ sheet: ctx.sheetName, row: r + 1, reason: '小节标题' }); continue; }
        try {
          var rowData = buildRow({ rule: ctx.rule, cells: cells, sheet: ctx.sheetName, rowIndex: r + 1, tableIndex: ti });
          if (!rowData) { skipped.push({ sheet: ctx.sheetName, row: r + 1, reason: '无有效数据' }); continue; }
          out.push(rowData);
        } catch (e) {
          skipped.push({ sheet: ctx.sheetName, row: r + 1, reason: '解析异常：' + (e && e.message) });
        }
      }
    });
    return { rows: out, skipped: skipped };
  }

  function buildRow(arg) {
    var rule = arg.rule, cells = arg.cells;
    var issues = [];
    var purpose = nz(cells.purpose);
    var hwType = nz(cells.hwType);
    var appsList = splitApps(cells.apps || '');
    var system = nz(cells.system);
    var entityCol = normalizeText(cells.entity || '');

    var kind = null;
    if (/虚拟机|云主机|虚拟桌面/i.test(entityCol)) kind = 'vm';
    else if (/实体机|物理机|裸金属/i.test(entityCol)) kind = 'phys';
    else if (ENDPOINT_KW.test(hwType + ' ' + purpose + ' ' + appsList.join(','))) kind = 'endpoint';
    if (!kind) {
      if (/虚拟|vm/i.test(cells.specText || '')) kind = 'vm';
      else kind = 'phys';
      issues.push({ field: 'kind', level: 'warn', code: 'KIND_GUESS', msg: '未标注实体机/虚拟机，按' + (kind === 'vm' ? '虚拟机' : '物理机') + '推定' });
    }

    var meaningful = !!(cells.qty || cells.specText || cells.cpuModel || cells.mem || cells.disk || cells.apps || purpose);
    if (!meaningful) return null;

    var qtyPack = parseQty(cells.qty, { dflt: (rule.vm && rule.vm.defaultQty) || 1 });
    if (qtyPack.issue === 'EMPTY') issues.push({ field: 'qty', level: 'warn', code: 'NO_QTY', msg: '未填写数量，按 ' + qtyPack.qty + ' 处理' });
    else if (qtyPack.issue === 'UNKNOWN_TOKEN') issues.push({ field: 'qty', level: 'warn', code: 'QTY_UNKNOWN', msg: '数量标记为「' + nz(cells.qty) + '」（按需），暂按 ' + qtyPack.qty + ' 处理' });
    else if (qtyPack.issue === 'NOT_NUMBER') issues.push({ field: 'qty', level: 'warn', code: 'QTY_BAD', msg: '数量「' + nz(cells.qty) + '」无法解析，按 ' + qtyPack.qty + ' 处理' });
    else if (qtyPack.issue === 'NOT_POSITIVE') issues.push({ field: 'qty', level: 'warn', code: 'QTY_BAD', msg: '数量非正数，按 ' + qtyPack.qty + ' 处理' });
    else if (qtyPack.issue === 'ROUND_UP') issues.push({ field: 'qty', level: 'warn', code: 'QTY_ROUND', msg: '数量为小数，向上取整为 ' + qtyPack.qty });

    var reqVal = parseTruthy(cells.required);
    var optional = reqVal === false;
    var altToken = (hwType.match(/[(]\s*(二选一|三选一|多选一|可选其一)\s*[)]/) || [])[1] || '';

    var purposeNorm = purpose ? purposeOf(purpose) : '';
    // 用途文本有值但归不到任何分组时，用「部署应用」再推一次（如「基础平台」+ ZooKeeper/Redis/Kafka → 中间件）
    if (purpose && purposeNorm === UNASSIGNED && appsList.length) {
      var byApps = purposeOfApps(appsList);
      if (byApps && byApps !== UNASSIGNED) {
        purposeNorm = byApps;
        issues.push({ field: 'purpose', level: 'warn', code: 'PURPOSE_BY_APPS', msg: '用途「' + purpose + '」未命中分组，按部署应用推导为「' + byApps + '」，请人工核对' });
      } else {
        issues.push({ field: 'purpose', level: 'warn', code: 'PURPOSE_UNKNOWN', msg: '用途「' + purpose + '」未命中任何分组，请人工补录或归入分组' });
      }
    }
    if (!purpose && appsList.length) {
      purpose = appsList.slice(0, 3).join('/');
      purposeNorm = purposeOfApps(appsList) || UNASSIGNED;
      issues.push({ field: 'purpose', level: 'warn', code: 'PURPOSE_DERIVED', msg: '「硬件用途」列缺失，暂以「部署应用」内容作为用途，请人工核对' });
    } else if (!purpose) {
      if (hwType || system) {
        purpose = hwType || system;
        purposeNorm = purposeOf(purpose);
        issues.push({ field: 'purpose', level: 'warn', code: 'PURPOSE_DERIVED', msg: '「硬件用途」为空，回退使用「' + purpose + '」' });
      } else {
        purpose = '未标注'; purposeNorm = '未分组';
        issues.push({ field: 'purpose', level: 'warn', code: 'NO_PURPOSE', msg: '未能识别用途，请人工补录' });
      }
    }

    var spec = finalizeSpec(parseSpecText(cells.specText, specFromColumns(cells, emptySpec()), { kind: kind }));
    if (kind === 'vm') {
      spec.vmCpu = spec.cpuCores || 0;
      spec.vmMemGB = spec.memCapacityGB || 0;
      spec.vmStoGB = (spec.disks || []).reduce(function (a, d) { return a + d.sizeGB * (d.count || 1); }, 0);
      if (!spec.vmStoGB) {
        spec.vmStoGB = (rule.vm && rule.vm.defaultStorageGB) || 100;
        issues.push({ field: 'sto', level: 'warn', code: 'VM_STO_DFLT', msg: '虚拟机未标明存储，按 ' + spec.vmStoGB + 'G 预估' });
      }
      if (!spec.vmCpu || !spec.vmMemGB) {
        issues.push({ field: 'spec', level: 'error', code: 'NO_SPEC', msg: '虚拟机未解析到 CPU 或内存规格' });
      }
    } else if (kind === 'phys') {
      if (!spec.cpuModel && !spec.cpuCores && !spec.memCapacityGB) issues.push({ field: 'spec', level: 'error', code: 'NO_SPEC', msg: '未解析到任何 CPU / 内存规格' });
      else if (!spec.cpuModel || !spec.memCapacityGB) {
        issues.push({ field: 'spec', level: 'warn', code: 'PARTIAL_SPEC', msg: (!spec.cpuModel ? '缺 CPU 型号；' : '') + (!spec.memCapacityGB ? '缺内存容量；' : '') + '请人工核对' });
      }
    }

    var status = 'ok';
    issues.forEach(function (i) { if (i.level === 'error') status = 'failed'; });
    if (status === 'ok' && issues.length) status = 'partial';

    return {
      id: 'r' + arg.rowIndex + '_' + arg.tableIndex,
      sheet: arg.sheet, rowIndex: arg.rowIndex, tableIndex: arg.tableIndex,
      system: system, hwType: hwType,
      purpose: purpose, purposeNorm: purposeNorm || purposeOf(purpose),
      apps: appsList, kind: kind, optional: optional, required: reqVal,
      exclusiveGroup: altToken, altOption: hwType,
      qty: qtyPack.qty, qtyUnknown: qtyPack.unknown, qtyRaw: nz(cells.qty),
      spec: spec, issues: issues, status: status,
      signature: signatureOf(kind, purposeNorm, spec),
      raw: cells,
    };
  }

  // ---------------- 互斥候选（二选一）处理 ----------------
  function resolveAlternatives(rows) {
    var warnings = [], groups = {};
    (rows || []).forEach(function (r) {
      if (!r.exclusiveGroup) return;
      var key = r.purpose + '::' + r.exclusiveGroup;
      (groups[key] = groups[key] || []).push(r);
    });
    Object.keys(groups).forEach(function (k) {
      var list = groups[k];
      var chosen = list.filter(function (r) { return r.required !== false; });
      if (!chosen.length) chosen = [list[0]];
      var pickIdx = list.indexOf(chosen[0]);
      list.forEach(function (r, i) { r.altGroup = k; r.defaultPick = (i === pickIdx); });
      var opts = list.map(function (r) { return trim(r.altOption || r.purpose); })
        .filter(function (v, i, a) { return v && a.indexOf(v) === i; }).join(' / ');
      if (chosen.length > 1) {
        warnings.push({
          code: 'ALT_CONFLICT',
          msg: '用途「' + list[0].purpose + '」存在互斥候选（' + list[0].exclusiveGroup + '：' + opts + '），其中 ' + chosen.length + ' 行均标记为「必选」，默认只取「' + trim(chosen[0].altOption || chosen[0].purpose) + '」共 ' + chosen[0].qty + ' 台，请在明细中人工确认',
          rows: chosen.map(function (r) { return r.id; }),
        });
      } else {
        warnings.push({
          code: 'ALT_GROUP',
          msg: '用途「' + list[0].purpose + '」为' + list[0].exclusiveGroup + '候选（' + opts + '），默认选取：' + specTitle(chosen[0]),
          rows: list.map(function (r) { return r.id; }),
        });
      }
    });
    (rows || []).forEach(function (r) { if (r.defaultPick === undefined) r.defaultPick = true; });
    return warnings;
  }

  function specTitle(r) {
    if (!r) return '';
    if (r.kind === 'vm') return (r.spec.vmCpu || '?') + 'C/' + (r.spec.vmMemGB || '?') + 'G/' + (r.spec.vmStoGB || '?') + 'G（虚拟机）';
    var bits = [];
    if (r.spec.cpuModel) bits.push(r.spec.cpuModel);
    if (r.spec.cpuCores) bits.push(r.spec.cpuCores + '核');
    if (r.spec.memCapacityGB) bits.push(r.spec.memCapacityGB + 'G');
    if (r.spec.diskDesc) bits.push(r.spec.diskDesc);
    return bits.join(' / ') || '未识别规格';
  }

  // ---------------- 规格模板（Combo） ----------------
  function stamp() { return new Date().toISOString().slice(0, 16).replace('T', ' '); }
  function comboName(r) {
    if (r.kind === 'vm') return '虚拟机 ' + r.spec.vmCpu + 'C/' + r.spec.vmMemGB + 'G/' + r.spec.vmStoGB + 'G';
    var bits = [];
    if (r.spec.cpuModel) bits.push(r.spec.cpuModel);
    if (r.spec.cpuCores) bits.push(r.spec.cpuCores + '核');
    if (r.spec.cpuFreqGHz) bits.push('@' + r.spec.cpuFreqGHz + 'GHz');
    if (r.spec.memCapacityGB) bits.push(r.spec.memCapacityGB + 'G');
    if (r.spec.nicDesc) bits.push(r.spec.nicDesc);
    return (bits.join(' ') || specTitle(r)).slice(0, 60);
  }
  function buildCombos(rows, prevCombos) {
    var map = {};
    (prevCombos || []).forEach(function (c) { map[c.key] = clone(c); });
    (rows || []).forEach(function (r) {
      if (r.kind === 'endpoint' || r.status === 'failed' || r.defaultPick === false) return;
      var key = r.kind + '|' + r.purposeNorm + '|' + r.signature;
      var at = stamp();
      if (map[key]) { map[key].useCount = (map[key].useCount || 0) + (r.qty || 1); map[key].updatedAt = at; return; }
      map[key] = {
        id: 'cb_' + hashKey(key).slice(0, 8), key: key, kind: r.kind, name: comboName(r),
        purpose: r.purpose, purposeNorm: r.purposeNorm, spec: clone(r.spec),
        machineId: null, useCount: r.qty || 1, sources: [], createdAt: at, updatedAt: at,
      };
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return (b.useCount || 0) - (a.useCount || 0); });
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ---------------- 默认已选配置 ----------------
  function modelKeyOf(spec) {
    return compact(spec && spec.cpuModel) + '|' + ((spec && spec.cpuCores) || 0) + '|' + ((spec && spec.memCapacityGB) || 0);
  }
  function specPopulated(spec) {
    return !!(spec && (spec.cpuModel || spec.cpuCores || spec.memCapacityGB || spec.vmCpu || spec.vmMemGB));
  }
  /** 已选配置去重键：与「是否已入库为机型」无关，保证入库/重导入都不会产生重复 */
  function selKeyOf(kind, purpose, machineId, spec) {
    var modelPart = specPopulated(spec)
      ? modelKeyOf(spec)
      : (machineId ? ('m' + machineId) : '');
    return [kind, compact(purpose) || '未标注', modelPart,
      ((spec && spec.vmCpu) || 0) + '/' + ((spec && spec.vmMemGB) || 0) + '/' + ((spec && spec.vmStoGB) || 0)].join('|');
  }
  /** 核数口径兼容：单价库一般存「单颗核数」，解析结果存「整机物理核总数」 */
  function coresCompatible(m, spec) {
    var mc = m.cpu_cores || 0, sc = spec.cpuCores || 0;
    if (!mc || !sc) return true;
    if (mc === sc) return true;
    if (spec.cpuPerSocket && mc === spec.cpuPerSocket) return true;
    var socks = spec.cpuSockets || 0;
    if (socks && mc * socks === sc) return true;
    if (mc * 2 === sc) return true;
    return false;
  }
  function matchMachine(spec, machines) {
    if (!machines || !machines.length || !spec || !spec.cpuModel) return null;
    var want = compact(spec.cpuModel);
    var wantNum = (want.match(/\d{3,5}/) || [])[0] || '';
    for (var i = 0; i < machines.length; i++) {
      var m = machines[i];
      var have = compact([m.brand, m.model, m.cpu_model].join(' '));
      if (have === want) return m;
      if (wantNum && have.indexOf(wantNum) >= 0 && coresCompatible(m, spec)) return m;
    }
    return null;
  }
  function buildSelections(rows, opt) {
    opt = opt || {};
    var machines = opt.machines || [];
    var includeOptional = !!opt.includeOptional;
    var includeFailed = !!opt.includeFailed;
    var out = [];
    (rows || []).forEach(function (r) {
      if (r.kind === 'endpoint') return;
      if (r.status === 'failed' && !includeFailed) return;
      if ((r.optional || r.defaultPick === false) && !includeOptional) return;
      var machine = r.kind === 'phys' ? matchMachine(r.spec, machines) : null;
      out.push({
        id: 'sel_' + hashKey(r.id + '|' + r.signature).slice(0, 10),
        kind: r.kind,
        purpose: r.purpose,
        apps: (r.apps || []).slice(0, 6),
        qty: r.qty || 1,
        machineId: machine ? machine.id : null,
        modelText: specTitle(r),
        cpu: r.kind === 'vm' ? r.spec.vmCpu : 0,
        memGB: r.kind === 'vm' ? r.spec.vmMemGB : 0,
        stoGB: r.kind === 'vm' ? r.spec.vmStoGB : 0,
        spec: clone(r.spec),
        source: { fileKey: opt.fileKey || '', file: opt.fileName || '', rowIndexes: [r.rowIndex] },
        selKey: selKeyOf(r.kind, r.purpose, machine ? machine.id : null, r.spec),
        manual: false, include: true, note: '',
      });
    });
    return out;
  }
  /** 重复导入：同 selKey 更新而非追加 */
  function mergeSelections(prev, next, opt) {
    opt = opt || {};
    var policy = opt.conflictPolicy || 'keep-manual';
    var res = { added: 0, updated: 0, removed: 0, conflict: 0, items: [] };
    var oldByKey = {};
    (prev || []).forEach(function (s) { (oldByKey[s.selKey] = oldByKey[s.selKey] || []).push(s); });
    var used = {};
    // B-4：stale 只在同一来源文件内判定，避免上传第 2 个文件时删掉第 1 个文件的数据
    var scopeFileKey = opt.scopeFileKey || (next[0] && next[0].source && next[0].source.fileKey) || null;
    var prevOfScope = {};
    (prev || []).forEach(function (s) {
      var fk = s.source && s.source.fileKey;
      (prevOfScope[fk || ''] = prevOfScope[fk || ''] || []).push(s);
    });
    (next || []).forEach(function (s) {
      var old = (oldByKey[s.selKey] || []).filter(function (o) { return !used[o.id]; })[0];
      if (!old) { s.manual = false; res.items.push(s); res.added++; return; }
      used[old.id] = 1;
      var keep = clone(old);
      keep.source = {
        fileKey: s.source.fileKey, file: s.source.file,
        rowIndexes: (keep.source.rowIndexes || []).concat(s.source.rowIndexes || [])
          .filter(function (v, i, a) { return a.indexOf(v) === i; }),
      };
      // B-5：机型/规格变更也要纳入冲突判定（原先只比数量，机型变更被静默丢弃）
      var specChanged = signatureOf(keep.kind, purposeNormOf(keep), keep.spec) !== signatureOf(s.kind, purposeNormOf(s), s.spec);
      if (policy === 'overwrite' || !keep.manual) {
        keep.qty = s.qty; keep.spec = s.spec; keep.modelText = s.modelText;
        keep.machineId = s.machineId || keep.machineId;
        keep.cpu = s.cpu; keep.memGB = s.memGB; keep.stoGB = s.stoGB;
        keep.manual = false;   // 系统已覆盖，解除人工保护，避免策略粘滞
      } else if (keep.manual && (keep.qty !== s.qty || specChanged)) {
        res.conflict++;
        var msgs = [];
        if (keep.qty !== s.qty) msgs.push('重导入数量为 ' + s.qty + '，已保留人工值 ' + keep.qty);
        if (specChanged) msgs.push('重导入机型/规格为「' + (s.modelText || '?') + '」，已保留人工值「' + (keep.modelText || '?') + '」');
        keep.note = (keep.note ? keep.note + '；' : '') + msgs.join('；');
      }
      res.items.push(keep); res.updated++;
    });
    // B-4：仅当提供了 scopeFileKey 时才做同文件内的 stale 清理；否则一律保留其他文件的行
    var scope = scopeFileKey != null ? (prevOfScope[scopeFileKey || ''] || []) : [];
    var dropped = {};
    scope.forEach(function (s) {
      if (used[s.id]) return;
      dropped[s.id] = 1;
      if (opt.stalePolicy === 'keep') { res.items.push(clone(s)); return; }
      res.removed++;
    });
    // 补回不属于本次 scope、且未被显式清理的其他文件数据
    var keptIds = {};
    res.items.forEach(function (s) { keptIds[s.id] = 1; });
    (prev || []).forEach(function (s) {
      if (keptIds[s.id] || used[s.id] || dropped[s.id]) return;
      res.items.push(clone(s));
    });
    return res;
  }
  function purposeNormOf(sel) {
    return (sel && sel.spec && sel.spec.purposeNorm) || purposeOf(sel && sel.purpose);
  }

  // ---------------- 顶层入口 ----------------
  function fileKeyOf(name, sheets) {
    var digest = (sheets || []).map(function (sh) { return sh.name + ':' + (sh.rows || []).length; }).join(';');
    var sample = [];
    (sheets || []).slice(0, 3).forEach(function (sh) {
      (sh.rows || []).slice(0, 6).forEach(function (r) {
        sample.push((r || []).map(function (c) { return String(c == null ? '' : c); }).join('').slice(0, 60));
      });
    });
    return hashKey(nz(name) + '|' + digest + '|' + sample.join('~').slice(0, 400));
  }
  function emptyResult(msg, code, sheets) {
    var list = (sheets || []).filter(function (s) { return s && s.rows; });
    return {
      ok: false, error: code, errorMsg: msg,
      sheetNames: list.map(function (s) { return s.name; }),
      preview: list.slice(0, 4).map(function (s) { return { name: s.name, rows: (s.rows || []).slice(0, 10) }; }),
      rows: [], skippedRows: [], combos: [], selections: [],
      stats: { total: 0, ok: 0, partial: 0, failed: 0, endpoint: 0, skipped: 0 }, warnings: [],
    };
  }

  function parseWorkbook(wb, opt) {
    opt = opt || {};
    var rules = opt.rules || defaultRules();
    var warnings = [];
    wb = wb || {};
    var sheets = ((wb.sheets) || []).filter(function (s) { return s && Array.isArray(s.rows); }).slice(0, LIMITS.maxSheets);
    if (!sheets.length) return emptyResult('工作簿为空或没有可用工作表', 'EMPTY_WORKBOOK', sheets);

    var pick = pickPlan(sheets, rules, { sheetName: opt.sheetName, ruleId: opt.ruleId });
    if (!pick) return emptyResult('未能自动定位到服务器配置表，请手动选择工作表与表头行', 'NO_MATCHED_TABLE', sheets);
    if (pick.rule.id === 'generic') warnings.push({ code: 'FALLBACK_RULE', msg: '未命中专用供应商模板，已按「通用兜底」规则解析，结果需重点人工核对' });

    var tables = detectTables(pick.sheet, pick);
    if (opt.headerStart != null) {
      var rows_ = pick.sheet.rows;
      var colCount_ = opt.colCount || Math.min(LIMITS.maxCols, Math.max.apply(null, rows_.map(function (r) { return (r || []).length; })));
      var hStart = Math.max(0, parseInt(opt.headerStart, 10) - 1);
      var hHeight = opt.headerHeight || 1;
      var heads = headerCells(rows_, hStart, hHeight, colCount_);
      var mp = mapColumns(heads, pick.rule);
      // 仅替换首张表，后续自动识别到的逻辑表（如 Sheet 内第二张表）仍然保留
      var others = tables.tables.filter(function (t) { return t.start > hStart + hHeight; });
      tables.tables = [{
        start: hStart, headerHeight: hHeight, heads: heads,
        map: applyColumnMap(mp.map, opt.columnMap, heads.length),
        fields: mp.fields, colCount: heads.length,
      }].concat(others).sort(function (a, b) { return a.start - b.start; });
      pick.plan.headerStart = hStart;
      pick.plan.headerHeight = hHeight;
    } else if (opt.columnMap && Object.keys(opt.columnMap).length) {
      // C-7：手动列映射必须无条件生效。原实现只在上方「用户显式指定表头行」分支里
      // 消费 opt.columnMap，导致界面上改了列映射、重新解析却毫无变化（死代码）。
      tables.tables = tables.tables.map(function (t) {
        return Object.assign({}, t, { map: applyColumnMap(t.map, opt.columnMap, t.colCount) });
      });
      pick.plan.map = applyColumnMap(pick.plan.map, opt.columnMap, pick.plan.colCount);
    }

    var built = buildRows({ rows: tables.rows, tables: tables.tables, rule: pick.rule, sheetName: pick.sheet.name });
    resolveAlternatives(built.rows).forEach(function (w) { warnings.push(w); });
    built.skipped.slice(0, 5).forEach(function (s) {
      warnings.push({ code: 'ROW_SKIPPED', msg: '第 ' + s.row + ' 行已跳过（' + s.reason + '）' });
    });

    var fileKey = opt.fileKey || fileKeyOf(wb.name, sheets);
    var stats = { ok: 0, partial: 0, failed: 0, endpoint: 0, total: built.rows.length, skipped: built.skipped.length };
    built.rows.forEach(function (r) {
      stats[r.status === 'ok' ? 'ok' : r.status === 'partial' ? 'partial' : 'failed']++;
      if (r.kind === 'endpoint') stats.endpoint++;
    });

    var combos = buildCombos(built.rows, opt.prevCombos);
    combos.forEach(function (c) {
      var m = matchMachine(c.spec, opt.machines || []);
      if (m) c.machineId = m.id;
      c.sources = c.sources || [];
      if (c.sources.indexOf(fileKey) < 0) c.sources.push(fileKey);
    });
    var selections = buildSelections(built.rows, {
      machines: opt.machines, includeOptional: opt.includeOptional,
      includeFailed: opt.includeFailed, fileKey: fileKey, fileName: nz(wb.name),
    });

    return {
      ok: true,
      file: { name: nz(wb.name), key: fileKey },
      rule: { id: pick.rule.id, name: pick.rule.name, vendor: pick.rule.vendor },
      sheet: { name: pick.sheet.name, headerStart: pick.plan.headerStart + 1, headerHeight: pick.plan.headerHeight,
        fields: pick.plan.fields, headers: headersOf(pick), colCount: (pick.plan.colCount || 0) },
      columnMap: pick.plan.map, tableCount: tables.tables.length,
      rows: built.rows, skippedRows: built.skipped,
      combos: combos, selections: selections, stats: stats, warnings: warnings,
    };
  }

  var API = {
    VERSION: VERSION, LIMITS: LIMITS, PURPOSE_RULES: PURPOSE_RULES,
    defaultRules: defaultRules, parseWorkbook: parseWorkbook,
    pickPlan: pickPlan, evaluateSheet: evaluateSheet, detectTables: detectTables,
    mapColumns: mapColumns, headerCells: headerCells,
    buildRows: buildRows, buildRow: buildRow, resolveAlternatives: resolveAlternatives,
    buildCombos: buildCombos, buildSelections: buildSelections, mergeSelections: mergeSelections,
    matchMachine: matchMachine, selKeyOf: selKeyOf, modelKeyOf: modelKeyOf, signatureOf: signatureOf,
    parseSpecText: parseSpecText, specFromColumns: specFromColumns, finalizeSpec: finalizeSpec,
    parseQty: parseQty, parseTruthy: parseTruthy, parseGB: parseGB, gbText: gbText,
    parseCapItems: parseCapItems, parseNics: parseNics, nicDesc: nicDesc, diskDesc: diskDesc, capByRole: capByRole,
    parseCpuText: parseCpuText, cpuBrand: cpuBrand, cleanCpuModel: cleanCpuModel,
    purposeOf: purposeOf, purposeOfApps: purposeOfApps, purposeGroups: purposeGroups,
    UNASSIGNED: UNASSIGNED, splitApps: splitApps,
    specTitle: specTitle, comboName: comboName,
    normalizeText: normalizeText, cellText: cellText, hashKey: hashKey, fileKeyOf: fileKeyOf,
  };
  return API;
});
