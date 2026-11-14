/**
 * Returns the data-stream text-delta payload that boots the guest dev server,
 * or null when the model already emitted a shell action itself (so we don't
 * double-run install/dev). Free OpenRouter models often skip the shell step,
 * leaving files written but the preview never starting.
 *
 * When the model wrote a package.json but no usable package-lock.json, a
 * deterministic lockfile is emitted as a file action BEFORE the install shell
 * step, so npm resolves versions from a lockfile instead of the registry
 * (slow, non-reproducible, and flaky offline on the guest).
 *
 * ponytail: single string payload + regex guard; extract config only if the
 * command ever needs to vary per project type.
 */

interface RootPackage {
  name: string;
  version: string;
}

function extractFileAction(content: string, filePath: string): string | null {
  /*
   * Non-greedy match on the file body; boltAction bodies are plain text
   * emitted by the model, and `</boltAction>` cannot appear inside a JSON
   * document the parser accepts.
   */
  const pattern = new RegExp(
    `<boltAction type=["']file["'] filePath=["']${filePath}["']>\\n?([\\s\\S]*?)<\\/boltAction>`,
  );
  const match = pattern.exec(content);

  return match === null ? null : match[1].trim();
}

function parseRootPackage(json: string | null): RootPackage | null {
  if (json === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(json) as { name?: unknown; version?: unknown };

    if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
      return null;
    }

    return { name: parsed.name, version: parsed.version };
  } catch {
    return null;
  }
}

/**
 * Deterministic lockfile for the guest project, generated from the model's
 * package.json. Package resolution still happens at install time; the
 * lockfile only pins the root identity so `npm install` has a consistent
 * baseline instead of "no lockfile" (which forces a full registry resolve).
 */
export function generateGuestLockfile(packageJson: string | null): string | null {
  const root = parseRootPackage(packageJson);

  if (root === null) {
    return null;
  }

  return `${JSON.stringify(
    {
      name: root.name,
      version: root.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: root.name,
          version: root.version,
        },
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * The lockfile the model emitted, when it is parseable and matches the root
 * package name/version of package.json. Anything else (missing, unparsable,
 * mismatched identity) is treated as "no lockfile".
 */
function modelLockfile(content: string): string | null {
  const packageJson = parseRootPackage(extractFileAction(content, 'package.json'));

  if (packageJson === null) {
    return null;
  }

  const lockJson = extractFileAction(content, 'package-lock.json');
  const emitted = parseRootPackage(lockJson);

  if (emitted === null || emitted.name !== packageJson.name || emitted.version !== packageJson.version) {
    return null;
  }

  return lockJson;
}

export function devServerInjection(content: string): string | null {
  if (!content || /<boltAction\s+type=["']shell["']/.test(content)) {
    return null;
  }

  const hasPackageJson = extractFileAction(content, 'package.json') !== null;
  const hasDevScript = hasPackageJson && /"dev"\s*:/.test(extractFileAction(content, 'package.json')!);

  /*
   * Plain-HTML projects (no package.json) cannot run npm at all: the npm
   * step exits 1 and the preview stays on "No preview available". Serve
   * them statically with the guest's python3 (zero deps, no network).
   * ponytail: guest python3 is verified present in the runtime image.
   */
  const command = !hasPackageJson
    ? /*
       * The guest fs is SHARED across chats: a python server from a previous
       * chat keeps port 5173 bound, so the new server exits EADDRINUSE and the
       * preview keeps serving stale content. Reboot it via pidfile.
       * ponytail: pidfile only covers the static path; npm-path servers that
       * orphan vite children need per-port tracking if it ever bites.
       */
      'old=$(cat /tmp/.nexari-dev.pid 2>/dev/null); [ -n "$old" ] && kill -9 "$old" 2>/dev/null; python3 -m http.server 5173 --bind 0.0.0.0 & echo $! > /tmp/.nexari-dev.pid; wait'
    : hasDevScript
      ? 'npm install && npm run dev -- --host 0.0.0.0 --port 5173'
      : 'npm install && npx --yes serve -l 5173 .';

  const npmPath = hasPackageJson;
  const modelLock = npmPath ? modelLockfile(content) : null;
  const generated =
    npmPath && modelLock === null ? generateGuestLockfile(extractFileAction(content, 'package.json')) : null;

  const lockfileAction =
    generated === null ? '' : `<boltAction type="file" filePath="package-lock.json">${generated}</boltAction>\n`;

  const injectedText =
    '\n\n<boltArtifact id="dev-server-autostart" title="Start Dev Server" type="run">\n' +
    lockfileAction +
    `<boltAction type="shell">${command}</boltAction>\n` +
    '</boltArtifact>\n';

  return `0:${JSON.stringify(injectedText)}\n`;
}
