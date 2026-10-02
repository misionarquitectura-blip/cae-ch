/**
 * Prueba de extremo a extremo del API de afiliados.
 *
 * Requiere el Worker corriendo en local con la base ya sembrada:
 *
 *   npx wrangler d1 execute caech-afiliados --local --file=schema.sql
 *   node scripts/crear-admin.mjs --usuario admin --correo admin@cae-ch.org.ec \
 *        --nombre "Administrador CAE-CH" --iteraciones 50000
 *   # aplicar el INSERT que imprime, luego:
 *   npx wrangler dev --port 8787 --local
 *
 *   node test/api.test.mjs <clave-temporal-del-admin> [ruta-al-log-de-wrangler]
 *
 * El log de wrangler hace falta para el tramo de registro: con
 * MAIL_PROVEEDOR="consola" el enlace de confirmacion se escribe ahi.
 * Por eso `reiniciar.sh` arranca el Worker con
 * `--var REGISTRO_ACTIVO:si --var PERMITIR_CORREO_CONSOLA:si`.
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const API = process.env.API || 'http://127.0.0.1:8787';
const CLAVE_TEMPORAL = process.argv[2];
const LOG = process.argv[3];
const ORIGEN = 'https://cae-ch.org';

if (!CLAVE_TEMPORAL) {
    console.error('Uso: node test/api.test.mjs <clave-temporal-del-admin> [log-de-wrangler]');
    process.exit(1);
}

let pasadas = 0, fallidas = 0;

function comprobar(descripcion, condicion, detalle) {
    if (condicion) {
        pasadas++;
        console.log('  ✓', descripcion);
    } else {
        fallidas++;
        console.log('  ✗', descripcion, detalle !== undefined ? '\n      ' + JSON.stringify(detalle) : '');
    }
}

function seccion(titulo) {
    console.log('\n── ' + titulo + ' ' + '─'.repeat(Math.max(0, 58 - titulo.length)));
}

async function llamar(metodo, ruta, { cuerpo, token, origen } = {}) {
    const cabeceras = { 'Origin': origen === undefined ? ORIGEN : origen };
    if (cuerpo) cabeceras['Content-Type'] = 'application/json';
    if (token) cabeceras['Authorization'] = 'Bearer ' + token;
    const r = await fetch(API + ruta, {
        method: metodo,
        headers: cabeceras,
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        redirect: 'manual'
    });
    let datos = null;
    try { datos = await r.json(); } catch (e) { /* redirecciones no traen JSON */ }
    return { estado: r.status, datos, cabeceras: r.headers };
}

const CLAVE_ADMIN = 'RiobambaCatastro2026';
const CLAVE_AFILIADO = 'ChimborazoArqui2026';

// ── 1. Salud y CORS ─────────────────────────────────────────────────
seccion('Salud y CORS');
{
    const r = await llamar('GET', '/api/salud');
    comprobar('GET /api/salud responde 200', r.estado === 200, r.datos);
    comprobar('origen permitido recibe Access-Control-Allow-Origin',
        r.cabeceras.get('access-control-allow-origin') === ORIGEN);

    const ajeno = await llamar('GET', '/api/salud', { origen: 'https://sitio-ajeno.example' });
    comprobar('origen NO permitido no recibe la cabecera CORS',
        ajeno.cabeceras.get('access-control-allow-origin') === null,
        ajeno.cabeceras.get('access-control-allow-origin'));

    const inexistente = await llamar('GET', '/api/no-existe');
    comprobar('ruta inexistente responde 404', inexistente.estado === 404);
}

// ── 2. Ingreso ──────────────────────────────────────────────────────
seccion('Ingreso del administrador');
let tokenAdmin = null;
{
    const malo = await llamar('POST', '/api/sesion', { cuerpo: { usuario: 'admin', clave: 'incorrecta' } });
    comprobar('clave incorrecta responde 401', malo.estado === 401, malo.datos);

    const inexistente = await llamar('POST', '/api/sesion', { cuerpo: { usuario: 'nadie', clave: 'incorrecta' } });
    comprobar('usuario inexistente devuelve el MISMO mensaje que clave incorrecta',
        inexistente.estado === 401 && inexistente.datos.error === malo.datos.error,
        { inexistente: inexistente.datos, malo: malo.datos });

    const bien = await llamar('POST', '/api/sesion', { cuerpo: { usuario: 'admin', clave: CLAVE_TEMPORAL } });
    comprobar('clave temporal correcta responde 200', bien.estado === 200, bien.datos);
    comprobar('entrega un token de sesion', typeof bien.datos?.token === 'string' && bien.datos.token.length > 20);
    comprobar('marca requiere_cambio_clave', bien.datos?.afiliado?.requiere_cambio_clave === true);
    comprobar('con clave temporal NO hay permisos de descarga',
        bien.datos?.permisos && !bien.datos.permisos.dxf && !bien.datos.permisos.csv && !bien.datos.permisos.pdf,
        bien.datos?.permisos);
    comprobar('la respuesta nunca incluye hash_clave',
        !JSON.stringify(bien.datos).includes('pbkdf2'));
    tokenAdmin = bien.datos?.token;

    const conCorreo = await llamar('POST', '/api/sesion', { cuerpo: { usuario: 'ADMIN@cae-ch.org.ec', clave: CLAVE_TEMPORAL } });
    comprobar('tambien se puede entrar con el correo', conCorreo.estado === 200);
}

// ── 3. Bloqueo de descarga con clave temporal ───────────────────────
seccion('Descarga bloqueada mientras la clave sea temporal');
{
    const r = await llamar('POST', '/api/descargas', { token: tokenAdmin, cuerpo: { formato: 'dxf', clave_catastral: '060150010101' } });
    comprobar('DXF con clave temporal responde 403', r.estado === 403, r.datos);
    comprobar('la respuesta avisa que debe cambiar la clave', r.datos?.requiere_cambio_clave === true);

    const sinSesion = await llamar('POST', '/api/descargas', { cuerpo: { formato: 'dxf' } });
    comprobar('DXF sin sesion responde 401', sinSesion.estado === 401);
}

// ── 4. Cambio de clave ──────────────────────────────────────────────
seccion('Cambio de clave obligatorio');
{
    const corta = await llamar('POST', '/api/sesion/clave', {
        token: tokenAdmin, cuerpo: { clave_actual: CLAVE_TEMPORAL, clave_nueva: 'corta1A' }
    });
    comprobar('rechaza una clave de menos de 12 caracteres', corta.estado === 400, corta.datos);

    const debil = await llamar('POST', '/api/sesion/clave', {
        token: tokenAdmin, cuerpo: { clave_actual: CLAVE_TEMPORAL, clave_nueva: 'todominusculas' }
    });
    comprobar('rechaza una clave sin mayusculas ni numeros', debil.estado === 400, debil.datos);

    const conUsuario = await llamar('POST', '/api/sesion/clave', {
        token: tokenAdmin, cuerpo: { clave_actual: CLAVE_TEMPORAL, clave_nueva: 'AdminAdmin2026' }
    });
    comprobar('rechaza una clave que contiene el usuario', conUsuario.estado === 400, conUsuario.datos);

    const actualMala = await llamar('POST', '/api/sesion/clave', {
        token: tokenAdmin, cuerpo: { clave_actual: 'no-es-la-mia', clave_nueva: CLAVE_ADMIN }
    });
    comprobar('rechaza si la clave actual no coincide', actualMala.estado === 401, actualMala.datos);

    const bien = await llamar('POST', '/api/sesion/clave', {
        token: tokenAdmin, cuerpo: { clave_actual: CLAVE_TEMPORAL, clave_nueva: CLAVE_ADMIN }
    });
    comprobar('acepta una clave valida', bien.estado === 200, bien.datos);
    comprobar('ya no exige cambio de clave', bien.datos?.afiliado?.requiere_cambio_clave === false);
    comprobar('ahora si hay permisos de descarga',
        bien.datos?.permisos?.dxf === true && bien.datos?.permisos?.csv === true);

    const vieja = await llamar('POST', '/api/sesion', { cuerpo: { usuario: 'admin', clave: CLAVE_TEMPORAL } });
    comprobar('la clave temporal ya no sirve', vieja.estado === 401);

    const otraSesion = await llamar('GET', '/api/sesion', { token: tokenAdmin });
    comprobar('la sesion que hizo el cambio sigue viva', otraSesion.estado === 200);
}

// ── 4b. Aceptacion de Terminos y Privacidad ─────────────────────────
seccion('Aceptacion de Terminos y Privacidad');
{
    // Una cuenta dada de alta por la administracion no paso por la casilla
    // del registro: la aceptacion queda pendiente, sin quitarle permisos.
    const antes = await llamar('GET', '/api/sesion', { token: tokenAdmin });
    comprobar('la cuenta del admin nace con la aceptacion pendiente',
        antes.datos?.afiliado?.terminos_pendientes === true, antes.datos?.afiliado);
    comprobar('la aceptacion pendiente no quita permisos de descarga',
        antes.datos?.permisos?.pdf === true, antes.datos?.permisos);

    const sinMarcar = await llamar('POST', '/api/sesion/terminos', { token: tokenAdmin, cuerpo: {} });
    comprobar('sin acepta_terminos: true no se registra nada', sinMarcar.estado === 400, sinMarcar.datos);

    const sinSesion = await llamar('POST', '/api/sesion/terminos', { cuerpo: { acepta_terminos: true } });
    comprobar('aceptar exige sesion', sinSesion.estado === 401);

    const acepta = await llamar('POST', '/api/sesion/terminos', { token: tokenAdmin, cuerpo: { acepta_terminos: true } });
    comprobar('registra la aceptacion', acepta.estado === 200, acepta.datos);
    comprobar('guarda la version aceptada',
        !!acepta.datos?.afiliado?.terminos_version && acepta.datos?.afiliado?.terminos_pendientes === false,
        acepta.datos?.afiliado);

    const despues = await llamar('GET', '/api/sesion', { token: tokenAdmin });
    comprobar('la aceptacion persiste en la base', despues.datos?.afiliado?.terminos_pendientes === false,
        despues.datos?.afiliado);
}

// ── 5. Descargas autorizadas y auditadas ────────────────────────────
seccion('Descargas de afiliado');
{
    for (const formato of ['dxf', 'csv', 'pdf']) {
        const r = await llamar('POST', '/api/descargas', { token: tokenAdmin, cuerpo: { formato, clave_catastral: '060150010101' } });
        comprobar(formato.toUpperCase() + ' autorizado', r.estado === 200 && r.datos.autorizado === true, r.datos);
    }
    const libre = await llamar('POST', '/api/descargas', { token: tokenAdmin, cuerpo: { formato: 'pdf' } });
    comprobar('el admin descarga libre, sin cupo ni pago', libre.estado === 200 && libre.datos.via === 'libre', libre.datos);
    const invalido = await llamar('POST', '/api/descargas', { token: tokenAdmin, cuerpo: { formato: 'shp' } });
    comprobar('formato desconocido responde 400', invalido.estado === 400);

    const falso = await llamar('GET', '/api/sesion', { token: 'token-inventado-que-no-existe' });
    comprobar('un token inventado responde 401', falso.estado === 401);
}

// ── 6. Administracion ───────────────────────────────────────────────
seccion('Alta de afiliados');
let idAfiliado = null, claveAfiliado = null;
{
    const lista = await llamar('GET', '/api/admin/afiliados', { token: tokenAdmin });
    comprobar('el admin puede listar afiliados', lista.estado === 200 && lista.datos.total === 1, lista.datos);

    const alta = await llamar('POST', '/api/admin/afiliados', {
        token: tokenAdmin,
        cuerpo: {
            nombre: 'Arq. Maria Paredes', usuario: 'mparedes',
            correo: 'mparedes@example.com', registro_profesional: 'CAE-CH-0421',
            vigencia_hasta: '2027-12-31'
        }
    });
    comprobar('crea el afiliado', alta.estado === 201, alta.datos);
    comprobar('devuelve la clave temporal una sola vez',
        /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/.test(alta.datos?.clave_temporal || ''), alta.datos?.clave_temporal);
    comprobar('nace con rol afiliado y estado activo',
        alta.datos?.afiliado?.rol === 'afiliado' && alta.datos?.afiliado?.estado === 'activo');
    idAfiliado = alta.datos?.afiliado?.id;
    claveAfiliado = alta.datos?.clave_temporal;

    const repetido = await llamar('POST', '/api/admin/afiliados', {
        token: tokenAdmin,
        cuerpo: { nombre: 'Otro Nombre', usuario: 'mparedes', correo: 'otro@example.com' }
    });
    comprobar('rechaza un usuario duplicado', repetido.estado === 409, repetido.datos);

    const correoRepetido = await llamar('POST', '/api/admin/afiliados', {
        token: tokenAdmin,
        cuerpo: { nombre: 'Otro Nombre', usuario: 'otrousuario', correo: 'mparedes@example.com' }
    });
    comprobar('rechaza un correo duplicado', correoRepetido.estado === 409);

    const usuarioMalo = await llamar('POST', '/api/admin/afiliados', {
        token: tokenAdmin, cuerpo: { nombre: 'Nombre Valido', usuario: 'Con Espacios', correo: 'x@example.com' }
    });
    comprobar('rechaza un usuario con formato invalido', usuarioMalo.estado === 400);
}

// ── 7. Separacion de privilegios ────────────────────────────────────
seccion('El afiliado no es administrador');
let tokenAfiliado = null;
{
    const ingreso = await llamar('POST', '/api/sesion', { cuerpo: { usuario: 'mparedes', clave: claveAfiliado } });
    comprobar('el afiliado nuevo puede ingresar', ingreso.estado === 200, ingreso.datos);
    tokenAfiliado = ingreso.datos?.token;

    await llamar('POST', '/api/sesion/clave', {
        token: tokenAfiliado, cuerpo: { clave_actual: claveAfiliado, clave_nueva: CLAVE_AFILIADO }
    });

    const intento = await llamar('GET', '/api/admin/afiliados', { token: tokenAfiliado });
    comprobar('el afiliado NO puede listar afiliados', intento.estado === 403, intento.datos);

    const intentoAlta = await llamar('POST', '/api/admin/afiliados', {
        token: tokenAfiliado, cuerpo: { nombre: 'Colado Colado', usuario: 'colado', correo: 'colado@example.com' }
    });
    comprobar('el afiliado NO puede crear afiliados', intentoAlta.estado === 403);
}

// ── 7b. Planimetria: abierta, con el equipo declarado ───────────────
seccion('Planimetria y declaracion de equipo');
{
    const sesionAfi = await llamar('GET', '/api/sesion', { token: tokenAfiliado });
    comprobar('la planimetria esta abierta a toda cuenta habilitada',
        sesionAfi.datos?.permisos?.planimetria === true, sesionAfi.datos?.permisos);
    comprobar('el afiliado cobra por cupo', sesionAfi.datos?.permisos?.cobro === 'cupo', sesionAfi.datos?.permisos);

    const sinDeclarar = await llamar('POST', '/api/herramientas', {
        token: tokenAfiliado, cuerpo: { herramienta: 'planimetria' }
    });
    comprobar('sin declarar el equipo la puerta responde 403',
        sinDeclarar.estado === 403 && sinDeclarar.datos?.requiere_declaracion === true, sinDeclarar.datos);

    const vacia = await llamar('GET', '/api/equipo', { token: tokenAfiliado });
    comprobar('todavia no hay declaracion', vacia.estado === 200 && vacia.datos?.declaracion === null, vacia.datos);

    const base = { tipo: 'gnss_rtk', marca: 'Trimble', modelo: 'R12i', serie: '6342F01234', acepta_responsabilidad: true };
    const tipoMalo = await llamar('POST', '/api/equipo', { token: tokenAfiliado, cuerpo: { ...base, tipo: 'celular' } });
    comprobar('un equipo que no es de precision se rechaza', tipoMalo.estado === 400, tipoMalo.datos);

    const sinSerie = await llamar('POST', '/api/equipo', { token: tokenAfiliado, cuerpo: { ...base, serie: '' } });
    comprobar('sin numero de serie no hay declaracion', sinSerie.estado === 400, sinSerie.datos);

    const ortoGruesa = await llamar('POST', '/api/equipo', {
        token: tokenAfiliado, cuerpo: { ...base, tipo: 'ortofoto', gsd_cm: 6 }
    });
    comprobar('una ortofoto de 6 cm/px no alcanza', ortoGruesa.estado === 400, ortoGruesa.datos);

    const sinAceptar = await llamar('POST', '/api/equipo', {
        token: tokenAfiliado, cuerpo: { ...base, acepta_responsabilidad: 'si' }
    });
    comprobar('sin aceptar la responsabilidad no hay declaracion', sinAceptar.estado === 400, sinAceptar.datos);

    const declara = await llamar('POST', '/api/equipo', { token: tokenAfiliado, cuerpo: base });
    comprobar('declara su GNSS RTK', declara.estado === 201
        && declara.datos?.declaracion?.serie === '6342F01234', declara.datos);

    const abre = await llamar('POST', '/api/herramientas', {
        token: tokenAfiliado, cuerpo: { herramienta: 'planimetria' }
    });
    comprobar('declarado, la puerta lo deja pasar', abre.estado === 200, abre.datos);

    const sesionAdmin = await llamar('GET', '/api/sesion', { token: tokenAdmin });
    comprobar('el administrador tiene la planimetria',
        sesionAdmin.datos?.permisos?.planimetria === true, sesionAdmin.datos?.permisos);
    const adminSinDeclarar = await llamar('POST', '/api/herramientas', {
        token: tokenAdmin, cuerpo: { herramienta: 'planimetria' }
    });
    comprobar('pero tambien declara su equipo antes de usarla',
        adminSinDeclarar.datos?.requiere_declaracion === true, adminSinDeclarar.datos);
    await llamar('POST', '/api/equipo', {
        token: tokenAdmin, cuerpo: { tipo: 'estacion_total', marca: 'Leica', modelo: 'TS07', serie: '1234567', acepta_responsabilidad: true }
    });
    const abreAdmin = await llamar('POST', '/api/herramientas', {
        token: tokenAdmin, cuerpo: { herramienta: 'planimetria' }
    });
    comprobar('y la abre', abreAdmin.estado === 200 && abreAdmin.datos?.autorizado === true, abreAdmin.datos);

    const inventada = await llamar('POST', '/api/herramientas', {
        token: tokenAdmin, cuerpo: { herramienta: 'teletransporte' }
    });
    comprobar('una herramienta inventada no existe', inventada.estado === 400, inventada.datos);

    const seLaDaSolo = await llamar('PATCH', '/api/admin/afiliados/' + idAfiliado, {
        token: tokenAfiliado, cuerpo: { herramientas: ['planimetria'] }
    });
    comprobar('el afiliado NO puede tocar sus herramientas', seLaDaSolo.estado === 403);

    const malaLista = await llamar('PATCH', '/api/admin/afiliados/' + idAfiliado, {
        token: tokenAdmin, cuerpo: { herramientas: ['planimetria', 'teletransporte'] }
    });
    comprobar('una lista con una herramienta desconocida se rechaza entera', malaLista.estado === 400);

    const sinSesion = await llamar('POST', '/api/herramientas', { cuerpo: { herramienta: 'planimetria' } });
    comprobar('sin sesion no se abre ninguna herramienta', sinSesion.estado === 401);
}

// ── 7c. Cupo mensual del colegiado ──────────────────────────────────
seccion('Cupo mensual del colegiado');
{
    const predios = ['0601500101', '0601500102', '0601500103', '0601500104'];
    for (let i = 0; i < predios.length; i++) {
        const r = await llamar('POST', '/api/descargas', {
            token: tokenAfiliado, cuerpo: { formato: 'pdf', clave_catastral: predios[i] }
        });
        comprobar('predio ' + (i + 1) + ' de 4 entra por el cupo',
            r.estado === 200 && r.datos?.via === 'cupo' && r.datos?.cupo?.usados === i + 1, r.datos);
    }

    const mismo = await llamar('POST', '/api/descargas', {
        token: tokenAfiliado, cuerpo: { formato: 'dxf', clave_catastral: predios[0] }
    });
    comprobar('el DXF de un predio ya habilitado no gasta cupo',
        mismo.estado === 200 && mismo.datos?.predio_nuevo === false && !mismo.datos?.cupo, mismo.datos);

    const sinClave = await llamar('POST', '/api/descargas', { token: tokenAfiliado, cuerpo: { formato: 'csv' } });
    comprobar('sin clave del predio no se autoriza nada', sinClave.estado === 400, sinClave.datos);

    const quinto = await llamar('POST', '/api/descargas', {
        token: tokenAfiliado, cuerpo: { formato: 'pdf', clave_catastral: '0601500105' }
    });
    comprobar('el quinto predio del mes pide pago (402)',
        quinto.estado === 402 && quinto.datos?.requiere_pago === true, quinto.datos);
    comprobar('y dice el precio y el cupo agotado',
        quinto.datos?.tarifa?.precio === 2000 && quinto.datos?.cupo?.restantes === 0, quinto.datos);

    const estado = await llamar('GET', '/api/predios/estado?clave=' + predios[1], { token: tokenAfiliado });
    comprobar('el estado del predio lo da por habilitado via cupo',
        estado.datos?.habilitado === true && estado.datos?.via === 'cupo' && !!estado.datos?.vence_en, estado.datos);

    const resumen = await llamar('GET', '/api/cuenta/cobros', { token: tokenAfiliado });
    comprobar('el resumen de la cuenta lista los 4 predios',
        resumen.estado === 200 && resumen.datos?.predios?.length === 4 && resumen.datos?.cupo?.usados === 4, resumen.datos);
}

// ── 8. Suspension y vigencia ────────────────────────────────────────
seccion('Suspension, vigencia y bajas');
{
    const suspender = await llamar('PATCH', '/api/admin/afiliados/' + idAfiliado, {
        token: tokenAdmin, cuerpo: { estado: 'suspendido' }
    });
    comprobar('el admin suspende al afiliado', suspender.estado === 200, suspender.datos);

    const conSesionVieja = await llamar('POST', '/api/descargas', { token: tokenAfiliado, cuerpo: { formato: 'dxf' } });
    comprobar('la suspension corta la sesion ya abierta', conSesionVieja.estado === 401, conSesionVieja.datos);

    const reingreso = await llamar('POST', '/api/sesion', { cuerpo: { usuario: 'mparedes', clave: CLAVE_AFILIADO } });
    comprobar('el suspendido no puede volver a entrar', reingreso.estado === 403, reingreso.datos);

    await llamar('PATCH', '/api/admin/afiliados/' + idAfiliado, { token: tokenAdmin, cuerpo: { estado: 'activo' } });

    const caducar = await llamar('PATCH', '/api/admin/afiliados/' + idAfiliado, {
        token: tokenAdmin, cuerpo: { vigencia_hasta: '2020-01-01' }
    });
    comprobar('el admin puede fijar la vigencia', caducar.estado === 200, caducar.datos);

    const vencido = await llamar('POST', '/api/sesion', { cuerpo: { usuario: 'mparedes', clave: CLAVE_AFILIADO } });
    comprobar('con la afiliacion vencida no se puede entrar', vencido.estado === 403, vencido.datos);

    await llamar('PATCH', '/api/admin/afiliados/' + idAfiliado, { token: tokenAdmin, cuerpo: { vigencia_hasta: '2030-12-31' } });

    const autoBaja = await llamar('PATCH', '/api/admin/afiliados/' + (await llamar('GET', '/api/sesion', { token: tokenAdmin })).datos.afiliado.id, {
        token: tokenAdmin, cuerpo: { estado: 'suspendido' }
    });
    comprobar('el admin no puede desactivarse a si mismo', autoBaja.estado === 400, autoBaja.datos);

    const autoDegradar = await llamar('PATCH', '/api/admin/afiliados/' + (await llamar('GET', '/api/sesion', { token: tokenAdmin })).datos.afiliado.id, {
        token: tokenAdmin, cuerpo: { rol: 'afiliado' }
    });
    comprobar('el admin no puede quitarse el rol de admin', autoDegradar.estado === 400, autoDegradar.datos);

    const restablecer = await llamar('POST', '/api/admin/afiliados/' + idAfiliado + '/clave', { token: tokenAdmin });
    comprobar('el admin restablece la clave del afiliado', restablecer.estado === 200, restablecer.datos);
    comprobar('el restablecimiento entrega una clave nueva',
        /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/.test(restablecer.datos?.clave_temporal || ''));

    const conClaveVieja = await llamar('POST', '/api/sesion', { cuerpo: { usuario: 'mparedes', clave: CLAVE_AFILIADO } });
    comprobar('la clave anterior deja de servir tras el restablecimiento', conClaveVieja.estado === 401);
}

// ── 9. Freno de fuerza bruta ────────────────────────────────────────
seccion('Freno de fuerza bruta');
{
    let ultimo = null;
    for (let i = 0; i < 6; i++) {
        ultimo = await llamar('POST', '/api/sesion', { cuerpo: { usuario: 'mparedes', clave: 'intento-fallido-' + i } });
    }
    comprobar('tras 5 intentos fallidos la cuenta se bloquea', ultimo.estado === 429, ultimo.datos);

    const admin = await llamar('POST', '/api/sesion', { cuerpo: { usuario: 'admin', clave: CLAVE_ADMIN } });
    comprobar('el bloqueo es por cuenta, no global', admin.estado === 200);

    const desbloquear = await llamar('PATCH', '/api/admin/afiliados/' + idAfiliado, {
        token: tokenAdmin, cuerpo: { desbloquear: true }
    });
    comprobar('el admin puede desbloquear la cuenta', desbloquear.estado === 200, desbloquear.datos);
}

// ── 10. Pase de cortesia retirado ───────────────────────────────────
seccion('El pase de cortesia esta retirado');
{
    // Desde 2026-09-04 el mapa se abre al publico y, a cambio, los tres
    // productos exigen cuenta de colegiado. Los endpoints siguen en pie
    // para no romper enlaces viejos, pero nacen apagados.
    const solicitud = await llamar('POST', '/api/freemium/solicitar', {
        cuerpo: { correo: 'ciudadano' + Date.now() + '@example.com' }
    });
    comprobar('solicitar un pase responde 503', solicitud.estado === 503, solicitud.datos);

    const paseFalso = await llamar('POST', '/api/freemium/consumir', { cuerpo: { pase: 'pase-inventado' } });
    comprobar('un pase inventado no autoriza nada', paseFalso.estado >= 400, paseFalso.datos);
}

// ── 10b. Registro publico de usuarios ───────────────────────────────
seccion('Registro publico de usuarios');
let tokenUsuario = null;
const CORREO_USR = 'vecino' + Date.now() + '@example.com';
const CLAVE_USR  = 'RiobambaVecino2026';
const REGISTRO_USR = 'CAE-CH-' + String(Date.now()).slice(-6);
{
    const sinAceptar = await llamar('POST', '/api/registro', {
        cuerpo: { nombre: 'Juan Vecino', registro_profesional: REGISTRO_USR, correo: CORREO_USR, clave: CLAVE_USR }
    });
    comprobar('sin aceptar Terminos y Privacidad no hay alta', sinAceptar.estado === 400, sinAceptar.datos);

    const aceptaTexto = await llamar('POST', '/api/registro', {
        cuerpo: { nombre: 'Juan Vecino', registro_profesional: REGISTRO_USR, correo: CORREO_USR, clave: CLAVE_USR,
                  acepta_terminos: 'si' }
    });
    comprobar('la aceptacion debe ser un true expreso, no un texto', aceptaTexto.estado === 400, aceptaTexto.datos);

    const registroRaro = await llamar('POST', '/api/registro', {
        cuerpo: { nombre: 'Juan Vecino', registro_profesional: 'ab', correo: CORREO_USR, clave: CLAVE_USR, acepta_terminos: true }
    });
    comprobar('rechaza un numero de registro con mala pinta', registroRaro.estado === 400, registroRaro.datos);

    const corta = await llamar('POST', '/api/registro', {
        cuerpo: { nombre: 'Juan Vecino', registro_profesional: REGISTRO_USR, correo: CORREO_USR, clave: 'corta1A', acepta_terminos: true }
    });
    comprobar('rechaza una clave debil', corta.estado === 400, corta.datos);

    const correoMalo = await llamar('POST', '/api/registro', {
        cuerpo: { nombre: 'Juan Vecino', registro_profesional: REGISTRO_USR, correo: 'no-es-correo', clave: CLAVE_USR, acepta_terminos: true }
    });
    comprobar('rechaza un correo mal formado', correoMalo.estado === 400);

    const alta = await llamar('POST', '/api/registro', {
        cuerpo: { nombre: 'Juan Vecino', registro_profesional: REGISTRO_USR, correo: CORREO_USR, clave: CLAVE_USR, acepta_terminos: true }
    });
    comprobar('crea la cuenta', alta.estado === 201, alta.datos);

    const registroTomado = await llamar('POST', '/api/registro', {
        cuerpo: { nombre: 'Otra Persona', registro_profesional: REGISTRO_USR,
                  correo: 'otra' + Date.now() + '@example.com', clave: CLAVE_USR, acepta_terminos: true }
    });
    comprobar('un numero de registro ya usado responde 409', registroTomado.estado === 409, registroTomado.datos);
    comprobar('no entrega token: la cuenta aun no sirve', !alta.datos.token);

    const sinConfirmar = await llamar('POST', '/api/sesion', { cuerpo: { usuario: CORREO_USR, clave: CLAVE_USR } });
    comprobar('sin confirmar el correo NO se puede ingresar', sinConfirmar.estado === 403, sinConfirmar.datos);
    comprobar('la respuesta lo senala para poder reenviar', sinConfirmar.datos?.correo_sin_verificar === true);

    const repetido = await llamar('POST', '/api/registro', {
        cuerpo: { nombre: 'Otro Nombre', registro_profesional: REGISTRO_USR, correo: CORREO_USR, clave: CLAVE_USR, acepta_terminos: true }
    });
    comprobar('un correo ya registrado responde igual que un alta (no filtra el padron)',
        repetido.estado === 201, repetido.datos);

    if (LOG) {
        let m = null;
        for (let i = 0; i < 20 && !m; i++) {
            await new Promise(r => setTimeout(r, 250));
            m = [...readFileSync(LOG, 'utf8').matchAll(/registro\/verificar\?t=([A-Za-z0-9_-]+)/g)].pop();
        }
        comprobar('el enlace de confirmacion aparece en el log', !!m);

        if (m) {
            const r = await fetch(API + '/api/registro/verificar?t=' + m[1], { redirect: 'manual' });
            const destino = r.headers.get('location') || '';
            comprobar('confirmar redirige al sitio', r.status === 302 && destino.includes('cuenta=verificada'), destino);

            const repite = await fetch(API + '/api/registro/verificar?t=' + m[1], { redirect: 'manual' });
            comprobar('el enlace muere tras usarse',
                (repite.headers.get('location') || '').includes('enlace_invalido'));

            const ingreso = await llamar('POST', '/api/sesion', { cuerpo: { usuario: CORREO_USR, clave: CLAVE_USR } });
            comprobar('ya confirmado, puede ingresar', ingreso.estado === 200, ingreso.datos);
            comprobar('nace con rol usuario', ingreso.datos?.afiliado?.rol === 'usuario');
            comprobar('no exige cambio de clave: la eligio el', ingreso.datos?.afiliado?.requiere_cambio_clave === false);
            comprobar('el alta deja constancia de la version aceptada',
                !!ingreso.datos?.afiliado?.terminos_version && ingreso.datos?.afiliado?.terminos_pendientes === false,
                ingreso.datos?.afiliado);
            tokenUsuario = ingreso.datos?.token;

            comprobar('guarda el numero de registro que declaro',
                ingreso.datos?.afiliado?.registro_profesional === REGISTRO_USR, ingreso.datos?.afiliado);
            comprobar('el numero nace SIN validar',
                ingreso.datos?.afiliado?.registro_validado === false, ingreso.datos?.afiliado);

            // Mientras el numero no se coteje contra el padron la cuenta
            // funciona como publica: pide productos, pero paga cada predio.
            const p = ingreso.datos?.permisos;
            comprobar('puede pedir productos', p?.pdf === true && p?.dxf === true && p?.csv === true, p);
            comprobar('pero cobra por pago, no por cupo', p?.cobro === 'pago' && p?.colegiado === false, p);

            const pdfPendiente = await llamar('POST', '/api/descargas', {
                token: tokenUsuario, cuerpo: { formato: 'pdf', clave_catastral: '060150010101' }
            });
            comprobar('el PDF de un predio pide pago (402)', pdfPendiente.estado === 402, pdfPendiente.datos);
            comprobar('y explica que el registro esta pendiente',
                pdfPendiente.datos?.registro_pendiente === true, pdfPendiente.datos);

            const admin = await llamar('GET', '/api/admin/afiliados', { token: tokenUsuario });
            comprobar('un usuario no llega a la administracion', admin.estado === 403);

            // ── El admin coteja el padron y valida el numero ──
            const yo = await llamar('GET', '/api/sesion', { token: tokenUsuario });
            const pendientes = await llamar('GET', '/api/admin/afiliados?pendientes=1', { token: tokenAdmin });
            comprobar('la bandeja de pendientes lista la cuenta nueva',
                pendientes.estado === 200 && pendientes.datos.afiliados.some(a => a.id === yo.datos.afiliado.id),
                pendientes.datos?.total);

            const validar = await llamar('PATCH', '/api/admin/afiliados/' + yo.datos.afiliado.id, {
                token: tokenAdmin, cuerpo: { registro_validado: true }
            });
            comprobar('el admin valida el numero de registro', validar.estado === 200, validar.datos);
            comprobar('la cuenta queda marcada como validada',
                validar.datos?.afiliado?.registro_validado === true, validar.datos?.afiliado);

            const tras = await llamar('GET', '/api/sesion', { token: tokenUsuario });
            comprobar('validado, pasa a cobrar por cupo de colegiado',
                tras.datos?.permisos?.cobro === 'cupo' && tras.datos?.permisos?.colegiado === true, tras.datos?.permisos);

            const pdfOk = await llamar('POST', '/api/descargas', {
                token: tokenUsuario, cuerpo: { formato: 'pdf', clave_catastral: '060150010101' }
            });
            comprobar('y el servidor lo autoriza con su cupo', pdfOk.estado === 200 && pdfOk.datos?.via === 'cupo', pdfOk.datos);

            const pdfOtro = await llamar('POST', '/api/descargas', {
                token: tokenUsuario, cuerpo: { formato: 'pdf', clave_catastral: '060150010102' }
            });
            comprobar('el segundo predio tambien', pdfOtro.estado === 200, pdfOtro.datos);

            const invalidar = await llamar('PATCH', '/api/admin/afiliados/' + yo.datos.afiliado.id, {
                token: tokenAdmin, cuerpo: { registro_validado: false }
            });
            comprobar('el admin puede revocar la validacion', invalidar.estado === 200, invalidar.datos);
            const revocado = await llamar('GET', '/api/sesion', { token: tokenUsuario });
            comprobar('revocado, vuelve a pagar como cuenta publica',
                revocado.datos?.permisos?.cobro === 'pago', revocado.datos?.permisos);
            const yaHabilitado = await llamar('POST', '/api/descargas', {
                token: tokenUsuario, cuerpo: { formato: 'csv', clave_catastral: '060150010101' }
            });
            comprobar('pero conserva los predios que ya habilito', yaHabilitado.estado === 200, yaHabilitado.datos);

            // Se deja validado para lo que sigue.
            await llamar('PATCH', '/api/admin/afiliados/' + yo.datos.afiliado.id, {
                token: tokenAdmin, cuerpo: { registro_validado: true }
            });
        }
    } else {
        console.log('  – tramo de confirmacion omitido (no se paso el log de wrangler)');
    }
}

// ── 10c. Cuenta publica y pago por predio ───────────────────────────
// PayPhone se simula en el puerto 8791: `reiniciar.sh` arranca el Worker
// con PAYPHONE_URL_CONFIRMAR apuntando aqui. El id de la transaccion
// decide la respuesta: 777 devuelve otro monto, 999 un pago cancelado y
// cualquier otro, aprobado por el monto que el Worker preparo.
seccion('Cuenta publica y pago por predio');
{
    const preparados = new Map();
    const llamadasConfirm = [];
    const simulador = createServer((req, res) => {
        let cuerpo = '';
        req.on('data', c => { cuerpo += c; });
        req.on('end', () => {
            const d = JSON.parse(cuerpo || '{}');
            llamadasConfirm.push({ auth: req.headers.authorization, ...d });
            const monto = preparados.get(d.clientTxId) || 0;
            const r = d.id === 999
                ? { statusCode: 2, transactionStatus: 'Canceled', clientTransactionId: d.clientTxId, transactionId: d.id, amount: monto }
                : { statusCode: 3, transactionStatus: 'Approved', clientTransactionId: d.clientTxId, transactionId: d.id,
                    amount: d.id === 777 ? 100 : monto, authorizationCode: 'W' + d.id };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(r));
        });
    });
    await new Promise(r => simulador.listen(8791, '127.0.0.1', r));

    const CORREO_PUB = 'publico' + Date.now() + '@example.com';
    const CLAVE_PUB = 'GuanoPublico2026';
    let tokenPub = null;

    const alta = await llamar('POST', '/api/registro', {
        cuerpo: { nombre: 'Rosa Publica', correo: CORREO_PUB, clave: CLAVE_PUB, acepta_terminos: true }
    });
    comprobar('sin numero de registro tambien hay alta (cuenta publica)', alta.estado === 201, alta.datos);

    if (LOG) {
        let m = null;
        for (let i = 0; i < 20 && !m; i++) {
            await new Promise(r => setTimeout(r, 250));
            const enlaces = [...readFileSync(LOG, 'utf8').matchAll(/registro\/verificar\?t=([A-Za-z0-9_-]+)/g)];
            m = enlaces.length ? enlaces.pop() : null;
        }
        if (m) await fetch(API + '/api/registro/verificar?t=' + m[1], { redirect: 'manual' });
        const ingreso = await llamar('POST', '/api/sesion', { cuerpo: { usuario: CORREO_PUB, clave: CLAVE_PUB } });
        comprobar('la cuenta publica confirma e ingresa', ingreso.estado === 200, ingreso.datos);
        tokenPub = ingreso.datos?.token;
        const p = ingreso.datos?.permisos;
        comprobar('nace sin numero de registro', ingreso.datos?.afiliado?.registro_profesional == null, ingreso.datos?.afiliado);
        comprobar('cobra por pago y tiene la planimetria', p?.cobro === 'pago' && p?.planimetria === true, p);
    } else {
        console.log('  – tramo de cuenta publica omitido (no se paso el log de wrangler)');
    }

    if (tokenPub) {
        const PREDIO = '0601500201';
        const sinPagar = await llamar('POST', '/api/descargas', {
            token: tokenPub, cuerpo: { formato: 'pdf', clave_catastral: PREDIO }
        });
        comprobar('sin pagar el predio responde 402', sinPagar.estado === 402 && sinPagar.datos?.requiere_pago === true, sinPagar.datos);
        comprobar('una cuenta publica no tiene cupo', sinPagar.datos?.cupo === null, sinPagar.datos);
        comprobar('el cobro en linea figura disponible', sinPagar.datos?.tarifa?.cobro_en_linea === true, sinPagar.datos?.tarifa);

        async function preparar() {
            const r = await llamar('POST', '/api/pagos', { token: tokenPub, cuerpo: { clave_catastral: PREDIO } });
            if (r.datos?.cajita) preparados.set(r.datos.cajita.clientTransactionId, r.datos.cajita.amount);
            return r;
        }

        const p1 = await preparar();
        comprobar('prepara el pago', p1.estado === 201 && !!p1.datos?.pago?.id, p1.datos);
        const c = p1.datos?.cajita || {};
        comprobar('la cajita cobra USD 20 con IVA desglosado',
            c.amount === 2000 && c.amountWithTax === 1739 && c.tax === 261 && c.amountWithoutTax === 0, c);
        comprobar('el clientTransactionId es el id del pago y es alfanumerico',
            c.clientTransactionId === p1.datos?.pago?.id && /^[A-Z0-9]{10,40}$/.test(c.clientTransactionId), c.clientTransactionId);

        const ajeno = await llamar('POST', '/api/pagos/confirmar', {
            token: tokenAdmin, cuerpo: { id: 4321, clientTransactionId: c.clientTransactionId }
        });
        comprobar('otra cuenta no puede confirmar un pago ajeno', ajeno.estado === 404, ajeno.datos);

        const otroMonto = await llamar('POST', '/api/pagos/confirmar', {
            token: tokenPub, cuerpo: { id: 777, clientTransactionId: c.clientTransactionId }
        });
        comprobar('un monto distinto al preparado se rechaza',
            otroMonto.datos?.ok === false && otroMonto.datos?.pago?.estado === 'rechazado', otroMonto.datos);
        comprobar('el Worker llamo al Confirm con el token de PayPhone',
            llamadasConfirm.some(l => l.auth === 'Bearer prueba-payphone'), llamadasConfirm);

        const sigue = await llamar('POST', '/api/descargas', { token: tokenPub, cuerpo: { formato: 'pdf', clave_catastral: PREDIO } });
        comprobar('tras el rechazo el predio sigue cerrado', sigue.estado === 402);

        const p2 = await preparar();
        const cancelado = await llamar('POST', '/api/pagos/confirmar', {
            token: tokenPub, cuerpo: { id: 999, clientTransactionId: p2.datos?.pago?.id }
        });
        comprobar('un pago cancelado en PayPhone queda cancelado',
            cancelado.datos?.pago?.estado === 'cancelado', cancelado.datos);

        const p3 = await preparar();
        const aprobado = await llamar('POST', '/api/pagos/confirmar', {
            token: tokenPub, cuerpo: { id: 12345, clientTransactionId: p3.datos?.pago?.id }
        });
        comprobar('un pago aprobado habilita el predio',
            aprobado.estado === 200 && aprobado.datos?.ok === true && !!aprobado.datos?.vence_en, aprobado.datos);
        comprobar('y guarda la autorizacion de PayPhone', aprobado.datos?.pago?.autorizacion === 'W12345', aprobado.datos?.pago);

        const llamadasAntes = llamadasConfirm.length;
        const repetido = await llamar('POST', '/api/pagos/confirmar', {
            token: tokenPub, cuerpo: { id: 12345, clientTransactionId: p3.datos?.pago?.id }
        });
        comprobar('confirmar otra vez es idempotente y no vuelve a PayPhone',
            repetido.datos?.ok === true && llamadasConfirm.length === llamadasAntes, repetido.datos);

        for (const formato of ['pdf', 'dxf', 'csv']) {
            const r = await llamar('POST', '/api/descargas', { token: tokenPub, cuerpo: { formato, clave_catastral: PREDIO } });
            comprobar('pagado, ' + formato.toUpperCase() + ' autorizado', r.estado === 200 && r.datos?.via === 'pago', r.datos);
        }

        const otraVez = await llamar('POST', '/api/pagos', { token: tokenPub, cuerpo: { clave_catastral: PREDIO } });
        comprobar('no deja pagar dos veces el mismo predio', otraVez.estado === 409 && otraVez.datos?.ya_habilitado === true, otraVez.datos);

        const OTRO = 'GEO-E760123-N9815432-A512';
        const otro = await llamar('POST', '/api/descargas', { token: tokenPub, cuerpo: { formato: 'pdf', clave_catastral: OTRO } });
        comprobar('un poligono propio (clave GEO-) tambien se cobra', otro.estado === 402, otro.datos);

        const yo = await llamar('GET', '/api/sesion', { token: tokenPub });
        const sede = await llamar('POST', '/api/admin/afiliados/' + yo.datos.afiliado.id + '/predios', {
            token: tokenAdmin, cuerpo: { clave_catastral: OTRO, motivo: 'pago en sede' }
        });
        comprobar('el admin habilita un predio pagado en la sede', sede.estado === 201 && sede.datos?.via === 'admin', sede.datos);
        const tras = await llamar('POST', '/api/descargas', { token: tokenPub, cuerpo: { formato: 'pdf', clave_catastral: OTRO } });
        comprobar('y la cuenta ya lo descarga', tras.estado === 200 && tras.datos?.via === 'admin', tras.datos);

        const seHabilitaSolo = await llamar('POST', '/api/admin/afiliados/' + yo.datos.afiliado.id + '/predios', {
            token: tokenPub, cuerpo: { clave_catastral: '0601500999' }
        });
        comprobar('una cuenta publica no se habilita predios a si misma', seHabilitaSolo.estado === 403);

        const resumen = await llamar('GET', '/api/cuenta/cobros', { token: tokenPub });
        comprobar('su resumen muestra los dos predios y los tres pagos cerrados',
            resumen.datos?.predios?.length === 2 && resumen.datos?.pagos?.length === 3, resumen.datos);

        const pagosAdmin = await llamar('GET', '/api/admin/pagos', { token: tokenAdmin });
        comprobar('el admin ve los pagos con su estado',
            pagosAdmin.estado === 200 && pagosAdmin.datos?.resumen?.some(f => f.estado === 'aprobado' && f.monto === 2000),
            pagosAdmin.datos?.resumen);
        const pagosAjeno = await llamar('GET', '/api/admin/pagos', { token: tokenPub });
        comprobar('y una cuenta publica no', pagosAjeno.estado === 403);
    }

    simulador.close();
}

// ── 11. Bitacora ────────────────────────────────────────────────────
seccion('Bitacora y auditoria');
{
    const descargas = await llamar('GET', '/api/admin/descargas', { token: tokenAdmin });
    comprobar('la bitacora de descargas registra las de afiliado',
        descargas.estado === 200 && descargas.datos.descargas.some(d => d.formato === 'dxf' && d.usuario === 'admin'),
        descargas.datos?.resumen);

    const eventos = await llamar('GET', '/api/admin/eventos', { token: tokenAdmin });
    comprobar('la bitacora registra los ingresos fallidos',
        eventos.datos?.eventos?.some(e => e.tipo === 'ingreso_fallido'));
    comprobar('la bitacora registra las altas de afiliados',
        eventos.datos?.eventos?.some(e => e.tipo === 'afiliado_creado'));
    comprobar('la bitacora nunca guarda la IP en claro',
        !JSON.stringify(eventos.datos).match(/\b\d{1,3}(\.\d{1,3}){3}\b/));

    if (tokenUsuario) {
        const yo = await llamar('GET', '/api/sesion', { token: tokenUsuario });
        const ascenso = await llamar('PATCH', '/api/admin/afiliados/' + yo.datos.afiliado.id, {
            token: tokenAdmin, cuerpo: { rol: 'afiliado' }
        });
        comprobar('el admin asciende un usuario a afiliado', ascenso.estado === 200, ascenso.datos);
        const tras = await llamar('GET', '/api/sesion', { token: tokenUsuario });
        comprobar('como afiliado conserva todos los permisos',
            tras.datos?.permisos?.dxf === true && tras.datos?.permisos?.pdf === true, tras.datos?.permisos);
        comprobar('la bitacora deja constancia de la validacion del registro',
            eventos.datos?.eventos?.some(e => (e.detalle || '').includes('registro validado')));
    }

    const cierre = await llamar('DELETE', '/api/sesion', { token: tokenAdmin });
    comprobar('el cierre de sesion responde 200', cierre.estado === 200);
    const despues = await llamar('GET', '/api/sesion', { token: tokenAdmin });
    comprobar('el token deja de servir tras cerrar sesion', despues.estado === 401);
}

console.log('\n' + '═'.repeat(62));
console.log('  ' + pasadas + ' pasadas, ' + fallidas + ' fallidas');
console.log('═'.repeat(62) + '\n');
process.exit(fallidas ? 1 : 0);
