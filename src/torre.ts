// ============================================================
//  IMPERIO CRM · Torre de Control (el panel visual)
//  - GET  /torre                      : la página (setup + login + panel)
//  - GET  /torre/api/estado           : ¿ya se creó la clave? (público)
//  - POST /torre/api/setup            : crea la clave (solo la primera vez)
//  - GET  /torre/api/stats            : métricas y series para los gráficos
//  - GET  /torre/api/leads            : lista con filtros, búsqueda y paginación
//  - GET  /torre/api/lead/:id         : ficha completa (datos + conversación + eventos)
//  - POST /torre/api/lead/:id/estado  : cambiar la temperatura del lead
//  - POST /torre/api/lead/:id/notas   : guardar tus notas del lead
//  - POST /torre/api/lead/nuevo       : agregar un lead a mano
//
//  Auth: cabecera x-torre-key. La clave se crea en la PRIMERA visita a /torre
//  (se guarda con hash en la tabla config; nunca en texto plano) o, si
//  prefieres, por secreto: printf '%s' 'CLAVE' | npx wrangler secret put TORRE_KEY
// ============================================================

import { json, texto, escapeHtml, upsertLead, getLeadContext, type Env } from "./crm";

const ESTADOS_VALIDOS = ["nuevo", "curioso", "tibio", "caliente", "calificado", "agendo", "comprador", "baja"];

// ---------- Clave de la Torre ----------
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function claveGuardada(env: Env): Promise<{ hash: string; salt: string } | null> {
  const rs = await env.DB.prepare(
    "SELECT key, value FROM config WHERE key IN ('torre_key_hash','torre_key_salt')"
  ).all<{ key: string; value: string }>();
  const m = new Map((rs.results ?? []).map((r) => [r.key, r.value]));
  const hash = m.get("torre_key_hash");
  const salt = m.get("torre_key_salt");
  return hash && salt ? { hash, salt } : null;
}

export async function torreAuthorized(request: Request, env: Env): Promise<boolean> {
  const key = request.headers.get("x-torre-key") || "";
  if (!key) return false;
  if (env.TORRE_KEY && key === env.TORRE_KEY) return true;
  const g = await claveGuardada(env);
  if (!g) return false;
  return (await sha256Hex(g.salt + key)) === g.hash;
}

// ---------- Router de la Torre ----------
export async function handleTorre(request: Request, env: Env, pathname: string): Promise<Response> {
  if (pathname === "/torre" || pathname === "/torre/") {
    return new Response(torreHtml(env), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (!pathname.startsWith("/torre/api/")) return json({ ok: false, error: "not_found" }, 404);

  // Públicos (necesarios antes de tener clave):
  if (pathname === "/torre/api/estado" && request.method === "GET") return torreEstado(env);
  if (pathname === "/torre/api/setup" && request.method === "POST") return torreSetup(request, env);

  // Todo lo demás requiere la clave:
  if (!(await torreAuthorized(request, env))) return json({ ok: false, error: "unauthorized" }, 401);

  const url = new URL(request.url);
  if (pathname === "/torre/api/stats" && request.method === "GET") return torreStats(env);
  if (pathname === "/torre/api/leads" && request.method === "GET") return torreLeads(env, url);
  if (pathname === "/torre/api/lead/nuevo" && request.method === "POST") return torreLeadNuevo(request, env);

  let m = pathname.match(/^\/torre\/api\/lead\/(\d+)$/);
  if (m && request.method === "GET") return torreLead(env, Number(m[1]));
  m = pathname.match(/^\/torre\/api\/lead\/(\d+)\/estado$/);
  if (m && request.method === "POST") return torreCambiarEstado(request, env, Number(m[1]));
  m = pathname.match(/^\/torre\/api\/lead\/(\d+)\/notas$/);
  if (m && request.method === "POST") return torreGuardarNotas(request, env, Number(m[1]));

  return json({ ok: false, error: "not_found" }, 404);
}

// ---------- /torre/api/estado : ¿ya hay clave? ----------
async function torreEstado(env: Env): Promise<Response> {
  const configurada = !!env.TORRE_KEY || !!(await claveGuardada(env));
  return json({ ok: true, configurada });
}

// ---------- /torre/api/setup : crear la clave (una sola vez) ----------
async function torreSetup(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const clave = typeof body.key === "string" ? body.key.trim() : "";
  if (clave.length < 6) return json({ ok: false, error: "clave_corta" }, 400);
  if (env.TORRE_KEY || (await claveGuardada(env))) return json({ ok: false, error: "ya_configurada" }, 409);

  const salt = crypto.randomUUID();
  const hash = await sha256Hex(salt + clave);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO config (key, value) VALUES ('torre_key_salt', ?)").bind(salt),
    env.DB.prepare("INSERT OR IGNORE INTO config (key, value) VALUES ('torre_key_hash', ?)").bind(hash),
  ]);
  // Si dos pestañas intentaron crear clave al tiempo, gana la primera.
  const g = await claveGuardada(env);
  if (!g || g.hash !== hash) return json({ ok: false, error: "ya_configurada" }, 409);
  return json({ ok: true });
}

// ---------- Zona horaria: "hoy" debe ser TU hoy ----------
function offsetMinutos(tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(
      new Date()
    );
    const s = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    if (/^(GMT|UTC)$/.test(s)) return 0;
    const m = s.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!m) return -300;
    const min = Number(m[2]) * 60 + Number(m[3]);
    return (m[1] === "-" ? -1 : 1) * min;
  } catch {
    return -300; // si la zona está mal escrita, usamos hora de Colombia
  }
}

function zonaHoraria(env: Env): string {
  const tz = env.TIMEZONE || "America/Bogota";
  return /^[A-Za-z0-9_+\/-]+$/.test(tz) ? tz : "America/Bogota";
}

// ---------- /torre/api/stats ----------
async function torreStats(env: Env): Promise<Response> {
  const db = env.DB;
  let off = offsetMinutos(zonaHoraria(env));
  if (!Number.isFinite(off)) off = -300;
  const mod = `${off} minutes`;
  const rs = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM leads"),
    db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE date(created_at, '${mod}') = date('now', '${mod}')`),
    db.prepare("SELECT COUNT(*) AS n FROM leads WHERE created_at >= datetime('now','-7 days')"),
    db.prepare("SELECT COUNT(*) AS n FROM leads WHERE status = 'comprador'"),
    db.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status"),
    db.prepare("SELECT channel, COUNT(*) AS n FROM leads GROUP BY channel ORDER BY n DESC"),
    db.prepare(
      `SELECT date(created_at, '${mod}') AS d, COUNT(*) AS n FROM leads WHERE created_at >= datetime('now','-31 days') GROUP BY d ORDER BY d`
    ),
    db.prepare(
      "SELECT COALESCE(NULLIF(source,''),'(sin origen)') AS s, COUNT(*) AS n FROM leads GROUP BY s ORDER BY n DESC LIMIT 8"
    ),
  ]);
  const first = (i: number) => (rs[i].results?.[0] as { n: number } | undefined)?.n ?? 0;
  return json({
    ok: true,
    total: first(0),
    hoy: first(1),
    semana: first(2),
    compradores: first(3),
    por_estado: rs[4].results ?? [],
    por_canal: rs[5].results ?? [],
    por_dia: rs[6].results ?? [],
    origenes: rs[7].results ?? [],
  });
}

// ---------- /torre/api/leads ----------
async function torreLeads(env: Env, url: URL): Promise<Response> {
  const db = env.DB;
  const status = url.searchParams.get("status") || "";
  const channel = url.searchParams.get("channel") || "";
  const q = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || "1") || 1);
  const LIMIT = 50;
  const offset = (page - 1) * LIMIT;

  const where: string[] = [];
  const binds: unknown[] = [];
  if (status) { where.push("status = ?"); binds.push(status); }
  if (channel) { where.push("channel = ?"); binds.push(channel); }
  if (q) {
    where.push("(name LIKE ? OR email LIKE ? OR phone LIKE ? OR external_id LIKE ? OR source LIKE ?)");
    const like = `%${q}%`;
    binds.push(like, like, like, like, like);
  }
  const W = where.length ? " WHERE " + where.join(" AND ") : "";

  const rs = await db.batch([
    db
      .prepare(
        `SELECT id, channel, external_id, name, phone, email, status, source, created_at, last_seen
         FROM leads${W} ORDER BY last_seen DESC LIMIT ${LIMIT} OFFSET ${offset}`
      )
      .bind(...binds),
    db.prepare(`SELECT COUNT(*) AS n FROM leads${W}`).bind(...binds),
  ]);
  const total = (rs[1].results?.[0] as { n: number } | undefined)?.n ?? 0;
  return json({ ok: true, leads: rs[0].results ?? [], total, page, limit: LIMIT });
}

// ---------- /torre/api/lead/:id : la ficha ----------
async function torreLead(env: Env, id: number): Promise<Response> {
  const ctx = await getLeadContext(env, id);
  if (!ctx) return json({ ok: false, error: "not_found" }, 404);
  const ev = await env.DB.prepare(
    "SELECT type, payload, created_at FROM events WHERE lead_id = ? ORDER BY id DESC LIMIT 100"
  )
    .bind(id)
    .all();
  return json({ ok: true, ...ctx, events: ev.results ?? [] });
}

// ---------- /torre/api/lead/:id/estado : mover en el embudo ----------
async function torreCambiarEstado(request: Request, env: Env, id: number): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const estado = typeof body.status === "string" ? body.status.trim() : "";
  if (!ESTADOS_VALIDOS.includes(estado)) return json({ ok: false, error: "estado_invalido" }, 400);
  const r = await env.DB.prepare("UPDATE leads SET status = ? WHERE id = ?").bind(estado, id).run();
  if (!r.meta.changes) return json({ ok: false, error: "not_found" }, 404);
  await env.DB.prepare("INSERT INTO events (lead_id, type) VALUES (?, ?)")
    .bind(id, `estado: ${estado}`)
    .run();
  return json({ ok: true });
}

// ---------- /torre/api/lead/:id/notas ----------
async function torreGuardarNotas(request: Request, env: Env, id: number): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const notas = texto(body.notes, 5000) ?? "";
  const r = await env.DB.prepare("UPDATE leads SET notes = ? WHERE id = ?").bind(notas, id).run();
  if (!r.meta.changes) return json({ ok: false, error: "not_found" }, 404);
  return json({ ok: true });
}

// ---------- /torre/api/lead/nuevo : agregar a mano ----------
async function torreLeadNuevo(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const email = texto(body.email);
  const phone = texto(body.phone, 40);
  const externalId = email ?? phone;
  if (!externalId) return json({ ok: false, error: "falta_contacto" }, 400);
  const lead = await upsertLead(env, {
    channel: "manual",
    externalId,
    name: texto(body.name, 120),
    source: texto(body.source),
    phone,
    email,
  });
  return json({ ok: true, lead_id: lead.id });
}

// ============================================================
//  LA PÁGINA (un solo archivo, sin dependencias)
//  Ojo: el JS de la página usa concatenación (nada de backticks)
//  para convivir dentro de este template literal de TypeScript.
// ============================================================

// -- Colores de marca: del hex del negocio salen las variantes --
function colorValido(c: string | undefined): string {
  return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : "#cdb68c";
}
function canal(hex: string, i: number): number {
  return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
}
function aHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}
function haciaBlanco(hex: string, p: number): string {
  const [r, g, b] = [canal(hex, 0), canal(hex, 1), canal(hex, 2)];
  return aHex(r + (255 - r) * p, g + (255 - g) * p, b + (255 - b) * p);
}
function haciaNegro(hex: string, p: number): string {
  return aHex(canal(hex, 0) * (1 - p), canal(hex, 1) * (1 - p), canal(hex, 2) * (1 - p));
}

function torreHtml(env: Env): string {
  const negocio = escapeHtml(env.BUSINESS_NAME || "Mi Negocio");
  const color = colorValido(env.BRAND_COLOR);
  const rgb = `${canal(color, 0)},${canal(color, 1)},${canal(color, 2)}`;
  const colorClaro = haciaBlanco(color, 0.55);
  const colorOscuro = haciaNegro(color, 0.18);
  const tz = zonaHoraria(env);

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Torre de Control · ${negocio}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%2309090a'/%3E%3Ctext x='32' y='44' font-family='Archivo,sans-serif' font-size='34' font-weight='900' fill='%23${color.slice(1)}' text-anchor='middle'%3ET%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#09090a; --card:#121215; --card2:#0d0d10; --line:rgba(255,255,255,0.08);
    --gold:${color}; --gold-rgb:${rgb}; --gold-soft:rgba(${rgb},0.16);
    --ink:#f4f2ee; --ink2:#cfcdc7; --muted:#8f8d88;
  }
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);font-family:'Archivo',system-ui,sans-serif;-webkit-font-smoothing:antialiased;}
  [hidden]{display:none !important;}
  .mono{font-family:'JetBrains Mono',monospace;}
  .wrap{max-width:1180px;margin:0 auto;padding:22px 20px 70px;}
  /* ---------- login / setup ---------- */
  .login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
  .login-card{width:100%;max-width:380px;background:linear-gradient(180deg,#131316,#0d0d10);border:1px solid rgba(var(--gold-rgb),0.28);border-radius:20px;padding:34px 28px;box-shadow:0 40px 110px -20px rgba(0,0,0,0.9);}
  .login-card h1{margin:0 0 4px;font-size:21px;font-weight:800;}
  .login-card p{margin:0 0 20px;font-size:13.5px;color:var(--muted);line-height:1.55;}
  .login-card input{width:100%;padding:14px 16px;border-radius:12px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);color:var(--ink);font-family:'JetBrains Mono',monospace;font-size:15px;outline:none;margin-bottom:10px;}
  .login-card input:focus{border-color:rgba(var(--gold-rgb),0.65);box-shadow:0 0 0 3px rgba(var(--gold-rgb),0.13);}
  .login-err{color:#e6a99a;font-size:13px;margin:4px 0 8px;min-height:16px;}
  .login-logo{width:40px;height:40px;border-radius:11px;background:#09090a;border:1px solid rgba(var(--gold-rgb),0.4);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:21px;color:var(--gold);}
  /* ---------- header ---------- */
  .top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:22px;}
  .brand{display:flex;align-items:center;gap:12px;margin-right:auto;}
  .brand .logo{width:38px;height:38px;border-radius:10px;background:#0d0d10;border:1px solid rgba(var(--gold-rgb),0.4);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:20px;color:var(--gold);}
  .brand h1{margin:0;font-size:17px;font-weight:800;letter-spacing:-0.01em;}
  .brand .sub{font-size:11px;letter-spacing:0.14em;color:var(--muted);text-transform:uppercase;font-family:'JetBrains Mono',monospace;}
  /* ---------- botones ---------- */
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 18px;border:0;cursor:pointer;border-radius:999px;font-size:14px;font-weight:700;font-family:'Archivo',sans-serif;color:#0b0b0c;background:linear-gradient(180deg,${colorClaro},${color} 60%,${colorOscuro});}
  .btn.full{width:100%;padding:14px;font-size:15px;}
  .btn.ghost{background:none;color:var(--ink2);border:1px solid var(--line);font-weight:600;}
  .btn.ghost:hover{border-color:rgba(var(--gold-rgb),0.5);color:var(--ink);}
  /* ---------- tiles ---------- */
  .tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:14px;}
  .tile{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--line);border-radius:16px;padding:18px 20px 16px;position:relative;overflow:hidden;}
  .tile::before{content:'';position:absolute;top:0;left:20px;right:20px;height:2px;background:linear-gradient(90deg,var(--gold),transparent);opacity:0.7;}
  .tile .k{font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;}
  .tile .v{font-size:34px;font-weight:800;letter-spacing:-0.02em;line-height:1;font-variant-numeric:tabular-nums;}
  .tile .s{font-size:12px;color:var(--muted);margin-top:7px;}
  /* ---------- cards / gráficos ---------- */
  .grid{display:grid;grid-template-columns:1.6fr 1fr;gap:14px;margin-bottom:14px;}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;}
  .card{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--line);border-radius:16px;padding:18px 20px;}
  .card h2{margin:0 0 14px;font-size:13px;font-weight:700;letter-spacing:0.02em;color:var(--ink2);display:flex;align-items:center;gap:8px;}
  .card h2 .dot{width:7px;height:7px;border-radius:50%;background:var(--gold);}
  .hbar-row{display:grid;grid-template-columns:96px 1fr 44px;align-items:center;gap:10px;margin:9px 0;}
  .hbar-row .lbl{font-size:12.5px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .hbar-row .track{height:13px;background:rgba(255,255,255,0.045);border-radius:0 4px 4px 0;position:relative;}
  .hbar-row .fill{position:absolute;inset:0 auto 0 0;background:var(--gold);border-radius:0 4px 4px 0;min-width:2px;}
  .hbar-row .fill.zero{background:rgba(255,255,255,0.10);}
  .hbar-row .num{font-family:'JetBrains Mono',monospace;font-size:12.5px;color:var(--ink);text-align:right;font-variant-numeric:tabular-nums;}
  .src-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05);}
  .src-row:last-child{border-bottom:0;}
  .src-row .s{flex:1;font-size:12.5px;color:var(--ink2);font-family:'JetBrains Mono',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .src-row .n{font-family:'JetBrains Mono',monospace;font-size:12.5px;color:var(--ink);}
  /* ---------- chips de estado ---------- */
  .chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px 4px;border-radius:999px;font-size:11.5px;font-weight:600;letter-spacing:0.02em;white-space:nowrap;border:1px solid;}
  .chip::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;}
  .st-nuevo{color:#a8c4e0;background:rgba(127,167,207,0.12);border-color:rgba(127,167,207,0.35);}
  .st-curioso{color:#8fc1f2;background:rgba(93,162,232,0.12);border-color:rgba(93,162,232,0.35);}
  .st-tibio{color:#ecd28a;background:rgba(227,192,105,0.12);border-color:rgba(227,192,105,0.35);}
  .st-caliente{color:#f2a97f;background:rgba(232,139,90,0.13);border-color:rgba(232,139,90,0.38);}
  .st-calificado{color:#cbaae6;background:rgba(180,143,217,0.13);border-color:rgba(180,143,217,0.36);}
  .st-agendo{color:#93d6c9;background:rgba(114,198,184,0.12);border-color:rgba(114,198,184,0.36);}
  .st-comprador{color:#9fd8ab;background:rgba(127,196,143,0.13);border-color:rgba(127,196,143,0.4);}
  .st-baja{color:#9a988f;background:rgba(143,141,136,0.10);border-color:rgba(143,141,136,0.3);}
  .ch{display:inline-block;padding:2px 7px 3px;border-radius:6px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:0.08em;color:var(--muted);border:1px solid var(--line);text-transform:uppercase;}
  /* ---------- filtros + tabla ---------- */
  .filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;}
  .filters select,.filters input{padding:10px 13px;border-radius:10px;border:1px solid rgba(255,255,255,0.13);background:#0d0d10;color:var(--ink);font-family:'Archivo',sans-serif;font-size:13.5px;outline:none;}
  .filters input{flex:1;min-width:180px;}
  .filters select:focus,.filters input:focus{border-color:rgba(var(--gold-rgb),0.6);}
  table{width:100%;border-collapse:collapse;}
  th{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-weight:500;}
  td{padding:11px 10px;border-bottom:1px solid rgba(255,255,255,0.05);font-size:13.5px;vertical-align:middle;}
  tbody tr{cursor:pointer;}
  tbody tr:hover{background:rgba(var(--gold-rgb),0.05);}
  td .nm{font-weight:600;color:var(--ink);}
  td .em{font-size:12px;color:var(--muted);font-family:'JetBrains Mono',monospace;}
  td .src{font-size:11.5px;color:var(--muted);font-family:'JetBrains Mono',monospace;max-width:210px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;}
  td .tm{font-size:12px;color:var(--muted);white-space:nowrap;}
  .pager{display:flex;align-items:center;gap:12px;justify-content:flex-end;margin-top:14px;}
  .pager .info{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--muted);}
  .empty{padding:34px 10px;text-align:center;color:var(--muted);font-size:14px;}
  /* ---------- ficha (drawer) ---------- */
  .drawer-bg{position:fixed;inset:0;background:rgba(5,5,7,0.6);backdrop-filter:blur(3px);z-index:40;}
  .drawer{position:fixed;top:0;right:0;bottom:0;width:min(440px,100%);background:#0f0f12;border-left:1px solid rgba(var(--gold-rgb),0.25);z-index:41;padding:24px 22px;overflow-y:auto;}
  .drawer h3{margin:0 0 2px;font-size:19px;font-weight:800;}
  .drawer .close{position:absolute;top:14px;right:16px;background:none;border:0;color:var(--muted);font-size:24px;cursor:pointer;padding:4px;}
  .fgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0;}
  .fitem{background:rgba(255,255,255,0.03);border:1px solid var(--line);border-radius:10px;padding:10px 12px;}
  .fitem .k{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);margin-bottom:4px;}
  .fitem .v{font-size:13px;color:var(--ink2);word-break:break-word;}
  .sec{font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:0.14em;text-transform:uppercase;color:var(--gold);margin:20px 0 10px;}
  .dsel{padding:10px 13px;border-radius:10px;border:1px solid rgba(255,255,255,0.13);background:#0d0d10;color:var(--ink);font-family:'Archivo',sans-serif;font-size:13.5px;outline:none;flex:1;}
  .dsel:focus{border-color:rgba(var(--gold-rgb),0.6);}
  .dnotas{width:100%;min-height:92px;padding:11px 13px;border-radius:10px;border:1px solid rgba(255,255,255,0.13);background:rgba(255,255,255,0.04);color:var(--ink);font-family:'Archivo',sans-serif;font-size:13.5px;line-height:1.5;outline:none;resize:vertical;}
  .dnotas:focus{border-color:rgba(var(--gold-rgb),0.6);}
  .msg{max-width:88%;padding:10px 13px;border-radius:13px;font-size:13.5px;line-height:1.5;margin:7px 0;white-space:pre-wrap;word-break:break-word;}
  .msg.user{background:rgba(255,255,255,0.06);color:var(--ink2);border-bottom-left-radius:4px;}
  .msg.assistant{background:rgba(var(--gold-rgb),0.13);border:1px solid rgba(var(--gold-rgb),0.2);color:var(--ink);margin-left:auto;border-bottom-right-radius:4px;}
  .msg .t{display:block;font-family:'JetBrains Mono',monospace;font-size:9.5px;color:var(--muted);margin-top:6px;}
  .ev{display:flex;gap:10px;align-items:baseline;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:12.5px;color:var(--ink2);}
  .ev .t{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);white-space:nowrap;}
  /* ---------- modal agregar lead ---------- */
  .modal{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:min(420px,92%);background:#0f0f12;border:1px solid rgba(var(--gold-rgb),0.3);border-radius:18px;padding:26px 24px;z-index:45;box-shadow:0 40px 110px -20px rgba(0,0,0,0.9);}
  .modal h3{margin:0 0 4px;font-size:18px;font-weight:800;}
  .modal .mhint{margin:0 0 16px;font-size:12.5px;color:var(--muted);line-height:1.5;}
  .modal input{width:100%;padding:12px 14px;border-radius:11px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);color:var(--ink);font-family:'Archivo',sans-serif;font-size:14px;outline:none;margin-bottom:10px;}
  .modal input:focus{border-color:rgba(var(--gold-rgb),0.65);}
  /* ---------- pie ---------- */
  .foot{margin-top:36px;text-align:center;font-size:11.5px;color:#5c5a55;font-family:'JetBrains Mono',monospace;letter-spacing:0.06em;}
  .foot b{color:var(--gold);font-weight:600;}
  /* ---------- tooltip ---------- */
  #tt{position:fixed;z-index:60;pointer-events:none;background:#1a1a1e;border:1px solid rgba(var(--gold-rgb),0.35);border-radius:9px;padding:7px 11px;font-size:12px;color:var(--ink);box-shadow:0 14px 40px -8px rgba(0,0,0,0.8);white-space:nowrap;}
  #tt .b{font-family:'JetBrains Mono',monospace;font-weight:600;}
  #tt .m{color:var(--muted);}
  .bar-hit:hover .bar{opacity:0.72;}
  @media (max-width:900px){ .tiles{grid-template-columns:repeat(2,1fr);} .grid,.grid2{grid-template-columns:1fr;} }
</style>
</head>
<body>

<!-- PRIMERA VEZ: CREAR CLAVE -->
<div id="setup" class="login" hidden>
  <div class="login-card">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;">
      <div class="login-logo">T</div>
      <div>
        <h1>Bienvenido 👋</h1>
        <div class="mono" style="font-size:10.5px;letter-spacing:0.14em;color:#8f8d88;">${negocio.toUpperCase()} · IMPERIO CRM</div>
      </div>
    </div>
    <p>Este es tu CRM. Antes de empezar, crea tu clave de acceso: es la llave de tu Torre de Control. Guárdala en un lugar seguro.</p>
    <form id="setupForm">
      <input id="setupKey1" type="password" autocomplete="new-password" placeholder="Crea tu clave (mínimo 6 caracteres)">
      <input id="setupKey2" type="password" autocomplete="new-password" placeholder="Repítela">
      <div id="setupErr" class="login-err"></div>
      <button class="btn full" type="submit">Crear mi clave y entrar →</button>
    </form>
  </div>
</div>

<!-- LOGIN -->
<div id="login" class="login" hidden>
  <div class="login-card">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;">
      <div class="login-logo">T</div>
      <div>
        <h1>Torre de Control</h1>
        <div class="mono" style="font-size:10.5px;letter-spacing:0.14em;color:#8f8d88;">${negocio.toUpperCase()} · IMPERIO CRM</div>
      </div>
    </div>
    <p>Escribe tu clave de acceso para entrar al panel.</p>
    <form id="loginForm">
      <input id="keyInput" type="password" autocomplete="current-password" placeholder="Clave de acceso">
      <div id="loginErr" class="login-err"></div>
      <button class="btn full" type="submit">Entrar →</button>
    </form>
  </div>
</div>

<!-- PANEL -->
<div id="app" class="wrap" hidden>
  <div class="top">
    <div class="brand">
      <div class="logo">T</div>
      <div>
        <h1>Torre de Control</h1>
        <div class="sub">${negocio} · CRM en vivo</div>
      </div>
    </div>
    <button id="btnNuevo" class="btn" type="button">＋ Agregar lead</button>
    <button id="btnRefresh" class="btn ghost" type="button">↻ Actualizar</button>
    <button id="btnLogout" class="btn ghost" type="button">Salir</button>
  </div>

  <div class="tiles">
    <div class="tile"><div class="k">Total de leads</div><div class="v" id="tTotal">—</div><div class="s">en toda la base</div></div>
    <div class="tile"><div class="k">Hoy</div><div class="v" id="tHoy">—</div><div class="s">nuevos hoy</div></div>
    <div class="tile"><div class="k">Últimos 7 días</div><div class="v" id="tSemana">—</div><div class="s">nuevos esta semana</div></div>
    <div class="tile"><div class="k">Compradores</div><div class="v" id="tComp">—</div><div class="s">estado «comprador»</div></div>
  </div>

  <div class="grid">
    <div class="card">
      <h2><span class="dot"></span>Leads por día · últimos 30 días</h2>
      <div id="chartDias"></div>
    </div>
    <div class="card">
      <h2><span class="dot"></span>Embudo por temperatura</h2>
      <div id="chartEmbudo"></div>
    </div>
  </div>

  <div class="grid2">
    <div class="card">
      <h2><span class="dot"></span>Leads por canal</h2>
      <div id="chartCanal"></div>
    </div>
    <div class="card">
      <h2><span class="dot"></span>Origen (campañas) · top 8</h2>
      <div id="listaOrigen"></div>
    </div>
  </div>

  <div class="card">
    <h2><span class="dot"></span>Leads</h2>
    <div class="filters">
      <select id="fEstado">
        <option value="">Estado: todos</option>
        <option value="nuevo">Nuevo</option><option value="curioso">Curioso</option>
        <option value="tibio">Tibio</option><option value="caliente">Caliente</option>
        <option value="calificado">Calificado</option><option value="agendo">Agendó</option>
        <option value="comprador">Comprador</option><option value="baja">Baja</option>
      </select>
      <select id="fCanal">
        <option value="">Canal: todos</option>
        <option value="web">Web</option>
        <option value="instagram">Instagram</option>
        <option value="whatsapp">WhatsApp</option>
        <option value="manual">Manual</option>
      </select>
      <input id="fBuscar" type="search" placeholder="Buscar por nombre, correo, teléfono u origen…">
      <button id="fLimpiar" class="btn ghost" type="button">Limpiar</button>
    </div>
    <div style="overflow-x:auto;">
      <table>
        <thead><tr><th>Lead</th><th>Canal</th><th>Estado</th><th>Origen</th><th>Último visto</th></tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
    <div id="emptyMsg" class="empty" hidden>Aún no hay leads con estos filtros.</div>
    <div class="pager">
      <span class="info" id="pagerInfo"></span>
      <button id="pgPrev" class="btn ghost" type="button">← Anterior</button>
      <button id="pgNext" class="btn ghost" type="button">Siguiente →</button>
    </div>
  </div>

  <div class="foot">Hecho con <b>Imperio CRM</b> · tu CRM propio, sin mensualidades · Nómadas Millonarios</div>
</div>

<!-- AGREGAR LEAD A MANO -->
<div id="modalBg" class="drawer-bg" hidden></div>
<div id="modal" class="modal" hidden>
  <h3>Agregar lead</h3>
  <p class="mhint">Para ese cliente que te escribió por fuera: anótalo aquí y no se te pierde. Necesitas al menos su correo o su WhatsApp.</p>
  <input id="nNombre" type="text" placeholder="Nombre">
  <input id="nCorreo" type="email" placeholder="Correo">
  <input id="nTel" type="text" placeholder="WhatsApp (con código de país)">
  <input id="nOrigen" type="text" placeholder="¿De dónde salió? (ej: referido, feria, DM)">
  <div id="nErr" class="login-err"></div>
  <div style="display:flex;gap:10px;">
    <button id="nGuardar" class="btn" type="button" style="flex:1;">Guardar lead</button>
    <button id="nCancelar" class="btn ghost" type="button">Cancelar</button>
  </div>
</div>

<!-- FICHA DE LEAD -->
<div id="drawerBg" class="drawer-bg" hidden></div>
<div id="drawer" class="drawer" hidden></div>
<div id="tt" hidden></div>

<script>
(function(){
  var KEY_LS = 'imperio_crm_key';
  var TZ = '${tz}';
  var BRAND = '${color}';
  var ESTADOS = ['nuevo','curioso','tibio','caliente','calificado','agendo','comprador','baja'];
  var NOMBRES = {nuevo:'Nuevo',curioso:'Curioso',tibio:'Tibio',caliente:'Caliente',calificado:'Calificado',agendo:'Agendó',comprador:'Comprador',baja:'Baja'};
  var CANALES = {instagram:'IG',whatsapp:'WA',web:'WEB',manual:'MANUAL'};
  var page = 1, lastTotal = 0, LIMIT = 50;

  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function getKey(){ try{ return localStorage.getItem(KEY_LS) || ''; }catch(e){ return ''; } }
  function setKey(k){ try{ if(k) localStorage.setItem(KEY_LS,k); else localStorage.removeItem(KEY_LS); }catch(e){} }

  function api(path, opts){
    opts = opts || {};
    var headers = { 'x-torre-key': getKey() };
    if(opts.body) headers['content-type'] = 'application/json';
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function(r){
      if(r.status === 401){ showLogin('Clave incorrecta o vencida.'); throw new Error('401'); }
      return r.json();
    });
  }

  /* ---------- fechas (en TU zona horaria) ---------- */
  function parseUTC(s){ return new Date(String(s).replace(' ','T') + 'Z'); }
  function fmtFecha(s){
    if(!s) return '—';
    try{ return parseUTC(s).toLocaleString('es',{ timeZone:TZ, day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }); }catch(e){ return s; }
  }
  function rel(s){
    if(!s) return '—';
    var ms = Date.now() - parseUTC(s).getTime();
    var m = Math.floor(ms/60000);
    if(m < 1) return 'ahora';
    if(m < 60) return 'hace ' + m + ' min';
    var h = Math.floor(m/60);
    if(h < 24) return 'hace ' + h + ' h';
    var d = Math.floor(h/24);
    if(d === 1) return 'ayer';
    if(d < 30) return 'hace ' + d + ' días';
    try{ return parseUTC(s).toLocaleDateString('es',{ timeZone:TZ, day:'2-digit', month:'short' }); }catch(e){ return s; }
  }
  function diaLocal(offsetDias){
    return new Date(Date.now() - offsetDias*86400000).toLocaleDateString('en-CA',{ timeZone:TZ });
  }
  function etiquetaDia(iso){
    try{ return new Date(iso + 'T12:00:00Z').toLocaleDateString('es',{ timeZone:TZ, day:'2-digit', month:'short' }); }catch(e){ return iso; }
  }

  /* ---------- tooltip ---------- */
  var tt = $('tt');
  function ttShow(html, x, y){
    tt.innerHTML = html; tt.hidden = false;
    var W = tt.offsetWidth, H = tt.offsetHeight;
    var px = Math.min(x + 14, window.innerWidth - W - 10);
    var py = y - H - 12; if(py < 8) py = y + 16;
    tt.style.left = px + 'px'; tt.style.top = py + 'px';
  }
  function ttHide(){ tt.hidden = true; }

  /* ---------- pantallas: setup / login / panel ---------- */
  function showSetup(){
    $('app').hidden = true; $('login').hidden = true; $('setup').hidden = false;
    setTimeout(function(){ $('setupKey1').focus(); }, 60);
  }
  function showLogin(msg){
    $('app').hidden = true; $('setup').hidden = true; $('login').hidden = false;
    $('loginErr').textContent = msg || '';
    setTimeout(function(){ $('keyInput').focus(); }, 60);
  }
  function showApp(){ $('login').hidden = true; $('setup').hidden = true; $('app').hidden = false; }

  $('setupForm').addEventListener('submit', function(ev){
    ev.preventDefault();
    var k1 = $('setupKey1').value.trim(), k2 = $('setupKey2').value.trim();
    if(k1.length < 6){ $('setupErr').textContent = 'La clave debe tener al menos 6 caracteres.'; return; }
    if(k1 !== k2){ $('setupErr').textContent = 'Las claves no coinciden.'; return; }
    fetch('/torre/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: k1 })
    }).then(function(r){ return r.json(); }).then(function(d){
      if(d.ok){ setKey(k1); entrar(); }
      else if(d.error === 'ya_configurada'){ showLogin('Ya había una clave creada. Escríbela para entrar.'); }
      else { $('setupErr').textContent = 'No pude crear la clave. Intenta de nuevo.'; }
    }).catch(function(){ $('setupErr').textContent = 'No pude conectar. Revisa tu internet.'; });
  });

  $('loginForm').addEventListener('submit', function(ev){
    ev.preventDefault();
    var k = $('keyInput').value.trim();
    if(!k){ $('loginErr').textContent = 'Escribe la clave.'; return; }
    setKey(k);
    entrar();
  });
  $('btnLogout').addEventListener('click', function(){ setKey(''); showLogin(''); });
  $('btnRefresh').addEventListener('click', function(){ cargarStats(); cargarLeads(); });

  /* ---------- stats + gráficos ---------- */
  function cargarStats(){
    api('/torre/api/stats').then(function(d){
      if(!d.ok) return;
      $('tTotal').textContent = d.total;
      $('tHoy').textContent = d.hoy;
      $('tSemana').textContent = d.semana;
      $('tComp').textContent = d.compradores;
      pintarDias(d.por_dia || []);
      pintarEmbudo(d.por_estado || []);
      pintarCanal(d.por_canal || []);
      pintarOrigen(d.origenes || []);
    }).catch(function(){});
  }

  function pintarDias(rows){
    var mapa = {}; rows.forEach(function(r){ mapa[r.d] = r.n; });
    var dias = [], max = 0;
    for(var i = 29; i >= 0; i--){
      var iso = diaLocal(i), n = mapa[iso] || 0;
      if(n > max) max = n;
      dias.push({ iso: iso, n: n });
    }
    var W = 640, H = 170, padL = 30, padB = 22, padT = 12;
    var innerW = W - padL - 8, innerH = H - padT - padB;
    var bw = innerW / 30;
    var yMax = Math.max(4, Math.ceil(max * 1.15));
    var svg = [];
    svg.push('<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block;" role="img" aria-label="Leads por día, últimos 30 días">');
    for(var g = 1; g <= 3; g++){
      var gy = padT + innerH - (innerH * g / 3);
      svg.push('<line x1="' + padL + '" y1="' + gy + '" x2="' + (W-8) + '" y2="' + gy + '" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>');
      svg.push('<text x="' + (padL - 6) + '" y="' + (gy + 3.5) + '" text-anchor="end" font-size="9" fill="#8f8d88" font-family="JetBrains Mono,monospace">' + Math.round(yMax * g / 3) + '</text>');
    }
    svg.push('<line x1="' + padL + '" y1="' + (padT + innerH) + '" x2="' + (W-8) + '" y2="' + (padT + innerH) + '" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>');
    dias.forEach(function(dd, idx){
      var x = padL + idx * bw + 1.5;
      var w = Math.max(2, bw - 3);
      var h = dd.n === 0 ? 0 : Math.max(3, innerH * dd.n / yMax);
      var y = padT + innerH - h;
      svg.push('<g class="bar-hit" data-i="' + idx + '">');
      if(dd.n > 0){
        svg.push('<rect class="bar" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="2.5" fill="' + BRAND + '"/>');
        svg.push('<rect x="' + x + '" y="' + (padT + innerH - 1.5) + '" width="' + w + '" height="1.5" fill="' + BRAND + '"/>');
      } else {
        svg.push('<rect x="' + x + '" y="' + (padT + innerH - 2) + '" width="' + w + '" height="2" rx="1" fill="rgba(255,255,255,0.10)"/>');
      }
      svg.push('<rect x="' + (padL + idx * bw) + '" y="' + padT + '" width="' + bw + '" height="' + innerH + '" fill="transparent"/>');
      svg.push('</g>');
      if(idx % 5 === 0){
        svg.push('<text x="' + (x + w/2) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="8.5" fill="#8f8d88" font-family="JetBrains Mono,monospace">' + etiquetaDia(dd.iso) + '</text>');
      }
    });
    svg.push('</svg>');
    var box = $('chartDias');
    box.innerHTML = svg.join('');
    var hits = box.querySelectorAll('.bar-hit');
    for(var j = 0; j < hits.length; j++){
      (function(el){
        el.addEventListener('mousemove', function(ev){
          var dd = dias[Number(el.getAttribute('data-i'))];
          ttShow('<span class="b">' + dd.n + '</span> lead' + (dd.n === 1 ? '' : 's') + ' <span class="m">· ' + etiquetaDia(dd.iso) + '</span>', ev.clientX, ev.clientY);
        });
        el.addEventListener('mouseleave', ttHide);
      })(hits[j]);
    }
  }

  function filasBarras(items, contenedor, tooltipUnidad){
    var max = 0;
    items.forEach(function(it){ if(it.n > max) max = it.n; });
    var html = items.map(function(it){
      var pct = max ? Math.round(it.n * 100 / max) : 0;
      return '<div class="hbar-row" data-tt="' + esc(it.label) + ': ' + it.n + '">' +
        '<div class="lbl">' + esc(it.label) + '</div>' +
        '<div class="track"><div class="fill' + (it.n === 0 ? ' zero' : '') + '" style="width:' + (it.n === 0 ? 2 : Math.max(2, pct)) + '%"></div></div>' +
        '<div class="num">' + it.n + '</div></div>';
    }).join('');
    contenedor.innerHTML = html || '<div class="empty">Sin datos todavía.</div>';
    var rows = contenedor.querySelectorAll('.hbar-row');
    for(var i = 0; i < rows.length; i++){
      (function(el){
        el.addEventListener('mousemove', function(ev){ ttShow('<span class="b">' + esc(el.getAttribute('data-tt')) + '</span> <span class="m">' + tooltipUnidad + '</span>', ev.clientX, ev.clientY); });
        el.addEventListener('mouseleave', ttHide);
      })(rows[i]);
    }
  }

  function pintarEmbudo(rows){
    var mapa = {}; rows.forEach(function(r){ mapa[r.status] = r.n; });
    var items = ESTADOS.map(function(st){ return { label: NOMBRES[st], n: mapa[st] || 0 }; });
    filasBarras(items, $('chartEmbudo'), 'leads');
  }
  function pintarCanal(rows){
    var items = rows.map(function(r){
      var lbl = r.channel === 'web' ? 'Web' : r.channel === 'manual' ? 'Manual' : (r.channel.charAt(0).toUpperCase() + r.channel.slice(1));
      return { label: lbl, n: r.n };
    });
    filasBarras(items, $('chartCanal'), 'leads');
  }
  function pintarOrigen(rows){
    $('listaOrigen').innerHTML = rows.length
      ? rows.map(function(r){ return '<div class="src-row"><span class="s" title="' + esc(r.s) + '">' + esc(r.s) + '</span><span class="n">' + r.n + '</span></div>'; }).join('')
      : '<div class="empty">Cuando enciendas la pauta, aquí verás qué campaña trae cada lead.</div>';
  }

  /* ---------- tabla ---------- */
  function cargarLeads(){
    var ps = new URLSearchParams();
    if($('fEstado').value) ps.set('status', $('fEstado').value);
    if($('fCanal').value) ps.set('channel', $('fCanal').value);
    if($('fBuscar').value.trim()) ps.set('q', $('fBuscar').value.trim());
    ps.set('page', String(page));
    api('/torre/api/leads?' + ps.toString()).then(function(d){
      if(!d.ok) return;
      lastTotal = d.total;
      var tb = $('tbody');
      tb.innerHTML = (d.leads || []).map(function(L){
        var quien = esc(L.name || '(sin nombre)');
        var contacto = esc(L.email || L.phone || L.external_id || '');
        return '<tr data-id="' + L.id + '">' +
          '<td><span class="nm">' + quien + '</span><br><span class="em">' + contacto + '</span></td>' +
          '<td><span class="ch">' + esc(CANALES[L.channel] || L.channel) + '</span></td>' +
          '<td><span class="chip st-' + esc(L.status) + '">' + esc(NOMBRES[L.status] || L.status) + '</span></td>' +
          '<td><span class="src" title="' + esc(L.source || '') + '">' + esc(L.source || '—') + '</span></td>' +
          '<td><span class="tm" title="' + esc(fmtFecha(L.last_seen)) + '">' + rel(L.last_seen) + '</span></td>' +
        '</tr>';
      }).join('');
      $('emptyMsg').hidden = (d.leads || []).length > 0;
      var desde = lastTotal === 0 ? 0 : (page - 1) * LIMIT + 1;
      var hasta = Math.min(page * LIMIT, lastTotal);
      $('pagerInfo').textContent = desde + '–' + hasta + ' de ' + lastTotal;
      $('pgPrev').disabled = page <= 1;
      $('pgNext').disabled = hasta >= lastTotal;
      var trs = tb.querySelectorAll('tr');
      for(var i = 0; i < trs.length; i++){
        (function(tr){ tr.addEventListener('click', function(){ abrirFicha(Number(tr.getAttribute('data-id'))); }); })(trs[i]);
      }
    }).catch(function(){});
  }

  var buscarTimer = null;
  $('fEstado').addEventListener('change', function(){ page = 1; cargarLeads(); });
  $('fCanal').addEventListener('change', function(){ page = 1; cargarLeads(); });
  $('fBuscar').addEventListener('input', function(){ clearTimeout(buscarTimer); buscarTimer = setTimeout(function(){ page = 1; cargarLeads(); }, 350); });
  $('fLimpiar').addEventListener('click', function(){ $('fEstado').value = ''; $('fCanal').value = ''; $('fBuscar').value = ''; page = 1; cargarLeads(); });
  $('pgPrev').addEventListener('click', function(){ if(page > 1){ page--; cargarLeads(); } });
  $('pgNext').addEventListener('click', function(){ if(page * LIMIT < lastTotal){ page++; cargarLeads(); } });

  /* ---------- agregar lead a mano ---------- */
  function abrirModal(){
    $('nErr').textContent = '';
    $('modal').hidden = false; $('modalBg').hidden = false;
    setTimeout(function(){ $('nNombre').focus(); }, 60);
  }
  function cerrarModal(){
    $('modal').hidden = true; $('modalBg').hidden = true;
    $('nNombre').value = ''; $('nCorreo').value = ''; $('nTel').value = ''; $('nOrigen').value = '';
  }
  $('btnNuevo').addEventListener('click', abrirModal);
  $('nCancelar').addEventListener('click', cerrarModal);
  $('modalBg').addEventListener('click', cerrarModal);
  $('nGuardar').addEventListener('click', function(){
    var correo = $('nCorreo').value.trim(), tel = $('nTel').value.trim();
    if(!correo && !tel){ $('nErr').textContent = 'Pon al menos el correo o el WhatsApp.'; return; }
    api('/torre/api/lead/nuevo', { method: 'POST', body: {
      name: $('nNombre').value.trim() || null,
      email: correo || null,
      phone: tel || null,
      source: $('nOrigen').value.trim() || null
    }}).then(function(d){
      if(d.ok){ cerrarModal(); cargarStats(); page = 1; cargarLeads(); }
      else { $('nErr').textContent = 'No pude guardarlo. Revisa los datos.'; }
    }).catch(function(){});
  });

  /* ---------- ficha ---------- */
  function cerrarFicha(){ $('drawer').hidden = true; $('drawerBg').hidden = true; }
  $('drawerBg').addEventListener('click', cerrarFicha);
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape'){ cerrarFicha(); cerrarModal(); } });

  function botonListo(btn){
    var antes = btn.textContent;
    btn.textContent = '✓ Listo';
    setTimeout(function(){ btn.textContent = antes; }, 1300);
  }

  function abrirFicha(id){
    api('/torre/api/lead/' + id).then(function(d){
      if(!d.ok) return;
      var L = d.lead || {};
      var html = [];
      html.push('<button class="close" type="button" aria-label="Cerrar">×</button>');
      html.push('<h3>' + esc(L.name || '(sin nombre)') + '</h3>');
      html.push('<div style="margin:6px 0 2px;"><span class="chip st-' + esc(L.status) + '">' + esc(NOMBRES[L.status] || L.status) + '</span> <span class="ch" style="margin-left:6px;">' + esc(CANALES[L.channel] || L.channel) + '</span></div>');
      html.push('<div class="fgrid">');
      html.push('<div class="fitem"><div class="k">Correo</div><div class="v">' + esc(L.email || '—') + '</div></div>');
      html.push('<div class="fitem"><div class="k">WhatsApp</div><div class="v">' + esc(L.phone || '—') + '</div></div>');
      html.push('<div class="fitem"><div class="k">Origen</div><div class="v">' + esc(L.source || '—') + '</div></div>');
      html.push('<div class="fitem"><div class="k">Lead #</div><div class="v">' + L.id + '</div></div>');
      html.push('<div class="fitem"><div class="k">Llegó</div><div class="v">' + esc(fmtFecha(L.created_at)) + '</div></div>');
      html.push('<div class="fitem"><div class="k">Último visto</div><div class="v">' + esc(fmtFecha(L.last_seen)) + '</div></div>');
      html.push('</div>');

      html.push('<div class="sec">Cambiar estado</div>');
      html.push('<div style="display:flex;gap:8px;align-items:center;">');
      html.push('<select id="dEstado" class="dsel">');
      ESTADOS.forEach(function(st){
        html.push('<option value="' + st + '"' + (st === L.status ? ' selected' : '') + '>' + NOMBRES[st] + '</option>');
      });
      html.push('</select>');
      html.push('<button id="dGuardaEstado" class="btn ghost" type="button">Guardar</button>');
      html.push('</div>');

      html.push('<div class="sec">Notas</div>');
      html.push('<textarea id="dNotas" class="dnotas" placeholder="Apunta aquí lo importante de este lead…">' + esc(L.notes || '') + '</textarea>');
      html.push('<button id="dGuardaNotas" class="btn ghost" type="button" style="margin-top:8px;">Guardar notas</button>');

      var evs = d.events || [];
      if(evs.length){
        html.push('<div class="sec">Historia</div>');
        evs.forEach(function(ev){ html.push('<div class="ev"><span class="t">' + esc(fmtFecha(ev.created_at)) + '</span><span>' + esc(ev.type) + '</span></div>'); });
      }
      var msgs = d.messages || [];
      html.push('<div class="sec">Conversación (' + msgs.length + ')</div>');
      if(msgs.length){
        msgs.forEach(function(m){
          html.push('<div class="msg ' + (m.role === 'user' ? 'user' : 'assistant') + '">' + esc(m.content) + '<span class="t">' + esc(fmtFecha(m.created_at)) + '</span></div>');
        });
      } else {
        html.push('<div class="empty" style="padding:16px 0;">Sin mensajes — llegó por formulario o lo agregaste tú.</div>');
      }
      var dr = $('drawer');
      dr.innerHTML = html.join('');
      dr.querySelector('.close').addEventListener('click', cerrarFicha);
      dr.querySelector('#dGuardaEstado').addEventListener('click', function(){
        var nuevo = dr.querySelector('#dEstado').value;
        api('/torre/api/lead/' + id + '/estado', { method: 'POST', body: { status: nuevo } }).then(function(r){
          if(r.ok){ botonListo(dr.querySelector('#dGuardaEstado')); cargarStats(); cargarLeads(); }
        }).catch(function(){});
      });
      dr.querySelector('#dGuardaNotas').addEventListener('click', function(){
        var notas = dr.querySelector('#dNotas').value;
        api('/torre/api/lead/' + id + '/notas', { method: 'POST', body: { notes: notas } }).then(function(r){
          if(r.ok){ botonListo(dr.querySelector('#dGuardaNotas')); }
        }).catch(function(){});
      });
      dr.hidden = false; $('drawerBg').hidden = false;
      dr.scrollTop = 0;
    }).catch(function(){});
  }

  /* ---------- arranque ---------- */
  function entrar(){
    api('/torre/api/stats').then(function(d){
      if(d && d.ok){
        showApp();
        $('tTotal').textContent = d.total; $('tHoy').textContent = d.hoy;
        $('tSemana').textContent = d.semana; $('tComp').textContent = d.compradores;
        pintarDias(d.por_dia || []); pintarEmbudo(d.por_estado || []);
        pintarCanal(d.por_canal || []); pintarOrigen(d.origenes || []);
        page = 1; cargarLeads();
      }
    }).catch(function(){});
  }

  function boot(){
    fetch('/torre/api/estado').then(function(r){ return r.json(); }).then(function(d){
      if(!d || !d.ok){ showLogin('No pude conectar. Recarga la página.'); return; }
      if(!d.configurada){ showSetup(); return; }
      if(!getKey()){ showLogin(''); return; }
      entrar();
    }).catch(function(){ showLogin('No pude conectar. Recarga la página.'); });
  }
  boot();
})();
</script>
</body>
</html>`;
}
