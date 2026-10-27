/* 硬件配置清单解析 —— 页面视图
 * 菜单：报价 → 硬件清单解析（#/hw-parse）
 * 流程：上传 → 表/表头/列映射纠偏 → 明细校对（人工修正）→ 规格模板沉淀 / 默认已选配置 → 应用至配置台
 */
;(function (root) {
  'use strict';

  var V = {
    wb: null, result: null, rules: null, options: null,
    combos: [], selections: [], imports: [], tab: 'rows',
    cfg: { maxUploadBytes: 8 * 1024 * 1024, maxRows: 5000, maxCols: 60, maxSheets: 8 },
    removedKeys: {}, note: '', via: '',
    onlyUnassigned: false,   // 明细校对：仅看「未分组」用途的行
    onlyUnassignedSel: false, // 已选配置：仅看「未分组」用途的行
  };
  var H = root.HclCore, XR = root.XlsxRead;
  var esc = root.__esc || function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  function B() { return root.HwParseBridge || {}; }
  function q(s) { return root.document.querySelector(s); }
  function loadLibSafe() { var b = B(); return b.reloadLib ? b.reloadLib() : Promise.resolve(); }

  async function loadState() {
    try {
      if (!!B().api) {
        var cfg = await B().api('GET', '/api/hcl/config');
        if (cfg) {
          if (cfg.rules && cfg.rules.length) V.rules = cfg.rules;
          if (cfg.options) V.options = cfg.options;
          if (cfg.maxUploadBytes) V.cfg.maxUploadBytes = cfg.maxUploadBytes;
          if (cfg.maxRows) V.cfg.maxRows = cfg.maxRows;
          if (cfg.maxCols) V.cfg.maxCols = cfg.maxCols;
          if (cfg.maxSheets) V.cfg.maxSheets = cfg.maxSheets;
        }
        var st = await B().api('GET', '/api/hcl/state');
        if (st) {
          V.combos = st.combos || [];
          V.selections = st.selections || [];
          V.imports = st.imports || [];
          V.removedKeys = st.removedKeys || {};   // B-6：删除墓碑恢复，避免刷新后已删行复活
          if (st.rules && st.rules.length) V.rules = st.rules;
          if (st.options) V.options = st.options;
        }
      }
    } catch (e) { /* 忽略 */ }
    if (!V.rules) V.rules = H.defaultRules();
    if (!V.options) V.options = {};
  }
  async function saveState(extra) {
    try {
      if (!!B().api) {
        var payload = {
          combos: V.combos, selections: V.selections, imports: V.imports, options: V.options,
        };
        // B-6：removedKeys 纳入持久化，否则刷新后手动删掉的行会复活
        if (V.removedKeys && Object.keys(V.removedKeys).length) payload.removedKeys = V.removedKeys;
        var out = await B().api('PUT', '/api/hcl/state', payload);
        // 后端 413（状态超限）必须让用户知道，而不是静默失败
        if (out && out.error) {
          if (B().toast) B().toast('保存失败：' + out.error);
          return;
        }
      }
    } catch (e) {
      if (B().toast) B().toast('保存失败：' + ((e && e.message) || e));
    }
    if (extra && extra.reloadConfigurator && B().reloadLib) await loadLibSafe();
  }

  // ---------------- 页面 ----------------
  async function render() {
    await loadState();
    if (!V.rules) V.rules = H.defaultRules();
    q('#content').innerHTML = layout();
    bindUI();
  }

  /** 可选用途分组（下拉/建议用），带兜底 */
  function groups() {
    if (H.purposeGroups) return H.purposeGroups();
    return [
      { name: '接入层', kws: ['网关'] },
      { name: '应用服务', kws: ['应用'] },
      { name: '中间件', kws: ['中间件'] },
      { name: '数据服务', kws: ['数据库'] },
      { name: '存储备份', kws: ['存储'] },
      { name: '基础设施', kws: ['管理'] },
    ];
  }
  function isUnassigned(r) {
    // 终端机（笔记本/台式机）不参与选型，无需补录用途，不计入「未分组」
    if (!r || r.kind === 'endpoint') return false;
    var n = r.purposeNorm;
    return !n || n === '未分组';
  }
  /** 用途单元格：文本输入 + 分组快捷下拉 + 归一化结果徽标 + 输入建议 */
  /** 候选下拉内容（供全局唯一 datalist 使用）。D-3：
   *  原实现把 <datalist> 写在 purposeCell 内，每行重复渲染一份，
   *  既产生重复 id（HTML 非法）也让 500 行表格的 DOM 节点翻数倍。 */
  function purposeSuggests() {
    var suggests = [];
    groups().forEach(function (g) {
      suggests.push(g.name);
      g.kws.slice(0, 4).forEach(function (k) { suggests.push(k); });
    });
    return suggests;
  }
  /** 全局唯一的用途候选 datalist，在表格外渲染一次 */
  function purposeDatalist() {
    return `<datalist id="hwPurposeList">${purposeSuggests()
      .map(function (s) { return `<option value="${esc(s)}">`; }).join('')}</datalist>`;
  }
  function purposeCell(r, onChange, onGroup) {
    var un = isUnassigned(r);
    var opts = groups().map(function (g) {
      // 关键：option value 必须是分组名，否则 onchange 时 this.value 为空串，分组动作会被 if(!group) 直接忽略
      return `<option value="${esc(g.name)}">${esc(g.name)}</option>`;
    }).join('');
    var tag = un
      ? '<span class="hw-badge err">未分组</span><span class="hint">未识别用途，请人工补录或用「归入分组」</span>'
      : (r.purposeNorm === '未分组'
        ? '<span class="hw-badge">' + (r.kind === 'endpoint' ? '终端（不参与选型）' : '未分组') + '</span>'
        : '<span class="hw-badge ok">' + esc(r.purposeNorm) + '</span>');
    return `<input list="hwPurposeList" value="${esc(r.purpose || '')}" placeholder="如：数据库集群"
        onchange="${onChange}('${r.id}','purpose',this.value)">
      <select class="hw-grp" title="直接归入用途分组" onchange="${onGroup}('${r.id}',this.value)">
        <option value="">归入分组…</option>${opts}</select>
      <div class="muted">${tag}
        ${r.optional ? ' ｜ 候选(必选=否)' : ''}${r.defaultPick === false ? ' ｜ 互斥候选中未选中' : ''}</div>`;
  }

  function statBar() {
    var r = V.result;
    if (!r) return '';
    var s = r.stats || {};
    var un = ((r.rows) || []).filter(isUnassigned).length;
    return `<div class="hw-stats">
      <div class="hw-stat"><div class="n">${s.total || 0}</div><div class="l">解析行数</div></div>
      <div class="hw-stat ok"><div class="n">${s.ok || 0}</div><div class="l">完全识别</div></div>
      <div class="hw-stat warn"><div class="n">${s.partial || 0}</div><div class="l">部分识别</div></div>
      <div class="hw-stat err"><div class="n">${s.failed || 0}</div><div class="l">无法识别</div></div>
      <div class="hw-stat"><div class="n">${s.skipped || 0}</div><div class="l">跳过行</div></div>
      <div class="hw-stat"><div class="n">${(r.combos || []).length}</div><div class="l">规格模板</div></div>
      <div class="hw-stat ${un ? 'err' : 'ok'}" style="cursor:${un ? 'pointer' : 'default'}"
           onclick="${un ? "hwOnlyUnassigned()" : ''}" title="${un ? '点击只看这些行' : ''}">
        <div class="n">${un}</div><div class="l">用途未分组${un ? ' ↗' : ''}</div></div>
      <div class="hw-stat"><div class="n">${(r.selections || []).length}</div><div class="l">默认已选配置</div></div>
    </div>`;
  }

  function layout() {
    var r = V.result;
    var ruleBox = '';
    if (V.wb) {
      var sheets = (V.wb.sheets || []).map(function (s) {
        var sel = r && r.sheet && r.sheet.name === s.name ? 'selected' : '';
        return `<option ${sel}>${esc(s.name)}（${(s.rows || []).length} 行）</option>`;
      }).join('');
      var ruleOpts = (V.rules || []).map(function (x) {
        return `<option value="${esc(x.id)}" ${r && r.rule && r.rule.id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`;
      }).join('');
      ruleBox = `<div class="card card-pad" style="margin-bottom:14px">
        <div class="toolbar"><div><h2 class="h2">② 解析纠偏</h2>
          <p class="hint">自动命中：规则「${esc(r && r.rule ? r.rule.name : '—')}」｜工作表「${esc(r && r.sheet ? r.sheet.name : '—')}」｜表头第 ${r && r.sheet ? r.sheet.headerStart : '—'} 行${r && r.tableCount > 1 ? '（该工作表含 ' + r.tableCount + ' 张逻辑表）' : ''}｜读取方式：${esc(V.via === 'backend' ? '后端解析' : V.via === 'local' ? '浏览器本地解析' : '—')}</p></div>
          <button class="btn sm" onclick="hwEditRules()">规则配置</button></div>
        <div class="grid-4">
          <div class="field"><label>工作表</label><select id="hwSheet">${sheets}</select></div>
          <div class="field"><label>表头行号</label><input id="hwHeader" type="number" min="1" value="${r && r.sheet ? r.sheet.headerStart : 1}"></div>
          <div class="field"><label>表头行数</label><input id="hwHeaderH" type="number" min="1" max="3" value="${r && r.sheet ? r.sheet.headerHeight : 1}"></div>
          <div class="field"><label>解析规则</label><select id="hwRule">${ruleOpts}</select></div>
        </div>
        <div class="field"><label>开关（影响默认选型）</label>
          <div class="hw-switches">
            <label><input type="checkbox" id="hwIncOpt" ${V.options.includeOptional ? 'checked' : ''} onchange="hwOpt('includeOptional',this.checked)"> 纳入「必选=否」的候选行</label>
            <label><input type="checkbox" id="hwIncFail" ${V.options.includeFailed ? 'checked' : ''} onchange="hwOpt('includeFailed',this.checked)"> 纳入无法识别的行</label>
            <label><input type="checkbox" id="hwMat" ${V.options.materializeMachines ? 'checked' : ''} onchange="hwOpt('materializeMachines',this.checked)"> 应用时把新规格写入单价库</label>
            <label><select id="hwConflict" onchange="hwOpt('conflictPolicy',this.value)">
              <option value="keep-manual" ${V.options.conflictPolicy !== 'overwrite' ? 'selected' : ''}>重导入冲突时保留人工值</option>
              <option value="overwrite" ${V.options.conflictPolicy === 'overwrite' ? 'selected' : ''}>重导入冲突时以新清单覆盖</option></select></label>
          </div></div>
        <div class="actions" style="justify-content:flex-start">
          <button class="btn primary" onclick="hwReparse()">重新解析</button>
          <button class="btn" onclick="hwToggleColMap()">${V.showColMap ? '收起列映射' : '列映射纠偏'}</button>
          <span class="muted">修改后点击「重新解析」，已选配置会按用途+规格去重更新，不会重复。</span>
        </div>
        ${V.showColMap ? colMapPanel() : ''}
      </div>`;
    }

    // ---------------- C-7 列映射纠偏 UI ----------------
  /** 可映射的语义字段（与 hcl-core 的 rule.columns 键保持一致） */
  var MAP_FIELDS = [
    ['purpose', '硬件用途'], ['entity', '实体机/虚拟机'], ['required', '必选'],
    ['qty', '数量'], ['cpuModel', 'CPU 型号'], ['cpuCores', 'CPU 核数'], ['cpuFreq', 'CPU 主频'],
    ['mem', '内存容量'], ['disk', '硬盘'], ['nic', '网卡'], ['power', '电源'],
    ['raid', 'RAID/阵列'], ['os', '操作系统'], ['hv', '虚拟化平台'],
    ['specText', '配置原文（自由文本）'], ['apps', '部署应用'], ['system', '所属系统'],
  ];
  function colMapPanel() {
    var r = V.result;
    if (!r || !r.sheet) return '<div class="hw-warn">尚未选中工作表，请先完成解析。</div>';
    var heads = r.sheet.headers || [];
    if (!heads.length) return '<div class="hw-warn">未能读取表头，无法提供列映射。</div>';
    var cur = (r.sheet.map) || {};
    return `<div class="colmap">
      <div class="hw-stat">C-7 列映射纠偏</div>
      <p class="hint">当前工作表「${esc(r.sheet.name)}」识别到 ${heads.length} 列。供应商表头千差万别，
        可在这里把任意列手动指派为语义字段，然后点「重新解析」——无需改 JSON。</p>
      <div class="colmap-grid">
        ${MAP_FIELDS.map(function (f) {
          return `<div class="field"><label>${esc(f[1])}</label>
            <select onchange="hwSetColMap('${f[0]}',this.value)">
              <option value="">— 不映射 —</option>
              ${heads.map(function (h, i) {
                return `<option value="${i}" ${String(cur[f[0]]) === String(i) ? 'selected' : ''}>第${i + 1}列：${esc(h || '(空表头)')}</option>`;
              }).join('')}
            </select></div>`;
        }).join('')}
      </div>
      <div class="actions" style="justify-content:flex-start">
        <button class="btn" onclick="hwResetColMap()">恢复自动识别</button>
        <span class="muted">当前命中规则：${esc(r.rule ? r.rule.name : '—')}；表头起始行 ${r.sheet.headerStart}</span>
      </div>
    </div>`;
  }
  root.hwToggleColMap = function () { V.showColMap = !V.showColMap; render(); };
  root.hwSetColMap = function (field, idx) {
    if (!V.options.columnMap) V.options.columnMap = {};
    if (idx === '' || idx == null) delete V.options.columnMap[field];
    else V.options.columnMap[field] = parseInt(idx, 10);
    V.options.autoPickSheet = true;
    saveState();
  };
  root.hwResetColMap = function () { V.options.columnMap = {}; saveState(); runParse({ fresh: true }); };

  var warnings = '';
    if (r && (r.warnings || []).length) {
      warnings = `<div class="hw-warn"><b>解析提示（${r.warnings.length}）</b>
        <ul>${r.warnings.slice(0, 20).map(function (w) {
        return `<li><span class="hw-code">${esc(w.code)}</span>${esc(w.msg)}</li>`;
      }).join('')}</ul></div>`;
    }
    if (V.note) warnings = `<div class="hw-warn ok"><b>操作结果</b><p class="hint">${esc(V.note)}</p></div>` + warnings;

    return `<div class="toolbar"><h2 class="h2" style="margin:0">硬件配置清单解析与默认选型</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn sm" onclick="location.hash='#/configurator'">前往配置台</button>
        <button class="btn sm" onclick="hwExport()">导出已选配置 CSV</button>
        <button class="btn sm danger" onclick="hwClearAll()">清空全部</button>
      </div></div>
      <p class="hint">上传不同供应商的硬件配置清单（.xlsx / .csv），自动识别机型规格与数量并生成默认选型基线；解析不出来的行会明确标出，可人工修正后重新生成。</p>

      <div class="card card-pad" style="margin-top:12px">
        <h2 class="h2">① 上传清单</h2>
        <div class="hw-drop" id="hwDrop" onclick="document.getElementById('hwFile').click()">
          <div style="font-size:30px">📥</div>
          <div>点击选择，或把 .xlsx / .csv 拖到此处</div>
          <div class="muted">单个文件 ≤ ${Math.round(V.cfg.maxUploadBytes / 1048576)}MB｜不支持 .xls（请另存为 xlsx）</div>
        </div>
        <input type="file" id="hwFile" accept=".xlsx,.xlsm,.csv,.txt" style="display:none">
      </div>

      ${ruleBox}
      ${statBar()}
      ${warnings}
      ${r ? tabNav() : ''}
      <div id="hwBody">${r ? purposeDatalist() + tabBody() : emptyBody()}</div>`;
  }

  function emptyBody() {
    if ((V.selections || []).length === 0 && (V.combos || []).length === 0) {
      return `<div class="card card-pad"><div class="empty">尚未导入任何清单。上传后将自动生成「默认已选配置」与可复用的「规格模板」。</div></div>`;
    }
    return tabNav() + tabBody();
  }
  function tabNav() {
    var tabs = [['rows', '明细校对'], ['combos', '规格模板沉淀'], ['sels', '默认已选配置']];
    return `<div class="hw-tabs">${tabs.map(function (t) {
      return `<button class="${V.tab === t[0] ? 'on' : ''}" onclick="hwTab('${t[0]}')">${t[1]}${t[0] === 'sels' ? '（' + V.selections.length + '）' : t[0] === 'combos' ? '（' + V.combos.length + '）' : ''}</button>`;
    }).join('')}</div>`;
  }
  function tabBody() {
    if (V.tab === 'combos') return comboTable();
    if (V.tab === 'sels') return selTable();
    return rowTable();
  }

  // ---- 明细校对 ----
  function rowTable() {
    var all = (V.result && V.result.rows) || [];
    if (!all.length) return `<div class="card card-pad"><div class="empty">没有解析出任何数据行，请检查「工作表 / 表头行」是否正确。</div></div>`;
    var unCount = all.filter(isUnassigned).length;
    var rows = V.onlyUnassigned ? all.filter(isUnassigned) : all;
    if (!rows.length) return `<div class="card card-pad"><div class="empty">没有「未分组」的行了 🎉　<button class="btn sm" onclick="hwOnlyUnassigned()">显示全部</button></div></div>`;
    var body = rows.map(function (r) {
      var iss = (r.issues || []).map(function (i) {
        return `<li class="${i.level}">${esc(i.msg)}</li>`;
      }).join('');
      var badge = r.status === 'ok' ? '<span class="hw-badge ok">完全识别</span>'
        : r.status === 'partial' ? '<span class="hw-badge warn">部分识别</span>'
          : '<span class="hw-badge err">无法识别</span>';
      var kindTag = r.kind === 'vm' ? '<span class="tag">虚拟机</span>'
        : r.kind === 'endpoint' ? '<span class="tag muted">终端</span>' : '<span class="tag x86">物理机</span>';
      var pickable = r.kind !== 'endpoint';
      return `<tr class="${r.defaultPick === false ? 'hw-off' : ''}">
        <td>${badge}<div class="muted" style="margin-top:4px">第 ${r.rowIndex} 行</div></td>
        <td>${purposeCell(r, 'hwFix', 'hwSetPurpose')}</td>
        <td>${kindTag}
          <select onchange="hwFix('${r.id}','kind',this.value)">
            <option value="phys" ${r.kind === 'phys' ? 'selected' : ''}>物理机</option>
            <option value="vm" ${r.kind === 'vm' ? 'selected' : ''}>虚拟机</option>
            <option value="endpoint" ${r.kind === 'endpoint' ? 'selected' : ''}>终端</option></select></td>
        <td><input type="number" min="1" value="${r.qty}" style="width:70px" onchange="hwFix('${r.id}','qty',this.value)">
          ${r.qtyUnknown ? '<div class="hw-badge warn">数量待定</div>' : ''}</td>
        <td><div class="hw-spec">${esc(H.specTitle(r))}</div>
          <div class="muted">CPU：${esc(r.spec.cpuModel || '—')}｜内存：${r.spec.memCapacityGB ? r.spec.memCapacityGB + 'G' : '—'}｜${esc(r.spec.diskDesc || '无硬盘信息')}｜${esc(r.spec.nicDesc || '无网卡信息')}</div></td>
        <td>${iss ? `<ul class="hw-issues">${iss}</ul>` : '<span class="muted">—</span>'}</td>
        <td style="white-space:nowrap">
          <button class="btn sm" onclick="hwEditRow('${r.id}')">详细修正</button>
          ${pickable ? `<div style="margin-top:6px"><label class="muted"><input type="checkbox" ${r.defaultPick !== false ? 'checked' : ''} onchange="hwPick('${r.id}',this.checked)"> 纳入选型</label></div>` : ''}</td>
      </tr>`;
    }).join('');
    return `<div class="card card-pad">
      <div class="toolbar"><div><h2 class="h2">③ 明细校对</h2><p class="hint">可直接修改用途 / 形态 / 数量；规格字段点「详细修正」。取消勾选的行不会进入默认选型。<b>「未分组」的行</b>：在用途框里补录（如「数据库集群」），或用右侧「归入分组…」下拉直接归类。</p></div>
        <button class="btn sm primary" onclick="hwApplyRows()">按当前明细重新生成已选配置</button></div>
      <div class="hw-switches" style="margin-bottom:8px">
        <button class="btn sm ${V.onlyUnassigned ? 'primary' : ''}" onclick="hwOnlyUnassigned()">
          ${V.onlyUnassigned ? '显示全部 ' + all.length + ' 行' : '只看未分组用途（' + unCount + '）'}</button>
        ${unCount ? `<span class="muted">还有 ${unCount} 行未识别用途，补录后再点「重新生成」，用途会同步到已选配置。</span>` : ''}
      </div>
      <table><thead><tr><th>状态</th><th>用途（可补录 / 归类）</th><th>形态</th><th class="num">数量</th><th>解析出的规格</th><th>提示</th><th></th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  }

  // ---- 规格模板 ----
  function comboTable() {
    if (!V.combos.length) return `<div class="card card-pad"><div class="empty">还没有沉淀的规格模板，先上传一份清单。</div></div>`;
    var b = B();
    var machines = (b.machines ? b.machines() : []) || [];
    var body = V.combos.map(function (c) {
      var m = c.machineId ? machines.filter(function (x) { return x.id === c.machineId; })[0] : null;
      return `<tr>
        <td><b>${esc(c.name)}</b><div class="muted">${esc(c.kind === 'vm' ? '虚拟机' : '物理机')}｜使用 ${c.useCount || 0} 次｜来源 ${(c.sources || []).length} 个文件</div></td>
        <td>${esc(c.purpose)}<div class="muted">${esc(c.purposeNorm || '')}</div></td>
        <td><div class="hw-spec">${esc(c.kind === 'vm'
          ? (c.spec.vmCpu + 'C / ' + c.spec.vmMemGB + 'G / ' + c.spec.vmStoGB + 'G')
          : [c.spec.cpuModel, c.spec.cpuCores ? c.spec.cpuCores + '核' : '', c.spec.memCapacityGB ? c.spec.memCapacityGB + 'G' : '',
            c.spec.diskDesc, c.spec.nicDesc].filter(Boolean).join(' / '))}</div></td>
        <td>${m ? `<span class="tag x86">已入库：${esc(m.brand + ' ' + m.model)}</span>` : '<span class="hw-badge warn">未入库</span>'}</td>
        <td style="white-space:nowrap">
          ${m ? '' : `<button class="btn sm primary" onclick="hwComboToMachine('${c.id}')">加入单价库</button>`}
          <button class="btn sm danger" onclick="hwDelCombo('${c.id}')">删除</button></td></tr>`;
    }).join('');
    return `<div class="card card-pad">
      <div class="toolbar"><div><h2 class="h2">规格模板沉淀</h2><p class="hint">按「用途 + 规格签名」去重累积，跨文件复用；使用次数越高说明越常用。可一键写入单价库成为机型。</p></div></div>
      <table><thead><tr><th>模板</th><th>用途</th><th>规格</th><th>入库状态</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`;
  }

  // ---- 默认已选配置 ----
  function selTable() {
    if (!V.selections.length) return `<div class="card card-pad"><div class="empty">暂无已选配置，上传清单后会自动生成一版基线。</div></div>`;
    var machines = (B().machines ? B().machines() : []) || [];
    var body = V.selections.map(function (s) {
      var opts = [];
      if (s.kind === 'phys') {
        machines.forEach(function (m) {
          opts.push(`<option value="m:${m.id}:${esc(m.brand + ' ' + m.model)}" ${s.machineId === m.id ? 'selected' : ''}>${esc(m.brand + ' ' + m.model)} · ${m.cpu_cores}核 · ${esc(m.arch)}</option>`);
        });
        opts.push(`<option value="t:${esc(s.modelText || '')}" ${!s.machineId ? 'selected' : ''}>未入库：${esc(s.modelText || '自定义')}</option>`);
      } else {
        V.combos.filter(function (c) { return c.kind === 'vm'; }).forEach(function (c) {
          opts.push(`<option value="c:${c.id}:${c.spec.vmCpu}:${c.spec.vmMemGB}:${c.spec.vmStoGB}" ${(s.cpu === c.spec.vmCpu && s.memGB === c.spec.vmMemGB) ? 'selected' : ''}>${esc(c.name)}</option>`);
        });
        opts.push(`<option value="t:${s.cpu}/${s.memGB}/${s.stoGB}" selected>当前：${s.cpu}C/${s.memGB}G/${s.stoGB}G</option>`);
      }
      var sUn = !s.purposeNorm || s.purposeNorm === '未分组';
      return `<tr>
        <td>${purposeCell({
        id: s.id, purpose: s.purpose, purposeNorm: s.purposeNorm || H.purposeOf(s.purpose),
      }, 'hwSelEdit', 'hwSelSetPurpose')}
          <div class="muted">${esc((s.apps || []).slice(0, 3).join('、') || '')}</div>
          ${sUn ? '<div class="hw-badge err">未分组</div>' : ''}</td>
        <td>${s.kind === 'vm' ? '<span class="tag">虚拟机</span>' : '<span class="tag x86">物理机</span>'}
          ${s.manual ? '<span class="hw-badge">已人工调整</span>' : ''}</td>
        <td><select onchange="hwSelReplace('${s.id}',this.value)">${opts.join('')}</select>
          <div class="muted">${esc(s.modelText || '')}</div></td>
        <td><input type="number" min="1" value="${s.qty}" style="width:70px" onchange="hwSelEdit('${s.id}','qty',this.value)"></td>
        <td class="muted">${esc(s.source && s.source.file ? s.source.file : '手工新增')}</td>
        <td style="white-space:nowrap"><label class="muted"><input type="checkbox" ${s.include !== false ? 'checked' : ''} onchange="hwSelEdit('${s.id}','include',this.checked)"> 应用</label>
          <button class="btn sm danger" onclick="hwDelSel('${s.id}')">删</button></td></tr>`;
    }).join('');
    var total = V.selections.filter(function (s) { return s.include !== false; })
      .reduce(function (a, s) { return a + (s.qty || 0); }, 0);
    return `<div class="card card-pad">
      <div class="toolbar"><div><h2 class="h2">默认已选配置（基线）</h2>
        <p class="hint">由清单自动生成，作为人工核对与生产决策的基线；支持增删、改数量、替换规格。共 ${V.selections.length} 行 / ${total} 台。</p></div>
        <div style="display:flex;gap:8px"><button class="btn sm" onclick="hwAddSel()">＋ 手工新增</button>
        <button class="btn primary" onclick="hwApply()">应用至配置台</button></div></div>
      <table><thead><tr><th>用途</th><th>形态</th><th>机型 / 规格（可替换）</th><th class="num">数量</th><th>来源</th><th></th></tr></thead>
      <tbody>${body}</tbody></table>
      <div class="actions" style="justify-content:flex-start;margin-top:12px">
        <button class="btn primary" onclick="hwApply()">应用至配置台</button>
        <button class="btn" onclick="hwSaveNow()">仅保存</button>
        <span class="muted">「应用」会把勾选的行写入配置台的物理机 / 虚拟机清单（携带用途作为部署组件）。</span>
      </div></div>`;
  }

  // ---------------- 交互 ----------------
  function bindUI() {
    q('#content').querySelector('#hwFile').onchange = function (e) {
      if (e.target.files && e.target.files[0]) onFile(e.target.files[0]);
    };
    var drop = q('#content').querySelector('#hwDrop');
    if (drop) {
      drop.ondragover = function (e) { e.preventDefault(); drop.classList.add('drag'); };
      drop.ondragleave = function () { drop.classList.remove('drag'); };
      drop.ondrop = function (e) {
        e.preventDefault(); drop.classList.remove('drag');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
      };
    }
  }

  async function onFile(file) {
    V.note = '';
    try {
      (B().toast || function () { })('正在读取：' + file.name);
      var wb = await XR.readFile(file, {
        maxUploadBytes: V.cfg.maxUploadBytes, maxRows: V.cfg.maxRows,
        maxCols: V.cfg.maxCols, maxSheets: V.cfg.maxSheets,
      });
      V.wb = wb; V.via = wb.via;
      runParse({ fresh: true });
    } catch (e) {
      V.result = null; V.wb = null;
      V.note = '读取失败：' + (e && e.message);
      render();
      (B().toast || function () { })('读取失败');
    }
  }

  async function runParse(opt) {
    opt = opt || {};
    if (!V.wb) return;
    var sheetName = null, headerStart = null, headerHeight = null, ruleId = null, colCount = null;
    var el = q('#hwSheet'); if (el) sheetName = el.value;
    var eh = q('#hwHeader'); if (eh) headerStart = parseInt(eh.value, 10) || null;
    var ehh = q('#hwHeaderH'); if (ehh) headerHeight = parseInt(ehh.value, 10) || 1;
    var er = q('#hwRule'); if (er) ruleId = er.value;
    if (V.result && V.result.sheet) {
      var autoRow = V.result.sheet.headerStart;
      if (headerStart !== autoRow) { /* 用户改过 */ } else headerStart = null;
    }
    try {
      var res = H.parseWorkbook(V.wb, {
        rules: V.rules, machines: (B().machines ? B().machines() : []) || [],
        sheetName: sheetName, ruleId: ruleId,
        headerStart: headerStart, headerHeight: headerHeight, colCount: colCount,
        columnMap: V.options.columnMap || null,   // C-7：把界面上的列映射纠偏传给引擎
        prevCombos: V.combos,
        includeOptional: !!V.options.includeOptional,
        includeFailed: !!V.options.includeFailed,
      });
      if (!res.ok) {
        V.result = null;
        V.note = '未能解析：' + res.errorMsg + '。请在工作表下拉中选择正确的工作表，并填写表头行号后点击「重新解析」。';
        render(); return;
      }
      V.result = res;
      if (opt.fresh) {
        // 去重合并（同一文件重导入 → 更新而非追加）
        var before = V.selections.length;
        var merged = H.mergeSelections(V.selections, res.selections, {
          conflictPolicy: V.options.conflictPolicy || 'keep-manual',
          stalePolicy: V.options.stalePolicy || 'remove',
        });
        V.selections = merged.items.filter(function (s) { return !V.removedKeys[s.selKey]; });
        V.combos = res.combos;
        V.imports.push({
          file: res.file.name, fileKey: res.file.key, at: new Date().toISOString().slice(0, 16).replace('T', ' '),
          rows: res.stats.total, added: merged.added, updated: merged.updated, removed: merged.removed, conflict: merged.conflict,
        });
        V.imports = V.imports.slice(-30);
        V.note = `导入完成：新增 ${merged.added} 行 / 更新 ${merged.updated} 行 / 移除 ${merged.removed} 行${merged.conflict ? ' / 冲突保留人工值 ' + merged.conflict + ' 行' : ''}（原有 ${before} 行）`;
      }
      await saveState();
      await render();
      (B().toast || function () { })('解析完成');
    } catch (e) {
      V.note = '解析异常：' + (e && e.message);
      await render();
    }
  }

  // 由明细重建已选配置
  function applyRows() {
    if (!V.result) return;
    var rows = V.result.rows.filter(function (r) {
      return r.kind !== 'endpoint' && r.defaultPick !== false && (!r.optional || V.options.includeOptional)
        && (r.status !== 'failed' || V.options.includeFailed);
    });
    var next = H.buildSelections(rows, {
      machines: (B().machines ? B().machines() : []) || [],
      includeOptional: !!V.options.includeOptional, includeFailed: !!V.options.includeFailed,
      fileKey: V.result.file.key, fileName: V.result.file.name,
    });
    var merged = H.mergeSelections(V.selections, next, {
      // 沿用用户在纠偏区选择的冲突策略，默认「保留人工值」，避免覆盖人工补录的用途
      conflictPolicy: V.options.conflictPolicy || 'keep-manual', stalePolicy: 'keep',
    });
    V.selections = merged.items.filter(function (s) { return !V.removedKeys[s.selKey]; });
    syncCombos(rows);
    V.note = `已按明细重建：新增 ${merged.added} / 更新 ${merged.updated} 行`
      + (merged.conflict ? ' / 冲突保留人工值 ' + merged.conflict + ' 行' : '');
    V.tab = 'sels';
    saveState(); render();
  }

  /** 明细里人工补录用途后，把新用途同步给已沉淀的规格模板（按规格签名匹配，并重算去重键） */
  function syncCombos(rows) {
    var bySig = {};
    rows.forEach(function (r) {
      if (r.kind === 'endpoint' || r.status === 'failed') return;
      bySig[r.signature] = r;
    });
    var seen = {};
    V.combos.forEach(function (c) {
      var parts = String(c.key || '').split('|');
      var sig = parts.slice(2).join('|');
      var r = bySig[sig];
      if (!r) { seen[c.key] = c; return; }
      c.purpose = r.purpose;
      c.purposeNorm = r.purposeNorm;
      c.key = c.kind + '|' + r.purposeNorm + '|' + sig;
      c.id = 'cb_' + H.hashKey(c.key).slice(0, 8);
      if (seen[c.key]) { // 合并到已存在的同键模板
        seen[c.key].useCount = (seen[c.key].useCount || 0) + (c.useCount || 0);
        return;
      }
      seen[c.key] = c;
    });
    V.combos = Object.keys(seen).map(function (k) { return seen[k]; })
      .sort(function (a, b) { return (b.useCount || 0) - (a.useCount || 0); });
  }

  function findRow(id) {
    if (!V.result) return null;
    for (var i = 0; i < V.result.rows.length; i++) if (V.result.rows[i].id === id) return V.result.rows[i];
    return null;
  }
  function recomputeRow(r) {
    var machines = (B().machines ? B().machines() : []) || [];
    r.spec = H.finalizeSpec(r.spec);
    if (r.kind === 'vm') {
      r.spec.vmCpu = r.spec.cpuCores || r.spec.vmCpu || 0;
      r.spec.vmMemGB = r.spec.memCapacityGB || r.spec.vmMemGB || 0;
      if (!r.spec.vmStoGB) r.spec.vmStoGB = 100;
    }
    r.purposeNorm = H.purposeOf(r.purpose);
    r.signature = H.signatureOf(r.kind, r.purposeNorm, r.spec);
    r.issues = (r.issues || []).filter(function (i) { return i.code !== 'PARTIAL_SPEC' && i.code !== 'NO_SPEC'; });
    if (r.kind !== 'phys') return r;
    if (!r.spec.cpuModel && !r.spec.cpuCores && !r.spec.memCapacityGB) r.issues.push({ field: 'spec', level: 'error', code: 'NO_SPEC', msg: '未解析到任何 CPU / 内存规格' });
    r.status = r.issues.some(function (i) { return i.level === 'error'; }) ? 'failed' : (r.issues.length ? 'partial' : 'ok');
    return r;
  }

  // ---------------- 暴露给页面的方法 ----------------
  var api = {
    render: render,
    /** 直接注入已读好的工作簿（供测试或程序化调用）：{ name, sheets:[{name, rows}] } */
    loadWorkbook: async function (wb, via) { V.wb = wb; V.via = via || 'local'; await runParse({ fresh: true }); },
    getState: function () { return { combos: V.combos, selections: V.selections, imports: V.imports, result: V.result }; },
  };
  root.HwParseView = api;

  root.hwTab = function (t) { V.tab = t; V.note = ''; render(); };
  root.hwOpt = function (k, v) { V.options[k] = v; V.options.autoPickSheet = true; saveState(); };
  // B-6：重新解析是用户的显式动作，必须与「重新上传」一样走完整合并，
// 否则改了表头/规则后 selections 与 imports 都不更新，用户却以为已生效。
root.hwReparse = async function () { await runParse({ fresh: true }); };
  root.hwSaveNow = async function () { await saveState(); (B().toast || function () { })('已保存'); };
  root.hwApplyRows = applyRows;

  root.hwPick = function (id, checked) {
    var r = findRow(id); if (!r) return;
    r.defaultPick = checked;
    saveState();
  };
  root.hwFix = function (id, field, val) {
    var r = findRow(id); if (!r) return;
    if (field === 'qty') { r.qty = Math.max(1, parseInt(val, 10) || 1); r.qtyUnknown = false; }
    else if (field === 'kind') r.kind = val;
    else r[field] = val;
    recomputeRow(r);
    saveState();
    // 用途变化会改变归一化分组与徽标，必须重绘才能看到最新结果
    if (field === 'purpose' || field === 'kind') render();
  };
  /** 明细行：直接归入某个用途分组（用分组名回填，保证自命中） */
  root.hwSetPurpose = function (id, group) {
    if (!group) return;
    var r = findRow(id); if (!r) return;
    r.purpose = group;
    recomputeRow(r);
    saveState(); render();
    (B().toast || function () { })('已归入「' + group + '」');
  };
  /** 已选配置行：直接归入某个用途分组 */
  root.hwSelSetPurpose = function (id, group) {
    if (!group) return;
    V.selections.forEach(function (s) {
      if (s.id !== id) return;
      s.purpose = group; s.purposeNorm = H.purposeOf(group); s.manual = true;
    });
    saveState(); render();
  };
  root.hwOnlyUnassigned = function () { V.onlyUnassigned = !V.onlyUnassigned; V.tab = 'rows'; render(); };
  root.hwOnlyUnassignedSel = function () { V.onlyUnassignedSel = !V.onlyUnassignedSel; V.tab = 'sels'; render(); };
  root.hwEditRow = function (id) {
    var r = findRow(id); if (!r) return;
    var isVm = r.kind === 'vm';
    var body = `<div class="grid-2">
      <div class="field"><label>用途</label><input id="rf_purpose" value="${esc(r.purpose)}"></div>
      <div class="field"><label>数量</label><input id="rf_qty" type="number" min="1" value="${r.qty}"></div>
      <div class="field"><label>形态</label><select id="rf_kind">
        <option value="phys" ${r.kind === 'phys' ? 'selected' : ''}>物理机</option>
        <option value="vm" ${r.kind === 'vm' ? 'selected' : ''}>虚拟机</option>
        <option value="endpoint" ${r.kind === 'endpoint' ? 'selected' : ''}>终端（不参与选型）</option></select></div>
      <div class="field"><label>CPU 型号</label><input id="rf_cpu" value="${esc(r.spec.cpuModel || '')}"></div>
      <div class="field"><label>${isVm ? 'vCPU（核）' : '整机物理核数'}</label><input id="rf_cores" type="number" value="${r.spec.cpuCores || ''}"></div>
      <div class="field"><label>主频(GHz)</label><input id="rf_freq" type="number" step="0.1" value="${r.spec.cpuFreqGHz || ''}"></div>
      <div class="field"><label>${isVm ? '内存(G)' : '内存容量(G)'}</label><input id="rf_mem" type="number" value="${r.spec.memCapacityGB || ''}"></div>
      <div class="field"><label>${isVm ? '存储(G)' : '硬盘描述'}</label><input id="rf_disk" value="${esc(isVm ? (r.spec.vmStoGB || '') : (r.spec.diskDesc || ''))}"></div>
      <div class="field"><label>网卡描述</label><input id="rf_nic" value="${esc(r.spec.nicDesc || '')}"></div>
      <div class="field"><label>所列路数（CPU 颗数）</label><input id="rf_sock" type="number" value="${r.spec.cpuSockets || ''}"></div>
    </div>
    <p class="hint">原值：${esc(r.qtyRaw ? ('数量=' + r.qtyRaw) : '')} ${esc(H.specTitle(r))}</p>`;
    B().modal('修正第 ' + r.rowIndex + ' 行', body,
      `<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="hwSaveRowFix('${id}')">保存并重算</button>`);
  };
  root.hwSaveRowFix = function (id) {
    var r = findRow(id); if (!r) return;
    var g = function (s) { var e = q(s); return e ? e.value : ''; };
    r.purpose = g('#rf_purpose');
    r.qty = Math.max(1, parseInt(g('#rf_qty'), 10) || 1); r.qtyUnknown = false;
    r.kind = g('#rf_kind');
    r.spec.cpuModel = H.cleanCpuModel(g('#rf_cpu'));
    r.spec.cpuCores = parseInt(g('#rf_cores'), 10) || 0;
    r.spec.cpuFreqGHz = parseFloat(g('#rf_freq')) || 0;
    r.spec.memCapacityGB = parseInt(g('#rf_mem'), 10) || 0;
    r.spec.cpuSockets = parseInt(g('#rf_sock'), 10) || 0;
    r.spec.nicDesc = g('#rf_nic');
    if (r.kind === 'vm') r.spec.vmStoGB = parseInt(g('#rf_disk'), 10) || 100;
    else r.spec.diskDesc = g('#rf_disk');
    if (r.spec.diskDesc && r.kind !== 'vm') {
      r.spec.disks = H.capByRole(r.spec.diskDesc.replace(/×/g, '*'), 'disk');
    }
    recomputeRow(r);
    B().closeModal();
    applyRows();
  };

  root.hwComboToMachine = async function (cid) {
    var c = null;
    for (var i = 0; i < V.combos.length; i++) if (V.combos[i].id === cid) c = V.combos[i];
    if (!c) return;
    // D-2：机型生成口径统一走 bridge 的唯一实现，避免两份代码漂移
    var it = { spec: c.spec, modelText: c.name };
    var srcName = (V.result && V.result.file ? V.result.file.name : '硬件清单') + '（规格模板沉淀）';
    var d = B().buildMachineFromSpec ? B().buildMachineFromSpec(it, srcName) : null;
    if (!d) { (B().toast || function () { })('机型生成接口不可用'); return; }
    try {
      var out = await B().api('POST', '/api/machines', d);
      await loadLibSafe();
      c.machineId = out && out.id ? out.id : c.machineId;
      await saveState();
      render();
      (B().toast || function () { })('已写入单价库，请补充单价');
    } catch (e) { (B().toast || function () { })('写入失败：' + e.message); }
  };
  root.hwDelCombo = async function (cid) {
    V.combos = V.combos.filter(function (c) { return c.id !== cid; });
    await saveState(); render();
  };
  root.hwDelSel = async function (id) {
    var s = V.selections.filter(function (x) { return x.id === id; })[0];
    if (s) V.removedKeys[s.selKey] = 1;
    V.selections = V.selections.filter(function (x) { return x.id !== id; });
    await saveState(); render();
  };
  root.hwSelEdit = function (id, k, v) {
    V.selections.forEach(function (s) {
      if (s.id !== id) return;
      if (k === 'qty') s.qty = Math.max(1, parseInt(v, 10) || 1);
      else s[k] = v;
      // 用途改了只刷新归一化分组，不动 selKey：否则去重键漂移会导致下次导入重复
      if (k === 'purpose') s.purposeNorm = H.purposeOf(v);
      s.manual = true;
    });
    saveState();
    if (k === 'purpose') render();
  };
  root.hwSelReplace = function (id, val) {
    V.selections.forEach(function (s) {
      if (s.id !== id) return;
      var parts = String(val).split(':');
      if (parts[0] === 'm') {
        s.machineId = parseInt(parts[1], 10); s.modelText = decodeURIComponent(parts.slice(2).join(':'));
        s.spec = null; // 以机型为准，去重键改用 machineId
      } else if (parts[0] === 'c') {
        s.cpu = parseInt(parts[2], 10) || s.cpu; s.memGB = parseInt(parts[3], 10) || s.memGB; s.stoGB = parseInt(parts[4], 10) || s.stoGB;
        s.modelText = s.cpu + 'C/' + s.memGB + 'G/' + s.stoGB + 'G';
        s.spec = { cpuModel: '', cpuCores: 0, memCapacityGB: 0, disks: [], nics: [], vmCpu: s.cpu, vmMemGB: s.memGB, vmStoGB: s.stoGB };
      } else {
        s.machineId = null; s.modelText = decodeURIComponent(parts.slice(1).join(':'));
        s.spec = null;
      }
      s.manual = true;
      s.selKey = H.selKeyOf(s.kind, s.purpose, s.machineId, s.spec || {});
    });
    saveState(); render();
  };
  root.hwAddSel = function () {
    var b = B();
    var machines = (b.machines ? b.machines() : []) || [];
    var opts = machines.map(function (m) {
      return `<option value="${m.id}">${esc(m.brand + ' ' + m.model)} · ${m.cpu_cores}核 · ${esc(m.arch)}</option>`;
    }).join('');
    B().modal('手工新增已选配置行', `<div class="grid-2">
      <div class="field"><label>形态</label><select id="ns_kind" onchange="hwAddSelSwitch()"><option value="phys">物理机</option><option value="vm">虚拟机</option></select></div>
      <div class="field"><label>用途</label><input id="ns_purpose" placeholder="如：数据库集群"></div>
      <div class="field"><label>数量</label><input id="ns_qty" type="number" value="1" min="1"></div>
      <div class="field" id="ns_phys"><label>机型</label><select id="ns_machine">${opts}</select></div>
      <div class="field hidden" id="ns_cpuF"><label>vCPU（核）</label><input id="ns_cpu" type="number" value="8"></div>
      <div class="field hidden" id="ns_memF"><label>内存(G)</label><input id="ns_mem" type="number" value="32"></div>
      <div class="field hidden" id="ns_stoF"><label>存储(G)</label><input id="ns_sto" type="number" value="200"></div>
    </div>`, `<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="hwSaveNewSel()">新增</button>`);
  };
  root.hwAddSelSwitch = function () {
    var k = q('#ns_kind').value;
    ['#ns_phys'].forEach(function (s) { q(s).classList.toggle('hidden', k !== 'phys'); });
    ['#ns_cpuF', '#ns_memF', '#ns_stoF'].forEach(function (s) { q(s).classList.toggle('hidden', k !== 'vm'); });
  };
  root.hwSaveNewSel = function () {
    var b = B();
    var machines = (b.machines ? b.machines() : []) || [];
    var kind = q('#ns_kind').value;
    var purpose = q('#ns_purpose').value || '未标注';
    var qty = Math.max(1, parseInt(q('#ns_qty').value, 10) || 1);
    var s = {
      id: 'sel_m' + Date.now(), kind: kind, purpose: purpose, apps: [], qty: qty,
      machineId: null, modelText: '', cpu: 0, memGB: 0, stoGB: 0,
      spec: { cpuModel: '', cpuCores: 0, memCapacityGB: 0, disks: [], nics: [], vmCpu: 0, vmMemGB: 0, vmStoGB: 0 },
      source: { fileKey: '', file: '手工新增', rowIndexes: [] },
      selKey: '', manual: true, include: true, note: '',
    };
    if (kind === 'phys') {
      var mid = parseInt(q('#ns_machine').value, 10);
      var m = machines.filter(function (x) { return x.id === mid; })[0];
      s.machineId = mid; s.modelText = m ? (m.brand + ' ' + m.model) : '';
    } else {
      s.cpu = parseInt(q('#ns_cpu').value, 10) || 0;
      s.memGB = parseInt(q('#ns_mem').value, 10) || 0;
      s.stoGB = parseInt(q('#ns_sto').value, 10) || 0;
      s.modelText = s.cpu + 'C/' + s.memGB + 'G/' + s.stoGB + 'G';
    }
    s.selKey = kind + '|' + purpose + '|' + (s.machineId ? ('m' + s.machineId) : s.modelText) + '|' + Date.now();
    V.selections.push(s);
    B().closeModal(); saveState(); render();
    (b.toast || function () { })('已新增');
  };

  root.hwApply = async function () {
    var b = B();
    if (!b.apply) { (b.toast || function () { })('配置台未就绪'); return; }
    var items = V.selections.filter(function (s) { return s.include !== false; });
    if (!items.length) { (b.toast || function () { })('没有勾选任何行'); return; }
    try {
      var out = await b.apply(items, { materialize: !!V.options.materializeMachines, source: V.result && V.result.file });
      await saveState();
      root.location.hash = '#/configurator';
      (b.toast || function () { })('已应用：' + JSON.stringify(out));
    } catch (e) { (b.toast || function () { })('应用失败：' + e.message); }
  };

  root.hwClearAll = async function () {
    if (!root.confirm('确认清空所有规格模板与已选配置？已解析的明细也会一并清除。')) return;
    V.combos = []; V.selections = []; V.imports = []; V.result = null; V.wb = null; V.removedKeys = {}; V.note = '已清空';
    try { if (!!B().api) await B().api('DELETE', '/api/hcl/state'); } catch (e) { }
    render();
  };

  root.hwExport = function () {
    if (!V.selections.length) { (B().toast || function () { })('没有可导出的已选配置'); return; }
    var rows = [['默认已选配置（由硬件清单解析生成）'],
    ['生成时间：' + new Date().toISOString().slice(0, 16).replace('T', ' ')], []];
    rows.push(['形态', '用途', '机型/规格', '数量', '来源文件', '备注']);
    V.selections.forEach(function (s) {
      rows.push([s.kind === 'vm' ? '虚拟机' : '物理机', s.purpose,
        s.modelText || (s.cpu ? (s.cpu + 'C/' + s.memGB + 'G/' + s.stoGB + 'G') : ''),
        s.qty, (s.source && s.source.file) || '', s.manual ? '已人工调整' : '']);
    });
    var csv = rows.map(function (r) { return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(','); }).join('\r\n');
    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = '已选配置清单.csv'; a.click();
  };

  root.hwEditRules = function () {
    B().modal('解析规则配置', `<p class="hint">规则为 JSON，用于适配不同供应商的表格结构。修改后保存，重新解析即生效；可导出与他人共享。</p>
      <textarea id="hwRulesText" style="width:100%;height:320px;font-family:monospace;font-size:12px">${esc(JSON.stringify(V.rules, null, 2))}</textarea>`,
      `<button class="btn" onclick="hwResetRules()">恢复默认</button>
       <button class="btn" onclick="closeModal()">关闭</button>
       <button class="btn primary" onclick="hwSaveRules()">保存规则</button>`);
  };
  root.hwSaveRules = function () {
    try {
      var obj = JSON.parse(q('#hwRulesText').value);
      if (!Array.isArray(obj)) throw new Error('规则必须是数组');
      V.rules = obj;
      B().api('PUT', '/api/hcl/rules', { rules: obj });
      B().closeModal(); render();
      (B().toast || function () { })('规则已保存');
    } catch (e) { (B().toast || function () { })('规则格式错误：' + e.message); }
  };
  root.hwResetRules = function () {
    V.rules = H.defaultRules();
    q('#hwRulesText').value = JSON.stringify(V.rules, null, 2);
    B().api('PUT', '/api/hcl/rules', { rules: V.rules });
    (B().toast || function () { })('已恢复默认规则');
  };
})(typeof self !== 'undefined' ? self : this);
