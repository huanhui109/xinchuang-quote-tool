/**
 * 后端 API 契约测试 —— Node 包装器
 *
 * 背景：此前后端 server.py 从未被真正执行过 —— tools/test-quote.js 只是
 * readFileSync('server.py') 做正则文本断言。逻辑写错、接口 404、403 规则
 * 没生效，测试都能全绿。这是本项目最大的质量盲区。
 *
 * 本包装器只做一件事：调用 test-backend.py（纯标准库实现），转发它的输出，
 * 并按「结果：N 通过 / M 失败」的约定设置退出码。
 * 真正的断言全部在 tools/test-backend.py 里。
 *
 * 运行： node tools/test-backend.js
 */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const PY = process.env.PYTHON_BIN || 'python3';
const ROOT = path.join(__dirname, '..');

try {
  const out = execFileSync(PY, [path.join(__dirname, 'test-backend.py')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: ROOT,
  });
  process.stdout.write(out);
  // 判定依据：只看结尾的汇总行「结果：N 通过 / M 失败（共 N+M 项）」
  // —— 不能用「输出里含『失败』二字」来判断，那会误伤 M=0 的成功输出。
  const m = out.match(/结果：(\d+)\s*通过\s*\/\s*(\d+)\s*失败/);
  if (!m) {
    console.log('结果：0 通过 / 1 失败（共 1 项）');
    console.log('失败项：无法解析 test-backend.py 的汇总行');
    process.exitCode = 1;
  } else if (Number(m[2]) > 0) {
    process.exitCode = 1;
  }
} catch (e) {
  const out = (e.stdout || '') + (e.stderr || '');
  process.stdout.write(out);
  console.log('结果：0 通过 / 1 失败（共 1 项）');
  process.exitCode = 1;
}
