/* BabyPlan 网页家长区低保真原型 W01—W08；只操作当前页面内存中的虚构数据。 */
(() => {
  'use strict';

  const fixture = window.BABYPLAN_FIXTURE;
  const screen = document.querySelector('#screen');
  if (!fixture) {
    screen.textContent = '演示数据未加载，请确认 ../mobile/fixture.js 可读取后重新打开原型。';
    return;
  }

  /* ---------- 基础工具 ---------- */

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const clone = value => (typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));

  const businessDate = fixture.businessDate;
  const futureDate = fixture.futureDaySample.date;
  const fixedClock = '2026-11-11（周三）15:00 · Asia/Shanghai';

  const pageCodes = {
    w01: 'W01',
    w02: 'W02',
    w03: 'W03',
    w04: 'W04',
    w05: 'W05',
    w06: 'W06',
    w07: 'W07',
    w08: 'W08'
  };

  const pageTitles = {
    w01: '连接与家庭选择',
    w02: '今天与本周',
    w03: '安排查看与调整',
    w04: '阶段路线',
    w05: '书架整理',
    w06: '成长档案',
    w07: '打印与导出',
    w08: '家庭与成员设置'
  };

  const navItems = [
    ['w01', '连接'],
    ['w02', '今天'],
    ['w03', '安排'],
    ['w04', '阶段'],
    ['w05', '书架'],
    ['w06', '成长'],
    ['w07', '打印'],
    ['w08', '家庭']
  ];

  const kindLabels = {
    movement: '亲子运动',
    exploration: '动手探索',
    reading: '中文共读',
    english: '英语互动',
    child_led: '共同游戏',
    replay: '熟悉内容复玩'
  };

  const typeLabels = {
    story: '小故事',
    photo: '照片',
    first: '第一次',
    quote: '原话',
    measurement: '测量'
  };

  const feedbackLabels = {
    want_again: '还想再玩',
    family_busy: '家里没空',
    child_tired: '孩子困了',
    time_unfit: '这个时段不方便'
  };

  const syncLabels = {
    pending: '已存本机 · 待同步',
    sending: '发送中（模拟）',
    failed: '同步失败 · 可重试',
    synced: '模拟同步已确认'
  };

  const connectionLabels = {
    connected: '已连接（模拟）',
    connecting: '连接中（模拟）',
    expired: '连接已失效',
    failed: '连接失败',
    not_joined: '账号未加入家庭'
  };

  const todayLabels = {
    ready: '正常',
    loading: '加载中',
    failed: '加载失败',
    empty: '空安排'
  };

  const weekDates = [
    { date: '2026-11-09', label: '周一' },
    { date: '2026-11-10', label: '周二' },
    { date: '2026-11-11', label: '周三' },
    { date: '2026-11-12', label: '周四' },
    { date: '2026-11-13', label: '周五' },
    { date: '2026-11-14', label: '周六' },
    { date: '2026-11-15', label: '周日' }
  ];

  const weekdayShort = {
    '2026-11-09': '周一',
    '2026-11-10': '周二',
    '2026-11-11': '周三',
    '2026-11-12': '周四',
    '2026-11-13': '周五',
    '2026-11-14': '周六',
    '2026-11-15': '周日'
  };

  const sourceKindLabels = {
    design_sample: '原创设计样本'
  };

  const T = {
    LOAD_W: '正在加载家庭内容…',
    ERR: '没有加载成功。请检查网络后重试。',
    CONNECT_ERR: '没有连接成功。请检查网络后重试。',
    PERM_ROLE: '当前账号没有这项权限。请回到上一页，或联系家庭/内容负责人。',
    PERM_FAMILY: '当前账号还没有加入这个家庭。请回到连接页面查看可用方式。',
    CONN_EXPIRED: '家庭服务连接已失效，请更新连接配置。本机内容会保留。',
    NO_SIGNUP: 'BabyPlan 暂不提供公开注册。请使用已有的家庭连接方式。',
    EMPTY_TODAY: '今天还没有安排。系统准备好后会显示在这里。',
    EMPTY_BOOKS: '书架还是空的。可以先把家里已有的书加进来。',
    EMPTY_GROWTH: '还没有成长记录。照片、第一次、原话和小故事都可以留在这里。',
    EMPTY_FILTER: '这个筛选下还没有内容。',
    EMPTY_STAGE: '这个阶段的内容还在准备中。可以先看已经收录的阶段。',
    OFFLINE_WEB: '当前没有网络。页面显示上次加载的内容；新的整理或记录不会保存到服务器。',
    OFFLINE_EMPTY: '还没有下载今天的安排，请联网后再试。',
    CONFLICT_RECORD: '这条记录已有更新。请先看看两边的不同，再决定保留哪一份。',
    MEDIA_PENDING: '照片已保存在本机，还没有上传；其他家庭成员暂时看不到。联网后可以重试上传。',
    PRINT_PENDING: '有照片还没有上传，不会出现在打印预览中。',
    ACTION_ERR: '这次操作没有完成。请重试；你填写的内容还在。',
    DISCARD: '这次修改还没有保存，确定离开？',
    SYNC_PENDING: '已保存在本机，等待同步。',
    PRINT_LOCAL: '打印预览只在当前设备上显示，不会生成或上传正式文件。',
    PRINT_EMPTY: '还没有选择要打印的内容。',
    PRINT_LOAD: '正在准备打印预览…',
    PRINT_FAIL: '打印预览没有准备好。请重试；已选择的内容不会丢失。',
    BUDGET: '这些是建议时间和大致时长，不是必须完成的任务。可以只做一段，也可以按孩子状态提前或顺延。',
    NO_SCORE: '这里记录的是家庭一起玩过什么，不是发育评分；没有记录不代表不会。',
    STAGE_DISCLAIMER: '这些是支持建议，不是发育评分；没有记录不代表不会。',
    MEASURE_DISCLAIMER: '测量记录只用于家庭自己查看；参考曲线和百分位需匹配年龄与来源，本轮不绘制、不计算。',
    FUTURE_READONLY: '这是还没到的日期，暂时只能查看，不能记录。',
    AUTO_LOCK: '后台不会自动重排已经开始或家长改过的内容。',
    EDITION_PENDING: '版本信息待核实。',
    ROLE_PENDING: '成员角色和权限还在确认中。',
    INVALID_VALUE: '请填写有效数值。'
  };

  const MUTATING_ACTIONS = new Set([
    'record',
    'adjust',
    'restore-adjust',
    'confirm-adjust',
    'confirm-restore',
    'resolve-local',
    'resolve-remote',
    'sync-now',
    'book-add',
    'book-edit',
    'book-shelf',
    'media-retry'
  ]);

  const announcement = $('#announcement');
  const modal = $('#modal');
  let state;

  /* ---------- 虚构数据与初始状态 ---------- */

  function seedBooks() {
    return fixture.books.map((book, index) => ({
      ...clone(book),
      id: book.id || `sample-book-${index + 1}`,
      shelf: 'owned',
      note: '',
      origin: '虚构样本书目',
      sync: 'local',
      simulationOnly: true
    }));
  }

  function seedGrowth() {
    const storyText = fixture.memoryDraft?.text || '今天把球轻轻推回来，抬头看着我。（原创虚构故事）';
    return [
      {
        id: 'growth-story-roll',
        type: 'story',
        date: businessDate,
        title: '把球轻轻推回来',
        text: storyText,
        addedBy: 'sample-parent-b',
        visible: '家庭成员可见（候选）',
        media: clone(fixture.memoryDraft?.media || {
          placeholder: true,
          state: 'pending_upload',
          remoteVisible: false
        }),
        simulationOnly: true
      },
      {
        id: 'growth-photo-roll',
        type: 'photo',
        date: businessDate,
        title: '照片占位：一起滚球',
        text: '这是一张虚构照片占位，没有真实图片。照片上传失败，文字仍保留。',
        addedBy: 'sample-parent-a',
        visible: '家庭成员可见（候选）',
        media: {
          placeholder: true,
          state: 'failed',
          remoteVisible: false
        },
        simulationOnly: true
      },
      {
        id: 'growth-first-roll',
        type: 'first',
        date: businessDate,
        title: '第一次把球滚回来',
        text: '家长确认：这是第一次在提示后把球推回来。第一次由家长确认，不由一次参与自动推断。',
        addedBy: 'sample-parent-a',
        visible: '家庭成员可见（候选）',
        firstTimeConfirmed: true,
        simulationOnly: true
      },
      {
        id: 'growth-quote-bear',
        type: 'quote',
        date: businessDate,
        title: '孩子原话（原创虚构）',
        text: '“还要，看小熊。”',
        addedBy: 'sample-parent-b',
        visible: '家庭成员可见（候选）',
        simulationOnly: true
      },
      {
        id: 'growth-story-basket',
        type: 'story',
        date: '2026-11-09',
        title: '毛巾进篮子',
        text: '把方巾放进篮子，又拿出来。（原创虚构故事）',
        addedBy: 'sample-parent-a',
        visible: '家庭成员可见（候选）',
        simulationOnly: true
      },
      {
        id: 'growth-measure-height',
        type: 'measurement',
        date: businessDate,
        title: '身高测量（家庭记录）',
        text: '',
        addedBy: 'sample-parent-a',
        visible: '家庭成员可见（候选）',
        value: 82.5,
        unit: 'cm',
        method: '卧位身长（候选）',
        source: '家中测量（候选）',
        referenceStandard: null,
        percentile: null,
        simulationOnly: true
      }
    ];
  }

  function createPrintState() {
    const firstItemId = fixture.day.items[0]?.id;
    return {
      arrangement: firstItemId ? { [firstItemId]: true } : {},
      stage: false,
      growth: {},
      allGrowth: false,
      preview: null,
      previewBusy: false,
      previewError: '',
      generation: 0
    };
  }

  function createState() {
    return {
      route: 'w01',
      memberId: fixture.initialState.activeMemberId,
      selectedItemId: fixture.initialState.selectedItemId || fixture.day.items[0]?.id || '',
      selectedDate: businessDate,
      review: {
        today: 'ready',
        connection: 'connected',
        network: 'online',
        failure: false,
        readOnly: false,
        conflict: false
      },
      connectionError: '',
      records: {},
      syncs: {},
      adjustments: {},
      books: seedBooks(),
      growth: [],
      bookFilter: 'all',
      growthType: 'all',
      growthFrom: '',
      growthTo: '',
      growthDateError: '',
      print: createPrintState(),
      notice: '',
      focusTarget: '',
      dialog: null
    };
  }

  /* ---------- 派生数据 ---------- */

  const memberName = id => fixture.family.members.find(member => member.id === id)?.label || '家长（虚构）';
  const participants = ids => (ids || []).map(memberName).join('、');
  const isOffline = () => state.review.network === 'offline';
  const isReadOnly = () => state.review.readOnly;
  const hasFamilyAccess = () => state.review.connection === 'connected';
  const hasUnuploadedPhotos = () => state.growth.some(record => record.media && record.media.state !== 'uploaded');

  function itemById(id) {
    return fixture.day.items.find(item => item.id === id)
      || fixture.futureDaySample.items.find(item => item.id === id)
      || null;
  }

  function displayItem(id) {
    const base = itemById(id);
    if (!base) return null;
    const adjustment = state.adjustments[id];
    if (adjustment?.type === 'replace' && adjustment.item) {
      return { ...clone(adjustment.item), id };
    }
    if (adjustment?.type === 'shorten') {
      return { ...clone(base), budgetMinutes: adjustment.minutes };
    }
    return base;
  }

  function segmentFor(item) {
    return fixture.day.segments.find(segment => segment.id === item?.segmentId) || null;
  }

  function itemTitle(id) {
    return displayItem(id)?.title || '家庭记录';
  }

  function adjustmentTag(adjustment) {
    if (!adjustment) return '';
    if (adjustment.type === 'replace') return tag('已换项（本地）');
    if (adjustment.type === 'shorten') return tag(`已缩短为约 ${adjustment.minutes} 分钟（本地）`);
    if (adjustment.type === 'skip') return tag('安排已跳过（本地）');
    return '';
  }

  function statusLabel(id) {
    if (state.review.conflict && id === fixture.conflictSample.itemId) return '双方记录待确认';
    const record = state.records[id];
    if (record) return record.status === 'played' ? '一起玩了' : '今天跳过';
    if (state.adjustments[id]?.type === 'skip') return '安排已跳过（本地）';
    return '未记录';
  }

  function syncTag(id) {
    const sync = state.syncs[id];
    return sync ? tag(syncLabels[sync] || sync) : '';
  }

  function isConflictActive(id = fixture.conflictSample.itemId) {
    return state.review.conflict && id === fixture.conflictSample.itemId;
  }

  function weekDayInfo(date) {
    if (date === businessDate) {
      return { kind: 'full', short: '完整样本', detail: '三段 · 多个内容块' };
    }
    if (date === futureDate) {
      return { kind: 'future', short: '未来单项', detail: '单项只读样本' };
    }
    return { kind: 'none', short: '未提供', detail: '没有样本内容' };
  }

  function filteredBooks() {
    return state.books.filter(book => state.bookFilter === 'all' || book.shelf === state.bookFilter);
  }

  function filteredGrowth() {
    return state.growth
      .filter(record => state.growthType === 'all' || record.type === state.growthType)
      .filter(record => !state.growthFrom || record.date >= state.growthFrom)
      .filter(record => !state.growthTo || record.date <= state.growthTo)
      .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title, 'zh-CN'));
  }

  function printableGrowth() {
    return state.growth.filter(record => record.type !== 'photo');
  }

  function collectPrintSelection() {
    const arrangementIds = fixture.day.items
      .filter(item => state.print.arrangement[item.id])
      .map(item => item.id);
    const growthIds = (state.print.allGrowth
      ? printableGrowth()
      : printableGrowth().filter(record => state.print.growth[record.id]))
      .map(record => record.id);
    return {
      arrangementIds,
      stage: Boolean(state.print.stage),
      growthIds,
      count: arrangementIds.length + (state.print.stage ? 1 : 0) + growthIds.length
    };
  }

  /* ---------- 通用片段 ---------- */

  function announce(message) {
    announcement.textContent = '';
    window.setTimeout(() => {
      announcement.textContent = message;
    }, 30);
  }

  function setNotice(message) {
    state.notice = message;
    announce(message);
  }

  function tag(text, extra = '') {
    return `<span class="tag ${esc(extra)}">${esc(text)}</span>`;
  }

  function actionButton(label, action, options = {}) {
    const readOnlyBlocked = MUTATING_ACTIONS.has(action) && isReadOnly();
    const disabled = Boolean(options.disabled || readOnlyBlocked);
    const reasonId = options.reasonId || (readOnlyBlocked ? 'readonly-note' : '');
    const reasonText = options.reasonText || (readOnlyBlocked ? T.PERM_ROLE : '');
    return `<button type="button" class="button ${esc(options.variant || '')}" data-action="${esc(action)}" ${options.attrs || ''} ${disabled ? 'disabled' : ''} ${reasonId ? `aria-describedby="${esc(reasonId)}"` : ''} ${reasonText ? `title="${esc(reasonText)}"` : ''}>${label}</button>`;
  }

  function pageIntro(code, title, lead = '') {
    return `<header class="page-intro"><p class="eyebrow">${esc(code)} · 网页家长区 · 扩展原型（未合同化）</p><h1 id="page-title" tabindex="-1">${esc(title)}</h1>${lead ? `<p class="lead">${esc(lead)}</p>` : ''}</header>`;
  }

  function readOnlyBanner() {
    if (!isReadOnly()) return '';
    return `<div class="banner" id="readonly-note" role="status"><strong>当前为只读权限（模拟）</strong><p>${esc(T.PERM_ROLE)}</p></div>`;
  }

  function networkBanner() {
    if (!isOffline()) return '';
    return `<div class="banner" role="status"><strong>当前没有网络</strong><p>${esc(T.OFFLINE_WEB)}</p></div>`;
  }

  function conflictBanner() {
    if (!state.review.conflict) return '';
    return `<div class="banner" id="conflict-summary"><strong>这条记录已有更新</strong><p>${esc(T.CONFLICT_RECORD)}</p><div class="actions">${actionButton('查看双方内容', 'open-conflict', { variant: 'primary' })}</div></div>`;
  }

  function syncBanner() {
    const pending = Object.entries(state.syncs).filter(([, sync]) => sync !== 'synced');
    if (!pending.length) return '';
    return `<div class="banner"><strong>有本机记录尚未同步</strong><p>${esc(T.SYNC_PENDING)}</p><div class="actions">${actionButton('查看同步状态', 'open-sync')}</div></div>`;
  }

  function noticeBanner() {
    if (!state.notice) return '';
    return `<div class="banner notice-banner" role="status"><p>${esc(state.notice)}</p>${actionButton('收起', 'dismiss-notice', { variant: 'text' })}</div>`;
  }

  function recordSummary(record) {
    if (!record) return '';
    return `<p class="record-line note"><strong>记录：</strong>${esc(record.status === 'played' ? '一起玩了' : '今天跳过')}<br>陪伴：${esc(participants(record.participantIds))}<br>添加：${esc(memberName(record.addedBy))}${record.feedback ? `<br>反馈：${esc(feedbackLabels[record.feedback] || record.feedback)}` : ''}</p>`;
  }

  function sourceList(sources) {
    if (!sources?.length) return '<p class="note">来源说明待补充。</p>';
    return sources.map(source => {
      const kind = sourceKindLabels[source.kind] || '来源';
      return `<p class="source-line"><span class="tag">${esc(kind)}</span> ${esc(source.title)}</p>`;
    }).join('');
  }

  function itemContentHtml(item, options = {}) {
    if (!item) return '';
    const includeWhy = options.includeWhy !== false;
    const dialogueLabels = {
      opening: '开始时',
      whenJoins: '孩子跟着玩',
      whenWatches: '孩子只是看',
      whenStops: '孩子想停'
    };
    let html = '';

    if (includeWhy) {
      html += `<section class="section"><h2>为什么这样安排</h2><p>${esc(`候选安排：${segmentFor(item)?.label || '当天'}，约 ${item.budgetMinutes} 分钟。编排理由和替换规则仍待评审；可按孩子状态提前结束或调整。`)}</p></section>`;
    }

    html += `<section class="section"><h2>准备什么</h2>${item.materials?.length ? `<ul>${item.materials.map(material => `<li>${esc(material)}</li>`).join('')}</ul>` : '<p>不用道具。</p>'}</section>`;

    if (item.steps?.length) {
      html += `<section class="section"><h2>怎么玩</h2><ol>${item.steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol></section>`;
    }

    if (item.dialogue && Object.keys(item.dialogue).length) {
      html += `<section class="section"><h2>家长可以这样说</h2>${Object.entries(item.dialogue).map(([key, text]) => `<div class="dialogue"><h3>${esc(dialogueLabels[key] || key)}</h3><p>“${esc(text)}”</p></div>`).join('')}</section>`;
    }

    if (item.english?.length) {
      html += `<section class="section"><h2>顺口说一句英文</h2><p class="note">原创话术；看、指和动作都可以回应，不要求跟读。</p>${item.english.map(line => `<div class="english-line"><h3 lang="en">${esc(line.line)}</h3><p>${esc(line.meaningZh)}</p><p class="note">什么时候：${esc(line.when)}<br>配合动作：${esc(line.action)}</p></div>`).join('')}</section>`;
    }

    html += `<section class="section"><h2>安全提示</h2><p>${esc(item.safety || '安全说明待补充。')}</p></section>`;
    html += `<section class="section"><h2>来源与内容说明</h2>${sourceList(item.sources)}<p class="note">原创虚构样本，尚未完成正式内容审阅；不代表适龄、安全或来源审核已经通过。</p></section>`;
    return html;
  }

  function chosenRadio(name, value, label, checked, disabled = false) {
    return `<label class="choice"><input type="radio" name="${esc(name)}" value="${esc(value)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span>${esc(label)}</span></label>`;
  }

  function chosenCheckbox(name, value, label, checked, disabled = false) {
    return `<label class="choice"><input type="checkbox" name="${esc(name)}" value="${esc(value)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span>${esc(label)}</span></label>`;
  }

  function mediaPlaceholder(media) {
    if (!media) return '';
    const stateText = media.state === 'failed'
      ? '照片占位 · 上传失败'
      : media.state === 'uploaded'
        ? '照片占位 · 已上传（模拟）'
        : '照片占位 · 待上传';
    return `<div class="placeholder" role="img" aria-label="照片占位，不是真实照片"><span>${esc(stateText)}<br>不是真实照片</span></div>`;
  }

  function mediaNote(record) {
    if (!record.media) return '';
    if (record.media.state === 'failed') {
      return `<div class="banner error"><strong>照片上传失败</strong><p>文字已保留；照片仍在本机待上传，其他成员暂时看不到，打印时也会排除。</p></div>`;
    }
    if (record.media.state === 'uploaded') {
      return '<p class="note">照片已上传（模拟），其他成员可见范围仍待确认。</p>';
    }
    return `<p class="banner"><strong>照片待上传</strong><p>${esc(T.MEDIA_PENDING)}</p><p class="note">打印只包含文字，照片会排除。</p></div>`;
  }

  /* ---------- 渲染入口与外壳 ---------- */

  function render() {
    const content = state.route === 'w01'
      ? pageW01()
      : (!hasFamilyAccess() ? connectionGate() : (pages[state.route] || pageW01)());
    screen.innerHTML = `<div class="page">${noticeBanner()}${content}</div>`;
    updateHeader();
    updateReviewMeta();
    document.body.classList.toggle('has-print-preview', Boolean(state.print.preview));

    const target = state.focusTarget;
    state.focusTarget = '';
    if (target) {
      window.requestAnimationFrame(() => {
        const element = document.querySelector(target);
        if (!element) return;
        element.focus({ preventScroll: true });
        element.scrollIntoView({ block: 'start', behavior: 'auto' });
      });
    }
  }

  function updateHeader() {
    const status = $('.header-status');
    status.innerHTML = `
      <span class="chip">${esc(memberName(state.memberId))}</span>
      <button type="button" class="chip chip-button" data-action="nav" data-route="w01">${esc(connectionLabels[state.review.connection] || connectionLabels.connected)}</button>
      ${isReadOnly() ? '<span class="chip">只读权限</span>' : ''}
      <span class="chip">18～23月</span>
    `;
    $('#primary-nav').innerHTML = navItems.map(([route, label]) => `<button type="button" class="nav-button" data-action="nav" data-route="${esc(route)}" ${state.route === route ? 'aria-current="page"' : ''}>${esc(label)}</button>`).join('');
  }

  function updateReviewMeta() {
    $('#review-page-code').textContent = `${pageCodes[state.route]} · ${pageTitles[state.route]}`;
    $('#review-clock').textContent = fixedClock;
    const extras = [
      isReadOnly() ? '只读权限' : '',
      state.review.conflict ? '记录冲突' : '',
      state.review.failure ? '下一次失败已选' : ''
    ].filter(Boolean);
    $('#review-state-summary').textContent = [
      `连接：${connectionLabels[state.review.connection]}`,
      `今天：${todayLabels[state.review.today]}`,
      `网络：${isOffline() ? '离线' : '在线'}`,
      ...extras
    ].join(' · ');
    syncReviewControls();
  }

  function syncReviewControls() {
    const setValue = (id, value) => {
      const element = document.getElementById(id);
      if (element && element.value !== value) element.value = value;
    };
    const setChecked = (id, checked) => {
      const element = document.getElementById(id);
      if (element) element.checked = checked;
    };
    setValue('review-connection', state.review.connection);
    setValue('review-today', state.review.today);
    setValue('review-member', state.memberId);
    setValue('review-theme', document.documentElement.dataset.theme || 'light');
    setValue('review-font', document.documentElement.dataset.fontScale || '1');
    setChecked('review-network', isOffline());
    setChecked('review-conflict', state.review.conflict);
    setChecked('review-readonly', isReadOnly());
    setChecked('review-failure', state.review.failure);
  }

  function connectionGate() {
    const code = pageCodes[state.route];
    const title = pageTitles[state.route];
    let message = T.CONNECT_ERR;
    let detail = '页面没有加载家庭内容，避免把连接失败画成空状态。';
    if (state.review.connection === 'connecting') {
      message = T.LOAD_W;
      detail = '连接结果尚未返回，请稍候或回到连接页查看。';
    } else if (state.review.connection === 'expired') {
      message = T.CONN_EXPIRED;
      detail = '本机内容会保留；更新连接配置后再查看家长区。';
    } else if (state.review.connection === 'not_joined') {
      message = T.PERM_FAMILY;
      detail = '不提供公开注册；加入方式仍在确认中。';
    } else if (state.review.connection === 'failed') {
      message = state.connectionError || T.CONNECT_ERR;
    }
    return `${pageIntro(code, title)}<div class="empty-state"><h2>家庭内容暂不可用</h2><p>${esc(message)}</p><p class="note">${esc(detail)}</p><div class="actions">${actionButton('去连接与家庭选择', 'nav', { attrs: 'data-route="w01"', variant: 'primary' })}</div></div>`;
  }

  /* ---------- W01 连接与家庭选择 ---------- */

  function pageW01() {
    const connection = state.review.connection;
    let html = pageIntro('W01', '连接与家庭选择', '本轮假定家长网页已连接到虚构家庭；这里主要演示连接失效、账号未加入家庭和恢复路径，不展开完整登录、加入或账号恢复表单。');
    html += networkBanner();

    if (connection === 'connected') {
      html += `<div class="banner"><strong>已连接虚构演示家庭（模拟）</strong><p>家长甲和家长乙共用同一份家庭安排。当前成员：${esc(memberName(state.memberId))}。成员切换只改变当前添加者，不改变已有记录的添加者与陪伴者。</p></div>`;
      html += `<section class="card"><h2>虚构演示家庭</h2><p>孩子：18～23月；生日未提供，不推断具体月龄。</p><p class="note">家庭成员：${fixture.family.members.map(member => esc(member.label)).join('、')}。不固定爸爸妈妈的分工。</p><div class="actions">${actionButton('进入家长区', 'nav', { attrs: 'data-route="w02"', variant: 'primary' })}${actionButton('查看今天与本周', 'nav', { attrs: 'data-route="w02"' })}</div></section>`;
    } else if (connection === 'connecting') {
      html += `<div class="loading-state" aria-busy="true"><h2>${esc(T.LOAD_W)}</h2><p class="note">加载结果尚未返回，不代表没有家庭内容。</p><div class="actions"><button type="button" class="button" disabled>连接中…</button>${actionButton('模拟完成连接', 'connect-retry')}</div></div>`;
    } else if (connection === 'expired') {
      html += `<div class="banner error"><strong>家庭连接已失效</strong><p>${esc(T.CONN_EXPIRED)}</p><div class="actions">${actionButton('更新连接配置（模拟）', 'connect-update', { variant: 'primary' })}${actionButton('重试连接（模拟）', 'connect-retry')}</div></div>`;
    } else if (connection === 'not_joined') {
      html += `<div class="banner error"><strong>账号未加入家庭</strong><p>${esc(T.PERM_FAMILY)}</p><p class="note">不显示公开注册，也不提供可点却不可用的加入操作。邀请码、链接、扫码和部署配置均只是候选方式。</p><div class="actions">${actionButton('重新检查已有连接（模拟）', 'connect-retry', { variant: 'primary' })}${actionButton('查看加入候选说明', 'join-methods')}</div></div>`;
    } else {
      html += `<div class="banner error"><strong>连接失败</strong><p>${esc(state.connectionError || T.CONNECT_ERR)}</p><div class="actions">${actionButton('重试连接（模拟）', 'connect-retry', { variant: 'primary' })}${actionButton('更新连接配置（模拟）', 'connect-update')}</div></div>`;
    }

    html += `<section class="section"><h2>连接说明</h2><p>${esc(T.NO_SIGNUP)}</p><p class="note">加入方式仍在确认中；本轮不创建账号、不输入凭证、不发送邀请。内容管理区使用独立入口和角色，家长区不显示发布、审核或撤回操作。</p><div class="actions">${actionButton('查看加入候选说明', 'join-methods')}</div></section>`;
    return html;
  }

  /* ---------- W02 今天与本周 ---------- */

  function pageW02() {
    let html = pageIntro('W02', '今天，一起玩一会儿', T.BUDGET);
    html += `<p class="date-line">${esc(businessDate)}（${esc(weekdayShort[businessDate])}） · 固定时钟 15:00 · 家庭时区 ${esc(fixture.timezone)}</p>`;
    html += readOnlyBanner();
    html += networkBanner();
    html += conflictBanner();
    html += syncBanner();

    if (state.review.today === 'loading') {
      return html + `<div class="loading-state" aria-busy="true"><h2>${esc(T.LOAD_W)}</h2><p class="note">加载结果尚未返回，不代表今天没有内容。</p></div>`;
    }

    if (state.review.today === 'failed') {
      html += `<div class="banner"><h2>没有加载成功</h2><p>${esc(T.ERR)}</p><p class="note">下面保留上次加载的内容，不代表已经获取最新安排。</p><div class="actions">${actionButton('重试（模拟）', 'today-retry', { variant: 'primary' })}</div></div>`;
    }

    if (state.review.today === 'empty') {
      const message = isOffline() ? T.OFFLINE_EMPTY : T.EMPTY_TODAY;
      return html + `<div class="empty-state"><h2>${esc(isOffline() ? '还没有下载今天的安排' : '今天还没有安排')}</h2><p>${esc(message)}</p><p class="note">不会自动编造已发布内容。可以先去书架看看家里已有的书。</p><div class="actions">${isOffline() ? actionButton('模拟恢复网络', 'restore-network', { variant: 'primary' }) : actionButton('重新加载（模拟）', 'today-retry', { variant: 'primary' })}${actionButton('查看书架', 'nav', { attrs: 'data-route="w05"' })}</div></div>`;
    }

    if (!fixture.day.items.some(item => item.id === state.selectedItemId)) {
      state.selectedItemId = fixture.day.items[0]?.id || '';
    }

    const selectedItem = displayItem(state.selectedItemId);
    html += `<div class="split"><section aria-label="今天的安排">${segmentsHtml()}</section><aside class="detail-panel" aria-label="内容详情">${detailHtml(selectedItem)}</aside></div>`;
    html += weekSummary();
    html += '<p class="note">原创虚构安排；适龄、安全与来源仍需正式内容审阅。没有总完成度、倒计时或连续奖励。</p>';
    return html;
  }

  function segmentsHtml() {
    return fixture.day.segments.map((segment, index) => {
      const list = fixture.day.items.filter(item => item.segmentId === segment.id);
      if (!list.length) return '';
      const heading = `<div class="segment-head"><h2><span class="letter">${esc(['A', 'B', 'C'][index] || '')}</span>${esc(segment.label)}</h2><p class="note">${esc(segment.window)} · 候选预算约 ${esc(segment.budgetMinutes)} 分钟</p></div>`;
      const cards = list.map(itemCard).join('');
      const dinner = index === 0 ? '<div class="dinner">17:30 左右 · 晚饭与洗漱<br>不计入亲子互动预算，不在饭桌上安排教学。</div>' : '';
      return `<section class="segment">${heading}${cards}${dinner}</section>`;
    }).join('');
  }

  function itemCard(item) {
    const display = displayItem(item.id) || item;
    const record = state.records[item.id];
    const adjustment = state.adjustments[item.id];
    const selected = item.id === state.selectedItemId;
    const materials = display.materials?.length ? display.materials.join('、') : '不用道具';
    return `<article class="card item-card ${selected ? 'is-selected' : ''}" id="item-card-${esc(item.id)}">
      <div class="tag-row">${tag(kindLabels[item.kind] || '亲子活动')}${tag(`${display.budgetMinutes} 分钟 · 可调整`)}${adjustmentTag(adjustment)}</div>
      <button type="button" class="item-open" data-action="select-item" data-id="${esc(item.id)}" ${selected ? 'aria-current="true"' : ''}>
        <span class="item-title">${esc(display.title)}</span>
        <span class="item-arrow" aria-hidden="true">查看详情 →</span>
      </button>
      <p class="note">准备：${esc(materials)}</p>
      <div class="tag-row">${tag(statusLabel(item.id))}${syncTag(item.id)}${isConflictActive(item.id) ? tag('双方记录待确认') : ''}</div>
      ${recordSummary(record)}
    </article>`;
  }

  function detailHtml(item) {
    if (!item) return '<div class="empty-state"><h2>这项内容暂时找不到了</h2><p>返回今天或重新加载后再试。</p></div>';
    const record = state.records[item.id];
    const adjustment = state.adjustments[item.id];
    const conflict = isConflictActive(item.id);
    let html = `<div class="detail-head"><p class="eyebrow">内容详情</p><h2 id="detail-title" tabindex="-1">${esc(item.title)}</h2><div class="tag-row">${tag(kindLabels[item.kind] || '亲子活动')}${tag(`${item.budgetMinutes} 分钟 · 可调整`)}${adjustmentTag(adjustment)}${tag(statusLabel(item.id))}${syncTag(item.id)}</div></div>`;

    if (conflict) {
      html += `<div class="banner"><strong>这条记录已有更新</strong><p>${esc(T.CONFLICT_RECORD)}</p><div class="actions">${actionButton('查看双方内容', 'open-conflict', { variant: 'primary' })}</div></div>`;
    }

    if (adjustment) {
      html += `<div class="banner"><strong>当前调整</strong><p>${esc(adjustmentText(adjustment))}</p><p class="note">已有参与记录会保留；后台不会自动重排这一项。</p><div class="actions">${actionButton('恢复原安排', 'restore-adjust', { attrs: `data-id="${esc(item.id)}"` })}</div></div>`;
    }

    html += itemContentHtml(item);
    if (record) html += `<section class="section"><h2>参与记录</h2>${recordSummary(record)}</section>`;
    if (record || adjustment) html += `<p class="auto-lock">${esc(T.AUTO_LOCK)}</p>`;

    html += `<div class="actions">
      ${actionButton(record ? '修改记录' : '记录参与', 'record', { attrs: `data-id="${esc(item.id)}"`, variant: 'primary' })}
      ${actionButton('调整安排', 'adjust', { attrs: `data-id="${esc(item.id)}"` })}
      ${adjustment ? actionButton('恢复原安排', 'restore-adjust', { attrs: `data-id="${esc(item.id)}"` }) : ''}
      ${conflict ? actionButton('查看双方内容', 'open-conflict') : ''}
    </div>`;
    return html;
  }

  function adjustmentText(adjustment) {
    if (!adjustment) return '';
    if (adjustment.type === 'replace') return `已换为「${adjustment.title}」（本地模拟）。`;
    if (adjustment.type === 'shorten') return `已缩短为约 ${adjustment.minutes} 分钟（本地模拟）。`;
    if (adjustment.type === 'skip') return `今天跳过这一项（本地模拟${adjustment.reason ? `，原因：${adjustment.reason}` : ''}）。`;
    return '';
  }

  function weekSummary() {
    const days = weekDates.map(day => {
      const info = weekDayInfo(day.date);
      return `<button type="button" class="week-day" data-action="select-week-date" data-date="${esc(day.date)}" aria-pressed="${day.date === state.selectedDate}"><span class="day-name">${esc(day.label)}</span><span>${esc(day.date.slice(5))}</span><span class="state ${info.kind === 'none' ? 'unavailable' : ''}">${esc(info.short)}</span></button>`;
    }).join('');
    return `<section class="section"><div class="page-head-row"><h2>本周</h2>${actionButton('查看周安排', 'nav', { attrs: 'data-route="w03"' })}</div><p class="note">本周只展示样本中实际存在的日期；其他日期不会复制 11 月 11 日的安排来假装完整一周。</p><div class="week-strip" aria-label="本周日期">${days}</div></section>`;
  }

  /* ---------- W03 安排查看与调整 ---------- */

  function pageW03() {
    let html = pageIntro('W03', '安排查看与调整', '周视图按段和内容块展示现有样本。换项、缩短、跳过和恢复都只是本地候选机制，确认后才改变这一项。');
    html += readOnlyBanner();
    html += networkBanner();
    html += conflictBanner();

    if (state.review.today === 'loading') {
      return html + `<div class="loading-state" aria-busy="true"><h2>${esc(T.LOAD_W)}</h2><p class="note">加载结果尚未返回，不代表这一周没有内容。</p></div>`;
    }
    if (state.review.today === 'failed') {
      html += `<div class="banner"><h2>没有加载成功</h2><p>${esc(T.ERR)}</p><p>下面保留上次加载的安排。</p><div class="actions">${actionButton('重试（模拟）', 'today-retry', { variant: 'primary' })}</div></div>`;
    }
    if (state.review.today === 'empty') {
      return html + `<div class="empty-state"><h2>这一周还没有安排</h2><p>${esc(isOffline() ? T.OFFLINE_EMPTY : '系统准备好后会显示在这里。')}</p>${actionButton('重新加载（模拟）', 'today-retry')}</div>`;
    }

    const days = weekDates.map(day => {
      const info = weekDayInfo(day.date);
      return `<button type="button" class="week-card" data-action="select-week-date" data-date="${esc(day.date)}" aria-pressed="${day.date === state.selectedDate}"><span class="date">${esc(day.label)} ${esc(day.date.slice(5))}</span><span class="state ${info.kind === 'none' ? 'unavailable' : ''}">${esc(info.short)}<br>${esc(info.detail)}</span></button>`;
    }).join('');

    html += `<div class="week-grid" aria-label="一周安排">${days}</div>`;
    html += '<p class="week-note">周视图只展示样本中确实存在的日期；未提供日期不是“产品没有安排”，也没有复制 11 月 11 日。未来 11 月 12 日只有一个只读样本项。</p>';
    html += selectedDayHtml();
    return html;
  }

  function selectedDayHtml() {
    const date = state.selectedDate;
    const info = weekDayInfo(date);
    let html = `<section class="section"><div class="page-head-row"><h2 id="selected-day-title" tabindex="-1">${esc(date)}（${esc(weekdayShort[date] || '')}）</h2>${tag(info.short)}</div>`;

    if (info.kind === 'full') {
      html += `<p class="note">完整样本日：三段共 ${esc(fixture.day.items.length)} 个内容块。可调整单项，已开展或已改过的项不会被后台自动重排。</p>`;
      html += fixture.day.segments.map((segment, index) => {
        const list = fixture.day.items.filter(item => item.segmentId === segment.id);
        if (!list.length) return '';
        return `<section class="segment"><div class="segment-head"><h2><span class="letter">${esc(['A', 'B', 'C'][index] || '')}</span>${esc(segment.label)}</h2><p class="note">${esc(segment.window)} · 候选预算约 ${esc(segment.budgetMinutes)} 分钟</p></div>${list.map(weekItem).join('')}</section>`;
      }).join('');
    } else if (info.kind === 'future') {
      html += `<div class="banner"><strong>未来日期 · 只读</strong><p>${esc(T.FUTURE_READONLY)}</p></div>`;
      html += fixture.futureDaySample.items.map(item => `<article class="card"><div class="tag-row">${tag(kindLabels[item.kind] || '亲子活动')}${tag(`${esc(item.budgetMinutes)} 分钟`)}${tag('未来只读样本')}</div><h3>${esc(item.title)}</h3>${itemContentHtml(item)}</article>`).join('');
      html += '<p class="note">这个未来样本只有一个内容块，不是已生成的完整明日计划。</p>';
    } else {
      html += `<div class="empty-state"><h2>这个日期没有提供样本内容</h2><p>未提供不等于产品没有安排；原型没有复制其他日期来填充。</p><div class="actions">${actionButton('回到 11 月 11 日样本', 'select-week-date', { attrs: `data-date="${esc(businessDate)}"`, variant: 'primary' })}</div></div>`;
    }

    return html + '</section>';
  }

  function weekItem(item) {
    const display = displayItem(item.id) || item;
    const record = state.records[item.id];
    const adjustment = state.adjustments[item.id];
    const materials = display.materials?.length ? display.materials.join('、') : '不用道具';
    return `<article class="card">
      <div class="tag-row">${tag(kindLabels[item.kind] || '亲子活动')}${tag(`${display.budgetMinutes} 分钟 · 可调整`)}${adjustmentTag(adjustment)}${tag(statusLabel(item.id))}${syncTag(item.id)}</div>
      <h3>${esc(display.title)}</h3>
      <p class="note">${esc(segmentFor(item)?.label || '当天')} · 18～23月（产品编排区间） · 准备：${esc(materials)}</p>
      <p class="note">安排说明：候选安排，理由与编排规则仍待评审；可按孩子状态提前结束。</p>
      <p><strong>安全提示：</strong>${esc(display.safety || '安全说明待补充。')}</p>
      <p class="note">来源：${sourceList(display.sources)}</p>
      ${record ? recordSummary(record) : ''}
      ${record || adjustment ? `<p class="auto-lock">${esc(T.AUTO_LOCK)}</p>` : ''}
      <div class="actions">
        ${actionButton('查看详情与记录', 'open-item', { attrs: `data-id="${esc(item.id)}"`, variant: 'primary' })}
        ${actionButton('调整安排', 'adjust', { attrs: `data-id="${esc(item.id)}"` })}
        ${adjustment ? actionButton('恢复原安排', 'restore-adjust', { attrs: `data-id="${esc(item.id)}"` }) : ''}
      </div>
    </article>`;
  }

  /* ---------- W04 阶段路线 ---------- */

  function pageW04() {
    const guide = fixture.stageGuideSample;
    let html = pageIntro('W04', '阶段路线', '按 18～23、24～29、30～35 月和 36 月总结展示。当前只有一份七段结构的支持示例，其他阶段允许显示待补。');
    html += networkBanner();
    html += `<div class="banner"><strong>${esc(T.STAGE_DISCLAIMER)}</strong><p>阶段区间是产品编排，不是官方逐月标准；本页不显示评分、达标、能力等级或筛查结论。</p></div>`;
    html += `<div class="stage-list">
      <details class="stage-band current" open>
        <summary><span>18～23月 · 当前示例</span><span>七段结构</span></summary>
        <div class="seven-grid">
          <div class="seven-item"><h3>1. 关注方向</h3><p>${esc(guide.focus)}</p></div>
          <div class="seven-item"><h3>2. 生活中的表现</h3><p>${esc(guide.everydayExample)}</p></div>
          <div class="seven-item"><h3>3. 父母支持方式</h3><p>${esc(guide.parentSupport)}</p></div>
          <div class="seven-item"><h3>4. 两三个玩法</h3><ul>${guide.playIdeas.map(idea => `<li>${esc(idea)}</li>`).join('')}</ul></div>
          <div class="seven-item"><h3>5. 更容易版本</h3><p>${esc(guide.easierVersion)}</p></div>
          <div class="seven-item"><h3>6. 可选下一步</h3><p>${esc(guide.optionalNextStep)}</p></div>
          <div class="seven-item"><h3>7. 来源与年龄节点</h3><p>${esc(guide.source.title)}</p><p class="note">来源地址（仅文字，不打开外链）：${esc(guide.source.url)}</p><p class="note">${esc(guide.source.boundary)}</p></div>
        </div>
        <div class="actions">${actionButton('加入打印选择并查看', 'print-stage', { variant: 'primary' })}${actionButton('去打印与导出', 'nav', { attrs: 'data-route="w07"' })}</div>
      </details>
      <details class="stage-band"><summary><span>24～29月</span><span>内容待补</span></summary><p>${esc(T.EMPTY_STAGE)}</p><p class="note">不使用旧月龄档假装新阶段内容已经制作完成。</p></details>
      <details class="stage-band"><summary><span>30～35月</span><span>内容待补</span></summary><p>${esc(T.EMPTY_STAGE)}</p></details>
      <details class="stage-band"><summary><span>36月阶段总结</span><span>内容待补</span></summary><p>${esc(T.EMPTY_STAGE)}</p></details>
    </div>`;
    html += `<p class="note section">${esc(T.NO_SCORE)}</p>`;
    return html;
  }

  /* ---------- W05 书架整理 ---------- */

  function pageW05() {
    let html = pageIntro('W05', '书架整理', '整理家中已有和想读的书目，优先使用家里已有的书。版本、封面、分册和点读兼容性都不推断。');
    html += readOnlyBanner();
    html += networkBanner();
    html += `<div class="page-head-row"><h2 id="book-list-title" tabindex="-1">家中书目</h2>${actionButton('添加家中书目（候选）', 'book-add', { variant: 'primary' })}</div>`;
    html += `<div class="filter-row" aria-label="书架筛选">${[['all', '全部'], ['owned', '家中已有'], ['want_read', '想读']].map(([value, label]) => `<button type="button" class="button filter-button" data-action="book-filter" data-filter="${esc(value)}" aria-pressed="${state.bookFilter === value}">${esc(label)}</button>`).join('')}</div>`;
    html += '<p class="note">书目版本信息待核实；不自动导入点读笔历史，也不承诺封面、页码或点读能力。</p>';

    const books = filteredBooks();
    if (!state.books.length) {
      html += `<div class="empty-state"><h2>书架还是空的</h2><p>${esc(T.EMPTY_BOOKS)}</p><div class="actions">${actionButton('添加家中书目（候选）', 'book-add', { variant: 'primary' })}</div></div>`;
    } else if (!books.length) {
      html += `<div class="empty-state"><h2>这个筛选下还没有内容</h2><p>${esc(T.EMPTY_FILTER)}</p><div class="actions">${actionButton('查看全部书目', 'clear-book-filter', { variant: 'primary' })}</div></div>`;
    } else {
      html += `<div class="book-grid">${books.map(bookCard).join('')}</div>`;
    }
    html += '<p class="note section">整理操作只保存在当前原型；离线时标为“本地演示 · 待同步”，不会上传或写入服务器。</p>';
    return html;
  }

  function bookCard(book) {
    const shelfLabel = book.shelf === 'want_read' ? '想读' : '家中已有';
    return `<article class="book-card">
      <div class="tag-row">${tag(shelfLabel)}${tag(T.EDITION_PENDING)}${book.sync === 'pending' ? tag('本地演示 · 待同步') : tag('本地原型')}</div>
      <h3>${esc(book.label)}</h3>
      ${book.note ? `<p>${esc(book.note)}</p>` : '<p class="note">还没有备注。可以记下版本、语言或家里放在哪里。</p>'}
      <p class="note">来源：${esc(book.origin)} · 封面、页码、语言与点读兼容性均未确认。</p>
      <div class="actions">
        ${actionButton(book.note ? '编辑备注' : '添加备注', 'book-edit', { attrs: `data-id="${esc(book.id)}"` })}
        ${actionButton(book.shelf === 'owned' ? '标为想读' : '移入家中已有', 'book-shelf', { attrs: `data-id="${esc(book.id)}"` })}
      </div>
    </article>`;
  }

  /* ---------- W06 成长档案 ---------- */

  function pageW06() {
    let html = pageIntro('W06', '成长档案', '故事、照片、第一次、原话和测量可以由家庭成员一起查看；本轮只展示虚构样本，不新增真实记录。');
    html += readOnlyBanner();
    html += networkBanner();
    html += `<p class="note" id="photo-print-note">待上传照片不会加入打印选择；已存本机的照片占位也不冒充已上传。可见范围仍为候选。</p>`;
    html += `<div class="filter-row" aria-label="成长类型筛选">${[['all', '全部'], ['story', '小故事'], ['photo', '照片'], ['first', '第一次'], ['quote', '原话'], ['measurement', '测量']].map(([value, label]) => `<button type="button" class="button filter-button" data-action="growth-type" data-type="${esc(value)}" aria-pressed="${state.growthType === value}">${esc(label)}</button>`).join('')}</div>`;
    html += `<form id="growth-filter" class="date-filter" novalidate>
      <div class="field"><label for="growth-from">开始日期</label><input id="growth-from" name="from" type="date" value="${esc(state.growthFrom)}" ${state.growthDateError ? 'aria-invalid="true" aria-describedby="growth-date-error"' : ''}></div>
      <div class="field"><label for="growth-to">结束日期</label><input id="growth-to" name="to" type="date" value="${esc(state.growthTo)}" ${state.growthDateError ? 'aria-invalid="true" aria-describedby="growth-date-error"' : ''}></div>
      <div class="filter-actions"><button type="submit" class="button primary">应用日期</button>${actionButton('清除筛选', 'growth-clear')}</div>
    </form>`;
    if (state.growthDateError) html += `<p class="form-error" id="growth-date-error" role="alert">${esc(state.growthDateError)}</p>`;

    const records = filteredGrowth();
    if (!state.growth.length) {
      html += `<div class="empty-state"><h2>还没有成长记录</h2><p>${esc(T.EMPTY_GROWTH)}</p></div>`;
    } else if (!records.length) {
      html += `<div class="empty-state"><h2>这个筛选下还没有内容</h2><p>${esc(T.EMPTY_FILTER)}</p><div class="actions">${actionButton('清除筛选', 'growth-clear', { variant: 'primary' })}</div></div>`;
    } else {
      html += `<div class="growth-list">${records.map(growthCard).join('')}</div>`;
    }
    html += `<p class="note section">${esc(T.NO_SCORE)} ${esc(T.MEASURE_DISCLAIMER)}</p>`;
    return html;
  }

  function growthCard(record) {
    const selected = Boolean(state.print.growth[record.id]);
    const photoOnly = record.type === 'photo';
    let body = '';
    if (record.type === 'measurement') {
      body = `<div class="measure-grid">
        <div><dt>数值（演示）</dt><dd>${esc(record.value)} ${esc(record.unit)}</dd></div>
        <div><dt>测量方法（候选）</dt><dd>${esc(record.method)}</dd></div>
        <div><dt>测量来源（候选）</dt><dd>${esc(record.source)}</dd></div>
        <div><dt>参考标准 / 百分位</dt><dd>未提供，不计算</dd></div>
      </div><p class="note">${esc(T.MEASURE_DISCLAIMER)}</p>`;
    } else if (record.type === 'quote') {
      body = `<p class="quote-text">${esc(record.text)}</p>`;
    } else {
      body = record.text ? `<p>${esc(record.text)}</p>` : '';
    }

    let printControl = '';
    if (photoOnly) {
      printControl = '<p class="note">照片未上传，不能加入打印；请先在真实实现中完成上传后再选择。</p>';
    } else {
      printControl = actionButton(selected ? '已加入打印选择' : '选择打印', 'growth-print-pick', {
        attrs: `data-id="${esc(record.id)}"`,
        disabled: selected
      });
    }

    return `<article class="growth-card">
      <div class="tag-row">${tag(typeLabels[record.type] || '成长记录')}${tag(record.date)}${tag(record.visible)}${record.type === 'first' && record.firstTimeConfirmed ? tag('家长确认的第一次') : ''}${selected ? tag('已加入打印选择') : ''}</div>
      <h3>${esc(record.title)}</h3>
      ${mediaPlaceholder(record.media)}
      ${body}
      ${record.media ? mediaNote(record) : ''}
      ${record.type === 'first' ? '<p class="note">第一次由家长确认，不由一次参与自动推断。</p>' : ''}
      <p class="note">添加：${esc(memberName(record.addedBy))} · 可见范围：${esc(record.visible)}</p>
      <div class="actions">
        ${printControl}
        ${record.media && record.media.state !== 'uploaded' ? actionButton('重试上传（模拟）', 'media-retry', { attrs: `data-id="${esc(record.id)}"` }) : ''}
      </div>
    </article>`;
  }

  /* ---------- W07 打印与导出 ---------- */

  function pageW07() {
    let html = pageIntro('W07', '打印与导出', T.PRINT_LOCAL);
    html += networkBanner();
    if (hasUnuploadedPhotos()) html += `<div class="banner"><strong>有照片还没有上传</strong><p>${esc(T.PRINT_PENDING)}</p><p class="note">照片默认不选；即使选择“整份成长档案”，也不会包含未上传照片。</p></div>`;
    html += '<p class="note">本周只有 2026-11-11 提供完整样本；打印选择不会复制其他日期，也不会补造一周内容。</p>';
    html += `<div class="page-head-row"><h2 id="print-selection-title" tabindex="-1">选择打印内容</h2><p id="print-summary" class="note"></p></div>`;
    html += `<div class="no-print">${printGroups()}<div class="actions">${actionButton('生成本地预览', 'generate-preview', { variant: 'primary' })}${actionButton('清空选择', 'clear-print')}</div></div>`;
    html += `<div id="print-area">${printAreaHtml()}</div>`;
    return html;
  }

  function printGroups() {
    const arrangement = fixture.day.items.map(item => {
      const display = displayItem(item.id) || item;
      return `<label class="check-row"><input type="checkbox" data-print-kind="arrangement" data-id="${esc(item.id)}" ${state.print.arrangement[item.id] ? 'checked' : ''}><span><strong>${esc(display.title)}</strong><br><span class="note">${esc(segmentFor(item)?.label || '当天')} · ${esc(display.budgetMinutes)} 分钟</span></span></label>`;
    }).join('');

    const growth = state.growth.map(record => {
      const disabled = record.type === 'photo';
      const checked = state.print.allGrowth ? !disabled : Boolean(state.print.growth[record.id]);
      const note = record.media ? '；含待上传照片，打印只含文字，照片排除' : '';
      return `<label class="check-row"><input type="checkbox" data-print-kind="growth" data-id="${esc(record.id)}" data-photo="${disabled ? '1' : '0'}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span><strong>${esc(record.title)}</strong><br><span class="note">${esc(typeLabels[record.type] || '成长记录')} · ${esc(record.date)}${record.type === 'photo' ? ' · 照片未上传，不能打印' : esc(note)}</span></span></label>`;
    }).join('');

    return `<section class="print-group"><h3>今天安排</h3><p class="note">逐项选择。默认只选了“把大软球滚给你”，可以清空或改选。</p>${arrangement}</section>
      <section class="print-group"><h3>阶段路线</h3><label class="check-row"><input type="checkbox" data-print-kind="stage" ${state.print.stage ? 'checked' : ''}><span><strong>18～23月阶段支持示例</strong><br><span class="note">七段结构、来源与年龄节点；不包含评分。</span></span></label></section>
      <section class="print-group"><h3>成长档案</h3><p class="note">逐条选择；照片默认不选且不可加入。勾选“整份成长档案”只会包含可打印的非照片记录。</p><label class="check-row"><input type="checkbox" id="print-all-growth" ${state.print.allGrowth ? 'checked' : ''}><span><strong>整份成长档案（默认不选）</strong><br><span class="note">不包含未上传照片，也不包含整份档案的分享或导出。</span></span></label>${growth}</section>`;
  }

  function printAreaHtml() {
    if (state.print.previewBusy) {
      return `<div class="loading-state" id="print-preview-loading" aria-busy="true"><h2>${esc(T.PRINT_LOAD)}</h2><p class="note">选择已保留；预览只在本浏览器生成。</p></div>`;
    }
    if (state.print.previewError) {
      return `<div class="banner error" id="print-preview-error" role="alert" tabindex="-1"><strong>打印预览没有准备好</strong><p>${esc(state.print.previewError)}</p><div class="actions">${actionButton('重试预览', 'retry-preview', { variant: 'primary' })}${actionButton('返回选择', 'close-preview')}</div></div>`;
    }
    if (state.print.preview) return printPreviewHtml(state.print.preview);
    return '';
  }

  function printPreviewHtml(preview) {
    const blocks = [];
    if (preview.arrangementIds.length) {
      blocks.push(`<section class="print-block"><h3>今天安排</h3>${preview.arrangementIds.map(printItemBlock).join('')}</section>`);
    }
    if (preview.stage) {
      blocks.push(printStageBlock());
    }
    if (preview.growthIds.length) {
      blocks.push(`<section class="print-block"><h3>成长档案（逐条）</h3>${preview.growthIds.map(printGrowthBlock).join('')}</section>`);
    }
    return `<section id="print-preview" class="print-preview" tabindex="-1" aria-label="本地打印预览">
      <div class="actions no-print">${actionButton('打开浏览器打印（本地）', 'browser-print', { variant: 'primary' })}${actionButton('关闭预览', 'close-preview')}</div>
      <h2>本地打印预览</h2>
      <p class="note">${esc(T.PRINT_LOCAL)}</p>
      <div class="print-meta">${tag(`家庭：${fixture.family.label}`)}${tag(`日期：${businessDate}`)}${tag(`固定时钟：15:00`)}</div>
      ${hasUnuploadedPhotos() ? `<p class="note">${esc(T.PRINT_PENDING)}</p>` : ''}
      ${blocks.join('') || `<p>${esc(T.PRINT_EMPTY)}</p>`}
    </section>`;
  }

  function printItemBlock(id) {
    const item = displayItem(id);
    if (!item) return '';
    return `<section class="print-block"><h3>${esc(item.title)}</h3><div class="print-meta">${tag(segmentFor(item)?.label || '当天')}${tag(`${item.budgetMinutes} 分钟`)}${tag(kindLabels[item.kind] || '亲子活动')}</div>${itemContentHtml(item)}</section>`;
  }

  function printStageBlock() {
    const guide = fixture.stageGuideSample;
    return `<section class="print-block"><h3>18～23月阶段支持示例</h3>
      <p><strong>关注方向：</strong>${esc(guide.focus)}</p>
      <p><strong>生活中的表现：</strong>${esc(guide.everydayExample)}</p>
      <p><strong>父母支持方式：</strong>${esc(guide.parentSupport)}</p>
      <p><strong>玩法：</strong>${esc(guide.playIdeas.join('；'))}</p>
      <p><strong>更容易版本：</strong>${esc(guide.easierVersion)}</p>
      <p><strong>可选下一步：</strong>${esc(guide.optionalNextStep)}</p>
      <p><strong>来源：</strong>${esc(guide.source.title)}</p>
      <p class="note">来源地址（仅文字）：${esc(guide.source.url)}</p>
      <p class="note">${esc(guide.source.boundary)}</p>
      <p class="note">${esc(T.STAGE_DISCLAIMER)}</p>
    </section>`;
  }

  function printGrowthBlock(id) {
    const record = state.growth.find(entry => entry.id === id);
    if (!record) return '';
    let detail = '';
    if (record.type === 'measurement') {
      detail = `<p><strong>数值：</strong>${esc(record.value)} ${esc(record.unit)}；<strong>方法：</strong>${esc(record.method)}；<strong>来源：</strong>${esc(record.source)}</p><p class="note">${esc(T.MEASURE_DISCLAIMER)}</p>`;
    } else if (record.text) {
      detail = `<p>${esc(record.text)}</p>`;
    }
    return `<section class="print-block"><h3>${esc(record.title)}</h3><div class="print-meta">${tag(typeLabels[record.type] || '成长记录')}${tag(record.date)}${tag(record.visible)}</div>${detail}${record.type === 'first' ? '<p class="note">家长确认的第一次。</p>' : ''}${record.media ? '<p class="note">照片没有上传，已从打印内容排除。</p>' : ''}<p class="note">添加：${esc(memberName(record.addedBy))}</p></section>`;
  }

  function updatePrintSummary() {
    const summary = document.getElementById('print-summary');
    if (!summary) return;
    const count = collectPrintSelection().count;
    summary.textContent = count ? `已选择 ${count} 项；照片和整份档案默认不选。` : '还没有选择要打印的内容。';
  }

  function refreshPrintArea() {
    const area = document.getElementById('print-area');
    if (area) area.innerHTML = printAreaHtml();
    document.body.classList.toggle('has-print-preview', Boolean(state.print.preview));
    updatePrintSummary();
  }

  function invalidatePrintPreview() {
    if (!state.print) return;
    state.print.generation += 1;
    state.print.preview = null;
    state.print.previewBusy = false;
    state.print.previewError = '';
  }

  function syncGrowthPrintChecks() {
    const all = state.print.allGrowth;
    $$('[data-print-kind="growth"]').forEach(input => {
      if (input.dataset.photo === '1') return;
      input.checked = all || Boolean(state.print.growth[input.dataset.id]);
      input.disabled = all;
    });
  }

  function generatePrintPreview() {
    const selection = collectPrintSelection();
    if (!selection.count) {
      state.print.preview = null;
      state.print.previewBusy = false;
      state.print.previewError = T.PRINT_EMPTY;
      state.focusTarget = '#print-preview-error';
      render();
      return;
    }
    const token = state.print.generation + 1;
    const activeState = state;
    state.print.generation = token;
    state.print.preview = null;
    state.print.previewBusy = true;
    state.print.previewError = '';
    state.focusTarget = '#print-preview-loading';
    render();
    window.setTimeout(() => {
      if (state !== activeState || token !== state.print.generation) return;
      state.print.previewBusy = false;
      if (takeFailure()) {
        state.print.previewError = T.PRINT_FAIL;
        state.focusTarget = '#print-preview-error';
        announce('打印预览没有准备好，已选择的内容仍然保留。');
      } else {
        state.print.preview = {
          arrangementIds: collectPrintSelection().arrangementIds,
          stage: collectPrintSelection().stage,
          growthIds: collectPrintSelection().growthIds
        };
        state.focusTarget = '#print-preview';
        announce('本地打印预览已生成；没有上传或生成正式文件。');
      }
      render();
    }, 480);
  }

  /* ---------- W08 家庭与成员设置 ---------- */

  function pageW08() {
    let html = pageIntro('W08', '家庭与成员设置', '成员、孩子档案和连接状态都是虚构演示；角色与权限仍待确认。');
    html += readOnlyBanner();
    html += networkBanner();
    html += `<section class="card"><h2>家庭</h2><p>${esc(fixture.family.label)}</p><p class="note">孩子年龄范围：18～23月；生日未提供。补充方式和是否多孩子均待定，不推断生日。</p></section>`;

    html += `<section class="section"><h2>成员</h2><p class="note" id="role-pending-note">${esc(T.ROLE_PENDING)} 不显示已确认的权限矩阵。</p><div class="book-grid">${fixture.family.members.map(member => `<article class="book-card"><div class="tag-row">${tag(member.id === state.memberId ? '当前添加者' : '家庭成员')}${tag('角色待确认')}</div><h3>${esc(member.label)}</h3><p class="note">角色变更只做本地演示，不改变真实权限；本轮按钮保持不可用。</p><div class="actions">${actionButton('变更角色（待定）', 'role-change', { disabled: true, reasonId: 'role-pending-note', reasonText: T.ROLE_PENDING })}</div></article>`).join('')}</div><div class="actions">${actionButton('邀请成员（候选）', 'invite-member', { disabled: true, reasonId: 'role-pending-note', reasonText: '邀请方式待确认，不发送真实邀请。' })}${actionButton('移除成员（待定）', 'remove-member', { disabled: true, reasonId: 'role-pending-note', reasonText: '移除规则待确认。' })}${actionButton('退出家庭（待定）', 'leave-family', { disabled: true, reasonId: 'role-pending-note', reasonText: '退出规则待确认。' })}</div></section>`;

    html += `<section class="section"><h2>孩子档案</h2><p>年龄范围：18～23月 · 当前阶段示例：18～23月。</p><p class="note">生日为空；不默认猜生日，也不在没有参考资料时显示百分位或医学结论。</p></section>`;
    html += `<section class="section"><h2>连接与权限</h2><p>家庭连接：${esc(connectionLabels[state.review.connection] || connectionLabels.connected)}</p><p class="note">当前成员：${esc(memberName(state.memberId))}。${isReadOnly() ? '当前为只读权限（模拟），内容整理动作不可用。' : '当前为可整理权限（模拟）。'}</p><p class="note">网页原型不读取真实相册、通知或设备权限；照片仍为占位。内容管理区使用独立入口，不在家长区显示发布操作。</p><div class="actions">${actionButton('查看连接与恢复', 'nav', { attrs: 'data-route="w01"' })}${actionButton('查看加入候选说明', 'join-methods')}</div></section>`;
    return html;
  }

  /* ---------- 页面映射 ---------- */

  const pages = {
    w01: pageW01,
    w02: pageW02,
    w03: pageW03,
    w04: pageW04,
    w05: pageW05,
    w06: pageW06,
    w07: pageW07,
    w08: pageW08
  };

  /* ---------- 导航与状态 ---------- */

  function routeFromHash() {
    const route = window.location.hash.replace(/^#/, '');
    return pageCodes[route] ? route : '';
  }

  function navigate(route, options = {}) {
    if (!pageCodes[route]) route = 'w01';
    if (state.dialog) closeDialog(true, false);
    invalidatePrintPreview();
    state.route = route;
    state.notice = options.notice || '';
    state.focusTarget = options.focusTarget || '#page-title';
    if (window.location.hash !== `#${route}`) {
      window.history.pushState({ route }, '', `#${route}`);
    }
    render();
  }

  function selectItem(id) {
    if (!itemById(id)) return;
    state.selectedItemId = id;
    state.focusTarget = '#detail-title';
    render();
  }

  function selectWeekDate(date) {
    if (!weekDayInfo(date)) return;
    state.selectedDate = date;
    navigate('w03', { focusTarget: '#selected-day-title' });
  }

  function takeFailure() {
    if (!state.review.failure) return false;
    state.review.failure = false;
    syncReviewControls();
    return true;
  }

  function canMutate() {
    if (!hasFamilyAccess()) {
      setNotice(T.PERM_FAMILY);
      render();
      return false;
    }
    if (isReadOnly()) {
      announce(T.PERM_ROLE);
      return false;
    }
    return true;
  }

  function setTheme(value) {
    document.documentElement.dataset.theme = value === 'dark' ? 'dark' : 'light';
    syncReviewControls();
  }

  function setFontScale(value) {
    const scale = String(value) === '2' ? '2' : '1';
    document.documentElement.style.setProperty('--font-scale', scale);
    document.documentElement.dataset.fontScale = scale;
    syncReviewControls();
  }

  function resetAll() {
    if (state.dialog) closeDialog(true, false);
    state = createState();
    $('#review-scenario').value = 'expanded_parent_web';
    syncReviewControls();
    setTheme('light');
    setFontScale('1');
    state.notice = '演示已重置为固定虚构样本；刷新页面也会重置。';
    state.focusTarget = '#page-title';
    if (window.location.hash !== '#w01') {
      window.history.replaceState({ route: 'w01' }, '', '#w01');
    }
    render();
    announce('演示已重置。');
  }

  function connectAttempt() {
    if (isOffline()) {
      state.connectionError = '当前没有网络，无法模拟连接；本机内容保留，请先在审阅面板恢复网络。';
      render();
      announce(state.connectionError);
      return;
    }
    if (takeFailure()) {
      state.review.connection = 'failed';
      state.connectionError = T.CONNECT_ERR;
      syncReviewControls();
      render();
      announce('模拟连接失败，已保留恢复入口。');
      return;
    }
    state.review.connection = 'connected';
    state.connectionError = '';
    syncReviewControls();
    state.notice = '已模拟完成家庭连接；没有真实登录、凭证校验或网络请求。';
    state.focusTarget = '#page-title';
    render();
    announce(state.notice);
  }

  function todayRetry() {
    if (isOffline()) {
      setNotice('当前没有网络。请先在审阅面板恢复网络，或查看已缓存内容。');
      render();
      return;
    }
    state.review.today = 'ready';
    syncReviewControls();
    setNotice('已模拟重新加载今天的内容；没有发送真实请求。');
    state.focusTarget = '#page-title';
    render();
  }

  /* ---------- 弹层 ---------- */

  function dialogTitle() {
    const dialog = state.dialog;
    if (!dialog) return '';
    if (dialog.type === 'record') return '记录这一项的参与';
    if (dialog.type === 'adjust') return '调整这一项安排';
    if (dialog.type === 'restore') return '恢复原安排';
    if (dialog.type === 'conflict') return '这条记录需要确认';
    if (dialog.type === 'sync') return '本机记录与同步';
    if (dialog.type === 'book') return dialog.draft?.mode === 'edit' ? '编辑书目与备注' : '添加家中书目（候选）';
    if (dialog.type === 'info') return dialog.draft?.title || '说明';
    return '说明';
  }

  function openDialog(type, draft = null) {
    if (state.dialog) closeDialog(true, false);
    const returnFocus = document.activeElement;
    state.dialog = {
      type,
      draft: draft ? clone(draft) : null,
      initial: draft ? JSON.stringify(draft) : '',
      errors: { general: '', field: null },
      discard: false,
      busy: false,
      returnFocus
    };
    renderDialog();
    if (!modal.open) modal.showModal();
    window.requestAnimationFrame(() => focusDialog());
  }

  function closeDialog(force = false, restoreFocus = true) {
    if (!state.dialog) return;
    if (state.dialog.busy && !force) return;
    const focus = state.dialog.returnFocus;
    state.dialog = null;
    if (modal.open) modal.close();
    modal.innerHTML = '';
    if (restoreFocus && focus && focus.isConnected) {
      focus.focus({ preventScroll: true });
    } else if (restoreFocus) {
      screen.focus({ preventScroll: true });
    }
  }

  function requestCloseDialog() {
    if (!state.dialog || state.dialog.busy) return;
    if (state.dialog.discard) return;
    if (state.dialog.draft && JSON.stringify(state.dialog.draft) !== state.dialog.initial) {
      state.dialog.discard = true;
      renderDialog();
      focusDialog();
      return;
    }
    closeDialog(true);
  }

  function dialogReadonlyNote() {
    if (!isReadOnly()) return '';
    return `<p class="form-error" id="dialog-readonly-note" role="status">${esc(T.PERM_ROLE)}</p>`;
  }

  function dialogErrorHtml() {
    if (!state.dialog?.errors?.general) return '';
    return `<p class="form-error" id="modal-error" role="alert" tabindex="-1">${esc(state.dialog.errors.general)}</p>`;
  }

  function renderDialog() {
    if (!state.dialog) {
      modal.innerHTML = '';
      return;
    }
    const dialog = state.dialog;
    const title = dialogTitle();
    let body = '';

    if (dialog.discard) {
      body = `<p>${esc(T.DISCARD)}</p><p class="note">原来的记录、安排或书目不会改变。</p><div class="dialog-actions">${actionButton('继续编辑', 'continue-edit', { variant: 'primary' })}${actionButton('放弃修改', 'discard')}</div>`;
    } else if (dialog.type === 'record') {
      body = recordDialogBody();
    } else if (dialog.type === 'adjust') {
      body = adjustDialogBody();
    } else if (dialog.type === 'restore') {
      body = restoreDialogBody();
    } else if (dialog.type === 'conflict') {
      body = conflictDialogBody();
    } else if (dialog.type === 'sync') {
      body = syncDialogBody();
    } else if (dialog.type === 'book') {
      body = bookDialogBody();
    } else {
      body = `<p>${esc(dialog.draft?.text || '')}</p><div class="dialog-actions">${actionButton('知道了', 'close-dialog', { variant: 'primary' })}</div>`;
    }

    modal.innerHTML = `<div class="dialog-head"><h2 id="modal-title" tabindex="-1">${esc(title)}</h2>${!dialog.busy && !dialog.discard ? actionButton('关闭', 'close-dialog', { variant: 'text', attrs: 'aria-label="关闭弹层"' }) : ''}</div>${dialogReadonlyNote()}${dialogErrorHtml()}${body}<p class="dialog-note">本地模拟 · 没有真实保存、上传、同步或服务请求。</p>`;
    modal.className = 'dialog';
    if (dialog.busy) {
      $$('input, select, textarea, button[type="submit"]', modal).forEach(control => {
        control.disabled = true;
      });
    }
  }

  function recordDialogBody() {
    const draft = state.dialog.draft;
    const item = itemById(draft.itemId);
    const feedbackKeys = draft.status === 'played' ? ['want_again'] : ['family_busy', 'child_tired', 'time_unfit'];
    const participantError = state.dialog.errors.field === 'participant';
    return `<form id="modal-form" novalidate>
      <p>${esc(item?.title || '当前内容块')}</p>
      <fieldset><legend>参与状态</legend>${chosenRadio('status', 'played', '一起玩了', draft.status === 'played')}${chosenRadio('status', 'skipped', '今天跳过', draft.status === 'skipped')}</fieldset>
      <fieldset><legend>可选反馈 · 不选也可以</legend>${chosenRadio('feedback', '', '暂不填写', !draft.feedback)}${feedbackKeys.map(key => chosenRadio('feedback', key, feedbackLabels[key], draft.feedback === key)).join('')}</fieldset>
      <fieldset ${participantError ? 'aria-describedby="modal-error"' : ''}><legend>谁陪着玩（可多选）</legend>${fixture.family.members.map(member => chosenCheckbox('participant', member.id, member.label, draft.participantIds?.includes(member.id))).join('')}</fieldset>
      <p class="note">由 ${esc(memberName(state.memberId))} 添加。陪伴者与添加者可以不同；本轮按单个内容块演示。${isOffline() ? ' 当前没有网络，保存只会写在本机原型。' : ''}</p>
      <div class="dialog-actions"><button type="submit" class="button primary" ${state.dialog.busy ? 'disabled' : ''}>${state.dialog.busy ? '正在保存…' : '保存记录'}</button>${actionButton('取消', 'close-dialog', { disabled: state.dialog.busy })}</div>
    </form>`;
  }

  function adjustDialogBody() {
    const draft = state.dialog.draft;
    const item = itemById(draft.itemId);
    const display = displayItem(draft.itemId) || item;
    const candidate = fixture.replacementSample.candidate;
    const canReplace = item?.id === fixture.replacementSample.targetItemId;
    const reasons = ['材料不在手边', '想换一种玩法', '时间更短', '孩子今天状态不同', '其他'];
    const minutesInvalid = state.dialog.errors.field === 'minutes';
    return `<form id="modal-form" novalidate>
      <p>原安排：${esc(display?.title || '当前内容块')} · ${esc(display?.budgetMinutes || '')} 分钟</p>
      <fieldset><legend>这次怎么调整</legend>
        ${chosenRadio('mode', 'replace', `换成「${candidate.title}」`, draft.mode === 'replace', !canReplace)}
        ${canReplace ? `<p class="note">18～23月 · ${candidate.materials.length ? esc(candidate.materials.join('、')) : '不用道具'} · 约 ${esc(candidate.budgetMinutes)} 分钟（可提前结束）。</p>` : '<p class="note">这项暂时没有匹配的替代候选；不把其他内容伪造成候选。</p>'}
        ${chosenRadio('mode', 'shorten', `保持玩法，缩短为约 ${esc(draft.minutes)} 分钟`, draft.mode === 'shorten')}
        ${chosenRadio('mode', 'skip', '今天跳过这一项', draft.mode === 'skip')}
      </fieldset>
      <div class="field"><label for="adjust-reason">为什么想调整（候选）</label><select id="adjust-reason" name="reason">${reasons.map(reason => `<option value="${esc(reason)}" ${draft.reason === reason ? 'selected' : ''}>${esc(reason)}</option>`).join('')}</select></div>
      ${draft.mode === 'shorten' ? `<div class="field"><label for="adjust-minutes">缩短后的分钟数</label><input id="adjust-minutes" name="minutes" type="number" min="1" max="${Math.max(1, (display?.budgetMinutes || 5) - 1)}" step="1" value="${esc(draft.minutes)}" ${minutesInvalid ? 'aria-invalid="true" aria-describedby="modal-error"' : ''}><p class="note">候选机制：只调整这一项；其他内容与记录保持原样。</p></div>` : ''}
      <p class="note">${state.records[draft.itemId] ? '这项已有参与记录；调整安排不会删除记录。' : ''} 后台不会自动重排已经开始或家长改过的内容。</p>
      <div class="dialog-actions"><button type="submit" class="button primary" ${state.dialog.busy ? 'disabled' : ''}>${state.dialog.busy ? '正在保存…' : '确认调整'}</button>${actionButton('取消', 'close-dialog', { disabled: state.dialog.busy })}</div>
    </form>`;
  }

  function restoreDialogBody() {
    const item = itemById(state.dialog.draft.itemId);
    const adjustment = state.adjustments[state.dialog.draft.itemId];
    return `<form id="modal-form" novalidate>
      <p>恢复「${esc(displayItem(item?.id)?.title || item?.title || '这一项')}」原来的活动与时长？</p>
      <p class="note">当前调整：${esc(adjustmentText(adjustment) || '无')}</p>
      <p class="note">已有参与记录会保留；后台不会自动重排已经开始或家长改过的内容。</p>
      <div class="dialog-actions"><button type="submit" class="button primary" ${state.dialog.busy ? 'disabled' : ''}>${state.dialog.busy ? '正在恢复…' : '恢复原安排'}</button>${actionButton('取消', 'close-dialog', { disabled: state.dialog.busy })}</div>
    </form>`;
  }

  function conflictDialogBody() {
    const conflict = fixture.conflictSample;
    const local = conflict.local;
    const remote = conflict.remote;
    const side = (title, record, note) => `<article class="card"><h3>${esc(title)}</h3><p>${esc(record.status === 'played' ? '一起玩了' : '今天跳过')}${record.feedback ? ` · ${esc(feedbackLabels[record.feedback] || record.feedback)}` : ''}</p><p class="note">陪伴：${esc(participants(record.participantIds))}<br>添加：${esc(memberName(record.addedBy))}<br>${esc(note)}</p></article>`;
    return `<p>${esc(T.CONFLICT_RECORD)}</p>
      <div class="split">${side('本机选择', local, '来自当前原型')}${side('另一边的更新（模拟）', remote, '另一位虚构家长')}</div>
      <div class="dialog-actions">${actionButton('保留我的', 'resolve-local', { variant: 'primary', reasonId: isReadOnly() ? 'dialog-readonly-note' : '' })}${actionButton('采用已有更新', 'resolve-remote', { reasonId: isReadOnly() ? 'dialog-readonly-note' : '' })}${actionButton('稍后处理', 'close-dialog')}</div>
      <p class="note">两边内容会同时显示，不会静默覆盖。同一内容块的同次共同参与可合并；真实合并规则待定。</p>`;
  }

  function syncDialogBody() {
    const entries = Object.entries(state.syncs);
    const pending = entries.filter(([, sync]) => sync !== 'synced');
    const rows = entries.length
      ? `<ul>${entries.map(([id, sync]) => `<li>${esc(itemTitle(id))}：${esc(syncLabels[sync] || sync)}</li>`).join('')}</ul>`
      : `<p>当前没有待同步记录。</p>`;
    const offlineNote = isOffline() ? '<p class="form-error" role="status">当前没有网络。本机记录会保留，不能模拟同步成功。</p>' : '';
    const conflictNote = state.review.conflict ? `<p class="banner">还有一条记录需要比较双方内容。${actionButton('查看双方内容', 'open-conflict')}</p>` : '';
    return `<div>${rows}${offlineNote}${conflictNote}</div>
      <p class="note">同步结果只在页面内模拟，不发送真实请求。离线时不会显示“已同步”或“服务器已保存”。</p>
      <div class="dialog-actions">${pending.length && !isOffline() ? actionButton(state.dialog.busy ? '正在发送…' : '模拟同步重试', 'sync-now', { variant: 'primary', disabled: state.dialog.busy, reasonId: isReadOnly() ? 'dialog-readonly-note' : '' }) : ''}${actionButton('关闭', 'close-dialog')}</div>`;
  }

  function bookDialogBody() {
    const draft = state.dialog.draft;
    const titleInvalid = state.dialog.errors.field === 'title';
    return `<form id="modal-form" novalidate>
      <div class="field"><label for="book-title">书名或占位名称</label><input id="book-title" name="title" required value="${esc(draft.title)}" placeholder="例如：演示绘本" ${titleInvalid ? 'aria-invalid="true" aria-describedby="modal-error"' : ''}></div>
      <div class="field"><label for="book-shelf">放在哪里</label><select id="book-shelf" name="shelf"><option value="owned" ${draft.shelf === 'owned' ? 'selected' : ''}>家中已有</option><option value="want_read" ${draft.shelf === 'want_read' ? 'selected' : ''}>想读</option></select></div>
      <div class="field"><label for="book-note">备注（可选）</label><textarea id="book-note" name="note" placeholder="例如：家里有其中一本；版本待核对。">${esc(draft.note || '')}</textarea></div>
      <p class="note">版本、语言、封面、分册与点读兼容性都不推断。保存只在当前原型；离线时标为待同步。</p>
      <div class="dialog-actions"><button type="submit" class="button primary" ${state.dialog.busy ? 'disabled' : ''}>${state.dialog.busy ? '正在保存…' : '保存到原型'}</button>${actionButton('取消', 'close-dialog', { disabled: state.dialog.busy })}</div>
    </form>`;
  }

  function focusDialog() {
    const target = modal.querySelector('[data-autofocus]') || modal.querySelector('#modal-title');
    if (target) target.focus({ preventScroll: true });
  }

  function focusDialogControl(name, value) {
    const controls = $$('[name]', modal);
    const target = controls.find(control => control.name === name && (value === undefined || control.value === value));
    if (target) target.focus({ preventScroll: false });
  }

  function focusDialogError() {
    const target = modal.querySelector('#modal-error');
    if (target) target.focus({ preventScroll: false });
  }

  /* ---------- 弹层动作 ---------- */

  function openRecord(id) {
    if (!itemById(id)) return;
    if (isConflictActive(id)) {
      openConflict();
      return;
    }
    if (!canMutate()) return;
    const existing = state.records[id];
    const draft = existing ? clone(existing) : {
      itemId: id,
      status: 'played',
      feedback: null,
      participantIds: [state.memberId],
      addedBy: state.memberId
    };
    draft.itemId = id;
    draft.addedBy = state.memberId;
    openDialog('record', draft);
  }

  function openAdjust(id) {
    if (!itemById(id)) return;
    if (!canMutate()) return;
    const item = itemById(id);
    const canReplace = id === fixture.replacementSample.targetItemId;
    openDialog('adjust', {
      itemId: id,
      mode: canReplace ? 'replace' : 'shorten',
      reason: '材料不在手边',
      minutes: Math.max(1, Math.min(fixture.replacementSample.shortenCandidateMinutes, (displayItem(id)?.budgetMinutes || 5) - 1)),
      originalTitle: item?.title || ''
    });
  }

  function openRestore(id) {
    if (!itemById(id) || !state.adjustments[id]) return;
    if (!canMutate()) return;
    openDialog('restore', { itemId: id });
  }

  function openConflict() {
    if (state.dialog) closeDialog(true, false);
    openDialog('conflict', null);
  }

  function openSync() {
    if (state.dialog) closeDialog(true, false);
    openDialog('sync', null);
  }

  function openBookDialog(mode, id) {
    if (!canMutate()) return;
    if (mode === 'edit') {
      const book = state.books.find(entry => entry.id === id);
      if (!book) return;
      openDialog('book', {
        mode: 'edit',
        id: book.id,
        title: book.label,
        shelf: book.shelf,
        note: book.note || ''
      });
      return;
    }
    openDialog('book', { mode: 'add', id: '', title: '', shelf: 'owned', note: '' });
  }

  function openInfo(title, text) {
    openDialog('info', { title, text });
  }

  function saveRecord() {
    if (!state.dialog || state.dialog.type !== 'record') return;
    if (!canMutate()) return;
    if (isConflictActive(state.dialog.draft.itemId) || state.review.conflict) {
      closeDialog(true, false);
      openConflict();
      announce('这条记录已有更新，请先比较双方内容，未保存新的修改。');
      return;
    }
    const form = $('#modal-form');
    if (!form) return;
    const data = new FormData(form);
    const status = String(data.get('status') || 'played');
    const allowedFeedback = status === 'played' ? ['want_again'] : ['family_busy', 'child_tired', 'time_unfit'];
    const rawFeedback = String(data.get('feedback') || '');
    const feedback = allowedFeedback.includes(rawFeedback) ? rawFeedback : null;
    const participantIds = data.getAll('participant').map(String);
    state.dialog.draft = {
      ...state.dialog.draft,
      status,
      feedback,
      participantIds,
      addedBy: state.memberId
    };
    if (!participantIds.length) {
      state.dialog.errors = { general: '请选择至少一位陪伴者。', field: 'participant' };
      renderDialog();
      focusDialogControl('participant');
      return;
    }
    state.dialog.errors = { general: '', field: null };
    state.dialog.busy = true;
    const activeState = state;
    const activeDialog = state.dialog;
    renderDialog();
    window.setTimeout(() => {
      if (state !== activeState || state.dialog !== activeDialog) return;
      state.dialog.busy = false;
      if (takeFailure()) {
        state.dialog.errors = { general: T.ACTION_ERR, field: null };
        renderDialog();
        focusDialogError();
        announce('保存失败，填写的内容仍然保留。');
        return;
      }
      const draft = state.dialog.draft;
      state.records[draft.itemId] = {
        itemId: draft.itemId,
        date: businessDate,
        status: draft.status,
        feedback: draft.feedback,
        participantIds: [...draft.participantIds],
        addedBy: draft.addedBy,
        simulationOnly: true
      };
      state.syncs[draft.itemId] = 'pending';
      closeDialog(true, false);
      state.focusTarget = state.route === 'w02' ? '#detail-title' : '#page-title';
      setNotice(isOffline()
        ? '记录已保存在本机，等待同步；当前没有网络。'
        : '记录已保存在当前原型（本机），等待模拟同步。');
      render();
    }, 420);
  }

  function saveAdjustment() {
    if (!state.dialog || state.dialog.type !== 'adjust') return;
    if (!canMutate()) return;
    const form = $('#modal-form');
    if (!form) return;
    const data = new FormData(form);
    const mode = String(data.get('mode') || 'shorten');
    const reason = String(data.get('reason') || '');
    const minutes = Number(data.get('minutes'));
    const itemId = state.dialog.draft.itemId;
    state.dialog.draft = { ...state.dialog.draft, mode, reason, minutes };

    if (mode === 'replace' && itemId !== fixture.replacementSample.targetItemId) {
      state.dialog.errors = { general: '这项暂时没有匹配的替代候选，可以选择缩短或跳过。', field: 'mode' };
      renderDialog();
      focusDialogControl('mode');
      return;
    }
    const currentMinutes = displayItem(itemId)?.budgetMinutes || 1;
    if (mode === 'shorten' && (!Number.isInteger(minutes) || minutes < 1 || minutes >= currentMinutes)) {
      state.dialog.errors = { general: T.INVALID_VALUE + ' 缩短后的整数分钟数必须小于当前时长。', field: 'minutes' };
      renderDialog();
      focusDialogControl('minutes');
      return;
    }

    state.dialog.errors = { general: '', field: null };
    state.dialog.busy = true;
    const activeState = state;
    const activeDialog = state.dialog;
    renderDialog();
    window.setTimeout(() => {
      if (state !== activeState || state.dialog !== activeDialog) return;
      state.dialog.busy = false;
      if (takeFailure()) {
        state.dialog.errors = { general: '这次调整没有完成。原安排没有改变；你的选择还在。', field: null };
        renderDialog();
        focusDialogError();
        return;
      }
      if (mode === 'replace') {
        state.adjustments[itemId] = {
          type: 'replace',
          title: fixture.replacementSample.candidate.title,
          item: clone(fixture.replacementSample.candidate),
          reason
        };
      } else if (mode === 'shorten') {
        state.adjustments[itemId] = { type: 'shorten', minutes, reason };
      } else {
        state.adjustments[itemId] = { type: 'skip', reason };
      }
      invalidatePrintPreview();
      closeDialog(true, false);
      state.focusTarget = state.route === 'w03' ? '#selected-day-title' : '#detail-title';
      setNotice(state.records[itemId]
        ? '安排已调整；已有参与记录保留，后台不会自动重排。'
        : '安排已调整（本地模拟）；其他内容和记录保持原样。');
      render();
    }, 420);
  }

  function saveRestore() {
    if (!state.dialog || state.dialog.type !== 'restore') return;
    if (!canMutate()) return;
    const itemId = state.dialog.draft.itemId;
    state.dialog.busy = true;
    const activeState = state;
    const activeDialog = state.dialog;
    renderDialog();
    window.setTimeout(() => {
      if (state !== activeState || state.dialog !== activeDialog) return;
      state.dialog.busy = false;
      if (takeFailure()) {
        state.dialog.errors = { general: '恢复没有完成。当前调整仍然保留，请重试。', field: null };
        renderDialog();
        focusDialogError();
        return;
      }
      delete state.adjustments[itemId];
      invalidatePrintPreview();
      closeDialog(true, false);
      state.focusTarget = state.route === 'w03' ? '#selected-day-title' : '#detail-title';
      setNotice('已恢复原安排；已有参与记录保留。');
      render();
    }, 420);
  }

  function saveBook() {
    if (!state.dialog || state.dialog.type !== 'book') return;
    if (!canMutate()) return;
    const form = $('#modal-form');
    if (!form) return;
    const data = new FormData(form);
    const title = String(data.get('title') || '').trim();
    const shelf = String(data.get('shelf') || 'owned');
    const note = String(data.get('note') || '').trim();
    state.dialog.draft = { ...state.dialog.draft, title, shelf, note };
    if (!title) {
      state.dialog.errors = { general: '请填写书名或占位名称。', field: 'title' };
      renderDialog();
      focusDialogControl('title');
      return;
    }
    state.dialog.errors = { general: '', field: null };
    state.dialog.busy = true;
    const activeState = state;
    const activeDialog = state.dialog;
    renderDialog();
    window.setTimeout(() => {
      if (state !== activeState || state.dialog !== activeDialog) return;
      state.dialog.busy = false;
      if (takeFailure()) {
        state.dialog.errors = { general: T.ACTION_ERR, field: null };
        renderDialog();
        focusDialogError();
        return;
      }
      const draft = state.dialog.draft;
      const sync = isOffline() ? 'pending' : 'local';
      if (draft.mode === 'edit') {
        const book = state.books.find(entry => entry.id === draft.id);
        if (book) {
          book.label = draft.title;
          book.shelf = draft.shelf;
          book.note = draft.note;
          book.sync = sync;
        }
      } else {
        state.books.push({
          id: `local-book-${state.books.length + 1}`,
          label: draft.title,
          shelf: draft.shelf,
          note: draft.note,
          editionStatus: 'unverified',
          cover: null,
          readingPenCompatibility: 'unknown',
          origin: '本地添加（演示）',
          sync,
          simulationOnly: true
        });
      }
      closeDialog(true, false);
      state.focusTarget = '#book-list-title';
      setNotice(isOffline()
        ? '书目已保存在本机原型，等待同步；版本仍待核实。'
        : '书目已保存在当前原型（本地模拟）；版本仍待核实。');
      render();
    }, 360);
  }

  function resolveConflict(side) {
    if (!canMutate()) return;
    const conflict = fixture.conflictSample;
    const selected = side === 'local' ? conflict.local : conflict.remote;
    state.records[conflict.itemId] = {
      ...clone(selected),
      itemId: conflict.itemId,
      date: businessDate,
      simulationOnly: true
    };
    state.syncs[conflict.itemId] = 'pending';
    state.review.conflict = false;
    syncReviewControls();
    closeDialog(true, false);
    state.focusTarget = state.route === 'w02' ? '#detail-title' : '#page-title';
    setNotice(side === 'local'
      ? '已保留本机选择（本地模拟），等待模拟同步。'
      : '已采用另一边的更新（本地模拟），等待模拟同步确认。');
    render();
  }

  function simulateSync() {
    if (!canMutate()) return;
    if (isOffline()) {
      if (state.dialog) {
        state.dialog.errors = { general: '当前没有网络。本机记录会保留，不能模拟同步成功。', field: null };
        renderDialog();
        focusDialogError();
      }
      return;
    }
    const pending = Object.entries(state.syncs).filter(([, sync]) => sync !== 'synced');
    if (!pending.length) {
      if (state.dialog) {
        state.dialog.errors = { general: '当前没有待同步记录。', field: null };
        renderDialog();
        focusDialogError();
      }
      return;
    }
    if (state.dialog) {
      state.dialog.busy = true;
      state.dialog.errors = { general: '', field: null };
    }
    const ids = pending.map(([id]) => id);
    const activeState = state;
    const operationDialog = state.dialog;
    const sentRecords = Object.fromEntries(ids.map(id => [id, JSON.stringify(state.records[id])]));
    ids.forEach(id => {
      state.syncs[id] = 'sending';
    });
    renderDialog();
    render();
    window.setTimeout(() => {
      if (state !== activeState) return;
      const failure = takeFailure() || isOffline();
      ids.forEach(id => {
        if (JSON.stringify(state.records[id]) !== sentRecords[id]) { state.syncs[id] = 'pending'; return; }
        state.syncs[id] = failure ? 'failed' : 'synced';
      });
      if (state.dialog === operationDialog && state.dialog) {
        state.dialog.busy = false;
        if (failure) {
          state.dialog.errors = { general: '同步没有完成。修改仍保存在本机，可以重试。', field: null };
        }
      }
      if (failure) {
        announce('模拟同步失败，修改仍保存在本机。');
      } else {
        setNotice('模拟同步结果已更新；没有发送真实请求。');
      }
      renderDialog();
      render();
    }, 650);
  }

  /* ---------- 表单提交 ---------- */

  function handleGrowthFilter() {
    const from = String($('#growth-from')?.value || '');
    const to = String($('#growth-to')?.value || '');
    if (from && to && from > to) {
      state.growthFrom = from;
      state.growthTo = to;
      state.growthDateError = '开始日期不能晚于结束日期。';
      state.focusTarget = '#growth-date-error';
      render();
      return;
    }
    state.growthFrom = from;
    state.growthTo = to;
    state.growthDateError = '';
    state.focusTarget = '#growth-list-title';
    render();
  }

  function handleDialogSubmit() {
    if (!state.dialog) return;
    if (state.dialog.type === 'record') saveRecord();
    else if (state.dialog.type === 'adjust') saveAdjustment();
    else if (state.dialog.type === 'restore') saveRestore();
    else if (state.dialog.type === 'book') saveBook();
  }

  /* ---------- 事件 ---------- */

  document.addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    if (MUTATING_ACTIONS.has(action) && !canMutate()) return;

    if (action === 'nav') return navigate(target.dataset.route);
    if (action === 'reset-demo') return resetAll();
    if (action === 'dismiss-notice') {
      state.notice = '';
      return render();
    }
    if (action === 'select-item') return selectItem(target.dataset.id);
    if (action === 'select-week-date') return selectWeekDate(target.dataset.date);
    if (action === 'open-item') {
      state.selectedItemId = target.dataset.id;
      return navigate('w02', { focusTarget: '#detail-title' });
    }
    if (action === 'record') return openRecord(target.dataset.id);
    if (action === 'adjust') return openAdjust(target.dataset.id);
    if (action === 'restore-adjust') return openRestore(target.dataset.id);
    if (action === 'open-conflict') return openConflict();
    if (action === 'open-sync') return openSync();
    if (action === 'close-dialog') return requestCloseDialog();
    if (action === 'discard') return closeDialog(true);
    if (action === 'continue-edit') {
      if (!state.dialog) return;
      state.dialog.discard = false;
      renderDialog();
      return focusDialog();
    }
    if (action === 'resolve-local') return resolveConflict('local');
    if (action === 'resolve-remote') return resolveConflict('remote');
    if (action === 'sync-now') return simulateSync();
    if (action === 'book-add') return openBookDialog('add');
    if (action === 'book-edit') return openBookDialog('edit', target.dataset.id);
    if (action === 'book-shelf') return toggleBookShelf(target.dataset.id);
    if (action === 'book-filter') {
      state.bookFilter = target.dataset.filter || 'all';
      state.focusTarget = '#book-list-title';
      return render();
    }
    if (action === 'clear-book-filter') {
      state.bookFilter = 'all';
      state.focusTarget = '#book-list-title';
      return render();
    }
    if (action === 'growth-type') {
      state.growthType = target.dataset.type || 'all';
      state.focusTarget = '#growth-list-title';
      return render();
    }
    if (action === 'growth-clear') {
      state.growthType = 'all';
      state.growthFrom = '';
      state.growthTo = '';
      state.growthDateError = '';
      state.focusTarget = '#growth-list-title';
      return render();
    }
    if (action === 'growth-print-pick') {
      state.print.growth[target.dataset.id] = true;
      state.print.allGrowth = false;
      return navigate('w07', {
        notice: '已加入打印选择；请生成本地预览。照片仍会排除。',
        focusTarget: '#print-selection-title'
      });
    }
    if (action === 'media-retry') return retryMedia(target.dataset.id);
    if (action === 'print-stage') {
      state.print.stage = true;
      return navigate('w07', {
        notice: '阶段路线已加入打印选择；请生成本地预览。',
        focusTarget: '#print-selection-title'
      });
    }
    if (action === 'generate-preview') return generatePrintPreview();
    if (action === 'retry-preview') return generatePrintPreview();
    if (action === 'clear-print') {
      invalidatePrintPreview();
      state.print.arrangement = {};
      state.print.stage = false;
      state.print.growth = {};
      state.print.allGrowth = false;
      state.focusTarget = '#print-selection-title';
      return render();
    }
    if (action === 'close-preview') {
      invalidatePrintPreview();
      state.focusTarget = '#print-selection-title';
      return render();
    }
    if (action === 'browser-print') {
      announce('已调用浏览器本地打印对话框；原型不生成或上传正式文件。');
      window.print();
      return;
    }
    if (action === 'today-retry') return todayRetry();
    if (action === 'restore-network') {
      state.review.network = 'online';
      syncReviewControls();
      setNotice('已模拟恢复网络；本机记录和修改保持不变，仍未发送真实请求。');
      state.focusTarget = '#page-title';
      return render();
    }
    if (action === 'connect-retry' || action === 'connect-update') return connectAttempt();
    if (action === 'join-methods') {
      return openInfo('加入家庭方式仍待确认', '邀请码、邀请链接、扫码、账号恢复和部署配置都只是候选。本轮不创建账号、不输入凭证、不发送邀请，也不提供公开注册。');
    }
    if (action === 'role-change' || action === 'invite-member' || action === 'remove-member' || action === 'leave-family') {
      return announce(T.ROLE_PENDING);
    }
  });

  document.addEventListener('change', event => {
    const target = event.target;

    if (target.id === 'review-scenario') {
      const id = target.value;
      if (state.dialog) closeDialog(true, false);
      state = createState();
      if (id === 'extra_growth') state.growth = seedGrowth();
      else {
        const sample = fixture.scenarios.find(entry => entry.id === id);
        state.growth = (sample?.overrides?.memoryRecords || []).map((record, index) => ({...clone(record), id: `fixture-memory-${index}`, type: 'story', date: businessDate, title: '原创虚构故事', addedBy: record.addedBy || state.memberId, visible: '家庭成员可见（候选）'}));
      }
      state.route = /media|memory|growth/.test(id) ? 'w06' : id === 'expanded_print' ? 'w07' : 'w02';
      state.notice = id === 'extra_growth' ? '当前是额外虚构成长样本，不代表家庭已有记录。' : '已重新载入场景；之前的页面内修改已重置。';
      syncReviewControls();
      history.replaceState({route: state.route}, '', `#${state.route}`);
      return render();
    }
    if (target.id === 'review-connection') {
      state.review.connection = target.value;
      state.connectionError = '';
      invalidatePrintPreview();
      syncReviewControls();
      state.focusTarget = '#page-title';
      return render();
    }
    if (target.id === 'review-today') {
      state.review.today = target.value;
      invalidatePrintPreview();
      syncReviewControls();
      state.focusTarget = '#page-title';
      return render();
    }
    if (target.id === 'review-member') {
      state.memberId = target.value;
      invalidatePrintPreview();
      announce(`已切换为${memberName(state.memberId)}；已有记录的添加者保持不变。`);
      return render();
    }
    if (target.id === 'review-theme') {
      setTheme(target.value);
      return;
    }
    if (target.id === 'review-font') {
      setFontScale(target.value);
      return;
    }
    if (target.id === 'review-network') {
      state.review.network = target.checked ? 'offline' : 'online';
      invalidatePrintPreview();
      syncReviewControls();
      state.focusTarget = '#page-title';
      return render();
    }
    if (target.id === 'review-conflict') {
      state.review.conflict = target.checked;
      invalidatePrintPreview();
      syncReviewControls();
      state.focusTarget = '#page-title';
      return render();
    }
    if (target.id === 'review-readonly') {
      state.review.readOnly = target.checked;
      invalidatePrintPreview();
      syncReviewControls();
      state.focusTarget = '#page-title';
      return render();
    }
    if (target.id === 'review-failure') {
      state.review.failure = target.checked;
      invalidatePrintPreview();
      syncReviewControls();
      refreshPrintArea();
      return;
    }

    if (target.id === 'print-all-growth') {
      state.print.allGrowth = target.checked;
      state.print.growth = {};
      if (target.checked) {
        printableGrowth().forEach(record => {
          state.print.growth[record.id] = true;
        });
      }
      syncGrowthPrintChecks();
      invalidatePrintPreview();
      refreshPrintArea();
      announce('打印选择已更新，请重新生成预览。');
      return;
    }
    if (target.dataset.printKind === 'arrangement') {
      state.print.arrangement[target.dataset.id] = target.checked;
      invalidatePrintPreview();
      refreshPrintArea();
      announce('打印选择已更新，请重新生成预览。');
      return;
    }
    if (target.dataset.printKind === 'stage') {
      state.print.stage = target.checked;
      invalidatePrintPreview();
      refreshPrintArea();
      announce('打印选择已更新，请重新生成预览。');
      return;
    }
    if (target.dataset.printKind === 'growth') {
      state.print.growth[target.dataset.id] = target.checked;
      invalidatePrintPreview();
      refreshPrintArea();
      announce('打印选择已更新，请重新生成预览。');
      return;
    }

    if (!state.dialog) return;

    if (target.name === 'status') {
      state.dialog.draft.status = target.value;
      state.dialog.draft.feedback = null;
      renderDialog();
      return focusDialogControl('status', target.value);
    }
    if (target.name === 'feedback') {
      state.dialog.draft.feedback = target.value || null;
      return;
    }
    if (target.name === 'participant') {
      state.dialog.draft.participantIds = $$('[name="participant"]:checked', modal).map(input => input.value);
      return;
    }
    if (target.name === 'mode') {
      state.dialog.draft.mode = target.value;
      renderDialog();
      return focusDialogControl('mode', target.value);
    }
    if (target.name === 'reason') {
      state.dialog.draft.reason = target.value;
      return;
    }
    if (target.name === 'minutes') {
      state.dialog.draft.minutes = Number(target.value);
      return;
    }
    if (target.name === 'shelf') {
      state.dialog.draft.shelf = target.value;
    }
  });

  document.addEventListener('input', event => {
    if (!state.dialog?.draft) return;
    const target = event.target;
    if (target.name === 'title') state.dialog.draft.title = target.value;
    if (target.name === 'note') state.dialog.draft.note = target.value;
    if (target.name === 'minutes') state.dialog.draft.minutes = Number(target.value);
  });

  document.addEventListener('submit', event => {
    if (event.target.id === 'growth-filter') {
      event.preventDefault();
      handleGrowthFilter();
      return;
    }
    if (event.target.id === 'modal-form') {
      event.preventDefault();
      handleDialogSubmit();
    }
  });

  modal.addEventListener('cancel', event => {
    event.preventDefault();
    requestCloseDialog();
  });

  window.addEventListener('popstate', () => {
    const route = routeFromHash();
    if (!route) return;
    if (state.dialog) closeDialog(true, false);
    invalidatePrintPreview();
    state.route = route;
    state.notice = '';
    state.focusTarget = '#page-title';
    render();
  });

  function toggleBookShelf(id) {
    if (!canMutate()) return;
    const book = state.books.find(entry => entry.id === id);
    if (!book) return;
    book.shelf = book.shelf === 'owned' ? 'want_read' : 'owned';
    book.sync = isOffline() ? 'pending' : 'local';
    state.focusTarget = '#book-list-title';
    setNotice(isOffline()
      ? '书目状态已保存在本机原型，等待同步。'
      : '书目状态已保存在当前原型（本地模拟）。');
    render();
  }

  function retryMedia(id) {
    if (!canMutate()) return;
    const record = state.growth.find(entry => entry.id === id);
    if (!record?.media) return;
    record.media.state = 'pending_upload';
    state.focusTarget = '#growth-list-title';
    setNotice('已模拟重试，照片仍在本机等待上传；没有真实上传请求。');
    render();
  }

  /* ---------- 初始化 ---------- */

  const initialRoute = routeFromHash() || 'w01';
  state = createState();
  state.route = initialRoute;
  $('#review-member').innerHTML = fixture.family.members.map(member => `<option value="${esc(member.id)}">${esc(member.label)}</option>`).join('');
  setTheme('light');
  setFontScale('1');
  syncReviewControls();
  render();
  updatePrintSummary();
  if (window.matchMedia('(max-width: 1180px)').matches) {
    $('#review-details').open = false;
  }
  if (window.location.hash !== `#${state.route}`) {
    window.history.replaceState({ route: state.route }, '', `#${state.route}`);
  }
})();
