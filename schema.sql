-- ============================================================
--  IMPERIO CRM · Esquema de la base de datos (Cloudflare D1)
--
--  ⚠️ NO NECESITAS CORRER ESTE ARCHIVO.
--  El Worker crea estas tablas SOLO, la primera vez que arranca.
--  Este archivo es solo referencia, para que veas (tú o tu Claude)
--  cómo está organizada la información.
--
--  La idea: una fila en `leads` por persona = está en tu CRM.
-- ============================================================

CREATE TABLE IF NOT EXISTS leads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel     TEXT NOT NULL,                 -- 'web' | 'instagram' | 'whatsapp' | 'manual'
  external_id TEXT,                           -- correo / teléfono / id externo: lo que identifica a la persona
  name        TEXT,
  phone       TEXT,
  email       TEXT,
  status      TEXT NOT NULL DEFAULT 'nuevo',  -- nuevo | curioso | tibio | caliente | calificado | agendo | comprador | baja
  source      TEXT,                           -- de qué anuncio/campaña/página vino
  notes       TEXT,                           -- tus notas sobre este lead
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel, external_id)
);

-- Conversaciones (por si luego conectas WhatsApp/Instagram, o para notas con historia)
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id    INTEGER NOT NULL,
  role       TEXT NOT NULL,                   -- 'user' | 'assistant'
  content    TEXT NOT NULL,
  channel    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);

-- Eventos para seguimiento (pidió precio, asistió a clase, compró, ...)
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id    INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT,                            -- JSON opcional
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);

-- Configuración interna del CRM (aquí vive tu clave de la Torre, cifrada con hash)
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_events_lead   ON events(lead_id);
CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_channel ON leads(channel, external_id);
