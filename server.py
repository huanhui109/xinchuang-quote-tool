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
import socket
import base64
import zipfile
import io
import threading
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
DATA_DIR = os.path.join(BASE_DIR, "data")
STORE_FILE = os.path.join(DATA_DIR, "store.json")
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
             "rail": "2U导轨", "unit_price_cents": 8600000, "supplier": "厂商询价(示例)", "basis": "示例价，待替换"},
            {"id": 2, "version_id": 1, "brand": "海光", "model": "Hygon 7470", "arch": "海光(C86/x86)",
             "cpu_model": "Hygon 7470", "cpu_sockets": 2, "cpu_cores": 48, "cpu_freq": 2.6,
             "mem_capacity": 512, "mem_gen": "DDR4", "disk_bays": "8",
             "disk_desc": "4×1.92T NVMe + 4×3.84T NVMe", "nic": "4×25GbE", "power": "2×1200W",
             "rail": "2U导轨", "unit_price_cents": 15800000, "supplier": "厂商询价(示例)", "basis": "示例价，待替换"},
            {"id": 3, "version_id": 1, "brand": "鲲鹏", "model": "Kunpeng 920", "arch": "鲲鹏(ARM)",
             "cpu_model": "Kunpeng 920", "cpu_sockets": 2, "cpu_cores": 64, "cpu_freq": 2.6,
             "mem_capacity": 512, "mem_gen": "DDR4", "disk_bays": "8",
             "disk_desc": "4×1.92T NVMe", "nic": "4×25GbE", "power": "2×900W",
             "rail": "2U导轨", "unit_price_cents": 14200000, "supplier": "厂商询价(示例)", "basis": "示例价，待替换"},
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
    """补齐旧版 store.json 缺失的字段（向前兼容）。"""
    global STORE
    changed = False
    for key, dft in [("quotes", []), ("apps", []), ("versions", []), ("machines", []),
                     ("parts", []), ("vm_prices", []), ("vm_flavors", [])]:
        if key not in STORE or STORE[key] is None:
            STORE[key] = dft
            changed = True
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
        STORE["arch"]["options"] = opts
        for key in ("model", "graph", "xml", "source", "updated_at"):
            STORE["arch"].setdefault(key, None)
        changed = True
    if "hwlib" not in STORE or not isinstance(STORE["hwlib"], dict):
        STORE["hwlib"] = {"rules": None, "combos": [], "selections": [], "imports": [],
                          "purposes": [], "options": dict(DEFAULT_HCL_OPTIONS), "updated_at": None}
        changed = True
    else:
        hw = STORE["hwlib"]
        for key, dft in [("combos", []), ("selections", []), ("imports", []), ("purposes", [])]:
            if not isinstance(hw.get(key), list):
                hw[key] = dft
                changed = True
        opts = dict(DEFAULT_HCL_OPTIONS)
        if isinstance(hw.get("options"), dict):
            opts.update(hw["options"])
            hw["options"] = opts
            changed = True
        hw.setdefault("rules", None)
        hw.setdefault("updated_at", None)
    if changed:
        save_store()


def save_store():
    """原子写：先写临时文件再 os.replace，避免崩溃/断电留下截断的 JSON（A-4）。"""
    os.makedirs(DATA_DIR, exist_ok=True)
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
    def __init__(self, code, msg):
        self.code = code
        self.msg = msg


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


def dispatch(method, seg, body):
    head = seg[0] if seg else ""
    if method == "GET" and head == "info":
        return {"name": "信创服务器配置报价工具", "version": "0.2"}
    if head == "settings":
        if method == "GET":
            return dict(STORE.get("settings", {}))
        if method == "POST":
            STORE["settings"].update(body or {})
            save_store()
            return {"ok": True}
    if head == "os_options":
        return OS_OPTIONS
    if head == "hypervisor_options":
        return HV_OPTIONS
    if head == "cfg":
        if method == "GET":
            return STORE.get("cfg", {})
        if method == "PUT":
            STORE["cfg"] = body or {}
            save_store()
            return {"ok": True}
    if head == "versions":
        if method == "GET":
            return [dict(v) for v in STORE.get("versions", [])]
        if method == "POST":
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
            tid = int(seg[1])
            for v in STORE.get("versions", []):
                v["is_active"] = 1 if v["id"] == tid else 0
            save_store()
            return {"ok": True}
    for tbl in ["machines", "parts", "vm_prices", "vm_flavors"]:
        if head == tbl:
            if method == "GET":
                return col_get(tbl)
            if method == "POST":
                d = dict(body or {})
                d["id"] = next_id()
                d["version_id"] = active_version_id()
                STORE.setdefault(tbl, []).append(d)
                save_store()
                return {"ok": True, "id": d["id"]}
            if method in ("PUT", "DELETE") and len(seg) >= 2:
                tid = int(seg[1])
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
        if method == "GET" and len(seg) == 1:
            return [{"id": q["id"], "name": q.get("name"), "created_at": q.get("created_at"),
                     "version_id": q.get("version_id"), "version_name": q.get("version_name"),
                     "tax_rate": q.get("tax_rate"),
                     "subtotal_cents": q.get("subtotal_cents"),
                     "tax_cents": q.get("tax_cents"),
                     "total_cents": q.get("total_cents"),
                     "item_count": len(q.get("items") or [])} for q in STORE.get("quotes", [])]
        if method == "POST":
            d = dict(body or {})
            d["id"] = next_id()
            d["created_at"] = now()
            STORE.setdefault("quotes", []).append(d)
            save_store()
            return {"ok": True, "id": d["id"]}
        if len(seg) >= 2:
            tid = int(seg[1])
            q = next((x for x in STORE.get("quotes", []) if x["id"] == tid), None)
            if not q:
                raise HTTPError(404, "not found")
            if method == "GET":
                return dict(q)
            if method == "DELETE":
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
        if method in ("PUT", "DELETE") and len(seg) >= 2:
            tid = int(seg[1])
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
        try:
            with _lock:
                result = dispatch(method, seg, self._read_body() if method in ("POST", "PUT") else None)
            self._send(200, result)
        except HTTPError as e:
            self._send(e.code, {"error": e.msg})
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
