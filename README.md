# Nexari

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-22.x-green)

Nexari es un IDE de desarrollo en el navegador que **genera y corre proyectos 100% en local**: el LLM (Ollama con un modelo local) escribe el código y el proyecto se ejecuta en un runtime WebAssembly en tu propia máquina — sin StackBlitz, sin nube, sin API keys de terceros.

## Qué hace

- Escribes un prompt (ej. *"hazme un TODO app con React"*) y Nexari genera el proyecto archivo por archivo.
- Los archivos se escriben en un filesystem virtual y se **ejecutan en vivo** vía el runtime [Vivari](https://github.com/EliabLemus) (wasm/browser stack): preview montado en el workbench y terminal visible del proceso en ejecución.
- Todo corre en local: el modelo (Ollama), el runtime y la build.

## Requisitos

- Node 22
- [pnpm](https://pnpm.io)
- [Ollama](https://ollama.com) con un modelo local instalado (ej. `ollama pull qwen2.5-coder`)

## Cómo correrlo

```bash
pnpm install
VITE_RUNTIME_BACKEND=nexari pnpm run dev
```

Abre `http://localhost:5173`, elige tu modelo local de Ollama y escribe tu primer prompt.

## Scripts útiles

- `pnpm run dev` — servidor de desarrollo.
- `pnpm test` — suite de tests (Vitest).
- `pnpm run typecheck` / `pnpm run lint` — chequeos de código.

## Basado en

- **[bolt.diy](https://github.com/stackblitz-labs/bolt.diy)** (MIT) — fork base de la UI y el flujo de chat/artifacts. Créditos a StackBlitz, Cole Medin y la comunidad de bolt.diy.
- **Vivari** (Apache-2.0; paquetes `@vivari/core`, `@vivari/react` y afines bajo MIT) — runtime que ejecuta y previsualiza los proyectos generados directamente en el navegador.

## Licencia

MIT — ver [LICENSE](./LICENSE).
