// ════════════════════════════════════════════════════════════════════
//  Autenticacion de afiliados.
//
//  El token de sesion viaja en `Authorization: Bearer <token>`, no en
//  cookie. Motivo: el sitio vive en GitHub Pages y el API en workers.dev,
//  o sea dominios distintos; una cookie ahi es de terceros y Safari y
//  Chrome la bloquean. Cuando el API pase a api.cae-ch.org conviene
//  migrar a cookie HttpOnly + SameSite=Lax (ver README).
// ════════════════════════════════════════════════════════════════════

import { generarToken, sha256, hashearClave, verificarClave, requiereRehash, hashIP } from './cripto.js';
import { ahora, vencido, texto } from './http.js';

const MAX_INTENTOS    = 5;
const BLOQUEO_MIN     = 15;
const HORAS_SESION    = 8;
const CLAVE_MIN_LARGO = 12;

export function iteraciones(env) {
    return parseInt(env.HASH_ITERACIONES, 10) || 210000;
}

export async function registrarEvento(env, { tipo, afiliado_id, usuario, detalle, ip_hash }) {
    try {
        await env.DB.prepare(
            'INSERT INTO eventos (creado_en, tipo, afiliado_id, usuario, detalle, ip_hash) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(ahora(), tipo, afiliado_id || null, usuario || null, detalle || null, ip_hash || null).run();
    } catch (e) {
        console.error('No se pudo registrar el evento', tipo, e);
    }
}

/** Vista publica de un afiliado: nunca incluye el hash de la clave. */
export function perfilPublico(fila) {
    return {
        id: fila.id,
        usuario: fila.usuario,
        nombre: fila.nombre,
        correo: fila.correo,
        rol: fila.rol,
        origen: fila.origen,
        estado: fila.estado,
        correo_verificado: !!fila.correo_verificado,
        pdf_cortesia_usado: !!fila.pdf_cortesia_en,
        nucleo: fila.nucleo,
        registro_profesional: fila.registro_profesional,
        vigencia_hasta: fila.vigencia_hasta,
        requiere_cambio_clave: !!fila.requiere_cambio_clave,
        ultimo_acceso: fila.ultimo_acceso
    };
}

/**
 * Que puede hacer esta cuenta, aqui y ahora.
 *   visor : abrir el GeoVisor y consultar el mapa
 *   pdf   : generar el DICAT. Los colegiados, sin limite; quien se
 *           registro por su cuenta, una unica vez (reporte de cortesia)
 *   dxf/csv : exportaciones, exclusivas de afiliados y administracion
 */
export function permisos(fila) {
    const base = fila.estado === 'activo'
        && !fila.requiere_cambio_clave
        && !!fila.correo_verificado
        && (!fila.vigencia_hasta || !vencido(fila.vigencia_hasta));
    const colegiado = base && (fila.rol === 'afiliado' || fila.rol === 'admin');
    return {
        visor: base,
        pdf: colegiado || (base && !fila.pdf_cortesia_en),
        dxf: colegiado,
        csv: colegiado
    };
}

/** Politica de contrasena. Devuelve null si es aceptable, o el motivo. */
export function validarClave(clave, perfil) {
    if (typeof clave !== 'string' || clave.length < CLAVE_MIN_LARGO) {
        return 'La contrasena debe tener al menos ' + CLAVE_MIN_LARGO + ' caracteres.';
    }
    if (clave.length > 200) return 'La contrasena es demasiado larga.';
    const clases = [/[a-z]/, /[A-Z]/, /[0-9]/].filter(r => r.test(clave)).length;
    if (clases < 3) {
        return 'La contrasena debe combinar minusculas, mayusculas y numeros.';
    }
    const bajo = clave.toLowerCase();
    const propios = [perfil && perfil.usuario, perfil && perfil.correo ? perfil.correo.split('@')[0] : null];
    for (const dato of propios) {
        if (dato && dato.length >= 4 && bajo.includes(String(dato).toLowerCase())) {
            return 'La contrasena no puede contener su usuario ni su correo.';
        }
    }
    return null;
}

// ── Ingreso ─────────────────────────────────────────────────────────

/**
 * @returns {{estado:number, cuerpo:object}} respuesta lista para serializar.
 * Los mensajes de fallo son deliberadamente identicos para usuario
 * inexistente y clave incorrecta: no se filtra que cuentas existen.
 */
export async function iniciarSesion(env, request, { usuario, clave }) {
    const login = texto(usuario, 120).toLowerCase();
    const ip_hash = await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA);
    const generico = { estado: 401, cuerpo: { ok: false, error: 'Usuario o contrasena incorrectos.' } };

    if (!login || typeof clave !== 'string' || !clave) return generico;

    const fila = await env.DB.prepare(
        'SELECT * FROM afiliados WHERE usuario = ? OR correo = ? LIMIT 1'
    ).bind(login, login).first();

    if (!fila) {
        await registrarEvento(env, { tipo: 'ingreso_fallido', usuario: login, detalle: 'usuario inexistente', ip_hash });
        // Se gasta el mismo tiempo que en una verificacion real para no
        // delatar por temporizacion que la cuenta no existe.
        await verificarClave(clave, await hashearClave('senuelo', iteraciones(env)));
        return generico;
    }

    if (fila.bloqueado_hasta && !vencido(fila.bloqueado_hasta)) {
        await registrarEvento(env, { tipo: 'ingreso_bloqueado', afiliado_id: fila.id, usuario: login, ip_hash });
        return {
            estado: 429,
            cuerpo: { ok: false, error: 'Cuenta bloqueada temporalmente por intentos fallidos. Reintente en unos minutos.' }
        };
    }

    if (fila.estado !== 'activo') {
        await registrarEvento(env, { tipo: 'ingreso_rechazado', afiliado_id: fila.id, usuario: login, detalle: fila.estado, ip_hash });
        return {
            estado: 403,
            cuerpo: { ok: false, error: 'Su cuenta no esta activa. Comuniquese con la sede del CAE-CH.' }
        };
    }

    if (!await verificarClave(clave, fila.hash_clave)) {
        const intentos = (fila.intentos_fallidos || 0) + 1;
        const bloqueo = intentos >= MAX_INTENTOS
            ? new Date(Date.now() + BLOQUEO_MIN * 60000).toISOString()
            : null;
        await env.DB.prepare(
            'UPDATE afiliados SET intentos_fallidos = ?, bloqueado_hasta = ?, actualizado_en = ? WHERE id = ?'
        ).bind(bloqueo ? 0 : intentos, bloqueo, ahora(), fila.id).run();
        await registrarEvento(env, {
            tipo: 'ingreso_fallido', afiliado_id: fila.id, usuario: login,
            detalle: 'intento ' + intentos + (bloqueo ? ' - cuenta bloqueada' : ''), ip_hash
        });
        return generico;
    }

    // Se comprueba DESPUES de validar la clave: de lo contrario cualquiera
    // podria averiguar que direcciones estan registradas.
    if (!fila.correo_verificado) {
        await registrarEvento(env, { tipo: 'ingreso_sin_verificar', afiliado_id: fila.id, usuario: login, ip_hash });
        return {
            estado: 403,
            cuerpo: {
                ok: false,
                error: 'Confirme su correo electronico antes de ingresar. Le enviamos un enlace al registrarse.',
                correo_sin_verificar: true
            }
        };
    }

    if (fila.vigencia_hasta && vencido(fila.vigencia_hasta)) {
        await registrarEvento(env, { tipo: 'ingreso_rechazado', afiliado_id: fila.id, usuario: login, detalle: 'vigencia caducada', ip_hash });
        return {
            estado: 403,
            cuerpo: { ok: false, error: 'Su afiliacion vencio. Renuevela en la sede del CAE-CH para recuperar el acceso.' }
        };
    }

    // Credenciales correctas: se rehashea si el coste vigente subio.
    if (requiereRehash(fila.hash_clave, iteraciones(env))) {
        const nuevo = await hashearClave(clave, iteraciones(env));
        await env.DB.prepare('UPDATE afiliados SET hash_clave = ? WHERE id = ?').bind(nuevo, fila.id).run();
    }

    const token = generarToken(32);
    const expira = new Date(Date.now() + HORAS_SESION * 3600000).toISOString();
    await env.DB.prepare(
        'INSERT INTO sesiones (token_hash, afiliado_id, creada_en, expira_en, ultimo_uso, ip_hash, agente) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(
        await sha256(token), fila.id, ahora(), expira, ahora(), ip_hash,
        texto(request.headers.get('User-Agent'), 180)
    ).run();

    await env.DB.prepare(
        'UPDATE afiliados SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_acceso = ? WHERE id = ?'
    ).bind(ahora(), fila.id).run();

    await registrarEvento(env, { tipo: 'ingreso', afiliado_id: fila.id, usuario: fila.usuario, ip_hash });

    return {
        estado: 200,
        cuerpo: {
            ok: true,
            token: token,
            expira_en: expira,
            afiliado: perfilPublico(fila),
            permisos: permisos(fila)
        }
    };
}

// ── Verificacion de sesion en cada peticion ─────────────────────────

export function tokenDePeticion(request) {
    const cabecera = request.headers.get('Authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(cabecera.trim());
    return m ? m[1].trim() : null;
}

/**
 * @returns {Promise<{afiliado: object, token_hash: string} | null>}
 * Purga la sesion si esta vencida o revocada.
 */
export async function sesionActual(env, request) {
    const token = tokenDePeticion(request);
    if (!token) return null;

    const token_hash = await sha256(token);
    const fila = await env.DB.prepare(
        'SELECT s.expira_en AS s_expira, s.revocada AS s_revocada, a.* ' +
        '  FROM sesiones s JOIN afiliados a ON a.id = s.afiliado_id ' +
        ' WHERE s.token_hash = ? LIMIT 1'
    ).bind(token_hash).first();

    if (!fila || fila.s_revocada) return null;
    if (vencido(fila.s_expira)) {
        await env.DB.prepare('DELETE FROM sesiones WHERE token_hash = ?').bind(token_hash).run();
        return null;
    }
    if (fila.estado !== 'activo') return null;

    await env.DB.prepare('UPDATE sesiones SET ultimo_uso = ? WHERE token_hash = ?')
        .bind(ahora(), token_hash).run();

    return { afiliado: fila, token_hash: token_hash };
}

export async function cerrarSesion(env, request) {
    const token = tokenDePeticion(request);
    if (!token) return;
    await env.DB.prepare('DELETE FROM sesiones WHERE token_hash = ?').bind(await sha256(token)).run();
}

// ── Cambio de clave ─────────────────────────────────────────────────

export async function cambiarClave(env, request, sesion, { clave_actual, clave_nueva }) {
    const fila = sesion.afiliado;

    if (!await verificarClave(String(clave_actual || ''), fila.hash_clave)) {
        return { estado: 401, cuerpo: { ok: false, error: 'La contrasena actual no es correcta.' } };
    }
    const motivo = validarClave(clave_nueva, fila);
    if (motivo) return { estado: 400, cuerpo: { ok: false, error: motivo } };
    if (clave_nueva === clave_actual) {
        return { estado: 400, cuerpo: { ok: false, error: 'La contrasena nueva debe ser distinta de la actual.' } };
    }

    const hash = await hashearClave(clave_nueva, iteraciones(env));
    await env.DB.prepare(
        'UPDATE afiliados SET hash_clave = ?, requiere_cambio_clave = 0, clave_cambiada_en = ?, actualizado_en = ? WHERE id = ?'
    ).bind(hash, ahora(), ahora(), fila.id).run();

    // Se cierran las demas sesiones: si la clave cambio por sospecha de
    // filtracion, las sesiones abiertas en otro equipo deben caer.
    await env.DB.prepare(
        'DELETE FROM sesiones WHERE afiliado_id = ? AND token_hash != ?'
    ).bind(fila.id, sesion.token_hash).run();

    await registrarEvento(env, {
        tipo: 'clave_cambiada', afiliado_id: fila.id, usuario: fila.usuario,
        ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
    });

    const actualizado = Object.assign({}, fila, { requiere_cambio_clave: 0 });
    return {
        estado: 200,
        cuerpo: { ok: true, afiliado: perfilPublico(actualizado), permisos: permisos(actualizado) }
    };
}
