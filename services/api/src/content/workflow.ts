import { createHash, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { AppError, notFound } from '../errors.js';
import {
  userRequestHash,
  withTransaction,
} from '../db/transactions.js';
import {
  type ContentCard,
  type ContentPackage,
} from './package.js';

export type ContentRole = 'editor' | 'reviewer' | 'publisher';
export type ContentStatus =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'published'
  | 'withdrawn';
export type ContentRevisionDto = {
  id: string;
  activity: ContentCard;
  status: ContentStatus;
  revision: number;
  changeNote: string;
  contentHash: string;
  authorId: string;
  evidenceRefs: string[];
};
export type ReleaseDto = {
  id: string;
  version: number;
  revisionIds: string[];
  state: 'published' | 'withdrawn';
  selfReviewed: boolean;
  publishedAt: string;
  environment: 'private_trial' | 'public';
  active: boolean;
  evidenceRefs: string[];
};
export type ReviewEvidence = {
  id: string;
  kind: 'editorial_review' | 'expert_review' | 'family_trial' | 'rights_license';
  cardId: string;
  revision: number;
  contentHash: string;
  actorId: string;
  actorKind: 'human';
  createdAt: string;
  decision: 'approved' | 'rejected';
  evidenceRef: string;
  authorId?: string | undefined;
  selfReviewed?: boolean | undefined;
  checks?: Array<'sources' | 'age_safety' | 'language' | 'rights'> | undefined;
  qualificationRef?: string | undefined;
  completedAt?: string | undefined;
  authorizationRef?: string | undefined;
  scope?: string | undefined;
  allowedEnvironments?: Array<'private_trial' | 'public'> | undefined;
};

type RevisionRow = {
  id: string;
  activity_id: string;
  activity_revision: number;
  content: ContentCard;
  content_hash: string;
  workflow_status: ContentStatus;
  author_id: string;
  change_note: string;
  evidence_refs: string[];
  withdrawn_at: Date | null;
};

type EvidenceRow = {
  id: string;
  kind: ReviewEvidence['kind'];
  card_id: string;
  revision_number: number;
  content_hash: string;
  actor_id: string;
  actor_kind: 'human';
  evidence_created_at: Date;
  decision: ReviewEvidence['decision'];
  evidence_ref: string;
  author_id: string | null;
  self_reviewed: boolean | null;
  checks: ReviewEvidence['checks'] | null;
  qualification_ref: string | null;
  completed_at: Date | null;
  authorization_ref: string | null;
  scope: string | null;
  allowed_environments: ReviewEvidence['allowedEnvironments'] | null;
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function cursorEncode(value: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function cursorDecode(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { createdAt?: unknown; id?: unknown };
    if (
      typeof parsed.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== 'string' ||
      parsed.id.length > 100
    ) {
      throw new Error();
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new AppError(400, 'INVALID_REQUEST', '分页游标无效');
  }
}

export async function rolesForUser(
  pool: Pool | PoolClient,
  userId: string,
): Promise<ContentRole[]> {
  const result = await pool.query<{ role: ContentRole }>(
    'SELECT role FROM app.content_roles WHERE user_id=$1 ORDER BY role',
    [userId],
  );
  return result.rows.map(row => row.role);
}

export function requireContentRole(
  pool: Pool,
  allowed?: ReadonlyArray<ContentRole>,
) {
  return async (request: FastifyRequest): Promise<void> => {
    const roles = await rolesForUser(pool, request.auth.userId);
    if (!roles.length) {
      throw new AppError(403, 'CONTENT_ROLE_REQUIRED', '当前账号没有内容工作台权限');
    }
    if (allowed && !roles.some(role => allowed.includes(role))) {
      throw new AppError(403, 'CONTENT_ROLE_REQUIRED', '当前账号没有这项内容操作权限');
    }
  };
}

async function withContentOperation<T>(
  pool: Pool,
  actorUserId: string,
  operationId: string,
  action: string,
  request: unknown,
  work: (client: PoolClient) => Promise<{ statusCode: number; body: T }>,
): Promise<T> {
  const hash = userRequestHash({ actorUserId, action, request });
  return withTransaction(pool, async client => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`content:${actorUserId}:${operationId}`],
    );
    const previous = await client.query<{
      request_hash: string;
      response_status: number;
      result: T;
      expired: boolean;
    }>(`
      SELECT request_hash,response_status,result,expires_at <= now() AS expired
      FROM app.content_operations
      WHERE actor_user_id=$1 AND operation_id=$2
    `, [actorUserId, operationId]);
    const saved = previous.rows[0];
    if (saved) {
      if (saved.request_hash !== hash) {
        throw new AppError(409, 'OPERATION_REUSED', '同一操作标识不能用于不同内容');
      }
      if (saved.expired) {
        throw new AppError(409, 'OPERATION_EXPIRED', '该操作已过期，请先核对现有内容');
      }
      return saved.result;
    }
    const result = await work(client);
    await client.query(`
      INSERT INTO app.content_operations(
        actor_user_id,operation_id,action,request_hash,response_status,result
      ) VALUES($1,$2,$3,$4,$5,$6)
    `, [actorUserId, operationId, action, hash, result.statusCode, result.body]);
    return result.body;
  });
}

function revisionDto(row: RevisionRow): ContentRevisionDto {
  return {
    id: row.id,
    activity: row.content,
    status: row.withdrawn_at ? 'withdrawn' : row.workflow_status,
    revision: Number(row.activity_revision),
    changeNote: row.change_note,
    contentHash: row.content_hash,
    authorId: row.author_id,
    evidenceRefs: row.evidence_refs ?? [],
  };
}

const revisionSelect = `
  SELECT ar.id,ar.activity_id,ar.revision AS activity_revision,ar.content,
         ar.content_hash,ar.withdrawn_at,w.status AS workflow_status,
         w.author_id,w.change_note,w.evidence_refs
  FROM app.activity_revisions ar
  JOIN app.content_revision_workflow w ON w.revision_id=ar.id
`;

async function loadRevision(
  client: PoolClient,
  revisionId: string,
  lock = false,
): Promise<RevisionRow> {
  const result = await client.query<RevisionRow>(`
    ${revisionSelect}
    WHERE ar.id=$1
    ${lock ? 'FOR UPDATE OF ar,w' : ''}
  `, [revisionId]);
  if (!result.rows[0]) throw notFound();
  return result.rows[0];
}

export async function createContentRevision(
  pool: Pool,
  actorUserId: string,
  input: {
    activityId: string;
    operationId: string;
    baseRevision: number;
    activity: ContentCard;
    changeNote: string;
  },
): Promise<ContentRevisionDto> {
  return withContentOperation(
    pool,
    actorUserId,
    input.operationId,
    'content.revision.create',
    input,
    async client => {
      if (input.activity.id !== input.activityId) {
        throw new AppError(400, 'INVALID_REQUEST', '路径与正文中的活动标识不一致');
      }
      const latest = await client.query<{
        id: string;
        revision: number;
        package_id: string;
        content_version: number;
      }>(`
        SELECT id,revision,package_id,content_version
        FROM app.activity_revisions
        WHERE activity_id=$1
        ORDER BY revision DESC
        LIMIT 1
        FOR UPDATE
      `, [input.activityId]);
      const current = latest.rows[0];
      if (input.baseRevision === 0 && current) {
        throw new AppError(409, 'REVISION_CONFLICT', '活动已有修订，请基于最新修订继续', {
          current: Number(current.revision),
          submitted: input.baseRevision,
        });
      }
      if (input.baseRevision > 0 && (!current || Number(current.revision) !== input.baseRevision)) {
        throw new AppError(409, 'REVISION_CONFLICT', '活动修订已被其他编辑更新', {
          current: current ? Number(current.revision) : null,
          submitted: input.baseRevision,
        });
      }
      const nextRevision = input.baseRevision + 1;
      if (input.activity.revision !== nextRevision) {
        throw new AppError(422, 'INVALID_REVISION', '正文修订号必须等于服务器的下一修订号');
      }
      const basePackage = await client.query<{
        package_id: string;
        content_version: number;
      }>(`
        SELECT package_id,content_version
        FROM app.content_releases
        WHERE package_snapshot IS NOT NULL
        ORDER BY published_at DESC NULLS LAST,version DESC
        LIMIT 1
      `);
      const content: ContentCard = {
        ...input.activity,
        revision: nextRevision,
        reviewState: 'draft',
        withdrawn: false,
      };
      const revisionId = randomUUID();
      const contentHash = sha256(JSON.stringify(content));
      await client.query(`
        INSERT INTO app.activity_revisions(
          id,activity_id,revision,package_id,content_version,kind,age_bands,title,
          support,materials,content,content_hash,review_state
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft')
      `, [
        revisionId,
        content.id,
        nextRevision,
        current?.package_id ?? basePackage.rows[0]?.package_id ?? 'workflow',
        current?.content_version ?? basePackage.rows[0]?.content_version ?? 1,
        content.kind,
        JSON.stringify(content.ageBands),
        content.title,
        content.support,
        JSON.stringify(content.materials),
        JSON.stringify(content),
        contentHash,
      ]);
      await client.query(`
        INSERT INTO app.content_revision_workflow(
          revision_id,status,author_id,change_note
        ) VALUES($1,'draft',$2,$3)
      `, [revisionId, actorUserId, input.changeNote]);
      const row = await loadRevision(client, revisionId);
      return { statusCode: 201, body: revisionDto(row) };
    },
  );
}

export async function submitContentRevision(
  pool: Pool,
  actorUserId: string,
  revisionId: string,
  input: { operationId: string; baseRevision: number },
): Promise<ContentRevisionDto> {
  return withContentOperation(
    pool,
    actorUserId,
    input.operationId,
    'content.revision.submit',
    { revisionId, ...input },
    async client => {
      const row = await loadRevision(client, revisionId, true);
      if (Number(row.activity_revision) !== input.baseRevision) {
        throw new AppError(409, 'REVISION_CONFLICT', '内容修订已被更新', {
          current: Number(row.activity_revision),
          submitted: input.baseRevision,
        });
      }
      if (row.workflow_status !== 'draft') {
        throw new AppError(409, 'INVALID_REVISION_STATE', '只有草稿可以送审');
      }
      const sources = await client.query<{ count: string }>(`
        SELECT count(*) FROM app.content_sources WHERE id=ANY($1::text[])
      `, [row.content.sourceIds]);
      if (
        !row.content.sourceIds.length ||
        Number(sources.rows[0]?.count) !== new Set(row.content.sourceIds).size
      ) {
        throw new AppError(422, 'SOURCE_REQUIRED', '送审前必须绑定已登记的真实来源');
      }
      if (!row.content.steps.length || !row.content.safety.trim()) {
        throw new AppError(422, 'CONTENT_INCOMPLETE', '活动步骤和安全信息不能为空');
      }
      await client.query(`
        UPDATE app.content_revision_workflow
        SET status='in_review',submitted_at=now(),updated_at=now()
        WHERE revision_id=$1
      `, [revisionId]);
      return { statusCode: 200, body: revisionDto(await loadRevision(client, revisionId)) };
    },
  );
}

function evidenceMatchesRevision(
  evidence: EvidenceRow,
  row: RevisionRow,
): boolean {
  return evidence.card_id === row.activity_id &&
    Number(evidence.revision_number) === Number(row.activity_revision) &&
    evidence.content_hash === row.content_hash;
}

async function insertEvidence(
  client: PoolClient,
  actorUserId: string,
  record: ReviewEvidence,
): Promise<ReviewEvidence> {
  if (record.actorId !== actorUserId || record.actorKind !== 'human') {
    throw new AppError(422, 'HUMAN_REVIEW_REQUIRED', '审读证据必须绑定当前真实审读账号');
  }
  const revision = await client.query<{
    id: string;
    content_hash: string;
    author_id: string | null;
    created_at: Date;
  }>(`
    SELECT ar.id,ar.content_hash,w.author_id,ar.created_at
    FROM app.activity_revisions ar
    LEFT JOIN app.content_revision_workflow w ON w.revision_id=ar.id
    WHERE ar.activity_id=$1 AND ar.revision=$2
  `, [record.cardId, record.revision]);
  const row = revision.rows[0];
  if (!row || row.content_hash !== record.contentHash) {
    throw new AppError(422, 'EVIDENCE_HASH_MISMATCH', '证据没有绑定当前内容正文');
  }
  const actualSelfReviewed = row.author_id === actorUserId;
  if (
    (record.kind === 'editorial_review' || record.kind === 'expert_review') &&
    (record.authorId !== row.author_id ||
      record.selfReviewed !== actualSelfReviewed)
  ) {
    throw new AppError(422, 'SELF_REVIEW_MISMATCH', '审读人与作者关系由服务器计算');
  }
  if (record.kind === 'editorial_review') {
    const expected = ['age_safety', 'language', 'rights', 'sources'];
    if (
      !record.checks ||
      [...record.checks].sort().join(',') !== expected.join(',')
    ) {
      throw new AppError(422, 'REVIEW_CHECKS_REQUIRED', '编辑审读必须完成四项检查');
    }
  }
  if (record.kind === 'expert_review' && !record.qualificationRef?.trim()) {
    throw new AppError(422, 'QUALIFICATION_REQUIRED', '专业审读必须提供资质引用');
  }
  if (
    record.kind === 'family_trial' &&
    (!record.completedAt || record.decision !== 'approved')
  ) {
    throw new AppError(422, 'FAMILY_TRIAL_INCOMPLETE', '家庭试玩必须记录完成时间和通过结论');
  }
  if (
    record.kind === 'rights_license' &&
    (!record.authorizationRef?.trim() ||
      !record.scope?.trim() ||
      !record.allowedEnvironments?.length ||
      record.decision !== 'approved')
  ) {
    throw new AppError(422, 'RIGHTS_EVIDENCE_INCOMPLETE', '授权证据必须包含范围与可用环境');
  }
  const existing = await client.query('SELECT id FROM app.content_review_evidence WHERE id=$1', [record.id]);
  if (existing.rows[0]) throw new AppError(409, 'EVIDENCE_ID_CONFLICT', '同一证据标识已被使用');
  await client.query(`
    INSERT INTO app.content_review_evidence(
      id,kind,card_id,revision_number,content_hash,actor_id,actor_kind,
      evidence_created_at,decision,evidence_ref,author_id,self_reviewed,checks,
      qualification_ref,completed_at,authorization_ref,scope,allowed_environments,
      record,created_by
    ) VALUES(
      $1,$2,$3,$4,$5,$6,'human',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
    )
  `, [
    record.id,
    record.kind,
    record.cardId,
    record.revision,
    record.contentHash,
    record.actorId,
    record.createdAt,
    record.decision,
    record.evidenceRef,
    record.authorId ?? null,
    record.selfReviewed ?? null,
    record.checks ? JSON.stringify(record.checks) : null,
    record.qualificationRef ?? null,
    record.completedAt ?? null,
    record.authorizationRef ?? null,
    record.scope ?? null,
    record.allowedEnvironments ?? null,
    JSON.stringify(record),
    actorUserId,
  ]);
  return record;
}

function evidenceDto(row: EvidenceRow): ReviewEvidence {
  return {
    id: row.id,
    kind: row.kind,
    cardId: row.card_id,
    revision: Number(row.revision_number),
    contentHash: row.content_hash,
    actorId: row.actor_id,
    actorKind: 'human',
    createdAt: row.evidence_created_at.toISOString(),
    decision: row.decision,
    evidenceRef: row.evidence_ref,
    ...(row.author_id ? { authorId: row.author_id } : {}),
    ...(row.self_reviewed !== null ? { selfReviewed: row.self_reviewed } : {}),
    ...(row.checks ? { checks: row.checks } : {}),
    ...(row.qualification_ref ? { qualificationRef: row.qualification_ref } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {}),
    ...(row.authorization_ref ? { authorizationRef: row.authorization_ref } : {}),
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.allowed_environments ? { allowedEnvironments: row.allowed_environments } : {}),
  };
}

export async function createReviewEvidence(
  pool: Pool,
  actorUserId: string,
  operationId: string,
  record: ReviewEvidence,
): Promise<ReviewEvidence> {
  return withContentOperation(
    pool,
    actorUserId,
    operationId,
    'content.evidence.create',
    { record },
    async client => {
      const created = await insertEvidence(client, actorUserId, record);
      return { statusCode: 201, body: created };
    },
  );
}

export async function getReviewEvidence(
  pool: Pool,
  evidenceId: string,
): Promise<ReviewEvidence> {
  const result = await pool.query<EvidenceRow>(`
    SELECT id,kind,card_id,revision_number,content_hash,actor_id,actor_kind,
           evidence_created_at,decision,evidence_ref,author_id,self_reviewed,
           checks,qualification_ref,completed_at,authorization_ref,scope,
           allowed_environments
    FROM app.content_review_evidence WHERE id=$1
  `, [evidenceId]);
  if (!result.rows[0]) throw notFound();
  return evidenceDto(result.rows[0]);
}

export async function reviewContentRevision(
  pool: Pool,
  actorUserId: string,
  revisionId: string,
  input: {
    operationId: string;
    baseRevision: number;
    decision: 'approve' | 'reject';
    checks: Array<'sources' | 'age_safety' | 'language' | 'rights'>;
    note: string;
    selfReviewed: boolean;
    evidenceRefs: string[];
  },
): Promise<ContentRevisionDto> {
  return withContentOperation(
    pool,
    actorUserId,
    input.operationId,
    'content.revision.review',
    { revisionId, ...input },
    async client => {
      const row = await loadRevision(client, revisionId, true);
      if (Number(row.activity_revision) !== input.baseRevision) {
        throw new AppError(409, 'REVISION_CONFLICT', '内容修订已被更新', {
          current: Number(row.activity_revision),
          submitted: input.baseRevision,
        });
      }
      if (row.workflow_status !== 'in_review') {
        throw new AppError(409, 'INVALID_REVISION_STATE', '只有待审修订可以审核');
      }
      const actualSelfReviewed = row.author_id === actorUserId;
      if (input.selfReviewed !== actualSelfReviewed) {
        throw new AppError(422, 'SELF_REVIEW_MISMATCH', '自审标记与当前审读身份不一致');
      }
      if (
        input.decision === 'approve' &&
        [...input.checks].sort().join(',') !==
          ['age_safety', 'language', 'rights', 'sources'].join(',')
      ) {
        throw new AppError(422, 'REVIEW_CHECKS_REQUIRED', '通过审核必须完成四项检查');
      }
      const evidenceRefs = [...new Set(input.evidenceRefs)];
      if (evidenceRefs.length) {
        const evidence = await client.query<EvidenceRow>(`
          SELECT id,kind,card_id,revision_number,content_hash,actor_id,actor_kind,
                 evidence_created_at,decision,evidence_ref,author_id,self_reviewed,
                 checks,qualification_ref,completed_at,authorization_ref,scope,
                 allowed_environments
          FROM app.content_review_evidence WHERE id=ANY($1::text[])
        `, [evidenceRefs]);
        if (
          evidence.rows.length !== evidenceRefs.length ||
          evidence.rows.some(item =>
            !evidenceMatchesRevision(item, row) || item.decision !== 'approved')
        ) {
          throw new AppError(422, 'INVALID_EVIDENCE_REF', '证据引用不存在或没有绑定这次正文');
        }
      }
      if (input.decision === 'approve') {
        const hasEditorial = evidenceRefs.length
          ? (await client.query<{ count: string }>(`
              SELECT count(*) FROM app.content_review_evidence
              WHERE id=ANY($1::text[]) AND kind='editorial_review' AND decision='approved'
            `, [evidenceRefs])).rows[0]
          : undefined;
        let refs = evidenceRefs;
        if (!hasEditorial || Number(hasEditorial.count) === 0) {
          const now = new Date().toISOString();
          const generated: ReviewEvidence = {
            id: randomUUID(),
            kind: 'editorial_review',
            cardId: row.activity_id,
            revision: Number(row.activity_revision),
            contentHash: row.content_hash,
            actorId: actorUserId,
            actorKind: 'human',
            createdAt: now,
            decision: 'approved',
            evidenceRef: `review:${revisionId}:${input.operationId}`,
            authorId: row.author_id,
            selfReviewed: actualSelfReviewed,
            checks: ['sources', 'age_safety', 'language', 'rights'],
          };
          await insertEvidence(client, actorUserId, generated);
          refs = [...refs, generated.id];
        }
        evidenceRefs.splice(0, evidenceRefs.length, ...refs);
      }
      const status: ContentStatus =
        input.decision === 'approve' ? 'approved' : 'draft';
      await client.query(`
        UPDATE app.content_revision_workflow
        SET status=$2,review_note=$3,evidence_refs=$4,reviewed_by=$5,
            reviewed_at=now(),updated_at=now()
        WHERE revision_id=$1
      `, [revisionId, status, input.note, JSON.stringify(evidenceRefs), actorUserId]);
      await client.query(`
        UPDATE app.activity_revisions SET review_state=$2 WHERE id=$1
      `, [revisionId, input.decision === 'approve' ? 'reviewed' : 'draft']);
      return { statusCode: 200, body: revisionDto(await loadRevision(client, revisionId)) };
    },
  );
}

export async function listContentRevisions(
  pool: Pool,
  input: {
    cursor?: string | undefined;
    limit?: number | undefined;
    status?: ContentStatus | undefined;
  },
): Promise<{ items: ContentRevisionDto[]; nextCursor: string | null }> {
  const limit = input.limit ?? 50;
  const cursor = input.cursor ? cursorDecode(input.cursor) : null;
  const values: unknown[] = [];
  const where: string[] = [];
  if (input.status) {
    values.push(input.status);
    where.push(`w.status=$${values.length}`);
  }
  if (cursor) {
    values.push(cursor.createdAt, cursor.id);
    where.push(`(w.created_at,w.revision_id) < ($${values.length - 1}::timestamptz,$${values.length}::uuid)`);
  }
  values.push(limit + 1);
  const result = await pool.query<RevisionRow & { workflow_created_at: Date }>(`
    SELECT ar.id,ar.activity_id,ar.revision AS activity_revision,ar.content,
           ar.content_hash,ar.withdrawn_at,w.status AS workflow_status,
           w.author_id,w.change_note,w.evidence_refs,w.created_at AS workflow_created_at
    FROM app.activity_revisions ar
    JOIN app.content_revision_workflow w ON w.revision_id=ar.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY w.created_at DESC,w.revision_id DESC
    LIMIT $${values.length}
  `, values);
  const page = result.rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(revisionDto),
    nextCursor: result.rows.length > limit && last
      ? cursorEncode({
          createdAt: last.workflow_created_at.toISOString(),
          id: last.id,
        })
      : null,
  };
}

export async function getContentRevision(
  pool: Pool,
  revisionId: string,
): Promise<ContentRevisionDto> {
  const client = await pool.connect();
  try {
    return revisionDto(await loadRevision(client, revisionId));
  } finally {
    client.release();
  }
}

export async function listContentSources(pool: Pool): Promise<{
  sources: Array<{
    id: string;
    title: string;
    url: string;
    verifiedOn: string;
    scope: string;
  }>;
}> {
  const result = await pool.query<{
    id: string;
    title: string;
    url: string;
    verified_on: string | Date;
    scope: string;
  }>(`
    SELECT id,title,url,verified_on,scope
    FROM app.content_sources
    ORDER BY id
  `);
  return {
    sources: result.rows.map(row => ({
      id: row.id,
      title: row.title,
      url: row.url,
      verifiedOn:
        row.verified_on instanceof Date
          ? row.verified_on.toISOString().slice(0, 10)
          : String(row.verified_on).slice(0, 10),
      scope: row.scope,
    })),
  };
}

async function releaseDto(
  client: PoolClient,
  row: {
    id: string;
    version: number;
    status: 'draft' | 'published' | 'withdrawn';
    self_reviewed: boolean;
    published_at: Date | null;
    environment: 'development' | 'private_trial' | 'public';
    active: boolean;
    evidence_refs: string[];
  },
): Promise<ReleaseDto> {
  if (row.environment === 'development' || !row.published_at) throw notFound();
  const revisions = await client.query<{ activity_revision_id: string }>(`
    SELECT activity_revision_id
    FROM app.content_release_revisions
    WHERE release_id=$1
    ORDER BY activity_revision_id
  `, [row.id]);
  return {
    id: row.id,
    version: Number(row.version),
    revisionIds: revisions.rows.map(item => item.activity_revision_id),
    state: row.status === 'withdrawn' ? 'withdrawn' : 'published',
    selfReviewed: row.self_reviewed,
    publishedAt: row.published_at.toISOString(),
    environment: row.environment,
    active: row.active,
    evidenceRefs: row.evidence_refs,
  };
}

export async function publishContentWorkflowRelease(
  pool: Pool,
  actorUserId: string,
  input: {
    operationId: string;
    revisionIds: string[];
    environment: 'private_trial' | 'public';
    evidenceRefs: string[];
  },
): Promise<ReleaseDto> {
  return withContentOperation(
    pool,
    actorUserId,
    input.operationId,
    'content.release.publish',
    input,
    async client => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`content-release:${input.environment}`],
      );
      const revisionIds = [...new Set(input.revisionIds)];
      const revisions = await client.query<RevisionRow>(`
        ${revisionSelect}
        WHERE ar.id=ANY($1::uuid[])
        FOR UPDATE OF ar,w
      `, [revisionIds]);
      if (
        revisions.rows.length !== revisionIds.length ||
        revisions.rows.some(row =>
          row.workflow_status !== 'approved' || row.withdrawn_at)
      ) {
        throw new AppError(422, 'REVISION_NOT_APPROVED', '只能发布已审核且未撤回的固定修订');
      }
      const requestedEvidence = [...new Set(input.evidenceRefs)];
      const allEvidence = await client.query<EvidenceRow>(`
        SELECT id,kind,card_id,revision_number,content_hash,actor_id,actor_kind,
               evidence_created_at,decision,evidence_ref,author_id,self_reviewed,
               checks,qualification_ref,completed_at,authorization_ref,scope,
               allowed_environments
        FROM app.content_review_evidence
        WHERE id=ANY($1::text[])
      `, [requestedEvidence]);
      if (allEvidence.rows.length !== requestedEvidence.length) {
        throw new AppError(422, 'INVALID_EVIDENCE_REF', '发布证据引用不存在');
      }
      const selectedRevisions = new Map(
        revisions.rows.map(row => [
          `${row.activity_id}:${row.activity_revision}:${row.content_hash}`,
          row,
        ]),
      );
      if (allEvidence.rows.some(item => (
        item.decision !== 'approved'
        || !selectedRevisions.has(
          `${item.card_id}:${item.revision_number}:${item.content_hash}`,
        )
      ))) {
        throw new AppError(
          422,
          'INVALID_EVIDENCE_REF',
          '发布证据必须通过审读并绑定本次发布的固定正文',
        );
      }
      for (const revision of revisions.rows) {
        const evidence = await client.query<EvidenceRow>(`
          SELECT id,kind,card_id,revision_number,content_hash,actor_id,actor_kind,
                 evidence_created_at,decision,evidence_ref,author_id,self_reviewed,
                 checks,qualification_ref,completed_at,authorization_ref,scope,
                 allowed_environments
          FROM app.content_review_evidence
          WHERE card_id=$1 AND revision_number=$2 AND content_hash=$3
            AND decision='approved'
        `, [revision.activity_id, revision.activity_revision, revision.content_hash]);
        const approved = evidence.rows;
        if (!allEvidence.rows.some(item => evidenceMatchesRevision(item, revision))) {
          throw new AppError(
            422,
            'EVIDENCE_REF_REQUIRED',
            '每条发布活动都必须显式引用绑定该正文的审读证据',
          );
        }
        const editorial = approved.some(item => item.kind === 'editorial_review');
        if (!editorial) {
          throw new AppError(422, 'EDITORIAL_REVIEW_REQUIRED', '每条活动都必须有编辑审读证据');
        }
        if (input.environment === 'public' && !approved.some(item =>
          item.kind === 'editorial_review' && item.self_reviewed === false)) {
          throw new AppError(422, 'INDEPENDENT_REVIEW_REQUIRED', '公开发布需要独立编辑审读');
        }
        if (input.environment === 'public' && !approved.some(item =>
          item.kind === 'expert_review')) {
          throw new AppError(422, 'EXPERT_REVIEW_REQUIRED', '公开发布需要专业审阅证据');
        }
        if (input.environment === 'public' && !approved.some(item =>
          item.kind === 'family_trial' && item.completed_at)) {
          throw new AppError(422, 'FAMILY_TRIAL_REQUIRED', '公开发布需要完成的家庭试玩证据');
        }
        if (revision.content.rights === 'licensed' && !approved.some(item =>
          item.kind === 'rights_license' &&
          item.allowed_environments?.includes(input.environment))) {
          throw new AppError(422, 'RIGHTS_LICENSE_REQUIRED', '授权内容缺少对应发布环境的使用证据');
        }
      }
      const base = await client.query<{
        package_snapshot: ContentPackage;
      }>(`
        SELECT package_snapshot
        FROM app.content_releases
        WHERE package_snapshot IS NOT NULL
        ORDER BY published_at DESC NULLS LAST,version DESC
        LIMIT 1
      `);
      if (!base.rows[0]) {
        throw new AppError(422, 'BASE_PACKAGE_REQUIRED', '发布前需要先导入包含七天模板的内容包');
      }
      const basePackage = base.rows[0].package_snapshot;
      const cards = new Map(basePackage.cards.map(card => [card.id, card]));
      for (const revision of revisions.rows) cards.set(revision.activity_id, revision.content);
      const sourceIds = new Set(revisions.rows.flatMap(row => row.content.sourceIds));
      const sources = await client.query<{
        id: string;
        title: string;
        url: string;
        verified_on: string | Date;
        scope: string;
      }>('SELECT id,title,url,verified_on,scope FROM app.content_sources WHERE id=ANY($1::text[])', [
        [...sourceIds],
      ]);
      const sourceMap = new Map(basePackage.sources.map(source => [source.id, source]));
      for (const source of sources.rows) {
        sourceMap.set(source.id, {
          id: source.id,
          title: source.title,
          url: source.url,
          verifiedOn:
            source.verified_on instanceof Date
              ? source.verified_on.toISOString().slice(0, 10)
              : String(source.verified_on).slice(0, 10),
          scope: source.scope,
        });
      }
      const contentVersionResult = await client.query<{ next: number }>(
        'SELECT COALESCE(MAX(content_version),0)+1 AS next FROM app.content_releases',
      );
      const contentVersion = Number(contentVersionResult.rows[0]!.next);
      const isPublic = input.environment === 'public';
      const packageSnapshot: ContentPackage = {
        ...basePackage,
        contentVersion,
        channel: 'release',
        createdOn: new Date().toISOString().slice(0, 10),
        review: {
          editorial: 'approved',
          expert: isPublic ? 'reviewed' : 'not_reviewed',
          familyTrial: isPublic ? 'completed' : 'not_started',
        },
        sources: [...sourceMap.values()],
        cards: [...cards.values()],
        publicationEnvironment: input.environment,
        evidenceRefs: requestedEvidence,
      };
      const versionResult = await client.query<{ next: number }>(
        'SELECT COALESCE(MAX(version),0)+1 AS next FROM app.content_releases WHERE environment=$1',
        [input.environment],
      );
      const version = Number(versionResult.rows[0]!.next);
      const releaseId = randomUUID();
      const selfReviewed = revisions.rows.every(row =>
        row.author_id === actorUserId,
      );
      await client.query(
        'UPDATE app.content_releases SET active=false WHERE environment=$1 AND active',
        [input.environment],
      );
      const created = await client.query<{
        published_at: Date;
      }>(`
        INSERT INTO app.content_releases(
          id,version,environment,status,package_id,content_version,self_reviewed,
          evidence_refs,created_by,published_at,package_snapshot,active
        ) VALUES($1,$2,$3,'published',$4,$5,$6,$7,$8,now(),$9,true)
        RETURNING published_at
      `, [
        releaseId,
        version,
        input.environment,
        basePackage.packageId,
        contentVersion,
        selfReviewed,
        JSON.stringify(requestedEvidence),
        actorUserId,
        JSON.stringify(packageSnapshot),
      ]);
      for (const revision of revisions.rows) {
        await client.query(`
          INSERT INTO app.content_release_revisions(release_id,activity_revision_id)
          VALUES($1,$2)
        `, [releaseId, revision.id]);
        await client.query(`
          UPDATE app.content_revision_workflow
          SET status='published',updated_at=now()
          WHERE revision_id=$1
        `, [revision.id]);
      }
      return {
        statusCode: 201,
        body: {
          id: releaseId,
          version,
          revisionIds,
          state: 'published' as const,
          selfReviewed,
          publishedAt: created.rows[0]!.published_at.toISOString(),
          environment: input.environment,
          active: true,
          evidenceRefs: requestedEvidence,
        },
      };
    },
  );
}

export async function withdrawContentRelease(
  pool: Pool,
  actorUserId: string,
  releaseId: string,
  input: {
    operationId: string;
    kind: 'editorial' | 'safety';
    reason: string;
  },
): Promise<ReleaseDto> {
  return withContentOperation(
    pool,
    actorUserId,
    input.operationId,
    'content.release.withdraw',
    { releaseId, ...input },
    async client => {
      const release = await client.query<{
        id: string;
        version: number;
        status: 'draft' | 'published' | 'withdrawn';
        self_reviewed: boolean;
        published_at: Date | null;
        environment: 'development' | 'private_trial' | 'public';
        active: boolean;
        evidence_refs: string[];
      }>(`
        SELECT id,version,status,self_reviewed,published_at,environment,active,evidence_refs
        FROM app.content_releases WHERE id=$1 FOR UPDATE
      `, [releaseId]);
      const row = release.rows[0];
      if (!row || row.environment === 'development') throw notFound();
      if (row.status !== 'published') {
        throw new AppError(409, 'RELEASE_NOT_ACTIVE', '当前版本不是可用发布状态');
      }
      await client.query(`
        UPDATE app.content_releases
        SET status='withdrawn',active=false,withdrawn_at=now(),
            withdrawal_kind=$2,withdrawal_reason=$3
        WHERE id=$1
      `, [releaseId, input.kind, input.reason]);
      await client.query(`
        UPDATE app.activity_revisions ar
        SET withdrawn_at=now()
        FROM app.content_release_revisions rr
        WHERE rr.release_id=$1 AND ar.id=rr.activity_revision_id
      `, [releaseId]);
      await client.query(`
        UPDATE app.content_revision_workflow w
        SET status='withdrawn',updated_at=now()
        FROM app.content_release_revisions rr
        WHERE rr.release_id=$1 AND w.revision_id=rr.activity_revision_id
      `, [releaseId]);
      const updated = await client.query<{
        id: string;
        version: number;
        status: 'published' | 'withdrawn';
        self_reviewed: boolean;
        published_at: Date;
        environment: 'private_trial' | 'public';
        active: boolean;
        evidence_refs: string[];
      }>(`
        SELECT id,version,status,self_reviewed,published_at,environment,active,evidence_refs
        FROM app.content_releases WHERE id=$1
      `, [releaseId]);
      return { statusCode: 200, body: await releaseDto(client, updated.rows[0]!) };
    },
  );
}

export async function listContentReleases(
  pool: Pool,
  input: { cursor?: string | undefined; limit?: number | undefined },
): Promise<{ items: ReleaseDto[]; nextCursor: string | null }> {
  const limit = input.limit ?? 50;
  const cursor = input.cursor ? cursorDecode(input.cursor) : null;
  const values: unknown[] = [];
  const where = ["environment IN ('private_trial','public')"];
  if (cursor) {
    values.push(cursor.createdAt, cursor.id);
    where.push(`(created_at,id) < ($${values.length - 1}::timestamptz,$${values.length}::uuid)`);
  }
  values.push(limit + 1);
  const rows = await pool.query<{
    id: string;
    version: number;
    status: 'draft' | 'published' | 'withdrawn';
    self_reviewed: boolean;
    published_at: Date | null;
    environment: 'private_trial' | 'public';
    active: boolean;
    evidence_refs: string[];
    created_at: Date;
  }>(`
    SELECT id,version,status,self_reviewed,published_at,environment,active,
           evidence_refs,created_at
    FROM app.content_releases
    WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC,id DESC
    LIMIT $${values.length}
  `, values);
  const client = await pool.connect();
  try {
    const page = rows.rows.slice(0, limit);
    const items: ReleaseDto[] = [];
    for (const row of page) items.push(await releaseDto(client, row));
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: rows.rows.length > limit && last
        ? cursorEncode({ createdAt: last.created_at.toISOString(), id: last.id })
        : null,
    };
  } finally {
    client.release();
  }
}

export async function getContentRelease(
  pool: Pool,
  releaseId: string,
): Promise<ReleaseDto> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      id: string;
      version: number;
      status: 'draft' | 'published' | 'withdrawn';
      self_reviewed: boolean;
      published_at: Date | null;
      environment: 'development' | 'private_trial' | 'public';
      active: boolean;
      evidence_refs: string[];
    }>(`
      SELECT id,version,status,self_reviewed,published_at,environment,active,evidence_refs
      FROM app.content_releases WHERE id=$1
    `, [releaseId]);
    if (!result.rows[0]) throw notFound();
    return releaseDto(client, result.rows[0]);
  } finally {
    client.release();
  }
}

export async function getContentOptions(
  pool: Pool,
  actorUserId: string,
  environment: 'development' | 'private_trial' | 'public',
  allowFixtureReleaseSelection = false,
): Promise<{
  activities: ContentCard[];
  stageGuides: unknown[];
  sources: unknown[];
  withdrawals: ContentWithdrawal[];
}> {
  void actorUserId;
  const withdrawals = await listContentWithdrawals(pool);
  const preferredEnvironment = allowFixtureReleaseSelection ? null : environment;
  const release = preferredEnvironment
    ? await pool.query<{
        id: string;
        package_snapshot: ContentPackage;
        environment: string;
      }>(`
        SELECT id,package_snapshot,environment
        FROM app.content_releases
        WHERE package_snapshot IS NOT NULL
          AND environment=$1 AND status='published' AND active
        ORDER BY version DESC
        LIMIT 1
      `, [preferredEnvironment])
    : await pool.query<{
        id: string;
        package_snapshot: ContentPackage;
        environment: string;
      }>(`
        SELECT id,package_snapshot,environment
        FROM app.content_releases
        WHERE package_snapshot IS NOT NULL
          AND status='published' AND active
        ORDER BY CASE WHEN active THEN 0 ELSE 1 END,
                 published_at DESC NULLS LAST,version DESC
        LIMIT 1
      `);
  const row = release.rows[0];
  if (!row) return { activities: [], stageGuides: [], sources: [], withdrawals };
  const revisions = await pool.query<{
    activity_id: string;
    content: ContentCard;
    withdrawn_at: Date | null;
  }>(`
    SELECT ar.activity_id,ar.content || jsonb_build_object('reviewState',ar.review_state) AS content,ar.withdrawn_at
    FROM app.content_release_revisions rr
    JOIN app.activity_revisions ar ON ar.id=rr.activity_revision_id
    WHERE rr.release_id=$1
      AND ($2='development' OR (ar.review_state='reviewed' AND NOT ar.test_fixture))
    ORDER BY ar.activity_id,ar.revision DESC
  `, [row.id, row.environment]);
  const latest = new Map<string, ContentCard>();
  const blocked = new Set(withdrawals.map(entry => `${entry.activityId}:${entry.revision}`));
  for (const revision of revisions.rows) {
    if (revision.withdrawn_at || revision.content.withdrawn || blocked.has(`${revision.content.id}:${revision.content.revision}`) || latest.has(revision.activity_id)) continue;
    latest.set(revision.activity_id, {
      ...revision.content,
      withdrawn: false,
    });
  }
  return {
    activities: [...latest.values()],
    stageGuides: row.package_snapshot.stageGuides,
    sources: row.package_snapshot.sources,
    withdrawals,
  };
}

export type ContentWithdrawal = {
  id: string; activityId: string; revision: number; reason: string;
  kind: 'editorial' | 'safety'; effectiveAt: string;
};

export async function listContentWithdrawals(db: Pool | PoolClient): Promise<ContentWithdrawal[]> {
  const { rows } = await db.query<{
    id: string; activity_id: string; revision: number; withdrawn_at: Date;
    withdrawal_reason: string | null; withdrawal_kind: 'editorial' | 'safety' | null;
  }>(`
    SELECT DISTINCT ON (ar.id) ar.id,ar.activity_id,ar.revision,ar.withdrawn_at,
           cr.withdrawal_reason,cr.withdrawal_kind
    FROM app.activity_revisions ar
    LEFT JOIN app.content_release_revisions rr ON rr.activity_revision_id=ar.id
    LEFT JOIN app.content_releases cr ON cr.id=rr.release_id AND cr.status='withdrawn'
    WHERE ar.withdrawn_at IS NOT NULL
    ORDER BY ar.id,cr.withdrawn_at DESC NULLS LAST
  `);
  return rows.map(row => ({
    id: row.id, activityId: row.activity_id, revision: Number(row.revision),
    effectiveAt: row.withdrawn_at.toISOString(),
    kind: row.withdrawal_kind ?? 'safety',
    reason: row.withdrawal_reason ?? '这项玩法已停止推荐。',
  }));
}
