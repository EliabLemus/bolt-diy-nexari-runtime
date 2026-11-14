# Nexari

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-22.x-green)

Nexari es un **runtime WebAssembly open-source** que ejecuta proyectos generados por IA directamente en tu navegador — sin Docker, sin contenedores, sin nube. Este repo entrega Nexari integrado en **Bolt** (IDE en el navegador basado en bolt.diy): el LLM genera el proyecto y Nexari lo corre en vivo en la misma pestaña. El modelo puede ser local (Ollama) o remoto (OpenRouter u otro proveedor con API key).

## Qué hace

- Escribes un prompt en Bolt (ej. *"hazme un TODO app con React"*) y el LLM genera el proyecto archivo por archivo.
- **Nexari** escribe los archivos en un filesystem virtual, arranca el proceso y monta el preview en vivo, con terminal visible — todo dentro del navegador.
- Nexari está construido sobre la base WebAssembly de [Vivari](https://github.com/EliabLemus).
- Todo corre en local: el modelo (Ollama), el runtime y la build.

## Por qué Nexari

El "genera y corre en el navegador" está comercialmente probado ([bolt.new](https://sacra.com/c/bolt-new/) llegó a $40M ARR en meses con ese modelo), pero los productos que lo dominan ejecutan tu código en su nube. Nexari toma la misma idea y la lleva **a tu máquina**:

| | bolt.new / v0 / Lovable | bolt.diy (WebContainers) | **Bolt + Nexari** |
|---|---|---|---|
| Ejecución | nube del proveedor | navegador (runtime propietario, licencia comercial) | navegador (**runtime open-source propio**) |
| Tu código | sale de tu equipo | se ejecuta con SDK licenciado | **nunca sale de tu máquina** |
| Offline / air-gapped | no | parcial | **sí (LLM local + runtime local)** |
| Costo de sandbox | pago por uso | licencia enterprise en producción | **$0, sin vendor lock** |

### Casos de uso

- **Prototipado privado** — equipos que no pueden enviar código a APIs de nube (firewalls, datos sensibles, entornos regulados): LLM local + ejecución local, cero datos salen.
- **Probar LLMs locales en modo agente** — el ecosistema Ollama (~200k+ instancias desplegadas) sirve para chatear; con Bolt + Nexari esos modelos **generan y ejecutan** proyectos completos.
- **Demos y apps desechables** — el patrón que bolt.new validó con millones de usuarios, sin cuentas ni cuotas.
- **Educación** — entornos de código en el navegador sin setup y sin costos de sandbox en la nube por alumno.

### Posición honesta

Es un producto de **nicho**, no un competidor generalista de bolt.new/Lovable. El diferenciador real es el runtime propio ([Vivari](https://github.com/EliabLemus)) 100% open-source — sin la licencia comercial que ata a WebContainers API — combinado con privacidad extremo a extremo. Alternativas WASM de Linux-completo (container2wasm, jslinux) existen pero son emulación lenta sin IDE integrado.

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
- **Vivari** (Apache-2.0; paquetes `@vivari/core`, `@vivari/react` y afines bajo MIT) — la base WebAssembly sobre la que está construido Nexari: ejecuta y previsualiza los proyectos generados directamente en el navegador.
- **[Modern Web Guidance](https://github.com/GoogleChrome/modern-web-guidance)** (Apache-2.0) — GoogleChrome; guía de buenas prácticas web modernas inyectada al prompt de generación (desactivable con `MODERN_WEB_GUIDANCE=off`).

## Licencia

MIT — ver [LICENSE](./LICENSE).
