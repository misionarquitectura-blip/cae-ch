// ════════════════════════════════════════════════════════════════════
//  Cobro por predio: cupo del colegiado y pago en linea con PayPhone.
//
//  Desde el 2026-10-02 (convenio CAE-CH ↔ desarrollador) los productos de
//  un predio -DICAT en PDF, CSV y DXF- se habilitan POR PREDIO:
//
//    · admin      libre, sin anotar nada
//    · colegiado  CUPO_MENSUAL predios al mes sin pagar; pasado el cupo,
//                 paga como cualquiera
//    · el resto   paga PRECIO_PREDIO_CENTAVOS por predio
//
//  Un predio habilitado -por cupo, por pago o por la administracion- abre
//  los TRES formatos durante DIAS_ACCESO_PREDIO dias. Volver a descargar
//  el mismo predio dentro del plazo no gasta cupo ni cobra otra vez.
//
//  El pago sigue las dos fases de la Cajita de PayPhone:
//    1. POST /api/pagos {clave_catastral}
//       Anota el pago como 'preparado' y devuelve la configuracion de la
//       cajita. El clientTransactionId ES el id de la fila.
//    2. POST /api/pagos/confirmar {id, clientTransactionId}
//       PayPhone devuelve al usuario a pago.html con esos dos datos. El
//       Worker llama al Confirm de PayPhone -sin confirmar en 5 minutos,
//       PayPhone reversa el cobro- y solo si el estado es aprobado, el
//       monto es el preparado y la transaccion es de esta cuenta, habilita
//       el predio. Nunca se cree a la URL de regreso.
//
//  Mientras PAYPHONE_TOKEN y PAYPHONE_STORE_ID no esten cargados como
//  secretos, el cobro en linea responde 503 y lo dice: el resto del
//  sistema -cupo, habilitacion manual desde el panel- funciona igual.
// ════════════════════════════════════════════════════════════════════

import { generarToken, hashIP } from './cripto.js';
import { ahora, texto } from './http.js';
import { permisos, registrarEvento } from './sesiones.js';

const URL_CONFIRMAR_PAYPHONE = 'https://paymentbox.payphonetodoesposible.com/api/confirm';

/**
 * Credenciales de PayPhone tal como se usan. Se pegan a mano en
 * `wrangler secret put`, asi que se limpian espacios, saltos de linea,
 * comillas y un "Bearer " copiado de mas: cualquiera de ellos hace que
 * PayPhone responda "Su aplicacion no esta autorizada".
 */
function credenciales(env) {
    const limpiar = v => String(v || '').trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim();
    return { token: limpiar(env.PAYPHONE_TOKEN), storeId: limpiar(env.PAYPHONE_STORE_ID) };
}

/** Parametros de cobro leidos del entorno, con los valores del convenio. */
export function tarifa(env) {
    const precio = parseInt(env.PRECIO_PREDIO_CENTAVOS, 10) || 2000;
    const ivaPct = Number.isFinite(parseFloat(env.IVA_PORCENTAJE)) ? parseFloat(env.IVA_PORCENTAJE) : 15;
    // PayPhone exige amount = amountWithTax + tax exacto, en centavos: se
    // redondea la base y el IVA es lo que falta. USD 20 → 1739 + 261.
    const base = Math.round(precio / (1 + ivaPct / 100));
    return {
        precio: precio,
        base: base,
        iva: precio - base,
        iva_porcentaje: ivaPct,
        cupo_mensual: parseInt(env.CUPO_MENSUAL, 10) >= 0 ? parseInt(env.CUPO_MENSUAL, 10) : 4,
        dias_acceso: parseInt(env.DIAS_ACCESO_PREDIO, 10) || 30,
        cobro_en_linea: !!(credenciales(env).token && credenciales(env).storeId)
    };
}

/** Lo que el cliente necesita para explicar el precio. Sin secretos. */
function tarifaPublica(t) {
    return {
        precio: t.precio, base: t.base, iva: t.iva, iva_porcentaje: t.iva_porcentaje,
        moneda: 'USD', dias_acceso: t.dias_acceso, cobro_en_linea: t.cobro_en_linea
    };
}

/**
 * Clave del predio tal como se compara. Las del catastro son digitos; las
 * de un poligono propio (CSV, coordenadas) las arma el visor a partir de
 * la geometria, con el prefijo GEO-.
 */
export function normalizarClave(v) {
    return texto(v, 60).replace(/\s+/g, '').toUpperCase();
}

function claveValida(c) {
    return /^[A-Z0-9][A-Z0-9._,\-]{2,59}$/.test(c);
}

/** Primer instante del mes en curso en Ecuador continental (UTC-5, sin horario de verano). */
export function inicioMesEcuador(ms) {
    const local = new Date((ms || Date.now()) - 5 * 3600000);
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1, 5)).toISOString();
}

export async function cupoUsado(env, afiliadoId) {
    const fila = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM predios_habilitados WHERE afiliado_id = ? AND via = 'cupo' AND creado_en >= ?"
    ).bind(afiliadoId, inicioMesEcuador()).first();
    return fila ? fila.n : 0;
}

async function habilitacionVigente(env, afiliadoId, clave) {
    return env.DB.prepare(
        'SELECT * FROM predios_habilitados WHERE afiliado_id = ? AND clave_catastral = ? AND vence_en > ? '
        + 'ORDER BY vence_en DESC LIMIT 1'
    ).bind(afiliadoId, clave, ahora()).first();
}

async function habilitar(env, { afiliado_id, clave, via, pago_id, concedido_por, dias }) {
    const t = ahora();
    const vence = new Date(Date.now() + dias * 86400000).toISOString();
    await env.DB.prepare(
        'INSERT INTO predios_habilitados (afiliado_id, clave_catastral, via, pago_id, creado_en, vence_en, concedido_por) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(afiliado_id, clave, via, pago_id || null, t, vence, concedido_por || null).run();
    return { via: via, vence_en: vence };
}

/** Cupo del mes de una cuenta, o null si no le corresponde. */
async function resumenCupo(env, fila, t) {
    if (permisos(fila).cobro !== 'cupo') return null;
    const usados = await cupoUsado(env, fila.id);
    return { usados: usados, total: t.cupo_mensual, restantes: Math.max(0, t.cupo_mensual - usados) };
}

// ── Estado de un predio para una cuenta ────────────────────────────

export async function estadoPredio(env, sesion, clave) {
    const fila = sesion.afiliado;
    const t = tarifa(env);
    const c = normalizarClave(clave);
    if (!claveValida(c)) return { estado: 400, cuerpo: { ok: false, error: 'Clave del predio no valida.' } };

    const p = permisos(fila);
    const vigente = p.cobro === 'libre' ? null : await habilitacionVigente(env, fila.id, c);
    return {
        estado: 200,
        cuerpo: {
            ok: true,
            clave_catastral: c,
            cobro: p.cobro,
            habilitado: p.cobro === 'libre' || !!vigente,
            via: p.cobro === 'libre' ? 'libre' : (vigente ? vigente.via : null),
            vence_en: vigente ? vigente.vence_en : null,
            cupo: await resumenCupo(env, fila, t),
            tarifa: tarifaPublica(t)
        }
    };
}

// ── La puerta: ¿puede esta cuenta descargar este predio? ────────────

/**
 * La llama /api/descargas despues de comprobar `permisos()[formato]`.
 * @returns {Promise<{ok:true, via:string, cupo?:object} | {ok:false, estado:number, cuerpo:object}>}
 */
export async function autorizarPredio(env, fila, claveCruda) {
    const p = permisos(fila);
    if (p.cobro === 'libre') return { ok: true, via: 'libre' };

    const t = tarifa(env);
    const clave = normalizarClave(claveCruda);
    if (!claveValida(clave)) {
        return { ok: false, estado: 400, cuerpo: { ok: false, error: 'Falta la clave del predio.' } };
    }

    const vigente = await habilitacionVigente(env, fila.id, clave);
    if (vigente) return { ok: true, via: vigente.via, vence_en: vigente.vence_en, clave: clave };

    if (p.cobro === 'cupo') {
        const usados = await cupoUsado(env, fila.id);
        if (usados < t.cupo_mensual) {
            const h = await habilitar(env, {
                afiliado_id: fila.id, clave: clave, via: 'cupo', dias: t.dias_acceso
            });
            await registrarEvento(env, {
                tipo: 'predio_cupo', afiliado_id: fila.id, usuario: fila.usuario,
                detalle: clave + ' (' + (usados + 1) + ' de ' + t.cupo_mensual + ' del mes)'
            });
            return {
                ok: true, via: 'cupo', vence_en: h.vence_en, clave: clave, nuevo: true,
                cupo: { usados: usados + 1, total: t.cupo_mensual, restantes: t.cupo_mensual - usados - 1 }
            };
        }
    }

    // 402 Payment Required: no es un error del usuario sino un paso.
    const pendiente = fila.rol === 'usuario' && !!fila.registro_profesional && !fila.registro_validado;
    let motivo;
    if (p.cobro === 'cupo') {
        motivo = 'Ya uso los ' + t.cupo_mensual + ' predios gratuitos de este mes. '
               + 'Este predio puede habilitarlo con un pago.';
    } else if (pendiente) {
        motivo = 'Su numero de registro del CAE todavia no ha sido cotejado, asi que por ahora '
               + 'los predios se habilitan con un pago. Cuando lo validemos tendra su cupo de colegiado.';
    } else {
        motivo = 'Para descargar los productos de este predio hay que habilitarlo con un pago.';
    }
    return {
        ok: false,
        estado: 402,
        cuerpo: {
            ok: false,
            error: motivo,
            requiere_pago: true,
            registro_pendiente: pendiente,
            clave_catastral: clave,
            cupo: await resumenCupo(env, fila, t),
            tarifa: tarifaPublica(t)
        }
    };
}

// ── Fase 1: preparar el pago ────────────────────────────────────────

export async function prepararPago(env, request, sesion, datos) {
    const fila = sesion.afiliado;
    const p = permisos(fila);
    const t = tarifa(env);

    if (!p.pdf) {
        return { estado: 403, cuerpo: { ok: false, error: 'Su cuenta no esta habilitada para pedir productos.' } };
    }
    if (p.cobro === 'libre') {
        return { estado: 409, cuerpo: { ok: false, error: 'Su cuenta descarga sin pagar.', ya_habilitado: true } };
    }
    if (!t.cobro_en_linea) {
        return {
            estado: 503,
            cuerpo: {
                ok: false, cobro_en_linea: false,
                error: 'El pago en linea todavia no esta habilitado. Mientras tanto puede pagar en la sede '
                     + 'del CAE-CH y la administracion habilitara el predio en su cuenta.'
            }
        };
    }

    const clave = normalizarClave(datos.clave_catastral);
    if (!claveValida(clave)) return { estado: 400, cuerpo: { ok: false, error: 'Falta la clave del predio.' } };

    const vigente = await habilitacionVigente(env, fila.id, clave);
    if (vigente) {
        return {
            estado: 409,
            cuerpo: { ok: false, ya_habilitado: true, vence_en: vigente.vence_en,
                      error: 'Este predio ya esta habilitado en su cuenta.' }
        };
    }

    // Alfanumerico y corto: PayPhone limita el clientTransactionId.
    const id = 'CAECH' + Date.now().toString(36).toUpperCase()
             + generarToken(9).replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
    await env.DB.prepare(
        "INSERT INTO pagos (id, afiliado_id, clave_catastral, monto, base, iva, estado, pasarela, creado_en) "
        + "VALUES (?, ?, ?, ?, ?, ?, 'preparado', 'payphone', ?)"
    ).bind(id, fila.id, clave, t.precio, t.base, t.iva, ahora()).run();

    await registrarEvento(env, {
        tipo: 'pago_preparado', afiliado_id: fila.id, usuario: fila.usuario,
        detalle: id + ' predio ' + clave + ' ' + (t.precio / 100).toFixed(2) + ' USD',
        ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
    });

    return {
        estado: 201,
        cuerpo: {
            ok: true,
            pago: { id: id, clave_catastral: clave, monto: t.precio },
            tarifa: tarifaPublica(t),
            // Configuracion de PPaymentButtonBox. El token de PayPhone viaja
            // al navegador porque asi funciona la Cajita: la autorizacion de
            // verdad esta en el Confirm, que solo hace este Worker.
            cajita: {
                token: credenciales(env).token,
                storeId: credenciales(env).storeId,
                clientTransactionId: id,
                amount: t.precio,
                amountWithTax: t.base,
                tax: t.iva,
                amountWithoutTax: 0,
                currency: 'USD',
                reference: ('Productos del predio ' + clave).slice(0, 100),
                lang: 'es',
                defaultMethod: 'card',
                timeZone: -5
            }
        }
    };
}

// ── Fase 2: confirmar ───────────────────────────────────────────────

export async function confirmarPago(env, request, sesion, datos) {
    const fila = sesion.afiliado;
    const t = tarifa(env);
    const idPayphone = parseInt(datos.id, 10);
    const clientTx = texto(String(datos.clientTransactionId || ''), 60);

    if (!idPayphone || !clientTx) {
        return { estado: 400, cuerpo: { ok: false, error: 'Faltan los datos de la transaccion.' } };
    }

    const pago = await env.DB.prepare('SELECT * FROM pagos WHERE id = ? LIMIT 1').bind(clientTx).first();
    // Una transaccion ajena se responde igual que una inexistente.
    if (!pago || pago.afiliado_id !== fila.id) {
        return { estado: 404, cuerpo: { ok: false, error: 'No encontramos ese pago en su cuenta.' } };
    }

    // Idempotente: recargar pago.html no vuelve a llamar a PayPhone.
    if (pago.estado !== 'preparado') return respuestaPago(env, pago, t);

    if (!t.cobro_en_linea) {
        return { estado: 503, cuerpo: { ok: false, error: 'El pago en linea no esta configurado.' } };
    }

    let r, respuesta = null;
    try {
        r = await fetch(env.PAYPHONE_URL_CONFIRMAR || URL_CONFIRMAR_PAYPHONE, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + credenciales(env).token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: idPayphone, clientTxId: clientTx })
        });
        respuesta = await r.json().catch(() => null);
    } catch (e) {
        console.error('Confirm de PayPhone:', e);
    }

    if (!r || !respuesta) {
        // Sin respuesta no se decide nada: el pago sigue preparado y el
        // usuario puede reintentar. Si nadie confirma, PayPhone lo reversa.
        return {
            estado: 502,
            cuerpo: { ok: false, reintentar: true,
                      error: 'No pudimos comprobar el pago con PayPhone. Recargue esta pagina en un momento.' }
        };
    }

    const aprobado = r.status === 200
        && respuesta.statusCode === 3
        && respuesta.clientTransactionId === pago.id
        && Number(respuesta.amount) === pago.monto
        && Number(respuesta.transactionId) === idPayphone;

    const tc = ahora();
    if (aprobado) {
        const cambio = await env.DB.prepare(
            "UPDATE pagos SET estado = 'aprobado', transaccion = ?, autorizacion = ?, confirmado_en = ? "
            + "WHERE id = ? AND estado = 'preparado'"
        ).bind(String(respuesta.transactionId), texto(String(respuesta.authorizationCode || ''), 40) || null,
               tc, pago.id).run();
        // La condicion sobre el estado hace que dos confirmaciones en
        // paralelo no habiliten dos veces: solo la que cambio la fila sigue.
        if (cambio.meta && cambio.meta.changes === 1) {
            await habilitar(env, {
                afiliado_id: fila.id, clave: pago.clave_catastral, via: 'pago', pago_id: pago.id, dias: t.dias_acceso
            });
            await registrarEvento(env, {
                tipo: 'pago_aprobado', afiliado_id: fila.id, usuario: fila.usuario,
                detalle: pago.id + ' predio ' + pago.clave_catastral + ' transaccion ' + respuesta.transactionId,
                ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
            });
        }
        const actualizado = await env.DB.prepare('SELECT * FROM pagos WHERE id = ?').bind(pago.id).first();
        return respuestaPago(env, actualizado, t);
    }

    const cancelado = respuesta.statusCode === 2;
    const motivo = cancelado
        ? 'cancelado en PayPhone'
        : 'no coincide o no aprobado: status ' + respuesta.statusCode + ', monto ' + respuesta.amount
          + ', transaccion ' + respuesta.clientTransactionId;
    await env.DB.prepare(
        "UPDATE pagos SET estado = ?, transaccion = ?, detalle = ?, confirmado_en = ? WHERE id = ? AND estado = 'preparado'"
    ).bind(cancelado ? 'cancelado' : 'rechazado', String(respuesta.transactionId || idPayphone),
           texto(motivo, 200), tc, pago.id).run();
    await registrarEvento(env, {
        tipo: cancelado ? 'pago_cancelado' : 'pago_rechazado', afiliado_id: fila.id, usuario: fila.usuario,
        detalle: pago.id + ' ' + motivo
    });
    const final = await env.DB.prepare('SELECT * FROM pagos WHERE id = ?').bind(pago.id).first();
    return respuestaPago(env, final, t);
}

async function respuestaPago(env, pago, t) {
    const h = pago.estado === 'aprobado'
        ? await env.DB.prepare('SELECT vence_en FROM predios_habilitados WHERE pago_id = ? LIMIT 1').bind(pago.id).first()
        : null;
    const mensajes = {
        aprobado: 'Pago aprobado. El predio quedo habilitado en su cuenta: ya puede descargar el DICAT, el CSV y el DXF.',
        cancelado: 'El pago se cancelo. No se cobro nada.',
        rechazado: 'El pago no pudo verificarse y no se habilito el predio. Si se le debito un valor, '
                 + 'escriba a caechoficial@gmail.com con el numero de transaccion.',
        preparado: 'El pago todavia no se ha completado.'
    };
    return {
        estado: 200,
        cuerpo: {
            ok: pago.estado === 'aprobado',
            pago: vistaPago(pago),
            vence_en: h ? h.vence_en : null,
            mensaje: mensajes[pago.estado],
            tarifa: tarifaPublica(t)
        }
    };
}

function vistaPago(f) {
    return {
        id: f.id, clave_catastral: f.clave_catastral, monto: f.monto, base: f.base, iva: f.iva,
        estado: f.estado, pasarela: f.pasarela, transaccion: f.transaccion, autorizacion: f.autorizacion,
        creado_en: f.creado_en, confirmado_en: f.confirmado_en
    };
}

// ── Lo que ve la propia cuenta ──────────────────────────────────────

export async function resumenCuenta(env, sesion) {
    const fila = sesion.afiliado;
    const t = tarifa(env);
    const { results: predios } = await env.DB.prepare(
        'SELECT clave_catastral, via, creado_en, vence_en FROM predios_habilitados '
        + 'WHERE afiliado_id = ? AND vence_en > ? ORDER BY creado_en DESC LIMIT 100'
    ).bind(fila.id, ahora()).all();
    const { results: pagos } = await env.DB.prepare(
        "SELECT * FROM pagos WHERE afiliado_id = ? AND estado != 'preparado' ORDER BY creado_en DESC LIMIT 50"
    ).bind(fila.id).all();
    return {
        estado: 200,
        cuerpo: {
            ok: true,
            cobro: permisos(fila).cobro,
            cupo: await resumenCupo(env, fila, t),
            tarifa: tarifaPublica(t),
            predios: predios || [],
            pagos: (pagos || []).map(vistaPago)
        }
    };
}

// ── Administracion ──────────────────────────────────────────────────

export async function listarPagos(env, url) {
    const limite = Math.min(parseInt(url.searchParams.get('limite'), 10) || 200, 500);
    const { results } = await env.DB.prepare(
        'SELECT p.*, a.usuario, a.nombre FROM pagos p LEFT JOIN afiliados a ON a.id = p.afiliado_id '
        + 'ORDER BY p.creado_en DESC LIMIT ?'
    ).bind(limite).all();
    const { results: resumen } = await env.DB.prepare(
        'SELECT estado, COUNT(*) AS n, COALESCE(SUM(monto), 0) AS monto FROM pagos GROUP BY estado'
    ).all();
    return {
        estado: 200,
        cuerpo: {
            ok: true,
            resumen: resumen || [],
            pagos: (results || []).map(f => Object.assign(vistaPago(f), {
                usuario: f.usuario, nombre: f.nombre, detalle: f.detalle
            }))
        }
    };
}

/**
 * Habilita un predio a mano: pago en la sede, cortesia institucional o un
 * pago en linea que se aprobo en PayPhone pero no llego a confirmarse aqui.
 * Queda con via 'admin' y el usuario de quien lo concedio.
 */
export async function habilitarPredioAdmin(env, request, sesion, afiliadoId, datos) {
    const t = tarifa(env);
    const clave = normalizarClave(datos.clave_catastral);
    if (!claveValida(clave)) return { estado: 400, cuerpo: { ok: false, error: 'Indique la clave del predio.' } };

    const cuenta = await env.DB.prepare('SELECT id, usuario FROM afiliados WHERE id = ?').bind(afiliadoId).first();
    if (!cuenta) return { estado: 404, cuerpo: { ok: false, error: 'Cuenta no encontrada.' } };

    const h = await habilitar(env, {
        afiliado_id: cuenta.id, clave: clave, via: 'admin',
        concedido_por: sesion.afiliado.usuario, dias: t.dias_acceso
    });
    await registrarEvento(env, {
        tipo: 'predio_habilitado', afiliado_id: cuenta.id, usuario: cuenta.usuario,
        detalle: clave + ' por ' + sesion.afiliado.usuario + (datos.motivo ? ' - ' + texto(datos.motivo, 120) : ''),
        ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
    });
    return { estado: 201, cuerpo: { ok: true, clave_catastral: clave, via: 'admin', vence_en: h.vence_en } };
}
