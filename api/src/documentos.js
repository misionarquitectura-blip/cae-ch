// ════════════════════════════════════════════════════════════════════
//  Aceptacion de cada documento legal por separado (desde 2026-11-01).
//
//  Antes de descargar un producto (PDF, CSV, DXF) o abrir la planimetria,
//  la cuenta acepta uno por uno los Terminos, la Politica de Privacidad y
//  el aviso de almacenamiento en el navegador (cookies). Cada uno se lee
//  entero en la ventana de lectura de caech-acceso.js: la casilla no se
//  habilita hasta llegar al final y pasar un tiempo minimo con el texto
//  abierto. Aqui se vuelve a exigir ese minimo y se guarda una fila por
//  documento con su version, el tiempo de lectura y la accion que lo pidio.
//
//  Si cambia un texto se sube SU version: solo ese documento se vuelve a
//  pedir. La de los Terminos es VERSION_TERMINOS (sesiones.js), que
//  coincide con las fechas de vigencia de legal.html.
// ════════════════════════════════════════════════════════════════════

import { hashIP } from './cripto.js';
import { ahora, texto } from './http.js';
import { registrarEvento, VERSION_TERMINOS } from './sesiones.js';

export const DOCUMENTOS = {
    terminos:   { version: VERSION_TERMINOS, minimo: 20, nombre: 'Terminos y condiciones' },
    privacidad: { version: VERSION_TERMINOS, minimo: 20, nombre: 'Politica de privacidad' },
    cookies:    { version: VERSION_TERMINOS, minimo: 8,  nombre: 'Cookies y almacenamiento en el navegador' }
};

const CONTEXTOS = ['pdf', 'csv', 'dxf', 'planimetria', 'ingreso'];

/** Documentos cuya version vigente la cuenta aun no acepto, en orden. */
export async function documentosPendientes(env, afiliadoId) {
    const { results } = await env.DB.prepare(
        'SELECT documento, version FROM aceptaciones WHERE afiliado_id = ?'
    ).bind(afiliadoId).all();
    const aceptadas = new Set((results || []).map(f => f.documento + '|' + f.version));
    return Object.keys(DOCUMENTOS).filter(d => !aceptadas.has(d + '|' + DOCUMENTOS[d].version));
}

/** Lo que la puerta devuelve cuando faltan documentos (HTTP 428). */
export function cuerpoPendientes(pendientes) {
    return {
        requiere_documentos: pendientes.map(d => ({
            documento: d, version: DOCUMENTOS[d].version, minimo_segundos: DOCUMENTOS[d].minimo
        }))
    };
}

export async function estadoDocumentos(env, sesion) {
    const pendientes = await documentosPendientes(env, sesion.afiliado.id);
    return { estado: 200, cuerpo: Object.assign({ ok: true }, cuerpoPendientes(pendientes)) };
}

export async function aceptarDocumento(env, request, sesion, datos) {
    const fila = sesion.afiliado;
    const malo = m => ({ estado: 400, cuerpo: { ok: false, error: m } });

    const documento = texto(datos.documento, 20).toLowerCase();
    const doc = DOCUMENTOS[documento];
    if (!doc) return malo('Documento no reconocido.');
    if (texto(datos.version, 20) !== doc.version) {
        return { estado: 409, cuerpo: { ok: false, error: 'El texto cambio mientras lo leia. Recargue la pagina y vuelva a leerlo.' } };
    }
    if (datos.lectura_completa !== true || datos.acepta !== true) {
        return malo('Lea el documento hasta el final y marque la casilla para aceptarlo.');
    }
    const segundos = Math.round(Number(datos.segundos_lectura));
    if (!Number.isFinite(segundos) || segundos < doc.minimo) {
        return malo('Tomese el tiempo de leer el documento antes de aceptarlo.');
    }
    const contexto = CONTEXTOS.includes(datos.contexto) ? datos.contexto : null;
    const t = ahora();

    await env.DB.prepare(
        'INSERT INTO aceptaciones (afiliado_id, documento, version, segundos_lectura, contexto, aceptado_en, ip_hash) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(fila.id, documento, doc.version, Math.min(segundos, 86400), contexto, t,
           await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)).run();

    await registrarEvento(env, {
        tipo: 'documento_aceptado', afiliado_id: fila.id, usuario: fila.usuario,
        detalle: documento + ' ' + doc.version + ' (' + segundos + ' s' + (contexto ? ', ' + contexto : '') + ')'
    });

    // Con los tres al dia, la aceptacion de conjunto de la migracion 004
    // tambien queda al dia y el ingreso deja de pedirla.
    const pendientes = await documentosPendientes(env, fila.id);
    if (!pendientes.length && fila.terminos_version !== VERSION_TERMINOS) {
        await env.DB.prepare(
            'UPDATE afiliados SET terminos_version = ?, terminos_aceptados_en = ?, actualizado_en = ? WHERE id = ?'
        ).bind(VERSION_TERMINOS, t, t, fila.id).run();
    }
    return { estado: 201, cuerpo: Object.assign({ ok: true, aceptado: documento }, cuerpoPendientes(pendientes)) };
}
