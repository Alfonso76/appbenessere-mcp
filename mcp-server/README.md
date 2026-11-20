# appbenessere-mcp

MCP server (Cloudflare Worker separato) che espone **in sola lettura** i dati di AppBenessere.

- Endpoint: `POST /mcp`, trasporto Streamable HTTP, **stateless** (nessun `Mcp-Session-Id`)
- Stack: `createMcpHandler` da `agents/mcp/server` + `@modelcontextprotocol/server` v2 + `zod`
- Protocollo: supporta sia la revisione 2026-07-28 (`server/discover`) sia l'handshake classico `initialize` (2025-xx)
- Auth: `Authorization: Bearer <MCP_TOKEN>`. Senza token configurato il server risponde sempre 401.
- DB: binding `DB` → `appbenessere-dev` (copia). Utente esposto: `MCP_USER_ID` (temporaneo, Fase 6 → dal token).

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
