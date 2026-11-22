export const MEMORY_TYPE_LABELS = {
  quote: '宝宝原话',
  story: '小故事',
  first: '第一次',
};

export const OBSERVATION_VALUE_LABELS = {
  noticed: '我留意到了',
  not_yet_observed: '还没留意',
  discuss: '想和专业或家人聊聊',
};

export const MEASUREMENT_KIND_LABELS = {
  height: '身高',
  weight: '体重',
};

export const CONTENT_STATUS_LABELS = {
  draft: '草稿',
  in_review: '审核中',
  approved: '已通过',
  published: '已发布',
  withdrawn: '已撤回',
};

const SNAPSHOT_ARRAY_KEYS = [
  'children',
  'days',
  'memories',
  'measurements',
  'observations',
  'sessions',
  'books',
  'media',
  'withdrawals',
];

export function dateDaysAgo(currentDate, days) {
  const [year, month, day] = currentDate.split('-').map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day));
  instant.setUTCDate(instant.getUTCDate() - days);
  return instant.toISOString().slice(0, 10);
}

export function validateExportRequest({ from, to, types }) {
  const errors = {};
  if (!from) errors.from = '请选择开始日期';
  if (!to) errors.to = '请选择结束日期';
  if (from && to && from > to) errors.to = '结束日期不能早于开始日期';
  if (!Array.isArray(types) || types.length === 0) {
    errors.types = '请至少选择一种导出内容';
  }
  return { errors, valid: Object.keys(errors).length === 0 };
}

export function sortedGrowthEvents(snapshot) {
  const events = [
    ...(snapshot?.memories ?? []).map((item) => ({ ...item, eventKind: 'memory' })),
    ...(snapshot?.measurements ?? []).map((item) => ({ ...item, eventKind: 'measurement' })),
    ...(snapshot?.observations ?? []).map((item) => ({ ...item, eventKind: 'observation' })),
  ];
  return events.sort((left, right) => {
    const dateOrder = String(right.localDate).localeCompare(String(left.localDate));
    return dateOrder || String(left.id).localeCompare(String(right.id));
  });
}

export function mergeSnapshotPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('家庭快照没有返回任何分页');
  }
  const first = pages[0];
  if (!first?.snapshotId || !first?.cursor) {
    throw new Error('家庭快照分页缺少快照标识或同步游标');
  }
  for (const page of pages.slice(1)) {
    if (page?.snapshotId !== first.snapshotId) {
      throw new Error('家庭快照分页来自不同快照，已停止合并');
    }
    if (page?.cursor !== first.cursor) {
      throw new Error('家庭快照分页的同步游标不一致，已停止合并');
    }
  }

  const merged = { ...first };
  SNAPSHOT_ARRAY_KEYS.forEach((key) => {
    merged[key] = pages.flatMap((page) => Array.isArray(page?.[key]) ? page[key] : []);
  });
  merged.nextPageToken = null;
  merged.hasMore = false;
  merged.expiresAt = pages.at(-1)?.expiresAt || first.expiresAt;
  return merged;
}

export function resolveEvidenceReferences(referenceIds, sources = []) {
  const sourceById = new Map(
    sources
      .filter((source) => source && typeof source.id === 'string')
      .map((source) => [source.id, source]),
  );
  return (Array.isArray(referenceIds) ? referenceIds : []).map((id) => ({
    id,
    source: sourceById.get(id) || null,
  }));
}

export function isSafeHttpUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function evidenceMatchesRevision(evidence, revision) {
  return Boolean(
    evidence
    && evidence.decision === 'approved'
    && evidence.actorKind === 'human'
    && evidence.cardId === revision.activity?.id
    && evidence.revision === revision.revision
    && evidence.contentHash === revision.contentHash,
  );
}

function evidenceAllowsEnvironment(evidence, environment) {
  if (!Array.isArray(evidence?.allowedEnvironments)) {
    return environment === 'private_trial';
  }
  return evidence.allowedEnvironments.includes(environment);
}

export function canPublishRevisions(revisions, {
  evidenceRecords = [],
  sources = [],
  sourceDetailsAvailable = true,
  environment = 'private_trial',
} = {}) {
  if (!Array.isArray(revisions) || revisions.length === 0) {
    return { allowed: false, reason: '还没有选择要发布的内容修订' };
  }
  if (!sourceDetailsAvailable) {
    return {
      allowed: false,
      reason: '来源或审读证据详情尚未读取，不能据此发布内容',
    };
  }

  const evidenceById = new Map(
    evidenceRecords
      .filter((record) => record && typeof record.id === 'string')
      .map((record) => [record.id, record]),
  );
  const sourceIds = new Set(
    sources
      .filter((source) => source && typeof source.id === 'string')
      .map((source) => source.id),
  );
  const blocked = revisions.filter((revision) => {
    const refs = Array.isArray(revision.evidenceRefs) ? revision.evidenceRefs : [];
    const activitySourceIds = Array.isArray(revision.activity?.sourceIds)
      ? revision.activity.sourceIds
      : [];
    const matchingEvidence = refs
      .map((reference) => evidenceById.get(reference))
      .filter((evidence) => evidenceMatchesRevision(evidence, revision));
    const privateEvidenceAvailable = matchingEvidence.some(
      (evidence) => evidenceAllowsEnvironment(evidence, 'private_trial'),
    );
    const independentReviewAvailable = matchingEvidence.some(
      (evidence) => evidence.selfReviewed === false
        && evidenceAllowsEnvironment(evidence, 'public')
        && ['editorial_review', 'expert_review'].includes(evidence.kind),
    );
    const familyTrialAvailable = matchingEvidence.some(
      (evidence) => evidence.kind === 'family_trial'
        && Boolean(evidence.completedAt)
        && evidenceAllowsEnvironment(evidence, 'public'),
    );
    const environmentEvidenceAvailable = environment === 'public'
      ? independentReviewAvailable && familyTrialAvailable
      : privateEvidenceAvailable;
    return revision.status !== 'approved'
      || revision.activity?.reviewState !== 'reviewed'
      || revision.activity?.withdrawn
      || refs.length === 0
      || activitySourceIds.length === 0
      || activitySourceIds.some((sourceId) => !sourceIds.has(sourceId))
      || !environmentEvidenceAvailable;
  });
  if (blocked.length > 0) {
    return {
      allowed: false,
      reason: `有 ${blocked.length} 项修订未同时满足${environment === 'public' ? '公开发布所需的独立审读、家庭试玩、' : ''}审核、来源、证据绑定和正文哈希校验，不能发布`,
    };
  }
  return {
    allowed: true,
    reason: environment === 'public'
      ? '所有修订均通过独立审读与试玩证据、来源及固定正文哈希校验'
      : '所有修订均已通过审核，且来源证据与固定正文哈希一致',
  };
}

function normalizedDiffValue(value) {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((item) => String(item).trim()));
  }
  if (value && typeof value === 'object') {
    return JSON.stringify(
      Object.keys(value)
        .sort()
        .map((key) => [key, String(value[key] ?? '').trim()]),
    );
  }
  return String(value ?? '').trim();
}

export function activityDiff(previous, current) {
  if (!previous || !current) return [];
  const fields = [
    ['标题', 'title'],
    ['类型', 'kind'],
    ['年龄档', 'ageBands'],
    ['支持方向', 'support'],
    ['材料', 'materials'],
    ['步骤', 'steps'],
    ['亲子对话', 'dialogue'],
    ['英语', 'english'],
    ['更容易', 'easier'],
    ['下一步', 'next'],
    ['安全说明', 'safety'],
    ['来源', 'sourceIds'],
    ['权利状态', 'rights'],
  ];
  return fields
    .filter(([, key]) => (
      normalizedDiffValue(previous[key]) !== normalizedDiffValue(current[key])
    ))
    .map(([label, key]) => ({
      label,
      previous: previous[key],
      current: current[key],
    }));
}
