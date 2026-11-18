// ════════════════════════════════════════════════════════════════════
//  Datos de facturacion de cada pago y reporte mensual para el SRI.
//
//  Quien paga puede pedir la factura a su nombre. Es OPCIONAL: sin datos,
//  el pago se factura a consumidor final, que es lo que el SRI admite en
//  montos bajos como los de la plataforma. Los datos se guardan en la fila
//  del pago -son los de esa factura- y no en la cuenta.
//
//    PUT  /api/pagos/:id/facturacion          la propia cuenta, mientras el
//                                             pago este preparado o aprobado
//                                             y la factura no se haya emitido
//    GET  /api/admin/pagos/reporte?mes=AAAA-MM  aprobados del mes (hora de
//                                             Ecuador) con totales
//    PATCH /api/admin/pagos/:id/factura {numero}  anota la factura emitida;
//                                             numero vacio la desmarca
//
//  La bitacora anota que se dieron datos de facturacion, nunca el numero de
//  identificacion: ese solo esta en la fila del pago.
// ════════════════════════════════════════════════════════════════════

import { hashIP } from './cripto.js';
import { ahora, texto, correoValido } from './http.js';
import { registrarEvento } from './sesiones.js';
import { cedulaValida, rucValido } from './solicitudes.js';

const TIPOS = ['cedula', 'ruc', 'pasaporte'];

// Ecuador continental no cambia de hora: UTC-5 todo el año.
const DESFASE_ECUADOR_MS = 5 * 3600 * 1000;

/**
 * Valida lo que manda el formulario. Devuelve los valores listos para la
 * fila o un error para mostrar tal cual. {tipo: 'consumidor_final'} (o sin
 * tipo) borra los datos: la factura vuelve a consumidor final.
 */
export function validarFacturacion(datos) {
    const tipo = texto(String((datos && datos.tipo) || ''), 20).toLowerCase();
    if (!tipo || tipo === 'consumidor_final') {
        return { valores: { tipo: null, identificacion: null, nombre: null, correo: null, direccion: null } };
    }
    if (!TIPOS.includes(tipo)) return { error: 'Tipo de identificacion no valido.' };

    let ident = texto(String(datos.identificacion || ''), 20).replace(/[\s.-]+/g, '').toUpperCase();
    if (tipo === 'cedula' && !cedulaValida(ident)) return { error: 'La cedula no es valida: revise los 10 digitos.' };
    if (tipo === 'ruc' && !rucValido(ident)) return { error: 'El RUC no es valido: revise los 13 digitos.' };
    if (tipo === 'pasaporte' && !/^[A-Z0-9]{3,20}$/.test(ident)) return { error: 'El pasaporte no es valido.' };

    const nombre = texto(String(datos.nombre || ''), 150).replace(/\s+/g, ' ');
    if (nombre.length < 3) return { error: 'Indique el nombre o la razon social que debe ir en la factura.' };

    const correo = texto(String(datos.correo || ''), 254).toLowerCase();
    if (correo && !correoValido(correo)) return { error: 'El correo para la factura no es valido.' };

    const direccion = texto(String(datos.direccion || ''), 200).replace(/\s+/g, ' ');

    return { valores: { tipo: tipo, identificacion: ident, nombre: nombre, correo: correo || null, direccion: direccion || null } };
}

/** Los datos de facturacion de una fila de pagos, para el cliente. */
export function vistaFacturacion(f) {
    return {
        tipo: f.factura_tipo || 'consumidor_final',
        identificacion: f.factura_identificacion || null,
        nombre: f.factura_nombre || null,
        correo: f.factura_correo || null,
        direccion: f.factura_direccion || null,
        numero: f.factura_numero || null,
        facturado_en: f.facturado_en || null
    };
}

/** Los ultimos datos que dio la cuenta, para no hacerlos teclear otra vez. */
export async function facturacionAnterior(env, afiliadoId) {
    const f = await env.DB.prepare(
        'SELECT factura_tipo, factura_identificacion, factura_nombre, factura_correo, factura_direccion '
        + 'FROM pagos WHERE afiliado_id = ? AND factura_tipo IS NOT NULL ORDER BY creado_en DESC LIMIT 1'
    ).bind(afiliadoId).first();
    return f ? vistaFacturacion(f) : null;
}

// ── La propia cuenta ────────────────────────────────────────────────

export async function guardarFacturacion(env, request, sesion, pagoId, datos) {
    const fila = sesion.afiliado;
    const pago = await env.DB.prepare('SELECT * FROM pagos WHERE id = ? LIMIT 1').bind(pagoId).first();
    if (!pago || pago.afiliado_id !== fila.id) {
        return { estado: 404, cuerpo: { ok: false, error: 'No encontramos ese pago en su cuenta.' } };
    }
    if (pago.estado !== 'preparado' && pago.estado !== 'aprobado') {
        return { estado: 409, cuerpo: { ok: false, error: 'Este pago no se cobro: no hay nada que facturar.' } };
    }
    if (pago.facturado_en) {
        return { estado: 409, cuerpo: { ok: false, error:
            'La factura de este pago ya se emitio (' + pago.factura_numero + '). Si hay que corregirla, '
            + 'escriba a caechoficial@gmail.com.' } };
    }

    const v = validarFacturacion(datos);
    if (v.error) return { estado: 400, cuerpo: { ok: false, error: v.error } };
    const x = v.valores;

    // La condicion repite la del chequeo: si la factura se emitio entre
    // medias, no se pisan los datos con los que se hizo.
    const cambio = await env.DB.prepare(
        'UPDATE pagos SET factura_tipo = ?, factura_identificacion = ?, factura_nombre = ?, factura_correo = ?, '
        + "factura_direccion = ? WHERE id = ? AND facturado_en IS NULL AND estado IN ('preparado', 'aprobado')"
    ).bind(x.tipo, x.identificacion, x.nombre, x.correo, x.direccion, pago.id).run();
    if (!cambio.meta || cambio.meta.changes !== 1) {
        return { estado: 409, cuerpo: { ok: false, error: 'El pago cambio mientras tanto. Recargue la pagina.' } };
    }

    await registrarEvento(env, {
        tipo: 'pago_facturacion', afiliado_id: fila.id, usuario: fila.usuario,
        detalle: pago.id + ' ' + (x.tipo || 'consumidor final'),
        ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
    });

    const actualizado = await env.DB.prepare('SELECT * FROM pagos WHERE id = ?').bind(pago.id).first();
    return { estado: 200, cuerpo: { ok: true, facturacion: vistaFacturacion(actualizado) } };
}

// ── Administracion ──────────────────────────────────────────────────

/** 'AAAA-MM' del mes en curso en Ecuador. */
function mesEcuador(ms) {
    return new Date(ms - DESFASE_ECUADOR_MS).toISOString().slice(0, 7);
}

/** Limites ISO [desde, hasta) de un mes de Ecuador, en UTC. */
export function rangoMes(mes) {
    const m = /^(\d{4})-(\d{2})$/.exec(mes || '');
    if (!m || +m[2] < 1 || +m[2] > 12) return null;
    const anio = +m[1], n = +m[2];
    return {
        desde: new Date(Date.UTC(anio, n - 1, 1) + DESFASE_ECUADOR_MS).toISOString(),
        hasta: new Date(Date.UTC(anio, n, 1) + DESFASE_ECUADOR_MS).toISOString()
    };
}

export async function reporteMensual(env, url) {
    const mes = url.searchParams.get('mes') || mesEcuador(Date.now());
    const r = rangoMes(mes);
    if (!r) return { estado: 400, cuerpo: { ok: false, error: 'El mes va como AAAA-MM.' } };

    const { results } = await env.DB.prepare(
        'SELECT p.*, a.usuario, a.nombre, a.correo FROM pagos p LEFT JOIN afiliados a ON a.id = p.afiliado_id '
        + "WHERE p.estado = 'aprobado' AND p.confirmado_en >= ? AND p.confirmado_en < ? ORDER BY p.confirmado_en"
    ).bind(r.desde, r.hasta).all();

    const filas = (results || []).map(f => ({
        id: f.id, concepto: f.concepto || 'predio', clave_catastral: f.clave_catastral,
        monto: f.monto, base: f.base, iva: f.iva,
        transaccion: f.transaccion, autorizacion: f.autorizacion,
        creado_en: f.creado_en, confirmado_en: f.confirmado_en,
        usuario: f.usuario, nombre: f.nombre, correo_cuenta: f.correo,
        facturacion: vistaFacturacion(f)
    }));
    const suma = (lista, k) => lista.reduce((a, f) => a + (f[k] || 0), 0);
    const pendientes = filas.filter(f => !f.facturacion.facturado_en);

    return {
        estado: 200,
        cuerpo: {
            ok: true, mes: mes, desde: r.desde, hasta: r.hasta,
            totales: {
                n: filas.length, base: suma(filas, 'base'), iva: suma(filas, 'iva'), monto: suma(filas, 'monto'),
                facturados: filas.length - pendientes.length, pendientes: pendientes.length,
                con_datos: filas.filter(f => f.facturacion.tipo !== 'consumidor_final').length
            },
            pagos: filas
        }
    };
}

/**
 * Numero de factura del SRI: establecimiento, punto de emision y secuencial,
 * 001-001-000000123. Se aceptan sin guiones o con el secuencial corto.
 */
export function normalizarNumeroFactura(v) {
    const m = /^(\d{3})-?(\d{3})-?(\d{1,9})$/.exec(String(v || '').replace(/\s+/g, ''));
    return m ? m[1] + '-' + m[2] + '-' + m[3].padStart(9, '0') : null;
}

export async function marcarFactura(env, request, sesion, pagoId, datos) {
    const pago = await env.DB.prepare('SELECT * FROM pagos WHERE id = ? LIMIT 1').bind(pagoId).first();
    if (!pago) return { estado: 404, cuerpo: { ok: false, error: 'Pago no encontrado.' } };
    if (pago.estado !== 'aprobado') {
        return { estado: 409, cuerpo: { ok: false, error: 'Solo se facturan los pagos aprobados.' } };
    }

    const crudo = texto(String((datos && datos.numero) || ''), 30);
    const numero = crudo ? normalizarNumeroFactura(crudo) : null;
    if (crudo && !numero) {
        return { estado: 400, cuerpo: { ok: false, error: 'El numero de factura va como 001-001-000000123.' } };
    }

    const t = numero ? ahora() : null;
    await env.DB.prepare('UPDATE pagos SET factura_numero = ?, facturado_en = ?, facturado_por = ? WHERE id = ?')
        .bind(numero, t, numero ? sesion.afiliado.usuario : null, pago.id).run();
    await registrarEvento(env, {
        tipo: numero ? 'pago_facturado' : 'pago_factura_anulada', afiliado_id: pago.afiliado_id,
        usuario: sesion.afiliado.usuario,
        detalle: pago.id + (numero ? ' factura ' + numero : ' sin factura (antes ' + (pago.factura_numero || '-') + ')'),
        ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
    });
    return { estado: 200, cuerpo: { ok: true, id: pago.id, numero: numero, facturado_en: t } };
}
