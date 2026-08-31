import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const mode = process.env.KODEX_SMOKE_SERVICE;
const port = Number(mode === 'local-server' ? process.env.KODEX_SERVER_PORT : process.env.PRODUCT_API_PORT);
const host = '127.0.0.1';
const uiOrigin = process.env.KODEX_UI_ORIGINS;
const productOrigin = process.env.KODEX_PRODUCT_API_ORIGINS;
const uiRoot = process.env.KODEX_UI_ROOT;

if (!['product-api', 'local-server', 'hanging'].includes(mode) || !Number.isSafeInteger(port) || port <= 0) {
  throw new Error('Desktop smoke service configuration is invalid.');
}

function type(filename) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.svg') return 'image/svg+xml';
  if (extension === '.png') return 'image/png';
  if (extension === '.woff2') return 'font/woff2';
  return 'application/octet-stream';
}

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  if (request.headers.host !== `${host}:${port}`) {
    json(response, 403, { ok: false });
    return;
  }
  if (uiOrigin && request.headers.origin === uiOrigin) {
    response.setHeader('Access-Control-Allow-Origin', uiOrigin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  const url = new URL(request.url ?? '/', `http://${host}:${port}`);
  if (mode === 'hanging') return;
  if (mode === 'product-api') {
    if (request.method === 'GET' && ['/api/health/live', '/api/health/ready'].includes(url.pathname)) {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      json(response, 401, { ok: false, error: { code: 'unauthenticated', message: 'Authentication is required.' } });
      return;
    }
    json(response, 404, { ok: false });
    return;
  }

  if (url.pathname === '/api/health' && request.method === 'GET') {
    json(response, 200, { ok: true });
    return;
  }
  if (!uiRoot || !['GET', 'HEAD'].includes(request.method ?? 'GET')) {
    json(response, 404, { ok: false });
    return;
  }
  const root = path.resolve(uiRoot);
  let relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  let filename = path.resolve(root, relative);
  if (path.relative(root, filename).startsWith('..')) {
    json(response, 404, { ok: false });
    return;
  }
  try {
    if (!(await stat(filename)).isFile()) throw new Error('not a file');
  } catch {
    relative = 'index.html';
    filename = path.join(root, relative);
  }
  let contents = await readFile(filename);
  if (relative === 'index.html') {
    contents = Buffer.from(contents.toString('utf8').replace(
      '</head>',
      `<meta name="kodex-product-api-origin" content="${productOrigin}"></head>`,
    ));
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', type(filename));
  response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss: ${productOrigin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
  response.end(request.method === 'HEAD' ? undefined : contents);
});

server.listen(port, host);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
process.on('message', (message) => {
  if (message?.type === 'kodex-shutdown') server.close(() => process.exit(0));
});
process.once('disconnect', () => server.close(() => process.exit(0)));
