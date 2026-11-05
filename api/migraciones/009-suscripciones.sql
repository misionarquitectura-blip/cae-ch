-- ════════════════════════════════════════════════════════════════════
--  009 · Suscripcion mensual, concepto del pago y predio de cortesia
--
--  Desde el 2026-11-05 una cuenta general puede suscribirse: USD 9,90 por
--  ciclo mensual, con tres predios gratuitos por ciclo y los demas a USD 2,50.
--  Y toda cuenta tiene, una sola vez, un predio de cortesia para probar el
--  DICAT, el CSV y el DXF.
--  Cada fila es un ciclo pagado. La renovacion no debita sola: PayPhone
--  cobra por la Cajita, con el titular presente, y aqui no se guarda
--  ninguna tarjeta. Los predios gratuitos no se acumulan porque se cuentan
--  dentro del ciclo vigente (ver src/cobros.js).
--
--    npx wrangler d1 execute caech-afiliados --remote \
--        --file=migraciones/009-suscripciones.sql
--
--  APLICAR ANTES DE DESPLEGAR EL WORKER: el calculo de la tarifa lee
--  `suscripciones` en cada descarga. Los ALTER no son idempotentes: antes de
--  repetirla, comprobar con SELECT name FROM pragma_table_info('pagos').
--  `schema.sql` ya trae todo; esto es para bases anteriores al 2026-11-05.
-- ════════════════════════════════════════════════════════════════════

-- Que se esta pagando. En una suscripcion, `clave_catastral` guarda el predio
-- desde el que se contrato, para volver a el, o 'SUSCRIPCION' si no hubo.
ALTER TABLE pagos ADD COLUMN concepto TEXT NOT NULL DEFAULT 'predio'
    CHECK (concepto IN ('predio', 'suscripcion'));

CREATE TABLE IF NOT EXISTS suscripciones (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    afiliado_id     TEXT    NOT NULL REFERENCES afiliados(id) ON DELETE CASCADE,
    pago_id         TEXT    REFERENCES pagos(id) ON DELETE SET NULL,
    inicio          TEXT    NOT NULL,
    vence_en        TEXT    NOT NULL,
    creado_en       TEXT    NOT NULL,
    concedido_por   TEXT                                    -- usuario del admin, si se pago en la sede
);

CREATE INDEX IF NOT EXISTS idx_suscripciones_cuenta ON suscripciones (afiliado_id, vence_en);

-- ── Predio de cortesia ──────────────────────────────────────────────
-- Cuando la cuenta uso el suyo. Nula: aun lo tiene, tambien las anteriores.
ALTER TABLE afiliados ADD COLUMN cortesia_usada_en TEXT;

-- SQLite no modifica un CHECK: para admitir via = 'cortesia' se rehace la
-- tabla conservando cada fila. Ninguna otra tabla apunta a esta.
CREATE TABLE predios_habilitados_nueva (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    afiliado_id     TEXT    NOT NULL REFERENCES afiliados(id) ON DELETE CASCADE,
    clave_catastral TEXT    NOT NULL,
    via             TEXT    NOT NULL CHECK (via IN ('cupo', 'pago', 'admin', 'cortesia')),
    pago_id         TEXT    REFERENCES pagos(id) ON DELETE SET NULL,
    creado_en       TEXT    NOT NULL,
    vence_en        TEXT    NOT NULL,
    concedido_por   TEXT
);

INSERT INTO predios_habilitados_nueva
    (id, afiliado_id, clave_catastral, via, pago_id, creado_en, vence_en, concedido_por)
    SELECT id, afiliado_id, clave_catastral, via, pago_id, creado_en, vence_en, concedido_por
    FROM predios_habilitados;

DROP TABLE predios_habilitados;
ALTER TABLE predios_habilitados_nueva RENAME TO predios_habilitados;

CREATE INDEX IF NOT EXISTS idx_predios_cuenta ON predios_habilitados (afiliado_id, clave_catastral);
CREATE INDEX IF NOT EXISTS idx_predios_cupo   ON predios_habilitados (afiliado_id, via, creado_en);
