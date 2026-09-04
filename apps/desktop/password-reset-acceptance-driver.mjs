import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { Client } from 'pg';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const fetchRequest = globalThis.fetch.bind(globalThis);

function acceptanceInput(options) {
  for (const [name, value] of Object.entries(options)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Desktop password reset acceptance is missing ${name}.`);
    }
  }
  const local = new URL(options.localOrigin);
  const product = new URL(options.productOrigin);
  const probe = new URL(options.deliveryProbeUrl);
  const database = new URL(options.databaseUrl);
  for (const url of [local, product, probe]) {
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
      throw new Error('Desktop password reset acceptance services must use loopback HTTP.');
    }
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)
    || !['127.0.0.1', 'localhost'].includes(database.hostname)) {
    throw new Error('Desktop password reset database must be a loopback PostgreSQL fixture.');
  }
  return {
    ...options,
    deliveryProbeUrl: probe.toString(),
    localOrigin: local.origin,
    productOrigin: product.origin,
  };
}

async function writeFailureArtifacts(window, artifactDirectory) {
  if (typeof artifactDirectory !== 'string' || !path.isAbsolute(artifactDirectory)) return;
  await mkdir(artifactDirectory, { recursive: true });
  const styleId = 'kodex-password-reset-acceptance-redaction';
  const installed = await window.webContents.executeJavaScript(`(() => {
    const style = document.createElement('style');
    style.id = ${JSON.stringify(styleId)};
    style.textContent = 'body *{color:transparent!important;text-shadow:none!important;-webkit-text-fill-color:transparent!important}';
    document.head.append(style);
    return true;
  })()`).catch(() => false);
  if (installed === true) {
    await window.webContents.capturePage().then((image) => writeFile(
      path.join(artifactDirectory, 'password-reset-renderer-failure.png'), image.toPNG(),
    )).catch(() => undefined);
  }
  const structure = await window.webContents.executeJavaScript(`(() => ({
    origin: location.origin,
    hashPresent: location.hash.length > 0,
    headings: [...document.querySelectorAll('h1,h2,h3')].map((node) => node.textContent?.trim()).filter(Boolean),
    controls: [...document.querySelectorAll('input,button')].map((node) => ({
      tag: node.tagName.toLowerCase(), name: node.getAttribute('name'), type: node.getAttribute('type'),
      disabled: node.hasAttribute('disabled'),
    })),
  }))()`);
  await writeFile(path.join(artifactDirectory, 'password-reset-renderer-structure.json'), `${JSON.stringify(structure, null, 2)}\n`);
  if (installed === true) {
    await window.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(styleId)})?.remove()`)
      .catch(() => undefined);
  }
}

const DOM_HELPERS = `
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const normalized = (value) => String(value ?? '').replace(/\\s+/gu, ' ').trim();
  async function waitFor(read, description, milliseconds = 30_000) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value;
      await delay(50);
    }
    throw new Error('Timed out waiting for ' + description + '.');
  }
  function buttonByText(text, root = document) {
    return [...root.querySelectorAll('button')].find((button) => normalized(button.textContent) === text);
  }
  function inputByLabel(text, root = document) {
    const label = [...root.querySelectorAll('label')]
      .find((candidate) => normalized(candidate.childNodes[0]?.textContent).startsWith(text));
    return label?.querySelector('input') ?? null;
  }
  function setValue(control, value) {
    if (!control) throw new Error('The expected renderer input is unavailable.');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('The renderer input has no native value setter.');
    setter.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function click(control) {
    if (!control || control.disabled) throw new Error('The expected renderer control is unavailable.');
    control.focus();
    control.click();
  }
`;

async function registerLogoutAndRequest(window, input) {
  return window.webContents.executeJavaScript(`(async (input) => {
    ${DOM_HELPERS}
    await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex에 로그인', 'login shell');
    click([...document.querySelectorAll('[role="tab"]')].find((button) => normalized(button.textContent) === '회원가입'));
    await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex 계정 만들기', 'registration form');
    setValue(inputByLabel('표시 이름'), input.displayName);
    setValue(inputByLabel('이메일'), input.email);
    setValue(inputByLabel('비밀번호'), input.oldPassword);
    click(buttonByText('계정 만들기'));
    await waitFor(() => document.querySelector('.app-shell'), 'authenticated shell', 60_000);
    click(await waitFor(() => document.querySelector('.account-button'), 'account menu'));
    const popover = await waitFor(() => document.querySelector('.account-popover'), 'account popover');
    click(buttonByText('로그아웃', popover));
    await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex에 로그인', 'post-logout login');
    click(buttonByText('비밀번호를 잊으셨나요?'));
    await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === '비밀번호 재설정', 'recovery form');
    setValue(inputByLabel('이메일'), input.email);
    click(buttonByText('재설정 안내 보내기'));
    const notice = await waitFor(() => document.querySelector('[role="status"]'), 'generic recovery confirmation');
    const text = normalized(notice.textContent);
    if (text !== '계정이 존재하면 비밀번호 재설정 안내를 보냈습니다. 이메일을 확인하세요.' || text.includes(input.email)) {
      throw new Error('The recovery confirmation was not generic.');
    }
    return true;
  })(${JSON.stringify(input)})`);
}

async function fetchResetUrl(options) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetchRequest(options.deliveryProbeUrl, {
      headers: { 'X-Acceptance-Probe': options.deliveryProbeBearer },
    });
    if (response.status === 200) {
      const body = await response.json();
      if (typeof body?.resetUrl === 'string') return body.resetUrl;
      throw new Error('The delivery fixture returned a malformed probe response.');
    }
    if (response.status !== 404) throw new Error('The delivery fixture rejected its private probe.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the password reset delivery fixture.');
}

function parseResetUrl(value, localOrigin) {
  const url = new URL(value);
  const prefix = '#password-reset=';
  if (url.origin !== localOrigin || url.pathname !== '/' || url.search || !url.hash.startsWith(prefix)) {
    throw new Error('The delivered reset URL did not use the exact desktop fragment origin.');
  }
  const token = url.hash.slice(prefix.length);
  if (!TOKEN_PATTERN.test(token)) throw new Error('The delivered password reset token was not canonical.');
  return token;
}

async function createSecondarySession(options) {
  const response = await fetchRequest(`${options.productOrigin}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: options.localOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: options.email, password: options.oldPassword }),
  });
  if (response.status !== 200) throw new Error('The secondary pre-reset session could not be created.');
  const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
  const setCookies = getSetCookie ? getSetCookie() : [response.headers.get('set-cookie')].filter(Boolean);
  const cookie = setCookies.map((entry) => entry.split(';', 1)[0]).join('; ');
  if (!cookie.includes('kodex_product_session=')) throw new Error('The secondary session cookie was missing.');
  return cookie;
}

async function enterResetFragment(window, localOrigin, token) {
  await window.webContents.executeJavaScript(`history.replaceState(history.state, '', ${JSON.stringify(`/#password-reset=${token}`)}); true`);
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.webContents.removeListener('did-finish-load', loaded);
      window.webContents.removeListener('did-fail-load', failed);
      if (error) reject(error); else resolve();
    };
    const loaded = () => finish();
    const failed = () => finish(new Error('The password reset fragment reload failed.'));
    const timer = setTimeout(() => finish(new Error('The password reset fragment reload timed out.')), 30_000);
    window.webContents.once('did-finish-load', loaded);
    window.webContents.once('did-fail-load', failed);
    window.webContents.reload();
  });
  const current = window.webContents.getURL();
  if (!current.startsWith(`${localOrigin}/`) || current.includes(token) || new URL(current).hash) {
    throw new Error('The renderer did not erase the password reset fragment at startup.');
  }
}

async function assertNoTokenPersistence(window, token, localOrigin, productOrigin) {
  const rendererSafe = await window.webContents.executeJavaScript(`(async (token) => {
    const values = [location.href, location.hash, document.body.innerText, document.cookie];
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index); values.push(key, key === null ? null : storage.getItem(key));
      }
    }
    values.push(...[...document.querySelectorAll('input,textarea')].map((node) => node.value));
    values.push(...performance.getEntriesByType('resource').map((entry) => entry.name));
    return !values.some((value) => String(value ?? '').includes(token));
  })(${JSON.stringify(token)})`);
  const cookies = [
    ...await window.webContents.session.cookies.get({ url: localOrigin }),
    ...await window.webContents.session.cookies.get({ url: productOrigin }),
  ];
  const entries = window.webContents.navigationHistory?.getAllEntries?.() ?? [];
  if (!rendererSafe
    || cookies.some((cookie) => cookie.name.includes(token) || cookie.value.includes(token))
    || entries.some((entry) => String(entry.url ?? '').includes(token))) {
    throw new Error('The password reset token remained in renderer persistence or navigation state.');
  }
}

async function completeReset(window, input) {
  return window.webContents.executeJavaScript(`(async (input) => {
    ${DOM_HELPERS}
    await waitFor(() => normalized(document.querySelector('#password-reset-title')?.textContent) === '새 비밀번호 설정', 'password reset form');
    setValue(inputByLabel('새 비밀번호 확인'), input.newPassword);
    setValue(inputByLabel('새 비밀번호'), input.newPassword);
    click(buttonByText('비밀번호 변경'));
    await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex에 로그인', 'post-reset login');
    return true;
  })(${JSON.stringify(input)})`);
}

async function loginWithNewPassword(window, input) {
  return window.webContents.executeJavaScript(`(async (input) => {
    ${DOM_HELPERS}
    await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex에 로그인', 'new password login shell');
    setValue(inputByLabel('이메일'), input.email);
    setValue(inputByLabel('비밀번호'), input.newPassword);
    await delay(0);
    if (inputByLabel('이메일')?.value !== input.email || inputByLabel('비밀번호')?.value !== input.newPassword) {
      throw new Error('The new credentials were not reflected in the renderer controls.');
    }
    document.querySelector('.auth-form')?.requestSubmit();
    const outcome = await waitFor(() => document.querySelector('.app-shell') || document.querySelector('[role="alert"]'), 'new password login result', 60_000);
    if (!outcome.classList.contains('app-shell')) throw new Error('The new password was rejected by the renderer login path.');
    return true;
  })(${JSON.stringify(input)})`);
}

async function assertOldPasswordRejected(options) {
  const response = await fetchRequest(`${options.productOrigin}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: options.localOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: options.email, password: options.oldPassword }),
  });
  if (response.status !== 401) throw new Error('The old password was not rejected after reset.');
  const body = await response.json();
  if (body?.error?.code !== 'invalid_credentials') {
    throw new Error('The old-password rejection did not use the generic credential response.');
  }
  const replacement = await fetchRequest(`${options.productOrigin}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: options.localOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: options.email, password: options.newPassword }),
  });
  if (replacement.status !== 200) throw new Error('The new password was not accepted by the Product API.');
}

function resetHash(token) {
  return createHash('sha256').update('kodex-password-reset-v1\0', 'utf8').update(token, 'utf8').digest('hex');
}

export async function runDesktopPasswordResetAcceptance(window, rawOptions) {
  const options = acceptanceInput(rawOptions);
  const database = new Client({ connectionString: options.databaseUrl, ssl: false });
  let token = '';
  let secondaryCookie = '';
  try {
    await database.connect();
    await registerLogoutAndRequest(window, options);
    secondaryCookie = await createSecondarySession(options);
    token = parseResetUrl(await fetchResetUrl(options), options.localOrigin);
    const stored = await database.query(
      `SELECT encode(reset.token_hash, 'hex') AS token_hash
       FROM password_reset_requests reset JOIN users ON users.id = reset.user_id
       WHERE users.email = $1 ORDER BY reset.created_at DESC LIMIT 1`,
      [options.email],
    );
    if (stored.rows[0]?.token_hash !== resetHash(token)) {
      throw new Error('The desktop reset request was not stored as the expected domain-separated hash.');
    }
    await enterResetFragment(window, options.localOrigin, token);
    await assertNoTokenPersistence(window, token, options.localOrigin, options.productOrigin);
    await completeReset(window, options);
    await assertOldPasswordRejected(options);
    await loginWithNewPassword(window, options);
    await assertNoTokenPersistence(window, token, options.localOrigin, options.productOrigin);
    const revoked = await fetchRequest(`${options.productOrigin}/api/auth/me`, { headers: { Cookie: secondaryCookie } });
    if (revoked.status !== 401) throw new Error('The password reset did not revoke a secondary active session.');
    const completed = await database.query(
      `SELECT reset.consumed_at, reset.revoked_at, reset.delivery_failed_at
       FROM password_reset_requests reset JOIN users ON users.id = reset.user_id
       WHERE users.email = $1 ORDER BY reset.created_at DESC LIMIT 1`,
      [options.email],
    );
    if (!(completed.rows[0]?.consumed_at instanceof Date)
      || completed.rows[0]?.revoked_at !== null || completed.rows[0]?.delivery_failed_at !== null) {
      throw new Error('The desktop password reset did not reach one consumed terminal state.');
    }
    const audit = await database.query(
      `SELECT action, details FROM audit_logs
       WHERE actor_user_id = (SELECT id FROM users WHERE email = $1)
         AND action LIKE 'password_reset_%' ORDER BY id`,
      [options.email],
    );
    const auditText = JSON.stringify(audit.rows);
    if (!audit.rows.some((row) => row.action === 'password_reset_requested')
      || !audit.rows.some((row) => row.action === 'password_reset_completed')
      || auditText.includes(token) || auditText.includes(options.email)) {
      throw new Error('The password reset audit evidence was incomplete or contained sensitive material.');
    }
  } catch (error) {
    await writeFailureArtifacts(window, options.artifactDirectory).catch(() => undefined);
    let diagnostic = error instanceof Error ? error.message : String(error);
    for (const sensitive of [
      token, secondaryCookie, options.databaseUrl, options.deliveryProbeBearer,
      options.email, options.oldPassword, options.newPassword,
    ].filter((value) => typeof value === 'string' && value.length > 0)) {
      diagnostic = diagnostic.replaceAll(sensitive, '[redacted]');
    }
    process.stderr.write(`Desktop password reset acceptance diagnostic: ${diagnostic.slice(0, 500).replaceAll('\n', ' ')}\n`);
    throw error;
  } finally {
    token = '';
    secondaryCookie = '';
    await database.end().catch(() => undefined);
  }
}
