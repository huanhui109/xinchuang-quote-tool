# 架构图（draw.io）功能说明

> 适用版本：服务器配置工作台 v0.3　|　模块入口：菜单「报价 → 架构梳理 → 架构图 · draw.io」  
> 开源组件：[diagrams.net / draw.io](https://github.com/jgraph/drawio)（Embed Mode，`proto=json` 双向消息）

本模块把「架构梳理」页的**部署组件清单**自动绘制成**分层拓扑图**，再通过 draw.io 开源前端组件提供**页面内手工编辑**（拖节点、增删、连线、分组、改样式），支持**保存回后端**、**再次导入重新解析并自动重排**，且与现有 `cfg` / `store.json` 数据结构保持兼容。

---

## 一、改动文件清单

| 文件                        | 类型     | 说明                                                                                                                           |
| ------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `web/arch-graph.js`       | **新增** | 布局引擎，纯函数零依赖。用途分类字典、节点/边关系建模、依赖分层与自动布局、draw.io XML 生成、XML 回解析并重建 model。同时支持 `require()` 以便 Node 单测                            |
| `web/arch-diagram.js`     | **新增** | 视图层：菜单页 UI、draw.io iframe 集成（postMessage）、内置离线 SVG 编辑器、保存/导出/重置/重解析交互                                                        |
| `web/index.html`          | 修改     | 在 `app.js` 之前引入 `arch-graph.js`、`arch-diagram.js`                                                                            |
| `web/app.js`              | 修改     | ① 菜单「架构梳理」下新增「架构图 · draw.io」入口；② `ROUTES` 注册路由；③ `seedStore` 新增 `arch` 存储字段；④ `localApi` 新增 `/api/arch/*` 离线回退；⑤ 架构梳理页新增跳转按钮 |
| `web/styles.css`          | 修改     | 新增 `.ad-*` 系列样式（编辑器容器、节点、连线、图例、配置项面板）                                                                                        |
| `server.py`               | 修改     | 新增 `arch` 持久化与 `/api/arch/config`、`/api/arch/diagram`（GET/PUT/DELETE）；`DRAWIO_EMBED_URL` 等配置项；旧 `store.json` 自动迁移            |
| `tools/test-arch.js`      | **新增** | 布局引擎 + 视图冒烟单元测试（47 项）                                                                                                        |
| `tools/test-app-smoke.js` | **新增** | 整个 SPA 在「后端不可用」场景下的路由与离线回退冒烟测试                                                                                               |
| `README.md`               | 修改     | 补充架构图章节、目录结构、API 列表                                                                                                          |

**未改动**：现有 `cfg`（`phys`/`vm`/`links`/`pos`）、`machines`、`vm_prices` 等结构一律保持原样，架构图只是在其之上派生，属于只读派生 + 独立存储。

---

## 二、菜单与交互流程

### 2.1 菜单位置

```
报价
 ├─ 配置台（攒机）        ← 在这里填整机参数、标注「部署组件」、连线
 ├─ 报价单
 ├─ 架构梳理              ← 汇总清单（新增「打开架构图」按钮）
 └─ 架构图 · draw.io      ← 本次新增
```

### 2.2 主流程

```
① 配置台 → 拓扑白板：拖入/新增服务器，填写「部署组件」，用「连线模式」建立互联
        ↓
② 进入「架构图 · draw.io」：页面加载时自动执行
        ArchGraph.deriveModel(cfg, lib)     由 cfg 派生组件清单
        ArchGraph.layout(model, options)    自动分层 + 用途分组 + 坐标
        ArchGraph.toDrawioXml(graph)        生成 draw.io XML
        ↓
③ draw.io iframe（proto=json）自动 load(xml)，页面内手工编辑
        · 拖动/缩放/对齐、增删节点、改连线端点、改分组、改配色样式
        · 每次改动触发 autosave，前端实时拿到最新 XML
        ↓
④ 点「保存」 → PUT /api/arch/diagram {model, graph, xml, options, source}
        ↓
⑤ 点「解析并重排」
        ArchGraph.fromDrawioXml(xml)        回解析（含手工新增的节点）
        ArchGraph.modelFromParsed(parsed)   重建组件清单
        ArchGraph.layout(...)               再次自动布局，覆盖手工摆放
```

### 2.3 页面按钮

| 按钮         | 行为                                              |
| ---------- | ----------------------------------------------- |
| 重新生成       | 丢弃手工摆放，从当前 `cfg` 重新派生清单并重绘                      |
| 解析并重排      | 以**当前图**（含手工改动）为准回解析，再跑一次自动布局                   |
| 保存         | 把当前 XML + 布局结果 + 组件清单快照写入后端/本地                  |
| 导出 .drawio | 下载 `.drawio` 文件（可被 draw.io 桌面版/网页版打开）           |
| 导出 PNG     | 向 draw.io 发送 `export` 消息，下载位图                   |
| 重置         | `DELETE /api/arch/diagram`，清空已保存图（**不影响**配置台清单） |
| 编辑器切换      | `draw.io 在线编辑器` ⇄ `内置离线编辑器`                     |

离线（无外网）时 draw.io iframe 在 `loadTimeoutMs` 内未 `init`，**自动降级**到内置离线编辑器（拖拽/连线/增删/改属性均可用，产出同一种 XML）。

---

## 三、数据格式定义

### 3.1 部署组件清单 `model`（唯一事实源为 `cfg`，此为派生快照）

```jsonc
{
  "version": 1,
  "source": "topo",              // topo=由 cfg 派生 | drawio=由手工图回解析
  "generatedAt": "2026-10-21T03:12:00.000Z",
  "warnings": [ { "code": "CYCLE_DEP", "msg": "……" } ],
  "components": [
    {
      "id": "cmp_1",                       // 稳定唯一 ID
      "name": "交易网关",                   // 来自服务器的 deploy 字段
      "purpose": "接入层",                  // 用途分类（自动推断或手工指定）
      "type": "物理机",                     // 资源类型：物理机 / 虚拟机
      "spec": "海光 Hygon 5480 2路32核/256G",
      "arch": "海光(C86/x86)",
      "qty": 2,                            // 实例/副本数
      "unit_cents": 8600000,
      "members": ["p_a_1", "p_a_2"],       // 原始服务器节点 ID（可回溯到配置台）
      "depends_on": ["cmp_3"],             // 有向依赖：本组件依赖谁
      "connects": ["cmp_2"]                // 无向网络连通
    }
  ]
}
```

### 3.2 布局结果 `graph`（nodes / groups / edges 三层）

```jsonc
{
  "version": 1,
  "layout": "layered-purpose",     // layered-purpose | manual
  "nodes": [{
    "id": "cmp_1", "name": "交易网关", "purpose": "接入层",
    "type": "物理机", "spec": "…", "arch": "…",
    "qty": 2,            // 副本数，渲染为节点第三行「实例 xN」+ 层叠阴影
    "members": ["p_a_1", "p_a_2"],
    "layer": 0,          // 依赖层级，0 为最上层（接入侧）
    "group": "grp_0_接入层",
    "x": 70, "y": 89, "w": 196, "h": 72
  }],
  "groups": [{ "id": "grp_0_接入层", "name": "接入层", "layer": 0,
               "x": 48, "y": 48, "w": 458, "h": 124, "members": ["cmp_1"] }],
  "edges": [{ "id": "e_1", "source": "cmp_1", "target": "cmp_3",
              "kind": "depends",     // depends=依赖（蓝色实线箭头）| connects=互联（灰色虚线双向）
              "label": "依赖" }],
  "bounds": { "w": 1200, "h": 760 },
  "stats": { "nodes": 3, "edges": 2, "groups": 3, "layers": 3, "instances": 7, "truncated": false },
  "warnings": []
}
```

### 3.3 draw.io XML 中的语义落盘

生成的 XML 是每个细胞（cell）用 `<object>` 包装 + `<mxCell>` 子节点，**自定义语义以小写 `xc*` 属性挂在 `<object>` 上**，draw.io 编辑后会原样保留，因此可无损回解析：

```xml
<object id="n_cmp_1" label="…" xcid="cmp_1" xcname="交易网关"
        xcpurpose="接入层" xctype="物理机" xcqty="2" xcspec="…"
        xcmembers="p_a_1,p_a_2" xclayer="0">
  <mxCell style="rounded=1;html=1;fillColor=#e8f0ff;strokeColor=#1d4fb0;" vertex="1" parent="grp_0_…">
    <mxGeometry x="70" y="89" width="196" height="72" as="geometry"/>
  </mxCell>
</object>

<object id="e_1" label="依赖" xckind="depends" xcsrc="cmp_1" xcdst="cmp_3">
  <mxCell style="edgeStyle=orthogonalEdgeStyle;endArrow=blockThin;…" edge="1" parent="1"
          source="n_cmp_1" target="n_cmp_3">
    <mxGeometry relative="1" as="geometry"/>
  </mxCell>
</object>
```

| 属性                                                      | 含义                  |
| ------------------------------------------------------- | ------------------- |
| `xcid`                                                  | 组件 / 边的逻辑 ID（回解析主键） |
| `xcname` `xcpurpose` `xctype` `xcqty` `xcspec` `xcarch` | 节点业务属性              |
| `xcmembers`                                             | 关联的原始服务器节点（逗号分隔）    |
| `xclayer`                                               | 生成时的依赖层级（重排时仅作参考）   |
| `xckind` `xcsrc` `xcdst`                                | 边的类型与端点逻辑 ID        |

> 连线两端在 XML 里用的是 **draw.io 细胞 ID**（`source="n_cmp_1"`），逻辑 ID 走 `xcsrc/xcdst`，避免 draw.io 重建细胞 ID 时映射失效。

### 3.4 后端存储（`data/store.json`）

```jsonc
"arch": {
  "options": { "groupBy": "purpose", "maxNodes": 300, … },
  "model": { … },    // 最近一次生成所用的组件清单快照
  "graph": { … },    // 最近一次布局结果
  "xml": "<mxfile…>",// 最近一次保存的图（手工编辑后的权威副本）
  "source": "topo",  // topo | drawio
  "updated_at": "2026-10-21 11:20"
}
```

---

## 四、配置项

### 4.1 环境变量（服务端）

| 变量                       | 默认值                           | 说明                                                                                                                      |
| ------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `DRAWIO_EMBED_URL`       | `https://embed.diagrams.net/` | draw.io embed 地址。**内网/离线部署时可指向自建 drawio 静态服务**（把官方 release 的 `src/main/webapp` 挂到任意静态目录），页面会读取 `/api/arch/config` 返回的地址 |
| `DRAWIO_LOAD_TIMEOUT_MS` | `12000`                       | 等待 draw.io `init` 的毫秒数，超时自动降级到内置离线编辑器                                                                                   |
| `MAX_ARCH_XML_BYTES`     | `8388608`（8 MB）               | 单个图 XML 上限，超出返回 `413`                                                                                                   |
| `PORT`                   | `8000`                        | 服务端口（原有）                                                                                                                |

### 4.2 布局选项（页面「布局选项与配置项」面板，随图持久化）

| 选项                | 默认        | 作用                                |
| ----------------- | --------- | --------------------------------- |
| `groupBy`         | `purpose` | `purpose`=按用途画分组容器；`none`=只分层不画分组 |
| `aggregate`       | `true`    | 同用途同规格的实例聚合为一个节点，数量用「实例 xN」表达     |
| `inferDependency` | `true`    | 跨用途的连线按用途层级推导成有向依赖                |
| `breakCycle`      | `true`    | 检测到循环依赖时把回边降级为「互联」                |
| `stackReplicas`   | `true`    | 副本层叠阴影效果                          |
| `maxStack`        | `4`       | 层叠最多画几层（引擎级，页面未暴露）                |
| `legend`          | `true`    | 输出图例（颜色 / 线型 / 数量含义）              |
| `maxNodes`        | `300`     | 节点上限，超出截断                         |
| `maxEdges`        | `800`     | 连线上限，超出截断                         |

### 4.3 用途分类字典

顺序即层级顺序（索引越小越靠图上方），见 `web/arch-graph.js` 的 `PURPOSE_ORDER` / `PURPOSE_RULES`：

`接入层 → 应用服务 → 中间件 → 数据服务 → 存储备份 → 基础设施 → 未分组`

命中规则为关键字包含匹配（忽略大小写），例如「Oracle数据库」→ 数据服务，「Redis缓存」→ 中间件，「k8s管理节点」→ 基础设施。需要新增业务分类时，只改 `PURPOSE_RULES` 一处即可。

---

## 五、REST API

| 方法     | 路径                  | 说明                                                               |
| ------ | ------------------- | ---------------------------------------------------------------- |
| GET    | `/api/arch/config`  | 返回 `{embedUrl, loadTimeoutMs, options}`                          |
| GET    | `/api/arch/diagram` | 返回 `{options, model, graph, xml, source, updated_at, has_xml}`   |
| PUT    | `/api/arch/diagram` | 保存 `{xml?, model?, graph?, source?, options?}`；XML 超 8 MB 返回 413 |
| DELETE | `/api/arch/diagram` | 清空图数据与布局（不影响配置台 `cfg`）                                           |

```bash
curl http://localhost:8000/api/arch/config
curl http://localhost:8000/api/arch/diagram
curl -X PUT http://localhost:8000/api/arch/diagram \
     -H 'Content-Type: application/json' -d '{"xml":"<mxfile/>","source":"drawio"}'
```

后端不可用时（纯静态托管 / 预览面板 / 离线），前端 `localApi` 对本组接口提供同契约的 localStorage 实现，功能不降级。

---

## 六、关键边界情况处理

| 场景                         | 处理策略                                                                    | 告警码                                |
| -------------------------- | ----------------------------------------------------------------------- | ---------------------------------- |
| **空清单**（未标注部署组件 / 没有任何服务器） | 布局返回 `empty:true`，生成一张带说明文字的占位图，页面给出引导「请先在配置台填写部署组件」；不会白屏也不会报错          | `EMPTY_LIST`                       |
| **部分节点未标注组件**              | 未标注的服务器仍参与布局，用途归入「未分组」（最底层）；连线端点若找不到对应组件则记 dangling 后忽略该连线              | `LINK_DANGLING`                    |
| **循环依赖**                   | DFS 找出全部回边；开启 `breakCycle` 时把回边降级为无向「互联」，随后分层迭代有明确迭代上限（不会死循环）；告警里给出降级边数 | `CYCLE_DEP`                        |
| **超大图**                    | 组件数超 `maxNodes` 截断并提示；连线超 `maxEdges` 截断；800 节点实测布局 23 ms                | `TRUNCATED` / `EDGE_TRUNCATED`     |
| **自环 / 悬挂引用**              | 组件依赖自己或引用不存在的组件，均被过滤并告警                                                 | `SELF_LOOP` / `DANGLING_REF`       |
| **重复组件 ID**                | 自动改名，保证 `id` 唯一                                                         | `DUP_ID`                           |
| **draw.io 不可用 / 无外网**      | 超时未 `init` → 自动切换到内置离线编辑器；两种编辑器产出同一种 XML，随时可切回                          | —                                  |
| **手工新增的节点**                | 回解析时按标签文本重新推断用途，数量按 1 计，并提示                                             | `MANUAL_NODE`                      |
| **手工删掉了 `xc*` 属性**         | 语义回退：用途由节点文字推断、数量回退为 1、成员清单回退为「按上一次 model 的 id 快照」                      | `MANUAL_NODE`                      |
| **非法 XML / 空字符串导入**        | 返回空结果 + 提示，不影响已有数据                                                      | `PARSE_BAD_FORMAT` / `PARSE_EMPTY` |
| **连线端点解析不到**               | 忽略该连线并提示                                                                | `PARSE_EDGE_DROP`                  |
| **XML 过大**                 | 后端拒绝写入（HTTP 413）                                                        | —                                  |
| **旧版 store.json**          | 启动时 `migrate_store()` 自动补齐 `arch` 等缺失字段                                 | —                                  |

---

## 七、验证记录

```bash
node tools/test-arch.js        # 47 项：布局算法、XML 往返、边界场景、视图冒烟
node tools/test-app-smoke.js   # SPA 离线回退全路由冒烟
```

最近一次执行：47 / 47 通过，0 失败。覆盖：空清单、自环、悬挂引用、循环依赖收敛、800 节点截断（23 ms）、节点互不重叠、层级与依赖方向正确、数量聚合正确、XML→回解析→再布局一致性、手工节点识别、非法输入不崩溃、保存/读取/删除全链路。
