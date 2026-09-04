// ════════════════════════════════════════════════════════════════════
//  Registro publico de usuarios.
//
//  Quien se registra nace con rol 'usuario': abre el GeoVisor y consulta
//  el mapa, y dispone de UN reporte DICAT de cortesia. DXF y CSV siguen
//  siendo exclusivos de los afiliados, cuyas altas hace la administracion.
//
//  Flujo:
//    1. POST /api/registro            {nombre, usuario, correo, clave}
//       Crea la cuenta sin verificar y envia el enlace de confirmacion.
//    2. GET  /api/registro/verificar?t=<token>
//       Marca el correo verificado y redirige al sitio.
//    3. POST /api/registro/reenviar   {correo}
//       Vuelve a enviar el enlace si caduco o no llego.
//
//  Sin el correo verificado NO se puede iniciar sesion: asi lo decidio el
//  CAE-CH. Mientras `MAIL_PROVEEDOR` sea "consola" el enlace solo queda en
//  los logs, de modo que en la practica el registro no puede completarse
//  hasta que el emisor de correo este configurado.
// ════════════════════════════════════════════════════════════════════

import { generarId, generarToken, sha256, hashearClave, hashIP } from './cripto.js';
import { ahora, vencido, texto, correoValido, enFuturo } from './http.js';
import { iteraciones, registrarEvento, perfilPublico, permisos, validarClave } from './sesiones.js';
import { enviarCorreo, plantillaVerificacionRegistro } from './correo.js';

const MIN_ENLACE      = 60 * 24;  // el enlace de confirmacion dura un dia
const MAX_REENVIOS    = 5;
const MAX_POR_IP_HORA = 5;

function usuarioValido(u) {
    return /^[a-z0-9](?:[a-z0-9._-]{2,29})$/.test(u);
}

/** Propone un usuario a partir del correo, si quien se registra no da uno. */
function usuarioDesdeCorreo(correo) {
    const base = correo.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
    return (base.length >= 3 ? base : 'usuario' + base).slice(0, 26);
}

async function excesoDeRegistros(env, ip_hash) {
    if (!ip_hash) return false;
    const desde = new Date(Date.now() - 3600000).toISOString();
    const fila = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM eventos WHERE tipo = 'registro' AND ip_hash = ? AND creado_en > ?"
    ).bind(ip_hash, desde).first();
    return (fila ? fila.n : 0) >= MAX_POR_IP_HORA;
}

/** Genera el token, lo guarda hasheado y manda el correo. */
async function enviarEnlace(env, fila) {
    const token = generarToken(32);
    await env.DB.prepare(
        'UPDATE afiliados SET token_verificacion = ?, token_expira = ?, actualizado_en = ? WHERE id = ?'
    ).bind(await sha256(token), enFuturo(MIN_ENLACE), ahora(), fila.id).run();

    const base = String(env.API_URL || '').replace(/\/+$/, '');
    const enlace = base + '/api/registro/verificar?t=' + encodeURIComponent(token);
    const plantilla = plantillaVerificacionRegistro(enlace, fila.nombre);

    return enviarCorreo(env, {
        para: fila.correo,
        asunto: plantilla.asunto,
        html: plantilla.html,
        textoPlano: plantilla.textoPlano
    });
}

// ── 1. Alta ─────────────────────────────────────────────────────────

export async function registrar(env, request, datos) {
    if (String(env.REGISTRO_ACTIVO || 'si').toLowerCase() === 'no') {
        return { estado: 503, cuerpo: { ok: false, error: 'El registro de usuarios no esta disponible por ahora.' } };
    }

    const nombre  = texto(datos.nombre, 120);
    const correo  = texto(datos.correo, 254).toLowerCase();
    const clave   = typeof datos.clave === 'string' ? datos.clave : '';
    let   usuario = texto(datos.usuario, 30).toLowerCase();

    if (nombre.length < 3)     return malo('Escriba su nombre completo.');
    if (!correoValido(correo)) return malo('El correo no tiene un formato valido.');

    if (!usuario) usuario = usuarioDesdeCorreo(correo);
    if (!usuarioValido(usuario)) {
        return malo('El usuario debe tener entre 3 y 30 caracteres: minusculas, numeros, punto, guion o guion bajo.');
    }

    const motivo = validarClave(clave, { usuario, correo });
    if (motivo) return malo(motivo);

    const ip_hash = await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA);
    if (await excesoDeRegistros(env, ip_hash)) {
        return { estado: 429, cuerpo: { ok: false, error: 'Demasiados registros desde esta conexion. Intente mas tarde.' } };
    }

    const choque = await env.DB.prepare(
        'SELECT usuario, correo, correo_verificado FROM afiliados WHERE usuario = ? OR correo = ? LIMIT 1'
    ).bind(usuario, correo).first();

    if (choque) {
        if (choque.usuario === usuario && choque.correo !== correo) {
            return malo('Ese nombre de usuario ya esta tomado. Elija otro.', 409);
        }
        // El correo ya existe. No se confirma ni se desmiente que la cuenta
        // exista: se responde igual que en un alta correcta, para no dejar
        // que nadie averigue quien esta registrado probando direcciones.
        if (!choque.correo_verificado) {
            const fila = await env.DB.prepare('SELECT * FROM afiliados WHERE correo = ?').bind(correo).first();
            if (fila.reenvios_verificacion < MAX_REENVIOS) {
                await env.DB.prepare(
                    'UPDATE afiliados SET reenvios_verificacion = reenvios_verificacion + 1 WHERE id = ?'
                ).bind(fila.id).run();
                await enviarEnlace(env, fila);
            }
        }
        await registrarEvento(env, {
            tipo: 'registro', usuario: correo, detalle: 'correo ya existente', ip_hash: ip_hash
        });
        return respuestaAlta();
    }

    const id = generarId('usr');
    const t = ahora();
    await env.DB.prepare(
        'INSERT INTO afiliados (id, usuario, correo, nombre, nucleo, rol, origen, estado, hash_clave, ' +
        ' requiere_cambio_clave, correo_verificado, creado_en, actualizado_en) ' +
        "VALUES (?, ?, ?, ?, 'Chimborazo', 'usuario', 'registro', 'activo', ?, 0, 0, ?, ?)"
    ).bind(id, usuario, correo, nombre, await hashearClave(clave, iteraciones(env)), t, t).run();

    const fila = await env.DB.prepare('SELECT * FROM afiliados WHERE id = ?').bind(id).first();
    const envio = await enviarEnlace(env, fila);

    await registrarEvento(env, {
        tipo: 'registro', afiliado_id: id, usuario: usuario,
        detalle: envio.enviado ? 'enlace enviado via ' + envio.proveedor : 'FALLO ENVIO: ' + envio.detalle,
        ip_hash: ip_hash
    });

    if (!envio.enviado) {
        // La cuenta queda creada pero sin poder confirmarse. Se dice la
        // verdad en vez de fingir que el correo salio.
        return {
            estado: 502,
            cuerpo: {
                ok: false,
                error: 'Su cuenta se creo, pero no pudimos enviarle el correo de confirmacion. '
                     + 'Escriba a la sede del CAE-CH para activarla.'
            }
        };
    }

    return respuestaAlta();
}

function respuestaAlta() {
    return {
        estado: 201,
        cuerpo: {
            ok: true,
            mensaje: 'Le enviamos un enlace para confirmar su correo. Revise su bandeja de entrada '
                   + 'y la carpeta de correo no deseado; el enlace dura 24 horas.'
        }
    };
}

// ── 2. Confirmacion ─────────────────────────────────────────────────

/** Devuelve una redireccion al sitio; no pasa por el helper JSON. */
export async function verificarCorreo(env, request, url) {
    const token = url.searchParams.get('t') || '';
    const sitio = String(env.SITIO_URL || '').replace(/\/+$/, '');
    const volver = clave => Response.redirect(sitio + '/index.html?cuenta=' + clave, 302);

    if (!token) return volver('enlace_invalido');

    const fila = await env.DB.prepare(
        'SELECT * FROM afiliados WHERE token_verificacion = ? LIMIT 1'
    ).bind(await sha256(token)).first();

    if (!fila) return volver('enlace_invalido');
    if (fila.correo_verificado) return volver('ya_verificada');
    if (vencido(fila.token_expira)) return volver('enlace_caducado');

    await env.DB.prepare(
        'UPDATE afiliados SET correo_verificado = 1, verificado_en = ?, ' +
        ' token_verificacion = NULL, token_expira = NULL, actualizado_en = ? WHERE id = ?'
    ).bind(ahora(), ahora(), fila.id).run();

    await registrarEvento(env, {
        tipo: 'registro_verificado', afiliado_id: fila.id, usuario: fila.usuario,
        ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
    });

    return volver('verificada');
}

// ── 3. Reenvio ──────────────────────────────────────────────────────

export async function reenviarVerificacion(env, request, datos) {
    const correo = texto(datos.correo, 254).toLowerCase();
    // Respuesta identica exista o no la cuenta: no se filtra el padron.
    const generica = {
        estado: 200,
        cuerpo: { ok: true, mensaje: 'Si esa direccion tiene una cuenta sin confirmar, le enviamos un enlace nuevo.' }
    };
    if (!correoValido(correo)) return generica;

    const ip_hash = await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA);
    const fila = await env.DB.prepare('SELECT * FROM afiliados WHERE correo = ? LIMIT 1').bind(correo).first();

    if (fila && !fila.correo_verificado && fila.estado === 'activo'
        && fila.reenvios_verificacion < MAX_REENVIOS) {
        await env.DB.prepare(
            'UPDATE afiliados SET reenvios_verificacion = reenvios_verificacion + 1 WHERE id = ?'
        ).bind(fila.id).run();
        const envio = await enviarEnlace(env, fila);
        await registrarEvento(env, {
            tipo: 'registro_reenvio', afiliado_id: fila.id, usuario: fila.usuario,
            detalle: envio.enviado ? 'ok' : 'FALLO ENVIO: ' + envio.detalle, ip_hash: ip_hash
        });
    }

    return generica;
}

/** Estado de la cuenta recien creada, para que el visor sepa que mostrar. */
export function resumen(fila) {
    return { afiliado: perfilPublico(fila), permisos: permisos(fila) };
}

function malo(mensaje, estado) {
    return { estado: estado || 400, cuerpo: { ok: false, error: mensaje } };
}
