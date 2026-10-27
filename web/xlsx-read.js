/* 浏览器端 xlsx / csv 读取
 * 用于「后端不可用」场景的兜底：优先调用后端 /api/hcl/parse，
 * 失败且浏览器支持 DecompressionStream 时本地自解 zip 解析 xlsx。
 * 仅在浏览器环境加载（依赖 FileReader / Blob / DOMParser）。
 */
;(function (root) {
  'use strict';

  var MAX_UNZIP_BYTES = 32 * 1024 * 1024;
  var MAX_ENTRIES = 200;

  function abToBase64(buf) {
    var bytes = new Uint8Array(buf), s = '', chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return root.btoa(s);
  }

  // ---------------- ZIP 读取（仅提取需要的条目） ----------------
  function findEocd(dv, len) {
    var min = Math.max(0, len - 66000);
    for (var i = len - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  }
  function readEntries(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var len = bytes.length;
    var eocd = findEocd(dv, len);
    if (eocd < 0) throw new Error('不是有效的 xlsx（zip 结构损坏）');
    var count = dv.getUint16(eocd + 10, true);
    var cdOff = dv.getUint32(eocd + 16, true);
    if (count > MAX_ENTRIES) throw new Error('压缩包条目过多（>' + MAX_ENTRIES + '），疑似异常文件');
    var out = {}, p = cdOff, n = 0;
    while (n < count && p + 46 <= len) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var rawSize = dv.getUint32(p + 24, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOff = dv.getUint32(p + 42, true);
      var name = '';
      for (var k = 0; k < nameLen; k++) name += String.fromCharCode(bytes[p + 46 + k]);
      out[name] = { method: method, compSize: compSize, rawSize: rawSize, localOff: localOff };
      p += 46 + nameLen + extraLen + commentLen;
      n++;
    }
    return { entries: out, bytes: bytes, dv: dv };
  }
  function entryBytes(zip, ent) {
    var bytes = zip.bytes, dv = zip.dv;
    if (dv.getUint32(ent.localOff, true) !== 0x04034b50) throw new Error('zip 局部头损坏');
    var nameLen = dv.getUint16(ent.localOff + 26, true);
    var extraLen = dv.getUint16(ent.localOff + 28, true);
    var start = ent.localOff + 30 + nameLen + extraLen;
    if (ent.rawSize > MAX_UNZIP_BYTES) throw new Error('解压后内容过大（>' + Math.round(MAX_UNZIP_BYTES / 1048576) + 'MB）');
    if (ent.method === 0) return bytes.subarray(start, start + ent.compSize);
    if (ent.method !== 8) throw new Error('不支持的压缩方式（' + ent.method + '）');
    throw new Error('需要流式解压');
  }
  async function inflate(bytes, budget) {
    if (typeof root.DecompressionStream !== 'function') throw new Error('当前浏览器不支持 DecompressionStream');
    var ds = new root.DecompressionStream('deflate-raw');
    var blob = new Blob([bytes]);
    // @ts-ignore
    var stream = blob.stream().pipeThrough(ds);
    var rd = new Response(stream).getReader();
    var chunks = [], total = 0;
    // C-9：边解压边计数，超过上限立即中断。
    // 仅校验 zip 头里声明的 rawSize 不够——攻击者可伪造该字段（zip bomb）。
    for (;;) {
      var r = await rd.read();
      if (r.done) break;
      total += r.value.length;
      if (budget && total > budget) {
        try { await rd.cancel(); } catch (e) { /* ignore */ }
        throw new Error('解压后内容超过上限（>' + Math.round(budget / 1048576) + 'MB），疑似压缩炸弹，已中止');
      }
      chunks.push(r.value);
    }
    var out = new Uint8Array(total), off = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
    return out;
  }
  async function entryText(zip, name) {
    var ent = zip.entries[name];
    if (!ent) return null;
    if (ent.method === 0) return new TextDecoder('utf-8').decode(entryBytes(zip, ent));
    var raw = await inflate(zip.bytes.subarray.apply(zip.bytes, sliceRange(zip, ent)), entryBudget(ent));
    if (raw.length > MAX_UNZIP_BYTES) throw new Error('解压后内容过大（>' + Math.round(MAX_UNZIP_BYTES / 1048576) + 'MB）');
    return new TextDecoder('utf-8').decode(raw);
  }
  /** 单条目解压预算：不超过声明值与全局上限的较小者，再留 1% 余量给压缩头差异 */
  function entryBudget(ent) {
    var declared = (ent && ent.rawSize > 0) ? ent.rawSize : MAX_UNZIP_BYTES;
    return Math.min(MAX_UNZIP_BYTES, Math.ceil(declared * 1.01)) || MAX_UNZIP_BYTES;
  }
  function sliceRange(zip, ent) {
    var dv = zip.dv;
    var nameLen = dv.getUint16(ent.localOff + 26, true);
    var extraLen = dv.getUint16(ent.localOff + 28, true);
    var start = ent.localOff + 30 + nameLen + extraLen;
    return [start, start + ent.compSize];
  }

  // ---------------- xlsx 解析 ----------------
  function colIndex(ref) {
    var n = 0;
    for (var i = 0; i < ref.length; i++) {
      var ch = ref.charCodeAt(i);
      if (ch >= 65 && ch <= 90) n = n * 26 + (ch - 64);
      else if (ch >= 97 && ch <= 122) n = n * 26 + (ch - 96);
      else break;
    }
    return Math.max(0, n - 1);
  }
  function parseXml(text) {
    return new DOMParser().parseFromString(text, 'application/xml');
  }
  function xmlNodes(doc, tag) {
    return Array.prototype.slice.call(doc.getElementsByTagName(tag));
  }
  function parseSheetXml(text, shared, maxRows, maxCols) {
    var doc = parseXml(text);
    var data = doc.getElementsByTagName('sheetData')[0];
    if (!data) return { rows: [], truncated: false };
    var tmp = {}, maxR = 0, truncated = false;
    var rowsEl = data.getElementsByTagName('row');
    for (var i = 0; i < rowsEl.length; i++) {
      var rowEl = rowsEl[i];
      var ridx = parseInt(rowEl.getAttribute('r') || (i + 1), 10);
      if (ridx > maxRows) { truncated = true; continue; }
      var cells = {}, maxc = -1;
      var cs = rowEl.getElementsByTagName('c');
      for (var j = 0; j < cs.length; j++) {
        var c = cs[j];
        var idx = colIndex(c.getAttribute('r') || '');
        if (idx >= maxCols) continue;
        var t = c.getAttribute('t'), v = null;
        var vEl = c.getElementsByTagName('v')[0];
        if (t === 's' && vEl) { var k = parseInt(vEl.textContent || '0', 10); v = shared[k]; }
        else if (t === 'inlineStr') {
          var ts = c.getElementsByTagName('t'), s = '';
          for (var q = 0; q < ts.length; q++) s += ts[q].textContent || '';
          v = s;
        } else if (vEl) {
          v = vEl.textContent;
          if (t !== 'str' && t !== 'e' && v !== null && v !== '' && !isNaN(parseFloat(v)) && /^-?[\d.eE+]+$/.test(v)) v = parseFloat(v);
        }
        if (v === null || v === undefined || v === '') continue;
        cells[idx] = v;
        if (idx > maxc) maxc = idx;
      }
      if (maxc < 0 && !Object.keys(cells).length) continue;
      tmp[ridx] = cells;
      if (ridx > maxR) maxR = ridx;
    }
    var rows = [], limit = Math.min(maxR, maxRows);
    for (var r = 1; r <= limit; r++) {
      var one = tmp[r] || {};
      var arr = [], keys = Object.keys(one), mc = keys.length ? Math.max.apply(null, keys.map(Number)) : -1;
      for (var x = 0; x <= mc; x++) arr.push(one[x] === undefined ? null : one[x]);
      rows.push(arr);
    }
    return { rows: rows, truncated: truncated };
  }
  async function readXlsxLocal(buffer, opts) {
    opts = opts || {};
    var zip = readEntries(new Uint8Array(buffer));
    var shared = [];
    if (zip.entries['xl/sharedStrings.xml']) {
      var ssDoc = parseXml(await entryText(zip, 'xl/sharedStrings.xml'));
      var sis = ssDoc.getElementsByTagName('si');
      for (var i = 0; i < sis.length; i++) {
        var ts = sis[i].getElementsByTagName('t'), s = '';
        for (var j = 0; j < ts.length; j++) s += ts[j].textContent || '';
        shared.push(s);
      }
    }
    var order = [];
    try {
      var wbDoc = parseXml(await entryText(zip, 'xl/workbook.xml'));
      var rels = {};
      if (zip.entries['xl/_rels/workbook.xml.rels']) {
        var relDoc = parseXml(await entryText(zip, 'xl/_rels/workbook.xml.rels'));
        var rl = xmlNodes(relDoc, 'Relationship');
        rl.forEach(function (el) { rels[el.getAttribute('Id')] = el.getAttribute('Target'); });
      }
      var shs = wbDoc.getElementsByTagName('sheet');
      for (var s = 0; s < shs.length; s++) {
        var target = rels[shs[s].getAttribute('r:id') || shs[s].getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')] || '';
        target = String(target).replace(/^\//, '');
        if (target && target.indexOf('xl/') !== 0) target = 'xl/' + target;
        order.push({ name: shs[s].getAttribute('name') || ('Sheet' + (s + 1)), target: target });
      }
    } catch (e) { order = []; }
    if (!order.length) {
      Object.keys(zip.entries).filter(function (n) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(n); })
        .forEach(function (n, i) { order.push({ name: 'Sheet' + (i + 1), target: n }); });
    }
    var sheets = [];
    for (var k = 0; k < Math.min(order.length, opts.maxSheets || 8); k++) {
      var o = order[k];
      if (!o.target || !zip.entries[o.target]) continue;
      try {
        var parsed = parseSheetXml(await entryText(zip, o.target), shared, opts.maxRows || 5000, opts.maxCols || 60);
        sheets.push({ name: o.name, rows: parsed.rows, truncated: parsed.truncated });
      } catch (e) { /* 单个 sheet 失败不影响整体 */ }
    }
    if (!sheets.length) throw new Error('未在 xlsx 中找到任何工作表');
    return sheets;
  }

  // ---------------- CSV ----------------
  function parseCsvText(text, maxRows, maxCols) {
    var rows = [], row = [], cur = '', q = false;
    text = text.replace(/^\uFEFF/, '');
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; if (rows.length >= maxRows) break; }
      else if (ch === '\r') { /* skip */ }
      else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.map(function (r) { return r.slice(0, maxCols); });
  }

  // ---------------- 对外入口 ----------------
  /**
   * @param {File} file
   * @param {Object} opts { maxUploadBytes, maxRows, maxCols, maxSheets, useBackend }
   * @returns {Promise<{name, kind, sheets, via}>}
   */
  async function readFile(file, opts) {
    opts = opts || {};
    var name = file.name || '';
    var ext = (name.split('.').pop() || '').toLowerCase();
    if (ext === 'xls' || ext === 'xlt') throw new Error('不支持 .xls（旧二进制格式），请在 Excel 中另存为 .xlsx 后重试');
    if (file.size > (opts.maxUploadBytes || 8 * 1024 * 1024)) {
      throw new Error('文件超过 ' + Math.round((opts.maxUploadBytes || 8 * 1024 * 1024) / 1048576) + 'MB 上限');
    }
    var buf = await file.arrayBuffer();
    if (buf.byteLength === 0) throw new Error('文件内容为空');

    // 1) 优先后端
    if (opts.useBackend !== false) {
      try {
        var res = await fetch('/api/hcl/parse', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: name, content: abToBase64(buf) }),
        });
        if (res.ok) {
          var obj = await res.json();
          return { name: name, kind: obj.kind, sheets: obj.sheets, via: 'backend' };
        }
      } catch (e) { /* 落到本地解析 */ }
    }

    // 2) 本地解析
    if (ext === 'csv' || ext === 'txt') {
      var text = await file.text();
      return { name: name, kind: 'csv', sheets: [{ name: 'CSV', rows: parseCsvText(text, opts.maxRows || 5000, opts.maxCols || 60), truncated: false }], via: 'local' };
    }
    try {
      var sheets = await readXlsxLocal(buf, opts);
      return { name: name, kind: 'xlsx', sheets: sheets, via: 'local' };
    } catch (e) {
      if (String(e.message || '').indexOf('zip') >= 0 || String(e.message || '').indexOf('DecompressionStream') >= 0
          || String(e.message || '').indexOf('压缩炸弹') >= 0 || String(e.message || '').indexOf('上限') >= 0) {
        throw new Error('无法在本机解析该 xlsx（' + e.message + '）。请启动 python server.py 后重试，或将文件另存为 CSV。');
      }
      throw e;
    }
  }

  var API = {
    readFile: readFile, readXlsxLocal: readXlsxLocal, parseCsvText: parseCsvText,
    parseSheetXml: parseSheetXml, colIndex: colIndex, abToBase64: abToBase64, readEntries: readEntries,
    inflate: inflate, entryBudget: entryBudget, MAX_UNZIP_BYTES: MAX_UNZIP_BYTES,
  };
  if (typeof module === 'object' && module.exports) module.exports = API;
  root.XlsxRead = API;
})(typeof self !== 'undefined' ? self : this);
