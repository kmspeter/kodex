import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { Client } from 'pg';

const PROJECT_NAME = 'Repository Acceptance Fixture';
const REPOSITORY_PATH = 'docs/repository-note.md';
const REPOSITORY_TITLE = `${PROJECT_NAME} / ${REPOSITORY_PATH}`;
const REPOSITORY_MARKER = 'REPOSITORY_ACCEPTANCE_ALPHA';
const MANUAL_TITLE = 'Manual acceptance knowledge';
const MANUAL_MARKER = 'MANUAL_KNOWLEDGE_BRAVO';
const FOREIGN_MARKER = 'FOREIGN_TENANT_CHARLIE';
const SAFE_AGENT_CITATION = `repository citation: ${REPOSITORY_TITLE}`;
const FORBIDDEN_MARKERS = [
  'IGNORED_FILE_SECRET_DO_NOT_INDEX',
  'ENV_SECRET_DO_NOT_INDEX',
  'SSH_PRIVATE_SECRET_DO_NOT_INDEX',
];

function acceptanceInput(options) {
  for (const [name, value] of Object.entries(options)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Desktop repository RAG acceptance is missing ${name}.`);
    }
  }
  const fixture = new URL(options.fixtureBaseUrl);
  const product = new URL(options.productOrigin);
  const local = new URL(options.localOrigin);
  const database = new URL(options.databaseUrl);
  if (fixture.protocol !== 'http:' || fixture.hostname !== '127.0.0.1' || !fixture.pathname.endsWith('/v1')) {
    throw new Error('Desktop repository RAG fixture must be an exact loopback HTTP /v1 endpoint.');
  }
  if (
    product.protocol !== 'http:' || product.hostname !== '127.0.0.1' || product.pathname !== '/'
    || local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.pathname !== '/'
  ) {
    throw new Error('Desktop repository RAG services must use exact loopback HTTP origins.');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !['127.0.0.1', 'localhost'].includes(database.hostname)) {
    throw new Error('Desktop repository RAG database must be a loopback PostgreSQL fixture.');
  }
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const sourceFile = path.resolve(options.sourceFile);
  const relativeSource = path.relative(repositoryRoot, sourceFile);
  if (
    !path.isAbsolute(options.repositoryRoot)
    || !path.isAbsolute(options.sourceFile)
    || relativeSource !== path.join('docs', 'repository-note.md')
  ) {
    throw new Error('Desktop repository RAG source file must be the owned fixture document.');
  }
  return {
    ...options,
    fixtureBaseUrl: fixture.toString().replace(/\/$/u, ''),
    localOrigin: local.origin,
    productOrigin: product.origin,
    repositoryRoot,
    sourceFile,
  };
}

async function writeFailureArtifacts(window, artifactDirectory) {
  if (typeof artifactDirectory !== 'string' || !path.isAbsolute(artifactDirectory)) return;
  await mkdir(artifactDirectory, { recursive: true });
  const redactionStyleId = 'kodex-repository-rag-acceptance-redaction';
  await window.webContents.executeJavaScript(`(() => {
    const style = document.createElement('style');
    style.id = ${JSON.stringify(redactionStyleId)};
    style.textContent = 'body *{color:transparent!important;text-shadow:none!important;-webkit-text-fill-color:transparent!important}';
    document.head.append(style);
  })()`).catch(() => undefined);
  await window.webContents.capturePage().then((image) => writeFile(
    path.join(artifactDirectory, 'repository-rag-renderer-failure.png'), image.toPNG(),
  )).catch(() => undefined);
  const structure = await window.webContents.executeJavaScript(`(() => ({
    origin: location.origin,
    bodyClass: document.body.className,
    headings: [...document.querySelectorAll('h1,h2,h3,h4')]
      .map((node) => node.textContent?.trim())
      .filter((value) => ['Kodex에 로그인', 'Kodex 계정 만들기', 'Knowledge / RAG', '현재 project 파일 인덱싱'].includes(value)),
    counts: {
      buttons: document.querySelectorAll('button').length,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      forms: document.querySelectorAll('form').length,
      inputs: document.querySelectorAll('input,select,textarea').length,
      repositoryCandidates: document.querySelectorAll('.repository-file-list label').length,
      knowledgeRows: document.querySelectorAll('.knowledge-row').length,
    },
  }))()`);
  await writeFile(
    path.join(artifactDirectory, 'repository-rag-renderer-structure.json'),
    `${JSON.stringify(structure, null, 2)}\n`, 'utf8',
  );
  await window.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(redactionStyleId)})?.remove()`)
    .catch(() => undefined);
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
  async function waitForDialogAction(dialog, description, milliseconds = 30_000) {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await waitFor(() => dialog.getAttribute('aria-busy') === 'false', description, milliseconds);
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
      : control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
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
  async function openKnowledge() {
    click(buttonByText('Knowledge / RAG'));
    return waitFor(() => document.querySelector('.knowledge-dialog'), 'Knowledge / RAG dialog');
  }
  function candidateCheckbox(dialog, relativePath) {
    return [...dialog.querySelectorAll('.repository-file-list label')]
      .find((label) => label.querySelector('span')?.getAttribute('title') === relativePath)
      ?.querySelector('input[type="checkbox"]') ?? null;
  }
  async function indexRepository(dialog, relativePath, expectedIndexed, expectedUnchanged) {
    click(buttonByText('후보 파일 확인', dialog) ?? buttonByText('후보 다시 확인', dialog));
    const candidateList = await waitFor(() => dialog.querySelector('[aria-label="Repository candidate files"]'), 'repository preview');
    await waitFor(() => candidateCheckbox(dialog, relativePath), 'selected repository candidate');
    const candidatePaths = [...candidateList.querySelectorAll('span[title]')].map((node) => node.getAttribute('title'));
    if (!candidatePaths.includes(relativePath)) throw new Error('The safe repository document was not a preview candidate.');
    if (candidatePaths.some((entry) => entry === '.env' || entry?.startsWith('.ssh/') || entry?.startsWith('ignored/') || entry?.endsWith('.ignored.txt'))) {
      throw new Error('The repository preview exposed ignored or secret paths.');
    }
    const exclusionText = normalized(dialog.querySelector('[aria-label="제외 요약"]')?.textContent);
    if (!exclusionText.includes('git_ignored') || !exclusionText.includes('credential_or_secret')) {
      throw new Error('The repository preview did not report both ignore and secret exclusions.');
    }
    const indexButton = buttonByText('선택 파일 인덱싱', dialog);
    if (!indexButton?.disabled) throw new Error('Repository indexing was enabled before selection and consent.');
    click(candidateCheckbox(dialog, relativePath));
    if (!indexButton.disabled) throw new Error('Repository indexing was enabled before explicit consent.');
    const consent = dialog.querySelector('.repository-consent input[type="checkbox"]');
    click(consent);
    if (indexButton.disabled) throw new Error('Repository indexing did not enable after explicit consent.');
    click(indexButton);
    const result = await waitFor(() => {
      const candidate = dialog.querySelector('.repository-result');
      const text = normalized(candidate?.textContent);
      return text.includes('저장/갱신 ' + expectedIndexed + '개 · 변경 없음 ' + expectedUnchanged + '개')
        && text.includes(relativePath) ? candidate : null;
    }, 'repository index result', 45_000);
    return normalized(result.textContent);
  }
`;

async function registerConfigureAndIndex(window, input) {
  return window.webContents.executeJavaScript(`(async (input) => {
    ${DOM_HELPERS}
    await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex에 로그인', 'login shell');
    const registerTab = [...document.querySelectorAll('button')]
      .find((button) => button.getAttribute('role') === 'tab' && normalized(button.textContent) === '회원가입');
    click(registerTab);
    await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex 계정 만들기', 'registration form');
    setValue(inputByLabel('표시 이름'), input.displayName);
    setValue(inputByLabel('이메일'), input.email);
    setValue(inputByLabel('비밀번호'), input.password);
    click(buttonByText('계정 만들기'));
    await waitFor(() => document.querySelector('.app-shell'), 'authenticated product workspace', 30_000);

    click(buttonByText('Settings'));
    const settingsDialog = await waitFor(() => document.querySelector('[role="dialog"]'), 'Settings dialog');
    click(await waitFor(() => buttonByLabel('Browse for project directory', settingsDialog), 'project directory IPC action'));
    await waitFor(() => settingsDialog.querySelector('input[aria-label="Absolute project path"]')?.value === input.repositoryRoot, 'preload-selected project path');
    setValue(settingsDialog.querySelector('input[aria-label="Optional project display name"]'), input.projectName);
    click(buttonByText('Add project', settingsDialog));
    await waitForDialogAction(settingsDialog, 'repository fixture project add');
    await waitFor(() => [...settingsDialog.querySelectorAll('.integration-row strong')]
      .some((node) => normalized(node.textContent) === input.projectName), 'repository fixture project row');

    click(buttonByText('Agent', settingsDialog));
    const provider = await waitFor(() => settingsDialog.querySelector('select[aria-label="Model provider"]'), 'provider selector');
    setValue(provider, 'local');
    setValue(await waitFor(() => settingsDialog.querySelector('input[aria-label="Local Responses API base URL"]'), 'local base URL'), input.fixtureBaseUrl);
    setValue(await waitFor(() => settingsDialog.querySelector('input[aria-label="Local model name"]'), 'local model'), 'kodex-repository-rag-loopback');
    setValue(settingsDialog.querySelector('select[aria-label="Sandbox policy"]'), 'read-only');
    await waitForDialogAction(settingsDialog, 'sandbox setting save');
    setValue(settingsDialog.querySelector('select[aria-label="Approval policy"]'), 'never');
    await waitForDialogAction(settingsDialog, 'approval setting save');
    click(await waitFor(() => buttonByText('Apply provider and restart App Server', settingsDialog), 'provider apply'));
    await waitForDialogAction(settingsDialog, 'provider restart completion', 30_000);
    click(buttonByLabel('Close', settingsDialog));

    const dialog = await openKnowledge();
    await waitFor(() => dialog.querySelector('.knowledge-list')?.getAttribute('aria-busy') === 'false', 'knowledge list');
    setValue(inputByLabel('문서 제목', dialog), input.manualTitle);
    setValue(inputByLabel('텍스트 원문', dialog), input.manualContent);
    click(buttonByText('문서 등록', dialog));
    await waitFor(() => [...dialog.querySelectorAll('.knowledge-row strong')]
      .some((node) => normalized(node.textContent) === input.manualTitle), 'manual knowledge row', 45_000);
    const result = await indexRepository(dialog, input.repositoryPath, 1, 0);
    await waitFor(() => [...dialog.querySelectorAll('.knowledge-row strong')]
      .some((node) => normalized(node.textContent) === input.repositoryTitle), 'repository knowledge row');
    const knowledgeText = normalized(dialog.innerText);
    if (knowledgeText.includes(input.repositoryRoot) || input.forbidden.some((marker) => knowledgeText.includes(marker))) {
      throw new Error('The Knowledge UI exposed an absolute path or excluded secret content.');
    }
    click(buttonByLabel('Close', dialog.closest('[role="dialog"]')));
    return { initialIndex: result };
  })(${JSON.stringify(input)})`);
}

async function reindex(window, expectedIndexed, expectedUnchanged) {
  return window.webContents.executeJavaScript(`(async (input) => {
    ${DOM_HELPERS}
    const dialog = await openKnowledge();
    await waitFor(() => dialog.querySelector('.knowledge-list')?.getAttribute('aria-busy') === 'false', 'knowledge list');
    const result = await indexRepository(dialog, input.repositoryPath, input.expectedIndexed, input.expectedUnchanged);
    click(buttonByLabel('Close', dialog.closest('[role="dialog"]')));
    return result;
  })(${JSON.stringify({ repositoryPath: REPOSITORY_PATH, expectedIndexed, expectedUnchanged })})`);
}

async function searchAndRunAgent(window, repositoryRoot) {
  return window.webContents.executeJavaScript(`(async (input) => {
    ${DOM_HELPERS}
    const dialog = await openKnowledge();
    await waitFor(() => dialog.querySelector('.knowledge-list')?.getAttribute('aria-busy') === 'false', 'knowledge list');
    const query = dialog.querySelector('input[aria-label="Knowledge 검색어"]');
    setValue(query, input.repositoryMarker);
    click(buttonByText('검색', dialog));
    const citation = await waitFor(() => [...dialog.querySelectorAll('.citation-row')].find((row) => (
      normalized(row.querySelector('strong')?.textContent) === input.repositoryTitle
      && normalized(row.querySelector('p')?.textContent).includes('changed repository version')
    )), 'safe repository search citation', 45_000);
    const citationText = normalized(citation.innerText);
    if (!citationText.includes(input.repositoryPath) || citationText.includes(input.repositoryRoot)
      || input.forbidden.some((marker) => citationText.includes(marker))) {
      throw new Error('The repository citation was unsafe.');
    }
    click(buttonByLabel('Close', dialog.closest('[role="dialog"]')));

    const composer = await waitFor(() => {
      const candidate = document.querySelector('textarea[aria-label="Message"]');
      return candidate && !candidate.disabled ? candidate : null;
    }, 'enabled message composer', 30_000);
    setValue(composer, input.repositoryMarker + '를 근거와 안전한 상대 경로 citation으로 답해줘.');
    click(buttonByLabel('Send message'));
    const conversation = await waitFor(() => {
      const candidate = document.querySelector('.conversation-inner');
      return normalized(candidate?.innerText).includes(input.safeAgentCitation) ? candidate : null;
    }, 'RAG-augmented assistant citation', 60_000);
    const conversationText = normalized(conversation.innerText);
    if (conversationText.includes(input.repositoryRoot) || input.forbidden.some((marker) => conversationText.includes(marker))) {
      throw new Error('The agent conversation exposed an absolute path or excluded secret content.');
    }
    return { agentCitation: input.safeAgentCitation, searchCitation: input.repositoryTitle };
  })(${JSON.stringify({
    forbidden: FORBIDDEN_MARKERS,
    repositoryMarker: REPOSITORY_MARKER,
    repositoryPath: REPOSITORY_PATH,
    repositoryRoot,
    repositoryTitle: REPOSITORY_TITLE,
    safeAgentCitation: SAFE_AGENT_CITATION,
  })})`);
}

async function verifyIdorBoundaries(window, input) {
  return window.webContents.executeJavaScript(`(async (input) => {
    ${DOM_HELPERS}
    const productOrigin = document.querySelector('meta[name="kodex-product-api-origin"]')?.content;
    if (productOrigin !== input.productOrigin) throw new Error('Product API origin mismatch.');
    const forbiddenWorkspace = await fetch(productOrigin + '/api/knowledge/documents?limit=5&workspace_id=' + input.foreignWorkspaceId, {
      credentials: 'include', cache: 'no-store',
      headers: { Accept: 'application/json', 'X-Kodex-Workspace-Id': input.foreignWorkspaceId },
    });
    if (forbiddenWorkspace.status !== 403) throw new Error('Foreign workspace list was not rejected with 403.');

    const csrf = document.cookie.split(';').map((entry) => entry.trim())
      .find((entry) => entry.startsWith('kodex_product_csrf='))?.split('=').slice(1).join('=');
    if (!csrf) throw new Error('Product CSRF proof was unavailable for the IDOR check.');
    const foreignDelete = await fetch(productOrigin + '/api/knowledge/documents/' + input.foreignDocumentId + '?workspace_id=' + input.workspaceId, {
      method: 'DELETE', credentials: 'include', cache: 'no-store',
      headers: {
        Accept: 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf),
        'X-Kodex-Workspace-Id': input.workspaceId,
      },
    });
    if (foreignDelete.status !== 404) throw new Error('Foreign document ID was not hidden with 404.');

    const bootstrapResponse = await fetch('/api/bootstrap', {
      credentials: 'include', cache: 'no-store',
      headers: { 'X-Kodex-Bootstrap': '1', 'X-Kodex-Workspace-Id': input.workspaceId },
    });
    if (!bootstrapResponse.ok) throw new Error('Local bootstrap failed during the project scope check.');
    const bootstrap = await bootstrapResponse.json();
    const previewResponse = await fetch('/api/knowledge/repository/preview', {
      method: 'POST', credentials: 'include', cache: 'no-store',
      headers: {
        'Content-Type': 'application/json', 'X-Kodex-CSRF': bootstrap.csrfToken,
        'X-Kodex-Session': bootstrap.sessionToken, 'X-Kodex-Workspace-Id': input.workspaceId,
      },
      body: JSON.stringify({ projectId: bootstrap.activeProject.id }),
    });
    if (!previewResponse.ok) throw new Error('Local preview failed during the project scope check.');
    const preview = await previewResponse.json();
    const tamperedConfirm = await fetch('/api/knowledge/repository/confirm', {
      method: 'POST', credentials: 'include', cache: 'no-store',
      headers: {
        'Content-Type': 'application/json', 'X-Kodex-CSRF': bootstrap.csrfToken,
        'X-Kodex-Session': bootstrap.sessionToken, 'X-Kodex-Workspace-Id': input.workspaceId,
      },
      body: JSON.stringify({
        previewToken: preview.previewToken,
        projectId: input.foreignProjectId,
        paths: [input.repositoryPath],
      }),
    });
    if (tamperedConfirm.status !== 409) throw new Error('A tampered project ID was not rejected with 409.');
    return { documentIdor: 404, projectBinding: 409, workspaceIsolation: 403 };
  })(${JSON.stringify(input)})`);
}

async function deleteAndVerify(window) {
  return window.webContents.executeJavaScript(`(async (input) => {
    ${DOM_HELPERS}
    const dialog = await openKnowledge();
    await waitFor(() => dialog.querySelector('.knowledge-list')?.getAttribute('aria-busy') === 'false', 'knowledge list');
    click(await waitFor(() => buttonByLabel(input.repositoryDeleteLabel, dialog), 'repository delete action'));
    await waitFor(() => ![...dialog.querySelectorAll('.knowledge-row strong')]
      .some((node) => normalized(node.textContent) === input.repositoryTitle), 'repository row deletion', 30_000);
    if (![...dialog.querySelectorAll('.knowledge-row strong')]
      .some((node) => normalized(node.textContent) === input.manualTitle)) {
      throw new Error('Manual knowledge disappeared after repository deletion.');
    }
    const query = dialog.querySelector('input[aria-label="Knowledge 검색어"]');
    setValue(query, input.repositoryMarker);
    click(buttonByText('검색', dialog));
    await waitFor(() => [...dialog.querySelectorAll('.dialog-empty')]
      .some((node) => normalized(node.textContent) === '기준 점수 이상의 검색 결과가 없습니다.'), 'empty repository search', 45_000);
    if (dialog.querySelector('.citation-row')) throw new Error('Deleted repository content remained searchable.');

    setValue(query, input.manualMarker);
    click(buttonByText('검색', dialog));
    await waitFor(() => [...dialog.querySelectorAll('.citation-row strong')]
      .some((node) => normalized(node.textContent) === input.manualTitle), 'manual knowledge search after delete', 45_000);
    const text = normalized(dialog.innerText);
    if (input.forbidden.some((marker) => text.includes(marker))) throw new Error('Excluded secret content appeared after deletion.');
    click(buttonByLabel('Close', dialog.closest('[role="dialog"]')));
    return { manualSurvived: true, repositorySearchEmpty: true };
  })(${JSON.stringify({
    forbidden: FORBIDDEN_MARKERS,
    manualMarker: MANUAL_MARKER,
    manualTitle: MANUAL_TITLE,
    repositoryDeleteLabel: `${REPOSITORY_TITLE} RAG에서 명시적으로 삭제`,
    repositoryMarker: REPOSITORY_MARKER,
    repositoryTitle: REPOSITORY_TITLE,
  })})`);
}

async function accountScope(client, email) {
  const result = await client.query(`
    SELECT account.id AS user_id, workspace.id AS workspace_id
    FROM users AS account
    JOIN workspaces AS workspace ON workspace.owner_user_id = account.id
    WHERE lower(account.email) = lower($1) AND account.deleted_at IS NULL AND workspace.deleted_at IS NULL
  `, [email]);
  if (result.rows.length !== 1) throw new Error(`Acceptance account scope was not unique for ${email}.`);
  return { userId: result.rows[0].user_id, workspaceId: result.rows[0].workspace_id };
}

async function repositoryState(client, scope) {
  const result = await client.query(`
    SELECT document.id, document.source_id, document.source_document_id, document.title,
           document.content_text, encode(document.content_checksum, 'hex') AS checksum,
           document.updated_at,
           array_agg(chunk.id ORDER BY chunk.chunk_index) AS chunk_ids,
           array_agg(chunk.content ORDER BY chunk.chunk_index) AS chunks,
           array_agg(chunk.embedding_model ORDER BY chunk.chunk_index) AS embedding_models,
           array_agg(chunk.embedding_dimensions ORDER BY chunk.chunk_index) AS embedding_dimensions,
           bool_and(chunk.embedding IS NOT NULL) AS embeddings_stored,
           source.external_key, source.source_type
    FROM documents AS document
    JOIN knowledge_sources AS source
      ON source.id = document.source_id
     AND source.workspace_id = document.workspace_id
     AND source.created_by_user_id = document.created_by_user_id
    JOIN document_chunks AS chunk
      ON chunk.document_id = document.id
     AND chunk.workspace_id = document.workspace_id
     AND chunk.created_by_user_id = document.created_by_user_id
    WHERE document.workspace_id = $1 AND document.created_by_user_id = $2
      AND source.source_type = 'repository_file'
    GROUP BY document.id, source.id
  `, [scope.workspaceId, scope.userId]);
  if (result.rows.length !== 1) throw new Error(`Expected one repository document, received ${result.rows.length}.`);
  return result.rows[0];
}

async function assertSafeDatabase(client, scope, repositoryRoot) {
  const result = await client.query(`
    SELECT concat_ws(E'\\n', source.name, source.external_key, document.title, document.source_document_id,
      document.content_text, chunk.content, citation.quoted_text, citation.metadata::text) AS searchable
    FROM knowledge_sources AS source
    JOIN documents AS document
      ON document.source_id = source.id
     AND document.workspace_id = source.workspace_id
     AND document.created_by_user_id = source.created_by_user_id
    JOIN document_chunks AS chunk
      ON chunk.document_id = document.id
     AND chunk.workspace_id = document.workspace_id
     AND chunk.created_by_user_id = document.created_by_user_id
    LEFT JOIN retrieval_citations AS citation
      ON citation.chunk_id = chunk.id
     AND citation.workspace_id = chunk.workspace_id
     AND citation.created_by_user_id = chunk.created_by_user_id
    WHERE document.workspace_id = $1 AND document.created_by_user_id = $2
  `, [scope.workspaceId, scope.userId]);
  const serialized = result.rows.map((row) => row.searchable).join('\n');
  if (serialized.toLowerCase().includes(repositoryRoot.toLowerCase())) {
    throw new Error('PostgreSQL RAG records exposed the absolute repository fixture path.');
  }
  for (const marker of FORBIDDEN_MARKERS) {
    if (serialized.includes(marker)) throw new Error(`PostgreSQL RAG records exposed excluded content: ${marker}`);
  }
}

function cookieHeader(response) {
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  return setCookies.map((entry) => entry.split(';', 1)[0]).join('; ');
}

async function createForeignKnowledge(options) {
  const registration = await globalThis.fetch(`${options.productOrigin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: options.localOrigin },
    body: JSON.stringify({
      displayName: 'Foreign Repository RAG User',
      email: options.foreignEmail,
      password: options.foreignPassword,
    }),
  });
  if (registration.status !== 201) throw new Error(`Foreign account registration failed with ${registration.status}.`);
  const cookies = cookieHeader(registration);
  const body = await registration.json();
  const workspaceId = body.defaultWorkspace?.id;
  if (!workspaceId || !body.csrfToken || !cookies.includes('kodex_product_session=')) {
    throw new Error('Foreign account registration did not return its private scope.');
  }
  const documentId = randomUUID();
  const created = await globalThis.fetch(`${options.productOrigin}/api/knowledge/documents?workspace_id=${workspaceId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Cookie: cookies, Origin: options.localOrigin,
      'X-CSRF-Token': body.csrfToken, 'X-Kodex-Workspace-Id': workspaceId,
    },
    body: JSON.stringify({
      documentId,
      title: 'Foreign private knowledge',
      content: `${FOREIGN_MARKER} must remain isolated from the primary tenant.`,
    }),
  });
  if (created.status !== 200) throw new Error(`Foreign knowledge creation failed with ${created.status}.`);
  return { documentId, workspaceId };
}

function sameIds(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Drives the consent flow only through renderer DOM controls, then cross-checks DB/API boundaries. */
export async function runDesktopRepositoryRagAcceptance(window, rawOptions) {
  const options = acceptanceInput(rawOptions);
  const database = new Client({ connectionString: options.databaseUrl, ssl: false });
  try {
    await database.connect();
    await registerConfigureAndIndex(window, {
      displayName: options.displayName,
      email: options.email,
      fixtureBaseUrl: options.fixtureBaseUrl,
      forbidden: FORBIDDEN_MARKERS,
      manualContent: `${MANUAL_MARKER} manual knowledge must survive repository deletion.`,
      manualTitle: MANUAL_TITLE,
      password: options.password,
      projectName: PROJECT_NAME,
      repositoryPath: REPOSITORY_PATH,
      repositoryRoot: options.repositoryRoot,
      repositoryTitle: REPOSITORY_TITLE,
    });
    const primaryScope = await accountScope(database, options.email);
    const initial = await repositoryState(database, primaryScope);
    if (
      initial.source_document_id !== REPOSITORY_PATH
      || initial.title !== REPOSITORY_TITLE
      || initial.source_type !== 'repository_file'
      || !initial.content_text.includes('initial repository version')
      || initial.chunks.length < 1
      || !initial.embeddings_stored
      || initial.embedding_models.some((model) => model !== 'kodex-acceptance-embedding-v1')
      || initial.embedding_dimensions.some((dimensions) => dimensions !== 3)
      || !String(initial.external_key).startsWith('repository:')
    ) throw new Error('Initial repository document/chunk persistence was incomplete.');
    await assertSafeDatabase(database, primaryScope, options.repositoryRoot);

    await reindex(window, 0, 1);
    const unchanged = await repositoryState(database, primaryScope);
    if (
      unchanged.id !== initial.id || unchanged.source_id !== initial.source_id
      || unchanged.checksum !== initial.checksum || !sameIds(unchanged.chunk_ids, initial.chunk_ids)
    ) throw new Error('Unchanged repository reindex did not preserve its logical identity and chunks.');

    await writeFile(options.sourceFile, options.updatedContent, 'utf8');
    await reindex(window, 1, 0);
    const changed = await repositoryState(database, primaryScope);
    if (
      changed.id !== initial.id || changed.source_id !== initial.source_id
      || changed.checksum === initial.checksum || sameIds(changed.chunk_ids, initial.chunk_ids)
      || !changed.content_text.includes('changed repository version')
    ) throw new Error('Changed repository reindex did not replace chunks under the stable document identity.');

    await searchAndRunAgent(window, options.repositoryRoot);
    const citations = await database.query(`
      SELECT citation.id, citation.metadata, citation.quoted_text
      FROM retrieval_citations AS citation
      JOIN document_chunks AS chunk
        ON chunk.id = citation.chunk_id
       AND chunk.workspace_id = citation.workspace_id
       AND chunk.created_by_user_id = citation.created_by_user_id
      WHERE chunk.document_id = $1 AND citation.workspace_id = $2 AND citation.created_by_user_id = $3
    `, [changed.id, primaryScope.workspaceId, primaryScope.userId]);
    if (citations.rows.length < 1 || citations.rows.some((row) => row.metadata?.sourceType !== 'repository_file')) {
      throw new Error('Repository search/agent retrieval did not persist source-aware citations.');
    }
    await assertSafeDatabase(database, primaryScope, options.repositoryRoot);

    const foreign = await createForeignKnowledge(options);
    const foreignScope = await accountScope(database, options.foreignEmail);
    if (foreignScope.workspaceId !== foreign.workspaceId) throw new Error('Foreign workspace scope mismatch.');
    await verifyIdorBoundaries(window, {
      foreignDocumentId: foreign.documentId,
      foreignProjectId: randomUUID(),
      foreignWorkspaceId: foreign.workspaceId,
      productOrigin: options.productOrigin,
      repositoryPath: REPOSITORY_PATH,
      workspaceId: primaryScope.workspaceId,
    });
    const foreignStillExists = await database.query(
      'SELECT 1 FROM documents WHERE id = $1 AND workspace_id = $2 AND created_by_user_id = $3',
      [foreign.documentId, foreignScope.workspaceId, foreignScope.userId],
    );
    if (foreignStillExists.rowCount !== 1) throw new Error('The foreign document was changed by an IDOR attempt.');

    await deleteAndVerify(window);
    const afterDelete = await database.query(
      'SELECT 1 FROM documents WHERE id = $1 OR source_id = $2', [changed.id, changed.source_id],
    );
    if (afterDelete.rowCount !== 0) throw new Error('Explicit repository deletion did not remove the document/source contents.');
    const oldChunks = await database.query(
      'SELECT 1 FROM document_chunks WHERE id = ANY($1::uuid[])', [changed.chunk_ids],
    );
    const oldCitations = await database.query(
      'SELECT 1 FROM retrieval_citations WHERE chunk_id = ANY($1::uuid[])', [changed.chunk_ids],
    );
    if (oldChunks.rowCount !== 0 || oldCitations.rowCount !== 0) {
      throw new Error('Explicit repository deletion did not cascade chunks/citations.');
    }
    const manual = await database.query(`
      SELECT document.title, document.content_text, source.source_type
      FROM documents AS document
      JOIN knowledge_sources AS source ON source.id = document.source_id
      WHERE document.workspace_id = $1 AND document.created_by_user_id = $2
    `, [primaryScope.workspaceId, primaryScope.userId]);
    if (
      manual.rows.length !== 1 || manual.rows[0].title !== MANUAL_TITLE
      || manual.rows[0].source_type !== 'manual_text' || !manual.rows[0].content_text.includes(MANUAL_MARKER)
    ) throw new Error('Manual knowledge was not preserved after repository deletion.');
  } catch (error) {
    await writeFailureArtifacts(window, options.artifactDirectory).catch(() => undefined);
    const message = (error instanceof Error ? error.message : String(error))
      .replaceAll(options.repositoryRoot, '[repository-fixture]')
      .replaceAll(options.databaseUrl, '[database-url]')
      .slice(0, 1_000);
    process.stderr.write(`Repository RAG acceptance scenario failed: ${message}\n`);
    throw error;
  } finally {
    await database.end().catch(() => undefined);
  }
}
