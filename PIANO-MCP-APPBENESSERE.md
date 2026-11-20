# Piano di sperimentazione: MCP Server per AppBenessere su Cloudflare

> Creato: 2026-11-20
> Obiettivo: capire **come si costruisce** un MCP server, **come si testa a mano** e **come lo usa un agente** per rispondere a richieste dell'utente. Tutto su Cloudflare.

---

## 0. Architettura target

```
┌──────────────────┐        ┌──────────────────────┐        ┌──────────────────┐
│  Client manuale  │        │  Worker "mcp-server" │        │  Database        │
│  (curl / script) │──HTTP─▶│  endpoint /mcp       │──bind─▶│  AppBenessere    │
└──────────────────┘ JSON-  │  tools / resources   │        │  (D1)            │
┌──────────────────┐  RPC   │  auth: bearer token  │        └──────────────────┘
│ Worker "agent"   │──────▶ └──────────────────────┘                ▲
│ Claude + loop    │                                                │
└──────────────────┘                                  ┌─────────────┴────┐
        ▲                                             │ Worker AppBenes- │
        │ "quante ore ho dormito questa settimana?"   │ sere (esistente, │
     utente                                           │ NON si tocca)    │
                                                      └──────────────────┘
```

**Principi**
- Il worker MCP è **separato** dall'app: l'app esistente non viene modificata.
- Accesso al DB **in sola lettura** e con **query parametrizzate** (niente SQL libero, almeno all'inizio).
- Ogni fase produce qualcosa di funzionante e un piccolo "diario" di cosa si è imparato.

### Struttura repository proposta

```
Experiments/
├── PIANO-MCP-APPBENESSERE.md      ← questo file
├── mcp-server/                    ← Worker MCP (Fase 2-3)
├── mcp-client/                    ← client manuali (Fase 4)
│   ├── curl/                      ← chiamate JSON-RPC grezze
│   ├── raw-fetch.ts               ← client senza SDK
│   └── sdk-client.ts              ← client con @modelcontextprotocol/sdk
├── mcp-agent/                     ← Worker agente con Claude (Fase 5)
└── NOTES.md                       ← diario di bordo
```

---

## Tempistiche complessive

| Fase | Contenuto | Durata stimata | Sessioni |
|------|-----------|----------------|----------|
| 1 | Ricognizione DB e concetti MCP | 2–3 h | 1 |
| 2 | Primo MCP server "hello world" su Worker | 2–3 h | 1 |
| 3 | Tool reali sul database AppBenessere | 3–4 h | 1–2 |
| 4 | Client manuali: curl → fetch → SDK → Inspector | 4–5 h | 2 |
| 5 | Agente su Worker che usa l'MCP server | 4–6 h | 2 |
| 6 | Sicurezza, osservabilità, rifinitura | 3–4 h | 1–2 |
| **Tot.** | | **~18–25 h** | **8–10 sessioni** (≈ 2–3 settimane a 3–4 sessioni/settimana) |

Consiglio: non saltare la Fase 4. È quella in cui si capisce davvero il protocollo; dopo, l'agente diventa "solo" un client automatico.

---

## Fase 1 — Ricognizione e concetti (2–3 h)

### Obiettivi
- Sapere esattamente **che database** usa AppBenessere e com'è fatto.
- Avere chiari i concetti base di MCP.

### Attività
1. **Identificare il DB** dell'app:
   ```bash
   npx wrangler whoami
   npx wrangler d1 list                       # se è D1
   ```
   Nel `wrangler.toml`/`wrangler.jsonc` dell'app cercare il binding (`d1_databases`, `kv_namespaces`, `hyperdrive`…).
2. **Esportare lo schema**:
   ```bash
   npx wrangler d1 execute <NOME_DB> --remote --command "SELECT name, sql FROM sqlite_master WHERE type='table';"
   ```
3. **Creare una copia di sviluppo** del DB (per non sperimentare sui dati reali):
   ```bash
   npx wrangler d1 export <NOME_DB> --remote --output=dump.sql
   npx wrangler d1 create appbenessere-dev
   npx wrangler d1 execute appbenessere-dev --remote --file=dump.sql
   ```
4. **Studio concetti MCP** (annotare in `NOTES.md`):
   - Ruoli: **host** (app/agente), **client** (connessione 1:1 col server), **server** (espone capacità).
   - Primitive: **tools** (azioni/funzioni invocabili), **resources** (dati leggibili per URI), **prompts** (template).
   - Protocollo: **JSON-RPC 2.0**. Ciclo di vita: `initialize` → `notifications/initialized` → `tools/list` → `tools/call`.
   - Trasporti: **stdio** (locale) e **Streamable HTTP** (remoto, quello che useremo su Cloudflare; header `Mcp-Session-Id`).
5. **Scegliere 4–6 domande "utente"** che l'agente dovrà saper soddisfare, es.:
   - "Quante ore ho dormito in media questa settimana?"
   - "Mostrami gli allenamenti di ottobre."
   - "Qual è il trend del mio peso negli ultimi 3 mesi?"
   Da queste deriveranno i tool.

### Deliverable
- `NOTES.md` con schema DB, glossario MCP, lista domande → tool candidati.

### Domande aperte da risolvere qui
- Il DB è **D1**? (Il piano assume D1. Se fosse Postgres esterno → Hyperdrive; se KV → binding KV; se l'accesso deve passare dalle API dell'app → **Service Binding** verso il worker AppBenessere.)
- I dati sono **multi-utente**? Se sì, ogni tool dovrà filtrare per `user_id` (rilevante per l'auth in Fase 6).

---

## Fase 2 — Primo MCP server su Worker (2–3 h)

### Obiettivi
- Capire l'anatomia minima di un server MCP remoto su Cloudflare.

### Attività
1. Creare il progetto:
   ```bash
   npm create cloudflare@latest mcp-server
   cd mcp-server
   npm install agents @modelcontextprotocol/sdk zod
   ```
2. Due approcci possibili (provarli entrambi, sono istruttivi):
   - **A. `McpAgent` (Agents SDK di Cloudflare)** — server con stato, appoggiato a un Durable Object per sessione. È lo standard Cloudflare per MCP remoti.
   - **B. Handler stateless** (`createMcpHandler` dell'Agents SDK, oppure SDK MCP ufficiale con transport Streamable HTTP) — più semplice, nessun Durable Object.
3. Implementare un tool banale `ping` e uno `add(a, b)` con schema `zod`.
4. Avvio in locale:
   ```bash
   npx wrangler dev          # → http://localhost:8787/mcp
   ```
5. Deploy:
   ```bash
   npx wrangler deploy       # → https://mcp-server.<account>.workers.dev/mcp
   ```

### Cosa osservare
- Dove si definiscono nome/versione del server (finiscono nella risposta a `initialize`).
- Come lo schema `zod` diventa il `inputSchema` JSON che il client vede in `tools/list`.
- Differenza pratica tra A e B (sessione, Durable Object, header `Mcp-Session-Id`).

### Deliverable
- Worker deployato con 2 tool di prova; nota in `NOTES.md` su A vs B e scelta motivata.

---

## Fase 3 — Tool reali sul database (3–4 h)

### Obiettivi
- Collegare il worker MCP al DB e progettare tool utili e sicuri.

### Attività
1. **Binding al DB** in `mcp-server/wrangler.jsonc` (lo stesso D1 può essere legato a più worker):
   ```jsonc
   "d1_databases": [
     { "binding": "DB", "database_name": "appbenessere-dev", "database_id": "<ID>" }
   ]
   ```
   (Usare prima la copia `-dev`, passare al DB reale solo a fine Fase 6.)
2. **Progettare i tool** a partire dalle domande della Fase 1. Esempio:

   | Tool | Input | Output |
   |------|-------|--------|
   | `get_schema_overview` | — | tabelle e colonne principali (descrizione testuale) |
   | `list_activities` | `from`, `to`, `type?`, `limit?` | elenco attività |
   | `get_sleep_stats` | `from`, `to` | media/min/max ore di sonno |
   | `get_metric_trend` | `metric`, `from`, `to`, `granularity` | serie temporale |

3. **Regole di implementazione**
   - Solo `SELECT`, sempre con `prepare(...).bind(...)` (mai concatenare stringhe).
   - `limit` con valore massimo (es. 200) per non saturare il contesto dell'agente.
   - **Descrizioni dei tool curate**: sono il "prompt" che l'agente legge per decidere quale tool usare. Scrivere quando usarlo, formato date, unità di misura.
   - Output: testo strutturato o JSON compatto; gestire errori restituendo `isError: true` con messaggio comprensibile.
4. (Facoltativo) Esporre lo schema anche come **resource** (`schema://appbenessere`) per vedere la differenza tra tool e resource.

### Deliverable
- Worker MCP con 3–5 tool reali, testati in locale con `wrangler dev` (in locale si può usare `--remote` o un D1 locale popolato col dump).

---

## Fase 4 — Client manuali: capire il protocollo (4–5 h, 2 sessioni)

Il cuore della sperimentazione: fare **a mano** esattamente quello che farà l'agente.

### 4a. curl — JSON-RPC nudo (1 h)
Salvare ogni chiamata in `mcp-client/curl/` e annotare le risposte.

```bash
URL=http://localhost:8787/mcp

# 1) initialize  → leggere l'header Mcp-Session-Id nella risposta (-i)
curl -i -X POST $URL \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18",
        "capabilities":{},
        "clientInfo":{"name":"curl-client","version":"0.1"}}}'

SID=<valore di Mcp-Session-Id>

# 2) notifica initialized (nessun id: è una notifica)
curl -X POST $URL -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3) elenco tool
curl -X POST $URL -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 4) chiamata a un tool
curl -X POST $URL -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"get_sleep_stats","arguments":{"from":"2026-11-01","to":"2026-11-15"}}}'
```

Osservare: formato SSE (`event: message` / `data: ...`) vs JSON semplice, errori JSON-RPC (`-32602` parametri invalidi, ecc.), cosa succede senza `Mcp-Session-Id`. Usare la versione di protocollo che il server dichiara di supportare.

### 4b. Client TypeScript senza SDK — `raw-fetch.ts` (1–1,5 h)
Riscrivere le 4 chiamate con `fetch`, includendo il parsing di SSE. Eseguire con `npx tsx raw-fetch.ts`. Serve a capire che un client MCP è "solo" HTTP + JSON-RPC + gestione sessione.

### 4c. Client con SDK ufficiale — `sdk-client.ts` (1 h)
```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "sdk-client", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_URL!)));
console.log(await client.listTools());
console.log(await client.callTool({ name: "list_activities", arguments: { from: "2026-10-01", to: "2026-10-31" } }));
await client.close();
```
Confrontare con 4b: cosa fa l'SDK al posto nostro (handshake, sessione, SSE, retry).

### 4d. Strumenti visuali (0,5–1 h)
- **MCP Inspector**: `npx @modelcontextprotocol/inspector` → transport "Streamable HTTP", URL del worker. Permette di vedere la cronologia dei messaggi.
- **Cloudflare AI Playground** (playground.ai.cloudflare.com): collegare il server remoto e chiedere in linguaggio naturale → primo assaggio di "agente".

### Deliverable
- Cartella `mcp-client/` con i 3 client funzionanti contro il server **deployato**.
- In `NOTES.md`: sequenza dei messaggi annotata (un "sequence diagram" testuale del ciclo di vita).

---

## Fase 5 — L'agente che usa il server MCP (4–6 h, 2 sessioni)

### Obiettivi
- Vedere come un LLM decide quali tool chiamare, con quali argomenti, e come compone la risposta.

### 5a. Agente "a mano" in locale (2 h)
Script `mcp-client/agent-loop.ts` che unisce il client SDK (4c) all'API di Claude:
1. `tools/list` sul server MCP → conversione in definizioni tool per l'API Claude (`name`, `description`, `input_schema`).
2. Invio a Claude della domanda utente + tool disponibili (modello consigliato: `claude-sonnet-5-5`, oppure `claude-haiku-5-5` per risparmiare).
3. Se la risposta contiene `tool_use` → eseguire `tools/call` sul server MCP → rimandare il risultato come `tool_result`.
4. Ripetere finché `stop_reason` non è `end_turn`.
5. **Loggare ogni passaggio**: è qui che si vede il "ragionamento" dell'agente (quali tool sceglie, quante chiamate, errori di argomenti).

Testare con le domande della Fase 1 e annotare dove l'agente sbaglia → spesso si corregge migliorando le **descrizioni dei tool** (torna alla Fase 3).

### 5b. Agente su Cloudflare (2–3 h)
Nuovo worker `mcp-agent/`:
- Endpoint `POST /ask { "question": "..." }`.
- Stesso loop di 5a, ma dentro un Worker (chiave API come secret: `npx wrangler secret put ANTHROPIC_API_KEY`).
- Opzioni da confrontare:
  - **Loop gestito da noi** (come 5a) — massimo controllo e visibilità.
  - **Agents SDK di Cloudflare** (`Agent` con client MCP integrato) — stato persistente e connessione MCP gestita.
  - **MCP connector dell'API Claude** — si passa l'URL del server MCP direttamente nella richiesta e l'API fa le chiamate ai tool: meno codice, meno visibilità. Verificare nella documentazione Anthropic lo stato attuale e gli header richiesti.
- Comunicazione worker→worker: via URL pubblico oppure **Service Binding** (più veloce e non esposto). Provare entrambi.

### Deliverable
- `curl -X POST https://mcp-agent.<account>.workers.dev/ask -d '{"question":"Quanto ho dormito questa settimana?"}'` restituisce una risposta corretta.
- Tabella in `NOTES.md`: domanda → tool chiamati → numero di turni → esito.

---

## Fase 6 — Sicurezza, osservabilità, rifinitura (3–4 h)

### Attività
1. **Autenticazione del server MCP**
   - Step 1: bearer token statico (`wrangler secret put MCP_TOKEN`), verificato a ogni richiesta; aggiornare i client della Fase 4.
   - Step 2 (facoltativo, avanzato): OAuth con `@cloudflare/workers-oauth-provider`, necessario se si vuole collegare il server a client come Claude Desktop / claude.ai.
2. **Multi-utente**: se l'app ha più utenti, l'identità deve derivare dal token, **non** da un parametro del tool (altrimenti l'agente potrebbe leggere dati altrui).
3. **Sola lettura forte**: valutare un utente/DB in sola lettura o una *read replica*; mai tool di scrittura senza conferma esplicita.
4. **Osservabilità**: `npx wrangler tail mcp-server` durante i test dell'agente; abilitare Workers Logs; loggare tool chiamato, durata, righe restituite.
5. **Limiti**: rate limiting sull'endpoint `/ask`, timeout, dimensione massima dei risultati.
6. **Passaggio al DB reale**: cambiare il binding da `appbenessere-dev` al DB di produzione solo ora.
7. (Facoltativo) Collegare il server a **Claude Code** (`claude mcp add --transport http appbenessere https://.../mcp`) per interrogare i propri dati dal terminale.

### Deliverable
- Server protetto, agente funzionante su dati reali, `NOTES.md` con lezioni apprese.

---

## Checklist prerequisiti

- [ ] Node.js ≥ 20 e npm
- [ ] Account Cloudflare con accesso al progetto AppBenessere (`npx wrangler login`)
- [ ] Nome e ID del database dell'app
- [ ] Chiave API Anthropic (per Fase 5)
- [ ] Opzionale: Claude Desktop / Claude Code per test finali

## Calendario suggerito (3 sessioni/settimana)

| Settimana | Sessione 1 | Sessione 2 | Sessione 3 |
|-----------|------------|------------|------------|
| 1 | Fase 1 | Fase 2 | Fase 3 (parte 1) |
| 2 | Fase 3 (parte 2) | Fase 4a + 4b | Fase 4c + 4d |
| 3 | Fase 5a | Fase 5b | Fase 6 |

## Criteri di successo finali
1. So spiegare, messaggio per messaggio, cosa succede tra client e server MCP.
2. So scrivere un client MCP sia senza SDK che con SDK.
3. L'agente risponde correttamente ad almeno 4 delle domande scelte in Fase 1, e so perché sceglie certi tool.
4. Tutto gira su Cloudflare, l'app esistente non è stata modificata e il server MCP è protetto.
