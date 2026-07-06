// ============================================================
//  IMPERIO CRM · El Worker (Cloudflare)
//  Tu CRM propio: sin mensualidades, tus datos son tuyos.
//
//  - POST /lead      : captura un lead (desde tu landing o formulario)
//  - GET  /lead/:id  : ficha completa de un lead (requiere tu clave)
//  - /torre          : Torre de Control — el panel visual (torre.ts)
//
//  Las tablas de la base de datos se crean SOLAS la primera vez.
//  No hay que correr migraciones ni pegar SQL en ningún lado.
// ============================================================

import { json, texto, escapeHtml, upsertLead, getLeadContext, type Env } from "./crm";
import { handleTorre, torreAuthorized } from "./torre";

// ---------- Las tablas se crean solas (una vez por arranque) ----------
let tablasListas: Promise<void> | null = null;

async function crearTablas(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS leads (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        channel     TEXT NOT NULL,
        external_id TEXT,
        name        TEXT,
        phone       TEXT,
        email       TEXT,
        status      TEXT NOT NULL DEFAULT 'nuevo',
        source      TEXT,
        notes       TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (channel, external_id)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id    INTEGER NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        channel    TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (lead_id) REFERENCES leads(id)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id    INTEGER NOT NULL,
        type       TEXT NOT NULL,
        payload    TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (lead_id) REFERENCES leads(id)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS config (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    ),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_events_lead   ON events(lead_id)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_leads_channel ON leads(channel, external_id)`),
  ]);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,x-torre-key",
        },
      });
    }

    try {
      // Primera vez que arranca: crea sus tablas. Si algo falla, reintenta en la próxima visita.
      if (!tablasListas) tablasListas = crearTablas(env);
      try {
        await tablasListas;
      } catch (e) {
        tablasListas = null;
        throw e;
      }

      if (pathname === "/" && request.method === "GET") {
        return new Response(paginaInicio(env), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/health") {
        return json({ ok: true, service: "imperio-crm", time: new Date().toISOString() });
      }

      // ---- Torre de Control (el panel visual) ----
      if (pathname === "/torre" || pathname.startsWith("/torre/")) {
        return await handleTorre(request, env, pathname);
      }

      // ---- Captura de leads ----
      if (pathname === "/lead" && request.method === "POST") {
        return await handleLeadCapture(request, env);
      }
      const leadMatch = pathname.match(/^\/lead\/(\d+)$/);
      if (leadMatch && request.method === "GET") {
        if (!(await torreAuthorized(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
        return await handleGetLead(Number(leadMatch[1]), env);
      }

      return json({ ok: false, error: "not_found" }, 404);
    } catch (err) {
      console.error("Worker error:", err);
      return json({ ok: false, error: "internal_error" }, 500);
    }
  },
};

// ---------- POST /lead : captura desde tu landing ----------
async function handleLeadCapture(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const channel = texto(body.channel, 40) ?? "web";
  const email = texto(body.email);
  const phone = texto(body.phone, 40);
  const externalId = texto(body.external_id) ?? email ?? phone;
  if (!externalId) return json({ ok: false, error: "missing_identifier" }, 400);

  const lead = await upsertLead(env, {
    channel,
    externalId,
    name: texto(body.name, 120),
    source: texto(body.source),
    phone,
    email,
  });
  return json({ ok: true, lead_id: lead.id });
}

// ---------- GET /lead/:id : ficha completa (requiere tu clave) ----------
async function handleGetLead(id: number, env: Env): Promise<Response> {
  const ctx = await getLeadContext(env, id);
  if (!ctx) return json({ ok: false, error: "not_found" }, 404);
  return json({ ok: true, ...ctx });
}

// ---------- GET / : página de bienvenida ----------
function paginaInicio(env: Env): string {
  const negocio = escapeHtml(env.BUSINESS_NAME || "Mi Negocio");
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Imperio CRM · ${negocio}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090a;color:#f4f2ee;font-family:system-ui,sans-serif;padding:20px;box-sizing:border-box;}
  .card{max-width:460px;text-align:center;}
  .ok{font-size:44px;margin-bottom:6px;}
  h1{font-size:22px;margin:0 0 6px;}
  p{color:#8f8d88;font-size:14.5px;line-height:1.6;margin:0 0 22px;}
  a.btn{display:inline-block;padding:13px 26px;border-radius:999px;background:linear-gradient(180deg,#f6edd6,#cdb68c 60%,#b89b64);color:#0b0b0c;font-weight:700;text-decoration:none;font-size:15px;}
  .foot{margin-top:26px;font-size:11.5px;color:#5c5a55;}
  code{background:rgba(255,255,255,0.07);padding:2px 7px;border-radius:6px;font-size:12px;color:#cdb68c;}
</style>
</head>
<body>
  <div class="card">
    <div class="ok">✅</div>
    <h1>Tu Imperio CRM está vivo</h1>
    <p>${negocio} ya tiene CRM propio. Los leads que capture tu landing con <code>POST /lead</code> aparecen en tu Torre de Control.</p>
    <a class="btn" href="/torre">Abrir la Torre de Control →</a>
    <div class="foot">Imperio CRM · hecho con IA · Nómadas Millonarios</div>
  </div>
</body>
</html>`;
}
