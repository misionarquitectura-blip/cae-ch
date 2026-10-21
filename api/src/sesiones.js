// ════════════════════════════════════════════════════════════════════
//  Autenticacion de afiliados.
//
//  El token de sesion viaja en `Authorization: Bearer <token>`, no en
//  cookie, y el sitio lo guarda en localStorage. Lo que lo resguarda de un
//  script ajeno es la CSP de cada pagina y la integridad SRI de las
//  librerias de CDN (ver README, "Decisiones de seguridad").
// ════════════════════════════════════════════════════════════════════

import { generarToken, sha256, hashearClave, verificarClave, requiereRehash, hashIP } from './cripto.js';
import { ahora, vencido, texto } from './http.js';

// Freno de fuerza bruta, en tres niveles. Los dos primeros cuentan filas
// de la bitacora en una ventana de BLOQUEO_MIN y frenan solo a la conexion
// que falla: quien adivina claves desde un equipo no bloquea al titular,
// que entra desde otro. El tercero bloquea la cuenta entera y es la
// defensa contra un ataque repartido entre muchas conexiones; por eso su
// umbral es alto. Los tres responden el mismo 429, y para un usuario
// inexistente se imita el tercero con la bitacora: el 429 no delata que
// cuentas existen.
const MAX_FALLOS_IP         = 30;   // por conexion, contra cualquier usuario (una oficina comparte IP)
const MAX_FALLOS_USUARIO_IP = 5;    // por conexion, contra un mismo usuario
const MAX_INTENTOS          = 20;   // por cuenta, desde cualquier conexion
const BLOQUEO_MIN           = 15;
const HORAS_SESION    = 8;
const CLAVE_MIN_LARGO = 12;

/**
 * Version vigente de los Terminos y la Politica de Privacidad: la fecha de
 * vigencia que encabeza legal.html. Al cambiar esos textos se sube aqui y
 * cada cuenta vuelve a aceptarlos en su siguiente ingreso.
 */
export const VERSION_TERMINOS = '2026-10-05';

/** true si la cuenta no acepto todavia la version vigente. */
export function terminosPendientes(fila) {
    return fila.terminos_version !== VERSION_TERMINOS;
}

/**
 * Herramientas aparte de las descargas. Anadir una aqui es lo unico que
 * hace falta: `permisos()` la resuelve sola y, si no esta en
 * HERRAMIENTAS_ABIERTAS, el panel dibuja una casilla para concederla
 * cuenta por cuenta.
 */
export const HERRAMIENTAS = ['planimetria'];

/**
 * Herramientas que toda cuenta habilitada abre sin concesion. La
 * planimetria lo es desde el 2026-10-02 (convenio): gratis para cualquier
 * cuenta, pero la puerta exige antes la declaracion del equipo.
 */
export const HERRAMIENTAS_ABIERTAS = ['planimetria'];

/** Lista de herramientas concedidas a una cuenta (la columna es CSV). */
export function herramientasDe(fila) {
    return String((fila && fila.herramientas) || '')
        .split(',').map(s => s.trim()).filter(h => HERRAMIENTAS.includes(h));
}

export function iteraciones(env) {
    return parseInt(env.HASH_ITERACIONES, 10) || 210000;
}

/**
 * Secreto con que se sazonan las claves antes de PBKDF2 (ver cripto.js).
 * Sin el secreto cargado todo sigue como antes, en el formato historico.
 * OJO: cargado una vez, perderlo o cambiarlo invalida todas las claves
 * rehechas con el; la administracion tendria que restablecerlas una a una.
 */
export function pimientaClaves(env) {
    return String(env.PIMIENTA_CLAVES || '').trim() || null;
}

/** Hash de una clave nueva con la configuracion vigente. */
export function hashear(env, clave) {
    return hashearClave(clave, iteraciones(env), pimientaClaves(env));
}

/** Verifica una clave contra el hash guardado, sea del formato que sea. */
export function verificar(env, clave, almacenado) {
    return verificarClave(clave, almacenado, pimientaClaves(env));
}

// Hash de mentira para el usuario inexistente. Se calcula una vez por
// instancia: si se hasheara en cada intento, ese camino costaria dos
// derivaciones y el real una, y la diferencia de tiempo delataria la cuenta.
let SENUELO = null;
async function senuelo(env) {
    if (!SENUELO) SENUELO = await hashear(env, 'senuelo-' + generarToken(8));
    return SENUELO;
}

const DEMASIADOS = {
    estado: 429,
    cuerpo: { ok: false, error: 'Demasiados intentos fallidos. Espere unos minutos antes de reintentar.' }
};

async function fallosRecientes(env, { ip_hash, usuario }) {
    const desde = new Date(Date.now() - BLOQUEO_MIN * 60000).toISOString();
    let sql = "SELECT COUNT(*) AS n FROM eventos WHERE tipo = 'ingreso_fallido' AND creado_en > ?";
    const args = [desde];
    if (ip_hash) { sql += ' AND ip_hash = ?'; args.push(ip_hash); }
    if (usuario) { sql += ' AND usuario = ?'; args.push(usuario); }
    const fila = await env.DB.prepare(sql).bind(...args).first();
    return fila ? fila.n : 0;
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
        nucleo: fila.nucleo,
        registro_profesional: fila.registro_profesional,
        registro_pendiente: fila.registro_pendiente || null,
        registro_validado: !!fila.registro_validado,
        herramientas: herramientasDe(fila),
        vigencia_hasta: fila.vigencia_hasta,
        requiere_cambio_clave: !!fila.requiere_cambio_clave,
        terminos_version: fila.terminos_version || null,
        terminos_pendientes: terminosPendientes(fila),
        ultimo_acceso: fila.ultimo_acceso
    };
}

/**
 * Que puede hacer esta cuenta, aqui y ahora.
 *
 * El GeoVisor NO figura aqui: desde 2026-09-04 el mapa es publico y se
 * abre sin cuenta. `visor` se conserva por compatibilidad con clientes
 * viejos y vale lo mismo que `base`.
 *
 * Los tres productos -DICAT en PDF, CSV y DXF- se piden por PREDIO desde el
 * 2026-10-02. `pdf`, `dxf` y `csv` dicen si la cuenta puede pedirlos; si un
 * predio concreto sale gratis o hay que pagarlo lo decide la puerta de
 * descargas (cobros.js) segun `cobro`:
 *   libre : el administrador
 *   cupo  : colegiado (afiliado, o usuario con el registro cotejado);
 *           unos predios al mes sin pagar y, pasado el cupo, paga
 *   pago  : cuenta publica, o colegiado con el numero aun por cotejar
 */
export function permisos(fila) {
    const base = fila.estado === 'activo'
        && !fila.requiere_cambio_clave
        && !!fila.correo_verificado
        && (!fila.vigencia_hasta || !vencido(fila.vigencia_hasta));
    const colegiado = base
        && (fila.rol === 'afiliado' || fila.rol === 'admin' || !!fila.registro_validado);

    const p = {
        visor: base,
        pdf: base,
        dxf: base,
        csv: base,
        colegiado: colegiado,
        cobro: !base ? null : fila.rol === 'admin' ? 'libre' : colegiado ? 'cupo' : 'pago'
    };

    // Las abiertas, para toda cuenta habilitada. Las demas exigen ser
    // colegiado y una concesion expresa. El administrador las tiene todas
    // por su rol: es quien las reparte.
    const concedidas = herramientasDe(fila);
    for (const h of HERRAMIENTAS) {
        p[h] = HERRAMIENTAS_ABIERTAS.includes(h)
            ? base
            : colegiado && (fila.rol === 'admin' || concedidas.includes(h));
    }
    return p;
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

    // Niveles 1 y 2: esta conexion ya fallo demasiado. Se mira antes de
    // buscar la cuenta, asi que no dice nada de ella.
    if (ip_hash && (await fallosRecientes(env, { ip_hash }) >= MAX_FALLOS_IP
                 || await fallosRecientes(env, { ip_hash, usuario: login }) >= MAX_FALLOS_USUARIO_IP)) {
        await registrarEvento(env, { tipo: 'ingreso_frenado', usuario: login, detalle: 'conexion', ip_hash });
        return DEMASIADOS;
    }

    const fila = await env.DB.prepare(
        'SELECT * FROM afiliados WHERE usuario = ? OR correo = ? LIMIT 1'
    ).bind(login, login).first();

    if (!fila) {
        // Nivel 3 imitado: una cuenta real se bloquea a los MAX_INTENTOS
        // fallos; un usuario inexistente responde igual a los mismos fallos.
        if (await fallosRecientes(env, { usuario: login }) >= MAX_INTENTOS) {
            await registrarEvento(env, { tipo: 'ingreso_bloqueado', usuario: login, ip_hash });
            return DEMASIADOS;
        }
        await registrarEvento(env, { tipo: 'ingreso_fallido', usuario: login, detalle: 'usuario inexistente', ip_hash });
        // Se gasta el mismo tiempo que en una verificacion real para no
        // delatar por temporizacion que la cuenta no existe.
        await verificar(env, clave, await senuelo(env));
        return generico;
    }

    if (fila.bloqueado_hasta && !vencido(fila.bloqueado_hasta)) {
        await registrarEvento(env, { tipo: 'ingreso_bloqueado', afiliado_id: fila.id, usuario: login, ip_hash });
        return DEMASIADOS;
    }

    if (!await verificar(env, clave, fila.hash_clave)) {
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

    // El estado y la confirmacion se comprueban DESPUES de validar la
    // clave: de lo contrario cualquiera podria averiguar que direcciones
    // estan registradas, o cuales estan suspendidas.
    if (fila.estado !== 'activo') {
        await registrarEvento(env, { tipo: 'ingreso_rechazado', afiliado_id: fila.id, usuario: login, detalle: fila.estado, ip_hash });
        return {
            estado: 403,
            cuerpo: { ok: false, error: 'Su cuenta no esta activa. Comuniquese con la sede del CAE-CH.' }
        };
    }

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
    if (requiereRehash(fila.hash_clave, iteraciones(env), pimientaClaves(env))) {
        const nuevo = await hashear(env, clave);
        await env.DB.prepare('UPDATE afiliados SET hash_clave = ? WHERE id = ?').bind(nuevo, fila.id).run();
    }

    return abrirSesion(env, request, fila, ip_hash);
}

/**
 * Emite el token de una cuenta ya autenticada y deja constancia. La usan
 * el ingreso y la confirmacion del correo, que tambien comprueba la clave.
 */
export async function abrirSesion(env, request, fila, ip_hash) {
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

    if (!await verificar(env, String(clave_actual || ''), fila.hash_clave)) {
        return { estado: 401, cuerpo: { ok: false, error: 'La contrasena actual no es correcta.' } };
    }
    const motivo = validarClave(clave_nueva, fila);
    if (motivo) return { estado: 400, cuerpo: { ok: false, error: motivo } };
    if (clave_nueva === clave_actual) {
        return { estado: 400, cuerpo: { ok: false, error: 'La contrasena nueva debe ser distinta de la actual.' } };
    }

    const hash = await hashear(env, clave_nueva);
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

// ── Aceptacion de Terminos y Politica de Privacidad ────────────────

/**
 * Deja constancia de que la cuenta acepto la version vigente. Lo usan las
 * cuentas que la administracion da de alta y las que existian antes de
 * que el registro pidiera la aceptacion; el alta publica ya la trae.
 * No condiciona permisos: sirve para PROBAR el consentimiento, no para
 * cortar herramientas que la cuenta ya tenia.
 */
export async function aceptarTerminos(env, request, sesion, { acepta_terminos }) {
    const fila = sesion.afiliado;
    if (acepta_terminos !== true) {
        return { estado: 400, cuerpo: { ok: false, error: 'Debe aceptar los Terminos y la Politica de Privacidad.' } };
    }
    const t = ahora();
    if (terminosPendientes(fila)) {
        await env.DB.prepare(
            'UPDATE afiliados SET terminos_version = ?, terminos_aceptados_en = ?, actualizado_en = ? WHERE id = ?'
        ).bind(VERSION_TERMINOS, t, t, fila.id).run();
        await registrarEvento(env, {
            tipo: 'terminos_aceptados', afiliado_id: fila.id, usuario: fila.usuario,
            detalle: 'version ' + VERSION_TERMINOS,
            ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
        });
    }
    const actualizado = Object.assign({}, fila, { terminos_version: VERSION_TERMINOS, terminos_aceptados_en: t });
    return {
        estado: 200,
        cuerpo: { ok: true, afiliado: perfilPublico(actualizado), permisos: permisos(actualizado) }
    };
}
