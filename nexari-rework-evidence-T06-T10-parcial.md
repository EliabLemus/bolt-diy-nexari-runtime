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

T10 — E2E navegador — **EN CURSO** (relanzamiento con `qwen3:4b-64k`)

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
| T09 | PARCIAL — mitigación qwen3:4b-64k aplicada, insuficiente (modelo carga a 32K) |
| T10 | FALLIDA E2E #2 — Ollama 400 Token Limit Exceeded; workbench no montó |

## T10 — E2E navegador (segunda pasada, 2026-11-11) — **FALLIDA (bloqueo confirmado)**

- Setup verificado: baseUrl SIN barra final (`http://localhost:11434`) en
  `provider_settings` (hallazgo: trailing-slash provocaba 307 sin CORS al
  cargar modelos dinámicos de Ollama). Cookies `selectedModel=qwen3:4b-64k`,
  `selectedProvider=Ollama`; `isDeveloperMode=true`, `promptId=optimized`.
- Prompt enviado: `NEXARI-E2E-20261111-E1` → chat `/chat/15`, fase
  "Analysing Request" → luego quedó clavada en "Determining Files to Read"
  (>12 min sin progreso).
- Causa raíz (log dev server): Ollama respondió **HTTP 400 "Token Limit
  Exceeded"**. `ollama api/ps` muestra `context_length: 32768` pese a que el
  modelo derivado fue creado con `num_ctx 65536` — Ollama cargó el modelo a
  32K, así que el prompt optimizado (~28K tokens + historial) vuelve a
  exceder el contexto.
- `stream-recovery`: 2 reintentos (attempt 1, attempt 2) con timeouts, luego
  "Max retries reached for stream recovery". El workbench nunca montó:
  0 iframes, 0 artifacts, sin terminal visible (última captura de página
  `/chat/15` en estado "Determining Files to Read").
- Dev server: `VITE_RUNTIME_BACKEND=nexari pnpm run dev --port 5173
  --strictPort` (session `proc_5edd81aa24f9`); eliminado al terminar.

**Siguientes pasos sugeridos**: recrear el modelo con `num_ctx` efectivo
(p.ej. `ollama create qwen3:4b-64k -f Modelfile` verificando
`ollama show qwen3:4b-64k | grep context`, o pasar `num_ctx` en
`options` de la llamada `/api/chat`) y relanzar el E2E.

## T10 — E2E navegador (tercera pasada, 2026-11-11) — **FALLIDA (nueva causa raíz identificada)**

- Desbloqueo previo: se descargó el modelo (`ollama stop qwen3:4b-64k`,
  exit 0) para forzar recarga con el `num_ctx 65536` del modelfile.
  Verificado: tras carga manual via `/api/generate` con `keep_alive:-1`,
  `/api/ps` reporta `context_length: 65536`.
- Causa raíz REAL confirmada en código: `app/lib/modules/llm/providers/
  ollama.ts` línea 131 envía `numCtx: this.getDefaultNumCtx(serverEnv)`,
  que devuelve **32768 por defecto** si no está seteada la env
  `DEFAULT_NUM_CTX`. Cada request de la app RE-CARGA el modelo a 32K
  aunque se haya precargado a 64K — por eso `/api/ps` vuelve a mostrar
  `context_length: 32768` durante la corrida.
- Mitigación intentada: dev server relanzado con
  `DEFAULT_NUM_CTX=65536` junto a `VITE_RUNTIME_BACKEND=nexari`. No fue
  suficiente: `/api/ps` volvió a 32768 durante la generación (la env de
  proceso no llega al `serverEnv` efectivo del provider en dev, o el
  valor se resuelve por otra ruta — requiere investigar cómo el stack
  Nexari propaga `serverEnv` al provider).
- Corrida: 2 intentos de navegador (límite consumido). Ambos: chat
  creado, fase "Analysing Request" (~30-40 s, generación activa en
  Ollama), luego clavada en "Determining Files to Read" >3 min; dev log
  muestra `stream-recovery` timeouts y "Max retries reached for stream
  recovery". Workbench NUNCA montó: 0 iframes, 0 artifacts, 0 terminal.
- Resultado tareas:
  - 10.2: **FAIL** (sin completion real).
  - 10.3–10.7: **NO-VERIFICABLE-E2E**.
  - 11.1–11.6: **NO-VERIFICABLE-E2E**.
- Dev server: sesión `proc_8a2d3ce1b149`, eliminado al terminar.

**Desbloqueo real**: hacer que el request del provider incluya
`num_ctx: 65536` — setear `DEFAULT_NUM_CTX` por la ruta que el runtime
Nexari usa para `serverEnv` (o cambiar el default de `getDefaultNumCtx`),
verificando con `/api/ps` durante la generación que el contexto cargado
es 65536.
