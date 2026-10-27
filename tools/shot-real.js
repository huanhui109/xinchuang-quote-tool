// 用 CDP 驱动无头 Edge/Chrome，打开真实应用截图拓扑视图
// 用法: node tools/shot-real.js <输出png> [滚动y] [视口宽] [视口高]
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = process.argv[2] || 'C:/tmp/real-topo.png';
const SCROLL = parseInt(process.argv[3] || '0', 10);
const W = parseInt(process.argv[4] || '1440', 10);
const H = parseInt(process.argv[5] || '900', 10);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_APP = 'http://127.0.0.1:8000/#/configurator';
const PORT = 9333;

function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-cdp-'));
  const edge = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, 'about:blank',
  ], { stdio: 'ignore' });
  try {
    let targets = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try { targets = await getJSON(`http://127.0.0.1:${PORT}/json`); if (targets && targets.length) break; } catch (e) {}
    }
    if (!targets) throw new Error('CDP 端口未就绪');
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pend = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise(res => {
      const i = ++id; pend.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evalJS = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) throw new Error('页面执行出错: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await send('Page.enable');
    await send('Page.navigate', { url: URL_APP });
    await sleep(1200);
    // 切到拓扑视图
    const info = await evalJS(`(function(){
      if (typeof setView !== 'function') return 'no setView';
      setView('topo');
      return {view: (typeof CFG!=='undefined'?CFG.view:'?'), cols: document.querySelectorAll('.cfg > .cfg-col').length,
              picker: !!document.querySelector('.cfg-picker'), board: (function(){var b=document.querySelector('#topoBoard');return b?{w:b.style.width,h:b.style.height,sw:b.scrollWidth,sh:b.scrollHeight}:null})()};
    })()`);
    console.log('页面状态:', JSON.stringify(info));
    // dump .cfg 的真实子树结构，定位嵌套错位
    const tree = await evalJS(`(function(){
      function desc(el){
        if(!el) return 'null';
        var kids=[].map.call(el.children,function(c){return c.tagName.toLowerCase()+'.'+String(c.className).split(' ').join('.')});
        return el.tagName.toLowerCase()+'.'+String(el.className).split(' ').join('.')+' > ['+kids.join(' | ')+']';
      }
      var cfg=document.querySelector('.cfg'); if(!cfg) return 'no .cfg';
      var p=document.querySelector('.cfg-picker');
      var chain=[],e=p; while(e && e!==cfg){chain.push(e.tagName.toLowerCase()+'.'+String(e.className).split(' ').join('.')); e=e.parentElement;}
      return {cfgChildren:[].map.call(cfg.children,function(c){return c.tagName.toLowerCase()+'.'+String(c.className).split(' ').join('.')}),
              pickerChain:chain.join(' < '),
              mainDesc:desc(document.querySelector('.cfg-main'))};
    })()`);
    console.log('DOM 结构:', JSON.stringify(tree, null, 1));
    // 追查 summary-total 去向 + cfg-body 内部嵌套
    const deep = await evalJS(`(function(){
      function kids(el,n){ return el?[].map.call(el.children,function(c){return c.tagName.toLowerCase()+'.'+String(c.className).split(' ').join('.')}).slice(0,n||12).join(' | '):'null'; }
      var main=document.querySelector('.cfg-main');
      var body=main?main.querySelector(':scope > .cfg-body'):null;
      var sum=document.querySelector('#cfgSummary');
      var chain=[],e=sum; while(e && e!==document.body){chain.push(e.tagName.toLowerCase()+'.'+String(e.className).split(' ').join('.')); e=e.parentElement; if(chain.length>8)break;}
      return {mainKids:kids(main), bodyKids:kids(body), summaryChain:chain.reverse().join(' > ')};
    })()`);
    console.log('深层嵌套:', JSON.stringify(deep, null, 1));
    await sleep(500);
    if (SCROLL > 0) { await evalJS(`document.querySelector('.content').scrollTop=${SCROLL}`); await sleep(300); }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
    console.log('已保存:', OUT);
    ws.close();
  } finally { edge.kill(); try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {} }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
