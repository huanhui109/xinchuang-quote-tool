#!/usr/bin/env node
/* 通过 GitHub REST API 建库并推送（Git Data API）
 *
 * 背景：本机网络对 github.com 的 git 协议端点做了域名级拦截（CONNECT 稳定返回 502），
 *       但 api.github.com 完全可达。因此无法使用 `git push`，
 *       改用 REST API 的 Git Data API 完成等价操作：
 *         1) POST   /user/repos                        创建公开仓库
 *         2) POST   /repos/{o}/{r}/git/blobs           批量创建 blob（每个文件一个）
 *         3) POST   /repos/{o}/{r}/git/trees           创建整棵树
 *         4) POST   /repos/{o}/{r}/git/commits         创建提交
 *         5) PATCH  /repos/{o}/{r}/git/refs/heads/main 更新分支引用
 *
 * 传输层用 curl（Node 的 TLS 与本机代理隧道组合存在兼容问题，curl 稳定可用）。
 *
 * 用法：
 *   GITHUB_TOKEN=<pat> node tools/push-via-api.js [owner] [repo] [message]
 *
 * 环境变量：
 *   GITHUB_TOKEN  必需，Personal Access Token（需 repo 权限）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OWNER = process.argv[2] || 'huanhui109';
const REPO = process.argv[3] || 'xinchuang-quote-tool';
const MESSAGE = process.argv[4] || 'feat: 信创服务器配置报价工具（已脱敏开源版）';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN 环境变量');
  process.exit(2);
}

const API = 'https://api.github.com';

/** 用 curl 发请求，返回 {status, body} */
function request(method, url, bodyObj) {
  const args = [
    '-sS', '--ssl-no-revoke', '--max-time', '60',
    '-X', method,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    '-H', 'User-Agent: xinchuang-quote-tool-push',
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-w', '\n__HTTP_STATUS__:%{http_code}',
  ];
  if (bodyObj !== undefined) {
    args.push('-H', 'Content-Type: application/json');
  }
  args.push(url);

  let stdout;
  if (bodyObj !== undefined) {
    const tmp = path.join(require('os').tmpdir(), 'ghreq-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
    fs.writeFileSync(tmp, JSON.stringify(bodyObj), 'utf8');
    try {
      stdout = execFileSync('curl', args.concat(['--data-binary', '@' + tmp]), {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    }
  } else {
    stdout = execFileSync('curl', args, {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  const marker = stdout.lastIndexOf('\n__HTTP_STATUS__:');
  if (marker < 0) throw new Error('响应缺少状态标记：' + stdout.slice(0, 200));
  const status = parseInt(stdout.slice(marker + 17).trim(), 10);
  const text = stdout.slice(0, marker);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = { raw: text }; }
  return { status, body: json };
}

/** 读取 git 已跟踪的文件列表（与本地提交完全一致） */
function listTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

(async function main() {
  console.log('目标仓库：https://github.com/' + OWNER + '/' + REPO);

  // 1) 账号校验
  let r = request('GET', API + '/user');
  if (r.status !== 200) {
    throw new Error('认证失败（HTTP ' + r.status + '）：' + JSON.stringify(r.body).slice(0, 300));
  }
  console.log('✅ 认证成功：' + r.body.login + '（账号类型 ' + r.body.type + '）');

  // 2) 仓库存在性检查 + 确保有默认分支（空仓库的 Git Database 不可写，需先有初始提交）
  r = request('GET', API + '/repos/' + OWNER + '/' + REPO);
  let baseSha = null;
  let defaultBranch = 'main';
  if (r.status === 404) {
    r = request('POST', API + '/user/repos', {
      name: REPO,
      description: '信创服务器配置报价工具：架构梳理、硬件清单解析与成本测算（原生 JS 前端 + 零依赖 Python 服务）',
      private: false,
      auto_init: true,
      has_issues: true,
      has_wiki: false,
    });
    if (r.status !== 201) throw new Error('创建仓库失败（HTTP ' + r.status + '）：' + JSON.stringify(r.body).slice(0, 300));
    console.log('✅ 公开仓库已创建（含初始化提交）');
    defaultBranch = r.body.default_branch || 'main';
  } else if (r.status === 200) {
    console.log('ℹ️  仓库已存在：' + r.body.html_url + '（private=' + r.body.private + '）');
    defaultBranch = r.body.default_branch || 'main';
  } else {
    throw new Error('查询仓库失败（HTTP ' + r.status + '）：' + JSON.stringify(r.body).slice(0, 300));
  }

  // 获取当前默认分支的提交 sha 作为父提交；若仓库完全为空（无任何提交，ref 端点返回 404/409），
  // 先通过 Contents API 写入占位文件以初始化 Git Database 与默认分支
  for (let attempt = 0; attempt < 4; attempt++) {
    const rr = request('GET', API + '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + defaultBranch);
    if (rr.status === 200) { baseSha = rr.body.object.sha; break; }
    if ((rr.status === 404 || rr.status === 409) && attempt < 3) { await new Promise((res) => setTimeout(res, 1500)); continue; }
    if (rr.status === 404 || rr.status === 409) break; // 空仓库，准备初始化
    throw new Error('查询分支失败（HTTP ' + rr.status + '）：' + JSON.stringify(rr.body).slice(0, 300));
  }
  if (!baseSha) {
    console.log('ℹ️  仓库为空，先用 Contents API 写入占位文件以初始化 Git Database');
    const sr = request('PUT', API + '/repos/' + OWNER + '/' + REPO + '/contents/.gitkeep', {
      message: 'chore: init repository',
      content: Buffer.from('initializing\n').toString('base64'),
      branch: defaultBranch,
    });
    if (sr.status !== 201) throw new Error('初始化空仓库失败（HTTP ' + sr.status + '）：' + JSON.stringify(sr.body).slice(0, 300));
    baseSha = sr.body.commit.sha;
    console.log('✅ 空仓库已初始化：' + baseSha);
  }
  console.log('ℹ️  父提交（基准）：' + baseSha);

  const files = listTrackedFiles();
  console.log('待上传文件：' + files.length + ' 个');

  // 3) 批量创建 blob
  const treeEntries = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const content = fs.readFileSync(path.join(ROOT, f));
    const br = request('POST', API + '/repos/' + OWNER + '/' + REPO + '/git/blobs', {
      content: content.toString('base64'), encoding: 'base64',
    });
    if (br.status !== 201) {
      throw new Error('创建 blob 失败 ' + f + '（HTTP ' + br.status + '）：' + JSON.stringify(br.body).slice(0, 300));
    }
    treeEntries.push({ path: f, mode: '100644', type: 'blob', sha: br.body.sha });
    process.stdout.write('  [' + (i + 1) + '/' + files.length + '] blob ' + f + '\n');
  }

  // 4) 创建 tree
  const tr = request('POST', API + '/repos/' + OWNER + '/' + REPO + '/git/trees', { tree: treeEntries });
  if (tr.status !== 201) throw new Error('创建 tree 失败（HTTP ' + tr.status + '）：' + JSON.stringify(tr.body).slice(0, 300));
  console.log('✅ tree 已创建：' + tr.body.sha);

  // 5) 创建 commit（以现有默认分支提交为父，快进推送）
  const cr = request('POST', API + '/repos/' + OWNER + '/' + REPO + '/git/commits', {
    message: MESSAGE, tree: tr.body.sha, parents: baseSha ? [baseSha] : [],
  });
  if (cr.status !== 201) throw new Error('创建 commit 失败（HTTP ' + cr.status + '）：' + JSON.stringify(cr.body).slice(0, 300));
  console.log('✅ commit 已创建：' + cr.body.sha);

  // 6) 更新默认分支引用（已存在则 PATCH 快进，不存在则 POST）
  let rr = request('GET', API + '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + defaultBranch);
  if (rr.status === 404) {
    rr = request('POST', API + '/repos/' + OWNER + '/' + REPO + '/git/refs', {
      ref: 'refs/heads/' + defaultBranch, sha: cr.body.sha,
    });
    if (rr.status !== 201) throw new Error('创建分支失败（HTTP ' + rr.status + '）：' + JSON.stringify(rr.body).slice(0, 300));
    console.log('✅ 分支 ' + defaultBranch + ' 已创建');
  } else if (rr.status === 200) {
    rr = request('PATCH', API + '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/' + defaultBranch, {
      sha: cr.body.sha, force: false,
    });
    if (rr.status !== 200) throw new Error('更新分支失败（HTTP ' + rr.status + '）：' + JSON.stringify(rr.body).slice(0, 300));
    console.log('✅ 分支 ' + defaultBranch + ' 已更新');
  } else {
    throw new Error('查询分支失败（HTTP ' + rr.status + '）：' + JSON.stringify(rr.body).slice(0, 300));
  }

  console.log('\n🎉 推送完成：https://github.com/' + OWNER + '/' + REPO);
  console.log('   提交：' + cr.body.sha);
})().catch((e) => {
  console.error('\n❌ 失败：' + (e && e.message ? e.message : e));
  process.exit(1);
});
