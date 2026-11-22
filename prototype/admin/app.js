/* 内容管理低保真：虚构角色、草稿与版本仅保存在当前页面内存。 */
(() => {
  'use strict';
  const F = window.BABYPLAN_FIXTURE;
  const $ = s => document.querySelector(s);
  const clone = value => structuredClone(value);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const W = F.contentWorkflow;
  const original = F.day.items.find(i => i.id === W.draftItemId);
  const labels = {draft:'草稿',in_review:'待审核',changes_requested:'需修改',ready:'可发布',publishing:'发布中',published:'已发布（模拟）',failed:'发布失败',withdrawal_confirmation:'撤回确认'};
  const roleNames = {demo_editor:'内容编辑',demo_reviewer:'内容审核',demo_publisher:'内容发布',demo_viewer:'只读查看',none:'无管理权限'};
  const routes = {c01:'角色与连接',c02:'内容库',c03:'草稿编辑',c04:'审核',c05:'发布',c06:'版本与撤回'};
  const names = {expanded_admin_draft:'草稿编辑',expanded_admin_review:'审核退回',expanded_admin_forbidden:'无发布权限',expanded_publish_failed:'发布失败',expanded_publish_success:'发布成功',expanded_withdraw:'撤回确认',loading:'加载中',error:'加载失败',empty:'内容库为空',offline:'断网',denied:'无管理权限'};
  const fields = {
    title:'标题',age:'适龄档（候选）',materials:'材料（每行一项）',steps:'步骤（每行一项）',
    opening:'开始时怎样说',whenJoins:'宝宝跟着玩',whenWatches:'宝宝只是看',whenStops:'宝宝想停',
    english:'英语（可选；每行：英文 | 中文意思 | 时机 | 动作）',safety:'安全提示',sources:'来源标题（每行一项）',bookId:'关联书目（可选）'
  };
  let s, dialog = null, returnFocus = null, token = 0;
  const b = (text, action, attrs='', primary=false) => `<button type="button" data-action="${action}" ${attrs} class="${primary?'primary':''}">${text}</button>`;
  const tag = text => `<span class="tag">${esc(text)}</span>`;
  const intro = (title, text='') => `<p class="eyebrow">${s.route.toUpperCase()} · 扩展原型（未合同化）</p><h1>${esc(title)}</h1>${text?`<p>${esc(text)}</p>`:''}`;
  const permission = action => Boolean(W.permissions[s.role]?.includes(action));
  const canRead = () => s.role !== 'none';
  const disabled = action => !permission(action) || s.busy ? 'disabled' : '';
  const dirty = () => JSON.stringify(s.buffer) !== JSON.stringify(s.saved);
  const lines = text => String(text||'').split('\n').map(t=>t.trim()).filter(Boolean);
  function buffer(item) {
    return {title:item.title,age:'18～23月',materials:item.materials.join('\n'),steps:item.steps.join('\n'),...item.dialogue,
      english:(item.english||[]).map(e=>[e.line,e.meaningZh,e.when,e.action].join(' | ')).join('\n'),safety:item.safety,
      sources:(item.sources||[]).map(v=>v.title).join('\n'),bookId:item.bookId||''};
  }
  function itemFromBuffer(data) {
    return {...clone(W.draftContent),title:data.title.trim(),materials:lines(data.materials),steps:lines(data.steps),
      dialogue:Object.fromEntries(['opening','whenJoins','whenWatches','whenStops'].map(k=>[k,data[k].trim()])),
      english:lines(data.english).map(line=>{const [text,meaningZh,when,action]=line.split('|').map(t=>t.trim());return {line:text,meaningZh,when,action};}),
      safety:data.safety.trim(),sources:lines(data.sources).map(title=>({kind:'design_sample',title})),bookId:data.bookId||undefined};
  }
  function boot(id='expanded_admin_draft') {
    token++; if ($('#modal').open) $('#modal').close(); dialog=null;
    const sample = F.scenarios.find(c=>c.id===id);
    const base = {...clone(F.initialState),...clone(sample?.overrides||{})};
    const live = base.visiblePublishedVersion;
    const content = live===2?clone(W.draftContent):clone(original);
    const phase = base.workflowState;
    const data = buffer(W.draftContent);
    s = {scenario:id,role:base.adminRole,route:phase==='changes_requested'?'c04':phase==='published'||phase==='failed'?'c05':phase==='withdrawal_confirmation'?'c06':'c03',
      workflow:phase,buffer:clone(data),saved:clone(data),active:live,base:phase==='published'?live:W.publishedVersion,draftVersion:phase==='published'?live+1:W.draftVersion,
      reviewed:['ready','failed'].includes(phase),versions:[{version:live,item:content,age:'18～23月',status:'active',by:'发布角色（虚构）',note:live===2?'场景中的已发布示例':'原始演示版本',time:'2026-11-11 15:00（固定时钟）'}],
      note:'',reason:phase==='changes_requested'?W.reviewReason:'',checks:{},filter:'all',kind:'all',request:'ready',offline:id==='offline',busy:false,notice:'',errors:{},conflict:null,revision:1};
    if(id==='expanded_admin_forbidden') {s.route='c05';s.reviewed=true;}
    if(id==='loading'||id==='error'||id==='empty') {s.route='c02';s.request=id;}
    if(id==='denied') {s.role='none';s.route='c01';}
    if(id==='offline') s.route='c02';
    $('#scenario').value=id; $('#role').value=s.role; $('#offline').checked=s.offline; $('#failure').checked=false;
    $('#expectation').textContent=sample?.expected||'额外本地模拟状态；不改变真实内容库。';
    history.replaceState({route:s.route},'',`#${s.route}`);render();
    if(phase==='withdrawal_confirmation') open('withdraw');
  }
  function say(text){s.notice=text;$('#announcement').textContent=text;}
  function nav(route, force=false) {
    if(s.busy)return;
    if(!force&&dirty()){open('discard',{next:()=>nav(route,true)});return;}
    s.route=route;s.errors={};s.notice='';history.pushState({route},'',`#${route}`);render();$('#screen').focus({preventScroll:true});
  }
  function deny(action, online=false) {
    if(!permission(action)){say('当前账号没有这项权限。请切换候选角色进行设计评审。');render();return true;}
    if(s.busy)return true;
    if(online&&s.offline){say('当前没有网络。请联网后重试；线上版本没有变化。');render();return true;}
    return false;
  }
  function published(){return s.versions.find(v=>v.version===s.active&&v.status==='active');}
  function details(item){
    const parts=[['准备什么',item.materials?.join('；')||'不用道具'],['怎么玩',item.steps?.join('\n')],...Object.entries(item.dialogue||{}).map(([k,v])=>[fields[k],v]),['英语互动',(item.english||[]).map(e=>`${e.line} · ${e.meaningZh} · ${e.when} · ${e.action}`).join('\n')],['安全提示',item.safety],['来源',(item.sources||[]).map(v=>v.title).join('\n')]];
    return parts.filter(([,v])=>v).map(([k,v])=>`<section><h3>${esc(k)}</h3><p class="preserve">${esc(v)}</p></section>`).join('');
  }
  function difference(){
    const before=buffer(published()?.item||original);
    return `<div class="comparison"><article class="card"><h2>当前活跃版本 v${s.active??'—'}</h2>${Object.keys(fields).map(k=>`<h3>${esc(fields[k])}</h3><p class="preserve">${esc(before[k]||'未提供')}</p>`).join('')}</article><article class="card"><h2>草稿 v${s.draftVersion}</h2>${Object.keys(fields).map(k=>`<h3>${esc(fields[k])}${before[k]!==s.saved[k]?' · 已修改':''}</h3><p class="preserve">${esc(s.saved[k]||'未提供')}</p>`).join('')}</article></div>`;
  }
  function rolePage(){return intro('角色与连接','已连接虚构内容账号。登录、加入与账号恢复方式待定；BabyPlan暂不提供公开注册。')+`<div class="banner"><p>当前角色：${esc(roleNames[s.role])}（候选）</p><p>${canRead()?'可以查看演示内容；操作权限按角色分别开放。':'当前账号没有管理区权限。'}</p></div><h2>候选权限分工</h2>${Object.entries(roleNames).filter(([k])=>k!=='none').map(([k,v])=>`<article class="card"><h3>${esc(v)}</h3><p>${esc(({demo_editor:'保存草稿、提交审核',demo_reviewer:'审核、退回修改',demo_publisher:'发布、撤回',demo_viewer:'仅查看'})[k])}</p></article>`).join('')}<p>角色切换位于独立审阅面板；它不是产品中的提权入口。真实角色与分权仍待确认。</p>${b('查看内容库','nav','data-route="c02"')}`;}
  function library(){
    if(s.request!=='ready'){
      const texts={loading:'正在加载内容库…',error:'没有加载成功。请检查网络后重试。',empty:'没有符合筛选的内容。'};
      return intro('内容库')+`<div class="banner" ${s.request==='loading'?'aria-busy="true"':''}><p>${texts[s.request]}</p>${b(s.request==='loading'?'模拟加载完成':'重试（模拟）','recover')}</div>`;
    }
    let cards='';
    if(s.kind!=='books'){
      if(s.filter==='all'||s.filter===s.workflow)cards+=`<article class="card"><h2>${esc(s.saved.title)}</h2>${tag(labels[s.workflow])}${tag(`草稿 v${s.draftVersion}`)}<p>18～23月 · 原创设计样本 · 最后修改：内容编辑（虚构）</p><p>草稿不会进入家庭安排；审核并发布后才会形成可用版本。</p>${b('打开草稿','nav','data-route="c03"')}${b('查看审核','nav','data-route="c04"')}</article>`;
      for(const v of s.versions){const status=v.status==='withdrawn'?'withdrawn':'published';if(s.filter!=='all'&&s.filter!==status)continue;
        cards+=`<article class="card"><h2>${esc(v.item.title)}</h2>${tag(`v${v.version}`)}${tag(v.status==='active'?'活跃版本（模拟）':v.status==='withdrawn'?'已撤回（模拟）':'历史版本')}<p>${esc(v.age)} · ${esc(v.by)}</p><p>来源：${esc(v.item.sources?.map(x=>x.title).join('；'))}</p>${b('查看版本','nav','data-route="c06"')}</article>`;
      }
    }
    if(s.kind!=='activities'&&(s.filter==='all'||s.filter==='draft'))cards+=F.books.map(book=>`<article class="card"><h2>${esc(book.label)}</h2>${tag('书目资料待核实')}<p>来源、语言、分册、封面与点读兼容性尚未确认，不作为可发布内容。</p>${b('查看核验说明','book-info')}</article>`).join('');
    return intro('内容库','书目与活动的核验、草稿和版本；这里不展示运营指标或家庭私人记录。')+`<div class="grid"><div><label for="kind">内容类型</label><select id="kind"><option value="all">全部</option><option value="activities">活动</option><option value="books">书目</option></select></div><div><label for="status-filter">状态</label><select id="status-filter">${[['all','全部'],['draft','草稿'],['in_review','待审核'],['ready','可发布'],['published','已发布'],['withdrawn','已撤回']].map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></div></div>${cards||'<p class="banner">没有符合筛选的内容。</p>'}`;
  }
  function editPage(){
    const lock=['in_review','ready','published','withdrawal_confirmation'].includes(s.workflow);
    const canEdit=permission('edit_draft')&&!lock&&!s.busy;
    const input=(key)=>{
      const err=s.errors[key]; const attr=`id="draft-${key}" name="${key}" ${!['english','materials','bookId'].includes(key)?'required':''} ${!canEdit?'disabled':''} ${err?`aria-invalid="true" aria-describedby="error-${key}"`:''}`;
      let control;
      if(key==='age')control=`<select ${attr}>${['18～23月','24～29月','30～35月','36月总结'].map(x=>`<option ${s.buffer[key]===x?'selected':''}>${x}</option>`).join('')}</select>`;
      else if(key==='bookId')control=`<select ${attr}><option value="">不关联</option>${F.books.map(x=>`<option value="${esc(x.id)}" ${s.buffer[key]===x.id?'selected':''}>${esc(x.label)}</option>`).join('')}</select>`;
      else control=key==='title'?`<input ${attr} value="${esc(s.buffer[key])}">`:`<textarea ${attr}>${esc(s.buffer[key])}</textarea>`;
      return `<label for="draft-${key}">${esc(fields[key])}${['english','materials','bookId'].includes(key)?'':'（必填）'}</label>${control}${err?`<p id="error-${key}" class="error">${esc(err)}</p>`:''}`;
    };
    return intro('草稿编辑','草稿不会进入家庭安排；审核并发布后才会形成可用版本。')+`<p>${tag(labels[s.workflow])}${tag(`草稿 v${s.draftVersion}`)}${dirty()?tag('尚未保存'):tag('当前内容已存于原型')}</p>${s.reason?`<p class="banner">退回原因：${esc(s.reason)}</p>`:''}<p class="note">家庭端原始内容仍是「${esc(original.title)}」。本页不连接家庭安排。</p>${lock?`<div class="banner"><p>该版本已送审或发布，编辑需先创建修订；修订会失效原审核结果。</p>${b('创建修订草稿','revise',disabled('edit_draft'))}</div>`:''}${!permission('edit_draft')?'<p class="banner">当前角色无编辑权限，可在审阅面板切换到内容编辑。</p>':''}${s.conflict?`<p class="banner">这份内容在你编辑时有了新版本，请先比较差异。${b('查看差异','compare')}</p>`:''}<form id="draft-form" novalidate>${Object.keys(fields).map(input).join('')}${Object.keys(s.errors).length?'<p role="alert" class="error">请修正标出的字段；输入已保留。</p>':''}<div class="actions">${b(s.busy?'正在保存…':'保存草稿','save',!canEdit?'disabled':'',true)}${b('提交审核','submit',!canEdit||s.offline?'disabled':'')}${b('取消并返回','nav','data-route="c02"')}</div><p class="note">离线只可保留页面内草稿，不能送审。来源标题只是设计占位，正式内容仍需人工审阅。</p></form>`;
  }
  function reviewPage(){
    const eligible=s.workflow==='in_review';
    return intro('内容审核','审核通过不等于发布。请比较差异，并人工检查来源、适龄与安全说明。')+(!eligible?`<p class="banner">${s.workflow==='changes_requested'?`内容已退回：${esc(s.reason)}`:s.reviewed?'审核已通过，尚未发布。':'没有待审核的内容。'} ${b('查看草稿','nav','data-route="c03"')}</p>`:'')+difference()+`<h2>人工核验（本地模拟）</h2>${[['source','已核对来源和年龄节点'],['age','已核对适龄范围及支持边界'],['safety','已核对材料与安全提示']].map(([k,v])=>`<label class="check"><input type="checkbox" name="review-check" value="${k}" ${s.checks[k]?'checked':''} ${!permission('review')||!eligible?'disabled':''}>${v}</label>`).join('')}<label for="review-reason">退回原因（退回时必填）</label><textarea id="review-reason" ${!permission('request_changes')||!eligible?'disabled':''}>${esc(s.reason)}</textarea>${!permission('review')?'<p class="banner">当前角色无审核权限。请切换到内容审核角色。</p>':''}<div class="actions">${b('通过审核','approve',!eligible||!permission('review')||s.offline?'disabled':'',true)}${b('退回修改','reject',!eligible||!permission('request_changes')||s.offline?'disabled':'')}${b('进入发布确认','nav','data-route="c05"')}</div>`;
  }
  function impact(){return `<ul><li>历史记录：${esc(W.withdrawalImpact.history)}。</li><li>已开展或家长已调整的项：${esc(W.withdrawalImpact.startedOrAdjusted)}。</li><li>未开展的项：${esc(W.withdrawalImpact.unstarted)}。</li><li>新安排何时采用新版、离线缓存何时失效：待确认。</li></ul>`;}
  function publishPage(){
    const ready=s.reviewed&&['ready','failed'].includes(s.workflow)&&!dirty()&&!s.conflict;
    return intro('发布确认','发布只改变当前管理原型内存，不代表家庭端已立即使用。')+`<article class="card"><h2>活跃版本：${s.active===null?'无':`v${s.active}`}</h2><p>待发布草稿：v${s.draftVersion} · ${esc(s.saved.title)}</p>${tag(labels[s.workflow])}</article>${s.base!==s.active&&s.workflow!=='published'?`<div class="banner"><p>这个内容已有新版本，请刷新后再发布。旧审核不能直接覆盖新版本。</p>${b('载入最新版本基准并重新送审','rebase')}</div>`:''}${s.workflow==='failed'?`<p class="error" role="alert">发布没有完成，线上版本没有变化。${esc(W.failureReason)} 草稿和版本说明已保留。</p>`:''}${s.workflow==='published'?'<p class="banner">发布完成（模拟），版本记录已更新。不改历史、已开展或家长已调整的项。</p>':''}<h2>影响范围（候选）</h2>${impact()}<label for="release-note">版本说明（必填）</label><textarea id="release-note" ${!permission('publish')?'disabled':''}>${esc(s.note)}</textarea>${!ready?'<p class="note">草稿必须先提交并通过审核，未保存修改或草稿冲突需先处理。</p>':''}${!permission('publish')?'<p class="banner">当前账号没有发布权限。请切换到内容发布角色进行评审。</p>':''}${s.offline?'<p class="banner">离线时不能发布；原活跃版本保留。</p>':''}<div class="actions">${b('检查并确认发布','publish',!ready||!permission('publish')||s.offline||s.busy?'disabled':'',true)}${b('查看版本记录','nav','data-route="c06"')}${b('返回审核','nav','data-route="c04"')}</div>`;
  }
  function versionsPage(){return intro('版本与撤回','版本快照仅存在于当前页面。撤回前需确认原因与影响，失败时活跃版本不变。')+s.versions.slice().reverse().map(v=>`<article class="card"><h2>v${v.version} · ${esc(v.item.title)}</h2>${tag(v.status==='active'?'活跃（模拟）':v.status==='withdrawn'?'已撤回（模拟）':'历史快照')}<p>${esc(v.time)} · ${esc(v.by)}</p><p>版本说明：${esc(v.note)}</p>${v.reason?`<p>撤回原因：${esc(v.reason)}</p>`:''}<details><summary>查看该版内容快照</summary>${details(v.item)}</details>${v.status==='active'?`<p class="note">撤回对未开展项的处理仍待确认，不自动回滚历史版本。</p>${b('查看撤回影响','withdraw',disabled('withdraw')||s.offline?'disabled':'')}`:''}</article>`).join('')+`<div class="actions">${b('查看当前发布状态','nav','data-route="c05"')}</div>`;}
  function render(){
    $('#identity').textContent=`虚构内容账号 · ${roleNames[s.role]}（候选） · 活跃版本 ${s.active??'无'}（模拟）`;
    $('#nav').innerHTML=Object.entries(routes).map(([r,text])=>b(text,'nav',`data-route="${r}" ${s.route===r?'aria-current="page"':''} ${s.busy?'disabled':''}`)).join('');
    $('#page-code').textContent=s.route.toUpperCase();$('#role').value=s.role;$('#role').disabled=s.busy;$('#offline').checked=s.offline;
    const pages={c01:rolePage,c02:library,c03:editPage,c04:reviewPage,c05:publishPage,c06:versionsPage};
    const blocked=!canRead()&&s.route!=='c01';
    $('#screen').innerHTML=`${s.offline?'<p class="banner">当前没有网络。线上版本没有变化。只能查看缓存或保留页面内草稿。</p>':''}${s.notice?`<p class="banner" role="status">${esc(s.notice)}</p>`:''}${blocked?intro('当前账号没有这项权限')+b('返回角色与连接','nav','data-route="c01"'):pages[s.route]()}`;
    if($('#status-filter'))$('#status-filter').value=s.filter;if($('#kind'))$('#kind').value=s.kind;
  }
  function open(type,data={}){
    returnFocus=document.activeElement;dialog={type,...data,error:'',reason:'',confirmed:false};renderDialog();$('#modal').showModal();$('#modal-title').focus({preventScroll:true});
  }
  function close(){if(s.busy)return;$('#modal').close();dialog=null;if(returnFocus?.isConnected)returnFocus.focus();else $('#screen').focus({preventScroll:true});}
  function renderDialog(){
    let title='',body='';
    if(dialog.type==='discard'){title='这次修改还没有保存';body=`<p>确定离开吗？保存过的草稿和活跃版本不会改变。</p><div class="actions">${b('继续编辑','close')}${b('放弃修改并离开','discard')}</div>`;}
    if(dialog.type==='publish'){title='确认发布这个版本？';body=`<p>将草稿 v${s.draftVersion} 设为原型中的活跃版本。当前为 v${s.active??'无'}。</p><p>版本说明：${esc(s.note)}</p>${impact()}<p>这是本地模拟，不改家长页面。</p><div class="actions">${b(s.busy?'正在发布…':'确认发布（模拟）','confirm-publish',s.busy?'disabled':'',true)}${b('取消','close',s.busy?'disabled':'')}</div>`;}
    if(dialog.type==='withdraw'){title='确认撤回活跃版本？';body=`<p>目标：v${s.active??'无'}。原型不会自动回滚至旧版本。</p>${impact()}<label for="withdraw-reason">撤回原因（必填）</label><textarea id="withdraw-reason" ${s.busy?'disabled':''} ${dialog.error?'aria-invalid="true" aria-describedby="dialog-error"':''}>${esc(dialog.reason)}</textarea><label class="check"><input type="checkbox" id="impact-confirm" ${dialog.confirmed?'checked':''} ${s.busy?'disabled':''}>已阅读影响说明；未开展项的处理规则仍待确认。</label><div class="actions">${b(s.busy?'正在撤回…':'确认撤回（模拟）','confirm-withdraw',s.busy?'disabled':'',true)}${b('取消','close',s.busy?'disabled':'')}</div>`;}
    if(dialog.type==='compare'){title='草稿已有另一份修改';body=`<div class="comparison"><div class="card"><h3>我的编辑</h3><p>${esc(s.buffer.title)}</p><p class="preserve">${esc(s.buffer.safety)}</p></div><div class="card"><h3>另一份更新（模拟）</h3><p>${esc(s.conflict?.title)}</p><p class="preserve">${esc(s.conflict?.safety)}</p></div></div><p>只演示并发差异；保留本地内容后仍需保存和重新审核。</p><div class="actions">${b('保留草稿','keep-draft')}${b('载入新版本','load-draft')}</div>`;}
    if(dialog.type==='book'){title='书目核验仍待补齐';body='<p>版本、分册、语言、封面授权与点读兼容性未核实，本轮只展示待核验资料，不将占位书目发布到家庭安排。</p>';}
    $('#modal').innerHTML=`<div class="dialog-head"><h2 id="modal-title" tabindex="-1">${title}</h2>${b('关闭','close',s.busy?'disabled':'')}</div>${body}${dialog.error?`<p id="dialog-error" class="error" role="alert">${esc(dialog.error)}</p>`:''}<p class="note">本地模拟 · 不会改变真实内容库或家庭数据</p>`;
    if($('#modal').open&&!$('#modal').contains(document.activeElement))$('#modal-title').focus({preventScroll:true});
  }
  function validate(){
    const errors={};for(const key of ['title','age','steps','opening','whenJoins','whenWatches','whenStops','safety','sources'])if(!s.buffer[key].trim())errors[key]='请填写这项内容。';
    if(lines(s.buffer.english).some(v=>v.split('|').length!==4||v.split('|').some(x=>!x.trim())))errors.english='每条英语需同时提供英文、中文意思、使用时机和动作，以 | 分隔。';
    s.errors=errors;if(Object.keys(errors).length){render();$(`#draft-${Object.keys(errors)[0]}`).focus();return false;}return true;
  }
  function operate(task,done){
    const fail=$('#failure').checked;$('#failure').checked=false;s.busy=true;const current=++token;
    if(dialog)renderDialog();else render();
    setTimeout(()=>{if(current!==token)return;s.busy=false;done(fail);$('#role').disabled=false;},450);
  }
  function save(submit){
    if(deny(submit?'submit_review':'edit_draft',submit))return;
    if(['in_review','ready','published','withdrawal_confirmation'].includes(s.workflow))return;
    if(s.conflict){say('请先比较草稿差异，再保存或提交。');render();return;}
    if(!validate())return;
    operate('save',fail=>{if(fail){say('这次操作没有完成；输入仍在，请重试。');render();return;}
      s.saved=clone(s.buffer);s.workflow=submit?'in_review':'draft';s.reviewed=false;s.checks={};s.revision++;s.errors={};
      say(submit?'已提交审核（模拟）。草稿仍不会进入家庭安排。':s.offline?'草稿只保留在当前页面（离线模拟），刷新会丢失。':'草稿已保存（模拟），尚未进入家庭安排。');render();});
  }
  function review(approve){
    if(deny(approve?'review':'request_changes',true)||s.workflow!=='in_review')return;
    if(approve&&!['source','age','safety'].every(k=>s.checks[k])){say('请先完成人工来源、适龄与安全核验。');render();return;}
    if(!approve&&!s.reason.trim()){say('请写清需要修改的地方。');render();$('#review-reason').setAttribute('aria-invalid','true');$('#review-reason').setAttribute('aria-describedby','review-error');const e=document.createElement('p');e.id='review-error';e.className='error';e.role='alert';e.textContent='退回原因不能为空。';$('#review-reason').after(e);$('#review-reason').focus();return;}
    operate('review',fail=>{if(fail){say('审核操作没有完成，填写内容已保留。');render();return;}
      s.workflow=approve?'ready':'changes_requested';s.reviewed=approve;s.checks={};say(approve?'审核通过（模拟），尚未发布。请切换发布角色。':'已退回修改（模拟），原因已保留。');render();});
  }
  function confirmPublish(){
    if(deny('publish',true)||!dialog||dialog.type!=='publish')return;
    if(!s.reviewed||!['ready','failed'].includes(s.workflow)||dirty()||s.conflict)return;
    if(s.base!==s.active){close();say('这个内容已有新版本，请刷新后再发布。');render();return;}
    operate('publish',fail=>{if(fail){s.workflow='failed';close();say('发布没有完成，线上版本没有变化；版本说明和草稿均已保留。');render();return;}
      for(const v of s.versions)if(v.status==='active')v.status='history';
      s.active=s.draftVersion;s.versions.push({version:s.active,item:clone(itemFromBuffer(s.saved)),age:s.saved.age,status:'active',by:'发布角色（虚构）',note:s.note,time:'2026-11-11 15:00（固定时钟）'});s.workflow='published';s.reviewed=false;close();say('发布完成（模拟），版本记录已更新。家庭端何时采用仍待确认。');render();});
  }
  function confirmWithdraw(){
    if(deny('withdraw',true)||!dialog||dialog.type!=='withdraw'||!published())return;
    if(!dialog.reason.trim()||!dialog.confirmed){dialog.error='请填写撤回原因，并确认已阅读影响说明。';renderDialog();$('#withdraw-reason').focus();return;}
    operate('withdraw',fail=>{if(fail){dialog.error='撤回没有完成，线上版本没有变化。原因仍在，可重试。';renderDialog();return;}
      const v=published();v.status='withdrawn';v.reason=dialog.reason.trim();s.active=null;close();say('已撤回这个版本（模拟）。未改写任何家庭安排，未自动回滚旧版。');render();});
  }
  document.addEventListener('input',event=>{
    const t=event.target;if(t.closest('#draft-form')&&t.name){s.buffer[t.name]=t.value;s.reviewed=false;}
    if(t.id==='review-reason')s.reason=t.value;if(t.id==='release-note')s.note=t.value;
    if(t.id==='withdraw-reason'&&dialog)dialog.reason=t.value;
  });
  document.addEventListener('change',event=>{
    const t=event.target;
    if(t.closest('#draft-form')&&t.name)s.buffer[t.name]=t.value;
    if(t.name==='review-check')s.checks[t.value]=t.checked;
    if(t.id==='impact-confirm'&&dialog)dialog.confirmed=t.checked;
    if(t.id==='scenario')boot(t.value);
    if(t.id==='role'){s.role=t.value;s.errors={};render();}
    if(t.id==='offline'){s.offline=t.checked;render();}
    if(t.id==='theme')document.documentElement.dataset.theme=t.value;
    if(t.id==='font')document.documentElement.style.setProperty('--scale',t.value);
    if(t.id==='status-filter'){s.filter=t.value;render();}
    if(t.id==='kind'){s.kind=t.value;render();}
  });
  document.addEventListener('submit',e=>{e.preventDefault();if(e.target.id==='draft-form')save(false);});
  document.addEventListener('click',e=>{
    const t=e.target.closest('[data-action]');if(!t||t.disabled)return;const a=t.dataset.action;
    if(a==='nav')return nav(t.dataset.route);
    if(a==='reset')return boot();
    if(a==='close')return close();
    if(a==='discard'){const next=dialog.next;s.buffer=clone(s.saved);close();return next();}
    if(a==='save')return save(false);if(a==='submit')return save(true);
    if(a==='approve')return review(true);if(a==='reject')return review(false);
    if(a==='revise'){if(deny('edit_draft'))return;s.workflow='draft';s.reviewed=false;s.checks={};s.reason='';if(s.active!==null){s.base=s.active;s.draftVersion=s.active+1;}say('已进入修订草稿（候选），需重新审核；活跃版本不变。');return render();}
    if(a==='publish'){
      if(deny('publish',true)||!s.reviewed||!['ready','failed'].includes(s.workflow))return;
      if(s.base!==s.active){say('这个内容已有新版本，请刷新后再发布。');return render();}
      if(!s.note.trim()){say('请填写版本说明。');render();$('#release-note').setAttribute('aria-invalid','true');$('#release-note').focus();return;}
      return open('publish');
    }
    if(a==='confirm-publish')return confirmPublish();
    if(a==='withdraw'){if(deny('withdraw',true)||!published())return;return open('withdraw');}
    if(a==='confirm-withdraw')return confirmWithdraw();
    if(a==='recover'){s.request='ready';say('已模拟重新加载，不代表服务已接通。');return render();}
    if(a==='book-info')return open('book');
    if(a==='draft-conflict'){
      if(!canRead())return;s.conflict={...clone(s.saved),title:'滚球等待回应（他人草稿）',safety:s.saved.safety+' 演示更新：增加周围障碍检查。'};say('检测到另一份草稿更新（模拟）。先比较，不覆盖你的输入。');render();return;
    }
    if(a==='compare'&&s.conflict)return open('compare');
    if(a==='keep-draft'||a==='load-draft'){
      if(deny('edit_draft')||!s.conflict)return;
      const mine=clone(s.buffer);s.saved=clone(s.conflict);s.buffer=a==='load-draft'?clone(s.conflict):mine;s.conflict=null;s.workflow='draft';s.reviewed=false;close();say('已选择草稿（模拟），请保存并重新提交审核。');return render();
    }
    if(a==='publish-conflict'){
      if(!canRead())return;const v=Math.max(...s.versions.map(x=>x.version))+1;for(const item of s.versions)if(item.status==='active')item.status='history';
      s.versions.push({version:v,item:{...clone(original),title:original.title+'（他人新版演示）'},age:'18～23月',status:'active',by:'另一发布者（虚构）',note:'并发发布场景',time:'2026-11-11 15:00（固定时钟）'});s.active=v;say('另一位发布者更新了活跃版本（模拟）；你的旧草稿不能直接覆盖。');return render();
    }
    if(a==='rebase'){if(deny('publish'))return;s.base=s.active;s.draftVersion=Math.max(...s.versions.map(x=>x.version))+1;s.workflow='draft';s.reviewed=false;s.route='c03';say('已更新版本基准，草稿内容保留；请由编辑保存、送审，再审核发布。');return render();}
  });
  $('#modal').addEventListener('cancel',e=>{e.preventDefault();close();});
  window.addEventListener('popstate',()=>{const route=location.hash.slice(1);if(dialog){history.pushState({route:s.route},'',`#${s.route}`);return close();}if(dirty()){history.pushState({route:s.route},'',`#${s.route}`);return open('discard',{next:()=>nav(routes[route]?route:'c02',true)});}s.route=routes[route]?route:'c02';render();});
  $('#scenario').innerHTML=Object.entries(names).map(([id,name])=>`<option value="${id}">${name}</option>`).join('');
  if(matchMedia('(max-width:1180px)').matches)$('#review').open=false;
  boot();
})();
