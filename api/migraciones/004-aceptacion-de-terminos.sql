-- ════════════════════════════════════════════════════════════════════
--  004 · Aceptacion de Terminos y Politica de Privacidad
--
--  La LOPDP pone en el responsable la carga de probar el consentimiento
--  (principio de responsabilidad proactiva y demostrada). Hasta ahora el
--  alta no dejaba constancia de que se hubieran aceptado los Terminos ni
--  leido la Politica de Privacidad.
--
--  `terminos_version` guarda la fecha de vigencia aceptada (la misma que
--  encabeza legal.html y que fija VERSION_TERMINOS en src/sesiones.js) y
--  `terminos_aceptados_en` el momento. Las cuentas que ya existian quedan
--  en NULL: se les pide aceptar en su proximo ingreso, sin bloquear nada.
--
--  APLICAR ANTES DE DESPLEGAR EL WORKER: el alta nueva escribe estas
--  columnas y fallaria contra una base sin ellas.
--
--    npx wrangler d1 execute caech-afiliados --remote \
--        --file=migraciones/004-aceptacion-de-terminos.sql
--
--  `schema.sql` ya trae las columnas; esto es solo para bases que
--  existian antes del 2026-10-01.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE afiliados ADD COLUMN terminos_version TEXT;
ALTER TABLE afiliados ADD COLUMN terminos_aceptados_en TEXT;
