import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { Client } from 'pg';
import { WebSocket } from 'ws';

function acceptanceInput(options) {
  for (const [name, value] of Object.entries(options)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Desktop workspace lifecycle acceptance is missing ${name}.`);
    }
  }
  const local = new URL(options.localOrigin);
  const product = new URL(options.productOrigin);
  const database = new URL(options.databaseUrl);
  if (
    local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.pathname !== '/'
    || product.protocol !== 'http:' || product.hostname !== '127.0.0.1' || product.pathname !== '/'
  ) {
    throw new Error('Desktop workspace lifecycle services must use exact loopback HTTP origins.');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !['127.0.0.1', 'localhost'].includes(database.hostname)) {
    throw new Error('Desktop workspace lifecycle database must be a loopback PostgreSQL fixture.');
  }
  if (!path.isAbsolute(options.artifactDirectory)) {
    throw new Error('Desktop workspace lifecycle artifacts must use an absolute owned path.');
  }
  if (options.targetWorkspaceName === options.renamedWorkspaceName) {
    throw new Error('Desktop workspace lifecycle rename must change the workspace name.');
  }
  return { ...options, localOrigin: local.origin, productOrigin: product.origin };
}

async function writeFailureArtifacts(window, artifactDirectory) {
  if (typeof artifactDirectory !== 'string' || !path.isAbsolute(artifactDirectory)) return;
  await mkdir(artifactDirectory, { recursive: true });
  const redactionStyleId = 'kodex-workspace-lifecycle-acceptance-redaction';
  const redactionInstalled = await window.webContents.executeJavaScript(`(() => {
    const style = document.createElement('style');
    style.id = ${JSON.stringify(redactionStyleId)};
    style.textContent = 'body *{color:transparent!important;text-shadow:none!important;-webkit-text-fill-color:transparent!important}';
    document.head.append(style);
    return true;
  })()`).catch(() => false);
  if (redactionInstalled === true) {
    await window.webContents.capturePage().then((image) => writeFile(
      path.join(artifactDirectory, 'workspace-lifecycle-renderer-failure.png'),
      image.toPNG(),
    )).catch(() => undefined);
  }
  const structure = await window.webContents.executeJavaScript(`(() => ({
    origin: location.origin,
    bodyClass: document.body.className,
    headings: [...document.querySelectorAll('h1,h2,h3,h4')]
      .map((node) => node.textContent?.trim())
      .filter((value) => [
        'Kodex에 로그인', 'Kodex 계정 만들기', 'Workspace 관리',
        '새 workspace', 'Workspace 이름 변경', '워크스페이스 보관'
      ].includes(value)),
    counts: {
      buttons: document.querySelectorAll('button').length,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      forms: document.querySelectorAll('form').length,
      inputs: document.querySelectorAll('input,select,textarea').length,
      workspaceOptions: document.querySelectorAll('.workspace-option').length,
    },
    controls: [...document.querySelectorAll('input,select,textarea')].map((node) => ({
      tag: node.tagName.toLowerCase(),
      type: node.getAttribute('type'),
      disabled: node.hasAttribute('disabled'),
    })),
  }))()`);
  await writeFile(
    path.join(artifactDirectory, 'workspace-lifecycle-renderer-structure.json'),
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
  async function productMe(productOrigin) {
    const response = await fetch(productOrigin + '/api/auth/me', { credentials: 'include', cache: 'no-store' });
    if (response.status !== 200) throw new Error('Product /me did not return 200.');
    const body = await response.json();
    if (!body || !body.user || !Array.isArray(body.workspaces)) {
      throw new Error('Product /me returned an invalid public context.');
    }
    return body;
  }
`;

async function runSetupAndRenameDomPhase(window, input) {
  return window.webContents.executeJavaScript(`(async (input) => {
    ${DOM_HELPERS}
    await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex에 로그인', 'login shell');
    click([...document.querySelectorAll('button')]
      .find((button) => button.getAttribute('role') === 'tab' && normalized(button.textContent) === '회원가입'));
    await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex 계정 만들기', 'registration form');
    setValue(inputByLabel('표시 이름'), input.displayName);
    setValue(inputByLabel('이메일'), input.email);
    setValue(inputByLabel('비밀번호'), input.password);
    click(buttonByText('계정 만들기'));

    await waitFor(() => document.querySelector('.app-shell'), 'authenticated workspace shell', 60_000);
    await waitFor(() => normalized(document.querySelector('.local-status')?.textContent) === 'connected', 'initial Local connection', 60_000);
    const initialMe = await productMe(input.productOrigin);
    if (initialMe.user.email !== input.email || initialMe.workspaces.length !== 1) {
      throw new Error('Registration did not create exactly one fallback workspace.');
    }
    const fallback = initialMe.workspaces[0];
    if (!fallback || fallback.role !== 'owner') throw new Error('The fallback workspace is not owner-runnable.');

    click(await waitFor(() => document.querySelector('.account-button'), 'account menu'));
    const initialPopover = await waitFor(() => document.querySelector('.account-popover'), 'account popover');
    click(buttonByText('Workspace 관리', initialPopover));
    const dialog = await waitFor(() => document.querySelector('.workspace-management-dialog[role="dialog"]'), 'Workspace management dialog');
    const createSection = await waitFor(
      () => dialog.querySelector('[aria-labelledby="create-workspace-title"]'),
      'workspace create section',
    );
    setValue(inputByLabel('Workspace 이름', createSection), input.targetWorkspaceName);
    click(buttonByText('생성', createSection));

    await waitFor(
      () => normalized(document.querySelector('.account-button')?.getAttribute('aria-label')).includes(input.targetWorkspaceName),
      'created workspace account label',
      60_000,
    );
    await waitFor(() => normalized(document.querySelector('.local-status')?.textContent) === 'connected', 'created workspace Local connection', 60_000);
    const afterCreate = await productMe(input.productOrigin);
    const target = afterCreate.workspaces.find((workspace) => workspace.name === input.targetWorkspaceName);
    if (!target || target.role !== 'owner' || !afterCreate.workspaces.some((workspace) => workspace.id === fallback.id)) {
      throw new Error('The renderer-created target and fallback were not both present in Product /me.');
    }
    const bootstrap = await fetch('/api/bootstrap', {
      credentials: 'include', cache: 'no-store',
      headers: { 'X-Kodex-Bootstrap': '1', 'X-Kodex-Workspace-Id': target.id },
    });
    if (bootstrap.status !== 200) throw new Error('The active target Local bootstrap did not return 200.');
    const bootstrapBody = await bootstrap.json();
    if (typeof bootstrapBody.sessionToken !== 'string' || bootstrapBody.sessionToken.length === 0) {
      throw new Error('The active target Local bootstrap omitted its session proof.');
    }

    const renameSection = await waitFor(
      () => document.querySelector('[aria-labelledby="rename-workspace-title"]'),
      'workspace rename section',
    );
    setValue(renameSection.querySelector('input[aria-label="새 workspace 이름"]'), input.renamedWorkspaceName);
    click(buttonByText('이름 변경', renameSection));
    await waitFor(
      () => normalized(document.querySelector('.account-button')?.getAttribute('aria-label')).includes(input.renamedWorkspaceName),
      'renamed workspace account label',
      30_000,
    );
    await waitFor(
      () => normalized(document.querySelector('.workspace-archive-note strong')?.textContent) === input.renamedWorkspaceName,
      'renamed archive confirmation label',
      30_000,
    );
    if (normalized(document.querySelector('.local-status')?.textContent) !== 'connected') {
      throw new Error('Rename interrupted the active Local connection.');
    }
    const afterRename = await productMe(input.productOrigin);
    const renamed = afterRename.workspaces.find((workspace) => workspace.id === target.id);
    if (!renamed || renamed.name !== input.renamedWorkspaceName) {
      throw new Error('Product /me did not expose the Unicode workspace rename.');
    }

    click(buttonByLabel('Close', dialog));
    await waitFor(() => !document.querySelector('.workspace-management-dialog'), 'closed Workspace management dialog');
    click(await waitFor(() => document.querySelector('.account-button'), 'renamed account menu'));
    const renamedPopover = await waitFor(() => document.querySelector('.account-popover'), 'renamed account popover');
    if (
      normalized(document.querySelector('.account-button')?.getAttribute('aria-label')).includes(input.renamedWorkspaceName) !== true
      || normalized(renamedPopover.querySelector('.account-workspace strong')?.textContent) !== input.renamedWorkspaceName
    ) {
      throw new Error('The current workspace account labels did not expose the Unicode rename.');
    }
    click(document.querySelector('.account-button'));
    await waitFor(() => !document.querySelector('.account-popover'), 'closed renamed account popover');
    return {
      fallback: { id: fallback.id, name: fallback.name },
      localSessionToken: bootstrapBody.sessionToken,
      renameMeStatus: 200,
      target: { id: target.id, name: input.renamedWorkspaceName },
    };
  })(${JSON.stringify(input)})`);
}

async function runArchiveDomPhase(window, input) {
  return window.webContents.executeJavaScript(`(async (input) => {
    ${DOM_HELPERS}
    click(await waitFor(() => document.querySelector('.account-button'), 'account menu before archive'));
    const accountPopover = await waitFor(() => document.querySelector('.account-popover'), 'account popover before archive');
    click(buttonByText('Workspace 관리', accountPopover));
    const dialog = await waitFor(() => document.querySelector('.workspace-management-dialog[role="dialog"]'), 'Workspace management dialog before archive');
    const archiveSection = await waitFor(
      () => dialog.querySelector('[aria-labelledby="archive-workspace-title"]'),
      'workspace archive section',
    );
    if (normalized(archiveSection.querySelector('.workspace-archive-note strong')?.textContent) !== input.target.name) {
      throw new Error('The archive confirmation prompt did not use the current renamed workspace name.');
    }
    const confirmation = archiveSection.querySelector('input[aria-label="보관할 workspace 이름 확인"]');
    const archiveButton = buttonByText('워크스페이스 보관', archiveSection);
    setValue(confirmation, input.target.name + '!');
    await waitFor(() => archiveButton.disabled, 'disabled archive action for mismatched confirmation');
    if (!archiveButton.disabled) throw new Error('Mismatched archive confirmation enabled the destructive action.');
    setValue(confirmation, input.target.name);
    await waitFor(() => !archiveButton.disabled, 'enabled archive action for exact confirmation');
    click(archiveButton);

    await waitFor(() => !document.querySelector('.workspace-management-dialog'), 'archive dialog dismissal', 30_000);
    await waitFor(() => document.querySelector('.app-shell'), 'fallback workspace shell', 60_000);
    await waitFor(() => normalized(document.querySelector('.local-status')?.textContent) === 'connected', 'fallback Local connection', 60_000);
    const fallbackButton = await waitFor(() => {
      const candidate = document.querySelector('.account-button');
      const label = normalized(candidate?.getAttribute('aria-label'));
      return candidate && label.includes(input.fallback.name) && !label.includes(input.target.name) ? candidate : null;
    }, 'fallback current workspace account label', 60_000);
    click(fallbackButton);
    const fallbackPopover = await waitFor(() => document.querySelector('.account-popover'), 'fallback account popover');
    const optionNames = [...fallbackPopover.querySelectorAll('.workspace-option strong')]
      .map((node) => normalized(node.textContent));
    if (
      normalized(fallbackPopover.querySelector('.account-workspace strong')?.textContent) !== input.fallback.name
      || optionNames.includes(input.target.name)
      || normalized(fallbackPopover.textContent).includes(input.target.name)
    ) {
      throw new Error('The archived workspace remained visible or current in the account UI.');
    }

    const afterArchive = await productMe(input.productOrigin);
    if (
      afterArchive.workspaces.some((workspace) => workspace.id === input.target.id)
      || !afterArchive.workspaces.some((workspace) => workspace.id === input.fallback.id)
    ) {
      throw new Error('Product /me did not exclude only the archived workspace.');
    }
    const history = await fetch(
      input.productOrigin + '/api/history/threads?workspace_id=' + encodeURIComponent(input.target.id) + '&limit=1',
      {
        credentials: 'include', cache: 'no-store',
        headers: { 'X-Kodex-Workspace-Id': input.target.id },
      },
    );
    const archivedBootstrap = await fetch('/api/bootstrap', {
      credentials: 'include', cache: 'no-store',
      headers: { 'X-Kodex-Bootstrap': '1', 'X-Kodex-Workspace-Id': input.target.id },
    });
    const fallbackBootstrap = await fetch('/api/bootstrap', {
      credentials: 'include', cache: 'no-store',
      headers: { 'X-Kodex-Bootstrap': '1', 'X-Kodex-Workspace-Id': input.fallback.id },
    });
    if (history.status !== 403 || archivedBootstrap.status !== 403 || fallbackBootstrap.status !== 200) {
      throw new Error('Archived Product/Local scope denial or fallback Local bootstrap returned an unexpected status.');
    }
    return {
      archivedBootstrapStatus: archivedBootstrap.status,
      archiveMeStatus: 200,
      fallbackBootstrapStatus: fallbackBootstrap.status,
      historyStatus: history.status,
      mismatchedConfirmationDisabled: true,
    };
  })(${JSON.stringify(input)})`);
}

function installLifecycleRequestAudit(window, productOrigin) {
  const completed = [];
  const filter = { urls: [`${productOrigin}/api/workspaces/*`] };
  window.webContents.session.webRequest.onCompleted(filter, (details) => {
    completed.push({ method: details.method, status: details.statusCode, url: details.url });
  });
  return {
    assert(targetId) {
      const pathname = `/api/workspaces/${targetId}`;
      const lifecycle = completed.filter((entry) => new URL(entry.url).pathname === pathname
        && ['DELETE', 'PATCH'].includes(entry.method));
      const projection = lifecycle.map((entry) => `${entry.method}:${entry.status}`).join(',');
      if (projection !== 'PATCH:200,DELETE:204') {
        throw new Error(`Renderer lifecycle mutations did not complete with the expected statuses (${projection || 'none'}).`);
      }
    },
    remove() {
      window.webContents.session.webRequest.onCompleted(null);
    },
  };
}

async function readDatabaseState(database, input, targetId) {
  const result = await database.query(`
    SELECT workspace.id, workspace.name, workspace.deleted_at, owner.id AS user_id,
      (SELECT count(*)::int FROM workspace_members member
       WHERE member.workspace_id = workspace.id AND member.user_id = owner.id) AS target_membership_count,
      (SELECT count(*)::int FROM workspace_members member WHERE member.user_id = owner.id) AS user_membership_count,
      (SELECT count(*)::int FROM auth_sessions session WHERE session.user_id = owner.id) AS session_count,
      (SELECT count(*)::int FROM auth_sessions session
       WHERE session.user_id = owner.id AND session.revoked_at IS NULL AND session.expires_at > now()) AS active_session_count
    FROM workspaces workspace
    JOIN users owner ON owner.id = workspace.owner_user_id
    WHERE workspace.id = $1 AND owner.email = $2
  `, [targetId, input.email]);
  if (result.rows.length !== 1) throw new Error('PostgreSQL did not contain the renderer-created lifecycle workspace.');
  return result.rows[0];
}

async function readLifecycleAudit(database, targetId) {
  const result = await database.query(
    `SELECT action, actor_user_id, target_id, details FROM audit_logs
     WHERE workspace_id = $1 AND action IN ('workspace.renamed', 'workspace.archived') ORDER BY id`,
    [targetId],
  );
  return result.rows;
}

async function verifyRenamedDatabase(database, input, targetId) {
  const state = await readDatabaseState(database, input, targetId);
  if (
    state.name !== input.renamedWorkspaceName || state.deleted_at !== null
    || state.target_membership_count !== 1 || state.user_membership_count < 2
    || state.session_count < 1 || state.active_session_count < 1
  ) {
    throw new Error('PostgreSQL did not preserve the expected active renamed workspace, membership, and session state.');
  }
  const audit = await readLifecycleAudit(database, targetId);
  if (
    audit.length !== 1 || audit[0].action !== 'workspace.renamed'
    || audit[0].actor_user_id !== state.user_id || audit[0].target_id !== targetId
    || JSON.stringify(audit[0].details) !== JSON.stringify({ operation: 'rename' })
  ) {
    throw new Error('The renderer rename did not produce the bounded lifecycle audit contract.');
  }
  return state;
}

async function verifyArchivedDatabase(database, input, targetId, before) {
  const state = await readDatabaseState(database, input, targetId);
  if (
    state.name !== input.renamedWorkspaceName || !(state.deleted_at instanceof Date)
    || state.target_membership_count !== before.target_membership_count
    || state.user_membership_count !== before.user_membership_count
    || state.session_count !== before.session_count
    || state.active_session_count !== before.active_session_count
  ) {
    throw new Error('Soft archive changed the final name or hard-deleted/revoked membership or session rows.');
  }
  const audit = await readLifecycleAudit(database, targetId);
  const expected = [
    { action: 'workspace.renamed', operation: 'rename' },
    { action: 'workspace.archived', operation: 'archive' },
  ];
  if (
    audit.length !== expected.length
    || audit.some((entry, index) => (
      entry.action !== expected[index].action
      || entry.actor_user_id !== state.user_id
      || entry.target_id !== targetId
      || JSON.stringify(entry.details) !== JSON.stringify({ operation: expected[index].operation })
    ))
  ) {
    throw new Error('The renderer archive did not preserve the exact bounded lifecycle audit sequence.');
  }
  const auditText = JSON.stringify(audit);
  for (const sensitive of [input.email, input.targetWorkspaceName, input.renamedWorkspaceName]) {
    if (auditText.includes(sensitive)) throw new Error('Lifecycle audit details retained raw display or account input.');
  }
}

async function expectArchivedWebSocketRejected(window, localOrigin, workspaceId, localSessionToken) {
  const cookies = await window.webContents.session.cookies.get({ url: localOrigin });
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  if (!cookies.some((cookie) => cookie.name === 'kodex_product_session')
    || !cookies.some((cookie) => cookie.name === 'kodex_session')) {
    throw new Error('Electron did not retain the Product and Local session cookies needed for the WebSocket denial probe.');
  }
  const socketUrl = new URL('/ws', localOrigin.replace(/^http/u, 'ws'));
  socketUrl.searchParams.set('workspace_id', workspaceId);
  const socket = new WebSocket(socketUrl, ['kodex', localSessionToken], {
    origin: localOrigin,
    headers: { Cookie: cookieHeader },
  });
  socket.on('error', () => undefined);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('Archived workspace WebSocket denial timed out.'));
    }, 10_000);
    socket.once('open', () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error('Archived workspace WebSocket unexpectedly opened.'));
    });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.destroy();
      if (response.statusCode === 403) resolve();
      else reject(new Error(`Archived workspace WebSocket returned HTTP ${response.statusCode}; expected 403.`));
    });
  });
}

/**
 * Drives workspace creation, rename, and one-way archive through public renderer
 * controls. Direct probes only verify the public Product/Local authorization and
 * persistence boundaries after the visible lifecycle actions.
 */
export async function runDesktopWorkspaceLifecycleAcceptance(window, rawOptions) {
  const options = acceptanceInput(rawOptions);
  const database = new Client({ connectionString: options.databaseUrl, ssl: false });
  const requestAudit = installLifecycleRequestAudit(window, options.productOrigin);
  let localSessionToken = '';
  try {
    await database.connect();
    const setup = await runSetupAndRenameDomPhase(window, options);
    if (
      !setup?.target?.id || !setup?.fallback?.id || setup.target.id === setup.fallback.id
      || setup.target.name !== options.renamedWorkspaceName || setup.renameMeStatus !== 200
    ) {
      throw new Error('The renderer returned an incomplete workspace setup and rename result.');
    }
    localSessionToken = setup.localSessionToken;
    const before = await verifyRenamedDatabase(database, options, setup.target.id);
    const archived = await runArchiveDomPhase(window, {
      fallback: setup.fallback,
      productOrigin: options.productOrigin,
      target: setup.target,
    });
    if (
      !archived?.mismatchedConfirmationDisabled || archived.archiveMeStatus !== 200
      || archived.historyStatus !== 403 || archived.archivedBootstrapStatus !== 403
      || archived.fallbackBootstrapStatus !== 200
    ) {
      throw new Error('The renderer returned an incomplete workspace archive and fallback result.');
    }
    requestAudit.assert(setup.target.id);
    await expectArchivedWebSocketRejected(
      window,
      options.localOrigin,
      setup.target.id,
      localSessionToken,
    );
    await verifyArchivedDatabase(database, options, setup.target.id, before);
  } catch (error) {
    await writeFailureArtifacts(window, options.artifactDirectory).catch(() => undefined);
    let diagnostic = error instanceof Error ? error.message : String(error);
    for (const sensitive of [
      localSessionToken, options.databaseUrl, options.displayName, options.email, options.password,
      options.renamedWorkspaceName, options.targetWorkspaceName,
    ].filter((value) => typeof value === 'string' && value.length > 0)) {
      diagnostic = diagnostic.replaceAll(sensitive, '[redacted]');
    }
    process.stderr.write(`Desktop workspace lifecycle acceptance diagnostic: ${diagnostic.slice(0, 500).replaceAll('\n', ' ')}\n`);
    throw error;
  } finally {
    requestAudit.remove();
    localSessionToken = '';
    await database.end().catch(() => undefined);
  }
}
