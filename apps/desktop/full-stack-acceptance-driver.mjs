import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';

const EXPECTED_ASSISTANT_MARKER = 'local stream ok';
const EXPECTED_TOOL_MARKER = 'kodex-loopback-tool';

function acceptanceInput(options) {
  for (const [name, value] of Object.entries(options)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Desktop full-stack acceptance is missing ${name}.`);
    }
  }
  const fixture = new URL(options.fixtureBaseUrl);
  if (fixture.protocol !== 'http:' || fixture.hostname !== '127.0.0.1' || !fixture.pathname.endsWith('/v1')) {
    throw new Error('Desktop full-stack acceptance fixture must be an exact loopback HTTP /v1 endpoint.');
  }
  return { ...options, fixtureBaseUrl: fixture.toString().replace(/\/$/u, '') };
}

async function writeFailureArtifacts(window, artifactDirectory) {
  if (typeof artifactDirectory !== 'string' || !path.isAbsolute(artifactDirectory)) return;
  await mkdir(artifactDirectory, { recursive: true });
  const redactionStyleId = 'kodex-acceptance-artifact-redaction';
  await window.webContents.executeJavaScript(`(() => {
    const style = document.createElement('style');
    style.id = ${JSON.stringify(redactionStyleId)};
    style.textContent = 'input,textarea,pre,code,.message-text,.account-summary{color:transparent!important;text-shadow:none!important}';
    document.head.append(style);
  })()`).catch(() => undefined);
  await window.webContents.capturePage().then((image) => writeFile(
    path.join(artifactDirectory, 'renderer-failure.png'),
    image.toPNG(),
  )).catch(() => undefined);
  const structure = await window.webContents.executeJavaScript(`(() => {
    const allowedText = new Set([
      'Kodex에 로그인', 'Kodex 계정 만들기', 'Settings', 'Agent',
      '저장된 DB 히스토리', 'What would you like Kodex to build?'
    ]);
    const headings = [...document.querySelectorAll('h1,h2,h3')]
      .map((node) => node.textContent?.trim())
      .filter((value) => value && allowedText.has(value));
    return {
      origin: location.origin,
      bodyClass: document.body.className,
      headings,
      counts: {
        buttons: document.querySelectorAll('button').length,
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        forms: document.querySelectorAll('form').length,
        inputs: document.querySelectorAll('input,select,textarea').length,
      },
      controls: [...document.querySelectorAll('input,select,textarea')].map((node) => ({
        tag: node.tagName.toLowerCase(),
        name: node.getAttribute('name'),
        type: node.getAttribute('type'),
        disabled: node.hasAttribute('disabled'),
      })),
    };
  })()`);
  await writeFile(
    path.join(artifactDirectory, 'renderer-structure.json'),
    `${JSON.stringify(structure, null, 2)}\n`,
    'utf8',
  );
  await window.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(redactionStyleId)})?.remove()`)
    .catch(() => undefined);
}

/**
 * Drives only public renderer DOM controls. This module is dynamically imported
 * by the explicit --full-stack-acceptance path and is absent from normal startup.
 */
export async function runDesktopFullStackAcceptance(window, rawOptions) {
  const options = acceptanceInput(rawOptions);
  try {
    const result = await window.webContents.executeJavaScript(`(async (input) => {
      const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const normalized = (value) => String(value ?? '').replace(/\\s+/gu, ' ').trim();
      const deadlineFor = (milliseconds) => Date.now() + milliseconds;

      async function waitFor(read, description, milliseconds = 20_000) {
        const deadline = deadlineFor(milliseconds);
        while (Date.now() < deadline) {
          const value = read();
          if (value) return value;
          await delay(50);
        }
        throw new Error('Timed out waiting for ' + description + '.');
      }

      async function waitForDialogAction(dialog, description, milliseconds = 20_000) {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await waitFor(() => dialog.getAttribute('aria-busy') === 'false', description, milliseconds);
      }

      function buttons() {
        return [...document.querySelectorAll('button')];
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

      await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex에 로그인', 'login shell');
      const registerTab = buttons().find((button) => button.getAttribute('role') === 'tab' && normalized(button.textContent) === '회원가입');
      click(registerTab);
      await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex 계정 만들기', 'registration form');
      setValue(inputByLabel('표시 이름'), input.displayName);
      setValue(inputByLabel('이메일'), input.email);
      setValue(inputByLabel('비밀번호'), input.password);
      click(buttonByText('계정 만들기'));

      await waitFor(() => document.querySelector('.app-shell'), 'authenticated product workspace', 30_000);
      await waitFor(() => [...document.querySelectorAll('.account-button span')]
        .some((node) => normalized(node.textContent) === input.displayName), 'registered user name');
      const accountButton = await waitFor(() => document.querySelector('.account-button'), 'account menu');
      if (!normalized(accountButton.getAttribute('aria-label')).includes('workspace')) {
        throw new Error('The authenticated shell did not expose its current workspace label.');
      }

      click(buttonByText('Settings'));
      const settingsDialog = await waitFor(() => document.querySelector('[role="dialog"]'), 'Settings dialog');
      click(buttonByText('Agent', settingsDialog));
      const provider = await waitFor(() => settingsDialog.querySelector('select[aria-label="Model provider"]'), 'provider selector');
      setValue(provider, 'local');
      const baseUrl = await waitFor(() => settingsDialog.querySelector('input[aria-label="Local Responses API base URL"]'), 'local provider base URL');
      const model = await waitFor(() => settingsDialog.querySelector('input[aria-label="Local model name"]'), 'local model');
      setValue(baseUrl, input.fixtureBaseUrl);
      setValue(model, 'kodex-loopback-model');
      setValue(settingsDialog.querySelector('select[aria-label="Sandbox policy"]'), 'danger-full-access');
      await waitForDialogAction(settingsDialog, 'sandbox setting save');
      setValue(settingsDialog.querySelector('select[aria-label="Approval policy"]'), 'never');
      await waitForDialogAction(settingsDialog, 'approval setting save');
      click(await waitFor(() => buttonByText('Apply provider and restart App Server', settingsDialog), 'provider apply action'));
      await waitForDialogAction(settingsDialog, 'provider restart completion', 30_000);
      click(buttonByLabel('Close', settingsDialog));

      const composer = await waitFor(() => {
        const candidate = document.querySelector('textarea[aria-label="Message"]');
        return candidate && !candidate.disabled ? candidate : null;
      }, 'enabled message composer', 30_000);
      setValue(composer, 'Run the deterministic desktop acceptance tool and report completion.');
      click(buttonByLabel('Send message'));
      await waitFor(() => normalized(document.body.innerText).includes(input.assistantMarker), 'assistant result', 60_000);
      await waitFor(() => normalized(document.body.innerText).includes(input.toolMarker), 'tool result marker', 30_000);

      click(buttonByText('저장된 DB 히스토리'));
      const historyDialog = await waitFor(() => document.querySelector('.history-dialog[role="dialog"]'), 'Saved DB History dialog');
      const list = await waitFor(() => historyDialog.querySelector('[aria-label="저장된 DB 히스토리 목록"]'), 'Saved DB History list');
      const historyDeadline = deadlineFor(30_000);
      let historyThread = null;
      while (Date.now() < historyDeadline) {
        historyThread = list.querySelector('.saved-history-thread');
        if (historyThread) break;
        const refresh = buttonByLabel('목록 다시 시도', historyDialog);
        if (refresh && !refresh.disabled) click(refresh);
        await delay(200);
      }
      if (!historyThread) throw new Error('Saved DB History did not display the new thread.');
      click(historyThread);
      const detail = await waitFor(() => {
        const candidate = historyDialog.querySelector('[aria-label="저장된 DB 히스토리 상세"]');
        const text = normalized(candidate?.innerText);
        return text.includes(input.assistantMarker) && text.includes(input.toolMarker) && text.includes('completed')
          ? candidate
          : null;
      }, 'Saved DB History assistant and tool projection', 30_000);
      if (!detail.querySelector('.saved-history-turn')) {
        throw new Error('Saved DB History did not expose the projected turn.');
      }

      click(buttonByLabel('Close', historyDialog));
      click(await waitFor(() => document.querySelector('.account-button'), 'account menu after history'));
      const accountPopover = await waitFor(() => document.querySelector('.account-popover'), 'account popover');
      if (
        !normalized(accountPopover.textContent).includes('현재 runtime workspace')
        || !normalized(accountPopover.querySelector('.account-workspace strong')?.textContent)
      ) {
        throw new Error('The account menu did not show the current workspace label.');
      }
      click(buttonByText('로그아웃', accountPopover));
      await waitFor(() => normalized(document.querySelector('#auth-title')?.textContent) === 'Kodex에 로그인', 'post-logout login shell', 20_000);
      if (document.querySelector('.app-shell') || document.querySelector('.account-button')) {
        throw new Error('Authenticated runtime UI remained mounted after logout.');
      }
      return { authenticatedShell: true, historyProjection: true, loggedOut: true };
    })(${JSON.stringify({
      assistantMarker: EXPECTED_ASSISTANT_MARKER,
      displayName: options.displayName,
      email: options.email,
      fixtureBaseUrl: options.fixtureBaseUrl,
      password: options.password,
      toolMarker: EXPECTED_TOOL_MARKER,
    })})`);
    if (!result?.authenticatedShell || !result.historyProjection || !result.loggedOut) {
      throw new Error('Desktop full-stack acceptance returned an incomplete renderer result.');
    }
  } catch (error) {
    await writeFailureArtifacts(window, options.artifactDirectory).catch(() => undefined);
    throw error;
  }
}
