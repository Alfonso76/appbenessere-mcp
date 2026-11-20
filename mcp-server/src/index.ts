/**
 * AppBenessere MCP server — Worker Cloudflare separato dall'app.
 *
 * Endpoint MCP: POST /mcp  (trasporto Streamable HTTP, stateless)
 *
 * `createMcpHandler` (agents/mcp/server) chiama la factory a ogni richiesta HTTP:
 * ogni richiesta ottiene un McpServer "fresco", quindi non c'è stato tra le chiamate.
 * Gestisce sia il protocollo 2026-07-28 (`server/discover`, nessuna sessione)
 * sia i client più vecchi che fanno l'handshake `initialize`.
 */
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "./tools";

export interface Env {
  DB: D1Database;
  /** Utente i cui dati vengono esposti. Temporaneo: in Fase 6 arriverà dal token. */
  MCP_USER_ID: string;
  /** Token richiesto nell'header `Authorization: Bearer <token>`. Secret (wrangler secret put / .dev.vars). */
  MCP_TOKEN?: string;
}

/** Confronto a tempo costante, per non rivelare il token tramite i tempi di risposta. */
async function tokenMatches(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  if (!env.MCP_TOKEN) return false; // senza token configurato il server resta chiuso
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match !== null && (await tokenMatches(match[1].trim(), env.MCP_TOKEN));
}

const INSTRUCTIONS = `Server in sola lettura sui dati di AppBenessere, un diario di esercizi (stretching, kung fu, meditazione...).
Modello dei dati:
- ogni esercizio ha una "frequenza" che dice ogni quanti giorni andrebbe fatto (Quotidiano = 1, 7 giorni, 30 giorni);
- una "registrazione" indica che un esercizio è stato svolto in una certa data (al massimo una al giorno per esercizio);
- le "note" sono appunti liberi con data e argomento, a volte collegati a un esercizio.
Le date sono sempre nel formato YYYY-MM-DD. Per domande su "quanto/quando mi sono allenato" usa get_activity_summary o get_entries; per conoscere gli esercizi usa list_exercises; per appunti e osservazioni usa search_notes.`;

function buildServer(env: Env): McpServer {
  const userId = Number(env.MCP_USER_ID);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("MCP_USER_ID non configurato correttamente");
  }
  const server = new McpServer(
    { name: "appbenessere-mcp", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, env.DB, userId);
  return server;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("AppBenessere MCP server. Endpoint MCP: POST /mcp\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // Le richieste preflight CORS non portano l'header Authorization: le lascia gestire all'handler.
    if (request.method !== "OPTIONS" && !(await isAuthorized(request, env))) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json", "WWW-Authenticate": 'Bearer realm="appbenessere-mcp"' },
      });
    }

    const handler = createMcpHandler(() => buildServer(env), { route: "/mcp" });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
