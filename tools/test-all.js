/**
 * 全量测试入口：一次跑完所有套件，任一失败即以非 0 退出码结束。
 * 用法：node tools/test-all.js
 */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const SUITES = [
  ['verify-syntax.js', '前端语法 / 引用'],
  ['test-hcl.js', '硬件清单解析'],
  ['test-arch.js', '架构图'],
  ['test-quote.js', '报价链路 / 配置台'],
  ['test-app-smoke.js', 'SPA 冒烟'],
  ['verify-layout.js', '配置台布局'],
  ['verify-xlsx.js', 'xlsx 导出'],
  ['test-fusion.js', '融合模型单测'],
  ['test-backend.js', '后端 API 契约'],
  ['test-docs.js', '文档一致性'],
];

let failed = 0;
const results = [];
// 各套件内部用相对路径读文件（如 web/app.js），必须切到项目根目录再执行，
// 否则从任意位置调用 test-all.js 都会误报失败。
const ROOT = path.join(__dirname, '..');
for (const [file, name] of SUITES) {
  process.stdout.write(`▶ ${name.padEnd(18, '　')} (${file}) … `);
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, file)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT,
    });
    let detail = '';
    const q = out.match(/结果：(\d+)\s*通过/);
    const lay = out.match(/结果：(.+)/);
    const all = out.match(/全部通过/);
    if (q) detail = `${q[1]} 项`;
    else if (lay && /正确/.test(lay[1])) detail = '结构正确';
    else if (all) detail = '全部通过';
    console.log(`✅ PASS${detail ? '  (' + detail + ')' : ''}`);
    results.push([name, 'PASS']);
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    console.log('❌ FAIL');
    out.split('\n').filter(l => l.indexOf('✗') >= 0).slice(0, 8).forEach(l => console.log('    ' + l.trim()));
    results.push([name, 'FAIL']);
    failed++;
  }
}

console.log('\n' + '='.repeat(60));
console.log(`合计：${SUITES.length - failed} 通过 / ${failed} 失败（共 ${SUITES.length} 套）`);
if (failed) {
  console.log('失败套件：' + results.filter(r => r[1] === 'FAIL').map(r => r[0]).join('、'));
}
console.log('='.repeat(60));
process.exitCode = failed ? 1 : 0;