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
 * El log de wrangler solo hace falta para el tramo freemium: con
 * MAIL_PROVEEDOR="consola" el enlace de verificacion se escribe ahi.
 */

import { readFileSync } from 'node:fs';

const API = process.env.API || 'http://127.0.0.1:8787';
const CLAVE_TEMPORAL = process.argv[2];
const LOG = process.argv[3];
const ORIGEN = 'https://www.cae-ch.org.ec';

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

// ── 5. Descargas autorizadas y auditadas ────────────────────────────
seccion('Descargas de afiliado');
{
    for (const formato of ['dxf', 'csv', 'pdf']) {
        const r = await llamar('POST', '/api/descargas', { token: tokenAdmin, cuerpo: { formato, clave_catastral: '060150010101' } });
        comprobar(formato.toUpperCase() + ' autorizado', r.estado === 200 && r.datos.autorizado === true, r.datos);
    }
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

// ── 10. Freemium ────────────────────────────────────────────────────
seccion('Freemium: un PDF por correo verificado');
{
    const correoMalo = await llamar('POST', '/api/freemium/solicitar', { cuerpo: { correo: 'no-es-un-correo' } });
    comprobar('rechaza un correo mal formado', correoMalo.estado === 400, correoMalo.datos);

    const correo = 'ciudadano' + Date.now() + '@example.com';
    const solicitud = await llamar('POST', '/api/freemium/solicitar', { cuerpo: { correo } });
    comprobar('acepta la solicitud y dice haber enviado el enlace', solicitud.estado === 200, solicitud.datos);

    if (!LOG) {
        console.log('  – tramo de verificacion omitido (no se paso el log de wrangler)');
    } else {
        // En modo "consola" el enlace queda escrito en los logs del Worker.
        // wrangler vuelca stdout de forma asincrona, asi que se espera a
        // que aparezca en vez de leer el archivo una sola vez.
        let m = null;
        for (let intento = 0; intento < 20 && !m; intento++) {
            await new Promise(r => setTimeout(r, 250));
            const texto = readFileSync(LOG, 'utf8');
            m = [...texto.matchAll(/verificar\?t=([A-Za-z0-9_-]+)/g)].pop();
        }
        comprobar('el enlace de verificacion aparece en el log', !!m);

        if (m) {
            const token = m[1];
            const r = await fetch(API + '/api/freemium/verificar?t=' + token, { redirect: 'manual' });
            const destino = r.headers.get('location') || '';
            comprobar('verificar redirige al visor', r.status === 302 && destino.includes('/geovisor.html?pase='), destino);

            const pase = new URL(destino).searchParams.get('pase');
            comprobar('el pase entregado es distinto del token del correo', pase && pase !== token);

            const viejo = await fetch(API + '/api/freemium/verificar?t=' + token, { redirect: 'manual' });
            comprobar('el enlace del correo muere tras usarse',
                (viejo.headers.get('location') || '').includes('pase_error'), viejo.headers.get('location'));

            const estado = await llamar('GET', '/api/freemium/estado?pase=' + encodeURIComponent(pase));
            comprobar('el pase figura como valido', estado.datos?.valido === true, estado.datos);

            const consumo = await llamar('POST', '/api/freemium/consumir', {
                cuerpo: { pase, clave_catastral: '060150010101' }
            });
            comprobar('el pase autoriza un PDF', consumo.estado === 200 && consumo.datos.formato === 'pdf', consumo.datos);

            const segundo = await llamar('POST', '/api/freemium/consumir', { cuerpo: { pase } });
            comprobar('el mismo pase NO sirve dos veces', segundo.estado === 409, segundo.datos);

            const otraVez = await llamar('POST', '/api/freemium/solicitar', { cuerpo: { correo } });
            comprobar('el correo ya gastado no puede pedir otro reporte', otraVez.estado === 409, otraVez.datos);
        }
    }

    const paseFalso = await llamar('POST', '/api/freemium/consumir', { cuerpo: { pase: 'pase-inventado' } });
    comprobar('un pase inventado responde 401', paseFalso.estado === 401);
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

    const cierre = await llamar('DELETE', '/api/sesion', { token: tokenAdmin });
    comprobar('el cierre de sesion responde 200', cierre.estado === 200);
    const despues = await llamar('GET', '/api/sesion', { token: tokenAdmin });
    comprobar('el token deja de servir tras cerrar sesion', despues.estado === 401);
}

console.log('\n' + '═'.repeat(62));
console.log('  ' + pasadas + ' pasadas, ' + fallidas + ' fallidas');
console.log('═'.repeat(62) + '\n');
process.exit(fallidas ? 1 : 0);
