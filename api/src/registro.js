// ════════════════════════════════════════════════════════════════════
//  Registro publico de usuarios.
//
//  El GeoVisor es publico: el mapa se abre sin cuenta. Lo que exige cuenta
//  son los PRODUCTOS -DICAT en PDF, CSV y DXF- y la planimetria.
//
//  Desde el 2026-10-02 cualquiera puede crear cuenta. El NUMERO DE
//  REGISTRO del CAE es opcional:
//    · sin numero: cuenta publica. Usa la planimetria y paga cada predio.
//    · con numero: se acepta tal como lo escribe y queda pendiente
//      (`registro_validado = 0`). Mientras tanto la cuenta funciona como
//      publica; cuando la administracion lo coteja contra el padron
//      (PATCH /api/admin/afiliados/:id con {registro_validado: true})
//      recibe el cupo mensual de predios del colegiado.
//
//  Flujo:
//    1. POST /api/registro            {nombre, correo, clave, acepta_terminos: true,
//                                      registro_profesional?}
//       Crea la cuenta sin verificar y envia el enlace de confirmacion.
//       Sin la aceptacion expresa de los Terminos y la Politica de
//       Privacidad no hay alta: queda la version aceptada y la fecha.
//    2. GET  /api/registro/verificar?t=<token>
//       Es el enlace del correo. Ya NO confirma nada: lleva al sitio, que
//       pide la contrasena de la cuenta y llama a
//       POST /api/registro/confirmar {t, clave}
//       Solo quien tiene el correo (el token) Y la clave confirma la cuenta,
//       y queda con la sesion abierta. Antes bastaba pulsar el enlace, y
//       quien registraba el correo de otra persona con una clave suya se
//       quedaba con la cuenta en cuanto el titular confirmaba.
//    3. POST /api/registro/reenviar   {correo}
//       Vuelve a enviar el enlace si caduco o no llego.
//
//  Sin el correo verificado NO se puede iniciar sesion: asi lo decidio el
//  CAE-CH. Mientras `MAIL_PROVEEDOR` sea "consola" el enlace solo queda en
//  los logs, de modo que en la practica el registro no puede completarse
//  hasta que el emisor de correo este configurado.
// ════════════════════════════════════════════════════════════════════

import { generarId, generarToken, sha256, hashIP } from './cripto.js';
import { ahora, vencido, texto, correoValido, enFuturo } from './http.js';
import {
    hashear, verificar, abrirSesion, registrarEvento, perfilPublico, permisos, validarClave, VERSION_TERMINOS
} from './sesiones.js';
import { enviarCorreo, plantillaVerificacionRegistro } from './correo.js';

const MIN_ENLACE      = 60 * 24;  // el enlace de confirmacion dura un dia
const MAX_REENVIOS    = 5;
const MAX_POR_IP_HORA = 5;
const MAX_CONFIRMACIONES_FALLIDAS = 5;   // claves erradas con un mismo enlace

function usuarioValido(u) {
    return /^[a-z0-9](?:[a-z0-9._-]{2,29})$/.test(u);
}

/**
 * Numero de registro del colegiado. No se conoce una mascara unica -hay
 * numeros con prefijo de nucleo, con guiones y sin ellos-, asi que solo se
 * exige que traiga digitos y que no venga con basura: entre 3 y 20
 * caracteres de digitos, letras, guion, barra o punto -los espacios ya los
 * quito `normalizarRegistro`-. Quien decide si el numero es real es la
 * administracion al cotejar el padron.
 */
function registroValido(r) {
    return /^[A-Za-z0-9][A-Za-z0-9.\-\/]{2,19}$/.test(r) && /[0-9]/.test(r);
}

/** Forma canonica para comparar: sin espacios y en mayusculas. */
function normalizarRegistro(r) {
    return r.replace(/\s+/g, '').toUpperCase();
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
    // La cuenta no sirve hasta confirmar el correo, y el proveedor 'consola'
    // no envia nada: solo escribe el enlace en los logs. Abrir el alta en
    // ese modo dejaria cuentas muertas y gente esperando un correo que no
    // existe, asi que se falla cerrado y se dice por que.
    //
    // PERMITIR_CORREO_CONSOLA="si" levanta el freno a proposito. Lo usa la
    // suite de pruebas, que necesita justamente leer el enlace del log
    // (`wrangler dev --var PERMITIR_CORREO_CONSOLA:si`). Nunca en produccion.
    if (String(env.MAIL_PROVEEDOR || 'consola').toLowerCase() === 'consola'
        && String(env.PERMITIR_CORREO_CONSOLA || 'no').toLowerCase() !== 'si') {
        return {
            estado: 503,
            cuerpo: {
                ok: false,
                error: 'El alta de cuentas se habilita en cuanto el CAE-CH termine de configurar el envio '
                     + 'de correo. Mientras tanto escriba a caechoficial@gmail.com con su numero de registro. '
                     + 'El mapa del GeoVisor sigue abierto sin cuenta.'
            }
        };
    }

    const nombre  = texto(datos.nombre, 120);
    const correo  = texto(datos.correo, 254).toLowerCase();
    const clave   = typeof datos.clave === 'string' ? datos.clave : '';
    let   usuario = texto(datos.usuario, 30).toLowerCase();
    const registro = normalizarRegistro(texto(datos.registro_profesional, 40));

    if (nombre.length < 3)     return malo('Escriba su nombre completo.');
    if (datos.acepta_terminos !== true) {
        return malo('Para crear la cuenta debe aceptar los Terminos y condiciones y la Politica de privacidad.');
    }
    if (!correoValido(correo)) return malo('El correo no tiene un formato valido.');
    // Vacio = cuenta publica. Si viene, tiene que parecer un numero real.
    if (registro && !registroValido(registro)) {
        return malo('El numero de registro no parece valido. Escribalo tal como consta en su credencial del CAE.');
    }

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

    // Un numero de registro es de un solo colegiado. Aqui SI se dice que ya
    // esta tomado: no es un dato que se pueda sondear a ciegas -hay que
    // conocer el numero- y callarlo dejaria al colegiado sin saber por que
    // su alta no prospera.
    const choqueRegistro = registro && await env.DB.prepare(
        'SELECT id FROM afiliados WHERE registro_profesional = ? AND correo != ? LIMIT 1'
    ).bind(registro, correo).first();
    if (choqueRegistro) {
        return malo('Ese numero de registro ya tiene una cuenta. Si es el suyo, ingrese o escriba a la sede del CAE-CH.', 409);
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
            // Alguien vuelve a registrar un correo que nadie confirmo. Puede
            // ser el titular que no encontro el primer correo... o el titular
            // llegando DESPUES de que otro registrara su direccion. En los dos
            // casos manda el ultimo alta: sus datos y su clave reemplazan a
            // los anteriores y el enlace nuevo invalida al viejo. Como
            // confirmar exige la clave, el enlace que llega al titular solo
            // sirve con la clave que el mismo acaba de escribir.
            const fila = await env.DB.prepare('SELECT * FROM afiliados WHERE correo = ?').bind(correo).first();
            if (fila.reenvios_verificacion < MAX_REENVIOS) {
                await env.DB.prepare(
                    'UPDATE afiliados SET reenvios_verificacion = reenvios_verificacion + 1, nombre = ?, '
                    + 'hash_clave = ?, registro_pendiente = ?, terminos_version = ?, terminos_aceptados_en = ?, '
                    + 'actualizado_en = ? WHERE id = ? AND correo_verificado = 0'
                ).bind(nombre, await hashear(env, clave), registro || null, VERSION_TERMINOS, ahora(), ahora(),
                       fila.id).run();
                await enviarEnlace(env, Object.assign({}, fila, { nombre: nombre }));
            }
        }
        await registrarEvento(env, {
            tipo: 'registro', usuario: correo, detalle: 'correo ya existente', ip_hash: ip_hash
        });
        return respuestaAlta(!!registro);
    }

    // El numero queda en `registro_pendiente` hasta que el correo se
    // confirme: una cuenta sin confirmar no reserva el numero de nadie.
    const id = generarId('usr');
    const t = ahora();
    await env.DB.prepare(
        'INSERT INTO afiliados (id, usuario, correo, nombre, registro_pendiente, registro_validado, ' +
        ' nucleo, rol, origen, estado, hash_clave, requiere_cambio_clave, correo_verificado, ' +
        ' terminos_version, terminos_aceptados_en, creado_en, actualizado_en) ' +
        "VALUES (?, ?, ?, ?, ?, 0, 'Chimborazo', 'usuario', 'registro', 'activo', ?, 0, 0, ?, ?, ?, ?)"
    ).bind(id, usuario, correo, nombre, registro || null,
            await hashear(env, clave), VERSION_TERMINOS, t, t, t).run();

    const fila = await env.DB.prepare('SELECT * FROM afiliados WHERE id = ?').bind(id).first();
    const envio = await enviarEnlace(env, fila);

    await registrarEvento(env, {
        tipo: 'registro', afiliado_id: id, usuario: usuario,
        detalle: (registro ? 'registro CAE ' + registro + ' pendiente de validar' : 'cuenta publica')
               + '; terminos ' + VERSION_TERMINOS + ' aceptados; '
               + (envio.enviado ? 'enlace enviado via ' + envio.proveedor : 'FALLO ENVIO: ' + envio.detalle),
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

    return respuestaAlta(!!registro);
}

function respuestaAlta(colegiado) {
    return {
        estado: 201,
        cuerpo: {
            ok: true,
            mensaje: 'Le enviamos un enlace para confirmar su correo. Revise su bandeja de entrada '
                   + 'y la carpeta de correo no deseado; el enlace dura 24 horas. '
                   + (colegiado
                       ? 'Despues la administracion del CAE-CH cotejara su numero de registro contra el '
                         + 'padron y habilitara su cupo de colegiado; mientras tanto puede usar la cuenta '
                         + 'como cualquier usuario.'
                       : 'Con la cuenta confirmada podra usar la planimetria y habilitar predios para '
                         + 'descargar el DICAT, el CSV y el DXF.')
        }
    };
}

// ── 2. Confirmacion ─────────────────────────────────────────────────

/**
 * El enlace del correo. No confirma: lleva al sitio con el token para que
 * la persona escriba su clave (ver `confirmarCorreo`). Solo descarta aqui
 * los enlaces que no van a servir, para decirlo sin pedir la clave.
 * Devuelve una redireccion; no pasa por el helper JSON.
 */
export async function verificarCorreo(env, request, url) {
    const token = url.searchParams.get('t') || '';
    const sitio = String(env.SITIO_URL || '').replace(/\/+$/, '');
    const volver = clave => Response.redirect(sitio + '/index.html?cuenta=' + clave, 302);

    if (!token) return volver('enlace_invalido');

    const fila = await env.DB.prepare(
        'SELECT correo_verificado, token_expira FROM afiliados WHERE token_verificacion = ? LIMIT 1'
    ).bind(await sha256(token)).first();

    if (!fila) return volver('enlace_invalido');
    if (fila.correo_verificado) return volver('ya_verificada');
    if (vencido(fila.token_expira)) return volver('enlace_caducado');

    // En el fragmento (#) y no en la consulta: el fragmento no viaja al
    // servidor de GitHub Pages ni en el Referer de lo que cargue la pagina.
    return Response.redirect(sitio + '/index.html#confirmar=' + encodeURIComponent(token), 302);
}

/**
 * POST /api/registro/confirmar {t, clave}
 * Confirma el correo si el token es del enlace vigente Y la clave es la de
 * la cuenta. Deja la sesion abierta: quien confirma acaba de demostrar que
 * tiene el correo y la clave, igual que al ingresar.
 */
export async function confirmarCorreo(env, request, datos) {
    const token = texto(datos.t, 200);
    const clave = typeof datos.clave === 'string' ? datos.clave : '';
    const ip_hash = await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA);
    const invalido = { estado: 400, cuerpo: { ok: false, motivo: 'enlace_invalido',
        error: 'El enlace de confirmacion no es valido o ya fue reemplazado por uno mas nuevo.' } };

    if (!token) return invalido;
    const fila = await env.DB.prepare(
        'SELECT * FROM afiliados WHERE token_verificacion = ? LIMIT 1'
    ).bind(await sha256(token)).first();

    if (!fila) return invalido;
    if (fila.correo_verificado) {
        return { estado: 409, cuerpo: { ok: false, motivo: 'ya_verificada',
            error: 'Esta cuenta ya estaba confirmada. Ingrese con su correo y contrasena.' } };
    }
    if (vencido(fila.token_expira)) {
        return { estado: 410, cuerpo: { ok: false, motivo: 'enlace_caducado',
            error: 'El enlace de confirmacion caduco. Ingrese y pida que se lo reenviemos.' } };
    }
    if (fila.estado !== 'activo') {
        return { estado: 403, cuerpo: { ok: false, error: 'Su cuenta no esta activa. Comuniquese con la sede del CAE-CH.' } };
    }

    if (!clave || !await verificar(env, clave, fila.hash_clave)) {
        await registrarEvento(env, { tipo: 'confirmacion_fallida', afiliado_id: fila.id, usuario: fila.usuario, ip_hash });
        // Se cuentan los fallos desde el ultimo cambio de la fila, que es
        // cuando se emitio este enlace (alta o reenvio).
        const cuenta = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM eventos WHERE tipo = 'confirmacion_fallida' AND afiliado_id = ? AND creado_en >= ?"
        ).bind(fila.id, fila.actualizado_en || '').first();
        if (cuenta && cuenta.n >= MAX_CONFIRMACIONES_FALLIDAS) {
            // El enlace deja de servir: hay que pedir otro, que llega al correo.
            await env.DB.prepare(
                'UPDATE afiliados SET token_verificacion = NULL, token_expira = NULL WHERE id = ?'
            ).bind(fila.id).run();
            return { estado: 400, cuerpo: { ok: false, motivo: 'enlace_invalido',
                error: 'Demasiados intentos con una contrasena incorrecta. Pida un enlace nuevo desde «Ingresar».' } };
        }
        return { estado: 401, cuerpo: { ok: false,
            error: 'La contrasena no coincide con la que eligio al crear la cuenta.' } };
    }

    // El numero de registro pendiente pasa a la cuenta si sigue libre. Si
    // otro colegiado lo confirmo antes, se queda sin el y se dice.
    let registroOcupado = false;
    let registro = fila.registro_pendiente || null;
    if (registro) {
        const otro = await env.DB.prepare(
            'SELECT id FROM afiliados WHERE registro_profesional = ? AND id != ? LIMIT 1'
        ).bind(registro, fila.id).first();
        if (otro) { registroOcupado = true; registro = null; }
    }

    const t = ahora();
    const cambio = await env.DB.prepare(
        'UPDATE afiliados SET correo_verificado = 1, verificado_en = ?, token_verificacion = NULL, token_expira = NULL, '
        + ' registro_profesional = COALESCE(?, registro_profesional), registro_pendiente = NULL, actualizado_en = ? '
        + ' WHERE id = ? AND correo_verificado = 0'
    ).bind(t, registro, t, fila.id).run();
    if (!cambio.meta || cambio.meta.changes !== 1) {
        return { estado: 409, cuerpo: { ok: false, motivo: 'ya_verificada',
            error: 'Esta cuenta ya estaba confirmada. Ingrese con su correo y contrasena.' } };
    }

    await registrarEvento(env, {
        tipo: 'registro_verificado', afiliado_id: fila.id, usuario: fila.usuario,
        detalle: registroOcupado ? 'numero de registro ' + fila.registro_pendiente + ' ya tomado por otra cuenta' : null,
        ip_hash: ip_hash
    });

    const confirmada = await env.DB.prepare('SELECT * FROM afiliados WHERE id = ?').bind(fila.id).first();
    const r = await abrirSesion(env, request, confirmada, ip_hash);
    r.cuerpo.registro_ocupado = registroOcupado;
    r.cuerpo.mensaje = registroOcupado
        ? 'Correo confirmado. El numero de registro que escribio ya pertenece a otra cuenta, asi que no lo '
          + 'asociamos a esta: si es el suyo, escriba a la sede del CAE-CH.'
        : 'Correo confirmado. Su cuenta ya esta activa.';
    return r;
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
