import { mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { Client } from 'pg';

function inputOptions(options) {
  for (const [name, value] of Object.entries(options)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Desktop data lifecycle acceptance is missing ${name}.`);
    }
  }
  const local = new URL(options.localOrigin);
  const product = new URL(options.productOrigin);
  const database = new URL(options.databaseUrl);
  const relativeDataRoot = path.relative(os.tmpdir(), options.dataRoot);
  if (
    local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.pathname !== '/'
    || product.protocol !== 'http:' || product.hostname !== '127.0.0.1' || product.pathname !== '/'
    || !['postgres:', 'postgresql:'].includes(database.protocol)
    || !['127.0.0.1', 'localhost'].includes(database.hostname)
    || !path.isAbsolute(options.artifactDirectory)
    || !path.isAbsolute(options.dataRoot)
    || relativeDataRoot.startsWith('..')
    || path.isAbsolute(relativeDataRoot)
    || !path.basename(options.dataRoot).startsWith('kodex-desktop-smoke-')
  ) throw new Error('Desktop data lifecycle acceptance received an unsafe runtime boundary.');
  return { ...options, localOrigin: local.origin, productOrigin: product.origin };
}

async function exists(filename) {
  try { await stat(filename); return true; } catch { return false; }
}

async function waitFor(read, description, milliseconds = 60_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function failureArtifacts(window, artifactDirectory) {
  await mkdir(artifactDirectory, { recursive: true });
  const structure = await window.webContents.executeJavaScript(`(() => ({
    origin: location.origin,
    headings: [...document.querySelectorAll('h1,h2,h3')].map((entry) => entry.textContent?.trim()),
    counts: {
      buttons: document.querySelectorAll('button').length,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      forms: document.querySelectorAll('form').length,
      inputs: document.querySelectorAll('input').length,
    },
  }))()`);
  await writeFile(
    path.join(artifactDirectory, 'data-lifecycle-renderer-structure.json'),
    `${JSON.stringify(structure, null, 2)}\n`,
    'utf8',
  );
}

const DOM_HELPERS = `
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const normalized = (value) => String(value ?? '').replace(/\\s+/gu, ' ').trim();
  async function waitFor(read, description, milliseconds = 60_000) {
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
  function setValue(control, value) {
    if (!control) throw new Error('The expected renderer input is unavailable.');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('The renderer input setter is unavailable.');
    setter.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function click(control) {
    if (!control || control.disabled) throw new Error('The expected renderer control is unavailable.');
    control.click();
  }
  async function productMe(productOrigin) {
    const response = await fetch(productOrigin + '/api/auth/me', { credentials: 'include', cache: 'no-store' });
    if (response.status !== 200) throw new Error('Product /me did not return 200.');
    return response.json();
  }
`;

async function setupAndExport(window, options) {
  return window.webContents.executeJavaScript(`(async (input) => {
    ${DOM_HELPERS}
    await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex에 로그인', 'login shell');
    click([...document.querySelectorAll('button')]
      .find((button) => button.getAttribute('role') === 'tab' && normalized(button.textContent) === '회원가입'));
    await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex 계정 만들기', 'registration form');
    const registration = document.querySelector('.auth-form');
    setValue(registration.querySelector('input[autocomplete="name"]'), input.displayName);
    setValue(registration.querySelector('input[autocomplete="email"]'), input.email);
    setValue(registration.querySelector('input[autocomplete="new-password"]'), input.password);
    click(buttonByText('계정 만들기', registration));
    await waitFor(() => document.querySelector('.app-shell'), 'authenticated shell');
    await waitFor(() => normalized(document.querySelector('.local-status')?.textContent) === 'connected', 'Local connection');
    const context = await productMe(input.productOrigin);
    if (!context.user?.id || context.workspaces?.length !== 1 || context.workspaces[0].role !== 'owner') {
      throw new Error('Registration did not create the expected owner workspace.');
    }
    click(document.querySelector('.account-button'));
    const popover = await waitFor(() => document.querySelector('.account-popover'), 'account popover');
    click(buttonByText('Security', popover));
    const dialog = await waitFor(() => document.querySelector('.security-dialog'), 'Security dialog');
    const exportSection = dialog.querySelector('[aria-labelledby="data-export-title"]');
    const deletionSection = dialog.querySelector('[aria-labelledby="account-delete-title"]');
    if (
      !normalized(exportSection?.textContent).includes('embedding vector는 제외합니다')
      || !normalized(deletionSection?.textContent).includes('secure erasure가 아닙니다')
    ) throw new Error('Renderer did not disclose export exclusions and physical deletion limits.');
    setValue(exportSection.querySelector('input[aria-label="내보내기 현재 비밀번호"]'), input.password);
    click(buttonByText('JSON 생성', exportSection));
    await waitFor(
      () => normalized(exportSection.textContent).includes('내보내기 상태: completed'),
      'completed export job',
      90_000,
    );
    click(dialog.querySelector('button[aria-label="Close"]'));
    await waitFor(() => !document.querySelector('.security-dialog'), 'closed Security dialog');
    return { userId: context.user.id, workspace: context.workspaces[0] };
  })(${JSON.stringify(options)})`);
}

async function deleteWorkspace(window, options) {
  return window.webContents.executeJavaScript(`(async (input) => {
    ${DOM_HELPERS}
    click(await waitFor(() => document.querySelector('.account-button'), 'account button'));
    const popover = await waitFor(() => document.querySelector('.account-popover'), 'account popover');
    click(buttonByText('Workspace 관리', popover));
    const dialog = await waitFor(() => document.querySelector('.workspace-management-dialog'), 'Workspace management dialog');
    const section = dialog.querySelector('[aria-labelledby="delete-workspace-title"]');
    if (!normalized(section?.textContent).includes('secure erasure가 아닙니다')) {
      throw new Error('Workspace deletion did not disclose physical deletion limits.');
    }
    const password = section.querySelector('input[aria-label="Workspace 영구 삭제 현재 비밀번호"]');
    const name = section.querySelector('input[aria-label="영구 삭제할 Workspace 이름 확인"]');
    const confirmation = section.querySelector('input[aria-label="Workspace 영구 삭제 확인"]');
    const submit = buttonByText('영구 삭제 요청', section);
    setValue(password, input.password);
    setValue(name, input.workspace.name + '!');
    setValue(confirmation, 'DELETE WORKSPACE');
    if (!submit.disabled) throw new Error('Mismatched Workspace name enabled permanent deletion.');
    setValue(name, input.workspace.name);
    await waitFor(() => !submit.disabled, 'exact permanent deletion confirmation');
    click(submit);
    await waitFor(() => normalized(document.querySelector('#workspace-required-title')?.textContent)
      === '실행 가능한 workspace가 없습니다', 'workspace-free account shell');
    const context = await productMe(input.productOrigin);
    if (context.workspaces.length !== 0) throw new Error('Deleted Workspace remained visible in Product /me.');
    const denied = await fetch('/api/bootstrap', {
      credentials: 'include', cache: 'no-store',
      headers: { 'X-Kodex-Bootstrap': '1', 'X-Kodex-Workspace-Id': input.workspace.id },
    });
    if (denied.status !== 403) throw new Error('Deleted Workspace Local bootstrap was not denied.');
    return { mismatchedNameDisabled: true, localStatus: denied.status };
  })(${JSON.stringify(options)})`);
}

export async function runDesktopDataLifecycleAcceptance(window, rawOptions) {
  const options = inputOptions(rawOptions);
  const database = new Client({ connectionString: options.databaseUrl, ssl: false });
  try {
    await database.connect();
    const setup = await setupAndExport(window, options);
    const tenantRoot = path.join(
      options.dataRoot,
      'tenants',
      'users',
      setup.userId,
      'workspaces',
      setup.workspace.id,
    );
    await waitFor(() => exists(tenantRoot), 'exact Electron tenant root');
    const exportState = await database.query(
      `SELECT lifecycle_job.status, artifact.document::text AS document
       FROM data_lifecycle_jobs lifecycle_job
       JOIN data_export_artifacts artifact ON artifact.job_id = lifecycle_job.id
       WHERE lifecycle_job.kind = 'user_export' AND lifecycle_job.target_user_id = $1`,
      [setup.userId],
    );
    const exported = exportState.rows[0];
    if (!exported || exported.status !== 'completed') throw new Error('Renderer export was not durably completed.');
    for (const forbidden of [options.password, 'password_hash', 'token_hash', 'query_embedding', '"embedding"']) {
      if (exported.document.includes(forbidden)) throw new Error('Renderer export included forbidden secret or vector data.');
    }
    const deleted = await deleteWorkspace(window, { ...options, workspace: setup.workspace });
    if (!deleted?.mismatchedNameDisabled || deleted.localStatus !== 403) {
      throw new Error('Renderer permanent deletion returned incomplete boundary evidence.');
    }
    await waitFor(async () => {
      const result = await database.query(
        `SELECT lifecycle_job.status,
          (SELECT count(*)::int FROM data_lifecycle_local_targets target
           WHERE target.job_id = lifecycle_job.id AND target.status <> 'completed') AS incomplete_targets,
          (SELECT count(*)::int FROM workspaces workspace WHERE workspace.id = $1) AS workspace_count
         FROM data_lifecycle_jobs lifecycle_job
         WHERE lifecycle_job.kind = 'workspace_delete' AND lifecycle_job.target_workspace_id = $1`,
        [setup.workspace.id],
      );
      const row = result.rows[0];
      return row?.status === 'completed' && row.incomplete_targets === 0 && row.workspace_count === 0;
    }, 'durable Workspace deletion completion', 90_000);
    if (await exists(tenantRoot)) throw new Error('Exact Electron tenant root remained after completed deletion.');
  } catch (error) {
    await failureArtifacts(window, options.artifactDirectory).catch(() => undefined);
    let diagnostic = error instanceof Error ? error.message : String(error);
    for (const sensitive of [options.databaseUrl, options.displayName, options.email, options.password]) {
      diagnostic = diagnostic.replaceAll(sensitive, '[redacted]');
    }
    process.stderr.write(`Desktop data lifecycle acceptance diagnostic: ${diagnostic.slice(0, 500).replaceAll('\n', ' ')}\n`);
    throw error;
  } finally {
    await database.end().catch(() => undefined);
  }
}
