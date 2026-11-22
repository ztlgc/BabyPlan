import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { extname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4174;
const DEFAULT_API_TARGET = 'http://127.0.0.1:4318';
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
]);

export function parseArguments(argv, environment = process.env) {
  const configuredPort = environment.WEB_PORT?.trim();
  let host = environment.WEB_HOST?.trim() || DEFAULT_HOST;
  let port = configuredPort ? Number(configuredPort) : DEFAULT_PORT;
  let apiTarget = environment.BABYPLAN_API_TARGET ?? DEFAULT_API_TARGET;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--host' && argv[index + 1]) {
      host = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--port' && argv[index + 1]) {
      port = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (argument === '--api' && argv[index + 1]) {
      apiTarget = argv[index + 1];
      index += 1;
    }
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('端口必须是 0～65535 之间的整数');
  }

  let parsedApiTarget;
  try {
    parsedApiTarget = new URL(apiTarget);
  } catch {
    throw new Error('API 目标地址格式无效');
  }
  if (!['http:', 'https:'].includes(parsedApiTarget.protocol)
      || parsedApiTarget.username
      || parsedApiTarget.password
      || parsedApiTarget.search
      || parsedApiTarget.hash) {
    throw new Error('API 目标必须是安全的 HTTP/HTTPS 地址');
  }

  return { host, port, apiTarget: parsedApiTarget.toString().replace(/\/+$/, '') };
}

function applySecurityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "connect-src 'self' http: https:",
    "img-src 'self' data:",
    "script-src 'self'",
    "style-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '));
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function sendText(response, statusCode, text) {
  applySecurityHeaders(response);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end(text);
}

function proxyApiRequest(request, response, requestUrl, apiTarget) {
  const target = new URL(apiTarget);
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers = { ...request.headers };
  headers.host = target.host;
  // 页面和 API 在本地使用不同端口；代理转换来源，使 API 的严格同源校验仍生效。
  headers.origin = target.origin;
  delete headers.connection;

  const upstream = transport({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: request.method,
    path: `${target.pathname.replace(/\/+$/, '')}${requestUrl.pathname}${requestUrl.search}`,
    headers,
  }, upstreamResponse => {
    response.statusCode = upstreamResponse.statusCode ?? 502;
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (value !== undefined && !['connection', 'transfer-encoding'].includes(name.toLowerCase())) {
        response.setHeader(name, value);
      }
    }
    response.setHeader('Cache-Control', response.getHeader('Cache-Control') ?? 'no-store');
    upstreamResponse.pipe(response);
  });

  upstream.on('error', () => {
    if (!response.headersSent) {
      sendText(response, 502, '家庭服务暂时不可达');
    } else {
      response.destroy();
    }
  });
  request.pipe(upstream);
}

export function createWebServer({
  publicDirectory = new URL('./public/', import.meta.url),
  apiTarget = DEFAULT_API_TARGET,
} = {}) {
  const rootDirectory = publicDirectory instanceof URL
    ? fileURLToPath(publicDirectory)
    : publicDirectory;

  return createServer(async (request, response) => {
    let pathname;
    let requestUrl;
    try {
      requestUrl = new URL(request.url ?? '/', 'http://localhost');
      pathname = decodeURIComponent(requestUrl.pathname);
    } catch {
      sendText(response, 400, '请求地址无效');
      return;
    }

    if (requestUrl.pathname === '/v2' || requestUrl.pathname.startsWith('/v2/')) {
      proxyApiRequest(request, response, requestUrl, apiTarget);
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      sendText(response, 405, '不支持的请求方法');
      return;
    }

    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const resolvedPath = normalize(join(rootDirectory, relativePath));
    const pathFromRoot = relative(rootDirectory, resolvedPath);

    if (pathFromRoot.startsWith('..') || pathFromRoot.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      sendText(response, 404, '页面不存在');
      return;
    }

    try {
      const fileInfo = await stat(resolvedPath);
      if (!fileInfo.isFile()) {
        sendText(response, 404, '页面不存在');
        return;
      }

      applySecurityHeaders(response);
      response.statusCode = 200;
      response.setHeader('Content-Length', fileInfo.size);
      response.setHeader('Content-Type', MIME_TYPES.get(extname(resolvedPath).toLowerCase()) ?? 'application/octet-stream');

      if (request.method === 'HEAD') {
        response.end();
        return;
      }

      createReadStream(resolvedPath).pipe(response);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        sendText(response, 404, '页面不存在');
        return;
      }
      console.error('静态文件读取失败', error);
      sendText(response, 500, '页面暂时无法打开');
    }
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);

if (isDirectRun) {
  const { host, port, apiTarget } = parseArguments(process.argv.slice(2));
  const server = createWebServer({ apiTarget });
  server.listen(port, host, () => {
    console.log(`BabyPlan 家长网页已启动：http://${host}:${port}`);
    console.log(`同源 /v2 请求将代理到：${apiTarget}`);
  });
}
