-- ════════════════════════════════════════════════════════════════════
--  002 · Numero de registro del CAE en el alta publica
--
--  Desde 2026-09-04 el GeoVisor se abre sin cuenta: el mapa completo es
--  publico. Lo que exige cuenta son los PRODUCTOS -DICAT en PDF, CSV y
--  DXF- y esas cuentas son solo para miembros del CAE, de modo que el
--  alta pide el numero de registro del colegiado.
--
--  El numero se acepta tal como lo escribe quien se registra y queda
--  PENDIENTE: `registro_validado = 0` deja abrir el visor pero bloquea
--  toda descarga hasta que la administracion lo coteje contra el padron
--  del CAE-CH y lo apruebe.
--
--    npx wrangler d1 execute caech-afiliados --remote \
--        --file=migraciones/002-numero-de-registro.sql
--
--  Solo hace falta sobre una base que ya tenia el esquema anterior;
--  `schema.sql` ya trae estas columnas.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE afiliados ADD COLUMN registro_validado     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE afiliados ADD COLUMN registro_validado_en  TEXT;
ALTER TABLE afiliados ADD COLUMN registro_validado_por TEXT;

-- Las cuentas que ya existian las creo la administracion cotejando el
-- padron en la sede, asi que su registro se da por validado.
UPDATE afiliados
   SET registro_validado = 1,
       registro_validado_en = creado_en,
       registro_validado_por = 'migracion-002'
 WHERE origen = 'admin';

-- Un numero de registro identifica a un colegiado y solo a uno. El
-- indice es parcial porque las cuentas historicas pueden no tenerlo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_afiliados_registro
    ON afiliados (registro_profesional)
    WHERE registro_profesional IS NOT NULL;
