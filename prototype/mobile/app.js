/* BabyPlan 安卓低保真；只操作当前页面内存中的虚构数据。 */
(() => {
  'use strict';
  const fixture = window.BABYPLAN_FIXTURE;
  if (!fixture) { document.querySelector('#screen').textContent = '演示数据未加载，请重新打开原型。'; return; }
  const $ = s => document.querySelector(s);
  const clone = value => structuredClone(value);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const pointer = ref => ref.slice(2).split('/').reduce((obj,key) => obj[key], fixture);
  const codes = {today:'N02',detail:'N03',books:'N06',stages:'N07',guide:'N08',growth:'N09',measure:'N11',settings:'N12',connection:'N01'};
  const titles = {today:'今天的陪伴',detail:'活动详情',books:'书架与活动',stages:'阶段指引',guide:'一起看图、等待和轮流',growth:'成长',measure:'测量记录',settings:'家庭设置',connection:'家庭连接'};
  const kinds = {movement:'亲子运动',exploration:'动手探索',reading:'中文共读',english:'英语互动',child_led:'共同游戏',replay:'熟悉内容复玩'};
  const feedbackLabels = {want_again:'还想再玩',family_busy:'家里没空',child_tired:'宝宝累了',time_unfit:'这个时段不方便'};
  const syncLabels = {pending:'已存本机 · 待同步',sending:'发送中（模拟）',failed:'同步失败 · 可重试',synced:'已同步（模拟）',conflict:'双方记录需要确认'};
  const scenarioLabels = {
    expanded_today:'今天 · 尚未开展',expanded_loading:'正在加载',expanded_service_error:'服务失败 · 有缓存',expanded_connection_expired:'家庭连接失效',expanded_empty:'今天没有安排',expanded_participation:'代另一位家长记录',expanded_other_member:'另一家长看到记录',expanded_future:'未来日期 · 只读',expanded_offline_cached:'离线 · 有缓存与待同步',expanded_offline_empty:'离线 · 没有缓存',expanded_sync_sending:'同步 · 发送中',expanded_sync_failed:'同步 · 失败重试',expanded_sync_success:'同步 · 已确认',expanded_conflict:'两位家长修改冲突',expanded_replace:'换活动',expanded_book_unverified:'书目版本未核实',expanded_stage:'阶段指引示例',expanded_memory_empty:'成长 · 空状态',expanded_media_pending:'照片 · 待上传',expanded_media_failure:'照片 · 上传失败',expanded_media_denied:'相册权限关闭',expanded_measurement:'测量 · 空表单',expanded_reminder_denied:'通知权限关闭',expanded_reminder_elapsed:'提醒时间已过'
  };
  let state, day, epoch = 0;
  const ui = {route:'today',selected:'sample-roll',modal:null,draft:null,initialDraft:'',discard:false,busy:false,error:'',notice:'',filter:'all',query:'',replacements:{},shortened:{},temporary:[],measurements:[],measureDraft:null,measureInvalid:[],books:[],photoChoice:false,returnFocus:null,scenario:'expanded_today'};
  const icons = {today:'<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4m8-4v4M4 10h16m-11 4h6"/>',stages:'<path d="M4 20V9h5v11m0-6h5v6m0-16h6v16M3 20h18"/>',books:'<path d="M12 6v15M3 4c4 0 6 0 9 2 3-2 5-2 9-2v15c-4 0-6 0-9 2-3-2-5-2-9-2Z"/>',growth:'<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m4 16 5-5 4 4 3-3 4 4"/><circle cx="15" cy="8" r="1"/>',back:'<path d="m14 5-7 7 7 7"/>',settings:'<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>'};
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${icons[name] || ''}</svg>`;
  const button = (text, action, attrs='', style='') => `<button type="button" data-action="${action}" class="${style}" ${attrs}>${text}</button>`;
  const tag = text => `<span class="tag">${esc(text)}</span>`;
  const memberName = id => fixture.family.members.find(m => m.id === id)?.label || '家长（虚构）';
  const participants = ids => (ids || []).map(memberName).join('、');
  const today = () => {
    const parts = new Intl.DateTimeFormat('en-CA',{timeZone:fixture.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(state.referenceNow));
    const get = type => parts.find(p => p.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  };
  const dayDate = () => day?.date || fixture.businessDate;
  const future = () => dayDate() > today();
  const items = () => day?.items || [];
  const itemById = id => ui.replacements[id] ? {...ui.replacements[id],id} : [...items(),...ui.temporary].find(i => i.id === id);
  const picked = () => itemById(ui.selected) || items()[0];
  const isDirty = () => ui.draft && JSON.stringify(ui.draft) !== ui.initialDraft;
  function announce(message) { $('#announcement').textContent = message; }
  function notice(message) { ui.notice = message; announce(message); }
  function later(callback, ms=400) { const token = epoch; setTimeout(() => { if (token === epoch) callback(); }, ms); }
  function setRoute(route, push=true) {
    if (ui.modal) closeSheet(true);
    ui.route = route; ui.error = '';
    if (push) history.pushState({route},'',`#${route}`);
    render(); $('#screen').scrollTop = 0; $('#screen').focus({preventScroll:true});
    $('.device').scrollIntoView({block:'start',behavior:'instant'});
  }
  function routeToItem(id) { ui.selected = id; setRoute('detail'); }
  function applyScenario(id) {
    epoch++;
    const scenario = fixture.scenarios.find(c => c.id === id) || fixture.scenarios[0];
    state = {...clone(fixture.initialState),...clone(scenario.overrides)};
    day = state.daySource ? clone(pointer(state.daySource)) : null;
    Object.assign(ui,{scenario:id,selected:state.selectedItemId,modal:null,draft:null,discard:false,busy:false,error:'',notice:'',replacements:{},shortened:{},temporary:[],measurements:[],measureDraft:null,measureInvalid:[],books:[],filter:'all',query:'',photoChoice:false});
    if ($('#sheet').open) $('#sheet').close();
    let route = 'today';
    if (id === 'expanded_connection_expired') route = 'connection';
    if (id === 'expanded_book_unverified') route = 'books';
    if (id === 'expanded_stage') route = 'stages';
    if (/expanded_(memory|media)/.test(id)) route = 'growth';
    if (id === 'expanded_measurement') route = 'measure';
    if (/expanded_reminder/.test(id)) route = 'settings';
    if (id === 'expanded_future') route = 'detail';
    ui.route = route;
    history.replaceState({route},'',`#${route}`);
    $('#scenario').value = id;
    $('#scenario-expectation').textContent = scenario.expected;
    if (id === 'expanded_participation') state.activeMemberId = fixture.participationDraft.addedBy;
    render();
    if (id === 'expanded_participation') openRecord('played', clone(fixture.participationDraft));
    if (id === 'expanded_replace') openReplace();
    if (id === 'expanded_conflict' || /expanded_sync_/.test(id)) openSync();
  }
  function header() {
    const root = ['today','stages','books','growth'].includes(ui.route);
    $('#app-header').innerHTML = `<div class="header-start">${root ? '' : button(icon('back'),'back','aria-label="返回上一页"','text')}<div><div class="brand">${root ? 'BabyPlan' : esc(titles[ui.route])}</div><div class="caption">${esc(memberName(state.activeMemberId))} · 18～23月</div></div></div>${ui.route !== 'settings' ? button(icon('settings'),'nav','data-route="settings" aria-label="家庭设置"','text') : ''}`;
    const active = ['guide'].includes(ui.route) ? 'stages' : ['measure'].includes(ui.route) ? 'growth' : ui.route;
    $('#app-nav').innerHTML = [['today','今天'],['stages','阶段指引'],['books','书架与活动'],['growth','成长']].map(([route,text]) => button(`${icon(route)}<span>${text}</span>`,'nav',`data-route="${route}" ${active === route ? 'aria-current="page"' : ''}`)).join('');
    $('#member').value = state.activeMemberId;
    $('#page-code').textContent = ui.modal === 'record' || ui.modal === 'sync' ? 'N04' : ui.modal === 'replace' ? 'N05' : ui.modal === 'memory' ? 'N10' : codes[ui.route];
    $('#clock-label').textContent = new Intl.DateTimeFormat('zh-CN',{timeZone:fixture.timezone,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(state.referenceNow));
    $('#network-label').textContent = state.network === 'offline' ? '离线（模拟）' : '在线（模拟）';
  }
  function intro(code,title,text='') { return `<div class="intro"><p class="eyebrow">${code} · 演示内容</p><h1>${esc(title)}</h1>${text ? `<p class="subtle">${esc(text)}</p>` : ''}</div>`; }
  function statusFor(item) {
    const record = state.itemRecords[item.id];
    return record ? record.status === 'played' ? '✓ 一起玩了' : '— 今天跳过' : future() ? '尚未开始 · 只读' : '未记录';
  }
  function statusBanner() {
    let html = '';
    if (state.connectionState === 'expired') html += `<div class="banner"><p>家庭服务连接已失效。本机内容会保留。</p>${button('查看恢复方式','nav','data-route="connection"')}</div>`;
    if (state.network === 'offline' && day) html += `<div class="banner"><p>当前没有网络。已下载的内容仍可查看；新记录先保存在本机，联网后再同步。</p>${button('模拟恢复网络','restore-network')}</div>`;
    if (state.requestState === 'failed' && day) html += `<div class="banner"><p>没有加载成功，下面保留上次下载的内容。</p>${button('重试（模拟）','recover')}</div>`;
    if (Object.values(state.syncStates).some(s => s !== 'synced')) html += `<div class="banner"><p>有本机记录尚未同步，或需要确认双方的修改。</p>${button('查看同步与冲突','open-sync')}</div>`;
    return html;
  }
  function activityCard(item) {
    item = itemById(item.id) || item;
    const record = state.itemRecords[item.id];
    const time = ui.shortened[item.id] || item.budgetMinutes;
    return `<article class="card" data-item-card="${esc(item.id)}"><div>${tag(kinds[item.kind] || '亲子活动')}${tag(`${time}分钟 · 可调整`)}</div><button class="open-card" data-action="detail" data-id="${esc(item.id)}"><h3>${esc(item.title)} <span class="arrow" aria-hidden="true">↗</span></h3></button><p class="note hint">准备：${esc(item.materials.length ? item.materials.join('、') : '不用道具')}</p><div>${tag(statusFor(item))}${state.syncStates[item.id] ? tag(syncLabels[state.syncStates[item.id]]) : ''}</div>${record ? `<p class="note">陪伴：${esc(participants(record.participantIds))}<br>添加：${esc(memberName(record.addedBy))}${record.feedback ? `<br>反馈：${esc(feedbackLabels[record.feedback])}` : ''}</p>` : ''}${future() ? '<p class="note">未来日期，只能查看。</p>' : `<div class="actions">${button(record ? '查看 / 修改' : '记录这一项','record',`data-id="${esc(item.id)}"`)}${button('换活动','replace',`data-id="${esc(item.id)}"`)}</div>`}</article>`;
  }
  function todayPage() {
    let html = intro('N02','今天，一起玩一会儿','这些是建议窗口和大致时长，不是必须完成的任务。可以只做一段，也可以提前结束。');
    html += `<p class="date-line">${esc(dayDate())} · 按家庭时区 Asia/Shanghai</p>${statusBanner()}`;
    if (state.requestState === 'loading') return html + `<div class="empty" aria-busy="true"><h2>正在加载今天的安排…</h2><p>加载结果尚未返回，不代表没有内容。</p>${button('模拟加载完成','recover')}</div>`;
    if (!day) return html + `<div class="empty"><h2>${state.network === 'offline' ? '还没有下载今天的安排' : '今天还没有安排'}</h2><p>${state.network === 'offline' ? '请联网后再试，不会生成虚构任务。' : '系统准备好后会显示在这里。你也可以先查看书架。'}</p><div class="actions">${button(state.network === 'offline' ? '模拟恢复网络' : '重新加载（模拟）','recover','', 'primary')}${button('查看书架','nav','data-route="books"')}</div></div>`;
    const segments = day.segments || fixture.day.segments;
    segments.forEach((segment,index) => {
      const list = items().filter(i => i.segmentId === segment.id);
      if (!list.length) return;
      html += `<section class="segment"><div class="segment-head"><h2><span class="letter">${['A','B','C'][index]}</span>${esc(segment.label)}</h2><p class="note">${esc(segment.window)} · 候选预算约${segment.budgetMinutes}分钟</p></div>${list.map(activityCard).join('')}</section>`;
      if (index === 0) html += '<div class="dinner"><p class="note">17:30 左右 · 晚饭与洗漱<br>不计入亲子互动预算，不在饭桌上安排教学。</p></div>';
    });
    if (ui.temporary.length) html += `<section class="section"><h2>临时开展</h2><p class="note">只记录真实发生的参与，不增加必须完成的预算。</p>${ui.temporary.map(activityCard).join('')}</section>`;
    return html + `<div class="section">${button('从活动库临时选一项','nav','data-route="books"')}<p class="note">原创虚构安排；适龄、安全与来源仍需正式内容审阅。</p></div>`;
  }
  function detailPage() {
    const item = picked();
    if (!item) return intro('N03','这项内容暂时找不到了') + button('返回今天','nav','data-route="today"');
    const labels = {opening:'开始时',whenJoins:'宝宝跟着玩',whenWatches:'宝宝只是看',whenStops:'宝宝想停'};
    return `${intro('N03',item.title)}<div class="row">${tag(kinds[item.kind] || '共同游戏')}${tag(`${ui.shortened[item.id] || item.budgetMinutes}分钟 · 可缩短`)}${tag(statusFor(item))}</div>${future() ? '<div class="banner"><p>这是还没到的日期，暂时只能查看，不能记录。</p></div>' : ''}${statusBanner()}<section class="section"><h2>为什么这样安排</h2><p>示例：材料准备简单，可以在日常里一起玩。安排理由和编排规则仍待评审。</p></section><section class="section"><h2>准备什么</h2>${item.materials.length ? `<ul>${item.materials.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : '<p>不用道具。</p>'}</section><section class="section"><h2>怎么玩</h2><ol>${item.steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol></section><section class="section"><h2>家长可以这样说</h2>${Object.entries(item.dialogue).map(([key,text]) => `<div class="dialogue"><h3>${labels[key]}</h3><p>“${esc(text)}”</p></div>`).join('')}</section>${item.english?.length ? `<section class="section"><h2>顺口说一句英文</h2><p class="note">原创话术；看、指和动作都可以回应，不要求跟读。</p>${item.english.map(line => `<div class="card"><h3 lang="en">${esc(line.line)}</h3><p>${esc(line.meaningZh)}</p><p class="note">什么时候：${esc(line.when)}<br>配合动作：${esc(line.action)}</p></div>`).join('')}</section>` : ''}<section class="section"><h2>安全提示</h2><p>${esc(item.safety)}</p></section><section class="section"><h2>来源与内容说明</h2>${(item.sources || []).map(s => `<p class="note">${esc(s.title)}</p>`).join('')}<p class="note">本轮只演示内容结构，不代表已完成适龄、安全或来源审核。</p></section>${future() ? '<p class="banner">未来日期 · 只读</p>' : `<div class="detail-actions">${button('一起玩了','record',`data-id="${esc(item.id)}" data-status="played"`,'primary')}${button('今天跳过','record',`data-id="${esc(item.id)}" data-status="skipped"`)}${button('换活动','replace',`data-id="${esc(item.id)}"`)}</div>`}`;
  }
  function booksPage() {
    const list = fixture.day.items.filter(item => !ui.query || item.title.includes(ui.query));
    const showBooks = ui.filter !== 'activities';
    return intro('N06','家里的书，熟悉的玩法','优先用已有的书和材料，不需要为了安排购入新东西。') + `<form id="search-form"><label for="book-search">搜索书名或活动</label><div class="row"><input id="book-search" name="query" type="search" value="${esc(ui.query)}" placeholder="例如：小熊" style="flex:1"><button type="submit">搜索</button></div></form><div class="tabs" aria-label="书架筛选">${[['all','全部'],['owned','家中已有'],['activities','活动']].map(([key,label]) => button(label,'filter',`data-filter="${key}" aria-pressed="${ui.filter === key}"`)).join('')}</div>${showBooks ? `<section class="section"><h2>家中已有</h2>${!ui.query || fixture.books[0].label.includes(ui.query) ? `<div class="card"><h3>${esc(fixture.books[0].label)}</h3>${tag('版本信息待核实')}<p class="note">封面、分册、语言与点读兼容性都未确认。</p>${button('查看书目说明','book-info')}</div>` : '<p>这个筛选下还没有书目。</p>'}${ui.books.map(book => `<div class="card"><h3>${esc(book)}</h3>${tag('本地新增 · 待核实')}</div>`).join('')}${button('添加家中书目（候选）','add-book')}</section>` : ''}${ui.filter !== 'owned' ? `<section class="section"><h2>可开展的活动</h2>${list.length ? list.map(item => `<div class="card"><h3>${esc(item.title)}</h3><p class="note">${esc(item.materials.join('、') || '不用道具')}</p><div class="actions">${button('看玩法','library-detail',`data-id="${esc(item.id)}"`)}${button('临时开展','temporary',`data-id="${esc(item.id)}"`)}</div></div>`).join('') : `<p>这个筛选下还没有内容。</p>${button('清除筛选','clear-search')}`}</section>` : ''}`;
  }
  function stagesPage() {
    return intro('N07','每个阶段，慢慢探索','这些是父母支持孩子的方向，不是发育评分；没有记录不代表不会。') + ['18～23月','24～29月','30～35月','36月阶段总结'].map((label,index) => `<article class="card"><h2>${label}</h2><p>${index === 0 ? '一起看图、等待和轮流' : '这一阶段的内容还在准备中'}</p><p class="note">${index === 0 ? '当前有一份原创设计示例，尚待正式内容审阅。' : '不复用旧月龄档伪装成已制作完成的阶段内容。'}</p>${button(index === 0 ? '查看支持示例' : '查看准备说明',index === 0 ? 'nav' : 'stage-pending',index === 0 ? 'data-route="guide"' : '')}</article>`).join('');
  }
  function guidePage() {
    const guide = fixture.stageGuideSample;
    return intro('N08',guide.focus,guide.ageBand) + [['生活里的表现',guide.everydayExample],['父母可以怎么支持',guide.parentSupport],['两种玩法',guide.playIdeas.join('；')],['更容易一点',guide.easierVersion],['可选下一步',guide.optionalNextStep],['来源与年龄节点',guide.source.title]].map(([title,text]) => `<section class="section"><h2>${esc(title)}</h2><p>${esc(text)}</p></section>`).join('') + `<p class="banner">${esc(guide.source.boundary)}</p><p class="note">如有能力倒退或持续担忧，可与儿保人员沟通；本产品不做诊断。</p>`;
  }
  function growthPage() {
    return intro('N09','把日常留在这里','照片、原话、小故事与第一次，由你决定记下什么。') + `<div class="actions">${button('写一条成长记录','add-memory','','primary')}${button('测量记录','nav','data-route="measure"')}</div><p class="note section">家庭成员可见 · 当前只有虚构占位</p>${state.memoryRecords.length ? state.memoryRecords.map((memory,index) => `<article class="card">${memory.media ? `<div class="placeholder">照片占位 · 不是真实照片</div>` : ''}${tag(memory.firstTimeConfirmed ? '家长确认的第一次' : '小故事')}<p>${esc(memory.text)}</p><p class="note">${esc(fixture.businessDate)} · ${esc(memberName(memory.addedBy || state.activeMemberId))}</p>${memory.media ? `<p class="banner">${memory.media.state === 'failed' ? '照片上传失败。文字已保留，可以重试。' : '照片已存本机，还没有上传；其他成员暂时看不到。'}</p>${button('重试上传（模拟）','media-retry',`data-index="${index}"`)}` : ''}</article>`).join('') : `<div class="empty"><h2>还没有成长记录</h2><p>不必每天填写，也不从一次参与自动判断“第一次”。</p>${button('写一条小故事','add-memory')}</div>`}`;
  }
  function measurePage() {
    return intro('N11','测量记录','先保存家庭自己的测量。年龄、方法和参考资料未齐全时，不显示百分位或诊断。') + `<form id="measure-form" novalidate><label for="measure-date">测量日期</label><input id="measure-date" name="date" type="date" value="${fixture.businessDate}" max="${today()}" required><label for="measure-kind">测量项目</label><select id="measure-kind" name="kind"><option value="height">身长 / 身高（cm）</option><option value="weight">体重（kg）</option></select><label for="measure-value">数值（虚构演示）</label><input id="measure-value" name="value" type="number" min="0.1" step="0.1" required inputmode="decimal"><label for="measure-method">测量方法（候选）</label><select id="measure-method" name="method"><option value="">请选择方法</option><option>卧位身长</option><option>站立身高</option><option>体重秤</option></select><label for="measure-source">测量来源（候选）</label><select id="measure-source" name="source"><option>家中</option><option>儿保</option></select>${ui.error ? `<p class="form-error" role="alert">${esc(ui.error)}</p>` : ''}<div class="actions"><button type="submit" class="primary">保存到原型</button></div></form><section class="section"><h2>家庭记录</h2>${ui.measurements.length ? `<table><caption class="sr-only">虚构测量记录</caption><thead><tr><th>日期</th><th>数值</th><th>方法 / 来源</th></tr></thead><tbody>${ui.measurements.map(m => `<tr><td>${esc(m.date)}</td><td>${esc(m.value)} ${m.kind === 'height' ? 'cm' : 'kg'}</td><td>${esc(m.method)} / ${esc(m.source)}</td></tr>`).join('')}</tbody></table>` : '<p>还没有测量记录。</p>'}<p class="note">本轮只展示表格，不绘制参考曲线、不计算百分位。</p></section>`;
  }
  function settingsPage() {
    const timeNow = new Intl.DateTimeFormat('en-GB',{timeZone:fixture.timezone,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(state.referenceNow));
    return intro('N12','家庭设置','成员与提醒设置均在当前原型内模拟。') + `<h2>一起使用的人</h2>${fixture.family.members.map(m => `<div class="key-value"><span>${esc(m.label)}</span><span>${state.activeMemberId === m.id ? '当前添加者' : '家庭成员'}</span></div>`).join('')}<p class="note">陪伴者可与添加者不同；成员角色和加入方式待确认。</p>${button('查看邀请候选','invite')}<section class="section"><h2>提醒</h2><label class="check"><input type="checkbox" id="reminder-enabled" ${state.reminder.enabled ? 'checked' : ''}>希望每天提醒一次</label><label for="reminder-time">候选提醒时间</label><input id="reminder-time" type="time" value="${state.reminder.time}"><p class="note">16:00是扩展方案候选；实际默认时间待确认。这里不会安排系统通知。</p><div class="banner"><p>系统权限：${state.reminder.permission === 'denied' ? '未开启。仍可查看和记录活动。' : '允许（模拟）'}</p>${state.reminder.permission === 'denied' ? button('查看系统设置说明','permission-info') : ''}${state.reminder.enabled && timeNow > state.reminder.time ? '<p>今天的提醒时间已经过了，不补发。</p>' : ''}</div></section><section class="section"><h2>家庭连接</h2><p>${state.connectionState === 'expired' ? '连接已失效，本机内容保留。' : '已连接虚构家庭（模拟）'}</p><div class="actions">${button('查看连接恢复','nav','data-route="connection"')}${button('同步与冲突','open-sync')}</div></section><section class="section"><h2>孩子与资料</h2><p>年龄范围：18～23月；没有录入生日。</p><p class="note">生日录入、权限、媒体保存与导出规则待确认，本轮不采集真实资料。</p></section>`;
  }
  function connectionPage() {
    return intro('N01',state.connectionState === 'expired' ? '家庭连接需要恢复' : '全家共用一份安排','家长甲和家长乙看到同一份家庭安排。当前只有虚构家庭，不输入真实凭证。') + `<div class="banner"><p>${state.connectionState === 'expired' ? '家庭服务连接已失效，请更新连接配置。本机内容会保留。' : '本轮假定家庭已连接，仅演示恢复入口。'}</p></div><div class="stack-actions">${button('模拟恢复已有家庭连接','connect','','primary')}${button('查看加入 / 创建候选','invite')}${button('返回今天，查看本机内容','nav','data-route="today"')}</div><p class="note">BabyPlan暂不提供公开注册。邀请、扫码、账号恢复方式都尚未确定。</p>`;
  }
  function render() {
    const pages = {today:todayPage,detail:detailPage,books:booksPage,stages:stagesPage,guide:guidePage,growth:growthPage,measure:measurePage,settings:settingsPage,connection:connectionPage};
    $('#screen').innerHTML = `${ui.notice ? `<div class="banner" role="status">${esc(ui.notice)} ${button('收起','dismiss','','text')}</div>` : ''}${(pages[ui.route] || todayPage)()}`;
    if (ui.route === 'measure') {
      const form = $('#measure-form');
      if (ui.measureDraft) Object.entries(ui.measureDraft).forEach(([key,value]) => { if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value; });
      if (ui.error) {
        const error = $('#screen .form-error'); error.id = 'measure-error';
        ui.measureInvalid.forEach(key => { const input = form.elements.namedItem(key); if (!input) return; input.setAttribute('aria-invalid','true'); input.setAttribute('aria-describedby','measure-error'); });
      }
    }
    header();
  }
  function openSheet(type,draft={}) {
    ui.returnFocus = document.activeElement;
    ui.modal = type; ui.draft = draft; ui.initialDraft = JSON.stringify(draft); ui.discard = false; ui.error = ''; ui.busy = false;
    renderSheet();
    if (!$('#sheet').open) $('#sheet').showModal();
    $('#sheet-title').focus({preventScroll:true});
    header();
  }
  function closeSheet(force=false) {
    if (ui.busy && !force) return;
    if (!force && isDirty() && !['sync','info'].includes(ui.modal)) { ui.discard = true; renderSheet(); return; }
    const focus = ui.returnFocus;
    ui.modal = null; ui.draft = null; ui.discard = false; ui.error = ''; $('#sheet').close(); header();
    if (focus?.isConnected) focus.focus(); else $('#screen').focus({preventScroll:true});
  }
  function openRecord(status='played',preset) {
    if (future()) { notice('未来日期暂时只能查看。'); render(); return; }
    if (state.syncStates[ui.selected] === 'conflict') { openSync(); return; }
    const existing = state.itemRecords[ui.selected];
    const draft = preset || (existing ? clone(existing) : {status,feedback:null,participantIds:[state.activeMemberId]});
    draft.addedBy = state.activeMemberId;
    openSheet('record',draft);
  }
  function openReplace() {
    if (!picked()) return;
    if (future()) { notice('未来预览只读。'); render(); return; }
    if (state.itemRecords[ui.selected]) { info('保留已经记录的内容','已经记录的内容保留原样。请从尚未记录的一项体验换活动。'); return; }
    openSheet('replace',{choice:picked()?.kind === 'movement' && picked()?.segmentId === 'afternoon' ? 'replace' : 'shorten',reason:'材料不在手边'});
  }
  function openSync() { openSheet('sync'); }
  function info(title,text) { openSheet('info',{title,text}); }
  function radio(name,value,label,checked) { return `<label class="choice"><input type="radio" name="${name}" value="${esc(value)}" ${checked ? 'checked' : ''}><span>${esc(label)}</span></label>`; }
  function renderSheet() {
    let title = '', body = '';
    const draft = ui.draft || {};
    if (ui.discard) {
      title = '这次修改还没有保存';
      body = `<p>确定离开吗？原来的记录不会改变。</p><div class="actions">${button('继续编辑','continue-edit','','primary')}${button('放弃修改','discard')}</div>`;
    } else if (ui.modal === 'record') {
      title = '这一项玩得怎么样？';
      const feedbacks = draft.status === 'played' ? ['want_again'] : ['family_busy','child_tired','time_unfit'];
      body = `<p>${esc(picked()?.title)}</p><fieldset><legend>参与状态</legend>${radio('status','played','一起玩了',draft.status === 'played')}${radio('status','skipped','今天跳过',draft.status === 'skipped')}</fieldset><fieldset><legend>可选反馈 · 不选也可以</legend>${radio('feedback','','暂不填写',!draft.feedback)}${feedbacks.map(key => radio('feedback',key,feedbackLabels[key],draft.feedback === key)).join('')}</fieldset><fieldset><legend>谁陪着玩（候选交互）</legend>${fixture.family.members.map(m => `<label class="choice"><input type="checkbox" name="participant" value="${m.id}" ${draft.participantIds?.includes(m.id) ? 'checked' : ''}><span>${esc(m.label)}</span></label>`).join('')}</fieldset><p class="note">由${esc(memberName(state.activeMemberId))}添加。陪伴者与添加者可以不同；按单个内容块演示。</p>${ui.error ? `<p class="form-error" role="alert">${esc(ui.error)}</p>` : ''}<div class="actions">${button(ui.busy ? '正在保存…' : '保存记录','save-record',ui.busy ? 'disabled' : '', 'primary')}${button('取消','close',ui.busy ? 'disabled' : '')}</div>`;
    } else if (ui.modal === 'replace') {
      title = '换成别的活动';
      const candidate = fixture.replacementSample.candidate;
      body = `<p>原安排：${esc(picked()?.title)}</p><p class="note">只替换今天这一个内容块，不改动已经记录的内容块。</p><label for="replace-reason">为什么想调整（候选）</label><select id="replace-reason" name="reason">${['材料不在手边','想换本书','时间更短','孩子今天状态不同','其他'].map(reason => `<option ${draft.reason === reason ? 'selected' : ''}>${reason}</option>`).join('')}</select><fieldset><legend>这次怎么调整</legend>${picked()?.kind === 'movement' && picked()?.segmentId === 'afternoon' ? radio('replacement','replace',`换成「${candidate.title}」`,draft.choice === 'replace') + `<p class="note">18～23月 · 不用道具 · 约${candidate.budgetMinutes}分钟（可提前结束）</p>` : '<p>暂时没有匹配的替代候选，可以缩短这一项或保持原安排。</p>'}${radio('replacement','shorten',`保持玩法，缩短为约${fixture.replacementSample.shortenCandidateMinutes}分钟`,draft.choice === 'shorten')}</fieldset><p class="note">候选示例，不是自动生成算法；已改过的内容不会被后台重排。</p><div class="actions">${button('确认调整','confirm-replace','','primary')}${button('取消','close')}</div>`;
    } else if (ui.modal === 'sync') {
      title = '本机记录与同步';
      const conflictId = Object.keys(state.syncStates).find(id => state.syncStates[id] === 'conflict');
      const syncs = Object.entries(state.syncStates);
      if (conflictId) {
        const conflict = fixture.conflictSample;
        body = `<p>这条记录已有更新。请先看看两边的不同，再决定保留哪一份。</p><div class="card"><h3>本机选择</h3><p>${conflict.local.status === 'played' ? '一起玩了' : '今天跳过'}</p><p class="note">陪伴：${esc(participants(conflict.local.participantIds))}</p></div><div class="card"><h3>另一边的更新（模拟）</h3><p>${conflict.remote.status === 'played' ? '一起玩了' : '今天跳过'} · ${esc(feedbackLabels[conflict.remote.feedback] || '未选反馈')}</p><p class="note">陪伴：${esc(participants(conflict.remote.participantIds))}</p></div><div class="actions">${button('保留我的','resolve-local',`data-id="${conflictId}"`,'primary')}${button('采用已有更新','resolve-remote',`data-id="${conflictId}"`)}${button('稍后处理','close','','full')}</div><p class="note">同一内容块的同次共同参与可合并；独立开展的两次参与不因同段去重。真实合并规则待定。</p>`;
      } else body = syncs.length ? syncs.map(([id,sync]) => `<div class="card"><h3>${esc(itemById(id)?.title || '家庭记录')}</h3><p>${esc(syncLabels[sync])}</p></div>`).join('') + `<div class="actions">${button('模拟重试并确认','retry-sync','','primary')}${button('关闭','close')}</div>` : '<p>当前没有待同步记录。这里的同步结果均为页面内模拟。</p>' + button('关闭','close');
    } else if (ui.modal === 'memory') {
      title = '写一条成长记录';
      body = `<label for="memory-text">小故事或孩子原话（仅用虚构内容）</label><textarea id="memory-text" name="memoryText" placeholder="例如：今天把球推回来，抬头看着我。">${esc(draft.text)}</textarea><label class="check"><input type="checkbox" name="firstTime" ${draft.firstTimeConfirmed ? 'checked' : ''}>由我确认这是第一次</label>${button(draft.media ? '已添加照片占位' : '添加照片占位','photo-placeholder')}<p class="note">不打开真实相册，不上传照片；相册权限关闭仍可写文字。</p>${ui.error ? `<p class="form-error" role="alert">${esc(ui.error)}</p>` : ''}<div class="actions">${button(ui.busy ? '正在保存…' : '保存到原型','save-memory',ui.busy ? 'disabled' : '', 'primary')}${button('取消','close',ui.busy ? 'disabled' : '')}</div>`;
    } else if (ui.modal === 'book') {
      title = '添加家中书目（候选）';
      body = `<label for="book-title">虚构书名或占位名称</label><input id="book-title" name="bookTitle" value="${esc(draft.title)}" placeholder="例如：演示绘本"><p class="note">版本、语言、封面和点读能力暂不推断。</p>${ui.error ? `<p class="form-error" role="alert">${esc(ui.error)}</p>` : ''}<div class="actions">${button('保存到原型','save-book','','primary')}${button('取消','close')}</div>`;
    } else { title = draft.title || '说明'; body = `<p>${esc(draft.text)}</p>${button('知道了','close','','primary')}`; }
    $('#sheet').innerHTML = `<div class="sheet-top"><h2 id="sheet-title" tabindex="-1">${esc(title)}</h2>${!ui.busy && !ui.discard ? button('关闭','close','aria-label="关闭弹层"','text') : ''}</div>${body}<p class="sheet-note">本地模拟 · 没有真实保存、上传或服务请求</p>`;
    $('#sheet').querySelectorAll('input,select,textarea').forEach(input => { input.disabled = ui.busy; });
    const error = $('#sheet .form-error');
    if (error) {
      error.id = 'sheet-error';
      $('#sheet').querySelectorAll('fieldset,textarea,input:not([type=radio]):not([type=checkbox])').forEach(input => { input.setAttribute('aria-describedby','sheet-error'); input.setAttribute('aria-invalid','true'); });
    }
    if ($('#sheet').open && !$('#sheet').contains(document.activeElement)) $('#sheet-title').focus({preventScroll:true});
    header();
  }
  function saveRecord() {
    if (!ui.draft.participantIds?.length) { ui.error = '请选择至少一位陪伴者。'; renderSheet(); return; }
    ui.busy = true; ui.error = ''; renderSheet();
    later(() => {
      ui.busy = false;
      if ($('#save-failure').checked) { $('#save-failure').checked = false; ui.error = '这次保存没有完成。你填写的内容还在，请重试。'; renderSheet(); return; }
      state.itemRecords[ui.selected] = {...clone(ui.draft),itemId:ui.selected,addedBy:state.activeMemberId,date:dayDate(),simulationOnly:true};
      state.syncStates[ui.selected] = 'pending';
      closeSheet(true); notice('已保存在本机，等待同步（模拟）。'); setRoute('today');
    });
  }
  function retrySync() {
    if (state.network === 'offline') { info('当前没有网络','本机记录会保留。请先在审阅面板切换到在线，或选择“模拟恢复网络”后重试。'); return; }
    const snapshot = Object.fromEntries(Object.entries(state.syncStates).filter(([,s]) => s !== 'synced' && s !== 'conflict').map(([id]) => [id,state.itemRecords[id]]));
    Object.keys(snapshot).forEach(id => state.syncStates[id] = 'sending'); render(); renderSheet();
    later(() => {
      Object.entries(snapshot).forEach(([id,record]) => { state.syncStates[id] = state.itemRecords[id] === record ? 'synced' : 'pending'; });
      render(); if (ui.modal === 'sync') renderSheet(); announce('模拟同步结果已更新。');
    },650);
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    if (action === 'nav') { ui.notice = ''; return setRoute(target.dataset.route); }
    if (action === 'back') { ui.notice = ''; return setRoute(ui.route === 'guide' ? 'stages' : ui.route === 'measure' ? 'growth' : 'today'); }
    if (action === 'detail') return routeToItem(target.dataset.id);
    if (action === 'record') { ui.selected = target.dataset.id; return openRecord(target.dataset.status || 'played'); }
    if (action === 'replace') { ui.selected = target.dataset.id; return openReplace(); }
    if (action === 'close') return closeSheet();
    if (action === 'discard') return closeSheet(true);
    if (action === 'continue-edit') { ui.discard = false; return renderSheet(); }
    if (action === 'dismiss') { ui.notice = ''; return render(); }
    if (action === 'reset') { $('#save-failure').checked = false; applyScenario('expanded_today'); return; }
    if (action === 'open-sync') return openSync();
    if (action === 'save-record') return saveRecord();
    if (action === 'retry-sync') return retrySync();
    if (action === 'resolve-local' || action === 'resolve-remote') {
      const id = target.dataset.id, side = action === 'resolve-local' ? 'local' : 'remote';
      state.itemRecords[id] = {...clone(fixture.conflictSample[side]),itemId:id,date:fixture.businessDate,simulationOnly:true};
      state.syncStates[id] = side === 'local' ? 'pending' : 'synced'; closeSheet(true); notice(side === 'local' ? '已保留本机选择，等待同步（模拟）。' : '已采用另一边的更新（模拟）。'); return render();
    }
    if (action === 'confirm-replace') {
      if (ui.draft.choice === 'shorten') ui.shortened[ui.selected] = fixture.replacementSample.shortenCandidateMinutes;
      else { ui.replacements[ui.selected] = clone(fixture.replacementSample.candidate); delete ui.shortened[ui.selected]; }
      closeSheet(true); notice('只调整了这一项，其他内容与已有记录保持原样（模拟）。'); return render();
    }
    if (action === 'restore-network') { state.network = 'online'; notice('已模拟恢复网络，本机记录保持不变。'); return render(); }
    if (action === 'recover') { state.network = 'online'; state.requestState = 'ready'; if (!day) day = clone(fixture.day); notice('已载入虚构演示安排。'); return render(); }
    if (action === 'connect') { state.connectionState = 'connected'; notice('已模拟恢复家庭连接。'); return setRoute('today'); }
    if (action === 'filter') { ui.filter = target.dataset.filter; return render(); }
    if (action === 'clear-search') { ui.query = ''; return render(); }
    if (action === 'library-detail') { if (!items().some(i => i.id === target.dataset.id)) { info('没有已下载的当天安排','可以看书目占位；活动详情需先在审阅面板恢复有缓存的场景。'); return; } return routeToItem(target.dataset.id); }
    if (action === 'temporary') {
      if (!day || future()) return info('先查看当天安排','当前没有可编辑的当天安排。请切回今天场景，再体验临时开展。');
      const item = clone(fixture.day.items.find(i => i.id === target.dataset.id)); item.id = `temporary-${ui.temporary.length + 1}`; ui.temporary.push(item); return routeToItem(item.id);
    }
    if (action === 'book-info') return info('书目版本待核实','这里是“家中熟悉绘本”的文字占位。不会推断实际分册、书页、封面授权或点读笔兼容性。');
    if (action === 'add-book') return openSheet('book',{title:''});
    if (action === 'save-book') {
      if (!ui.draft.title.trim()) { ui.error = '请填写书名或占位名称。'; return renderSheet(); }
      ui.books.push(ui.draft.title.trim()); closeSheet(true); notice('书目已加入当前原型，版本仍待核实。'); return render();
    }
    if (action === 'stage-pending') return info('内容仍在准备中','当前只提供18～23月的一个支持示例。其他阶段不使用旧档位假装内容已经制作完成。');
    if (action === 'add-memory') return openSheet('memory',{text:'',firstTimeConfirmed:false,media:null});
    if (action === 'photo-placeholder') {
      if (state.photoPermission === 'denied') { ui.error = '相册权限未开启。可以继续保存文字；此处不打开真实系统设置。'; return renderSheet(); }
      ui.draft.media = {placeholder:true,state:'pending_upload',remoteVisible:false}; return renderSheet();
    }
    if (action === 'save-memory') {
      if (!ui.draft.text.trim() && !ui.draft.media) { ui.error = '写点什么，或添加照片占位后再保存。'; return renderSheet(); }
      ui.busy = true; ui.error = ''; renderSheet();
      return later(() => { ui.busy = false; if ($('#save-failure').checked) { $('#save-failure').checked = false; ui.error = '这次保存没有完成，填写的内容还在。'; return renderSheet(); } state.memoryRecords.push({...clone(ui.draft),addedBy:state.activeMemberId}); const hasPhoto = Boolean(ui.draft.media); closeSheet(true); notice(hasPhoto ? '成长记录已存到当前原型。照片仍是待上传占位。' : '文字成长记录已存到当前原型。'); render(); });
    }
    if (action === 'media-retry') { const memory = state.memoryRecords[Number(target.dataset.index)]; memory.media.state = 'pending_upload'; notice('已模拟重试，照片仍在本机等待上传；没有真实上传请求。'); return render(); }
    if (action === 'invite') return info('加入家庭方式仍待确认','邀请码、链接、扫码或部署配置都只是候选。本轮不创建账号、不发送邀请、不改变真实家庭权限。');
    if (action === 'permission-info') return info('系统设置入口说明','实际App需要跳到Android通知设置。浏览器原型只展示权限说明，不申请或修改系统权限。');
  });
  document.addEventListener('change',event => {
    const target = event.target;
    if (target.id === 'scenario') return applyScenario(target.value);
    if (target.id === 'member') { state.activeMemberId = target.value; notice(`已切换为${memberName(target.value)}，家庭记录保持共享（模拟）。`); return render(); }
    if (target.id === 'theme') { document.documentElement.dataset.theme = target.value; return; }
    if (target.id === 'font-scale') { document.documentElement.style.setProperty('--scale',target.value); return; }
    if (target.id === 'reminder-enabled') { state.reminder.enabled = target.checked; announce('提醒偏好已在当前原型中修改。'); return render(); }
    if (target.id === 'reminder-time') { state.reminder.time = target.value; announce('候选提醒时间已在当前原型中修改。'); return render(); }
    if (!ui.modal || !ui.draft) return;
    const focusName = target.name, focusValue = target.value;
    if (target.name === 'status') { ui.draft.status = target.value; ui.draft.feedback = null; renderSheet(); }
    if (target.name === 'feedback') ui.draft.feedback = target.value || null;
    if (target.name === 'participant') ui.draft.participantIds = [...$('#sheet').querySelectorAll('[name=participant]:checked')].map(i => i.value);
    if (target.name === 'replacement') ui.draft.choice = target.value;
    if (target.name === 'reason') ui.draft.reason = target.value;
    if (target.name === 'firstTime') ui.draft.firstTimeConfirmed = target.checked;
    if (target.name === 'status') [...$('#sheet').querySelectorAll('input')].find(i => i.name === focusName && i.value === focusValue)?.focus();
  });
  document.addEventListener('input',event => {
    if (!ui.draft) return;
    if (event.target.name === 'memoryText') ui.draft.text = event.target.value;
    if (event.target.name === 'bookTitle') ui.draft.title = event.target.value;
  });
  document.addEventListener('submit',event => {
    if (event.target.id === 'search-form') { event.preventDefault(); ui.query = new FormData(event.target).get('query').trim(); render(); return; }
    if (event.target.id !== 'measure-form') return;
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); ui.measureDraft = data;
    const invalid = [];
    if (!data.date || data.date > today()) invalid.push('date');
    if (!Number.isFinite(Number(data.value)) || Number(data.value) <= 0) invalid.push('value');
    if (!data.method) invalid.push('method');
    if (!invalid.length && (data.kind === 'weight') !== (data.method === '体重秤')) { invalid.push('kind','method'); ui.error = '体重请选择体重秤，身长/身高请选择对应的测量方法。'; }
    else if (invalid.length) ui.error = '请检查日期、正数数值和测量方法。';
    ui.measureInvalid = invalid;
    if (invalid.length) { render(); $('#measure-form').elements.namedItem(invalid[0])?.focus(); return; }
    ui.measurements.push(data); ui.error = ''; ui.measureInvalid = []; notice('已保存虚构测量记录；不计算参考百分位。'); render();
  });
  $('#sheet').addEventListener('cancel',event => { event.preventDefault(); closeSheet(); });
  window.addEventListener('popstate',event => { if (ui.modal) { closeSheet(); history.pushState({route:ui.route},'',`#${ui.route}`); return; } ui.route = event.state?.route || 'today'; ui.notice = ''; render(); });
  $('#scenario').innerHTML = fixture.scenarios.filter(s => scenarioLabels[s.id]).map(s => `<option value="${s.id}">${esc(scenarioLabels[s.id])}</option>`).join('');
  $('#member').innerHTML = fixture.family.members.map(m => `<option value="${m.id}">${esc(m.label)}</option>`).join('');
  if (matchMedia('(max-width:760px)').matches) $('#review-details').open = false;
  applyScenario('expanded_today');
})();
