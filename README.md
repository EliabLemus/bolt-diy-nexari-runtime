# Nexari

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-22.x-green)

Nexari es un IDE de desarrollo en el navegador que **genera y corre proyectos en tu máquina**: el LLM escribe el código y el proyecto se ejecuta en un runtime WebAssembly local — el modelo puede ser local (Ollama) o remoto (OpenRouter u otro proveedor con API key).

## Qué hace

- Escribes un prompt (ej. *"hazme un TODO app con React"*) y Nexari genera el proyecto archivo por archivo.
- Los archivos se escriben en un filesystem virtual y se **ejecutan en vivo** vía el runtime [Vivari](https://github.com/EliabLemus) (wasm/browser stack): preview montado en el workbench y terminal visible del proceso en ejecución.
- Todo corre en local: el modelo (Ollama), el runtime y la build.

## Requisitos

- Node 22
- [pnpm](https://pnpm.io)
- Un LLM: [Ollama](https://ollama.com) local (ej. `ollama pull qwen2.5-coder`) **o** una API key de proveedor (ej. `OPEN_ROUTER_API_KEY` en `.env.local`)

## Cómo correrlo

```bash
pnpm install
pnpm run dev
```

Abre `http://localhost:5173`, elige tu modelo en la UI y escribe tu primer prompt. El backend de ejecución por defecto es **Nexari** (runtime WebAssembly local); `VITE_RUNTIME_BACKEND` solo se necesita para optar explícitamente por otro backend (`nexari` | `stackblitz`).

## Scripts útiles

- `pnpm run dev` — servidor de desarrollo.
- `pnpm test` — suite de tests (Vitest).
- `pnpm run typecheck` / `pnpm run lint` — chequeos de código.

## Basado en

- **[bolt.diy](https://github.com/stackblitz-labs/bolt.diy)** (MIT) — fork base de la UI y el flujo de chat/artifacts. Créditos a StackBlitz, Cole Medin y la comunidad de bolt.diy.
- **Vivari** (Apache-2.0; paquetes `@vivari/core`, `@vivari/react` y afines bajo MIT) — runtime que ejecuta y previsualiza los proyectos generados directamente en el navegador.
- **[Modern Web Guidance](https://github.com/GoogleChrome/modern-web-guidance)** (Apache-2.0) — GoogleChrome; guía de buenas prácticas web modernas inyectada al prompt de generación (desactivable con `MODERN_WEB_GUIDANCE=off`).

## Licencia

MIT — ver [LICENSE](./LICENSE).
