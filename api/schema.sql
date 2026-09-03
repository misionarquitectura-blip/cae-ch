-- ════════════════════════════════════════════════════════════════════
--  CAE-CH · Base de datos de afiliados con acceso a reportes
--  Cloudflare D1 (SQLite).  Aplicar con:
--    npx wrangler d1 execute caech-afiliados --remote --file=schema.sql
--
--  Principio de minimizacion: aqui NO se guardan cedulas ni RUC, en
--  coherencia con el saneo del catastro y con la politica de privacidad
--  publicada en legal.html#privacidad.
-- ════════════════════════════════════════════════════════════════════

PRAGMA foreign_keys = ON;

-- ── Afiliados ───────────────────────────────────────────────────────
-- Las credenciales se entregan en mano: el admin crea la cuenta con una
-- clave temporal de alta entropia y `requiere_cambio_clave = 1` obliga a
-- cambiarla en el primer ingreso.
CREATE TABLE IF NOT EXISTS afiliados (
    id                    TEXT    PRIMARY KEY,
    usuario               TEXT    NOT NULL UNIQUE,          -- minusculas, sin espacios
    correo                TEXT    NOT NULL UNIQUE,          -- minusculas
    nombre                TEXT    NOT NULL,
    registro_profesional  TEXT,                             -- SENESCYT / CAE, opcional
    nucleo                TEXT    NOT NULL DEFAULT 'Chimborazo',
    rol                   TEXT    NOT NULL DEFAULT 'afiliado'
                                  CHECK (rol IN ('afiliado', 'admin')),
    estado                TEXT    NOT NULL DEFAULT 'activo'
                                  CHECK (estado IN ('activo', 'suspendido', 'baja')),

    -- pbkdf2-sha256$<iteraciones>$<salt_b64>$<hash_b64>
    hash_clave            TEXT    NOT NULL,
    requiere_cambio_clave INTEGER NOT NULL DEFAULT 1,
    clave_cambiada_en     TEXT,

    vigencia_hasta        TEXT,                             -- ISO-8601; NULL = sin caducidad
    creado_en             TEXT    NOT NULL,
    actualizado_en        TEXT    NOT NULL,
    ultimo_acceso         TEXT,

    -- Freno de fuerza bruta
    intentos_fallidos     INTEGER NOT NULL DEFAULT 0,
    bloqueado_hasta       TEXT
);

CREATE INDEX IF NOT EXISTS idx_afiliados_estado ON afiliados (estado);

-- ── Sesiones ────────────────────────────────────────────────────────
-- Se guarda el SHA-256 del token, nunca el token. Una filtracion de la
-- base no entrega sesiones utilizables.
CREATE TABLE IF NOT EXISTS sesiones (
    token_hash   TEXT    PRIMARY KEY,
    afiliado_id  TEXT    NOT NULL REFERENCES afiliados(id) ON DELETE CASCADE,
    creada_en    TEXT    NOT NULL,
    expira_en    TEXT    NOT NULL,
    ultimo_uso   TEXT,
    ip_hash      TEXT,                                      -- SHA-256(ip + PEPPER), no la IP
    agente       TEXT,
    revocada     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sesiones_afiliado ON sesiones (afiliado_id);
CREATE INDEX IF NOT EXISTS idx_sesiones_expira   ON sesiones (expira_en);

-- ── Pases freemium ──────────────────────────────────────────────────
-- Lanzamiento: un unico DICAT en PDF por correo verificado, para siempre.
-- El UNIQUE sobre correo es lo que hace cumplir "una unica vez".
CREATE TABLE IF NOT EXISTS pases_freemium (
    id              TEXT    PRIMARY KEY,
    correo          TEXT    NOT NULL UNIQUE,                -- normalizado a minusculas
    token_hash      TEXT    NOT NULL,                       -- SHA-256 del enlace de verificacion
    creado_en       TEXT    NOT NULL,
    expira_en       TEXT    NOT NULL,                       -- caducidad del enlace
    verificado_en   TEXT,
    consumido_en    TEXT,
    clave_catastral TEXT,                                   -- predio del reporte gastado
    ip_hash         TEXT,
    reenvios        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pases_token ON pases_freemium (token_hash);

-- ── Auditoria de descargas ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS descargas (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    creado_en       TEXT    NOT NULL,
    formato         TEXT    NOT NULL CHECK (formato IN ('pdf', 'dxf', 'csv')),
    origen          TEXT    NOT NULL CHECK (origen IN ('afiliado', 'freemium')),
    afiliado_id     TEXT    REFERENCES afiliados(id) ON DELETE SET NULL,
    pase_id         TEXT    REFERENCES pases_freemium(id) ON DELETE SET NULL,
    clave_catastral TEXT,
    ip_hash         TEXT
);

CREATE INDEX IF NOT EXISTS idx_descargas_fecha    ON descargas (creado_en);
CREATE INDEX IF NOT EXISTS idx_descargas_afiliado ON descargas (afiliado_id);

-- ── Bitacora de seguridad ───────────────────────────────────────────
-- Ingresos, fallos, altas, bajas y cambios de clave. Sin datos personales
-- mas alla del usuario afectado.
CREATE TABLE IF NOT EXISTS eventos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    creado_en   TEXT    NOT NULL,
    tipo        TEXT    NOT NULL,
    afiliado_id TEXT,
    usuario     TEXT,
    detalle     TEXT,
    ip_hash     TEXT
);

CREATE INDEX IF NOT EXISTS idx_eventos_fecha ON eventos (creado_en);
CREATE INDEX IF NOT EXISTS idx_eventos_tipo  ON eventos (tipo);
