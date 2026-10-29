# 贡献指南

感谢你愿意为这个项目花时间。这份文档说明**本地怎么跑起来**、**提交前必须做什么**，
以及**哪些内容不允许进仓库**。

## 开发环境

| 依赖 | 版本 | 必需 | 说明 |
|---|---|---|---|
| Python | 3.10+ | 是（跑后端与后端测试时） | 只用标准库，**无需 pip install** |
| Node.js | 18+ | 是（跑测试与 Node 兜底服务时） | 同样无第三方依赖，**无需 npm install** |
| 浏览器 | 支持 ES2020 | 是 | 前端为原生 JS SPA |

```bash
git clone https://github.com/huanhui109/xinchuang-quote-tool.git
cd xinchuang-quote-tool
python3 server.py     # → http://localhost:8000
```

> `package.json` **只用于元信息与 `npm test` 入口**，不引入任何依赖，也没有构建步骤。
> 前端是无打包器的原生 JS，请勿引入 npm 运行时依赖。

## 提交前必跑

```bash
node tools/test-all.js
```

一次跑完 **11 套**，任一失败即以非 0 退出码结束：

| 套件 | 覆盖 |
|---|---|
| `verify-syntax.js` | 前端脚本语法解析 + `index.html` 引用完整性 |
| `verify-sanitize.js` | **脱敏守卫**：扫描工作区，禁止敏感内容被重新引入 |
| `test-hcl.js` | 硬件清单解析引擎 |
| `test-arch.js` | 架构图引擎 |
| `test-quote.js` | 报价链路 / 配置台 |
| `test-app-smoke.js` | SPA 离线回退全路由冒烟 |
| `verify-layout.js` | 配置台布局结构 |
| `verify-xlsx.js` | xlsx 导出端到端 |
| `test-fusion.js` | 融合模型（角色裁剪 / 锚点 / 资产侧路由） |
| `test-backend.js` | 后端 API 契约（**真起 `server.py` 子进程跑 HTTP**） |
| `test-docs.js` | 文档与代码一致性 + 版本号单一来源 |

### 两条容易踩的坑

1. **工作区全绿 ≠ 提交内容全绿。**
   曾因首批提交遗漏 `tools/verify-syntax.js`，本地测试全绿但干净检出时该套件失败。
   提交后请做一次干净克隆复跑：

   ```bash
   rm -rf /tmp/verify && git clone <你的 fork> /tmp/verify && cd /tmp/verify && node tools/test-all.js
   ```

2. **改了文档就必须重跑。**
   `test-docs.js` 会对「文档写了但代码没有」以非 0 退出码失败，
   这是刻意的 —— 文档必须能当验收依据用。

## 提交信息规范

采用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <中文简述>

<正文：为什么改、影响什么范围>
```

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修复缺陷 |
| `docs` | 文档 |
| `test` | 测试 |
| `chore` | 构建 / 依赖 / 杂项 |
| `refactor` | 不改变外部行为的重构 |
| `perf` | 性能 |

示例：

```
feat(hcl): 宽表解析支持两级表头自动识别

原先要求人工指定 headerStart，宽表清单需手工纠偏后才可用。
现按「表头行内出现字段名最多」自动定位，保留人工纠偏入口。
影响范围：web/hcl-core.js 的 parseWorkbook、tools/test-hcl.js。
```

## 脱敏红线（重要）

本仓库是**公开**的。以下内容**一律不得提交**：

- 真实客户 / 供应商 / 公司名称
- 内部系统代号、内部产品代号
- 真实商务条款（报价、维保条款文本、合同金额）
- 凭据：API Key、Token、密码、私钥、Cookie
- 内网主机名、域名、IP 地址、数据库连接串
- 真实个人信息：姓名、邮箱、手机号、证件号
- 真实设备序列号（SN）、机房 / 园区名称
- 本机绝对路径（含用户名）

### 该怎么写示例数据

用**结构等价、语义通用**的合成数据。`tools/fixtures/` 就是这么来的：
`tools/make-fixtures.js` 生成结构等价的合成清单，保留了解析器测试依赖的全部表结构特征
（两级表头、合并单元格继承、三类行形态等），但内容全部是虚构的。

> 修改 fixture **必须改 `tools/make-fixtures.js` 再重新生成**，不要手改 JSON ——
> 否则下次运行生成脚本会把你的修改覆盖掉：
>
> ```bash
> node tools/make-fixtures.js
> ```

`data/store.example.json` 是干净示例；`data/store.json` 是运行时数据（含真实报价与导入记录），
已在 `.gitignore` 中，**不要提交**。

## 版本号与变更日志

版本号的**唯一真源**是根目录的 `VERSION` 文件。改动版本号时：

1. 更新 `VERSION`；
2. 更新 `web/app.js` 里的 `APP_VERSION` 常量（前端无打包器，无法读文件）；
3. 在 `CHANGELOG.md` 顶部新增对应条目，注明变更类型（新增 / 修改 / 修复 / 移除）与影响范围；
4. 更新 README 首部的版本徽标。

这四步的一致性由 `tools/test-docs.js` 断言自动校验，漏改会被 CI 拦下。

## 架构约定（避免破坏现有结构）

- **前端**：原生 JS，无构建、无打包器、无框架。
  通用交互一律走 `web/ui.js` 的组件层，**不要在页面里手写原生 `confirm()` / `prompt()`**。
- **视图契约**：每个路由在 `VIEW_META` 中声明 `title` / `desc` / `actions()`，
  页面级操作只进顶栏动作区，区块级操作留在区块内，**同一按钮不得在一屏出现两次**。
- **图标**：统一 inline SVG（`Icons` / `NAV_ICONS`），**禁用 emoji**。
- **空状态**：必须「图标 + 说明 + 下一步引导」，不能只写「暂无」。
- **后端**：Python 标准库，无数据库、无第三方包。
  唯一性靠进程内锁内的集合成员检查实现，**不要引入 DB 级约束**。
- **数据格式**：金额一律以「分」为整数单位，避免浮点误差。
- **口径**：改动任何影响报价口径的地方，必须同步更新 `README.md` 与 `CHANGELOG.md`。

## 提交 Pull Request

1. 从 `main` 切出特性分支：`git checkout -b feat/xxx`；
2. 改动 + 自测通过（`node tools/test-all.js`）；
3. 推送并开 PR，**描述里写清「改了什么 / 为什么 / 影响范围」**；
4. 等待 CI 通过。

## 许可

提交即表示你同意你的贡献以 [MIT 许可证](LICENSE) 发布。
