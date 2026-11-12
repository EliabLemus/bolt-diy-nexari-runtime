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
 * Absence deliberately preserves the historical StackBlitz runtime. Unknown
 * values fail closed so a typo cannot silently change the execution backend.
 */
export function resolveRuntimeBackend(value: string | undefined): RuntimeBackend {
  if (value === undefined || value === '') {
    return 'stackblitz';
  }

  if (value === 'stackblitz' || value === 'nexari') {
    return value;
  }

  throw new RuntimeConfigurationError(value);
}

export function configuredRuntimeBackend(): RuntimeBackend {
  return resolveRuntimeBackend(import.meta.env.VITE_RUNTIME_BACKEND);
}
