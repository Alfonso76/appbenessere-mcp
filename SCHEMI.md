# Schemi del progetto AppBenessere MCP

> I diagrammi sono in [Mermaid](https://mermaid.js.org/): si vedono già disegnati su GitHub
> e in VS Code con l'anteprima Markdown (`Ctrl+Shift+V`, con l'estensione *Markdown Preview Mermaid Support*).
> Aggiornato al 2026-11-25: è presente solo `mcp-server/`. Client (Fase 4) e agente (Fase 5) vanno aggiunti qui quando ci saranno.

---

## 1. Architettura: chi parla con chi

```mermaid
flowchart LR
    subgraph Client["Client MCP (oggi: curl / PowerShell)"]
        C["curl / Invoke-WebRequest<br/>poi: raw-fetch.ts, sdk-client.ts, agente"]
    end

    subgraph CF["Cloudflare"]
        subgraph W["Worker appbenessere-mcp"]
            IDX["src/index.ts<br/>fetch() + auth"]
            TOOLS["src/tools.ts<br/>4 tool + SQL"]
        end
        DEV[("D1 appbenessere-dev<br/>copia dei dati")]
        PROD[("D1 appbenessere<br/>produzione")]
        APP["Worker AppBenessere<br/>(non lo tocchiamo)"]
    end

    C -- "POST /mcp<br/>JSON-RPC + Bearer token" --> IDX
    IDX --> TOOLS
    TOOLS -- "binding DB<br/>SELECT parametrizzate" --> DEV
    APP --> PROD
    PROD -. "export / import<br/>(fatto a mano, Fase 1)" .-> DEV
```

In locale (`npm run dev`) c'è lo stesso schema, ma il Worker gira in **workerd** sul tuo PC
e il D1 è un file SQLite in `mcp-server/.wrangler/state/`, riempito da `db/dump.sql`.

---

## 2. File: chi usa cosa

```mermaid
flowchart TB
    subgraph Strumenti["Strumenti (chi legge i file)"]
        NPM["npm"]
        WR["wrangler<br/>(dev / deploy)"]
        TSC["tsc<br/>(npm run typecheck)"]
        RT["runtime workerd<br/>(locale o Cloudflare)"]
        GIT["git"]
    end

    PKG["package.json<br/>+ package-lock.json"]
    WJ["wrangler.jsonc"]
    DV[".dev.vars<br/>(MCP_TOKEN locale)"]
    TSCONF["tsconfig.json"]
    IDX["src/index.ts"]
    TOOLS["src/tools.ts"]
    DUMP["db/dump.sql"]
    SCHEMA["db/schema.sql"]
    GI[".gitignore"]

    NPM --> PKG
    NPM -- "npm run ..." --> WR
    NPM -- "npm run typecheck" --> TSC
    WR --> WJ
    WR --> DV
    WR -- "main: src/index.ts<br/>(compila con esbuild)" --> IDX
    WR -- "npm run db:seed-local" --> DUMP
    TSC --> TSCONF
    TSC --> IDX
    RT --> IDX
    IDX -- "import registerTools" --> TOOLS
    GIT --> GI
    SCHEMA -. "solo documentazione<br/>(lo leggiamo noi)" .-> TOOLS
```

| File | Cosa contiene | Chi lo usa | Su git? |
|------|---------------|-----------|---------|
| `mcp-server/package.json` | nome progetto, dipendenze, script `dev`/`deploy`/`typecheck`/`db:seed-local`/`tail` | npm | sì |
| `mcp-server/package-lock.json` | versioni esatte di tutte le dipendenze | npm (`npm install` / `npm ci`) | sì |
| `mcp-server/wrangler.jsonc` | nome Worker, file d'ingresso, binding `DB`, variabile `MCP_USER_ID`, secret richiesto `MCP_TOKEN`, log attivi | wrangler | sì |
| `mcp-server/.dev.vars` | `MCP_TOKEN=...` per l'uso in locale | `wrangler dev` | **no** |
| `mcp-server/tsconfig.json` | regole TypeScript, tipi dei Workers | `tsc` ed editor (wrangler non lo usa per compilare) | sì |
| `mcp-server/src/index.ts` | punto d'ingresso HTTP, controllo token, creazione del server MCP | runtime del Worker | sì |
| `mcp-server/src/tools.ts` | i 4 tool, schemi zod, query SQL, funzioni di supporto | `index.ts` | sì |
| `mcp-server/README.md` | istruzioni d'uso e checklist | noi | sì |
| `db/schema.sql` | struttura del DB dell'app | noi (riferimento per scrivere le query) | sì |
| `db/dump.sql` | schema + **dati reali** | `npm run db:seed-local` | **no** |
| `.gitignore` | cosa git deve ignorare | git | sì |
| `.wrangler/`, `node_modules/` | stato locale (D1 locale, cache) e librerie installate | wrangler / npm | no |
| `PIANO-MCP-APPBENESSERE.md`, `SCHEMI.md` | piano e schemi | noi | sì |
| `DBDEV` | appunti su `appbenessere-dev` | noi | sì (attenzione: non metterci token) |

---

## 3. Dipendenze tra le funzioni (dentro il codice)

```mermaid
flowchart TB
    subgraph index["src/index.ts"]
        F["export default fetch(request, env, ctx)"]
        AUTH["isAuthorized(request, env)"]
        TM["tokenMatches(given, expected)<br/>SHA-256 + timingSafeEqual"]
        BS["buildServer(env)"]
        INS["INSTRUCTIONS<br/>(testo per l'LLM)"]
    end

    subgraph lib["librerie"]
        CMH["createMcpHandler<br/>(agents/mcp/server)"]
        MCP["McpServer<br/>(@modelcontextprotocol/server)"]
        Z["zod"]
    end

    subgraph tools["src/tools.ts"]
        RT["registerTools(server, db, userId)"]
        T1["list_exercises"]
        T2["get_entries"]
        T3["get_activity_summary"]
        T4["search_notes"]
        SAFE["safely(fn)"]
        RR["resolveRange(from, to)"]
        OK["ok(data)"]
        FAIL["fail(msg)"]
        H["todayUtc / addDays / daysBetween"]
        EL["escapeLike(s)"]
        DATE["DATE (schema zod)"]
    end

    F --> AUTH --> TM
    F --> CMH
    CMH -- "chiama la factory<br/>a ogni richiesta" --> BS
    BS --> MCP
    BS --> INS
    BS --> RT
    RT -- "server.registerTool(...)" --> T1 & T2 & T3 & T4
    T1 & T2 & T3 & T4 --> SAFE
    T2 & T3 --> RR --> H
    T1 --> H
    T4 --> EL
    T1 & T2 & T3 & T4 --> OK
    SAFE --> FAIL
    RR -. "errore" .-> FAIL
    DATE --> Z
    T2 & T3 & T4 --> DATE
```

---

## 4. Il viaggio di una richiesta `tools/call`

```mermaid
sequenceDiagram
    autonumber
    participant C as Client (curl)
    participant F as index.ts fetch()
    participant A as isAuthorized
    participant H as createMcpHandler
    participant S as McpServer (nuovo a ogni richiesta)
    participant T as tool get_entries
    participant D as D1 (DB)

    C->>F: POST /mcp  Authorization: Bearer ...  {"method":"tools/call", ...}
    F->>A: controlla il token
    alt token mancante o sbagliato
        A-->>F: false
        F-->>C: 401 {"error":"unauthorized"}
    else token corretto
        A-->>F: true
        F->>H: handler(request, env, ctx)
        H->>S: buildServer(env) → registerTools(...)
        H->>S: passa il messaggio JSON-RPC
        S->>S: valida gli arguments con lo schema zod
        alt argomenti non validi
            S-->>H: result.isError = true (messaggio leggibile)
        else argomenti validi
            S->>T: handler({from, to, ...})
            T->>T: resolveRange() → default ultimi 7 giorni
            T->>D: prepare(SELECT ...).bind(userId, from, to, ...)
            D-->>T: righe
            T->>T: raggruppa per giorno → ok(json)
            T-->>S: { content: [{type:"text", text:"{...}"}] }
        end
        S-->>H: risposta JSON-RPC (id uguale a quello della richiesta)
        H-->>C: 200  event: message / data: {...}  (SSE)
    end
```

Punti chiave:
- **Stateless**: il server MCP viene ricreato a ogni richiesta, quindi non esiste `Mcp-Session-Id`.
- `userId` arriva da `MCP_USER_ID` in `wrangler.jsonc`, **mai** dagli argomenti del tool.
- Gli errori "di dominio" (data sbagliata, intervallo troppo ampio, eccezione SQL) tornano come `isError: true` dentro una risposta **riuscita**: l'LLM li legge e può correggersi.
  Un tool inesistente invece è un errore di protocollo JSON-RPC (`-32602`).

---

## 5. Ciclo di vita del protocollo (cosa fa un client)

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server MCP

    Note over C,S: Handshake classico (revisioni 2025-xx)
    C->>S: initialize {protocolVersion, capabilities, clientInfo}
    S-->>C: {protocolVersion, serverInfo: appbenessere-mcp 0.1.0, capabilities: {tools}, instructions}
    C->>S: notifications/initialized  (notifica: niente id, niente risposta)
    S-->>C: 202 Accepted

    Note over C,S: Scoperta dei tool
    C->>S: tools/list
    S-->>C: [list_exercises, get_entries, get_activity_summary, search_notes] con inputSchema JSON

    Note over C,S: Uso (quante volte serve)
    C->>S: tools/call {name, arguments}
    S-->>C: {content:[{type:"text", text}], isError?}
```

Con la revisione 2026-07-28 il client può saltare l'handshake (`server/discover` + header `MCP-Protocol-Version`):
per questo nei test con `curl` basta mandare direttamente `tools/list` con `MCP-Protocol-Version: 2025-11-25`.

---

## 6. Dipendenze tra i tool (come li concatena un agente)

```mermaid
flowchart LR
    Q(["Domanda dell'utente"])
    LE["list_exercises<br/>→ id, nome, frequenza, ultima_volta"]
    GE["get_entries<br/>(from, to, exercise_id?)"]
    GS["get_activity_summary<br/>(from, to)"]
    SN["search_notes<br/>(text?, topic?, from?, to?)"]

    Q -- "quali esercizi ho?" --> LE
    Q -- "cosa ho fatto ieri?" --> GE
    Q -- "sono costante? cosa trascuro?" --> GS
    Q -- "cosa avevo annotato su...?" --> SN
    LE -- "exercise_id" --> GE
    GS -. "id degli esercizi in ritardo" .-> GE
```

L'unica dipendenza "dura" è `exercise_id`: per filtrare `get_entries` su un esercizio
bisogna prima conoscerne l'id con `list_exercises` (o leggerlo da `get_activity_summary`).
Gli altri tool sono indipendenti tra loro.

---

## 7. Tabelle del database usate dai tool

```mermaid
erDiagram
    frequenza ||--o{ exercises : "frequenza_id"
    exercises ||--o{ entries : "exercise_id"
    exercises |o--o{ notes : "exercise_id (facoltativo)"

    frequenza {
        int id
        int user_id
        text name "Quotidiano, 7 giorni..."
        int giorni "ogni quanti giorni"
        int sort_order
    }
    exercises {
        int id
        int user_id
        int frequenza_id
        text name
        int archived
        text programma
        text stile
    }
    entries {
        int id
        int user_id
        int exercise_id
        text date "YYYY-MM-DD, una al giorno"
    }
    notes {
        int id
        int user_id
        int exercise_id
        text date
        text topic
        text body
        text observations
    }
```

| Tool | Tabelle lette |
|------|---------------|
| `list_exercises` | `exercises`, `frequenza`, `entries` (per `ultima_volta`) |
| `get_entries` | `entries`, `exercises` |
| `get_activity_summary` | `exercises`, `frequenza`, `entries` |
| `search_notes` | `notes`, `exercises` |

**Mai lette**: `users` (hash delle password), `sessions` (token), `chat_conversations`, `chat_messages`, `exercises_master`, `d1_migrations`.
