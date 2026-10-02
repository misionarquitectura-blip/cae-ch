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

    -- Numero de registro del colegiado en el CAE. Opcional desde el
    -- 2026-10-02: quien lo da se registra como colegiado y el numero se
    -- guarda tal como lo escribe; `registro_validado` dice si la
    -- administracion ya lo coteja contra el padron. Sin numero, o mientras
    -- no se valide, la cuenta es publica: paga cada predio que descarga.
    registro_profesional  TEXT,
    registro_validado     INTEGER NOT NULL DEFAULT 0,
    registro_validado_en  TEXT,
    registro_validado_por TEXT,                             -- usuario del admin que valido

    -- Herramientas concedidas a esta cuenta, separadas por comas. Las
    -- descargas NO estan aqui: van con el registro cotejado. Aqui van las
    -- herramientas que se abren una cuenta a la vez -"planimetria"-. El
    -- administrador las tiene todas por su rol, sin figurar en la columna.
    herramientas          TEXT,

    nucleo                TEXT    NOT NULL DEFAULT 'Chimborazo',
    -- usuario  : se registro por su cuenta. Paga cada predio; si dio su
    --            numero de registro y se valida, tiene el cupo del colegiado.
    -- afiliado : colegiado del CAE-CH, alta por la administracion.
    -- admin    : ademas gestiona el padron.
    rol                   TEXT    NOT NULL DEFAULT 'usuario'
                                  CHECK (rol IN ('usuario', 'afiliado', 'admin')),
    origen                TEXT    NOT NULL DEFAULT 'admin'
                                  CHECK (origen IN ('registro', 'admin')),
    estado                TEXT    NOT NULL DEFAULT 'activo'
                                  CHECK (estado IN ('activo', 'suspendido', 'baja')),

    -- pbkdf2-sha256$<iteraciones>$<salt_b64>$<hash_b64>
    hash_clave            TEXT    NOT NULL,
    requiere_cambio_clave INTEGER NOT NULL DEFAULT 1,
    clave_cambiada_en     TEXT,

    -- Aceptacion de los Terminos y la Politica de Privacidad (LOPDP: el
    -- responsable debe poder DEMOSTRAR el consentimiento). Se guarda la
    -- version aceptada -la fecha de vigencia de legal.html- y cuando.
    -- NULL o una version distinta de VERSION_TERMINOS = aceptacion pendiente.
    terminos_version      TEXT,
    terminos_aceptados_en TEXT,

    -- Verificacion del correo. Las cuentas que crea la administracion nacen
    -- verificadas: el CAE-CH responde por ellas y la clave se entrega en mano.
    -- Las del registro publico no pueden ingresar hasta confirmar el correo.
    correo_verificado     INTEGER NOT NULL DEFAULT 0,
    verificado_en         TEXT,
    token_verificacion    TEXT,                             -- SHA-256 del token, nunca el token
    token_expira          TEXT,
    reenvios_verificacion INTEGER NOT NULL DEFAULT 0,

    -- Reporte de cortesia del esquema anterior. Se conserva por historia:
    -- desde 2026-09-04 no hay pases de cortesia, toda descarga exige cuenta.
    pdf_cortesia_en       TEXT,

    vigencia_hasta        TEXT,                             -- ISO-8601; NULL = sin caducidad
    creado_en             TEXT    NOT NULL,
    actualizado_en        TEXT    NOT NULL,
    ultimo_acceso         TEXT,

    -- Freno de fuerza bruta
    intentos_fallidos     INTEGER NOT NULL DEFAULT 0,
    bloqueado_hasta       TEXT
);

CREATE INDEX IF NOT EXISTS idx_afiliados_estado ON afiliados (estado);
CREATE INDEX IF NOT EXISTS idx_afiliados_rol    ON afiliados (rol);
CREATE INDEX IF NOT EXISTS idx_afiliados_token  ON afiliados (token_verificacion);

-- Un numero de registro identifica a un colegiado y solo a uno.
CREATE UNIQUE INDEX IF NOT EXISTS idx_afiliados_registro
    ON afiliados (registro_profesional)
    WHERE registro_profesional IS NOT NULL;

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

-- ── Predios habilitados ─────────────────────────────────────────────
-- Una fila por predio que una cuenta puede descargar. `via` dice por que:
--   cupo  : uno de los predios gratuitos del mes del colegiado
--   pago  : pagado en linea (pago_id apunta a la transaccion)
--   admin : concedido a mano por la administracion (pago en sede, cortesia)
CREATE TABLE IF NOT EXISTS predios_habilitados (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    afiliado_id     TEXT    NOT NULL REFERENCES afiliados(id) ON DELETE CASCADE,
    clave_catastral TEXT    NOT NULL,
    via             TEXT    NOT NULL CHECK (via IN ('cupo', 'pago', 'admin')),
    pago_id         TEXT    REFERENCES pagos(id) ON DELETE SET NULL,
    creado_en       TEXT    NOT NULL,
    vence_en        TEXT    NOT NULL,
    concedido_por   TEXT                                    -- usuario del admin, si via = 'admin'
);

CREATE INDEX IF NOT EXISTS idx_predios_cuenta ON predios_habilitados (afiliado_id, clave_catastral);
CREATE INDEX IF NOT EXISTS idx_predios_cupo   ON predios_habilitados (afiliado_id, via, creado_en);

-- ── Pagos ───────────────────────────────────────────────────────────
-- `id` es el clientTransactionId que se entrega a PayPhone. El Confirm se
-- coteja contra esta fila -monto, cuenta y predio-, nunca contra lo que
-- diga la URL de regreso.
CREATE TABLE IF NOT EXISTS pagos (
    id                   TEXT    PRIMARY KEY,
    afiliado_id          TEXT    NOT NULL REFERENCES afiliados(id) ON DELETE CASCADE,
    clave_catastral      TEXT    NOT NULL,
    monto                INTEGER NOT NULL,                  -- centavos, IVA incluido
    base                 INTEGER NOT NULL,                  -- centavos
    iva                  INTEGER NOT NULL,                  -- centavos
    estado               TEXT    NOT NULL DEFAULT 'preparado'
                                 CHECK (estado IN ('preparado', 'aprobado', 'cancelado', 'rechazado')),
    pasarela             TEXT    NOT NULL DEFAULT 'payphone',
    transaccion          TEXT,                              -- transactionId de PayPhone
    autorizacion         TEXT,                              -- authorizationCode
    detalle              TEXT,                              -- motivo de rechazo, si lo hubo
    creado_en            TEXT    NOT NULL,
    confirmado_en        TEXT
);

CREATE INDEX IF NOT EXISTS idx_pagos_cuenta ON pagos (afiliado_id, creado_en);
CREATE INDEX IF NOT EXISTS idx_pagos_estado ON pagos (estado, creado_en);

-- ── Declaracion de equipo (planimetria) ─────────────────────────────
-- La vigente es la ultima de cada cuenta. Se conservan las anteriores:
-- son la constancia de con que equipo declaro trabajar en cada momento.
CREATE TABLE IF NOT EXISTS declaraciones_equipo (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    afiliado_id     TEXT    NOT NULL REFERENCES afiliados(id) ON DELETE CASCADE,
    tipo            TEXT    NOT NULL
                            CHECK (tipo IN ('gnss_rtk', 'estacion_total', 'lidar', 'ortofoto')),
    marca           TEXT    NOT NULL,
    modelo          TEXT    NOT NULL,
    serie           TEXT    NOT NULL,
    gsd_cm          REAL,                                   -- solo ortofoto: resolucion verificada
    texto_version   TEXT    NOT NULL,                       -- version del texto de responsabilidad aceptado
    creado_en       TEXT    NOT NULL,
    ip_hash         TEXT
);

CREATE INDEX IF NOT EXISTS idx_equipo_cuenta ON declaraciones_equipo (afiliado_id, creado_en);

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
