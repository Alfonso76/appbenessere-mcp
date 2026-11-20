/**
 * Tool MCP sui dati di AppBenessere.
 *
 * Regole:
 * - solo SELECT, sempre con parametri legati (`prepare().bind()`), mai SQL concatenato;
 * - ogni query è filtrata per `userId`, che arriva dal server e MAI da un argomento del tool;
 * - tabelle mai esposte: users, sessions, chat_conversations, chat_messages;
 * - risultati limitati, per non riempire il contesto dell'agente.
 *
 * Le `description` sono il "prompt" che l'LLM legge per scegliere il tool: vanno curate.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato data atteso: YYYY-MM-DD");

const MAX_RANGE_DAYS = 366;
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Risolve l'intervallo di date con i default (ultimi 7 giorni fino a oggi) e lo valida. */
function resolveRange(from?: string, to?: string): { from: string; to: string } | string {
  const end = to ?? todayUtc();
  const start = from ?? addDays(end, -6);
  if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) return "Data non valida.";
  if (start > end) return `Intervallo non valido: from (${start}) è dopo to (${end}).`;
  if (daysBetween(start, end) > MAX_RANGE_DAYS) return `Intervallo troppo ampio: massimo ${MAX_RANGE_DAYS} giorni.`;
  return { from: start, to: end };
}

/** Esegue l'handler e trasforma le eccezioni in un risultato `isError` leggibile dall'agente. */
async function safely(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    console.error("tool error", err);
    return fail(`Errore interno durante la lettura dei dati: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function registerTools(server: McpServer, db: D1Database, userId: number): void {
  // ------------------------------------------------------------------ list_exercises
  server.registerTool(
    "list_exercises",
    {
      title: "Elenco esercizi",
      description:
        "Elenca gli esercizi dell'utente con la loro frequenza prevista (ogni quanti giorni vanno fatti), " +
        "programma, stile e la data dell'ultima volta in cui sono stati svolti. " +
        "Usalo per sapere quali esercizi esistono o per trovare l'id di un esercizio da passare ad altri tool.",
      inputSchema: z.object({
        include_archived: z
          .boolean()
          .optional()
          .describe("Includi anche gli esercizi archiviati (default: false)."),
      }),
      annotations: READ_ONLY,
    },
    async ({ include_archived }) =>
      safely(async () => {
        const { results } = await db
          .prepare(
            `SELECT e.id, e.name, e.programma, e.stile, e.archived,
                    f.name AS frequenza, f.giorni AS ogni_giorni,
                    (SELECT MAX(en.date) FROM entries en
                      WHERE en.exercise_id = e.id AND en.user_id = e.user_id) AS ultima_volta
               FROM exercises e
               JOIN frequenza f ON f.id = e.frequenza_id AND f.user_id = e.user_id
              WHERE e.user_id = ?1 AND (?2 = 1 OR e.archived = 0)
              ORDER BY f.sort_order, e.ordine_visualiz, e.name`,
          )
          .bind(userId, include_archived ? 1 : 0)
          .all();
        return ok({ oggi: todayUtc(), totale: results.length, esercizi: results });
      }),
  );

  // ------------------------------------------------------------------ get_entries
  server.registerTool(
    "get_entries",
    {
      title: "Registrazioni per giorno",
      description:
        "Restituisce, giorno per giorno, quali esercizi sono stati svolti in un intervallo di date. " +
        "Usalo per domande come 'cosa ho fatto ieri?' o 'quando ho fatto Meditazione questo mese?'. " +
        "Senza date restituisce gli ultimi 7 giorni fino a oggi (UTC). Per conteggi e confronti con la frequenza prevista preferisci get_activity_summary.",
      inputSchema: z.object({
        from: DATE.optional().describe("Data iniziale inclusa, YYYY-MM-DD. Default: 6 giorni prima di 'to'."),
        to: DATE.optional().describe("Data finale inclusa, YYYY-MM-DD. Default: oggi."),
        exercise_id: z.number().int().positive().optional().describe("Filtra su un solo esercizio (id da list_exercises)."),
        limit: z.number().int().min(1).max(500).optional().describe("Numero massimo di registrazioni (default 200, max 500)."),
      }),
      annotations: READ_ONLY,
    },
    async ({ from, to, exercise_id, limit }) =>
      safely(async () => {
        const range = resolveRange(from, to);
        if (typeof range === "string") return fail(range);
        const max = limit ?? 200;

        const { results } = await db
          .prepare(
            `SELECT en.date, e.id AS exercise_id, e.name
               FROM entries en
               JOIN exercises e ON e.id = en.exercise_id AND e.user_id = en.user_id
              WHERE en.user_id = ?1 AND en.date BETWEEN ?2 AND ?3
                AND (?4 IS NULL OR en.exercise_id = ?4)
              ORDER BY en.date DESC, e.ordine_visualiz, e.name
              LIMIT ?5`,
          )
          .bind(userId, range.from, range.to, exercise_id ?? null, max + 1)
          .all<{ date: string; exercise_id: number; name: string }>();

        const truncated = results.length > max;
        const rows = truncated ? results.slice(0, max) : results;
        const byDay = new Map<string, string[]>();
        for (const r of rows) {
          const list = byDay.get(r.date) ?? [];
          list.push(r.name);
          byDay.set(r.date, list);
        }
        return ok({
          ...range,
          registrazioni: rows.length,
          giorni_attivi: byDay.size,
          troncato: truncated,
          giorni: [...byDay].map(([date, esercizi]) => ({ date, esercizi })),
        });
      }),
  );

  // ------------------------------------------------------------------ get_activity_summary
  server.registerTool(
    "get_activity_summary",
    {
      title: "Riepilogo attività e aderenza",
      description:
        "Per ogni esercizio attivo conta quante volte è stato svolto in un intervallo di date e lo confronta con la frequenza prevista: " +
        "volte attese nel periodo, ultima esecuzione, giorni trascorsi e se è 'in ritardo' rispetto alla frequenza. " +
        "Usalo per domande come 'quanto mi sono allenato questo mese?', 'cosa sto trascurando?', 'sono costante?'. " +
        "Senza date usa gli ultimi 7 giorni fino a oggi (UTC).",
      inputSchema: z.object({
        from: DATE.optional().describe("Data iniziale inclusa, YYYY-MM-DD. Default: 6 giorni prima di 'to'."),
        to: DATE.optional().describe("Data finale inclusa, YYYY-MM-DD. Default: oggi."),
      }),
      annotations: READ_ONLY,
    },
    async ({ from, to }) =>
      safely(async () => {
        const range = resolveRange(from, to);
        if (typeof range === "string") return fail(range);
        const periodDays = daysBetween(range.from, range.to) + 1;

        const { results } = await db
          .prepare(
            `SELECT e.id, e.name, f.name AS frequenza, f.giorni,
                    COUNT(CASE WHEN en.date BETWEEN ?2 AND ?3 THEN 1 END) AS volte,
                    MAX(CASE WHEN en.date <= ?3 THEN en.date END) AS ultima_volta
               FROM exercises e
               JOIN frequenza f ON f.id = e.frequenza_id AND f.user_id = e.user_id
               LEFT JOIN entries en ON en.exercise_id = e.id AND en.user_id = e.user_id
              WHERE e.user_id = ?1 AND e.archived = 0
              GROUP BY e.id
              ORDER BY f.sort_order, e.ordine_visualiz, e.name`,
          )
          .bind(userId, range.from, range.to)
          .all<{ id: number; name: string; frequenza: string; giorni: number; volte: number; ultima_volta: string | null }>();

        const esercizi = results.map((r) => {
          const giorniDaUltima = r.ultima_volta ? daysBetween(r.ultima_volta, range.to) : null;
          const attese = r.giorni > 0 ? Math.round((periodDays / r.giorni) * 10) / 10 : null;
          return {
            id: r.id,
            esercizio: r.name,
            frequenza: r.frequenza,
            volte: r.volte,
            volte_attese: attese,
            ultima_volta: r.ultima_volta,
            giorni_da_ultima: giorniDaUltima,
            in_ritardo: r.giorni > 0 && (giorniDaUltima === null || giorniDaUltima >= r.giorni),
          };
        });

        const giorniAttivi = await db
          .prepare(`SELECT COUNT(DISTINCT date) AS n FROM entries WHERE user_id = ?1 AND date BETWEEN ?2 AND ?3`)
          .bind(userId, range.from, range.to)
          .first<number>("n");

        return ok({
          ...range,
          giorni_nel_periodo: periodDays,
          giorni_attivi: giorniAttivi ?? 0,
          registrazioni_totali: esercizi.reduce((s, e) => s + e.volte, 0),
          esercizi_in_ritardo: esercizi.filter((e) => e.in_ritardo).map((e) => e.esercizio),
          esercizi,
        });
      }),
  );

  // ------------------------------------------------------------------ search_notes
  server.registerTool(
    "search_notes",
    {
      title: "Cerca nelle note",
      description:
        "Cerca negli appunti dell'utente (argomento, testo e osservazioni), opzionalmente in un intervallo di date. " +
        "Usalo per domande su consigli ricevuti, tecniche, osservazioni personali, es. 'cosa avevo annotato sull'assetto?'. " +
        "Senza filtri restituisce le note più recenti.",
      inputSchema: z.object({
        text: z.string().min(2).max(100).optional().describe("Testo da cercare (non distingue maiuscole/minuscole)."),
        topic: z.string().min(1).max(100).optional().describe("Filtra sull'argomento della nota (corrispondenza parziale)."),
        from: DATE.optional().describe("Data iniziale inclusa, YYYY-MM-DD."),
        to: DATE.optional().describe("Data finale inclusa, YYYY-MM-DD."),
        limit: z.number().int().min(1).max(50).optional().describe("Numero massimo di note (default 20)."),
      }),
      annotations: READ_ONLY,
    },
    async ({ text, topic, from, to, limit }) =>
      safely(async () => {
        const like = (s?: string) => (s ? `%${escapeLike(s)}%` : null);
        const { results } = await db
          .prepare(
            `SELECT n.id, n.date, n.topic, n.body, n.observations, e.name AS esercizio
               FROM notes n
               LEFT JOIN exercises e ON e.id = n.exercise_id AND e.user_id = n.user_id
              WHERE n.user_id = ?1
                AND (?2 IS NULL OR n.topic LIKE ?2 ESCAPE '\\' OR n.body LIKE ?2 ESCAPE '\\' OR n.observations LIKE ?2 ESCAPE '\\')
                AND (?3 IS NULL OR n.topic LIKE ?3 ESCAPE '\\')
                AND (?4 IS NULL OR n.date >= ?4)
                AND (?5 IS NULL OR n.date <= ?5)
              ORDER BY n.date DESC, n.id DESC
              LIMIT ?6`,
          )
          .bind(userId, like(text), like(topic), from ?? null, to ?? null, limit ?? 20)
          .all();
        return ok({ trovate: results.length, note: results });
      }),
  );
}
