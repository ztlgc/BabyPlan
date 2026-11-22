import { ApiError, BabyPlanApi, apiErrorMessage } from './lib/api.js';
import {
  addDays,
  businessDate,
  describeChildAge,
  formatChineseDate,
  formatChineseWeekday,
  weekDates,
} from './lib/dates.js';
import {
  DEFAULT_API_BASE,
  normalizeApiBase,
  normalizeEmail,
  normalizeInvitationCode,
  splitCommaValues,
  splitTextValues,
  validateChildProfileInput,
  validateInvitationCode,
  validateInvitationSignupInput,
  validateLoginInput,
  validateParticipationInput,
  validatePreferenceInput,
} from './lib/validation.js';
import {
  CONTENT_STATUS_LABELS,
  MEASUREMENT_KIND_LABELS,
  MEMORY_TYPE_LABELS,
  OBSERVATION_VALUE_LABELS,
  activityDiff,
  canPublishRevisions,
  dateDaysAgo,
  isSafeHttpUrl,
  mergeSnapshotPages,
  resolveEvidenceReferences,
  sortedGrowthEvents,
  validateExportRequest,
} from './lib/growth.js';

const API_STORAGE_KEY = 'babyplan.web.apiBase';
const KIND_LABELS = {
  movement: '运动',
  explore: '探索',
  reading: '共读',
  english: '英语',
  'child-led': '孩子主导',
  calm: '安静收尾',
};
const KIND_SYMBOLS = {
  movement: '动',
  explore: '探',
  reading: '读',
  english: 'EN',
  'child-led': '由',
  calm: '静',
};
const ROLE_LABELS = {
  owner: '家庭管理员',
  caregiver: '共同照护者',
};
const BLOCK_LABELS = {
  before: '白天',
  after: '下午',
  bedtime: '睡前',
};
const MAX_EVIDENCE_DETAIL_REQUESTS = 200;

function emptyGrowthTrashState() {
  return {
    loaded: false,
    loading: false,
    loadingKind: '',
    error: '',
    items: [],
    nextCursor: {
      memory: null,
      measurement: null,
      observation: null,
    },
  };
}

const state = {
  api: null,
  bootstrap: null,
  family: null,
  child: null,
  today: '',
  dates: [],
  selectedDate: '',
  selectedItemId: null,
  mode: 'day',
  view: 'schedule',
  plans: new Map(),
  preferences: null,
  preferencesError: '',
  growth: {
    loaded: false,
    loading: false,
    error: '',
    snapshot: null,
    options: null,
    trash: emptyGrowthTrashState(),
  },
  content: {
    loaded: false,
    loading: false,
    enabled: false,
    error: '',
    revisions: [],
    releases: [],
    sources: [],
    activities: [],
    evidenceRecords: [],
    revisionsError: '',
    releasesError: '',
    sourcesError: '',
    activitiesError: '',
    evidenceError: '',
  },
  requestGeneration: 0,
  successTimer: null,
};

const dom = {};

function element(tagName, className = '', text = '') {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  if (text !== '') {
    node.textContent = text;
  }
  return node;
}

function clear(node) {
  node.replaceChildren();
}

function setHidden(node, hidden) {
  node.hidden = hidden;
}

function option(value, label) {
  const node = element('option', '', label);
  node.value = value;
  return node;
}

function readStoredApiBase() {
  try {
    return normalizeApiBase(localStorage.getItem(API_STORAGE_KEY) || DEFAULT_API_BASE);
  } catch {
    return DEFAULT_API_BASE;
  }
}

function storeApiBase(baseUrl) {
  try {
    localStorage.setItem(API_STORAGE_KEY, baseUrl);
  } catch {
    // 浏览器禁止本地存储时，当前页面仍可使用本次输入的地址。
  }
}

function newUuid() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function markFormDirty(form, dirty = true) {
  form.dataset.dirty = dirty ? 'true' : 'false';
}

function hasDirtyForm() {
  return Boolean(document.querySelector('form[data-dirty="true"]'));
}

function discardDirtyForms() {
  document.querySelectorAll('form[data-dirty="true"]').forEach((form) => {
    markFormDirty(form, false);
  });
}

function confirmDiscardOtherDirtyForms(currentForm) {
  const otherForms = [...document.querySelectorAll('form[data-dirty="true"]')]
    .filter((form) => form !== currentForm);
  if (otherForms.length === 0) return true;
  if (!window.confirm('其他表单还有未提交的输入。继续会丢弃那些内容，确定吗？')) {
    return false;
  }
  otherForms.forEach((form) => markFormDirty(form, false));
  return true;
}

function confirmDiscardDirtyForm() {
  if (!hasDirtyForm()) return true;
  if (!window.confirm('还有尚未提交的表单内容。确定离开并丢弃这些输入吗？')) {
    return false;
  }
  discardDirtyForms();
  return true;
}

function bindDirtyProtection(form) {
  markFormDirty(form, false);
  form.addEventListener('input', () => markFormDirty(form, true));
  form.addEventListener('change', () => markFormDirty(form, true));
}

window.addEventListener('beforeunload', (event) => {
  if (!hasDirtyForm()) return;
  event.preventDefault();
  event.returnValue = '';
});

function cacheDom() {
  [
    'api-base',
    'app-shell',
    'boundary-api',
    'book-form',
    'book-form-error',
    'book-language',
    'book-note',
    'book-submit',
    'book-title',
    'books-list',
    'child-select',
    'child-settings',
    'content-nav',
    'content-creator',
    'content-role-note',
    'content-releases',
    'content-revisions',
    'content-roles',
    'content-status',
    'current-user',
    'date-strip',
    'day-mode-button',
    'day-plan-panel',
    'day-view',
    'detail-heading',
    'detail-panel',
    'email',
    'email-error',
    'family-overview-summary',
    'family-overview-title',
    'family-select',
    'export-form',
    'export-form-error',
    'export-from',
    'export-media',
    'export-result',
    'export-submit',
    'export-to',
    'danger-zone',
    'global-status',
    'growth-count',
    'growth-form',
    'growth-history',
    'growth-trash',
    'growth-trash-list',
    'growth-print-button',
    'growth-status',
    'login-button',
    'login-error',
    'login-form',
    'login-view',
    'logout-button',
    'main-content',
    'member-management',
    'members-list',
    'overview-members',
    'preferences-content',
    'print-button',
    'print-root',
    'privacy-actions',
    'publish-gate-actions',
    'publish-gate-note',
    'publish-gate-title',
    'release-count',
    'refresh-button',
    'refresh-content-button',
    'refresh-growth-button',
    'refresh-preferences-button',
    'revision-count',
    'service-boundary',
    'signup-button',
    'signup-code',
    'signup-code-error',
    'signup-details',
    'signup-email',
    'signup-email-error',
    'signup-error',
    'signup-form',
    'signup-name',
    'signup-name-error',
    'signup-pass',
    'signup-pass-error',
    'toast',
    'invitation-actions',
    'view-schedule',
    'view-content',
    'view-growth',
    'view-settings',
    'web-pass',
    'web-pass-error',
    'week-mode-button',
    'week-view',
  ].forEach((id) => {
    dom[id] = document.getElementById(id);
  });
}

function setFieldError(input, errorNode, message) {
  errorNode.textContent = message || '';
  if (message) {
    input.setAttribute('aria-invalid', 'true');
  } else {
    input.removeAttribute('aria-invalid');
  }
}

function clearLoginErrors() {
  setFieldError(dom.email, dom['email-error'], '');
  setFieldError(dom['web-pass'], dom['web-pass-error'], '');
  setFieldError(dom['api-base'], document.getElementById('api-base-error'), '');
  dom['login-error'].textContent = '';
  setHidden(dom['login-error'], true);
}

function showLoginError(message) {
  dom['login-error'].textContent = message;
  setHidden(dom['login-error'], !message);
}

function setLoginBusy(busy) {
  dom['login-button'].disabled = busy;
  const label = dom['login-button'].querySelector('span');
  if (label) {
    label.textContent = busy ? '正在连接…' : '登录';
  }
}

function clearSignupErrors() {
  setFieldError(dom['signup-code'], dom['signup-code-error'], '');
  setFieldError(dom['signup-email'], dom['signup-email-error'], '');
  setFieldError(dom['signup-name'], dom['signup-name-error'], '');
  setFieldError(dom['signup-pass'], dom['signup-pass-error'], '');
  dom['signup-error'].textContent = '';
  setHidden(dom['signup-error'], true);
}

function showSignupError(message) {
  dom['signup-error'].textContent = message;
  setHidden(dom['signup-error'], !message);
}

function setSignupBusy(busy) {
  dom['signup-button'].disabled = busy;
  const label = dom['signup-button'].querySelector('span');
  if (label) {
    label.textContent = busy ? '正在创建…' : '创建账号并加入家庭';
  }
}

function showLogin(message = '') {
  setHidden(dom['app-shell'], true);
  setHidden(dom['login-view'], false);
  showLoginError(message);
  dom['web-pass'].value = '';
  dom['signup-pass'].value = '';
}

function resetSignedInState() {
  state.bootstrap = null;
  state.family = null;
  state.child = null;
  state.dates = [];
  state.plans.clear();
  state.preferences = null;
  state.preferencesError = '';
  state.growth = {
    loaded: false,
    loading: false,
    error: '',
    snapshot: null,
    options: null,
    trash: emptyGrowthTrashState(),
  };
  state.content = {
    loaded: false,
    loading: false,
    enabled: false,
    error: '',
    revisions: [],
    releases: [],
    sources: [],
    activities: [],
    evidenceRecords: [],
    revisionsError: '',
    releasesError: '',
    sourcesError: '',
    activitiesError: '',
    evidenceError: '',
  };
  state.selectedItemId = null;
  state.requestGeneration += 1;
}

function showApp() {
  setHidden(dom['login-view'], true);
  setHidden(dom['app-shell'], false);
  dom['login-error'].textContent = '';
}

function showGlobalStatus(message, kind = 'error', timeout = 0) {
  if (state.successTimer) {
    clearTimeout(state.successTimer);
    state.successTimer = null;
  }
  dom['global-status'].textContent = message;
  dom['global-status'].dataset.kind = kind;
  setHidden(dom['global-status'], !message);
  if (message && timeout > 0) {
    state.successTimer = setTimeout(() => {
      setHidden(dom['global-status'], true);
      state.successTimer = null;
    }, timeout);
  }
}

function showToast(message) {
  dom.toast.textContent = message;
  setHidden(dom.toast, false);
  setTimeout(() => {
    setHidden(dom.toast, true);
  }, 2600);
}

function currentFamilyChildren() {
  if (!state.family) {
    return [];
  }
  return state.bootstrap.children.filter((child) => child.familyId === state.family.id);
}

function currentMember() {
  return state.family?.members.find((member) => member.userId === state.bootstrap?.user.id) || null;
}

function activeMembers() {
  return state.family?.members.filter((member) => member.active) || [];
}

function memberLabel(member) {
  const displayName = member.displayName || '未设置昵称';
  return member.userId === state.bootstrap.user.id ? `${displayName}（我）` : displayName;
}

function selectedPlan() {
  return state.plans.get(state.selectedDate);
}

function selectedItem() {
  const entry = selectedPlan();
  if (!entry?.plan || !state.selectedItemId) {
    return null;
  }
  return entry.plan.items.find((item) => item.id === state.selectedItemId) || null;
}

async function restoreSession() {
  try {
    const bootstrap = await state.api.getBootstrap();
    await enterApplication(bootstrap);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      showLogin();
      return;
    }
    showLogin(`暂时无法读取家庭信息：${apiErrorMessage(error)}`);
  }
}

async function handleLogin(event) {
  event.preventDefault();
  clearLoginErrors();

  const email = normalizeEmail(dom.email.value);
  const passwordValue = dom['web-pass'].value;
  const validationErrors = validateLoginInput(email, passwordValue);

  let apiBase;
  try {
    apiBase = normalizeApiBase(dom['api-base'].value);
  } catch (error) {
    setFieldError(dom['api-base'], document.getElementById('api-base-error'), error.message);
    dom['api-base'].focus();
    return;
  }

  setFieldError(dom.email, dom['email-error'], validationErrors.email);
  setFieldError(dom['web-pass'], dom['web-pass-error'], validationErrors['pass' + 'word']);
  if (Object.keys(validationErrors).length > 0) {
    const firstInvalid = validationErrors.email ? dom.email : dom['web-pass'];
    firstInvalid.focus();
    return;
  }

  setLoginBusy(true);
  try {
    state.api.setBaseUrl(apiBase);
    storeApiBase(apiBase);
    await state.api.login({
      email,
      ['pass' + 'word']: passwordValue,
      deviceId: newUuid(),
    });
    dom['web-pass'].value = '';
    await state.api.ensureCsrfToken();
    const bootstrap = await state.api.getBootstrap();
    await enterApplication(bootstrap);
  } catch (error) {
    showLoginError(error instanceof ApiError && error.status === 401
      ? '邮箱或密码不正确，请核对后重试。'
      : `没有登录成功：${apiErrorMessage(error)}`);
    dom['web-pass'].focus();
  } finally {
    setLoginBusy(false);
  }
}

async function handleSignup(event) {
  event.preventDefault();
  clearSignupErrors();

  let apiBase;
  try {
    apiBase = normalizeApiBase(dom['api-base'].value);
  } catch (error) {
    setFieldError(dom['api-base'], document.getElementById('api-base-error'), error.message);
    showSignupError('请先在上方“连接设置”填写有效的 API 地址。');
    dom['api-base'].focus();
    return;
  }

  const validation = validateInvitationSignupInput({
    code: dom['signup-code'].value,
    email: dom['signup-email'].value,
    displayName: dom['signup-name'].value,
    password: dom['signup-pass'].value,
  });
  setFieldError(dom['signup-code'], dom['signup-code-error'], validation.errors.code);
  setFieldError(dom['signup-email'], dom['signup-email-error'], validation.errors.email);
  setFieldError(dom['signup-name'], dom['signup-name-error'], validation.errors.displayName);
  setFieldError(dom['signup-pass'], dom['signup-pass-error'], validation.errors.password);
  const firstInvalid = validation.errors.code
    ? dom['signup-code']
    : validation.errors.email
      ? dom['signup-email']
      : validation.errors.displayName
        ? dom['signup-name']
        : validation.errors.password
          ? dom['signup-pass']
          : null;
  if (firstInvalid) {
    firstInvalid.focus();
    return;
  }

  setSignupBusy(true);
  try {
    state.api.setBaseUrl(apiBase);
    storeApiBase(apiBase);
    await state.api.redeemInvitation({
      operationId: newUuid(),
      token: validation.value.code,
      email: validation.value.email,
      displayName: validation.value.displayName,
      password: validation.value.password,
      deviceId: newUuid(),
    });
    dom['signup-pass'].value = '';
    dom['signup-code'].value = '';
    await state.api.ensureCsrfToken();
    const bootstrap = await state.api.getBootstrap();
    await enterApplication(bootstrap);
    showToast('账号已创建，已加入家庭。');
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      showSignupError('邀请码不存在，请向家庭管理员确认。');
    } else if (error instanceof ApiError && error.code === 'EMAIL_EXISTS') {
      showSignupError('这个邮箱已有账号，请直接登录后在家庭设置中接受邀请。');
    } else if (error instanceof ApiError && error.code === 'INVITATION_USED') {
      showSignupError('这个邀请码已经被使用，请向家庭管理员要一个新的邀请码。');
    } else if (error instanceof ApiError && error.code === 'INVITATION_UNAVAILABLE') {
      showSignupError('这个邀请码已经过期或失效，请向家庭管理员要一个新的邀请码。');
    } else if (error instanceof ApiError && error.status === 429) {
      showSignupError('尝试次数过多，请稍后再试。');
    } else {
      showSignupError(`没有创建成功：${apiErrorMessage(error)}`);
    }
    dom['signup-code'].focus();
  } finally {
    setSignupBusy(false);
  }
}

async function enterApplication(bootstrap) {
  state.bootstrap = bootstrap;
  state.family = bootstrap.families[0] || null;
  state.child = state.family
    ? bootstrap.children.find((child) => child.familyId === state.family.id) || null
    : null;
  state.today = state.family
    ? businessDate(new Date(), state.family.timezone)
    : businessDate(new Date(), 'Asia/Shanghai');
  state.dates = weekDates(state.today);
  state.selectedDate = state.today;
  state.selectedItemId = null;
  state.growth = {
    loaded: false,
    loading: false,
    error: '',
    snapshot: null,
    options: null,
    trash: emptyGrowthTrashState(),
  };
  state.content = {
    loaded: false,
    loading: false,
    enabled: Array.isArray(bootstrap.contentRoles) && bootstrap.contentRoles.length > 0,
    error: '',
    revisions: [],
    releases: [],
    sources: [],
    activities: [],
    evidenceRecords: [],
    revisionsError: '',
    releasesError: '',
    sourcesError: '',
    activitiesError: '',
    evidenceError: '',
  };
  setHidden(dom['content-nav'], !state.content.enabled);
  dom['content-roles'].textContent = state.content.enabled
    ? bootstrap.contentRoles.map((role) => ({ editor: '内容编辑', reviewer: '内容审核', publisher: '内容发布' })[role] || role).join('、')
    : '没有内容管理角色';
  dom['content-role-note'].textContent = state.content.enabled
    ? '页面只显示当前账号获准查看的内容状态；角色仍由服务端逐次校验。'
    : '育儿账号不需要内容角色；这里不会显示隐藏的家庭记录。';
  dom['export-from'].value = dateDaysAgo(state.today, 30);
  dom['export-to'].value = state.today;
  setHidden(dom['export-result'], true);
  clear(dom['export-result']);

  showApp();
  dom['current-user'].textContent = bootstrap.user.displayName || '当前家长';
  dom['boundary-api'].textContent = `API：${state.api.baseUrl}`;
  populateFamilyControls();
  renderOverview();
  renderMembers();
  renderFamilyManagement();
  renderDateStrip();
  switchView('schedule');

  if (!state.family) {
    renderNoFamily();
    renderPreferences();
    return;
  }

  loadPreferences();
  if (state.child) {
    await ensureCurrentChildPlans();
    loadSelectedDay({ force: true });
  } else {
    renderNoChild();
  }
}

async function ensureCurrentChildPlans() {
  if (!state.child) return;
  const generation = state.requestGeneration;
  const childId = state.child.id;
  try {
    const result = await state.api.ensurePlans(childId, newUuid());
    if (generation !== state.requestGeneration || state.child?.id !== childId) return;
    for (const plan of result?.days || []) {
      if (plan?.localDate) {
        state.plans.set(plan.localDate, { loaded: true, plan, error: '' });
      }
    }
  } catch (error) {
    if (generation !== state.requestGeneration || state.child?.id !== childId) return;
    state.plans.set(state.selectedDate, {
      loaded: false,
      plan: null,
      error: apiErrorMessage(error),
    });
  }
}

function populateFamilyControls() {
  clear(dom['family-select']);
  if (state.bootstrap.families.length === 0) {
    dom['family-select'].appendChild(option('', '尚无家庭'));
    dom['family-select'].disabled = true;
  } else {
    dom['family-select'].disabled = false;
    state.bootstrap.families.forEach((family) => {
      dom['family-select'].appendChild(option(family.id, family.name));
    });
    dom['family-select'].value = state.family.id;
  }

  clear(dom['child-select']);
  const children = currentFamilyChildren();
  if (children.length === 0) {
    dom['child-select'].appendChild(option('', '尚无孩子资料'));
    dom['child-select'].disabled = true;
  } else {
    dom['child-select'].disabled = false;
    children.forEach((child) => {
      dom['child-select'].appendChild(option(child.id, child.displayName || '未命名孩子'));
    });
    dom['child-select'].value = state.child.id;
  }
}

function renderOverview() {
  clear(dom['overview-members']);
  if (!state.family) {
    dom['family-overview-title'].textContent = '还没有可访问的家庭';
    dom['family-overview-summary'].textContent = '当前账号尚未加入家庭。账号与邀请入口完成后会在这里显示。';
    return;
  }

  dom['family-overview-title'].textContent = state.family.name;
  const childText = state.child
    ? `${state.child.displayName || '孩子'} · ${describeChildAge(state.child)}`
    : '尚无孩子资料';
  dom['family-overview-summary'].textContent = `${childText} · ${state.family.timezone}`;

  activeMembers().forEach((member) => {
    const chip = element('span', 'member-chip');
    chip.appendChild(element('strong', '', memberLabel(member)));
    chip.appendChild(element('span', '', ROLE_LABELS[member.role] || member.role));
    dom['overview-members'].appendChild(chip);
  });
}

function renderMembers() {
  clear(dom['members-list']);
  if (!state.family) {
    dom['members-list'].appendChild(element('p', 'muted', '当前账号尚未加入家庭。'));
    return;
  }

  activeMembers().forEach((member) => {
    const row = element('div', 'member-row');
    const main = element('div', 'member-main');
    main.appendChild(element('strong', '', memberLabel(member)));
    main.appendChild(element('small', '', ROLE_LABELS[member.role] || member.role));
    row.appendChild(main);
    row.appendChild(element('span', 'tag', member.active ? '有效成员' : '已停用'));
    if (
      currentMember()?.role === 'owner'
      && member.userId !== state.bootstrap.user.id
    ) {
      const remove = element('button', 'button button-danger button-small', '移除');
      remove.type = 'button';
      remove.addEventListener('click', () => removeMember(member));
      row.appendChild(remove);
    }
    dom['members-list'].appendChild(row);
  });
}

async function refreshBootstrap() {
  const previousFamilyId = state.family?.id || null;
  const previousChildId = state.child?.id || null;
  const bootstrap = await state.api.getBootstrap();
  state.bootstrap = bootstrap;
  state.family = bootstrap.families.find((family) => family.id === previousFamilyId)
    || bootstrap.families[0]
    || null;
  state.child = state.family
    ? bootstrap.children.find((child) => child.id === previousChildId)
      || bootstrap.children.find((child) => child.familyId === state.family.id)
      || null
    : null;
  state.content.enabled = Array.isArray(bootstrap.contentRoles)
    && bootstrap.contentRoles.length > 0;
  setHidden(dom['content-nav'], !state.content.enabled);
  dom['content-roles'].textContent = state.content.enabled
    ? bootstrap.contentRoles.map((role) => ({
      editor: '内容编辑',
      reviewer: '内容审核',
      publisher: '内容发布',
    })[role] || role).join('、')
    : '没有内容管理角色';
  populateFamilyControls();
  renderOverview();
  renderMembers();
  renderFamilyManagement();
  return bootstrap;
}

async function removeMember(member) {
  if (!state.family) return;
  if (!confirmDiscardDirtyForm()) return;
  if (!window.confirm(`移除 ${member.displayName || '这位成员'} 后，对方将失去此家庭的访问权。确定继续吗？`)) {
    return;
  }
  try {
    await state.api.removeFamilyMember(
      state.family.id,
      member.userId,
      newUuid(),
    );
    await refreshBootstrap();
    await loadPreferences();
    showToast('家庭成员已移除，访问和后续下载授权已撤销。');
  } catch (error) {
    showGlobalStatus(`没有移除成员：${apiErrorMessage(error)}`);
  }
}

function fieldLabel(control, text) {
  const label = element('label', '', text);
  label.htmlFor = control.id;
  return label;
}

function buildChildSettingsForm() {
  if (!state.child) {
    return element('p', 'inline-alert', '当前家庭没有孩子资料。现有接口不能单独补建孩子，请保留原家庭资料。');
  }
  const form = element('form', 'inline-form');
  form.noValidate = true;
  bindDirtyProtection(form);
  const name = textInput('child-display-name', {
    value: state.child.displayName || '',
    maxLength: 60,
  });
  appendFormField(form, '孩子称呼', name);
  const mode = selectInput('child-age-mode', [
    ['months', '只记月龄和记录日期'],
    ['birthDate', '准确出生日期'],
  ], state.child.ageMode || 'months');
  appendFormField(form, '年龄记录方式', mode);
  const months = textInput('child-age-months', {
    type: 'number',
    value: state.child.ageMonths ?? '',
    min: 0,
    max: 36,
    step: 1,
  });
  const asOf = textInput('child-age-as-of', {
    type: 'date',
    value: state.child.ageAsOf || state.today,
  });
  const birthDate = textInput('child-birth-date', {
    type: 'date',
    value: state.child.birthDate || '',
  });
  const monthFields = element('div', 'form-row');
  monthFields.append(
    (() => {
      const field = element('div', 'field');
      field.append(fieldLabel(months, '当前月龄'), months);
      return field;
    })(),
    (() => {
      const field = element('div', 'field');
      field.append(fieldLabel(asOf, '月龄记录日期'), asOf);
      return field;
    })(),
  );
  const birthField = element('div', 'field');
  birthField.append(fieldLabel(birthDate, '出生日期'), birthDate);
  const syncMode = () => {
    monthFields.hidden = mode.value !== 'months';
    birthField.hidden = mode.value !== 'birthDate';
  };
  mode.addEventListener('change', syncMode);
  syncMode();
  form.append(monthFields, birthField);
  const error = element('p', 'form-alert');
  error.hidden = true;
  form.appendChild(error);
  const submit = element('button', 'button button-primary', '保存孩子资料');
  submit.type = 'submit';
  form.appendChild(submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const validation = validateChildProfileInput({
      displayName: name.value,
      ageMode: mode.value,
      ageMonths: months.value,
      ageAsOf: asOf.value,
      birthDate: birthDate.value,
    });
    if (!validation.valid) {
      error.textContent = Object.values(validation.errors)[0];
      error.hidden = false;
      return;
    }
    if (!confirmDiscardOtherDirtyForms(form)) return;
    submit.disabled = true;
    submit.textContent = '正在保存…';
    try {
      await state.api.updateChild(state.child.id, {
        operationId: newUuid(),
        baseRevision: state.child.revision,
        age: validation.value,
      });
      markFormDirty(form, false);
      await refreshBootstrap();
      renderDateStrip();
      showToast('孩子资料已由家庭 API 保存。');
    } catch (saveError) {
      error.textContent = `没有保存成功，输入仍保留：${apiErrorMessage(saveError)}`;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = '保存孩子资料';
    }
  });
  return form;
}

function buildInvitationForm() {
  const details = element('details', 'connection-settings');
  details.appendChild(element('summary', '', '邀请另一位家长'));
  const form = element('form', 'inline-form');
  form.noValidate = true;
  bindDirtyProtection(form);
  form.appendChild(element(
    'p',
    'field-hint',
    '邀请码由你设置，24 小时内有效且只能使用一次。请避开生日、手机号等容易猜到的内容。',
  ));
  const code = textInput('invite-code', { maxLength: 32 });
  code.autocomplete = 'off';
  code.spellcheck = false;
  const codeBlock = appendFormField(
    form,
    '邀请码',
    code,
    '4～32 个字符，可使用中文、字母、数字、下划线或短横线。',
  );
  const codeError = element('p', 'field-error');
  codeError.id = 'invite-code-error';
  codeBlock.appendChild(codeError);
  const output = element('div', 'stack');
  output.hidden = true;
  const error = element('p', 'form-alert');
  error.hidden = true;
  const submit = element('button', 'button button-primary', '创建邀请码');
  submit.type = 'submit';
  form.append(error, submit, output);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    const codeValue = normalizeInvitationCode(code.value);
    const codeErrorText = validateInvitationCode(codeValue);
    setFieldError(code, codeError, codeErrorText);
    if (codeErrorText) {
      code.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = '正在创建…';
    try {
      const invitation = await state.api.createInvitation(
        state.family.id,
        newUuid(),
        codeValue,
      );
      clear(output);
      output.appendChild(element(
        'p',
        '',
        `有效期至 ${new Date(invitation.expiresAt).toLocaleString('zh-CN')}`,
      ));
      const token = element('textarea');
      token.readOnly = true;
      token.rows = 3;
      token.value = invitation.invitationToken;
      token.setAttribute('aria-label', '家庭邀请码');
      const copy = element('button', 'button button-quiet', '复制邀请码');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(invitation.invitationToken);
          showToast('邀请码已复制。');
        } catch {
          token.focus();
          token.select();
          showToast('已选中邀请码，请按 Ctrl+C 复制。');
        }
      });
      output.append(token, copy);
      output.hidden = false;
      code.value = '';
      markFormDirty(form, false);
    } catch (invitationError) {
      error.textContent = `没有创建邀请码：${apiErrorMessage(invitationError)}`;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = '创建邀请码';
    }
  });
  details.appendChild(form);
  return details;
}

function buildAcceptInvitationForm() {
  const details = element('details', 'connection-settings');
  details.appendChild(element('summary', '', '接受另一个家庭的邀请'));
  const form = element('form', 'inline-form');
  form.noValidate = true;
  bindDirtyProtection(form);
  const token = element('textarea');
  token.id = 'invitation-token';
  token.rows = 3;
  token.maxLength = 4096;
  appendFormField(
    form,
    '邀请码',
    token,
    '填写家庭管理员设置的邀请码；如果收到旧版长邀请令牌，也可整段粘贴。使用当前已登录账号接受邀请，不会创建新账号或公开注册。',
  );
  const error = element('p', 'form-alert');
  error.hidden = true;
  const submit = element('button', 'button button-primary', '接受邀请');
  submit.type = 'submit';
  form.append(error, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!token.value.trim()) {
      error.textContent = '请填写邀请码。';
      error.hidden = false;
      token.focus();
      return;
    }
    if (!confirmDiscardOtherDirtyForms(form)) return;
    submit.disabled = true;
    submit.textContent = '正在加入…';
    try {
      await state.api.acceptInvitation({
        operationId: newUuid(),
        token: token.value.trim(),
      });
      markFormDirty(form, false);
      await refreshBootstrap();
      await loadPreferences();
      showToast('已加入受邀家庭。');
    } catch (acceptError) {
      error.textContent = `没有接受邀请：${apiErrorMessage(acceptError)}`;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = '接受邀请';
    }
  });
  details.appendChild(form);
  return details;
}

function buildCreateFamilyForm() {
  const form = element('form', 'inline-form');
  form.noValidate = true;
  bindDirtyProtection(form);
  const name = textInput('new-family-name', { maxLength: 80 });
  appendFormField(form, '家庭称呼', name, '例如：我们的小家');
  const timezone = textInput('new-family-timezone', {
    value: 'Asia/Shanghai',
    maxLength: 100,
  });
  appendFormField(form, '家庭时区', timezone);
  const childName = textInput('new-family-child-name', { maxLength: 60 });
  appendFormField(form, '孩子称呼', childName);
  const months = textInput('new-family-child-months', {
    type: 'number',
    min: 0,
    max: 36,
    step: 1,
    value: 18,
  });
  appendFormField(form, '当前月龄', months, '可以只记月龄，不必提供出生日期。');
  const error = element('p', 'form-alert');
  error.hidden = true;
  const submit = element('button', 'button button-primary', '创建家庭');
  submit.type = 'submit';
  form.append(error, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!name.value.trim() || !childName.value.trim()) {
      error.textContent = '请填写家庭称呼和孩子称呼。';
      error.hidden = false;
      return;
    }
    const child = validateChildProfileInput({
      displayName: childName.value,
      ageMode: 'months',
      ageMonths: months.value,
      ageAsOf: state.today,
      birthDate: '',
    });
    if (!child.valid) {
      error.textContent = Object.values(child.errors)[0];
      error.hidden = false;
      return;
    }
    if (!confirmDiscardOtherDirtyForms(form)) return;
    submit.disabled = true;
    submit.textContent = '正在创建…';
    try {
      const family = await state.api.createFamily({
        operationId: newUuid(),
        name: name.value.trim(),
        timezone: timezone.value.trim(),
        child: child.value,
      });
      markFormDirty(form, false);
      await refreshBootstrap();
      state.family = state.bootstrap.families.find((item) => item.id === family.id)
        || state.bootstrap.families[0]
        || null;
      state.child = state.bootstrap.children.find((item) => item.familyId === state.family?.id)
        || null;
      populateFamilyControls();
      renderOverview();
      renderMembers();
      renderFamilyManagement();
      renderDateStrip();
      showToast('家庭已创建。');
    } catch (createError) {
      error.textContent = `没有创建家庭：${apiErrorMessage(createError)}`;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = '创建家庭';
    }
  });
  return form;
}

function buildFamilyDeletionForm() {
  const form = element('form', 'inline-form delete-family-form');
  form.noValidate = true;
  bindDirtyProtection(form);
  form.appendChild(element(
    'p',
    'form-alert',
    '删除意图提交后家庭会立即冻结。数据库、照片和导出会被异步永久清理，保留去标识删除墓碑。',
  ));
  const credential = element('input');
  credential.type = 'password';
  credential.id = 'reauth-credential';
  credential.autocomplete = 'current-password';
  credential.maxLength = 256;
  appendFormField(form, '当前账号密码', credential, '输入后五分钟内只能用于本次家庭删除确认。');
  const confirmName = textInput('delete-family-confirm-name', {
    maxLength: 80,
  });
  appendFormField(
    form,
    `输入家庭称呼“${state.family.name}”`,
    confirmName,
    '家庭称呼必须完全一致。',
  );
  const confirmation = element('label', 'check-row');
  const confirmed = element('input');
  confirmed.type = 'checkbox';
  confirmation.append(
    confirmed,
    element('span', '', '我明白删除后不能从网页恢复，并已处理需要保留的数据。'),
  );
  form.appendChild(confirmation);
  const error = element('p', 'form-alert');
  error.hidden = true;
  const submit = element('button', 'button button-danger', '永久删除这个家庭');
  submit.type = 'submit';
  form.append(error, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    if (!credential.value) {
      error.textContent = '请输入当前账号密码重新验证。';
      error.hidden = false;
      credential.focus();
      return;
    }
    if (confirmName.value !== state.family.name || !confirmed.checked) {
      error.textContent = '家庭称呼或删除确认不一致，本次没有提交。';
      error.hidden = false;
      confirmName.focus();
      return;
    }
    if (!confirmDiscardOtherDirtyForms(form)) return;
    if (!window.confirm(
      '下一步会重新验证密码并提交永久删除。家庭访问会立即冻结，确定继续吗？',
    )) return;
    submit.disabled = true;
    submit.textContent = '正在重新验证…';
    try {
      const reauth = await state.api.requestReauth(credential.value);
      submit.textContent = '正在提交删除…';
      await state.api.requestFamilyDeletion(state.family.id, {
        operationId: newUuid(),
        confirmFamilyName: confirmName.value,
        reauthToken: reauth.reauthToken,
      });
      markFormDirty(form, false);
      resetSignedInState();
      showLogin('家庭删除请求已受理。访问已经冻结，请关闭此页面。');
    } catch (deleteError) {
      error.textContent = `家庭没有删除：${apiErrorMessage(deleteError)}`;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = '永久删除这个家庭';
      credential.value = '';
    }
  });
  return form;
}

function renderFamilyManagement() {
  clear(dom['member-management']);
  clear(dom['child-settings']);
  clear(dom['invitation-actions']);
  clear(dom['privacy-actions']);
  dom['danger-zone'].hidden = true;
  if (!state.family) {
    dom['child-settings'].appendChild(element(
      'p',
      'muted',
      '加入或创建家庭后，才能设置孩子资料。',
    ));
    dom['invitation-actions'].append(
      buildCreateFamilyForm(),
      buildAcceptInvitationForm(),
    );
    return;
  }

  dom['child-settings'].appendChild(buildChildSettingsForm());
  dom['invitation-actions'].appendChild(buildAcceptInvitationForm());
  const owner = currentMember()?.role === 'owner';
  if (owner) {
    dom['member-management'].append(
      buildInvitationForm(),
      element(
        'p',
        'field-hint',
        '只有家庭管理员可以生成邀请、移除成员和永久删除家庭。',
      ),
    );
  } else {
    dom['member-management'].appendChild(element(
      'p',
      'muted',
      '你可以共同照护和记录；邀请、移除成员与永久删除由家庭管理员操作。',
    ));
  }
  if (owner) {
    dom['danger-zone'].hidden = false;
    dom['privacy-actions'].appendChild(buildFamilyDeletionForm());
  }
}

async function loadPreferences() {
  if (!state.family) {
    renderPreferences();
    return;
  }

  clear(dom['preferences-content']);
  dom['preferences-content'].appendChild(element('p', 'muted', '正在读取家庭偏好…'));
  try {
    state.preferences = await state.api.getFamilyPreferences(state.family.id);
    state.preferencesError = '';
  } catch (error) {
    state.preferences = null;
    state.preferencesError = apiErrorMessage(error);
  }
  renderPreferences();
}

function renderPreferenceRow(title, contentNode) {
  const row = element('div', 'preference-row');
  row.appendChild(element('strong', '', title));
  row.appendChild(contentNode);
  return row;
}

function renderPreferences() {
  clear(dom['preferences-content']);
  if (!state.family) {
    dom['preferences-content'].appendChild(element('p', 'inline-alert', '当前账号尚未加入家庭，无法读取偏好。'));
    return;
  }
  if (state.preferencesError) {
    const alert = element('div', 'inline-alert');
    alert.appendChild(element('p', '', `偏好没有读取成功：${state.preferencesError}`));
    alert.appendChild(element('p', 'muted', '这里不会用默认材料或语言偏好代替服务端事实。'));
    dom['preferences-content'].appendChild(alert);
    return;
  }
  if (!state.preferences) {
    dom['preferences-content'].appendChild(element('p', 'muted', '正在读取家庭偏好…'));
    return;
  }

  const materials = element('div', 'tag-list');
  if (state.preferences.availableMaterials.length === 0) {
    materials.appendChild(element('span', 'tag', '未确认可用材料'));
  } else {
    state.preferences.availableMaterials.forEach((material) => {
      materials.appendChild(element('span', 'tag', material));
    });
  }

  const excluded = element('div', 'tag-list');
  if (state.preferences.excludedMaterials.length === 0) {
    excluded.appendChild(element('span', 'tag', '没有排除材料'));
  } else {
    state.preferences.excludedMaterials.forEach((material) => {
      excluded.appendChild(element('span', 'tag', material));
    });
  }

  dom['preferences-content'].appendChild(renderPreferenceRow('可用材料', materials));
  dom['preferences-content'].appendChild(renderPreferenceRow('排除材料', excluded));
  dom['preferences-content'].appendChild(renderPreferenceRow(
    '语言方式',
    element('span', 'tag', state.preferences.languageMode === 'zh_with_english' ? '中文，并加入英语' : '中文'),
  ));
  dom['preferences-content'].appendChild(buildPreferencesForm());
}

function buildPreferencesForm() {
  const details = element('details', 'connection-settings');
  details.appendChild(element('summary', '', '修改家庭材料与语言偏好'));
  const form = element('form', 'inline-form');
  form.noValidate = true;
  bindDirtyProtection(form);
  const available = element('textarea');
  available.id = 'preferences-available';
  available.rows = 3;
  available.maxLength = 6000;
  available.value = (state.preferences.availableMaterials || []).join('、');
  appendFormField(
    form,
    '家中已有材料',
    available,
    '每项用逗号或换行分隔。留空表示尚未确认材料，不表示没有材料。',
  );
  const excluded = element('textarea');
  excluded.id = 'preferences-excluded';
  excluded.rows = 3;
  excluded.maxLength = 6000;
  excluded.value = (state.preferences.excludedMaterials || []).join('、');
  appendFormField(form, '需要排除的材料', excluded, '同一项不能同时出现在可用与排除列表。');
  const language = selectInput('preferences-language', [
    ['zh', '中文'],
    ['zh_with_english', '中文，并加入英语'],
  ], state.preferences.languageMode);
  appendFormField(form, '陪伴语言', language);
  const error = element('p', 'form-alert');
  error.hidden = true;
  const submit = element('button', 'button button-primary', '保存家庭偏好');
  submit.type = 'submit';
  form.append(error, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const validation = validatePreferenceInput({
      availableMaterials: available.value,
      excludedMaterials: excluded.value,
      languageMode: language.value,
    });
    if (!validation.valid) {
      error.textContent = Object.values(validation.errors)[0];
      error.hidden = false;
      return;
    }
    if (!confirmDiscardOtherDirtyForms(form)) return;
    submit.disabled = true;
    submit.textContent = '正在保存…';
    try {
      state.preferences = await state.api.updateFamilyPreferences(
        state.family.id,
        {
          operationId: newUuid(),
          baseRevision: state.preferences.revision,
          ...validation.value,
        },
      );
      state.preferencesError = '';
      markFormDirty(form, false);
      renderPreferences();
      showToast('家庭材料与语言偏好已由服务端保存。');
    } catch (saveError) {
      error.textContent = `没有保存偏好，输入仍保留：${apiErrorMessage(saveError)}`;
      error.hidden = false;
    } finally {
      if (submit.isConnected) {
        submit.disabled = false;
        submit.textContent = '保存家庭偏好';
      }
    }
  });
  details.appendChild(form);
  return details;
}

function renderDateStrip() {
  clear(dom['date-strip']);
  state.dates.forEach((date) => {
    const button = element('button', 'date-button');
    button.type = 'button';
    button.dataset.date = date;
    if (date === state.selectedDate) {
      button.classList.add('is-selected');
      button.setAttribute('aria-pressed', 'true');
    } else {
      button.setAttribute('aria-pressed', 'false');
    }

    const relative = date === state.today
      ? '今天'
      : date === addDays(state.today, 1)
        ? '明天'
        : '';
    button.appendChild(element('span', 'date-weekday', formatChineseWeekday(date)));
    button.appendChild(element('span', 'date-number', date.slice(8)));
    button.appendChild(element('span', 'date-relative', relative));
    button.addEventListener('click', () => {
      state.selectedDate = date;
      state.selectedItemId = null;
      setMode('day');
      renderDateStrip();
      loadSelectedDay();
    });
    dom['date-strip'].appendChild(button);
  });
}

async function loadSelectedDay({ force = false } = {}) {
  if (!state.child) {
    renderNoChild();
    return;
  }

  const date = state.selectedDate;
  const existing = state.plans.get(date);
  if (!force && existing?.loaded) {
    renderDayPlan();
    return;
  }

  const generation = state.requestGeneration;
  const childId = state.child.id;
  renderDayLoading();
  try {
    const plan = await state.api.getDayPlan(childId, date);
    if (generation !== state.requestGeneration || childId !== state.child?.id) return;
    state.plans.set(date, {
      loaded: true,
      plan,
      error: '',
    });
  } catch (error) {
    if (generation !== state.requestGeneration || childId !== state.child?.id) return;
    state.plans.set(date, {
      loaded: false,
      plan: null,
      error: apiErrorMessage(error),
    });
  }

  if (generation !== state.requestGeneration || childId !== state.child?.id || date !== state.selectedDate) {
    return;
  }
  renderDayPlan();
}

function renderDayLoading() {
  clear(dom['day-plan-panel']);
  dom['day-plan-panel'].appendChild(element('p', 'empty-state', '正在读取这一天的真实安排…'));
  clear(dom['detail-panel']);
  const empty = element('div', 'empty-detail');
  empty.appendChild(element('p', 'section-kicker', '活动详情'));
  empty.appendChild(element('h2', 'detail-title', '正在读取'));
  empty.appendChild(element('p', '', '选择活动后，完整玩法会显示在这里。'));
  dom['detail-panel'].appendChild(empty);
}

function renderNoFamily() {
  clear(dom['day-plan-panel']);
  const empty = element('div', 'empty-state');
  empty.appendChild(element('h2', '', '还没有家庭'));
  empty.appendChild(element('p', '', '加入或创建家庭后，这里才会读取陪伴安排。'));
  dom['day-plan-panel'].appendChild(empty);
  clear(dom['detail-panel']);
  dom['detail-panel'].appendChild(empty.cloneNode(true));
  clear(dom['week-view']);
}

function renderNoChild() {
  clear(dom['day-plan-panel']);
  const empty = element('div', 'empty-state');
  empty.appendChild(element('h2', '', '还没有孩子资料'));
  empty.appendChild(element('p', '', '当前家庭没有可读取安排的孩子档案。'));
  dom['day-plan-panel'].appendChild(empty);
  clear(dom['detail-panel']);
  dom['detail-panel'].appendChild(empty.cloneNode(true));
}

function planModeLabel(plan) {
  return plan.generationVersion?.startsWith('v2.daily:')
    ? '每日亲子活动 · 可拆开玩'
    : plan.mode === 'lite' ? '轻松一天' : '标准安排';
}

function renderDayPlan() {
  const entry = selectedPlan();
  clear(dom['day-plan-panel']);

  if (!entry) {
    renderDayLoading();
    return;
  }
  if (entry.error) {
    const alert = element('div', 'inline-alert');
    alert.appendChild(element('h2', '', '这一天的安排没有读取成功'));
    alert.appendChild(element('p', '', entry.error));
    const retry = element('button', 'button button-quiet', '重试');
    retry.type = 'button';
    retry.addEventListener('click', () => loadSelectedDay({ force: true }));
    alert.appendChild(retry);
    dom['day-plan-panel'].appendChild(alert);
    renderDetail();
    return;
  }
  if (!entry.plan) {
    const empty = element('div', 'empty-state');
    empty.appendChild(element('h2', '', '今天的安排还没准备好'));
    empty.appendChild(element('p', '', '服务端没有返回这一天的计划，页面不会自动编造内容。'));
    const refresh = element('button', 'button button-quiet', '重新读取');
    refresh.type = 'button';
    refresh.addEventListener('click', () => loadSelectedDay({ force: true }));
    empty.appendChild(refresh);
    dom['day-plan-panel'].appendChild(empty);
    renderDetail();
    return;
  }

  const visibleItems = entry.plan.items.filter((item) => item.visibility === 'active');
  if (visibleItems.length > 0 && !visibleItems.some((item) => item.id === state.selectedItemId)) {
    state.selectedItemId = visibleItems[0].id;
  }

  const header = element('div', 'plan-header');
  const titleWrap = element('div');
  titleWrap.appendChild(element('h2', '', formatChineseDate(entry.plan.localDate, { weekday: true })));
  titleWrap.appendChild(element('p', 'plan-meta', `${planModeLabel(entry.plan)} · 活动预算合计 ${entry.plan.effectiveBudgetMinutes} 分钟`));
  header.appendChild(titleWrap);
  dom['day-plan-panel'].appendChild(header);

  if (visibleItems.length === 0) {
    dom['day-plan-panel'].appendChild(element('p', 'empty-state', '这一天没有已发布的活动。'));
    renderDetail();
    return;
  }

  const list = element('ul', 'activity-list');
  visibleItems.forEach((item) => {
    const listItem = element('li');
    const button = element('button', 'activity-button');
    button.type = 'button';
    button.dataset.itemId = item.id;
    if (item.id === state.selectedItemId) {
      button.classList.add('is-selected');
    }
    if (item.participation) {
      button.classList.add('has-record');
    }

    button.appendChild(element('span', 'activity-kind', KIND_SYMBOLS[item.snapshot.kind] || '玩'));

    const copy = element('span', 'activity-copy');
    copy.appendChild(element('strong', '', item.snapshot.title));
    const subline = [BLOCK_LABELS[item.block] || item.block, `${item.budgetMinutes} 分钟`];
    if (item.blockedByWithdrawal) {
      subline.push('已停止推荐');
    } else if (item.participation) {
      subline.push(item.participation.status === 'played' ? '已记录' : '已跳过');
    }
    copy.appendChild(element('span', '', subline.join(' · ')));
    button.appendChild(copy);
    button.appendChild(element('span', 'activity-time', item.startedAt ? '已开始' : '待安排'));

    button.addEventListener('click', () => {
      state.selectedItemId = item.id;
      document.querySelectorAll('.activity-button').forEach((node) => {
        node.classList.toggle('is-selected', node.dataset.itemId === item.id);
      });
      // 点击旧列表里的活动时重新读取，先取得撤回状态再打开玩法。
      loadSelectedDay({ force: true });
    });
    listItem.appendChild(button);
    list.appendChild(listItem);
  });
  dom['day-plan-panel'].appendChild(list);
  renderDetail();
}

function appendDetailSection(parent, title, contentNode) {
  const section = element('section', 'detail-section');
  section.appendChild(element('h3', '', title));
  section.appendChild(contentNode);
  parent.appendChild(section);
}

function textList(values, ordered = false) {
  const list = element(ordered ? 'ol' : 'ul', ordered ? 'numbered-list' : 'plain-list');
  values.forEach((value) => {
    list.appendChild(element('li', '', value));
  });
  return list;
}

function renderDetail() {
  clear(dom['detail-panel']);
  const item = selectedItem();
  if (!item) {
    const empty = element('div', 'empty-detail');
    empty.appendChild(element('p', 'section-kicker', '活动详情'));
    empty.appendChild(element('h2', 'detail-title', '选择一个活动'));
    empty.appendChild(element('p', '', '材料、玩法、亲子对话和安全提示会显示在这里。'));
    dom['detail-panel'].appendChild(empty);
    return;
  }

  const activity = item.snapshot;
  const heading = element('div', 'detail-heading');
  const titleWrap = element('div');
  titleWrap.appendChild(element('p', 'section-kicker', `${KIND_LABELS[activity.kind] || activity.kind} · ${item.budgetMinutes} 分钟`));
  titleWrap.appendChild(element('h2', 'detail-title', activity.title));
  if (!item.blockedByWithdrawal) titleWrap.appendChild(element('p', 'detail-summary', activity.support));
  heading.appendChild(titleWrap);
  dom['detail-panel'].appendChild(heading);

  const badges = element('div', 'detail-badges');
  badges.appendChild(element('span', 'status-badge', BLOCK_LABELS[item.block] || item.block));
  if (item.participation) {
    badges.appendChild(element(
      'span',
      `status-badge ${item.participation.status}`,
      item.participation.status === 'played' ? '已记录一起玩了' : '已记录今天跳过',
    ));
  }
  if (item.blockedByWithdrawal) {
    badges.appendChild(element('span', 'status-badge blocked', '已停止推荐'));
  }
  dom['detail-panel'].appendChild(badges);

  if (item.blockedByWithdrawal) {
    const notice = element('div', 'inline-alert');
    notice.appendChild(element('p', '', item.withdrawalReason || '这个玩法已停止推荐，请先换一个。'));
    if (item.participation) {
      notice.appendChild(element('p', '', '以前的参与记录仍然保留。'));
      for (const note of item.participation.notes || []) {
        if (note.text) notice.appendChild(element('p', '', note.text));
      }
    }
    dom['detail-panel'].appendChild(notice);
    return;
  }

  const materials = activity.materials.length > 0
    ? textList(activity.materials)
    : element('p', 'muted', '这个活动不需要额外材料。');
  appendDetailSection(dom['detail-panel'], '需要准备', materials);
  appendDetailSection(dom['detail-panel'], '怎么玩', textList(activity.steps, true));

  const dialogue = element('div', 'dialogue-grid');
  [
    ['这样开场', activity.dialogue.opening],
    ['孩子投入时', activity.dialogue.engaged],
    ['孩子观察时', activity.dialogue.observing],
    ['准备停止', activity.dialogue.stopping],
  ].forEach(([label, text]) => {
    const line = element('div', 'dialogue-item');
    line.appendChild(element('strong', '', label));
    line.appendChild(element('span', '', text));
    dialogue.appendChild(line);
  });
  appendDetailSection(dom['detail-panel'], '可以这样说', dialogue);

  if (activity.english?.phrase) {
    const english = element('div', 'stack');
    english.appendChild(element('strong', '', activity.english.phrase));
    english.appendChild(element('span', '', activity.english.meaning));
    english.appendChild(element('small', 'muted', activity.english.when));
    appendDetailSection(dom['detail-panel'], '英语短语', english);
  }

  const adaptations = element('div', 'stack');
  adaptations.appendChild(element('p', '', `更轻松：${activity.easier}`));
  adaptations.appendChild(element('p', '', `想往前一步：${activity.next}`));
  appendDetailSection(dom['detail-panel'], '按孩子的状态调整', adaptations);

  const safety = element('div', 'safety-note');
  safety.appendChild(element('strong', '', '安全提醒'));
  safety.appendChild(element('p', '', activity.safety));
  appendDetailSection(dom['detail-panel'], '安全前请先看', safety);

  dom['detail-panel'].appendChild(buildParticipationForm(item));
}

function fieldBlock(labelText, control, hint = '') {
  const block = element('div', 'field');
  const label = element('label', '', labelText);
  label.htmlFor = control.id;
  block.appendChild(label);
  block.appendChild(control);
  if (hint) {
    block.appendChild(element('p', 'field-hint', hint));
  }
  return block;
}

function buildParticipationForm(item) {
  const box = element('section', 'participation-box');
  box.appendChild(element('h3', '', item.participation ? '更新参与记录' : '记下这次参与'));
  box.appendChild(element('p', 'muted', '“一起玩了”只表示真实参与过，不代表完成度或能力评价。实际时长可以留空。'));

  if (state.selectedDate > state.today) {
    box.appendChild(element('p', 'future-note', '未来安排仅供查看，到当天后才能记录参与。'));
    return box;
  }
  if (item.blockedByWithdrawal) {
    box.appendChild(element('p', 'future-note', '这个玩法已停止推荐，不能再继续执行或新增记录。'));
    return box;
  }

  const existing = item.participation;
  const currentUser = state.bootstrap.user;
  const ownNote = existing?.notes.find((note) => note.authorId === currentUser.id)?.text || '';
  const participantIds = new Set(existing?.participantIds ?? []);
  if (!existing && currentMember()?.active) {
    participantIds.add(currentUser.id);
  }

  const form = element('form');
  form.noValidate = true;

  const statusField = element('fieldset', 'field');
  statusField.appendChild(element('legend', '', '这次怎么样'));
  const statusChoices = element('div', 'choice-row');
  [
    ['played', '一起玩了'],
    ['skipped', '今天先跳过'],
  ].forEach(([value, label]) => {
    const choice = element('label', 'choice-pill');
    const radio = element('input');
    radio.type = 'radio';
    radio.name = 'status';
    radio.value = value;
    radio.checked = (existing?.status || 'played') === value;
    choice.appendChild(radio);
    choice.appendChild(element('span', '', label));
    statusChoices.appendChild(choice);
  });
  statusField.appendChild(statusChoices);
  const statusError = element('p', 'field-error', '');
  statusField.appendChild(statusError);
  form.appendChild(statusField);

  const participantField = element('fieldset', 'field');
  participantField.appendChild(element('legend', '', '谁一起参与'));
  const participantChoices = element('div', 'choice-row');
  activeMembers().forEach((member) => {
    const choice = element('label', 'choice-pill');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'participantIds';
    checkbox.value = member.userId;
    checkbox.checked = participantIds.has(member.userId);
    choice.appendChild(checkbox);
    choice.appendChild(element('span', '', memberLabel(member)));
    participantChoices.appendChild(choice);
  });
  participantField.appendChild(participantChoices);
  const participantError = element('p', 'field-error', '');
  participantField.appendChild(participantError);
  form.appendChild(participantField);

  const row = element('div', 'form-row');
  const minutes = element('input');
  minutes.id = 'actual-minutes';
  minutes.name = 'actualMinutes';
  minutes.type = 'number';
  minutes.inputMode = 'numeric';
  minutes.min = '0';
  minutes.max = '1440';
  minutes.step = '1';
  minutes.value = existing?.actualMinutes ?? '';
  const minutesBlock = fieldBlock('实际玩了几分钟（可不填）', minutes);
  const minutesError = element('p', 'field-error', '');
  minutesBlock.appendChild(minutesError);
  row.appendChild(minutesBlock);
  form.appendChild(row);

  const note = element('textarea');
  note.id = 'participation-note';
  note.name = 'note';
  note.maxLength = 2000;
  note.value = ownNote;
  const noteBlock = fieldBlock('留一句给家人（可选）', note, `${note.value.length}/2000；另一位家长的备注不会被覆盖。`);
  const noteError = element('p', 'field-error', '');
  noteBlock.appendChild(noteError);
  form.appendChild(noteBlock);
  note.addEventListener('input', () => {
    noteBlock.querySelector('.field-hint').textContent = `${note.value.length}/2000；另一位家长的备注不会被覆盖。`;
  });

  const againRow = element('label', 'check-row');
  const again = element('input');
  again.type = 'checkbox';
  again.name = 'again';
  again.checked = Boolean(existing?.again);
  againRow.appendChild(again);
  againRow.appendChild(element('span', '', '下次还想再玩'));
  form.appendChild(againRow);

  const result = element('p', 'field-error', '');
  result.setAttribute('role', 'status');
  form.appendChild(result);

  const submit = element('button', 'button button-primary button-wide', existing ? '更新记录' : '保存参与记录');
  submit.type = 'submit';
  form.appendChild(submit);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    [statusError, participantError, minutesError, noteError].forEach((node) => {
      node.textContent = '';
    });
    result.textContent = '';
    result.className = 'field-error';

    const status = form.elements.namedItem('status')?.value || '';
    const checkedParticipants = [...form.querySelectorAll('input[name="participantIds"]:checked')]
      .map((node) => node.value);
    const validation = validateParticipationInput({
      status,
      participantIds: checkedParticipants,
      note: note.value,
      actualMinutes: minutes.value,
    });

    statusError.textContent = validation.errors.status || '';
    participantError.textContent = validation.errors.participantIds || '';
    noteError.textContent = validation.errors.note || '';
    minutesError.textContent = validation.errors.actualMinutes || '';
    if (Object.keys(validation.errors).length > 0) {
      const firstInvalid = validation.errors.status
        ? statusField.querySelector('input')
        : validation.errors.participantIds
          ? participantField.querySelector('input')
          : validation.errors.actualMinutes
            ? minutes
            : note;
      firstInvalid?.focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = '正在保存…';
    try {
      const saved = await state.api.saveParticipation(item.id, {
        operationId: newUuid(),
        baseRevision: existing?.revision ?? 0,
        ...validation.value,
        again: again.checked,
      });
      item.participation = saved;
      const entry = selectedPlan();
      if (entry?.plan) {
        entry.plan.items = entry.plan.items.map((candidate) => candidate.id === item.id
          ? { ...candidate, participation: saved }
          : candidate);
      }
      renderDayPlan();
      showGlobalStatus('参与记录已保存到家庭 API。', 'success', 4000);
    } catch (error) {
      result.className = 'inline-alert';
      result.textContent = `没有保存成功，刚才写的内容仍在表单里。${apiErrorMessage(error)}`;
    } finally {
      submit.disabled = false;
      submit.textContent = existing ? '更新记录' : '保存参与记录';
    }
  });

  box.appendChild(form);
  return box;
}

function showPanelMessage(node, message, kind = 'error') {
  node.className = kind === 'success' ? 'form-success' : 'inline-alert';
  node.textContent = message;
  setHidden(node, !message);
}

function appendFormField(parent, labelText, control, hint = '') {
  const block = fieldBlock(labelText, control, hint);
  parent.appendChild(block);
  return block;
}

function textInput(id, { type = 'text', value = '', maxLength, min, max, step } = {}) {
  const input = element('input');
  input.id = id;
  input.type = type;
  input.value = value;
  if (maxLength !== undefined) input.maxLength = maxLength;
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  if (step !== undefined) input.step = String(step);
  return input;
}

function selectInput(id, choices, value = '') {
  const select = element('select');
  select.id = id;
  choices.forEach(([choiceValue, label]) => select.appendChild(option(choiceValue, label)));
  select.value = value || choices[0]?.[0] || '';
  return select;
}

function growthSnapshotForChild() {
  const snapshot = state.growth.snapshot;
  if (!snapshot) return null;
  return {
    memories: (snapshot.memories || []).filter(
      (item) => item.childId === state.child?.id && !item.deletedAt,
    ),
    measurements: (snapshot.measurements || []).filter(
      (item) => item.childId === state.child?.id,
    ),
    observations: (snapshot.observations || []).filter(
      (item) => item.childId === state.child?.id,
    ),
  };
}

function stageFocuses() {
  return (state.growth.options?.stageGuides || []).flatMap((guide) =>
    guide.focuses.map((focus) => ({ ...focus, ageBand: guide.ageBand, guideTitle: guide.title })),
  );
}

async function readGrowthSnapshot(familyId) {
  const pages = [];
  const seenTokens = new Set();
  let pageToken = '';
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const page = await state.api.getFamilySnapshot(familyId, { pageToken, limit: 100 });
    pages.push(page);
    if (!page.hasMore) return mergeSnapshotPages(pages);
    const nextToken = page.nextPageToken;
    if (!nextToken || seenTokens.has(nextToken)) {
      throw new Error('家庭快照分页令牌缺失或重复，已停止合并');
    }
    seenTokens.add(nextToken);
    pageToken = nextToken;
  }
  throw new Error('家庭快照超过安全分页上限，已停止合并');
}

async function loadGrowth({ force = false } = {}) {
  if (!state.family) {
    renderGrowth();
    return;
  }
  if (force && !confirmDiscardDirtyForm()) return false;
  if (state.growth.loading) return;
  if (state.growth.loaded && !force) {
    renderGrowth();
    return;
  }

  state.growth.loading = true;
  state.growth.error = '';
  showPanelMessage(dom['growth-status'], '正在读取家庭成长记录与书架…', 'success');
  const generation = state.requestGeneration;
  const familyId = state.family.id;
  try {
    let snapshot;
    try {
      snapshot = await readGrowthSnapshot(familyId);
    } catch (error) {
      if (error.status !== 410 || generation !== state.requestGeneration) throw error;
      snapshot = await readGrowthSnapshot(familyId);
    }
    // 快照不签发照片链接；每张照片在家长主动打开时重新核对权限。
    let options = null;
    try {
      options = await state.api.getContentOptions();
    } catch {
      // 阶段线索缺失不影响已经存在的成长事实；观察表会明确显示待接入。
    }
    if (generation === state.requestGeneration && state.family?.id === familyId) {
      state.growth.snapshot = snapshot;
      state.growth.options = options;
      state.growth.loaded = true;
    }
  } catch (error) {
    if (generation === state.requestGeneration) state.growth.error = apiErrorMessage(error);
  } finally {
    state.growth.loading = false;
  }
  if (generation !== state.requestGeneration || state.family?.id !== familyId) {
    if (state.view === 'growth' && state.family && !state.growth.loaded) {
      queueMicrotask(() => loadGrowth({ force: true }));
    }
    return;
  }
  renderGrowth();
  return true;
}

function renderGrowth() {
  clear(dom['growth-history']);
  clear(dom['growth-form']);
  clear(dom['books-list']);
  clear(dom['growth-trash-list']);
  setHidden(dom['growth-trash'], !state.child);
  if (!state.family) {
    dom['growth-history'].appendChild(element('p', 'empty-card', '当前账号尚未加入家庭。'));
    dom['growth-count'].textContent = '不可读取';
    showPanelMessage(dom['growth-status'], '');
    return;
  }
  if (state.growth.error) {
    showPanelMessage(dom['growth-status'], `成长记录没有读取成功：${state.growth.error}`);
    dom['growth-history'].appendChild(element('p', 'empty-card', '没有用演示内容代替服务端事实。'));
    dom['growth-count'].textContent = '读取失败';
    return;
  }
  if (state.growth.loading || !state.growth.loaded) {
    dom['growth-history'].appendChild(element('p', 'empty-card', '正在读取真实记录…'));
    dom['growth-count'].textContent = '读取中';
    return;
  }

  showPanelMessage(dom['growth-status'], '');
  const snapshot = growthSnapshotForChild();
  const events = sortedGrowthEvents(snapshot);
  dom['growth-count'].textContent = `${events.length} 条`;
  if (!state.child) {
    dom['growth-history'].appendChild(element('p', 'empty-card', '当前家庭还没有孩子档案。'));
  } else if (events.length === 0) {
    dom['growth-history'].appendChild(element('p', 'empty-card', '还没有成长记录。可以从右侧记下真实发生的一件小事。'));
  } else {
    events.forEach((item) => dom['growth-history'].appendChild(renderGrowthEntry(item)));
  }

  renderGrowthForms();
  renderBooks();
  if (dom['growth-trash'].open) void loadGrowthTrash({ force: true });
}

const GROWTH_TRASH_KIND_LABELS = {
  memory: '小记',
  measurement: '测量',
  observation: '观察',
};

function taggedGrowthTrashItems(kind, result) {
  return (result?.items || []).map((item) => ({ ...item, eventKind: kind }));
}

async function readDeletedGrowthKind(kind, childId, cursor = '') {
  if (kind === 'memory') {
    return state.api.listDeletedMemories(childId, cursor);
  }
  if (kind === 'measurement') {
    return state.api.listDeletedMeasurements(childId, cursor);
  }
  return state.api.listDeletedObservations(childId, cursor);
}

async function restoreDeletedGrowthKind(kind, item) {
  const body = { operationId: newUuid(), baseRevision: item.revision };
  if (kind === 'memory') return state.api.restoreMemory(item.id, body);
  if (kind === 'measurement') return state.api.restoreMeasurement(item.id, body);
  return state.api.restoreObservation(item.id, body);
}

function sortedGrowthTrashItems(items) {
  return [...items].sort((left, right) => {
    const leftTime = String(left.deletedAt || left.localDate);
    const rightTime = String(right.deletedAt || right.localDate);
    return rightTime.localeCompare(leftTime) || String(left.id).localeCompare(String(right.id));
  });
}

async function loadGrowthTrash({ force = false } = {}) {
  const childId = state.child?.id;
  const generation = state.requestGeneration;
  if (!childId) return;
  if (!force && (state.growth.trash.loading || state.growth.trash.loaded)) {
    renderGrowthTrash();
    return;
  }
  const trash = emptyGrowthTrashState();
  trash.loading = true;
  state.growth.trash = trash;
  renderGrowthTrash();
  try {
    const [memories, measurements, observations] = await Promise.all([
      state.api.listDeletedMemories(childId),
      state.api.listDeletedMeasurements(childId),
      state.api.listDeletedObservations(childId),
    ]);
    if (
      generation !== state.requestGeneration
      || state.child?.id !== childId
      || state.growth.trash !== trash
    ) {
      return;
    }
    trash.loaded = true;
    trash.loading = false;
    trash.items = sortedGrowthTrashItems([
      ...taggedGrowthTrashItems('memory', memories),
      ...taggedGrowthTrashItems('measurement', measurements),
      ...taggedGrowthTrashItems('observation', observations),
    ]);
    trash.nextCursor = {
      memory: memories.nextCursor || null,
      measurement: measurements.nextCursor || null,
      observation: observations.nextCursor || null,
    };
  } catch (error) {
    if (generation !== state.requestGeneration || state.child?.id !== childId) return;
    trash.loaded = false;
    trash.loading = false;
    trash.error = apiErrorMessage(error);
  }
  renderGrowthTrash();
}

async function loadMoreGrowthTrash(kind) {
  const childId = state.child?.id;
  const cursor = state.growth.trash.nextCursor[kind];
  if (!childId || !cursor || state.growth.trash.loadingKind) return;
  const generation = state.requestGeneration;
  const trash = state.growth.trash;
  trash.loadingKind = kind;
  trash.error = '';
  renderGrowthTrash();
  try {
    const result = await readDeletedGrowthKind(kind, childId, cursor);
    if (
      generation !== state.requestGeneration
      || state.child?.id !== childId
      || state.growth.trash !== trash
    ) {
      return;
    }
    const existing = new Set(trash.items.map((item) => `${item.eventKind}:${item.id}`));
    trash.items = sortedGrowthTrashItems([
      ...trash.items,
      ...taggedGrowthTrashItems(kind, result)
        .filter((item) => !existing.has(`${item.eventKind}:${item.id}`)),
    ]);
    trash.nextCursor[kind] = result.nextCursor || null;
  } catch (error) {
    if (generation !== state.requestGeneration || state.child?.id !== childId) return;
    trash.error = `更多${GROWTH_TRASH_KIND_LABELS[kind]}没有读取成功：${apiErrorMessage(error)}`;
  } finally {
    if (state.growth.trash === trash) {
      trash.loadingKind = '';
      renderGrowthTrash();
    }
  }
}

function renderGrowthTrash() {
  const panel = dom['growth-trash-list'];
  clear(panel);
  const trash = state.growth.trash;
  if (trash.loading) {
    panel.appendChild(element('p', 'muted', '正在读取最近删除的小记、测量与观察…'));
    return;
  }
  if (!trash.loaded) {
    panel.appendChild(element(
      'p',
      'inline-alert',
      `最近删除没有读取成功：${trash.error || '未知错误'}`,
    ));
    const retry = element('button', 'button button-quiet', '重新读取');
    retry.type = 'button';
    retry.addEventListener('click', () => loadGrowthTrash({ force: true }));
    panel.appendChild(retry);
    return;
  }
  if (trash.error) {
    panel.appendChild(element('p', 'inline-alert', trash.error));
  }
  if (trash.items.length === 0) {
    panel.appendChild(element('p', 'muted', '没有可以恢复的成长记录。'));
    return;
  }
  for (const item of trash.items) {
    panel.appendChild(renderGrowthTrashEntry(item));
  }
  const nav = element('div', 'growth-entry-actions');
  for (const kind of ['memory', 'measurement', 'observation']) {
    if (!trash.nextCursor[kind]) continue;
    const label = trash.loadingKind === kind
      ? `正在读取更多${GROWTH_TRASH_KIND_LABELS[kind]}…`
      : `更多${GROWTH_TRASH_KIND_LABELS[kind]}`;
    const button = element('button', 'button button-quiet', label);
    button.type = 'button';
    button.disabled = Boolean(trash.loadingKind);
    button.addEventListener('click', () => loadMoreGrowthTrash(kind));
    nav.appendChild(button);
  }
  if (nav.childElementCount > 0) panel.appendChild(nav);
}

function renderGrowthTrashEntry(item) {
  const kind = item.eventKind;
  const card = element('article', 'growth-entry');
  const header = element('div', 'growth-entry-header');
  const title = element('div');
  const labels = {
    memory: MEMORY_TYPE_LABELS[item.type] || '成长小记',
    measurement: MEASUREMENT_KIND_LABELS[item.kind] || '测量',
    observation: '阶段观察',
  };
  title.appendChild(element('strong', '', labels[kind]));
  title.appendChild(element('p', 'growth-entry-meta', item.localDate));
  header.appendChild(title);
  header.appendChild(element('span', 'tag warning', GROWTH_TRASH_KIND_LABELS[kind]));
  card.appendChild(header);
  if (kind === 'memory') {
    card.appendChild(element('p', '', item.text));
  } else if (kind === 'measurement') {
    const method = {
      recumbent: '卧位身长',
      standing: '站立身高',
      scale: '体重秤',
    }[item.method] || item.method;
    card.appendChild(element('p', '', `${item.value} ${item.unit} · ${method}`));
  } else {
    card.appendChild(element(
      'p',
      '',
      OBSERVATION_VALUE_LABELS[item.value] || item.value,
    ));
    if (item.note) card.appendChild(element('p', '', item.note));
  }
  if (item.deletedAt) {
    card.appendChild(element(
      'p',
      'growth-entry-meta',
      `删除于 ${new Date(item.deletedAt).toLocaleString('zh-CN')}`,
    ));
  }
  const restore = element(
    'button',
    'button button-quiet',
    `恢复这条${GROWTH_TRASH_KIND_LABELS[kind]}`,
  );
  restore.type = 'button';
  restore.addEventListener('click', async () => {
    if (!confirmDiscardDirtyForm()) return;
    restore.disabled = true;
    try {
      await restoreDeletedGrowthKind(kind, item);
      showToast(`${GROWTH_TRASH_KIND_LABELS[kind]}已恢复。`);
      await loadGrowth({ force: true });
      if (dom['growth-trash'].open) {
        await loadGrowthTrash({ force: true });
      }
    } catch (error) {
      showGlobalStatus(
        `未能恢复${GROWTH_TRASH_KIND_LABELS[kind]}：${apiErrorMessage(error)}`,
      );
      restore.disabled = false;
    }
  });
  card.appendChild(restore);
  return card;
}

function renderGrowthEntry(item) {
  const card = element('article', 'growth-entry');
  const header = element('div', 'growth-entry-header');
  const titleWrap = element('div');
  const labels = {
    memory: MEMORY_TYPE_LABELS[item.type] || '成长小记',
    measurement: MEASUREMENT_KIND_LABELS[item.kind] || '测量',
    observation: '阶段观察',
  };
  titleWrap.appendChild(element('strong', '', labels[item.eventKind]));
  titleWrap.appendChild(element('p', 'growth-entry-meta', item.localDate));
  header.appendChild(titleWrap);
  header.appendChild(element(
    'span',
    `tag ${item.eventKind === 'measurement' ? 'warning' : 'good'}`,
    item.eventKind === 'measurement' ? `${item.value} ${item.unit}` : `修订 ${item.revision}`,
  ));
  card.appendChild(header);

  if (item.eventKind === 'memory') {
    card.appendChild(element('p', '', item.text));
    appendMemoryPhotos(card, item);
    if (item.firstConfirmed) {
      card.appendChild(element('p', 'growth-entry-meta', '已由家长明确确认这是第一次。'));
    }
  } else if (item.eventKind === 'measurement') {
    const method = {
      recumbent: '卧位身长',
      standing: '站立身高',
      scale: '体重秤',
    }[item.method] || item.method;
    card.appendChild(element('p', '', `${item.value} ${item.unit} · ${method} · ${item.source === 'clinic' ? '儿保/医院' : '家中'}`));
    card.appendChild(element('p', 'growth-entry-meta', '这里只保存测量事实，不计算百分位，也不作诊断。'));
  } else {
    card.appendChild(element('p', '', OBSERVATION_VALUE_LABELS[item.value] || item.value));
    if (item.note) card.appendChild(element('p', '', item.note));
    card.appendChild(element('p', 'growth-entry-meta', `观察线索：${item.guideId}`));
  }

  const actions = element('div', 'growth-entry-actions');
  const remove = element('button', 'button button-danger', '删除这条误记');
  remove.type = 'button';
  remove.addEventListener('click', () => deleteGrowthEntry(item));
  actions.appendChild(remove);
  card.appendChild(actions);
  return card;
}

function appendMemoryPhotos(card, memory) {
  const media = (state.growth.snapshot?.media || [])
    .filter((item) => item.memoryId === memory.id && item.state !== 'deleted');
  if (media.length === 0) return;
  const gallery = element('div', 'growth-photo-grid');
  media.forEach((item) => {
    const frame = element('figure', 'growth-photo');
    if (item.state === 'ready') {
      const view = element('button', 'button button-quiet', '查看照片');
      view.type = 'button';
      view.addEventListener('click', async () => {
        view.disabled = true;
        try {
          const info = await state.api.getMedia(item.id);
          const downloadUrl = state.api.signedDownloadUrl('media', item.id, info.downloadUrl);
          if (!downloadUrl) throw new Error('暂时没有可用的照片链接。');
          const image = element('img');
          image.alt = '成长小记照片';
          image.src = downloadUrl;
          image.addEventListener('error', () => {
            image.replaceWith(view);
            view.disabled = false;
            showGlobalStatus('照片链接已过期或不可用，可以重试。');
          }, { once: true });
          view.replaceWith(image);
        } catch (error) {
          view.disabled = false;
          showGlobalStatus(`照片没有打开：${apiErrorMessage(error)}`);
        }
      });
      frame.appendChild(view);
    } else {
      const labels = {
        pending: '照片正在等待上传',
        processing: '照片正在处理',
        failed: '照片处理失败',
      };
      frame.appendChild(element(
        'div',
        'photo-placeholder',
        labels[item.state] || '照片尚未就绪',
      ));
    }
    gallery.appendChild(frame);
  });
  card.appendChild(gallery);
}

async function deleteGrowthEntry(item) {
  if (!confirmDiscardDirtyForm()) return;
  const confirmation = item.eventKind === 'memory'
    ? '这条小记会移到“最近删除”，30 天内可恢复。确定删除吗？'
    : '这条记录会从成长历史移除，并同步到其他设备。确定删除吗？';
  if (!window.confirm(confirmation)) return;
  const body = { operationId: newUuid(), baseRevision: item.revision };
  try {
    if (item.eventKind === 'memory') {
      await state.api.deleteMemory(item.id, { ...body, permanent: false });
    } else if (item.eventKind === 'measurement') {
      await state.api.deleteMeasurement(item.id, body);
    } else {
      await state.api.deleteObservation(item.id, body);
    }
    showToast('删除已由家庭 API 确认。');
    await loadGrowth({ force: true });
  } catch (error) {
    showGlobalStatus(`没有删除成功：${apiErrorMessage(error)}`);
  }
}

function renderGrowthForms() {
  if (!state.child) {
    dom['growth-form'].appendChild(element('p', 'empty-card', '先补充孩子档案，才能新增记录。'));
    return;
  }
  dom['growth-form'].appendChild(buildMemoryForm());
  dom['growth-form'].appendChild(buildMeasurementForm());
  dom['growth-form'].appendChild(buildObservationForm());
}

function buildMemoryForm() {
  const details = element('details', 'connection-settings');
  details.open = true;
  details.appendChild(element('summary', '', '宝宝原话、小故事或第一次'));
  const form = element('form', 'inline-form');
  form.noValidate = true;
  bindDirtyProtection(form);
  const date = textInput('memory-date', { type: 'date', value: state.today, max: state.today });
  appendFormField(form, '发生日期', date);
  const type = selectInput('memory-type', [
    ['quote', '宝宝原话'],
    ['story', '小故事'],
    ['first', '第一次'],
  ], 'quote');
  appendFormField(form, '记录类型', type);
  const text = element('textarea');
  text.id = 'memory-text';
  text.maxLength = 2000;
  text.rows = 4;
  appendFormField(form, '写下真实发生的内容', text, '不会自动从活动参与记录生成“第一次”。');
  const photo = element('input');
  photo.id = 'memory-photo';
  photo.type = 'file';
  photo.accept = 'image/jpeg,image/png,image/webp';
  appendFormField(
    form,
    '可选照片',
    photo,
    '只读取你选中的一张照片，离开系统选择器后不保留整库访问权限；单张不超过 20MB。',
  );
  const firstRow = element('label', 'check-row');
  const firstConfirmed = element('input');
  firstConfirmed.type = 'checkbox';
  firstRow.appendChild(firstConfirmed);
  firstRow.appendChild(element('span', '', '我确认这确实是宝宝第一次做到'));
  firstRow.hidden = true;
  form.appendChild(firstRow);
  type.addEventListener('change', () => {
    firstRow.hidden = type.value !== 'first';
  });
  const error = element('p', 'form-alert');
  error.hidden = true;
  const finish = element('button', 'button button-quiet', '照片暂不重试，查看已保存正文');
  finish.type = 'button';
  finish.hidden = true;
  form.append(error, finish);
  const submit = element('button', 'button button-primary', '保存成长小记');
  submit.type = 'submit';
  form.appendChild(submit);
  let savedMemoryId = '';
  let memorySaved = false;
  let saveAttempt = null;
  const lockSavedText = () => {
    [date, type, text, firstConfirmed].forEach((control) => {
      control.disabled = true;
    });
    finish.hidden = false;
  };
  finish.addEventListener('click', async () => {
    finish.disabled = true;
    await loadGrowth({ force: true });
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    const value = text.value.trim();
    if (!date.value || date.value > state.today) {
      error.textContent = '请选择今天或过去的日期。';
      error.hidden = false;
      date.focus();
      return;
    }
    if (!value) {
      error.textContent = '请先写下真实发生的内容。';
      error.hidden = false;
      text.focus();
      return;
    }
    if (type.value === 'first' && !firstConfirmed.checked) {
      error.textContent = '请确认这确实是第一次，再保存。';
      error.hidden = false;
      firstConfirmed.focus();
      return;
    }
    if (!confirmDiscardOtherDirtyForms(form)) return;
    submit.disabled = true;
    submit.textContent = '正在保存…';
    try {
      if (!savedMemoryId) {
        const fields = {
          localDate: date.value,
          type: type.value,
          text: value,
          firstConfirmed: type.value === 'first' && firstConfirmed.checked,
          mediaIds: [],
        };
        const key = JSON.stringify(fields);
        if (saveAttempt?.key !== key) {
          saveAttempt = { key, body: { ...fields, operationId: newUuid(), id: newUuid() } };
        }
        await state.api.createMemory(state.child.id, saveAttempt.body);
        savedMemoryId = saveAttempt.body.id;
        memorySaved = true;
        lockSavedText();
        markFormDirty(form, false);
      }
      if (photo.files?.[0]) {
        submit.textContent = '正文已保存，正在上传照片…';
        const media = await uploadMemoryPhoto(savedMemoryId, photo.files[0]);
        if (media.state !== 'ready') {
          throw new Error(`照片已上传，但服务端状态仍为“${media.state}”`);
        }
      }
      markFormDirty(form, false);
      showToast(photo.files?.[0]
        ? '成长小记已保存，照片已由家庭服务处理完成。'
        : '成长小记已保存到家庭 API。');
      await loadGrowth({ force: true });
    } catch (saveError) {
      error.textContent = memorySaved
        ? `正文已经保存，但照片没有完成：${apiErrorMessage(saveError)}。再次点击只会为同一条正文重试照片，不会新建重复记录。`
        : `没有保存成功，内容仍在表单里。${apiErrorMessage(saveError)}`;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = savedMemoryId ? '重试上传这张照片' : '保存成长小记';
    }
  });
  details.appendChild(form);
  return details;
}

async function digestFile(file) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前浏览器不支持照片完整性校验，请改用最新版浏览器或手机端上传。');
  }
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function uploadMemoryPhoto(memoryId, file) {
  const mime = file.type;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
    throw new Error('只支持 JPEG、PNG 或 WebP 照片');
  }
  if (file.size < 1 || file.size > 20 * 1024 * 1024) {
    throw new Error('照片大小需在 1 字节至 20MB 之间');
  }
  const sha256 = await digestFile(file);
  const ticket = await state.api.createMediaUpload({
    operationId: newUuid(),
    memoryId,
    mime,
    byteSize: file.size,
    sha256,
  });
  await state.api.uploadMediaBytes(ticket.uploadUrl, file, mime);
  let media = await state.api.completeMediaUpload(ticket.media.id, newUuid());
  for (let attempt = 0; attempt < 12 && !['ready', 'failed'].includes(media.state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    media = await state.api.getMedia(ticket.media.id);
  }
  if (media.state === 'failed') {
    throw new Error('服务端未能处理这张照片');
  }
  return media;
}

function buildMeasurementForm() {
  const details = element('details', 'connection-settings');
  details.appendChild(element('summary', '', '身高或体重测量'));
  const form = element('form', 'inline-form');
  form.noValidate = true;
  bindDirtyProtection(form);
  const date = textInput('measurement-date', { type: 'date', value: state.today, max: state.today });
  appendFormField(form, '测量日期', date);
  const kind = selectInput('measurement-kind', [['height', '身高'], ['weight', '体重']], 'height');
  appendFormField(form, '测量类型', kind);
  const value = textInput('measurement-value', { type: 'number', min: 0.1, max: 300, step: 0.1 });
  appendFormField(form, '数值', value);
  const method = selectInput('measurement-method', [
    ['recumbent', '卧位身长'],
    ['standing', '站立身高'],
  ], 'standing');
  appendFormField(form, '测量方式', method);
  const source = selectInput('measurement-source', [['home', '家中'], ['clinic', '儿保或医院']], 'home');
  appendFormField(form, '来源', source);
  const syncMethod = () => {
    clear(method);
    if (kind.value === 'weight') {
      method.appendChild(option('scale', '体重秤'));
      method.value = 'scale';
    } else {
      method.appendChild(option('standing', '站立身高'));
      method.appendChild(option('recumbent', '卧位身长'));
      method.value = 'standing';
    }
  };
  kind.addEventListener('change', syncMethod);
  syncMethod();
  const error = element('p', 'form-alert');
  error.hidden = true;
  form.appendChild(error);
  const submit = element('button', 'button button-primary', '保存测量');
  submit.type = 'submit';
  form.appendChild(submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    const numericValue = Number(value.value);
    if (!date.value || date.value > state.today) {
      error.textContent = '请选择今天或过去的日期。';
      error.hidden = false;
      return;
    }
    if (!Number.isFinite(numericValue) || numericValue <= 0 || numericValue > 300) {
      error.textContent = '请输入大于 0 且不超过 300 的测量值。';
      error.hidden = false;
      value.focus();
      return;
    }
    if (!confirmDiscardOtherDirtyForms(form)) return;
    submit.disabled = true;
    submit.textContent = '正在保存…';
    try {
      await state.api.createMeasurement(state.child.id, {
        operationId: newUuid(),
        id: newUuid(),
        localDate: date.value,
        kind: kind.value,
        value: numericValue,
        unit: kind.value === 'height' ? 'cm' : 'kg',
        method: method.value,
        source: source.value,
      });
      markFormDirty(form, false);
      showToast('测量事实已保存。');
      await loadGrowth({ force: true });
    } catch (saveError) {
      error.textContent = `没有保存成功，刚才填写的数值仍在表单里。${apiErrorMessage(saveError)}`;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = '保存测量';
    }
  });
  details.appendChild(form);
  return details;
}

function buildObservationForm() {
  const details = element('details', 'connection-settings');
  details.appendChild(element('summary', '', '记录一次阶段观察'));
  const focuses = stageFocuses();
  if (focuses.length === 0) {
    details.appendChild(element(
      'p',
      'inline-alert',
      '阶段观察线索尚未由内容服务返回，当前页面不会让家长手填内部编号或伪造观察项。',
    ));
    return details;
  }
  const form = element('form', 'inline-form');
  form.noValidate = true;
  bindDirtyProtection(form);
  const date = textInput('observation-date', { type: 'date', value: state.today, max: state.today });
  appendFormField(form, '观察日期', date);
  const guide = selectInput(
    'observation-guide',
    focuses.map((focus) => [focus.id, `${focus.title} · ${focus.domain}`]),
  );
  appendFormField(form, '观察线索', guide);
  const value = selectInput('observation-value', [
    ['noticed', OBSERVATION_VALUE_LABELS.noticed],
    ['not_yet_observed', OBSERVATION_VALUE_LABELS.not_yet_observed],
    ['discuss', OBSERVATION_VALUE_LABELS.discuss],
  ], 'noticed');
  appendFormField(form, '这次看到什么', value);
  const note = element('textarea');
  note.id = 'observation-note';
  note.maxLength = 2000;
  note.rows = 3;
  appendFormField(form, '补充说明（可选）', note);
  const boundary = element(
    'p',
    'field-hint',
    '“还没留意”不等于能力不足。这里不做评分、百分位或发育诊断。',
  );
  form.appendChild(boundary);
  const error = element('p', 'form-alert');
  error.hidden = true;
  form.appendChild(error);
  const submit = element('button', 'button button-primary', '保存阶段观察');
  submit.type = 'submit';
  form.appendChild(submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!date.value || date.value > state.today) {
      error.textContent = '请选择今天或过去的日期。';
      error.hidden = false;
      return;
    }
    if (!confirmDiscardOtherDirtyForms(form)) return;
    submit.disabled = true;
    submit.textContent = '正在保存…';
    try {
      await state.api.createObservation(state.child.id, {
        operationId: newUuid(),
        id: newUuid(),
        guideId: guide.value,
        localDate: date.value,
        value: value.value,
        note: note.value.trim(),
      });
      markFormDirty(form, false);
      showToast('阶段观察已保存到家庭 API。');
      await loadGrowth({ force: true });
    } catch (saveError) {
      error.textContent = `没有保存成功，刚才填写的内容仍在表单里。${apiErrorMessage(saveError)}`;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = '保存阶段观察';
    }
  });
  details.appendChild(form);
  return details;
}

function renderBooks() {
  const books = state.growth.snapshot?.books || [];
  if (books.length === 0) {
    dom['books-list'].appendChild(element('p', 'empty-card', '书架还没有登记项。'));
    return;
  }
  books.forEach((book) => {
    const row = element('div', 'book-row');
    const copy = element('div');
    copy.appendChild(element('strong', '', book.title));
    copy.appendChild(element('p', 'book-meta', `${book.language} · ${book.editionStatus === 'verified' ? '版本已确认' : '版本待核对'}`));
    if (book.note) copy.appendChild(element('p', '', book.note));
    row.appendChild(copy);
    const remove = element('button', 'button button-danger', '移除');
    remove.type = 'button';
    remove.addEventListener('click', () => deleteBook(book));
    row.appendChild(remove);
    dom['books-list'].appendChild(row);
  });
}

async function deleteBook(book) {
  if (!confirmDiscardDirtyForm()) return;
  if (!window.confirm(`从家庭书架移除《${book.title}》？`)) return;
  try {
    await state.api.deleteFamilyBook(book.id, {
      operationId: newUuid(),
      baseRevision: book.revision,
    });
    showToast('书架已更新。');
    await loadGrowth({ force: true });
  } catch (error) {
    showGlobalStatus(`没有移除成功：${apiErrorMessage(error)}`);
  }
}

async function handleBookSubmit(event) {
  event.preventDefault();
  if (!state.family) return;
  const error = dom['book-form-error'];
  const title = dom['book-title'].value.trim();
  const language = dom['book-language'].value.trim();
  error.hidden = true;
  if (!title || !language) {
    error.textContent = '请填写书名和语言。';
    error.hidden = false;
    (title ? dom['book-language'] : dom['book-title']).focus();
    return;
  }
  if (!confirmDiscardOtherDirtyForms(dom['book-form'])) return;
  dom['book-submit'].disabled = true;
  dom['book-submit'].textContent = '正在保存…';
  try {
    await state.api.createFamilyBook(state.family.id, {
      operationId: newUuid(),
      title,
      editionId: null,
      language,
      note: dom['book-note'].value.trim(),
    });
    markFormDirty(dom['book-form'], false);
    dom['book-title'].value = '';
    dom['book-note'].value = '';
    showToast('已登记到家庭书架。');
    await loadGrowth({ force: true });
  } catch (saveError) {
    error.textContent = `没有登记成功：${apiErrorMessage(saveError)}`;
    error.hidden = false;
  } finally {
    dom['book-submit'].disabled = false;
    dom['book-submit'].textContent = '登记到书架';
  }
}

function renderExportResult(exportJob, error = '') {
  clear(dom['export-result']);
  setHidden(dom['export-result'], !exportJob && !error);
  if (error) {
    dom['export-result'].appendChild(element('p', 'inline-alert', error));
    return;
  }
  const card = element('div', 'export-status');
  const statusLabels = {
    queued: '已进入队列',
    running: '正在准备',
    ready: '可以下载',
    failed: '导出失败',
    expired: '下载已过期',
  };
  card.appendChild(element('strong', '', statusLabels[exportJob.status] || exportJob.status));
  card.appendChild(element('p', 'growth-entry-meta', `任务 ${exportJob.id}`));
  if (exportJob.expiresAt) {
    card.appendChild(element('p', 'growth-entry-meta', `下载截止：${new Date(exportJob.expiresAt).toLocaleString('zh-CN')}`));
  }
  const download = state.api.signedDownloadUrl('exports', exportJob.id, exportJob.downloadUrl);
  if (exportJob.status === 'expired') {
    card.appendChild(element(
      'p',
      'inline-alert',
      '这次导出的下载链接已经过期，旧链接不能继续使用。请按原范围重新申请一次导出。',
    ));
  } else if (exportJob.status === 'failed') {
    card.appendChild(element(
      'p',
      'inline-alert',
      '服务端没有完成这次导出。已有家庭记录不会因此改变，可以重新申请。',
    ));
  } else if (download) {
    const link = element('a', 'button button-primary', '下载家庭数据');
    link.href = download;
    link.download = `babyplan-${exportJob.id}.zip`;
    card.appendChild(link);
  } else if (exportJob.status === 'ready') {
    card.appendChild(element(
      'p',
      'inline-alert',
      '服务端报告导出已完成，但没有返回可用下载地址。请联系部署管理员核对存储配置。',
    ));
  }
  if ((exportJob.missingMedia || []).length > 0) {
    card.appendChild(element('p', 'inline-alert', `有 ${exportJob.missingMedia.length} 个照片未能打包，原因会在下载清单中列出。`));
  }
  dom['export-result'].appendChild(card);
}

async function pollExport(exportId) {
  let job = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      job = await state.api.getExport(exportId);
      renderExportResult(job);
      if (['ready', 'failed', 'expired'].includes(job.status)) return job;
    } catch (error) {
      renderExportResult(null, `导出状态没有读取成功：${apiErrorMessage(error)}`);
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return job;
}

async function handleExportSubmit(event) {
  event.preventDefault();
  if (!state.family) return;
  const errorNode = dom['export-form-error'];
  errorNode.hidden = true;
  const types = [...dom['export-form'].querySelectorAll('input[name="export-types"]:checked')]
    .map((node) => node.value);
  const validation = validateExportRequest({
    from: dom['export-from'].value,
    to: dom['export-to'].value,
    types,
  });
  if (!validation.valid) {
    errorNode.textContent = Object.values(validation.errors)[0];
    errorNode.hidden = false;
    return;
  }
  if (!confirmDiscardOtherDirtyForms(dom['export-form'])) return;
  dom['export-submit'].disabled = true;
  dom['export-submit'].textContent = '正在申请…';
  setHidden(dom['export-result'], true);
  try {
    const job = await state.api.createExport(state.family.id, {
      operationId: newUuid(),
      from: dom['export-from'].value,
      to: dom['export-to'].value,
      types,
      includeMedia: dom['export-media'].checked,
    });
    markFormDirty(dom['export-form'], false);
    renderExportResult(job);
    if (!['ready', 'failed', 'expired'].includes(job.status)) {
      await pollExport(job.id);
    }
  } catch (exportError) {
    const message = exportError instanceof ApiError && exportError.status === 404
      ? '导出接口尚未在当前服务中提供；本次没有创建任务。'
      : `导出申请没有成功：${apiErrorMessage(exportError)}`;
    renderExportResult(null, message);
  } finally {
    dom['export-submit'].disabled = false;
    dom['export-submit'].textContent = '申请导出';
  }
}

async function collectCursorItems(fetchPage) {
  const items = [];
  const seenCursors = new Set();
  let cursor = '';
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const page = await fetchPage(cursor);
    items.push(...(Array.isArray(page?.items) ? page.items : []));
    const nextCursor = page?.nextCursor;
    if (!nextCursor) return items;
    if (seenCursors.has(nextCursor)) {
      throw new Error('内容分页游标重复，已停止继续读取');
    }
    if (pageIndex === 99) {
      throw new Error('内容分页超过安全上限，已停止继续读取');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return items;
}

async function collectEvidenceRecords(revisions) {
  const allReferences = [...new Set(
    revisions.flatMap((revision) =>
      Array.isArray(revision.evidenceRefs) ? revision.evidenceRefs : [],
    ),
  )];
  const references = allReferences.slice(0, MAX_EVIDENCE_DETAIL_REQUESTS);
  const records = [];
  const failures = [];
  for (let index = 0; index < references.length; index += 6) {
    const batch = references.slice(index, index + 6);
    const results = await Promise.allSettled(
      batch.map((reference) => state.api.getReviewEvidence(reference)),
    );
    results.forEach((result, resultIndex) => {
      if (result.status === 'fulfilled') {
        records.push(result.value);
      } else {
        failures.push({ reference: batch[resultIndex], error: result.reason });
      }
    });
  }
  return {
    records,
    failures,
    deferredCount: allReferences.length - references.length,
  };
}

async function loadContent({ force = false } = {}) {
  if (!state.content.enabled || !state.bootstrap) {
    renderContent();
    return;
  }
  if (force && !confirmDiscardDirtyForm()) return false;
  if (state.content.loading) return;
  if (state.content.loaded && !force) {
    renderContent();
    return;
  }
  state.content.loading = true;
  state.content.error = '';
  state.content.revisionsError = '';
  state.content.releasesError = '';
  state.content.sourcesError = '';
  state.content.activitiesError = '';
  state.content.evidenceError = '';
  showPanelMessage(dom['content-status'], '正在读取内容审核队列…', 'success');
  try {
    const [revisionResult, releaseResult, sourceResult, optionResult] = await Promise.allSettled([
      collectCursorItems((cursor) => state.api.listContentRevisions({ cursor })),
      collectCursorItems((cursor) => state.api.listContentReleases({ cursor })),
      state.api.listContentSources(),
      state.api.getContentOptions(),
    ]);

    if (revisionResult.status === 'fulfilled') {
      state.content.revisions = revisionResult.value;
    } else {
      state.content.revisions = [];
      state.content.revisionsError = apiErrorMessage(revisionResult.reason);
    }
    if (releaseResult.status === 'fulfilled') {
      state.content.releases = releaseResult.value;
    } else {
      state.content.releases = [];
      state.content.releasesError = apiErrorMessage(releaseResult.reason);
    }
    if (sourceResult.status === 'fulfilled') {
      state.content.sources = Array.isArray(sourceResult.value?.sources)
        ? sourceResult.value.sources
        : [];
    } else {
      state.content.sources = [];
      state.content.sourcesError = apiErrorMessage(sourceResult.reason);
    }
    if (optionResult.status === 'fulfilled') {
      state.content.activities = Array.isArray(optionResult.value?.activities)
        ? optionResult.value.activities
        : [];
    } else {
      state.content.activities = [];
      state.content.activitiesError = apiErrorMessage(optionResult.reason);
    }

    const evidenceResult = await collectEvidenceRecords(state.content.revisions);
    state.content.evidenceRecords = evidenceResult.records;
    if (evidenceResult.failures.length > 0 || evidenceResult.deferredCount > 0) {
      state.content.evidenceError = [
        evidenceResult.failures.length > 0
          ? `有 ${evidenceResult.failures.length} 项审读证据未能读取`
          : '',
        evidenceResult.deferredCount > 0
          ? `另有 ${evidenceResult.deferredCount} 项因批量安全上限未自动展开`
          : '',
      ].filter(Boolean).join('；') + '；缺失或未展开的记录不会被当作审核通过。';
    }
    state.content.loaded = true;
  } catch (error) {
    state.content.error = apiErrorMessage(error);
  } finally {
    state.content.loading = false;
  }
  renderContent();
  return true;
}

function renderContent() {
  clear(dom['content-creator']);
  clear(dom['content-revisions']);
  clear(dom['content-releases']);
  clear(dom['publish-gate-actions']);
  if (!state.content.enabled) {
    dom['content-status'].textContent = '当前账号没有内容角色，不能读取内容工作台。';
    setHidden(dom['content-status'], false);
    dom['revision-count'].textContent = '无权限';
    dom['release-count'].textContent = '无权限';
    return;
  }
  if (state.content.error) {
    showPanelMessage(dom['content-status'], `内容工作台没有读取成功：${state.content.error}`);
    dom['revision-count'].textContent = '读取失败';
    dom['release-count'].textContent = '读取失败';
    dom['content-revisions'].appendChild(element('p', 'empty-card', '没有用演示内容替代审核事实。'));
    dom['content-releases'].appendChild(element('p', 'empty-card', '发布历史暂不可见。'));
    return;
  }
  if (state.content.loading || !state.content.loaded) {
    dom['content-status'].textContent = '正在读取真实内容审核队列…';
    setHidden(dom['content-status'], false);
    return;
  }
  const sectionProblems = [
    state.content.revisionsError && `修订：${state.content.revisionsError}`,
    state.content.releasesError && `发布历史：${state.content.releasesError}`,
    state.content.sourcesError && `来源：${state.content.sourcesError}`,
    state.content.activitiesError && `当前发布内容：${state.content.activitiesError}`,
    state.content.evidenceError,
  ].filter(Boolean);
  showPanelMessage(
    dom['content-status'],
    sectionProblems.length > 0
      ? `工作台只显示已读取的真实部分。${sectionProblems.join('；')}`
      : '',
    sectionProblems.length > 0 ? 'error' : 'success',
  );
  dom['revision-count'].textContent = state.content.revisionsError
    ? '接口未接入'
    : `${state.content.revisions.length} 项`;
  dom['release-count'].textContent = state.content.releasesError
    ? '接口未接入'
    : `${state.content.releases.length} 项`;
  renderContentCreator();
  if (state.content.revisionsError) {
    dom['content-revisions'].appendChild(element(
      'p',
      'empty-card',
      `内容修订没有读取成功：${state.content.revisionsError}`,
    ));
  } else if (state.content.revisions.length === 0) {
    dom['content-revisions'].appendChild(element('p', 'empty-card', '当前没有内容修订。'));
  } else {
    state.content.revisions.forEach((revision) => {
      dom['content-revisions'].appendChild(renderRevision(revision));
    });
  }
  if (state.content.releasesError) {
    dom['content-releases'].appendChild(element(
      'p',
      'empty-card',
      `发布历史没有读取成功：${state.content.releasesError}`,
    ));
  } else if (state.content.releases.length === 0) {
    dom['content-releases'].appendChild(element('p', 'empty-card', '当前没有发布版本。'));
  } else {
    state.content.releases.forEach((release) => {
      dom['content-releases'].appendChild(renderRelease(release));
    });
  }
  renderPublishGate();
}

function latestRevisionByActivity() {
  const latest = new Map();
  state.content.revisions.forEach((revision) => {
    if (!revision.activity?.id) return;
    const current = latest.get(revision.activity.id);
    if (!current || revision.revision > current.revision) {
      latest.set(revision.activity.id, revision);
    }
  });
  return latest;
}

function contentEditorChoices() {
  const choices = [];
  const seen = new Set();
  const latest = [...latestRevisionByActivity().values()]
    .sort((left, right) => left.activity.title.localeCompare(right.activity.title, 'zh-CN'));
  latest.forEach((revision) => {
    seen.add(revision.activity.id);
    choices.push({
      revision,
      activity: revision.activity,
      label: `${revision.activity.title} · 服务端修订 ${revision.revision}`,
    });
  });
  state.content.activities.forEach((activity) => {
    if (seen.has(activity.id)) return;
    choices.push({
      revision: null,
      activity,
      label: `${activity.title} · 当前发布内容`,
    });
  });
  return choices;
}

function renderContentCreator() {
  clear(dom['content-creator']);
  const roles = state.bootstrap?.contentRoles || [];
  if (!roles.includes('editor')) return;
  const choices = contentEditorChoices();
  const header = element('div', 'section-heading-row');
  const title = element('div');
  title.appendChild(element('p', 'section-kicker', '可编辑正文'));
  title.appendChild(element('h3', '', '创建下一修订'));
  header.appendChild(title);
  dom['content-creator'].appendChild(header);
  if (choices.length === 0) {
    dom['content-creator'].appendChild(element(
      'p',
      state.content.activitiesError ? 'inline-alert' : 'empty-card',
      state.content.activitiesError
        ? `没有读到可编辑的发布内容：${state.content.activitiesError}`
        : '当前没有已发布内容或已有修订可供继续编辑。',
    ));
    return;
  }
  const picker = selectInput(
    'content-activity-picker',
    choices.map((choice, index) => [String(index), choice.label]),
    '0',
  );
  appendFormField(
    dom['content-creator'],
    '选择内容',
    picker,
    '保存会生成不可变的新修订；已发布正文和家庭历史快照不会被覆盖。',
  );
  const editorHost = element('div', 'stack');
  dom['content-creator'].appendChild(editorHost);
  let selectedIndex = picker.value;
  const renderSelection = () => {
    clear(editorHost);
    const choice = choices[Number(picker.value)] || choices[0];
    editorHost.appendChild(buildActivityEditor(choice.activity, choice.revision));
  };
  picker.addEventListener('change', () => {
    if (!confirmDiscardDirtyForm()) {
      picker.value = selectedIndex;
      return;
    }
    selectedIndex = picker.value;
    renderSelection();
  });
  renderSelection();
}

function editorField(id, label, value, { multiline = false, maxLength = 2000, hint = '' } = {}) {
  const field = element('div', 'field');
  const control = element(multiline ? 'textarea' : 'input');
  control.id = id;
  control.maxLength = maxLength;
  if (multiline) {
    control.rows = 3;
    control.value = value ?? '';
  } else {
    control.value = value ?? '';
  }
  field.appendChild(fieldLabel(control, label));
  field.appendChild(control);
  if (hint) field.appendChild(element('small', 'field-hint', hint));
  return { field, control };
}

function buildActivityEditor(activity, baseRevision) {
  const editor = element('details', 'connection-settings activity-editor');
  editor.open = true;
  editor.appendChild(element('summary', '', `编辑《${activity.title}》正文`));
  const form = element('form', 'inline-form content-editor-form');
  form.noValidate = true;
  bindDirtyProtection(form);
  const title = editorField('content-title', '标题', activity.title, { maxLength: 60 });
  const kind = selectInput('content-kind', [
    ['movement', '运动'],
    ['explore', '探索'],
    ['reading', '共读'],
    ['english', '英语'],
    ['child-led', '孩子主导'],
    ['calm', '安静收尾'],
  ], activity.kind);
  const support = editorField('content-support', '支持方向', activity.support, {
    multiline: true,
    maxLength: 300,
  });
  const materials = editorField(
    'content-materials',
    '材料（每行一项）',
    (activity.materials || []).join('\n'),
    { multiline: true, maxLength: 1800 },
  );
  const steps = editorField(
    'content-steps',
    '步骤（每行一步，最多五步）',
    (activity.steps || []).join('\n'),
    { multiline: true, maxLength: 2000 },
  );
  const dialogue = activity.dialogue || {};
  const opening = editorField('content-opening', '亲子对话 · 开场', dialogue.opening, {
    multiline: true,
    maxLength: 300,
  });
  const engaged = editorField('content-engaged', '亲子对话 · 投入', dialogue.engaged, {
    multiline: true,
    maxLength: 300,
  });
  const observing = editorField('content-observing', '亲子对话 · 观察', dialogue.observing, {
    multiline: true,
    maxLength: 300,
  });
  const stopping = editorField('content-stopping', '亲子对话 · 停止出口', dialogue.stopping, {
    multiline: true,
    maxLength: 300,
  });
  const english = activity.english || {};
  const phrase = editorField('content-english-phrase', '英语短句', english.phrase, {
    maxLength: 200,
  });
  const meaning = editorField('content-english-meaning', '英语中文含义', english.meaning, {
    maxLength: 200,
  });
  const when = editorField('content-english-when', '英语使用时机', english.when, {
    multiline: true,
    maxLength: 300,
  });
  const easier = editorField('content-easier', '更容易的版本', activity.easier, {
    multiline: true,
    maxLength: 300,
  });
  const next = editorField('content-next', '可选下一步', activity.next, {
    multiline: true,
    maxLength: 300,
  });
  const safety = editorField('content-safety', '安全说明与停止条件', activity.safety, {
    multiline: true,
    maxLength: 700,
  });
  const sources = editorField(
    'content-sources',
    '来源编号（逗号分隔）',
    (activity.sourceIds || []).join(', '),
    { maxLength: 600 },
  );
  const changeNote = editorField('content-change-note', '本次修改说明', '', {
    multiline: true,
    maxLength: 2000,
  });
  const grid = element('div', 'editor-grid');
  grid.append(
    title.field,
    (() => {
      const field = element('div', 'field');
      field.append(fieldLabel(kind, '活动类型'), kind);
      return field;
    })(),
    support.field,
    materials.field,
    steps.field,
    opening.field,
    engaged.field,
    observing.field,
    stopping.field,
    phrase.field,
    meaning.field,
    when.field,
    easier.field,
    next.field,
    safety.field,
    sources.field,
    changeNote.field,
  );
  form.appendChild(grid);
  const error = element('p', 'form-alert');
  error.hidden = true;
  const submit = element('button', 'button button-primary', '保存新修订草稿');
  submit.type = 'submit';
  form.append(error, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const materialsValue = splitTextValues(materials.control.value);
    const stepsValue = splitTextValues(steps.control.value);
    const sourceValues = splitCommaValues(sources.control.value);
    if (
      !title.control.value.trim()
      || !support.control.value.trim()
      || stepsValue.length === 0
      || stepsValue.length > 5
      || !safety.control.value.trim()
      || sourceValues.length === 0
    ) {
      error.textContent = '标题、支持方向、1～5 个步骤、安全说明和至少一个来源编号不能为空。';
      error.hidden = false;
      return;
    }
    if (!confirmDiscardOtherDirtyForms(form)) return;
    const nextRevision = Number(activity.revision) + 1;
    submit.disabled = true;
    submit.textContent = '正在保存草稿…';
    try {
      await state.api.createContentRevision(activity.id, {
        operationId: newUuid(),
        baseRevision: Number(activity.revision),
        activity: {
          ...activity,
          revision: nextRevision,
          title: title.control.value.trim(),
          kind: kind.value,
          support: support.control.value.trim(),
          materials: materialsValue,
          steps: stepsValue,
          dialogue: {
            opening: opening.control.value.trim(),
            engaged: engaged.control.value.trim(),
            observing: observing.control.value.trim(),
            stopping: stopping.control.value.trim(),
          },
          english: {
            phrase: phrase.control.value.trim(),
            meaning: meaning.control.value.trim(),
            when: when.control.value.trim(),
          },
          easier: easier.control.value.trim(),
          next: next.control.value.trim(),
          safety: safety.control.value.trim(),
          sourceIds: sourceValues,
          reviewState: 'draft',
          withdrawn: false,
        },
        changeNote: changeNote.control.value.trim(),
      });
      markFormDirty(form, false);
      showToast(`《${title.control.value.trim()}》修订 ${nextRevision} 已保存为草稿。`);
      await loadContent({ force: true });
    } catch (saveError) {
      error.textContent = `没有保存修订，输入仍保留：${apiErrorMessage(saveError)}`;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = '保存新修订草稿';
    }
  });
  editor.appendChild(form);
  return editor;
}

function displayDiffValue(value) {
  if (Array.isArray(value)) return value.join('、') || '（空）';
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${item}`)
      .join('；') || '（空）';
  }
  return String(value ?? '') || '（空）';
}

function buildRevisionDiff(revision) {
  const previous = state.content.revisions
    .filter((item) => (
      item.activity?.id === revision.activity?.id
      && item.revision < revision.revision
    ))
    .sort((left, right) => right.revision - left.revision)[0];
  if (!previous) return null;
  const changes = activityDiff(previous.activity, revision.activity);
  const details = element('details', 'connection-settings revision-diff');
  details.appendChild(element(
    'summary',
    '',
    `与修订 ${previous.revision} 比较：${changes.length} 个字段变化`,
  ));
  if (changes.length === 0) {
    details.appendChild(element('p', 'muted', '正文可见字段没有变化。'));
    return details;
  }
  const list = element('dl', 'diff-list');
  changes.forEach((change) => {
    list.appendChild(element('dt', '', change.label));
    const values = element('dd');
    values.appendChild(element('span', 'diff-old', `原：${displayDiffValue(change.previous)}`));
    values.appendChild(element('span', 'diff-new', `新：${displayDiffValue(change.current)}`));
    list.appendChild(values);
  });
  details.appendChild(list);
  return details;
}

function buildSubmitRevisionForm(revision) {
  const form = element('form', 'inline-form compact-form');
  form.noValidate = true;
  bindDirtyProtection(form);
  const submit = element('button', 'button button-primary', '送审这个固定草稿');
  submit.type = 'submit';
  const error = element('p', 'form-alert');
  error.hidden = true;
  form.append(
    element('p', 'field-hint', '送审后正文不可直接修改；如需调整，应从本修订创建下一修订。'),
    error,
    submit,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = '正在送审…';
    try {
      await state.api.submitContentRevision(revision.id, {
        operationId: newUuid(),
        baseRevision: revision.revision,
      });
      markFormDirty(form, false);
      showToast('固定修订已进入审核队列。');
      await loadContent({ force: true });
    } catch (submitError) {
      error.textContent = `没有送审：${apiErrorMessage(submitError)}`;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = '送审这个固定草稿';
    }
  });
  return form;
}

function matchingEvidence(revision) {
  return state.content.evidenceRecords.filter((record) => (
    record.cardId === revision.activity?.id
    && record.revision === revision.revision
    && record.contentHash === revision.contentHash
    && record.decision === 'approved'
  ));
}

function revisionDomSuffix(revision) {
  return String(revision.id || revision.revision)
    .replace(/[^a-zA-Z0-9_-]/g, '-');
}

function buildEvidenceForm(revision) {
  const suffix = revisionDomSuffix(revision);
  const details = element('details', 'connection-settings evidence-form');
  details.appendChild(element('summary', '', '登记一条真实审读或试玩证据'));
  const form = element('form', 'inline-form');
  form.noValidate = true;
  bindDirtyProtection(form);
  const kind = selectInput(`evidence-kind-${suffix}`, [
    ['expert_review', '专业审阅'],
    ['family_trial', '家庭试玩'],
    ['rights_license', '内容授权'],
  ], 'expert_review');
  appendFormField(form, '证据类型', kind);
  const evidenceRef = textInput(`evidence-reference-${suffix}`, { maxLength: 1000 });
  appendFormField(form, '原始证据引用', evidenceRef, '填写真实笔记编号、文件位置或其他可由审读人核对的引用。');

  const expertField = element('div', 'field');
  const qualificationRef = textInput(`evidence-qualification-${suffix}`, { maxLength: 1000 });
  expertField.append(
    fieldLabel(qualificationRef, '专业资质或审阅角色引用'),
    qualificationRef,
  );
  form.appendChild(expertField);

  const trialField = element('div', 'field');
  const completedAt = textInput(`evidence-completed-at-${suffix}`, {
    type: 'date',
    value: state.today,
    max: state.today,
  });
  trialField.append(fieldLabel(completedAt, '试玩完成日期'), completedAt);
  form.appendChild(trialField);

  const rightsFields = element('div', 'stack');
  const authorizationRef = textInput(`evidence-authorization-${suffix}`, { maxLength: 1000 });
  const scope = textInput(`evidence-scope-${suffix}`, { maxLength: 1000 });
  const rightsGrid = element('div', 'form-row');
  const authField = element('div', 'field');
  authField.append(fieldLabel(authorizationRef, '授权文件引用'), authorizationRef);
  const scopeField = element('div', 'field');
  scopeField.append(fieldLabel(scope, '授权范围'), scope);
  rightsGrid.append(authField, scopeField);
  rightsFields.appendChild(rightsGrid);

  const environments = element('fieldset', 'field');
  environments.appendChild(element(
    'legend',
    '',
    '这条证据支持哪些发布环境',
  ));
  const environmentRow = element('div', 'choice-row');
  [['private_trial', '私人试用'], ['public', '公开发布']].forEach(([value, label]) => {
    const choice = element('label', 'choice-pill');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.value = value;
    choice.append(checkbox, element('span', '', label));
    environmentRow.appendChild(choice);
  });
  environments.appendChild(environmentRow);
  form.appendChild(rightsFields);
  form.appendChild(environments);

  const syncKind = () => {
    expertField.hidden = kind.value !== 'expert_review';
    trialField.hidden = kind.value !== 'family_trial';
    rightsFields.hidden = kind.value !== 'rights_license';
  };
  kind.addEventListener('change', syncKind);
  syncKind();
  const error = element('p', 'form-alert');
  error.hidden = true;
  const submit = element('button', 'button button-primary', '登记绑定此正文的证据');
  submit.type = 'submit';
  form.append(error, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!evidenceRef.value.trim()) {
      error.textContent = '请填写可核对的原始证据引用。';
      error.hidden = false;
      evidenceRef.focus();
      return;
    }
    const allowedEnvironments = [...environmentRow.querySelectorAll('input:checked')]
      .map((input) => input.value);
    if (allowedEnvironments.length === 0) {
      error.textContent = '请选择这条证据支持的至少一个发布环境。';
      error.hidden = false;
      environments.querySelector('input')?.focus();
      return;
    }
    const record = {
      id: newUuid(),
      kind: kind.value,
      cardId: revision.activity.id,
      revision: revision.revision,
      contentHash: revision.contentHash,
      actorId: state.bootstrap.user.id,
      actorKind: 'human',
      createdAt: new Date().toISOString(),
      decision: 'approved',
      evidenceRef: evidenceRef.value.trim(),
    };
    if (kind.value === 'expert_review') {
      if (!qualificationRef.value.trim()) {
        error.textContent = '专业审阅必须填写资质或角色引用。';
        error.hidden = false;
        qualificationRef.focus();
        return;
      }
      record.authorId = revision.authorId;
      record.selfReviewed = revision.authorId === state.bootstrap.user.id;
      record.qualificationRef = qualificationRef.value.trim();
    } else if (kind.value === 'family_trial') {
      if (!completedAt.value || completedAt.value > state.today) {
        error.textContent = '请填写今天或过去的家庭试玩完成日期。';
        error.hidden = false;
        completedAt.focus();
        return;
      }
      record.completedAt = new Date(`${completedAt.value}T12:00:00`).toISOString();
    } else {
      if (!authorizationRef.value.trim() || !scope.value.trim()) {
        error.textContent = '内容授权必须填写文件引用和授权范围。';
        error.hidden = false;
        authorizationRef.focus();
        return;
      }
      record.authorizationRef = authorizationRef.value.trim();
      record.scope = scope.value.trim();
    }
    record.allowedEnvironments = allowedEnvironments;
    if (!confirmDiscardOtherDirtyForms(form)) return;
    submit.disabled = true;
    submit.textContent = '正在登记…';
    try {
      await state.api.createReviewEvidence(newUuid(), record);
      markFormDirty(form, false);
      showToast('证据已按正文修订和哈希登记。');
      await loadContent({ force: true });
    } catch (evidenceError) {
      error.textContent = `没有登记证据：${apiErrorMessage(evidenceError)}`;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = '登记绑定此正文的证据';
    }
  });
  details.appendChild(form);
  return details;
}

function buildReviewRevisionForm(revision) {
  const suffix = revisionDomSuffix(revision);
  const details = element('details', 'connection-settings review-form');
  details.appendChild(element('summary', '', '审核这个固定修订'));
  const form = element('form', 'inline-form');
  form.noValidate = true;
  bindDirtyProtection(form);
  form.appendChild(element(
    'p',
    'field-hint',
    '通过必须完成下列四项人工检查。需要专业审阅或家庭试玩证据时，请先在上方登记并引用。',
  ));
  const checks = element('fieldset', 'field');
  checks.appendChild(element('legend', '', '人工检查'));
  const checkRow = element('div', 'choice-row');
  [
    ['sources', '来源与范围'],
    ['age_safety', '适龄与安全'],
    ['language', '中文与英语'],
    ['rights', '版权与授权'],
  ].forEach(([value, label]) => {
    const choice = element('label', 'choice-pill');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.value = value;
    choice.append(checkbox, element('span', '', label));
    checkRow.appendChild(choice);
  });
  checks.appendChild(checkRow);
  form.appendChild(checks);
  const evidenceChoices = matchingEvidence(revision);
  const evidenceCheckboxes = [];
  if (evidenceChoices.length > 0) {
    const evidenceField = element('fieldset', 'field');
    evidenceField.appendChild(element('legend', '', '随审核一并引用'))
    evidenceChoices.forEach((record) => {
      const choice = element('label', 'check-row');
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.value = record.id;
      evidenceCheckboxes.push(checkbox);
      choice.append(
        checkbox,
        element('span', '', `${record.kind} · ${record.evidenceRef}`),
      );
      evidenceField.appendChild(choice);
    });
    form.appendChild(evidenceField);
  }
  const decision = selectInput(`review-decision-${suffix}`, [
    ['approve', '通过'],
    ['reject', '退回修改'],
  ], 'approve');
  appendFormField(form, '审核结论', decision);
  const note = element('textarea');
  note.id = `review-note-${suffix}`;
  note.rows = 3;
  note.maxLength = 2000;
  appendFormField(form, '审核意见', note);
  const error = element('p', 'form-alert');
  error.hidden = true;
  const submit = element('button', 'button button-primary', '提交审核结论');
  submit.type = 'submit';
  form.append(error, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const selectedChecks = [...checkRow.querySelectorAll('input:checked')]
      .map((input) => input.value);
    if (decision.value === 'approve' && selectedChecks.length !== 4) {
      error.textContent = '通过审核前必须完成四项人工检查。';
      error.hidden = false;
      return;
    }
    if (!confirmDiscardOtherDirtyForms(form)) return;
    const selectedEvidence = evidenceCheckboxes.filter((input) => input.checked)
      .map((input) => input.value);
    submit.disabled = true;
    submit.textContent = '正在提交…';
    try {
      await state.api.reviewContentRevision(revision.id, {
        operationId: newUuid(),
        baseRevision: revision.revision,
        decision: decision.value,
        checks: selectedChecks,
        note: note.value.trim(),
        selfReviewed: revision.authorId === state.bootstrap.user.id,
        evidenceRefs: selectedEvidence,
      });
      markFormDirty(form, false);
      showToast(decision.value === 'approve'
        ? '审核已通过，服务端已绑定本次正文证据。'
        : '修订已退回草稿。');
      await loadContent({ force: true });
    } catch (reviewError) {
      error.textContent = `没有提交审核：${apiErrorMessage(reviewError)}`;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = '提交审核结论';
    }
  });
  details.appendChild(form);
  return details;
}

function renderRevision(revision) {
  const card = element('article', 'revision-card');
  const header = element('div', 'revision-header');
  const title = element('div');
  title.appendChild(element('strong', '', revision.activity?.title || '未命名内容'));
  title.appendChild(element('p', 'revision-meta', `修订 ${revision.revision} · ${CONTENT_STATUS_LABELS[revision.status] || revision.status}`));
  header.appendChild(title);
  header.appendChild(element(
    'span',
    `tag ${revision.status === 'approved' ? 'good' : revision.status === 'withdrawn' ? 'danger' : 'warning'}`,
    CONTENT_STATUS_LABELS[revision.status] || revision.status,
  ));
  card.appendChild(header);
  if (revision.changeNote) card.appendChild(element('p', '', revision.changeNote));
  card.appendChild(element(
    'p',
    'revision-meta',
    `正文审核状态：${revision.activity?.reviewState === 'reviewed' ? '已审读' : '草稿'} · 权利状态：${revision.activity?.rights === 'licensed' ? '授权资源' : '原创'} · 哈希 ${String(revision.contentHash).slice(0, 16)}…`,
  ));
  if (revision.activity) {
    card.appendChild(buildRevisionPreview(revision.activity));
  }
  const diff = buildRevisionDiff(revision);
  if (diff) card.appendChild(diff);
  card.appendChild(buildEvidenceSection(revision));
  card.appendChild(buildSourceSection(revision.activity?.sourceIds || []));
  const roles = state.bootstrap.contentRoles || [];
  if (roles.includes('editor') && revision.status === 'draft') {
    card.appendChild(buildSubmitRevisionForm(revision));
  }
  if (roles.includes('reviewer') && revision.status === 'in_review') {
    card.appendChild(buildEvidenceForm(revision));
    card.appendChild(buildReviewRevisionForm(revision));
  }
  return card;
}

function appendFact(parent, label, value) {
  if (value === undefined || value === null || value === '') return;
  const row = element('p', 'revision-fact');
  row.appendChild(element('strong', '', `${label}：`));
  row.appendChild(document.createTextNode(String(value)));
  parent.appendChild(row);
}

function appendPreviewList(parent, title, values, ordered = false) {
  if (!Array.isArray(values) || values.length === 0) return;
  parent.appendChild(element('strong', '', title));
  const list = element(ordered ? 'ol' : 'ul', 'revision-preview-list');
  values.forEach((value) => list.appendChild(element('li', '', String(value))));
  parent.appendChild(list);
}

function buildRevisionPreview(activity) {
  const details = element('details', 'connection-settings revision-preview');
  details.open = activity.reviewState === 'draft';
  details.appendChild(element('summary', '', '查看家长端正文与安全信息'));
  appendFact(details, '支持方向', activity.support);
  appendPreviewList(details, '材料', activity.materials);
  if (!activity.materials?.length) {
    appendFact(details, '材料', '无需额外材料');
  }
  appendPreviewList(details, '步骤', activity.steps, true);
  if (activity.dialogue) {
    const dialogue = element('div', 'revision-dialogue');
    dialogue.appendChild(element('strong', '', '亲子对话'));
    appendFact(dialogue, '开场', activity.dialogue.opening);
    appendFact(dialogue, '投入', activity.dialogue.engaged);
    appendFact(dialogue, '观察', activity.dialogue.observing);
    appendFact(dialogue, '停止', activity.dialogue.stopping);
    details.appendChild(dialogue);
  }
  if (activity.english?.phrase) {
    appendFact(
      details,
      '英语',
      `${activity.english.phrase}（${activity.english.meaning}）· ${activity.english.when}`,
    );
  }
  appendFact(details, '更容易', activity.easier);
  appendFact(details, '下一步', activity.next);
  if (activity.safety) {
    details.appendChild(element('p', 'revision-safety', `安全提醒：${activity.safety}`));
  }
  return details;
}

function buildEvidenceSection(revision) {
  const wrapper = element('section', 'revision-evidence');
  wrapper.appendChild(element('h3', '', '审读证据'));
  const references = Array.isArray(revision.evidenceRefs) ? revision.evidenceRefs : [];
  if (references.length === 0) {
    wrapper.appendChild(element('p', 'inline-alert', '缺少来源或审读证据，不能进入发布。'));
    return wrapper;
  }

  const evidenceById = new Map(
    state.content.evidenceRecords
      .filter((record) => record && typeof record.id === 'string')
      .map((record) => [record.id, record]),
  );
  const list = element('ul', 'evidence-list');
  references.forEach((reference) => {
    const record = evidenceById.get(reference);
    const item = element('li', 'evidence-item');
    item.appendChild(element('strong', '', record?.kind || `证据 ${reference}`));
    if (!record) {
      item.appendChild(element(
        'p',
        'inline-alert',
        `审读证据详情未提供（${reference}）；该缺失不会被解释为审核通过。`,
      ));
    } else {
      appendFact(item, '结论', record.decision === 'approved' ? '人工通过' : '人工拒绝');
      appendFact(item, '审读身份', record.actorKind === 'human' ? '真人审读者' : '未确认');
      appendFact(item, '自审', record.selfReviewed ? '是，仅适用于允许自审的环境' : '否');
      appendFact(item, '检查范围', (record.checks || []).join('、'));
      appendFact(item, '适用环境', (record.allowedEnvironments || []).join('、'));
      appendFact(item, '证据范围', record.scope);
      const bindingOk = record.cardId === revision.activity?.id
        && record.revision === revision.revision
        && record.contentHash === revision.contentHash;
      if (!bindingOk) {
        item.appendChild(element(
          'p',
          'inline-alert',
          '这条证据未绑定当前正文哈希与修订号，不能用于发布门禁。',
        ));
      }
    }
    list.appendChild(item);
  });
  wrapper.appendChild(list);
  return wrapper;
}

function buildSourceSection(sourceIds) {
  const wrapper = element('section', 'revision-sources');
  wrapper.appendChild(element('h3', '', '来源范围'));
  if (state.content.sourcesError) {
    wrapper.appendChild(element(
      'p',
      'inline-alert',
      `来源详情没有读取成功：${state.content.sourcesError}`,
    ));
  }
  const references = resolveEvidenceReferences(sourceIds, state.content.sources);
  if (references.length === 0) {
    wrapper.appendChild(element('p', 'inline-alert', '当前修订没有来源编号。'));
    return wrapper;
  }
  const list = element('ul', 'source-list');
  references.forEach(({ id, source }) => {
    const item = element('li', 'source-item');
    if (!source) {
      item.appendChild(element('strong', '', `来源 ${id}`));
      item.appendChild(element('p', 'inline-alert', '来源详情未提供，不能据此确认适用范围。'));
    } else {
      const heading = element('div', 'source-heading');
      if (isSafeHttpUrl(source.url)) {
        const link = element('a', '', source.title);
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        heading.appendChild(link);
      } else {
        heading.appendChild(element('strong', '', source.title));
        heading.appendChild(element('span', 'inline-alert', '来源链接格式不安全，仅显示文字。'));
      }
      item.appendChild(heading);
      appendFact(item, '核验日期', source.verifiedOn);
      appendFact(item, '支持范围', source.scope);
    }
    list.appendChild(item);
  });
  wrapper.appendChild(list);
  return wrapper;
}

function renderRelease(release) {
  const card = element('article', 'release-card');
  const header = element('div', 'release-header');
  const title = element('div');
  title.appendChild(element('strong', '', `版本 ${release.version}`));
  title.appendChild(element(
    'p',
    'release-meta',
    `${release.environment === 'public' ? '公开内容' : '私人试用'} · ${release.state === 'withdrawn' ? '已撤回' : '发布中'} · ${new Date(release.publishedAt).toLocaleString('zh-CN')}`,
  ));
  header.appendChild(title);
  header.appendChild(element(
    'span',
    `tag ${release.state === 'withdrawn' ? 'danger' : release.active ? 'good' : 'warning'}`,
    release.state === 'withdrawn' ? '已撤回' : release.active ? '有效' : '已停用',
  ));
  card.appendChild(header);
  if (release.selfReviewed) {
    card.appendChild(element('p', 'inline-alert', '此版本带自审标记；公开环境仍需独立审读。'));
  }
  card.appendChild(buildReleaseEvidenceSection(release));
  if (release.state !== 'withdrawn' && state.bootstrap.contentRoles.includes('publisher')) {
    card.appendChild(buildWithdrawForm(release));
  }
  return card;
}

function buildReleaseEvidenceSection(release) {
  const wrapper = element('section', 'revision-evidence');
  wrapper.appendChild(element('h3', '', '发布证据'));
  const references = Array.isArray(release.evidenceRefs) ? release.evidenceRefs : [];
  if (references.length === 0) {
    wrapper.appendChild(element('p', 'inline-alert', '发布记录没有提供可核验的证据引用。'));
    return wrapper;
  }
  const evidenceById = new Map(
    state.content.evidenceRecords
      .filter((record) => record && typeof record.id === 'string')
      .map((record) => [record.id, record]),
  );
  const list = element('ul', 'evidence-list');
  references.forEach((reference) => {
    const record = evidenceById.get(reference);
    const item = element('li', 'evidence-item');
    item.appendChild(element('strong', '', record?.kind || `证据 ${reference}`));
    if (record) {
      appendFact(item, '结论', record.decision === 'approved' ? '人工通过' : '人工拒绝');
      appendFact(item, '审读时间', record.completedAt || record.createdAt);
      appendFact(item, '适用环境', (record.allowedEnvironments || []).join('、'));
    } else {
      item.appendChild(element(
        'p',
        'inline-alert',
        '发布记录引用的证据详情未提供，不能据此证明该版本审核通过。',
      ));
    }
    list.appendChild(item);
  });
  wrapper.appendChild(list);
  return wrapper;
}

function buildWithdrawForm(release) {
  const form = element('form', 'inline-form');
  form.noValidate = true;
  bindDirtyProtection(form);
  const kind = selectInput(`withdraw-kind-${release.id}`, [
    ['safety', '安全问题（优先停止推荐）'],
    ['editorial', '文字或编辑问题'],
  ], 'safety');
  appendFormField(form, '撤回类型', kind);
  const reason = element('textarea');
  reason.id = `withdraw-reason-${release.id}`;
  reason.maxLength = 1000;
  reason.rows = 3;
  appendFormField(form, '撤回原因', reason, '原因会进入审计记录，应写清家长需要立即知道的影响。');
  const error = element('p', 'form-alert');
  error.hidden = true;
  form.appendChild(error);
  const submit = element('button', 'button button-danger', '安全撤回这个版本');
  submit.type = 'submit';
  form.appendChild(submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!reason.value.trim()) {
      error.textContent = '请填写撤回原因。';
      error.hidden = false;
      reason.focus();
      return;
    }
    if (!confirmDiscardOtherDirtyForms(form)) return;
    if (!window.confirm('撤回会影响所有仍在线设备，并保留完整审计记录。确定继续吗？')) return;
    submit.disabled = true;
    submit.textContent = '正在撤回…';
    try {
      await state.api.withdrawRelease(release.id, {
        operationId: newUuid(),
        kind: kind.value,
        reason: reason.value.trim(),
      });
      markFormDirty(form, false);
      showToast('版本撤回已由服务端确认。');
      await loadContent({ force: true });
    } catch (withdrawError) {
      error.textContent = `没有撤回成功：${apiErrorMessage(withdrawError)}`;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = '安全撤回这个版本';
    }
  });
  return form;
}

function renderPublishGate() {
  const approved = state.content.revisions.filter((revision) => revision.status === 'approved');
  const evaluateGate = (releaseEnvironment) => state.content.revisionsError
    ? { allowed: false, reason: '内容修订队列没有读取成功，不能发布' }
    : canPublishRevisions(approved, {
      evidenceRecords: state.content.evidenceRecords,
      sources: state.content.sources,
      sourceDetailsAvailable: !state.content.sourcesError && !state.content.evidenceError,
      environment: releaseEnvironment,
    });
  let gate = evaluateGate('private_trial');
  const roles = state.bootstrap.contentRoles || [];
  const form = element('form', 'inline-form publish-form');
  form.noValidate = true;
  bindDirtyProtection(form);
  const environment = selectInput('publish-environment', [
    ['private_trial', '私人试用'],
    ['public', '公开发布'],
  ], 'private_trial');
  appendFormField(
    form,
    '发布目标',
    environment,
    '公开发布还需服务端核对独立审读与完成的家庭试玩证据。',
  );
  const publish = element('button', 'button button-primary', '发布已审核修订');
  publish.type = 'submit';
  const refreshGate = () => {
    gate = evaluateGate(environment.value);
    dom['publish-gate-title'].textContent = gate.allowed ? '审核与证据已满足' : '当前不能发布';
    dom['publish-gate-note'].textContent = gate.reason;
    publish.disabled = !gate.allowed || !roles.includes('publisher');
  };
  refreshGate();
  environment.addEventListener('change', refreshGate);
  if (!roles.includes('publisher')) {
    publish.title = '当前账号没有发布角色';
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    gate = evaluateGate(environment.value);
    if (!gate.allowed || !roles.includes('publisher')) return;
    if (!confirmDiscardOtherDirtyForms(form)) return;
    if (!window.confirm(
      `将发布 ${approved.length} 项已审核修订到${environment.value === 'public' ? '公开内容' : '私人试用'}。服务端会再次核对证据；失败时不会切换现有版本。确定继续吗？`,
    )) return;
    publish.disabled = true;
    publish.textContent = '正在发布…';
    try {
      await state.api.publishRelease({
        operationId: newUuid(),
        revisionIds: approved.map((revision) => revision.id),
        environment: environment.value,
        evidenceRefs: [...new Set(
          approved.flatMap((revision) => revision.evidenceRefs || []),
        )],
      });
      markFormDirty(form, false);
      showToast('发布已由服务端事务确认。');
      await loadContent({ force: true });
    } catch (error) {
      const message = error instanceof ApiError && error.status === 404
        ? '发布接口尚未在当前服务中提供；本次没有切换任何内容版本。'
        : `没有发布成功，现有版本保持不变：${apiErrorMessage(error)}`;
      showGlobalStatus(message, 'error');
    } finally {
      publish.disabled = false;
      publish.textContent = '发布已审核修订';
    }
  });
  form.appendChild(publish);
  dom['publish-gate-actions'].appendChild(form);
}

function setMode(mode) {
  state.mode = mode;
  const isDay = mode === 'day';
  setHidden(dom['day-view'], !isDay);
  setHidden(dom['week-view'], isDay);
  setHidden(dom['print-button'], isDay);
  dom['day-mode-button'].classList.toggle('is-active', isDay);
  dom['week-mode-button'].classList.toggle('is-active', !isDay);
  dom['day-mode-button'].setAttribute('aria-pressed', String(isDay));
  dom['week-mode-button'].setAttribute('aria-pressed', String(!isDay));
  if (!isDay) {
    loadWeek();
  }
}

function renderWeekLoading() {
  clear(dom['week-view']);
  state.dates.forEach((date) => {
    const card = element('article', 'day-card');
    card.appendChild(element('h2', '', formatChineseDate(date, { weekday: true })));
    card.appendChild(element('p', 'muted', '正在读取真实安排…'));
    dom['week-view'].appendChild(card);
  });
}

async function loadWeek({ force = false } = {}) {
  if (!state.child) {
    renderNoChild();
    return;
  }
  const generation = state.requestGeneration;
  const childId = state.child.id;
  const cachedAll = state.dates.every((date) => state.plans.get(date)?.loaded || state.plans.get(date)?.error);
  if (!force && cachedAll) {
    renderWeek();
    return;
  }

  renderWeekLoading();
  await Promise.all(state.dates.map(async (date) => {
    if (!force && state.plans.get(date)?.loaded) {
      return;
    }
    try {
      const plan = await state.api.getDayPlan(childId, date);
      if (generation !== state.requestGeneration || childId !== state.child?.id) return;
      state.plans.set(date, { loaded: true, plan, error: '' });
    } catch (error) {
      if (generation !== state.requestGeneration || childId !== state.child?.id) return;
      state.plans.set(date, { loaded: false, plan: null, error: apiErrorMessage(error) });
    }
  }));
  if (generation === state.requestGeneration && state.child?.id === childId && state.mode === 'week') {
    renderWeek();
  }
}

function renderWeek() {
  clear(dom['week-view']);
  state.dates.forEach((date) => {
    const entry = state.plans.get(date);
    const card = element('article', 'day-card');
    if (date === state.today) {
      card.classList.add('is-today');
    }
    card.appendChild(element('h2', '', formatChineseDate(date, { weekday: true })));

    if (!entry) {
      card.appendChild(element('p', 'muted', '正在读取真实安排…'));
    } else if (entry.error) {
      card.appendChild(element('p', 'inline-alert', `没有读取成功：${entry.error}`));
    } else if (!entry.plan) {
      card.appendChild(element('p', 'muted', '这一天还没有安排。'));
    } else {
      const visibleItems = entry.plan.items.filter((item) => item.visibility === 'active');
      card.appendChild(element(
        'p',
        'day-card-meta',
        `${planModeLabel(entry.plan)} · ${visibleItems.length} 项 · ${entry.plan.effectiveBudgetMinutes} 分钟`,
      ));
      if (visibleItems.length === 0) {
        card.appendChild(element('p', 'muted', '没有已发布活动。'));
      } else {
        const list = element('ul', 'compact-activity-list');
        visibleItems.forEach((item) => {
          const row = element('li', 'compact-activity');
          const button = element('button');
          button.type = 'button';
          button.appendChild(element('span', '', item.snapshot.title));
          button.appendChild(element(
            'small',
            '',
            `${KIND_LABELS[item.snapshot.kind] || item.snapshot.kind} · ${item.budgetMinutes} 分钟${item.participation ? ' · 已记录' : ''}`,
          ));
          button.addEventListener('click', () => {
            state.selectedDate = date;
            state.selectedItemId = item.id;
            renderDateStrip();
            setMode('day');
            renderDayPlan();
          });
          row.appendChild(button);
          if (item.blockedByWithdrawal) {
            row.appendChild(element('span', 'status-badge blocked', '停止推荐'));
          }
          list.appendChild(row);
        });
        card.appendChild(list);
      }
    }
    dom['week-view'].appendChild(card);
  });
}

function switchView(view) {
  if (!['schedule', 'settings', 'growth', 'content'].includes(view)) {
    view = 'schedule';
  }
  if (view === 'content' && !state.content.enabled) {
    view = 'schedule';
  }
  const changingView = view !== state.view;
  if (changingView && !confirmDiscardDirtyForm()) {
    return;
  }
  state.view = view;
  setHidden(dom['view-schedule'], view !== 'schedule');
  setHidden(dom['view-settings'], view !== 'settings');
  setHidden(dom['view-growth'], view !== 'growth');
  setHidden(dom['view-content'], view !== 'content');
  document.querySelectorAll('.nav-button').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('is-active', active);
    if (active) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  });
  if (changingView && view === 'settings' && state.family && !state.preferences && !state.preferencesError) {
    loadPreferences();
  }
  if (changingView && view === 'growth') {
    loadGrowth();
  }
  if (view === 'content') {
    if (changingView) loadContent();
  }
  dom['main-content'].focus();
}

function appendPrintText(parent, tagName, text) {
  if (text) {
    parent.appendChild(element(tagName, '', text));
  }
}

function buildPrintDay(date) {
  const entry = state.plans.get(date);
  const daySection = element('section', 'print-day');
  const heading = element('div', 'print-day-heading');
  heading.appendChild(element('h2', '', formatChineseDate(date, { weekday: true })));
  heading.appendChild(element('span', '', entry?.plan
    ? `${planModeLabel(entry.plan)} · ${entry.plan.effectiveBudgetMinutes} 分钟`
    : ''));
  daySection.appendChild(heading);

  if (!entry) {
    appendPrintText(daySection, 'p', '这一天的安排还没有读取。');
    return daySection;
  }
  if (entry.error) {
    appendPrintText(daySection, 'p', `这一天的安排未读取成功：${entry.error}`);
    return daySection;
  }
  if (!entry.plan) {
    appendPrintText(daySection, 'p', '这一天没有安排。');
    return daySection;
  }

  const visibleItems = entry.plan.items.filter((item) => item.visibility === 'active');
  if (visibleItems.length === 0) {
    appendPrintText(daySection, 'p', '没有已发布活动。');
    return daySection;
  }

  visibleItems.forEach((item) => {
    const activity = item.snapshot;
    const block = element('article', 'print-activity');
    block.appendChild(element('h3', '', activity.title));
    if (item.blockedByWithdrawal) {
      appendPrintText(block, 'p', item.withdrawalReason || '已停止推荐，玩法不再提供。');
      daySection.appendChild(block);
      return;
    }
    block.appendChild(element(
      'p',
      'print-meta',
      `${KIND_LABELS[activity.kind] || activity.kind} · ${BLOCK_LABELS[item.block] || item.block} · 预算 ${item.budgetMinutes} 分钟`,
    ));
    appendPrintText(block, 'p', activity.support);
    appendPrintText(block, 'strong', '材料');
    if (activity.materials.length === 0) {
      appendPrintText(block, 'p', '无需额外材料');
    } else {
      block.appendChild(textList(activity.materials));
    }
    appendPrintText(block, 'strong', '步骤');
    block.appendChild(textList(activity.steps, true));
    appendPrintText(block, 'strong', '亲子对话');
    block.appendChild(textList([
      `开场：${activity.dialogue.opening}`,
      `投入：${activity.dialogue.engaged}`,
      `观察：${activity.dialogue.observing}`,
      `停止：${activity.dialogue.stopping}`,
    ]));
    if (activity.english?.phrase) {
      appendPrintText(block, 'p', `英语：${activity.english.phrase}（${activity.english.meaning}）`);
    }
    const safety = element('p', 'print-safety');
    safety.textContent = `安全提醒：${activity.safety}`;
    block.appendChild(safety);
    daySection.appendChild(block);
  });
  return daySection;
}

function renderPrintSheet() {
  clear(dom['print-root']);
  const header = element('header', 'print-header');
  header.appendChild(element('h1', '', `${state.family?.name || '家庭'} · 未来七天陪伴安排`));
  const child = state.child;
  header.appendChild(element(
    'p',
    '',
    `${child?.displayName || '孩子'} · ${describeChildAge(child || {})} · ${formatChineseDate(state.dates[0])}—${formatChineseDate(state.dates[6])}`,
  ));
  header.appendChild(element('p', '', `打印自小芽 · BabyPlan；${new Date().toLocaleString('zh-CN')}`));
  dom['print-root'].appendChild(header);
  state.dates.forEach((date) => dom['print-root'].appendChild(buildPrintDay(date)));
  const footer = element('footer', 'print-footer');
  footer.textContent = '参与记录不会自动等于发育成就。页面未读取成功的日期会如实列出，不会在打印件中补造内容。';
  dom['print-root'].appendChild(footer);
}

async function handlePrint() {
  if (!state.child) {
    showGlobalStatus('当前家庭没有可打印的孩子安排。');
    return;
  }
  dom['print-button'].disabled = true;
  const generation = state.requestGeneration;
  try {
    await loadWeek({ force: true });
    if (generation !== state.requestGeneration) return;
    renderPrintSheet();
    window.print();
  } finally {
    dom['print-button'].disabled = false;
  }
}

function stageFocusLabel(guideId) {
  return stageFocuses().find((focus) => focus.id === guideId)?.title || '阶段线索详情未提供';
}

function buildGrowthPrintItem(item) {
  const card = element('article', 'print-growth-item');
  const title = {
    memory: MEMORY_TYPE_LABELS[item.type] || '成长小记',
    measurement: MEASUREMENT_KIND_LABELS[item.kind] || '测量',
    observation: '阶段观察',
  }[item.eventKind];
  card.appendChild(element('h3', '', `${title} · ${item.localDate}`));
  if (item.eventKind === 'memory') {
    card.appendChild(element('p', '', item.text));
    if (item.firstConfirmed) {
      card.appendChild(element('p', 'print-meta', '家长已明确确认这是第一次。'));
    }
  } else if (item.eventKind === 'measurement') {
    const method = {
      recumbent: '卧位身长',
      standing: '站立身高',
      scale: '体重秤',
    }[item.method] || '测量方式未注明';
    card.appendChild(element(
      'p',
      '',
      `${item.value} ${item.unit}，${method}，${item.source === 'clinic' ? '儿保或医院' : '家中记录'}`,
    ));
  } else {
    card.appendChild(element('p', '', OBSERVATION_VALUE_LABELS[item.value] || item.value));
    if (item.note) card.appendChild(element('p', '', item.note));
    card.appendChild(element('p', 'print-meta', `阶段线索：${stageFocusLabel(item.guideId)}`));
  }
  return card;
}

function buildGrowthPrintSection(title, items) {
  const section = element('section', 'print-growth-section');
  section.appendChild(element('h2', '', `${title}（${items.length}）`));
  if (items.length === 0) {
    section.appendChild(element('p', 'print-growth-empty', '这一部分暂无记录。'));
  } else {
    items.forEach((item) => section.appendChild(buildGrowthPrintItem(item)));
  }
  return section;
}

function renderGrowthPrintSheet() {
  clear(dom['print-root']);
  const snapshot = growthSnapshotForChild();
  const events = sortedGrowthEvents(snapshot);
  const memories = events.filter((item) => item.eventKind === 'memory');
  const measurements = events.filter((item) => item.eventKind === 'measurement');
  const observations = events.filter((item) => item.eventKind === 'observation');
  const books = state.growth.snapshot?.books || [];
  const dates = events.map((item) => item.localDate).sort();

  const header = element('header', 'print-header');
  header.appendChild(element('h1', '', `${state.family?.name || '家庭'} · 成长记录`));
  header.appendChild(element(
    'p',
    '',
    `${state.child?.displayName || '孩子'} · ${describeChildAge(state.child || {})}`,
  ));
  header.appendChild(element(
    'p',
    '',
    dates.length > 0
      ? `${formatChineseDate(dates[0])}—${formatChineseDate(dates.at(-1))}`
      : `整理日期 ${formatChineseDate(state.today)}`,
  ));
  header.appendChild(element('p', '', `打印自小芽 · BabyPlan；${new Date().toLocaleString('zh-CN')}`));
  dom['print-root'].appendChild(header);

  dom['print-root'].appendChild(buildGrowthPrintSection('原话、故事与第一次', memories));
  dom['print-root'].appendChild(buildGrowthPrintSection('身高与体重测量', measurements));
  dom['print-root'].appendChild(buildGrowthPrintSection('阶段观察', observations));

  const booksSection = element('section', 'print-growth-section');
  booksSection.appendChild(element('h2', '', `家庭书架（${books.length}）`));
  if (books.length === 0) {
    booksSection.appendChild(element('p', 'print-growth-empty', '书架暂无登记项。'));
  } else {
    const list = element('ul', 'print-book-list');
    books.forEach((book) => {
      const item = element('li');
      item.appendChild(element('strong', '', book.title));
      item.appendChild(document.createTextNode(
        `，${book.language}，${book.editionStatus === 'verified' ? '版本已确认' : '版本次要信息待核对'}${book.note ? `。${book.note}` : ''}`,
      ));
      list.appendChild(item);
    });
    booksSection.appendChild(list);
  }
  dom['print-root'].appendChild(booksSection);

  const footer = element('footer', 'print-footer');
  footer.textContent = '本页只整理家庭记录与原始测量事实，不计算医学百分位、不判断发育达标，也不以活动参与次数自动生成“第一次”。';
  dom['print-root'].appendChild(footer);
}

async function handleGrowthPrint() {
  if (!state.family) {
    showGlobalStatus('当前账号没有可打印的家庭记录。');
    return;
  }
  if (state.growth.loading) {
    showGlobalStatus('成长记录正在读取，请稍后再打印。');
    return;
  }
  if (!state.growth.loaded) {
    await loadGrowth({ force: true });
  }
  if (state.growth.error || !state.growth.loaded) {
    showGlobalStatus(`成长记录没有读取成功，不能打印不完整的纸张：${state.growth.error || '未知错误'}`);
    return;
  }
  dom['growth-print-button'].disabled = true;
  try {
    renderGrowthPrintSheet();
    window.print();
  } finally {
    dom['growth-print-button'].disabled = false;
  }
}

async function handleFamilyChange() {
  const previousFamilyId = state.family?.id || '';
  if (!confirmDiscardDirtyForm()) {
    dom['family-select'].value = previousFamilyId;
    return;
  }
  state.family = state.bootstrap.families.find((family) => family.id === dom['family-select'].value) || null;
  state.child = state.family
    ? state.bootstrap.children.find((child) => child.familyId === state.family.id) || null
    : null;
  state.today = businessDate(new Date(), state.family?.timezone || 'Asia/Shanghai');
  state.dates = weekDates(state.today);
  state.selectedDate = state.today;
  state.selectedItemId = null;
  state.plans.clear();
  state.preferences = null;
  state.preferencesError = '';
  state.growth = {
    loaded: false,
    loading: state.growth.loading,
    error: '',
    snapshot: null,
    options: null,
    trash: emptyGrowthTrashState(),
  };
  state.requestGeneration += 1;
  populateFamilyControls();
  renderOverview();
  renderMembers();
  renderFamilyManagement();
  renderDateStrip();
  dom['boundary-api'].textContent = `API：${state.api.baseUrl}`;
  setMode('day');
  if (state.view === 'growth') {
    loadGrowth({ force: true });
  } else if (state.view === 'content') {
    loadContent({ force: true });
  } else if (state.view === 'settings') {
    loadPreferences();
  } else {
    loadPreferences();
    if (state.child) {
      await ensureCurrentChildPlans();
      loadSelectedDay({ force: true });
    } else {
      renderNoChild();
    }
  }
}

async function handleChildChange() {
  const previousChildId = state.child?.id || '';
  if (!confirmDiscardDirtyForm()) {
    dom['child-select'].value = previousChildId;
    return;
  }
  state.child = currentFamilyChildren().find((child) => child.id === dom['child-select'].value) || null;
  state.plans.clear();
  state.selectedItemId = null;
  state.requestGeneration += 1;
  renderOverview();
  setMode('day');
  if (state.view === 'growth') {
    if (state.growth.loaded) {
      renderGrowth();
    } else {
      loadGrowth({ force: true });
    }
  } else if (state.view === 'schedule' && state.child) {
    await ensureCurrentChildPlans();
    loadSelectedDay({ force: true });
  } else if (state.view === 'schedule') {
    renderNoChild();
  }
}

async function handleLogout() {
  if (!confirmDiscardDirtyForm()) return;
  dom['logout-button'].disabled = true;
  try {
    await state.api.logout();
    resetSignedInState();
    showLogin();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      resetSignedInState();
      showLogin('当前会话已经结束，请重新登录。');
    } else {
      showGlobalStatus(`没有退出成功：${apiErrorMessage(error)}`);
    }
  } finally {
    dom['logout-button'].disabled = false;
  }
}

function wireEvents() {
  dom['login-form'].addEventListener('submit', handleLogin);
  dom['signup-form'].addEventListener('submit', handleSignup);
  dom['family-select'].addEventListener('change', handleFamilyChange);
  dom['child-select'].addEventListener('change', handleChildChange);
  dom['logout-button'].addEventListener('click', handleLogout);
  bindDirtyProtection(dom['book-form']);
  bindDirtyProtection(dom['export-form']);
  dom['refresh-button'].addEventListener('click', () => {
    if (!confirmDiscardDirtyForm()) return;
    state.plans.clear();
    loadPreferences();
    if (state.mode === 'week') {
      loadWeek({ force: true });
    } else {
      loadSelectedDay({ force: true });
    }
  });
  dom['refresh-preferences-button'].addEventListener('click', () => {
    if (confirmDiscardDirtyForm()) loadPreferences();
  });
  dom['day-mode-button'].addEventListener('click', () => setMode('day'));
  dom['week-mode-button'].addEventListener('click', () => setMode('week'));
  dom['print-button'].addEventListener('click', handlePrint);
  dom['growth-print-button'].addEventListener('click', handleGrowthPrint);
  dom['growth-trash'].addEventListener('toggle', () => {
    if (dom['growth-trash'].open && state.growth.loaded) {
      void loadGrowthTrash({ force: true });
    }
  });
  dom['refresh-growth-button'].addEventListener('click', () => {
    if (confirmDiscardDirtyForm()) loadGrowth({ force: true });
  });
  dom['refresh-content-button'].addEventListener('click', () => {
    if (confirmDiscardDirtyForm()) loadContent({ force: true });
  });
  dom['book-form'].addEventListener('submit', handleBookSubmit);
  dom['export-form'].addEventListener('submit', handleExportSubmit);
  document.querySelectorAll('.nav-button').forEach((button) => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });
}

async function initialize() {
  cacheDom();
  const initialApiBase = readStoredApiBase();
  dom['api-base'].value = initialApiBase;
  state.api = new BabyPlanApi({ baseUrl: initialApiBase });
  dom['boundary-api'].textContent = `API：${initialApiBase}`;
  wireEvents();
  await restoreSession();
}

initialize();
