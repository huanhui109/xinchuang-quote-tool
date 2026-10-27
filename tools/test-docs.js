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
const CODE_FILES = ['web/app.js', 'web/hcl-core.js', 'web/hcl-view.js', 'web/hcl-bridge.js',
  'web/arch-graph.js', 'web/arch-diagram.js', 'web/xlsx-read.js', 'web/styles.css', 'server.py',
  'tools/test-quote.js', 'tools/test-hcl.js', 'tools/test-arch.js',
  'tools/verify-layout.js', 'tools/verify-xlsx.js'];

function readCode() {
  return CODE_FILES.map(f => {
    const p = path.join(ROOT, f);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }).join('\n');
}
function readDocs() {
  const files = ['README.md', 'docs/HW-CONFIG-PARSER.md', 'docs/ARCH-DIAGRAM.md'];
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
];

/** 反向检查：代码里的公开开关是否在文档里被说明 */
const FLAGS = ['archDiagram'];

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