import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';

function capture(command, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} exited with ${code}`));
    });
  });
}

export async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

/**
 * Starts an isolated pgvector container without starting/stopping Docker Desktop itself.
 * The caller owns the returned cleanup and must invoke it from finally.
 */
export async function startIsolatedPostgres({ database, namePrefix }) {
  const containerName = `${namePrefix}-${randomUUID()}`;
  const port = await reserveLoopbackPort();
  const user = 'kodex';
  const password = 'kodex-test-only';
  let runAttempted = false;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (!runAttempted) return;
    await capture('docker', ['stop', '--time', '3', containerName], 15_000).catch(() => undefined);
    // A timed-out `docker run -d` may have created the container before its CLI
    // process returned. The UUID-scoped name makes this unconditional fallback safe.
    await capture('docker', ['rm', '--force', containerName], 15_000).catch(() => undefined);
  };
  try {
    await capture('docker', ['info', '--format', '{{.ServerVersion}}'], 15_000).catch(() => {
      throw new Error('Docker is not ready. Start Docker Desktop (or another Docker daemon) and retry.');
    });
    runAttempted = true;
    await capture('docker', [
      'run', '--rm', '-d', '--name', containerName,
      '-e', `POSTGRES_DB=${database}`,
      '-e', `POSTGRES_USER=${user}`,
      '-e', `POSTGRES_PASSWORD=${password}`,
      '-p', `127.0.0.1:${port}:5432`,
      'pgvector/pgvector:0.8.6-pg17',
    ], 60_000);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await capture('docker', ['exec', containerName, 'pg_isready', '-U', user, '-d', database], 5_000);
        return {
          containerName,
          databaseUrl: `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`,
          port,
          stop,
        };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error(`Temporary PostgreSQL container did not become ready within 30 seconds (${containerName}).`);
  } catch (error) {
    await stop();
    throw error;
  }
}
