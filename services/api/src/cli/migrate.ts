import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';

async function main(): Promise<void> {
  const pool = createPool(loadConfig());
  try {
    const applied = await migrate(pool);
    process.stdout.write(JSON.stringify({ event: 'migrations_complete', applied }) + '\n');
  } finally { await pool.end(); }
}

main().catch(() => {
  // 数据库异常可能含 SQL 参数，命令行只返回可定位的事件，不输出原始连接配置。
  process.stderr.write('迁移失败；请检查本机配置和迁移文件。\n');
  process.exitCode = 1;
});
