import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type AppConfig = {
  environment: 'development' | 'test' | 'production';
  host: string;
  port: number;
  publicBaseUrl: string;
  databaseUrl: string;
  poolMax: number;
  mediaRoot: string;
  recoveryOutboxRoot: string;
  deletionJournalRoot: string | null;
  contentEnvironment: 'development' | 'private_trial' | 'public';
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
};

function integer(value: string | undefined, fallback: number, min: number, max: number, key: string): number {
  if (value !== undefined && !/^\d+$/.test(value)) throw new Error(`配置 ${key} 必须是整数`);
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`配置 ${key} 超出允许范围`);
  return result;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const environment = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(environment)) throw new Error('配置 NODE_ENV 不支持');
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('缺少配置 DATABASE_URL');
  let parsed: URL;
  try { parsed = new URL(databaseUrl); } catch { throw new Error('配置 DATABASE_URL 格式无效'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.username || !parsed.password || parsed.pathname.length < 2) {
    throw new Error('配置 DATABASE_URL 需要 PostgreSQL 地址、数据库及凭证');
  }
  const host = env.API_HOST ?? '127.0.0.1';
  if (!host || /[\s/]/.test(host)) throw new Error('配置 API_HOST 无效');
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['silent', 'error', 'warn', 'info', 'debug'].includes(logLevel)) throw new Error('配置 LOG_LEVEL 不支持');
  const port = integer(env.API_PORT, 4318, 1, 65535, 'API_PORT');
  const publicBaseUrl = env.PUBLIC_BASE_URL ?? `http://${host}:${port}`;
  let publicUrl: URL;
  try { publicUrl = new URL(publicBaseUrl); } catch { throw new Error('配置 PUBLIC_BASE_URL 格式无效'); }
  if (!['http:', 'https:'].includes(publicUrl.protocol) || !publicUrl.hostname || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
    throw new Error('配置 PUBLIC_BASE_URL 需要不含凭证、查询或片段的 HTTP(S) 地址');
  }
  const mediaRoot = env.MEDIA_ROOT ?? '.work/media';
  if (!mediaRoot.trim()) throw new Error('配置 MEDIA_ROOT 不能为空');
  if (environment === 'production' && !env.RECOVERY_OUTBOX_ROOT) {
    throw new Error('生产环境缺少配置 RECOVERY_OUTBOX_ROOT');
  }
  const recoveryOutboxRoot = env.RECOVERY_OUTBOX_ROOT ?? '.work/account-recovery-outbox';
  if (!recoveryOutboxRoot.trim()) throw new Error('配置 RECOVERY_OUTBOX_ROOT 不能为空');
  const journal = env.DELETION_JOURNAL_ROOT
    ?? (environment === 'test' ? null : join(dirname(recoveryOutboxRoot), 'deletion-journal'));
  if (journal !== null && (!journal.trim() ||
    [mediaRoot, recoveryOutboxRoot, env.BACKUP_ROOT, env.RESTORE_ROOT, env.WEB_ROOT]
      .filter((path): path is string => Boolean(path))
      .some(path => containsPath(journal, path) || containsPath(path, journal)))) {
    throw new Error('配置 DELETION_JOURNAL_ROOT 必须是独立的私有目录');
  }
  const contentEnvironment = env.CONTENT_ENVIRONMENT ?? (environment === 'production' ? 'public' : 'development');
  if (contentEnvironment !== 'public' && contentEnvironment !== 'private_trial' && contentEnvironment !== 'development') {
    throw new Error('配置 CONTENT_ENVIRONMENT 无效');
  }
  if (environment === 'production' && contentEnvironment === 'development') {
    throw new Error('配置 CONTENT_ENVIRONMENT 不能让生产环境读取开发内容');
  }
  return {
    environment: environment as AppConfig['environment'],
    host,
    port,
    publicBaseUrl: publicUrl.toString().replace(/\/$/, ''),
    databaseUrl,
    poolMax: integer(env.DB_POOL_MAX, 8, 1, 30, 'DB_POOL_MAX'),
    mediaRoot,
    recoveryOutboxRoot,
    deletionJournalRoot: journal === null ? null : resolve(journal),
    contentEnvironment,
    logLevel: logLevel as AppConfig['logLevel'],
  };
}

function containsPath(parent: string, path: string): boolean {
  const delta = relative(resolve(parent), resolve(path));
  return delta === '' || (!isAbsolute(delta) && delta.split(/[\\/]/)[0] !== '..');
}
