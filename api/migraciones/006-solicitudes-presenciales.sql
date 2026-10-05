-- ════════════════════════════════════════════════════════════════════
--  006 · Solicitudes presenciales del DICAT
--
--  La via principal del DICAT es la persona que se acerca a la sede.
--  Hasta ahora esa solicitud se tomaba de palabra, o en una hoja que
--  vivia en el navegador de una sola computadora: dos equipos del
--  mostrador daban numeros repetidos y no se veian entre si.
--
--  Esta tabla la lleva al panel: un correlativo institucional por ano,
--  la misma lista desde cualquier equipo y constancia de que el
--  solicitante acepto las dos clausulas que firma en papel.
--
--  DATOS PERSONALES. Es la unica tabla del sistema que guarda datos de
--  una persona que NO es titular de una cuenta: nombre, documento,
--  telefono y, si lo da, correo. Por eso:
--    · `consentimiento_datos` y `consentimiento_alcance` son obligatorios
--      y se guardan junto con `texto_version`, la version del texto que
--      se le leyo. Es la responsabilidad proactiva que pide la LOPDP:
--      poder demostrar QUE acepto y CUANDO.
--    · DELETE /api/admin/solicitudes/:id borra la fila de verdad -no la
--      marca-, para poder atender el derecho de eliminacion.
--    · El documento se guarda en claro a proposito: sin el, la constancia
--      firmada no identifica a nadie y el tramite pierde su objeto.
--
--    npx wrangler d1 execute caech-afiliados --remote \
--        --file=migraciones/006-solicitudes-presenciales.sql
--
--  APLICAR ANTES DE DESPLEGAR EL WORKER: la pestana Solicitudes del
--  panel consulta esta tabla en cuanto se abre. `schema.sql` ya la trae;
--  esto es para la base que existia antes. Es CREATE ... IF NOT EXISTS:
--  repetirla no rompe nada.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS solicitudes_dicat (
    id                      TEXT    PRIMARY KEY,
    numero                  TEXT    NOT NULL UNIQUE,        -- DICAT-AAAA-NNNN, correlativo por ano
    creado_en               TEXT    NOT NULL,
    actualizado_en          TEXT,
    recibida_en             TEXT    NOT NULL,               -- cuando se atendio en el mostrador

    -- Solicitante
    solicitante             TEXT    NOT NULL,
    documento_tipo          TEXT    NOT NULL
                                    CHECK (documento_tipo IN ('cedula', 'ruc', 'pasaporte')),
    documento               TEXT    NOT NULL,
    telefono                TEXT    NOT NULL,
    correo                  TEXT,
    registro_profesional    TEXT,                           -- si es colegiado del CAE
    calidad                 TEXT    NOT NULL,               -- propietario, apoderado, profesional a cargo...

    -- Predio
    clave_catastral         TEXT    NOT NULL,               -- 27 digitos, sin separadores
    clave_auxiliar          TEXT,
    direccion               TEXT    NOT NULL,
    parroquia               TEXT,
    barrio                  TEXT,
    propietario_catastro    TEXT,

    -- Reporte pedido
    entrega                 TEXT    NOT NULL,
    ejemplares              INTEGER NOT NULL DEFAULT 1,
    finalidad               TEXT,
    entrega_ofrecida        TEXT,                           -- AAAA-MM-DD
    observaciones           TEXT,

    -- Constancia (LOPDP)
    consentimiento_datos    INTEGER NOT NULL DEFAULT 0,
    consentimiento_alcance  INTEGER NOT NULL DEFAULT 0,
    texto_version           TEXT    NOT NULL,

    -- Seguimiento
    estado                  TEXT    NOT NULL DEFAULT 'recibida'
                                    CHECK (estado IN ('recibida', 'entregada', 'anulada')),
    entregada_en            TEXT,
    atendido_por            TEXT    NOT NULL,               -- quien recibio, en el mostrador
    registrada_por          TEXT    REFERENCES afiliados(id) ON DELETE SET NULL,
    ip_hash                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_solicitudes_fecha  ON solicitudes_dicat (creado_en);
CREATE INDEX IF NOT EXISTS idx_solicitudes_estado ON solicitudes_dicat (estado, creado_en);
CREATE INDEX IF NOT EXISTS idx_solicitudes_clave  ON solicitudes_dicat (clave_catastral);
