import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

function assertWindowsRestrictedAcl(filename, name) {
  const windowsRoot = process.env.SystemRoot;
  if (typeof windowsRoot !== 'string' || !windowsRoot.trim()) {
    throw new Error(`${name} file ACL cannot be verified.`);
  }
  const powershell = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    "$ErrorActionPreference='Stop'",
    '$acl=Get-Acl -LiteralPath $args[0]',
    '$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    "$allowed=@($current,'S-1-5-18','S-1-5-32-544')",
    '$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value',
    'if(-not ($allowed -contains $owner)){exit 3}',
    '$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])',
    "foreach($rule in $rules){if($rule.AccessControlType -eq 'Allow' -and -not ($allowed -contains $rule.IdentityReference.Value)){exit 3}}",
    'exit 0',
  ].join(';');
  const inherited = Object.fromEntries([
    'ComSpec', 'PATH', 'PATHEXT', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR',
  ].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script, filename], {
    env: inherited,
    shell: false,
    stdio: 'ignore',
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`${name} file ACL is broad or could not be verified.`);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateSecretBytes(bytes, options) {
  if (!(bytes instanceof Uint8Array)) throw new Error(`${options.name} input is invalid.`);
  const value = Buffer.from(bytes);
  if (value.length < options.minimumBytes || value.length > options.maximumBytes) {
    value.fill(0);
    throw new Error(`${options.name} input is empty or outside the byte limit.`);
  }
  return value;
}

export async function readRestrictedSecretFile(filename, options) {
  if (typeof filename !== 'string' || !filename.trim()) throw new Error(`${options.name} file is required.`);
  const absolute = path.resolve(filename);
  const forbiddenRoots = options.forbiddenRoots ?? [];
  if (
    !Array.isArray(forbiddenRoots)
    || forbiddenRoots.length > 16
    || forbiddenRoots.some((root) => typeof root !== 'string' || !root.trim())
  ) throw new Error(`${options.name} forbidden roots are invalid.`);
  if (forbiddenRoots.some((root) => isWithin(path.resolve(root), absolute))) {
    throw new Error(`${options.name} file must remain outside protected roots.`);
  }
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch {
    throw new Error(`${options.name} file is missing or inaccessible.`);
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size < options.minimumBytes
    || metadata.size > options.maximumBytes
  ) throw new Error(`${options.name} file must be a bounded regular file, not a link.`);
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error(`${options.name} file permissions must not grant group or other access.`);
  }
  if (process.platform === 'win32') assertWindowsRestrictedAcl(absolute, options.name);
  let handle;
  try {
    const flags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    handle = await open(absolute, flags);
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.size !== metadata.size
      || opened.dev !== metadata.dev
      || opened.ino !== metadata.ino
      || (process.platform !== 'win32' && (opened.mode & 0o077) !== 0)
    ) throw new Error(`${options.name} file changed or is not a restricted regular file.`);
    const bytes = await handle.readFile();
    try {
      return validateSecretBytes(bytes, options);
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error(`${options.name} file must not be a symbolic link.`);
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function assertRestrictedDirectory(dirname, name = 'Restricted directory') {
  if (typeof dirname !== 'string' || !dirname.trim()) throw new Error(`${name} is required.`);
  const absolute = path.resolve(dirname);
  const metadata = await lstat(absolute).catch(() => {
    throw new Error(`${name} is missing or inaccessible.`);
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${name} must be a real directory, not a link.`);
  }
  if (process.platform === 'win32') assertWindowsRestrictedAcl(absolute, name);
  else if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`${name} permissions must not grant group or other access.`);
  }
  return absolute;
}

export async function readSecretPipe(stream, options) {
  if (!stream || stream.isTTY) throw new Error(`${options.name} stdin must be a non-interactive pipe.`);
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk);
      total += bytes.length;
      if (total > options.maximumBytes) {
        bytes.fill(0);
        throw new Error(`${options.name} stdin exceeds the byte limit.`);
      }
      chunks.push(bytes);
    }
    return validateSecretBytes(Buffer.concat(chunks, total), options);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

export function normalizeBackupPassphrase(bytes) {
  const value = Buffer.from(bytes);
  try {
    let end = value.length;
    if (end > 0 && value[end - 1] === 0x0a) {
      end -= 1;
      if (end > 0 && value[end - 1] === 0x0d) end -= 1;
    }
    const normalized = Buffer.from(value.subarray(0, end));
    if (
      normalized.length < 16
      || normalized.length > 4_096
      || normalized.includes(0)
      || normalized.includes(0x0a)
      || normalized.includes(0x0d)
    ) {
      normalized.fill(0);
      throw new Error('Backup passphrase must be one non-empty 16 to 4096 byte line.');
    }
    return normalized;
  } finally {
    value.fill(0);
  }
}
