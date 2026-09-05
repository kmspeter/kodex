import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  activateWindowsInstallerRelease,
  confirmWindowsInstallerRelease,
  createExternalWindowsAclAdapter,
  planWindowsInstallerUpdate,
  planWindowsUninstallCodeBoundary,
  recoverWindowsInstaller,
  rollbackWindowsInstallerRelease,
  stageWindowsInstallerCandidate,
  WindowsInstallerError,
  windowsInstallerStatus,
} from './lib/windows-installer.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: kodex-installer <plan|stage|activate|confirm|rollback|recover|status|uninstall-code-boundary> [strict command options]';

function parseFlags(values) {
  const flags = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (
      typeof flag !== 'string'
      || !/^--[a-z-]+$/u.test(flag)
      || flags.has(flag)
      || typeof value !== 'string'
      || !value
      || value.startsWith('--')
    ) throw new Error(USAGE);
    flags.set(flag, value);
  }
  return flags;
}

function exactFlags(flags, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  if (!required.every((name) => flags.has(name)) || [...flags.keys()].some((name) => !allowed.has(name))) {
    throw new Error(USAGE);
  }
}

function absoluteFlag(flags, name) {
  const value = flags.get(name);
  if (!path.isAbsolute(value)) throw new Error(USAGE);
  return path.resolve(value);
}

function positiveInteger(value) {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(USAGE);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(USAGE);
  return parsed;
}

function commonOptions(flags) {
  const configuredRoot = flags.get('--install-root');
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const installRoot = configuredRoot
    ? absoluteFlag(flags, '--install-root')
    : localAppData ? path.join(path.resolve(localAppData), 'Programs', 'Kodex') : null;
  if (!installRoot) throw new Error(USAGE);
  return {
    installRoot,
    layoutPath: flags.has('--layout')
      ? absoluteFlag(flags, '--layout')
      : path.join(repositoryRoot, 'config', 'windows-installer-layout.json'),
  };
}

async function aclOptions(flags) {
  return { aclAdapter: await createExternalWindowsAclAdapter(absoluteFlag(flags, '--acl-adapter')) };
}

async function commandArguments(values) {
  const [command, ...rest] = values;
  const flags = parseFlags(rest);
  const commonOptional = ['--install-root', '--layout'];
  if (command === 'plan' || command === 'stage') {
    exactFlags(flags, ['--candidate', '--trust-store', '--acl-adapter'], commonOptional);
    return {
      command,
      options: {
        ...commonOptions(flags),
        ...await aclOptions(flags),
        candidate: absoluteFlag(flags, '--candidate'),
        trustStorePath: absoluteFlag(flags, '--trust-store'),
      },
    };
  }
  if (command === 'activate') {
    exactFlags(flags, ['--release', '--trust-store', '--acl-adapter'], commonOptional);
    return {
      command,
      options: {
        ...commonOptions(flags),
        ...await aclOptions(flags),
        releaseId: flags.get('--release'),
        trustStorePath: absoluteFlag(flags, '--trust-store'),
      },
    };
  }
  if (command === 'confirm') {
    exactFlags(flags, ['--release', '--database-schema', '--trust-store', '--acl-adapter'], commonOptional);
    return {
      command,
      options: {
        ...commonOptions(flags),
        ...await aclOptions(flags),
        databaseSchemaVersion: positiveInteger(flags.get('--database-schema')),
        releaseId: flags.get('--release'),
        trustStorePath: absoluteFlag(flags, '--trust-store'),
      },
    };
  }
  if (command === 'rollback') {
    exactFlags(flags, ['--trust-store', '--acl-adapter'], [...commonOptional, '--database-schema']);
    return {
      command,
      options: {
        ...commonOptions(flags),
        ...await aclOptions(flags),
        databaseSchemaVersion: flags.has('--database-schema')
          ? positiveInteger(flags.get('--database-schema'))
          : undefined,
        trustStorePath: absoluteFlag(flags, '--trust-store'),
      },
    };
  }
  if (command === 'recover') {
    exactFlags(flags, ['--trust-store', '--acl-adapter'], commonOptional);
    return {
      command,
      options: {
        ...commonOptions(flags),
        ...await aclOptions(flags),
        trustStorePath: absoluteFlag(flags, '--trust-store'),
      },
    };
  }
  if (command === 'status') {
    exactFlags(flags, [], commonOptional);
    return { command, options: commonOptions(flags) };
  }
  if (command === 'uninstall-code-boundary') {
    exactFlags(flags, ['--acl-adapter'], commonOptional);
    return { command, options: { ...commonOptions(flags), ...await aclOptions(flags) } };
  }
  throw new Error(USAGE);
}

async function main() {
  const parsed = await commandArguments(process.argv.slice(2));
  let result;
  switch (parsed.command) {
    case 'plan': result = await planWindowsInstallerUpdate(parsed.options); break;
    case 'stage': result = await stageWindowsInstallerCandidate(parsed.options); break;
    case 'activate': result = await activateWindowsInstallerRelease(parsed.options); break;
    case 'confirm': result = await confirmWindowsInstallerRelease(parsed.options); break;
    case 'rollback': result = await rollbackWindowsInstallerRelease(parsed.options); break;
    case 'recover': result = await recoverWindowsInstaller(parsed.options); break;
    case 'status': result = await windowsInstallerStatus(parsed.options); break;
    case 'uninstall-code-boundary': result = await planWindowsUninstallCodeBoundary(parsed.options); break;
    default: throw new Error(USAGE);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const code = error instanceof WindowsInstallerError ? error.code : error?.message === USAGE ? 'invalid_arguments' : 'installer_failed';
  process.stderr.write(`${JSON.stringify({ kind: 'kodex_windows_installer_error', code })}\n`);
  process.exitCode = 1;
});
