export type RuntimeBackend = 'stackblitz' | 'nexari';

export class RuntimeConfigurationError extends Error {
  constructor(value: string) {
    super(`Unsupported runtime backend: ${value}`);
    this.name = 'RuntimeConfigurationError';
  }
}

/**
 * Resolve the backend from an explicit public configuration value.
 *
 * Absence defaults to the Nexari runtime (the project's execution backend —
 * StackBlitz was the historical default and is kept only as an explicit
 * opt-in). Unknown values fail closed so a typo cannot silently change the
 * execution backend.
 */
export function resolveRuntimeBackend(value: string | undefined): RuntimeBackend {
  if (value === undefined || value === '') {
    return 'nexari';
  }

  if (value === 'stackblitz' || value === 'nexari') {
    return value;
  }

  throw new RuntimeConfigurationError(value);
}

export function configuredRuntimeBackend(): RuntimeBackend {
  return resolveRuntimeBackend(import.meta.env.VITE_RUNTIME_BACKEND);
}
