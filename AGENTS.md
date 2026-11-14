# AGENTS.md

Guía para agentes de código (Codex, Claude, etc.) trabajando en este repo.

## Comandos canónicos

```bash
pnpm install          # bootstrap
pnpm run dev          # dev server en :5173 (si está ocupado, usa otro puerto)
pnpm run test         # Vitest — 109 archivos / ~1000 tests
pnpm run typecheck    # tsc
pnpm run lint         # eslint app/
```

Verificación completa en un paso: `hermes verify --json` (bootstrap + build + typecheck + test + lint). CI equivalente: todo debe estar en verde antes de push.

## Arquitectura mínima

- `app/lib/runtime/` — backend de ejecución. El default es **Nexari** (runtime WebAssembly via `@nexari/vivari-adapter`); `stackblitz` existe solo como opt-in explícito vía `VITE_RUNTIME_BACKEND`. `resolveRuntimeBackend()` falla cerrado con valores desconocidos.
- `app/lib/.server/llm/dev-server-injection.ts` — inyecta el comando que sirve el proyecto generado (python3 http.server para guests HTML puro).
- `app/lib/runtime/nexari-action-shell.ts` — shell de acciones del guest. Los servers corren **detached** por la lane de server-step; el server stale se mata desde el runner (el `sh` del guest no soporta job control).
- `app/lib/common/prompts/` — system prompts. El código generado DEBE ir dentro de `<boltArtifact>`; código fenced fuera del artifact se descarta.

## Convenciones

- Todo cambio de lógica lleva test. El guard `webcontainer-import-guard.spec.ts` prohíbe imports de valor de `@webcontainer/api` fuera de `browser-runtime.ts` (factory lazy).
- Lint usa reglas prettier + @blitz; `pnpm exec eslint --fix` arregla la mayoría (ojo: reglas de comentarios circulares en `vivari-guest-factory.ts`).
- `main` = producción. Commits convencionales (`fix:`, `feat:`, `chore:`, `docs:`).
- Sin secretos: `.env.local` no está versionado; las plantillas van en `.env.example`.
