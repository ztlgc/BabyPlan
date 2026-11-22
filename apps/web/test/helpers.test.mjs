import assert from 'node:assert/strict';
import test from 'node:test';
import { BabyPlanApi, ApiError, apiErrorMessage } from '../public/lib/api.js';
import {
  addDays,
  businessDate,
  describeChildAge,
  formatChineseDate,
  isValidIsoDate,
  weekDates,
} from '../public/lib/dates.js';
import {
  DEFAULT_API_BASE,
  normalizeApiBase,
  normalizeInvitationCode,
  validateChildProfileInput,
  validateInvitationCode,
  validateInvitationSignupInput,
  validateLoginInput,
  validateParticipationInput,
  validatePreferenceInput,
} from '../public/lib/validation.js';
import {
  activityDiff,
  canPublishRevisions,
  isSafeHttpUrl,
  mergeSnapshotPages,
  resolveEvidenceReferences,
  sortedGrowthEvents,
  validateExportRequest,
} from '../public/lib/growth.js';

test('日期计算不依赖浏览器本地时区', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(weekDates('2026-11-13'), [
    '2026-11-13',
    '2026-11-14',
    '2026-11-15',
    '2026-11-16',
    '2026-11-17',
    '2026-11-18',
    '2026-11-19',
  ]);
  assert.equal(isValidIsoDate('2026-02-29'), false);
});

test('家庭时区业务日期和月龄说明可生成', () => {
  const instant = new Date('2026-11-12T16:30:00.000Z');
  assert.equal(businessDate(instant, 'Asia/Shanghai'), '2026-11-13');
  assert.equal(describeChildAge({ ageMonths: 20 }), '20 月龄');
  assert.equal(describeChildAge({ ageMonths: null }), '月龄未记录');
});

test('中文日期支持在计划标题中显示星期', () => {
  assert.match(
    formatChineseDate('2026-11-13', { weekday: true }),
    /11月13日.*星期五/,
  );
});

test('API 地址只接受 HTTP、HTTPS 或安全相对路径', () => {
  assert.equal(normalizeApiBase(DEFAULT_API_BASE), DEFAULT_API_BASE);
  assert.equal(normalizeApiBase('https://example.test/v2///'), 'https://example.test/v2');
  assert.equal(normalizeApiBase('/v2'), '/v2');
  assert.throws(() => normalizeApiBase('javascript:alert(1)'));
  const credentialUrl = ['https://user:', 'not-a-real-', 'credential', '@example.test/v2'].join('');
  assert.throws(() => normalizeApiBase(credentialUrl));
  assert.throws(() => normalizeApiBase('/v2/../private'));
});

test('登录和参与记录输入在提交前校验', () => {
  assert.deepEqual(validateLoginInput('', ''), {
    email: '请输入有效的邮箱地址',
    password: '请输入密码',
  });

  const missingCompanion = validateParticipationInput({
    status: 'played',
    participantIds: [],
    note: '',
    actualMinutes: '',
  });
  assert.equal(missingCompanion.errors.participantIds, '一起玩了时，请至少选择一位陪伴者');
  assert.equal(missingCompanion.value.actualMinutes, null);

  const duplicateParticipants = validateParticipationInput({
    status: 'played',
    participantIds: ['p1', 'p1'],
    note: '一起玩了',
    actualMinutes: '12',
  });
  assert.deepEqual(duplicateParticipants.errors, {});
  assert.deepEqual(duplicateParticipants.value.participantIds, ['p1']);
  assert.equal(duplicateParticipants.value.actualMinutes, 12);
});

test('邀请码和网页注册输入在提交前校验', () => {
  assert.equal(normalizeInvitationCode('　MAMA２０２６　'), 'MAMA2026');
  assert.equal(validateInvitationCode('abc'), '邀请码需为 4～32 个字符');
  assert.equal(
    validateInvitationCode('mama 2026'),
    '邀请码只能使用中文、字母、数字、下划线或短横线',
  );
  assert.deepEqual(
    validateInvitationSignupInput({
      code: '小满一家',
      email: ' Parent@Example.Test ',
      displayName: '小满妈妈',
      password: 'not-a-real-password',
    }).errors,
    {},
  );
  const invalid = validateInvitationSignupInput({
    code: 'abc',
    email: 'not-an-email',
    displayName: '',
    password: 'short',
  });
  assert.equal(invalid.errors.code, '邀请码需为 4～32 个字符');
  assert.equal(invalid.errors.email, '请输入有效的邮箱地址');
  assert.equal(invalid.errors.displayName, '请填写家里怎么称呼你');
  assert.equal(invalid.errors.password, '密码至少需要 12 位');
});

test('API 客户端使用 Web 会话、credentials include 和 CSRF 头', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/sessions')) {
      return new Response(JSON.stringify({
        user: { id: 'u1', displayName: '小禾' },
        sessionId: 's1',
        accessToken: null,
        refreshToken: null,
        expiresAt: '2026-11-13T01:15:00.000Z',
        refreshExpiresAt: '2026-12-13T01:00:00.000Z',
        csrfToken: null,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/sessions/csrf')) {
      return new Response(JSON.stringify({ csrfToken: 'csrf-in-memory' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ id: 'part1', revision: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const api = new BabyPlanApi({ baseUrl: DEFAULT_API_BASE, fetchImpl });
  await api.login({ email: 'parent@example.test', password: 'not-a-real-password', deviceId: 'de305d54-75b4-431b-adb2-eb6b9e546014' });
  await api.saveParticipation('item-1', { status: 'played' });

  assert.equal(requests[0].options.credentials, 'include');
  assert.equal(JSON.parse(requests[0].options.body).clientType, 'web');
  assert.equal(requests[1].url, `${DEFAULT_API_BASE}/sessions/csrf`);
  assert.equal(requests[2].options.headers['X-CSRF-Token'], 'csrf-in-memory');
  assert.equal(requests[2].options.credentials, 'include');
});

test('网页凭邀请码创建账号使用真实合同路径', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({
      user: { id: 'u2', displayName: '小满妈妈' },
      sessionId: 's2',
      accessToken: null,
      refreshToken: null,
      csrfToken: null,
      expiresAt: '2026-11-13T01:15:00.000Z',
      refreshExpiresAt: '2026-12-13T01:00:00.000Z',
      family: { id: 'family-1', name: '小满一家', members: [] },
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  const api = new BabyPlanApi({ baseUrl: DEFAULT_API_BASE, fetchImpl });
  await api.redeemInvitation({
    operationId: 'de305d54-75b4-431b-adb2-eb6b9e546014',
    token: '小满一家',
    email: 'parent@example.test',
    displayName: '小满妈妈',
    password: 'not-a-real-password',
    deviceId: 'de305d54-75b4-431b-adb2-eb6b9e546015',
  });
  assert.equal(requests[0].url, `${DEFAULT_API_BASE}/invitations/redeem`);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.credentials, 'include');
  assert.equal(requests[0].options.headers['X-CSRF-Token'], undefined);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    operationId: 'de305d54-75b4-431b-adb2-eb6b9e546014',
    token: '小满一家',
    email: 'parent@example.test',
    password: 'not-a-real-password',
    displayName: '小满妈妈',
    deviceId: 'de305d54-75b4-431b-adb2-eb6b9e546015',
    clientType: 'web',
  });
});

test('网络错误不会伪装成登录成功', async () => {
  const api = new BabyPlanApi({
    baseUrl: DEFAULT_API_BASE,
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(
    () => api.login({ email: 'a@example.test', password: 'x', deviceId: 'id' }),
    (error) => error instanceof ApiError && error.code === 'NETWORK_ERROR',
  );
});

test('浏览器默认 fetch 以 Window 为接收者，避免 Illegal invocation', async () => {
  const originalFetch = globalThis.fetch;
  let receiver = null;
  globalThis.fetch = function strictBrowserFetch() {
    'use strict';
    receiver = this;
    return Promise.resolve(new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
  };
  try {
    const api = new BabyPlanApi({ baseUrl: DEFAULT_API_BASE });
    await api.rawRequest('/families/family-1/books');
    assert.equal(receiver, globalThis);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('导出日期与内容类型在提交前校验', () => {
  assert.deepEqual(validateExportRequest({
    from: '2026-11-13',
    to: '2026-11-01',
    types: [],
  }), {
    errors: {
      to: '结束日期不能早于开始日期',
      types: '请至少选择一种导出内容',
    },
    valid: false,
  });
  assert.deepEqual(validateExportRequest({
    from: '2026-11-01',
    to: '2026-11-13',
    types: ['memories'],
  }), { errors: {}, valid: true });
});

test('成长事件按日期倒序排列', () => {
  const events = sortedGrowthEvents({
    memories: [{ id: 'm2', localDate: '2026-11-01' }],
    measurements: [{ id: 's1', localDate: '2026-11-13' }],
    observations: [{ id: 'o1', localDate: '2026-11-13' }],
  });
  assert.deepEqual(events.map((item) => item.id), ['o1', 's1', 'm2']);
  assert.deepEqual(events.map((item) => item.eventKind), [
    'observation',
    'measurement',
    'memory',
  ]);
});

test('家庭快照只合并同一快照和游标的分页', () => {
  const base = {
    cursor: 'change-cursor',
    snapshotId: 'snapshot-1',
    children: [],
    days: [],
    memories: [],
    measurements: [],
    observations: [],
    sessions: [],
    books: [],
    media: [],
    withdrawals: [],
    expiresAt: '2026-11-13T02:00:00.000Z',
  };
  const merged = mergeSnapshotPages([
    {
      ...base,
      memories: [{ id: 'm1' }],
      nextPageToken: 'page-2',
      hasMore: true,
    },
    {
      ...base,
      measurements: [{ id: 's1' }],
      nextPageToken: null,
      hasMore: false,
    },
  ]);
  assert.deepEqual(merged.memories, [{ id: 'm1' }]);
  assert.deepEqual(merged.measurements, [{ id: 's1' }]);
  assert.equal(merged.hasMore, false);
  assert.equal(merged.nextPageToken, null);

  assert.throws(
    () => mergeSnapshotPages([
      { ...base, nextPageToken: 'page-2', hasMore: true },
      { ...base, snapshotId: 'snapshot-2', nextPageToken: null, hasMore: false },
    ]),
    /不同快照/,
  );
  assert.throws(
    () => mergeSnapshotPages([
      { ...base, nextPageToken: 'page-2', hasMore: true },
      { ...base, cursor: 'another-cursor', nextPageToken: null, hasMore: false },
    ]),
    /同步游标不一致/,
  );
});

test('来源映射和链接只接受可核验的安全地址', () => {
  const resolved = resolveEvidenceReferences(['src-1', 'src-missing'], [{
    id: 'src-1',
    title: '来源一',
    url: 'https://example.test/source',
    verifiedOn: '2026-11-13',
    scope: '只支持游戏方向',
  }]);
  assert.equal(resolved[0].source.title, '来源一');
  assert.equal(resolved[1].source, null);
  assert.equal(isSafeHttpUrl('https://example.test/source'), true);
  assert.equal(isSafeHttpUrl('http://example.test/source'), true);
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
  assert.equal(isSafeHttpUrl('/relative-source'), false);
});

test('发布门禁要求审核、来源详情和绑定正文哈希的人工证据', () => {
  const revision = {
    id: 'revision-id',
    status: 'approved',
    revision: 3,
    contentHash: 'a'.repeat(64),
    evidenceRefs: ['evidence-1'],
    activity: {
      id: 'activity-1',
      reviewState: 'reviewed',
      withdrawn: false,
      sourceIds: ['source-1'],
    },
  };
  const evidence = {
    id: 'evidence-1',
    decision: 'approved',
    actorKind: 'human',
    cardId: 'activity-1',
    revision: 3,
    contentHash: 'a'.repeat(64),
  };
  const sources = [{
    id: 'source-1',
    title: '来源一',
    url: 'https://example.test/source',
    verifiedOn: '2026-11-13',
    scope: '适用范围',
  }];

  assert.equal(canPublishRevisions([revision], {
    evidenceRecords: [evidence],
    sources,
    sourceDetailsAvailable: true,
  }).allowed, true);
  assert.equal(canPublishRevisions([revision], {
    evidenceRecords: [evidence],
    sources,
    sourceDetailsAvailable: false,
  }).allowed, false);
  assert.equal(canPublishRevisions([revision], {
    evidenceRecords: [{ ...evidence, contentHash: 'b'.repeat(64) }],
    sources,
    sourceDetailsAvailable: true,
  }).allowed, false);
  assert.equal(canPublishRevisions([{ ...revision, status: 'draft' }], {
    evidenceRecords: [evidence],
    sources,
    sourceDetailsAvailable: true,
  }).allowed, false);

  const publicRevision = { ...revision, evidenceRefs: ['review-1', 'trial-1'] };
  const publicEvidence = [
    {
      ...evidence,
      id: 'review-1',
      kind: 'editorial_review',
      selfReviewed: false,
      allowedEnvironments: ['public'],
    },
    {
      ...evidence,
      id: 'trial-1',
      kind: 'family_trial',
      completedAt: '2026-11-12T10:00:00.000Z',
      allowedEnvironments: ['public'],
    },
  ];
  assert.equal(canPublishRevisions([publicRevision], {
    evidenceRecords: publicEvidence,
    sources,
    environment: 'public',
  }).allowed, true);
  assert.equal(canPublishRevisions([publicRevision], {
    evidenceRecords: publicEvidence.slice(0, 1),
    sources,
    environment: 'public',
  }).allowed, false);
});

test('成长与内容工作台请求使用真实合同路径和安全写请求', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/sessions')) {
      return new Response(JSON.stringify({
        user: { id: 'u1', displayName: '小禾' },
        sessionId: 's1',
        accessToken: null,
        refreshToken: null,
        expiresAt: '2026-11-13T01:15:00.000Z',
        refreshExpiresAt: '2026-12-13T01:00:00.000Z',
        csrfToken: 'csrf-token',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/admin/evidence/missing')) {
      return new Response(JSON.stringify({
        error: {
          code: 'EVIDENCE_NOT_FOUND',
          message: '证据不可见',
          requestId: 'request-1',
          details: { scope: 'evidence' },
        },
      }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ items: [], nextCursor: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const api = new BabyPlanApi({ baseUrl: DEFAULT_API_BASE, fetchImpl });
  await api.login({
    email: 'parent@example.test',
    password: 'not-a-real-password',
    deviceId: 'de305d54-75b4-431b-adb2-eb6b9e546014',
  });
  await api.getFamilySnapshot('family-1', { pageToken: 'page/2', limit: 25 });
  await api.ensurePlans('child-1', 'operation-plans');
  await api.createMemory('child-1', { operationId: 'operation-1' });
  await api.listContentSources();
  await assert.rejects(
    () => api.getReviewEvidence('missing'),
    (error) => error instanceof ApiError
      && error.status === 404
      && error.code === 'EVIDENCE_NOT_FOUND'
      && error.requestId === 'request-1'
      && error.details.scope === 'evidence',
  );
  await api.publishRelease({
    operationId: 'operation-publish',
    revisionIds: ['revision-1'],
    environment: 'private_trial',
    evidenceRefs: ['evidence-1'],
  });

  assert.equal(
    requests[1].url,
    `${DEFAULT_API_BASE}/families/family-1/snapshot?limit=25&pageToken=page%2F2`,
  );
  assert.equal(requests[2].url, `${DEFAULT_API_BASE}/children/child-1/plans/ensure`);
  assert.equal(requests[2].options.method, 'POST');
  assert.equal(requests[2].options.headers['X-CSRF-Token'], 'csrf-token');
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    operationId: 'operation-plans',
  });
  assert.equal(requests[3].url, `${DEFAULT_API_BASE}/children/child-1/memories`);
  assert.equal(requests[3].options.headers['X-CSRF-Token'], 'csrf-token');
  assert.equal(requests[4].url, `${DEFAULT_API_BASE}/admin/sources`);
  assert.equal(requests[5].url, `${DEFAULT_API_BASE}/admin/evidence/missing`);
  assert.equal(requests[6].url, `${DEFAULT_API_BASE}/admin/releases`);
  assert.equal(requests[6].options.method, 'POST');
  assert.equal(requests[6].options.headers['X-CSRF-Token'], 'csrf-token');
  assert.deepEqual(JSON.parse(requests[6].options.body), {
    operationId: 'operation-publish',
    revisionIds: ['revision-1'],
    environment: 'private_trial',
    evidenceRefs: ['evidence-1'],
  });
});

test('孩子资料与家庭偏好输入会规范化并在提交前拒绝冲突', () => {
  const child = validateChildProfileInput({
    displayName: ' 小满 ',
    ageMode: 'months',
    ageMonths: '20',
    ageAsOf: '2026-11-13',
    birthDate: '2026-03-01',
  });
  assert.equal(child.valid, true);
  assert.deepEqual(child.value, {
    displayName: '小满',
    ageMode: 'months',
    ageMonths: 20,
    ageAsOf: '2026-11-13',
    birthDate: null,
  });
  assert.equal(validateChildProfileInput({
    displayName: '',
    ageMode: 'birthDate',
    ageMonths: '',
    ageAsOf: '',
    birthDate: '',
  }).errors.birthDate, '请选择出生日期');

  const preferences = validatePreferenceInput({
    availableMaterials: '积木，纸，积木\n绘本',
    excludedMaterials: '响铃玩具',
    languageMode: 'zh_with_english',
  });
  assert.equal(preferences.valid, true);
  assert.deepEqual(preferences.value.availableMaterials, ['积木', '纸', '绘本']);

  const conflicting = validatePreferenceInput({
    availableMaterials: '积木、纸',
    excludedMaterials: '纸',
    languageMode: 'zh',
  });
  assert.equal(conflicting.valid, false);
  assert.match(conflicting.errors.materials, /不能同时出现/);
});

test('内容差异指出新增修订中的具体字段变化', () => {
  const changes = activityDiff({
    title: '推小车',
    support: '练习走稳',
    materials: ['小车'],
    dialogue: { opening: '你好' },
    sourceIds: ['src-1'],
  }, {
    title: '推小车',
    support: '练习停步与转身',
    materials: ['小车', '软垫'],
    dialogue: { opening: '你好', engaged: '慢一点' },
    sourceIds: ['src-1', 'src-2'],
  });
  assert.deepEqual(changes.map((change) => change.label), [
    '支持方向',
    '材料',
    '亲子对话',
    '来源',
  ]);
});

test('家庭管理、重新认证、删除和内容写操作使用合同路径', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/sessions/csrf')) {
      return new Response(JSON.stringify({ csrfToken: 'csrf-family' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/sessions/reauth')) {
      return new Response(JSON.stringify({
        reauthToken: 'reauth-once',
        expiresAt: '2026-11-13T01:05:00.000Z',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ id: 'ok', revision: 2 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const api = new BabyPlanApi({ baseUrl: DEFAULT_API_BASE, fetchImpl });

  await api.updateFamilyPreferences('family 1', {
    operationId: 'operation-preferences',
    baseRevision: 2,
    availableMaterials: ['积木'],
    excludedMaterials: [],
    languageMode: 'zh_with_english',
  });
  await api.createInvitation('family 1', 'operation-invite');
  await api.removeFamilyMember('family 1', 'user/2', 'operation-remove');
  await api.requestReauth('current-password-value');
  await api.requestFamilyDeletion('family 1', {
    operationId: 'operation-delete',
    confirmFamilyName: '小满一家',
    reauthToken: 'reauth-once',
  });
  await api.createContentRevision('activity/1', {
    operationId: 'operation-revision',
    baseRevision: 1,
    activity: { id: 'activity/1', revision: 2 },
    changeNote: '核验安全说明',
  });
  await api.submitContentRevision('revision/1', {
    operationId: 'operation-submit',
    baseRevision: 2,
  });
  await api.reviewContentRevision('revision/1', {
    operationId: 'operation-review',
    baseRevision: 2,
    decision: 'approve',
    checks: ['sources', 'age_safety', 'language', 'rights'],
    note: '四项人工核对完成',
    selfReviewed: false,
    evidenceRefs: ['evidence-1'],
  });
  await api.createReviewEvidence('operation-evidence', {
    id: 'evidence-1',
    kind: 'family_trial',
    decision: 'approved',
  });
  await api.withdrawRelease('release/1', {
    operationId: 'operation-withdraw',
    kind: 'safety',
    reason: '停止推荐并通知家长',
  });

  assert.equal(
    requests[1].url,
    `${DEFAULT_API_BASE}/families/family%201/preferences`,
  );
  assert.equal(requests[1].options.method, 'PUT');
  assert.equal(requests[1].options.headers['X-CSRF-Token'], 'csrf-family');
  assert.equal(
    requests[2].url,
    `${DEFAULT_API_BASE}/families/family%201/invitations`,
  );
  assert.equal(requests[2].options.method, 'POST');
  assert.equal(
    requests[3].url,
    `${DEFAULT_API_BASE}/families/family%201/members/user%2F2`,
  );
  assert.equal(requests[3].options.method, 'DELETE');
  assert.equal(requests[4].url, `${DEFAULT_API_BASE}/sessions/reauth`);
  assert.equal(requests[4].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[4].options.body), {
    password: 'current-password-value',
  });
  assert.equal(
    requests[5].url,
    `${DEFAULT_API_BASE}/families/family%201`,
  );
  assert.equal(requests[5].options.method, 'DELETE');
  assert.equal(
    requests[6].url,
    `${DEFAULT_API_BASE}/admin/activities/activity%2F1/revisions`,
  );
  assert.deepEqual(JSON.parse(requests[6].options.body), {
    operationId: 'operation-revision',
    baseRevision: 1,
    activity: { id: 'activity/1', revision: 2 },
    changeNote: '核验安全说明',
  });
  assert.equal(
    requests[7].url,
    `${DEFAULT_API_BASE}/admin/revisions/revision%2F1/submit`,
  );
  assert.equal(requests[7].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[7].options.body), {
    operationId: 'operation-submit',
    baseRevision: 2,
  });
  assert.equal(
    requests[8].url,
    `${DEFAULT_API_BASE}/admin/revisions/revision%2F1/review`,
  );
  assert.equal(requests[8].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[8].options.body), {
    operationId: 'operation-review',
    baseRevision: 2,
    decision: 'approve',
    checks: ['sources', 'age_safety', 'language', 'rights'],
    note: '四项人工核对完成',
    selfReviewed: false,
    evidenceRefs: ['evidence-1'],
  });
  assert.equal(requests[9].url, `${DEFAULT_API_BASE}/admin/evidence`);
  assert.equal(requests[9].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[9].options.body), {
    operationId: 'operation-evidence',
    record: {
      id: 'evidence-1',
      kind: 'family_trial',
      decision: 'approved',
    },
  });
  assert.equal(
    requests[10].url,
    `${DEFAULT_API_BASE}/admin/releases/release%2F1/withdraw`,
  );
  assert.equal(requests[10].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[10].options.body), {
    operationId: 'operation-withdraw',
    kind: 'safety',
    reason: '停止推荐并通知家长',
  });
});

test('照片上传严格按申请、原始字节 PUT、完成处理顺序执行', async () => {
  const requests = [];
  const photo = new Blob(['private-photo-bytes'], { type: 'image/png' });
  const uploadKey = 'local-fixture-upload-ticket';
  const uploadPath = `/media/upload-targets/${uploadKey}`;
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url === `${DEFAULT_API_BASE}${uploadPath}`) {
      return new Response('', { status: 200 });
    }
    if (url.endsWith('/media/uploads')) {
      return new Response(JSON.stringify({
        media: { id: 'media-1', state: 'pending' },
        uploadUrl: `https://uploads.example.test/v2${uploadPath}`,
        expiresAt: '2026-11-13T01:10:00.000Z',
      }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/media/media-1/complete')) {
      return new Response(JSON.stringify({
        id: 'media-1',
        state: 'ready',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`未预期请求：${url}`);
  };
  const api = new BabyPlanApi({ baseUrl: DEFAULT_API_BASE, fetchImpl });
  api.csrfToken = 'csrf-upload';

  const ticket = await api.createMediaUpload({
    operationId: 'operation-upload',
    memoryId: 'memory-1',
    mime: 'image/png',
    byteSize: photo.size,
    sha256: 'a'.repeat(64),
  });
  await api.uploadMediaBytes(ticket.uploadUrl, photo, photo.type);
  const completed = await api.completeMediaUpload('media-1', 'operation-complete');

  assert.deepEqual(requests.map((request) => ({
    url: request.url,
    method: request.options.method,
  })), [
    {
      url: `${DEFAULT_API_BASE}/media/uploads`,
      method: 'POST',
    },
    {
      url: `${DEFAULT_API_BASE}${uploadPath}`,
      method: 'PUT',
    },
    {
      url: `${DEFAULT_API_BASE}/media/media-1/complete`,
      method: 'POST',
    },
  ]);
  assert.equal(requests[0].options.headers['X-CSRF-Token'], 'csrf-upload');
  assert.equal(requests[1].options.headers['Content-Type'], 'image/png');
  assert.equal(requests[1].options.body, photo);
  assert.equal(requests[1].options.headers['X-CSRF-Token'], undefined);
  assert.equal(completed.state, 'ready');
  const uuid = '3b6b98f3-6f66-48ba-9b85-3f8fbddf3b93';
  const signedPath = `/v2/media/${uuid}/content?token=${uploadKey}`;
  assert.equal(api.signedDownloadUrl('media', uuid, `https://api.example.test${signedPath}`), signedPath);
  assert.equal(api.signedDownloadUrl('exports', uuid, signedPath), '');
  assert.equal(api.signedDownloadUrl('media', uuid, `${signedPath}&token=${uploadKey}`), '');
});

test('409 冲突会展示服务端当前修订和本次提交修订', () => {
  for (const current of [4, { revision: 4, mode: 'lite' }]) {
    const error = new ApiError('修订冲突', {
      status: 409,
      code: 'REVISION_CONFLICT',
      details: { current, submitted: 3 },
    });
    assert.match(apiErrorMessage(error), /服务端当前修订 4/);
    assert.match(apiErrorMessage(error), /本次提交 3/);
  }
});

test('非修订冲突的 409 保留服务端业务提示', () => {
  const error = new ApiError('这个邀请码已存在，请换一个', {
    status: 409,
    code: 'INVITATION_CODE_EXISTS',
  });
  assert.equal(apiErrorMessage(error), '这个邀请码已存在，请换一个');
});
