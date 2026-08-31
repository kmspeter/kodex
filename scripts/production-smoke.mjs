import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  startRuntimeChild,
  stopRuntimeChildren,
  unusedLoopbackPort,
  waitForReady,
} from '../apps/desktop/runtime-processes.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(repositoryRoot, 'apps', 'desktop', 'smoke-service.mjs');

const localPort = await unusedLoopbackPort();
const productPort = await unusedLoopbackPort();
const localOrigin = `http://127.0.0.1:${localPort}`;
const productOrigin = `http://127.0.0.1:${productPort}`;
const common = {
  KODEX_UI_ROOT: path.join(repositoryRoot, 'apps', 'ui', 'dist'),
  KODEX_UI_ORIGINS: localOrigin,
  KODEX_PRODUCT_API_ORIGINS: productOrigin,
  KODEX_SERVER_PORT: String(localPort),
  PRODUCT_API_PORT: String(productPort),
};
const children = [];
const product = startRuntimeChild('Product API smoke fixture', process.execPath, fixture, {
  cwd: repositoryRoot,
  env: { ...common, KODEX_SMOKE_SERVICE: 'product-api' },
});
children.push(product);
let local;

try {
  await waitForReady(product, `${productOrigin}/api/health/ready`, 'Product API');
  local = startRuntimeChild('Local Server smoke fixture', process.execPath, fixture, {
    cwd: repositoryRoot,
    env: { ...common, KODEX_SMOKE_SERVICE: 'local-server' },
  });
  children.push(local);
  await waitForReady(local, `${localOrigin}/api/health`, 'Local Server');
  const page = await fetch(localOrigin);
  const html = await page.text();
  if (!page.ok || !html.includes(`<meta name="kodex-product-api-origin" content="${productOrigin}">`)) {
    throw new Error('Built UI did not receive the exact runtime Product API origin.');
  }
  const session = await fetch(`${productOrigin}/api/auth/me`, { headers: { Origin: localOrigin } });
  if (session.status !== 401 || (await session.json()).error?.code !== 'unauthenticated') {
    throw new Error('Product API smoke fixture did not expose the login-state contract.');
  }
  process.stdout.write('Kodex production smoke passed: Product API ready -> Local Server ready -> runtime-configured login state.\n');
} finally {
  await stopRuntimeChildren(children);
}
