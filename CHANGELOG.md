# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)（SemVer）。
所有**不兼容变更**只出现在主版本号；向后兼容的功能新增进次版本号；修复与文案进修订号。

版本号的**唯一真源**是仓库根目录的 [`VERSION`](VERSION) 文件；`server.py` 从中读取，
前端 `web/app.js` 因无打包器无法读取文件，使用同名常量兜底，三方一致性由
`tools/test-docs.js` 断言钉死。

## [0.3.0] - 2026-10-29

### 新增

- **资产侧能力**：空间模型（机房 → 机柜 → U 位，每半 U 一行）、统一设备台账、
  报价单 → 交付批次、机柜 2D U 位视图、上架可行性预校验、角色机制
  （`sales` / `delivery` / `ops` / `viewer`）、价格隔离与脱敏导出、采价反馈。
  - 影响范围：新增 16 个资产侧 REST 接口；新增 4 个前端视图（设备台账 / 空间模型 /
    U 位视图 / 交付批次）。
- **版本语义双轨**：定价快照（`versions`）与设备级变更（`asset_changes`，`rev_no` 递增、
  append-only）解耦；锚点体系 `source_line_uid = q_<quoteId>_<itemNo>`，
  `config_line_ref` 可空非持久，`legacy=1` 标记老单弱锚点。
- **埋点地基**：独立 JSONL 事件流（`data/events.jsonl`）+ 健康度文件
  （`data/events.health.json`，`dropped` 计数外露）。事件含 `rack_occupancy_conflict` /
  `snapshot_mismatch` / `config_save` / `quote_export`。
- **通用 UI 组件层** `web/ui.js`：Toast / Confirm / Modal / Prompt / Tooltip /
  空状态 / 表单构建器 / DataTable，页面不再各写一套。
- **运维脚本** `start.sh`（macOS / Linux）与 `start.bat`（Windows）：一键启动、
  端口仲裁、日志与 PID 统一托管、优雅停止。
- **测试体系**：由 8 套扩至 **11 套**，新增融合模型单测（81 项）与后端 API 契约测试
  （180 项，真起 `server.py` 子进程跑 HTTP）。
- **脱敏守卫** `tools/verify-sanitize.js`：把「不许出现什么」固化成可执行断言，
  防止敏感内容在后续改动中被重新引入（已当场拦下 4 处遗漏）。
- **发布规范文件**：`VERSION`（版本号单一来源）、`CHANGELOG.md`、`SECURITY.md`
  （含 `X-Role` 自声明头的信任边界）、`CONTRIBUTING.md`、`.env.example`
  （16 项环境变量样例）、`.github/workflows/test.yml`（CI）、`package.json`（仅元数据）。
- **README 补齐五要素**：新增「项目简介」与「配置项」章节，重写「目录结构」，
  补充典型使用场景与角色边界表。

### 修改

- **脱敏**：业务系统代号泛化为中性词（词表 / fixture / 生成脚本 / 测试断言**成套**替换，
  分组语义经实测逐条保持不变）；竞品代号与内部工具名中性化；
  商务条款去除具商业承诺特征的表述。
- **安全口径对齐**：`server.js`（Node 兜底）默认监听由 `0.0.0.0` 改为 `127.0.0.1`
  （可用 `HOST` 覆盖），与 `server.py` 保持一致，消除对外全网暴露的默认行为。
- **文档口径修正**：测试套件数由「8 套」更正为「10 套」；`data/store.example.json`
  不再声称「等价于内置 `seed_store()` 的输出」（实为同源、个别措辞有差异）；
  内置单价说明区分「示例价」（`basis` 标记）与「待询价」（单价为 0）两种状态。
- **版本号**：0.2 → **0.3.0**。由两处硬编码改为 `VERSION` 文件单一来源 + 前端常量兜底。

### 修复

- **前端语法静态检查**：新增 `tools/verify-syntax.js`，用 `vm.Script` 纯解析兜底。
  本项目大量使用「模板字符串拼 HTML」，字符串内再嵌字符串字面量，
  一旦引号层级写错就是整页白屏的 SyntaxError，而静态检查此前发现不了。
- **角色切换残留**：修复 `loadLib` 在缓存命中时直接返回、未回写全局状态，
  导致来回切换角色后数据集停留在上一个角色。
- **路由参数解析**：修复 query 参数并入路由段后被误当作记录 id
  （`ValueError` → 500），引入 `seg_id()` 统一解析。

### 移除

- **内部评估文档**：`docs/FUSION-DESIGN.md`、`docs/FUSION-ROADMAP.md`、
  `docs/FUSION-METRICS.md`。
- **个人辅助脚本**：`tools/push-via-api.js`（含硬编码账号，功能已被标准 `git push` 取代）、
  `tools/shot-real.js`（Windows 专属调试脚本）。
- **死代码**：`server.py` 中零引用的 `import socket`。

## [0.2.0] - 2026-10-27

### 新增

- 首个公开发布版本：硬件清单解析、配置台（攒机）、报价引擎与导出、
  部署架构梳理、单价库版本化。

> 早期版本的变更记录未逐条留存；本文件自 0.3.0 起完整维护。
