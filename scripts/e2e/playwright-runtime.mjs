import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import process from 'node:process';

export const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/**
 * Binds the HTTP socket before preparing Next.js, so free-port allocation remains reserved for the
 * full run. Both generic and secure runners use this exact non-secret compiler/server lifecycle.
 */
export async function startIsolatedNextServer(
  run,
  outputDir,
  reportDir,
  { requestErrorReporter = defaultNextRequestErrorReporter } = {},
) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, 'localhost', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not resolve the isolated Playwright server port.');
  }

  const port = address.port;
  Object.assign(process.env, {
    AUTH_SECRET: process.env.AUTH_SECRET ?? 'playwright-local-auth-secret',
    WAPTIONS_E2E_PORT: String(port),
    WAPTIONS_E2E_RUN_ID: run.runId,
    WAPTIONS_E2E_OUTPUT_DIR: outputDir,
    WAPTIONS_E2E_REPORT_DIR: reportDir,
    WAPTIONS_NEXT_DIST_DIR: run.distDir,
    WAPTIONS_TSCONFIG_PATH: run.tsconfigPath,
  });

  let app;
  try {
    const next = (await import('next')).default;
    app = next({ dev: true, dir: process.cwd(), hostname: 'localhost', port });
    await app.prepare();
    const requestHandler = app.getRequestHandler();
    const upgradeHandler = app.getUpgradeHandler();
    server.on('request', (request, response) => {
      void requestHandler(request, response).catch((error) => {
        requestErrorReporter(error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    server.on('upgrade', (request, socket, head) => {
      void upgradeHandler(request, socket, head).catch(() => socket.destroy());
    });
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    await app?.close();
    throw error;
  }

  return {
    port,
    async close() {
      try {
        await app.close();
      } finally {
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    },
  };
}

/** Preserves the generic runner's existing full Error-object diagnostics. */
export function defaultNextRequestErrorReporter(error, logger = console.error) {
  logger('The isolated Next.js request handler failed.', error);
}

/**
 * Creates a reporter for secret-bearing secure runs. Request errors can include form values or
 * temporary paths, so this callback deliberately emits no Error fields before artifact inspection.
 */
export function createGenericNextRequestErrorReporter(
  write = (message) => process.stderr.write(message),
) {
  return () => write('The isolated Next.js request handler failed.\n');
}

/** Spawns Playwright without a shell; callers choose inherited versus piped stdio explicitly. */
export function spawnPlaywright({ args, environment, stdio = 'inherit' }) {
  return spawn(
    pnpmExecutable,
    ['exec', 'playwright', 'test', ...args],
    {
      cwd: process.cwd(),
      env: environment,
      stdio,
      shell: false,
      detached: process.platform !== 'win32',
    },
  );
}
