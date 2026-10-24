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

  let result;
  let runFailure;
  let cleanupFailure;

  try {
    result = await callback(profileDirectory);
  } catch (error) {
    runFailure = error;
  }

  try {
    await remove(profileDirectory);
  } catch (error) {
    cleanupFailure = error;
  }

  if (runFailure && cleanupFailure) {
    throw new AggregateError([runFailure, cleanupFailure], 'Nexari E2E profile execution and cleanup both failed.');
  }

  if (runFailure) {
    throw runFailure;
  }

  if (cleanupFailure) {
    throw cleanupFailure;
  }

  return result;
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
    '--remote-allow-origins=*',
    '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1',
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

export function classifyNexariResource(url, appOrigin) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  if (parsed.origin !== appOrigin) {
    return undefined;
  }

  if (parsed.pathname === '/') {
    return 'document';
  }

  if (parsed.pathname === '/sw.js') {
    return 'service-worker';
  }

  if (parsed.pathname.startsWith('/assets/') || parsed.pathname.startsWith('/vendor/')) {
    return 'asset';
  }

  return undefined;
}

export function assessNexariEvidence(evidence, appOrigin) {
  const mandatoryResponses = new Set(
    evidence.responses
      .filter((response) => response.status >= 200 && response.status < 400)
      .map((response) => classifyNexariResource(response.url, appOrigin))
      .filter(Boolean),
  );
  const reasons = [];

  if (!evidence.crossOriginIsolated) {
    reasons.push('cross-origin-isolation-missing');
  }

  if (new URL(evidence.serviceWorkerScriptUrl ?? appOrigin, appOrigin).pathname !== '/sw.js') {
    reasons.push('service-worker-controller-missing');
  }

  if (!['document', 'service-worker', 'asset'].every((kind) => mandatoryResponses.has(kind))) {
    reasons.push('insufficient-mandatory-asset-evidence');
  }

  if (evidence.failures.some((failure) => !failure.url || classifyNexariResource(failure.url, appOrigin))) {
    reasons.push('mandatory-resource-failure');
  }

  if (evidence.consoleErrors.some((message) => /kernel worker failed to load/i.test(message))) {
    reasons.push('kernel-worker-console-error');
  } else if (evidence.consoleErrors.length > 0) {
    reasons.push('console-error');
  }

  return { passed: reasons.length === 0, reasons };
}

function consoleArgumentsText(args = []) {
  return args
    .map((argument) => argument?.value ?? argument?.description ?? argument?.unserializableValue ?? '')
    .join(' ')
    .trim();
}

/**
 * Minimal dependency-free CDP transport. Node 22 supplies WebSocket globally;
 * tests inject a fake so this code never opens a real browser connection there.
 */
export async function connectRawCdp({ webSocketUrl, WebSocket = globalThis.WebSocket, timeoutMs = 15_000 }) {
  if (typeof WebSocket !== 'function') {
    throw new Error('Raw CDP requires a WebSocket-capable Node runtime.');
  }

  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const listeners = new Set();
  const events = [];
  let nextId = 1;

  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out opening the CDP WebSocket.')), timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', (event) => {
      clearTimeout(timer);
      reject(event.error ?? new Error('CDP WebSocket failed to open.'));
    });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));

    if (message.id) {
      const deferred = pending.get(message.id);

      if (deferred) {
        pending.delete(message.id);
        message.error
          ? deferred.reject(new Error(message.error.message ?? 'CDP command failed.'))
          : deferred.resolve(message.result);
      }

      return;
    }

    events.push(message);

    for (const listener of listeners) {
      void listener(message);
    }
  });

  await opened;

  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };

      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify(payload));
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitFor(method, sessionId, waitTimeoutMs = timeoutMs) {
      const matching = events.find((event) => event.method === method && (!sessionId || event.sessionId === sessionId));

      if (matching) {
        return Promise.resolve(matching);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error(`Timed out waiting for CDP event ${method}.`));
        }, waitTimeoutMs);
        const listener = (event) => {
          if (event.method !== method || (sessionId && event.sessionId !== sessionId)) {
            return;
          }

          clearTimeout(timer);
          listeners.delete(listener);
          resolve(event);
        };
        listeners.add(listener);
      });
    },
    close() {
      for (const deferred of pending.values()) {
        deferred.reject(new Error('CDP connection closed.'));
      }

      pending.clear();
      socket.close();
    },
  };
}

/**
 * Capture browser evidence through a tiny transport interface. The concrete raw
 * WebSocket client is deliberately separate so this protocol sequence is fully
 * unit-testable without starting Chrome or Vite.
 */
export async function captureNexariBrowserEvidence({ cdp, appUrl }) {
  const responses = [];
  const failures = [];
  const consoleErrors = [];
  const requestUrls = new Map();
  const sessions = new Set();

  const enableSession = async (sessionId, includePage = false) => {
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);

    if (includePage) {
      await cdp.send('Page.enable', {}, sessionId);
    }
  };

  const unsubscribe = cdp.onEvent(async (event) => {
    if (event.method === 'Target.attachedToTarget') {
      const sessionId = event.params?.sessionId;

      if (typeof sessionId === 'string' && !sessions.has(sessionId)) {
        sessions.add(sessionId);
        await enableSession(sessionId);
      }

      return;
    }

    if (!sessions.has(event.sessionId)) {
      return;
    }

    if (event.method === 'Network.requestWillBeSent') {
      requestUrls.set(event.params?.requestId, event.params?.request?.url);
      return;
    }

    if (event.method === 'Network.responseReceived') {
      const response = event.params?.response;

      if (response?.url) {
        responses.push({ url: response.url, status: response.status });
      }

      return;
    }

    if (event.method === 'Network.loadingFailed') {
      failures.push({
        requestId: event.params?.requestId,
        url: requestUrls.get(event.params?.requestId),
        errorText: event.params?.errorText ?? 'unknown network failure',
      });
      return;
    }

    if (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error') {
      consoleErrors.push(consoleArgumentsText(event.params.args));
      return;
    }

    if (event.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(event.params?.exceptionDetails?.text ?? 'runtime exception');
    }
  });

  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessions.add(sessionId);
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await enableSession(sessionId, true);
    await cdp.send('Page.navigate', { url: appUrl }, sessionId);
    await cdp.waitFor('Page.loadEventFired', sessionId);

    const evaluateBrowserState = async () => {
      const evaluation = await cdp.send(
        'Runtime.evaluate',
        {
          expression:
            'Promise.resolve(navigator.serviceWorker?.ready).then(() => ({ crossOriginIsolated, serviceWorkerScriptUrl: navigator.serviceWorker?.controller?.scriptURL ?? null }))',
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      );

      return evaluation?.result?.value ?? {};
    };
    let state = await evaluateBrowserState();

    if (!state.serviceWorkerScriptUrl) {
      await cdp.send('Page.reload', { ignoreCache: true }, sessionId);
      await cdp.waitFor('Page.loadEventFired', sessionId);
      state = await evaluateBrowserState();
    }

    return {
      responses,
      failures,
      consoleErrors,
      crossOriginIsolated: state.crossOriginIsolated === true,
      serviceWorkerScriptUrl: state.serviceWorkerScriptUrl ?? null,
    };
  } finally {
    unsubscribe?.();
  }
}

function drainChild(child) {
  child?.stdout?.resume?.();
  child?.stderr?.resume?.();
}

function waitForExit(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function stopChild(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) {
    return;
  }

  const exited = waitForExit(child);
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);

  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function waitForJson(url, child, fetchImpl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const exit = waitForExit(child).then(({ code, signal }) => {
    throw new Error(`Owned child exited before readiness (code=${code}, signal=${signal}).`);
  });

  while (Date.now() < deadline) {
    try {
      const response = await Promise.race([fetchImpl(url), exit]);

      if (response.ok) {
        return response.json();
      }
    } catch (error) {
      if (error?.message?.startsWith('Owned child exited')) {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for ${url}.`);
}

/**
 * The only live path. It is deliberately impossible to reach without a token
 * supplied by the Human Owner after this runner's static gates are green.
 */
export async function runNexariE2E({
  approvalToken,
  cwd = process.cwd(),
  env = process.env,
  chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  timeoutMs = 60_000,
  dependencies = {},
} = {}) {
  if (approvalToken !== OWNER_APPROVAL_TOKEN) {
    throw new NexariCdpApprovalRequiredError();
  }

  resolveNexariSelector(env);

  const runtime = dependencies.runtime ?? globalThis;

  if (!inspectCdpCapabilities(runtime).cdpWebSocket || !inspectCdpCapabilities(runtime).fetch) {
    throw new Error('Nexari CDP E2E requires Node with global WebSocket and fetch.');
  }

  const acquirePort = dependencies.acquirePort ?? acquireLoopbackPort;
  const startServer = dependencies.startServer ?? startNexariDevServer;
  const startChrome = dependencies.startChrome ?? launchChrome;
  const fetchImpl = dependencies.fetch ?? runtime.fetch;
  const connect = dependencies.connect ?? connectRawCdp;
  const capture = dependencies.capture ?? captureNexariBrowserEvidence;
  const makeProfile = dependencies.createOwnedProfile ?? createOwnedProfile;
  const stop = dependencies.stopChild ?? stopChild;
  const serverPort = await acquirePort();
  const debugPort = await acquirePort();
  const appUrl = `http://${CDP_LOOPBACK_HOST}:${serverPort}/`;
  const server = startServer({ cwd, port: serverPort, env });
  drainChild(server);

  try {
    await waitForJson(appUrl, server, fetchImpl, timeoutMs);

    return await makeProfile(async (profileDirectory) => {
      const chrome = startChrome({ approvalToken, chromeExecutable, profileDirectory, debugPort });
      drainChild(chrome);

      let cdp;

      try {
        const version = await waitForJson(
          `http://${CDP_LOOPBACK_HOST}:${debugPort}/json/version`,
          chrome,
          fetchImpl,
          timeoutMs,
        );
        cdp = await connect({ webSocketUrl: version.webSocketDebuggerUrl, WebSocket: runtime.WebSocket, timeoutMs });

        const evidence = await capture({ cdp, appUrl });
        const assessment = assessNexariEvidence(evidence, new URL(appUrl).origin);

        return { ...assessment, appUrl, evidence };
      } finally {
        cdp?.close();
        await stop(chrome);
      }
    });
  } finally {
    await stop(server);
  }
}

export function formatUsage() {
  return [
    `Nexari CDP E2E runner v${RUNNER_VERSION}`,
    'This runner is owner-gated and does not launch Chrome by default.',
    'After explicit approval, invoke through the project command with a temporary profile and loopback CDP only.',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--owner-approved')) {
    void runNexariE2E({ approvalToken: OWNER_APPROVAL_TOKEN })
      .then((report) => {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        process.exitCode = report.passed ? 0 : 1;
      })
      .catch((error) => {
        process.stderr.write(`${error.stack ?? error.message}\n`);
        process.exitCode = 1;
      });
  } else {
    process.stdout.write(`${formatUsage()}\n`);
  }
}
