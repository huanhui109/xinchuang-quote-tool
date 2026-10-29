#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""后端 API 契约测试 —— 真起 server.py 进程跑 HTTP。

背景：此前 server.py 从未被真正执行过 —— tools/test-quote.js 只是
readFileSync('server.py') 做正则文本断言。逻辑写错、接口 404、403 规则
没生效，测试都能全绿。这是本项目最大的质量盲区。

本套件（纯标准库，无第三方依赖）：
  · 直接 import server，用 tempfile 目录隔离数据（单测部分）
  · 真起 subprocess 跑 server.py，走 HTTP 做集成断言（集成部分）
  · 关键：STORE_DATA_DIR 环境变量隔离，绝不污染用户真实的 data/store.json

运行： python3 tools/test-backend.py
输出： 结果：N 通过 / M 失败（共 N+M 项）
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER_PY = os.path.join(ROOT, 'server.py')

PASS = 0
FAIL = 0
FAILURES = []


def ok(cond, msg):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] ' + str(msg))
    else:
        FAIL += 1
        FAILURES.append(str(msg))
        print('  [FAIL] ' + str(msg))


def eq(a, b, msg):
    ok(a == b, '%s（期望 %r，实际 %r）' % (msg, b, a))


def group(name):
    print('\n# ' + name)


def eq_json(a, b, msg):
    ok(json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True),
       '%s（期望 %s，实际 %s）' % (msg, json.dumps(b, sort_keys=True),
                                 json.dumps(a, sort_keys=True)))


# ============================================================ 进程脚手架

def free_port():
    """取一个当前空闲的高位端口。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class ServerProc(object):
    """真起 server.py 子进程，用完必杀。"""

    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.port = free_port()
        self.proc = None

    def __enter__(self):
        env = dict(os.environ)
        env['PORT'] = str(self.port)
        env['HOST'] = '127.0.0.1'
        env['STORE_DATA_DIR'] = self.data_dir
        env['PYTHONUNBUFFERED'] = '1'
        self.proc = subprocess.Popen(
            [sys.executable, SERVER_PY],
            cwd=ROOT, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        # 轮询 /api/info 直到就绪
        deadline = time.time() + 20
        while time.time() < deadline:
            if self.proc.poll() is not None:
                out = self.proc.stdout.read().decode('utf-8', 'replace')
                raise RuntimeError('server.py 启动即退出：\n' + out)
            try:
                st, body = self.request('GET', '/api/info')
                if st == 200:
                    return self
            except Exception:
                pass
            time.sleep(0.15)
        raise RuntimeError('server.py 启动超时（20s）')

    def __exit__(self, *exc):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except Exception:
                self.proc.kill()
                try:
                    self.proc.wait(timeout=5)
                except Exception:
                    pass
        if self.proc and self.proc.stdout:
            try:
                self.proc.stdout.close()
            except Exception:
                pass
        return False

    def url(self, path):
        return 'http://127.0.0.1:%d%s' % (self.port, path)

    def request(self, method, path, body=None, role=None, timeout=20):
        """返回 (status, parsed_body)。HTTP 错误不抛，返回真实状态码。"""
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        if role:
            headers['X-Role'] = role
        req = urllib.request.Request(self.url(path), data=data,
                                     headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode('utf-8', 'replace')
                try:
                    return resp.status, json.loads(raw)
                except Exception:
                    return resp.status, raw
        except urllib.error.HTTPError as e:
            raw = e.read().decode('utf-8', 'replace')
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, raw

    def get(self, path, role=None):
        return self.request('GET', path, None, role)

    def post(self, path, body=None, role=None):
        return self.request('POST', path, body if body is not None else {},
                            role)

    def put(self, path, body=None, role=None):
        return self.request('PUT', path, body if body is not None else {}, role)

    def delete(self, path, role=None):
        return self.request('DELETE', path, None, role)

    def store(self):
        """读取服务端实际落盘的 store.json。"""
        p = os.path.join(self.data_dir, 'store.json')
        if not os.path.isfile(p):
            return None
        with open(p, 'r', encoding='utf-8') as f:
            return json.load(f)


# ============================================================ 断言工具

# 与 server.py 的 PRICE_FIELD_NAMES 保持一致：
# 库价字段（unit_price_cents / price_cents）与报价条目字段（unit_cents / line_cents）
# 是两套命名，两套都要扫描，否则会漏掉真实泄露。
PRICE_KEYS = ('unit_price_cents', 'price_cents', 'tax_rate', 'total_cents',
              'line_cents', 'unit_cents', 'subtotal_cents', 'tax_cents',
              'grand_cents', 'discount_cents', 'amount_cents')


def scan_price_keys(obj, path='$'):
    """递归扫描 JSON，找出所有价格相关字段名。返回 [(路径, 字段名)]。"""
    hits = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in PRICE_KEYS:
                hits.append((path + '.' + k, k))
            hits.extend(scan_price_keys(v, path + '.' + str(k)))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            hits.extend(scan_price_keys(v, '%s[%d]' % (path, i)))
    return hits


def free_port_ok(p):
    return 1024 < p < 65535


# ============================================================ 测试主体

def run():
    tmp = tempfile.mkdtemp(prefix='xcq_backend_test_')
    try:
        test_unit_level(tmp)
        test_integration(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_unit_level(tmp):
    """import server 直接调内部函数（不依赖 HTTP）。"""
    group('单元：数据目录隔离与 import 安全性')
    os.environ['STORE_DATA_DIR'] = tmp
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    import server  # noqa: E402  （main() 只在 __main__ 下执行，import 安全）

    ok(os.path.isdir(WEB_DIR_EXPECT := os.path.join(ROOT, 'web')),
       'WEB_DIR 存在：%s' % WEB_DIR_EXPECT)
    ok(server.DATA_DIR == tmp,
       'STORE_DATA_DIR 覆盖生效（DATA_DIR=%s）' % server.DATA_DIR)
    ok(server.STORE_FILE.startswith(tmp),
       'STORE_FILE 落在隔离目录内（%s）' % server.STORE_FILE)

    # ---- M1.0 高度换算 ----
    group('单元：M1.0 高度换算与 U 位索引')
    eq(server.machine_u_size({'chassis_u': 2, 'rail': '2U导轨'}),
       {'u_size': 2, 'u_size_source': 'chassis'},
       'chassis_u=2 → 权威高度 2U，来源 chassis')
    eq(server.machine_u_size({'chassis_u': 0, 'rail': '2U导轨'}),
       {'u_size': 2, 'u_size_source': 'rail'},
       'chassis_u=0 → 按 rail 解析 2U，来源 rail')
    eq(server.machine_u_size({'rail': '4U导轨'}),
       {'u_size': 4, 'u_size_source': 'rail'},
       '无 chassis_u 时按 rail 解析 4U')
    eq(server.u_index_of(1), 2, 'u_index_of(1) = 2（每半 U 一格）')
    eq(server.u_index_of(0), 0, 'u_index_of(0) = 0')
    eq(server.device_u_indices(1, 2), [2, 3, 4, 5],
       'device_u_indices(1,2) = [2,3,4,5]（整 U 占 2 格）')
    eq(server.device_u_indices(1.5, 0.5), [3],
       'device_u_indices(1.5,0.5) = [3]（半 U 占 1 格）')
    eq(server.device_u_indices(1, 1), [2, 3],
       'device_u_indices(1,1) = [2,3]（1U 占 2 格）')

    # ---- M1.0 seed_store 新集合 ----
    group('单元：M1.0 新集合与机型字段')
    seeded = server.seed_store()
    for key in ('rooms', 'racks', 'rack_units', 'devices', 'asset_changes',
                'links', 'deliveries', 'reconciliations', 'price_feedback'):
        ok(key in seeded and isinstance(seeded[key], list),
           'seed_store 含空集合 %s' % key)
    ok(len(seeded.keys()) == len(set(seeded.keys())),
       'seed_store 顶层键无重复')
    for m in seeded.get('machines', []):
        ok('chassis_u' in m,
           '机型 %s 有 chassis_u 字段（值=%r）' % (m.get('model'), m.get('chassis_u')))
        break

    # ---- M1.0 migrate_store 幂等 ----
    group('单元：M1.0 migrate_store 幂等与锚点字段')
    server.STORE = server.seed_store()
    # 造一个「老单据」：无 item_no / line_uid / legacy
    server.STORE['quotes'] = [{
        'id': 901, 'name': '老单', 'created_at': '2026-01-01 00:00',
        'version_id': 1, 'items': [
            {'type': '物理机', 'title': 'A', 'qty': 1, 'unit_cents': 100, 'line_cents': 100},
            {'type': '物理机', 'title': 'B', 'qty': 2, 'unit_cents': 200, 'line_cents': 400},
        ],
    }]
    server.migrate_store()
    first = json.dumps(server.STORE, sort_keys=True, ensure_ascii=False)
    items = server.STORE['quotes'][0]['items']
    eq(items[0].get('item_no'), 1, '老单 items[0].item_no = 1')
    eq(items[1].get('item_no'), 2, '老单 items[1].item_no = 2')
    eq(items[0].get('legacy'), 1, '老单 items[0].legacy = 1（弱锚点）')
    ok(bool(items[0].get('line_uid')), '老单 items[0].line_uid 已生成：%r' % items[0].get('line_uid'))
    ok(items[0].get('line_uid') == 'q_901_1',
       'line_uid 格式钉死为 q_<quoteId>_<itemNo>（实际 %r）' % items[0].get('line_uid'))
    # 幂等：再跑一次，结果必须完全一致
    server.migrate_store()
    second = json.dumps(server.STORE, sort_keys=True, ensure_ascii=False)
    ok(first == second, 'migrate_store 幂等：连跑两次结果完全一致')
    # 只加不减：老单条目数不变
    eq(len(server.STORE['quotes'][0]['items']), 2, 'migrate 只加不减：条目数仍为 2')

    # ---- M0 版本语义双轨 ----
    group('单元：M0 版本语义双轨（versions 与 asset_changes 不混用）')
    ok(all('rev_no' not in v for v in server.STORE.get('versions', [])),
       'versions[] 无 rev_no 键（定价快照不带设备级变更号）')
    ok(all('version_id' not in a for a in server.STORE.get('asset_changes', [])),
       'asset_changes[] 无 version_id 键（设备级变更不带定价版本号）')

    # ---- M6 价格字段剥离 ----
    group('单元：M6 价格字段剥离')
    stripped = server.strip_price_fields({
        'type': '物理机', 'qty': 1, 'unit_cents': 100, 'line_cents': 100,
        'parts': [{'spec': 'x', 'price_cents': 5}],
        'meta': {'tax_rate': '0.13'},
    })
    ok('unit_cents' not in stripped, 'strip_price_fields 剥离 unit_cents')
    ok('line_cents' not in stripped, 'strip_price_fields 剥离 line_cents')
    ok('tax_rate' not in stripped.get('meta', {}), 'strip_price_fields 递归剥离 tax_rate')
    ok('price_cents' not in stripped.get('parts', [{}])[0], 'strip_price_fields 递归剥离嵌套 price_cents')
    ok('qty' in stripped, 'strip_price_fields 保留非价格字段 qty')

    # ---- 角色能力矩阵 ----
    group('单元：M5 角色能力矩阵')
    eq(server.role_caps('sales').get('publish_pricing'), True, 'sales 有定价发布权')
    eq(server.role_caps('delivery').get('publish_pricing'), False, 'delivery 无定价发布权')
    eq(server.role_caps('ops').get('publish_pricing'), False, 'ops 无定价发布权')
    eq(server.role_caps('viewer').get('publish_pricing'), False, 'viewer 无定价发布权')
    eq(server.role_caps('ops').get('read_quotes'), False, 'ops 无报价单读权限')
    eq(server.role_caps('viewer').get('read_price_feedback'), False,
       'viewer 无 price_feedback 读权限')
    eq(server.role_caps('delivery').get('submit_price_feedback'), True,
       'delivery 有采价反馈提交权（采价权 ≠ 发布权）')
    eq(server.role_caps('ops').get('read_assets'), True, 'ops 可读资产侧')
    eq(server.role_caps('viewer').get('write_assets'), False, 'viewer 只读资产侧')
    eq(server.role_caps('unknown').get('role'), 'sales', '非法角色回落 sales')


def test_integration(tmp):
    """真起进程跑 HTTP。"""
    group('集成：进程启动与基础接口')
    data_dir = os.path.join(tmp, 'data')
    os.makedirs(data_dir, exist_ok=True)
    with ServerProc(data_dir) as srv:
        st, body = srv.get('/api/info')
        ok(st == 200, 'GET /api/info 返回 200（实际 %s）' % st)
        ok(isinstance(body, dict), '/api/info 返回 JSON 对象')

        st, body = srv.get('/api/whoami')
        ok(st == 200, 'GET /api/whoami 返回 200（实际 %s）' % st)
        ok(isinstance(body, dict) and body.get('role') == 'sales',
           '缺省角色为 sales（向后兼容）')
        st, body = srv.get('/api/whoami', role='ops')
        ok(st == 200 and body.get('role') == 'ops', 'X-Role: ops 被服务端识别')
        ok(body.get('role_source') == 'self_declared', 'role_source 标注为 self_declared')

        # ---- 非法角色 ----
        st, body = srv.get('/api/whoami', role='hacker')
        ok(st == 400, '非法角色返回 400（实际 %s）' % st)

        # ============================================================
        # M6：价格隔离（服务端级断言）
        # ============================================================
        group('M6：价格隔离（服务端级）')
        st, body = srv.get('/api/quotes', role='ops')
        ok(st == 403, 'ops 访问 /api/quotes 被服务端 403（实际 %s）' % st)
        st, body = srv.get('/api/quotes', role='delivery')
        ok(st == 403, 'delivery 访问 /api/quotes 被服务端 403（实际 %s）' % st)
        st, body = srv.get('/api/quotes', role='sales')
        ok(st == 200, 'sales 访问 /api/quotes 返回 200（实际 %s）' % st)
        for p in ['/api/machines', '/api/parts', '/api/vm_prices', '/api/vm_flavors',
                  '/api/cfg', '/api/library/export']:
            st, _ = srv.get(p, role='ops')
            ok(st == 403, 'ops 访问 %s 被服务端 403（实际 %s）' % (p, st))

        # viewer 汇总投影
        st, body = srv.get('/api/quotes', role='viewer')
        ok(st == 200, 'viewer 访问 /api/quotes 列表返回 200（实际 %s）' % st)
        hits = scan_price_keys(body)
        # viewer 允许 total_cents（汇总），但不允许明细级价格字段
        bad = [h for h in hits if h[1] != 'total_cents']
        eq(bad, [], 'viewer 报价单投影不含明细价格字段（仅允许 total_cents 汇总）')
        ok(isinstance(body, list) and all('items' not in q for q in body),
           'viewer 报价单投影不含 items 明细')

        # 发布权仅 sales
        st, _ = srv.post('/api/versions', {'name': 'x'}, role='delivery')
        ok(st == 403, 'delivery 新建定价版本被拒（发布权仅 sales，实际 %s）' % st)
        st, _ = srv.post('/api/versions', {'name': 'x'}, role='ops')
        ok(st == 403, 'ops 新建定价版本被拒（实际 %s）' % st)
        st, _ = srv.put('/api/versions/1/activate', {}, role='ops')
        ok(st == 403, 'ops 启用定价版本被拒（实际 %s）' % st)

        # settings 裁剪
        st, body = srv.get('/api/settings', role='ops')
        ok(st == 200, 'ops 访问 /api/settings 返回 200（用裁剪而非 403）')
        ok('tax_rate' not in body, 'ops 的 settings 已剥离 tax_rate')
        st, body = srv.get('/api/settings', role='sales')
        ok('tax_rate' in body, 'sales 的 settings 保留 tax_rate')

        # ============================================================
        # M2：空间模型 + 行级占用账本 + 三类冲突分列
        # ============================================================
        group('M2：空间模型与三类冲突分列')
        st, room = srv.post('/api/rooms', {'name': 'A栋 301', 'building': 'A',
                                           'floor': 3, 'capacity_kw': 100}, role='sales')
        ok(st == 200, '新建机房返回 200（实际 %s）' % st)
        room_id = room.get('id')
        st, rack = srv.post('/api/racks', {'room_id': room_id, 'code': 'A-3',
                                           'u_total': 42, 'power_capacity_w': 5000,
                                           'row': 1, 'col': 3}, role='sales')
        ok(st == 200, '新建机柜返回 200（实际 %s）' % st)
        rack_id = rack.get('id')

        # 放一台 2U 设备占 1-4U（u_start=1, u_size=2 → 槽位 [2,3,4,5]）
        st, dev1 = srv.post('/api/devices', {'sku_id': 1, 'sn': 'SN0001',
                                             'rack_id': rack_id, 'u_start': 1,
                                             'purpose': '数据库', 'role': '主'},
                            role='sales')
        ok(st == 200, '新增设备（带机柜位置）返回 200（实际 %s）' % st)
        ok(dev1.get('arch'), '服务端自动带出机型 arch（实际 %r）' % dev1.get('arch'))
        ok(dev1.get('u_size') == 2, '服务端自动算出 u_size=2（实际 %r）' % dev1.get('u_size'))
        ok(dev1.get('u_size_source') == 'rail', 'u_size_source=rail（chassis_u 缺省）')
        dev1_id = dev1.get('id')

        # 行级账本：2U 设备 → 4 个槽位行
        st, units = srv.get('/api/rack_units/%s' % rack_id)
        ok(st == 200, 'GET /api/rack_units 返回 200（实际 %s）' % st)
        eq(len(units), 4, '2U 设备写 4 个槽位行（每半 U 一行）')
        eq(sorted(u['u_index'] for u in units), [2, 3, 4, 5], '槽位索引 = round(u×2)')

        # ① 行级重叠：设备 A 占 U1.0–U3.0（槽位 2..5），
        #    再放一台 2U 到 u_start=2（U2.0–U4.0，槽位 4..7）→ 槽位 4、5 双重占用 → 409
        st, body = srv.post('/api/devices', {'sku_id': 1, 'sn': 'SN0002',
                                             'rack_id': rack_id, 'u_start': 2},
                            role='sales')
        ok(st == 409, '行级重叠返回 409（实际 %s）' % st)
        ok(len(body.get('conflicts', {}).get('overlap', [])) > 0, 'conflict_types 含 overlap')
        eq([c.get('u_index') for c in body.get('conflicts', {}).get('overlap', [])],
           [4, 5], '重叠槽位精确命中 4、5（行级账本定位到具体槽位）')
        ok(len(body.get('conflicts', {}).get('over_height', [])) == 0,
           'over_height 为空（未命中该类）')
        ok(len(body.get('conflicts', {}).get('power_over', [])) == 0,
           'power_over 为空（未命中该类）')
        err_text = str(body.get('error') or '')
        ok('功率' not in err_text and '柜总高' not in err_text and '总高' not in err_text,
           'error 文案只描述命中的那一类（实际 %r，不含功率/柜总高）' % err_text)

        # ② 超出柜总高：u_start=41, u_size=2 → 43 > 42
        st, body = srv.post('/api/devices', {'sku_id': 1, 'sn': 'SN0003',
                                             'rack_id': rack_id, 'u_start': 41},
                            role='sales')
        ok(st == 409, '超出柜总高返回 409（实际 %s）' % st)
        ok(len(body.get('conflicts', {}).get('over_height', [])) > 0, 'over_height 非空')
        ok(len(body.get('conflicts', {}).get('overlap', [])) == 0, 'overlap 为空')

        # ③ 功率超容：机柜功率 5000W，放一台 power_w=6000
        st, body = srv.post('/api/devices', {'sku_id': 1, 'sn': 'SN0004',
                                             'rack_id': rack_id, 'u_start': 10,
                                             'power_w': 6000}, role='sales')
        ok(st == 409, '功率超容返回 409（实际 %s）' % st)
        ok(len(body.get('conflicts', {}).get('power_over', [])) > 0, 'power_over 非空')
        ok(len(body.get('conflicts', {}).get('overlap', [])) == 0, 'overlap 为空')

        # 非法状态
        st, _ = srv.post('/api/devices', {'sku_id': 1, 'sn': 'SNX', 'state': 'fault'},
                         role='sales')
        ok(st == 400, '非法 state 返回 400（实际 %s）' % st)

        # 设备响应递归扫描无价格字段
        st, body = srv.get('/api/devices', role='ops')
        hits = scan_price_keys(body)
        eq(hits, [], '设备台账响应递归扫描 0 个价格字段')

        # ============================================================
        # M2：并发占用（同一 U 位两发 → 恰好 1 成功）
        # ============================================================
        group('M2：并发占用穿透')
        import threading
        results = []
        lock = threading.Lock()

        def place(sn):
            st, _ = srv.post('/api/devices', {'sku_id': 1, 'sn': sn,
                                              'rack_id': rack_id, 'u_start': 20},
                             role='sales')
            with lock:
                results.append(st)

        threads = [threading.Thread(target=place, args=('CONC%d' % i,)) for i in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        eq(sorted(results), [200, 409], '同一 U 位并发两发 → 恰好 1 成功 1 冲突')
        st, units = srv.get('/api/rack_units/%s' % rack_id)
        at20 = [u for u in units if u['u_index'] in (40, 41)]
        eq(len(at20), 2, '落库后该 U 位只有 1 台设备占 2 个槽位（残留冲突数 = 0）')

        # ============================================================
        # M4：报价单 → 交付批次
        # ============================================================
        group('M4：报价单 → 交付批次（行→台展开）')
        st, q = srv.post('/api/quotes', {
            'name': '交付测试单', 'version_id': 1, 'version_name': '基线 v1',
            'items': [
                {'item_no': 1, 'type': '物理机', 'title': '数据库服务器', 'qty': 14,
                 'unit_cents': 100, 'line_cents': 1400, 'machine_id': 1,
                 'arch': '海光(C86/x86)', 'purpose': '数据库', 'role': '主'},
                {'item_no': 2, 'type': '虚拟机', 'title': '4C8G', 'qty': 2,
                 'unit_cents': 10, 'line_cents': 20, 'cpu': 4, 'mem_gb': 8, 'sto_gb': 100},
            ],
        }, role='sales')
        ok(st == 200, '新建报价单返回 200（实际 %s）' % st)
        quote_id = q.get('id')

        # dry_run 不落库
        st, before_dev = srv.get('/api/devices')
        st, dry = srv.post('/api/deliveries', {'quote_id': quote_id, 'dry_run': True,
                                               'target_rack_id': rack_id}, role='sales')
        ok(st == 200, 'dry_run 返回 200（实际 %s）' % st)
        st, after_dev = srv.get('/api/devices')
        eq(len(after_dev), len(before_dev), 'dry_run 后 devices 记录数不变')

        # 正式生成
        st, d = srv.post('/api/deliveries', {'quote_id': quote_id,
                                             'target_rack_id': rack_id}, role='sales')
        ok(st == 200, '生成交付批次返回 200（实际 %s，body=%s）' % (st, str(d)[:200]))
        ok(d.get('device_count') == 14, '1 行 qty=14 → 生成 14 台设备（实际 %r）' % d.get('device_count'))
        devs = d.get('devices') or []
        eq(len(devs), 14, '响应含 14 台设备')
        uids = set(x.get('source_line_uid') for x in devs)
        eq(len(uids), 1, '14 台 source_line_uid 全部相同（同一行共用）')
        eq(list(uids)[0], 'q_%s_1' % quote_id,
           'source_line_uid 格式 = q_<quoteId>_<itemNo>（实际 %r）' % list(uids)[0])
        eq(sorted(x.get('seq_no') for x in devs), list(range(1, 15)),
           'seq_no 恰为 1..14')
        ok(all(x.get('origin') == 'delivery' for x in devs), 'origin 全为 delivery')
        ok(all(x.get('sku_id') for x in devs), 'sku_id 覆盖率 100%')
        ok(all((x.get('plan_snapshot') or {}).get('summary') for x in devs),
           '下游重录字段：规格摘要已带出（机型规格无需重录）')
        ok(all(x.get('arch') for x in devs), '下游重录字段：arch 已带出')
        ok(all(x.get('purpose') for x in devs), '下游重录字段：用途已带出')
        ok(all(x.get('role') for x in devs), '下游重录字段：主备角色已带出')
        ok(all(x.get('rack_id') == rack_id for x in devs), '下游重录字段：机房-机柜-U位已带出')
        # 虚机不占 U 位，不生成物理设备
        ok(all(x.get('origin') == 'delivery' for x in devs), '虚机条目不生成物理设备')

        st, dl = srv.get('/api/deliveries')
        one = [x for x in dl if x.get('id') == d.get('id')][0]
        ok(one.get('quote_version_id') == 1, 'deliveries.quote_version_id == 报价单 version_id')
        eq(scan_price_keys(one.get('snapshot') or {}), [], 'deliveries.snapshot 无价格字段')

        # 幂等
        st, _ = srv.post('/api/deliveries', {'quote_id': quote_id}, role='sales')
        ok(st == 409, '同 quote_id 重复生成返回 409（实际 %s）' % st)

        # 原子性：无部分落库
        st, before_dev = srv.get('/api/devices')
        st, before_units = srv.get('/api/rack_units')
        st, q2 = srv.post('/api/quotes', {
            'name': '冲突测试单', 'version_id': 1,
            'items': [{'item_no': 1, 'type': '物理机', 'title': 'X', 'qty': 40,
                       'unit_cents': 1, 'line_cents': 40, 'machine_id': 1}],
        }, role='sales')
        st, _ = srv.post('/api/deliveries', {'quote_id': q2.get('id'),
                                             'target_rack_id': rack_id}, role='sales')
        ok(st == 409, '空间不足时返回 409（实际 %s）' % st)
        st, after_dev = srv.get('/api/devices')
        st, after_units = srv.get('/api/rack_units')
        eq(len(after_dev), len(before_dev), '冲突时 devices 数量不变（无部分落库）')
        eq(len(after_units), len(before_units), '冲突时 rack_units 数量不变（无部分落库）')

        # ============================================================
        # M3：rackview
        # ============================================================
        group('M3：rackview 2D U 位视图')
        st, rv = srv.get('/api/rackview?rack_id=%s' % rack_id, role='ops')
        ok(st == 200, 'GET /api/rackview 返回 200（实际 %s）' % st)
        slots = rv.get('slots') or []
        eq(len(slots), 84, '42U 机柜 → 84 个半 U 槽位')
        idxs = [s['u_index'] for s in slots]
        eq(idxs, list(range(84)), '槽位索引连续无重复')
        occ = [s for s in slots if s['occupancy'] == 'occupied']
        ok(len(occ) > 0, '存在已占用槽位')
        ok(all(s.get('device') for s in occ), '占用槽位带设备信息')
        ok('conflicts' in rv and 'power' in rv and 'occupancy' in rv,
           'rackview 含 conflicts / power / occupancy')

        # ============================================================
        # M7：上架可行性预校验（只读）
        # ============================================================
        group('M7：上架可行性预校验（只读空间模型）')
        st, before_dev = srv.get('/api/devices')
        st, before_units = srv.get('/api/rack_units')
        st, before_links = srv.get('/api/links')
        st, v = srv.post('/api/space/validate', {
            'rack_id': rack_id,
            'lines': [{'machine_id': 1, 'qty': 2}],
        }, role='ops')
        ok(st == 200, 'POST /api/space/validate 返回 200（实际 %s）' % st)
        for k in ('mode', 'space_data_completeness', 'pass', 'conflicts',
                  'conflict_device_count', 'onboarded_device_count',
                  'u_conflict_rate', 'infeasible_ratio', 'notes'):
            ok(k in v, '响应含字段 %s' % k)
        ok(set(v.get('conflicts', {}).keys()) == {'overlap', 'over_height', 'power_over'},
           '三类冲突数组独立存在')
        ok(v.get('mode') == 'spatial', '空间数据完整（1/1 机柜已录）→ mode=spatial（实际 %r）' % v.get('mode'))
        ok(v.get('onboarded_device_count') == 2, 'onboarded_device_count = 2')
        ok(abs(v.get('u_conflict_rate', -1) - v.get('conflict_device_count', 0) / max(v.get('onboarded_device_count', 1), 1)) < 1e-9,
           'u_conflict_rate = conflict_device_count / onboarded_device_count')
        st, after_dev = srv.get('/api/devices')
        st, after_units = srv.get('/api/rack_units')
        st, after_links = srv.get('/api/links')
        eq(after_dev, before_dev, '预校验后 devices 完全不变（只读）')
        eq(after_units, before_units, '预校验后 rack_units 完全不变（只读）')
        eq(after_links, before_links, '预校验后 links 完全不变（只读）')

        # 完整率 < 80% → 降级为纸面校验
        st, r2 = srv.post('/api/racks', {'room_id': room_id, 'code': 'A-4',
                                         'u_total': 42, 'power_capacity_w': 0,
                                         'row': 1, 'col': 4}, role='sales')
        st, v2 = srv.post('/api/space/validate', {
            'rack_id': rack_id, 'lines': [{'machine_id': 1, 'qty': 1}],
        }, role='ops')
        ok(v2.get('mode') == 'paper',
           '空间完整率 <80%% → mode=paper（实际 %r）' % v2.get('mode'))
        ok(v2.get('pass') is None, '降级时 pass=null，不给出基于空间的通过结论')
        ok(any('纸面' in n for n in (v2.get('notes') or [])), 'notes 明确提示降级为纸面校验')

        # ============================================================
        # M6：脱敏导出 + 采价权 ≠ 发布权
        # ============================================================
        group('M6：脱敏导出与采价反馈')
        st, exp = srv.get('/api/assets/export', role='ops')
        ok(st == 200, 'GET /api/assets/export 返回 200（实际 %s）' % st)
        eq(exp.get('columns'), ['资产编号', '型号', 'SN', '机房', '机柜', 'U位', '状态'],
           '导出列头严格等于 7 列')
        blob = json.dumps(exp, ensure_ascii=False)
        ok('单价' not in blob and '金额' not in blob and '税率' not in blob and '含税' not in blob,
           '导出内容不含任何价格字样')

        # 采价权 ≠ 发布权
        st, pf = srv.post('/api/price_feedback', {'sku_id': 1, 'actual_price_cents': 8000000,
                                                   'source': '供应商报价'}, role='delivery')
        ok(st == 200, 'delivery 提交采价反馈返回 200（实际 %s）' % st)
        eq(scan_price_keys(pf), [], '采价反馈响应不回显库价')
        st, mine = srv.get('/api/price_feedback', role='delivery')
        eq(len(mine), 1, 'delivery 可见自己提交的记录')
        st, others = srv.get('/api/price_feedback', role='ops')
        eq(len(others), 0, 'ops 看不到 delivery 提交的记录（本人可见原则）')
        st, alls = srv.get('/api/price_feedback', role='sales')
        eq(len(alls), 1, 'sales 可见全部采价反馈')
        st, _ = srv.get('/api/price_feedback', role='viewer')
        ok(st == 403, 'viewer 访问采价反馈被拒（实际 %s）' % st)

        # ============================================================
        # M5：双视图（planned 不进运行态）
        # ============================================================
        group('M5：规划态 / 运行态双视图')
        st, all_dev = srv.get('/api/devices')
        st, rt = srv.get('/api/devices?scope=runtime')
        ok(all(d.get('state') in ('installed', 'running') for d in rt),
           'scope=runtime 不含 planned 设备')
        st, pl = srv.get('/api/devices?scope=plan')
        ok(all(d.get('state') in ('planned', 'ordered') for d in pl),
           'scope=plan 只含 planned/ordered')
        eq(len(rt) + len(pl), len(all_dev), 'runtime 与 plan 互斥且并集 = 全部')

        # ============================================================
        # M1.0：备份轮转 + 埋点
        # ============================================================
        group('M1.0：备份轮转与埋点健康度')
        bak = os.path.join(data_dir, 'store.json.bak')
        ok(os.path.isfile(bak), 'save_store 后生成 data/store.json.bak')
        events_file = os.path.join(data_dir, 'events.jsonl')
        ok(os.path.isfile(events_file), '埋点写入 data/events.jsonl')
        health_file = os.path.join(data_dir, 'events.health.json')
        ok(os.path.isfile(health_file), '埋点健康度写入 data/events.health.json')
        with open(health_file, 'r', encoding='utf-8') as f:
            health = json.load(f)
        ok('dropped' in health, 'events.health.json 含 dropped 计数（写失败必须外露）')
        st, h = srv.get('/api/events/health')
        ok(st == 200 and 'dropped' in h, 'GET /api/events/health 返回健康度')

        # 埋点事件名可读回：守护指标（② U 位冲突 / 快照漂移）必须有事件来源，
        # 否则「残留 U 位冲突数 = 0」「快照不一致率 = 0」只是口号，无法采信。
        with open(events_file, 'r', encoding='utf-8') as f:
            ev_names = []
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev_names.append(json.loads(line).get('event_name'))
                except ValueError:
                    pass
        ok('rack_occupancy_conflict' in ev_names,
           '占用冲突已埋点 rack_occupancy_conflict（实际事件: %r）' % sorted(set(ev_names)))
        ok('quote_to_delivery' in ev_names, '报价转交付已埋点 quote_to_delivery')
        ok('validation_block' in ev_names, '上架预校验已埋点 validation_block')
        ok('price_feedback_submit' in ev_names, '采价反馈已埋点 price_feedback_submit')
        ok('snapshot_mismatch' not in ev_names,
           '正常写入路径下不产生 snapshot_mismatch（快照不一致率 = 0）')
        # 快照漂移巡检接口
        st, dr = srv.get('/api/assets/drift')
        ok(st == 200 and dr.get('drift_count') == 0,
           'GET /api/assets/drift 返回 drift_count=0（实际 %r）' % dr.get('drift_count'))

        # 资产侧集合不得冗余价格字段
        st, store = srv.store(), None
        raw = srv.store()
        for coll in ('devices', 'deliveries', 'links', 'rooms', 'racks', 'rack_units'):
            eq(scan_price_keys(raw.get(coll) or []), [],
               '%s 集合内不含任何价格字段' % coll)

        # M0：版本语义双轨
        ok(all('rev_no' not in v for v in raw.get('versions', [])),
           'versions[] 无 rev_no（版本语义不混淆）')
        ok(all('version_id' not in a for a in raw.get('asset_changes', [])),
           'asset_changes[] 无 version_id（版本语义不混淆）')
        # 改位产生 asset_changes 且 rev_no 递增
        st, devs_now = srv.get('/api/devices')
        target = [d for d in devs_now if d.get('sn') == 'SN0001'][0]
        # 改到一段连续空闲位（4 个半 U 槽位 = 2U 设备所需），
        # 动态找而不是写死坐标 —— 写死会随前置用例的数据布局漂移而误报冲突。
        st, rv = srv.get('/api/rackview?rack_id=%s' % rack_id, role='sales')
        free = sorted(s['u_index'] for s in (rv.get('slots') or [])
                      if s.get('occupancy') == 'free')
        free_start = None
        for i in range(len(free) - 3):
            if free[i + 3] - free[i] == 3:
                free_start = free[i] / 2.0
                break
        ok(free_start is not None, '存在 4 个连续空闲半 U 槽位可供改位')
        st, ch = srv.put('/api/devices/%s' % target.get('id'),
                         {'u_start': free_start}, role='sales')
        ok(st == 200, '设备改位返回 200（实际 %s）' % st)
        ok(ch.get('asset_change', {}).get('rev_no', 0) >= 1,
           '改位追加 asset_changes 且 rev_no 递增（实际 %r）' % ch.get('asset_change'))
        raw2 = srv.store()
        ok(raw2['versions'][0].get('is_active') == raw.get('versions', [{}])[0].get('is_active'),
           '改位不影响 versions[].is_active')



def main():
    print('\n' + '=' * 60)
    print('# 后端 API 契约测试')
    try:
        run()
    except Exception as e:
        import traceback
        traceback.print_exc()
        ok(False, '测试执行异常：%s' % e)
    print('\n' + '=' * 60)
    print('结果：%d 通过 / %d 失败（共 %d 项）' % (PASS, FAIL, PASS + FAIL))
    if FAILURES:
        print('失败项：')
        for f in FAILURES:
            print('  - ' + f)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
