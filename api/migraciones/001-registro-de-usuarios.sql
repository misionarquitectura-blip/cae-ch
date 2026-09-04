-- ════════════════════════════════════════════════════════════════════
--  001 · Registro publico de usuarios
--
--  Solo hace falta si YA se aplico `schema.sql` en una base existente.
--  Si la base todavia no esta creada, `schema.sql` ya trae todo esto y
--  esta migracion sobra.
--
--  SQLite no permite alterar una restriccion CHECK, y `rol` la tenia
--  limitada a ('afiliado','admin'), asi que hay que reconstruir la tabla.
--
--    npx wrangler d1 execute caech-afiliados --remote \
--        --file=migraciones/001-registro-de-usuarios.sql
-- ════════════════════════════════════════════════════════════════════

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE afiliados_nueva (
    id                    TEXT    PRIMARY KEY,
    usuario               TEXT    NOT NULL UNIQUE,
    correo                TEXT    NOT NULL UNIQUE,
    nombre                TEXT    NOT NULL,
    registro_profesional  TEXT,
    nucleo                TEXT    NOT NULL DEFAULT 'Chimborazo',
    rol                   TEXT    NOT NULL DEFAULT 'usuario'
                                  CHECK (rol IN ('usuario', 'afiliado', 'admin')),
    origen                TEXT    NOT NULL DEFAULT 'admin'
                                  CHECK (origen IN ('registro', 'admin')),
    estado                TEXT    NOT NULL DEFAULT 'activo'
                                  CHECK (estado IN ('activo', 'suspendido', 'baja')),
    hash_clave            TEXT    NOT NULL,
    requiere_cambio_clave INTEGER NOT NULL DEFAULT 1,
    clave_cambiada_en     TEXT,
    correo_verificado     INTEGER NOT NULL DEFAULT 0,
    verificado_en         TEXT,
    token_verificacion    TEXT,
    token_expira          TEXT,
    reenvios_verificacion INTEGER NOT NULL DEFAULT 0,
    pdf_cortesia_en       TEXT,
    vigencia_hasta        TEXT,
    creado_en             TEXT    NOT NULL,
    actualizado_en        TEXT    NOT NULL,
    ultimo_acceso         TEXT,
    intentos_fallidos     INTEGER NOT NULL DEFAULT 0,
    bloqueado_hasta       TEXT
);

-- Las cuentas que ya existian las creo la administracion y entrego las
-- credenciales en mano: nacen como 'admin' de origen y ya verificadas,
-- para no dejar fuera a nadie que hoy pueda entrar.
INSERT INTO afiliados_nueva (
    id, usuario, correo, nombre, registro_profesional, nucleo, rol, origen,
    estado, hash_clave, requiere_cambio_clave, clave_cambiada_en,
    correo_verificado, verificado_en, vigencia_hasta,
    creado_en, actualizado_en, ultimo_acceso, intentos_fallidos, bloqueado_hasta
)
SELECT
    id, usuario, correo, nombre, registro_profesional, nucleo, rol, 'admin',
    estado, hash_clave, requiere_cambio_clave, clave_cambiada_en,
    1, creado_en, vigencia_hasta,
    creado_en, actualizado_en, ultimo_acceso, intentos_fallidos, bloqueado_hasta
FROM afiliados;

DROP TABLE afiliados;
ALTER TABLE afiliados_nueva RENAME TO afiliados;

CREATE INDEX IF NOT EXISTS idx_afiliados_estado ON afiliados (estado);
CREATE INDEX IF NOT EXISTS idx_afiliados_rol    ON afiliados (rol);
CREATE INDEX IF NOT EXISTS idx_afiliados_token  ON afiliados (token_verificacion);

COMMIT;

PRAGMA foreign_keys = ON;
