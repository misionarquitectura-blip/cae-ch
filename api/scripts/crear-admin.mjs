#!/usr/bin/env node
/**
 * Crea el PRIMER administrador de la base de afiliados.
 *
 * No existe endpoint de arranque a proposito: un `/api/registro` abierto,
 * aunque fuera de un solo uso, es justo la puerta que no queremos en un
 * sistema institucional cerrado. El primer admin nace por SQL directo.
 *
 * Uso:
 *   node scripts/crear-admin.mjs --usuario admin --correo tu@correo.com \
 *        --nombre "Nombre Apellido" [--iteraciones 210000]
 *
 * Imprime la sentencia SQL y la clave temporal. Aplique la sentencia con:
 *   npx wrangler d1 execute caech-afiliados --remote --command "<SQL>"
 */

import { hashearClave, generarClaveTemporal, generarId } from '../src/cripto.js';

function argumento(nombre, porDefecto) {
    const i = process.argv.indexOf('--' + nombre);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto;
}

const usuario = String(argumento('usuario', '')).toLowerCase().trim();
const correo  = String(argumento('correo', '')).toLowerCase().trim();
const nombre  = String(argumento('nombre', '')).trim();
const iteraciones = parseInt(argumento('iteraciones', '210000'), 10);

if (!usuario || !correo || !nombre) {
    console.error('Faltan datos.\n');
    console.error('  node scripts/crear-admin.mjs --usuario admin --correo tu@correo.com --nombre "Nombre Apellido"\n');
    process.exit(1);
}
if (!/^[a-z0-9](?:[a-z0-9._-]{2,29})$/.test(usuario)) {
    console.error('Usuario invalido: 3 a 30 caracteres, minusculas, numeros, punto, guion o guion bajo.');
    process.exit(1);
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) {
    console.error('Correo invalido.');
    process.exit(1);
}

const id = generarId('afi');
const clave = generarClaveTemporal();
const hash = await hashearClave(clave, iteraciones);
const t = new Date().toISOString();

const escapar = s => String(s).replace(/'/g, "''");

const sql =
    'INSERT INTO afiliados (id, usuario, correo, nombre, nucleo, rol, estado, hash_clave, ' +
    'requiere_cambio_clave, creado_en, actualizado_en) VALUES (' +
    `'${escapar(id)}', '${escapar(usuario)}', '${escapar(correo)}', '${escapar(nombre)}', ` +
    `'Chimborazo', 'admin', 'activo', '${escapar(hash)}', 1, '${t}', '${t}');`;

console.log('\n══ Administrador inicial ═══════════════════════════════════');
console.log('  usuario         :', usuario);
console.log('  correo          :', correo);
console.log('  CLAVE TEMPORAL  :', clave);
console.log('  (se debera cambiar en el primer ingreso; no se guarda en claro)');
console.log('\n══ SQL a aplicar ══════════════════════════════════════════\n');
console.log(sql);
console.log('\n══ Comando ════════════════════════════════════════════════\n');
console.log('npx wrangler d1 execute caech-afiliados --remote --command "'
    + sql.replace(/"/g, '\\"') + '"\n');
