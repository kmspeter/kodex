import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { Client } from 'pg';

const INVITATION_HASH_DOMAIN = Buffer.from('kodex-workspace-invitation-v1\0', 'utf8');
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function acceptanceInput(options) {
  for (const [name, value] of Object.entries(options)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Desktop workspace invitation acceptance is missing ${name}.`);
    }
  }
  const local = new URL(options.localOrigin);
  const product = new URL(options.productOrigin);
  const database = new URL(options.databaseUrl);
  if (
    local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.pathname !== '/'
    || product.protocol !== 'http:' || product.hostname !== '127.0.0.1' || product.pathname !== '/'
  ) {
    throw new Error('Desktop workspace invitation services must use exact loopback HTTP origins.');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !['127.0.0.1', 'localhost'].includes(database.hostname)) {
    throw new Error('Desktop workspace invitation database must be a loopback PostgreSQL fixture.');
  }
  return { ...options, localOrigin: local.origin, productOrigin: product.origin };
}

function maskedEmail(email) {
  const separator = email.lastIndexOf('@');
  const local = email.slice(0, separator);
  return `${local.slice(0, 1)}${'*'.repeat(Math.min(3, Math.max(1, local.length - 1)))}${email.slice(separator)}`;
}

async function writeFailureArtifacts(window, artifactDirectory) {
  if (typeof artifactDirectory !== 'string' || !path.isAbsolute(artifactDirectory)) return;
  await mkdir(artifactDirectory, { recursive: true });
  const redactionStyleId = 'kodex-workspace-invitation-acceptance-redaction';
  const redactionInstalled = await window.webContents.executeJavaScript(`(() => {
    const style = document.createElement('style');
    style.id = ${JSON.stringify(redactionStyleId)};
    style.textContent = 'body *{color:transparent!important;text-shadow:none!important;-webkit-text-fill-color:transparent!important}';
    document.head.append(style);
    return true;
  })()`).catch(() => false);
  if (redactionInstalled === true) {
    await window.webContents.capturePage().then((image) => writeFile(
      path.join(artifactDirectory, 'workspace-invitation-renderer-failure.png'),
      image.toPNG(),
    )).catch(() => undefined);
  }
  const structure = await window.webContents.executeJavaScript(`(() => ({
    origin: location.origin,
    hashPresent: location.hash.length > 0,
    bodyClass: document.body.className,
    headings: [...document.querySelectorAll('h1,h2,h3,h4')]
      .map((node) => node.textContent?.trim())
      .filter((value) => [
        'Kodex에 로그인', 'Kodex 계정 만들기', 'Workspace 관리',
        'Workspace 초대를 처리할 수 없습니다', '대기 중인 초대'
      ].includes(value)),
    counts: {
      buttons: document.querySelectorAll('button').length,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      forms: document.querySelectorAll('form').length,
      inputs: document.querySelectorAll('input,select,textarea').length,
      pendingInvitations: document.querySelectorAll('.workspace-invitation-row').length,
    },
    controls: [...document.querySelectorAll('input,select,textarea')].map((node) => ({
      tag: node.tagName.toLowerCase(),
      name: node.getAttribute('name'),
      type: node.getAttribute('type'),
      disabled: node.hasAttribute('disabled'),
    })),
  }))()`);
  await writeFile(
    path.join(artifactDirectory, 'workspace-invitation-renderer-structure.json'),
    `${JSON.stringify(structure, null, 2)}\n`,
    'utf8',
  );
  if (redactionInstalled === true) {
    await window.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(redactionStyleId)})?.remove()`)
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
  function buttonByLabel(label, root = document) {
    return [...root.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === label);
  }
  function inputByLabel(labelText, root = document) {
    const label = [...root.querySelectorAll('label')]
      .find((candidate) => normalized(candidate.childNodes[0]?.textContent).startsWith(labelText));
    return label?.querySelector('input,textarea,select') ?? null;
  }
  function setValue(control, value) {
    if (!control) throw new Error('The expected renderer input is unavailable.');
    const prototype = control instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : control instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) throw new Error('The renderer control does not expose a native value setter.');
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

async function runOwnerDomPhase(window, input) {
  return window.webContents.executeJavaScript(`(async (input) => {
    ${DOM_HELPERS}
    await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex에 로그인', 'owner login shell');
    click([...document.querySelectorAll('button')]
      .find((button) => button.getAttribute('role') === 'tab' && normalized(button.textContent) === '회원가입'));
    await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex 계정 만들기', 'owner registration form');
    setValue(inputByLabel('표시 이름'), input.ownerDisplayName);
    setValue(inputByLabel('이메일'), input.ownerEmail);
    setValue(inputByLabel('비밀번호'), input.ownerPassword);
    click(buttonByText('계정 만들기'));

    await waitFor(() => document.querySelector('.app-shell'), 'owner authenticated shell', 60_000);
    await waitFor(() => normalized(document.querySelector('.local-status')?.textContent) === 'connected', 'owner Local WebSocket', 60_000);
    click(await waitFor(() => document.querySelector('.account-button'), 'owner account menu'));
    const accountPopover = await waitFor(() => document.querySelector('.account-popover'), 'owner account popover');
    click(buttonByText('Workspace 관리', accountPopover));
    const dialog = await waitFor(() => document.querySelector('.workspace-management-dialog[role="dialog"]'), 'Workspace management dialog');
    await waitFor(() => dialog.getAttribute('aria-busy') === 'false', 'initial Workspace management load');
    setValue(inputByLabel('초대할 email', dialog), input.inviteeEmail);
    setValue(dialog.querySelector('select[aria-label="초대할 역할"]'), 'member');
    click(buttonByText('초대 링크 생성', dialog));
    const linkInput = await waitFor(() => dialog.querySelector('input[aria-label="새 workspace 초대 링크"]'), 'one-time invitation link');
    await waitFor(() => dialog.getAttribute('aria-busy') === 'false', 'invitation create completion');
    const inviteUrl = linkInput.value;
    const rawToken = inviteUrl.includes('#invite=') ? inviteUrl.split('#invite=')[1] : '';
    if (!/^[A-Za-z0-9_-]{43}$/u.test(rawToken)) {
      throw new Error('The one-time renderer input did not contain a canonical invitation fragment.');
    }
    const invitationRows = [...dialog.querySelectorAll('.workspace-invitation-row')];
    if (invitationRows.length !== 1 || !normalized(invitationRows[0].textContent).includes(input.inviteeEmail)) {
      throw new Error('The pending invitation list did not contain exactly the requested target.');
    }
    const candidateValues = [...document.querySelectorAll('input,textarea')].map((control) => control.value);
    if (candidateValues.filter((value) => value.includes(rawToken)).length !== 1
      || candidateValues.filter((value) => value === inviteUrl).length !== 1) {
      throw new Error('The raw invitation link was not isolated to its one-time renderer input.');
    }
    if (normalized(document.body.innerText).includes(rawToken)
      || invitationRows.some((row) => normalized(row.textContent).includes(rawToken))) {
      throw new Error('The pending invitation renderer exposed raw token material.');
    }
    click(buttonByLabel('초대 링크 닫기', dialog));
    await waitFor(() => !dialog.querySelector('input[aria-label="새 workspace 초대 링크"]'), 'one-time link removal');
    if ([...document.querySelectorAll('input,textarea')].some((control) => control.value === inviteUrl)) {
      throw new Error('The renderer retained the one-time link after it was closed.');
    }
    click(buttonByLabel('Close', dialog));
    await waitFor(() => !document.querySelector('.workspace-management-dialog'), 'Workspace management close');
    click(await waitFor(() => document.querySelector('.account-button'), 'owner account menu after invitation'));
    click(buttonByText('로그아웃', await waitFor(() => document.querySelector('.account-popover'), 'owner logout menu')));
    await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex에 로그인', 'owner logout completion');
    return { inviteUrl };
  })(${JSON.stringify(input)})`);
}

function parseInvitationUrl(inviteUrl, localOrigin) {
  let parsed;
  try {
    parsed = new URL(inviteUrl);
  } catch {
    throw new Error('The renderer returned an invalid one-time invitation link.');
  }
  const prefix = '#invite=';
  const token = parsed.hash.startsWith(prefix) ? parsed.hash.slice(prefix.length) : '';
  if (
    parsed.origin !== localOrigin || parsed.pathname !== '/' || parsed.search
    || !INVITATION_TOKEN_PATTERN.test(token)
    || Buffer.from(token, 'base64url').toString('base64url') !== token
  ) {
    throw new Error('The renderer invitation link did not use the canonical local fragment format.');
  }
  return token;
}

async function verifyCreatedInvitation(database, input, token) {
  const result = await database.query(`
    SELECT invitation.id, invitation.workspace_id, invitation.target_email,
           invitation.requested_role, encode(invitation.token_hash, 'hex') AS token_hash,
           invitation.accepted_at, invitation.revoked_at, workspace.name AS workspace_name
    FROM workspace_invitations invitation
    JOIN workspaces workspace ON workspace.id = invitation.workspace_id
    JOIN workspace_members owner_membership
      ON owner_membership.workspace_id = invitation.workspace_id AND owner_membership.role = 'owner'
    JOIN users owner_account ON owner_account.id = owner_membership.user_id
    WHERE owner_account.email = $1 AND invitation.target_email = $2
  `, [input.ownerEmail, input.inviteeEmail]);
  if (result.rows.length !== 1) throw new Error('PostgreSQL did not contain exactly one renderer-created invitation.');
  const invitation = result.rows[0];
  const expectedHash = createHash('sha256')
    .update(INVITATION_HASH_DOMAIN)
    .update(Buffer.from(token, 'base64url'))
    .digest('hex');
  if (
    invitation.target_email !== input.inviteeEmail || invitation.requested_role !== 'member'
    || invitation.token_hash !== expectedHash || invitation.accepted_at || invitation.revoked_at
  ) {
    throw new Error('The renderer-created invitation did not preserve the expected hash-only pending state.');
  }
  const columns = await database.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspace_invitations'
    ORDER BY ordinal_position
  `);
  const tokenColumns = columns.rows.map((entry) => entry.column_name).filter((name) => name.includes('token'));
  if (tokenColumns.length !== 1 || tokenColumns[0] !== 'token_hash') {
    throw new Error('The invitation table exposed a non-hash token column.');
  }
  const audit = await database.query(
    `SELECT action, target_id, details FROM audit_logs WHERE workspace_id = $1 ORDER BY id`,
    [invitation.workspace_id],
  );
  const auditText = JSON.stringify(audit.rows);
  if (auditText.includes(token) || auditText.includes(expectedHash) || auditText.includes(input.inviteeEmail)) {
    throw new Error('The invitation create audit boundary retained sensitive invitation material.');
  }
  return {
    id: invitation.id,
    workspaceId: invitation.workspace_id,
    workspaceName: invitation.workspace_name,
    tokenHash: expectedHash,
  };
}

function requestBody(details) {
  const chunks = [];
  for (const entry of details.uploadData ?? []) {
    if (entry.bytes) chunks.push(Buffer.from(entry.bytes));
  }
  return chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : '';
}

function installRequestAudit(window, input, token) {
  const filter = { urls: [`${input.localOrigin}/*`, `${input.productOrigin}/*`] };
  const starts = [];
  const tokenRoutes = [];
  const completed = [];
  const requestTags = new Map();
  const violations = [];
  let fragmentEntries = 0;
  const classify = (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.origin === input.productOrigin) {
      if (url.pathname === '/api/invitations/preview') return 'preview';
      if (url.pathname === '/api/invitations/accept') return 'accept';
      if (url.pathname === '/api/auth/me') return 'me';
      if (url.pathname === '/api/auth/register') return 'register';
      return 'product-other';
    }
    if (url.origin === input.localOrigin && url.pathname === '/api/bootstrap') return 'bootstrap';
    return 'local-other';
  };
  window.webContents.session.webRequest.onBeforeRequest(filter, (details, callback) => {
    const tag = classify(details.url);
    starts.push(tag);
    requestTags.set(details.id, tag);
    const body = requestBody(details);
    if (details.url.includes(token)) {
      const requested = new URL(details.url);
      if (
        details.resourceType === 'mainFrame' && requested.origin === input.localOrigin
        && requested.pathname === '/' && !requested.search && requested.hash === `#invite=${token}`
      ) fragmentEntries += 1;
      else violations.push('url');
    }
    if (body.includes(token)) {
      tokenRoutes.push(tag);
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      if (
        !['preview', 'accept'].includes(tag) || !parsed || typeof parsed !== 'object'
        || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || parsed.token !== token
      ) violations.push('body');
    }
    callback({});
  });
  window.webContents.session.webRequest.onCompleted(filter, (details) => {
    completed.push({ method: details.method, status: details.statusCode, tag: requestTags.get(details.id) ?? classify(details.url) });
    requestTags.delete(details.id);
  });
  return {
    assertAccepted() {
      if (violations.length > 0 || fragmentEntries !== 1 || tokenRoutes.join(',') !== 'preview,accept') {
        throw new Error(`The accepted invitation request sequence moved the token outside its fragment and strict bodies (fragments=${fragmentEntries}, routes=${tokenRoutes.join(',') || 'none'}, violations=${violations.join(',') || 'none'}).`);
      }
      const acceptIndex = starts.indexOf('accept');
      const deniedBootstrapIndex = starts.indexOf('bootstrap');
      const refreshedMeIndex = starts.indexOf('me', acceptIndex + 1);
      const acceptedBootstrapIndex = starts.indexOf('bootstrap', acceptIndex + 1);
      if (
        deniedBootstrapIndex < 0 || acceptIndex < 0 || deniedBootstrapIndex > acceptIndex
        || refreshedMeIndex < 0 || acceptedBootstrapIndex < 0 || refreshedMeIndex > acceptedBootstrapIndex
      ) {
        throw new Error('The renderer did not revalidate /me before starting the accepted workspace runtime.');
      }
      if (!completed.some((entry) => entry.method === 'POST' && entry.tag === 'preview' && entry.status === 200)
        || !completed.some((entry) => entry.method === 'POST' && entry.tag === 'accept' && entry.status === 200)) {
        throw new Error('The invitation preview and accept requests did not complete successfully.');
      }
    },
    assertTerminal() {
      if (violations.length > 0 || fragmentEntries !== 2 || tokenRoutes.join(',') !== 'preview,accept,preview') {
        throw new Error(`The terminal invitation request sequence retained or retransmitted the raw token (fragments=${fragmentEntries}, routes=${tokenRoutes.join(',') || 'none'}, violations=${violations.join(',') || 'none'}).`);
      }
      const previewStatuses = completed.filter((entry) => entry.method === 'POST' && entry.tag === 'preview').map((entry) => entry.status);
      const acceptStatuses = completed.filter((entry) => entry.method === 'POST' && entry.tag === 'accept').map((entry) => entry.status);
      if (previewStatuses.join(',') !== '200,410' || acceptStatuses.join(',') !== '200') {
        throw new Error(`The reused invitation did not produce the expected generic terminal response (preview=${previewStatuses.join(',') || 'none'}, accept=${acceptStatuses.join(',') || 'none'}).`);
      }
    },
    remove() {
      window.webContents.session.webRequest.onBeforeRequest(null);
      window.webContents.session.webRequest.onCompleted(null);
    },
  };
}

async function assertNoTokenPersistence(window, token, localOrigin, productOrigin) {
  const rendererSafe = await window.webContents.executeJavaScript(`(async (token) => {
    const contains = (value) => String(value ?? '').includes(token);
    const storageValues = [];
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        storageValues.push(key, key === null ? null : storage.getItem(key));
      }
    }
    const attributeValues = [...document.querySelectorAll('*')]
      .flatMap((node) => [...node.attributes].map((attribute) => attribute.value));
    const controlValues = [...document.querySelectorAll('input,textarea,select')]
      .map((control) => control.value);
    const databaseNames = typeof indexedDB.databases === 'function'
      ? (await indexedDB.databases()).map((entry) => entry.name ?? '')
      : [];
    const cacheNames = [];
    const cachedUrls = [];
    if ('caches' in globalThis) {
      for (const cacheName of await caches.keys()) {
        cacheNames.push(cacheName);
        const cache = await caches.open(cacheName);
        cachedUrls.push(...(await cache.keys()).map((request) => request.url));
      }
    }
    return databaseNames.length === 0 && cacheNames.length === 0 && ![
      location.href, location.hash, document.body.innerText, document.cookie,
      ...storageValues, ...attributeValues, ...controlValues, ...databaseNames, ...cacheNames, ...cachedUrls,
      ...performance.getEntriesByType('resource').map((entry) => entry.name),
    ].some(contains);
  })(${JSON.stringify(token)})`);
  const cookies = [
    ...await window.webContents.session.cookies.get({ url: localOrigin }),
    ...await window.webContents.session.cookies.get({ url: productOrigin }),
  ];
  const cookieSafe = cookies.every((cookie) => !cookie.name.includes(token) && !cookie.value.includes(token));
  const currentUrlSafe = !window.webContents.getURL().includes(token);
  const entries = window.webContents.navigationHistory?.getAllEntries?.() ?? [];
  const historySafe = entries.every((entry) => !String(entry.url ?? '').includes(token));
  if (!rendererSafe || !cookieSafe || !currentUrlSafe || !historySafe) {
    throw new Error('The invitation token remained in renderer DOM, URL, navigation history, or browser persistence.');
  }
}

async function enterInvitationFragment(window, localOrigin, token) {
  await window.webContents.executeJavaScript(`history.replaceState(history.state, '', ${JSON.stringify(`/#invite=${token}`)}); true`);
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.webContents.removeListener('did-finish-load', loaded);
      window.webContents.removeListener('did-fail-load', failed);
      if (error) reject(error);
      else resolve();
    };
    const loaded = () => finish();
    const failed = () => finish(new Error('The invitation fragment renderer reload failed.'));
    const timer = setTimeout(() => finish(new Error('The invitation fragment renderer reload timed out.')), 30_000);
    window.webContents.once('did-finish-load', loaded);
    window.webContents.once('did-fail-load', failed);
    window.webContents.reload();
  });
  const current = window.webContents.getURL();
  if (!current.startsWith(`${localOrigin}/`) || current.includes(token) || new URL(current).hash) {
    throw new Error('The renderer did not remove the invitation fragment during entrypoint startup.');
  }
}

async function runInviteeAcceptanceDomPhase(window, input) {
  return window.webContents.executeJavaScript(`(async (input) => {
    ${DOM_HELPERS}
    const invitationNote = await waitFor(() => document.querySelector('.invitation-auth-note'), 'masked invitation preview');
    if (location.hash || !normalized(invitationNote.textContent).includes(input.maskedEmail)
      || normalized(invitationNote.textContent).includes(input.inviteeEmail)) {
      throw new Error('The unauthenticated invitation preview did not keep the fragment and target email masked.');
    }
    await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex에 로그인', 'invitee login shell');
    click([...document.querySelectorAll('button')]
      .find((button) => button.getAttribute('role') === 'tab' && normalized(button.textContent) === '회원가입'));
    await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex 계정 만들기', 'invitee registration form');
    setValue(inputByLabel('표시 이름'), input.inviteeDisplayName);
    setValue(inputByLabel('이메일'), input.inviteeEmail);
    setValue(inputByLabel('비밀번호'), input.inviteePassword);
    click(buttonByText('계정 만들기'));

    const acceptance = await waitFor(() => document.querySelector('.invitation-accept-card'), 'explicit invitation acceptance', 30_000);
    if (!normalized(acceptance.textContent).includes(input.workspaceName)
      || !normalized(acceptance.textContent).includes(input.maskedEmail)) {
      throw new Error('The explicit acceptance card did not preserve the masked invitation preview.');
    }
    const denied = await fetch('/api/bootstrap', {
      credentials: 'include', cache: 'no-store',
      headers: { 'X-Kodex-Bootstrap': '1', 'X-Kodex-Workspace-Id': input.workspaceId },
    });
    if (denied.status !== 403) throw new Error('The invited workspace bootstrap was not forbidden before explicit acceptance.');
    click(buttonByText('초대 수락', acceptance));

    await waitFor(() => document.querySelector('.app-shell'), 'accepted workspace shell', 60_000);
    await waitFor(() => normalized(document.querySelector('.local-status')?.textContent) === 'connected', 'accepted workspace WebSocket', 60_000);
    const accountLabel = document.querySelector('.account-button')?.getAttribute('aria-label') ?? '';
    if (!normalized(accountLabel).includes(input.workspaceName) || !normalized(accountLabel).includes('member 역할')) {
      throw new Error('The /me refresh did not select the invited member workspace in the renderer.');
    }
    const bootstrap = await fetch('/api/bootstrap', {
      credentials: 'include', cache: 'no-store',
      headers: { 'X-Kodex-Bootstrap': '1', 'X-Kodex-Workspace-Id': input.workspaceId },
    });
    if (bootstrap.status !== 200) throw new Error('The accepted workspace bootstrap did not succeed.');
    const bootstrapBody = await bootstrap.json();
    if (typeof bootstrapBody.sessionToken !== 'string') throw new Error('The accepted bootstrap omitted its Local session proof.');
    const socketUrl = new URL('/ws', location.origin);
    socketUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socketUrl.searchParams.set('workspace_id', input.workspaceId);
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(socketUrl, ['kodex', bootstrapBody.sessionToken]);
      let opened = false;
      const timer = setTimeout(() => { socket.close(); reject(new Error('Accepted workspace WebSocket timed out.')); }, 20_000);
      socket.addEventListener('open', () => { opened = true; });
      socket.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message?.type !== 'hello') return;
        clearTimeout(timer);
        socket.close(1000, 'acceptance probe complete');
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Accepted workspace WebSocket was rejected.'));
      });
      socket.addEventListener('close', () => {
        if (!opened) { clearTimeout(timer); reject(new Error('Accepted workspace WebSocket closed before opening.')); }
      });
    });
    return { accepted: true, preAcceptStatus: denied.status, postAcceptStatus: bootstrap.status, socketHello: true };
  })(${JSON.stringify(input)})`);
}

async function runTerminalDomPhase(window, input) {
  return window.webContents.executeJavaScript(`(async (input) => {
    ${DOM_HELPERS}
    await waitFor(
      () => normalized(document.querySelector('#invitation-outcome-title')?.textContent)
        === 'Workspace 초대를 처리할 수 없습니다',
      'reused invitation terminal outcome',
    );
    const alert = document.querySelector('[role="alert"]');
    if (!normalized(alert?.textContent).includes('만료·취소·사용')) {
      throw new Error('The renderer did not show the generic terminal invitation message.');
    }
    if (location.hash) throw new Error('The terminal renderer retained the invitation fragment.');
    click(buttonByText('계속'));
    await waitFor(() => document.querySelector('.app-shell'), 'post-terminal authenticated shell', 60_000);
    await waitFor(() => normalized(document.querySelector('.local-status')?.textContent) === 'connected', 'post-terminal Local WebSocket', 60_000);
    const me = await fetch(input.productOrigin + '/api/auth/me', { credentials: 'include', cache: 'no-store' });
    const health = await fetch('/api/health', { credentials: 'include', cache: 'no-store' });
    if (me.status !== 200 || health.status !== 200) {
      throw new Error('Safe follow-up requests failed after the terminal invitation was cleared.');
    }
    return { followUpHealth: health.status, followUpMe: me.status, terminal: true };
  })(${JSON.stringify({ productOrigin: input.productOrigin })})`);
}

async function verifyAcceptedInvitation(database, input, invitation, token) {
  const result = await database.query(`
    SELECT invitation.accepted_at, invitation.revoked_at, accepted.email AS accepted_email,
           membership.role, encode(invitation.token_hash, 'hex') AS token_hash
    FROM workspace_invitations invitation
    JOIN users accepted ON accepted.id = invitation.accepted_by_user_id
    JOIN workspace_members membership
      ON membership.workspace_id = invitation.workspace_id AND membership.user_id = accepted.id
    WHERE invitation.id = $1
  `, [invitation.id]);
  const row = result.rows[0];
  if (
    result.rows.length !== 1 || !row.accepted_at || row.revoked_at
    || row.accepted_email !== input.inviteeEmail || row.role !== 'member' || row.token_hash !== invitation.tokenHash
  ) {
    throw new Error('PostgreSQL did not atomically commit the accepted renderer invitation membership.');
  }
  const pending = await database.query(`
    SELECT count(*)::int AS count FROM workspace_invitations
    WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
  `, [invitation.workspaceId]);
  if (pending.rows[0]?.count !== 0) throw new Error('The accepted invitation remained in the PostgreSQL pending set.');
  const audit = await database.query(
    `SELECT action, target_id, details FROM audit_logs
     WHERE workspace_id = $1 AND action LIKE 'workspace.invitation_%' ORDER BY id`,
    [invitation.workspaceId],
  );
  if (audit.rows.map((entry) => entry.action).join(',') !== 'workspace.invitation_created,workspace.invitation_accepted') {
    throw new Error('The renderer invitation lifecycle did not produce the expected audit actions.');
  }
  const auditText = JSON.stringify(audit.rows);
  if (auditText.includes(token) || auditText.includes(invitation.tokenHash) || auditText.includes(input.inviteeEmail)) {
    throw new Error('The accepted invitation audit boundary retained sensitive invitation material.');
  }
}

/**
 * Drives only public renderer controls for the invitation journey. Direct
 * renderer fetch/WebSocket probes are limited to the Local authorization
 * boundary that has no visible UI before an invitation is accepted.
 */
export async function runDesktopWorkspaceInvitationAcceptance(window, rawOptions) {
  const options = acceptanceInput(rawOptions);
  const database = new Client({ connectionString: options.databaseUrl, ssl: false });
  let audit;
  let token = '';
  try {
    await database.connect();
    const ownerResult = await runOwnerDomPhase(window, {
      inviteeEmail: options.inviteeEmail,
      ownerDisplayName: options.ownerDisplayName,
      ownerEmail: options.ownerEmail,
      ownerPassword: options.ownerPassword,
    });
    token = parseInvitationUrl(ownerResult.inviteUrl, options.localOrigin);
    const invitation = await verifyCreatedInvitation(database, options, token);
    await assertNoTokenPersistence(window, token, options.localOrigin, options.productOrigin);
    audit = installRequestAudit(window, options, token);

    await enterInvitationFragment(window, options.localOrigin, token);
    await assertNoTokenPersistence(window, token, options.localOrigin, options.productOrigin);
    const accepted = await runInviteeAcceptanceDomPhase(window, {
      inviteeDisplayName: options.inviteeDisplayName,
      inviteeEmail: options.inviteeEmail,
      inviteePassword: options.inviteePassword,
      maskedEmail: maskedEmail(options.inviteeEmail),
      workspaceId: invitation.workspaceId,
      workspaceName: invitation.workspaceName,
    });
    if (!accepted?.accepted || accepted.preAcceptStatus !== 403 || accepted.postAcceptStatus !== 200 || !accepted.socketHello) {
      throw new Error('The renderer returned an incomplete accepted invitation result.');
    }
    audit.assertAccepted();
    await assertNoTokenPersistence(window, token, options.localOrigin, options.productOrigin);
    await verifyAcceptedInvitation(database, options, invitation, token);

    await enterInvitationFragment(window, options.localOrigin, token);
    await assertNoTokenPersistence(window, token, options.localOrigin, options.productOrigin);
    const terminal = await runTerminalDomPhase(window, options);
    if (!terminal?.terminal || terminal.followUpMe !== 200 || terminal.followUpHealth !== 200) {
      throw new Error('The renderer returned an incomplete terminal invitation result.');
    }
    audit.assertTerminal();
    await assertNoTokenPersistence(window, token, options.localOrigin, options.productOrigin);
  } catch (error) {
    await writeFailureArtifacts(window, options.artifactDirectory).catch(() => undefined);
    let diagnostic = error instanceof Error ? error.message : String(error);
    for (const sensitive of [
      token, options.databaseUrl, options.inviteeEmail, options.inviteePassword,
      options.ownerEmail, options.ownerPassword,
    ].filter((value) => typeof value === 'string' && value.length > 0)) {
      diagnostic = diagnostic.replaceAll(sensitive, '[redacted]');
    }
    process.stderr.write(`Desktop invitation acceptance diagnostic: ${diagnostic.slice(0, 500).replaceAll('\n', ' ')}\n`);
    throw error;
  } finally {
    audit?.remove();
    token = '';
    await database.end().catch(() => undefined);
  }
}
