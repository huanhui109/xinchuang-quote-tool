# 信创服务器配置报价工具

**当前版本 v0.3.0** · [MIT 许可证](LICENSE) · [变更日志](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md)

面向 IT 基础架构人员，对**海光 / 鲲鹏**信创服务器（x86 / ARM）进行架构梳理，并对物理机与虚拟机的不同配置、不同数量做价格成本测算；支持配置组合、实时算价、保存与导出配置单 / 报价单。

> 计价口径：虚拟机单价含许可与运维、不做阶梯折扣、虚拟机不折算宿主机、不计维保、物理机按架构分库。

## 项目简介

### 解决什么问题

信创服务器采购里，**报价**与**落位**是两条互相割裂的线：

- **售前**在配置台里攒机型、算总价、导报价单 —— 但算完之后，机型规格、U 位占用、实际采购价散落在各人的表格里；
- **交付 / 运维**拿到的是一份「14 台 Hygon 5480」的清单，却不知道每台该放哪个机柜的哪个 U 位，也不知道哪台还没采购、哪台已上架；
- **管理层**想看全局投入与资产分布，拿到的却是一份含明细成本的报价单。

本工具把这条链路接起来：

```
单价库 → 配置台 → 报价单 → 交付批次 → 设备台账 → 机柜 U 位视图 → 上架预校验
```

### 为谁而做

| 角色 | 能拿到什么 | 用它解决什么 |
|---|---|---|
| 售前 `sales` | 全量（单价库 / 配置台 / 报价单 / 资产侧） | 快速出具可信报价，避免手工算价漏项 |
| 交付 `delivery` | 资产侧全量 + 交付批次 + 采价反馈 | 把报价单拆成可上架的设备批次与 U 位预分配 |
| 运维 `ops` | 资产侧全量 + 采价反馈 + 上架预校验 | 核对物理落位，提前发现 U 位冲突与容量缺口 |
| 管理层 `viewer` | 报价单**含税总价汇总** + 资产侧只读 | 看投入与资产分布，不接触明细成本 |

> 角色是**请求头自声明**的（`X-Role`），只做「口径隔离」不是身份认证 —— 详见 [安全说明](SECURITY.md)。

### 技术形态

- **前端**：原生 JS SPA（无构建、无打包器、零第三方运行时依赖）。xlsx 读写、CSV 导出、ZIP 打包、架构图布局全部自研。
- **后端**：Python 3.10+ **标准库**（`http.server`），同时提供静态服务与 REST API，JSON 文件持久化，**无数据库**。
- **双环境兜底**：后端不可用时前端自动回退浏览器 localStorage，功能依然完整；未安装 Python 时可用 Node 纯静态兜底。

## 开源说明

本仓库为**已脱敏**的公开版本，遵循 [MIT 许可证](LICENSE)。

- 代码、文档、测试 fixture 均已移除真实客户名称、内部系统代号、内部文档库链接、真实商务条款与本地绝对路径。
- 测试用 fixture（`tools/fixtures/*.json`）为**结构等价的合成数据**，由 `node tools/make-fixtures.js` 生成，可复现。
- `data/store.json` 属于运行时用户数据（含真实报价与导入记录），**已加入 `.gitignore`、不随仓库分发**；仓库内提供 `data/store.example.json` 作为干净示例。
- 内置单价均为**示例价**（`basis` 字段标记「示例价，待替换」），**不代表任何厂商的真实报价**；请按实际询价结果替换后再用于正式报价。单价为 `0` 的机型才表示「待询价」，二者是不同状态。

## 快速开始

### 一键启动（推荐）

- **Windows**：双击 `start.bat`，自动探测 Python / Node 兜底。
- **macOS / Linux**：运行 `./start.sh`，默认启动 Python 完整后端环境：

```bash
./start.sh                 # 启动 Python 完整环境（默认）
./start.sh start node      # 启动 Node 纯静态兜底环境
./start.sh start all       # Python + Node 同时启动（各自占用不同端口）
./start.sh status          # 查看运行状态与访问地址
./start.sh stop            # 停止全部
```

### 命令行手动启动

```bash
python server.py          # 需要 Python 3.10+（或 python3 server.py）
node server.js            # 需要 Node.js 18+（无 Python 时兜底，仅静态、无 REST API）
# 然后浏览器打开：
http://localhost:8000
```

零第三方依赖，无需 `pip install` / `npm install`。

**运行架构**：`server.py` 同时提供**静态页面**与 **REST API**（`/api/*`），数据持久化在项目目录 `data/store.json`。
前端 `app.js` **优先调用后端接口**（多标签页/跨会话共享，重启不丢）；当后端不可用时（静态预览面板、纯静态托管、离线）**自动回退浏览器 localStorage**，功能依然完整。Excel/CSV 导出在浏览器端实时生成。

> 端口说明：默认 `8000`。若该端口被占用，服务会**自动顺延**到 8001、8002… 并在启动日志中提示实际使用的端口（`PORT=9000 python server.py` 可手动指定）。
>
> 架构图模块默认使用官方 `https://embed.diagrams.net/`；内网或离线环境可通过 `DRAWIO_EMBED_URL` 指向自建 drawio 静态服务，无法联网时会自动降级到内置离线编辑器。

## REST API（可直接测试）

服务启动后，所有接口均为 `http://localhost:8000/api/*`，返回 JSON：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/info` | 服务信息 |
| GET / POST | `/api/settings` | 税率等设置 |
| GET | `/api/os_options`、`/api/hypervisor_options` | 操作系统 / 虚拟化平台选项 |
| GET / POST | `/api/versions` | 单价库版本列表 / 克隆新版本（复制机型部件并启用） |
| PUT | `/api/versions/<id>/activate` | 切换生效版本 |
| GET / POST / PUT / DELETE | `/api/machines`、`/api/parts`、`/api/vm_prices`、`/api/vm_flavors` | 物理机 / 部件 / 虚拟机资源单价 / 虚拟机规格组合 |
| GET / POST / DELETE | `/api/quotes`、`/api/quotes/<id>` | 报价单 |
| GET / POST | `/api/library/export`、`/api/library/import` | 单价库整体导出 / 导入 |
| GET / PUT | `/api/cfg` | 拓扑白板状态（布局、连线、部署组件） |
| GET | `/api/arch/config` | 架构图配置（draw.io embed 地址、超时、布局选项） |
| GET / PUT / DELETE | `/api/arch/diagram` | 部署架构图（组件清单 / 布局结果 / draw.io XML） |
| GET | `/api/hcl/config` | 硬件清单解析配置（上传上限、行列上限、解析规则、页面选项） |
| GET / PUT | `/api/hcl/rules` | 解析规则读写（JSON，可编辑以适配新供应商格式） |
| POST | `/api/hcl/parse` | 上传 xlsx/csv（内容 base64），返回 `{sheets:[{name,rows}]}` |
| GET / PUT / DELETE | `/api/hcl/state` | 规格模板沉淀 + 默认已选配置 + 导入记录 |

### 资产侧接口

以下接口带角色裁剪：`X-Role: sales|delivery|ops|viewer`（缺省 `sales`）。
⚠ 这是**自声明角色**（`role_source = self_declared`），只做「口径隔离」不是身份认证。

| 方法 | 路径 | 说明 | 可见角色 |
|---|---|---|---|
| GET | `/api/whoami` | 当前角色的能力矩阵 | 全员 |
| GET | `/api/catalog` | 机型目录（**脱敏**：只给规格，不含价格） | 全员 |
| GET | `/api/rooms`、`/api/racks` | 机房 / 机柜 | 全员 |
| POST / PUT / DELETE | `/api/rooms`、`/api/racks` | 机房 / 机柜维护 | sales / delivery / ops |
| GET | `/api/rack_units`、`/api/rack_units/<rack_id>` | U 位占用账本（每半 U 一行） | 全员 |
| GET | `/api/devices`、`/api/devices/<id>` | 设备台账（可加 `?scope=runtime` 或 `?scope=plan`） | 全员 |
| POST / PUT / DELETE | `/api/devices` | 设备台账维护（高度由服务端按机型带出） | sales / delivery / ops |
| GET | `/api/rackview?rack_id=<id>` | 机柜 U 位视图（占用位 + 三类冲突分列） | 全员 |
| POST | `/api/space/validate` | 上架可行性预校验（**只读**，不写任何数据） | 全员 |
| GET | `/api/deliveries`、`/api/deliveries/<id>` | 交付批次 | 全员 |
| POST | `/api/deliveries` | 报价单 → 交付批次（可 `dry_run` 预演） | sales / delivery |
| GET | `/api/assets/export` | 资产台账脱敏导出（固定 7 列，无单价 / 税率 / 含税价） | 全员 |
| GET / POST | `/api/price_feedback` | 采价反馈（本人可见；采价权 ≠ 发布权） | sales / delivery / ops |
| GET | `/api/asset_changes`、`/api/reconciliations`、`/api/links` | 变更流水 / 对账 / 链路 | 全员 |
| GET | `/api/events/health` | 埋点健康度（dropped 计数外露） | 全员 |
| POST | `/api/events` | 埋点上送 | 全员 |
| GET | `/api/quotes` | 报价单（**viewer 只得含税总价汇总投影**，无条目明细） | sales / viewer |

快速验证（服务已启动时）：

```bash
curl http://localhost:8000/api/versions
curl http://localhost:8000/api/machines
curl http://localhost:8000/api/vm_prices
# 写入示例
curl -X POST http://localhost:8000/api/machines \
  -H "Content-Type: application/json" \
  -d '{"brand":"海光","model":"Test","arch":"海光(C86/x86)","cpu_cores":32,"mem_capacity":256,"unit_price_cents":8600000}'
```

> 说明：`/api/machines` 等集合接口只返回**当前生效版本**下的数据（`version_id` 过滤），与页面展示一致。

> **角色隔离可当场验证**（服务已启动时）：
> ```bash
> curl -i http://localhost:8000/api/quotes -H 'X-Role: ops'          # 403
> curl -s http://localhost:8000/api/quotes -H 'X-Role: viewer'        # 只有汇总，无 items
> curl -s http://localhost:8000/api/assets/export -H 'X-Role: ops'   # 7 列，无任何价格字样
> ```

## 功能菜单

- **概览**：关键指标与快速入口
- **单价库**
  - 物理机机型（按海光 / 鲲鹏分架构，整机报价）
  - 可选部件（内存 / 硬盘 / 网卡 / RAID，受架构约束）
  - 虚拟机资源单价（vCPU / 内存 / 存储，综合单价）
  - 虚拟机规格组合（如 4C8G / 4C16G 等常用搭配，按资源单价自动算价；可一键加入配置台）
  - 版本管理（克隆新版本、切换生效版本；报价单锁定版本号）
- **配置台（攒机）**：左侧槽位、中部「清单视图 / 拓扑白板」切换、右侧单价库选件；物理机按标准整机配置参数展示（CPU / 内存 / 硬盘 / 网卡 / 电源 / 导轨），**不在单台叠加选配部件**；自动校验「机型=操作系统=虚拟化平台」架构一致；虚拟机按资源直乘。**部署组件 / 用途拆分为「用途 + 主备角色（主/备/单机）」**，便于标注单台服务器主备关系，并与硬件清单解析的用途注册表联动
- **硬件清单解析**：上传不同供应商的硬件配置 Excel/CSV，按**可配置解析规则**自动识别工作表、表头（支持多行合并表头）、列映射与规格（CPU 型号/核数/主频、内存条数×单条容量、硬盘块数×容量×介质、网卡端口×速率、RAID、电源），输出统一的物理机机型与虚拟机规格；**自动沉淀常用规格模板**并按「用途 + 数量」生成**默认已选配置基线**；支持人工纠偏（改用途/形态/数量/规格）、替换规格、增删行，**重复导入按去重键更新而非追加**，可一键应用至配置台。详见 [docs/HW-CONFIG-PARSER.md](docs/HW-CONFIG-PARSER.md)
- **拓扑白板（拖拽 + 自定义连线）**：画布以编号单台服务器节点展示配置项，节点可鼠标拖拽自由排版；**默认不再有网络/交换机，改由用户「连线模式」点选两个节点自行建立互联关系**；每个节点展示「归入分组 + 用途 + 主备角色」并与配置台联动；连线与布局持久化
- **报价单**：保存 / 查看 / 导出（Excel / CSV），含税总价与单价库版本号
- **架构梳理**：由「拓扑白板」自动提取 —— 依据各服务器部署组件与互联关系，汇总业务系统的部署组件、资源类型、服务器数量及互联关系；表格内「部署组件(用途)」支持直接编辑（与硬件清单解析的用途注册表联动），并新增独立的「归入分组」下拉；**不再支持手工导入**
- **架构图 · draw.io（当前隐藏）**：由部署组件清单**自动生成分层拓扑图**（用途分组 + 依赖分层 + 副本数聚合），集成开源 **draw.io（diagrams.net）Embed 前端组件**在页面内手工编辑（拖拽 / 增删节点 / 调整连线 / 分组 / 改样式），可保存回后端、导出 `.drawio`，并支持**回解析后再次自动布局**；无外网时自动降级到内置离线编辑器。详见 [docs/ARCH-DIAGRAM.md](docs/ARCH-DIAGRAM.md)。如需启用，将 `web/app.js` 中 `FEATURES.archDiagram` 设为 `true`。
- **数据导入导出**：单价库 JSON 备份与迁移
- **系统设置 / 关于**：税率、口径说明、范围边界
- **资产侧能力**
  - **设备台账**：统一设备实例台账 —— SN、机柜 U 位、状态、用途/主备；新增设备只需填「机型 + SN + 机柜 + U 位」，**机型规格（架构/核数/内存/盘位）由服务端按机型带出**，无需二次录型号
  - **机房 · 机柜**：机房 → 机柜 → U 位空间模型；`rack_units` 为**权威占用账本**（每半 U 一行，`u_index = round(u × 2)`），同柜同一 U 位不可重复占用
  - **U 位视图**：机柜正视 U 位图，按 **0.5 网格**渲染（半 U 设备不错位半格），占用位**红色标出**，冲突按三类分列展示
  - **交付批次**：报价单按「物理机」行拆成 N 台设备实例并预分配 U 位，形成待上架批次；支持只预演不落库
  - **采价反馈**：交付/运维可提交实际采购价（**采价权 ≠ 发布权**），仅本人与售前可见
  - **导出台账（脱敏）**：固定 7 列（资产编号/型号/SN/机房/机柜/U位/状态），**无单价、无税率、无含税价**，且不提供「显示价格」开关

### 角色与视图边界

页面右上角可切换角色，四种视角对应四种可见范围。**菜单级隔离 + 服务端裁剪双重生效** —— 前端隐藏只是体验，接口层仍会拒绝：

| 角色 | 可见范围 | 不可见 |
|---|---|---|
| 售前 `sales` | 全部（单价库 / 配置台 / 报价单 / 资产侧） | —— |
| 交付 `delivery` | 资产侧全部 + 交付批次 + 采价反馈 | 单价库、报价单（服务端 403） |
| 运维 `ops` | 资产侧全部 + 采价反馈 + 上架预校验 | 单价库、报价单（服务端 403） |
| 管理层 `viewer` | 报价单**含税总价汇总** + 资产侧只读 | 报价条目明细、单价库、采价反馈 |

> 概览页按角色分叉：售前看「报价口径」仪表盘，其余角色看「物理落位」概览 —— 强行给运维看售前仪表盘只会得到一屏空数据。

## 计价规则

```
物理机行 = (整机单价 + Σ选配部件单价×数量) × 数量      # 选配部件（C-1）在整机价之外另计
虚拟机单台 = vCPU×P_cpu + 内存×P_mem + 存储×P_sto   # 综合单价，不折算宿主机
订单含税总价 = Σ行金额 × (1 + 税率)                    # 无阶梯、无维保
```

税率保存在 `settings.tax_rate`，在「概览 → 税率」中调整；含税总价与税额均按「分」取整，避免浮点误差。

金额统一以「分」为整数单位计算，避免浮点误差。示例（性能版配置：14 台 Hygon 5480 + 7 台 4C/16G/100G 虚拟机，税率 13%）：含税总价 **1,499,736 元**。

## 方案模板与方案对比（C-4 / C-2）

配置台左栏提供三套模板：**性能版 / 标准版 / 最小版**。模板只决定「每类节点配多少台、每台多少资源」，
机型与选配部件仍从单价库选，不引入新的定价口径。应用模板会清空现有配置行（有二次确认）。

「方案对比」在同一套计价口径下给出三组结果，便于判断该走虚拟化还是换 CPU 平台：

| 方案 | 含义 |
|---|---|
| 当前方案 | 现有物理机 + 虚拟机配置 |
| 方案 A | 物理机全部转虚拟化（按核数折算台数与规格） |
| 方案 B | 海光 x86 → 鲲鹏 ARM 迁移（自动换成目标架构中配置最接近的机型，并重匹配 OS / 虚拟化平台） |

## 一致性校验（C-6）

物理机配置行除架构一致性外，还做四项规格校验。字段缺失一律跳过（不猜测、不误报）：

| 校验 | 规则 | 触发条件 |
|---|---|---|
| 内存通道上限 | 加装内存不得超过整机可插容量 | 存在内存类选配部件 |
| 盘位 / RAID 匹配 | 基础盘数 + 选配盘数 ≤ 机型 `disk_bays`；RAID 卡端口数需覆盖全部硬盘 | 机型已标盘位 |
| 电源功率 | 额定功率 ≥ 峰值功耗 × 1.2（峰值 = CPU TDP × 路数 + 12W/盘 + 100W） | 机型 CPU 在已知 TDP 库 |
| 机架 U 匹配 | 整机高度(U) ≤ 导轨标注 U 数 | 机型与导轨均已标 |

规格校验不阻断保存，但会在汇总条与配置行上给出警示。

## 导出 Excel 的正确性保证（E-1 / E-2）

配置清单 / 报价单 / 方案对比表均由浏览器端 `buildXlsx()` 直接打包成 xlsx（无第三方库）。
该产物是**手写 ZIP + OOXML**，字段顺序错一个字节，Excel 就会报「文件已损坏且无法修复」，因此：

| 风险点 | 处理 |
|---|---|
| ZIP 中央目录记录 | 严格按 46 字节固定头写入；`external attrs` 之后紧跟 `local header offset`。**历史 BUG 即出在此处多写了一个 2 字节字段，导致文件名与偏移整体错位** |
| ZIP 时间戳 | 固定为 2020-01-01（导出结果可复现，且避免全 0 时间戳被严格解析器判非法） |
| XML 非法控制字符 | `xclean()` 剔除 `0x00-0x08 / 0x0B / 0x0C / 0x0E-0x1F`（`\t \n \r` 保留）；混入一个即导致 Excel 判定文件损坏 |
| 非法数值 | `NaN` / `Infinity` 不写数值单元格，退化为文本，避免非法 XML 数值 |
| 工作表名 | `sheetNameSafe()`：剔除 `: \ / ? * [ ]`、按码点截断 31 字符、空名兜底、重名自动加序号；**顺序必须「先截断后转义」**，反序会把 `&amp;` 截成非法实体 |

验证方式：`node tools/verify-xlsx.js` 走真实导出链路产出文件，用**严格 ZIP 解析器**
逐字段校验（签名 / 偏移 / CRC32 / 中央目录长度），并覆盖多 sheet、重名、大数据量等边界。

## 配置台布局（E-3）

三列结构：`配置槽位 ｜ 画布 + 实时报价汇总 ｜ 单价库选件`。

| 约束 | 原因 |
|---|---|
| `.cfg` 中间列为 `minmax(0,1fr)` | 网格项默认 `min-width:auto`，画布被 JS 写成固定像素宽后会**撑爆轨道**，把右侧选件面板挤出屏幕 |
| `.cfg-col` 设 `min-width:0` | 同上，允许中间列收缩，超出部分交由 `.topo-wrap` 自身横向滚动 |
| `.cfg-picker` `position:sticky` + 限高 + 内部滚动 | 选件面板常驻右侧，滚动画布时始终可见可点 |
| 画布宽度取自 `.topo-wrap.clientWidth` | 若取画布自身宽度，重新渲染后会**自我放大**（把滚动宽度当可视宽度），形成正反馈 |
| 实时报价汇总嵌在 `cfg-main` 内、画布之后 | 汇总条此前是 `.cfg` 的兄弟节点，画布很高时会被顶到屏幕之外 |

验证方式：`node tools/verify-layout.js` 解析模板的 DOM 嵌套关系 + 校验 CSS 规则。

## 安全基线

| 项 | 说明 |
|---|---|
| CSV 公式注入 | 导出时 `csvCell()` 对以 `=` `+` `-` `@` 或 Tab/CR/LF 开头的单元格加前置单引号转义 |
| 解压炸弹 | xlsx 解压**边解边计数**，超过预算立即 `cancel()` 中止（仅校验 zip 头声明值不足以防伪造） |
| 离线提示 | 后端不可达时顶部常驻横幅，明确提示「仅存 localStorage、不会写入 store.json」 |
| 错误分级 | 仅**网络不可达**才回退 localStorage；后端 4xx/5xx 一律抛出，避免「以为保存成功」 |

## 列映射纠偏（C-7）

硬件清单解析页的「列映射纠偏」面板可把任意列手动指派为语义字段（用途、数量、CPU 型号、内存…），
点「重新解析」即生效，无需改 JSON。未指定的字段保留自动识别结果；越界索引会被忽略。
「恢复自动识别」可一键清空手动映射。

## 目录结构

```
VERSION              # 版本号单一来源（纯文本单行，如 0.3.0）
server.py            # 启动脚本（Python）：静态服务 + REST API（http.server，零依赖），端口占用自动顺延
server.js            # 启动脚本（Node 兜底）：仅静态服务，未安装 Python 时使用
web/index.html       # 前端入口（相对路径引用资源，可直接静态托管）
web/styles.css       # 样式（设计令牌 + 组件样式）
web/ui.js            # 通用 UI 组件层：Toast / Confirm / Modal / Prompt / Tooltip / 空状态 / 表单构建器 / DataTable
web/app.js           # 前端逻辑（原生 JS SPA；优先后端 API，不可用时回退 localStorage + 浏览器端 xlsx/csv）
web/arch-graph.js    # 部署架构图引擎：组件派生 / 分层布局 / draw.io XML 生成与回解析（纯函数，可 Node 单测）
web/arch-diagram.js  # 架构图页面：draw.io embed 集成 + 内置离线编辑器 + 保存/导出/重排
web/hcl-core.js      # 硬件清单解析引擎：规则匹配 / 表头列映射 / 合并行继承 / 规格文本解析 / 去重（UMD，可 Node 单测）
web/xlsx-read.js     # 浏览器端 xlsx/csv 读取（后端不可用时的兜底，基于原生 DecompressionStream）
web/hcl-view.js      # 硬件清单解析页面：上传 / 纠偏 / 明细校对 / 模板沉淀 / 默认已选配置 / 应用
docs/ARCH-DIAGRAM.md # 架构图模块说明（数据格式、配置项、边界情况）
docs/HW-CONFIG-PARSER.md # 硬件清单解析模块说明（数据结构、配置项、边界情况）
tools/test-all.js    # 统一测试入口：一次跑完 11 套，任一失败即以非 0 退出码结束
tools/test-hcl.js    # 硬件清单解析单元测试（合成清单 fixture + 边界场景）
tools/test-arch.js   # 架构图单元测试（布局算法 / XML 往返 / 视图冒烟）
tools/test-quote.js  # 报价链路单元测试（算价 / 选配部件 / 模板 / 校验 / 安全 / xlsx 结构 / 配置台布局）
tools/test-app-smoke.js  # SPA 离线回退全路由冒烟测试
tools/test-fusion.js # 融合模型单测（角色裁剪 / 锚点字段 / 资产侧路由渲染 / 离线不白屏）
tools/test-backend.py # 后端 API 契约测试（真起 server.py 子进程跑 HTTP）
tools/test-backend.js # 上述 Python 套件的 Node 包装器（精确解析通过 / 失败数）
tools/verify-layout.js  # 配置台布局结构验证：DOM 嵌套关系 + CSS 规则（E-3）
tools/verify-xlsx.js   # xlsx 导出端到端验证：严格 ZIP 解析 + 边界场景（E-1 / E-2）
tools/verify-syntax.js # 前端脚本语法校验 + index.html 引用完整性 + 单测加载清单一致性
tools/verify-sanitize.js # 脱敏守卫：防止敏感内容被重新引入仓库
tools/make-fixtures.js  # 生成脱敏合成 fixture（tools/fixtures/*.json）
tools/fixtures/*.json    # 脱敏后的合成解析 fixture（宽表式 / 自由文本式各一份）
data/store.json      # 运行时数据（已 gitignore）：首次启动自动生成示例数据；删除即恢复默认示例
data/store.example.json  # 干净的示例数据（与内置 seed_store() 同源，个别措辞略有差异）
start.sh             # macOS / Linux 一键启动与运维（start / stop / restart / status / logs）
start.bat            # Windows 一键启动（自动探测 python → python3 → node 兜底）
CHANGELOG.md         # 变更日志（Keep a Changelog 格式）
CONTRIBUTING.md      # 贡献指南（开发环境 / 测试要求 / 提交规范 / 脱敏红线）
SECURITY.md          # 安全说明（含 X-Role 自声明头的信任边界）
.env.example         # 环境变量样例（16 项，全部带默认值与说明）
.github/workflows/test.yml # CI：Node + Python 矩阵，跑 node tools/test-all.js
```

> 全量自测（建议提交前跑一遍）：
>
> ```bash
> node tools/test-all.js
> ```
>
> 一次跑完 11 套（前端语法 / 脱敏守卫 / 硬件清单解析 / 架构图 / 报价链路 / SPA 冒烟 / 配置台布局 / xlsx 导出 / 融合模型单测 / 后端 API 契约 / 文档一致性），
> 任一失败即以非 0 退出码结束。
>
> `test-docs.js` 发现「文档写了但代码没有」会**以非 0 退出码失败**，可直接接入 CI，
> 保证文档持续可作为验收依据。

## 界面与交互体系

前端交互遵循一套统一的组件规范（`web/ui.js`），避免各页面各写一套导致体验割裂。

### 视图契约

每个路由在 `VIEW_META` 中声明三件事，渲染时统一落到顶栏：

| 声明 | 作用 | 示例 |
|---|---|---|
| `title` | 顶栏主标题，回答「我在哪」 | `配置台（攒机）` |
| `desc` | 顶栏副标题，回答「这个页面解决什么问题」 | `组合物理机与虚拟机，实时算价并校验架构一致性` |
| `actions()` | 顶栏右侧动作区，回答「此刻能做什么」 | `方案对比` / `导出配置清单` / `保存为报价单` |

> 页面级操作只出现在顶栏动作区，区块级操作（架构筛选、视图切换）留在区块内部，
> 两者不重复——避免同一个按钮在一屏里出现两次。

### 反馈组件

| 组件 | 用途 | 说明 |
|---|---|---|
| `UI.toast(msg, kind)` | 轻提示 | `kind` 分 `ok` / `err` / `warn` 三级语义，**成功与失败在视觉上必须能一眼区分**；允许多条堆叠，连续操作不互相覆盖 |
| `UI.confirm(msg, opts)` | 二次确认 | 替代原生 `confirm()`：可定制标题、按钮文案、危险态配色；支持 Esc 关闭 |
| `UI.prompt(msg, opts)` | 单值输入 | 替代原生 `prompt()`：可带默认值、占位符与校验 |
| `UI.modal({...})` | 弹窗 | 统一 head / body / foot 结构，支持 `lg` / `xl` 尺寸与焦点管理 |
| `UI.tip.showNear()` | 悬浮提示 | **锚点定位**（跟随鼠标会盖住相邻单元格，密集表格里不可用） |
| `UI.empty(icon, text, hint, action)` | 空状态 | 必须是「图标 + 说明 + 下一步引导」，不能只写「暂无」 |
| `UI.buildForm(fields)` | 表单构建器 | 字段声明一处，取值与校验统一（`getValues()` / `validate()`） |
| `DataTable` | 数据表 | 统一「搜索 + 筛选 + 计数 + 图标化空状态」 |

> **渐进增强**：离线单测环境（`tools/test-*.js`）用极简 DOM 桩，没有弹窗宿主。
> 组件层会检测能力，必要时回退到原生 `confirm` / `prompt`，
> 既保住自动化测试的同步断言契约，又不影响真实浏览器的体验。

### 概览页（仪表盘）

概览页不是「几个数字 + 一段话」，而是回答四个问题：

1. **现在什么状态** —— 4 张可点击指标卡（配置台行数 / 当前含税总价 / 单价库规模 / 待询价机型），点击直接钻取到相关视图；
2. **有什么风险** —— 「待办与风险」区把**会影响报价准确性**的事项显式列出并分级（待询价机型、虚拟机单价缺失、架构不一致、规格校验未通过），点击直达处理页面；
3. **最近做了什么** —— 最近报价单列表（可点进详情）；
4. **下一步做什么** —— 单价库构成 + 工作流入口。

> 待询价机型（`unit_price_cents = 0`）必须在概览页显式提示：它与「真实 0 元」
> 在数据上无法区分，漏掉必然导致报价失真。

### 设计令牌

`web/styles.css` 顶部定义语义化令牌，命名按**用途**而非颜色外观：

```
--text-1/2/3   文本三级（主 / 次 / 弱）
--line/--line-2/--line-soft   描边三级
--brand/--brand-d/--brand-soft   品牌色
--ok/--warn/--danger + 各自的 -soft / -line 变体
--sp-1..6   间距节奏      --radius/--radius-sm/--radius-lg   圆角
--ease/--dur   动效
```

图标统一使用 inline SVG（`Icons` 对象），不使用 emoji——emoji 在不同系统/字体下
渲染差异大，且与页面内其它 SVG 图标风格割裂。



## 硬件清单解析（配置台 → 硬件清单解析）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `HCL_MAX_UPLOAD_BYTES` | 8388608（8MB） | 单次上传体积上限（前端同名为 `maxUploadBytes`） |
| `HCL_MAX_ROWS` / `HCL_MAX_COLS` / `HCL_MAX_SHEETS` | 5000 / 60 / 8 | 单表读取上限（超出截断并告警） |
| `HCL_MAX_UNZIP_BYTES` / `HCL_MAX_ZIP_ENTRIES` | 32MB / 200 | 解压炸弹防护 |
| `HCL_MAX_STATE_BYTES` | 4194304（4MB） | 模板 + 已选配置状态上限 |

读数约定（避免口径分歧）：`cpuCores` = **整机物理核总数**；`T/TB` 按硬盘厂商**十进制**（1T=1000G、3.84T=3840G）；写入单价库时 `cpu_cores` 记为**单颗核数**（与现有机型库一致）。
解析出的规格**不会**自动写入单价库，需人工点「加入单价库」或在应用时勾选「把新规格写入单价库」（单价为 0、`basis` 标记待询价）。

> 数据说明：删除 `data/store.json` 后重启服务，会重新生成内置示例数据（海光 5480/7470、鲲鹏 920 等）。
> 页面使用**相对路径**引用 `styles.css` / `app.js`，因此可将 `web/` 目录直接交给任意静态服务器托管；
> 但此时无后端，`app.js` 会自动回退 localStorage 模式（功能完整，仅数据存于当前浏览器）。
> 若静态预览面板无法加载（静态快照不执行脚本），请用 `python server.py` 打开 `http://localhost:8000`。

## 已知边界（本期不做）

阶梯折扣、宿主机超分/预留/HA 折算、维保计算、在线支付、多供应商招投标。

> 成本价防泄已通过「角色隔离 + 服务端价格字段投影 + 脱敏导出」实现（见[角色与视图边界](#角色与视图边界)）。
> 但角色是**请求头自声明**，只做口径隔离、不构成身份认证 —— 需要真正的权限体系请在网关层接入 SSO 后把角色写入签名令牌。

## 依赖

| 项 | 要求 | 说明 |
|---|---|---|
| Python | 3.10+（推荐） | 运行 `server.py`，提供静态服务 + REST API。仅用标准库，**无需 pip 安装** |
| Node.js | 18+ | 兜底方案：`node server.js` 仅提供静态页面；也用于运行测试脚本 |
| 浏览器 | 支持 ES2020 的现代浏览器 | 前端为原生 JS SPA，无构建步骤、无打包器 |

前端无第三方运行时依赖：xlsx 读写、CSV 导出、ZIP 打包、架构图布局均为自研实现（`web/xlsx-read.js`、`web/app.js`、`web/arch-graph.js`）。

## 配置项

全部通过**环境变量**配置，无配置文件依赖；样例见 [`.env.example`](.env.example)。未设置时使用下表默认值。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址。默认仅本机可访问；确需对外暴露再设为 `0.0.0.0` |
| `PORT` | `8000` | 监听端口。被占用时服务自动顺延到 8001、8002… 并在启动日志提示 |
| `STORE_DATA_DIR` | `<项目根>/data` | 数据目录（`store.json`、备份、埋点事件文件）。测试可用它做隔离 |
| `MAX_BODY_BYTES` | `33554432`（32MB） | REST 请求体上限，防止超大 JSON 打满内存 |
| `EVENTS_MAX_BYTES` | `10485760`（10MB） | 埋点事件文件单文件体积上限，超出自动轮转 |
| `EVENTS_KEEP` | `10` | 埋点事件文件保留份数 |
| `DRAWIO_EMBED_URL` | `https://embed.diagrams.net/` | 架构图编辑器地址。内网/离线可指向自建 drawio 静态服务 |
| `DRAWIO_LOAD_TIMEOUT_MS` | `12000` | draw.io 加载超时（毫秒），超时自动降级到内置离线编辑器 |
| `MAX_ARCH_XML_BYTES` | `8388608`（8MB） | 架构图 XML 体积上限 |
| `HCL_MAX_UPLOAD_BYTES` | `8388608`（8MB） | 硬件清单单次上传体积上限 |
| `HCL_MAX_ROWS` | `5000` | 单表读取行数上限（超出截断并告警） |
| `HCL_MAX_COLS` | `60` | 单表读取列数上限 |
| `HCL_MAX_SHEETS` | `8` | 单文件工作表数量上限 |
| `HCL_MAX_UNZIP_BYTES` | `33554432`（32MB） | 解压预算（解压炸弹防护） |
| `HCL_MAX_ZIP_ENTRIES` | `200` | zip 条目数上限 |
| `HCL_MAX_STATE_BYTES` | `4194304`（4MB） | 规格模板 + 已选配置状态上限 |

> `server.js`（Node 兜底）只读取 `HOST` 与 `PORT` 两项，其余配置仅 Python 后端生效。

## 本地启动与运维（start.sh）

项目提供两种运行环境，由 `start.sh`（Mac / Linux）统一管理：

| 环境 | 启动文件 | 能力 |
|---|---|---|
| `python` | `server.py` | 静态服务 + REST API + JSON 持久化（`data/store.json`），完整功能 |
| `node` | `server.js` | 纯静态托管，无 API，前端自动回退浏览器 localStorage |

> 双环境适用于：完整后端（多标签共享、跨会话持久化）与纯静态兜底（静态预览面板、离线、无 Python 环境）分别验证。

命令一览（环境可选 `python` / `node` / `all`，默认 `python` / `all`）：

```bash
./start.sh                 # 启动 python 完整环境
./start.sh start node      # 启动 node 纯静态兜底环境
./start.sh start all       # 两个环境一起启动（端口自动错开）
./start.sh stop            # 停止所有环境
./start.sh stop node       # 仅停止 node 环境
./start.sh restart         # 重启所有
./start.sh status          # 查看两环境状态、pid、访问地址
./start.sh logs            # 查看 python 日志（可跟 node）
./start.sh help            # 帮助
```

运维细节：
- 运行态产物（PID 文件、日志）统一放在 `.run/`，已被 `.gitignore` 忽略；
- 默认端口 `8000`，若被占用脚本自动顺延到下一个空闲端口，并在 `status` / 启动输出中给出实际地址；
- 停止采用「优雅 `SIGTERM` → 超时 `SIGKILL`」策略，避免数据文件（`store.json`）写一半被截断。

> 依赖 `lsof`（macOS / Linux 自带）做端口占用探测；Windows 请用 `start.bat`。若系统无 `lsof`，脚本会退化为逐端口绑定探测。

## 测试

```bash
node tools/test-all.js
```

一次跑完 11 套（前端语法/引用 / **脱敏守卫** / 硬件清单解析 / 架构图 / 报价链路 / SPA 冒烟 / 配置台布局 / xlsx 导出 / **融合模型单测** / **后端 API 契约** / 文档一致性），任一失败即以非 0 退出码结束，可直接接入 CI。

其中两套是 v0.3.0 新增、也是本项目此前最大的质量盲区补齐：

- `tools/test-backend.py`（经 `tools/test-backend.js` 包装）：**真起 `server.py` 子进程跑 HTTP**。此前 `server.py` 从未被真正执行过 —— 逻辑写错、接口 404、403 规则没生效，测试都能全绿。用 `STORE_DATA_DIR` 隔离数据目录，绝不污染真实的 `data/store.json`。
- `tools/test-fusion.js`：融合模型单测（角色裁剪、锚点字段、资产侧路由渲染、离线不白屏）。

```bash
python3 tools/test-backend.py   # 也可单独跑
node tools/test-fusion.js
```

## 许可证

[MIT](LICENSE) © huanhui109

版本变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 免责声明

本工具输出的是基于**单机维护**的单价库的成本测算结果，不含阶梯折扣、维保、宿主机折算等因素，
亦不构成任何形式的商业报价。正式对外报价请以实际询价与合同为准。

