-- ════════════════════════════════════════════════════════════════════
--  007 · Endurecimiento tras la auditoria del 2026-10-21
--
--  1. `descargas.folio`: cada producto autorizado lleva un folio que el
--     Worker emite y guarda. El DICAT lo imprime como su numero y en el
--     QR; GET /api/verificar?folio= dice si el documento salio de la
--     plataforma. Un PDF armado desde la consola del navegador -sin pasar
--     por la puerta de descargas- no tiene folio registrado.
--
--  2. `afiliados.registro_pendiente`: el numero de registro del CAE que
--     escribe quien se registra se guarda aqui hasta que confirma el
--     correo, y solo entonces pasa a `registro_profesional` (la columna
--     con el indice UNICO). Antes, una cuenta sin confirmar "ocupaba" el
--     numero de un colegiado con solo escribirlo.
--
--  3. Indices de `eventos` para el freno de intentos de ingreso por
--     conexion y por usuario, que cuenta filas de la bitacora.
--
--    npx wrangler d1 execute caech-afiliados --remote \
--        --file=migraciones/007-endurecimiento.sql
--
--  APLICAR ANTES DE DESPLEGAR EL WORKER: /api/descargas escribe el folio
--  y el registro escribe `registro_pendiente`. `schema.sql` ya trae todo;
--  esto es para la base que existia antes. Los ALTER TABLE no son
--  idempotentes: si ya se aplico, fallan con "duplicate column name" y
--  no hay que repetirlos.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE descargas ADD COLUMN folio TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_descargas_folio
    ON descargas (folio)
    WHERE folio IS NOT NULL;

ALTER TABLE afiliados ADD COLUMN registro_pendiente TEXT;

-- Las cuentas sin confirmar que ya tenian numero lo pasan a pendiente:
-- dejan de reservarlo y lo recuperan al confirmar, si sigue libre.
UPDATE afiliados
   SET registro_pendiente = registro_profesional, registro_profesional = NULL
 WHERE correo_verificado = 0 AND registro_profesional IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_eventos_ip      ON eventos (tipo, ip_hash, creado_en);
CREATE INDEX IF NOT EXISTS idx_eventos_usuario ON eventos (tipo, usuario, creado_en);
