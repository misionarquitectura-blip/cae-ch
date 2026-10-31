-- ════════════════════════════════════════════════════════════════════
--  008 · Aceptacion de cada documento legal por separado
--
--  Hasta ahora una sola casilla aceptaba juntos los Terminos y la
--  Politica de Privacidad (columnas terminos_* de afiliados, migracion
--  004). Desde el 2026-11-01, antes de descargar un DICAT, un CSV o un
--  DXF y antes de abrir la planimetria, la cuenta acepta POR SEPARADO
--  los Terminos, la Politica de Privacidad y el aviso de almacenamiento
--  en el navegador (cookies), cada uno despues de recorrerlo entero en la
--  ventana de lectura. Se guarda una fila por documento con su version,
--  el tiempo de lectura y la accion que lo pidio.
--
--  APLICAR ANTES DE DESPLEGAR EL WORKER: las puertas de descargas y de
--  herramientas leen esta tabla y fallarian contra una base sin ella.
--
--    npx wrangler d1 execute caech-afiliados --remote \
--        --file=migraciones/008-aceptacion-por-documento.sql
--
--  Es idempotente. `schema.sql` ya trae la tabla.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS aceptaciones (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    afiliado_id       TEXT    NOT NULL REFERENCES afiliados(id) ON DELETE CASCADE,
    documento         TEXT    NOT NULL
                              CHECK (documento IN ('terminos', 'privacidad', 'cookies')),
    version           TEXT    NOT NULL,
    segundos_lectura  INTEGER NOT NULL,
    contexto          TEXT,
    aceptado_en       TEXT    NOT NULL,
    ip_hash           TEXT
);

CREATE INDEX IF NOT EXISTS idx_aceptaciones_cuenta ON aceptaciones (afiliado_id, documento, id);
