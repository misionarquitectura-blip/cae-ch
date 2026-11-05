// ════════════════════════════════════════════════════════════════════
//  Cobro por predio y suscripcion: cupo del colegiado, ciclo del suscriptor
//  y pago en linea con PayPhone.
//
//  Los productos de un predio -DICAT en PDF, CSV y DXF- se habilitan POR
//  PREDIO. Tarifas vigentes desde el 2026-11-05:
//
//    · admin      libre, sin anotar nada
//    · colegiado  CUPO_MENSUAL predios al mes calendario sin pagar; pasado
//                 el cupo, paga PRECIO_COLEGIADO_CENTAVOS. No se suscribe.
//    · suscriptor cuenta general con un ciclo vigente: CUPO_SUSCRIPCION
//                 predios por ciclo sin pagar; pasado el cupo, paga
//                 PRECIO_SUSCRIPTOR_CENTAVOS
//    · el resto   paga PRECIO_PREDIO_CENTAVOS por predio
//
//  Ademas, toda cuenta menos el admin tiene UNA sola vez un predio de cortesia
//  para probar los tres productos. Se usa antes que cualquier otro beneficio,
//  no resta del cupo y no vuelve con el mes ni con el ciclo.
//
//  El contador no se reinicia con ninguna tarea: se cuentan las filas 'cupo'
//  desde el inicio del mes o del ciclo vigente, asi que lo que no se uso no
//  pasa al siguiente. Va por cuenta, no por dispositivo.
//
//  La suscripcion es prepagada: PRECIO_SUSCRIPCION_CENTAVOS abren un ciclo de
//  un mes. No se debita sola, porque la Cajita cobra con el titular presente
//  y aqui no se guarda ninguna tarjeta. Renovar antes de tiempo encadena el
//  ciclo nuevo al final del vigente, sin perder dias.
//
//  Un predio habilitado -por cupo, por pago o por la administracion- abre
//  los TRES formatos durante DIAS_ACCESO_PREDIO dias. Volver a descargar
//  el mismo predio dentro del plazo no gasta cupo ni cobra otra vez.
//
//  El pago sigue las dos fases de la Cajita de PayPhone:
//    1. POST /api/pagos {clave_catastral} o {concepto: 'suscripcion'}
//       Anota el pago como 'preparado' y devuelve la configuracion de la
//       cajita. El clientTransactionId ES el id de la fila.
//    2. POST /api/pagos/confirmar {id, clientTransactionId}
//       PayPhone devuelve al usuario a pago.html con esos dos datos. El
//       Worker llama al Confirm de PayPhone -sin confirmar en 5 minutos,
//       PayPhone reversa el cobro- y solo si el estado es aprobado, el
//       monto es el preparado y la transaccion es de esta cuenta, habilita
//       el predio o abre el ciclo. Nunca se cree a la URL de regreso.
//
//  Mientras PAYPHONE_TOKEN y PAYPHONE_STORE_ID no esten cargados como
//  secretos, el cobro en linea responde 503 y lo dice: el resto del
//  sistema -cupo, habilitacion manual desde el panel- funciona igual.
// ════════════════════════════════════════════════════════════════════

import { generarToken, hashIP } from './cripto.js';
import { ahora, texto } from './http.js';
import { permisos, registrarEvento } from './sesiones.js';

const URL_CONFIRMAR_PAYPHONE = 'https://paymentbox.payphonetodoesposible.com/api/confirm';

// Lo que guarda `pagos.clave_catastral`, que es obligatoria, en una suscripcion
// contratada sin un predio de por medio.
const CLAVE_SUSCRIPCION = 'SUSCRIPCION';

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

function ivaPorcentaje(env) {
    return Number.isFinite(parseFloat(env.IVA_PORCENTAJE)) ? parseFloat(env.IVA_PORCENTAJE) : 15;
}

/**
 * PayPhone exige amount = amountWithTax + tax exacto, en centavos: se
 * redondea la base y el IVA es lo que falta. USD 5 → 435 + 65.
 */
function desglose(env, precio) {
    const base = Math.round(precio / (1 + ivaPorcentaje(env) / 100));
    return { precio: precio, base: base, iva: precio - base };
}

/**
 * Parametros de cobro leidos del entorno. Con la cuenta, el precio es el
 * suyo: el colegiado (cobro 'cupo') y el suscriptor tienen el preferencial;
 * sin cuenta, o cualquier otra, el regular.
 * @param {object} [suscripcion] ciclo vigente de la cuenta, si lo tiene
 */
export function tarifa(env, fila, suscripcion) {
    const publico = parseInt(env.PRECIO_PREDIO_CENTAVOS, 10) || 500;
    const colegiado = !!fila && permisos(fila).cobro === 'cupo';
    const suscriptor = !colegiado && !!suscripcion;
    const precio = colegiado ? (parseInt(env.PRECIO_COLEGIADO_CENTAVOS, 10) || 250)
                 : suscriptor ? (parseInt(env.PRECIO_SUSCRIPTOR_CENTAVOS, 10) || 250)
                 : publico;
    const d = desglose(env, precio);
    return {
        precio: d.precio,
        precio_publico: publico,
        descuento_colegiado: colegiado,
        descuento_suscriptor: suscriptor,
        base: d.base,
        iva: d.iva,
        iva_porcentaje: ivaPorcentaje(env),
        cupo_mensual: parseInt(env.CUPO_MENSUAL, 10) >= 0 ? parseInt(env.CUPO_MENSUAL, 10) : 4,
        cupo_suscripcion: parseInt(env.CUPO_SUSCRIPCION, 10) >= 0 ? parseInt(env.CUPO_SUSCRIPCION, 10) : 3,
        precio_suscripcion: parseInt(env.PRECIO_SUSCRIPCION_CENTAVOS, 10) || 990,
        dias_acceso: parseInt(env.DIAS_ACCESO_PREDIO, 10) || 30,
        cobro_en_linea: !!(credenciales(env).token && credenciales(env).storeId)
    };
}

/** Lo que el cliente necesita para explicar el precio. Sin secretos. */
function tarifaPublica(t) {
    return {
        precio: t.precio, precio_publico: t.precio_publico, descuento_colegiado: t.descuento_colegiado,
        descuento_suscriptor: t.descuento_suscriptor, precio_suscripcion: t.precio_suscripcion,
        cupo_suscripcion: t.cupo_suscripcion, base: t.base, iva: t.iva, iva_porcentaje: t.iva_porcentaje,
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

/**
 * Fin de un ciclo que empieza en `inicioIso`: el mismo dia del mes siguiente
 * en Ecuador o, si ese mes no lo tiene, su ultimo dia (31-ene → 28-feb).
 */
export function finDeCiclo(inicioIso) {
    const local = new Date(Date.parse(inicioIso) - 5 * 3600000);
    const anio = local.getUTCFullYear(), mes = local.getUTCMonth();
    const ultimoDia = new Date(Date.UTC(anio, mes + 2, 0)).getUTCDate();
    const fin = Date.UTC(anio, mes + 1, Math.min(local.getUTCDate(), ultimoDia),
        local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds());
    return new Date(fin + 5 * 3600000).toISOString();
}

async function cupoUsado(env, afiliadoId, desde) {
    const fila = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM predios_habilitados WHERE afiliado_id = ? AND via = 'cupo' AND creado_en >= ?"
    ).bind(afiliadoId, desde).first();
    return fila ? fila.n : 0;
}

/** Ciclo de suscripcion en curso de una cuenta, o null. */
async function suscripcionVigente(env, afiliadoId) {
    const t = ahora();
    return env.DB.prepare(
        'SELECT * FROM suscripciones WHERE afiliado_id = ? AND inicio <= ? AND vence_en > ? ORDER BY inicio DESC LIMIT 1'
    ).bind(afiliadoId, t, t).first();
}

/** Ultimo ciclo pagado que aun no termina: el vigente o el ya renovado. */
async function ultimoCiclo(env, afiliadoId) {
    return env.DB.prepare(
        'SELECT * FROM suscripciones WHERE afiliado_id = ? AND vence_en > ? ORDER BY vence_en DESC LIMIT 1'
    ).bind(afiliadoId, ahora()).first();
}

/** Se abre un ciclo por vez: renovado el siguiente, no se pagan mas por delante. */
function renovacionAdelantada(ciclo) {
    return !!ciclo && ciclo.inicio > ahora();
}

async function abrirCiclo(env, { afiliado_id, pago_id, concedido_por }) {
    const anterior = await ultimoCiclo(env, afiliado_id);
    const t = ahora();
    const inicio = anterior ? anterior.vence_en : t;
    const vence = finDeCiclo(inicio);
    await env.DB.prepare(
        'INSERT INTO suscripciones (afiliado_id, pago_id, inicio, vence_en, creado_en, concedido_por) '
        + 'VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(afiliado_id, pago_id || null, inicio, vence, t, concedido_por || null).run();
    return { inicio: inicio, vence_en: vence };
}

/**
 * Lo que le corresponde hoy a una cuenta: su tarifa, su ciclo y sus predios
 * gratuitos. Es la unica fuente de las condiciones de cobro.
 */
async function regimen(env, fila) {
    const p = permisos(fila);
    const suscripcion = p.cobro === 'pago' ? await suscripcionVigente(env, fila.id) : null;
    const t = tarifa(env, fila, suscripcion);
    let cupo = null;
    if (p.cobro === 'cupo' || suscripcion) {
        const desde = suscripcion ? suscripcion.inicio : inicioMesEcuador();
        const total = suscripcion ? t.cupo_suscripcion : t.cupo_mensual;
        const usados = await cupoUsado(env, fila.id, desde);
        cupo = {
            usados: usados, total: total, restantes: Math.max(0, total - usados),
            periodo: suscripcion ? 'ciclo' : 'mes'
        };
    }
    return { t: t, suscripcion: suscripcion, cupo: cupo };
}

/** Datos de la suscripcion para el cliente; null si no le corresponde. */
async function vistaSuscripcion(env, fila, suscripcion) {
    if (permisos(fila).cobro !== 'pago') return null;
    const ultimo = await ultimoCiclo(env, fila.id);
    return {
        activa: !!suscripcion,
        inicio: suscripcion ? suscripcion.inicio : null,
        vence_en: suscripcion ? suscripcion.vence_en : null,
        cubierta_hasta: ultimo ? ultimo.vence_en : null,
        renovada: renovacionAdelantada(ultimo)
    };
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

/** ¿Le queda a esta cuenta el predio de cortesia? */
function cortesiaDisponible(fila) {
    const cobro = permisos(fila).cobro;
    return (cobro === 'cupo' || cobro === 'pago') && !fila.cortesia_usada_en;
}

/**
 * Gasta el predio de cortesia y habilita el predio. Las dos ordenes van en un
 * lote -una transaccion- y condicionadas a que siga sin usarse, asi que dos
 * descargas en paralelo no obtienen dos cortesias.
 * @returns {Promise<string|null>} hasta cuando queda habilitado, o null si ya se habia usado
 */
async function usarCortesia(env, fila, clave, dias) {
    const t = ahora();
    const vence = new Date(Date.now() + dias * 86400000).toISOString();
    const [insercion] = await env.DB.batch([
        env.DB.prepare(
            "INSERT INTO predios_habilitados (afiliado_id, clave_catastral, via, creado_en, vence_en) "
            + "SELECT ?, ?, 'cortesia', ?, ? WHERE EXISTS "
            + "(SELECT 1 FROM afiliados WHERE id = ? AND cortesia_usada_en IS NULL)"
        ).bind(fila.id, clave, t, vence, fila.id),
        env.DB.prepare(
            'UPDATE afiliados SET cortesia_usada_en = ? WHERE id = ? AND cortesia_usada_en IS NULL'
        ).bind(t, fila.id)
    ]);
    return insercion.meta && insercion.meta.changes === 1 ? vence : null;
}

// ── Estado de un predio para una cuenta ────────────────────────────

export async function estadoPredio(env, sesion, clave) {
    const fila = sesion.afiliado;
    const r = await regimen(env, fila);
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
            categoria: p.categoria,
            cortesia_disponible: cortesiaDisponible(fila),
            habilitado: p.cobro === 'libre' || !!vigente,
            via: p.cobro === 'libre' ? 'libre' : (vigente ? vigente.via : null),
            vence_en: vigente ? vigente.vence_en : null,
            cupo: r.cupo,
            suscripcion: await vistaSuscripcion(env, fila, r.suscripcion),
            tarifa: tarifaPublica(r.t)
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

    const clave = normalizarClave(claveCruda);
    if (!claveValida(clave)) {
        return { ok: false, estado: 400, cuerpo: { ok: false, error: 'Falta la clave del predio.' } };
    }

    const vigente = await habilitacionVigente(env, fila.id, clave);
    if (vigente) return { ok: true, via: vigente.via, vence_en: vigente.vence_en, clave: clave };

    const { t, suscripcion, cupo } = await regimen(env, fila);
    if (cortesiaDisponible(fila)) {
        const vence = await usarCortesia(env, fila, clave, t.dias_acceso);
        if (vence) {
            await registrarEvento(env, {
                tipo: 'predio_cortesia', afiliado_id: fila.id, usuario: fila.usuario, detalle: clave
            });
            return { ok: true, via: 'cortesia', vence_en: vence, clave: clave, nuevo: true };
        }
    }

    if (cupo && cupo.restantes > 0) {
        const h = await habilitar(env, {
            afiliado_id: fila.id, clave: clave, via: 'cupo', dias: t.dias_acceso
        });
        const usados = cupo.usados + 1;
        await registrarEvento(env, {
            tipo: 'predio_cupo', afiliado_id: fila.id, usuario: fila.usuario,
            detalle: clave + ' (' + usados + ' de ' + cupo.total + (suscripcion ? ' del ciclo)' : ' del mes)')
        });
        return {
            ok: true, via: 'cupo', vence_en: h.vence_en, clave: clave, nuevo: true,
            cupo: Object.assign({}, cupo, { usados: usados, restantes: cupo.total - usados })
        };
    }

    // 402 Payment Required: no es un error del usuario sino un paso.
    const pendiente = fila.rol === 'usuario' && !!fila.registro_profesional && !fila.registro_validado;
    let motivo;
    if (p.cobro === 'cupo') {
        motivo = (t.cupo_mensual === 1 ? 'Ya uso el predio gratuito de este mes. '
                                    : 'Ya uso los ' + t.cupo_mensual + ' predios gratuitos de este mes. ')
               + 'Este predio puede habilitarlo con un pago, con el precio de colegiado.';
    } else if (suscripcion) {
        motivo = (t.cupo_suscripcion === 1 ? 'Ya uso el predio gratuito de este ciclo de su suscripcion. '
                                    : 'Ya uso los ' + t.cupo_suscripcion + ' predios gratuitos de este ciclo de su suscripcion. ')
               + 'Este predio puede habilitarlo con un pago, con el precio de suscriptor.';
    } else if (pendiente) {
        motivo = 'Su numero de registro del CAE todavia no ha sido cotejado, asi que por ahora '
               + 'los predios se habilitan con un pago. Cuando lo validemos tendra su cupo de colegiado.';
    } else {
        motivo = 'Para descargar los productos de este predio hay que habilitarlo con un pago o con una suscripcion.';
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
            categoria: p.categoria,
            cupo: cupo,
            suscripcion: await vistaSuscripcion(env, fila, suscripcion),
            tarifa: tarifaPublica(t)
        }
    };
}

// ── Fase 1: preparar el pago ────────────────────────────────────────

export async function prepararPago(env, request, sesion, datos) {
    const fila = sesion.afiliado;
    const p = permisos(fila);
    const { t } = await regimen(env, fila);
    const esSuscripcion = datos.concepto === 'suscripcion';

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
                     + 'del CAE-CH y la administracion lo registrara en su cuenta.'
            }
        };
    }

    let clave = normalizarClave(datos.clave_catastral);
    if (esSuscripcion) {
        if (p.cobro !== 'pago') {
            return { estado: 409, cuerpo: { ok: false, error:
                'Como colegiado no necesita suscripcion: sus beneficios se aplican solos.' } };
        }
        const ciclo = await ultimoCiclo(env, fila.id);
        if (renovacionAdelantada(ciclo)) {
            return { estado: 409, cuerpo: { ok: false, ya_renovada: true, vence_en: ciclo.vence_en, error:
                'Su suscripcion ya esta renovada para el siguiente ciclo.' } };
        }
        // El predio desde el que se contrato es opcional y sirve para volver a el.
        if (!claveValida(clave)) clave = CLAVE_SUSCRIPCION;
    } else {
        if (!claveValida(clave)) return { estado: 400, cuerpo: { ok: false, error: 'Falta la clave del predio.' } };

        // Por un enlace directo a pago.html se podria pagar lo que aun es gratis.
        if (cortesiaDisponible(fila)) {
            return { estado: 409, cuerpo: { ok: false, cortesia_disponible: true, error:
                'Su cuenta aun tiene un predio de cortesia: descargue este predio desde el visor, sin pagar.' } };
        }

        const vigente = await habilitacionVigente(env, fila.id, clave);
        if (vigente) {
            return {
                estado: 409,
                cuerpo: { ok: false, ya_habilitado: true, vence_en: vigente.vence_en,
                          error: 'Este predio ya esta habilitado en su cuenta.' }
            };
        }
    }
    const cobro = esSuscripcion ? desglose(env, t.precio_suscripcion) : t;

    // Alfanumerico y corto: PayPhone limita el clientTransactionId.
    const id = 'CAECH' + Date.now().toString(36).toUpperCase()
             + generarToken(9).replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
    await env.DB.prepare(
        "INSERT INTO pagos (id, afiliado_id, clave_catastral, monto, base, iva, estado, pasarela, creado_en, concepto) "
        + "VALUES (?, ?, ?, ?, ?, ?, 'preparado', 'payphone', ?, ?)"
    ).bind(id, fila.id, clave, cobro.precio, cobro.base, cobro.iva, ahora(), esSuscripcion ? 'suscripcion' : 'predio').run();

    await registrarEvento(env, {
        tipo: 'pago_preparado', afiliado_id: fila.id, usuario: fila.usuario,
        detalle: id + (esSuscripcion ? ' suscripcion ' : ' predio ' + clave + ' ') + (cobro.precio / 100).toFixed(2) + ' USD',
        ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
    });

    return {
        estado: 201,
        cuerpo: {
            ok: true,
            pago: { id: id, clave_catastral: clave, monto: cobro.precio, base: cobro.base, iva: cobro.iva,
                    concepto: esSuscripcion ? 'suscripcion' : 'predio' },
            tarifa: tarifaPublica(t),
            // Configuracion de PPaymentButtonBox. El token de PayPhone viaja
            // al navegador porque asi funciona la Cajita: la autorizacion de
            // verdad esta en el Confirm, que solo hace este Worker.
            cajita: {
                token: credenciales(env).token,
                storeId: credenciales(env).storeId,
                clientTransactionId: id,
                amount: cobro.precio,
                amountWithTax: cobro.base,
                tax: cobro.iva,
                amountWithoutTax: 0,
                currency: 'USD',
                reference: (esSuscripcion ? 'Suscripcion mensual CAE-CH' : 'Productos del predio ' + clave).slice(0, 100),
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
    // El monto se coteja contra el de la fila del pago, no contra esta tarifa.
    const { t } = await regimen(env, fila);
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
            if (pago.concepto === 'suscripcion') {
                await abrirCiclo(env, { afiliado_id: fila.id, pago_id: pago.id });
            } else {
                await habilitar(env, {
                    afiliado_id: fila.id, clave: pago.clave_catastral, via: 'pago', pago_id: pago.id, dias: t.dias_acceso
                });
            }
            await registrarEvento(env, {
                tipo: 'pago_aprobado', afiliado_id: fila.id, usuario: fila.usuario,
                detalle: pago.id + (pago.concepto === 'suscripcion' ? ' suscripcion' : ' predio ' + pago.clave_catastral)
                       + ' transaccion ' + respuesta.transactionId,
                ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
            });
        }
        const actualizado = await env.DB.prepare('SELECT * FROM pagos WHERE id = ?').bind(pago.id).first();
        return respuestaPago(env, actualizado, (await regimen(env, fila)).t);
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
    const esSuscripcion = pago.concepto === 'suscripcion';
    const h = pago.estado === 'aprobado'
        ? await env.DB.prepare('SELECT vence_en FROM ' + (esSuscripcion ? 'suscripciones' : 'predios_habilitados')
              + ' WHERE pago_id = ? LIMIT 1').bind(pago.id).first()
        : null;
    const mensajes = {
        aprobado: esSuscripcion
            ? 'Pago aprobado. Su suscripcion quedo activa: los predios gratuitos del ciclo y el precio de suscriptor se aplican solos.'
            : 'Pago aprobado. El predio quedo habilitado en su cuenta: ya puede descargar el DICAT, el CSV y el DXF.',
        cancelado: 'El pago se cancelo. No se cobro nada.',
        rechazado: 'El pago no pudo verificarse y no se aplico a su cuenta. Si se le debito un valor, '
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
        id: f.id, concepto: f.concepto || 'predio', clave_catastral: f.clave_catastral, monto: f.monto, base: f.base, iva: f.iva,
        estado: f.estado, pasarela: f.pasarela, transaccion: f.transaccion, autorizacion: f.autorizacion,
        creado_en: f.creado_en, confirmado_en: f.confirmado_en
    };
}

// ── Lo que ve la propia cuenta ──────────────────────────────────────

export async function resumenCuenta(env, sesion) {
    const fila = sesion.afiliado;
    const r = await regimen(env, fila);
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
            categoria: permisos(fila).categoria,
            cortesia_disponible: cortesiaDisponible(fila),
            cupo: r.cupo,
            suscripcion: await vistaSuscripcion(env, fila, r.suscripcion),
            tarifa: tarifaPublica(r.t),
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
 * Minutos que un pago 'preparado' esta a salvo de la escoba.
 *
 * Un 'preparado' es alguien que abrio la Cajita y no termino: no hubo cobro
 * y la fila no sirve de nada... salvo que el cobro SI este ocurriendo ahora
 * mismo. El Confirm de PayPhone se coteja contra esta fila -monto, cuenta y
 * predio-; si la borramos mientras el usuario esta tecleando su tarjeta, el
 * Confirm no encuentra nada, el predio no se habilita y el cobro ya se hizo.
 *
 * PayPhone reversa sola a los 5 minutos sin confirmacion. Treinta deja un
 * margen holgado sobre eso sin volver inutil la limpieza.
 */
const MINUTOS_GRACIA_PREPARADO = 30;

/**
 * Borra pagos 'preparados' que nunca se ejecutaron. Con `id`, solo ese; sin
 * el, todos los que hayan pasado la ventana de gracia.
 *
 * Solo toca 'preparado'. Un pago aprobado, cancelado o rechazado es la
 * constancia de que algo paso con el dinero de alguien y no se borra desde
 * el panel: eso se arregla con la pasarela, no escondiendo la fila.
 */
export async function eliminarPagosPreparados(env, request, sesion, id) {
    const corte = new Date(Date.now() - MINUTOS_GRACIA_PREPARADO * 60000).toISOString();

    if (id) {
        const pago = await env.DB.prepare('SELECT * FROM pagos WHERE id = ? LIMIT 1').bind(id).first();
        if (!pago) return { estado: 404, cuerpo: { ok: false, error: 'Pago no encontrado.' } };
        if (pago.estado !== 'preparado') {
            return { estado: 409, cuerpo: { ok: false, error:
                'Solo se borran los pagos en «preparado». Este esta ' + pago.estado + ': es constancia de una transaccion.' } };
        }
        // Se comparan TIEMPOS, no cadenas. El resto del codigo compara fechas
        // ISO como texto -`vence_en > ?`- y funciona porque todas las escribe
        // ahora(); pero aqui basta una fila con el separador en espacio en vez
        // de 'T' para que el orden lexicografico la de por vieja y se borre un
        // pago que todavia podia confirmarse. Date.parse digiere las dos.
        const preparadoEn = Date.parse(pago.creado_en);
        if (!Number.isFinite(preparadoEn) || preparadoEn > Date.parse(corte)) {
            return { estado: 409, cuerpo: { ok: false, error:
                'Este pago se preparo hace menos de ' + MINUTOS_GRACIA_PREPARADO
                + ' minutos y todavia podria confirmarse. Espere e intentelo otra vez.' } };
        }
        await env.DB.prepare('DELETE FROM pagos WHERE id = ?').bind(id).run();
        await registrarEvento(env, {
            tipo: 'pago_preparado_borrado', afiliado_id: sesion.afiliado.id, usuario: sesion.afiliado.usuario,
            detalle: id + ' predio ' + pago.clave_catastral,
            ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
        });
        return { estado: 200, cuerpo: { ok: true, borrados: 1 } };
    }

    // Se eligen en JS por el mismo motivo que arriba: un `creado_en <= ?` en
    // SQL compara cadenas, y una fila con el separador raro se daria por
    // vieja. Los 'preparados' son pocos -los que no cuajaron-, asi que leerlos
    // para filtrarlos no cuesta nada.
    const { results } = await env.DB.prepare(
        "SELECT id, creado_en FROM pagos WHERE estado = 'preparado'"
    ).all();
    const limite = Date.parse(corte);
    const ids = (results || [])
        .filter(f => { const t = Date.parse(f.creado_en); return Number.isFinite(t) && t <= limite; })
        .map(f => f.id);
    const borrados = ids.length;

    if (!borrados) {
        return { estado: 200, cuerpo: { ok: true, borrados: 0,
            aviso: 'No hay pagos en «preparado» con mas de ' + MINUTOS_GRACIA_PREPARADO + ' minutos.' } };
    }

    await env.DB.batch(ids.map(id =>
        env.DB.prepare("DELETE FROM pagos WHERE id = ? AND estado = 'preparado'").bind(id)));
    await registrarEvento(env, {
        tipo: 'pagos_preparados_borrados', afiliado_id: sesion.afiliado.id, usuario: sesion.afiliado.usuario,
        detalle: borrados + ' pagos preparados sin ejecutar',
        ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
    });
    return { estado: 200, cuerpo: { ok: true, borrados: borrados } };
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

/** Abre un ciclo de suscripcion a mano: pago en la sede o un Confirm perdido. */
export async function concederSuscripcionAdmin(env, request, sesion, afiliadoId, datos) {
    const cuenta = await env.DB.prepare('SELECT * FROM afiliados WHERE id = ?').bind(afiliadoId).first();
    if (!cuenta) return { estado: 404, cuerpo: { ok: false, error: 'Cuenta no encontrada.' } };
    if (permisos(cuenta).cobro !== 'pago') {
        return { estado: 409, cuerpo: { ok: false, error: 'Solo las cuentas generales habilitadas tienen suscripcion.' } };
    }
    if (renovacionAdelantada(await ultimoCiclo(env, cuenta.id))) {
        return { estado: 409, cuerpo: { ok: false, error: 'Esta cuenta ya tiene renovado el siguiente ciclo.' } };
    }
    const ciclo = await abrirCiclo(env, { afiliado_id: cuenta.id, concedido_por: sesion.afiliado.usuario });
    await registrarEvento(env, {
        tipo: 'suscripcion_concedida', afiliado_id: cuenta.id, usuario: cuenta.usuario,
        detalle: 'hasta ' + ciclo.vence_en + ' por ' + sesion.afiliado.usuario + (datos.motivo ? ' - ' + texto(datos.motivo, 120) : ''),
        ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
    });
    return { estado: 201, cuerpo: { ok: true, inicio: ciclo.inicio, vence_en: ciclo.vence_en } };
}
