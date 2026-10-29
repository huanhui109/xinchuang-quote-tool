/* 信创服务器配置报价工具 - 前端（原生 JS，无第三方依赖，浏览器本地运行） */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (cents) => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const yuanToCents = (y) => Math.round(parseFloat(String(y || '0').replace(/,/g, '')) * 100);
const archClass = (a) => a && a.includes('ARM') ? 'arm' : (a && a.includes('x86') ? 'x86' : 'muted');
const OS_OPTIONS = [
  { label: '麒麟 V10 (x86)', arch: '海光(C86/x86)' }, { label: '统信 UOS (x86)', arch: '海光(C86/x86)' },
  { label: '中科方德 (x86)', arch: '海光(C86/x86)' }, { label: '麒麟 V10 (ARM64)', arch: '鲲鹏(ARM)' },
  { label: '统信 UOS (ARM64)', arch: '鲲鹏(ARM)' },
];
const HV_OPTIONS = [
  { label: '云宏 CNware (x86)', arch: '海光(C86/x86)' }, { label: '华为 FusionCompute (x86)', arch: '海光(C86/x86)' },
  { label: 'OpenStack (x86)', arch: '海光(C86/x86)' }, { label: '华为 FusionCompute (ARM)', arch: '鲲鹏(ARM)' },
  { label: 'OpenStack (ARM)', arch: '鲲鹏(ARM)' },
];

// ---- 架构图（draw.io）默认配置（与后端 DEFAULT_ARCH_OPTIONS 保持一致） ----
const ARCH_OPTIONS_DEFAULT = () => ({
  layout: 'layered-purpose', groupBy: 'purpose', aggregate: true,
  inferDependency: true, breakCycle: true, stackReplicas: true, legend: true,
  maxNodes: 300, maxEdges: 800,
});
const DRAWIO_FALLBACK_URL = 'https://embed.diagrams.net/';
// 功能开关（false = 隐藏菜单入口并禁用路由；代码保留，便于后续重新启用）
const FEATURES = {
  archDiagram: false,
};
// 硬件配置清单解析：默认选项（与后端 DEFAULT_HCL_OPTIONS 保持一致）
const HCL_OPTIONS_DEFAULT = () => ({
  autoPickSheet: true, includeOptional: false, includeFailed: false,
  materializeMachines: false, conflictPolicy: 'keep-manual', stalePolicy: 'remove',
});

// ============ 浏览器本地数据层（localStorage），无需后端 ============
const LS_KEY = 'xcq_store_v1';
let STORE = null;
// 注意：CFG 必须在 loadStore() 调用（文件下方第 ~201 行）之前声明，
// 否则 loadStore/lsSave 访问 CFG 会触发暂时性死区（TDZ）导致拓扑数据无法持久化。
let CFG = { phys: [], vm: [], archFilter: '全部', view: 'list', pos: {}, links: [], selNode: null, connecting: false };

// ---- C-4 方案模板库：性能版 / 标准版 / 最小版 ----
// 模板只决定「每类节点配多少台、每台多少资源」，机型与部件仍从单价库选，
// 因此不会引入新的定价口径，也不需要后端改动。
const SCHEME_TEMPLATES = {
  perf: {
    name: '性能版',
    hint: '高可用 + 资源冗余：物理机 2 台起，虚拟机按 2 倍资源配置，适合核心业务/数据库',
    groups: [
      { group: '数据服务', physQty: 2, vmCpu: 16, vmMem: 64, vmSto: 500, vmQty: 2 },
      { group: '应用服务', physQty: 2, vmCpu: 8, vmMem: 32, vmSto: 200, vmQty: 4 },
      { group: '中间件', physQty: 0, vmCpu: 8, vmMem: 32, vmSto: 200, vmQty: 3 },
      { group: '接入层', physQty: 0, vmCpu: 4, vmMem: 16, vmSto: 100, vmQty: 3 },
      { group: '基础设施', physQty: 2, vmCpu: 4, vmMem: 16, vmSto: 200, vmQty: 2 },
    ],
  },
  standard: {
    name: '标准版',
    hint: '均衡配置：数据库双机、应用三节点，适合一般业务系统',
    groups: [
      { group: '数据服务', physQty: 2, vmCpu: 8, vmMem: 32, vmSto: 500, vmQty: 1 },
      { group: '应用服务', physQty: 2, vmCpu: 4, vmMem: 16, vmSto: 200, vmQty: 3 },
      { group: '中间件', physQty: 0, vmCpu: 4, vmMem: 16, vmSto: 200, vmQty: 2 },
      { group: '接入层', physQty: 0, vmCpu: 4, vmMem: 8, vmSto: 100, vmQty: 2 },
      { group: '基础设施', physQty: 2, vmCpu: 2, vmMem: 8, vmSto: 200, vmQty: 1 },
    ],
  },
  minimal: {
    name: '最小版',
    hint: '成本优先：数据库与应用合并部署，仅保证基本可用，适合试点/测试环境',
    groups: [
      { group: '数据服务', physQty: 1, vmCpu: 4, vmMem: 16, vmSto: 200, vmQty: 1 },
      { group: '应用服务', physQty: 1, vmCpu: 2, vmMem: 8, vmSto: 100, vmQty: 2 },
      { group: '中间件', physQty: 0, vmCpu: 2, vmMem: 8, vmSto: 100, vmQty: 1 },
      { group: '接入层', physQty: 0, vmCpu: 2, vmMem: 4, vmSto: 100, vmQty: 1 },
      { group: '基础设施', physQty: 1, vmCpu: 2, vmMem: 8, vmSto: 200, vmQty: 1 },
    ],
  },
};
/** 为某用途分组挑选最合适的机型：优先整机价最低、架构与模板分组无关 */
function pickMachineFor(group) {
  const cand = (S.machines || []).filter(m => !isPendingPrice(m));
  if (!cand.length) return null;
  return cand.slice().sort((a, b) => (a.unit_price_cents || 0) - (b.unit_price_cents || 0))[0];
}
window.applyScheme = async (key) => {
  const tpl = SCHEME_TEMPLATES[key]; if (!tpl) return;
  const hasCfg = CFG.phys.length || CFG.vm.length;
  if (hasCfg && !await UI.confirm(`应用「${tpl.name}」模板将清空当前 ${CFG.phys.length + CFG.vm.length} 行配置，是否继续？`,
    { title: '应用方案模板', okText: '清空并应用', danger: true })) return;
  await loadLib();
  // ⚠ 资产侧隔离（M1.0-e）：此处只允许改**规划态** CFG。
  // 下面这行会清空 CFG.phys / CFG.vm / CFG.pos / CFG.links —— 配置行 id 随之失效，
  // 因此设备的**持久锚点只能是 source_line_uid（指向报价单条目）**，
  // 不能用配置行 id 当锚点。运行态的 devices / links / rack_units 一律不得触碰。
  CFG.phys = []; CFG.vm = []; CFG.pos = {}; CFG.links = [];
  const noMachine = [];
  tpl.groups.forEach(g => {
    if (g.physQty > 0) {
      const m = pickMachineFor(g.group);
      if (!m) { noMachine.push(g.group); }
      else {
        for (let i = 0; i < g.physQty; i++) {
          CFG.phys.push({
            id: newLineId('p'), machineId: m.id, qty: 1, parts: [],
            purpose: g.group, role: i === 0 ? '主' : '备', group: g.group, deploy: g.group,
            os: (S.os.find(o => o.arch === m.arch) || {}).label || '',
            hv: (S.hv.find(h => h.arch === m.arch) || {}).label || '',
          });
        }
      }
    }
    for (let i = 0; i < g.vmQty; i++) {
      CFG.vm.push({
        id: newLineId('v'), cpu: g.vmCpu, mem: g.vmMem, sto: g.vmSto, qty: 1,
        purpose: g.group, role: g.vmQty > 1 ? (i === 0 ? '主' : '备') : '单机',
        group: g.group, deploy: g.group, flavor: `${g.vmCpu}C/${g.vmMem}G/${g.vmSto}G`,
      });
    }
  });
  await persistCfg();
  renderConfigurator();
  toast(noMachine.length
    ? `已应用「${tpl.name}」；${noMachine.join('、')} 未找到已询价机型，请手动补充`
    : `已应用「${tpl.name}」模板，共 ${CFG.phys.length} 台物理机 + ${CFG.vm.length} 台虚拟机`);
};
window.schemePreview = (key) => {
  const tpl = SCHEME_TEMPLATES[key]; if (!tpl) return '';
  const physN = tpl.groups.reduce((s, g) => s + g.physQty, 0);
  const vmN = tpl.groups.reduce((s, g) => s + g.vmQty, 0);
  return tpl.groups.map(g => {
    const items = [];
    if (g.physQty) items.push(`物理机×${g.physQty}`);
    if (g.vmQty) items.push(`虚机 ${g.vmCpu}C/${g.vmMem}G/${g.vmSto}G ×${g.vmQty}`);
    return `<tr><td>${esc(g.group)}</td><td>${items.join(' ＋ ') || '—'}</td></tr>`;
  }).join('') + `<tr class="tot"><td>合计</td><td>${physN} 台物理机 ＋ ${vmN} 台虚拟机</td></tr>`;
};
window.schemeTotal = (key) => {
  const tpl = SCHEME_TEMPLATES[key]; if (!tpl) return { phys: 0, vm: 0, physCents: 0, vmCents: 0 };
  const m = pickMachineFor('');
  const physCents = m ? (m.unit_price_cents || 0) * tpl.groups.reduce((s, g) => s + g.physQty, 0) : 0;
  const p = vmPrice('cpu').price_cents, me = vmPrice('mem').price_cents, st = vmPrice('storage').price_cents;
  const vmCents = tpl.groups.reduce((s, g) => s + (g.vmCpu * p + g.vmMem * me + g.vmSto * st) * g.vmQty, 0);
  return { phys: tpl.groups.reduce((s, g) => s + g.physQty, 0), vm: tpl.groups.reduce((s, g) => s + g.vmQty, 0), physCents, vmCents };
};
function nextId() { STORE._seq = (STORE._seq || 0) + 1; return STORE._seq; }
function active() { return STORE.versions.find(v => v.is_active) || STORE.versions[0]; }
function lsSave() { try { STORE.cfg = CFG; } catch (e) {} localStorage.setItem(LS_KEY, JSON.stringify(STORE)); }
async function persistCfg() {
  // 优先写后端（拓扑：布局/连线/部署组件）；后端不可用时仅写 localStorage
  try { await api('PUT', '/api/cfg', CFG); } catch (e) {}
  lsSave();
}
function seedStore() {
  // 先建立 STORE 骨架（含空数组），再逐条 push，避免 mk()->nextId() 在 STORE 赋值前读取 STORE._seq
  STORE = {
    _seq: 100,
    settings: { tax_rate: '0.13', currency: 'CNY' },
    versions: [], machines: [], parts: [], vm_prices: [], vm_flavors: [], quotes: [], apps: [],
    // 资产侧（融合 MVP）：设备台账 / 机房·机柜 / U 位行级占用账本 / 设备变更 / 连线 / 交付批次 / 采价反馈
    assets: { devices: [], rooms: [], racks: [], rack_units: [], asset_changes: [], links: [], deliveries: [], reconciliations: [], price_feedback: [] },
    // 架构图（draw.io）持久化：model=组件清单快照 / graph=自动布局结果 / xml=手工编辑后的图
    arch: { options: Object.assign({}, ARCH_OPTIONS_DEFAULT()), model: null, graph: null, xml: null, source: 'topo', updated_at: null },
    // 硬件配置清单解析：自定义规则 / 沉淀模板 / 默认已选配置 / 导入记录
    hwlib: { rules: null, combos: [], selections: [], imports: [], purposes: [], options: Object.assign({}, HCL_OPTIONS_DEFAULT()), updated_at: null },
  };
  STORE.versions.push({ id: 1, name: '基线 v1（示例）', note: '由需求文档样例初始化：海光 5480/7470，虚拟机资源综合单价', created_at: now(), is_active: 1 });
  STORE.machines.push(
    mk('machines', { brand: '海光', model: 'Hygon 5480', arch: '海光(C86/x86)', cpu_model: 'Hygon 5480', cpu_sockets: 2, cpu_cores: 32, cpu_freq: 2.5, mem_capacity: 256, mem_gen: 'DDR4', disk_bays: '8', disk_desc: '2×960G SSD + 4×1.92T NVMe', nic: '4×25GbE', power: '2×800W', rail: '2U导轨', unit_price_cents: 8600000, supplier: '厂商询价(示例)', basis: '示例价，待替换' }),
    mk('machines', { brand: '海光', model: 'Hygon 7470', arch: '海光(C86/x86)', cpu_model: 'Hygon 7470', cpu_sockets: 2, cpu_cores: 48, cpu_freq: 2.6, mem_capacity: 512, mem_gen: 'DDR4', disk_bays: '8', disk_desc: '4×1.92T NVMe + 4×3.84T NVMe', nic: '4×25GbE', power: '2×1200W', rail: '2U导轨', unit_price_cents: 15800000, supplier: '厂商询价(示例)', basis: '示例价，待替换' }),
    mk('machines', { brand: '鲲鹏', model: 'Kunpeng 920', arch: '鲲鹏(ARM)', cpu_model: 'Kunpeng 920', cpu_sockets: 2, cpu_cores: 64, cpu_freq: 2.6, mem_capacity: 512, mem_gen: 'DDR4', disk_bays: '8', disk_desc: '4×1.92T NVMe', nic: '4×25GbE', power: '2×900W', rail: '2U导轨', unit_price_cents: 14200000, supplier: '厂商询价(示例)', basis: '示例价，待替换' }),
  );
  STORE.parts.push(
    mk('parts', { category: '内存', spec: '32G DDR4 RDIMM', price_cents: 120000, compat_arch: '海光(C86/x86)', compat_machine: '' }),
    mk('parts', { category: '内存', spec: '64G DDR4 RDIMM', price_cents: 230000, compat_arch: '海光(C86/x86)', compat_machine: '' }),
    mk('parts', { category: '内存', spec: '32G DDR4 RDIMM', price_cents: 125000, compat_arch: '鲲鹏(ARM)', compat_machine: '' }),
    mk('parts', { category: '硬盘', spec: '1.92T NVMe SSD', price_cents: 90000, compat_arch: '', compat_machine: '' }),
    mk('parts', { category: '硬盘', spec: '3.84T NVMe SSD', price_cents: 160000, compat_arch: '', compat_machine: '' }),
    mk('parts', { category: '网卡', spec: '25GbE 双口网卡', price_cents: 45000, compat_arch: '', compat_machine: '' }),
    mk('parts', { category: 'RAID', spec: 'Broadcom 9560 8i', price_cents: 60000, compat_arch: '', compat_machine: '' }),
  );
  STORE.vm_prices.push(
    mk('vm_prices', { res_type: 'cpu', unit: '核', price_cents: 70000, basis: '0.07万元/核（综合单价）' }),
    mk('vm_prices', { res_type: 'mem', unit: 'GB', price_cents: 80000, basis: '0.08万元/G（综合单价）' }),
    mk('vm_prices', { res_type: 'storage', unit: 'GB', price_cents: 2000, basis: '0.2万元/100G（综合单价）' }),
  );
  // 虚拟机规格组合（常见 CPU/内存搭配，基于资源综合单价联动）
  STORE.vm_flavors.push(
    mk('vm_flavors', { name: '通用型 4C8G', vcpu: 4, mem_gb: 8, storage_gb: 100, note: '轻量应用 / 代理', is_common: 1 }),
    mk('vm_flavors', { name: '通用型 4C16G', vcpu: 4, mem_gb: 16, storage_gb: 100, note: '中间件 / 缓存', is_common: 1 }),
    mk('vm_flavors', { name: '通用型 8C16G', vcpu: 8, mem_gb: 16, storage_gb: 200, note: '应用服务', is_common: 1 }),
    mk('vm_flavors', { name: '通用型 8C32G', vcpu: 8, mem_gb: 32, storage_gb: 200, note: '数据库 / 重负载', is_common: 1 }),
  );
  lsSave();
}
function mk(tbl, d) { const o = Object.assign({ id: nextId(), version_id: 1 }, d); return o; }
function now() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function loadStore() {
  try { const s = localStorage.getItem(LS_KEY); if (s) STORE = JSON.parse(s); } catch (e) {}
  if (!STORE) seedStore();
  if (STORE && STORE.cfg && STORE.cfg.phys) {
    CFG = Object.assign(CFG, STORE.cfg);
    CFG.connecting = false; CFG.selNode = null;
  }
}

// ---- 真实后端 API：优先 fetch 后端；后端不可用时（预览/离线）回退本地实现 ----
// D-4：错误分级 —— 只有「后端不可达」才降级到 localStorage；
// 后端可达但返回 4xx/5xx 时必须把真实错误抛出去，否则保存失败会被静默吞掉。
const api = async (method, path, body) => {
  let res;
  try {
    // X-Role：角色自声明（M5）。服务端据此裁剪字段与返回 403。
    const opts = { method, headers: { 'Content-Type': 'application/json', 'X-Role': currentRole() } };
    if (method === 'POST' || method === 'PUT') opts.body = JSON.stringify(body ?? {});
    res = await fetch(path, opts);
  } catch (e) {
    // 网络层失败：后端未启动 / 预览面板 / 纯静态托管 / 断网 → 本地回退
    markOffline(true);
    return await localApi(method, path, body);
  }
  markOffline(false);
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    let detail = '';
    try {
      const j = await res.json();
      if (j && (j.error || j.message)) { detail = String(j.error || j.message); msg = detail; }
    } catch (_) { /* 非 JSON 响应，保留 HTTP 状态码 */ }
    // 5xx 视为服务端故障，不降级（降级会让用户误以为写入成功）
    const err = new Error(msg);
    err.status = res.status;
    err.path = path;
    err.method = method;
    err.serverSide = res.status >= 500;
    throw err;
  }
  return await res.json();
};

// ---- 离线状态横幅：明确告知当前处于本地回退模式，修改不会同步到 server.py ----
let _offlineEl = null;
function markOffline(off) {
  const show = !!off;
  if (show === (!!_offlineEl && _offlineEl.dataset.on === '1')) return;
  if (show) {
    const el = document.createElement('div');
    el.className = 'offline-banner';
    el.dataset.on = '1';
    el.innerHTML = '⚠ <b>离线模式</b>：未能连接 server.py，当前所有修改仅保存在浏览器 localStorage，'
      + '不会写入 data/store.json，也与其他页面/设备不通。启动服务请执行 <code>python server.py</code>。'
      + '<button class="btn sm" onclick="location.reload()">重试连接</button>';
    if (document.body && document.body.appendChild) document.body.appendChild(el);
    _offlineEl = el;
  } else if (_offlineEl) {
    if (_offlineEl.remove) _offlineEl.remove();
    _offlineEl = null;
  }
}

// ---- 本地 API 路由（与后端保持同样的 path 契约，作为回退） ----
const localApi = async (method, path, body) => {
  await Promise.resolve();
  const [p, qs] = path.split('?');
  const seg = p.split('/').filter(Boolean).slice(1); // 去掉 'api'
  const head = seg[0];
  const idOf = (i) => parseInt(seg[i], 10);
  const table = (t) => { STORE[t] = STORE[t] || []; return STORE[t]; };
  const ver = (t) => { const v = active(); return table(t).filter(r => r.version_id === v.id); };

  if (method === 'GET' && head === 'info') return { name: '信创服务器配置报价工具', version: '0.2' };
  // ---- 角色自述（M5）----
  if (method === 'GET' && head === 'whoami') {
    return { role: currentRole(), role_source: ROLE_SOURCE };
  }
  if (method === 'GET' && head === 'catalog') {
    // 机型目录（脱敏）：与后端同口径 —— 只给规格，不给任何价格字段
    const v = active();
    return table('machines').filter(m => m.version_id === v.id).map(m => ({
      id: m.id, brand: m.brand, model: m.model, arch: m.arch, rail: m.rail,
      chassis_u: m.chassis_u ?? 0, cpu_model: m.cpu_model, cpu_cores: m.cpu_cores,
      mem_capacity: m.mem_capacity, disk_desc: m.disk_desc, nic: m.nic,
    }));
  }
  if (head === 'settings') {
    if (method === 'GET') {
      const st = Object.assign({}, STORE.settings);
      // 非 sales 剥离 tax_rate：用字段裁剪而非 403，否则 loadLib() 会因 reject 整页白屏
      if (!roleCan('read_pricing')) delete st.tax_rate;
      return st;
    }
    if (method === 'POST') {
      if (!roleCan('write_quotes')) denyRole('当前角色无权修改系统设置');
      Object.assign(STORE.settings, body); lsSave(); return { ok: true };
    }
  }
  if (head === 'os_options') return OS_OPTIONS;
  if (head === 'hypervisor_options') return HV_OPTIONS;
  if (head === 'versions') {
    if (method === 'GET') return STORE.versions.map(r => ({ ...r }));
    if (method === 'POST') {
      // 发布权仅 sales（采价权 ≠ 发布权）
      if (!roleCan('publish_pricing')) denyRole('仅售前角色可新建定价版本');
      const v = active(); const nid = nextId();
      // 克隆当前生效版本的机型/部件/虚拟机
      const newM = table('machines').filter(r => r.version_id === v.id).map(r => ({ ...r, id: nextId(), version_id: nid }));
      const newP = table('parts').filter(r => r.version_id === v.id).map(r => ({ ...r, id: nextId(), version_id: nid }));
      const newV = table('vm_prices').filter(r => r.version_id === v.id).map(r => ({ ...r, id: nextId(), version_id: nid }));
      const newF = table('vm_flavors').filter(r => r.version_id === v.id).map(r => ({ ...r, id: nextId(), version_id: nid }));
      STORE.machines.push(...newM); STORE.parts.push(...newP); STORE.vm_prices.push(...newV); STORE.vm_flavors.push(...newF);
      STORE.versions.forEach(x => x.is_active = 0);
      const nv = { id: nid, name: body.name || '新版本', note: body.note || '', created_at: now(), is_active: 1 };
      STORE.versions.push(nv); lsSave(); return { ok: true, id: nid };
    }
  }
  // 路径 /api/versions/<id>/activate → seg = ['versions', '<id>', 'activate']
  if (method === 'PUT' && seg[2] === 'activate') {
    if (!roleCan('publish_pricing')) denyRole('仅售前角色可启用定价版本');
    const id = idOf(1); STORE.versions.forEach(x => x.is_active = (x.id === id ? 1 : 0)); lsSave(); return { ok: true };
  }
  for (const t of ['machines', 'parts', 'vm_prices', 'vm_flavors']) {
    if (head === t) {
      // 单价库对非 sales 角色不可见（菜单级 + 数据级双重隔离）
      if (!roleCan('read_pricing')) denyRole('当前角色无权访问单价库');
      if (method === 'GET') return ver(t).map(r => ({ ...r }));
      if (method === 'POST') { const d = Object.assign({ id: nextId(), version_id: active().id }, body); table(t).push(d); lsSave(); return { ok: true, id: d.id }; }
      if (method === 'PUT') { const id = idOf(1); const r = table(t).find(x => x.id === id); if (r) Object.assign(r, body, { id }); lsSave(); return { ok: true }; }
      if (method === 'DELETE') { const id = idOf(1); STORE[t] = STORE[t].filter(x => x.id !== id); lsSave(); return { ok: true }; }
    }
  }
  if (head === 'quotes') {
    // 报价单含价格字段，三档处理（与后端同口径）：
    //   sales          → 全量（含条目明细与金额）
    //   viewer（管理层）→ 仅汇总投影（不含 items 与明细金额）
    //   delivery / ops → 403
    if (!roleCan('read_quotes')) denyRole('当前角色无权访问报价单');
    // viewer 汇总投影：只保留含税总价与条目数，不含任何明细价格字段
    const quoteSummary = (q) => ({
      id: q.id, name: q.name, created_at: q.created_at,
      version_id: q.version_id, version_name: q.version_name,
      total_cents: q.total_cents, item_count: (q.items || []).length,
    });
    if (method === 'GET' && !seg[1]) {
      if (currentRole() === 'viewer') return STORE.quotes.map(quoteSummary);
      return STORE.quotes.map(q => ({ id: q.id, name: q.name, created_at: q.created_at, version_id: q.version_id, version_name: q.version_name, tax_rate: q.tax_rate, subtotal_cents: q.subtotal_cents, tax_cents: q.tax_cents, total_cents: q.total_cents, item_count: (q.items || []).length }));
    }
    if (method === 'POST') {
      if (!roleCan('write_quotes')) denyRole('当前角色无权创建报价单');
      const d = Object.assign({ id: nextId(), created_at: now() }, body);
      // M1.0-b 锚点：与后端同口径 —— 分配 id 后派生 line_uid = q_<quoteId>_<item_no>
      const items = d.items || [];
      items.forEach((it, idx) => {
        if (!it || typeof it !== 'object') return;
        if (!Number.isInteger(it.item_no) || it.item_no <= 0) { it.item_no = idx + 1; it.legacy = 1; }
        if (it.legacy === undefined) it.legacy = 0;
        it.line_uid = `q_${d.id}_${it.item_no}`;
      });
      d.items = items;
      STORE.quotes.push(d); lsSave(); return { ok: true, id: d.id };
    }
    if (method === 'GET' && seg[1]) {
      const q = STORE.quotes.find(x => x.id === idOf(1));
      if (!q) return {};
      if (!roleCan('read_quotes_detail')) return quoteSummary(q);
      return { ...q, items: q.items || [] };
    }
    if (method === 'DELETE' && seg[1]) {
      if (!roleCan('write_quotes')) denyRole('当前角色无权删除报价单');
      STORE.quotes = STORE.quotes.filter(x => x.id !== idOf(1)); lsSave(); return { ok: true };
    }
  }
  if (head === 'cfg') {
    if (!roleCan('read_pricing')) denyRole('当前角色无权访问配置台');
    if (method === 'GET') return STORE.cfg;
    if (method === 'PUT') { STORE.cfg = body || {}; lsSave(); return { ok: true }; }
  }
  if (head === 'apps') {
    if (method === 'GET') return STORE.apps.map(r => ({ ...r }));
    if (method === 'POST') { const d = Object.assign({ id: nextId() }, body); table('apps').push(d); lsSave(); return { ok: true, id: d.id }; }
    // 路径 /api/apps/<id> → seg = ['apps', '<id>']，id 在 seg[1]
    if (method === 'PUT') { const id = idOf(1); const r = table('apps').find(x => x.id === id); if (r) Object.assign(r, body, { id }); lsSave(); return { ok: true }; }
    if (method === 'DELETE') { STORE.apps = STORE.apps.filter(x => x.id !== idOf(1)); lsSave(); return { ok: true }; }
  }
  // ---- 硬件配置清单解析（无后端时的 localStorage 回退；xlsx 解析在浏览器本地完成） ----
  if (head === 'hcl') {
    STORE.hwlib = STORE.hwlib || { rules: null, combos: [], selections: [], imports: [], options: Object.assign({}, HCL_OPTIONS_DEFAULT()) };
    const hw = STORE.hwlib;
    hw.options = Object.assign(HCL_OPTIONS_DEFAULT(), hw.options || {});
    if (seg[1] === 'config') {
      if (method === 'GET') {
        return { maxUploadBytes: 8 * 1024 * 1024, maxRows: 5000, maxCols: 60, maxSheets: 8, maxStateBytes: 4 * 1024 * 1024,
          rules: hw.rules || [], options: hw.options };
      }
    }
    if (seg[1] === 'rules') {
      if (method === 'GET') return hw.rules || [];
      if (method === 'PUT') { hw.rules = (body || {}).rules; lsSave(); return { ok: true }; }
    }
    if (seg[1] === 'state') {
      if (method === 'GET') {
        return { rules: hw.rules, combos: hw.combos || [], selections: hw.selections || [], imports: hw.imports || [],
          purposes: hw.purposes || [], removedKeys: hw.removed_keys || {},
          options: hw.options, updated_at: hw.updated_at || null };
      }
      if (method === 'PUT') {
        const b = body || {};
        ['combos', 'selections', 'imports', 'purposes'].forEach(k => { if (Array.isArray(b[k])) hw[k] = b[k]; });
        if (b.removedKeys && typeof b.removedKeys === 'object') hw.removed_keys = b.removedKeys;
        if (b.rules !== undefined) hw.rules = b.rules;
        if (b.options) Object.assign(hw.options, b.options);
        hw.updated_at = now(); lsSave();
        return { ok: true, updated_at: hw.updated_at };
      }
      if (method === 'DELETE') {
        hw.combos = []; hw.selections = []; hw.imports = []; hw.purposes = []; hw.rules = null; hw.removed_keys = {};
        hw.options = Object.assign({}, HCL_OPTIONS_DEFAULT());
        hw.updated_at = now(); lsSave();
        return { ok: true };
      }
    }
  }
  if (head === 'arch') {
    STORE.arch = STORE.arch || { options: Object.assign({}, ARCH_OPTIONS_DEFAULT()), model: null, graph: null, xml: null, source: 'topo', updated_at: null };
    STORE.arch.options = Object.assign(ARCH_OPTIONS_DEFAULT(), STORE.arch.options || {});
    if (seg[1] === 'config') return { embedUrl: DRAWIO_FALLBACK_URL, loadTimeoutMs: 12000, options: STORE.arch.options };
    if (seg[1] === 'diagram') {
      if (method === 'GET') return Object.assign({}, STORE.arch, { has_xml: !!STORE.arch.xml });
      if (method === 'PUT') {
        const b = body || {};
        ['xml', 'model', 'graph', 'source'].forEach(k => { if (k in b) STORE.arch[k] = b[k]; });
        if (b.options && typeof b.options === 'object') Object.assign(STORE.arch.options, b.options);
        STORE.arch.updated_at = now(); lsSave();
        return { ok: true, updated_at: STORE.arch.updated_at };
      }
      if (method === 'DELETE') {
        STORE.arch = { options: Object.assign({}, ARCH_OPTIONS_DEFAULT()), model: null, graph: null, xml: null, source: 'topo', updated_at: now() };
        lsSave(); return { ok: true };
      }
    }
    throw new Error('arch path not found');
  }
  if (head === 'library' && seg[1] === 'export') return null; // 由 downloadLibrary 处理
  if (head === 'library' && seg[1] === 'import' && method === 'POST') {
    if (!roleCan('read_pricing')) denyRole('当前角色无权导入单价库');
    (body.machines || []).forEach(m => STORE.machines.push(Object.assign({ id: nextId(), version_id: active().id }, m)));
    (body.parts || []).forEach(p => STORE.parts.push(Object.assign({ id: nextId(), version_id: active().id }, p)));
    (body.vm_prices || []).forEach(v => STORE.vm_prices.push(Object.assign({ id: nextId(), version_id: active().id }, v)));
    (body.vm_flavors || []).forEach(f => STORE.vm_flavors.push(Object.assign({ id: nextId(), version_id: active().id }, f)));
    if (body.settings) Object.assign(STORE.settings, body.settings);
    lsSave(); return { ok: true };
  }
  // ============================================================
  // 资产侧（融合 MVP）—— 与后端保持同样的 path 契约
  // 离线也必须做角色裁剪：否则离线泄露比在线泄露更隐蔽（用户看不到横幅提示）
  // ============================================================
  const assets = () => { STORE.assets = STORE.assets || { devices: [], rooms: [], racks: [], rack_units: [], asset_changes: [], links: [], deliveries: [], reconciliations: [], price_feedback: [] }; return STORE.assets; };
  const aTable = (t) => { const a = assets(); a[t] = Array.isArray(a[t]) ? a[t] : []; return a[t]; };
  if (head === 'devices') {
    if (method === 'GET') {
      if (!roleCan('read_assets')) denyRole('当前角色无权访问设备台账');
      // GET /api/devices/<id> → 单条；GET /api/devices[?筛选] → 列表
      if (seg[1] && !isNaN(parseInt(seg[1], 10))) {
        const one = aTable('devices').find(x => x.id === parseInt(seg[1], 10));
        return one ? { ...one } : {};
      }
      let rows = aTable('devices');
      const qp = (qs || '').split('&').map(x => x.split('='));
      const qv = (k) => { const hit = qp.find(p => p[0] === k); return hit ? decodeURIComponent(hit[1] || '') : ''; };
      // scope=runtime 只看运行态（planned 不得出现在巡检报表里）
      const scope = qv('scope');
      if (scope === 'runtime') rows = rows.filter(d => d.state === 'installed' || d.state === 'running');
      else if (scope === 'plan') rows = rows.filter(d => d.state === 'planned' || d.state === 'ordered');
      const st = qv('state'); if (st) rows = rows.filter(d => d.state === st);
      const rk = qv('rack_id'); if (rk) rows = rows.filter(d => String(d.rack_id) === rk);
      const og = qv('origin'); if (og) rows = rows.filter(d => d.origin === og);
      return rows.map(d => ({ ...d }));
    }
    if (!roleCan('write_assets')) denyRole('当前角色无权修改设备台账');
    if (method === 'POST') {
      const d = Object.assign({ id: nextId(), created_from: currentRole(), updated_at: now() }, body);
      d.state = d.state || 'planned';
      aTable('devices').push(d); lsSave();
      return { ok: true, id: d.id };
    }
    if (method === 'PUT' && seg[1]) {
      const d = aTable('devices').find(x => x.id === idOf(1));
      if (d) { Object.assign(d, body, { id: d.id, updated_at: now() }); lsSave(); }
      return { ok: true };
    }
    if (method === 'DELETE' && seg[1]) {
      assets().devices = aTable('devices').filter(x => x.id !== idOf(1)); lsSave();
      return { ok: true };
    }
  }
  if (head === 'rooms' || head === 'racks') {
    const t = head === 'rooms' ? 'rooms' : 'racks';
    if (method === 'GET') {
      if (seg[1] && !isNaN(parseInt(seg[1], 10))) {
        const one = aTable(t).find(x => x.id === parseInt(seg[1], 10));
        return one ? { ...one } : {};
      }
      return aTable(t).map(r => ({ ...r }));
    }
    if (!roleCan('write_assets')) denyRole('当前角色无权修改机房机柜');
    if (method === 'POST') { const d = Object.assign({ id: nextId() }, body); aTable(t).push(d); lsSave(); return { ok: true, id: d.id }; }
    if (method === 'PUT' && seg[1]) { const r = aTable(t).find(x => x.id === idOf(1)); if (r) Object.assign(r, body, { id: r.id }); lsSave(); return { ok: true }; }
    if (method === 'DELETE' && seg[1]) { assets()[t] = aTable(t).filter(x => x.id !== idOf(1)); lsSave(); return { ok: true }; }
  }
  if (head === 'rack_units') {
    if (method === 'GET') {
      let rows = aTable('rack_units');
      if (seg[1] && !isNaN(parseInt(seg[1], 10))) rows = rows.filter(r => r.rack_id === parseInt(seg[1], 10));
      return rows.map(r => ({ ...r }));
    }
    if (!roleCan('write_assets')) denyRole('当前角色无权修改机柜占用');
    if (method === 'POST') { const d = Object.assign({ id: nextId() }, body); aTable('rack_units').push(d); lsSave(); return { ok: true, rows: [d] }; }
    if (method === 'DELETE') { assets().rack_units = aTable('rack_units').filter(x => !(x.rack_id === body?.rack_id && x.u_index === body?.u_index)); lsSave(); return { ok: true }; }
  }
  if (head === 'rackview' && method === 'GET') {
    // GET /api/rackview?rack_id=<id> —— 離線也用本地賬本算，與服務端同構
    const qp = (qs || '').split('&').map(x => x.split('='));
    const hit = qp.find(p => p[0] === 'rack_id');
    const rid = parseInt(hit ? hit[1] : '0', 10) || 0;
    const rack = aTable('racks').find(r => r.id === rid);
    if (!rack) {
      return { rack: null, slots: [], conflicts: { overlap: [], over_height: [], power_over: [] },
        power: { used_w: 0, capacity_w: 0 }, occupancy: { used_slots: 0, total_slots: 0 } };
    }
    return localRackView(rack, aTable('rack_units'), aTable('devices'));
  }
  if (head === 'space' && seg[1] === 'validate' && method === 'POST') {
    // 離線無服務端空間模型 → 降級為紙面校驗（與服務端「空間完整率不足」同語義：
    // 不給出基於空間的通過結論，避免離線時給出假綠燈）
    const lines = (body && body.lines) || [];
    let qty = 0;
    lines.forEach(l => { qty += Number(l && l.qty || 0); });
    return {
      mode: 'paper', pass: null, space_data_completeness: 0,
      conflicts: { overlap: [], over_height: [], power_over: [] },
      conflict_device_count: 0, onboarded_device_count: qty,
      u_conflict_rate: 0, infeasible_ratio: 0,
      notes: ['離線模式：本地空間數據不足，降級為紙面校驗，不給出基於空間的通過結論'],
    };
  }
  if (head === 'deliveries') {
    if (method === 'GET' && seg.length === 1) return aTable('deliveries').map(d => ({ ...d }));
    if (method === 'GET' && seg[1]) { const d = aTable('deliveries').find(x => x.id === idOf(1)); return d ? { ...d } : {}; }
    if (!roleCan('manage_deliveries')) denyRole('当前角色无权生成交付批次');
    if (method === 'POST') { const d = Object.assign({ id: nextId(), generated_at: now() }, body); aTable('deliveries').push(d); lsSave(); return { ok: true, id: d.id }; }
  }
  if (head === 'asset_changes' && method === 'GET') return aTable('asset_changes').map(r => ({ ...r }));
  if (head === 'reconciliations' && method === 'GET') return aTable('reconciliations').map(r => ({ ...r }));
  if (head === 'links' && method === 'GET') return aTable('links').map(r => ({ ...r }));
  if (head === 'price_feedback') {
    if (method === 'GET') {
      if (!roleCan('read_price_feedback')) denyRole('当前角色无权访问采价反馈');
      // sales 全量；其它角色仅见本人提交的（访问自己的 price_feedback 不算泄露）
      const rows = aTable('price_feedback');
      return (currentRole() === 'sales' ? rows : rows.filter(r => r.created_by === currentRole())).map(r => ({ ...r }));
    }
    if (!roleCan('submit_price_feedback')) denyRole('当前角色无权提交采价反馈');
    if (method === 'POST') {
      const d = Object.assign({ id: nextId(), created_by: currentRole(), decided_by: null, at: now(), status: 'submitted' }, body);
      aTable('price_feedback').push(d); lsSave();
      return { ok: true, id: d.id, status: 'submitted' };
    }
  }
  if (head === 'events') {
    if (method === 'GET' && seg[1] === 'health') {
      const pend = readPendingEvents();
      return { dropped: 0, written: pend.length, last_event_ts: pend.length ? pend[pend.length - 1].ts : null, offline: true };
    }
    if (method === 'POST') {
      // 离线不写文件：事件排队到 localStorage，在线后由 flushPendingEvents 上送
      const list = Array.isArray(body?.events) ? body.events : (body ? [body] : []);
      const pend = readPendingEvents();
      list.forEach(e => pend.push(Object.assign({ ts: now(), role: currentRole(), role_source: ROLE_SOURCE, offline: true }, e)));
      writePendingEvents(pend);
      return { ok: true, written: list.length, dropped: 0 };
    }
  }
  if (head === 'assets' && seg[1] === 'export' && method === 'GET') {
    return localAssetsExport();
  }
  return { ok: true };
};

/* ---- 离线埋点队列（离线不写文件，在线后 flush）---- */
const EVENTS_PENDING_KEY = 'xcq_events_pending';
function readPendingEvents() {
  try { const s = localStorage.getItem(EVENTS_PENDING_KEY); return s ? JSON.parse(s) : []; } catch (e) { return []; }
}
function writePendingEvents(list) {
  try { localStorage.setItem(EVENTS_PENDING_KEY, JSON.stringify(list)); } catch (e) { /* 隐私模式忽略 */ }
}
async function flushPendingEvents() {
  const pend = readPendingEvents();
  if (!pend.length) return;
  try {
    await api('POST', '/api/events', { events: pend });
    writePendingEvents([]);
  } catch (e) { /* 仍离线则保留队列 */ }
}

/* ---- 脱敏导出（本地版，列头与服务端完全一致）---- */
function localAssetsExport() {
  const a = STORE.assets || { devices: [], rooms: [], racks: [] };
  const roomName = {}, rackName = {};
  (a.rooms || []).forEach(r => { roomName[r.id] = r.name || ''; });
  (a.racks || []).forEach(r => { rackName[r.id] = r.code || r.name || ''; });
  const rows = (a.devices || []).map(d => [
    d.code || '', d.sku_id || '', d.sn || '',
    roomName[d.room_id] || '', rackName[d.rack_id] || '',
    d.u_start || '', d.state || '',
  ]);
  // 列头服务端写死，不提供「显示价格」开关
  return { filename: '资产台账.csv', columns: ['资产编号', '型号', 'SN', '机房', '机柜', 'U位', '状态'], rows };
}

// ---- 浏览器端下载 / xlsx / csv ----
function download(filename, blob) {
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
/** XML 1.0 不允许的控制字符（0x00-0x08 / 0x0B / 0x0C / 0x0E-0x1F）。
 *  只要单元格文本里混入一个（如硬件清单解析出的规格串），Excel 打开时
 *  直接判定「文件已损坏」且无法修复，必须在写 XML 前剔除。
 *  \t \n \r 是合法空白，予以保留。*/
function xclean(s) { return String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); }
function xesc(s) {
  return xclean(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function colLetter(n) { let s = ''; n++; while (n) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); } return s; }
/** 工作表名清洗：剔除 Excel 禁止的 : \ / ? * [ ]，按码点截断 31 字符，保证非空且不重名。
 *  顺序必须是「先清洗截断、后 XML 转义」——反过来会把 &amp; 截成 &am，产出非法 XML。*/
function sheetNameSafe(name, used) {
  const raw = xclean(name == null ? '' : String(name)).replace(/[:\\/?*[\]]/g, '').trim();
  const base = Array.from(raw).slice(0, 31).join('') || 'Sheet';
  let n = base, i = 2;
  while (used.has(n.toLowerCase())) {
    const sfx = '(' + i++ + ')';
    n = Array.from(base).slice(0, Math.max(1, 31 - sfx.length)).join('') + sfx;
  }
  used.add(n.toLowerCase());
  return n;
}
function sheetXml(rows) {
  let out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
  rows.forEach((row, ri) => {
    out += `<row r="${ri + 1}">`;
    (row || []).forEach((val, ci) => {
      const ref = colLetter(ci) + (ri + 1);
      if (val === '' || val == null) return;
      // NaN / Infinity 不是合法 XML 数值，退化为文本，否则 Excel 报「文件已损坏」
      if (typeof val === 'number' && Number.isFinite(val)) out += `<c r="${ref}"><v>${val}</v></c>`;
      else if (typeof val === 'boolean') out += `<c r="${ref}" t="b"><v>${val ? 1 : 0}</v></c>`;
      else out += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xesc(val)}</t></is></c>`;
    });
    out += '</row>';
  });
  return out + '</sheetData></worksheet>';
}
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; }
function concatU8(arrs) { let n = 0; arrs.forEach(a => n += a.length); const out = new Uint8Array(n); let o = 0; arrs.forEach(a => { out.set(a, o); o += a.length; }); return out; }
function u16(n) { return new Uint8Array([n & 255, (n >> 8) & 255]); }
function u32(n) { return new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]); }
function buildXlsx(sheets) {
  const enc = new TextEncoder();
  const files = [];
  const names = new Set();
  sheets.forEach(s => { s._safe = sheetNameSafe(s.name, names); });
  const ct = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    ...sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
    '</Types>'];
  files.push({ name: '[Content_Types].xml', data: enc.encode(ct.join('')) });
  files.push({ name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') });
  const wb = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>',
    ...sheets.map((s, i) => `<sheet name="${xesc(s._safe)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`), '</sheets></workbook>'];
  files.push({ name: 'xl/workbook.xml', data: enc.encode(wb.join('')) });
  const rels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`), '</Relationships>'];
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: enc.encode(rels.join('')) });
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(s.rows)) }));
  // 打包为 ZIP（store，无压缩）
  // DOS 时间戳固定为 2020-01-01 00:00:00 —— 导出结果可复现，且避免全 0 时间戳被严格解析器判非法
  const DOS_TIME = 0, DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
  const parts = []; let offset = 0; const central = [];
  for (const f of files) {
    const nameB = enc.encode(f.name); const crc = crc32(f.data);
    // 本地文件头：固定 30 字节 + 文件名 + 数据
    const local = concatU8([u32(0x04034b50), u16(20), u16(0), u16(0), u16(DOS_TIME), u16(DOS_DATE), u32(crc), u32(f.data.length), u32(f.data.length), u16(nameB.length), u16(0), nameB, f.data]);
    parts.push(local); const lo = offset; offset += local.length;
    // 中央目录：固定 46 字节 + 文件名
    // 字段顺序必须严格对齐规范：external attrs(4) 之后紧跟 local header offset(4)，
    // 多写或少写任何一个字段都会让解析器从此处起全部错位（表现为「文件已损坏」）
    central.push(concatU8([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(f.data.length), u32(f.data.length), u16(nameB.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(lo), nameB]));
  }
  const cdStart = offset; let cdSize = 0; central.forEach(c => { parts.push(c); cdSize += c.length; });
  parts.push(concatU8([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(cdStart), u16(0)]));
  return new Blob(parts, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
/** C-8：CSV 公式注入防护。
 *  以 = + - @ 或控制字符开头的单元格，在 Excel/WPS 中会被当作公式执行
 *  （如 =cmd|'/c calc'!A1）。导出前统一加前置单引号做转义。 */
function csvCell(v) {
  const s = v == null ? '' : String(v);
  // Tab(0x09)/CR(0x0D)/LF(0x0A) 开头同样可触发 DDE
  if (/^[=+\-@\t\r]/.test(s)) return "'" + s;
  return s;
}
function buildCsv(rows) {
  const lines = rows.map(r => r.map(v => {
    const s = csvCell(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(','));
  return new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}
loadStore();

let toastTimer;
/**
 * 轻提示。转发到 UI 组件层，支持语义分级：
 *   toast('已保存')          → ok  绿色
 *   toast('保存失败：…', 'err') → err 红色
 * 允许多条堆叠，连续操作不会互相覆盖（原来单条复用，后一条会顶掉前一条）。
 */
const toast = (msg, kind = 'ok') => {
  if (typeof UI !== 'undefined' && UI.toast) return UI.toast(msg, kind);
  const t = $('#toast'); if (t) { t.textContent = msg; t.hidden = false; }
};

// ---------------- 数据缓存 ----------------
const S = { machines: [], parts: [], vm: [], vmf: [], os: [], hv: [], settings: {}, versions: [], quotes: [], apps: [],
  // 资产侧运行时缓存（融合 MVP）：设备台账 / 机房机柜 / U 位账本 / 交付批次 / 连线 / 采价反馈
  assets: { devices: [], rooms: [], racks: [], rack_units: [], deliveries: [], links: [], price_feedback: [] } };

/* ============================================================
 * 角色机制（M5）
 *
 * 角色由前端选择并存 localStorage，每次请求带 X-Role 头，由服务端裁剪字段。
 * **这不是身份认证**：请求头可被伪造，服务端裁剪属于「口径隔离」，
 * role_source='self_declared' 仅供审计，不可用于越权判定。
 * 缺省 sales —— 保持既有行为向后兼容。
 * ============================================================ */
const ROLE_KEY = 'xcq_role';
const ROLE_OPTIONS = [
  { v: 'sales', label: '售前' },
  { v: 'delivery', label: '交付' },
  { v: 'ops', label: '运维' },
  { v: 'viewer', label: '管理层' },
];
const ROLE_SOURCE = 'self_declared';
function currentRole() {
  try {
    const r = localStorage.getItem(ROLE_KEY);
    return (r && ROLE_OPTIONS.some(o => o.v === r)) ? r : 'sales';
  } catch (e) { return 'sales'; }
}
function setRole(r) {
  try {
    if (r && ROLE_OPTIONS.some(o => o.v === r)) localStorage.setItem(ROLE_KEY, r);
  } catch (e) { /* 隐私模式下 localStorage 可能不可写，忽略即可 */ }
  renderNav();
  renderRoleBar();
  renderTopbar(location.hash.replace('#/', '') || 'dashboard');
  // 返回 route() 的 promise：调用方可 await 到「该角色的数据已加载完」。
  // 不返回的话，角色切换后的数据刷新是悬空的 —— 上一角色的数据集会被
  // 留在 S 里，下一段代码读到的是错角色的数据。
  return route();
}
window.setRole = setRole;
/** 角色能力判定（与后端 role_caps 同口径） */
function roleCan(cap) {
  const r = currentRole();
  const sales = r === 'sales';
  const caps = {
    sales: sales,
    read_pricing: sales,
    publish_pricing: sales,
    read_quotes: sales || r === 'viewer',
    read_quotes_detail: sales,
    write_quotes: sales,
    read_assets: true,
    write_assets: r === 'sales' || r === 'delivery' || r === 'ops',
    submit_price_feedback: r === 'sales' || r === 'delivery' || r === 'ops',
    read_price_feedback: r === 'sales' || r === 'delivery' || r === 'ops',
    manage_deliveries: r === 'sales' || r === 'delivery',
  };
  return !!caps[cap];
}
/** 离线/在线一致的角色裁剪：抛 403 风格错误 */
function denyRole(msg) {
  const e = new Error(msg || '当前角色无权访问该接口');
  e.status = 403;
  throw e;
}

// ============ 空间模型（M2）：与后端 server.py 同口径 ============
// u_index = round(u × 2)：每半 U 一行，行粒度必须 ≥ 最细设备占用粒度，
// 否则二期引入半 U 设备时得迁数据。
// 权威占用账本 = rack_units；devices.u_start/u_size 只是冗余快照，冲突时以账本为准。
function uIndexOf(u) { return Math.round(Number(u || 0) * 2); }
/** 设备占用的槽位索引区间 [a, b) → [round(a×2), round(b×2)) */
function deviceUIndices(uStart, uSize) {
  const a = Number(uStart || 0);
  const b = a + Number(uSize || 1);
  const out = [];
  for (let i = uIndexOf(a); i < uIndexOf(b); i++) out.push(i);
  return out;
}
/** 机型高度：chassis_u（实际机箱高度）优先，缺省时按 rail 解析近似 */
function machineUSize(machine) {
  if (!machine || typeof machine !== 'object') return { u_size: 1, u_size_source: 'rail' };
  const cu = Number(machine.chassis_u || 0);
  if (cu > 0) return { u_size: cu, u_size_source: 'chassis' };
  const hit = String(machine.rail || '').match(/(\d+(?:\.\d+)?)\s*[Uu]/);
  return { u_size: hit ? Number(hit[1]) : 1, u_size_source: 'rail' };
}
/** 离线版 rackview：以本地 rack_units 为权威账本，算出与服务端同构的槽位与冲突 */
function localRackView(rack, units, devices) {
  const totalU = Number(rack && rack.u_total || 0);
  const totalIdx = Math.round(totalU * 2);
  const unitByIdx = {};
  (units || []).forEach(r => { if (r.rack_id === rack.id) unitByIdx[r.u_index] = r; });
  const devById = {};
  (devices || []).forEach(d => { devById[d.id] = d; });
  const slots = [];
  for (let idx = 0; idx < totalIdx; idx++) {
    const row = unitByIdx[idx];
    const dev = row ? devById[row.device_id] : null;
    let occ = 'free';
    if (row && dev) occ = row.reserved ? 'reserved' : 'occupied';
    else if (row) occ = 'reserved';
    slots.push({
      u_index: idx, u_start: idx / 2, occupancy: occ,
      device: dev ? {
        id: dev.id, code: dev.code || '', sn: dev.sn || '', state: dev.state || '',
        purpose: dev.purpose || '', role: dev.role || '',
        u_size: dev.u_size || 1, u_start: dev.u_start || 0,
      } : null,
    });
  }
  // 冲突三类分列：位置冲突（重叠/超高）≠ 资源冲突（功率）
  const conflicts = { overlap: [], over_height: [], power_over: [] };
  (devices || []).forEach(d => {
    if (d.rack_id !== rack.id) return;
    const idxs = deviceUIndices(d.u_start, d.u_size);
    idxs.forEach(i => { if (!unitByIdx[i]) conflicts.overlap.push({ device_id: d.id, u_index: i }); });
    if (totalU > 0 && Number(d.u_start || 0) + Number(d.u_size || 0) > totalU) {
      conflicts.over_height.push({ device_id: d.id, u_total: totalU });
    }
  });
  const usedW = (devices || []).filter(d => d.rack_id === rack.id)
    .reduce((s, d) => s + Number(d.power_w || 0), 0);
  const capW = Number(rack && rack.power_capacity_w || 0);
  if (capW > 0 && usedW > capW) {
    conflicts.power_over.push({ rack_id: rack.id, power_capacity_w: capW, used_power_w: usedW });
  }
  return {
    rack: Object.assign({}, rack),
    slots, conflicts,
    power: { used_w: usedW, capacity_w: capW },
    occupancy: { used_slots: slots.filter(s => s.occupancy !== 'free').length, total_slots: totalIdx },
  };
}
// B-12：请求合并 + 结果缓存，避免并发重复拉取与切换页签时反复请求
let _libInflight = null;
let _libCache = null;      // { key, data }
/** 把 loadLib 拉到的数据写进 S。
 *  缓存命中时也必须调用 —— 否则角色来回切换后，S 会停留在上一个角色的
 *  数据集上（如切到 ops 再切回 sales，机型库变空）。 */
function applyLib(data) {
  S.versions = data.versions || [];
  S.machines = data.machines || [];
  S.parts = data.parts || [];
  S.vm = data.vm || [];
  S.vmf = data.vmf || [];
  S.os = data.os || [];
  S.hv = data.hv || [];
  S.settings = data.settings || {};
}
async function loadLib(force) {
  // 缓存键带角色：不同角色可见的数据集不同（角色切回来时不能拿旧角色的缓存）
  const key = currentRole();
  if (!force && _libCache && _libCache.key === key) {
    applyLib(_libCache.data);
    return _libCache.data;
  }
  if (_libInflight) return _libInflight;      // 并发调用共享同一次请求
  _libInflight = (async () => {
    // 按角色裁剪请求集（M5）：非 sales 角色不请求单价库四表 ——
    // 服务端对这些表返回 403，若硬请求则 Promise.all 整体 reject → 整页白屏。
    const canPrice = roleCan('read_pricing');
    const jobs = [['versions', () => api('GET', '/api/versions')]];
    if (canPrice) {
      jobs.push(['machines', () => api('GET', '/api/machines')]);
      jobs.push(['parts', () => api('GET', '/api/parts')]);
      jobs.push(['vm', () => api('GET', '/api/vm_prices')]);
      jobs.push(['vmf', () => api('GET', '/api/vm_flavors')]);
    } else {
      const empty = () => Promise.resolve([]);
      jobs.push(['machines', empty], ['parts', empty], ['vm', empty], ['vmf', empty]);
    }
    jobs.push(['os', () => api('GET', '/api/os_options')]);
    jobs.push(['hv', () => api('GET', '/api/hypervisor_options')]);
    jobs.push(['settings', () => api('GET', '/api/settings')]);
    // allSettled：单个接口失败不拖垮整页（角色切换后端可能尚未放行某集合）
    const settled = await Promise.allSettled(jobs.map(j => j[1]()));
    const data = {};
    jobs.forEach((j, i) => { data[j[0]] = settled[i].status === 'fulfilled' ? settled[i].value : null; });
    applyLib(data);
    _libCache = { key, data };
    return data;
  })();
  try { return await _libInflight; }
  finally { _libInflight = null; }
}
/** 单价库数据变更后调用，使缓存失效并重新拉取 */
async function reloadLib() { _libCache = null; return loadLib(true); }

// ---- 共享用途注册表（硬件清单解析 / 配置台 / 架构梳理 共用） ----
const ROLES = ['主', '备', '单机'];
function purposeGroups() {
  if (typeof HclCore !== 'undefined' && HclCore.purposeGroups) return HclCore.purposeGroups();
  return [
    { name: '接入层', kws: ['网关'] }, { name: '应用服务', kws: ['应用'] },
    { name: '中间件', kws: ['中间件'] }, { name: '数据服务', kws: ['数据库'] },
    { name: '存储备份', kws: ['存储'] }, { name: '基础设施', kws: ['管理'] },
  ];
}
function purposeOf(text) {
  if (typeof HclCore !== 'undefined' && HclCore.purposeOf) return HclCore.purposeOf(text) || '未分组';
  const s = String(text || '').toLowerCase();
  for (const g of purposeGroups()) {
    if (g.name === text) return g.name;
    for (const k of g.kws) if (s.indexOf(k.toLowerCase()) >= 0) return g.name;
  }
  return '未分组';
}
function purposeRegistry() {
  const set = new Set();
  const hw = STORE && STORE.hwlib;
  (hw && hw.selections || []).forEach(x => { if (x.purpose) set.add(x.purpose); });
  (hw && hw.combos || []).forEach(x => { if (x.purpose) set.add(x.purpose); });
  (hw && hw.purposes || []).forEach(x => { if (x) set.add(x); });
  CFG.phys.forEach(x => { if (x.purpose) set.add(x.purpose); });
  CFG.vm.forEach(x => { if (x.purpose) set.add(x.purpose); });
  ['交易网关', '数据库', '中间件', 'Web', 'Redis缓存', '负载均衡', '管理节点', '报盘', '行情'].forEach(p => set.add(p));
  return [...set].sort();
}
function registerPurpose(p) {
  if (!p) return;
  STORE.hwlib = STORE.hwlib || { rules: null, combos: [], selections: [], imports: [], options: Object.assign({}, HCL_OPTIONS_DEFAULT()), purposes: [] };
  if (!STORE.hwlib.purposes) STORE.hwlib.purposes = [];
  if (!STORE.hwlib.purposes.includes(p)) { STORE.hwlib.purposes.push(p); lsSave(); }
  // 同步向后端/本地 state 持久化用途注册表（不阻塞渲染）
  api('GET', '/api/hcl/state').then(st => {
    const set = new Set(st.purposes || []);
    set.add(p);
    return api('PUT', '/api/hcl/state', { purposes: [...set] });
  }).catch(() => {});
}
function deployDisplay(line) {
  const r = line.role && line.role !== '单机' ? line.role + '-' : '';
  const p = line.purpose || line.deploy || '';
  return r + p;
}
function parseDeploy(deploy) {
  const m = String(deploy || '').match(/^((主|备|单机)-)?(.+)$/);
  if (!m) return { role: '', purpose: deploy || '' };
  return { role: m[2] || '', purpose: m[3] || '' };
}
function migrateLine(line) {
  if (!line.purpose && line.deploy) {
    const parsed = parseDeploy(line.deploy);
    line.purpose = parsed.purpose;
    line.role = parsed.role;
  }
  if (!line.role) line.role = '';
  if (!line.purpose && line.deploy) line.purpose = line.deploy;
  if (!line.group) line.group = purposeOf(line.purpose);
}
function migrateCfg() {
  CFG.phys.forEach(migrateLine);
  CFG.vm.forEach(migrateLine);
}
const activeVersion = () => S.versions.find(v => v.is_active) || S.versions[0] || {};
const vmPrice = (t) => S.vm.find(v => v.res_type === t) || { price_cents: 0, unit: '' };

// ---------------- 导航 ----------------
/* ============================================================
 * 导航结构
 *
 * 图标统一用 inline SVG（stroke 风格，与顶栏/卡片图标一致）。
 * 原实现用 emoji（🖥🔧☁🗂…），在 Windows / 不同字体下渲染差异很大，
 * 且与页面内其它 SVG 图标风格割裂——同一屏出现两种图标语言。
 * ============================================================ */
const NAV_ICONS = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect height="9" rx="1.5" width="7" x="3" y="3"/><rect height="5" rx="1.5" width="7" x="14" y="3"/><rect height="9" rx="1.5" width="7" x="14" y="12"/><rect height="5" rx="1.5" width="7" x="3" y="16"/></svg>',  machines: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect height="6" rx="1.5" width="20" x="2" y="4"/><rect height="6" rx="1.5" width="20" x="2" y="14"/><circle cx="6" cy="7" fill="currentColor" r="1" stroke="none"/><circle cx="6" cy="17" fill="currentColor" r="1" stroke="none"/></svg>',
  parts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14.7 6.3a4 4 0 0 0 5 5l-9 9a2.1 2.1 0 0 1-3-3z"/><path d="M14.7 6.3 17 4a3 3 0 0 1 3 3l-2.3 2.3"/></svg>',
  vm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M17.5 19H9a5 5 0 0 1-1.9-9.6A6.5 6.5 0 0 1 19.4 11 4 4 0 0 1 17.5 19z"/></svg>',
  versions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  configurator: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 6h16M4 12h16M4 18h10"/><circle cx="18" cy="18" r="2.5"/></svg>',
  'hw-parse': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/></svg>',
  quotes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></svg>',
  arch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 2 21 7v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/></svg>',
  'arch-diagram': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="4" r="2.5"/><circle cx="4" cy="19" r="2.5"/><circle cx="20" cy="19" r="2.5"/><path d="M12 6.5v5M12 11.5 5.5 17M12 11.5l6.5 5.5"/></svg>',
  data: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>',
  about: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/></svg>',
  // ---- 资产侧（融合 MVP）----
  devices: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect height="5" rx="1.2" width="20" x="2" y="3"/><rect height="5" rx="1.2" width="20" x="2" y="9.5"/><rect height="5" rx="1.2" width="20" x="2" y="16"/><circle cx="6" cy="5.5" fill="currentColor" r="1" stroke="none"/><circle cx="6" cy="12" fill="currentColor" r="1" stroke="none"/><circle cx="6" cy="18.5" fill="currentColor" r="1" stroke="none"/></svg>',
  space: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 21V9l9-6 9 6v12"/><path d="M9 21v-7h6v7"/></svg>',
  rackview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect height="20" rx="1.5" width="12" x="6" y="2"/><path d="M6 7h12M6 12h12M6 17h12"/></svg>',
  delivery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 7h11v10H2z"/><path d="M13 10h4.5l3.5 3.5V17h-8z"/><circle cx="6.5" cy="18.5" r="1.8"/><circle cx="17" cy="18.5" r="1.8"/></svg>',
};
/* ============================================================
 * 侧边导航
 *
 * 每个条目可声明 roles —— 该角色可见的菜单集合。
 * **菜单级隔离**是 M5 的硬要求：ops 打开导航就看不到「单价库」「报价单」，
 * 而不是只把内容藏起来。前端隐藏只是体验，服务端还会再裁一次（双保险）。
 * ============================================================ */
const NAV = [
  { title: '总览', items: [{ k: 'dashboard', label: '概览', ico: 'dashboard' }] },
  { title: '单价库', roles: ['sales'], items: [
    { k: 'lib/machines', label: '物理机机型', ico: 'machines' },
    { k: 'lib/parts', label: '可选部件', ico: 'parts' },
    { k: 'lib/vm', label: '虚拟机资源单价', ico: 'vm' },
    { k: 'lib/versions', label: '版本管理', ico: 'versions' },
  ] },
  { title: '报价', roles: ['sales'], items: [
    { k: 'configurator', label: '配置台（攒机）', ico: 'configurator' },
    { k: 'hw-parse', label: '硬件清单解析', ico: 'hw-parse' },
    { k: 'quotes', label: '报价单', ico: 'quotes' },
    { k: 'arch', label: '架构梳理', ico: 'arch' },
    { k: 'arch-diagram', label: '架构图 · draw.io', ico: 'arch-diagram', hidden: !FEATURES.archDiagram },
  ] },
  { title: '资产', items: [
    { k: 'assets/devices', label: '设备台账', ico: 'devices' },
    { k: 'assets/space', label: '机房 · 机柜', ico: 'space' },
    { k: 'assets/rackview', label: 'U 位视图', ico: 'rackview' },
    { k: 'assets/deliveries', label: '交付批次', ico: 'delivery' },
  ] },
  { title: '系统', roles: ['sales'], items: [
    { k: 'data', label: '数据导入导出', ico: 'data' },
    { k: 'settings', label: '系统设置', ico: 'settings' },
  ] },
  { title: '帮助', items: [
    { k: 'about', label: '关于 / 口径', ico: 'about' },
  ] },
];
const TITLES = {};
NAV.forEach(g => g.items.forEach(i => { if (!i.hidden) TITLES[i.k] = i.label; }));

/* ============================================================
 * 视图契约（对标同类成熟产品的 view 对象）
 *
 * 每个视图可声明：
 *   title  —— 顶栏主标题
 *   desc   —— 顶栏副标题（一句话说明这个页面解决什么问题）
 *   actions() —— 顶栏右侧上下文动作区（返回 HTML 或元素数组）
 *
 * 为什么要契约化：
 *   原实现每个页面自己往 #content 里塞标题，头部信息散落在页面内部，
 *   导致「我在哪、我能做什么、下一步做什么」三件事在同一个视口里互相打架。
 *   契约化之后，顶栏成为全局导航的一部分：标题告诉你位置，
 *   描述告诉你这个页面的职责，动作区告诉你此刻能做的事。
 * ============================================================ */
const VIEW_META = {
  'dashboard': {
    title: '概览',
    desc: '单价库、配置台与报价单的整体状态与待办',
    actions: () => `
      <button class="btn" onclick="location.hash='#/lib/machines'">维护单价库</button>
      <button class="btn primary" onclick="location.hash='#/configurator'">开始配置</button>`,
  },
  'lib/machines': {
    title: '物理机机型',
    desc: '按架构维护整机参考配置与整机报价',
    actions: () => `<button class="btn primary" onclick="editMachine()">+ 新增机型</button>`,
  },
  'lib/parts': {
    title: '可选部件',
    desc: '内存 / 硬盘 / 网卡 / RAID 等选配件单价与兼容约束',
    actions: () => `<button class="btn primary" onclick="editPart()">+ 新增部件</button>`,
  },
  'lib/vm': {
    title: '虚拟机资源单价',
    desc: 'vCPU / 内存 / 存储综合单价与常用规格组合',
    actions: () => `<button class="btn primary" onclick="editFlavor()">+ 新增规格组合</button>`,
  },
  'lib/versions': {
    title: '版本管理',
    desc: '报价单锁定单价库版本，保证报价口径可追溯',
    actions: () => roleCan('publish_pricing')
      ? `<button class="btn primary" onclick="newVersion()">+ 基于当前版本新建</button>` : '',
  },
  'configurator': {
    title: '配置台（攒机）',
    desc: '组合物理机与虚拟机，实时算价并校验架构一致性',
    actions: () => `
      <button class="btn" onclick="comparePlans()">方案对比</button>
      <button class="btn" onclick="exportCfg()">导出配置清单</button>
      <button class="btn" onclick="openPlacementCheck()">校验可上架</button>
      <button class="btn primary" onclick="confirmQuoteName()">保存为报价单</button>`,
  },
  'hw-parse': {
    title: '硬件清单解析',
    desc: '上传供应商清单，自动识别规格并沉淀为可选配置',
  },
  'quotes': {
    title: '报价单',
    desc: '保存、查看与导出历史报价',
    actions: () => `<button class="btn primary" onclick="location.hash='#/configurator'">新建报价单</button>`,
  },
  'arch': {
    title: '架构梳理',
    desc: '由拓扑白板推导部署组件、资源类型与互联关系',
  },
  'arch-diagram': {
    title: '架构图 · draw.io',
    desc: '由部署组件清单自动生成分层拓扑图并手工微调',
  },
  'data': {
    title: '数据导入导出',
    desc: '单价库整体备份与迁移',
  },
  'settings': {
    title: '系统设置',
    desc: '税率与计价口径',
  },
  'about': {
    title: '关于 / 口径',
    desc: '计价规则、范围边界与版本信息',
  },
  // ---- 资产侧（融合 MVP）----
  'assets/devices': {
    title: '设备台账',
    desc: '统一设备实例：SN、机柜 U 位、状态与用途一处维护',
    actions: () => `
      ${roleCan('write_assets') ? '<button class="btn primary" onclick="editDevice()">+ 新增设备</button>' : ''}
      <button class="btn" onclick="exportAssets()">导出台账（脱敏）</button>`,
  },
  'assets/space': {
    title: '机房 · 机柜',
    desc: '物理空间模型与 U 位占用账本',
    actions: () => roleCan('write_assets')
      ? `<button class="btn" onclick="editRoom()">+ 机房</button>
         <button class="btn primary" onclick="editRack()">+ 机柜</button>` : '',
  },
  'assets/rackview': {
    title: 'U 位视图',
    desc: '机柜正视 U 位图，占用位红色标出',
  },
  'assets/deliveries': {
    title: '交付批次',
    desc: '报价单按行拆成设备实例并预分配 U 位',
    actions: () => roleCan('manage_deliveries')
      ? `<button class="btn primary" onclick="genDelivery()">从报价单生成</button>` : '',
  },
};

/** 渲染顶栏：标题 + 描述 + 上下文动作区 */
function renderTopbar(key) {
  const meta = VIEW_META[key];
  const titleEl = $('#pageTitle');
  const descEl = $('#pageDesc');
  const actEl = $('#topbarActions');
  if (titleEl) titleEl.textContent = (meta && meta.title) || TITLES[key] || '概览';
  if (descEl) descEl.textContent = (meta && meta.desc) || '';
  if (actEl) {
    actEl.innerHTML = '';
    if (meta && meta.actions) {
      const raw = meta.actions();
      if (typeof raw === 'string') actEl.innerHTML = raw;
      else if (Array.isArray(raw)) raw.filter(Boolean).forEach(e => actEl.appendChild(e));
      else if (raw) actEl.appendChild(raw);
    }
  }
  renderRoleBar();
}

/** 顶栏角色下拉（M5）：切换角色即重算菜单可见性与数据裁剪 */
function renderRoleBar() {
  const el = $('#roleBar');
  if (!el) return;
  const cur = currentRole();
  const opts = ROLE_OPTIONS.map(o =>
    `<option value="${o.v}"${o.v === cur ? ' selected' : ''}>${o.label}</option>`).join('');
  el.innerHTML = `<label class="role-lbl">角色</label><select class="role-sel" onchange="setRole(this.value)">${opts}</select>`;
}

function renderNav() {
  const cur = location.hash.replace('#/', '') || 'dashboard';
  const role = currentRole();
  // 菜单级角色隔离（M5）：分组与条目都可声明 roles，空 = 全员可见
  const visible = (g) => (!g.roles || g.roles.indexOf(role) >= 0)
    && g.items.some(i => !i.hidden);
  const groups = NAV.filter(visible).map(g => {
    const items = g.items.filter(i => !i.hidden && (!i.roles || i.roles.indexOf(role) >= 0));
    return `<div class="nav-group-title">${g.title}</div>` + items.map(i =>
      `<div class="nav-item ${i.k === cur ? 'active' : ''}" data-k="${i.k}"><span class="nav-ico">${NAV_ICONS[i.ico] || ''}</span>${i.label}</div>`).join('');
  }).join('');
  $('#nav').innerHTML = groups;
  $$('.nav-item').forEach(el => el.onclick = () => { location.hash = '#/' + el.dataset.k; });
  const v = activeVersion();
  $('#verPill').textContent = '单价库版本：' + (v.name || '—');
  // 税率属于价格信息：非 sales 角色不显示
  const taxPill = $('#taxPill');
  if (taxPill) {
    taxPill.textContent = roleCan('read_pricing')
      ? '税率 ' + ((parseFloat(S.settings.tax_rate) || 0) * 100).toFixed(0) + '%'
      : '税率 —';
  }
  $('#verBadge').textContent = v.name ? ('当前版本：' + v.name) : '';
}

// ---------------- 路由 ----------------
function viewArchDiagramDisabled() {
  $('#content').innerHTML = `<div class="card card-pad">
    <h2 class="h2">架构图 · draw.io</h2>
    <p class="hint">该功能当前暂未启用。如需使用，请将 <code>FEATURES.archDiagram</code> 设为 <code>true</code> 并刷新页面。</p>
    <div class="actions" style="justify-content:flex-start;margin-top:14px">
      <button class="btn primary" onclick="location.hash='#/arch'">返回架构梳理</button>
    </div></div>`;
}
const ROUTES = {
  'dashboard': viewDashboard, 'lib/machines': viewMachines, 'lib/parts': viewParts,
  'lib/vm': viewVm, 'lib/versions': viewVersions, 'configurator': viewConfigurator,
  'hw-parse': HwParseView.render, 'quotes': viewQuotes, 'arch': viewArch,
  'arch-diagram': FEATURES.archDiagram ? ArchDiagramView.render : viewArchDiagramDisabled,
  'data': viewData, 'settings': viewSettings, 'about': viewAbout,
  // 资产侧（融合 MVP）
  'assets/devices': viewAssetsDevices, 'assets/space': viewAssetsSpace,
  'assets/rackview': viewAssetsRackview, 'assets/deliveries': viewAssetsDeliveries,
};
async function route() {
  const key = location.hash.replace('#/', '') || 'dashboard';
  renderNav();
  renderTopbar(key);
  const fn = ROUTES[key] || viewDashboard;
  try {
    await fn();
  } catch (e) {
    console.error('视图渲染失败', key, e);
    $('#content').innerHTML = `<div class="empty-state"><p>加载失败：${esc(e.message)}</p>
      <span class="hint">可返回概览页重试；若为数据问题，请到「数据导入导出」恢复单价库备份。</span></div>`;
  }
}
window.addEventListener('hashchange', route);

// ---------------- 通用 UI ----------------
/**
 * 弹窗。保留原有 (title, bodyHtml, footHtml) 签名以兼容既有 59 个全局函数，
 * 内部走 UI 组件层：Esc 关闭、焦点管理、遮罩点击关闭。
 */
function modal(title, bodyHtml, footHtml) {
  return UI.modal({ title, body: bodyHtml, foot: footHtml });
}
const closeModal = () => UI.closeModal();
$('#modalMask').onclick = (e) => { if (e.target.id === 'modalMask') closeModal(); };
// Esc 关闭弹窗 + 收起悬浮提示
// 注意：测试桩（tools/test-*.js）里的 document 是简化对象，没有 addEventListener，
// 这里做存在性判断，避免离线单测环境直接抛错。
if (typeof document.addEventListener === 'function') {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const mask = $('#modalMask');
      if (mask && !mask.hidden) closeModal();
      if (typeof UI !== 'undefined' && UI.tip) UI.tip.hide();
    }
  });
}

// ---------------- C-2 方案对比 / C-3 配置单导出 ----------------
/**
 * 方案对比：在当前配置清单基础上做「物理机 vs 虚拟化」与「海光 vs 鲲鹏」两组对比。
 * 口径与报价完全一致（同一个 physUnitCents/vmUnitCents），不做任何另立公式的估算。
 */
function archMigration(lines, fromArch, toArch) {
  // 把物理机行的机型从 fromArch 换成 toArch 中配置最接近（同核数/内存档）的机型
  return lines.map(l => {
    const m = S.machines.find(x => x.id === l.machineId);
    if (!m || m.arch !== fromArch) return l;
    const cand = S.machines.filter(x => x.arch === toArch);
    if (!cand.length) return l;
    const best = cand.slice().sort((a, b) => {
      const d = (x) => Math.abs((x.cpu_cores || 0) - (m.cpu_cores || 0)) * 10
        + Math.abs((x.mem_capacity || 0) - (m.mem_capacity || 0));
      return d(a) - d(b);
    })[0];
    return Object.assign({}, l, { machineId: best.id, os: (S.os.find(o => o.arch === best.arch) || {}).label || l.os,
      hv: (S.hv.find(h => h.arch === best.arch) || {}).label || l.hv });
  });
}
function vmizePhys(lines) {
  // 把物理机行替换为按其配置等比的虚拟机（1 台物理机 → 核数/2 台虚机，向上取整，最少 1）
  return lines.map(l => {
    const m = S.machines.find(x => x.id === l.machineId); if (!m) return null;
    const cores = (m.cpu_cores || 1) * (m.cpu_sockets || 1);
    const vmCount = Math.max(1, Math.ceil(cores / 2));
    const memPer = Math.round((m.mem_capacity || 8) / vmCount) || 8;
    const sto = (S.parts.filter(p => p.category && /硬盘|存储|盘/i.test(p.category)).length) ? 200 : 200;
    return { id: 'cmp_' + l.id, cpu: Math.max(2, Math.round(cores / vmCount)), mem: memPer, sto,
      qty: l.qty * vmCount, parts: [], purpose: l.purpose, role: l.role, group: l.group, deploy: l.deploy,
      flavor: '虚拟化替代', fromPhys: l.id, fromModel: m.brand + ' ' + m.model };
  }).filter(Boolean);
}
function sumCfg(phys, vm) {
  const tp = phys.reduce((s, l) => s + physUnitCents(l) * l.qty, 0);
  const tv = vm.reduce((s, l) => s + vmUnitCents(l) * l.qty, 0);
  const rate = parseFloat(S.settings.tax_rate) || 0;
  const sub = tp + tv;
  return { tp, tv, sub, tax: sub * rate, grand: sub * (1 + rate), pN: phys.length, vN: vm.length };
}
window.comparePlans = async () => {
  await loadLib();
  const phys = CFG.phys.filter(l => S.machines.find(x => x.id === l.machineId));
  const vm = CFG.vm;
  if (!phys.length && !vm.length) { toast('请先在配置台添加配置行'); return; }
  const archs = [...new Set(S.machines.map(m => m.arch))];
  const hygon = archs.find(a => /x86/i.test(a)) || '';
  const kunpeng = archs.find(a => /ARM/i.test(a)) || '';
  const rows = [];
  rows.push({ name: '当前方案（物理机 + 虚拟机）', ...sumCfg(phys, vm) });
  if (phys.length) {
    rows.push({ name: '方案A：全部虚拟化（物理机转虚机）', ...sumCfg([], vm.concat(vmizePhys(phys))) });
    if (hygon && kunpeng) {
      rows.push({ name: `方案B：${hygon} → ${kunpeng} 迁移`, ...sumCfg(archMigration(phys, hygon, kunpeng), vm) });
    }
  }
  const base = rows[0].grand;
  const tbl = rows.map(r => `<tr class="${r === rows[0] ? 'tot' : ''}">
    <td><b>${esc(r.name)}</b></td>
    <td class="num">${r.pN}</td><td class="num">${r.vN}</td>
    <td class="num">${fmt(r.tp)}</td><td class="num">${fmt(r.tv)}</td>
    <td class="num"><b>${fmt(r.grand)}</b></td>
    <td class="num" style="color:${r.grand > base ? '#c0392b' : (r.grand < base ? '#1e8e5a' : 'inherit')}">
      ${r === rows[0] ? '基准' : (r.grand - base >= 0 ? '+' : '') + fmt(r.grand - base) + ' 元'}</td>
  </tr>`).join('');
  modal('方案对比', `
    <p class="hint">同一套计价口径（整机价 + 选配部件；虚机按资源单价直乘），仅改变部署形态或 CPU 架构，便于判断该走虚机还是换平台。</p>
    <table><thead><tr><th>方案</th><th class="num">物理机</th><th class="num">虚拟机</th>
      <th class="num">物理机小计</th><th class="num">虚机小计</th><th class="num">含税总价</th><th class="num">对比当前</th></tr></thead>
    <tbody>${tbl}</tbody></table>
    <div class="actions"><button class="btn" onclick="closeModal()">关闭</button>
      <button class="btn primary" onclick="exportCompare()">导出对比表</button></div>`);
};
window.exportCompare = () => {
  const rows = [['方案对比表'], ['生成时间：' + new Date().toLocaleString('zh-CN')], ['单价库版本：' + (activeVersion().name || '—')],
    ['税率：' + ((parseFloat(S.settings.tax_rate) || 0) * 100).toFixed(0) + '%'], []];
  const body = document.querySelector('#modal table tbody');
  if (!body) { toast('请先打开方案对比'); return; }
  [...body.querySelectorAll('tr')].forEach(tr => {
    rows.push([...tr.children].map(td => td.textContent.trim()));
  });
  download('方案对比表_' + new Date().toISOString().slice(0, 10) + '.xlsx', buildXlsx([{ name: '方案对比', rows }]));
  toast('已导出对比表');
};
window.exportCfg = async () => {
  const rows = [['信创服务器配置清单'], ['生成时间：' + new Date().toLocaleString('zh-CN')],
    ['单价库版本：' + (activeVersion().name || '—'), '', `税率 ${((parseFloat(S.settings.tax_rate) || 0) * 100).toFixed(0)}%`], []];
  rows.push(['【物理机】']);
  rows.push(['#', '品牌型号', '架构', 'CPU', '核数(单颗)', '内存(G)', '硬盘', '选配部件', 'OS', '虚拟化平台', '数量', '单价(元)', '小计(元)', '用途', '角色']);
  CFG.phys.forEach((l, i) => {
    const m = S.machines.find(x => x.id === l.machineId);
    if (!m) return;
    rows.push([i + 1, `${m.brand} ${m.model}`, m.arch, `${m.cpu_model} ×${m.cpu_sockets}`, m.cpu_cores, m.mem_capacity,
      m.disk_desc || '', (l.parts || []).map(p => { const pt = S.parts.find(x => x.id === p.id); return pt ? `${pt.category} ${pt.spec}×${p.qty}` : ''; }).filter(Boolean).join('；'),
      l.os || '', l.hv || '', l.qty, fmtCents(m.unit_price_cents + physPartsCents(l)), fmtCents(physUnitCents(l) * l.qty), l.purpose || '', l.role || '']);
  });
  rows.push([]);
  rows.push(['【虚拟机】']);
  rows.push(['#', '规格', '用途', '角色', '数量', '单价(元)', '小计(元)']);
  CFG.vm.forEach((l, i) => rows.push([i + 1, `${l.cpu}C/${l.mem}G/${l.sto}G`, l.purpose || '', l.role || '', l.qty,
    fmtCents(vmUnitCents(l)), fmtCents(vmUnitCents(l) * l.qty)]));
  const tp = CFG.phys.reduce((s, l) => s + physUnitCents(l) * l.qty, 0);
  const tv = CFG.vm.reduce((s, l) => s + vmUnitCents(l) * l.qty, 0);
  const rate = parseFloat(S.settings.tax_rate) || 0;
  rows.push([]); rows.push(['', '', '', '', '', '不含税小计(元)', fmtCents(tp + tv)]);
  rows.push(['', '', '', '', '', '税额(元)', fmtCents((tp + tv) * rate)]);
  rows.push(['', '', '', '', '', '含税总价(元)', fmtCents((tp + tv) * (1 + rate))]);
  download('配置清单_' + new Date().toISOString().slice(0, 10) + '.xlsx', buildXlsx([{ name: '配置清单', rows }]));
  toast('已导出配置清单');
};
function fmtCents(c) { return (c / 100).toFixed(2); }

// ---------------- 视图：概览 ----------------
/**
 * 概览页 = 仪表盘。
 *
 * 原实现只有 3 个数字 + 一段文字 + 3 个按钮，用户看不出「当前项目处在什么状态、
 * 有什么问题要处理、下一步该干什么」。参考产品（同类成熟产品）的总览页做到了三件事：
 *   ① 每个指标卡可点击，直接钻取到相关视图；
 *   ② 有独立的「预警/待办」区，把需要用户处理的事显式列出来；
 *   ③ 有「最近动态」区，让用户看到最近的工作痕迹。
 * 这里按同样思路重写，并把「报价健康度」作为核心指标：
 * 待询价机型、架构不一致、规格校验告警——这三类问题一旦漏掉，报价直接失真。
 */
async function viewDashboard() {
  // 概览按角色分叉（M5）：售前看「报价口径」，资产侧看「物理落位」。
  // 非售前角色强行看售前仪表盘只会看到一屏空数据与不可点按钮 —— 那不是权限问题，
  // 是把两个岗位的仪表盘硬塞成一张。
  if (currentRole() !== 'sales') return viewAssetsDashboard(currentRole());
  await loadLib();
  try { S.quotes = await api('GET', '/api/quotes'); } catch (e) { S.quotes = []; }

  const tax = parseFloat(S.settings.tax_rate) || 0;
  const activeVer = activeVersion();

  /* ---------- 单价库健康度 ---------- */
  // 待询价：解析生成但单价为 0 的机型。它与「真实 0 元」无法区分，漏掉必然报价失真。
  const pendingMachines = S.machines.filter(isPendingPrice);
  // vmPrice() 找不到时返回 {price_cents:0} 而非 undefined，所以要按「是否配了这条资源」判断，
  // 不能用 !vmPrice(k)（永远为真）。
  const noVmPrice = ['cpu', 'mem', 'storage'].filter(k => !S.vm.some(v => v.res_type === k));
  const archs = [...new Set(S.machines.map(m => m.arch).filter(Boolean))];

  /* ---------- 配置台当前状态 ---------- */
  const cfgPhys = CFG.phys.length, cfgVm = CFG.vm.length;
  const totalPhys = CFG.phys.reduce((s, l) => s + physUnitCents(l) * (l.qty || 1), 0);
  const totalVm = CFG.vm.reduce((s, l) => s + vmUnitCents(l) * (l.qty || 1), 0);
  const subtotal = totalPhys + totalVm;
  const grand = Math.round(subtotal * (1 + tax));
  // 架构/规格一致性：与配置台用同一套校验函数，口径必须一致
  const errLines = CFG.phys.filter(l => physArchError(l));
  const specErrLines = CFG.phys.filter(l => {
    const m = S.machines.find(x => x.id === l.machineId);
    if (!m) return false;
    const addedMem = { list: (l.parts || []).map(p => ({ spec: (S.parts.find(x => x.id === p.id) || {}).spec, qty: p.qty })) };
    return !!(checkMemCapacity(m, addedMem) || checkDiskBays(m, l) || checkPower(m) || checkRackU(m));
  });

  /* ---------- 指标卡 ---------- */
  const cards = [
    {
      lbl: '配置台行数', val: cfgPhys + cfgVm, unit: '行',
      foot: cfgPhys + cfgVm ? `物理机 ${cfgPhys} · 虚拟机 ${cfgVm}` : '尚未开始配置',
      c: 'var(--brand-d)', ico: Icons.grid, view: 'configurator',
    },
    {
      lbl: '当前配置含税总价', val: fmt(grand), unit: '元',
      foot: `未税 ${fmt(subtotal)} 元 · 税率 ${(tax * 100).toFixed(0)}%`,
      c: 'var(--text-1)', ico: Icons.doc, view: 'configurator',
    },
    {
      lbl: '单价库规模', val: S.machines.length, unit: '个机型',
      foot: `${S.parts.length} 个部件 · ${archs.join(' / ') || '未设架构'}`,
      c: 'var(--info)', ico: Icons.layers, view: 'lib/machines',
    },
    {
      lbl: '待询价机型', val: pendingMachines.length, unit: '个',
      foot: pendingMachines.length ? '报价前需补齐单价，否则总价失真' : '全部机型均已询价',
      c: pendingMachines.length ? 'var(--warn)' : 'var(--ok)', ico: Icons.warn, view: 'lib/machines',
    },
  ];

  /* ---------- 待办清单 ---------- */
  const todos = [];
  if (!S.machines.length) {
    todos.push({ k: 'danger', t: '单价库为空，尚未录入任何物理机机型', v: '去维护', view: 'lib/machines' });
  } else if (pendingMachines.length) {
    todos.push({ k: 'warn', t: `${pendingMachines.length} 个机型单价为 0（待询价）`, v: '去处理', view: 'lib/machines' });
  }
  if (noVmPrice.length) {
    todos.push({ k: 'danger', t: `虚拟机资源单价缺失：${noVmPrice.join(' / ')}`, v: '去维护', view: 'lib/vm' });
  }
  if (errLines.length) {
    todos.push({ k: 'danger', t: `${errLines.length} 行物理机存在架构/部件不一致`, v: '去修正', view: 'configurator' });
  }
  if (specErrLines.length) {
    todos.push({ k: 'warn', t: `${specErrLines.length} 行物理机未通过规格校验`, v: '去查看', view: 'configurator' });
  }
  if (!cfgPhys && !cfgVm) {
    todos.push({ k: 'ok', t: '配置台为空，可从硬件清单解析或方案模板起步', v: '去配置', view: 'configurator' });
  }
  if (!S.quotes.length) {
    todos.push({ k: 'ok', t: '尚未保存任何报价单', v: '去保存', view: 'quotes' });
  }

  /* ---------- 最近报价单 ---------- */
  const recentQuotes = (S.quotes || []).slice().sort((a, b) =>
    String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 5);

  const statCards = cards.map(c => `
    <div class="stat clickable v-brand" style="--c:${c.c}" onclick="location.hash='#/${c.view}'">
      <span class="stat-go">${Icons.arrow}</span>
      <div class="stat-lbl">${c.ico}<span>${esc(c.lbl)}</span></div>
      <div class="stat-val" style="color:${c.c}">${esc(String(c.val))}<small>${esc(c.unit)}</small></div>
      <div class="stat-foot">${esc(c.foot)}</div>
    </div>`).join('');

  const todoHtml = todos.length ? todos.map(t => `
    <div class="todo-item" onclick="location.hash='#/${t.view}'">
      <span class="todo-dot ${t.k}"></span>
      <span class="todo-t">${esc(t.t)}</span>
      <span class="todo-v">${esc(t.v)} →</span>
    </div>`).join('') : UI.empty(Icons.warn, '没有待处理事项', '单价库与配置台状态正常');

  const quoteRows = recentQuotes.length ? recentQuotes.map(q => `
    <tr class="clickable" onclick="viewQuote(${q.id})">
      <td><b>${esc(q.name)}</b></td>
      <td class="muted">${esc(q.version_name || '—')}</td>
      <td class="num">${q.item_count != null ? q.item_count : '—'}</td>
      <td class="num"><b>${fmt(q.total_cents)}</b></td>
      <td class="muted">${esc(q.created_at || '')}</td>
    </tr>`).join('') : '';

  /* ---------- 单价库构成（横向条形图） ---------- */
  const byArch = archs.map(a => ({
    k: a, n: S.machines.filter(m => m.arch === a).length,
  })).sort((a, b) => b.n - a.n);
  const maxArch = Math.max(...byArch.map(x => x.n), 1);
  const archChart = byArch.length ? byArch.map(x => `
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px">
        <span>${esc(x.k)}</span><span style="color:var(--text-3)">${x.n} 个</span>
      </div>
      <div class="bar"><i style="width:${Math.round(x.n / maxArch * 100)}%;background:var(--brand)"></i></div>
    </div>`).join('') : '<p class="hint">尚未录入机型</p>';

  const vmSummary = S.vm.map(v =>
    `${v.res_type === 'cpu' ? 'CPU' : v.res_type === 'mem' ? '内存' : '存储'} ${fmt(v.price_cents)} 元/${v.unit}`
  ).join(' ｜ ');

  $('#content').innerHTML = `
  <div class="dash-grid">${statCards}</div>

  <div class="dash-section"><h2>待办与风险</h2><span class="sub">影响报价准确性的事项优先显示</span></div>
  <div class="dash-2col">
    <div class="card">
      <div class="card-head" style="padding:14px 18px 0"><h3 class="h3" style="margin:0">需要关注</h3></div>
      <div class="card-body"><div class="todo-list">${todoHtml}</div></div>
    </div>
    <div class="card">
      <div class="card-head" style="padding:14px 18px 0"><h3 class="h3" style="margin:0">单价库构成</h3></div>
      <div class="card-body">
        ${archChart}
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
          <div class="hint" style="margin-bottom:4px">虚拟机资源综合单价（已含许可与运维）</div>
          <div style="font-size:13px">${esc(vmSummary || '尚未配置')}</div>
        </div>
      </div>
    </div>
  </div>

  <div class="dash-section"><h2>最近报价单</h2>
    <span class="sub"><a href="#/quotes" style="color:var(--brand);text-decoration:none">查看全部 →</a></span></div>
  <div class="card">
    ${recentQuotes.length ? `<table class="tbl">
      <thead><tr><th>名称</th><th>单价库版本</th><th class="num">条目</th><th class="num">总价(元)</th><th>创建时间</th></tr></thead>
      <tbody>${quoteRows}</tbody></table>`
      : UI.empty(Icons.doc, '还没有保存过报价单', '在配置台完成配置后，点右上角「保存为报价单」即可归档',
          '<button class="btn primary" onclick="location.hash=\'#/configurator\'">前往配置台</button>')}
  </div>

  <div class="dash-section"><h2>工作流</h2><span class="sub">${esc(activeVer.name || '未选择版本')}</span></div>
  <div class="card card-pad">
    <div class="mini-metrics" style="margin-bottom:14px">
      <div class="mini-metric"><div class="n">${S.machines.length}</div><div class="l">物理机机型</div></div>
      <div class="mini-metric"><div class="n">${S.parts.length}</div><div class="l">可选部件</div></div>
      <div class="mini-metric"><div class="n">${S.vmf.length}</div><div class="l">虚拟机规格组合</div></div>
      <div class="mini-metric"><div class="n">${S.versions.length}</div><div class="l">单价库版本</div></div>
      <div class="mini-metric"><div class="n">${(S.quotes || []).length}</div><div class="l">历史报价单</div></div>
    </div>
    <p class="hint">① 在「单价库」维护机型与部件（按海光 / 鲲鹏分架构）② 到「配置台」组合并实时算价，或用「硬件清单解析」导入供应商清单 ③ 在「报价单」保存与导出。</p>
    <div class="actions" style="justify-content:flex-start">
      <button class="btn primary" onclick="location.hash='#/configurator'">前往配置台</button>
      <button class="btn" onclick="location.hash='#/lib/machines'">维护单价库</button>
      <button class="btn" onclick="location.hash='#/hw-parse'">解析硬件清单</button>
      <button class="btn" onclick="location.hash='#/arch'">架构梳理</button>
    </div>
  </div>`;
}

// ---------------- 视图：物理机机型 ----------------
// B-10：解析生成但未询价的机型（unit_price_cents=0）需要醒目标识，
// 否则与「真实 0 元」无法区分，报价直接失真。
function isPendingPrice(m) {
  return m && m.unit_price_cents === 0;
}
function pendingTag(m) {
  return isPendingPrice(m) ? ' <span class="tag pending" title="由清单解析生成，单价待询价">待询价</span>' : '';
}
// B-8：单机库搜索 + 筛选 + 排序
const LIB_UI = { q: '', arch: '', sort: 'price-asc' };
function filterMachines(list) {
  const q = LIB_UI.q.trim().toLowerCase();
  let out = (list || []).filter(m => {
    if (LIB_UI.arch && m.arch !== LIB_UI.arch) return false;
    if (!q) return true;
    return [m.brand, m.model, m.cpu_model, m.supplier, m.disk_desc, m.basis]
      .some(v => String(v || '').toLowerCase().indexOf(q) >= 0);
  });
  const s = LIB_UI.sort;
  out = out.slice().sort((a, b) => {
    if (s === 'price-asc') return (a.unit_price_cents || 0) - (b.unit_price_cents || 0);
    if (s === 'price-desc') return (b.unit_price_cents || 0) - (a.unit_price_cents || 0);
    if (s === 'cores-desc') return (b.cpu_cores || 0) - (a.cpu_cores || 0);
    if (s === 'mem-desc') return (b.mem_capacity || 0) - (a.mem_capacity || 0);
    return String(a.brand + a.model).localeCompare(String(b.brand + b.model), 'zh');
  });
  return out;
}
window.libSearch = (v) => { LIB_UI.q = v; renderMachineRows(); };
window.libFilter = (k, v) => { LIB_UI[k] = v; renderMachineRows(); };
async function renderMachineRows() {
  const all = S.machines || [];
  const list = filterMachines(all);
  const holder = $('#mTableHolder');
  const cnt = $('#mCount');
  if (cnt) cnt.textContent = list.length === all.length ? `共 ${all.length} 个机型` : `筛选出 ${list.length} / ${all.length} 个机型`;

  // 无数据时整表替换为图标化空状态（原实现只留一行「没有匹配的机型」裸文字）
  if (!list.length) {
    if (holder) {
      holder.innerHTML = `<div class="table-empty">${UI.empty(Icons.box,
        all.length ? '没有匹配的机型' : '还没有任何机型',
        all.length ? '试试调整搜索词或架构筛选' : '先录入整机参考配置与报价，之后配置台才能选型',
        `<button class="btn primary" onclick="editMachine()">+ 新增机型</button>`)}</div>`;
    }
    return;
  }
  // 空态消失后需要重建表格骨架
  if (holder && !$('#mRows')) {
    holder.innerHTML = `<table class="tbl"><thead><tr><th>品牌/型号</th><th>架构</th><th>CPU</th><th class="num">核数</th><th class="num">主频</th>
    <th class="num">内存(G)</th><th>硬盘</th><th class="num">含税单价(元)</th><th>供应商</th><th></th></tr></thead>
    <tbody id="mRows"></tbody></table>`;
  }
  const tb = $('#mRows');
  if (tb) tb.innerHTML = list.map(m => machineRowHtml(m)).join('');
}
function machineRowHtml(m) {
  return `<tr>
    <td><b>${esc(m.brand)} ${esc(m.model)}</b>${pendingTag(m)}</td>
    <td><span class="tag ${archClass(m.arch)}">${esc(m.arch)}</span></td>
    <td>${esc(m.cpu_model || '')} ×${m.cpu_sockets}${m.cpu_sockets === 1 ? ' <span class="muted" title="清单未识别到 CPU 路数，按 1 路记录，请人工确认">(路数待确认)</span>' : ''}</td>
    <td class="num">${m.cpu_cores}</td><td class="num">${m.cpu_freq}</td>
    <td class="num">${m.mem_capacity}</td><td>${esc(m.disk_desc || '')}</td>
    <td class="num"><b>${isPendingPrice(m) ? '待询价' : fmt(m.unit_price_cents)}</b></td>
    <td>${esc(m.supplier || '')}</td>
    <td class="actions" style="margin:0">
      <button class="btn sm" onclick="editMachine(${m.id})">编辑</button>
      <button class="btn sm danger" onclick="delMachine(${m.id})">删除</button>
    </td></tr>`;
}
async function viewMachines() {
  await loadLib();
  const archs = [...new Set(S.machines.map(m => m.arch).filter(Boolean))];
  const rows = filterMachines(S.machines).map(machineRowHtml).join('');
  $('#content').innerHTML = `<div class="card card-pad">
    <div class="toolbar"><div><h2 class="h2">物理机机型</h2><p class="hint">整机报价，按信创架构（海光 x86 / 鲲鹏 ARM）分库。单价库版本：${esc(activeVersion().name || '')}</p></div></div>
    <div class="table-toolbar">
      <div class="tb-search">${Icons.search}<input id="mQ" type="search" placeholder="搜索品牌 / 型号 / CPU / 供应商…" value="${esc(LIB_UI.q)}" oninput="libSearch(this.value)"></div>
      <label class="tb-sel"><span>架构</span><select onchange="libFilter('arch',this.value)"><option value="">全部架构</option>
        ${archs.map(a => `<option value="${esc(a)}" ${LIB_UI.arch === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
      <label class="tb-sel"><span>排序</span><select onchange="libFilter('sort',this.value)">
        ${[['price-asc', '单价 ↑ 从低到高'], ['price-desc', '单价 ↓ 从高到低'], ['cores-desc', '核数 ↓ 多到少'],
           ['mem-desc', '内存 ↓ 多到少'], ['name', '按名称']].map(([v, t]) =>
          `<option value="${v}" ${LIB_UI.sort === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <span class="tb-count" id="mCount"></span>
    </div>
    <div id="mTableHolder">${rows
      ? `<table class="tbl"><thead><tr><th>品牌/型号</th><th>架构</th><th>CPU</th><th class="num">核数</th><th class="num">主频</th>
    <th class="num">内存(G)</th><th>硬盘</th><th class="num">含税单价(元)</th><th>供应商</th><th></th></tr></thead>
    <tbody id="mRows">${rows}</tbody></table>`
      : `<div class="table-empty">${UI.empty(Icons.box,
          S.machines.length ? '没有匹配的机型' : '还没有任何机型',
          S.machines.length ? '试试调整搜索词或架构筛选' : '先录入整机参考配置与报价，之后配置台才能选型',
          `<button class="btn primary" onclick="editMachine()">+ 新增机型</button>`)}</div>`}</div></div>`;
  await renderMachineRows();
}
window.editMachine = async (id) => {
  await loadLib();
  const m = id ? S.machines.find(x => x.id === id) : {};
  modal(id ? '编辑机型' : '新增机型', `
    <div class="grid-2">
      <div class="field"><label>品牌</label><input id="f_brand" value="${esc(m.brand || '海光')}"></div>
      <div class="field"><label>型号</label><input id="f_model" value="${esc(m.model || '')}"></div>
      <div class="field"><label>架构</label><select id="f_arch">
        <option ${m.arch === '海光(C86/x86)' ? 'selected' : ''}>海光(C86/x86)</option>
        <option ${m.arch === '鲲鹏(ARM)' ? 'selected' : ''}>鲲鹏(ARM)</option></select></div>
      <div class="field"><label>CPU 型号</label><input id="f_cpu" value="${esc(m.cpu_model || '')}"></div>
      <div class="field"><label>CPU 颗数</label><input id="f_s" type="number" value="${m.cpu_sockets ?? 2}"></div>
      <div class="field"><label>核数</label><input id="f_cores" type="number" value="${m.cpu_cores ?? 32}"></div>
      <div class="field"><label>主频(GHz)</label><input id="f_freq" type="number" step="0.1" value="${m.cpu_freq ?? 2.5}"></div>
      <div class="field"><label>内存容量(G)</label><input id="f_mem" type="number" value="${m.mem_capacity ?? 256}"></div>
      <div class="field"><label>内存代际</label><input id="f_memg" value="${esc(m.mem_gen || 'DDR4')}"></div>
      <div class="field"><label>硬盘位</label><input id="f_db" value="${esc(m.disk_bays || '8')}"></div>
      <div class="field"><label>硬盘描述</label><input id="f_dd" value="${esc(m.disk_desc || '')}"></div>
      <div class="field"><label>网卡</label><input id="f_nic" value="${esc(m.nic || '')}"></div>
      <div class="field"><label>电源</label><input id="f_pw" value="${esc(m.power || '')}"></div>
      <div class="field"><label>导轨</label><input id="f_rail" value="${esc(m.rail || '2U导轨')}"></div>
      <div class="field"><label>机箱高度(U)</label><input id="f_chassis_u" type="number" step="0.5" min="0" value="${m.chassis_u ?? 0}"></div>
      <div class="field"><label>含税单价(元)</label><input id="f_price" type="number" step="0.01" value="${m.unit_price_cents ? (m.unit_price_cents / 100) : ''}"></div>
      <div class="field"><label>供应商</label><input id="f_sup" value="${esc(m.supplier || '')}"></div>
      <div class="field" style="grid-column:1/3"><label>报价依据</label><input id="f_basis" value="${esc(m.basis || '')}"></div>
    </div>`,
    `<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveMachine(${id || 0})">保存</button>`);
};
window.saveMachine = async (id) => {
  const d = {
    brand: $('#f_brand').value, model: $('#f_model').value, arch: $('#f_arch').value,
    cpu_model: $('#f_cpu').value, cpu_sockets: +$('#f_s').value, cpu_cores: +$('#f_cores').value,
    cpu_freq: +$('#f_freq').value, mem_capacity: +$('#f_mem').value, mem_gen: $('#f_memg').value,
    disk_bays: $('#f_db').value, disk_desc: $('#f_dd').value, nic: $('#f_nic').value,
    power: $('#f_pw').value, rail: $('#f_rail').value, unit_price_cents: yuanToCents($('#f_price').value),
    // M1.0：机箱高度 U（0 = 未标注 → 按导轨近似）。权威结果仍只有 u_size 一个字段。
    chassis_u: +$('#f_chassis_u').value || 0,
    supplier: $('#f_sup').value, basis: $('#f_basis').value
  };
  try {
    if (id) await api('PUT', '/api/machines/' + id, d); else await api('POST', '/api/machines', d);
    _libCache = null; closeModal(); await viewMachines(); toast('已保存');
  } catch (e) { toast('保存失败：' + e.message); }
};
window.delMachine = async (id) => {
  if (!await UI.confirm('确认删除该机型？已引用该机型的配置行将按 0 元计价。',
    { title: '删除机型', okText: '删除', danger: true })) return;
  _libCache = null;
  await api('DELETE', '/api/machines/' + id); await viewMachines(); toast('已删除');
};

// ---------------- 视图：部件 ----------------
// B-9：部件页筛选状态（搜索 + 类别 + 架构 + 排序）
const PART_UI = { q: '', cat: '', arch: '', sort: 'name' };
function filterParts(list) {
  const q = PART_UI.q.trim().toLowerCase();
  let out = (list || []).filter(p => {
    if (PART_UI.cat && p.category !== PART_UI.cat) return false;
    if (PART_UI.arch && (p.compat_arch || '通用') !== PART_UI.arch) return false;
    if (!q) return true;
    return [p.category, p.spec, p.compat_arch].some(v => String(v || '').toLowerCase().indexOf(q) >= 0);
  });
  out = out.slice().sort((a, b) => {
    if (PART_UI.sort === 'price-asc') return (a.price_cents || 0) - (b.price_cents || 0);
    if (PART_UI.sort === 'price-desc') return (b.price_cents || 0) - (a.price_cents || 0);
    return String(a.category + a.spec).localeCompare(String(b.category + b.spec), 'zh');
  });
  return out;
}
window.partSearch = (v) => { PART_UI.q = v; renderPartRows(); };
window.partFilter = (k, v) => { PART_UI[k] = v; renderPartRows(); };

async function viewParts() {
  await loadLib();
  const cats = [...new Set(S.parts.map(p => p.category).filter(Boolean))];
  const archs = [...new Set(S.parts.map(p => p.compat_arch || '通用'))];
  $('#content').innerHTML = `<div class="card card-pad">
    <div class="toolbar"><div><h2 class="h2">可选部件</h2><p class="hint">用于物理机加配（内存/硬盘/网卡/RAID），受架构约束。</p></div></div>
    <div class="table-toolbar">
      <div class="tb-search">${Icons.search}<input id="pQ" type="search" placeholder="搜索类别 / 规格…" value="${esc(PART_UI.q)}" oninput="partSearch(this.value)"></div>
      <label class="tb-sel"><span>类别</span><select onchange="partFilter('cat',this.value)"><option value="">全部类别</option>
        ${cats.map(c => `<option value="${esc(c)}" ${PART_UI.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label class="tb-sel"><span>架构</span><select onchange="partFilter('arch',this.value)"><option value="">全部架构</option>
        ${archs.map(a => `<option value="${esc(a)}" ${PART_UI.arch === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
      <label class="tb-sel"><span>排序</span><select onchange="partFilter('sort',this.value)">
        ${[['name', '按名称'], ['price-asc', '单价 ↑'], ['price-desc', '单价 ↓']].map(([v, t]) =>
          `<option value="${v}" ${PART_UI.sort === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <span class="tb-count" id="pCount"></span>
    </div>
    <div id="pTableHolder"></div></div>`;
  renderPartRows();
}
function renderPartRows() {
  const all = S.parts || [];
  const list = filterParts(all);
  const holder = $('#pTableHolder');
  const cnt = $('#pCount');
  if (cnt) cnt.textContent = list.length === all.length ? `共 ${all.length} 个部件` : `筛选出 ${list.length} / ${all.length} 个部件`;
  if (!holder) return;
  if (!list.length) {
    holder.innerHTML = `<div class="table-empty">${UI.empty(Icons.layers,
      all.length ? '没有匹配的部件' : '还没有可选部件',
      all.length ? '试试调整搜索词或筛选条件' : '录入内存 / 硬盘 / 网卡 / RAID 等加配件，配置台即可按需选配',
      `<button class="btn primary" onclick="editPart()">+ 新增部件</button>`)}</div>`;
    return;
  }
  const rows = list.map(p => `<tr>
    <td><span class="tag">${esc(p.category)}</span></td><td>${esc(p.spec)}</td>
    <td><span class="tag ${archClass(p.compat_arch)}">${esc(p.compat_arch || '通用')}</span></td>
    <td class="num">${fmt(p.price_cents)}</td>
    <td class="actions" style="margin:0"><button class="btn sm" onclick="editPart(${p.id})">编辑</button>
    <button class="btn sm danger" onclick="delPart(${p.id})">删除</button></td></tr>`).join('');
  holder.innerHTML = `<table class="tbl"><thead><tr><th>类别</th><th>规格</th><th>适配架构</th><th class="num">单价(元)</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}
window.editPart = async (id) => {
  const p = id ? S.parts.find(x => x.id === id) : {};
  modal(id ? '编辑部件' : '新增部件', `
    <div class="grid-2">
      <div class="field"><label>类别</label><input id="p_cat" value="${esc(p.category || '内存')}"></div>
      <div class="field"><label>规格</label><input id="p_spec" value="${esc(p.spec || '')}"></div>
      <div class="field"><label>适配架构</label><select id="p_arch"><option value="">通用</option>
        <option ${p.compat_arch === '海光(C86/x86)' ? 'selected' : ''}>海光(C86/x86)</option>
        <option ${p.compat_arch === '鲲鹏(ARM)' ? 'selected' : ''}>鲲鹏(ARM)</option></select></div>
      <div class="field"><label>单价(元)</label><input id="p_price" type="number" step="0.01" value="${p.price_cents ? (p.price_cents / 100) : ''}"></div>
    </div>`,
    `<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="savePart(${id || 0})">保存</button>`);
};
window.savePart = async (id) => {
  const d = { category: $('#p_cat').value, spec: $('#p_spec').value, compat_arch: $('#p_arch').value, price_cents: yuanToCents($('#p_price').value) };
  try { if (id) await api('PUT', '/api/parts/' + id, d); else await api('POST', '/api/parts', d); _libCache = null; closeModal(); await viewParts(); toast('已保存'); }
  catch (e) { toast('保存失败：' + e.message); }
};
window.delPart = async (id) => {
  if (!await UI.confirm('确认删除该部件？已引用该部件的配置行将按 0 元计价。',
    { title: '删除部件', okText: '删除', danger: true })) return;
  _libCache = null; await api('DELETE', '/api/parts/' + id); await viewParts(); toast('已删除');
};

// ---------------- 视图：虚拟机资源单价 ----------------
async function viewVm() {
  await loadLib();
  const rows = S.vm.map(v => `<tr>
    <td><span class="tag">${v.res_type === 'cpu' ? 'vCPU' : v.res_type === 'mem' ? '内存' : '存储'}</span></td>
    <td>${esc(v.unit)}</td><td class="num">${fmt(v.price_cents)}</td><td>${esc(v.basis || '')}</td>
    <td class="actions" style="margin:0"><button class="btn sm" onclick="editVm(${v.id})">编辑</button></td></tr>`).join('');
  const frows = S.vmf.map(f => `<tr>
    <td><b>${esc(f.name)}</b></td>
    <td class="num">${f.vcpu}</td><td class="num">${f.mem_gb}</td><td class="num">${f.storage_gb}</td>
    <td class="num"><b>${fmt(f.vcpu * vmPrice('cpu').price_cents + f.mem_gb * vmPrice('mem').price_cents + f.storage_gb * vmPrice('storage').price_cents)}</b></td>
    <td class="muted">${esc(f.note || '')}</td>
    <td class="actions" style="margin:0">
      <button class="btn sm" onclick="editFlavor(${f.id})">编辑</button>
      <button class="btn sm danger" onclick="delFlavor(${f.id})">删除</button>
      <button class="btn sm primary" onclick="addVmFromFlavor(${f.id})">加入配置台</button></td></tr>`).join('');
  $('#content').innerHTML = `<div class="card card-pad">
    <div class="toolbar"><div><h2 class="h2">虚拟机资源单价</h2><p class="hint">综合单价，已含许可与运维；虚拟机按资源直乘，不折算宿主机。现行：CPU ${fmt(vmPrice('cpu').price_cents)}元/核，内存 ${fmt(vmPrice('mem').price_cents)}元/G，存储 ${fmt(vmPrice('storage').price_cents)}元/G。</p></div></div>
    <table><thead><tr><th>资源类型</th><th>单位</th><th class="num">单价(元)</th><th>口径</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5">${UI.empty(Icons.box, '还没有配置虚拟机资源单价', '至少需要 CPU / 内存 / 存储三项单价，虚拟机才能算价')}</td></tr>`}</tbody></table></div>
  <div class="card card-pad" style="margin-top:16px">
    <div class="toolbar"><div><h2 class="h2">虚拟机规格组合（常用搭配）</h2><p class="hint">基于上方资源综合单价，预置常见 vCPU/内存/存储搭配；保存后可一键加入配置台，便于批量拼装已搭配好的虚拟机。现行单价库版本：${esc(activeVersion().name || '')}</p></div>
    <button class="btn primary" onclick="editFlavor()">+ 新增规格组合</button></div>
    <table><thead><tr><th>名称</th><th class="num">vCPU(核)</th><th class="num">内存(G)</th><th class="num">存储(G)</th><th class="num">综合单价(元)</th><th>备注</th><th></th></tr></thead>
    <tbody>${frows || `<tr><td colspan="7">${UI.empty(Icons.grid, '还没有规格组合', '预设常用 vCPU / 内存 / 存储搭配，保存后可一键加入配置台')}</td></tr>`}</tbody></table></div>`;
}
window.editVm = async (id) => {
  const v = id ? S.vm.find(x => x.id === id) : {};
  modal(id ? '编辑资源单价' : '新增资源单价', `
    <div class="grid-2">
      <div class="field"><label>类型</label><select id="v_t"><option value="cpu" ${v.res_type === 'cpu' ? 'selected' : ''}>cpu</option>
        <option value="mem" ${v.res_type === 'mem' ? 'selected' : ''}>mem</option><option value="storage" ${v.res_type === 'storage' ? 'selected' : ''}>storage</option></select></div>
      <div class="field"><label>单位</label><input id="v_u" value="${esc(v.unit || '核')}"></div>
      <div class="field"><label>单价(元)</label><input id="v_p" type="number" step="0.01" value="${v.price_cents ? (v.price_cents / 100) : ''}"></div>
      <div class="field"><label>口径</label><input id="v_b" value="${esc(v.basis || '')}"></div>
    </div>`,
    `<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveVm(${id || 0})">保存</button>`);
};
window.saveVm = async (id) => {
  const d = { res_type: $('#v_t').value, unit: $('#v_u').value, price_cents: yuanToCents($('#v_p').value), basis: $('#v_b').value };
  try { if (id) await api('PUT', '/api/vm_prices/' + id, d); else await api('POST', '/api/vm_prices', d); closeModal(); await viewVm(); toast('已保存'); }
  catch (e) { toast('保存失败：' + e.message); }
};
// ---------------- 虚拟机规格组合（flavor） ----------------
window.editFlavor = async (id) => {
  const f = id ? S.vmf.find(x => x.id === id) : {};
  modal(id ? '编辑规格组合' : '新增规格组合', `
    <div class="grid-2">
      <div class="field"><label>名称</label><input id="f_name" value="${esc(f.name || '')}" placeholder="如 通用型 4C16G"></div>
      <div class="field"><label>vCPU(核)</label><input id="f_vcpu" type="number" min="1" value="${f.vcpu ?? 4}"></div>
      <div class="field"><label>内存(G)</label><input id="f_mem" type="number" min="1" value="${f.mem_gb ?? 16}"></div>
      <div class="field"><label>存储(G)</label><input id="f_sto" type="number" min="0" value="${f.storage_gb ?? 100}"></div>
      <div class="field" style="grid-column:1/3"><label>备注</label><input id="f_note" value="${esc(f.note || '')}" placeholder="典型用途"></div>
    </div>
    <p class="hint" id="f_prev"></p>`,
    `<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveFlavor(${id || 0})">保存</button>`);
  const prev = () => { const c = (+$('#f_vcpu').value || 0) * vmPrice('cpu').price_cents + (+$('#f_mem').value || 0) * vmPrice('mem').price_cents + (+$('#f_sto').value || 0) * vmPrice('storage').price_cents; $('#f_prev').textContent = '按现行单价，综合单价约 ' + fmt(c) + ' 元/台'; };
  ['f_vcpu', 'f_mem', 'f_sto'].forEach(i => $('#' + i).addEventListener('input', prev)); prev();
};
window.saveFlavor = async (id) => {
  const d = { name: $('#f_name').value || '未命名规格', vcpu: +$('#f_vcpu').value || 1, mem_gb: +$('#f_mem').value || 1, storage_gb: +$('#f_sto').value || 0, note: $('#f_note').value };
  try { if (id) await api('PUT', '/api/vm_flavors/' + id, d); else await api('POST', '/api/vm_flavors', d); closeModal(); await viewVm(); toast('已保存'); }
  catch (e) { toast('保存失败：' + e.message); }
};
window.delFlavor = async (id) => {
  if (!await UI.confirm('确认删除该规格组合？', { title: '删除规格组合', okText: '删除', danger: true })) return;
  await api('DELETE', '/api/vm_flavors/' + id); await viewVm(); toast('已删除');
};
window.addVmFromFlavor = async (id) => {
  const f = S.vmf.find(x => x.id === id); if (!f) return;
  CFG.vm.push({ id: newLineId('v'), cpu: f.vcpu, mem: f.mem_gb, sto: f.storage_gb, qty: 1, flavor: f.name, purpose: '', role: '', group: '' });
  toast('已按「' + f.name + '」加入配置台（' + f.vcpu + 'C/' + f.mem_gb + 'G/' + f.storage_gb + 'G）');
  if (location.hash.indexOf('configurator') >= 0) renderConfigurator();
};

// ---------------- 视图：版本管理 ----------------
async function viewVersions() {
  await loadLib();
  // 发布权仅售前：非 sales 角色不渲染「新建 / 启用」按钮（点了也会被服务端 403）
  const canPublish = roleCan('publish_pricing');
  const rows = S.versions.map(v => `<tr>
    <td><b>${esc(v.name)}</b></td><td class="muted">${esc(v.note || '')}</td><td class="muted">${esc(v.created_at)}</td>
    <td>${v.is_active ? '<span class="tag x86">当前生效</span>' : ''}</td>
    <td class="actions" style="margin:0">${(canPublish && !v.is_active) ? `<button class="btn sm primary" onclick="activateVer(${v.id})">启用</button>` : ''}</td></tr>`).join('');
  $('#content').innerHTML = `<div class="card card-pad">
    <div class="toolbar"><div><h2 class="h2">版本管理</h2><p class="hint">每次变更建议新建版本（克隆当前生效版本），报价单锁定版本号即代表报价口径与有效期。</p></div>
    ${canPublish ? '<button class="btn primary" onclick="newVersion()">+ 基于当前版本新建</button>' : ''}</div>
    <table><thead><tr><th>版本名称</th><th>说明</th><th>创建时间</th><th>状态</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}
window.newVersion = async () => {
  const name = await UI.prompt('新版本名称：', {
    title: '新建单价库版本',
    value: '基线 v2 (' + new Date().toISOString().slice(0, 10) + ')',
    placeholder: '如：2026 年度框架价',
    okText: '下一步',
  });
  if (!name) return;
  const note = await UI.prompt('版本说明（变更原因）：', {
    title: '版本说明', placeholder: '如：海光机型价格更新', okText: '创建',
  });
  if (note === null) return;   // 用户取消 → 整体放弃
  try { await api('POST', '/api/versions', { name, note: note || '' }); _libCache = null; await viewVersions(); toast('已新建并启用'); } catch (e) { toast('失败：' + e.message, 'err'); }
};
window.activateVer = async (id) => { try { await api('PUT', '/api/versions/' + id + '/activate', {}); _libCache = null; await viewVersions(); toast('已切换版本'); } catch (e) { toast('失败：' + e.message); } };

// ---------------- 视图：配置台（核心） ----------------
async function viewConfigurator() {
  await loadLib();
  if (CFG.phys.length === 0 && CFG.vm.length === 0) {
    // 默认放一行物理机、一行虚拟机，便于上手
    if (S.machines[0]) CFG.phys.push(newPhys(S.machines[0].id));
    CFG.vm.push({ id: newLineId('v'), cpu: 4, mem: 16, sto: 100, qty: 1 });
  }
  renderConfigurator();
}
function newPhys(machineId) {
  const m = S.machines.find(x => x.id === machineId);
  const os = S.os.find(o => o.arch === m.arch) || S.os[0];
  const hv = S.hv.find(h => h.arch === m.arch) || S.hv[0];
  return { id: newLineId('p'), machineId, qty: 1, os: os?.label || '', hv: hv?.label || '', deploy: '', purpose: '', role: '', group: '', parts: [] };
}
/**
 * 物理机单价 = 整机价 + Σ选配部件（C-1）
 * line.parts 形如 [{ id, qty }]，qty 默认 1。
 * 部件按 id 匹配当前生效版本的 parts 表；匹配不到或版本不符时按 0 计并在 UI 提示，
 * 不静默丢钱也不虚增报价。
 */
function partCents(p) {
  const part = S.parts.find(x => x.id === p.id);
  if (!part) return 0;
  return part.price_cents || 0;
}
function partRowText(p) {
  const part = S.parts.find(x => x.id === p.id);
  if (!part) return '⚠ 部件已删除';
  return `${part.category} ${part.spec}`;
}
function physPartsCents(line) {
  return (line.parts || []).reduce((s, p) => s + partCents(p) * (p.qty || 1), 0);
}
function physUnitCents(line) {
  const m = S.machines.find(x => x.id === line.machineId); if (!m) return 0;
  return (m.unit_price_cents || 0) + physPartsCents(line);
}
/** 部件兼容性校验：架构不符 / 机型限定不符 */
function physPartsError(line) {
  const m = S.machines.find(x => x.id === line.machineId);
  if (!m) return '';
  const errs = [];
  (line.parts || []).forEach(p => {
    const part = S.parts.find(x => x.id === p.id);
    if (!part) { errs.push('部件已从单价库删除'); return; }
    if (part.compat_arch && m.arch && part.compat_arch !== m.arch) {
      errs.push(`${part.category}「${part.spec}」仅支持 ${part.compat_arch}，与机型 ${m.arch} 不符`);
    }
    if (part.compat_machine && m.model && String(part.compat_machine).indexOf(m.model) < 0) {
      errs.push(`${part.category}「${part.spec}」仅适配机型 ${part.compat_machine}`);
    }
  });
  return errs.join('；');
}
// ---------------- C-6 一致性校验引擎（需求 2.3 第 2~5 条） ----------------
// 已有的架构一致性校验在 physArchError；这里补齐硬件规格层面的四条硬约束。
// 原则：只报「可判定」的问题；字段缺失一律跳过，不猜测、不误伤。
const MEM_SLOTS_PER_SOCKET = { DDR4: 16, DDR5: 32 };   // 每路可插内存条数上限
const RAIL_U = { '1U': 1, '2U': 2, '4U': 4 };          // 机架高度 → U 数

/** 解析容量字符串，返回字节数。
 *  注意：DDR4/DDR5 里的字母 D 不能被当作单位，必须要求单位后不是字母。
 *  同时支持裸 T（如 "1.92T NVMe"）与 TB/GB/G。 */
function parseCapacityBytes(text) {
  const s = String(text == null ? '' : text).toUpperCase();
  // 单位后必须紧跟空格/加号/结尾，否则 "128G DDR5"、"32GbE" 会误判。
  // 候选按长度优先（TB > GB > T > G），保证 GB 不被拆成 G。
  const m = s.match(/(\d+(?:\.\d+)?)\s*(TB|GB|T|G)(?=\s|\+|$|×|X)/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  // 硬件清单里 G/GB 一律按 GiB 计、T/TB 按 TiB 计（厂商惯例，二进制容量）
  if (m[2] === 'TB' || m[2] === 'T') return n * 1024 * 1024 * 1024 * 1024;
  return n * 1024 * 1024 * 1024;
}
/** 2. 内存通道上限校验（加装内存不得超过整机可插容量） */
function checkMemCapacity(m, extraMemCents) {
  if (!m || !m.mem_capacity) return '';
  // 本机再加装的内存条（选配部件里的内存分类）
  let addedBytes = 0;
  (extraMemCents && extraMemCents.list || []).forEach(p => {
    const cap = parseCapacityBytes(p && p.spec);
    if (cap) addedBytes += cap * ((p && p.qty) || 1);
  });
  if (!addedBytes) return '';   // 无加装信息则不校验，避免误报
  const baseG = m.mem_capacity * (m.cpu_sockets || 1);
  if (addedBytes / (1024 * 1024 * 1024) <= baseG) return '';
  return `内存超出通道上限：整机已配 ${baseG}G，选配再加 ${Math.round(addedBytes / 1024 / 1024 / 1024)}G，超出可插容量`;
}
function parseMemCapacity(spec) { return parseCapacityBytes(spec); }

/** 3. 盘位 / RAID 匹配：选配硬盘数 + 基础盘数 ≤ 机型盘位，且 RAID 卡数量匹配盘位数 */
function checkDiskBays(m, line) {
  if (!m) return '';
  const bays = parseInt(m.disk_bays, 10);
  if (!bays) return '';                    // 机型未标盘位 → 不可判定，跳过
  let added = 0, raidCards = 0;
  ((line && line.parts) || []).forEach(p => {
    const part = S.parts.find(x => x.id === p.id);
    if (!part) return;
    if (/内存/i.test(part.category)) return;
    if (/RAID|阵列卡/i.test(part.category)) { raidCards += p.qty || 1; return; }
    if (/硬盘|盘|SSD|NVMe|SAS/i.test(part.category)) added += p.qty || 1;
  });
  const base = countDisks(m.disk_desc);
  if (added && base + added > bays) {
    return `硬盘超出盘位上限：机型 ${bays} 个盘位，基础盘 ${base} 块 + 选配 ${added} 块 = ${base + added} 块`;
  }
  // RAID 卡数 × 支持盘位 应能覆盖全部硬盘
  if (raidCards && base + added > 0) {
    const perCard = RAID_PORTS_PER_CARD[normalizeRaidClass(partRaidName(line))] || 0;
    if (perCard && raidCards * perCard < base + added) {
      return `RAID 卡端口不足：${raidCards} 张卡最多接 ${raidCards * perCard} 块盘，实际需要 ${base + added} 块`;
    }
  }
  return '';
}
const RAID_PORTS_PER_CARD = { '2盘位': 2, '4盘位': 4, '8盘位': 8, '12盘位': 12, '16盘位': 16, '24盘位': 24 };
function partRaidName(line) {
  const raid = ((line && line.parts) || []).map(p => S.parts.find(x => x.id === p.id))
    .find(x => x && /RAID|阵列卡/i.test(x.category));
  return raid ? (raid.spec || '') : '';
}
function normalizeRaidClass(spec) {
  const s = String(spec || '');
  const n = s.match(/(\d+)\s*(?:盘|路|通道)/);
  if (n) return n[1] + '盘位';
  if (/^RAID\s*0$/i.test(s)) return '';
  if (/^RAID\s*(5|6|10)$/i.test(s)) return '4盘位';
  return '';
}
/** 从 "2×960G SSD + 4×1.92T NVMe" 或 "1.92T NVMe" 里数盘数 */
function countDisks(desc) {
  const s = String(desc || '');
  if (!s) return 0;
  let total = 0, found = false;
  s.split('+').forEach(part => {
    const p = part.trim();
    if (!p) return;
    const m = p.match(/(\d+)\s*[×x*]\s*[\d.]+\s*(TB|GB|T|G)(?=\s|\+|$)/i);
    if (m) { total += parseInt(m[1], 10); found = true; return; }
    // 单盘写法（无「N×」前缀）：排除「转速 7200RPM」这类非盘描述
    if (/^\s*\d+(?:\.\d+)?\s*(TB|GB|T|G)(?=\s|\+|$)/i.test(p) && !/转速|RPM/i.test(p)) { total += 1; found = true; }
  });
  return found ? total : 0;
}

/** 4. 电源功率 ≥ 峰值功耗 × 1.2
 *  峰值口径：CPU 厂商 TDP 已是「单路满载功耗」，故按 路数×TDP 计，
 *  再叠加硬盘/风扇（约 12W/盘 + 100W 平台底噪）。曾错误地再乘核数，导致虚高 32 倍、
 *  所有双路机型都被误判为「电源不足」。 */
function checkPower(m) {
  if (!m || !m.power) return '';
  const rated = sumPower(m.power);
  if (!rated) return '';
  const tdp = cpuTdpWatts(m.cpu_model);
  if (!tdp) return '';                 // 型号不在已知库 → 不可判定，跳过
  const peak = tdp * (m.cpu_sockets || 1) + countDisks(m.disk_desc) * 12 + 100;
  const need = peak * 1.2;
  if (rated >= need) return '';
  return `电源功率不足：额定 ${rated}W < 峰值估算 ${Math.round(peak)}W × 1.2 = ${Math.round(need)}W`;
}
function sumPower(power) {
  let total = 0, found = false;
  String(power || '').split('+').forEach(part => {
    const m = part.match(/(\d+)\s*[×x*]?\s*(\d+)?\s*W/i);
    if (m) { total += (parseInt(m[1], 10) || 1) * (parseInt(m[2], 10) || 1); found = true; }
  });
  return found ? total : 0;
}
function cpuTdpWatts(model) {
  const s = String(model || '').toUpperCase();
  if (/5480|5450|7285/.test(s)) return 280;
  if (/7280|7265/.test(s)) return 350;
  if (/KUNPENG 920/.test(s)) return 300;
  if (/XEON PLATINUM/.test(s)) return 350;
  if (/XEON GOLD/.test(s)) return 280;
  if (/EPYC/.test(s)) return 320;
  if (/Xeon/i.test(s)) return 250;
  return 0;
}

/** 5. 机架 U 数与导轨匹配：整机高度(U) ≤ 导轨标注 U 数 */
function checkRackU(m) {
  if (!m || !m.rail) return '';
  const railU = parseRailU(m.rail);
  if (!railU) return '';                  // 导轨未标 U 数 → 不可判定，跳过
  const unitU = guessUnitU(m);
  if (!unitU) return '';
  if (unitU <= railU) return '';
  return `机架高度不匹配：机型为 ${unitU}U，导轨「${m.rail}」仅支持 ${railU}U`;
}
function parseRailU(rail) {
  const s = String(rail || '').toUpperCase();
  const direct = s.match(/(\d+)\s*U/);
  if (direct) return parseInt(direct[1], 10);
  const named = Object.keys(RAIL_U).find(k => s.indexOf(k) >= 0);
  return named ? RAIL_U[named] : 0;
}
/** 从盘位/内存/机型名粗略推断整机 U 数；推断不出返回 0 表示不可判定 */
function guessUnitU(m) {
  const s = [m.model, m.brand, m.disk_bays].join(' ');
  const named = Object.keys(RAIL_U).find(k => s.indexOf(k.toUpperCase()) >= 0);
  if (named) return RAIL_U[named];
  const bays = parseInt(m.disk_bays, 10);
  if (bays >= 24) return 4;
  if (bays >= 12) return 2;
  return 0;   // 不猜
}
/** 汇总一台物理机的全部规格校验 */
function physSpecErrors(line) {
  const m = S.machines.find(x => x.id === line.machineId);
  if (!m) return [];
  const memParts = { list: (line.parts || []).map(p => S.parts.find(x => x.id === p.id)).filter(Boolean) };
  return [checkMemCapacity(m, memParts), checkDiskBays(m, line), checkPower(m), checkRackU(m)]
    .filter(Boolean);
}

function vmUnitCents(line) { return line.cpu * vmPrice('cpu').price_cents + line.mem * vmPrice('mem').price_cents + line.sto * vmPrice('storage').price_cents; }
function physArchError(line) {
  const m = S.machines.find(x => x.id === line.machineId); if (!m) return '未选择机型';
  const os = S.os.find(o => o.label === line.os); const hv = S.hv.find(h => h.label === line.hv);
  const errs = [];
  if (os && os.arch && m.arch && os.arch !== m.arch) errs.push('操作系统架构(' + os.arch + ')与机型(' + m.arch + ')不一致');
  if (hv && hv.arch && m.arch && hv.arch !== m.arch) errs.push('虚拟化平台架构(' + hv.arch + ')与机型(' + m.arch + ')不一致');
  // C-1：部件兼容性同样纳入一致性校验
  const pe = physPartsError(line);
  if (pe) errs.push(pe);
  return errs.join('；');
}
function renderConfigurator() {
  migrateCfg();
  const totalPhys = CFG.phys.reduce((s, l) => s + physUnitCents(l) * l.qty, 0);
  const totalVm = CFG.vm.reduce((s, l) => s + vmUnitCents(l) * l.qty, 0);
  const subtotal = totalPhys + totalVm;
  const tax = subtotal * (parseFloat(S.settings.tax_rate) || 0);
  const grand = subtotal + tax;
  const specErrs = CFG.phys.reduce((a, l) => a.concat(physSpecErrors(l)), []);
  const hasSpecErr = specErrs.length > 0;
  const hasErr = CFG.phys.some(l => physArchError(l));
  const hasPending = CFG.phys.some(l => { const m = S.machines.find(x => x.id === l.machineId); return isPendingPrice(m); });

  const physHtml = CFG.phys.map(l => {
    const m = S.machines.find(x => x.id === l.machineId); const e = physArchError(l);
    const spec = m ? `<div class="spec">
        <div class="si"><span>架构</span><b><span class="tag ${archClass(m.arch)}">${esc(m.arch)}</span></b></div>
        <div class="si"><span>CPU</span><b>${esc(m.cpu_sockets)}×${esc(m.cpu_model)} · ${m.cpu_cores}核 @${m.cpu_freq}GHz</b></div>
        <div class="si"><span>内存</span><b>${m.mem_capacity}G ${esc(m.mem_gen || '')}</b></div>
        <div class="si"><span>硬盘</span><b>${esc(m.disk_desc || '—')}</b></div>
        <div class="si"><span>网卡</span><b>${esc(m.nic || '—')}</b></div>
        <div class="si"><span>电源/导轨</span><b>${esc(m.power || '—')} ｜ ${esc(m.rail || '—')}</b></div>
      </div>` : '';
    return `<div class="line phys" data-line="phys:${l.id}">
      <div class="lh"><span class="lt">${Icons.machines} ${m ? esc(m.brand + ' ' + m.model) : '未选机型'}</span>
        <button class="btn sm danger" onclick="rmPhys('${l.id}')">移除</button></div>
      <div class="field"><label>机型</label><select onchange="chPhysMachine('${l.id}',this.value)">
        ${S.machines.map(x => `<option value="${x.id}" ${x.id === l.machineId ? 'selected' : ''}>${esc(x.brand + ' ' + x.model)} · ${esc(x.arch)}</option>`).join('')}</select></div>
      ${spec}
        <div class="grid-2">
        <div class="field"><label>数量</label><input type="number" min="1" value="${l.qty}" oninput="chPhys('${l.id}','qty',this.value)"></div>
        <div class="field"><label>部署组件 / 用途</label>
          <input list="purposeRegistryList" value="${esc(l.purpose || '')}" onchange="chPurpose('${l.id}','phys',this.value)" placeholder="用途，如：数据库">
          <select onchange="chRole('${l.id}','phys',this.value)" style="margin-top:6px">
            <option value="">角色</option>
            ${ROLES.map(r => `<option value="${r}" ${l.role === r ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
          <div class="muted" style="margin-top:4px">显示：${esc(deployDisplay(l) || '未标注')}</div>
        </div>
      </div>
      <div class="grid-2">
        <div class="field"><label>操作系统（架构须匹配）</label><select onchange="chPhys('${l.id}','os',this.value)">
          ${S.os.map(o => `<option ${o.label === l.os ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>
        <div class="field"><label>虚拟化平台（架构须匹配）</label><select onchange="chPhys('${l.id}','hv',this.value)">
          ${S.hv.map(o => `<option ${o.label === l.hv ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>
      </div>
      ${e ? `<div class="err arch-tip">⚠ ${esc(e)}</div>` : `<div class="ok arch-tip">✓ 架构一致</div>`}
      ${m && isPendingPrice(m) ? `<div class="err">⚠ 该机型由清单解析生成、单价待询价，当前按 0 元计入报价</div>` : ''}
      <div class="field"><label>选配部件（整机价之外另计，C-1）</label>
        <div class="parts-box">
          ${(l.parts || []).map((p, i) => `<div class="part-row">
            <span class="part-name" title="${esc(partRowText(p))}">${esc(partRowText(p))}</span>
            <input type="number" min="1" value="${p.qty || 1}" oninput="chPart('${l.id}',${i},'qty',this.value)" class="part-qty">
            <span class="muted">${fmt(partCents(p) * (p.qty || 1))} 元</span>
            <button class="btn sm danger" onclick="rmPart('${l.id}',${i})">×</button>
          </div>`).join('')}
          <select onchange="addPart('${l.id}',this.value)" class="part-add">
            <option value="">+ 添加选配部件…</option>
            ${S.parts.map(p => `<option value="${p.id}">${esc(p.category)} · ${esc(p.spec)}（${fmt(p.price_cents)}元${p.compat_arch ? '，限' + esc(p.compat_arch) : ''}）</option>`).join('')}
          </select>
        </div>
        ${physPartsError(l) ? `<div class="err">⚠ ${esc(physPartsError(l))}</div>` : ''}
        ${physSpecErrors(l).map(x => `<div class="err spec">⚠ ${esc(x)}</div>`).join('')}
      </div>
      <div class="field"><label>本行单价 / 小计</label>
        <div class="muted line-amount">${isPendingPrice(m) ? '待询价' : fmt(m ? (m.unit_price_cents || 0) : 0)} 整机 + ${fmt(physPartsCents(l))} 部件 = <b>${fmt(physUnitCents(l))}</b> 元/台 ｜ 小计 <b>${fmt(physUnitCents(l) * l.qty)}</b> 元</div></div>
    </div>`;
  }).join('');

  const vmHtml = CFG.vm.map(l => `<div class="line vm" data-line="vm:${l.id}">
    <div class="lh"><span class="lt">${Icons.vm} 虚拟机</span><button class="btn sm danger" onclick="rmVm('${l.id}')">移除</button></div>
    <div class="grid-2">
      <div class="field"><label>vCPU(核)</label><input type="number" min="1" value="${l.cpu}" oninput="chVm('${l.id}','cpu',this.value)"></div>
      <div class="field"><label>内存(G)</label><input type="number" min="1" value="${l.mem}" oninput="chVm('${l.id}','mem',this.value)"></div>
      <div class="field"><label>存储(G)</label><input type="number" min="1" value="${l.sto}" oninput="chVm('${l.id}','sto',this.value)"></div>
      <div class="field"><label>数量</label><input type="number" min="1" value="${l.qty}" oninput="chVm('${l.id}','qty',this.value)"></div>
    </div>
    <div class="field"><label>部署组件 / 用途</label>
      <input list="purposeRegistryList" value="${esc(l.purpose || '')}" onchange="chPurpose('${l.id}','vm',this.value)" placeholder="用途，如：Web / 中间件">
      <select onchange="chRole('${l.id}','vm',this.value)" style="margin-top:6px">
        <option value="">角色</option>
        ${ROLES.map(r => `<option value="${r}" ${l.role === r ? 'selected' : ''}>${r}</option>`).join('')}
      </select>
      <div class="muted" style="margin-top:4px">显示：${esc(deployDisplay(l) || '未标注')}</div>
    </div>
    <div class="field"><label>本行单价 / 小计</label>
      <div class="muted line-amount">${fmt(vmUnitCents(l))} 元/台 ｜ 小计 <b>${fmt(vmUnitCents(l) * l.qty)}</b> 元</div></div>
  </div>`).join('');

  const flavorChips = S.vmf.map(f => `<div class="flavor-chip" draggable="true" ondragstart="dragFlavor(event,${f.id})" onclick="addVmFromFlavor(${f.id})" title="点击加入配置台；或在拓扑白板中拖入画布新增">
    <b>${esc(f.name)}</b><span class="fp">${f.vcpu}C/${f.mem_gb}G/${f.storage_gb}G</span></div>`).join('');
  const pickHtml = S.machines
    .filter(m => CFG.archFilter === '全部' || m.arch === CFG.archFilter)
    .map(m => { const added = CFG.phys.some(l => l.machineId === m.id);
      return `<div class="pick ${added ? 'added' : ''}" draggable="true" ondragstart="dragMachine(event,${m.id})" onclick="addPhys(${m.id})">
        <div><b>${esc(m.brand + ' ' + m.model)}</b>${pendingTag(m)}<div class="p">${esc(m.cpu_model)} ×${m.cpu_sockets} · ${m.cpu_cores}核 · ${isPendingPrice(m) ? '<b>待询价</b>' : fmt(m.unit_price_cents) + '元'}</div>
        <div class="p"><span class="tag ${archClass(m.arch)}">${esc(m.arch)}</span></div></div>
        <div>${added ? '✓ 已加入' : '＋ 加入'}</div></div>`; }).join('');

  $('#content').innerHTML = `<div class="toolbar"><h2 class="h2" style="margin:0">配置台（攒机式组合）</h2>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn primary" onclick="location.hash='#/hw-parse'">${Icons.upload} 从硬件清单导入</button>
      <div class="seg"><button class="${CFG.archFilter === '全部' ? 'on' : ''}" onclick="setArch('全部')">全部</button>
        <button class="${CFG.archFilter === '海光(C86/x86)' ? 'on' : ''}" onclick="setArch('海光(C86/x86)')">海光 x86</button>
        <button class="${CFG.archFilter === '鲲鹏(ARM)' ? 'on' : ''}" onclick="setArch('鲲鹏(ARM)')">鲲鹏 ARM</button></div>
      <div class="seg"><button class="${CFG.view === 'list' ? 'on' : ''}" onclick="setView('list')">清单视图</button>
        <button class="${CFG.view === 'topo' ? 'on' : ''}" onclick="setView('topo')">拓扑白板</button>
      </div>
    </div></div>
    <div class="arch-note">虚拟机按资源单价直乘（含许可与运维），不折算宿主机；物理机需保证「机型架构 = 操作系统架构 = 虚拟化平台架构」。</div>
    <div class="cfg">
      <div class="cfg-col"><h3>配置槽位</h3><div class="cfg-body">
        <div class="slot"><span>物理机配置行</span><span class="v">${CFG.phys.length} 行</span></div>
        <div class="slot"><span>虚拟机配置行</span><span class="v">${CFG.vm.length} 行</span></div>
        <div class="slot"><span>架构筛选</span><span class="v">${CFG.archFilter}</span></div>
        <button class="btn" style="width:100%" onclick="addPhys()">＋ 新增物理机行</button>
        <button class="btn" style="width:100%;margin-top:8px" onclick="addVm()">＋ 新增虚拟机行</button>
        <button class="btn ghost" style="width:100%;margin-top:8px" onclick="clearCfg()">清空配置</button>
        <h3 style="margin-top:16px">方案模板（C-4）</h3>
        <div class="scheme-list">
          ${Object.keys(SCHEME_TEMPLATES).map(k => {
            const t = SCHEME_TEMPLATES[k];
            const s = schemeTotal(k);
            return `<div class="scheme-item">
              <div class="scheme-h"><b>${esc(t.name)}</b>
                <button class="btn sm primary" onclick="applyScheme('${k}')">应用</button></div>
              <div class="muted">${esc(t.hint)}</div>
              <div class="scheme-n">${s.phys} 台物理机 ＋ ${s.vm} 台虚拟机 ｜ 约 ${fmt(s.physCents + s.vmCents)} 元</div>
            </div>`;
          }).join('')}
        </div>
      </div></div>
      <div class="cfg-col cfg-main"><h3>${CFG.view === 'topo' ? '拓扑白板（拖拽编排）' : '已选配置清单'}</h3><div class="cfg-body" style="${CFG.view === 'topo' ? 'padding:0;overflow:visible' : ''}">
        ${CFG.view === 'topo' ? renderTopo() : ((physHtml || '<p class="muted">尚无物理机</p>') + (vmHtml || '<p class="muted">尚无虚拟机</p>'))}
      </div>
      <div class="summary-total" id="cfgSummary">
      <div class="sub">实时报价汇总（单价库版本：${esc(activeVersion().name || '')}）</div>
      <div>物理机合计：<b>${fmt(totalPhys)}</b> 元 ｜ 虚拟机合计：<b>${fmt(totalVm)}</b> 元</div>
      <div class="big">含税总价：${fmt(grand)} 元</div>
      <div class="sub">不含税小计 ${fmt(subtotal)} 元 ｜ 税额 ${fmt(tax)} 元（税率 ${((parseFloat(S.settings.tax_rate) || 0) * 100).toFixed(0)}%）</div>
      <div class="actions" style="justify-content:flex-end;margin-top:10px">
        ${hasErr ? '<span style="color:#ffd2cc">⚠ 存在架构不一致，请修正后再保存</span>' : ''}
        ${hasSpecErr ? '<span style="color:#ffd2cc;margin-right:12px">⚠ 规格校验未通过（'+specErrs.length+' 项），建议修正</span>' : ''}
        ${hasPending ? '<span style="color:#ffd2cc;margin-right:12px">⚠ 存在待询价机型（按 0 元计）</span>' : ''}
        <button class="btn primary" ${hasErr ? 'disabled style="opacity:.5"' : ''} onclick="saveQuote(${subtotal},${grand})">保存为报价单</button>
      </div>
    </div></div>
      <div class="cfg-col cfg-picker"><h3>单价库选件</h3><div class="cfg-body">${pickHtml}
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
          <div class="muted" style="font-size:12px">虚拟机规格组合（点击 / 拖入白板新增）</div>
          ${flavorChips || '<div class="muted">暂无组合</div>'}
          <div class="muted" style="font-size:12px;margin-top:10px">虚拟机资源单价</div>
          <div class="pick">CPU ${fmt(vmPrice('cpu').price_cents)}元/核</div>
          <div class="pick">内存 ${fmt(vmPrice('mem').price_cents)}元/G</div>
          <div class="pick">存储 ${fmt(vmPrice('storage').price_cents)}元/G</div>
        </div>
      </div></div>
    </div>
    <datalist id="purposeRegistryList">${purposeRegistry().map(p => `<option value="${esc(p)}">`).join('')}</datalist>`;
  if (CFG.view === 'topo') bindTopo();
  lsSave();
}
// ---------------- 配置台局部刷新（B-7：避免整页重绘导致输入框失焦） ----------------
/** 只重算并替换汇总条，不重建页面，输入框保持焦点 */
function refreshSummary() {
  const el = $('#cfgSummary');
  if (!el) { renderConfigurator(); return; }
  const totalPhys = CFG.phys.reduce((s, l) => s + physUnitCents(l) * l.qty, 0);
  const totalVm = CFG.vm.reduce((s, l) => s + vmUnitCents(l) * l.qty, 0);
  const subtotal = totalPhys + totalVm;
  const rate = parseFloat(S.settings.tax_rate) || 0;
  const tax = subtotal * rate;
  const grand = subtotal + tax;
  const specErrs = CFG.phys.reduce((a, l) => a.concat(physSpecErrors(l)), []);
  const hasSpecErr = specErrs.length > 0;
  const hasErr = CFG.phys.some(l => physArchError(l));
  // B-10：存在待询价机型时给出显著提示，避免 0 元报价被误当作真实价格
  const hasPending = CFG.phys.some(l => { const m = S.machines.find(x => x.id === l.machineId); return isPendingPrice(m); });
  el.innerHTML = `
      <div class="sub">实时报价汇总（单价库版本：${esc(activeVersion().name || '')}）</div>
      <div>物理机合计：<b>${fmt(totalPhys)}</b> 元 ｜ 虚拟机合计：<b>${fmt(totalVm)}</b> 元</div>
      <div class="big">含税总价：${fmt(grand)} 元</div>
      <div class="sub">不含税小计 ${fmt(subtotal)} 元 ｜ 税额 ${fmt(tax)} 元（税率 ${(rate * 100).toFixed(0)}%）</div>
      <div class="actions" style="justify-content:flex-end;margin-top:10px">
        ${hasErr ? '<span style="color:#ffd2cc">⚠ 存在架构不一致，请修正后再保存</span>' : ''}
        ${hasSpecErr ? '<span style="color:#ffd2cc;margin-right:12px">⚠ 规格校验未通过（'+specErrs.length+' 项），建议修正</span>' : ''}
        ${hasPending ? '<span style="color:#ffd2cc;margin-right:12px">⚠ 存在待询价机型（按 0 元计）</span>' : ''}
        <button class="btn primary" ${hasErr ? 'disabled style="opacity:.5"' : ''} onclick="saveQuote(${Math.round(subtotal)},${Math.round(grand)})">保存为报价单</button>
      </div>`;
  lsSave();
}
/** 只更新某一行的「单价 / 小计」文本与架构校验提示 */
function refreshLine(kind, id) {
  const line = (kind === 'phys' ? CFG.phys : CFG.vm).find(x => x.id === id);
  if (!line) return;
  const unit = kind === 'phys' ? physUnitCents(line) : vmUnitCents(line);
  const holder = $(`[data-line="${kind}:${id}"]`);
  if (holder) {
    const amt = holder.querySelector('.line-amount');
    if (amt) amt.innerHTML = `${fmt(unit)} 元/台 ｜ 小计 <b>${fmt(unit * line.qty)}</b> 元`;
  }
  if (kind === 'phys') {
    const box = $(`[data-line="${kind}:${id}"]`);
    if (box) {
      const err = physArchError(line);
      const tip = box.querySelector('.arch-tip');
      if (tip) tip.outerHTML = err ? `<div class="err">⚠ ${esc(err)}</div>` : `<div class="ok">✓ 架构一致</div>`;
    }
  }
  refreshSummary();
}
window.setArch = (a) => { CFG.archFilter = a; renderConfigurator(); };
window.setView = (v) => { CFG.view = v; renderConfigurator(); };
window.resetTopo = () => { CFG.pos = {}; renderConfigurator(); };
window.dragMachine = (e, id) => { e.dataTransfer.setData('machineId', id); };
window.dragFlavor = (e, id) => { e.dataTransfer.setData('flavorId', id); };
window.dropItem = (e) => {
  e.preventDefault();
  const fid = e.dataTransfer.getData('flavorId'); const mid = e.dataTransfer.getData('machineId');
  if (fid) { const f = S.vmf.find(x => x.id == fid); if (f) { CFG.vm.push({ id: newLineId('v'), cpu: f.vcpu, mem: f.mem_gb, sto: f.storage_gb, qty: 1, flavor: f.name, purpose: '', role: '', group: '' }); toast('已加入：' + f.name); renderConfigurator(); } }
  else if (mid) { addPhys(+mid); toast('已加入物理机'); }
};
window.rmNode = (id) => {
  if (id.startsWith('p_')) { const lid = id.split('_')[1]; CFG.phys = CFG.phys.filter(l => l.id !== lid); }
  else if (id.startsWith('v_')) { const lid = id.slice(2); CFG.vm = CFG.vm.filter(l => l.id !== lid); }
  renderConfigurator();
};
// ---------------- 拓扑白板（拖拽编排 + 自定义连线） ----------------
function topoNodes() {
  const nodes = []; let pIdx = 0, vIdx = 0;
  CFG.phys.forEach(l => {
    const m = S.machines.find(x => x.id === l.machineId); if (!m) return;
    const items = `<div class="ni"><b>${Icons.machines} ${esc(m.brand + ' ' + m.model)}</b></div>
      <div class="ni">CPU：${m.cpu_sockets}×${esc(m.cpu_model)} ${m.cpu_cores}核</div>
      <div class="ni">内存：${m.mem_capacity}G ${esc(m.mem_gen || '')}</div>
      <div class="ni">硬盘：${esc(m.disk_desc || '—')}</div>
      <div class="ni">OS：${esc(l.os || '—')} ｜ HV：${esc(l.hv || '—')}</div>`;
    for (let u = 1; u <= (l.qty || 1); u++) { pIdx++; nodes.push({ id: 'p_' + l.id + '_' + u, lineId: l.id, kind: 'phys', no: '物理机#' + pIdx, deploy: l.deploy || '', purpose: l.purpose || '', role: l.role || '', group: l.group || '', items, spec: esc(m.brand + ' ' + m.model), foot: '单价 ' + fmt(physUnitCents(l)) + ' 元/台' }); }
  });
  CFG.vm.forEach(l => {
    vIdx++;
    const items = `<div class="ni"><b>${Icons.vm} 虚拟机（${l.qty}台）</b></div>
      <div class="ni">vCPU：${l.cpu} 核</div><div class="ni">内存：${l.mem} G</div><div class="ni">存储：${l.sto} G</div>
      ${l.flavor ? '<div class="ni">规格：' + esc(l.flavor) + '</div>' : ''}`;
    nodes.push({ id: 'v_' + l.id, lineId: l.id, kind: 'vm', no: '虚拟机#' + vIdx, deploy: l.deploy || '', purpose: l.purpose || '', role: l.role || '', group: l.group || '', items, spec: `${l.cpu}C/${l.mem}G/${l.sto}G`, foot: '单价 ' + fmt(vmUnitCents(l)) + ' 元/台' });
  });
  return nodes;
}
function renderTopo() {
  const nodes = topoNodes();
  if (nodes.length === 0) return `<div class="topo topo-empty" id="topo" ondragover="event.preventDefault()" ondrop="dropItem(event)">${UI.empty(Icons.grid, '尚无配置', '请从左侧新增，或从右侧「单价库选件 / 规格组合」点击 / 拖入画布')}</div>`;
  return `<div class="topo-wrap"><div class="topo ${CFG.connecting ? 'connecting' : ''}" id="topo" ondragover="event.preventDefault()" ondrop="dropItem(event)">
    <div class="topo-board" id="topoBoard">
    <svg class="topo-svg" id="topoSvg"></svg>
    ${nodes.map(n => `<div class="node ${n.kind} ${CFG.selNode === n.id ? 'sel' : ''}" data-id="${n.id}">
      <div class="node-h"><span class="node-no">${esc(n.no)}</span><button class="node-rm" onclick="event.stopPropagation();rmNode('${n.id}')" title="移除整行">×</button></div>
      <div class="node-b">${n.items}
        <div class="ni deploy"><span class="dl">${esc(n.group || '未分组')}</span>
          <input class="deploy-input" list="purposeRegistryList" value="${esc(n.purpose)}" placeholder="如：数据库" onchange="chPurpose('${n.lineId}','${n.kind}',this.value)" onclick="event.stopPropagation()">
          ${n.role ? `<span class="tag x86" style="margin-top:4px;display:inline-block">${esc(n.role)}</span>` : ''}
        </div>
      </div>
      <div class="node-f">${esc(n.foot)}</div>
    </div>`).join('')}
    </div>
  </div>
  </div><!-- /topo-wrap：必须在此闭合，否则会吃掉 cfg-body 的闭合标签，
                导致选件面板被解析进 cfg-main、汇总条被解析进 cfg-body（排版错乱）。
                topo-bar 保持在外部，不随画布滚动。 -->
  <div class="topo-bar">
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn sm ${CFG.connecting ? 'primary' : ''}" onclick="toggleConnect()">${CFG.connecting ? '✓ 连线模式：点两个节点建立连接' : '连线模式'}</button>
      <button class="btn sm" onclick="clearLinks()">清空连线</button>
      <button class="btn sm" onclick="resetTopo()">重置布局</button>
    </div>
    <span class="muted">拖动节点自由排版（画布可滚动，节点超出首屏时连线仍跟随）；在右侧「单价库选件 / 规格组合」中点击或拖入画布即可新增节点；连线模式下点两个节点建立连接（点连线可删除）。报价汇总在画布下方。</span>
  </div>`;
}
function bindTopo() {
  const canvas = $('#topo'); if (!canvas || canvas.classList.contains('topo-empty')) return;
  const svg = $('#topoSvg'); if (!svg) return;
  const board = $('#topoBoard'); if (!board) return;
  // 布局宽高必须取自滚动容器 .topo-wrap 的 clientWidth/Height（= 可视区），
  // 而不是画布自身宽度。取自身宽度会在重新渲染后自我放大，把右侧选件面板挤出屏幕。
  const wrap = (canvas.parentElement && canvas.parentElement.classList.contains('topo-wrap'))
    ? canvas.parentElement : canvas;
  const W = wrap.clientWidth || canvas.clientWidth;
  const H = canvas.clientHeight;
  const nodes = [...canvas.querySelectorAll('.node')];
  const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(nodes.length))));
  nodes.forEach((el, i) => {
    const id = el.dataset.id; const col = i % cols, row = Math.floor(i / cols);
    let x, y;
    if (CFG.pos[id]) { x = CFG.pos[id].x; y = CFG.pos[id].y; }
    else { x = 24 + col * 224; y = 24 + row * 184; CFG.pos[id] = { x, y }; }
    el.style.left = x + 'px'; el.style.top = y + 'px';
  });
  // B-11：画布按内容撑开并跟随滚动。原实现把 SVG 尺寸锁死为可视区大小，
  // 节点滚动到视口外后连线直接消失，且节点被限制在首屏内无法展开成大拓扑。
  function boardSize() {
    let maxX = W, maxY = H;
    nodes.forEach(el => {
      maxX = Math.max(maxX, parseFloat(el.style.left || 0) + el.offsetWidth + 24);
      maxY = Math.max(maxY, parseFloat(el.style.top || 0) + el.offsetHeight + 24);
    });
    return { w: Math.max(W, maxX), h: Math.max(H, maxY) };
  }
  function sizeLayers() {
    const s = boardSize();
    board.style.width = s.w + 'px';
    board.style.height = s.h + 'px';
    svg.setAttribute('width', s.w); svg.setAttribute('height', s.h);
    return s;
  }
  function drawLinks() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    (CFG.links || []).forEach(([a, b]) => {
      const ea = canvas.querySelector(`.node[data-id="${a}"]`); const eb = canvas.querySelector(`.node[data-id="${b}"]`);
      if (!ea || !eb) return;
      const ax = parseFloat(ea.style.left) + ea.offsetWidth / 2, ay = parseFloat(ea.style.top) + ea.offsetHeight / 2;
      const bx = parseFloat(eb.style.left) + eb.offsetWidth / 2, by = parseFloat(eb.style.top) + eb.offsetHeight / 2;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', ax); line.setAttribute('y1', ay); line.setAttribute('x2', bx); line.setAttribute('y2', by);
      line.setAttribute('class', 'edge'); line.dataset.a = a; line.dataset.b = b;
      line.setAttribute('onclick', `delLink('${a}','${b}')`);
      svg.appendChild(line);
    });
  }
  sizeLayers();
  drawLinks();
  nodes.forEach(el => {
    if (CFG.connecting) {
      el.onmousedown = null; el.style.cursor = 'pointer';
      el.onclick = () => nodeClick(el.dataset.id);
    } else {
      el.onclick = null; el.style.cursor = 'grab';
      el.onmousedown = (e) => {
        if (e.target.closest('.node-rm') || e.target.closest('.deploy-input')) return;
        e.preventDefault();
        const id = el.dataset.id; const sx = e.clientX, sy = e.clientY;
        const ox = parseFloat(el.style.left), oy = parseFloat(el.style.top);
        function move(ev) {
          // B-11：不再把节点锁死在首屏内，允许拖到画布任意位置；SVG 随之扩容
          const nx = Math.max(0, ox + (ev.clientX - sx));
          const ny = Math.max(0, oy + (ev.clientY - sy));
          el.style.left = nx + 'px'; el.style.top = ny + 'px';
          sizeLayers(); drawLinks();
        }
        function up() { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); CFG.pos[id] = { x: parseFloat(el.style.left), y: parseFloat(el.style.top) }; lsSave(); }
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      };
    }
  });
}
window.toggleConnect = () => { CFG.connecting = !CFG.connecting; CFG.selNode = null; renderConfigurator(); };
window.nodeClick = (id) => {
  if (!CFG.connecting) return;
  if (!CFG.selNode) CFG.selNode = id;
  else if (CFG.selNode === id) CFG.selNode = null;
  else {
    const a = CFG.selNode, b = id; CFG.links = CFG.links || [];
    if (!CFG.links.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) CFG.links.push([a, b]);
    CFG.selNode = null;
  }
  renderConfigurator();
};
window.clearLinks = () => { CFG.links = []; renderConfigurator(); };
window.delLink = (a, b) => { CFG.links = (CFG.links || []).filter(([x, y]) => !((x === a && y === b) || (x === b && y === a))); renderConfigurator(); };
window.archChPurpose = (lineId, kind, v) => {
  const arr = kind === 'phys' ? CFG.phys : CFG.vm;
  const l = arr.find(x => x.id === lineId);
  if (!l) return;
  l.purpose = v; l.group = purposeOf(v); l.deploy = deployDisplay(l);
  if (v) registerPurpose(v);
  persistCfg(); viewArch();
};
window.archChGroup = (lineId, kind, v) => {
  const arr = kind === 'phys' ? CFG.phys : CFG.vm;
  const l = arr.find(x => x.id === lineId);
  if (!l) return;
  l.group = v || purposeOf(l.purpose);
  persistCfg(); viewArch();
};
window.chDeploy = (lineId, kind, v) => {
  const arr = kind === 'phys' ? CFG.phys : CFG.vm;
  const l = arr.find(x => x.id === lineId);
  if (!l) return;
  const parsed = parseDeploy(v);
  l.purpose = parsed.purpose; l.role = parsed.role; l.group = purposeOf(parsed.purpose);
  l.deploy = deployDisplay(l);
  if (l.purpose) registerPurpose(l.purpose);
  persistCfg();
};
window.chPurpose = (lineId, kind, v) => {
  const arr = kind === 'phys' ? CFG.phys : CFG.vm;
  const l = arr.find(x => x.id === lineId);
  if (!l) return;
  l.purpose = v; l.group = purposeOf(v); l.deploy = deployDisplay(l);
  if (v) registerPurpose(v);
  persistCfg();
  renderConfigurator();
};
window.chRole = (lineId, kind, v) => {
  const arr = kind === 'phys' ? CFG.phys : CFG.vm;
  const l = arr.find(x => x.id === lineId);
  if (!l) return;
  l.role = v; l.deploy = deployDisplay(l);
  persistCfg();
  renderConfigurator();
};
window.addPhys = (machineId) => { CFG.phys.push(newPhys(machineId || S.machines[0]?.id)); renderConfigurator(); };
window.addVm = () => { CFG.vm.push({ id: newLineId('v'), cpu: 4, mem: 16, sto: 100, qty: 1, purpose: '', role: '', group: '' }); renderConfigurator(); };
window.rmPhys = (id) => { CFG.phys = CFG.phys.filter(l => l.id !== id); renderConfigurator(); };
window.rmVm = (id) => { CFG.vm = CFG.vm.filter(l => l.id !== id); renderConfigurator(); };
// B-9：清空配置是破坏性操作，补二次确认（与 delMachine/delQuote 保持一致）
// 说明：历史签名是同步的（调用方写的是 `clearCfg(); assert(...)`），
// 因此保留同步分支——UI.confirmSync 在无弹窗宿主时同步返回布尔值；
// 在真实浏览器里则走可视化确认框（异步），此时返回 Promise。
window.clearCfg = () => {
  const msg = '确认清空全部配置行？此操作不可撤销（已保存的报价单不受影响）。';
  const sync = UI.confirmSync(msg);
  if (sync !== null) {
    if (!sync) return;
    CFG = { phys: [], vm: [], archFilter: CFG.archFilter, view: CFG.view, pos: CFG.pos, links: CFG.links, selNode: null, connecting: false };
    renderConfigurator();
    toast('已清空配置');
    return;
  }
  return UI.confirm(msg, { title: '清空配置台', okText: '清空', danger: true }).then(ok => {
    if (!ok) return;
    CFG = { phys: [], vm: [], archFilter: CFG.archFilter, view: CFG.view, pos: CFG.pos, links: CFG.links, selNode: null, connecting: false };
    renderConfigurator();
    toast('已清空配置');
  });
};
window.addPart = (lineId, partId) => {
  const l = CFG.phys.find(x => x.id === lineId); if (!l || !partId) return;
  const pid = +partId;
  if (!(l.parts || []).some(p => p.id === pid)) {
    l.parts = (l.parts || []).concat([{ id: pid, qty: 1 }]);
  }
  renderConfigurator();
};
window.rmPart = (lineId, idx) => {
  const l = CFG.phys.find(x => x.id === lineId); if (!l) return;
  l.parts.splice(idx, 1); renderConfigurator();
};
window.chPart = (lineId, idx, k, v) => {
  const l = CFG.phys.find(x => x.id === lineId); if (!l) return;
  const p = (l.parts || [])[idx]; if (!p) return;
  p[k] = Math.max(1, +v || 1);
  refreshLine('phys', lineId);
};
// C-1：报价单明细需记录所选部件，便于还原与复核
window.chPhys = (id, k, v) => {
  const l = CFG.phys.find(x => x.id === id); if (!l) return;
  l[k] = (k === 'qty') ? (Math.max(1, +v || 1)) : v;
  refreshLine('phys', id);
};
window.chPhysMachine = (id, mid) => {
  const l = CFG.phys.find(x => x.id === id); if (!l) return;
  l.machineId = +mid;
  const m = S.machines.find(x => x.id === +mid);
  if (m) {
    const os = S.os.find(o => o.arch === m.arch); const hv = S.hv.find(h => h.arch === m.arch);
    l.os = os?.label || l.os; l.hv = hv?.label || l.hv;
  }
  renderConfigurator();  // 换机型要重画规格区（下拉选中项也需同步），属低频操作
};
window.chVm = (id, k, v) => {
  const l = CFG.vm.find(x => x.id === id); if (!l) return;
  const min = k === 'sto' ? 0 : 1;
  l[k] = Math.max(min, +v || min);
  refreshLine('vm', id);
};
// B-9：报价单名称改用 modal 表单并校验非空/不重名，替代 prompt
function askQuoteName(subtotal, grand) {
  const dup = new Set((STORE.quotes || []).map(q => q.name));
  modal('保存为报价单', `
    <div class="field"><label>报价单名称</label>
      <input id="q_name" value="报价单-${new Date().toISOString().slice(0, 10)}" placeholder="如：性能版报价-2026-10"></div>
    <p class="hint">将锁定当前单价库版本「${esc(activeVersion().name || '—')}」，含税总价 <b>${fmt(Math.round(grand))}</b> 元。</p>
    <p class="hint" id="q_err" style="color:#e24b4a"></p>`,
    `<button class="btn" onclick="closeModal()">取消</button>
     <button class="btn primary" onclick="confirmQuoteName(${Math.round(subtotal)},${Math.round(grand)})">保存</button>`);
  setTimeout(() => { const el = $('#q_name'); if (el) { el.focus(); el.select(); } }, 30);
  window.__qDup = [...dup];
}
window.confirmQuoteName = async (subtotal, grand) => {
  const name = ($('#q_name') ? $('#q_name').value : '').trim();
  if (!name) { $('#q_err').textContent = '名称不能为空'; return; }
  if ((window.__qDup || []).indexOf(name) >= 0) { $('#q_err').textContent = '已存在同名报价单，请换一个名称'; return; }
  closeModal();
  await doSaveQuote(name, subtotal, grand);
};
async function doSaveQuote(name, subtotal, grand) {
  const items = [];
  const ver = activeVersion();
  // 条目序号 item_no：从 1 递增（M1.0-b 锚点字段）。
  // line_uid 由后端在分配 quote_id 后补全（q_<quoteId>_<item_no>）——
  // 前端保存前拿不到 quoteId，故此处不写。
  let itemNo = 0;
  CFG.phys.forEach(l => {
    const m = S.machines.find(x => x.id === l.machineId);
    if (!m) return;
    itemNo++;
    items.push({
      item_no: itemNo, legacy: 0,
      type: '物理机', title: m.brand + ' ' + m.model + (l.os ? ' / ' + l.os : ''),
      qty: l.qty, unit_cents: physUnitCents(l), line_cents: physUnitCents(l) * l.qty,
      // 规格快照：保证单价库改价后历史报价仍可还原（RK-02）
      machine_id: m.id, arch: m.arch, cpu: `${m.cpu_sockets}×${m.cpu_model || ''} ${m.cpu_cores}核`,
      mem_gb: m.mem_capacity, disk: m.disk_desc || '', nic: m.nic || '',
      os: l.os || '', hv: l.hv || '', purpose: l.purpose || '', role: l.role || '',
      // C-1：记录所选部件快照
      parts: (l.parts || []).map(p => {
        const part = S.parts.find(x => x.id === p.id);
        return { id: p.id, qty: p.qty || 1,
          category: part ? part.category : '', spec: part ? part.spec : '',
          price_cents: part ? part.price_cents : 0 };
      }),
    });
  });
  CFG.vm.forEach(l => {
    itemNo++;
    items.push({
      item_no: itemNo, legacy: 0,
      type: '虚拟机', title: `${l.cpu}C/${l.mem}G/${l.sto}G`,
      qty: l.qty, unit_cents: vmUnitCents(l), line_cents: vmUnitCents(l) * l.qty,
      cpu: l.cpu, mem_gb: l.mem, sto_gb: l.sto,
      flavor: l.flavor || '', purpose: l.purpose || '', role: l.role || '',
    });
  });
  // subtotal / grand 均以「分」为单位，不可再乘 100（A-2）
  const taxCents = Math.round(grand) - Math.round(subtotal);
  try {
    await api('POST', '/api/quotes', {
      name, tax_rate: parseFloat(S.settings.tax_rate) || 0,
      subtotal_cents: Math.round(subtotal), tax_cents: taxCents, total_cents: Math.round(grand),
      // 锁定单价库版本口径（A-3）
      version_id: ver.id || null, version_name: ver.name || '',
      items,
    });
    toast('已保存报价单'); location.hash = '#/quotes';
  } catch (e) { toast('保存失败：' + e.message); }
}
window.saveQuote = async (subtotal, grand) => { askQuoteName(subtotal, grand); };

// ---------------- 视图：报价单 ----------------
// B-9：报价单页筛选状态（搜索 + 版本筛选）
const QUOTE_UI = { q: '', ver: '' };
window.quoteSearch = (v) => { QUOTE_UI.q = v; renderQuoteRows(); };
window.quoteFilter = (k, v) => { QUOTE_UI[k] = v; renderQuoteRows(); };
function filterQuotes(list) {
  const q = QUOTE_UI.q.trim().toLowerCase();
  return (list || []).filter(x => {
    if (QUOTE_UI.ver && (x.version_name || '—') !== QUOTE_UI.ver) return false;
    if (!q) return true;
    return [x.name, x.version_name].some(v => String(v || '').toLowerCase().indexOf(q) >= 0);
  });
}
async function viewQuotes() {
  S.quotes = await api('GET', '/api/quotes');
  const vers = [...new Set((S.quotes || []).map(q => q.version_name || '—'))];
  // 表格主体在 renderQuoteRows() 里渲染（便于筛选时局部重绘），
  // 但版本名必须先出现在 #content 里：它是「报价锁定了哪个口径」的关键信息，
  // 也是自动化测试断言的目标。
  const verHint = vers.length
    ? `已锁定版本：${vers.map(v => esc(v)).join('、')}`
    : '尚未保存报价单';
  $('#content').innerHTML = `<div class="card card-pad">
    <div class="toolbar"><div><h2 class="h2">报价单</h2><p class="hint">保存的配置与报价结果，均锁定单价库版本号，可随时复现与导出。</p></div></div>
    <div class="table-toolbar">
      <div class="tb-search">${Icons.search}<input id="qQ" type="search" placeholder="搜索报价单名称…" value="${esc(QUOTE_UI.q)}" oninput="quoteSearch(this.value)"></div>
      <label class="tb-sel"><span>版本</span><select onchange="quoteFilter('ver',this.value)"><option value="">全部版本</option>
        ${vers.map(v => `<option value="${esc(v)}" ${QUOTE_UI.ver === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <span class="tb-count" id="qCount"></span>
    </div>
    <div class="hint" style="margin:-4px 0 10px">${verHint}</div>
    <div id="qTableHolder"></div></div>`;
  renderQuoteRows();
}
function renderQuoteRows() {
  const all = S.quotes || [];
  const list = filterQuotes(all);
  const holder = $('#qTableHolder');
  const cnt = $('#qCount');
  if (cnt) cnt.textContent = list.length === all.length ? `共 ${all.length} 份报价单` : `筛选出 ${list.length} / ${all.length} 份报价单`;
  if (!holder) return;
  if (!list.length) {
    holder.innerHTML = `<div class="table-empty">${UI.empty(Icons.doc,
      all.length ? '没有匹配的报价单' : '还没有保存过报价单',
      all.length ? '试试调整搜索词或版本筛选' : '在配置台完成配置后，点右上角「保存为报价单」即可归档',
      `<button class="btn primary" onclick="location.hash='#/configurator'">前往配置台</button>`)}</div>`;
    return;
  }
  const rows = list.map(q => `<tr>
    <td><b>${esc(q.name)}</b></td>
    <td class="muted">${esc(q.version_name || '—')}</td>
    <td class="num">${q.item_count != null ? q.item_count : '—'}</td>
    <td class="num"><b>${fmt(q.total_cents)}</b></td><td class="muted">${esc(q.created_at)}</td>
    <td class="actions" style="margin:0">
      <button class="btn sm" onclick="viewQuote(${q.id})">查看</button>
      <button class="btn sm" onclick="exportQuote(${q.id},'xlsx')">Excel</button>
      <button class="btn sm" onclick="exportQuote(${q.id},'csv')">CSV</button>
      <button class="btn sm danger" onclick="delQuote(${q.id})">删</button></td></tr>`).join('');
  holder.innerHTML = `<table class="tbl"><thead><tr><th>名称</th><th>单价库版本</th><th class="num">行数</th><th class="num">含税总价(元)</th><th>创建时间</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}
window.exportQuote = async (id, fileFmt) => {
  if (fileFmt !== 'xlsx' && fileFmt !== 'csv') fileFmt = 'xlsx';
  // 后端模式下报价单存在 store.json，前端 STORE.quotes 为空；统一走 api 读取（A-1）
  let q = await api('GET', '/api/quotes/' + id);
  if (!q || !q.id) {
    const local = (STORE.quotes || []).find(x => x.id === id);
    q = local || null;
  }
  if (!q || !q.id) { toast('未找到该报价单，请刷新后重试'); return; }
  const items = q.items || [];
  const rows = [['信创服务器配置报价单'], ['报价名称：' + q.name], ['单价库版本：' + (q.version_name || '—')],
    ['税率：' + (parseFloat(q.tax_rate || 0) * 100).toFixed(0) + '%'], ['生成时间：' + q.created_at], []];
  rows.push(['序号', '类型', '名称/规格', '数量', '单价(元)', '小计(元)']);
  items.forEach((it, i) => rows.push([i + 1, it.type, it.title, it.qty, fmt(it.unit_cents), fmt(it.line_cents)]));
  const subtotal = items.reduce((s, it) => s + (it.line_cents || 0), 0);
  const tax = (q.tax_cents != null) ? q.tax_cents : (q.total_cents - subtotal);
  rows.push([]); rows.push(['', '', '', '', '不含税小计(元)', fmt(subtotal)]);
  rows.push(['', '', '', '', '税额(元)', fmt(tax)]);
  rows.push(['', '', '', '', '含税总价(元)', fmt(q.total_cents)]);
  if (fileFmt === 'xlsx') download('报价单_' + q.name + '_' + q.id + '.xlsx', buildXlsx([{ name: '报价单', rows }]));
  else download('报价单_' + q.name + '_' + q.id + '.csv', buildCsv(rows));
  // 埋点：报价导出（DLCR 第③环节的可测来源）；离线时事件排入本地队列，失败不影响导出
  try {
    await api('POST', '/api/events', { events: [{
      event_name: 'quote_export', payload: { quote_id: id, format: fileFmt, item_count: items.length } }] });
  } catch (e) { /* 忽略 */ }
};
window.delQuote = async (id) => {
  if (!await UI.confirm('确认删除该报价单？删除后无法恢复。',
    { title: '删除报价单', okText: '删除', danger: true })) return;
  await api('DELETE', '/api/quotes/' + id); await viewQuotes(); toast('已删除');
};
window.viewQuote = async (id) => {
  const q = await api('GET', '/api/quotes/' + id);
  if (!q || !q.id || !q.items) { toast('未找到该报价单，请刷新后重试'); return; }
  const rows = q.items.map((it, i) => `<tr><td>${i + 1}</td><td><span class="tag ${it.type === '虚拟机' ? '' : 'x86'}">${esc(it.type)}</span></td>
    <td>${esc(it.title)}</td><td class="num">${it.qty}</td><td class="num">${fmt(it.unit_cents)}</td><td class="num">${fmt(it.line_cents)}</td></tr>`).join('');
  const subtotal = q.items.reduce((s, it) => s + (it.line_cents || 0), 0);
  const tax = (q.tax_cents != null) ? q.tax_cents : (q.total_cents - subtotal);
  modal('报价单：' + q.name, `
    <p class="hint">单价库版本：${esc(q.version_name || '—')} ｜ 税率：${(parseFloat(q.tax_rate || 0) * 100).toFixed(0)}% ｜ 创建：${esc(q.created_at)}</p>
    <table><thead><tr><th>#</th><th>类型</th><th>名称/规格</th><th class="num">数量</th><th class="num">单价(元)</th><th class="num">小计(元)</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div style="margin-top:12px;text-align:right">
      <div class="muted">不含税小计：${fmt(subtotal)} 元</div>
      <div class="muted">税额：${fmt(tax)} 元</div>
      <div style="font-size:18px;font-weight:700;margin-top:4px">含税总价：${fmt(q.total_cents)} 元</div>
    </div>
    <div class="actions"><button class="btn" onclick="exportQuote(${q.id},'xlsx')">导出 Excel</button>
      <button class="btn" onclick="exportQuote(${q.id},'csv')">导出 CSV</button><button class="btn" onclick="closeModal()">关闭</button></div>`);
};

// ============================================================
// 资产侧视图（M1 台账 / M2 空间 / M3 rackview / M4 交付 / M6 导出 / M7 预校验）
//
// 为什么单独一块：售前侧看「报价口径」（单价库 / 配置台 / 报价单），
// 资产侧看「物理落位」（机房 / 机柜 / U 位 / 设备台账 / 交付批次）。
// 两类数据的字段、权限、导出模板都不同 —— 混在一页会让任何一方都看不清。
// ============================================================
const ASSET_STATE_LABEL = { planned: '待上架', ordered: '已到货', installed: '已上架', running: '运行中' };
const ASSET_ORIGIN_LABEL = { delivery: '交付批次', quote: '报价单', hwlib: '硬件清单', manual: '手工录入' };
const ASSET_RUNTIME_STATES = ['installed', 'running'];
const ASSET_PLAN_STATES = ['planned', 'ordered'];

/** 机型目录（脱敏）：资产侧选型用。单价库对非 sales 角色 403，
 *  但运维新增设备必须能选机型 —— 走目录接口只拿规格，不拿价格。 */
let _catalogCache = null;
async function loadCatalog() {
  if (_catalogCache) return _catalogCache;
  _catalogCache = await api('GET', '/api/catalog').catch(() => []);
  return _catalogCache;
}
function assetMachineName(catalog, skuId) {
  const m = (catalog || []).find(x => x.id === skuId);
  if (!m) return '机型#' + skuId;
  return ((m.brand || '') + ' ' + (m.model || '')).trim() || ('机型#' + skuId);
}

// ---------------- 视图：设备台账（M1） ----------------
async function viewAssetsDevices() {
  const [devices, racks, rooms, catalog] = await Promise.all([
    api('GET', '/api/devices').catch(() => []),
    api('GET', '/api/racks').catch(() => []),
    api('GET', '/api/rooms').catch(() => []),
    loadCatalog(),
  ]);
  // 采价反馈：交付/运维可提交实际采购价（采价权），但看不见库价、更不能发布版本
  let feedbacks = [];
  if (roleCan('read_price_feedback')) {
    feedbacks = await api('GET', '/api/price_feedback').catch(() => []);
  }
  const rackById = {}; racks.forEach(r => { rackById[r.id] = r; });
  const roomById = {}; rooms.forEach(r => { roomById[r.id] = r; });
  const locText = (d) => {
    if (!d.rack_id) return '未上架';
    const r = rackById[d.rack_id];
    const rm = r ? roomById[r.room_id] : null;
    const where = (rm ? rm.name + ' / ' : '') + (r ? (r.code || ('柜#' + r.id)) : ('柜#' + d.rack_id));
    return where + ' · U' + Number(d.u_start || 0) + '–' + (Number(d.u_start || 0) + Number(d.u_size || 1));
  };
  const n = (k) => devices.filter(d => d.state === k).length;
  const weak = devices.filter(d => !d.source_line_uid).length;
  const rows = devices.map(d => `<tr>
    <td><b>${esc(d.code || '—')}</b><div class="muted">${esc(d.sn || '未录 SN')}</div></td>
    <td>${esc(assetMachineName(catalog, d.sku_id))}<div class="muted">${esc(d.arch || '')}</div></td>
    <td>${esc(d.purpose || '—')}${d.role ? ' <span class="tag">' + esc(d.role) + '</span>' : ''}</td>
    <td><span class="state-tag st-${esc(d.state || 'planned')}">${esc(ASSET_STATE_LABEL[d.state] || d.state || '—')}</span></td>
    <td>${esc(locText(d))}<div class="muted">${Number(d.u_size || 1)}U · ${esc(d.u_size_source || 'rail')}</div></td>
    <td>${d.source_line_uid
      ? `<span class="tag">${esc(d.source_line_uid)}</span>`
      : '<span class="weak-anchor">弱锚点</span>'}
      <div class="muted">${esc(ASSET_ORIGIN_LABEL[d.origin] || d.origin || '—')}</div></td>
    <td class="actions" style="margin:0">
      ${roleCan('write_assets') ? `<button class="btn sm" onclick="editDevice(${d.id})">编辑</button>
      <button class="btn sm danger" onclick="delDevice(${d.id})">删</button>` : ''}</td></tr>`).join('');
  const emptyHtml = devices.length ? '' : UI.empty(Icons.server,
    '设备台账还是空的',
    '从「交付批次」生成，或直接在此新增一台设备 —— 只需填 SN、机柜与 U 位，机型规格自动带出',
    roleCan('write_assets') ? '<button class="btn primary" onclick="editDevice()">新增设备</button>' : '');

  $('#content').innerHTML = `<div class="card card-pad">
    <div class="toolbar"><div><h2 class="h2">设备台账</h2>
      <p class="hint">统一设备实例台账：SN、机柜 U 位、状态与用途在此一处维护，报价单与交付批次通过锚点回指到具体条目。</p></div>
      <div class="actions" style="margin:0">
        ${roleCan('write_assets') ? '<button class="btn primary" onclick="editDevice()">+ 新增设备</button>' : ''}
        ${roleCan('submit_price_feedback') ? '<button class="btn" onclick="openPriceFeedback()">+ 采价反馈</button>' : ''}
        <button class="btn" onclick="exportAssets()">导出台账（脱敏）</button></div></div>
    <div class="grid-3" style="margin:14px 0">
      <div class="stat"><div class="n">${devices.length}</div><div class="l">设备总数</div></div>
      <div class="stat"><div class="n">${n('planned') + n('ordered')}</div><div class="l">待上架</div></div>
      <div class="stat"><div class="n">${n('installed') + n('running')}</div><div class="l">已上架</div></div>
    </div>
    ${weak ? `<div class="hint" style="margin:0 0 10px">${weak} 台设备缺少报价锚点（source_line_uid）—— 属于弱锚点，回溯与对账时只能靠人工核对。</div>` : ''}
    <table class="tbl"><thead><tr><th>资产编号 / SN</th><th>机型</th><th>用途 / 主备</th><th>状态</th><th>机柜 · U 位</th><th>来源锚点</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>
    ${devices.length ? '' : emptyHtml}
    ${roleCan('read_price_feedback') ? `<h3 class="h3" style="margin-top:20px">采价反馈</h3>
      <div class="hint" style="margin:0 0 8px">采价权 ≠ 发布权：这里提交的是「实际采购价」这一不透明事实，采纳与否由售前决定。</div>
      ${feedbacks.length ? `<table class="tbl"><thead><tr><th>机型</th><th class="num">实际采购价(元)</th><th>来源</th><th>状态</th><th>提交人</th><th>时间</th></tr></thead>
        <tbody>${feedbacks.map(f => `<tr>
          <td>${esc(assetMachineName(catalog, f.sku_id))}</td>
          <td class="num">${f.actual_price_cents != null ? fmt(f.actual_price_cents) : '—'}</td>
          <td>${esc(f.source || '—')}</td>
          <td><span class="tag">${esc(f.status || 'submitted')}</span></td>
          <td>${esc(f.created_by || '—')}</td><td class="muted">${esc(f.at || '')}</td></tr>`).join('')}</tbody></table>`
        : '<p class="hint">尚无采价反馈记录。</p>'}` : ''}
  </div>`;
}

/** 提交采价反馈：实际采购价作为不透明事实提交，响应不回显库价 */
window.openPriceFeedback = async () => {
  const catalog = await loadCatalog();
  if (!catalog.length) { toast('机型目录为空：无法选择机型', 'err'); return; }
  const opts = catalog.map(m => `<option value="${m.id}">${esc(((m.brand || '') + ' ' + (m.model || '')).trim())}</option>`).join('');
  modal('提交采价反馈', `<div class="form-grid">
      <div class="field"><label>机型</label><select id="f_pfsku">${opts}</select></div>
      <div class="field"><label>实际采购价(元)</label><input id="f_pfprice" type="number" min="0" step="0.01" value="0"></div>
      <div class="field"><label>来源</label><input id="f_pfsrc" type="text" placeholder="如 供应商报价 / 框架协议"></div>
    </div>
    <p class="hint">你提交的是实际到手价，提交后只有你本人与售前可见；库价与定价版本发布权仍归售前。</p>`,
    `<button class="btn" onclick="closeModal()">取消</button>
     <button class="btn primary" onclick="submitPriceFeedback()">提交</button>`);
};
window.submitPriceFeedback = async () => {
  const body = {
    sku_id: +$('#f_pfsku').value,
    actual_price_cents: yuanToCents($('#f_pfprice').value),
    source: $('#f_pfsrc').value.trim(),
  };
  try { await api('POST', '/api/price_feedback', body); closeModal(); await viewAssetsDevices(); toast('已提交采价反馈'); }
  catch (e) { toast('提交失败：' + e.message, 'err'); }
};

/** 新增 / 编辑设备。机型规格由服务端带出，前端只填「哪台、哪个柜、第几 U」。 */
window.editDevice = async (id) => {
  const [catalog, racks, rooms] = await Promise.all([
    loadCatalog(), api('GET', '/api/racks').catch(() => []), api('GET', '/api/rooms').catch(() => []),
  ]);
  if (!catalog.length) {
    toast('机型目录为空：资产侧按当前生效版本取机型，请先在「单价库 · 物理机机型」录入机型', 'err');
    return;
  }
  let d = null;
  if (id) {
    const list = await api('GET', '/api/devices').catch(() => []);
    d = list.find(x => x.id === id) || null;
    if (!d) { toast('未找到该设备', 'err'); return; }
  }
  const rackOpts = ['<option value="">未上架（暂不指定位置）</option>'].concat(
    racks.map(r => {
      const rm = rooms.find(x => x.id === r.room_id);
      const label = (rm ? rm.name + ' / ' : '') + (r.code || ('柜#' + r.id)) + '（' + (r.u_total || 0) + 'U）';
      return `<option value="${r.id}"${d && d.rack_id === r.id ? ' selected' : ''}>${esc(label)}</option>`;
    })).join('');
  const skuOpts = catalog.map(m => {
    const u = machineUSize(m);
    const label = ((m.brand || '') + ' ' + (m.model || '')).trim() + ' · ' + (m.arch || '') + ' · ' + u.u_size + 'U';
    return `<option value="${m.id}"${d && d.sku_id === m.id ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
  const stateOpts = Object.keys(ASSET_STATE_LABEL).map(k =>
    `<option value="${k}"${d && d.state === k ? ' selected' : ''}>${ASSET_STATE_LABEL[k]}</option>`).join('');
  const roleOpts = ['主', '备', '单机'].map(r =>
    `<option value="${r}"${d && d.role === r ? ' selected' : ''}>${r}</option>`).join('');
  modal(d ? ('编辑设备 #' + d.id) : '新增设备', `
    <div class="form-grid">
      <div class="field"><label>机型（规格由服务端带出）</label><select id="f_sku">${skuOpts}</select></div>
      <div class="field"><label>资产编号</label><input id="f_code" type="text" value="${esc(d ? d.code || '' : '')}" placeholder="可选，如 ZC-2026-001"></div>
      <div class="field"><label>SN（序列号）</label><input id="f_sn" type="text" value="${esc(d ? d.sn || '' : '')}" placeholder="到货扫码录入"></div>
      <div class="field"><label>机柜</label><select id="f_rack">${rackOpts}</select></div>
      <div class="field"><label>U 位起点（0.5 步进）</label><input id="f_ustart" type="number" step="0.5" min="0" value="${d ? d.u_start || 0 : 0}"></div>
      <div class="field"><label>用途</label><input id="f_purpose" type="text" value="${esc(d ? d.purpose || '' : '')}" placeholder="如 数据库 / 接入层"></div>
      <div class="field"><label>主备角色</label><select id="f_role">${roleOpts}</select></div>
      <div class="field"><label>状态</label><select id="f_state">${stateOpts}</select></div>
      <div class="field"><label>功率(W)</label><input id="f_power" type="number" min="0" value="${d ? d.power_w || 0 : 0}"></div>
    </div>
    <p class="hint">高度（U）由机型自动带出，无需填写；同柜同一 U 位不可重复占用，冲突会在保存时拦截并标红。</p>`,
    `<button class="btn" onclick="closeModal()">取消</button>
     <button class="btn primary" onclick="saveDevice(${id || 0})">保存</button>`);
};
window.saveDevice = async (id) => {
  const body = {
    sku_id: +$('#f_sku').value,
    code: $('#f_code').value.trim(),
    sn: $('#f_sn').value.trim(),
    rack_id: +$('#f_rack').value || 0,
    u_start: Number($('#f_ustart').value) || 0,
    purpose: $('#f_purpose').value.trim(),
    role: $('#f_role').value,
    state: $('#f_state').value,
    power_w: Number($('#f_power').value) || 0,
  };
  try {
    if (id) await api('PUT', '/api/devices/' + id, body);
    else await api('POST', '/api/devices', body);
    closeModal(); await viewAssetsDevices(); toast('已保存');
  } catch (e) { toast('保存失败：' + e.message, 'err'); }
};
window.delDevice = async (id) => {
  if (!await UI.confirm('确认删除该设备？其 U 位占用将同时释放。',
    { title: '删除设备', okText: '删除', danger: true })) return;
  try { await api('DELETE', '/api/devices/' + id); await viewAssetsDevices(); toast('已删除'); }
  catch (e) { toast('删除失败：' + e.message, 'err'); }
};

/** 资产台账脱敏导出（M6）：列头与服务端写死的 7 列完全一致 —— 无单价、无税率、无含税价。 */
window.exportAssets = async () => {
  const exp = await api('GET', '/api/assets/export').catch(() => null);
  if (!exp || !exp.columns) { toast('导出失败：接口不可用', 'err'); return; }
  const rows = [['资产编号', '型号', 'SN', '机房', '机柜', 'U位', '状态']];
  (exp.rows || []).forEach(r => rows.push(r));
  download('资产台账_' + new Date().toISOString().slice(0, 10) + '.csv', buildCsv(rows));
  toast('已导出（脱敏版：不含单价、税率、含税价）');
};

// ---------------- 视图：机房 · 机柜（M2） ----------------
async function viewAssetsSpace() {
  const [rooms, racks, devices, units] = await Promise.all([
    api('GET', '/api/rooms').catch(() => []),
    api('GET', '/api/racks').catch(() => []),
    api('GET', '/api/devices').catch(() => []),
    api('GET', '/api/rack_units').catch(() => []),
  ]);
  const usedByRack = {};
  units.forEach(u => { usedByRack[u.rack_id] = (usedByRack[u.rack_id] || 0) + 1; });
  const powerByRack = {};
  devices.forEach(d => {
    if (!d.rack_id) return;
    powerByRack[d.rack_id] = (powerByRack[d.rack_id] || 0) + Number(d.power_w || 0);
  });
  const totalU = racks.reduce((s, r) => s + Number(r.u_total || 0), 0);
  const usedU = Object.keys(usedByRack).reduce((s, k) => s + usedByRack[k], 0) / 2;
  const rackRows = racks.map(r => {
    const rm = rooms.find(x => x.id === r.room_id);
    const u = Number(r.u_total || 0);
    const used = (usedByRack[r.id] || 0) / 2;
    const rate = u > 0 ? Math.round(used / u * 100) : 0;
    const pw = powerByRack[r.id] || 0, cap = Number(r.power_capacity_w || 0);
    return `<tr>
      <td><b>${esc(r.code || '—')}</b><div class="muted">${esc(rm ? rm.name : '未归属机房')}</div></td>
      <td class="num">${u}U</td>
      <td class="num">${used}U<div class="muted">${rate}%</div></td>
      <td class="num">${cap ? esc(String(Math.round(pw))) + ' / ' + esc(String(cap)) + ' W' : '未配置容量'}</td>
      <td class="actions" style="margin:0">
        <button class="btn sm" onclick="location.hash='#/assets/rackview?rack=${r.id}'">U 位视图</button>
        ${roleCan('write_assets') ? `<button class="btn sm" onclick="editRack(${r.id})">编辑</button>` : ''}</td></tr>`;
  }).join('');
  const roomRows = rooms.map(r => `<tr>
    <td><b>${esc(r.name || '—')}</b></td>
    <td>${esc(r.building || '')}</td><td class="num">${esc(String(r.floor ?? '—'))}</td>
    <td class="num">${r.capacity_kw ? esc(String(r.capacity_kw)) + ' kW' : '—'}</td>
    <td class="num">${racks.filter(x => x.room_id === r.id).length}</td></tr>`).join('');

  $('#content').innerHTML = `<div class="card card-pad">
    <div class="toolbar"><div><h2 class="h2">机房 · 机柜</h2>
      <p class="hint">物理空间模型：机房 → 机柜 → U 位。同柜同一 U 位不可重复占用，冲突分「行级重叠 / 超出柜总高 / 功率超容」三类单列。</p></div>
      <div class="actions" style="margin:0">
        ${roleCan('write_assets') ? '<button class="btn" onclick="editRoom()">+ 机房</button><button class="btn primary" onclick="editRack()">+ 机柜</button>' : ''}</div></div>
    <div class="grid-3" style="margin:14px 0">
      <div class="stat"><div class="n">${rooms.length}</div><div class="l">机房</div></div>
      <div class="stat"><div class="n">${racks.length}</div><div class="l">机柜</div></div>
      <div class="stat"><div class="n">${totalU ? Math.round(usedU / totalU * 100) : 0}%</div><div class="l">整体 U 位占用率</div></div>
    </div>
    <h3 class="h3">机柜</h3>
    ${racks.length ? `<table class="tbl"><thead><tr><th>机柜</th><th class="num">总高</th><th class="num">已占用</th><th class="num">功率</th><th></th></tr></thead>
      <tbody>${rackRows}</tbody></table>`
      : UI.empty(Icons.server, '还没有机柜', '先建机房，再在机房下建机柜（如 42U 标准柜），之后设备才有可落位的空间',
          roleCan('write_assets') ? '<button class="btn primary" onclick="editRack()">新建机柜</button>' : '')}
    <h3 class="h3" style="margin-top:20px">机房</h3>
    ${rooms.length ? `<table class="tbl"><thead><tr><th>名称</th><th>楼栋</th><th class="num">楼层</th><th class="num">配电容量</th><th class="num">机柜数</th></tr></thead>
      <tbody>${roomRows}</tbody></table>` : '<p class="hint">尚未建立机房。</p>'}
  </div>`;
}
window.editRoom = () => {
  modal('新增机房', `<div class="form-grid">
      <div class="field"><label>名称</label><input id="f_rname" type="text" placeholder="如 A栋 301"></div>
      <div class="field"><label>楼栋</label><input id="f_rb" type="text" placeholder="如 A"></div>
      <div class="field"><label>楼层</label><input id="f_rf" type="number" value="1"></div>
      <div class="field"><label>配电容量(kW)</label><input id="f_rk" type="number" min="0" value="0"></div>
    </div>`, `<button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" onclick="saveRoom()">保存</button>`);
};
window.saveRoom = async () => {
  const body = { name: $('#f_rname').value.trim(), building: $('#f_rb').value.trim(),
    floor: Number($('#f_rf').value) || 0, capacity_kw: Number($('#f_rk').value) || 0 };
  try { await api('POST', '/api/rooms', body); closeModal(); await viewAssetsSpace(); toast('已新建机房'); }
  catch (e) { toast('保存失败：' + e.message, 'err'); }
};
window.editRack = async (id) => {
  const rooms = await api('GET', '/api/rooms').catch(() => []);
  let r = null;
  if (id) {
    const list = await api('GET', '/api/racks').catch(() => []);
    r = list.find(x => x.id === id) || null;
  }
  const roomOpts = rooms.map(x => `<option value="${x.id}"${r && r.room_id === x.id ? ' selected' : ''}>${esc(x.name || ('机房#' + x.id))}</option>`).join('');
  modal(id ? ('编辑机柜 #' + id) : '新增机柜', `<div class="form-grid">
      <div class="field"><label>所属机房</label><select id="f_kroom">${roomOpts || '<option value="">（请先建机房）</option>'}</select></div>
      <div class="field"><label>机柜编码</label><input id="f_kcode" type="text" value="${esc(r ? r.code || '' : '')}" placeholder="如 A-3"></div>
      <div class="field"><label>总高(U)</label><input id="f_ktotal" type="number" min="1" value="${r ? r.u_total || 42 : 42}"></div>
      <div class="field"><label>功率容量(W)</label><input id="f_kpw" type="number" min="0" value="${r ? r.power_capacity_w || 0 : 0}"></div>
    </div>`, `<button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" onclick="saveRack(${id || 0})">保存</button>`);
};
window.saveRack = async (id) => {
  const body = { room_id: +$('#f_kroom').value || 0, code: $('#f_kcode').value.trim(),
    u_total: Number($('#f_ktotal').value) || 0, power_capacity_w: Number($('#f_kpw').value) || 0 };
  try {
    if (id) await api('PUT', '/api/racks/' + id, body);
    else await api('POST', '/api/racks', body);
    closeModal(); await viewAssetsSpace(); toast('已保存');
  } catch (e) { toast('保存失败：' + e.message, 'err'); }
};

// ---------------- 视图：U 位视图（M3） ----------------
/**
 * 机柜正视 U 位图。服务端判定占用与冲突，前端只渲染。
 * 0.5 网格：每个半 U 槽位一行（SLOT_H = UNIT_H / 2），
 * 整 U 设备跨两个槽位、半 U 设备只占一个 —— 二者不错位半格。
 */
function renderRackViewSvg(rv) {
  const UNIT_H = 16;          // 1U 的像素高度
  const SLOT_H = UNIT_H / 2; // 半 U 槽位高度（0.5 网格）
  const PAD_L = 34, PAD_T = 6, W = 236;
  const slots = (rv && rv.slots) || [];
  const H = PAD_T + slots.length * SLOT_H + 8;
  const x = PAD_L, w = W - PAD_L - 8;
  let cells = '';
  let ticks = '';
  let labels = '';
  slots.forEach((s, i) => {
    const y = PAD_T + i * SLOT_H;
    let fill = '#f6f7f9', stroke = '#e6e8ec';
    if (s.occupancy === 'occupied') { fill = '#e5484d'; stroke = '#c8383d'; }
    else if (s.occupancy === 'reserved') { fill = '#f2c94c'; stroke = '#d4a92c'; }
    cells += `<rect x="${x}" y="${y}" width="${w}" height="${SLOT_H - 0.5}" fill="${fill}" stroke="${stroke}" stroke-width="0.4"/>`;
    // 整 U 边界刻度（每 2 个槽位 = 1U）
    if (i % 2 === 0) {
      const u = s.u_index / 2;
      ticks += `<line x1="${x - 4}" y1="${y}" x2="${x}" y2="${y}" stroke="#b9bfc7" stroke-width="0.6"/>`;
      if (u % 4 === 0) labels += `<text x="${x - 6}" y="${y + SLOT_H}" text-anchor="end" font-size="7" fill="#8b929c">U${u}</text>`;
    }
    // 设备标签：只在设备的第一个槽位上写一次
    if (s.device && s.occupancy === 'occupied' && (s.device.u_size || 1) >= 1) {
      const top = Math.round(Number(s.device.u_start || 0) * 2) === s.u_index;
      if (top) {
        const label = (s.device.code || s.device.sn || '设备').slice(0, 16);
        labels += `<text x="${x + 4}" y="${y + SLOT_H - 1.5}" font-size="6.5" fill="#fff">${esc(label)}</text>`;
      }
    }
  });
  return `<svg class="rack-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="机柜 U 位占用图">
    <rect x="${x - 2}" y="${PAD_T - 2}" width="${w + 4}" height="${slots.length * SLOT_H + 4}" fill="none" stroke="#c9ced6" stroke-width="1"/>
    ${cells}${ticks}${labels}</svg>`;
}
async function viewAssetsRackview() {
  const racks = await api('GET', '/api/racks').catch(() => []);
  if (!racks.length) {
    $('#content').innerHTML = `<div class="card card-pad">${UI.empty(Icons.server,
      '还没有机柜可看', '先到「机房 · 机柜」建立机柜并录入 U 位占用，再回来看 U 位图',
      '<button class="btn primary" onclick="location.hash=\'#/assets/space\'">前往机房 · 机柜</button>')}</div>`;
    return;
  }
  // 支持 #/assets/rackview?rack=<id> 直接定位到某个柜
  const q = (location.hash.split('?')[1] || '');
  const qid = parseInt((q.split('&').find(p => p.split('=')[0] === 'rack') || ['', '0'])[1], 10) || 0;
  const rackId = qid || racks[0].id;
  const rv = await api('GET', '/api/rackview?rack_id=' + rackId).catch(() => null);
  if (!rv || !rv.rack) {
    $('#content').innerHTML = `<div class="card card-pad">${UI.empty(Icons.warn, '无法读取该机柜的 U 位数据',
      '请确认机柜已录入总高（U）后重试', '<button class="btn" onclick="location.hash=\'#/assets/space\'">返回机房 · 机柜</button>')}</div>`;
    return;
  }
  const rackOpts = racks.map(r => `<option value="${r.id}"${r.id === rackId ? ' selected' : ''}>${esc(r.code || ('柜#' + r.id))}</option>`).join('');
  const c = rv.conflicts || {};
  const cBlocks = [
    ['c-overlap', '行级重叠（位置冲突）', c.overlap || []],
    ['c-height', '超出柜总高（非法位置）', c.over_height || []],
    ['c-power', '功率超容（资源冲突，不计入 U 位冲突率）', c.power_over || []],
  ].filter(x => x[2].length);
  const occ = rv.occupancy || {};
  const power = rv.power || {};
  $('#content').innerHTML = `<div class="card card-pad">
    <div class="toolbar"><div><h2 class="h2">U 位视图</h2>
      <p class="hint">机柜正视 U 位图：红色为已占用位，黄色为预留位。冲突判定在服务端完成（占用账本逐行唯一），前端只渲染。</p></div>
      <div class="actions" style="margin:0">
        <label class="tb-sel"><span>机柜</span><select onchange="gotoRackView(this.value)">${rackOpts}</select></label></div></div>
    <div class="grid-3" style="margin:14px 0">
      <div class="stat"><div class="n">${occ.used_slots ?? 0}/${occ.total_slots ?? 0}</div><div class="l">已占用半 U 槽位</div></div>
      <div class="stat"><div class="n">${power.capacity_w ? Math.round(power.used_w || 0) + ' / ' + power.capacity_w : '未配置'}</div><div class="l">功率占用(W)</div></div>
      <div class="stat"><div class="n">${(c.overlap || []).length + (c.over_height || []).length}</div><div class="l">位置冲突数</div></div>
    </div>
    ${cBlocks.length ? `<div class="conflict-list">${cBlocks.map(b => `<div class="conflict-block ${b[0]}">
        <div class="conflict-title">${esc(b[1])}（${b[2].length}）</div>
        <ul>${b[2].slice(0, 8).map(x => `<li>${esc(JSON.stringify(x))}</li>`).join('')}</ul></div>`).join('')}</div>`
      : '<p class="hint">当前机柜无冲突。</p>'}
    <div style="margin-top:14px">${renderRackViewSvg(rv)}</div>
  </div>`;
}
window.gotoRackView = (rackId) => { location.hash = '#/assets/rackview?rack=' + rackId; };

// ---------------- 视图：交付批次（M4） ----------------
async function viewAssetsDeliveries() {
  const [deliveries, racks] = await Promise.all([
    api('GET', '/api/deliveries').catch(() => []),
    api('GET', '/api/racks').catch(() => []),
  ]);
  const rackById = {}; racks.forEach(r => { rackById[r.id] = r; });
  const rows = deliveries.map(d => {
    const r = d.target_rack_id ? rackById[d.target_rack_id] : null;
    return `<tr>
      <td><b>${esc(d.name || ('DEL-' + d.id))}</b><div class="muted">${esc(d.generated_at || '')}</div></td>
      <td>${d.quote_id ? '报价单 #' + esc(String(d.quote_id)) : '—'}</td>
      <td>${r ? esc(r.code || ('柜#' + r.id)) : '未指定'}</td>
      <td class="num">${(d.devices || []).length || d.device_count || 0}</td>
      <td><span class="state-tag st-planned">待上架</span></td>
      <td class="actions" style="margin:0">
        <button class="btn sm" onclick="viewDelivery(${d.id})">展开</button></td></tr>`;
  }).join('');
  $('#content').innerHTML = `<div class="card card-pad">
    <div class="toolbar"><div><h2 class="h2">交付批次</h2>
      <p class="hint">报价单按行拆成 N 台设备实例并预分配 U 位，形成待上架批次。到货扫码录 SN 后在设备台账改状态。</p></div>
      <div class="actions" style="margin:0">
        ${roleCan('manage_deliveries') ? '<button class="btn primary" onclick="genDelivery()">从报价单生成</button>' : ''}</div></div>
    ${deliveries.length ? `<table class="tbl"><thead><tr><th>批次</th><th>来源报价单</th><th>目标机柜</th><th class="num">设备数</th><th>状态</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`
      : UI.empty(Icons.truck, '还没有交付批次', '在报价单上点「生成交付清单」，系统会按行拆成设备并预分配 U 位',
          roleCan('manage_deliveries') ? '<button class="btn primary" onclick="genDelivery()">从报价单生成</button>' : '')}
  </div>`;
}
window.genDelivery = async () => {
  const quotes = await api('GET', '/api/quotes').catch(() => []);
  const racks = await api('GET', '/api/racks').catch(() => []);
  if (!quotes.length) { toast('还没有报价单：交付批次由报价单按行拆解生成', 'err'); return; }
  if (!racks.length) { toast('还没有机柜：设备需要落位，请先建立机柜', 'err'); return; }
  const qOpts = quotes.map(q => `<option value="${q.id}">${esc(q.name || ('报价单#' + q.id))}（${q.item_count || 0} 条）</option>`).join('');
  const rOpts = racks.map(r => `<option value="${r.id}">${esc(r.code || ('柜#' + r.id))}（${r.u_total || 0}U）</option>`).join('');
  modal('从报价单生成交付批次', `<div class="form-grid">
      <div class="field"><label>报价单</label><select id="f_dq">${qOpts}</select></div>
      <div class="field"><label>目标机柜</label><select id="f_drack">${rOpts}</select></div>
    </div>
    <p class="hint">按报价条目「物理机」行展开为设备实例，虚拟机不占物理 U 位；U 位在目标柜内自动避让已占位。</p>`,
    `<button class="btn" onclick="closeModal()">取消</button>
     <button class="btn" onclick="genDeliveryDry()">仅预演</button>
     <button class="btn primary" onclick="genDeliveryGo()">生成</button>`);
};
window.genDeliveryDry = async () => {
  try {
    const d = await api('POST', '/api/deliveries', {
      quote_id: +$('#f_dq').value, target_rack_id: +$('#f_drack').value, dry_run: true });
    closeModal();
    modal('预演结果', `<p class="hint">按当前占用账本预演（不写库）：将展开 ${d.device_count || 0} 台设备。
      ${(d.conflicts && d.conflicts.overlap && d.conflicts.overlap.length) ? '存在 ' + d.conflicts.overlap.length + ' 处无可行解位。' : '未发现位置冲突。'}</p>`,
      '<button class="btn primary" onclick="closeModal()">知道了</button>');
  } catch (e) { toast('预演失败：' + e.message, 'err'); }
};
window.genDeliveryGo = async () => {
  try {
    const d = await api('POST', '/api/deliveries', {
      quote_id: +$('#f_dq').value, target_rack_id: +$('#f_drack').value });
    closeModal(); await viewAssetsDeliveries();
    toast('已生成 ' + (d.device_count || 0) + ' 台设备');
  } catch (e) { toast('生成失败：' + e.message, 'err'); }
};
window.viewDelivery = async (id) => {
  const d = await api('GET', '/api/deliveries/' + id).catch(() => null);
  if (!d || !d.id) { toast('未找到该交付批次', 'err'); return; }
  const devs = d.devices || [];
  const rows = devs.map(x => `<tr>
    <td>${esc(x.sn || '未录 SN')}</td>
    <td>${esc(x.arch || '')}</td>
    <td>${esc(x.purpose || '—')}${x.role ? ' · ' + esc(x.role) : ''}</td>
    <td>${x.rack_id ? '柜#' + esc(String(x.rack_id)) + ' · U' + Number(x.u_start || 0) : '未分配'}</td>
    <td>${esc(x.source_line_uid || '')}</td></tr>`).join('');
  modal('交付批次：' + (d.name || ('DEL-' + d.id)), `
    <p class="hint">来源报价单 ${d.quote_id ? '#' + esc(String(d.quote_id)) : '—'} ｜ 设备 ${devs.length} 台 ｜ 生成于 ${esc(d.generated_at || '')}</p>
    ${devs.length ? `<table><thead><tr><th>SN</th><th>架构</th><th>用途</th><th>位置</th><th>锚点</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="hint">该批次暂无设备明细。</p>'}`,
    '<button class="btn primary" onclick="closeModal()">关闭</button>');
};

// ---------------- 视图：资产侧概览（非售前角色） ----------------
/**
 * 管理层（viewer）：报价总价汇总 + 资产落位概览，不含任何明细价格。
 * 交付 / 运维（delivery / ops）：物理落位、U 位占用与冲突，不含任何价格。
 */
async function viewAssetsDashboard(role) {
  const [devices, racks, rooms, deliveries] = await Promise.all([
    api('GET', '/api/devices').catch(() => []),
    api('GET', '/api/racks').catch(() => []),
    api('GET', '/api/rooms').catch(() => []),
    api('GET', '/api/deliveries').catch(() => []),
  ]);
  let quotes = [];
  if (role === 'viewer') {
    // viewer 读报价走服务端投影（只有含税总价汇总，无条目明细）
    quotes = await api('GET', '/api/quotes').catch(() => []);
  }
  const totalU = racks.reduce((s, r) => s + Number(r.u_total || 0), 0);
  const usedU = devices.filter(d => d.rack_id)
    .reduce((s, d) => s + Number(d.u_size || 1), 0);
  const runtime = devices.filter(d => ASSET_RUNTIME_STATES.indexOf(d.state) >= 0).length;
  const pending = devices.filter(d => ASSET_PLAN_STATES.indexOf(d.state) >= 0).length;
  const totalCents = quotes.reduce((s, q) => s + Number(q.total_cents || 0), 0);
  const cards = [
    { lbl: '设备总数', val: devices.length, unit: '台', foot: `待上架 ${pending} · 运行态 ${runtime}`, c: 'var(--brand-d)', ico: Icons.server, view: 'assets/devices' },
    { lbl: '机柜数', val: racks.length, unit: '个', foot: `机房 ${rooms.length} 个 · 总 ${totalU}U`, c: 'var(--info)', ico: Icons.grid, view: 'assets/space' },
    { lbl: 'U 位占用率', val: totalU ? Math.round(usedU / totalU * 100) : 0, unit: '%', foot: `已占用 ${usedU}U / ${totalU}U`, c: 'var(--warn)', ico: Icons.chart, view: 'assets/rackview' },
    { lbl: '交付批次', val: deliveries.length, unit: '批', foot: '报价单按行拆分为设备实例', c: 'var(--text-1)', ico: Icons.truck, view: 'assets/deliveries' },
  ];
  if (role === 'viewer') {
    cards.push({ lbl: '报价单含税总价', val: fmt(totalCents), unit: '元', foot: `${quotes.length} 份报价单（仅汇总，不含明细）`, c: 'var(--brand-d)', ico: Icons.doc, view: 'quotes' });
  }
  const statCards = cards.map(c => `
    <div class="stat clickable v-brand" style="--c:${c.c}" onclick="location.hash='#/${c.view}'">
      <span class="stat-go">${Icons.arrow}</span>
      <div class="stat-lbl">${c.ico}<span>${esc(c.lbl)}</span></div>
      <div class="stat-val" style="color:${c.c}">${esc(String(c.val))}<small>${esc(c.unit)}</small></div>
      <div class="stat-foot">${esc(c.foot)}</div>
    </div>`).join('');
  const todos = [];
  if (!racks.length) todos.push({ k: 'danger', t: '尚未建立机柜，设备无处落位', v: '去建立', view: 'assets/space' });
  if (pending) todos.push({ k: 'warn', t: `${pending} 台设备处于待上架状态`, v: '去上架', view: 'assets/devices' });
  if (!deliveries.length) todos.push({ k: 'ok', t: '尚未生成交付批次', v: '去生成', view: 'assets/deliveries' });
  const weak = devices.filter(d => !d.source_line_uid).length;
  if (weak) todos.push({ k: 'warn', t: `${weak} 台设备缺少报价锚点（弱锚点）`, v: '去核对', view: 'assets/devices' });
  const todoHtml = todos.length ? todos.map(t => `
    <div class="todo-item" onclick="location.hash='#/${t.view}'">
      <span class="todo-dot ${t.k}"></span><span class="todo-t">${esc(t.t)}</span><span class="todo-v">${esc(t.v)} →</span>
    </div>`).join('') : UI.empty(Icons.warn, '没有待处理事项', '资产台账状态正常');
  const quoteRows = quotes.length ? quotes.map(q => `
    <tr><td><b>${esc(q.name || '—')}</b></td>
      <td class="num">${q.item_count != null ? q.item_count : '—'}</td>
      <td class="num"><b>${fmt(q.total_cents || 0)}</b></td>
      <td class="muted">${esc(q.created_at || '')}</td></tr>`).join('') : '';
  $('#content').innerHTML = `
  <div class="dash-grid">${statCards}</div>
  <div class="dash-section"><h2>待办与风险</h2><span class="sub">${esc(roleLabel(role))}视角</span></div>
  <div class="dash-2col">
    <div class="card">
      <div class="card-head" style="padding:14px 18px 0"><h3 class="h3" style="margin:0">需要关注</h3></div>
      <div class="card-body"><div class="todo-list">${todoHtml}</div></div>
    </div>
    <div class="card">
      <div class="card-head" style="padding:14px 18px 0"><h3 class="h3" style="margin:0">角色可见范围</h3></div>
      <div class="card-body"><div class="hint">${esc(roleScopeText(role))}</div></div>
    </div>
  </div>
  ${role === 'viewer' ? `<div class="dash-section"><h2>报价总价汇总</h2>
    <span class="sub">仅含税总价与条目数，不含条目明细</span></div>
  <div class="card">
    ${quotes.length ? `<table class="tbl"><thead><tr><th>名称</th><th class="num">条目</th><th class="num">含税总价(元)</th><th>创建时间</th></tr></thead>
      <tbody>${quoteRows}</tbody></table>` : UI.empty(Icons.doc, '还没有报价单', '报价单保存后，这里只显示含税总价汇总')}
  </div>` : ''}`;
}
function roleLabel(role) {
  const hit = ROLE_OPTIONS.find(o => o.v === role);
  return hit ? hit.label : role;
}
function roleScopeText(role) {
  if (role === 'viewer') return '管理层视角：可见报价单含税总价汇总与资产落位概览；条目明细、单价库与采价记录不可见。';
  if (role === 'delivery') return '交付视角：可见设备台账、机房机柜、U 位视图与交付批次；单价库与报价单不可见（服务端 403）。';
  return '运维视角：可见设备台账、机房机柜、U 位视图；可提交采价反馈与上架预校验；单价库与报价单不可见（服务端 403）。';
}

// ---------------- 上架可行性预校验（M7） ----------------
/** 预校验按「配置台的物理机行」计算上架需求，只读空间模型，不写任何数据。 */
let _pcLines = [];
window.openPlacementCheck = async () => {
  const racks = await api('GET', '/api/racks').catch(() => []);
  if (!racks.length) {
    toast('还没有机柜：预校验需要先建立机柜并录入 U 位占用', 'err');
    return;
  }
  _pcLines = CFG.phys.map(l => ({ machine_id: l.machineId, qty: l.qty || 1 }));
  if (!_pcLines.length) {
    toast('配置台还没有物理机行：预校验按物理机行计算上架需求', 'warn');
    return;
  }
  const qty = _pcLines.reduce((s, l) => s + l.qty, 0);
  const opts = racks.map(r => `<option value="${r.id}">${esc(r.code || ('柜#' + r.id))}（${r.u_total || 0}U）</option>`).join('');
  modal('上架可行性预校验', `<div class="form-grid">
      <div class="field"><label>目标机柜</label><select id="f_pcrack">${opts}</select></div>
    </div>
    <div class="hint">按配置台 ${_pcLines.length} 行物理机（共 ${qty} 台）做只读预校验：只算不写 —— 不改设备、不改占用账本、不改报价。</div>`,
    `<button class="btn" onclick="closeModal()">取消</button>
     <button class="btn primary" onclick="runPlacementCheck()">开始校验</button>`);
};
window.runPlacementCheck = async () => {
  try {
    const v = await api('POST', '/api/space/validate', {
      rack_id: +$('#f_pcrack').value, lines: _pcLines });
    closeModal();
    showPlacementResult(v);
  } catch (e) { toast('校验失败：' + e.message, 'err'); }
};
function showPlacementResult(v) {
  const c = v.conflicts || {};
  const cnt = (k) => (c[k] || []).length;
  const blocks = [
    ['c-overlap', '行级重叠（位置冲突，计入 U 位冲突率）', c.overlap || []],
    ['c-height', '超出柜总高（非法位置率，单列）', c.over_height || []],
    ['c-power', '功率超容（资源冲突，不计入 U 位冲突率）', c.power_over || []],
  ];
  const degraded = v.mode !== 'spatial';
  const rate = (v.u_conflict_rate != null ? (v.u_conflict_rate * 100).toFixed(1) : '0.0');
  modal('预校验结果', `
    <p class="hint">模式：<b>${degraded ? '纸面校验（空间数据不足）' : '空间校验'}</b> ｜ 待上架 ${v.onboarded_device_count || 0} 台
      ｜ 冲突设备 ${v.conflict_device_count || 0} 台 ｜ U 位冲突率 ${rate}%
      ｜ 无可行解位比例 ${((v.infeasible_ratio || 0) * 100).toFixed(1)}%</p>
    ${degraded ? '<div class="conflict-block c-height"><div class="conflict-title">空间数据完整率不足，已降级为纸面校验</div><ul>' +
      (v.notes || []).map(n => `<li>${esc(n)}</li>`).join('') + '</ul></div>' : ''}
    ${blocks.filter(b => b[2].length).map(b => `<div class="conflict-block ${b[0]}">
        <div class="conflict-title">${esc(b[1])}（${b[2].length}）</div>
        <ul>${b[2].slice(0, 10).map(x => `<li>${esc(JSON.stringify(x))}</li>`).join('')}</ul></div>`).join('')}
    ${!blocks.some(b => b[2].length) && !degraded ? '<p class="hint">未发现位置冲突，该批次可在目标柜上架。</p>' : ''}
    <p class="hint">指标口径：U 位冲突率 = 冲突设备数 ÷ 上架设备数（不用「拦截次数÷尝试次数」，后者含重试会被放大）。</p>`,
    '<button class="btn primary" onclick="closeModal()">知道了</button>');
}

// ---------------- 视图：架构梳理 ----------------
async function viewArch() {
  await reloadLib();
  migrateCfg();
  const nodes = topoNodes();
  const byId = {}; nodes.forEach(n => byId[n.id] = n);
  const linkedDeploys = (kind, lineId) => {
    const prefix = kind === 'phys' ? ('p_' + lineId + '_') : ('v_' + lineId);
    const set = new Set();
    (CFG.links || []).forEach(([a, b]) => {
      let other = null;
      if (a.startsWith(prefix) && !b.startsWith(prefix)) other = b;
      else if (b.startsWith(prefix) && !a.startsWith(prefix)) other = a;
      if (other && byId[other]) set.add(byId[other].deploy || '未标注');
    });
    return [...set];
  };
  const physN = CFG.phys.reduce((s, l) => s + (l.qty || 1), 0);
  const vmN = CFG.vm.reduce((s, l) => s + (l.qty || 1), 0);
    const groupOpts = purposeGroups().map(g => `<option value="${esc(g.name)}">${esc(g.name)}</option>`).join('');
  const rows = [];
  CFG.phys.forEach(l => {
    const m = S.machines.find(x => x.id === l.machineId); if (!m) return;
    const ld = linkedDeploys('phys', l.id);
    rows.push(`<tr>
      <td><input list="purposeRegistryList" value="${esc(l.purpose || '')}" onchange="archChPurpose('${l.id}','phys',this.value)" placeholder="用途"><div class="muted">${esc(deployDisplay(l) || '未标注')}</div></td>
      <td><select onchange="archChGroup('${l.id}','phys',this.value)"><option value="">归入分组…</option>${groupOpts}</select></td>
      <td><span class="tag x86">物理机</span></td>
      <td>${esc(m.brand + ' ' + m.model)}</td><td class="num">${l.qty}</td><td class="num">${fmt(physUnitCents(l))}</td>
      <td class="num">${fmt(physUnitCents(l) * l.qty)}</td><td class="muted">${ld.length ? ld.map(esc).join('、') : '—'}</td></tr>`);
  });
  CFG.vm.forEach(l => {
    const ld = linkedDeploys('vm', l.id);
    rows.push(`<tr>
      <td><input list="purposeRegistryList" value="${esc(l.purpose || '')}" onchange="archChPurpose('${l.id}','vm',this.value)" placeholder="用途"><div class="muted">${esc(deployDisplay(l) || '未标注')}</div></td>
      <td><select onchange="archChGroup('${l.id}','vm',this.value)"><option value="">归入分组…</option>${groupOpts}</select></td>
      <td><span class="tag">虚拟机</span></td>
      <td>${l.cpu}C/${l.mem}G/${l.sto}G${l.flavor ? '（' + esc(l.flavor) + '）' : ''}</td><td class="num">${l.qty}</td><td class="num">${fmt(vmUnitCents(l))}</td>
      <td class="num">${fmt(vmUnitCents(l) * l.qty)}</td><td class="muted">${ld.length ? ld.map(esc).join('、') : '—'}</td></tr>`);
  });
  const linkRows = [];
  (CFG.links || []).forEach(([a, b]) => {
    const na = byId[a], nb = byId[b]; if (!na || !nb) return;
    linkRows.push(`<tr><td>${esc(na.no)}<div class="muted">${esc(na.deploy || '未标注')}</div></td>
      <td style="text-align:center;color:var(--brand)">⇄</td>
      <td>${esc(nb.no)}<div class="muted">${esc(nb.deploy || '未标注')}</div></td></tr>`);
  });
  $('#content').innerHTML = `<div class="card card-pad">
    <div class="toolbar"><div><h2 class="h2">架构梳理</h2><p class="hint">依据「配置台 → 拓扑白板」中每台服务器的部署组件与互联关系，自动汇总业务系统的部署组件、资源类型与服务器数量。请在拓扑白板中标注部署组件并建立连线。</p></div>
      ${FEATURES.archDiagram ? '<div class="actions" style="margin:0"><button class="btn primary" onclick="location.hash=\'#/arch-diagram\'">打开架构图（draw.io）</button></div>' : ''}</div>
    <div class="grid-3" style="margin:14px 0">
      <div class="stat"><div class="n">${nodes.length}</div><div class="l">服务器节点</div></div>
      <div class="stat"><div class="n">${physN + vmN}</div><div class="l">服务器总台数</div></div>
      <div class="stat"><div class="n">${(CFG.links || []).length}</div><div class="l">互联关系</div></div>
    </div>
    <h3 class="h3">一、部署组件 / 资源清单</h3>
    <table><thead><tr><th>部署组件(用途)</th><th>归入分组</th><th>资源类型</th><th>规格 / 机型</th><th class="num">数量</th><th class="num">单价(元)</th><th class="num">小计(元)</th><th>互联组件</th></tr></thead>
    <tbody>${rows.join('') || '<tr><td colspan="8">${UI.empty(Icons.box, "尚未在配置台添加任何服务器", "配置台的每一行都会在这里汇总为部署架构")}</td></tr>'}</tbody></table>
    <datalist id="purposeRegistryList">${purposeRegistry().map(p => `<option value="${esc(p)}">`).join('')}</datalist>
    <h3 class="h3" style="margin-top:18px">二、拓扑互联关系</h3>
    ${linkRows.length ? `<table><thead><tr><th>节点 A（部署组件）</th><th></th><th>节点 B（部署组件）</th></tr></thead><tbody>${linkRows.join('')}</tbody></table>` : '<p class="muted">尚未在拓扑白板中建立任何连线。进入「配置台 → 拓扑白板 → 连线模式」，点选两个节点即可建立互联关系。</p>'}
    <p class="hint" style="margin-top:12px">说明：本页由拓扑白板自动提取，不再支持手工导入；部署组件与互联关系请在「配置台」维护。</p>
  </div>`;
}
// ---------------- 视图：数据导入导出 ----------------
function viewData() {
  $('#content').innerHTML = `<div class="row">
    <div class="card card-pad" style="flex:1">
      <h2 class="h2">导出单价库</h2>
      <p class="hint">将当前生效版本的机型、部件、虚拟机单价导出为 JSON，便于备份与跨机迁移。</p>
      <a class="btn primary" href="javascript:void(0)" onclick="downloadLibrary()">下载单价库 JSON</a>
    </div>
    <div class="card card-pad" style="flex:1">
      <h2 class="h2">导入单价库</h2>
      <p class="hint">选择此前导出的 JSON 文件，合并进当前生效版本（不清空原有数据）。</p>
      <input type="file" id="libFile" accept=".json">
      <div class="actions"><button class="btn primary" onclick="importLib()">导入</button></div>
    </div>
  </div>
  <div class="card card-pad" style="margin-top:16px">
    <h2 class="h2">报价单导出</h2>
    <p class="hint">在「报价单」列表中，每条均可一键导出 Excel（.xlsx）或 CSV，含单价库版本号与税率，可直接发供应商询价。</p>
  </div>`;
}
window.downloadLibrary = async () => {
  // 优先取后端数据（真实生效版本），后端不可用时退回 localStorage
  let lib = null;
  try {
    const exp = await api('GET', '/api/library/export');
    if (exp && exp.machines) lib = exp;
  } catch (e) {}
  if (!lib) lib = { machines: STORE.machines, parts: STORE.parts, vm_prices: STORE.vm_prices, vm_flavors: STORE.vm_flavors, settings: STORE.settings };
  lib = Object.assign({}, lib, { exported_at: now() });
  download('单价库导出.json', new Blob([JSON.stringify(lib, null, 2)], { type: 'application/json' }));
};
window.importLib = async () => {
  const f = $('#libFile').files[0]; if (!f) return toast('请先选择文件');
  try { const obj = JSON.parse(await f.text()); await api('POST', '/api/library/import', obj); await reloadLib(); renderNav(); toast('导入成功'); }
  catch (e) { toast('导入失败：' + e.message); }
};

// ---------------- 视图：系统设置 ----------------
async function viewSettings() {
  await reloadLib();
  $('#content').innerHTML = `<div class="card card-pad" style="max-width:560px">
    <h2 class="h2">系统设置</h2>
    <div class="field"><label>默认税率（用于报价含税计算）</label><input id="s_tax" type="number" step="0.01" value="${parseFloat(S.settings.tax_rate) || 0.13}"></div>
    <p class="hint">当前货币：人民币（CNY）。金额一律以「分」为整数单位计算，避免浮点误差。</p>
    <div class="actions"><button class="btn primary" onclick="saveSettings()">保存设置</button></div>
  </div>
  <div class="card card-pad" style="margin-top:16px;max-width:760px">
    <h2 class="h2">已确认口径（需求 v0.2）</h2>
    <ol class="hint">
      <li>虚拟机单价 = 综合单价（已含许可与运维），不拆分；虚拟机不分架构、不折算宿主机。</li>
      <li>本期不做阶梯折扣，报价为纯线性 单价×数量。</li>
      <li>虚拟机按资源单价直接乘，不折算宿主机（无超分/预留/HA）。</li>
      <li>不计算维保；报价即单价库版本快照，版本号即有效期。</li>
      <li>物理机按架构分类：海光 x86 / 鲲鹏 ARM 独立库、独立报价、选件硬校验；虚拟机免架构校验。</li>
    </ol>
  </div>`;
}
window.saveSettings = async () => {
  try { await api('POST', '/api/settings', { tax_rate: parseFloat($('#s_tax').value) }); await reloadLib(); renderNav(); toast('已保存'); }
  catch (e) { toast('失败：' + e.message); }
};

// ---------------- 视图：关于 ----------------
function viewAbout() {
  $('#content').innerHTML = `<div class="card card-pad">
    <h2 class="h2">关于本工具</h2>
    <p class="hint">信创服务器「攒机式」配置与报价工具 —— 面向 IT 基础架构人员，对海光/鲲鹏信创服务器进行架构梳理，并对物理机与虚拟机的不同配置、不同数量做价格成本测算，支持保存与导出配置单/报价结果。</p>
    <h3 style="margin-top:14px">技术栈</h3>
    <p class="hint">运行：Python 标准库 <span class="code">http.server</span> 同时提供静态服务与 REST API（<span class="code">/api/*</span>，JSON 文件持久化，零第三方依赖）；前端：原生 JS SPA，数据<b>优先走后端接口</b>（同一浏览器多标签、跨会话共享，重启不丢），<b>后端不可用时自动回退浏览器 localStorage</b>（预览面板/纯静态托管/离线仍可完整使用）；导出：浏览器端自研 xlsx/csv 生成。启动：<span class="code">python server.py</span> → http://localhost:8000</p>
    <h3 style="margin-top:14px">范围与边界</h3>
    <p class="hint">本期：单价库（版本化、物理机分架构）、配置组合器（物理机架构校验）、报价引擎（纯线性含税）、导出、架构梳理。不做：阶梯折扣、宿主机超分折算、维保计算、在线支付与多供应商招投标。</p>
    <h3 style="margin-top:14px">已知风险（对应需求文档）</h3>
    <p class="hint">RK-02 单价版本化（已通过版本管理+报价锁定版本号缓解）；RK-06 成本价防泄（本期单机自用，未做角色权限，后续迭代补）。</p>
    <h3 style="margin-top:14px">开源与免责声明</h3>
    <p class="hint">本项目为<b>开源项目</b>，其代码、文档及由此生成的任何结果<b>仅供个人学习与技术交流使用</b>，不得用于商业用途。工具内置的单价、配置与报价样例均为<b>示意数据</b>，不代表任何厂商真实报价或承诺；实际采购请以官方询价与合同为准。使用本工具所产生的任何决策与后果均由使用者自行承担，作者不承担任何法律责任。</p>
  </div>`;
}

// ---------------- 硬件清单解析 → 配置台 的桥接 ----------------
/**
 * 由解析结果生成一条单价库机型（D-2：全项目唯一实现，hcl-view 不再另存一份）。
 * 口径要点：
 *  - cpu_cores 记「单颗核数」，与现有机型库一致
 *  - 宽表未识别路数时 cpu_sockets 取 1（不猜 2 路），并在 basis 标注待确认（B-3）
 */
function buildMachineFromSpec(it, srcName) {
  const s = it.spec || {};
  const sockets = s.cpuSockets > 0 ? s.cpuSockets : 0;
  const perSocket = s.cpuPerSocket > 0 ? s.cpuPerSocket
    : (s.cpuCores > 0 && sockets > 0 ? Math.round(s.cpuCores / sockets) : 0);
  const cpuModel = s.cpuModel || it.modelText || '清单解析机型';
  const isARM = /鲲鹏|kunpeng|飞腾|phytium|龙芯|loongson/i.test(cpuModel);
  const isHygon = /海光|hygon/i.test(cpuModel);
  const arch = s.arch || (isARM ? '鲲鹏(ARM)' : (isHygon ? '海光(C86/x86)' : '海光(C86/x86)'));
  const brand = s.brand || (isHygon ? '海光' : (isARM ? '鲲鹏' : '其他'));
  const memGen = s.memGen || 'DDR4';
  const diskCount = (s.disks || []).reduce((a, x) => a + (x.count || 1), 0);
  return {
    brand, model: cpuModel, arch,
    cpu_model: cpuModel,
    cpu_sockets: sockets > 0 ? sockets : 1,   // B-3：缺路数取 1 路，不猜 2 路
    cpu_cores: perSocket || 0,               // 单颗核数（口径与现有机型库一致）
    cpu_freq: s.cpuFreqGHz || 0,
    mem_capacity: s.memCapacityGB || 0, mem_gen: memGen,
    disk_bays: String(diskCount || '8'),
    disk_desc: s.diskDesc || '', nic: s.nicDesc || '',
    power: s.psuCount ? (s.psuCount + '×电源') : '', rail: '2U导轨',
    unit_price_cents: 0,
    supplier: '清单解析（待询价）',
    basis: '由《' + srcName + '》解析生成，单价待补'
      + (sockets > 0 ? '' : '；CPU 路数未在清单中识别到，按 1 路记，请人工确认'),
  };
}
async function materializeMachine(it, srcName) {
  const d = buildMachineFromSpec(it, srcName);
  try {
    const out = await api('POST', '/api/machines', d);
    await reloadLib();
    return out && out.id;
  } catch (e) { return null; }
}
window.HwParseBridge = {
  api: (m, p, b) => api(m, p, b),
  toast, esc, fmt, modal, closeModal,
  machines: () => S.machines,
  osList: () => S.os, hvList: () => S.hv,
  reloadLib: async () => { await reloadLib(); },
  buildMachineFromSpec,   // D-2：机型生成的唯一口径实现
  apply: async (items, opts) => {
    opts = opts || {};
    const srcName = (opts.source && opts.source.name) || '硬件配置清单';
    // 幂等策略：默认 replace（按 srcSelId 覆盖旧行，避免重复应用产生重复配置），可显式选 append（A-6）
    const mode = opts.mode || 'replace';
    let created = 0, skipped = 0, added = 0, replaced = 0;
    if (mode === 'replace' && items.length) {
      const srcIds = new Set(items.map(it => it.srcSelId || it.id).filter(Boolean));
      const keepPhys = CFG.phys.filter(l => !(l.srcSelId && srcIds.has(l.srcSelId)));
      const keepVm = CFG.vm.filter(l => !(l.srcSelId && srcIds.has(l.srcSelId)));
      replaced = (CFG.phys.length - keepPhys.length) + (CFG.vm.length - keepVm.length);
      CFG.phys = keepPhys; CFG.vm = keepVm;
      // 清掉已失效节点的拓扑位置与连线，避免残留
      const aliveIds = new Set([...CFG.phys, ...CFG.vm].map(l => l.id));
      CFG.links = (CFG.links || []).filter(([a, b]) => aliveIds.has(lineOf(a)) && aliveIds.has(lineOf(b)));
    }
    for (const it of items) {
      if (it.purpose) registerPurpose(it.purpose);
      const srcSelId = it.srcSelId || it.id || null;
      let machineId = it.machineId;
      if (it.kind === 'phys') {
        if (!machineId) {
          if (!opts.materialize) { skipped++; continue; }
          machineId = await materializeMachine(it, srcName);
          if (!machineId) { skipped++; continue; }
          created++;
        }
        const m = S.machines.find(x => x.id === machineId);
        if (!m) { skipped++; continue; }
        CFG.phys.push({
          id: newLineId('p'), srcSelId, machineId, qty: it.qty || 1,
          parts: [], // 选配部件（阶段4 C-1 启用）
          purpose: it.purpose || '', role: '', group: it.purposeNorm || purposeOf(it.purpose || ''), deploy: it.purpose || '',
          os: (S.os.find(o => o.arch === m.arch) || {}).label || '',
          hv: (S.hv.find(h => h.arch === m.arch) || {}).label || '',
        });
        added++;
      } else {
        CFG.vm.push({
          id: newLineId('v'), srcSelId,
          cpu: it.cpu || 0, mem: it.memGB || 0, sto: it.stoGB || 0,
          qty: it.qty || 1,
          purpose: it.purpose || '', role: '', group: it.purposeNorm || purposeOf(it.purpose || ''), deploy: it.purpose || '', flavor: it.modelText || '',
        });
        added++;
      }
    }
    await persistCfg();
    return { added, created, skipped, replaced, mode };
  },
};
// 配置行 id 生成：优先用 crypto.randomUUID，缺失时退回时间戳+随机串
function newLineId(prefix) {
  const u = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return prefix + Date.now().toString(36) + u;
}
// 从拓扑节点 id（p_<lineId>_<u> / v_<lineId>）反推配置行 id
function lineOf(nodeId) {
  const s = String(nodeId || '');
  if (s.startsWith('p_')) return s.split('_').slice(0, 2).join('_').slice(2);
  if (s.startsWith('v_')) return s.slice(2);
  return s;
}

// ---------------- 启动 ----------------
(async function init() {
  try { await loadLib(); } catch (e) { console.error(e); }
  // 优先从后端恢复拓扑（布局/连线/部署组件）；后端不可用时沿用 localStorage 里的 CFG
  try {
    const c = await api('GET', '/api/cfg');
    if (c && typeof c === 'object') Object.assign(CFG, c);
  } catch (e) {}
  CFG.connecting = false; CFG.selNode = null;
  route();
})();
