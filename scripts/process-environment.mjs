const PRIVATE_UI_KEYS = [
  'AUTH_COOKIE_SECRET',
  'DATABASE_URL',
  'KODEX_LOCAL_LLM_API_KEY',
  'OPENAI_API_KEY',
  'PRODUCT_DB_PASSWORD',
];
const PUBLIC_VITE_KEYS = new Set([
  'VITE_KODEX_API_URL',
  'VITE_PRODUCT_API_URL',
]);

export function createUiEnvironment(environment = process.env, port = '47831') {
  const output = {
    ...environment,
    KODEX_SERVER_PORT: port,
    KODEX_UI_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173',
    VITE_KODEX_API_URL: `http://127.0.0.1:${port}`,
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

export function createServerEnvironment(environment = process.env, mode = 'dev', port = '47831') {
  const originPort = mode === 'dev' ? '5173' : port;
  return {
    ...environment,
    KODEX_SERVER_PORT: port,
    KODEX_SERVE_UI: mode === 'start' ? '1' : '0',
    KODEX_UI_ORIGINS: `http://127.0.0.1:${originPort},http://localhost:${originPort}`,
  };
}
