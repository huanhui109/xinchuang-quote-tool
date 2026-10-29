'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
function El(tag){this.tagName=String(tag||'div').toUpperCase();this.children=[];this.style={};this.dataset={};this._attrs={};
 const c=new Set();this.classList={add:x=>c.add(x),remove:x=>c.delete(x),contains:x=>c.has(x),toggle:(x,f)=>{f?c.add(x):c.delete(x)}};
 this.innerHTML='';this.textContent='';this.offsetLeft=0;this.offsetTop=0;this.offsetWidth=196;this.offsetHeight=72;
 this.scrollWidth=1400;this.scrollHeight=900;this.clientWidth=1400;this.clientHeight=900;this.firstChild=null;}
El.prototype.setAttribute=function(k,v){this._attrs[k]=String(v);};
El.prototype.getAttribute=function(k){return (k in this._attrs)?this._attrs[k]:null;};
El.prototype.querySelector=function(s){const k=this.tagName+':'+s;if(!cache.has(k))cache.set(k,new El('div'));return cache.get(k);};
El.prototype.querySelectorAll=function(){return [];};
El.prototype.appendChild=function(c){this.children.push(c);this.firstChild=this.children[0];return c;};
El.prototype.removeChild=function(c){const i=this.children.indexOf(c);if(i>=0)this.children.splice(i,1);this.firstChild=this.children[0]||null;return c;};
El.prototype.remove=function(){};El.prototype.click=function(){};
const cache=new Map();
global.document={body:new El('body'),createElement:t=>new El(t),createElementNS:(n,t)=>new El(t),
 querySelector:s=>{if(!cache.has(s))cache.set(s,new El('div'));return cache.get(s);},
 querySelectorAll:s=>{if(!cache.has(s))cache.set(s,[]);return cache.get(s);}};
const LS={};
global.localStorage={getItem:k=>(k in LS?LS[k]:null),setItem:(k,v)=>{LS[k]=String(v);},removeItem:k=>{delete LS[k];}};
global.location={hash:''};
// 浏览器里 window === globalThis；冒烟测试沿用同一对象，保证 window.X 与全局可见性一致
globalThis.addEventListener=function(){}; globalThis.confirm=()=>true; globalThis.prompt=()=>'测试';
global.window=globalThis;
global.URL=URL; global.Blob=class{constructor(a){this.parts=a;}};
global.URLSearchParams=URLSearchParams;
global.fetch=async()=>{ throw new Error('offline stub'); };  // 触发本地回退分支
vm.runInThisContext(fs.readFileSync('web/arch-graph.js','utf8'),{filename:'arch-graph.js'});
vm.runInThisContext(fs.readFileSync('web/arch-diagram.js','utf8'),{filename:'arch-diagram.js'});
vm.runInThisContext(fs.readFileSync('web/hcl-core.js','utf8'),{filename:'hcl-core.js'});
vm.runInThisContext(fs.readFileSync('web/xlsx-read.js','utf8'),{filename:'xlsx-read.js'});
vm.runInThisContext(fs.readFileSync('web/hcl-view.js','utf8'),{filename:'hcl-view.js'});
vm.runInThisContext(fs.readFileSync('web/ui.js','utf8'),{filename:'ui.js'});
try{
  vm.runInThisContext(fs.readFileSync('web/app.js','utf8'),{filename:'app.js'});
  console.log('[PASS] app.js 顶层执行无异常（离线回退模式）');
}catch(e){ console.log('[FAIL] app.js 顶层异常: '+(e.stack||e)); process.exit(1); }
(async()=>{
  try{
    // 1) 路由：架构梳理
    global.location.hash='#/arch';
    await route();
    console.log('[PASS] 路由 #/arch 渲染完成');
    // 1.5) 在配置台中设置 purpose / role，验证主备显示
    CFG.phys=[{id:'ptest',machineId:S.machines[0].id,qty:1,deploy:'主-数据库',purpose:'数据库',role:'主',group:'数据服务',os:'',hv:''}];
    CFG.vm=[{id:'vtest',cpu:4,mem:8,sto:100,qty:1,deploy:'备-Web',purpose:'Web',role:'备',group:'应用服务'}];
    global.location.hash='#/configurator'; await route();
    const cfgHtml=String(document.querySelector('#content').innerHTML||'');
    if(cfgHtml.indexOf('purposeRegistryList')<0) throw new Error('配置台缺少用途候选列表');
    if(cfgHtml.indexOf('value="主"')<0||cfgHtml.indexOf('value="备"')<0) throw new Error('配置台缺少主/备角色选项');
    console.log('[PASS] 配置台渲染 purpose + 主备角色下拉');
    // 2) 路由：架构图（当前已隐藏，路由应给出友好提示）
    global.location.hash='#/arch-diagram';
    await route();
    const adHtml=String(document.querySelector('#content').innerHTML||'');
    if(adHtml.indexOf('暂未启用')<0 && adHtml.indexOf('打开架构图')<0) throw new Error('架构图路由未给出预期提示');
    console.log('[PASS] 路由 #/arch-diagram 已隐藏/降级');
    // 功能开关为 true 时才跑完整架构图链路（当前 false，以下跳过但保留代码）
    if(typeof FEATURES !== 'undefined' && FEATURES && FEATURES.archDiagram){
      const st=ArchDiagramView.getState();
      console.log('[INFO] 图节点数(空清单场景)='+(st.graph?st.graph.nodes.length:'n/a')+'  xml='+(st.xml?'已生成(占位)':'无'));
      const MID=S.machines.map(m=>m.id);
      CFG.phys=[{id:'a',machineId:MID[0],qty:2,deploy:'交易网关'},{id:'b',machineId:MID[2],qty:1,deploy:'Oracle数据库'}];
      CFG.vm=[{id:'c',cpu:8,mem:16,sto:200,qty:4,deploy:'Redis缓存'}];
      CFG.links=[['p_a_1','p_b_1'],['p_a_1','v_c']];
      ArchDiagramView.regenerate(true);
      const st2=ArchDiagramView.getState();
      console.log('[PASS] 离线模式下自动布局节点数='+st2.graph.nodes.length+' 连线='+st2.graph.edges.length);
      await api('PUT','/api/arch/diagram',{xml:st2.xml,source:'drawio'});
      const back=await api('GET','/api/arch/diagram');
      console.log('[PASS] 本地回退保存/读取 OK, has_xml='+back.has_xml);
      const cfgRet=await api('GET','/api/arch/config');
      console.log('[PASS] 本地回退 /api/arch/config OK, embedUrl='+cfgRet.embedUrl);
      await api('DELETE','/api/arch/diagram');
      const back2=await api('GET','/api/arch/diagram');
      console.log('[PASS] 本地回退 DELETE OK, has_xml='+back2.has_xml);
    }
    // 4.5) 架构梳理页可编辑 purpose 与独立归入分组下拉
    global.location.hash='#/arch'; await route();
    const archHtml=String(document.querySelector('#content').innerHTML||'');
    if(archHtml.indexOf('purposeRegistryList')<0) throw new Error('架构梳理页缺少用途候选列表');
    if(archHtml.indexOf('archChPurpose')<0) throw new Error('架构梳理页缺少用途编辑事件');
    if(archHtml.indexOf('archChGroup')<0) throw new Error('架构梳理页缺少归入分组事件');
    if(archHtml.indexOf('归入分组')<0) throw new Error('架构梳理页缺少「归入分组」列');
    console.log('[PASS] 架构梳理页渲染 purpose 编辑 + 归入分组下拉');
    // 5) 其余路由回归
    for(const h of ['#/dashboard','#/lib/machines','#/lib/parts','#/lib/vm','#/lib/versions','#/configurator','#/hw-parse','#/quotes','#/data','#/settings','#/about']){
      global.location.hash=h; await route();
      const html=String(document.querySelector('#content').innerHTML||'');
      if(html.indexOf('加载失败')>=0) throw new Error('路由 '+h+' 渲染失败：'+html.slice(0,200));
      if(html.length<20) throw new Error('路由 '+h+' 渲染内容为空');
    }
    console.log('[PASS] 全部菜单路由渲染无异常');
    // 5.5) 资产侧 4 个新路由：必须渲染出资产侧视图，不能是回落的概览页
    //      （ROUTES 里没注册的 key 会回落到 viewDashboard，同样渲染出几千字符 —— 那是假通过）
    const assetRoutes=[
      ['#/assets/devices',['设备台账','资产编号']],
      ['#/assets/space',['机房','机柜']],
      ['#/assets/rackview',['U 位','机柜']],
      ['#/assets/deliveries',['交付批次','报价单']],
    ];
    for(const routePair of assetRoutes){
      global.location.hash=routePair[0]; await route();
      const html=String(document.querySelector('#content').innerHTML||'');
      if(html.indexOf('加载失败')>=0) throw new Error('资产侧路由 '+routePair[0]+' 渲染失败');
      const miss=routePair[1].filter(k=>html.indexOf(k)<0);
      if(miss.length) throw new Error('资产侧路由 '+routePair[0]+' 未命中特征词 '+miss.join('/')+'（疑似回落到概览页）');
    }
    console.log('[PASS] 资产侧 4 路由渲染出各自视图（未回落概览页）');
    // 5.6) 角色回归：概览按角色分叉 + 角色来回切换后数据能恢复
    await setRole('ops');
    global.location.hash='#/dashboard'; await route();
    const opsHtml=String(document.querySelector('#content').innerHTML||'');
    if(opsHtml.indexOf('加载失败')>=0) throw new Error('ops 概览渲染失败');
    if(opsHtml.indexOf('设备总数')<0) throw new Error('ops 概览未分叉为资产侧视图（仍显示售前仪表盘）');
    await setRole('sales');
    if(!S.machines.length) throw new Error('角色切回 sales 后单价库数据未恢复（loadLib 缓存命中未回写 S）');
    global.location.hash='#/dashboard'; await route();
    const salesHtml=String(document.querySelector('#content').innerHTML||'');
    if(salesHtml.indexOf('设备总数')>=0) throw new Error('sales 概览未走售前仪表盘（被资产侧视图污染）');
    console.log('[PASS] 角色分叉：ops 概览走资产侧；切回 sales 后单价库数据与售前仪表盘均恢复');
    // 6) 硬件清单解析：离线模式下解析真实清单并应用到配置台
    const fx=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures','sample-wide-spec.json'),'utf8'));
    const pr=HclCore.parseWorkbook(fx,{machines:S.machines});
    if(!pr.ok) throw new Error('清单解析失败：'+pr.errorMsg);
    console.log('[PASS] 离线解析清单：'+pr.rows.length+' 行 / 默认已选 '+pr.selections.length+' 项 / 模板 '+pr.combos.length+' 个');
    await api('PUT','/api/hcl/state',{combos:pr.combos,selections:pr.selections,imports:[]});
    const hst=await api('GET','/api/hcl/state');
    console.log('[PASS] 本地回退 /api/hcl/state 保存读取 OK：模板 '+hst.combos.length+' / 已选 '+hst.selections.length);
    // 7) 重复导入不产生重复（去重键与是否已入库为机型无关）
    const pr2=HclCore.parseWorkbook(fx,{machines:S.machines});
    const mg=HclCore.mergeSelections(pr.selections,pr2.selections,{});
    if(mg.added!==0||mg.removed!==0) throw new Error('重复导入产生了新增/删除行：added='+mg.added+' removed='+mg.removed);
    console.log('[PASS] 重复导入：新增 '+mg.added+' / 更新 '+mg.updated+' / 移除 '+mg.removed+'（应为 0 新增 0 移除）');
    const before=S.machines.length;
    const out=await HwParseBridge.apply(pr.selections,{materialize:true,source:pr.file});
    await loadLib();
    console.log('[PASS] 应用至配置台：新增行 '+out.added+' / 新建机型 '+out.created+' / 跳过 '+out.skipped
      +'（单价库机型 '+before+' → '+S.machines.length+'）');
    if(CFG.phys.length+CFG.vm.length < pr.selections.length) throw new Error('应用后配置行不足');
    // 应用后应携带 purpose / group，且 purpose 进入共享注册表
    const firstPhys=CFG.phys.find(l=>l.purpose);
    if(!firstPhys||!firstPhys.purpose) throw new Error('应用后物理机行缺少 purpose');
    if(!firstPhys.group) throw new Error('应用后物理机行缺少 group');
    const reg=typeof purposeRegistry!=='undefined'?purposeRegistry():[];
    if(!reg.includes(firstPhys.purpose)) throw new Error('purpose 未进入共享注册表：'+firstPhys.purpose);
    console.log('[PASS] 应用至配置台携带 purpose/group：'+firstPhys.purpose+' / '+firstPhys.group);
    // 入库后再次导入，仍不应新增
    const pr3=HclCore.parseWorkbook(fx,{machines:S.machines});
    const mg2=HclCore.mergeSelections(pr.selections,pr3.selections,{});
    if(mg2.added!==0) throw new Error('入库后重复导入产生了新增行：'+mg2.added);
    console.log('[PASS] 入库后重复导入仍不新增（0 新增 / '+mg2.updated+' 更新）');
    await api('DELETE','/api/hcl/state');
    const hst2=await api('GET','/api/hcl/state');
    console.log('[PASS] 本地回退 /api/hcl/state 清空 OK：'+hst2.combos.length+' 模板');
    // 8) 解析页面：注入工作簿后应渲染出明细/模板/已选三个页签
    global.location.hash='#/hw-parse'; await route();
    const emptyHtml=String(document.querySelector('#content').innerHTML||'');
    if(emptyHtml.indexOf('硬件配置清单解析')<0) throw new Error('解析页面未渲染出标题');
    await HwParseView.loadWorkbook(fx,'local');
    const html2=String(document.querySelector('#content').innerHTML||'');
    ['明细校对','规格模板沉淀','默认已选配置','重新解析'].forEach(k=>{
      if(html2.indexOf(k)<0) throw new Error('解析结果页面缺少：'+k);
    });
    const stv=HwParseView.getState();
    console.log('[PASS] 解析页面渲染：明细/模板/已选三个页签齐全，已选 '+stv.selections.length+' 项 / 模板 '+stv.combos.length+' 个');
    // 9) 手工改数量后标记 manual，重导入应保留人工值
    const first=stv.selections[0];
    HwParseBridge && first && (first.qty=99, first.manual=true);
    const mg3=HclCore.mergeSelections([first],pr2.selections,{conflictPolicy:'keep-manual'});
    console.log('[PASS] 冲突策略：保留人工值 qty='+mg3.items[0].qty+'（人工=99 / 清单=2）冲突数='+mg3.conflict);
    if(first && mg3.items[0].qty!==99) throw new Error('人工值未被保留');
    // 10) 「未分组」用途的人工补录：hwSetPurpose 应刷新归一化分组并重绘
    const st0=HwParseView.getState();
    const rows=st0.result.rows||[];
    const unBefore=rows.filter(r=>!r.purposeNorm||r.purposeNorm==='未分组').length;
    const target=rows.filter(r=>!r.purposeNorm||r.purposeNorm==='未分组')[0]
              || Object.assign(rows[0],{purpose:'某某专有名词xyz',purposeNorm:'未分组'});
    global.hwSetPurpose(target.id,'数据服务');
    await new Promise(r=>setTimeout(r,0));
    if(target.purposeNorm!=='数据服务') throw new Error('hwSetPurpose 未刷新归一化分组，实际='+target.purposeNorm);
    const unAfter=(HwParseView.getState().result.rows||[]).filter(r=>!r.purposeNorm||r.purposeNorm==='未分组').length;
    if(unAfter!==unBefore-1) throw new Error('未分组计数未减少：'+unBefore+' → '+unAfter);
    const html3=String(document.querySelector('#content').innerHTML||'');
    if(html3.indexOf('归入分组')<0) throw new Error('明细表缺少「归入分组」快捷下拉');
    if(html3.indexOf('只看未分组用途')<0) throw new Error('缺少「只看未分组用途」筛选按钮');
    if(html3.indexOf('用途未分组')<0) throw new Error('统计卡缺少「用途未分组」');
    const optMatch=html3.match(/<option value="([^"]*)"[^>]*>数据服务<\/option>/);
    if(!optMatch) throw new Error('「归入分组」下拉缺少「数据服务」选项');
    if(!optMatch[1]) throw new Error('下拉选项 value 为空串，会导致 onchange 取不到所选分组（这是原 bug 根因）');
    console.log('[PASS] 未分组补录：hwSetPurpose 后归一化=数据服务，未分组 '+unBefore+' → '+unAfter+'，UI 含归类下拉/筛选/统计卡');
    // 11) 已选配置侧补录用途
    const s0=HwParseView.getState().selections[0];
    global.hwSelSetPurpose(s0.id,'基础设施');
    await new Promise(r=>setTimeout(r,0));
    const s1=HwParseView.getState().selections.filter(x=>x.id===s0.id)[0];
    if(!s1||s1.purposeNorm!=='基础设施') throw new Error('已选配置补录用途失败：'+JSON.stringify(s1&&s1.purposeNorm));
    if(s1.selKey!==s0.selKey) throw new Error('已选配置改用途不应漂移 selKey（会导致重导入重复）');
    console.log('[PASS] 已选配置补录用途：purposeNorm=基础设施，selKey 保持稳定不漂移');
  }catch(e){ console.log('[FAIL] 交互异常: '+(e.stack||e)); process.exit(1); }
})();
