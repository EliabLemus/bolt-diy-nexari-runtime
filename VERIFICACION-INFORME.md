# Verificación independiente — Informe de cierre Nexari (t_4c8ba039)

Fecha: 2026-10-30 · Verificador: perfil `verifier` (GLM) · Objeto: NEXARI-CIERRE.md @ ff07aba, rama de referencia `nexari/consumer-tarball-ac1` (a169abe).

## Veredicto: PASS (con una corrección menor de hecho)

Todas las afirmaciones sustantivas del informe se reprodujeron de forma independiente en un contexto limpio. Una afirmación colateral (el "borde" de 100 MB) es imprecisa y se corrige abajo; no afecta la validez del cierre, y de hecho facilita la Opción A′.

## Gates ejecutados (re-ejecutados, no confiado en salida reportada)

1. **Consumer contiene todo el facade** — REPRODUCIDO.
   `git merge-base 329e0ba a169abe` = 329e0ba (= HEAD exacto del facade);
   `a169abe..329e0ba` = 0 commits faltantes; 329e0ba..a169abe = 12 commits propios.
   Nota: el informe dice "los 11 commits del facade + 12 propios" = 23 total;
   verificado `rev-list a177ace..a169abe` = 23 con a177ace = nexari-fork/main.

2. **sha256 del tarball grande** — REPRODUCIDO.
   Blob extraído de git en a169abe (100,248,989 bytes):
   `6c97fb8ea6e82ffa3fa5ce27d225d38885e685712ec854669f994d4548b134da`
   = declarado en `manifest.json` (línea 69 de a169abe) y en el spec
   `nexari-browser-assets.provenance.spec.ts` (que además lo valida en la suite).

3. **Listas internas de los 4 tarballs vs manifest** — REPRODUCIDO.
   Comparación programática (tarfile vs manifest, con prefijo `package/` y globs
   `**` normalizados): los 4 tarballs MATCH exactos
   (9, 26, 5 y 145 archivos respectivamente). Los 3 menores no declaran sha256,
   como dice el informe; el cuarto sí (ítem 2).

4. **Suite local** — RE-EJECUTADA en checkout limpio de a169abe
   (`pnpm install --frozen-lockfile` + `npx vitest --run`):
   **20 archivos, 229/229 pasando**. Coincide con lo reportado.

5. **Typecheck preexistente** — REPRODUCIDO.
   Único error: `functions/[[path]].ts(5,37): TS2307 Cannot find module
   '../build/server'` con `build/` ausente (requiere `pnpm build` previo).
   Consistente con "condición preexistente del upstream", no un defecto de la rama.

6. **Runner E2E owner-gated** — REPRODUCIDO leyendo el código.
   642 líneas el .mjs y 521 el .spec.ts, como afirma el informe. Gate real:
   `runNexariE2e` lanza `NexariCdpApprovalRequiredError` si
   `approvalToken !== OWNER_APPROVAL_TOKEN` (`NEXARI_ISOLATED_CHROME_OWNER_APPROVED`)
   **antes** de reservar puertos o spawnear hijos; `launchChrome` re-verifica el
   token; CLI exige `--owner-approved`. CDP acotado a 127.0.0.1
   (`CDP_LOOPBACK_HOST`, args `--remote-debugbing-address` loopback +
   host-resolver-rules excluyendo 127.0.0.1), `--headless=new`, perfil temporal
   vía `mkdtemp` con cleanup garantizado (AggregateError si fallan run+cleanup).
   Los 23 tests del spec cubren lo enumerado en el informe.

7. **Remoto eliminado** — REPRODUCIDO.
   `https://github.com/EliabLemus/bolt.diy-nexari-runtime` → 404 (web y API).
   `ssh -T github-eliab` → "Hi EliabLemus! ... authenticated" (SSH vivo).
   `git ls-remote nexari-fork` (HTTPS/PAT) → "Invalid username or token".
   El trabajo existe solo en local: confirmado.

## Corrección menor (única discrepancia)

- **Informe, Opción A′**: "los blobs >100 MB requieren LFS; 100.2 MB está justo
  en el borde — evaluar git lfs". **Impreciso.** GitHub bloquea blobs >100 **MiB**
  (104,857,600 bytes), no >100 MB decimal (docs.github.com: "GitHub blocks files
  larger than 100 MiB"). El blob pesa 100,248,989 bytes = **95.65 MiB**, ~4.4 MiB
  por debajo del límite. El push de A′ no necesitaría LFS. La advertencia de
  advertencia-50MB sí aplicará (performance warning), pero no bloquea.

## Dictamen sobre lo perdido (scratch E2E)

Concuerdo con "no crítico": las versiones committeadas ya implementan cada control
que el informe enumera (gate owner, loopback, perfil temporal con cleanup,
headless, cobertura de contrato). La pérdida es refinamiento, no capacidad.

## Estado final

- Informe de cierre: **VERIFICADO — apto para decisión del usuario** (A′/B/C),
  con la corrección del límite 100 MiB integrada mentalmente al leer la Opción A′.
- Nada de lo afirmado en NEXARI-CIERRE.md carece de soporte en evidencia.
