# appbenessere-mcp

MCP server (Cloudflare Worker separato) che espone **in sola lettura** i dati di AppBenessere.

- Endpoint: `POST /mcp`, trasporto Streamable HTTP, **stateless** (nessun `Mcp-Session-Id`)
- Stack: `createMcpHandler` da `agents/mcp/server` + `@modelcontextprotocol/server` v2 + `zod`
- Protocollo: supporta sia la revisione 2026-07-28 (`server/discover`) sia l'handshake classico `initialize` (2025-xx)
- Auth: `Authorization: Bearer <MCP_TOKEN>`. Senza token configurato il server risponde sempre 401.
- DB: binding `DB` → `appbenessere` (**produzione**, dal 2026-11-26; in locale la copia da `../db/dump.sql`). Utente esposto: `MCP_USER_ID` (temporaneo, Fase 6 → dal token).

## Tool

| Tool | Input | A cosa serve |
|------|-------|--------------|
| `list_exercises` | `include_archived?` | esercizi, frequenza prevista, ultima esecuzione |
| `get_entries` | `from?`, `to?`, `exercise_id?`, `limit?` | cosa è stato svolto giorno per giorno |
| `get_activity_summary` | `from?`, `to?` | conteggi per esercizio vs frequenza attesa, esercizi in ritardo |
| `search_notes` | `text?`, `topic?`, `from?`, `to?`, `limit?` | ricerca negli appunti |

Date in formato `YYYY-MM-DD`; senza date: ultimi 7 giorni fino a oggi (UTC).
Tabelle **mai** esposte: `users`, `sessions`, `chat_conversations`, `chat_messages`.

## Sviluppo locale

```powershell
npm install
npm run db:seed-local        # popola il D1 locale da ../db/dump.sql (una volta sola)
# crea .dev.vars (è in .gitignore) con:  MCP_TOKEN=<un token a caso>
npm run dev                  # http://127.0.0.1:8787/mcp
npm run typecheck
```

Test veloce:

```bash
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-11-25" -H "Authorization: Bearer $MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Deploy

```powershell
npx wrangler secret put MCP_TOKEN    # incolla un token NUOVO, diverso da quello locale
npm run deploy                       # → https://appbenessere-mcp.<subdomain>.workers.dev/mcp
npm run tail                         # log in tempo reale
```

## Note emerse durante lo sviluppo

- `McpAgent` (Durable Object per sessione) risulta **deprecato** nella versione attuale di `agents`: la via consigliata è la factory stateless con `createMcpHandler`.
- Errori di due tipi: argomenti non validi / errori applicativi → `result.isError: true` (l'LLM li legge e può correggersi); tool inesistente → errore JSON-RPC `-32602`.
- In `wrangler dev` il secret da `.dev.vars` è arrivato al Worker solo dopo aver dichiarato `"secrets": { "required": ["MCP_TOKEN"] }` in `wrangler.jsonc`.

## Test manuali (MCP Inspector)

Strumento riutilizzabile con qualsiasi server MCP: `npx @modelcontextprotocol/inspector` (v2.16, UI su `http://localhost:6274`).
I server sono nel catalogo `~/.mcp-inspector/mcp.json` (fuori da git, contiene i token in chiaro):
`appbenessere-mcp-test` (locale, `http://127.0.0.1:8787/mcp`) e `appbenessere-mcp-prod` (`https://appbenessere-mcp.alfoliu.workers.dev/mcp`).

```powershell
npx @modelcontextprotocol/inspector                                                   # UI web
npx @modelcontextprotocol/inspector --cli --server appbenessere-mcp-prod --method tools/list
npx @modelcontextprotocol/inspector --cli --server appbenessere-mcp-test --method tools/call --tool-name get_entries --tool-arg from=2026-11-01 --tool-arg to=2026-11-30
```

Esito 2026-11-26: tutti superati.

| # | Area | Caso | Atteso |
|---|------|------|--------|
| 1–3 | Auth | nessun token / token errato / token giusto | 401 / 401 / connesso |
| 4 | Protocollo | `tools/list` | 4 tool, `readOnlyHint: true` |
| 5–6 | `list_exercises` | default / `include_archived` | attivi / anche archiviati |
| 7–10 | `get_entries` | default, novembre, `exercise_id`, `limit` | dati coerenti (nov: 205 registrazioni) |
| 11–14 | `get_entries` | from>to, intervallo >366 gg, data non ISO, `limit` 1000 | `isError` |
| 15 | `get_activity_summary` | novembre | conteggi coerenti con il test 8 |
| 16–19 | `search_notes` | testo, `%` (escape LIKE), 1 carattere, `topic` | risultati / nessun match globale / `isError` / filtro |
| 20 | Protocollo | tool inesistente | errore JSON-RPC `-32602` |
| 21 | Online | test 1–4 e 8 sul Worker deployato | come in locale |

Nota: con un token errato Inspector riceve 401 + `WWW-Authenticate` e tenta il flusso **OAuth** (`/.well-known/oauth-protected-resource`), che il server non implementa. Nella UI appare un generico *fetch error*, nella CLI `auth_required`: significa "token sbagliato", non "server irraggiungibile".

## Stato del progetto (checklist)

Ricostruita dal piano `../PIANO-MCP-APPBENESSERE.md` e dal lavoro fatto finora (aggiornata al 2026-11-26).

### Prerequisiti
- [x] Node.js ≥ 20, npm e git installati
- [x] Login a Cloudflare (`npx wrangler login`)
- [x] Nome e ID del DB dell'app: `appbenessere` (`bc665a27-…`)
- [x] Repository GitHub privato `appbenessere-mcp` creato, primo push fatto
- [ ] Chiave API Anthropic (serve dalla Fase 5)

### Fase 1 — Ricognizione DB e concetti MCP
- [x] Identificato il DB: è **D1** (`appbenessere`)
- [x] Esportati schema (`db/schema.sql`, su git) e dump completo (`db/dump.sql`, escluso da git)
- [x] Creata la copia di sviluppo `appbenessere-dev` e popolato il D1 locale dal dump
- [x] Individuate le tabelle da non esporre mai: `users`, `sessions`, `chat_conversations`, `chat_messages`
- [x] Scelte le domande utente → tool (esercizi, cosa ho fatto, riepilogo/ritardi, appunti)
- [ ] Creare `NOTES.md` (diario): schema DB, glossario MCP, elenco domande → tool

### Fase 2 — Primo MCP server su Worker
- [x] Progetto `mcp-server/` con `agents`, `@modelcontextprotocol/server` v2, `zod`, `wrangler`
- [x] Scelta A vs B: `McpAgent` è deprecato → usato handler **stateless** `createMcpHandler`
- [x] Avvio in locale con `wrangler dev` e test con `curl`
- [x] Deploy su Cloudflare (`appbenessere-mcp`, 2026-11-20)
- [ ] (Saltato) tool di prova `ping`/`add`: si è passati direttamente ai tool reali
- [ ] Annotare in `NOTES.md` il confronto stateful vs stateless e la scelta fatta

### Fase 3 — Tool reali sul database
- [x] Binding `DB` → `appbenessere-dev` (fino al 2026-11-26)
- [x] 4 tool in sola lettura: `list_exercises`, `get_entries`, `get_activity_summary`, `search_notes`
- [x] Solo `SELECT` con `prepare().bind()`, `limit` massimo, filtro su `MCP_USER_ID`
- [x] Errori gestiti con `isError: true`; tool inesistente → JSON-RPC `-32602`
- [x] Testati in locale sui dati reali (es. novembre: 205 registrazioni in 17 giorni)
- [x] Commit e push del server su GitHub
- [ ] (Facoltativo) esporre lo schema anche come **resource** (`schema://appbenessere`)

### Fase 4 — Client manuali (capire il protocollo)
- [x] Verificare il server **online**: 401 senza token, `tools/list` e `tools/call` con token (2026-11-26)
- [x] Test manuali con **MCP Inspector**, in locale e online: 21 casi superati (vedi *Test manuali*)
- [ ] 4a. Cartella `mcp-client/curl/` con le chiamate JSON-RPC salvate (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`) e risposte annotate
- [ ] 4a. Osservare SSE vs JSON, errori JSON-RPC, handshake classico vs revisione `server/discover`
- [ ] 4b. `mcp-client/raw-fetch.ts`: client senza SDK, con parsing SSE
- [ ] 4c. `mcp-client/sdk-client.ts`: client con SDK ufficiale, confronto con 4b
- [x] 4d. MCP Inspector sul server locale e su quello deployato
- [ ] 4d. Provare Cloudflare AI Playground sul server deployato
- [ ] Scrivere in `NOTES.md` la sequenza dei messaggi del ciclo di vita

### Fase 5 — Agente che usa il server MCP
- [ ] 5a. `mcp-client/agent-loop.ts`: loop Claude + MCP in locale con log di ogni passaggio
- [ ] 5a. Testare le domande della Fase 1 e migliorare le descrizioni dei tool dove l'agente sbaglia
- [ ] 5b. Worker `mcp-agent/` con endpoint `POST /ask` e secret `ANTHROPIC_API_KEY`
- [ ] 5b. Confrontare: loop nostro / Agents SDK Cloudflare / MCP connector dell'API Claude
- [ ] 5b. Provare chiamata worker→worker via URL pubblico e via **Service Binding**
- [ ] Tabella in `NOTES.md`: domanda → tool chiamati → turni → esito

### Fase 6 — Sicurezza, osservabilità, rifinitura
- [x] Bearer token statico `MCP_TOKEN` (locale in `.dev.vars`, produzione come secret)
- [ ] Aggiornare tutti i client (Fase 4–5) per usare il token
- [ ] Multi-utente: ricavare l'utente dal token invece che da `MCP_USER_ID`
- [ ] (Facoltativo) OAuth con `@cloudflare/workers-oauth-provider` per Claude Desktop / claude.ai
- [ ] Osservabilità: `wrangler tail`, Workers Logs, log di tool/durata/righe
- [ ] Limiti: rate limiting su `/ask`, timeout, dimensione massima risultati
- [x] Passare il binding dal DB `appbenessere-dev` a quello di produzione `appbenessere` (2026-11-26)
- [ ] (Facoltativo) Collegare il server a Claude Code (`claude mcp add --transport http …`)
- [ ] `NOTES.md` finale con le lezioni apprese

### Prossimo passo
Fase 4a: cartella `mcp-client/curl/` con le chiamate JSON-RPC salvate e le risposte annotate (`initialize` → `notifications/initialized` → `tools/list` → `tools/call`, SSE vs JSON, handshake classico vs `server/discover`), poi 4b `raw-fetch.ts`.
