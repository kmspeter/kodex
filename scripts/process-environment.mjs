const PRIVATE_PROVIDER_KEYS = ['OPENAI_API_KEY', 'KODEX_LOCAL_LLM_API_KEY'];

export function createUiEnvironment(environment = process.env, port = '47831') {
  const output = {
    ...environment,
    KODEX_SERVER_PORT: port,
    KODEX_UI_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173',
    VITE_KODEX_API_URL: `http://127.0.0.1:${port}`,
  };
  for (const key of Object.keys(output)) {
    if (PRIVATE_PROVIDER_KEYS.includes(key.toLocaleUpperCase())) delete output[key];
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
