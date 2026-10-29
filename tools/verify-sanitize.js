/**
 * 脱敏守卫 —— 防止敏感内容被重新引入仓库
 *
 * 背景：本仓库是公开的。脱敏如果只做一次，下一次改动很容易把敏感词带回来
 * （新增一段注释、扩一个 fixture、补一句文档，都可能顺手写进真实业务代号）。
 * 故把「不许出现什么」固化成可执行断言，接入 CI 与本地全量测试。
 *
 * 判据设计：
 *   - 只扫**工作区当前文件**，不扫 git 历史（历史里的旧内容无法靠改代码消除）。
 *   - 只扫文本类扩展名，跳过二进制（xlsx 等）。
 *   - 命中即失败并打印 文件:行号 + 原文片段 + 原因，便于直接定位。
 *
 * 注意：本文件自身也在扫描范围内。为避免「守卫把自己判成违规」，
 * 模式串采用拆分拼接写法（'天'+'鉴'），使字面量不连续出现在源码里。
 *
 * 用法：node tools/verify-sanitize.js
 * 退出码 0 = 通过；1 = 发现敏感内容
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** 扫描时跳过的目录 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.run', '__pycache__', '.pytest_cache', '.venv']);

/** 扫描的文本扩展名（不含扩展名的文件需在 EXTRA_NAMES 中单独列出） */
const TEXT_EXT = new Set(['.js', '.py', '.md', '.json', '.sh', '.html', '.css', '.bat', '.yml', '.yaml', '.txt', '.example']);
const EXTRA_NAMES = new Set(['.env.example', 'LICENSE', 'VERSION']);

/**
 * 禁止出现的敏感内容。
 * 每条只针对「确凿不可公开」的具体标识，不做泛化词匹配 ——
 * 「交易 / 清算 / 风控 / 报盘」等行业通用词是解析引擎的功能本体，禁掉会废掉工具价值。
 */
const FORBIDDEN = [
  { re: new RegExp('天' + '鉴'), why: '特定厂商运维平台品牌名' },
  { re: new RegExp('Work' + 'Buddy', 'i'), why: '内部产品名' },
  { re: new RegExp('Code' + 'Buddy', 'i'), why: '内部工具名' },
  { re: new RegExp('IDC' + ' Manager', 'i'), why: '竞品代号' },
  { re: new RegExp('资讯' + '报盘'), why: '原业务系统代号' },
  { re: new RegExp('交易' + '核心'), why: '原业务系统代号' },
  { re: new RegExp('核心' + '交易'), why: '原业务系统代号' },
  { re: new RegExp('ocp' + '操作机', 'i'), why: '原部署应用名' },
  { re: new RegExp('ob' + '集群', 'i'), why: '原部署应用名' },
  { re: new RegExp('硬盘' + '不返还'), why: '原商务条款表述' },
];

/** 递归收集待扫描文件 */
function collect(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  entries.forEach(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) collect(full, out);
      return;
    }
    if (!e.isFile()) return;
    const ext = path.extname(e.name).toLowerCase();
    if (TEXT_EXT.has(ext) || EXTRA_NAMES.has(e.name)) out.push(full);
  });
  return out;
}

function main() {
  const files = collect(ROOT, []);
  const problems = [];

  files.forEach(f => {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (e) {
      return;
    }
    // 二进制内容误判为文本时直接跳过（极少发生：xlsx 已在扩展名筛选中排除）
    if (text.indexOf('\u0000') >= 0) return;

    const lines = text.split('\n');
    lines.forEach((line, i) => {
      FORBIDDEN.forEach(fb => {
        if (fb.re.test(line)) {
          const rel = path.relative(ROOT, f);
          problems.push(`  ✗ ${rel}:${i + 1} 命中「${fb.re.source.replace(/\\/g, '')}」—— ${fb.why}`);
          console.log(`    ${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
        }
      });
    });
  });

  console.log('============================================================');
  console.log('脱敏守卫（verify-sanitize）');
  console.log('============================================================');
  console.log(`扫描文件：${files.length} 个 | 禁止项：${FORBIDDEN.length} 条`);
  if (!problems.length) {
    console.log('✅ 未发现敏感内容');
    console.log('============================================================');
    return;
  }
  console.log(`发现 ${problems.length} 处敏感内容：`);
  problems.forEach(p => console.log(p));
  console.log('============================================================');
  process.exitCode = 1;
}

main();
