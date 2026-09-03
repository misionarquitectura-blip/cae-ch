// ════════════════════════════════════════════════════════════════════
//  CAE-CH · API de afiliados  (Cloudflare Worker + D1)
//
//  Controla quien puede descargar los productos del GeoVisor:
//    · PDF  — libre para afiliados; el publico general dispone de UN
//             reporte de cortesia por correo verificado (freemium).
//    · DXF  — solo afiliados con vigencia al dia.
//    · CSV  — solo afiliados con vigencia al dia.
//
//  Alcance honesto del control: el visor se sirve estatico desde GitHub
//  Pages y la capa de catastro es un GeoJSON publico del repositorio.
//  Este API blinda la HERRAMIENTA y deja auditoria de cada descarga; no
//  vuelve secreto el dato subyacente, que es informacion municipal
//  publica. Para eso habria que sacar el catastro del repositorio, lo
//  que dejaria sin mapa al sitio publico.
// ════════════════════════════════════════════════════════════════════

import { json, ok, error, preflight, cuerpoJSON, texto, ahora } from './http.js';
import { hashIP } from './cripto.js';
import {
    iniciarSesion, cerrarSesion, sesionActual, cambiarClave,
    perfilPublico, permisos, registrarEvento
} from './sesiones.js';
import {
    listarAfiliados, crearAfiliado, actualizarAfiliado, restablecerClave,
    listarDescargas, listarEventos, listarPases
} from './admin.js';
import { solicitarPase, verificarPase, consumirPase, estadoPase } from './freemium.js';

const FORMATOS = ['pdf', 'dxf', 'csv'];

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const ruta = url.pathname.replace(/\/+$/, '') || '/';
        const metodo = request.method.toUpperCase();

        if (metodo === 'OPTIONS') return preflight(request, env);

        try {
            const r = await enrutar(request, env, url, ruta, metodo);
            return r || error('Ruta no encontrada.', 404, request, env);
        } catch (e) {
            console.error('Error no controlado:', e && e.stack ? e.stack : e);
            return error('Error interno del servidor.', 500, request, env);
        }
    },

    // Aseo periodico: sesiones vencidas y pases caducados nunca usados.
    async scheduled(evento, env, ctx) {
        const t = ahora();
        await env.DB.prepare('DELETE FROM sesiones WHERE expira_en < ?').bind(t).run();
        await env.DB.prepare(
            'DELETE FROM pases_freemium WHERE verificado_en IS NULL AND expira_en < ?'
        ).bind(new Date(Date.now() - 7 * 86400000).toISOString()).run();
    }
};

async function enrutar(request, env, url, ruta, metodo) {
    const responder = r => json(r.cuerpo, r.estado, request, env);

    // ── Salud ───────────────────────────────────────────────────────
    if (ruta === '/api/salud' && metodo === 'GET') {
        return ok({ servicio: 'caech-afiliados', hora: ahora() }, request, env);
    }

    // ── Sesion ──────────────────────────────────────────────────────
    if (ruta === '/api/sesion') {
        if (metodo === 'POST') {
            const datos = await cuerpoJSON(request);
            if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);
            return responder(await iniciarSesion(env, request, datos));
        }
        if (metodo === 'GET') {
            const sesion = await sesionActual(env, request);
            if (!sesion) return error('Sesion no valida o expirada.', 401, request, env);
            return ok({
                afiliado: perfilPublico(sesion.afiliado),
                permisos: permisos(sesion.afiliado)
            }, request, env);
        }
        if (metodo === 'DELETE') {
            await cerrarSesion(env, request);
            return ok({ mensaje: 'Sesion cerrada.' }, request, env);
        }
    }

    if (ruta === '/api/sesion/clave' && metodo === 'POST') {
        const sesion = await sesionActual(env, request);
        if (!sesion) return error('Sesion no valida o expirada.', 401, request, env);
        const datos = await cuerpoJSON(request);
        if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);
        return responder(await cambiarClave(env, request, sesion, datos));
    }

    // ── Autorizacion de descarga (afiliados) ────────────────────────
    if (ruta === '/api/descargas' && metodo === 'POST') {
        const sesion = await sesionActual(env, request);
        if (!sesion) return error('Inicie sesion para descargar este formato.', 401, request, env);

        const datos = await cuerpoJSON(request);
        if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);

        const formato = texto(datos.formato, 10).toLowerCase();
        if (!FORMATOS.includes(formato)) return error('Formato no reconocido.', 400, request, env);

        const p = permisos(sesion.afiliado);
        if (!p[formato]) {
            const motivo = sesion.afiliado.requiere_cambio_clave
                ? 'Debe cambiar su contrasena temporal antes de descargar.'
                : 'Su afiliacion no esta vigente. Renuevela en la sede del CAE-CH.';
            return error(motivo, 403, request, env, { requiere_cambio_clave: !!sesion.afiliado.requiere_cambio_clave });
        }

        const clave = texto(datos.clave_catastral, 60) || null;
        await env.DB.prepare(
            "INSERT INTO descargas (creado_en, formato, origen, afiliado_id, clave_catastral, ip_hash) VALUES (?, ?, 'afiliado', ?, ?, ?)"
        ).bind(
            ahora(), formato, sesion.afiliado.id, clave,
            await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
        ).run();

        return ok({ formato: formato, autorizado: true }, request, env);
    }

    // ── Freemium ────────────────────────────────────────────────────
    if (ruta === '/api/freemium/solicitar' && metodo === 'POST') {
        const datos = await cuerpoJSON(request);
        if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);
        return responder(await solicitarPase(env, request, datos));
    }

    if (ruta === '/api/freemium/verificar' && metodo === 'GET') {
        return verificarPase(env, request, url);   // devuelve una redireccion
    }

    if (ruta === '/api/freemium/consumir' && metodo === 'POST') {
        const datos = await cuerpoJSON(request);
        if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);
        return responder(await consumirPase(env, request, datos));
    }

    if (ruta === '/api/freemium/estado' && metodo === 'GET') {
        return ok(await estadoPase(env, url.searchParams.get('pase')), request, env);
    }

    // ── Administracion ──────────────────────────────────────────────
    if (ruta.startsWith('/api/admin/')) {
        const sesion = await sesionActual(env, request);
        if (!sesion) return error('Sesion no valida o expirada.', 401, request, env);
        if (sesion.afiliado.rol !== 'admin') {
            await registrarEvento(env, {
                tipo: 'admin_denegado', afiliado_id: sesion.afiliado.id, usuario: sesion.afiliado.usuario,
                detalle: metodo + ' ' + ruta,
                ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
            });
            return error('No tiene permisos de administracion.', 403, request, env);
        }

        if (ruta === '/api/admin/afiliados') {
            if (metodo === 'GET') return responder(await listarAfiliados(env));
            if (metodo === 'POST') {
                const datos = await cuerpoJSON(request);
                if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);
                return responder(await crearAfiliado(env, request, sesion, datos));
            }
        }

        const mClave = /^\/api\/admin\/afiliados\/([A-Za-z0-9_-]+)\/clave$/.exec(ruta);
        if (mClave && metodo === 'POST') {
            return responder(await restablecerClave(env, request, sesion, mClave[1]));
        }

        const mAfiliado = /^\/api\/admin\/afiliados\/([A-Za-z0-9_-]+)$/.exec(ruta);
        if (mAfiliado && metodo === 'PATCH') {
            const datos = await cuerpoJSON(request);
            if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);
            return responder(await actualizarAfiliado(env, request, sesion, mAfiliado[1], datos));
        }

        if (ruta === '/api/admin/descargas' && metodo === 'GET') return responder(await listarDescargas(env, url));
        if (ruta === '/api/admin/eventos'   && metodo === 'GET') return responder(await listarEventos(env, url));
        if (ruta === '/api/admin/pases'     && metodo === 'GET') return responder(await listarPases(env, url));
    }

    return null;
}
