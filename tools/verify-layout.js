/**
 * 布局结构验证（E-3）：用真实 HTML 解析器检查配置台 DOM 嵌套关系。
 * 背景：拓扑白板曾把「单价库选件」挤出屏幕（画布撑爆网格轨道），
 * 且「实时报价汇总」被顶到画布下方很远的位置。此脚本验证修复后的结构。
 *
 * 运行： node tools/verify-layout.js
 * 依赖： 无（只用内置能力 + 正则切分，不引入第三方 HTML 解析器）
 */
'use strict';
const fs = require('fs');
const path = require('path');

let fail = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fail++;
}

// ---- 从 app.js 中抽出 renderConfigurator 写入 #content 的那段模板 ----
// 注意：函数体内还有 physHtml / vmHtml 等嵌套的反引号模板，不能用「首个 ` 到首个 `;」截取，
// 否则会切到行内模板。以「赋值给 #content 的模板起点」到「末尾的 datalist」定位。
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');
const fnStart = src.indexOf('function renderConfigurator()');
if (fnStart < 0) throw new Error('未找到 renderConfigurator');
const assign = src.indexOf("$('#content').innerHTML = `", fnStart);
const A = assign < 0 ? -1 : assign + "$('#content').innerHTML = `".length;
const B = src.indexOf('<datalist id="purposeRegistryList">', fnStart);
if (A < 0 || B < 0 || B < A) throw new Error(`未能定位配置台模板边界 (A=${A}, B=${B})`);
let tpl = src.slice(A, B);

// 用与真实渲染等价的占位数据替换插值，便于离线检查结构
const vars = {
  totalPhys: '0', totalVm: '0', grand: '0', subtotal: '0', tax: '0',
  hasErr: 'false', hasSpecErr: 'false', specErrs: '[]', hasPending: 'false',
  physHtml: '<p class="line">PHYS</p>', vmHtml: '<p class="line">VM</p>',
  pickHtml: '<div class="pick">PICK</div>', flavorChips: '<div class="flavor-chip">F</div>',
};
tpl = tpl.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (m, k) => (k in vars ? vars[k] : 'X'));
// 三元表达式留痕即可（保留 CFG.view 画布分支，作为「画布在汇总条之前」的锚点）
tpl = tpl.replace(/\$\{CFG\.(?!view)[^}]*\}/g, 'X');
// 画布分支是 ${CFG.view === 'topo' ? renderTopo() : (...)}，内含嵌套引号与括号，
// 正则难以稳健匹配；直接按起止标记切除并替换为占位画布。
{
  const s = tpl.indexOf("${CFG.view === 'topo' ? renderTopo() :");
  if (s >= 0) {
    const tail = "'<p class=\"muted\">尚无虚拟机</p>'))}";
    const e = tpl.indexOf(tail, s);
    if (e < 0) throw new Error('未能定位画布分支结束位置');
    tpl = tpl.slice(0, s) + '<div class="topo"></div>' + tpl.slice(e + tail.length);
  }
}

console.log('\n# 配置台布局结构（E-3）');

// ---- 极简 div 配平检查：所有开闭标签必须严格嵌套 ----
const stack = [];
const re = /<(\/?)div\b[^>]*>/g;
let m, order = [];
while ((m = re.exec(tpl)) !== null) {
  if (m[1] === '/') {
    const top = stack.pop();
    if (top === undefined) { check(false, '出现多余的 </div>'); break; }
  } else stack.push(m.index);
}
check(stack.length === 0, `div 标签严格配平（未闭合 ${stack.length} 个）`);

// ---- 抽取 .cfg 网格的直接子节点 ----
const cfgAt = tpl.indexOf('<div class="cfg">');
check(cfgAt >= 0, '存在 .cfg 网格容器');
const cfgBody = tpl.slice(cfgAt);
const children = [];
{
  // 从 .cfg 之后开始，逐层扫描出第一层子 div
  let depth = 0, i = cfgAt + '<div class="cfg">'.length;
  const sub = cfgBody.slice('<div class="cfg">'.length);
  const rx = /<(\/?)div\b([^>]*)>/g;
  let mm;
  while ((mm = rx.exec(sub)) !== null) {
    const closing = mm[1] === '/';
    const attrs = mm[2] || '';
    if (!closing) {
      if (depth === 0) children.push({ attrs, start: mm.index });
      depth++;
    } else {
      depth--;
      if (depth < 0) break;
    }
  }
}
check(children.length === 3, `.cfg 网格有 3 个直接子列（实际 ${children.length}）`);

const cls = c => (c.attrs.match(/class="([^"]*)"/) || [, ''])[1];
const slot = c => (c.attrs.match(/id="([^"]*)"/) || [, ''])[1];

const pickerCol = children.find(c => cls(c).includes('cfg-picker'));
const mainCol = children.find(c => cls(c).includes('cfg-main'));
check(!!mainCol, '中间列带 cfg-main 类');
check(!!pickerCol, '右侧列带 cfg-picker 类');
if (pickerCol) {
  check(children.indexOf(pickerCol) === children.length - 1, '选件面板是网格最后一列（位于最右侧）');
}

// ---- 汇总条必须嵌在 cfg-main 内部 ----
// 注意 children[].start 是相对 cfgBody（即 tpl 从 .cfg 起算）的偏移，需换算成 tpl 绝对偏移
const base = cfgAt + '<div class="cfg">'.length;
const mainStart = mainCol ? mainCol.start + base : 0;
const pickStart = pickerCol ? pickerCol.start + base : tpl.length;
const mainSpan = tpl.slice(mainStart, pickStart);
const sumInMain = mainSpan.indexOf('id="cfgSummary"') >= 0;
check(sumInMain, '实时报价汇总嵌套在 cfg-main（画布下方）内，而非网格之外的兄弟节点');

// 汇总条应位于 cfg-main 的画布容器之后。
// 画布在静态模板中被规约为 <div class="topo"></div>（见上方替换），据此定位。
const canvasAt = mainSpan.indexOf('<div class="topo');
const sumAt = mainSpan.indexOf('id="cfgSummary"');
check(canvasAt >= 0 && sumAt > canvasAt, `汇总条排在画布之后（canvas@${canvasAt}, sum@${sumAt}）`);

const dup = (tpl.match(/id="cfgSummary"/g) || []).length;
check(dup === 1, `页面中只存在一个汇总条（实际 ${dup} 个）`);

// ---- 选件面板标题 ----
const pickerSpan = tpl.slice(pickStart);
const pt = pickerSpan.indexOf('单价库选件');
check(pt >= 0 && pt < 200, `选件面板标题紧随其列（偏移 ${pt}）`);

// ---- CSS 侧保障 ----
console.log('\n# CSS 布局保障');
const css = fs.readFileSync(path.join(ROOT, 'web/styles.css'), 'utf8');
const rule = sel => {
  const i = css.indexOf(sel);
  if (i < 0) return '';
  const j = css.indexOf('}', i);
  return css.slice(i, j + 1);
};
check(/grid-template-columns:[^;]*minmax\(0,\s*1fr\)/.test(css),
  '.cfg 中间列为 minmax(0,1fr)（画布不再撑爆轨道）');
check(/min-width:0/.test(rule('.cfg-col{')), '.cfg-col 设 min-width:0');
check(/position:sticky/.test(rule('.cfg-picker{')), '.cfg-picker 吸顶常驻右侧');
check(/overflow:auto/.test(rule('.cfg-picker .cfg-body{')), '选件面板内部独立滚动');
check(/max-height/.test(rule('.cfg-picker{')), '选件面板限高，避免超出视口');

console.log('\n' + '='.repeat(56));
console.log(fail ? `结果：${fail} 项失败` : '结果：布局结构全部正确');
process.exit(fail ? 1 : 0);