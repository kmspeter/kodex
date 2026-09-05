const PRIVATE_UI_KEYS = [
  'AUTH_COOKIE_SECRET',
  'AUTH_PASSWORD_RESET_DELIVERY_BEARER_TOKEN',
  'DATABASE_URL',
  'KODEX_LOCAL_LLM_API_KEY',
  'KODEX_OPERATIONS_BEARER_TOKEN',
  'OPENAI_API_KEY',
  'PRODUCT_DB_PASSWORD',
  'PRODUCT_DB_ADMIN_PASSWORD',
  'PRODUCT_DB_APP_PASSWORD',
  'PRODUCT_DB_MIGRATION_PASSWORD',
  'PRODUCT_DB_MIGRATION_URL',
  'PRODUCT_OPERATIONS_BEARER_TOKEN',
];
const PUBLIC_VITE_KEYS = new Set([
  'VITE_KODEX_API_URL',
  'VITE_PRODUCT_API_URL',
]);

export function createUiEnvironment(environment = process.env, port = '47831', productApiPort = '47832') {
  const output = {
    ...environment,
    KODEX_SERVER_PORT: port,
    KODEX_UI_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173',
    VITE_KODEX_API_URL: `http://127.0.0.1:${port}`,
    VITE_PRODUCT_API_URL: environment.VITE_PRODUCT_API_URL || `http://127.0.0.1:${productApiPort}`,
  };
  for (const key of Object.keys(output)) {
    if (
      PRIVATE_UI_KEYS.includes(key.toLocaleUpperCase())
      || (/^VITE_/iu.test(key) && !PUBLIC_VITE_KEYS.has(key))
    ) {
      delete output[key];
    }
  }
  return output;
}

export function createServerEnvironment(environment = process.env, mode = 'dev', port = '47831', productApiPort = '47832') {
  const originPort = mode === 'dev' ? '5173' : port;
  return {
    ...environment,
    KODEX_SERVER_PORT: port,
    KODEX_SERVE_UI: mode === 'start' ? '1' : '0',
    KODEX_UI_ORIGINS: `http://127.0.0.1:${originPort},http://localhost:${originPort}`,
    KODEX_PRODUCT_API_ORIGINS: environment.KODEX_PRODUCT_API_ORIGINS
      || `http://127.0.0.1:${productApiPort},http://localhost:${productApiPort}`,
  };
}

export function createProductApiEnvironment(environment = process.env, mode = 'dev', port = '47832', localServerPort = '47831') {
  const uiPort = mode === 'dev' ? '5173' : localServerPort;
  return {
    ...environment,
    PRODUCT_API_HOST: '127.0.0.1',
    PRODUCT_API_PORT: port,
    PRODUCT_API_ALLOWED_HOSTS: `127.0.0.1:${port},localhost:${port}`,
    AUTH_ALLOWED_ORIGINS: `http://127.0.0.1:${uiPort},http://localhost:${uiPort}`,
  };
}
