# 硬件配置清单解析与默认选型 —— 功能设计说明

> 适用范围：配置台（攒机）→ 新增子菜单「硬件清单解析」
> 版本：v1.0（2026-10-21）
> 样例输入来源（已脱敏的合成样例，见 `tools/fixtures/`）：
> - A. `sample-wide-spec-list.xlsx`（**宽表列式**：CPU 型号 / 物理核 / 主频 / 内存 / 硬盘 / 网卡 各自成列，含合并单元格分组、一个 Sheet 内嵌两张表、末尾带「客户端配置要求」小节）
> - B. `sample-free-text-list.xlsx`（**自由文本列式**：部署应用 | 服务器配置（整段多行文本）| 服务器类型 | 数量）

---

## 一、目标与范围

| 需求点 | 本设计对应实现 |
|---|---|
| 支持多供应商 Excel，按表头/行列结构与内容关键字自动识别 | 规则驱动的「多 Sheet 打分选表 → 表头行定位 → 关键字列映射 → 逐行归一」四段流水线；规则 JSON 可编辑可扩展 |
| 输出统一的物理机机型与虚拟机规格数据 | 统一内部行模型 `HwRow`（含 `kind=phys/vm`、`spec`、`purpose`、`qty`） |
| 自动沉淀常用 物理机+虚拟机 规格搭配 | `Combo` 规格模板库，按 `signature` 去重累积 `useCount` 与来源追溯 |
| 按功能描述与数量自动填充默认已选配置 | `buildSelections()` 生成 `Selection[]`，含机型/规格、数量、用途；作为人工调整基线 |
| 重复导入不产生重复数据 | 三级去重键：`fileKey`（文件指纹）、`rowKey`（文件+行）、`selKey`（用途+规格），重导入走「更新」而非「追加」 |
| 不可识别行/字段明确提示 + 人工修正 | 行级 `status=ok/partial/failed` + `issues[]`，页面提供表头行/列映射/单元格三级人工纠偏 |

**本期不做**：价格解析与自动核价（供应商报价页/汇总页口径差异过大，仍需人工在单价库录入）；`.xls`（BIFF 二进制）直接解析；合并单元格跨 Sheet 联动；自动差额比价。

---

## 二、改动文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `server.py` | 修改 | 新增 4 个 REST 端点；`STORE` 增加 `hwlib` 分区并做旧库迁移；xlsx 解压（zipfile + ElementTree，零第三方依赖） |
| `web/hcl-core.js` | **新增** | 解析引擎。UMD 导出（`module.exports` + `global.HclCore`），纯函数、无 DOM 依赖，可直接被 Node 单测调用 |
| `web/xlsx-read.js` | **新增** | 浏览器端 xlsx 读取（无后端时的兜底，基于原生 `DecompressionStream`）+ CSV 读取 |
| `web/hcl-view.js` | **新增** | 页面视图：上传 → 预览纠偏 → 明细校对 → 沉淀库 → 已选配置 → 应用到配置台 |
| `web/app.js` | 修改 | NAV 菜单项、ROUTES 注册、`localApi` 回退分支 |
| `web/index.html` | 修改 | 引入 3 个新脚本 |
| `web/styles.css` | 修改 | 追加 `.hw-*` 样式（表单/徽标/表格/卡片/页签） |
| `docs/HW-CONFIG-PARSER.md` | **新增** | 本文档 |
| `tools/test-hcl.js` | **新增** | 单元测试：规则匹配、表头定位、合并行继承、规格文本解析、VM 识别、去重合并、边界（空表/超大/非法数量） |
| `tools/fixtures/*.json` | **新增** | 由两份真实清单抽取的 fixture（脱敏后保留结构），供无文件依赖的回归测试 |
| `README.md` | 修改 | 菜单、API、配置项说明 |

---

## 三、菜单与交互流程

### 3.1 菜单位置

```
报价
 ├ 配置台（攒机）        #/configurator
 ├ 硬件清单解析          #/hw-parse      ← 本次新增
 ├ 报价单                #/quotes
 ├ 架构梳理              #/arch
 └ 架构图 · draw.io      #/arch-diagram
```

「配置台（攒机）」页面顶部同步新增入口按钮「📥 从硬件清单导入」，可直接跳转；解析完成后按钮变回「应用至配置台」。

### 3.2 交互流程（5 步）

```
┌ ① 上传 ────────────────────────────────────────────────┐
│ 拖拽/选择 .xlsx / .csv（≤8MB）                          │
│ 前置校验：扩展名 → 体积 → 魔数（PK\x03\x04）             │
│ 读取：后端 /api/hcl/parse → 失败/无后端 → 浏览器端自解   │
└────────────────────────────────────────────────────────┘
                        ↓
┌ ② 解析预览（可纠偏）────────────────────────────────────┐
│ 命中规则：xxx（得分 n）；命中 Sheet：xxx                  │
│ [Sheet 下拉] [表头行号输入] [重新解析]                    │
│ 列映射表：每条 = 内部字段 ← 表格列下拉（自动选中，可改）  │
│ 规则编辑器：JSON 文本域，可「恢复默认」「保存规则」        │
└────────────────────────────────────────────────────────┘
                        ↓
┌ ③ 明细校对 ────────────────────────────────────────────┐
│ 表格：状态徽标 / 行号 / 用途 / 形态 / 数量 / 解析出的规格 │
│       / issue 提示                                       │
│ ✅ 正常  ⚠ 部分识别（黄）  ✖ 无法识别（红，默认不入库）   │
│ 🏷 用途徽标：<span class=ok>应用服务</span> 正常           │
│            <span class=err>未分组</span> 需人工补录       │
│ 行内可直接编辑：用途、数量、形态、机型关键字、CPU/内存/    │
│       存储；「重试该行」重新走规格解析                     │
│ 顶部统计：N 行 / 识别 n / 待修正 m；勾选项「忽略失败行」   │
│ ★「用途未分组 n」统计卡（红，可点击）→ 只看这些行          │
└────────────────────────────────────────────────────────┘
                        ↓
┌ ④ 页签：规格模板沉淀 │ 默认已选配置 ────────────────────┐
│ A. 规格模板库 Combo[]                                     │
│    签名摘要 + 用途 + 使用次数 + 来源文件                  │
│    操作：[加入单价库为机型] [查看详情] [删除]              │
│ B. 默认已选配置 Selection[]                               │
│    列：用途 / 形态 / 机型·规格 / 数量 / 来源 / 操作       │
│    操作：数量 ± 或直接输入、替换规格（下拉：单价库机型      │
│          + 规格模板）、删除行、＋手动新增行                │
│    按钮：[应用至配置台] [导出 CSV] [清空]                 │
└────────────────────────────────────────────────────────┘
                        ↓
┌ ⑤ 应用 ────────────────────────────────────────────────┐
│ 写入 CFG.phys / CFG.vm（persistCfg → 后端 + localStorage）│
│ 自动补齐 OS / HV（按机型架构匹配默认项）                  │
│ 若机型不存在：可勾选「同时把新机型写入单价库」             │
│ → 跳转 #/configurator                                    │
└────────────────────────────────────────────────────────┘
```

### 3.3 用途「未分组」的人工补录（3 个入口）

显示「未分组」= 该行用途文本没命中任何分组，只影响**用途归类**，不影响规格解析与数量；但会直接影响拓扑白板/架构图的分组与层级，所以建议补录。

| # | 位置 | 操作 | 生效范围 |
|---|---|---|---|
| **1** | **③ 明细校对 → 用途列文本框**（首选） | 直接输入如「数据库集群」「合规风控」，失焦即生效；输入框带 `datalist` 建议（分组名 + 常用关键字） | 该行 `purpose` → 重算 `purposeNorm` / `signature`；再点「按当前明细重新生成已选配置」同步到已选配置与模板 |
| **2** | **③ 明细校对 → 用途列右侧「归入分组…」下拉** | 直接选接入层 / 应用服务 / 中间件 / 数据服务 / 存储备份 / 基础设施，用分组名回填（分组名可自命中） | 同上，一步到位，无需想关键字 |
| **3** | **「默认已选配置」页签 → 用途列** | 同上两种（文本框 + 归入分组下拉） | 只改这一条已选配置；**`selKey` 保持不变**，避免重导入时漂移成重复行 |

辅助入口：

- 顶部统计卡 **「用途未分组 n」**（红色，n>0 时可点击）→ 一键切到「只看未分组用途」，逐行补录完再点按钮切回全部。
- 「只看未分组用途（n）」按钮位于明细校对表格上方，切换即时生效。
- 终端机（笔记本/台式机 `kind=endpoint`）不参与选型，显示为灰色「终端（不参与选型）」，**不计入 n**。

补录后的数据一致性：

- `purposeNorm` 立即重算（页面重绘，徽标由红转绿）；
- 点「按当前明细重新生成已选配置」时，用途会同步到已选配置**和**已沉淀的规格模板（按规格签名匹配并重算 `comboKey`）；
- 冲突策略默认「保留人工值」，所以人工补录的用途不会被下次导入覆盖（除非在纠偏区改成「以新清单覆盖」）。

### 3.4 用途注册表与配置台 / 架构梳理 / 拓扑白板的联动

解析出的 `purpose` 文本不会只留在「硬件清单解析」页面，而是进入**共享用途注册表**（`STORE.hwlib.purposes`），供全工具复用：

| 模块 | 关联字段 | 行为 |
|---|---|---|
| **硬件清单解析** | 明细校对 / 默认已选配置的「用途」文本框 | 用户输入或导入的值自动 `registerPurpose()`；新值立即进入注册表 |
| **配置台（攒机）** | 每行的「部署组件 / 用途」拆为 **用途 + 主备角色** | 用途输入框使用 `purposeRegistryList` 候选；角色下拉 `主 / 备 / 单机`；显示为 `${角色}-${用途}`，便于标注单台服务器主备关系 |
| **拓扑白板** | 节点内展示 | 节点显示「归入分组」标签 + 用途输入框 + 主备角色徽章；修改用途与配置台双向同步 |
| **架构梳理** | 表格列「部署组件(用途)」+ 新增「归入分组」 | 「部署组件(用途)」可直接编辑，候选来自注册表；「归入分组」为独立下拉，与用途字段分开，默认由 `purposeOf(用途)` 推导，可人工覆盖 |

数据模型扩展（`CFG.phys[i]` / `CFG.vm[i]`）：

```ts
{
  purpose: string;   // 用途（自定义，与硬件清单解析的 purpose 同口径）
  role: string;      // 主 / 备 / 单机 / ''
  group: string;     // 归入分组（接入层 / 应用服务 / 中间件 / 数据服务 / 存储备份 / 基础设施 / 未分组）
  deploy: string;    // 兼容旧数据：role + purpose 的显示串；新数据由 purpose + role 实时计算
}
```

向后兼容：旧数据仅含 `deploy` 字符串时，`migrateLine()` 会按 `^(主|备|单机)-` 拆分出 `role` 与 `purpose`，并自动推导 `group`。

### 3.5 重复导入时序

```
第 1 次导入 fileA.xlsx
  fileKey = md5(文件名 + 有效行数 + 首行摘要)
  → 生成 selections[n]，每条记 fileKey/rowIndexes
第 2 次导入同一 fileA.xlsx（含修订版）
  → fileKey 相同 → 进入「更新模式」
     · 旧 item 且与新 para 同 selKey  → 覆写为新版（若被人工改过则弹确
       认 / 默认保留人工值并标 conflict）
     · 仅在旧列表中的 item          → 标记 stale，询问「删除导入源已移除
       的行」（默认删除）
     · 仅在新列表中的 item          → 追加
```

---

## 四、数据结构定义

### 4.1 中间表（解析器输入，与 Excel 读取器解耦）

```ts
interface Sheet  { name: string; rows: Cell[][]; }         // rows 为原始二维数组
interface ParsedWorkbook { file: FileMeta; sheets: Sheet[]; }
type Cell = string | number | boolean | null;
```

> 合并单元格**不依赖** `merged` 元数据，改用「可继承列向下填充」（见 5.3），这样后端与浏览器两种读取路径行为一致。

### 4.2 解析规则（可配置，存于 `STORE.hwlib.rules`）

```jsonc
{
  "id": "wide-server-list",
  "name": "宽表式服务器配置清单（CPU/内存/硬盘分列）",
  "vendor": "通用",
  "enabled": true,
  "priority": 100,
  "sheet":  { "include": "硬件|配置清单|服务器配置|主机", "exclude": "阅读指南|软件要求|封面|变更" },
  "header": { "scanRows": 10, "maxHeaderRows": 3, "minScore": 3 },
  "repeatColumns": ["system", "hwType", "purpose", "required", "raid"],  // 合并单元格/分组列，向下继承
  "columns": {
    "system":    ["所属系统", "系统"],
    "purpose":   ["硬件用途", "用途", "功能描述", "服务器用途"],
    "hwType":    ["硬件类型", "服务器类型", "设备类型"],
    "apps":      ["部署应用", "部署服务", "应用软件"],
    "entity":    ["实体机/虚拟机", "服务器类型", "资源类型", "形态"],
    "required":  ["必选", "是否必选"],
    "qty":       ["数量", "台数", "服务器数量"],
    "cpuModel":  ["CPU型号", "CPU", "处理器", "CPU型号(参考)"],
    "cpuCores":  ["物理核", "核数", "CPU核数"],
    "cpuFreq":   ["主频", "频率"],
    "mem":       ["内存", "内存容量"],
    "disk":      ["硬盘", "容量", "硬盘容量"],
    "diskType":  ["转速", "介质", "硬盘类型"],
    "raid":      ["灾备", "RAID"],
    "nic":       ["网卡"],
    "remark":    ["备注"],
    "specText":  ["服务器配置", "配置说明", "硬件服务器配置", "配置参考", "规格"]
  },
  "vm": { "defaultStorageGB": 100 },
  "qty": { "default": 1, "unknownTokens": ["n", "N", "-", "待定"] }
}
```

规则匹配采用**加权打分**：`必得分字段`（`purpose`/`qty`）命中 ×3，其余字段 ×1；命中 ≥ `header.minScore` 且含 1 个必得分字段即视为命中该 Sheet；多个规则命中取 `priority` 高者，并列取得分高者；均不命中则走内置兜底规则 `generic`（纯关键字猜列），并把结果整体降级为 `partial` 提示。

### 4.3 解析行（解析产出，`HwRow`）

```ts
interface HwRow {
  id: string;                 // 'r3'
  sheetName: string;
  rowIndex: number;           // 表格内的 1 基行号
  status: 'ok' | 'partial' | 'failed';
  issues: Issue[];            // {field, level:'error'|'warn', msg}
  system: string;             // 所属系统（清单中「所属系统」列的取值）
  hwType: string;             // 硬件类型（如 服务器 / TDSQL For MySQL（二选一））
  purpose: string;            // 原始用途（如 数据库）
  purposeNorm: string;        // 归一化用途（接入层/应用服务/中间件/数据服务/存储备份/基础设施/未分组）
  apps: string[];             // 部署应用拆分（按 、,，/\n 切分，去重去空）
  kind: 'phys' | 'vm';        // 实体机 / 虚拟机
  optional: boolean;          // 必选=否
  qty: number;                // 数量（非法时回落 1 并记 warn）
  qtyUnknown: boolean;        // 原值为 n/待定
  spec: Spec;                 // 见下
  signature: string;          // 去重签名
  raw: Record<string, Cell>;  // 原始行（纠偏与排错用）
}

interface Spec {
  cpuModel: string;           // 'Hygon 5480'
  cpuSockets: number;         // 2
  cpuCores: number;           // = 单颗核数 × 路数? 存"整机物理核总数"
  cpuFreqGHz: number;         // 2.5
  memSticks: number;          // 4
  memStickGB: number;         // 32
  memCapacityGB: number;      // 128
  memGen: string;             // 'DDR4'
  disks: DiskItem[];          // [{count:2, sizeGB:1920, type:'SSD_SATA', raw:'1.92T（SSD_SATA）*2'}]
  diskDesc: string;           // 汇总串：'2×1.92T SSD_SATA'
  nics: NicItem[];            // [{count:4, speed:'1GE', media:'电口'}]
  nicDesc: string;
  raid: boolean; raidDesc: string;
  psuCount: number;
  brand: string;              // 海光/鲲鹏/其他，由 CPU 型号推定
  arch: string;               // '海光(C86/x86)' | '鲲鹏(ARM)' | ''
  sourceText: string;         // 该行参与解析的自由文本（便于人工核对）
}
```

### 4.4 规格模板（沉淀，存于 `STORE.hwlib.combos`）

```ts
interface Combo {
  id: string;
  key: string;                // kind|purposeNorm|signature
  kind: 'phys' | 'vm';
  name: string;               // '鲲鹏920 64核/128G/2×10GE' 或 '虚拟机 8C/32G/512G'
  purpose: string; purposeNorm: string;
  spec: Spec;
  machineId: number | null;   // 已入库为机型后的反向引用
  useCount: number;           // 出现次数（沉淀热度）
  sources: string[];          // fileKey 列表
  createdAt: string; updatedAt: string;
}
```

### 4.5 已选配置清单（默认选型，存于 `STORE.hwlib.selections`）

```ts
interface Selection {
  id: string;
  kind: 'phys' | 'vm';
  purpose: string;            // 用途（可人工改）
  apps: string[];
  qty: number;
  machineId: number | null;   // phys：指向单价库 machines
  modelText: string;          // phys：机型展示串（未入库时也能显示）
  cpu: number; memGB: number; stoGB: number;   // vm：规格三元组
  comboId: string | null;     // 引用的模板
  source: { fileKey: string; file: string; rowIndexes: number[] };
  selKey: string;             // kind|purpose|modelKey|cpu/mem/sto —— 重复导入去重键
  manual: boolean;            // 是否被人工改过（冲突时保护人工值）
  include: boolean;           // 是否参与「应用至配置台」
  note: string;
}
```

### 4.6 持久化分区

```ts
STORE.hwlib = {
  rules: Rule[],              // 默认规则 + 用户自定义
  combos: Combo[],
  selections: Selection[],
  imports: ImportRecord[],    // { fileKey, name, at, sheets, rows, ok, warn, comboFrom operated }
  purposes: string[],         // 共享用途注册表（硬件清单解析 / 配置台 / 架构梳理 共用）
  options: HclOptions,
  updatedAt: string | null
}
```

---

## 五、解析流程与关键算法

### 5.1 选 Sheet
对每个 Sheet 取前 `scanRows` 行做扁平文本：
1. Sheet 名匹配 `sheet.exclude` → 跳过（`阅读指南`、`软件要求` 直接排除）；
2. Sheet 名或首行命中 `sheet.include` → +2 分；
3. 列映射得分 ≥ `minScore` 且含必得分字段 → 成为候选；
4. 无候选 → 取混有 2 个以上关键字页数最多的 Sheet，规则降级为 `generic`，整体标 `partial`。

> 样例 A 的 Sheet 名 `硬件要求-生产环境中配(日成交笔数1-30万) ` 命中「硬件」关键字并顺带包含 include 词命中。

### 5.2 定位表头（支持多行/合并表头）
- 在 `scanRows` 窗口内，把连续 ≤ `maxHeaderRows` 行拼成一个「候选表头带」；
- 每个候选对每个 `columns` 关键字做包含匹配（去空白/换行后，不区分大小写），统计命中字段数；
- 取命中最多、且行数最少的组合；样例 A 中第 3–4 行双层表头被合并为 `所属系统|硬件用途|…|CPU 型号|物理核|主频|内存|硬盘 容量/转速/灾备|网卡|备注|硬件服务器配置(参考)`。
- 若某列标题为空但被上层表头跨列覆盖（多层表头的父子关系），用「父表头 + 子表头」拼接后再匹配，保证 「CPU 型号」不会因为父表头叫「CPU」而失配。

### 5.3 合并单元格/分组行 → 向下继承
标记在 `repeatColumns` 内的列：**当本单元格为空、且本行至少有 1 个「非继承列」有值时**，继承上一行同列的值。
样例 A 中 `B5:B7` 所属系统、`C5:C7` 硬件用途、`D6:D7` 硬件类型、`Q6:Q7` 备注 均能正确继承；而第 12 行全空的分隔行会被后续「空行跳过」逻辑丢弃。

### 5.4 行过滤
命中任一条件即跳过（并记 `skippedRows`）：
- 整行空；
- 行内文本以「提示：/注：/阅读指南/客户端配置要求」等节标题开头；
- 该行的关键列全部为空 **且** 未继承到任何分组值；
- 二次表头行（与候选表头文本相同）。

### 5.5 形态判定 `kind`
优先级：① 显式列语义（样例 B 列 = `物理机/虚拟机`；样例 A 列 = `实体机/虚拟机`）；② 规格文本含 `虚拟机/VM/云主机/云桌面`；③ 样例 B 的 `服务器类型` 列值即形态。均未命中 → 有 CPU/内存颗粒+pcs等整机描述则默认 `phys`，否则 `vm`，并记 warn。

### 5.6 数量
`2` / `2台` / `'2'` → 2；`n`/`N`/`待定`/空 → `defaultQty=1` 且 `qtyUnknown=true` 记 warn；负数/0 → 1 + warn；小数 → 向上取整 + warn。

### 5.7 规格解析（两条通道的结果合并）

**通道 1：结构化列**（样例 A）
- CPU 型号：`鲲鹏920 arm` / `Hygon5480` → 品牌 + 架构推定（`鲲鹏|kunpeng` → 鲲鹏(ARM)；`海光|hygon` → 海光(C86/x86)）
- 物理核：`64`（单颗）× 路数。路数来源优先级：型号后 `*N` → `2*` 前缀 → columns 中 `cpuSockets` 字段 → 默认 2 → 若核数本身明显是整机总核（如 64 且存在 `32Core@` 文本）采用文本。
  > 明确口径：**解析出的 `cpuCores` 一律为「整机物理核总数」**，避免与单价库现有 `cpu_cores` 语义打架。
- 主频：`3.0GHz` → 3.0
- 内存：`128G` / `144G` → capacity；若有 `*N` 且格式是 `32G … *4` 则sticks=4、单条 32G、capacity=128

**通道 2：自由文本行解析**（样例 B 与样例 A 的「硬件服务器配置(参考)」列）
按 `\n` 切行，逐行打BOOL：

| 类别 | 正则/关键字 | 样例 | 结果 |
|---|---|---|---|
| CPU | `Hygon\s*5480\s*\(?\s*32C\s*/?\s*2\.?5GHz\s*\)?\s*[*x×]\s*2` | `Hygon5480 (32C/2.5GHz) *2` | model=5480, cores/socket=32, freq=2.5, sockets=2 |
| CPU | `2*鲲鹏920 5220,32Core@3.0GHz` | 参考列 | sockets=2, model=鲲鹏920 5220, cores=64, freq=3.0 |
| 内存 | `32G DDR4 2933MHz ECC RDIMM *4` | `*4` | stick=32G, sticks=4, gen=DDR4, cap=128G |
| 硬盘 | `1.92T（SSD_SATA）*2` | | disk{count:2, sizeGB:1920, type:SSD_SATA} |
| 硬盘 | `480G SSD_SATA 固态硬盘 *2` | | disk{count:2, sizeGB:480} |
| 硬盘 | `3.84T NVMe *6` | | disk{count:6, sizeGB:3840, type:NVMe} |
| 网卡 | `1GE（电口）*4` / `10GE（光口,含光模块）*2` | | nic{count:4,speed:1GE,media:电口} |
| 网卡 | `2*万兆双光口（不含光模块）` | 参考列 | nic{count:2,speed:10GE,media:光口} |
| RAID | `RAID`/`阵列卡`/`超级电容`/`2G级存` | | raid=true |
| 电源 | `电源`/`白金` + `*2` | | psu=2 |

统一预处理：全角括号/乘号归一（`（）×`→`()x`）、`*`/`x`/`X`/`×` 统一为 `*`、`ns`、单位大小写（`T`→`TB`、默认 `G`→`GB`）。

**合并策略**：结构化列优先，文本仅补空缺；两边都有则以结构化列为准并在 issue 中给出 `spec_source` 标注，人工可在详情页切换。

### 5.8 用途归一化
与架构图模块复用同一字典（`ArchGraph.PURPOSE_RULES`），保证「解析 → 已选配置 → 拓扑白板 → 架构图」端到端口径一致：

| 关键字（部分） | 归一化 |
|---|---|
| 网关/接入/负载/均衡/proxy/前置 | 接入层 |
| web/应用/交易/清算/委托/报盘/资管/风控 | 应用服务 |
| redis/kafka/mq/中间件/zookeeper | 中间件 |
| 数据库/数据/db/ TDSQL / OceanBase / mysql | 数据服务 |
| 存储/nas/备份/ceph | 存储备份 |
| 管理/监控/运维/日志/云管 | 基础设施 |

样例 B 的部署应用是自然语言（如 `资产中心，极速订单，HCS、网关类（行情网关，交易网关,报盘）`），先按 `，,、/；;\n` 切词再逐一映射，取**出现次数最多**的类别作为 `purposeNorm`，并在 `apps[]` 保留原始词。

**三级命中（只扩召回，不新增分组名）**：

| 顺序 | 规则 | 说明 |
|---|---|---|
| ① | 主字典 `ArchGraph.PURPOSE_RULES` | 与架构图严格同源，保证口径一致 |
| ② | 行业扩展词 `EXTRA_PURPOSE_RULES` | 金融/交易系统常见词（风控、清算、委托、资管、估值、报盘、行情、结算、OCP、AMO…），**分组名集合与 ① 完全相同**，单测有断言保护 |
| ③ | 分组名自命中 | 「基础设施 / 存储备份 / 接入层」这类分组名反查自己也必须命中，否则人工选了分组仍是「未分组」 |

此外，用途文本有值但三级都未命中时，会**再用部署应用推导一次**（`PURPOSE_BY_APPS`），并打黄标提示人工核对；仍无法判定才落 `未分组`（`PURPOSE_UNKNOWN`）。终端机（`kind=endpoint`）不参与选型，**不计入待补录**。

### 5.9 去重键定义

| 级别 | 键 | 用途 |
|---|---|---|
| 文件 | `fileKey = md5(name + '|' + Σ(有效行文本前120字))` | 判断是否同一份清单的重导入 |
| 模板 | `comboKey = kind + '|' + purposeNorm + '|' + signature` | 模板沉淀累积 `useCount` |
| 已选 | `selKey = kind + '|' + purpose + '|' + (machineId ? 'm'+machineId : modelKey) + '|' + (cpu+'/'+memGB+'/'+stoGB)` | 重复导入不重复；更新而非追加 |

`signature` = `cpuModel|cpuCores|cpuFreq|memCapacityGB|disks摘要|nic摘要`（数值化后拼接，忽略空格与来源）。

---

## 六、配置项

### 6.1 后端环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HCL_MAX_UPLOAD_BYTES` | `8388608`（8MB） | 单次上传体积上限 |
| `HCL_MAX_ROWS` | `5000` | 单 Sheet 读取行数上限（超出截断并 warn） |
| `HCL_MAX_COLS` | `60` | 单行列数上限 |
| `HCL_MAX_SHEETS` | `8` | 读取 Sheet 数上限 |
| `HCL_MAX_STATE_BYTES` | `4194304`（4MB） | combos + selections 状态上限 |

### 6.2 页面选项（随 state 持久化）

| 项 | 默认 | 说明 |
|---|---|---|
| `autoPickSheet` | true | 自动选 Sheet；关则每次询问 |
| `applySkippedRows` | false | 是否把解析失败行也加入已选清单（默认丢弃） |
| `includeOptional` | false | 是否把「必选=否」的候选行纳入默认选型 |
| `materializeMachines` | false | 应用时是否把未入库机型写入单价库 |
| `conflictPolicy` | `'keep-manual'` | 重导入冲突策略：`keep-manual`（保留人工值）/ `overwrite` |

### 6.3 解析规则
页面「规则」面板可直接编辑 JSON 并保存至后端（或 localStorage 回退），提供「恢复默认」；导出/导入规则文件便于团队共享。

---

### 5.10 读数口径（避免与单价库口径打架）

| 字段 | 口径 | 说明 |
|---|---|---|
| `spec.cpuCores` | **整机物理核总数** | 宽表列「物理核」通常为总数；自由文本 `48C *2` 则按 48×2=96 计算 |
| `cpu_cores`（写入单价库时） | **单颗核数** | 与现有机型库一致；由 `cpuPerSocket` 或 `cpuCores / cpuSockets` 换算 |
| 容量单位 | `T/TB` 按**十进制**（1T=1000G、3.84T=3840G），`GB` 原样 | 与硬盘厂商标称一致 |
| `selKey` | 与「是否已入库为机型」**无关** | 只用「用途 + 规格签名」，避免入库后再次导入被判成新行 |

---

## 七、边界条件与异常场景

| # | 场景 | 处理 | 用户可见反馈 |
|---|---|---|---|
| E1 | 空 Sheet / 全空表 | `fail` | 「未在工作簿中找到可用数据表」，并列出所有 Sheet 名 + 前 10 行预览供人工选表/指定表头行 |
| E2 | 表头行不在 `scanRows` 内 | 降级 | 提示「未自动定位表头」，页面出现表头行输入框，手动填行号后重解析 |
| E3 | 列映射不全（如缺硬盘列） | `partial` | 行级黄标「未识别字段：硬盘」，仍生成行；数量/CPU/内存全缺 → `failed` |
| E4 | 数量非法（`n`/空/负/小数） | 兜底 | 回落 1 + 黄标「数量非法(原值 X)，已按 1 处理，请人工确认」 |
| E5 | 用途为空 | 兜底 | 用「所属系统 + 硬件类型 + 部署应用」推导；仍为空 → `未分组` + 黄标 |
| E6 | 同一 sheet 多张表（样例 A 的「客户端配置要求」小节） | 自动切分 | 检测到二次表头即另起一张逻辑表；客户端/终端类（笔记本/台式机/云桌面）默认标记 `kind=endpoint` 且**不纳入**物理机/虚拟机选型，仅在明细里展示并可勾选 |
| E7 | 二选一候选（样例 A：TDSQL vs OceanBase） | 分组冲突 | 「必选=否」行默认排除；同为「必选=是」但属于同一互斥组（硬件类型含「二选一」）时默认取第一条，并在页面顶部给出「互斥候选组」提示，用户可勾选切换 |
| E8 | 超大文件 / 超多行列 | 截断保护 | 超出 `HCL_MAX_*` 即截断，warn 显示「读取前 N 行 / 前 M 列」 |
| E9 | `.xls` / 加密 / 损坏 | 拒绝 | 「不支持 .xls（BIFF），请另存为 .xlsx」/「文件损坏或已加密」 |
| E10 | 后端不可用 | 降级 | 自动走浏览器端解析（`DecompressionStream`）；若浏览器也不支持 → 提示「请启动 `python server.py` 或改传 CSV 版」 |
| E11 | 重复导入同文件 | 更新 | 见 3.3；结果摘要弹窗：`新增 a / 更新 b / 删除 c / 冲突 d` |
| E12 | 与原单价库机型不匹配 | 显式 | `selKey` 记录文本签名；应用时若 `machineId=null` → 提示「N 项未在单价库匹配到机型」，可「批量入库新机型」（单价填 0 并标 `basis=来自XXX清单，待询价`）或直接沿用现有最近似机型 |
| E13 | 合并单元格造成的空 row（样例 A 第 12 行） | 跳过 | 记入 `skippedRows`，不在页面上制造噪音 |
| E14 | 恶意/超大 XML（zip bomb） | 防护 | 后端限制解压后累计字节 ≤ 32MB、条目数 ≤ 200、拒绝含 `../` 路径项 |
| E15 | 状态超限 | 限流 | 超出 `HCL_MAX_STATE_BYTES` 拒绝写入并返回 413，提示先清理旧模板/清单 |
| E16 | 行规则解析异常 | 隔离 | 单行 try/catch，异常行降级 `failed` 继续跑完剩余行，不中断整表 |

---

## 八、取舍说明（设计决策）

1. **解析核心放前端 UMD 模块**：保证「后端可用 / 不可用」两条路径共用同一套规则与算法，避免 Python 与 JS 双实现产生口径漂移；后端只负责「解压 + 取单元格值」这类脏活。
2. **`cpuCores` 定义为整机物理核总数**：厂商清单对此常有分歧（单颗核数 vs 整机总核数），统一口径后单价库机型字段可直接复用。
3. **不自动写单价库**：解析出的规格不会自动变成机型（否则会污染单价库、价格失真），默认只在「应用至配置台」时按需 materialize，且单价为 0 并标记 `basis=来自XXX清单，待询价`。
4. **不自动核价**：两份样例均无可信的「金额」字段（供应商询价单格式各异），本期解析只到「规格层」，价格仍走单价库，避免引入错误报价。
5. **合并单元格不依赖 merge 元数据**：保证后端（Python zipfile）与浏览器（自解 zip）两条读取路径行为完全一致。

---

## 九、实现落地与验证

### 9.1 实际改动文件

| 文件 | 状态 | 说明 |
|---|---|---|
| `server.py` | 改 | `STORE.hwlib` 分区 + 旧库迁移；`read_xlsx_sheets`（zipfile + ElementTree，零依赖，按 `<row r="N">` 对齐真实行号）、`read_csv_sheets`、`hcl_read_file`（体积/格式/损坏校验）；4 个新端点 |
| `web/hcl-core.js` | 新 | 解析引擎（UMD，浏览器 + Node 单测共用），约 800 行 |
| `web/xlsx-read.js` | 新 | 浏览器端 xlsx/csv 读取（后端不可用时兜底，自解 zip + `DecompressionStream`） |
| `web/hcl-view.js` | 新 | 解析页面：上传 / 纠偏 / 明细校对 / 模板沉淀 / 默认已选配置 / 应用 |
| `web/app.js` | 改 | 菜单项 `hw-parse`、路由、`localApi` 回退分支、`HwParseBridge`（应用至配置台 + 机型入库）、配置台入口按钮；新增共享用途注册表 `purposeRegistry()` / `registerPurpose()` / `purposeOf()` / `purposeGroups()`；CFG.phys/vm 扩展 `purpose/role/group/deploy`；配置台/拓扑白板/架构梳理联动 |
| `web/index.html`、`web/styles.css` | 改 | 引入脚本；`.hw-*` 样式 |
| `tools/test-hcl.js`、`tools/fixtures/*.json` | 新 | 43 项单测 + 由两份真实清单抽取的 fixture |
| `tools/test-app-smoke.js` | 改 | 增加 `#/hw-parse` 路由与端到端（解析→落盘→应用→重复导入）验证 |
| `README.md` | 改 | 菜单 / API / 目录 / 配置项 |

### 9.2 验证结果

| 项 | 结果 |
|---|---|
| `node tools/test-hcl.js` | **52 / 52 通过**（规则匹配、表头定位、合并行继承、两通道规格解析、VM/终端识别、模板沉淀、去重合并、空表/无表/超大表/非法输入/全角符号、**用途未分组识别与补录、扩展词召回、分组集合与架构图一致**） |
| `node tools/test-arch.js` | 47 / 47 通过（未受影响） |
| `node tools/test-app-smoke.js` | 全通过：离线模式解析宽表样例得 9 行 / 5 项已选 / 5 个模板；state 保存读取清空 OK；应用至配置台 5 行（新建机型 1）；**重复导入 0 新增 / 5 更新**；入库后重复导入仍 0 新增；**应用后 CFG 行携带 purpose/group，配置台与架构梳理页均渲染用途编辑 + 归入分组下拉 + 主备角色选择** |
| 后端 HTTP 端到端 | `/api/hcl/{config,parse,state,rules}` 全通；`.xls` 400、超 8MB 413、损坏文件 400、CSV 分支 OK、状态超 4MB 413 |

### 9.3 两份样例清单的实际解析效果

| 清单 | 规则 | 结果 |
|---|---|---|
| 宽表样例（宽表列式，含合并单元格 + Sheet 内两张表 + 二选一候选） | `wide-spec-columns` | 9 行（7 服务器行 + 2 终端行），表头第 3 行、识别到 2 张逻辑表；用途继承正确；**互斥候选（TDSQL / OceanBase）默认取 TDSQL 并给出 ALT_CONFLICT 告警**；数量 2/1/3/2/2/2/1 全部正确；终端机（笔记本）自动标记 endpoint 不参与选型 |
| 自由文本样例（自由文本列式） | `free-text-spec` | 7 行全部识别；`Hygon 7470 (48C/2.6GHz) *2` → 96 核 / 2 路；`32G DDR4 ×16` → 512G；`2×480G SSD_SATA + 6×3.84T NVMe` 分块正确；数量 1/3/1/2/2/3/2 全部正确 |

> 说明：样例 B 无「硬件用途」列，用途由「部署应用」推导并给出 `PURPOSE_DERIVED` 黄标，属预期行为，可在明细中一键修正。

**用途分组命中率（扩展词上线前后，同一份清单）**

| 清单 | 上线前未分组 | 上线后未分组 | 改善点 |
|---|---|---|---|
| 宽表样例 | 4 行 | **2 行**（均为终端机，不计入待补录） | 「基础平台」→ 基础设施（扩展词）、「资讯行情」→ 应用服务（扩展词+应用推导） |
| 自由文本样例 | 3 行 | **0 行** | 「云管操作机」→ 基础设施、「AMO」→ 应用服务、「合规风控」→ 应用服务 |

也就是说：**真正需要人工补录的行数为 0**；剩余不可识别的（如未来出现新业务缩写 AMO 之外的新词），走本文档 3.3 的三个入口补录即可。
