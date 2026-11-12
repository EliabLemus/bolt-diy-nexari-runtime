import { describe, expect, it } from 'vitest';
import prompt from './optimized';

describe('optimized prompt wasm-safe guidance', () => {
  const rendered = prompt({
    cwd: '/',
    allowedHtmlElements: ['a', 'b'],
    supabase: false,
  } as any);

  it('instruye overrides wasm-safe para proyectos Vite/Rollup', () => {
    expect(rendered).toContain('@rollup/wasm-node');
    expect(rendered).toContain('^0.28.2');
    expect(rendered).toMatch(/overrides/);
  });

  it('mantiene la instrucción condicional (no degrada proyectos estáticos)', () => {
    expect(rendered).toMatch(/do NOT add them to static projects/);
  });
});
