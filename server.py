# -*- coding: utf-8 -*-
"""
信创服务器配置报价工具 - 启动脚本
  - 纯静态文件服务（web/ 目录）
  - 同时提供 REST API（/api/*，基于 JSON 文件持久化，零第三方依赖）
  - 前端优先调用后端 API；后端不可用时（如静态预览/离线）前端自动回退 localStorage

运行: python server.py  ->  http://localhost:8000
可选: PORT=9000 python server.py
"""
import os
import sys
import re
import csv as _csv
import json
import shutil
import socket
import base64
import zipfile
import io
import threading
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
# 数据目录可用 STORE_DATA_DIR 覆盖（测试隔离用；不设置时行为与原来完全一致）
DATA_DIR = os.environ.get("STORE_DATA_DIR") or os.path.join(BASE_DIR, "data")
STORE_FILE = os.path.join(DATA_DIR, "store.json")
# 落盘前的单文件轮转备份（M1.0-a）。
# 用固定名而非时间戳命名：时间戳命名会不断堆积副本，且不被 .gitignore 覆盖，
# 有把用户真实报价数据带进仓库的风险（见 .gitignore 的 data/store.json.bak-*）。
BAK_FILE = os.path.join(DATA_DIR, "store.json.bak")
# 埋点文件：独立 JSONL append，不进 store.json
# （save_store 每次全量重写整份 JSON，事件入库会放大写并让备份膨胀）。
EVENTS_FILE = os.path.join(DATA_DIR, "events.jsonl")
EVENTS_HEALTH_FILE = os.path.join(DATA_DIR, "events.health.json")
EVENTS_MAX_BYTES = int(os.environ.get("EVENTS_MAX_BYTES", str(10 * 1024 * 1024)))
EVENTS_KEEP = int(os.environ.get("EVENTS_KEEP", "10"))

# ---- 角色（M5）----
# 角色由客户端通过 X-Role 请求头自声明。**这不是身份认证**：头可被伪造，
# 服务端的裁剪属于「口径隔离」，role_source 仅供审计，不可用于越权判定。
ROLES = ("sales", "delivery", "ops", "viewer")
DEFAULT_ROLE = "sales"
ROLE_SOURCE = "self_declared"

# ---- 资产侧集合（M1/M2/M4/M6）----
ASSET_COLLECTIONS = ("rooms", "racks", "rack_units", "devices", "asset_changes",
                     "links", "deliveries", "reconciliations", "price_feedback")
# MVP 阶段仅暴露这 4 个状态，其余随二期 S2 状态机上线，避免实现者自造中间态。
DEVICE_STATES = ("planned", "ordered", "installed", "running")
# 运行态视图口径：只有这两态算「已上架」，计划行不得混入巡检报表。
RUNTIME_STATES = ("installed", "running")
# 设备台账允许的来源
DEVICE_ORIGINS = ("delivery", "quote", "hwlib", "manual")

# 设备台账字段默认值（M1）。config_line_ref 是**可空、非持久锚点**：
# 它只是「这台设备对应哪一行配置」的展示期引用，applyScheme 会清空重建配置行，
# 因此持久锚点只能是 source_line_uid（指向报价单条目）。
DEVICE_FIELD_DEFAULTS = (
    ("code", ""), ("source_line_uid", ""), ("seq_no", 0),
    ("config_line_ref", ""), ("origin", "manual"), ("sku_id", 0),
    ("sn", ""), ("arch", ""), ("os", ""), ("hypervisor", ""),
    ("purpose", ""), ("role", ""), ("group", ""), ("state", "planned"),
    ("rack_id", 0), ("u_start", 0), ("u_size", 1), ("u_size_source", "rail"),
    ("power_w", 0), ("host_device_id", 0), ("tags", []),
    ("plan_snapshot", None), ("created_from", ""), ("updated_at", ""),
)
# 默认只监听本机，成本价/协议价不在局域网裸奔（A-5）。
# 需要局域网访问时显式开启：HOST=0.0.0.0 python server.py
HOST = os.environ.get("HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("PORT", "8000"))
# 单次 API 请求体上限（防止超大 JSON 打满内存，D-5）
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(32 * 1024 * 1024)))

# ---- 架构图（draw.io）相关配置 ----
# draw.io embed 服务地址；内网/离线环境可在同级目录放 .env 或用环境变量覆盖为自建版 drawio
DRAWIO_EMBED_URL = os.environ.get(
    "DRAWIO_EMBED_URL", "https://embed.diagrams.net/"
)
# 前端必须遇到的加载超时（毫秒），超时自动降级到内置 SVG 编辑器
DRAWIO_LOAD_TIMEOUT_MS = int(os.environ.get("DRAWIO_LOAD_TIMEOUT_MS", "12000"))
# 自动布局的默认选项（前端可覆盖，保存时会一并持久化）
DEFAULT_ARCH_OPTIONS = {
    "layout": "layered-purpose",
    "groupBy": "purpose",
    "aggregate": True,
    "inferDependency": True,
    "breakCycle": True,
    "stackReplicas": True,
    "legend": True,
    "maxNodes": 300,
    "maxEdges": 800,
}

_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
}

DEFAULT_HCL_OPTIONS = {
    "autoPickSheet": True,        # 自动选 Sheet
    "includeOptional": False,     # 「必选=否」的候选行是否纳入默认选型
    "includeFailed": False,       # 解析失败行是否纳入默认选型
    "materializeMachines": False, # 应用时是否把未入库机型写入单价库
    "conflictPolicy": "keep-manual",  # keep-manual | overwrite
    "stalePolicy": "remove",      # remove | keep（重导入时源已删除的行）
}

MAX_ARCH_XML_BYTES = int(os.environ.get("MAX_ARCH_XML_BYTES", str(8 * 1024 * 1024)))

# ---- 硬件配置清单解析（HCL）相关限制 ----
HCL_MAX_UPLOAD_BYTES = int(os.environ.get("HCL_MAX_UPLOAD_BYTES", str(8 * 1024 * 1024)))
HCL_MAX_ROWS = int(os.environ.get("HCL_MAX_ROWS", "5000"))
HCL_MAX_COLS = int(os.environ.get("HCL_MAX_COLS", "60"))
HCL_MAX_SHEETS = int(os.environ.get("HCL_MAX_SHEETS", "8"))
HCL_MAX_UNZIP_BYTES = int(os.environ.get("HCL_MAX_UNZIP_BYTES", str(32 * 1024 * 1024)))
HCL_MAX_ZIP_ENTRIES = int(os.environ.get("HCL_MAX_ZIP_ENTRIES", "200"))
HCL_MAX_STATE_BYTES = int(os.environ.get("HCL_MAX_STATE_BYTES", str(4 * 1024 * 1024)))

OS_OPTIONS = [
    {"label": "麒麟 V10 (x86)", "arch": "海光(C86/x86)"},
    {"label": "统信 UOS (x86)", "arch": "海光(C86/x86)"},
    {"label": "中科方德 (x86)", "arch": "海光(C86/x86)"},
    {"label": "麒麟 V10 (ARM64)", "arch": "鲲鹏(ARM)"},
    {"label": "统信 UOS (ARM64)", "arch": "鲲鹏(ARM)"},
]
HV_OPTIONS = [
    {"label": "云宏 CNware (x86)", "arch": "海光(C86/x86)"},
    {"label": "华为 FusionCompute (x86)", "arch": "海光(C86/x86)"},
    {"label": "OpenStack (x86)", "arch": "海光(C86/x86)"},
    {"label": "华为 FusionCompute (ARM)", "arch": "鲲鹏(ARM)"},
    {"label": "OpenStack (ARM)", "arch": "鲲鹏(ARM)"},
]


def now():
    d = datetime.now()
    return d.strftime("%Y-%m-%d %H:%M")


def seed_store():
    return {
        "_seq": 200,
        "settings": {"tax_rate": "0.13", "currency": "CNY"},
        "versions": [
            {"id": 1, "name": "基线 v1（示例）",
             "note": "由需求文档样例初始化：海光 5480/7470，虚拟机资源综合单价",
             "created_at": now(), "is_active": 1},
        ],
        "machines": [
            {"id": 1, "version_id": 1, "brand": "海光", "model": "Hygon 5480", "arch": "海光(C86/x86)",
             "cpu_model": "Hygon 5480", "cpu_sockets": 2, "cpu_cores": 32, "cpu_freq": 2.5,
             "mem_capacity": 256, "mem_gen": "DDR4", "disk_bays": "8",
             "disk_desc": "2×960G SSD + 4×1.92T NVMe", "nic": "4×25GbE", "power": "2×800W",
             "rail": "2U导轨", "chassis_u": 0, "unit_price_cents": 8600000, "supplier": "厂商询价(示例)", "basis": "示例价，待替换"},
            {"id": 2, "version_id": 1, "brand": "海光", "model": "Hygon 7470", "arch": "海光(C86/x86)",
             "cpu_model": "Hygon 7470", "cpu_sockets": 2, "cpu_cores": 48, "cpu_freq": 2.6,
             "mem_capacity": 512, "mem_gen": "DDR4", "disk_bays": "8",
             "disk_desc": "4×1.92T NVMe + 4×3.84T NVMe", "nic": "4×25GbE", "power": "2×1200W",
             "rail": "2U导轨", "chassis_u": 0, "unit_price_cents": 15800000, "supplier": "厂商询价(示例)", "basis": "示例价，待替换"},
            {"id": 3, "version_id": 1, "brand": "鲲鹏", "model": "Kunpeng 920", "arch": "鲲鹏(ARM)",
             "cpu_model": "Kunpeng 920", "cpu_sockets": 2, "cpu_cores": 64, "cpu_freq": 2.6,
             "mem_capacity": 512, "mem_gen": "DDR4", "disk_bays": "8",
             "disk_desc": "4×1.92T NVMe", "nic": "4×25GbE", "power": "2×900W",
             "rail": "2U导轨", "chassis_u": 0, "unit_price_cents": 14200000, "supplier": "厂商询价(示例)", "basis": "示例价，待替换"},
        ],
        "parts": [
            {"id": 4, "version_id": 1, "category": "内存", "spec": "32G DDR4 RDIMM", "price_cents": 120000, "compat_arch": "海光(C86/x86)", "compat_machine": ""},
            {"id": 5, "version_id": 1, "category": "内存", "spec": "64G DDR4 RDIMM", "price_cents": 230000, "compat_arch": "海光(C86/x86)", "compat_machine": ""},
            {"id": 6, "version_id": 1, "category": "内存", "spec": "32G DDR4 RDIMM", "price_cents": 125000, "compat_arch": "鲲鹏(ARM)", "compat_machine": ""},
            {"id": 7, "version_id": 1, "category": "硬盘", "spec": "1.92T NVMe SSD", "price_cents": 90000, "compat_arch": "", "compat_machine": ""},
            {"id": 8, "version_id": 1, "category": "硬盘", "spec": "3.84T NVMe SSD", "price_cents": 160000, "compat_arch": "", "compat_machine": ""},
            {"id": 9, "version_id": 1, "category": "网卡", "spec": "25GbE 双口网卡", "price_cents": 45000, "compat_arch": "", "compat_machine": ""},
            {"id": 10, "version_id": 1, "category": "RAID", "spec": "Broadcom 9560 8i", "price_cents": 60000, "compat_arch": "", "compat_machine": ""},
        ],
        "vm_prices": [
            {"id": 11, "version_id": 1, "res_type": "cpu", "unit": "核", "price_cents": 70000, "basis": "0.07万元/核（综合单价）"},
            {"id": 12, "version_id": 1, "res_type": "mem", "unit": "GB", "price_cents": 80000, "basis": "0.08万元/G（综合单价）"},
            {"id": 13, "version_id": 1, "res_type": "storage", "unit": "GB", "price_cents": 2000, "basis": "0.2万元/100G（综合单价）"},
        ],
        "vm_flavors": [
            {"id": 14, "version_id": 1, "name": "通用型 4C8G", "vcpu": 4, "mem_gb": 8, "storage_gb": 100, "note": "轻量应用 / 代理", "is_common": 1},
            {"id": 15, "version_id": 1, "name": "通用型 4C16G", "vcpu": 4, "mem_gb": 16, "storage_gb": 100, "note": "中间件 / 缓存", "is_common": 1},
            {"id": 16, "version_id": 1, "name": "通用型 8C16G", "vcpu": 8, "mem_gb": 16, "storage_gb": 200, "note": "应用服务", "is_common": 1},
            {"id": 17, "version_id": 1, "name": "通用型 8C32G", "vcpu": 8, "mem_gb": 32, "storage_gb": 200, "note": "数据库 / 重负载", "is_common": 1},
        ],
        "quotes": [],
        "apps": [],
        # ---- 资产侧集合（融合 MVP）----
        # rooms/racks/rack_units：机房·机柜·行级 U 位占用账本（M2）
        # devices：统一设备台账（M1）  asset_changes：设备级变更流水（M0）
        # links：拓扑连线（logical=行级 / physical=实例级）  deliveries：交付批次（M4）
        # reconciliations：对账差异（二期 S1，MVP 只建表）  price_feedback：采价反馈（M6）
        "rooms": [],
        "racks": [],
        "rack_units": [],
        "devices": [],
        "asset_changes": [],
        "links": [],
        "deliveries": [],
        "reconciliations": [],
        "price_feedback": [],
        "cfg": {"phys": [], "vm": [], "archFilter": "全部", "view": "list", "pos": {}, "links": [], "selNode": None, "connecting": False},
        "arch": {
            "options": dict(DEFAULT_ARCH_OPTIONS),
            "model": None,     # 最近一次生成架构图所用的部署组件清单快照
            "graph": None,     # 最近一次自动布局结果（nodes/groups/edges）
            "xml": None,       # 最近一次保存的 draw.io XML（手工编辑后的权威副本）
            "source": "topo",  # topo | drawio
            "updated_at": None,
        },
        # 硬件配置清单解析：规则 / 沉淀模板 / 默认已选配置 / 导入记录 / 共享用途注册表
        "hwlib": {"rules": None, "combos": [], "selections": [], "imports": [],
                  "purposes": [], "options": dict(DEFAULT_HCL_OPTIONS), "updated_at": None},
    }


# ---- 共享内存存储（带文件持久化）----
_lock = threading.Lock()
STORE = {}


def load_store():
    """读取数据文件；损坏时保留现场并中止启动，绝不静默重置为示例数据（A-4）。"""
    global STORE
    if os.path.isfile(STORE_FILE):
        try:
            with open(STORE_FILE, "r", encoding="utf-8") as f:
                STORE = json.load(f)
            if not isinstance(STORE, dict):
                raise ValueError("store.json 根节点不是对象")
            migrate_store()
            return
        except Exception as e:
            bak = STORE_FILE + ".corrupt-" + datetime.now().strftime("%Y%m%d-%H%M%S")
            try:
                os.replace(STORE_FILE, bak)
            except Exception:
                bak = None
            sys.stderr.write(
                "[严重] data/store.json 解析失败：%s\n"
                "已保留损坏文件为 %s\n"
                "为避免覆盖你的单价库与报价单，服务已中止启动。\n"
                "请修复该文件（或将其移走）后重新启动。\n"
                % (e, bak or "(备份失败，请手工备份 data/store.json)")
            )
            sys.exit(2)
    STORE = seed_store()
    save_store()


def migrate_store():
    """补齐旧版 store.json 缺失的字段（向前兼容）。

    **幂等要求**：重复执行结果必须完全一致，只加不减。
    因此只在「实际内容发生变化」时才置 changed=True —— 否则每次启动都会
    无谓重写磁盘，也破坏「幂等」这个承诺。
    """
    global STORE
    changed = False

    def ensure_list(key):
        """确保 STORE[key] 是列表；缺失或类型不对时补默认值。"""
        nonlocal changed
        if not isinstance(STORE.get(key), list):
            STORE[key] = []
            changed = True

    # 原有 7 个集合
    for key in ["quotes", "apps", "versions", "machines",
                "parts", "vm_prices", "vm_flavors"]:
        ensure_list(key)

    # 资产侧 9 个集合（M1/M2/M4/M6）
    for key in ASSET_COLLECTIONS:
        ensure_list(key)

    if "cfg" not in STORE or not isinstance(STORE["cfg"], dict):
        STORE["cfg"] = {"phys": [], "vm": [], "archFilter": "全部", "view": "list",
                        "pos": {}, "links": [], "selNode": None, "connecting": False}
        changed = True

    if "arch" not in STORE or not isinstance(STORE["arch"], dict):
        STORE["arch"] = {"options": dict(DEFAULT_ARCH_OPTIONS), "model": None,
                         "graph": None, "xml": None, "source": "topo", "updated_at": None}
        changed = True
    else:
        opts = dict(DEFAULT_ARCH_OPTIONS)
        if isinstance(STORE["arch"].get("options"), dict):
            opts.update(STORE["arch"]["options"])
        # 只在真正不一致时才置 changed（原先无条件置 True，破坏幂等）
        if STORE["arch"].get("options") != opts:
            STORE["arch"]["options"] = opts
            changed = True
        for key in ("model", "graph", "xml", "source", "updated_at"):
            if key not in STORE["arch"]:
                STORE["arch"][key] = None
                changed = True

    if "hwlib" not in STORE or not isinstance(STORE["hwlib"], dict):
        STORE["hwlib"] = {"rules": None, "combos": [], "selections": [], "imports": [],
                          "purposes": [], "options": dict(DEFAULT_HCL_OPTIONS), "updated_at": None}
        changed = True
    else:
        hw = STORE["hwlib"]
        for key in ("combos", "selections", "imports", "purposes"):
            if not isinstance(hw.get(key), list):
                hw[key] = []
                changed = True
        opts = dict(DEFAULT_HCL_OPTIONS)
        if isinstance(hw.get("options"), dict):
            opts.update(hw["options"])
        if hw.get("options") != opts:
            hw["options"] = opts
            changed = True
        for key in ("rules", "updated_at"):
            if key not in hw:
                hw[key] = None
                changed = True

    # ---- 机型补 chassis_u（M1.0：机箱高度）----
    # 0 = 未标注 → 走 rail 近似；>0 = 实际机箱高度，优先于 rail。
    for m in STORE.get("machines", []):
        if "chassis_u" not in m:
            m["chassis_u"] = 0
            changed = True

    # ---- 报价条目补锚点字段（M1.0-b）----
    # 老单没有 item_no / 源配置行 id → 按下标补生成，并标 legacy=1（弱锚点）。
    # 弱锚点的含义：能定位到条目，但该条目对应的配置行已被 applyScheme 清空重建，
    # 因此不可作为「可回溯到配置行」的强锚点参与统计分子。
    for q in STORE.get("quotes", []):
        items = q.get("items")
        if not isinstance(items, list):
            continue
        for idx, it in enumerate(items):
            if not isinstance(it, dict):
                continue
            if not isinstance(it.get("item_no"), int) or it.get("item_no", 0) <= 0:
                it["item_no"] = idx + 1
                changed = True
            if not it.get("line_uid"):
                it["line_uid"] = "q_%s_%d" % (q.get("id"), idx + 1)
                changed = True
            if "legacy" not in it:
                it["legacy"] = 1
                changed = True

    # ---- 设备台账字段默认值（M1）----
    for d in STORE.get("devices", []):
        if not isinstance(d, dict):
            continue
        for key, dft in DEVICE_FIELD_DEFAULTS:
            if key not in d:
                d[key] = dft
                changed = True

    # ---- links 一次性幂等播种 ----
    if seed_links_once():
        changed = True

    if changed:
        save_store()


def save_store():
    """原子写：先写临时文件再 os.replace，避免崩溃/断电留下截断的 JSON（A-4）。

    落盘前先做一次单文件轮转备份（M1.0-a）：把上一份正式文件复制成
    data/store.json.bak。备份失败不阻断保存（保存是主路径，备份是兜底）。
    """
    os.makedirs(DATA_DIR, exist_ok=True)
    # 先备份上一份正式文件（首次落盘时没有上一份，跳过）
    if os.path.isfile(STORE_FILE):
        try:
            shutil.copyfile(STORE_FILE, BAK_FILE)
        except Exception:
            pass
    tmp = STORE_FILE + ".tmp-%d" % os.getpid()
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(STORE, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())   # 落盘后再替换，避免断电后拿到空文件
        os.replace(tmp, STORE_FILE)   # 同一文件系统内的原子替换
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except Exception:
                pass


def next_id():
    STORE["_seq"] = STORE.get("_seq", 200) + 1
    return STORE["_seq"]


def active_version_id():
    for v in STORE.get("versions", []):
        if v.get("is_active"):
            return v["id"]
    vs = STORE.get("versions", [])
    return vs[0]["id"] if vs else 1


class HTTPError(Exception):
    def __init__(self, code, msg, detail=None):
        self.code = code
        self.msg = msg
        # 结构化补充信息（如三类冲突分列），会合并进响应 body。
        # 既有调用点只传 (code, msg)，行为完全不变。
        self.detail = detail


def col_get(name):
    """返回生效版本下的集合列表（深拷贝，避免调用方改到存储）。"""
    vid = active_version_id()
    return [dict(r) for r in STORE.get(name, []) if r.get("version_id") == vid]


def col_index(cell_ref):
    """'AB12' -> 27（0 基列号）"""
    n = 0
    for ch in cell_ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
        else:
            break
    return max(0, n - 1)


def read_csv_sheets(raw_bytes):
    text = None
    for enc in ("utf-8-sig", "gbk", "utf-16"):
        try:
            t = raw_bytes.decode(enc)
            if t.count("\ufffd") > len(t) / 200:
                continue
            text = t
            break
        except Exception:
            continue
    if text is None:
        raise HTTPError(400, "CSV 编码无法识别，请另存为 UTF-8 编码的 CSV")
    rows = []
    try:
        reader = _csv.reader(io.StringIO(text))
        for r in reader:
            if len(rows) >= HCL_MAX_ROWS:
                break
            rows.append(list(r[:HCL_MAX_COLS]))
    except Exception as e:
        raise HTTPError(400, "CSV 解析失败：%s" % e)
    return [{"name": "CSV", "rows": rows, "truncated": len(rows) >= HCL_MAX_ROWS}]


def read_xlsx_sheets(raw_bytes):
    """零第三方依赖读取 xlsx：zipfile + ElementTree。"""
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw_bytes))
    except Exception:
        raise HTTPError(400, "文件不是有效的 xlsx（或已损坏 / 已加密）")
    names = zf.namelist()
    if len(names) > HCL_MAX_ZIP_ENTRIES:
        raise HTTPError(413, "压缩包条目过多（>%d），疑似异常文件" % HCL_MAX_ZIP_ENTRIES)
    total = 0
    for info in zf.infolist():
        if ".." in info.filename.replace("\\", "/").split("/") or info.filename.startswith("/"):
            raise HTTPError(400, "压缩包包含非法路径")
        total += info.file_size
        if total > HCL_MAX_UNZIP_BYTES:
            raise HTTPError(413, "解压后体积过大（>%d 字节），已中止" % HCL_MAX_UNZIP_BYTES)

    # 共享字符串
    shared = []
    if "xl/sharedStrings.xml" in names:
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
        ns = {"m": root.tag.split("}")[0][1:]} if root.tag.startswith("{") else {}
        for si in root.findall("m:si" if ns else "si", ns if ns else None):
            shared.append("".join(t.text or "" for t in si.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")))

    # 工作表顺序
    order = []
    try:
        wb = ET.fromstring(zf.read("xl/workbook.xml"))
        rels = {}
        if "xl/_rels/workbook.xml.rels" in names:
            r = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
            for rel in r:
                rels[rel.get("Id")] = rel.get("Target")
        NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
        RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
        for sh in wb.find(NS + "sheets"):
            target = rels.get(sh.get(RNS + "id"), "")
            target = target.lstrip("/")
            if not target.startswith("xl/"):
                target = "xl/" + target
            order.append((sh.get("name") or "", target))
    except Exception:
        order = []
    if not order:
        order = [(n, n) for n in names if n.startswith("xl/worksheets/sheet")]

    NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    sheets = []
    for name, target in order[:HCL_MAX_SHEETS]:
        if target not in names:
            continue
        try:
            ws = ET.fromstring(zf.read(target))
        except Exception:
            continue
        rows = []
        truncated = False
        data_rows = ws.find(NS + "sheetData")
        if data_rows is None:
            sheets.append({"name": name, "rows": [], "truncated": False})
            continue
        # 按 <row r="N"> 的真实行号对齐，避免缺行导致行列序号错位
        tmp_rows = {}
        max_r = 0
        for row in data_rows:
            try:
                ridx = int(row.get("r") or (len(tmp_rows) + 1))
            except Exception:
                ridx = len(tmp_rows) + 1
            if ridx > HCL_MAX_ROWS:
                truncated = True
                continue
            cells = []
            maxc = -1
            tmp = {}
            for c in row:
                ref = c.get("r") or ""
                idx = col_index(ref) if ref else len(tmp)
                if idx >= HCL_MAX_COLS:
                    continue
                t = c.get("t")
                v = None
                if t == "s":
                    try:
                        v = shared[int((c.find(NS + "v").text or "0"))]
                    except Exception:
                        v = None
                elif t == "inlineStr":
                    is_el = c.find(NS + "is")
                    v = "".join(x.text or "" for x in is_el.iter(NS + "t")) if is_el is not None else None
                else:
                    v_el = c.find(NS + "v")
                    v = v_el.text if v_el is not None else None
                    if t not in ("str", "e") and v is not None:
                        try:
                            v = float(v)
                            if v == int(v):
                                v = int(v)
                        except Exception:
                            pass
                if v is None or v == "":
                    continue
                tmp[idx] = v
                if idx > maxc:
                    maxc = idx
            for i in range(maxc + 1):
                cells.append(tmp.get(i))
            if cells:
                tmp_rows[ridx] = cells
                max_r = max(max_r, ridx)
        limit = min(max_r, HCL_MAX_ROWS)
        for i in range(1, limit + 1):
            rows.append(tmp_rows.get(i, []))
        sheets.append({"name": name, "rows": rows, "truncated": truncated})
    if not sheets:
        raise HTTPError(400, "未在 xlsx 中找到任何工作表")
    return sheets


def hcl_read_file(filename, content_b64):
    ext = os.path.splitext(filename or "")[1].lower()
    try:
        raw = base64.b64decode(content_b64 or "")
    except Exception:
        raise HTTPError(400, "文件内容解码失败")
    if not raw:
        raise HTTPError(400, "文件内容为空")
    if len(raw) > HCL_MAX_UPLOAD_BYTES:
        raise HTTPError(413, "文件超过 %d 字节上限" % HCL_MAX_UPLOAD_BYTES)
    if ext in (".xls", ".xlt"):
        raise HTTPError(400, "不支持 .xls（旧二进制格式），请在 Excel 中另存为 .xlsx 后重试")
    if raw[:2] == b"PK" and ext != ".csv":
        return read_xlsx_sheets(raw), "xlsx"
    if ext in (".xlsx", ".xlsm"):
        raise HTTPError(400, "扩展名为 xlsx 但文件内容不是有效压缩包（文件可能已损坏或被改名）")
    return read_csv_sheets(raw), "csv"


# ================================================================
# 融合 MVP 支撑函数（M1.0 地基 / M1 台账 / M2 空间模型 / M6 角色与价格隔离）
# ================================================================

# ---- 高度换算（M1.0）----
def machine_u_size(machine):
    """机型的 U 高度与来源。

    权威结果只有 u_size 一个字段：
      · chassis_u > 0  → 实际机箱高度，来源 'chassis'
      · 否则按 rail 解析近似（如 "2U导轨" → 2），来源 'rail'
    现存 3 个机型均无 chassis_u（值为 0），故 MVP 期一律走 rail 近似。
    不新建第二个高度字段名。
    """
    if not isinstance(machine, dict):
        return {"u_size": 1, "u_size_source": "rail"}
    cu = machine.get("chassis_u")
    try:
        cu = float(cu)
    except (TypeError, ValueError):
        cu = 0.0
    if cu > 0:
        return {"u_size": cu, "u_size_source": "chassis"}
    m = re.search(r"(\d+(?:\.\d+)?)\s*[UuUu]", str(machine.get("rail") or ""))
    if m:
        return {"u_size": float(m.group(1)), "u_size_source": "rail"}
    return {"u_size": 1, "u_size_source": "rail"}


def u_index_of(u):
    """U 位 → 槽位索引：u_index = round(u × 2)。

    每半 U 一个槽位：整 U 占 2 个 index，半 U 占 1 个。
    行级账本按槽位判定重叠，比「区间相交」更不容易写错边界，
    且唯一性退化为 O(1) 的集合成员检查。
    """
    return int(round(float(u) * 2))


def device_u_indices(u_start, u_size):
    """设备占用 [u_start, u_start+u_size) 对应的槽位索引列表。

    例：u_start=1, u_size=2 → [2,3,4,5]；u_start=1.5, u_size=0.5 → [3]
    """
    try:
        a = float(u_start)
        b = float(u_start) + float(u_size)
    except (TypeError, ValueError):
        return []
    return list(range(u_index_of(a), u_index_of(b)))


# ---- 埋点（M1.0-d）----
_EVENTS_DROPPED = 0   # 写失败计数：必须外露，否则「0 事件」与「埋点坏了」不可区分


def events_health():
    """埋点健康度快照。"""
    return {
        "dropped": _EVENTS_DROPPED,
        "written": STORE.get("_events_written", 0),
        "last_event_ts": STORE.get("_events_last_ts"),
        "file": os.path.basename(EVENTS_FILE),
        "max_bytes": EVENTS_MAX_BYTES,
        "keep": EVENTS_KEEP,
    }


def _write_events_health():
    """把埋点健康度写到独立文件（不进 store.json，避免备份膨胀）。"""
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(EVENTS_HEALTH_FILE, "w", encoding="utf-8") as f:
            json.dump(events_health(), f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def rotate_events_if_needed():
    """JSONL 轮转：超过 EVENTS_MAX_BYTES 就归档，最多保留 EVENTS_KEEP 份。"""
    try:
        if not os.path.isfile(EVENTS_FILE):
            return
        if os.path.getsize(EVENTS_FILE) < EVENTS_MAX_BYTES:
            return
        os.replace(EVENTS_FILE, EVENTS_FILE + ".1")
        # 丢弃超量的旧档（.2 及以后）
        old = EVENTS_FILE + ".2"
        while os.path.isfile(old):
            try:
                os.remove(old)
            except Exception:
                break
            old = EVENTS_FILE + ".2"
    except Exception:
        pass


def append_event(event_name, payload=None, role=None, page=None):
    """追加一条埋点到 data/events.jsonl（append，不进 store.json）。

    6 项必须件之一：写失败静默丢弃并计数，不影响主流程。
    """
    global _EVENTS_DROPPED
    rec = {
        "event_name": event_name,
        "ts": now(),
        "role": role or DEFAULT_ROLE,
        "role_source": ROLE_SOURCE,
        "page": page or "",
        "payload": payload or {},
    }
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        rotate_events_if_needed()
        with open(EVENTS_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        STORE["_events_written"] = STORE.get("_events_written", 0) + 1
        STORE["_events_last_ts"] = rec["ts"]
    except Exception:
        _EVENTS_DROPPED += 1
    _write_events_health()
    return rec


# ---- links 播种（MVP 只做一次性幂等播种，不做写路径切换）----
def seed_links_once():
    """把老 cfg.links 的拓扑连线播种到顶层 links 集合（一次性、幂等）。

    **行级端点，不按 device 展开**：一行 14 台按 device 展开 = 196 条边，
    且「一台换线整行受影响」违背逻辑连线的语义。
    幂等键 = source + sorted(a|b)，重复执行不会重复播种。
    """
    existing = set()
    for l in STORE.get("links", []):
        if not isinstance(l, dict):
            continue
        a, b = str(l.get("a") or ""), str(l.get("b") or "")
        existing.add((l.get("source") or "", tuple(sorted([a, b]))))
    added = 0
    for pair in (STORE.get("cfg") or {}).get("links") or []:
        if not isinstance(pair, (list, tuple)) or len(pair) < 2:
            continue
        a, b = str(pair[0]), str(pair[1])
        key = ("cfg", tuple(sorted([a, b])))
        if key in existing:
            continue
        existing.add(key)
        STORE.setdefault("links", []).append({
            "id": next_id(),
            "kind": "logical",          # 逻辑连线 = 行级
            "a": a,
            "b": b,
            "port_a": "",
            "port_b": "",
            "source": "cfg",
            "link_type": "",
            "status": "active",
            "speed": "",
            "media": "",
        })
        added += 1
    return added


# ---- 角色（M5）----
def role_matrix(role):
    """角色的能力矩阵（与前端 roleCan 同口径）。"""
    role = role if role in ROLES else DEFAULT_ROLE
    sales = role == "sales"
    viewer = role == "viewer"
    return {
        "role": role,
        "role_source": ROLE_SOURCE,
        "sales": sales,
        "read_pricing": sales,
        "publish_pricing": sales,          # 发布权仅 sales
        # viewer（管理层）可读报价，但只拿到「含税总价汇总」投影 —— 读得到 ≠ 读得到明细。
        # 明细读取权单列为 read_quotes_detail（仅 sales）。
        "read_quotes": sales or viewer,
        "read_quotes_detail": sales,
        "write_quotes": sales,
        "read_assets": True,
        "write_assets": role in ("sales", "delivery", "ops"),
        "submit_price_feedback": role in ("sales", "delivery", "ops"),
        "read_price_feedback": role in ("sales", "delivery", "ops"),
        "manage_deliveries": role in ("sales", "delivery"),
    }


def role_can(role, cap):
    """角色是否具备某能力。"""
    return bool(role_matrix(role).get(cap))


def role_caps(role):
    """对外暴露的能力矩阵（/api/whoami）。"""
    return role_matrix(role)


# ---- 价格隔离（M6）----
# 资产侧集合里不得冗余任何价格字段：写入端即剥离，不靠读取端过滤。
# 注意实际字段名有两套：库价用 unit_price_cents / price_cents，
# 报价条目用 unit_cents / line_cents —— 两套都要剥离，否则快照会带出金额。
PRICE_FIELD_NAMES = ("unit_price_cents", "price_cents", "tax_rate", "total_cents",
                     "subtotal_cents", "tax_cents", "line_cents", "unit_cents",
                     "grand_cents", "discount_cents", "amount_cents")


def strip_price_fields(obj):
    """递归剥离价格字段。用于 plan_snapshot / deliveries.snapshot 等落库快照。"""
    if isinstance(obj, dict):
        return {k: strip_price_fields(v) for k, v in obj.items() if k not in PRICE_FIELD_NAMES}
    if isinstance(obj, list):
        return [strip_price_fields(v) for v in obj]
    return obj


def project_device(d):
    """设备台账的对外投影（白名单）。

    照抄 quotes GET 列表的字段投影写法：列表推导 + 逐字段 dict.get()。
    白名单里不含任何价格字段 —— 资产侧不冗余价格。
    """
    return {
        "id": d.get("id"), "code": d.get("code", ""),
        "source_line_uid": d.get("source_line_uid", ""), "seq_no": d.get("seq_no", 0),
        "config_line_ref": d.get("config_line_ref", ""), "origin": d.get("origin", "manual"),
        "sku_id": d.get("sku_id", 0), "sn": d.get("sn", ""),
        "arch": d.get("arch", ""), "os": d.get("os", ""),
        "hypervisor": d.get("hypervisor", ""), "purpose": d.get("purpose", ""),
        "role": d.get("role", ""), "group": d.get("group", ""),
        "state": d.get("state", "planned"),
        "rack_id": d.get("rack_id", 0), "u_start": d.get("u_start", 0),
        "u_size": d.get("u_size", 1), "u_size_source": d.get("u_size_source", "rail"),
        "power_w": d.get("power_w", 0), "host_device_id": d.get("host_device_id", 0),
        "tags": list(d.get("tags") or []),
        "plan_snapshot": d.get("plan_snapshot"),
        "created_from": d.get("created_from", ""), "updated_at": d.get("updated_at", ""),
    }


# ---- 占用账本（M2）----
def rack_by_id(rack_id):
    return next((r for r in STORE.get("racks", []) if r.get("id") == rack_id), None)


def occupancy_set(rack_id, exclude_device_id=None):
    """某机柜已占用的槽位索引集合（权威来源 = rack_units 行级账本）。

    devices.u_start/u_size 只是冗余快照，冲突时以本账本为准。
    """
    used = set()
    for row in STORE.get("rack_units", []):
        if row.get("rack_id") != rack_id:
            continue
        if exclude_device_id is not None and row.get("device_id") == exclude_device_id:
            continue
        idx = row.get("u_index")
        if isinstance(idx, int):
            used.add(idx)
    return used


def rack_used_power_w(rack_id, exclude_device_id=None):
    """机柜内已用功率（按设备台账的 power_w 汇总）。"""
    total = 0
    for d in STORE.get("devices", []):
        if d.get("rack_id") != rack_id:
            continue
        if exclude_device_id is not None and d.get("id") == exclude_device_id:
            continue
        try:
            total += float(d.get("power_w") or 0)
        except (TypeError, ValueError):
            pass
    return total


def check_placement(rack_id, u_start, u_size, exclude_device_id=None, power_w=0):
    """三类冲突分列判定。

    返回 (ok, conflicts)：
      · overlap     行级重叠（目标槽位与同柜已占用槽位相交）→ **计入 U 位冲突率**
      · over_height 超出柜总高                              → 单列「非法位置率」
      · power_over  功率超容                                → **不计入 U 位冲突率**

    三类必须分列：资源冲突（功率）≠ 位置冲突（U 位）。
    """
    conflicts = {"overlap": [], "over_height": [], "power_over": []}
    rack = rack_by_id(rack_id)
    if rack is None:
        raise HTTPError(404, "机柜不存在")
    want = set(device_u_indices(u_start, u_size))
    used = occupancy_set(rack_id, exclude_device_id)
    for idx in sorted(want):
        if idx in used:
            row = next((r for r in STORE.get("rack_units", [])
                        if r.get("rack_id") == rack_id and r.get("u_index") == idx), None)
            conflicts["overlap"].append({
                "rack_id": rack_id, "u_index": idx,
                "device_id": (row or {}).get("device_id"),
            })
    # 超出柜总高
    try:
        total_u = float(rack.get("u_total") or 0)
    except (TypeError, ValueError):
        total_u = 0
    if total_u > 0:
        end_u = float(u_start) + float(u_size)
        if end_u > total_u:
            conflicts["over_height"].append({
                "rack_id": rack_id, "u_total": total_u,
                "u_start": float(u_start), "u_size": float(u_size),
            })
    # 功率超容
    try:
        cap = float(rack.get("power_capacity_w") or 0)
    except (TypeError, ValueError):
        cap = 0
    if cap > 0:
        try:
            add = float(power_w or 0)
        except (TypeError, ValueError):
            add = 0
        used_w = rack_used_power_w(rack_id, exclude_device_id) + add
        if used_w > cap:
            conflicts["power_over"].append({
                "rack_id": rack_id, "power_capacity_w": cap,
                "used_power_w": used_w, "required_power_w": add,
            })
    ok = not (conflicts["overlap"] or conflicts["over_height"] or conflicts["power_over"])
    return ok, conflicts


def conflict_types_of(conflicts):
    """命中的冲突类型（有序）。"""
    out = []
    for key in ("overlap", "over_height", "power_over"):
        if conflicts.get(key):
            out.append(key)
    return out


def conflict_error_text(conflicts):
    """409 的 error 文案：**只描述命中的那一类**，不混入其它两类。

    验收卡要求：报「行级重叠」时，文案不得出现「功率」「柜总高」。
    """
    types = conflict_types_of(conflicts)
    if "overlap" in types:
        return "U 位冲突"
    if "over_height" in types:
        return "超出机柜总高"
    if "power_over" in types:
        return "机柜功率超容"
    return "放置校验未通过"


def write_rack_units(rack_id, u_start, u_size, device_id=0, reserved=0):
    """写入行级占用行（每半 U 一行）。

    调用方必须已通过 check_placement 判定；本函数不重复判定，
    以免「检查」与「写入」之间出现窗口期。
    """
    rows = []
    for idx in device_u_indices(u_start, u_size):
        row = {"id": next_id(), "rack_id": rack_id, "u_index": idx,
               "device_id": device_id, "reserved": 1 if reserved else 0}
        STORE.setdefault("rack_units", []).append(row)
        rows.append(row)
    return rows


def release_rack_units(rack_id, device_id=None, u_index=None):
    """释放占用行。"""
    before = len(STORE.get("rack_units", []))
    STORE["rack_units"] = [
        r for r in STORE.get("rack_units", [])
        if not (r.get("rack_id") == rack_id
                and ((device_id is not None and r.get("device_id") == device_id)
                     or (u_index is not None and r.get("u_index") == u_index)))
    ]
    return before - len(STORE["rack_units"])


def snapshot_drift():
    """设备冗余快照与行级账本的不一致项。

    devices.u_start/u_size 是冗余快照，rack_units 才是权威。
    不一致时记 snapshot_mismatch 事件（目标：不一致率 = 0）。
    """
    drifts = []
    for d in STORE.get("devices", []):
        rack_id = d.get("rack_id")
        if not rack_id:
            continue
        want = set(device_u_indices(d.get("u_start") or 0, d.get("u_size") or 1))
        have = set()
        for row in STORE.get("rack_units", []):
            if row.get("rack_id") == rack_id and row.get("device_id") == d.get("id"):
                have.add(row.get("u_index"))
        if want != have:
            drifts.append({"device_id": d.get("id"), "rack_id": rack_id,
                           "expected": sorted(want), "actual": sorted(have)})
    return drifts


def _log_snapshot_drift(role):
    """写路径后自检快照漂移并埋点。

    指标「快照不一致率 = 0」是防漂移红线；只在写路径上自检，
    不在 GET 里反复记（否则同一次漂移被计 N 次，比率失真）。
    """
    for drift in snapshot_drift():
        append_event("snapshot_mismatch", drift, role)


def find_free_slots(rack_id, u_size, exclude_device_id=None):
    """在机柜内找一段连续的可用槽位（贪心，从下往上）。

    返回起始 U 位；找不到返回 None。
    """
    rack = rack_by_id(rack_id)
    if rack is None:
        return None
    try:
        total_u = float(rack.get("u_total") or 0)
    except (TypeError, ValueError):
        total_u = 0
    if total_u <= 0:
        return None
    used = occupancy_set(rack_id, exclude_device_id)
    need = device_u_indices(0, u_size)
    span = len(need)
    u = 0.0
    while u + u_size <= total_u + 1e-9:
        idxs = device_u_indices(u, u_size)
        if not any(i in used for i in idxs):
            return u
        u += 0.5
    return None


def space_completeness():
    """空间数据完整率 = 已录 u_total 且 power_capacity_w 的机柜数 ÷ 在用机柜数。

    ≥80% 才能给出基于空间的通过结论；<80% 降级为「纸面校验」。
    """
    racks = STORE.get("racks", [])
    in_use = [r for r in racks if r.get("u_total")]
    if not in_use:
        return 0.0, 0, 0
    complete = 0
    for r in in_use:
        try:
            if float(r.get("power_capacity_w") or 0) > 0:
                complete += 1
        except (TypeError, ValueError):
            pass
    return (complete / len(in_use)), complete, len(in_use)


# ---- 设备台账（M1）----
def devices_list(seg):
    """设备台账列表（白名单投影，无价格字段）。

    scope=runtime 只返回已上架（installed/running），计划行不得混入巡检报表。
    """
    rows = STORE.get("devices", [])
    scope = ""
    state = ""
    rack_id = ""
    origin = ""
    for i in range(1, len(seg)):
        if "=" not in seg[i]:
            continue
        k, v = seg[i].split("=", 1)
        if k == "scope":
            scope = v
        elif k == "state":
            state = v
        elif k == "rack_id":
            rack_id = v
        elif k == "origin":
            origin = v
    out = []
    for d in rows:
        if scope == "runtime" and d.get("state") not in RUNTIME_STATES:
            continue
        if scope == "plan" and d.get("state") not in ("planned", "ordered"):
            continue
        if state and d.get("state") != state:
            continue
        if rack_id and str(d.get("rack_id")) != str(rack_id):
            continue
        if origin and d.get("origin") != origin:
            continue
        out.append(project_device(d))
    return out


def machine_by_id(mid):
    try:
        mid = int(mid)
    except (TypeError, ValueError):
        return None
    return next((m for m in STORE.get("machines", []) if m.get("id") == mid), None)


def device_create(b, role):
    """新增设备：只填 SN / 机柜 / U 位即可，机型规格由服务端带出。"""
    sku_id = b.get("sku_id")
    if not sku_id:
        raise HTTPError(400, "缺少 sku_id（机型）")
    m = machine_by_id(sku_id)
    if m is None:
        raise HTTPError(400, "机型不存在：%s" % sku_id)
    state = b.get("state") or "planned"
    if state not in DEVICE_STATES:
        raise HTTPError(400, "非法状态：%s（MVP 仅允许 %s）" % (state, "/".join(DEVICE_STATES)))
    origin = b.get("origin") or "manual"
    if origin not in DEVICE_ORIGINS:
        raise HTTPError(400, "非法来源：%s" % origin)
    u = machine_u_size(m)
    d = {
        "id": next_id(),
        "code": b.get("code") or "",
        "source_line_uid": b.get("source_line_uid") or "",
        "seq_no": int(b.get("seq_no") or 0),
        "config_line_ref": b.get("config_line_ref") or "",
        "origin": origin,
        "sku_id": m.get("id"),
        "sn": b.get("sn") or "",
        # 机型规格由服务端带出（不信任客户端传入的 arch）
        "arch": m.get("arch") or "",
        "os": b.get("os") or "",
        "hypervisor": b.get("hypervisor") or "",
        "purpose": b.get("purpose") or "",
        "role": b.get("role") or "",
        "group": b.get("group") or "",
        "state": state,
        "rack_id": int(b.get("rack_id") or 0),
        "u_start": float(b.get("u_start") or 0),
        # u_size 一律取机型值，不采信客户端传入的高度 ——
        # 与 arch 同口径：规格由服务端带出，客户端只负责「哪台、哪个柜、第几 U」。
        # 改高度是合法的运维动作，走 device_update（那里才允许显式设置 u_size）。
        "u_size": u["u_size"],
        "u_size_source": u["u_size_source"],
        "power_w": float(b.get("power_w") or 0),
        "host_device_id": int(b.get("host_device_id") or 0),
        "tags": list(b.get("tags") or []),
        "plan_snapshot": b.get("plan_snapshot"),
        "created_from": b.get("created_from") or role,
        "updated_at": now(),
    }
    # 规格摘要（不含价格）
    d["plan_snapshot"] = strip_price_fields(d.get("plan_snapshot") or {
        "summary": "%s %s / %s / %d核 / %dG内存" % (
            m.get("brand") or "", m.get("model") or "", m.get("arch") or "",
            m.get("cpu_cores") or 0, m.get("mem_capacity") or 0),
        "arch": m.get("arch") or "",
        "machine_id": m.get("id"),
        "cpu": m.get("cpu_model") or "",
        "cpu_cores": m.get("cpu_cores") or 0,
        "mem_gb": m.get("mem_capacity") or 0,
        "disk": m.get("disk_desc") or "",
        "nic": m.get("nic") or "",
    })
    # 有机柜位置 → 写行级占用账本（冲突判定在锁内）
    conflicts = {"overlap": [], "over_height": [], "power_over": []}
    if d["rack_id"]:
        okc, conflicts = check_placement(d["rack_id"], d["u_start"], d["u_size"],
                                         power_w=d["power_w"])
        if not okc:
            # 埋点：占用写入命中已占用槽位 —— 指标②「重复/重叠占用对数」的来源
            append_event("rack_occupancy_conflict", {
                "rack_id": d["rack_id"], "u_start": d["u_start"], "u_size": d["u_size"],
                "conflict_types": conflict_types_of(conflicts),
                "overlap_slots": len(conflicts.get("overlap") or []),
            }, role)
            raise HTTPError(409, conflict_error_text(conflicts),
                            {"conflict_types": conflict_types_of(conflicts),
                             "conflicts": conflicts})
    STORE.setdefault("devices", []).append(d)
    if d["rack_id"]:
        write_rack_units(d["rack_id"], d["u_start"], d["u_size"], d["id"])
    save_store()
    append_event("device_create", {"device_id": d["id"], "origin": origin}, role)
    # 写路径自检：冗余快照与行级账本必须一致（快照不一致率目标 = 0）
    _log_snapshot_drift(role)
    return {"ok": True, "id": d["id"], "arch": d["arch"],
            "u_size": d["u_size"], "u_size_source": d["u_size_source"],
            "conflicts": conflicts}


def device_update(tid, b, role, method):
    """修改 / 删除设备。每次变更追加一条 asset_changes（M0 版本语义双轨）。"""
    d = next((x for x in STORE.get("devices", []) if x.get("id") == tid), None)
    if d is None:
        raise HTTPError(404, "设备不存在")
    if method == "DELETE":
        release_rack_units(d.get("rack_id") or 0, device_id=tid)
        STORE["devices"] = [x for x in STORE.get("devices", []) if x.get("id") != tid]
        save_store()
        append_event("device_delete", {"device_id": tid}, role)
        return {"ok": True}
    before = {k: d.get(k) for k in ("rack_id", "u_start", "u_size", "state", "sn",
                                    "purpose", "role", "group", "os", "hypervisor")}
    old_rack = d.get("rack_id") or 0
    conflicts = {"overlap": [], "over_height": [], "power_over": []}
    new_rack = int(b.get("rack_id", old_rack) or 0)
    new_start = float(b.get("u_start", d.get("u_start") or 0) or 0)
    new_size = float(b.get("u_size", d.get("u_size") or 1) or 1)
    # 改位 → 先校验新位置（排除自身占用），再释放旧占用行、写新行
    if new_rack:
        okc, conflicts = check_placement(new_rack, new_start, new_size,
                                         exclude_device_id=tid,
                                         power_w=float(b.get("power_w", d.get("power_w") or 0) or 0))
        if not okc:
            append_event("rack_occupancy_conflict", {
                "rack_id": new_rack, "u_start": new_start, "u_size": new_size,
                "device_id": tid, "op": "update",
                "conflict_types": conflict_types_of(conflicts),
                "overlap_slots": len(conflicts.get("overlap") or []),
            }, role)
            raise HTTPError(409, conflict_error_text(conflicts),
                            {"conflict_types": conflict_types_of(conflicts),
                             "conflicts": conflicts})
    for k in ("sn", "purpose", "role", "group", "os", "hypervisor", "code", "tags"):
        if k in b:
            d[k] = b[k]
    if "state" in b:
        if b["state"] not in DEVICE_STATES:
            raise HTTPError(400, "非法状态：%s" % b["state"])
        d["state"] = b["state"]
    moved = (new_rack != old_rack) or (new_start != float(d.get("u_start") or 0))
    if moved:
        if old_rack:
            release_rack_units(old_rack, device_id=tid)
        d["rack_id"] = new_rack
        d["u_start"] = new_start
        d["u_size"] = new_size
        if new_rack:
            write_rack_units(new_rack, new_start, new_size, tid)
    d["updated_at"] = now()
    # 设备级变更流水（M0）：rev_no 递增，append-only
    rev = 0
    for a in STORE.get("asset_changes", []):
        if a.get("device_id") == tid:
            rev = max(rev, int(a.get("rev_no") or 0))
    rev += 1
    after = {k: d.get(k) for k in before.keys()}
    STORE.setdefault("asset_changes", []).append({
        "id": next_id(), "device_id": tid, "rev_no": rev,
        "change_type": "update", "before": before, "after": after,
        "operator": role, "at": now(),
    })
    save_store()
    append_event("device_update", {"device_id": tid, "rev_no": rev}, role)
    return {"ok": True, "conflicts": conflicts, "asset_change": {"rev_no": rev}}


# ---- 交付批次（M4）----
def delivery_create(b, role):
    """报价单 → 交付批次：行 → 台展开，先算后写，冲突整体拒绝。"""
    quote_id = int(b.get("quote_id") or 0)
    q = next((x for x in STORE.get("quotes", []) if x.get("id") == quote_id), None)
    if q is None:
        raise HTTPError(404, "报价单不存在")
    if any(d.get("quote_id") == quote_id for d in STORE.get("deliveries", [])):
        raise HTTPError(409, "该报价单已生成过交付批次")
    dry_run = bool(b.get("dry_run"))
    target_rack = int(b.get("target_rack_id") or 0)
    # 1) 展开：仅物理机且 qty>0
    plan = []
    for it in q.get("items") or []:
        if not isinstance(it, dict):
            continue
        if it.get("type") != "物理机":
            continue
        qty = int(it.get("qty") or 0)
        if qty <= 0:
            continue
        if not it.get("machine_id"):
            raise HTTPError(400, "报价条目缺少 machine_id，无法生成设备")
        item_no = int(it.get("item_no") or 0)
        uid = "q_%s_%s" % (quote_id, item_no)
        for seq in range(1, qty + 1):
            plan.append((it, item_no, uid, seq))
    # 2) 预分配 U 位（贪心找连续可用区间）
    simulated = {}   # rack_id -> set(u_index)
    for rack_id, rows in ((r.get("id"), r) for r in STORE.get("racks", [])):
        simulated[rack_id] = occupancy_set(rack_id)
    placements = []
    conflicts = {"overlap": [], "over_height": [], "power_over": []}
    for it, item_no, uid, seq in plan:
        m = machine_by_id(it.get("machine_id"))
        u = machine_u_size(m or {})
        u_size = float(u["u_size"])
        rack_id = target_rack
        u_start = None
        if rack_id:
            used = simulated.get(rack_id, set())
            rack = rack_by_id(rack_id)
            total_u = float((rack or {}).get("u_total") or 0)
            pos = 0.0
            while total_u <= 0 or pos + u_size <= total_u + 1e-9:
                idxs = device_u_indices(pos, u_size)
                if not any(i in used for i in idxs):
                    u_start = pos
                    break
                pos += 0.5
            if u_start is None:
                conflicts["overlap"].append({
                    "rack_id": rack_id, "u_index": None, "device_id": None,
                    "note": "无可行解位（机柜已满或高度不足）"})
                continue
            for i in device_u_indices(u_start, u_size):
                used.add(i)
            simulated[rack_id] = used
        placements.append({"item": it, "item_no": item_no, "uid": uid, "seq": seq,
                           "machine": m, "u_size": u_size,
                           "u_size_source": u["u_size_source"],
                           "rack_id": rack_id, "u_start": u_start})
    # 3) 冲突 → 整体拒绝，不落库（禁止部分落库）
    if conflicts["overlap"] or conflicts["over_height"] or conflicts["power_over"]:
        raise HTTPError(409, conflict_error_text(conflicts),
                        {"conflict_types": conflict_types_of(conflicts),
                         "conflicts": conflicts})
    if dry_run:
        return {"ok": True, "dry_run": True, "device_count": len(placements),
                "devices": [{"source_line_uid": p["uid"], "seq_no": p["seq"],
                             "sku_id": (p["machine"] or {}).get("id"),
                             "arch": (p["machine"] or {}).get("arch"),
                             "u_start": p["u_start"], "u_size": p["u_size"],
                             "u_size_source": p["u_size_source"],
                             "rack_id": p["rack_id"]} for p in placements],
                "conflicts": conflicts, "infeasible_ratio": 0.0}
    # 4) 落库
    did = next_id()
    devices = []
    for p in placements:
        it = p["item"]
        m = p["machine"] or {}
        d = {
            "id": next_id(),
            "code": "",
            "source_line_uid": p["uid"],
            "seq_no": p["seq"],
            "config_line_ref": "",
            "origin": "delivery",
            "sku_id": m.get("id"),
            "sn": "",
            "arch": it.get("arch") or m.get("arch") or "",
            "os": it.get("os") or "",
            "hypervisor": it.get("hv") or "",
            "purpose": it.get("purpose") or "",
            "role": it.get("role") or "",
            "group": it.get("purpose") or "",
            "state": "planned",
            "rack_id": p["rack_id"],
            "u_start": p["u_start"],
            "u_size": p["u_size"],
            "u_size_source": p["u_size_source"],
            "power_w": 0,
            "host_device_id": 0,
            "tags": [],
            # 冻结快照：写入端即剥离价格字段
            "plan_snapshot": strip_price_fields({
                "summary": "%s %s / %s" % (m.get("brand") or "", m.get("model") or "",
                                           it.get("arch") or m.get("arch") or ""),
                "arch": it.get("arch") or m.get("arch") or "",
                "machine_id": m.get("id"),
                "cpu": it.get("cpu") or "", "mem_gb": it.get("mem_gb") or 0,
                "disk": it.get("disk") or "", "nic": it.get("nic") or "",
                "purpose": it.get("purpose") or "", "role": it.get("role") or "",
            }),
            "created_from": "delivery:%s" % did,
            "updated_at": now(),
        }
        devices.append(d)
    for d in devices:
        STORE.setdefault("devices", []).append(d)
        if d["rack_id"]:
            write_rack_units(d["rack_id"], d["u_start"], d["u_size"], d["id"])
    delivery = {
        "id": did,
        "quote_id": quote_id,
        "quote_version_id": q.get("version_id"),
        "status": "generated",
        "generated_at": now(),
        "device_count": len(devices),
        # 快照不含任何价格字段
        "snapshot": strip_price_fields({
            "quote_name": q.get("name") or "",
            "version_name": q.get("version_name") or "",
            "lines": [{"item_no": it.get("item_no"), "type": it.get("type"),
                       "title": it.get("title"), "qty": it.get("qty"),
                       "machine_id": it.get("machine_id"), "arch": it.get("arch")}
                      for it in (q.get("items") or []) if isinstance(it, dict)],
        }),
    }
    STORE.setdefault("deliveries", []).append(delivery)
    save_store()
    append_event("quote_to_delivery", {"delivery_id": did, "quote_id": quote_id,
                                       "device_count": len(devices)}, role)
    return {"ok": True, "id": did, "device_count": len(devices),
            "devices": [project_device(d) for d in devices],
            "conflicts": conflicts, "infeasible_ratio": 0.0}


# ---- U 位视图（M3）----
def build_rackview(seg):
    """服务端判定占用与冲突，前端只渲染。"""
    rack_id = 0
    for i in range(1, len(seg)):
        if "=" in seg[i]:
            k, v = seg[i].split("=", 1)
            if k == "rack_id":
                rack_id = int(v)
    rack = rack_by_id(rack_id)
    if rack is None:
        raise HTTPError(404, "机柜不存在")
    try:
        total_u = float(rack.get("u_total") or 0)
    except (TypeError, ValueError):
        total_u = 0
    units = {}
    for row in STORE.get("rack_units", []):
        if row.get("rack_id") == rack_id:
            units[row.get("u_index")] = row
    # 设备索引
    dev_by_id = {d.get("id"): d for d in STORE.get("devices", [])}
    slots = []
    total_idx = int(round(total_u * 2))
    for idx in range(total_idx):
        row = units.get(idx)
        dev = dev_by_id.get(row.get("device_id")) if row else None
        if row and dev:
            occ = "reserved" if row.get("reserved") else "occupied"
        elif row:
            occ = "reserved"
        else:
            occ = "free"
        slots.append({
            "u_index": idx,
            "u_start": idx / 2.0,
            "occupancy": occ,
            "device": ({"id": dev.get("id"), "code": dev.get("code") or "",
                        "sn": dev.get("sn") or "", "state": dev.get("state") or "",
                        "purpose": dev.get("purpose") or "", "role": dev.get("role") or "",
                        "u_size": dev.get("u_size") or 1,
                        "u_start": dev.get("u_start") or 0} if dev else None),
        })
    # 冲突（服务端判定，三类分列）
    conflicts = {"overlap": [], "over_height": [], "power_over": []}
    for d in STORE.get("devices", []):
        if d.get("rack_id") != rack_id:
            continue
        idxs = device_u_indices(d.get("u_start") or 0, d.get("u_size") or 1)
        if any(i not in units for i in idxs):
            conflicts["overlap"].append({"device_id": d.get("id"), "u_index": None,
                                         "note": "设备占位与行级账本不一致（快照漂移）"})
        if total_u > 0 and (float(d.get("u_start") or 0) + float(d.get("u_size") or 0)) > total_u:
            conflicts["over_height"].append({"device_id": d.get("id"), "u_total": total_u})
    try:
        cap = float(rack.get("power_capacity_w") or 0)
    except (TypeError, ValueError):
        cap = 0
    used_w = rack_used_power_w(rack_id)
    if cap > 0 and used_w > cap:
        conflicts["power_over"].append({"rack_id": rack_id, "power_capacity_w": cap,
                                        "used_power_w": used_w})
    return {
        "rack": dict(rack),
        "slots": slots,
        "conflicts": conflicts,
        "power": {"used_w": used_w, "capacity_w": cap},
        "occupancy": {"used_slots": len([s for s in slots if s["occupancy"] != "free"]),
                      "total_slots": total_idx},
    }


# ---- 上架可行性预校验（M7）----
def space_validate(b):
    """只读空间模型：不写 devices / links / rack_units / store.json。"""
    rack_id = int(b.get("rack_id") or 0)
    lines = b.get("lines") or []
    completeness, complete_n, total_n = space_completeness()
    conflicts = {"overlap": [], "over_height": [], "power_over": []}
    onboarded = 0
    conflict_devices = 0
    infeasible = 0
    total_u_required = 0.0
    power_required = 0.0
    simulated = {}
    for r in STORE.get("racks", []):
        simulated[r.get("id")] = occupancy_set(r.get("id"))
    for ln in lines:
        if not isinstance(ln, dict):
            continue
        m = machine_by_id(ln.get("machine_id"))
        u = machine_u_size(m or {})
        u_size = float(u["u_size"])
        qty = int(ln.get("qty") or 0)
        for _ in range(qty):
            onboarded += 1
            total_u_required += u_size
            try:
                power_required += float((m or {}).get("power") and 0) or 0
            except (TypeError, ValueError):
                pass
            used = simulated.get(rack_id, set())
            rack = rack_by_id(rack_id)
            total_u = float((rack or {}).get("u_total") or 0)
            pos = 0.0
            found = None
            while total_u <= 0 or pos + u_size <= total_u + 1e-9:
                idxs = device_u_indices(pos, u_size)
                if not any(i in used for i in idxs):
                    found = pos
                    break
                pos += 0.5
            if found is None:
                infeasible += 1
                conflict_devices += 1
                conflicts["overlap"].append({"rack_id": rack_id, "u_index": None,
                                             "note": "无可行解位"})
            else:
                for i in device_u_indices(found, u_size):
                    used.add(i)
                simulated[rack_id] = used
    rate = (conflict_devices / onboarded) if onboarded else 0.0
    infeasible_ratio = (infeasible / onboarded) if onboarded else 0.0
    notes = []
    if completeness >= 0.8:
        mode = "spatial"
        passed = (conflict_devices == 0)
    else:
        mode = "paper"
        passed = None
        notes.append("空间数据完整率仅 %.0f%%（%d/%d 机柜已录容量与功率），"
                     "降级为纸面校验，不给出基于空间的通过结论" % (completeness * 100, complete_n, total_n))
    append_event("validation_block", {"rack_id": rack_id, "mode": mode,
                                      "conflict_device_count": conflict_devices})
    return {
        "mode": mode,
        "space_data_completeness": completeness,
        "pass": passed,
        "conflicts": conflicts,
        "conflict_device_count": conflict_devices,
        "onboarded_device_count": onboarded,
        "u_conflict_rate": rate,
        "infeasible_ratio": infeasible_ratio,
        "total_u_required": total_u_required,
        "power_required_w": power_required,
        "notes": notes,
        # 快照漂移自查（防漂移红线：不一致率目标 = 0）
        "drift": snapshot_drift(),
    }


# ---- 脱敏导出（M6）----
def assets_export():
    """列头服务端写死，**不提供「显示价格」开关**。"""
    room_name = {r.get("id"): r.get("name") or "" for r in STORE.get("rooms", [])}
    rack_name = {r.get("id"): (r.get("code") or r.get("name") or "") for r in STORE.get("racks", [])}
    columns = ["资产编号", "型号", "SN", "机房", "机柜", "U位", "状态"]
    rows = []
    for d in STORE.get("devices", []):
        m = machine_by_id(d.get("sku_id"))
        rows.append([
            d.get("code") or "",
            (m or {}).get("model") or "",
            d.get("sn") or "",
            room_name.get(d.get("room_id")) or "",
            rack_name.get(d.get("rack_id")) or "",
            d.get("u_start") if d.get("rack_id") else "",
            d.get("state") or "",
        ])
    return {"filename": "资产台账.csv", "columns": columns, "rows": rows}


def seg_id(seg, idx=1):
    """把 seg[idx] 解析为整数 id；不是数字返回 None。

    query 参数已并入 seg（见 Handler._route_api），所以 seg[1] 可能是
    "scope=runtime" 这类筛选器而非 id。此时应视为「列表请求」，
    不能盲目 int() —— 否则 ValueError 变 500。
    """
    if len(seg) <= idx:
        return None
    try:
        return int(seg[idx])
    except (TypeError, ValueError):
        return None


def dispatch(method, seg, body, role=DEFAULT_ROLE):
    head = seg[0] if seg else ""
    if method == "GET" and head == "info":
        return {"name": "信创服务器配置报价工具", "version": "0.2"}
    if head == "settings":
        if method == "GET":
            st = dict(STORE.get("settings", {}))
            # 非 sales 剥离 tax_rate：用字段裁剪而非 403，否则 loadLib() 会因 reject 整页白屏
            if not role_can(role, "read_pricing"):
                st.pop("tax_rate", None)
            return st
        if method == "POST":
            if not role_can(role, "write_quotes"):
                raise HTTPError(403, "当前角色无权修改系统设置")
            STORE["settings"].update(body or {})
            save_store()
            return {"ok": True}
    if head == "os_options":
        return OS_OPTIONS
    if head == "hypervisor_options":
        return HV_OPTIONS
    if head == "cfg":
        if not role_can(role, "read_pricing"):
            raise HTTPError(403, "当前角色无权访问配置台")
        if method == "GET":
            return STORE.get("cfg", {})
        if method == "PUT":
            STORE["cfg"] = body or {}
            save_store()
            append_event("config_save", {"phys": len((body or {}).get("phys") or []),
                                         "vm": len((body or {}).get("vm") or [])}, role)
            return {"ok": True}
    if head == "versions":
        if method == "GET":
            return [dict(v) for v in STORE.get("versions", [])]
        if method == "POST":
            # 发布权仅 sales（采价权 ≠ 发布权）
            if not role_can(role, "publish_pricing"):
                raise HTTPError(403, "仅售前角色可新建定价版本")
            # 克隆当前生效版本的机型/部件/虚拟机到新版本并启用
            vid = active_version_id()
            nid = next_id()
            for tbl, key in [("machines", "machines"), ("parts", "parts"), ("vm_prices", "vm_prices"), ("vm_flavors", "vm_flavors")]:
                for r in STORE.get(tbl, []):
                    if r.get("version_id") == vid:
                        nr = dict(r)
                        nr["id"] = next_id()
                        nr["version_id"] = nid
                        STORE.setdefault(tbl, []).append(nr)
            for v in STORE.get("versions", []):
                v["is_active"] = 0
            nv = {"id": nid, "name": (body or {}).get("name", "新版本"),
                  "note": (body or {}).get("note", ""), "created_at": now(), "is_active": 1}
            STORE.setdefault("versions", []).append(nv)
            save_store()
            return {"ok": True, "id": nid}
        if method == "PUT" and len(seg) >= 3 and seg[2] == "activate":
            if not role_can(role, "publish_pricing"):
                raise HTTPError(403, "仅售前角色可启用定价版本")
            tid = seg_id(seg)
            if tid is None:
                raise HTTPError(404, "not found")
            for v in STORE.get("versions", []):
                v["is_active"] = 1 if v["id"] == tid else 0
            save_store()
            return {"ok": True}
    for tbl in ["machines", "parts", "vm_prices", "vm_flavors"]:
        if head == tbl:
            # 单价库对非 sales 角色不可见（菜单级 + 数据级双重隔离）
            if not role_can(role, "read_pricing"):
                raise HTTPError(403, "当前角色无权访问单价库")
            if method == "GET":
                return col_get(tbl)
            if method == "POST":
                d = dict(body or {})
                d["id"] = next_id()
                d["version_id"] = active_version_id()
                STORE.setdefault(tbl, []).append(d)
                save_store()
                return {"ok": True, "id": d["id"]}
            if method in ("PUT", "DELETE"):
                tid = seg_id(seg)
                if tid is None:
                    raise HTTPError(404, "not found")
                rec = next((r for r in STORE.get(tbl, []) if r["id"] == tid), None)
                if not rec:
                    raise HTTPError(404, "not found")
                if method == "PUT":
                    rec.update(body or {})
                    rec["id"] = tid
                    save_store()
                    return {"ok": True}
                if method == "DELETE":
                    STORE[tbl] = [r for r in STORE.get(tbl, []) if r["id"] != tid]
                    save_store()
                    return {"ok": True}
    if head == "quotes":
        # 报价单含价格字段，三档处理：
        #   sales          → 全量（含条目明细与金额）
        #   viewer（管理层）→ 仅汇总投影（报价名 + 含税总价 + 条目数），不含 items
        #   delivery / ops → 403（服务端拒绝，不是前端隐藏）
        if not role_can(role, "read_quotes"):
            raise HTTPError(403, "当前角色无权访问报价单")
        if method == "GET" and seg_id(seg) is None:
            if role == "viewer":
                # viewer 汇总投影：不含 unit_cents / line_cents / tax_cents / subtotal_cents / items
                return [{"id": q["id"], "name": q.get("name"), "created_at": q.get("created_at"),
                         "version_id": q.get("version_id"), "version_name": q.get("version_name"),
                         "total_cents": q.get("total_cents"),
                         "item_count": len(q.get("items") or [])} for q in STORE.get("quotes", [])]
            return [{"id": q["id"], "name": q.get("name"), "created_at": q.get("created_at"),
                     "version_id": q.get("version_id"), "version_name": q.get("version_name"),
                     "tax_rate": q.get("tax_rate"),
                     "subtotal_cents": q.get("subtotal_cents"),
                     "tax_cents": q.get("tax_cents"),
                     "total_cents": q.get("total_cents"),
                     "item_count": len(q.get("items") or [])} for q in STORE.get("quotes", [])]
        if method == "POST":
            if not role_can(role, "write_quotes"):
                raise HTTPError(403, "当前角色无权创建报价单")
            d = dict(body or {})
            d["id"] = next_id()
            d["created_at"] = now()
            # M1.0-b 锚点：报价单 id 已分配，此时才能派生条目级 line_uid。
            # 格式钉死 q_<quoteId>_<item_no>；老单据（无 item_no）按 legacy=1 处理。
            for idx, it in enumerate(d.get("items") or []):
                if not isinstance(it, dict):
                    continue
                if not isinstance(it.get("item_no"), int) or it.get("item_no", 0) <= 0:
                    it["item_no"] = idx + 1
                    it["legacy"] = 1
                it.setdefault("legacy", 0)
                it["line_uid"] = "q_%s_%d" % (d["id"], it["item_no"])
            STORE.setdefault("quotes", []).append(d)
            save_store()
            return {"ok": True, "id": d["id"]}
        if len(seg) >= 2:
            tid = seg_id(seg)
            if tid is None:
                raise HTTPError(404, "not found")
            q = next((x for x in STORE.get("quotes", []) if x["id"] == tid), None)
            if not q:
                raise HTTPError(404, "not found")
            if method == "GET":
                if not role_can(role, "read_quotes_detail"):
                    # viewer 单条同样只给汇总投影（不含 items 与明细金额）
                    return {"id": q["id"], "name": q.get("name"),
                            "created_at": q.get("created_at"),
                            "version_id": q.get("version_id"),
                            "version_name": q.get("version_name"),
                            "total_cents": q.get("total_cents"),
                            "item_count": len(q.get("items") or [])}
                return dict(q)
            if method == "DELETE":
                if not role_can(role, "write_quotes"):
                    raise HTTPError(403, "当前角色无权删除报价单")
                STORE["quotes"] = [x for x in STORE.get("quotes", []) if x["id"] != tid]
                save_store()
                return {"ok": True}
    if head == "apps":
        if method == "GET":
            return [dict(r) for r in STORE.get("apps", [])]
        if method == "POST":
            d = dict(body or {})
            d["id"] = next_id()
            STORE.setdefault("apps", []).append(d)
            save_store()
            return {"ok": True, "id": d["id"]}
        if method in ("PUT", "DELETE"):
            tid = seg_id(seg)
            if tid is None:
                raise HTTPError(404, "not found")
            rec = next((r for r in STORE.get("apps", []) if r["id"] == tid), None)
            if not rec:
                raise HTTPError(404, "not found")
            if method == "PUT":
                rec.update(body or {})
                rec["id"] = tid
                save_store()
                return {"ok": True}
            STORE["apps"] = [r for r in STORE.get("apps", []) if r["id"] != tid]
            save_store()
            return {"ok": True}
    if head == "arch":
        STORE.setdefault("arch", {"options": dict(DEFAULT_ARCH_OPTIONS), "model": None,
                                  "graph": None, "xml": None, "source": "topo", "updated_at": None})
        seg2 = seg[1] if len(seg) >= 2 else ""
        if seg2 == "config":
            return {"embedUrl": DRAWIO_EMBED_URL,
                    "loadTimeoutMs": DRAWIO_LOAD_TIMEOUT_MS,
                    "options": dict(STORE["arch"].get("options") or DEFAULT_ARCH_OPTIONS)}
        if seg2 == "diagram":
            if method == "GET":
                return {
                    "options": dict(STORE["arch"].get("options") or DEFAULT_ARCH_OPTIONS),
                    "model": STORE["arch"].get("model"),
                    "graph": STORE["arch"].get("graph"),
                    "xml": STORE["arch"].get("xml"),
                    "source": STORE["arch"].get("source"),
                    "updated_at": STORE["arch"].get("updated_at"),
                    "has_xml": bool(STORE["arch"].get("xml")),
                }
            if method == "PUT":
                b = body or {}
                xml = b.get("xml")
                if xml is not None:
                    if not isinstance(xml, str):
                        raise HTTPError(400, "xml must be string")
                    if len(xml.encode("utf-8")) > MAX_ARCH_XML_BYTES:
                        raise HTTPError(413, "xml too large (max %d bytes)" % MAX_ARCH_XML_BYTES)
                    STORE["arch"]["xml"] = xml
                for key in ("model", "graph", "source"):
                    if key in b:
                        STORE["arch"][key] = b[key]
                if isinstance(b.get("options"), dict):
                    opts = dict(DEFAULT_ARCH_OPTIONS)
                    opts.update({k: v for k, v in b["options"].items() if k in DEFAULT_ARCH_OPTIONS})
                    STORE["arch"]["options"] = opts
                STORE["arch"]["updated_at"] = now()
                save_store()
                return {"ok": True, "updated_at": STORE["arch"]["updated_at"]}
            if method == "DELETE":
                STORE["arch"].update({"xml": None, "graph": None, "model": None,
                                      "source": "topo", "updated_at": now()})
                STORE["arch"]["options"] = dict(DEFAULT_ARCH_OPTIONS)
                save_store()
                return {"ok": True}
        raise HTTPError(404, "arch path not found")
    if head == "hcl":
        STORE.setdefault("hwlib", {"rules": None, "combos": [], "selections": [], "imports": [],
                                   "purposes": [], "options": dict(DEFAULT_HCL_OPTIONS), "updated_at": None})
        hw = STORE["hwlib"]
        seg2 = seg[1] if len(seg) >= 2 else ""
        if seg2 == "config" and method == "GET":
            return {
                "maxUploadBytes": HCL_MAX_UPLOAD_BYTES,
                "maxRows": HCL_MAX_ROWS, "maxCols": HCL_MAX_COLS, "maxSheets": HCL_MAX_SHEETS,
                "maxStateBytes": HCL_MAX_STATE_BYTES,
                "rules": hw.get("rules") or [],
                "options": dict(hw.get("options") or DEFAULT_HCL_OPTIONS),
            }
        if seg2 == "rules":
            if method == "GET":
                return hw.get("rules") or []
            if method == "PUT":
                b = body or {}
                rules = b.get("rules")
                if rules is not None and not isinstance(rules, list):
                    raise HTTPError(400, "rules must be a list")
                hw["rules"] = rules
                hw["updated_at"] = now()
                save_store()
                return {"ok": True}
        if seg2 == "parse" and method == "POST":
            b = body or {}
            sheets, kind = hcl_read_file(b.get("filename") or "", b.get("content") or "")
            return {
                "name": b.get("filename") or "",
                "kind": kind,
                "sheetCount": len(sheets),
                "sheets": [{"name": s["name"], "rows": s["rows"], "truncated": s.get("truncated", False)} for s in sheets],
            }
        if seg2 == "state":
            if method == "GET":
                return {
                    "rules": hw.get("rules"),
                    "combos": hw.get("combos", []),
                    "selections": hw.get("selections", []),
                    "imports": hw.get("imports", []),
                    "purposes": hw.get("purposes", []),
                    "removed_keys": hw.get("removed_keys") or {},   # B-6：删除墓碑需持久化
                    "options": dict(hw.get("options") or DEFAULT_HCL_OPTIONS),
                    "updated_at": hw.get("updated_at"),
                }
            if method == "PUT":
                b = body or {}
                for key in ("combos", "selections", "imports", "purposes"):
                    if isinstance(b.get(key), list):
                        hw[key] = b[key]
                if isinstance(b.get("removedKeys"), dict):
                    hw["removed_keys"] = b["removedKeys"]
                if b.get("rules") is not None:
                    hw["rules"] = b["rules"]
                if isinstance(b.get("options"), dict):
                    opts = dict(DEFAULT_HCL_OPTIONS)
                    attrs = {k: v for k, v in b["options"].items() if k in DEFAULT_HCL_OPTIONS}
                    opts.update(attrs)
                    hw["options"] = opts
                blob = json.dumps({"combos": hw.get("combos", []),
                                   "selections": hw.get("selections", []),
                                   "imports": hw.get("imports", []),
                                   "removed_keys": hw.get("removed_keys") or {},
                                   "purposes": hw.get("purposes", [])}, ensure_ascii=False)
                if len(blob.encode("utf-8")) > HCL_MAX_STATE_BYTES:
                    raise HTTPError(413, "state too large (max %d bytes)，请先清理旧的模板或清单" % HCL_MAX_STATE_BYTES)
                hw["updated_at"] = now()
                save_store()
                return {"ok": True, "updated_at": hw["updated_at"]}
            if method == "DELETE":
                hw.update({"combos": [], "selections": [], "imports": [], "purposes": [],
                           "rules": None, "removed_keys": {}, "updated_at": now()})
                hw["options"] = dict(DEFAULT_HCL_OPTIONS)
                save_store()
                return {"ok": True}
        raise HTTPError(404, "hcl path not found")
    if head == "library" and len(seg) >= 2:
        if not role_can(role, "read_pricing"):
            raise HTTPError(403, "当前角色无权访问单价库备份")
        if seg[1] == "export" and method == "GET":
            return {
                "machines": STORE.get("machines", []),
                "parts": STORE.get("parts", []),
                "vm_prices": STORE.get("vm_prices", []),
                "vm_flavors": STORE.get("vm_flavors", []),
                "settings": STORE.get("settings", {}),
            }
        if seg[1] == "import" and method == "POST":
            b = body or {}
            vid = active_version_id()
            for tbl in ["machines", "parts", "vm_prices", "vm_flavors"]:
                for r in b.get(tbl, []):
                    nr = dict(r)
                    nr["id"] = next_id()
                    nr["version_id"] = vid
                    STORE.setdefault(tbl, []).append(nr)
            if b.get("settings"):
                STORE["settings"].update(b["settings"])
            save_store()
            return {"ok": True}

    # ============================================================
    # 资产侧路由（M1 台账 / M2 空间模型 / M4 交付 / M6 隔离 / M7 预校验）
    # 角色可见性由 dispatch(method, seg, body, role) 的 role 参数控制。
    # ============================================================
    if head == "whoami" and method == "GET":
        return role_caps(role)
    if head == "catalog" and method == "GET":
        # 机型目录（脱敏）—— 资产侧选型用。
        # 为什么需要它：单价库表 machines 对非 sales 角色 403（价格隔离），
        # 但运维新增设备必须能选机型（否则 M1「只填 SN/机柜/U 位」对 ops 不可用）。
        # 这里走字段白名单投影 —— 只给规格，不给任何价格字段。
        return [{"id": m.get("id"), "brand": m.get("brand"), "model": m.get("model"),
                 "arch": m.get("arch"), "rail": m.get("rail"),
                 "chassis_u": m.get("chassis_u", 0),
                 "cpu_model": m.get("cpu_model"), "cpu_cores": m.get("cpu_cores"),
                 "mem_capacity": m.get("mem_capacity"), "disk_desc": m.get("disk_desc"),
                 "nic": m.get("nic")}
                for m in STORE.get("machines", [])
                if m.get("version_id") == active_version_id()]
    if head == "rooms" or head == "racks":
        tbl = head
        if method == "GET":
            # GET /api/rooms            → 列表
            # GET /api/rooms?xxx=yyy    → 列表（query 已并入 seg）
            # GET /api/rooms/<id>       → 单条
            if seg_id(seg) is None:
                return [dict(r) for r in STORE.get(tbl, [])]
            rid = seg_id(seg)
            rec = next((r for r in STORE.get(tbl, []) if r.get("id") == rid), None)
            if not rec:
                raise HTTPError(404, "not found")
            return dict(rec)
        if method == "POST":
            if not role_can(role, "write_assets"):
                raise HTTPError(403, "当前角色无权新增%s" % ("机房" if tbl == "rooms" else "机柜"))
            d = dict(body or {})
            d["id"] = next_id()
            STORE.setdefault(tbl, []).append(d)
            save_store()
            return {"ok": True, "id": d["id"]}
        if method in ("PUT", "DELETE"):
            if not role_can(role, "write_assets"):
                raise HTTPError(403, "当前角色无权修改机房机柜")
            tid = seg_id(seg)
            if tid is None:
                raise HTTPError(404, "not found")
            rec = next((r for r in STORE.get(tbl, []) if r.get("id") == tid), None)
            if not rec:
                raise HTTPError(404, "not found")
            if method == "PUT":
                rec.update(body or {})
                rec["id"] = tid
                save_store()
                return {"ok": True}
            STORE[tbl] = [r for r in STORE.get(tbl, []) if r.get("id") != tid]
            save_store()
            return {"ok": True}
    if head == "rack_units":
        if method == "GET":
            rows = STORE.get("rack_units", [])
            rid = seg_id(seg)
            if rid is not None:
                rows = [r for r in rows if r.get("rack_id") == rid]
            return [dict(r) for r in rows]
        if method == "POST":
            if not role_can(role, "write_assets"):
                raise HTTPError(403, "当前角色无权修改机柜占用")
            b = body or {}
            rack_id = int(b.get("rack_id") or 0)
            u_start = float(b.get("u_start") or 0)
            u_size = float(b.get("u_size") or 1)
            device_id = int(b.get("device_id") or 0)
            okc, conflicts = check_placement(rack_id, u_start, u_size,
                                             exclude_device_id=device_id or None)
            if not okc:
                append_event("rack_occupancy_conflict", {
                    "rack_id": rack_id, "u_start": u_start, "u_size": u_size,
                    "device_id": device_id, "op": "rack_units",
                    "conflict_types": conflict_types_of(conflicts),
                    "overlap_slots": len(conflicts.get("overlap") or []),
                }, role)
                raise HTTPError(409, conflict_error_text(conflicts),
                                {"conflict_types": conflict_types_of(conflicts),
                                 "conflicts": conflicts})
            rows = write_rack_units(rack_id, u_start, u_size, device_id,
                                    1 if b.get("reserved") else 0)
            save_store()
            return {"ok": True, "rows": rows, "conflicts": conflicts}
        if method == "DELETE":
            if not role_can(role, "write_assets"):
                raise HTTPError(403, "当前角色无权修改机柜占用")
            b = body or {}
            release_rack_units(int(b.get("rack_id") or 0),
                               device_id=b.get("device_id"),
                               u_index=b.get("u_index"))
            save_store()
            return {"ok": True}
    if head == "rackview" and method == "GET":
        return build_rackview(seg)
    if head == "space" and len(seg) >= 2 and seg[1] == "validate" and method == "POST":
        return space_validate(body or {})
    if head == "assets" and len(seg) >= 2 and seg[1] == "export" and method == "GET":
        return assets_export()
    if head == "assets" and len(seg) >= 2 and seg[1] == "drift" and method == "GET":
        # 巡检：设备冗余快照与行级账本的不一致项（目标 = 0）
        drifts = snapshot_drift()
        return {"drift_count": len(drifts), "drifts": drifts,
                "device_count": len([d for d in STORE.get("devices", []) if d.get("rack_id")]),
                "drift_rate": (len(drifts) / len([d for d in STORE.get("devices", []) if d.get("rack_id")])
                               if any(d.get("rack_id") for d in STORE.get("devices", [])) else 0.0)}
    if head == "devices":
        if method == "GET":
            # GET /api/devices                → 列表
            # GET /api/devices?scope=runtime  → 列表（筛选器混在 seg 里）
            # GET /api/devices/<id>           → 单条
            tid = seg_id(seg)
            if tid is None:
                return devices_list(seg)
            d = next((x for x in STORE.get("devices", []) if x.get("id") == tid), None)
            if not d:
                raise HTTPError(404, "设备不存在")
            return project_device(d)
        if method == "POST":
            if not role_can(role, "write_assets"):
                raise HTTPError(403, "当前角色无权新增设备")
            return device_create(body or {}, role)
        if method in ("PUT", "DELETE"):
            if not role_can(role, "write_assets"):
                raise HTTPError(403, "当前角色无权修改设备台账")
            tid = seg_id(seg)
            if tid is None:
                raise HTTPError(404, "设备不存在")
            return device_update(tid, body or {}, role, method)
    if head == "deliveries":
        if method == "GET":
            tid = seg_id(seg)
            if tid is None:
                return [dict(d) for d in STORE.get("deliveries", [])]
            d = next((x for x in STORE.get("deliveries", []) if x.get("id") == tid), None)
            if not d:
                raise HTTPError(404, "not found")
            out = dict(d)
            out["devices"] = [project_device(x) for x in STORE.get("devices", [])
                              if x.get("source_line_uid") and x.get("created_from") == ("delivery:%s" % d.get("id"))]
            return out
        if method == "POST":
            if not role_can(role, "manage_deliveries"):
                raise HTTPError(403, "当前角色无权生成交付批次")
            return delivery_create(body or {}, role)
        if method == "PUT":
            if not role_can(role, "manage_deliveries"):
                raise HTTPError(403, "当前角色无权修改交付批次")
            tid = seg_id(seg)
            if tid is None:
                raise HTTPError(404, "not found")
            d = next((x for x in STORE.get("deliveries", []) if x.get("id") == tid), None)
            if not d:
                raise HTTPError(404, "not found")
            d.update(body or {})
            d["id"] = tid
            save_store()
            return {"ok": True}
    if head == "price_feedback":
        if method == "GET":
            if not role_can(role, "read_price_feedback"):
                raise HTTPError(403, "当前角色无权访问采价反馈")
            rows = STORE.get("price_feedback", [])
            if role != "sales":
                # 本人可见：访问自己提交的 price_feedback 不算泄露
                rows = [r for r in rows if r.get("created_by") == role]
            return [dict(r) for r in rows]
        if method == "POST":
            if not role_can(role, "submit_price_feedback"):
                raise HTTPError(403, "当前角色无权提交采价反馈")
            b = dict(body or {})
            b["id"] = next_id()
            b["created_by"] = role
            b["decided_by"] = None
            b["status"] = "submitted"
            b["at"] = now()
            STORE.setdefault("price_feedback", []).append(b)
            save_store()
            append_event("price_feedback_submit", {"sku_id": b.get("sku_id")}, role)
            # 响应不回显任何库价
            return {"ok": True, "id": b["id"], "status": "submitted"}
    if head == "asset_changes" and method == "GET":
        return [dict(a) for a in STORE.get("asset_changes", [])]
    if head == "reconciliations" and method == "GET":
        return [dict(a) for a in STORE.get("reconciliations", [])]
    if head == "links" and method == "GET":
        return [dict(a) for a in STORE.get("links", [])]
    if head == "events":
        if method == "GET" and len(seg) >= 2 and seg[1] == "health":
            return events_health()
        if method == "POST":
            b = body or {}
            items = b.get("events") if isinstance(b.get("events"), list) else [b]
            written = 0
            for ev in items:
                if not isinstance(ev, dict):
                    continue
                append_event(ev.get("event_name") or "unknown", ev.get("payload"),
                             role, ev.get("page"))
                written += 1
            return {"ok": True, "written": written, "dropped": _EVENTS_DROPPED}
    return {"ok": True}


class Server(ThreadingHTTPServer):
    # 关闭地址复用，确保端口被真正占用时抛 OSError，从而触发自动顺延
    allow_reuse_address = False
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj=None):
        if obj is None:
            data = b""
            ct = "application/json; charset=utf-8"
        elif isinstance(obj, (bytes, bytearray)):
            data = bytes(obj)
            ct = "application/octet-stream"
        else:
            data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            ct = "application/json; charset=utf-8"
        self.send_response(code)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if data:
            self.wfile.write(data)

    def _read_body(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
        except Exception:
            n = 0
        if n <= 0:
            return {}
        if n > MAX_BODY_BYTES:
            raise HTTPError(413, "请求体超过 %d 字节上限" % MAX_BODY_BYTES)
        raw = self.rfile.read(n)
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            raise HTTPError(400, "请求体不是合法 JSON")

    def _serve_static(self, name):
        fp = os.path.normpath(os.path.join(WEB_DIR, name))
        if not fp.startswith(WEB_DIR) or not os.path.isfile(fp):
            self._send(404, {"error": "Not Found"})
            return
        ext = os.path.splitext(fp)[1].lower()
        ct = _CONTENT_TYPES.get(ext, "application/octet-stream")
        with open(fp, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def _route_api(self, method):
        p = urlparse(self.path)
        seg = [s for s in p.path.split("/") if s][1:]  # 去掉 'api'
        # query 参数并入 seg：沿用既有的 "k=v" 段约定，
        # 这样 build_rackview / devices_list 等筛选器只需扫一种形态，
        # 不必为 path 参数与 query 参数各写一套解析。
        if p.query:
            for pair in p.query.split("&"):
                if not pair:
                    continue
                if "=" not in pair:
                    pair += "="
                seg.append(unquote(pair))
        # 角色自声明（M5）：由 X-Role 头携带，缺省 sales。
        # ⚠ 这不是身份认证 —— 头可被伪造，服务端裁剪属于「口径隔离」，
        # role_source 仅供审计，不可用于越权判定。
        role = self.headers.get("X-Role") or DEFAULT_ROLE
        try:
            if role not in ROLES:
                raise HTTPError(400, "非法角色：%s" % role)
            with _lock:
                result = dispatch(method, seg, self._read_body() if method in ("POST", "PUT") else None, role)
            self._send(200, result)
        except HTTPError as e:
            body = {"error": e.msg}
            if isinstance(e.detail, dict):
                body.update(e.detail)
            self._send(e.code, body)
        except Exception as e:  # noqa
            self._send(500, {"error": str(e)})

    def do_GET(self):
        p = urlparse(self.path)
        path = p.path
        if path.startswith("/api/"):
            return self._route_api("GET")
        if path in ("/", "/index.html"):
            return self._serve_static("index.html")
        if path.startswith("/static/"):
            return self._serve_static(path[len("/static/"):])
        if "." in os.path.basename(path):
            return self._serve_static(path.lstrip("/"))
        return self._serve_static("index.html")

    def do_POST(self):
        if urlparse(self.path).path.startswith("/api/"):
            return self._route_api("POST")
        self._send(404, {"error": "not found"})

    def do_PUT(self):
        if urlparse(self.path).path.startswith("/api/"):
            return self._route_api("PUT")
        self._send(404, {"error": "not found"})

    def do_DELETE(self):
        if urlparse(self.path).path.startswith("/api/"):
            return self._route_api("DELETE")
        self._send(404, {"error": "not found"})


def main():
    if not os.path.isdir(WEB_DIR):
        print(f"未找到 web 目录: {WEB_DIR}")
        return
    load_store()
    srv = None
    port = None
    max_tries = 10
    for offset in range(max_tries):
        cand = DEFAULT_PORT + offset
        try:
            srv = Server((HOST, cand), Handler)
            port = cand
            break
        except OSError as e:
            print(f"端口 {cand} 不可用（{e}），尝试下一个端口...")
            continue
    if srv is None:
        print(f"错误：端口 {DEFAULT_PORT}~{DEFAULT_PORT + max_tries - 1} 均无法绑定，请关闭占用程序后重试。")
        sys.exit(1)
    if port != DEFAULT_PORT:
        print(f"注意：默认端口 {DEFAULT_PORT} 被占用，已自动改用端口 {port}。")
    print(f"服务器已启动（静态 + REST API）: http://localhost:{port}")
    print(f"静态目录: {WEB_DIR}")
    print(f"数据文件: {STORE_FILE}")
    print("按 Ctrl+C 停止。")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
