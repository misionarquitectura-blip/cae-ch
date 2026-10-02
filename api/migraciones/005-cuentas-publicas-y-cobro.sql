-- ════════════════════════════════════════════════════════════════════
--  005 · Cuentas publicas, cobro por predio y declaracion de equipo
--
--  Hasta ahora las cuentas eran solo para colegiados. Desde el
--  2026-10-02, conforme al convenio entre el CAE-CH y el desarrollador:
--
--    · Cualquiera puede crear cuenta. El numero de registro del CAE pasa a
--      ser opcional: quien lo da entra como colegiado por cotejar; quien
--      no, como cuenta publica.
--    · Los productos de un predio -DICAT en PDF, CSV y DXF- se habilitan
--      por predio: el administrador, libre; el colegiado, con un cupo de
--      predios al mes; el resto, pagando. Un pago habilita los tres
--      formatos de ese predio durante un plazo.
--    · La planimetria es gratis para toda cuenta, previa declaracion del
--      equipo de alta precision con que se tomo el levantamiento.
--
--  No se guardan datos de tarjeta: los maneja PayPhone. De cada pago
--  queda el identificador de la transaccion, el codigo de autorizacion y
--  el monto, que es lo que hace falta para conciliar y facturar.
--
--    npx wrangler d1 execute caech-afiliados --remote \
--        --file=migraciones/005-cuentas-publicas-y-cobro.sql
--
--  APLICAR ANTES DE DESPLEGAR EL WORKER: la puerta de descargas lee
--  `predios_habilitados` en cada peticion. `schema.sql` ya trae las tablas;
--  esto es solo para bases que existian antes del 2026-10-02. Son CREATE
--  ... IF NOT EXISTS: repetirla no rompe nada.
-- ════════════════════════════════════════════════════════════════════

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
