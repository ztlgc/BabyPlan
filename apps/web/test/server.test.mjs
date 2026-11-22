import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { createWebServer, parseArguments } from '../server.mjs';

test('网页监听配置从环境变量读取且命令行参数优先', () => {
  assert.deepEqual(
    parseArguments([], {
      WEB_HOST: '0.0.0.0',
      WEB_PORT: '4175',
      BABYPLAN_API_TARGET: 'http://api:4318',
    }),
    {
      host: '0.0.0.0',
      port: 4175,
      apiTarget: 'http://api:4318',
    },
  );
  assert.deepEqual(
    parseArguments(
      ['--host', '127.0.0.1', '--port', '4176'],
      { WEB_HOST: '0.0.0.0', WEB_PORT: '4175' },
    ),
    {
      host: '127.0.0.1',
      port: 4176,
      apiTarget: 'http://127.0.0.1:4318',
    },
  );
});

test('静态服务器可启动并返回安全的家长网页入口', async (context) => {
  const server = createWebServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  const html = await response.text();
  const icon = await fetch(`http://127.0.0.1:${address.port}/babyplan-icon.png`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(html, /BabyPlan/);
  assert.match(html, /家长网页/);
  assert.match(html, /id="signup-form"/);
  assert.match(html, /id="signup-code"/);
  assert.match(html, /rel="icon" href="\/babyplan-icon\.png" type="image\/png"/);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.ok((await icon.arrayBuffer()).byteLength > 1_000);
});

test('静态服务器拒绝目录穿越且不泄露包文件', async (context) => {
  const server = createWebServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/%2e%2e/package.json`);
  assert.equal(response.status, 404);
});

test('前端源码不使用 innerHTML 插入动态内容', async () => {
  const sources = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/lib/api.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/lib/growth.js', import.meta.url), 'utf8'),
  ]);
  sources.forEach((source) => assert.doesNotMatch(source, /\.innerHTML\s*=/));
  assert.doesNotMatch(sources[0], /localStorage\.setItem\([^)]*(token|Token)/);
});

test('页面声明窄屏适配与 A4 打印样式', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /name="viewport"/);
  assert.match(html, /id="view-growth"/);
  assert.match(html, /id="growth-print-button"/);
  assert.match(html, /id="view-content"/);
  assert.match(html, /id="content-nav"/);
  assert.match(html, /id="content-revisions"/);
  assert.match(html, /id="member-management"/);
  assert.match(html, /id="child-settings"/);
  assert.match(html, /id="invitation-actions"/);
  assert.match(html, /id="danger-zone"/);
  assert.match(html, /id="privacy-actions"/);
  assert.match(html, /id="content-creator"/);
  assert.match(html, /id="export-form"/);
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(css, /@media \(max-width: 420px\)/);
  assert.match(css, /min-width:\s*0;/);
  assert.match(css, /max-width:\s*100%;/);
  assert.match(css, /@page\s*\{/);
  assert.match(css, /size:\s*A4 portrait/);
  assert.match(css, /@media print/);
  assert.match(css, /\.print-growth-section/);
});

test('成长回收站同时接入小记、测量和阶段观察的恢复链路', async () => {
  const [html, app, api] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/lib/api.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /最近删除的成长记录/);
  assert.match(api, /listDeletedMeasurements/);
  assert.match(api, /listDeletedObservations/);
  assert.match(api, /restoreMeasurement/);
  assert.match(api, /restoreObservation/);
  assert.match(app, /readDeletedGrowthKind/);
  assert.match(app, /更多\$\{GROWTH_TRASH_KIND_LABELS\[kind\]\}/);
  assert.match(app, /恢复这条\$\{GROWTH_TRASH_KIND_LABELS\[kind\]\}/);
});

test('家庭管理和内容审阅表单使用唯一控件标识与显式证据选择', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /evidence-kind-\$\{suffix\}/);
  assert.match(source, /review-decision-\$\{suffix\}/);
  assert.match(source, /review-note-\$\{suffix\}/);
  assert.match(source, /const evidenceCheckboxes = \[\]/);
  assert.match(source, /evidenceCheckboxes\.filter/);
  assert.doesNotMatch(source, /fieldset:nth-of-type/);
  assert.doesNotMatch(source, /selectInput\(['"]evidence-kind['"]/);
  assert.match(source, /confirmDiscardDirtyForm\(\)/);
  assert.match(source, /confirmDiscardOtherDirtyForms/);
  assert.match(source, /正文已经保存，但照片没有完成/);
  assert.match(source, /同一条正文重试照片/);
});

test('同源 /v2 请求被安全转发到真实 API', async (context) => {
  const api = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      response.statusCode = 201;
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Set-Cookie', 'bp_session=test; Path=/v2; HttpOnly');
      response.end(JSON.stringify({
        method: request.method,
        path: request.url,
        host: request.headers.host,
        origin: request.headers.origin,
        cookie: request.headers.cookie,
        body,
      }));
    });
  });
  await new Promise((resolve, reject) => {
    api.once('error', reject);
    api.listen(0, '127.0.0.1', resolve);
  });
  const address = api.address();
  const apiTarget = `http://127.0.0.1:${address.port}`;
  const web = createWebServer({ apiTarget });
  await new Promise((resolve, reject) => {
    web.once('error', reject);
    web.listen(0, '127.0.0.1', resolve);
  });
  context.after(async () => {
    await new Promise((resolve) => web.close(resolve));
    await new Promise((resolve) => api.close(resolve));
  });

  const webAddress = web.address();
  const response = await fetch(`http://127.0.0.1:${webAddress.port}/v2/families?x=1`, {
    method: 'POST',
    headers: {
      Cookie: 'bp_session=existing',
      'Content-Type': 'application/json',
    },
    body: '{"name":"测试"}',
  });
  assert.equal(response.status, 201);
  assert.match(
    response.headers.get('set-cookie'),
    new RegExp('bp_' + 'session=test'),
  );
  const payload = await response.json();
  assert.equal(payload.method, 'POST');
  assert.equal(payload.path, '/v2/families?x=1');
  assert.equal(payload.host, new URL(apiTarget).host);
  assert.equal(payload.origin, apiTarget);
  assert.equal(payload.cookie, 'bp_session=existing');
  assert.equal(payload.body, '{"name":"测试"}');
});
