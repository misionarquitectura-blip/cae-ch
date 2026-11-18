-- ════════════════════════════════════════════════════════════════════
--  010 · Datos de facturacion de cada pago y constancia de la factura
--
--  Desde el 2026-11-18 quien paga puede pedir, si quiere, la factura a su
--  nombre: tipo y numero de identificacion, razon social, y opcionalmente
--  correo y direccion. Sin esos datos el pago se factura a consumidor final,
--  como hasta ahora. Los datos van en la fila del pago, no en la cuenta:
--  son los de ESA factura, y una misma cuenta puede facturar a su nombre un
--  mes y a nombre de su empresa el siguiente.
--
--  La administracion anota ademas el numero de la factura emitida en el SRI
--  (001-001-000000123) y cuando: asi el reporte mensual del panel separa lo
--  facturado de lo pendiente.
--
--    npx wrangler d1 execute caech-afiliados --remote \
--        --file=migraciones/010-datos-de-facturacion.sql
--
--  APLICAR ANTES DE DESPLEGAR EL WORKER: el listado de pagos lee estas
--  columnas. Los ALTER no son idempotentes: antes de repetirla, comprobar
--  con SELECT name FROM pragma_table_info('pagos').
--  `schema.sql` ya trae todo; esto es para bases anteriores al 2026-11-18.
-- ════════════════════════════════════════════════════════════════════

-- Nula = consumidor final.
ALTER TABLE pagos ADD COLUMN factura_tipo TEXT
    CHECK (factura_tipo IS NULL OR factura_tipo IN ('cedula', 'ruc', 'pasaporte'));
ALTER TABLE pagos ADD COLUMN factura_identificacion TEXT;
ALTER TABLE pagos ADD COLUMN factura_nombre         TEXT;
ALTER TABLE pagos ADD COLUMN factura_correo         TEXT;
ALTER TABLE pagos ADD COLUMN factura_direccion      TEXT;

-- La factura emitida.
ALTER TABLE pagos ADD COLUMN factura_numero  TEXT;
ALTER TABLE pagos ADD COLUMN facturado_en    TEXT;
ALTER TABLE pagos ADD COLUMN facturado_por   TEXT;     -- usuario del admin

CREATE INDEX IF NOT EXISTS idx_pagos_confirmado ON pagos (estado, confirmado_en);
