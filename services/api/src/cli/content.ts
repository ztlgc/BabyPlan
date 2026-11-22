import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { importContentPackage, publishContentRelease, readContentPackage } from '../content/package.js';
import { createPool } from '../db/pool.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const pool = createPool(loadConfig());
  try {
    if (command === 'import') {
      const path = argument('--file');
      if (!path) throw new Error('缺少 --file');
      const environment = argument('--environment') ?? 'development';
      if (!['development', 'private_trial', 'public'].includes(environment)) throw new Error('--environment 无效');
      const content = await readContentPackage(resolve(path));
      const createdBy = argument('--created-by') ?? null;
      const result = await importContentPackage(pool, content, environment as 'development' | 'private_trial' | 'public', createdBy);
      process.stdout.write(JSON.stringify({ event: 'content_imported', ...result }) + '\n');
      return;
    }
    if (command === 'publish') {
      const releaseId = argument('--release-id');
      if (!releaseId) throw new Error('缺少 --release-id');
      const result = await publishContentRelease(pool, releaseId);
      process.stdout.write(JSON.stringify({ event: 'content_published', ...result }) + '\n');
      return;
    }
    throw new Error('命令必须是 import 或 publish');
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : '命令执行失败';
  process.stderr.write(message + '\n');
  process.exitCode = 1;
});
