/**
 * 文档一致性检查（D-6）
 *
 * 目的：README.md / docs/*.md 里的每一条「代码锚点」都必须真实存在于代码中。
 * 历史问题（P-69）：文档描述了 16 处代码里并不存在的能力，文档因此不能作为验收依据。
 *
 * 用法：node tools/test-docs.js
 * 退出码 0 = 一致；1 = 存在不一致（CI 可直接接入）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CODE_FILES = ['web/app.js', 'web/ui.js', 'web/hcl-core.js', 'web/hcl-view.js', 'web/hcl-bridge.js',
  'web/arch-graph.js', 'web/arch-diagram.js', 'web/xlsx-read.js', 'web/styles.css', 'server.py',
  'tools/test-quote.js', 'tools/test-hcl.js', 'tools/test-arch.js',
  'tools/verify-layout.js', 'tools/verify-xlsx.js', 'tools/verify-syntax.js', 'tools/verify-sanitize.js',
  'tools/test-fusion.js', 'tools/test-backend.js', 'tools/test-backend.py', 'tools/test-all.js'];

function readCode() {
  return CODE_FILES.map(f => {
    const p = path.join(ROOT, f);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }).join('\n');
}
function readDocs() {
  const files = ['README.md', 'docs/HW-CONFIG-PARSER.md', 'docs/ARCH-DIAGRAM.md', 'docs/FUSION-DESIGN.md', 'docs/FUSION-ROADMAP.md', 'docs/FUSION-METRICS.md'];
  return files.map(f => {
    const p = path.join(ROOT, f);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }).join('\n');
}

/**
 * 锚点表：每一项声明「文档里出现的标识符 → 必须能在代码里找到」。
 * kind:
 *   feature  文档描述了一个功能入口，代码必须实现它
 *   api      文档描述了一个函数/接口名，代码必须定义它
 */
const ANCHORS = [
  // ---- 硬件清单解析 ----
  { kind: 'api', doc: 'parseWorkbook', code: 'function parseWorkbook' },
  { kind: 'api', doc: 'columnMap', code: 'applyColumnMap' },
  { kind: 'feature', doc: 'includeOptional', code: 'includeOptional' },
  { kind: 'feature', doc: 'conflictPolicy', code: 'conflictPolicy' },
  { kind: 'feature', doc: 'materializeMachines', code: 'materializeMachines' },
  { kind: 'api', doc: 'XlsxRead', code: 'XlsxRead' },
  { kind: 'feature', doc: 'maxUploadBytes', code: 'maxUploadBytes' },
  { kind: 'api', doc: 'buildSelections', code: 'function buildSelections' },
  { kind: 'api', doc: 'buildCombos', code: 'function buildCombos' },
  // ---- 配置台 / 报价 ----
  { kind: 'api', doc: 'physUnitCents', code: 'function physUnitCents' },
  { kind: 'api', doc: 'vmUnitCents', code: 'function vmUnitCents' },
  { kind: 'feature', doc: '选配部件', code: 'physPartsCents' },
  { kind: 'feature', doc: '方案模板', code: 'SCHEME_TEMPLATES' },
  { kind: 'feature', doc: '方案对比', code: 'comparePlans' },
  { kind: 'api', doc: 'saveQuote', code: 'function saveQuote' },
  { kind: 'feature', doc: 'tax_rate', code: 'tax_rate' },
  { kind: 'feature', doc: '版本管理', code: 'viewVersions' },
  // ---- 架构图 ----
  { kind: 'api', doc: 'deriveModel', code: 'function deriveModel' },
  { kind: 'api', doc: 'toDrawioXml', code: 'function toDrawioXml' },
  { kind: 'api', doc: 'parseDrawioXml', code: 'parseDrawioXml' },
  { kind: 'api', doc: 'groupBy', code: 'groupBy' },
  { kind: 'api', doc: 'aggregate', code: 'opts.aggregate' },
  { kind: 'api', doc: 'legend', code: 'legendCells' },
  { kind: 'feature', doc: 'archDiagram', code: 'archDiagram' },
  // ---- 融合 MVP：空间模型 / 角色 / 台账 / U 位视图 / 交付 / 隔离 ----
  { kind: 'api', doc: 'u_index', code: 'def u_index_of' },
  { kind: 'api', doc: 'u_index', code: 'function uIndexOf' },
  { kind: 'api', doc: 'device_u_indices', code: 'def device_u_indices' },
  { kind: 'api', doc: 'device_u_indices', code: 'function deviceUIndices' },
  { kind: 'api', doc: 'machine_u_size', code: 'def machine_u_size' },
  { kind: 'api', doc: 'machine_u_size', code: 'function machineUSize' },
  { kind: 'api', doc: 'rack_units', code: 'rack_units' },
  { kind: 'api', doc: 'write_rack_units', code: 'def write_rack_units' },
  { kind: 'api', doc: 'check_placement', code: 'def check_placement' },
  { kind: 'api', doc: 'build_rackview', code: 'def build_rackview' },
  { kind: 'api', doc: 'space_validate', code: 'def space_validate' },
  { kind: 'api', doc: 'snapshot_drift', code: 'def snapshot_drift' },
  { kind: 'api', doc: 'assets_export', code: 'def assets_export' },
  { kind: 'api', doc: 'strip_price_fields', code: 'def strip_price_fields' },
  { kind: 'api', doc: 'device_create', code: 'def device_create' },
  { kind: 'api', doc: 'device_update', code: 'def device_update' },
  { kind: 'api', doc: 'delivery_create', code: 'def delivery_create' },
  { kind: 'api', doc: 'role_matrix', code: 'def role_matrix' },
  { kind: 'api', doc: 'role_can', code: 'def role_can' },
  { kind: 'api', doc: 'X-Role', code: 'X-Role' },
  { kind: 'api', doc: 'self_declared', code: 'self_declared' },
  { kind: 'api', doc: 'seg_id', code: 'def seg_id' },
  { kind: 'api', doc: 'catalog', code: 'head == "catalog"' },
  { kind: 'api', doc: 'source_line_uid', code: 'source_line_uid' },
  { kind: 'api', doc: 'line_uid', code: 'line_uid' },
  { kind: 'api', doc: 'asset_changes', code: 'asset_changes' },
  { kind: 'api', doc: 'rev_no', code: 'rev_no' },
  { kind: 'api', doc: 'append_event', code: 'def append_event' },
  { kind: 'api', doc: 'events_health', code: 'def events_health' },
  { kind: 'api', doc: 'events.jsonl', code: 'events.jsonl' },
  { kind: 'api', doc: 'store.json.bak', code: 'store.json.bak' },
  { kind: 'api', doc: 'rack_occupancy_conflict', code: 'rack_occupancy_conflict' },
  { kind: 'api', doc: 'snapshot_mismatch', code: 'snapshot_mismatch' },
  { kind: 'api', doc: 'validation_block', code: 'validation_block' },
  { kind: 'api', doc: 'quote_to_delivery', code: 'quote_to_delivery' },
  { kind: 'api', doc: 'price_feedback_submit', code: 'price_feedback_submit' },
  { kind: 'api', doc: 'config_save', code: 'config_save' },
  { kind: 'api', doc: 'quote_export', code: 'quote_export' },
  { kind: 'api', doc: 'viewAssetsDevices', code: 'function viewAssetsDevices' },
  { kind: 'api', doc: 'viewAssetsSpace', code: 'function viewAssetsSpace' },
  { kind: 'api', doc: 'viewAssetsRackview', code: 'function viewAssetsRackview' },
  { kind: 'api', doc: 'viewAssetsDeliveries', code: 'function viewAssetsDeliveries' },
  { kind: 'api', doc: 'renderRackViewSvg', code: 'function renderRackViewSvg' },
  { kind: 'api', doc: 'openPlacementCheck', code: 'window.openPlacementCheck' },
  { kind: 'api', doc: 'exportAssets', code: 'window.exportAssets' },
  { kind: 'api', doc: 'loadLib', code: 'function loadLib' },
  { kind: 'api', doc: 'localApi', code: 'const localApi' },
  { kind: 'api', doc: 'roleCan', code: 'function roleCan' },
  { kind: 'api', doc: 'STORE_DATA_DIR', code: 'STORE_DATA_DIR' },
  { kind: 'api', doc: 'test-backend.py', code: 'test-backend.py' },
  { kind: 'api', doc: 'test-fusion.js', code: 'test-fusion.js' },
  { kind: 'api', doc: 'verify-syntax.js', code: 'verify-syntax.js' },
  // ---- 安全 ----
  { kind: 'feature', doc: 'CSV 公式注入', code: 'csvCell' },
  { kind: 'feature', doc: '解压炸弹', code: '压缩炸弹' },
  { kind: 'feature', doc: '离线模式', code: 'offline-banner' },
  // ---- C-6 校验 ----
  { kind: 'feature', doc: '盘位', code: 'checkDiskBays' },
  { kind: 'feature', doc: '电源', code: 'checkPower' },
  { kind: 'feature', doc: '机架', code: 'checkRackU' },
  { kind: 'feature', doc: '内存', code: 'checkMemCapacity' },
  // ---- E-1 / E-2 xlsx 导出 ----
  { kind: 'api', doc: 'buildXlsx', code: 'function buildXlsx' },
  { kind: 'api', doc: '工作表名清洗', code: 'sheetNameSafe' },
  { kind: 'feature', doc: '控制字符', code: 'xclean' },
  // ---- E-3 配置台布局 ----
  { kind: 'feature', doc: '单价库选件', code: 'cfg-picker' },
  { kind: 'feature', doc: '实时报价汇总', code: 'id="cfgSummary"' },
  // ---- 通用 UI 组件层（web/ui.js）----
  { kind: 'api', doc: 'UI.empty', code: 'empty(icon, text, hint' },
  { kind: 'api', doc: 'UI.confirm', code: 'confirm(msg, {' },
  { kind: 'api', doc: 'UI.toast', code: 'toast(msg, kind' },
  { kind: 'api', doc: 'UI.buildForm', code: 'buildForm(fields, values' },
  { kind: 'api', doc: 'DataTable', code: 'const DataTable' },
  { kind: 'feature', doc: '视图契约', code: 'VIEW_META' },
  { kind: 'feature', doc: '空状态', code: 'empty-state' },
  { kind: 'feature', doc: '前端语法', code: 'verify-syntax' },
  { kind: 'feature', doc: '脱敏守卫', code: 'verify-sanitize' },
];

/** 反向检查：代码里的公开开关是否在文档里被说明 */
const FLAGS = ['archDiagram'];

/**
 * 跨文档口径守卫（融合方案 D-6 延伸）
 *
 * 背景：融合方案三份文档（DESIGN / ROADMAP / METRICS）在多轮并行编写中
 * 曾出现跨文档口径漂移（字段名不统一、指标名混用、越级引入 DB 约束等）。
 * 这些漂移不会让任何单套测试失败，却会让「文档 = 可执行方案」这句话失效。
 * 故在此把已裁决的关键口径固化为可执行断言。
 *
 * 规则：
 *   banned  —— 出现即错（除非出现在 allowWith 允许的否定语境里）
 *   paired  —— 两个词必须成对出现（口径双轨，不得只留一个）
 */
const BANNED = [
  // 1) 本项目无数据库：出现 DB 级唯一键 / Postgres 排他约束即错
  { re: /UNIQUE\s*\(/, hint: '本项目无 DB，唯一性 = _lock 内集合成员检查' },
  { re: /EXCLUDE\s+USING\s+gist/i, hint: 'Postgres 范围排他约束在本项目不可用' },
  { re: /asset_revisions|asset_change_items/, hint: '资产变更集合名为 asset_changes' },
  { re: /projects\s*集合|新建\s*projects\b/, hint: '不引入 project 概念，交付粒度挂 deliveries' },
  // 2) 字段名统一
  { re: /唯一键建在\s*`?u_start/, hint: '占用判据是 (rack_id, u_index) 集合成员检查' },
  // 3) 高度字段不得出现第二个权威名
  { re: /`height_u`|`size_u`/, hint: '高度权威结果只有 u_size，由 u_size_source 标注来源' },
];

/** 允许出现上述字样的否定语境（用于自我说明的句子） */
const NEGATION_CTX = /(无 DB|无数据库|不存在|不可用|不是 DB|非 DB|禁止|不得|不会|会逼出|即错|不在否定|统一为|不用|不复用|不新建|不另造|不引入|避免|出现即错|只出现一个|出现即错列|禁用|禁止出现)/;

/** 成对口径：两词必须同时出现在文档中 */
const PAIRED = [
  ['versions', 'asset_changes'],
  ['u_index', 'rack_units'],
  ['source_line_uid', 'seq_no'],
  ['u_size_source', 'chassis_u'],
  ['交付建账达成率', 'DLCR'],
];

/** MVP 期禁止直接考核 DLCR 的语境（DLCR 附近不应出现"考核"） */
const MVP_NO_DLCR_AUDIT = [
  'MVP 期内不作考核',
  'MVP 内不作考核',
  '正式 DLCR 待二期',
  '待二期③④上线后启用',
  'DLCR 卡片置灰',
  '禁止在 MVP 窗口内考核 DLCR',
  '降级为只观测',
  '结构性不可闭环',
];

/**
 * 判断命中位置是否位于 Markdown 表格的「出现即错 / 禁用」列。
 *
 * 背景：附录 B 的口径自检清单形如
 *   | 4 | 版本命名 | 正确口径…… | 出现 `asset_revisions` / `asset_change_items` |
 * 最后一列本身就是「禁用写法」清单，其中的违规词天然合法。
 * 识别方式：取命中所在表格行的最后一个 `|` 之后的内容，若其含「出现 / 禁止 / 不得 / 误称」等标记词，则判为禁用列。
 */
function isErrorColumn(docs, index) {
  const lineStart = docs.lastIndexOf('\n', index) + 1;
  let lineEnd = docs.indexOf('\n', index);
  if (lineEnd < 0) lineEnd = docs.length;
  const line = docs.slice(lineStart, lineEnd);
  if (line.indexOf('|') < 0) return false;
  // 命中所在单元格
  const cellStart = line.lastIndexOf('|', index - lineStart) + 1;
  const cellEnd = line.indexOf('|', index - lineStart);
  if (cellEnd < 0) return false;
  const cell = line.slice(cellStart, cellEnd);
  // 命中单元格本身带禁用标记词
  if (/出现|禁止|不得|误称|禁用|即错|不可|只能|写成|当作/.test(cell)) return true;
  // 命中单元格所在表格行内，有任何一列是「出现即错」清单列
  // 判据：该列以「出现/禁止/不得/误称/禁用」等禁用动词开头，或整列内容是「禁用写法列举」
  const cells = line.split('|').map(c => c.trim());
  const isBanListCell = c => {
    if (!c) return false;
    if (/^(出现|禁止|不得|误称|禁用|即错|不可|只能|写成|当作|违规)/.test(c)) return true;
    // 形如 "`projects` / `asset_revisions`" —— 全列都是反引号标识符列举
    const ids = c.match(/`[^`]+`/g);
    if (ids && ids.length >= 1 && c.replace(/`[^`]+`/g, '').replace(/[\/、,\s和与]+/g, '').length <= 2) return true;
    return false;
  };
  return cells.some(isBanListCell);
}

/**
 * 版本号一致性守卫
 *
 * 背景：版本号曾硬编码在 server.py 与 web/app.js 两处，靠人工同步，极易漏改。
 * 现改为「VERSION 文件为唯一真源 + 前端常量兜底」，但前端是原生 JS（无打包器），
 * 无法 require 文件，故仍需一个常量 —— 一致性必须由测试钉死，否则又是一处隐性分叉。
 *
 * 本守卫同时校验五方：VERSION 文件 / server.py / web/app.js / README / CHANGELOG。
 */
function checkVersionConsistency(problems) {
  const vPath = path.join(ROOT, 'VERSION');
  if (!fs.existsSync(vPath)) {
    problems.push('✗ 缺少 VERSION 文件 —— 版本号单一来源缺失');
    return;
  }
  const v = fs.readFileSync(vPath, 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    problems.push(`✗ VERSION 内容不是合法语义化版本：「${v}」`);
  }

  const py = fs.readFileSync(path.join(ROOT, 'server.py'), 'utf8');
  if (py.indexOf('APP_VERSION = _read_version()') < 0) {
    problems.push('✗ server.py 未从 VERSION 文件读取版本号（应为 APP_VERSION = _read_version()）');
  }
  if (py.indexOf('"version": APP_VERSION') < 0) {
    problems.push('✗ server.py 的 /api/info 未返回 APP_VERSION');
  }

  const app = fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');
  const m = app.match(/const APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!m) {
    problems.push('✗ web/app.js 缺少 APP_VERSION 常量');
  } else if (m[1] !== v) {
    problems.push(`✗ 版本号不一致：VERSION 文件为「${v}」，web/app.js 的 APP_VERSION 为「${m[1]}」`);
  }

  // 版本徽标必须在 README **首部**声明（标题下方的版本行）。
  // 若只做全文子串匹配，正文里任意一句「v0.3.0 新增」都会让它通过 —— 那是假安全。
  const rdLines = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').split('\n').slice(0, 10);
  const head = rdLines.join('\n');
  if (head.indexOf('v' + v) < 0) {
    problems.push(`✗ README 首部未以版本徽标形式声明当前版本「v${v}」`);
  }

  const clPath = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(clPath)) {
    problems.push('✗ 缺少 CHANGELOG.md');
  } else if (fs.readFileSync(clPath, 'utf8').indexOf('[' + v + ']') < 0) {
    problems.push(`✗ CHANGELOG.md 缺少版本「${v}」的条目`);
  }
}

function main() {
  const code = readCode();
  const docs = readDocs();
  const problems = [];
  let checked = 0;

  ANCHORS.forEach(a => {
    checked++;
    const inDoc = docs.indexOf(a.doc) >= 0;
    const inCode = code.indexOf(a.code) >= 0;
    if (inDoc && !inCode) {
      problems.push(`文档提到「${a.doc}」，但代码里找不到「${a.code}」`);
    }
    if (!inDoc && inCode && a.kind === 'feature') {
      // 代码有功能但文档没写 —— 记为提示（不是错误）
      problems.push(`⚠ 代码实现了「${a.code}」但文档未提及「${a.doc}」（建议补文档）`);
    }
  });

  FLAGS.forEach(f => {
    checked++;
    if (docs.indexOf(f) < 0) problems.push(`⚠ 功能开关 ${f} 未在文档中说明`);
  });

  // ---- 跨文档口径守卫 ----
  BANNED.forEach(b => {
    checked++;
    const re = new RegExp(b.re.source, 'g');
    let m;
    while ((m = re.exec(docs)) !== null) {
      const around = docs.slice(Math.max(0, m.index - 120), m.index + 160);
      if (!NEGATION_CTX.test(around) && !isErrorColumn(docs, m.index)) {
        problems.push(`✗ 文档出现「${m[0]}」且不在否定语境中 —— ${b.hint}`);
      }
    }
  });

  PAIRED.forEach(([a, b]) => {
    checked++;
    const hasA = docs.indexOf(a) >= 0;
    const hasB = docs.indexOf(b) >= 0;
    if (hasA !== hasB) {
      problems.push(`✗ 口径双轨「${a}」与「${b}」只出现了一个 —— 两者必须成对出现`);
    }
  });

  // MVP 期 DLCR 考核禁令：若文档声称 MVP 内考核 DLCR 而无任何降级说明，则错
  checked++;
  const hasAuditDLCR = /MVP[^。\n]{0,40}考核\s*DLCR|MVP[^。\n]{0,30}DLCR\s*[≥=]\s*\d/.test(docs);
  const hasGuard = MVP_NO_DLCR_AUDIT.some(g => docs.indexOf(g) >= 0);
  if (hasAuditDLCR && !hasGuard) {
    problems.push('✗ 文档在 MVP 语境考核 DLCR，但没有降级口径说明 —— ③④ 在二期，MVP 期分子恒为 0');
  }

  // ---- 版本号一致性（VERSION 单一来源）----
  checked++;
  checkVersionConsistency(problems);

  console.log('============================================================');
  console.log('文档一致性检查（D-6）');
  console.log('============================================================');
  console.log(`检查锚点：${checked} 项`);
  if (!problems.length) {
    console.log('✅ 文档与代码一致，可作为验收依据');
    console.log('============================================================');
    return;
  }
  console.log(`发现 ${problems.length} 处不一致：`);
  problems.forEach(p => console.log('  ✗ ' + p));
  console.log('============================================================');
  process.exitCode = 1;
}

main();