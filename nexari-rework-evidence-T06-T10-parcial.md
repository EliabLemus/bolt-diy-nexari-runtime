# Nexari REWORK — Registro de evidencia parcial T06–T10 (en curso)

Fecha: 2026-11-11 · Registro parcial committeado antes de la fase E2E para no
perder trabajo (segunda pasada delegada; la primera agotó iteraciones).

## Procedencia

- SPEC_REPO: `/Users/openjaime/Projects/nexari-boltdiy-integration` (tasks.md T06–T12).
- APP_REPO: worktree `~/.worktrees/subagent-sa-0-7500bd9c`, rama
  `hermes-subagent/subagent-sa-0-7500bd9c`, base `2974b395`.
- Log dev server primera pasada: `/tmp/t10_dev.log`.

## T06 — Streaming a terminal visible (S11) — **PASS** (impl + spec)

- Commit `7a4488c1` «feat(nexari): T06 — action-lane output streams into the
  visible workbench terminal (S11)».
- Archivos: `app/lib/runtime/nexari-action-shell.spec.ts` (+32),
  `nexari-action-shell.ts` (+29/-3), `app/lib/stores/terminal.ts` (+11),
  `app/lib/stores/workbench.ts` (+7/-1).
- La salida de la action lane se escribe en el terminal visible del workbench.

## T07 — (pendiente de verificación E2E)

## T08 — Preview respeta ready flag (S21) — **PASS** (impl + spec)

- Commit `2974b395` «feat(nexari): T08/S21 — preview UI respects ready flag;
  renders only after server-ready» (`app/components/workbench/Preview.tsx`, +7/-2).
- El preview no renderiza hasta que el server-step reporta ready.

## T09 — Selección de modelo / generación real — **PARCIAL (bloqueo encontrado)**

- Primera pasada E2E: generación real con `qwen3:4b` vía Ollama **sí produjo
  completion** (usage `promptTokens 28409 / completionTokens 6131` en
  `/tmp/t10_dev.log`) pero la petición **falló por límite de contexto**: el
  prompt optimizado (~28K tokens) excede `num_ctx` 32K del modelo.
- **Mitigación aplicada**: modelo derivado `qwen3:4b-64k` con `num_ctx 65536`
  creado y verificado en `ollama list`.
- localStorage de la app: provider Ollama, promptId `optimized`, developer mode ON.

## T10 — E2E navegador — **EN CURSO** (relanzamiento con `qwen3:4b-64k`)

- Dev server primera pasada: `VITE_RUNTIME_BACKEND=nexari`, puerto 5187
  (host ::1), log en `/tmp/t10_dev.log`. Proceso matado al cierre.
- Pendiente: repetir E2E con el modelo 64K y verificar S10.3–10.7 y 11.1–11.6;
  luego T12 (captura de red, matriz S01–S26, checkboxes en SPEC_REPO).

## Resumen parcial

| Tarea | Estado |
|---|---|
| T06 | PASS (commit 7a4488c1) |
| T07 | pendiente E2E |
| T08 | PASS (commit 2974b395) |
| T09 | PARCIAL — mitigación qwen3:4b-64k aplicada |
| T10 | EN CURSO |
