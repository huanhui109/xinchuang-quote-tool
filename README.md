# 信创服务器配置报价工具

面向 IT 基础架构人员，对**海光 / 鲲鹏**信创服务器（x86 / ARM）进行架构梳理，并对物理机与虚拟机的不同配置、不同数量做价格成本测算；支持配置组合、实时算价、保存与导出配置单 / 报价单。

> 计价口径：虚拟机单价含许可与运维、不做阶梯折扣、虚拟机不折算宿主机、不计维保、物理机按架构分库。

## 开源说明

本仓库为**已脱敏**的公开版本，遵循 [MIT 许可证](LICENSE)。

- 代码、文档、测试 fixture 均已移除真实客户名称、内部系统代号、内部文档库链接、真实商务条款与本地绝对路径。
- 测试用 fixture（`tools/fixtures/*.json`）为**结构等价的合成数据**，由 `node tools/make-fixtures.js` 生成，可复现。
- `data/store.json` 属于运行时用户数据（含真实报价与导入记录），**已加入 `.gitignore`、不随仓库分发**；仓库内提供 `data/store.example.json` 作为干净示例。
- 内置单价均为**示例价**（`unit_price_cents` 多数为 0，标记「待询价」），请按实际询价结果替换后再用于正式报价。

## 快速开始

```bash
# 方式一（推荐）：双击 start.bat（Windows，自动探测 Python / Node 兜底）
# 方式二：命令行
python server.py          # 需要 Python 3.10+（或 python3 server.py）
# 方式三：无 Python 时，用 Node 兜底（仅静态，无 REST API）
node server.js            # 需要 Node.js 18+
# 然后浏览器打开：
http://localhost:8000
```

零第三方依赖，无需 `pip install` / `npm install`。

## 快速开始

```bash
# 方式一（推荐）：双击 start.bat（Windows，自动探测 Python / Node 兜底）
# 方式二：命令行
python server.py          # 需要 Python 3.10+（或 python3 server.py）
# 方式三：无 Python 时，用 Node 兜底（仅静态，无 REST API）
node server.js            # 需要 Node.js 18+
# 然后浏览器打开：
http://localhost:8000
```

零第三方依赖，无需 `pip install` / `npm install`。

**运行架构**：`server.py` 同时提供**静态页面**与 **REST API**（`/api/*`），数据持久化在项目目录 `data/store.json`。
前端 `app.js` **优先调用后端接口**（多标签页/跨会话共享，重启不丢）；当后端不可用时（WorkBuddy 预览面板、纯静态托管、离线）**自动回退浏览器 localStorage**，功能依然完整。Excel/CSV 导出在浏览器端实时生成。

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
server.py            # 启动脚本（Python）：静态服务 + REST API（http.server，零依赖），端口占用自动顺延
server.js            # 启动脚本（Node 兜底）：仅静态服务，未安装 Python 时使用
web/index.html       # 前端入口（相对路径引用资源，可直接静态托管）
web/styles.css       # 样式
web/app.js           # 前端逻辑（原生 JS SPA；优先后端 API，不可用时回退 localStorage + 浏览器端 xlsx/csv）
web/arch-graph.js    # 部署架构图引擎：组件派生 / 分层布局 / draw.io XML 生成与回解析（纯函数，可 Node 单测）
web/arch-diagram.js  # 架构图页面：draw.io embed 集成 + 内置离线编辑器 + 保存/导出/重排
web/hcl-core.js      # 硬件清单解析引擎：规则匹配 / 表头列映射 / 合并行继承 / 规格文本解析 / 去重（UMD，可 Node 单测）
web/xlsx-read.js     # 浏览器端 xlsx/csv 读取（后端不可用时的兜底，基于原生 DecompressionStream）
web/hcl-view.js      # 硬件清单解析页面：上传 / 纠偏 / 明细校对 / 模板沉淀 / 默认已选配置 / 应用
docs/ARCH-DIAGRAM.md # 架构图模块说明（数据格式、配置项、边界情况）
docs/HW-CONFIG-PARSER.md # 硬件清单解析模块说明（数据结构、配置项、边界情况）
tools/test-arch.js   # 架构图单元测试（布局算法 / XML 往返 / 视图冒烟）
tools/test-hcl.js    # 硬件清单解析单元测试（合成清单 fixture + 边界场景）
tools/test-quote.js  # 报价链路单元测试（算价 / 选配部件 / 模板 / 校验 / 安全 / xlsx 结构 / 配置台布局）
tools/verify-layout.js  # 配置台布局结构验证：DOM 嵌套关系 + CSS 规则（E-3）
tools/verify-xlsx.js   # xlsx 导出端到端验证：严格 ZIP 解析 + 边界场景（E-1 / E-2）
tools/test-docs.js   # 文档一致性检查：README 与 docs 里的每个代码锚点都必须真实存在（D-6）
tools/test-app-smoke.js  # SPA 离线回退全路由冒烟测试
tools/make-fixtures.js  # 生成脱敏合成 fixture（tools/fixtures/*.json）
tools/fixtures/*.json    # 脱敏后的合成解析 fixture（宽表式 / 自由文本式各一份）
data/store.json      # 运行时数据（已 gitignore）：首次启动自动生成示例数据；删除即恢复默认示例
data/store.example.json  # 干净的示例数据（等价于内置 seed_store() 的输出）
start.bat            # Windows 一键启动（自动探测 python → python3 → node 兜底）
```

> 全量自测（建议提交前跑一遍）：
>
> ```bash
> node tools/test-all.js
> ```
>
> 一次跑完 7 套（解析 / 架构图 / 报价链路 / SPA 冒烟 / 布局 / xlsx 导出 / 文档一致性），
> 任一失败即以非 0 退出码结束。
>
> `test-docs.js` 发现「文档写了但代码没有」会**以非 0 退出码失败**，可直接接入 CI，
> 保证文档持续可作为验收依据。

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
> 若 WorkBuddy 预览面板无法加载（静态快照不执行脚本），请用 `python server.py` 打开 `http://localhost:8000`。

## 已知边界（本期不做）

阶梯折扣、宿主机超分/预留/HA 折算、维保计算、在线支付、多供应商招投标、角色权限（单机自用，成本价防泄为后续迭代项）。

## 依赖

| 项 | 要求 | 说明 |
|---|---|---|
| Python | 3.10+（推荐） | 运行 `server.py`，提供静态服务 + REST API。仅用标准库，**无需 pip 安装** |
| Node.js | 18+ | 兜底方案：`node server.js` 仅提供静态页面；也用于运行测试脚本 |
| 浏览器 | 支持 ES2020 的现代浏览器 | 前端为原生 JS SPA，无构建步骤、无打包器 |

前端无第三方运行时依赖：xlsx 读写、CSV 导出、ZIP 打包、架构图布局均为自研实现（`web/xlsx-read.js`、`web/app.js`、`web/arch-graph.js`）。

## 测试

```bash
node tools/test-all.js
```

一次跑完 7 套（解析 / 架构图 / 报价链路 / SPA 冒烟 / 布局 / xlsx 导出 / 文档一致性），任一失败即以非 0 退出码结束，可直接接入 CI。

## 许可证

[MIT](LICENSE) © huanhui109

## 免责声明

本工具输出的是基于**单机维护**的单价库的成本测算结果，不含阶梯折扣、维保、宿主机折算等因素，
亦不构成任何形式的商业报价。正式对外报价请以实际询价与合同为准。

