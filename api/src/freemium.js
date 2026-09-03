// ════════════════════════════════════════════════════════════════════
//  Freemium de lanzamiento: UN (1) DICAT en PDF por correo verificado.
//
//  Flujo:
//    1. POST /api/freemium/solicitar  {correo}
//       Crea el pase y envia un enlace de verificacion.
//    2. GET  /api/freemium/verificar?t=<token>
//       Marca el correo como verificado, ROTA el token (el de la bandeja
//       queda muerto) y redirige al visor con el pase nuevo.
//    3. POST /api/freemium/consumir   {pase, clave_catastral}
//       Gasta el pase y deja constancia en la bitacora de descargas.
//
//  El UNIQUE sobre `correo` en pases_freemium es lo que hace cumplir el
//  "una unica vez": un correo ya consumido no puede volver a solicitar.
// ════════════════════════════════════════════════════════════════════

import { generarId, generarToken, sha256, hashIP } from './cripto.js';
import { ahora, vencido, texto, correoValido, enFuturo } from './http.js';
import { registrarEvento } from './sesiones.js';
import { enviarCorreo, plantillaPaseFreemium } from './correo.js';

const MIN_ENLACE      = 60;   // caducidad del enlace de verificacion
const MIN_PASE        = 120;  // ventana para gastar el pase ya verificado
const MAX_REENVIOS    = 3;
const MAX_POR_IP_HORA = 5;

/** Normaliza el correo para que el UNIQUE sea efectivo. */
function normalizar(correo) {
    return texto(correo, 254).toLowerCase();
}

async function excesoDeSolicitudes(env, ip_hash) {
    if (!ip_hash) return false;
    const desde = new Date(Date.now() - 3600000).toISOString();
    const fila = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM eventos WHERE tipo = 'freemium_solicitud' AND ip_hash = ? AND creado_en > ?"
    ).bind(ip_hash, desde).first();
    return (fila ? fila.n : 0) >= MAX_POR_IP_HORA;
}

// ── 1. Solicitud ────────────────────────────────────────────────────

export async function solicitarPase(env, request, datos) {
    if (String(env.FREEMIUM_ACTIVO || 'si').toLowerCase() === 'no') {
        return { estado: 503, cuerpo: { ok: false, error: 'La promocion de lanzamiento no esta activa.' } };
    }

    const correo = normalizar(datos.correo);
    if (!correoValido(correo)) {
        return { estado: 400, cuerpo: { ok: false, error: 'Escriba un correo electronico valido.' } };
    }

    const ip_hash = await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA);
    if (await excesoDeSolicitudes(env, ip_hash)) {
        return { estado: 429, cuerpo: { ok: false, error: 'Demasiadas solicitudes desde esta conexion. Intente mas tarde.' } };
    }

    const previo = await env.DB.prepare('SELECT * FROM pases_freemium WHERE correo = ?').bind(correo).first();

    if (previo && previo.consumido_en) {
        return {
            estado: 409,
            cuerpo: {
                ok: false,
                error: 'Este correo ya uso su reporte de cortesia. Para acceso continuo, afiliese en la sede del CAE-CH.',
                consumido_en: previo.consumido_en
            }
        };
    }
    if (previo && previo.reenvios >= MAX_REENVIOS) {
        return { estado: 429, cuerpo: { ok: false, error: 'Se alcanzo el limite de reenvios para este correo. Escriba a la sede del CAE-CH.' } };
    }

    const token = generarToken(32);
    const token_hash = await sha256(token);
    const expira = enFuturo(MIN_ENLACE);
    const id = previo ? previo.id : generarId('pas');

    if (previo) {
        await env.DB.prepare(
            'UPDATE pases_freemium SET token_hash = ?, expira_en = ?, reenvios = reenvios + 1, ip_hash = ? WHERE id = ?'
        ).bind(token_hash, expira, ip_hash, id).run();
    } else {
        await env.DB.prepare(
            'INSERT INTO pases_freemium (id, correo, token_hash, creado_en, expira_en, ip_hash) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, correo, token_hash, ahora(), expira, ip_hash).run();
    }

    const base = String(env.API_URL || '').replace(/\/+$/, '');
    const enlace = base + '/api/freemium/verificar?t=' + encodeURIComponent(token);

    const plantilla = plantillaPaseFreemium(enlace, MIN_ENLACE);
    const envio = await enviarCorreo(env, {
        para: correo,
        asunto: plantilla.asunto,
        html: plantilla.html,
        textoPlano: plantilla.textoPlano
    });

    await registrarEvento(env, {
        tipo: 'freemium_solicitud', usuario: correo,
        detalle: envio.enviado ? 'enviado via ' + envio.proveedor : 'FALLO ENVIO: ' + envio.detalle,
        ip_hash: ip_hash
    });

    if (!envio.enviado) {
        return { estado: 502, cuerpo: { ok: false, error: 'No se pudo enviar el correo de verificacion. Intente mas tarde.' } };
    }

    // Respuesta deliberadamente parca: no confirma ni desmiente si el
    // correo ya existia en la base.
    return {
        estado: 200,
        cuerpo: { ok: true, mensaje: 'Le enviamos un enlace de verificacion. Revise su bandeja de entrada y la carpeta de correo no deseado.' }
    };
}

// ── 2. Verificacion (enlace del correo) ─────────────────────────────

/** Devuelve una Response de redireccion; no pasa por el helper JSON. */
export async function verificarPase(env, request, url) {
    const token = url.searchParams.get('t') || '';
    const sitio = String(env.SITIO_URL || '').replace(/\/+$/, '');
    const fallar = motivo => Response.redirect(sitio + '/geovisor.html?pase_error=' + motivo, 302);

    if (!token) return fallar('token_ausente');

    const fila = await env.DB.prepare('SELECT * FROM pases_freemium WHERE token_hash = ? LIMIT 1')
        .bind(await sha256(token)).first();

    if (!fila) return fallar('enlace_invalido');
    if (fila.consumido_en) return fallar('ya_utilizado');
    if (vencido(fila.expira_en)) return fallar('enlace_caducado');

    // Se rota el token: el que quedo en la bandeja de correo deja de servir.
    const pase = generarToken(32);
    await env.DB.prepare(
        'UPDATE pases_freemium SET token_hash = ?, verificado_en = COALESCE(verificado_en, ?), expira_en = ? WHERE id = ?'
    ).bind(await sha256(pase), ahora(), enFuturo(MIN_PASE), fila.id).run();

    await registrarEvento(env, {
        tipo: 'freemium_verificado', usuario: fila.correo,
        ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
    });

    return Response.redirect(sitio + '/geovisor.html?pase=' + encodeURIComponent(pase), 302);
}

// ── 3. Consumo ──────────────────────────────────────────────────────

export async function consumirPase(env, request, datos) {
    const pase = texto(datos.pase, 200);
    if (!pase) return { estado: 400, cuerpo: { ok: false, error: 'Falta el pase.' } };

    const token_hash = await sha256(pase);
    const fila = await env.DB.prepare('SELECT * FROM pases_freemium WHERE token_hash = ? LIMIT 1')
        .bind(token_hash).first();

    if (!fila || !fila.verificado_en) {
        return { estado: 401, cuerpo: { ok: false, error: 'Pase no valido. Solicite uno nuevo.' } };
    }
    if (fila.consumido_en) {
        return { estado: 409, cuerpo: { ok: false, error: 'Este pase ya fue utilizado.' } };
    }
    if (vencido(fila.expira_en)) {
        return { estado: 410, cuerpo: { ok: false, error: 'El pase caduco. Solicite uno nuevo.' } };
    }

    const clave = texto(datos.clave_catastral, 60) || null;
    const ip_hash = await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA);

    // La condicion `consumido_en IS NULL` cierra la carrera de dos
    // pestanas pulsando "descargar" a la vez.
    const r = await env.DB.prepare(
        'UPDATE pases_freemium SET consumido_en = ?, clave_catastral = ? WHERE id = ? AND consumido_en IS NULL'
    ).bind(ahora(), clave, fila.id).run();

    if (!r.meta || r.meta.changes === 0) {
        return { estado: 409, cuerpo: { ok: false, error: 'Este pase ya fue utilizado.' } };
    }

    await env.DB.prepare(
        "INSERT INTO descargas (creado_en, formato, origen, pase_id, clave_catastral, ip_hash) VALUES (?, 'pdf', 'freemium', ?, ?, ?)"
    ).bind(ahora(), fila.id, clave, ip_hash).run();

    await registrarEvento(env, { tipo: 'freemium_consumido', usuario: fila.correo, detalle: clave, ip_hash: ip_hash });

    return { estado: 200, cuerpo: { ok: true, formato: 'pdf', mensaje: 'Reporte de cortesia autorizado.' } };
}

/** Estado de un pase, para que el visor sepa si aun sirve. */
export async function estadoPase(env, pase) {
    if (!pase) return { valido: false };
    const fila = await env.DB.prepare(
        'SELECT correo, verificado_en, consumido_en, expira_en FROM pases_freemium WHERE token_hash = ? LIMIT 1'
    ).bind(await sha256(pase)).first();
    if (!fila) return { valido: false };
    return {
        valido: !!fila.verificado_en && !fila.consumido_en && !vencido(fila.expira_en),
        verificado: !!fila.verificado_en,
        consumido: !!fila.consumido_en,
        expira_en: fila.expira_en
    };
}
