/**
 * 前端脚本语法校验：web/ 下每个 .js 都要能被解析。
 *
 * 背景：本项目的前端是「原生 JS + 模板字符串拼 HTML」，模板字符串里再嵌
 * 字符串字面量，一旦引号层级写错（外层单引号套内层单引号），就是一个
 * SyntaxError，浏览器里整页白屏，但静态检查（HTML/CSS）发现不了。
 * 这个套件用 vm.Script 做纯语法解析，不执行代码，秒级完成。
 *
 * 运行： node tools/verify-syntax.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');

let fail = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fail++;
}

console.log('\n# 前端脚本语法校验');

// 收集 web/ 下的 js（不递归 node_modules 等，本项目 web/ 是平铺结构）
const files = fs.readdirSync(WEB).filter(f => f.endsWith('.js')).sort();

check(files.length > 0, `发现 ${files.length} 个前端脚本`);

for (const f of files) {
  const src = fs.readFileSync(path.join(WEB, f), 'utf8');
  try {
    // 只做语法解析，不执行
    new vm.Script(src, { filename: f });
    console.log(`  ✓ ${f}`);
  } catch (e) {
    console.log(`  ✗ ${f}`);
    console.log('      ' + String(e.message).split('\n')[0]);
    fail++;
  }
}

// ---- index.html 引用的脚本必须都存在 ----
console.log('\n# index.html 引用完整性');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const refs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
check(refs.length > 0, `index.html 引用了 ${refs.length} 个脚本`);
for (const r of refs) {
  const p = path.join(WEB, r);
  check(fs.existsSync(p), `引用存在：${r}`);
}

// ---- index.html 引用的样式必须都存在 ----
const links = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map(m => m[1]);
for (const l of links) {
  if (/^https?:/.test(l)) continue;
  check(fs.existsSync(path.join(WEB, l)), `样式存在：${l}`);
}

// ---- 离线单测脚本加载的前端文件必须都存在 ----
// test-*.js 用 vm.runInThisContext 载入这些文件，缺一个就直接抛错
console.log('\n# 单测脚本加载清单一致性');
for (const t of ['test-quote.js', 'test-app-smoke.js', 'verify-xlsx.js']) {
  const p = path.join(__dirname, t);
  if (!fs.existsSync(p)) { check(false, `缺少测试脚本 ${t}`); continue; }
  const src = fs.readFileSync(p, 'utf8');
  const loaded = [...src.matchAll(/web\/([\w.-]+\.js)/g)].map(m => m[1]);
  const missing = [...new Set(loaded)].filter(f => !fs.existsSync(path.join(WEB, f)));
  check(missing.length === 0, `${t} 引用的前端文件都存在${missing.length ? '，缺：' + missing.join(',') : ''}`);
}

console.log('\n' + '='.repeat(56));
console.log(fail ? `结果：${fail} 项失败` : '结果：语法与引用全部正确');
process.exit(fail ? 1 : 0);
