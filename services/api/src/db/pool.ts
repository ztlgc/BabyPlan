import pg from 'pg';
import type { AppConfig } from '../config.js';

export function createPool(config: AppConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
    application_name: 'babyplan-api',
    statement_timeout: 10_000,
  });
}
