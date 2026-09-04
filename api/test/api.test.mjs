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
    const sinRegistro = await llamar('POST', '/api/registro', {
        cuerpo: { nombre: 'Juan Vecino', correo: CORREO_USR, clave: CLAVE_USR }
    });
    comprobar('sin numero de registro del CAE no hay alta', sinRegistro.estado === 400, sinRegistro.datos);

    const registroRaro = await llamar('POST', '/api/registro', {
        cuerpo: { nombre: 'Juan Vecino', registro_profesional: 'ab', correo: CORREO_USR, clave: CLAVE_USR }
    });
    comprobar('rechaza un numero de registro con mala pinta', registroRaro.estado === 400, registroRaro.datos);

    const corta = await llamar('POST', '/api/registro', {
        cuerpo: { nombre: 'Juan Vecino', registro_profesional: REGISTRO_USR, correo: CORREO_USR, clave: 'corta1A' }
    });
    comprobar('rechaza una clave debil', corta.estado === 400, corta.datos);

    const correoMalo = await llamar('POST', '/api/registro', {
        cuerpo: { nombre: 'Juan Vecino', registro_profesional: REGISTRO_USR, correo: 'no-es-correo', clave: CLAVE_USR }
    });
    comprobar('rechaza un correo mal formado', correoMalo.estado === 400);

    const alta = await llamar('POST', '/api/registro', {
        cuerpo: { nombre: 'Juan Vecino', registro_profesional: REGISTRO_USR, correo: CORREO_USR, clave: CLAVE_USR }
    });
    comprobar('crea la cuenta', alta.estado === 201, alta.datos);

    const registroTomado = await llamar('POST', '/api/registro', {
        cuerpo: { nombre: 'Otra Persona', registro_profesional: REGISTRO_USR,
                  correo: 'otra' + Date.now() + '@example.com', clave: CLAVE_USR }
    });
    comprobar('un numero de registro ya usado responde 409', registroTomado.estado === 409, registroTomado.datos);
    comprobar('no entrega token: la cuenta aun no sirve', !alta.datos.token);

    const sinConfirmar = await llamar('POST', '/api/sesion', { cuerpo: { usuario: CORREO_USR, clave: CLAVE_USR } });
    comprobar('sin confirmar el correo NO se puede ingresar', sinConfirmar.estado === 403, sinConfirmar.datos);
    comprobar('la respuesta lo senala para poder reenviar', sinConfirmar.datos?.correo_sin_verificar === true);

    const repetido = await llamar('POST', '/api/registro', {
        cuerpo: { nombre: 'Otro Nombre', registro_profesional: REGISTRO_USR, correo: CORREO_USR, clave: CLAVE_USR }
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
            tokenUsuario = ingreso.datos?.token;

            comprobar('guarda el numero de registro que declaro',
                ingreso.datos?.afiliado?.registro_profesional === REGISTRO_USR, ingreso.datos?.afiliado);
            comprobar('el numero nace SIN validar',
                ingreso.datos?.afiliado?.registro_validado === false, ingreso.datos?.afiliado);

            // Mientras el numero no se coteje contra el padron: se entra,
            // se consulta el mapa (que ademas es publico) y no se descarga.
            const p = ingreso.datos?.permisos;
            comprobar('NO puede descargar el PDF', p?.pdf === false, p);
            comprobar('NO puede exportar DXF', p?.dxf === false, p);
            comprobar('NO puede exportar CSV', p?.csv === false, p);

            const dxf = await llamar('POST', '/api/descargas', { token: tokenUsuario, cuerpo: { formato: 'dxf' } });
            comprobar('el servidor rechaza el DXF', dxf.estado === 403, dxf.datos);
            comprobar('y explica que el registro esta pendiente', dxf.datos?.registro_pendiente === true, dxf.datos);

            const pdfPendiente = await llamar('POST', '/api/descargas', {
                token: tokenUsuario, cuerpo: { formato: 'pdf', clave_catastral: '060150010101' }
            });
            comprobar('tampoco autoriza el PDF', pdfPendiente.estado === 403, pdfPendiente.datos);

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
            comprobar('validado, ya puede descargar el PDF', tras.datos?.permisos?.pdf === true, tras.datos?.permisos);
            comprobar('validado, ya puede exportar DXF', tras.datos?.permisos?.dxf === true, tras.datos?.permisos);
            comprobar('validado, ya puede exportar CSV', tras.datos?.permisos?.csv === true, tras.datos?.permisos);

            const pdfOk = await llamar('POST', '/api/descargas', {
                token: tokenUsuario, cuerpo: { formato: 'pdf', clave_catastral: '060150010101' }
            });
            comprobar('y el servidor lo autoriza de verdad', pdfOk.estado === 200, pdfOk.datos);

            const pdfOtro = await llamar('POST', '/api/descargas', {
                token: tokenUsuario, cuerpo: { formato: 'pdf', clave_catastral: '060150010102' }
            });
            comprobar('sin limite de uno: el segundo PDF tambien', pdfOtro.estado === 200, pdfOtro.datos);

            const invalidar = await llamar('PATCH', '/api/admin/afiliados/' + yo.datos.afiliado.id, {
                token: tokenAdmin, cuerpo: { registro_validado: false }
            });
            comprobar('el admin puede revocar la validacion', invalidar.estado === 200, invalidar.datos);
            const revocado = await llamar('GET', '/api/sesion', { token: tokenUsuario });
            comprobar('revocado, vuelve a quedarse sin descargas',
                revocado.datos?.permisos?.pdf === false, revocado.datos?.permisos);

            // Se deja validado para lo que sigue.
            await llamar('PATCH', '/api/admin/afiliados/' + yo.datos.afiliado.id, {
                token: tokenAdmin, cuerpo: { registro_validado: true }
            });
        }
    } else {
        console.log('  – tramo de confirmacion omitido (no se paso el log de wrangler)');
    }
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
