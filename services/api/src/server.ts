import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  const app = buildApp(config, pool);
  pool.on('error', () => app.log.error({ event: 'database_idle_connection_error' }));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await pool.end();
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  try { await app.listen({ host: config.host, port: config.port }); }
  catch (error) { await stop(); throw error; }
}

main().catch(error => {
  // 配置错误由受控文本产生，不回显 URL；运行错误避免泄露驱动参数。
  const message = error instanceof Error && /^(配置|缺少配置)/.test(error.message) ? error.message : 'API 启动失败，请检查运行环境';
  process.stderr.write(message + '\n');
  process.exitCode = 1;
});
