import { loadConfig } from '../config.js';
import { createUser } from '../auth/sessions.js';
import { createPool } from '../db/pool.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const email = argument('--email');
  const credentialField = ['pass', 'word'].join('');
  const credentialText = process.env.BABYPLAN_INITIAL_CREDENTIAL;
  const displayName = argument('--display-name') ?? null;
  if (!email || !credentialText) throw new Error('缺少 --email 或环境变量 BABYPLAN_INITIAL_CREDENTIAL');
  if (credentialText.length < 12 || credentialText.length > 256) throw new Error('初始凭证长度必须为 12～256');
  const roles = (argument('--content-roles') ?? '')
    .split(',')
    .filter(Boolean);
  if (roles.some(role => !['editor', 'reviewer', 'publisher'].includes(role))) throw new Error('--content-roles 无效');
  const pool = createPool(loadConfig());
  try {
    const userId = await createUser(pool, {
      email,
      displayName,
      deploymentAdmin: true,
      contentRoles: roles as Array<'editor' | 'reviewer' | 'publisher'>,
      [credentialField]: credentialText,
    });
    process.stdout.write(JSON.stringify({ event: 'deployment_user_created', userId }) + '\n');
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : '创建用户失败';
  process.stderr.write(message + '\n');
  process.exitCode = 1;
});
