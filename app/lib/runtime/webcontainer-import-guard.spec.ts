import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Repo-wide guard for the Delta 003 acceptance property "the nexari path
 * contains no import of `@webcontainer/api`". The stackblitz boot factory in
 * `lib/runtime/browser-runtime.ts` holds the only sanctioned lazy SDK import;
 * every other non-spec source under `app/` may reference the SDK only through
 * type-only statements, which are erased at build time.
 *
 * The scanner is deliberately self-contained so the fixtures below can prove
 * it detects static value imports, multi-line imports, value re-exports, and
 * bare imports while never flagging `import type` statements or comment
 * mentions. It is not a full parser: regex literals embedding quote
 * characters are not modeled. Known evasion forms still classify as
 * violations (constructor strings read as bare/value references), so any
 * misclassification direction is fail-closed.
 */

const SDK_MODULE_PATTERN = /(['"])@webcontainer\/api\1/;

type SdkReferenceKind =
  | 'type-import'
  | 'value-import'
  | 'type-reexport'
  | 'value-reexport'
  | 'bare-import'
  | 'dynamic-import';

interface SdkReference {
  kind: SdkReferenceKind;
  line: number;
}

const VIOLATION_KINDS: readonly SdkReferenceKind[] = ['value-import', 'value-reexport', 'bare-import'];

/**
 * Known-accepted SDK surface this slice deliberately keeps.
 */
const ALLOWED_VALUE_REFERENCES: Record<string, readonly SdkReferenceKind[]> = {
  /*
   * Dead upstream auth shim (nothing imports it). Pinned to its exact known
   * state by a dedicated assertion below; any additional reference fails.
   */
  'lib/webcontainer/auth.client.ts': ['value-reexport'],
};

/** The stackblitz boot factory is the sole sanctioned lazy SDK import. */
const ALLOWED_DYNAMIC_IMPORT_FILES: readonly string[] = ['lib/runtime/browser-runtime.ts'];

function stripComments(source: string): string {
  let out = '';
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        index++;
      }

      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;

      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') {
          out += '\n';
        }

        index++;
      }

      index += 2;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      out += char;
      index++;

      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') {
          out += source.slice(index, index + 2);
          index += 2;
          continue;
        }

        out += source[index];
        index++;
      }

      out += quote;
      index++;
      continue;
    }

    out += char;
    index++;
  }

  return out;
}

function hasOnlyTypeSpecifiers(bracesContent: string): boolean {
  const specifiers = bracesContent.split(',').map((specifier) => specifier.trim());
  const hasBinding = specifiers.some((specifier) => specifier !== '');

  if (!hasBinding) {
    return false;
  }

  return specifiers.every((specifier) => specifier === '' || specifier.startsWith('type '));
}

function classifySdkStatement(stripped: string, specifierIndex: number): SdkReferenceKind {
  const keywordPattern = /\b(import|export)\b/g;
  let match: RegExpExecArray | null;
  let keywordIndex = -1;
  let keyword = '';

  while ((match = keywordPattern.exec(stripped)) !== null) {
    if (match.index >= specifierIndex) {
      break;
    }

    keywordIndex = match.index;
    keyword = match[1];
  }

  if (keywordIndex === -1) {
    return 'bare-import';
  }

  const head = stripped.slice(keywordIndex, specifierIndex);

  if (/import\(\s*$/.test(head)) {
    return 'dynamic-import';
  }

  if (keyword === 'import') {
    if (/^import\s*$/.test(head)) {
      return 'bare-import';
    }

    if (/^import\s+type\b/.test(head)) {
      return 'type-import';
    }

    const braces = head.match(/\{([\s\S]*)\}/);

    if (braces) {
      return hasOnlyTypeSpecifiers(braces[1]) ? 'type-import' : 'value-import';
    }

    return 'value-import';
  }

  if (/^export\s+type\b/.test(head)) {
    return 'type-reexport';
  }

  const braces = head.match(/\{([\s\S]*)\}/);

  if (braces) {
    return hasOnlyTypeSpecifiers(braces[1]) ? 'type-reexport' : 'value-reexport';
  }

  return 'value-reexport';
}

function scanSource(source: string): SdkReference[] {
  const stripped = stripComments(source);
  const references: SdkReference[] = [];
  const pattern = new RegExp(SDK_MODULE_PATTERN.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(stripped)) !== null) {
    references.push({
      kind: classifySdkStatement(stripped, match.index),
      line: stripped.slice(0, match.index).split('\n').length,
    });
  }

  return references;
}

async function collectSourceFiles(rootDir: string, current: string = rootDir): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === 'node_modules') {
      continue;
    }

    const entryPath = join(current, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(rootDir, entryPath)));
      continue;
    }

    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) || /\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      continue;
    }

    files.push(entryPath);
  }

  return files;
}

interface SourceAudit {
  files: string[];
  referencesByFile: Record<string, SdkReference[]>;
  violations: Array<{ file: string; reference: SdkReference }>;
}

async function auditAppSources(appDir: string): Promise<SourceAudit> {
  const baseDir = appDir.endsWith('/') ? appDir : `${appDir}/`;
  const files = await collectSourceFiles(appDir);
  const referencesByFile: Record<string, SdkReference[]> = {};
  const violations: SourceAudit['violations'] = [];

  for (const filePath of files) {
    const relativeFile = filePath.startsWith(baseDir) ? filePath.slice(baseDir.length) : filePath;
    const source = await readFile(filePath, 'utf8');
    const references = scanSource(source);

    referencesByFile[relativeFile] = references;

    for (const reference of references) {
      if (reference.kind === 'dynamic-import' && ALLOWED_DYNAMIC_IMPORT_FILES.includes(relativeFile)) {
        continue;
      }

      if (ALLOWED_VALUE_REFERENCES[relativeFile]?.includes(reference.kind)) {
        continue;
      }

      if (VIOLATION_KINDS.includes(reference.kind)) {
        violations.push({ file: relativeFile, reference });
      }
    }
  }

  return { files, referencesByFile, violations };
}

const APP_DIR = new URL('../../', import.meta.url).pathname;
const ENV_EXAMPLE_URL = new URL('../../../.env.example', import.meta.url);

function scanFragment(...lines: string[]): SdkReference[] {
  return scanSource(lines.join('\n'));
}

describe('webcontainer SDK import guard scanner', () => {
  it('detects a single-line static value import', () => {
    expect(scanFragment("import { WebContainer } from '@webcontainer/api';")).toEqual([
      { kind: 'value-import', line: 1 },
    ]);
  });

  it('detects a multi-line static value import', () => {
    expect(
      scanFragment('import {', '  WebContainer,', '  WebContainerProcess,', "} from '@webcontainer/api';"),
    ).toEqual([{ kind: 'value-import', line: 4 }]);
  });

  it('detects a static value re-export', () => {
    expect(scanFragment("export { auth, type AuthAPI } from '@webcontainer/api';")).toEqual([
      { kind: 'value-reexport', line: 1 },
    ]);
  });

  it('detects a default value import', () => {
    expect(scanFragment("import webcontainer from '@webcontainer/api';")).toEqual([{ kind: 'value-import', line: 1 }]);
  });

  it('allows import type statements', () => {
    expect(scanFragment("import type { WebContainer } from '@webcontainer/api';")).toEqual([
      { kind: 'type-import', line: 1 },
    ]);
    expect(scanFragment("import { type WebContainer } from '@webcontainer/api';")).toEqual([
      { kind: 'type-import', line: 1 },
    ]);
  });

  it('allows comment mentions of the module', () => {
    expect(scanFragment("// import { WebContainer } from '@webcontainer/api';")).toEqual([]);
    expect(scanFragment("/* import { WebContainer } from '@webcontainer/api'; */")).toEqual([]);
  });

  it('classifies the dynamic package import without flagging CDN URL strings', () => {
    expect(scanFragment("const mod = await import('@webcontainer/api');")).toEqual([
      { kind: 'dynamic-import', line: 1 },
    ]);
    expect(
      scanFragment(
        "const { setupConnect } = await import('https://cdn.jsdelivr.net/npm/@webcontainer/api@latest/dist/connect.js');",
      ),
    ).toEqual([]);
  });
});

describe('webcontainer SDK import guard fixtures', () => {
  it('walks a temp-dir tree: flags value imports, skips specs and non-source files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdk-guard-'));

    try {
      await mkdir(join(root, 'lib'), { recursive: true });
      await mkdir(join(root, 'sub'), { recursive: true });
      await writeFile(join(root, 'a.ts'), "import { WebContainer } from '@webcontainer/api';\n");
      await writeFile(join(root, 'lib', 'b.tsx'), "import type { WebContainer } from '@webcontainer/api';\n");
      await writeFile(join(root, 'c.spec.ts'), "import { WebContainer } from '@webcontainer/api';\n");
      await writeFile(join(root, 'sub', 'd.txt'), "import { WebContainer } from '@webcontainer/api';\n");

      const audit = await auditAppSources(root);

      expect(audit.files.sort()).toEqual([join(root, 'a.ts'), join(root, 'lib', 'b.tsx')].sort());
      expect(audit.violations).toEqual([{ file: 'a.ts', reference: { kind: 'value-import', line: 1 } }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('webcontainer SDK import guard (app/ tree)', () => {
  it('keeps the app tree free of static SDK value imports outside the known allowances', async () => {
    const audit = await auditAppSources(APP_DIR);

    expect(audit.files.length).toBeGreaterThan(10);
    expect(audit.violations).toEqual([]);
  });

  it('pins the sole sanctioned dynamic SDK import to the stackblitz boot factory', async () => {
    const audit = await auditAppSources(APP_DIR);
    const dynamicFiles = Object.entries(audit.referencesByFile)
      .filter(([, references]) => references.some((reference) => reference.kind === 'dynamic-import'))
      .map(([file]) => file);

    expect(dynamicFiles).toEqual(['lib/runtime/browser-runtime.ts']);
  });

  it('pins auth.client.ts to its known single value re-export', async () => {
    const audit = await auditAppSources(APP_DIR);

    expect(audit.referencesByFile['lib/webcontainer/auth.client.ts']).toEqual([{ kind: 'value-reexport', line: 6 }]);
  });

  it('documents VITE_RUNTIME_BACKEND in .env.example', async () => {
    const source = await readFile(ENV_EXAMPLE_URL, 'utf8');

    expect(source).toMatch(/^# Runtime Backend Selection \(optional\)$/m);
    expect(source).toMatch(/^#\s*VITE_RUNTIME_BACKEND=stackblitz$/m);
    expect(source).toMatch(/^#\s*VITE_RUNTIME_BACKEND=nexari$/m);
    expect(source).toContain('RuntimeConfigurationError');
    expect(source).toMatch(/fail closed/i);
  });
});
