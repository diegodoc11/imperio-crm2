// ============================================================
//  IMPERIO CRM · Piezas compartidas
//  El tipo Env, los helpers de base de datos y utilidades que
//  usan tanto el Worker (index.ts) como la Torre (torre.ts).
// ============================================================

export interface Env {
  DB: D1Database;
  BUSINESS_NAME?: string;
  BRAND_COLOR?: string;
  TIMEZONE?: string;
  TORRE_KEY?: string; // opcional: clave fija por secreto (si no, se crea en la primera visita a /torre)
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });

// Limpia un texto que viene de afuera: recorta espacios y limita el largo.
export const texto = (v: unknown, max = 300): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---------- CRM: una fila en `leads` por persona ----------
export interface UpsertInput {
  channel: string;
  externalId: string;
  name?: string | null;
  source?: string | null;
  phone?: string | null;
  email?: string | null;
}

export async function upsertLead(env: Env, i: UpsertInput): Promise<{ id: number; status: string }> {
  const row = await env.DB.prepare(
    `INSERT INTO leads (channel, external_id, name, source, phone, email)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel, external_id) DO UPDATE SET
       last_seen = datetime('now'),
       name   = COALESCE(excluded.name,  leads.name),
       phone  = COALESCE(excluded.phone, leads.phone),
       email  = COALESCE(excluded.email, leads.email),
       source = COALESCE(leads.source, excluded.source)
     RETURNING id, status`
  )
    .bind(i.channel, i.externalId, i.name ?? null, i.source ?? null, i.phone ?? null, i.email ?? null)
    .first<{ id: number; status: string }>();
  if (!row) throw new Error("upsertLead: la base de datos no devolvió la fila");
  return row;
}

// Ficha completa de un lead (datos + conversación).
export async function getLeadContext(env: Env, id: number) {
  const lead = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
  if (!lead) return null;
  const msgs = await env.DB.prepare(
    "SELECT role, content, created_at FROM messages WHERE lead_id = ? ORDER BY id ASC"
  )
    .bind(id)
    .all();
  return { lead, messages: msgs.results ?? [] };
}
