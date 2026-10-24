import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp as nodeMkdtemp, rm as nodeRemove } from 'node:fs/promises';
import { createServer as nodeCreateServer } from 'node:net';
import { tmpdir as nodeTmpdir } from 'node:os';
import path from 'node:path';

export const RUNNER_VERSION = '0.1.0';
export const CDP_LOOPBACK_HOST = '127.0.0.1';
export const OWNER_APPROVAL_TOKEN = 'NEXARI_ISOLATED_CHROME_OWNER_APPROVED';

export class NexariCdpSelectorError extends Error {
  constructor() {
    super('Nexari CDP E2E requires VITE_RUNTIME_BACKEND=nexari.');
    this.name = 'NexariCdpSelectorError';
  }
}

export class NexariCdpApprovalRequiredError extends Error {
  constructor() {
    super('Launching isolated Chrome requires explicit Human Owner approval.');
    this.name = 'NexariCdpApprovalRequiredError';
  }
}

export class NexariCdpPortReservationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NexariCdpPortReservationError';
  }
}

/**
 * This runner is intentionally dependency-free. It is a lifecycle-safe harness
 * for a future browser proof, not evidence that a browser E2E has run. The
 * owner-approved execution path will use a new temporary Chrome profile and a
 * loopback-only CDP endpoint; importing this module starts nothing.
 */
/** @param {{ WebSocket?: unknown; fetch?: unknown }} [runtime] */
export function inspectCdpCapabilities(runtime = globalThis) {
  return {
    cdpWebSocket: typeof runtime.WebSocket === 'function',
    fetch: typeof runtime.fetch === 'function',
  };
}

export function resolveNexariSelector(env) {
  if (env?.VITE_RUNTIME_BACKEND !== 'nexari') {
    throw new NexariCdpSelectorError();
  }

  return 'nexari';
}

export async function createOwnedProfile(callback, options = {}) {
  const tempDirectory = options.tempDirectory ?? nodeTmpdir();
  const mkdtemp = options.mkdtemp ?? nodeMkdtemp;
  const remove = options.remove ?? ((directory) => nodeRemove(directory, { recursive: true, force: true }));
  const profileDirectory = await mkdtemp(path.join(tempDirectory, 'nexari-cdp-e2e-'));

  try {
    return await callback(profileDirectory);
  } finally {
    await remove(profileDirectory);
  }
}

function getReservedPort(address) {
  if (
    !address ||
    typeof address === 'string' ||
    address.address !== CDP_LOOPBACK_HOST ||
    !Number.isInteger(address.port)
  ) {
    throw new NexariCdpPortReservationError('CDP port reservation did not bind to the IPv4 loopback address.');
  }

  return address.port;
}

export async function acquireLoopbackPort(options = {}) {
  const createServer = options.createServer ?? nodeCreateServer;

  return new Promise((resolve, reject) => {
    const server = createServer();
    let settled = false;

    const finish = (callback) => {
      if (settled) {
        return;
      }

      settled = true;
      callback();
    };

    server.once('error', (error) => finish(() => reject(error)));
    server.listen({ host: CDP_LOOPBACK_HOST, port: 0 }, () => {
      let port;

      try {
        port = getReservedPort(server.address());
      } catch (error) {
        server.close(() => finish(() => reject(error)));
        return;
      }

      server.close((error) => {
        if (error) {
          finish(() => reject(error));
          return;
        }

        finish(() => resolve(port));
      });
    });
  });
}

export function buildChromeArgs({ profileDirectory, debugPort }) {
  if (!profileDirectory || !Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) {
    throw new TypeError('Chrome requires an owned profile directory and a valid CDP port.');
  }

  return [
    `--user-data-dir=${profileDirectory}`,
    `--remote-debugging-address=${CDP_LOOPBACK_HOST}`,
    `--remote-debugging-port=${debugPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
  ];
}

export function startNexariDevServer({ cwd, port, env, spawn = nodeSpawn }) {
  resolveNexariSelector(env);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('Nexari Vite server requires a valid explicit loopback port.');
  }

  return spawn(
    'pnpm',
    ['exec', 'remix', 'vite:dev', '--host', CDP_LOOPBACK_HOST, '--port', String(port), '--strictPort'],
    {
      cwd,
      env: { ...env, VITE_RUNTIME_BACKEND: 'nexari' },
      stdio: 'pipe',
    },
  );
}

export function launchChrome({ approvalToken, chromeExecutable, profileDirectory, debugPort, spawn = nodeSpawn }) {
  if (approvalToken !== OWNER_APPROVAL_TOKEN) {
    throw new NexariCdpApprovalRequiredError();
  }

  if (!chromeExecutable) {
    throw new TypeError('Chrome executable path is required.');
  }

  return spawn(chromeExecutable, buildChromeArgs({ profileDirectory, debugPort }), { stdio: 'pipe' });
}

export function formatUsage() {
  return [
    `Nexari CDP E2E runner v${RUNNER_VERSION}`,
    'This runner is owner-gated and does not launch Chrome by default.',
    'After explicit approval, invoke through the project command with a temporary profile and loopback CDP only.',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${formatUsage()}\n`);
}
