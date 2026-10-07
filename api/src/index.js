// ════════════════════════════════════════════════════════════════════
//  CAE-CH · API de afiliados  (Cloudflare Worker + D1)
//
//  Controla quien puede descargar los productos del GeoVisor. Desde el
//  2026-10-02 cualquiera crea cuenta y los productos de un predio -DICAT
//  en PDF, CSV y DXF- se habilitan por predio: libre para el admin, con
//  cupo mensual para el colegiado y con pago para el resto (cobros.js).
//  La planimetria es gratis para toda cuenta con el equipo declarado.
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
    iniciarSesion, cerrarSesion, sesionActual, cambiarClave, aceptarTerminos,
    perfilPublico, permisos, registrarEvento, HERRAMIENTAS
} from './sesiones.js';
import {
    listarAfiliados, crearAfiliado, actualizarAfiliado, restablecerClave,
    listarDescargas, listarEventos, listarPases
} from './admin.js';
import { solicitarPase, verificarPase, consumirPase, estadoPase } from './freemium.js';
import { registrar, verificarCorreo, reenviarVerificacion } from './registro.js';
import {
    autorizarPredio, estadoPredio, prepararPago, confirmarPago, resumenCuenta,
    listarPagos, habilitarPredioAdmin, eliminarPagosPreparados
} from './cobros.js';
import { declaracionVigente, leerDeclaracion, declararEquipo } from './equipo.js';
import {
    listarSolicitudes, crearSolicitud, actualizarSolicitud, eliminarSolicitud
} from './solicitudes.js';

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

    if (ruta === '/api/sesion/terminos' && metodo === 'POST') {
        const sesion = await sesionActual(env, request);
        if (!sesion) return error('Sesion no valida o expirada.', 401, request, env);
        const datos = await cuerpoJSON(request);
        if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);
        return responder(await aceptarTerminos(env, request, sesion, datos));
    }

    // ── Autorizacion de descarga (afiliados) ────────────────────────
    if (ruta === '/api/descargas' && metodo === 'POST') {
        const sesion = await sesionActual(env, request);
        if (!sesion) return error('Inicie sesion para descargar este formato.', 401, request, env);

        const datos = await cuerpoJSON(request);
        if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);

        const formato = texto(datos.formato, 10).toLowerCase();
        if (!FORMATOS.includes(formato)) return error('Formato no reconocido.', 400, request, env);

        const a = sesion.afiliado;
        const p = permisos(a);
        if (!p[formato]) {
            let motivo;
            if (a.requiere_cambio_clave) {
                motivo = 'Debe cambiar su contrasena temporal antes de descargar.';
            } else if (!a.correo_verificado) {
                motivo = 'Confirme su correo antes de descargar. Le enviamos el enlace al registrarse.';
            } else {
                motivo = 'Su cuenta no esta vigente. Comuniquese con la sede del CAE-CH.';
            }
            return error(motivo, 403, request, env, { requiere_cambio_clave: !!a.requiere_cambio_clave });
        }

        // El predio: libre, ya habilitado, con cupo, o 402 con el precio.
        const predio = await autorizarPredio(env, a, datos.clave_catastral);
        if (!predio.ok) return json(predio.cuerpo, predio.estado, request, env);

        const clave = predio.clave || texto(datos.clave_catastral, 60) || null;
        await env.DB.prepare(
            "INSERT INTO descargas (creado_en, formato, origen, afiliado_id, clave_catastral, ip_hash) VALUES (?, ?, 'afiliado', ?, ?, ?)"
        ).bind(
            ahora(), formato, sesion.afiliado.id, clave,
            await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
        ).run();

        return ok({
            formato: formato, autorizado: true, via: predio.via,
            vence_en: predio.vence_en || null, cupo: predio.cupo || null, predio_nuevo: !!predio.nuevo
        }, request, env);
    }

    // ── Puerta de las herramientas ──────────────────────────────────
    // Una sola puerta para lo que no es descarga: la planimetria hoy, lo
    // que venga manana. No pasa por `descargas` porque esa tabla lleva un
    // CHECK sobre los tres formatos; el uso queda en la bitacora.
    if (ruta === '/api/herramientas' && metodo === 'POST') {
        const sesion = await sesionActual(env, request);
        if (!sesion) return error('Inicie sesion para usar esta herramienta.', 401, request, env);

        const datos = await cuerpoJSON(request);
        if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);

        const herramienta = texto(datos.herramienta, 40).toLowerCase();
        if (!HERRAMIENTAS.includes(herramienta)) return error('Herramienta no reconocida.', 400, request, env);

        const a = sesion.afiliado;
        if (!permisos(a)[herramienta]) {
            return error(a.requiere_cambio_clave
                ? 'Debe cambiar su contrasena temporal antes de usar esta herramienta.'
                : 'Su cuenta no tiene habilitada esta herramienta. '
                  + 'La concede la administracion del CAE-CH, cuenta por cuenta.', 403, request, env, {
                herramienta: herramienta,
                requiere_cambio_clave: !!a.requiere_cambio_clave
            });
        }

        // La planimetria solo trabaja con equipo de alta precision declarado.
        if (herramienta === 'planimetria' && !await declaracionVigente(env, a.id)) {
            return error('Antes de usar la planimetria declare el equipo con que tomo el levantamiento.',
                403, request, env, { herramienta: herramienta, requiere_declaracion: true });
        }

        await registrarEvento(env, {
            tipo: 'herramienta_abierta', afiliado_id: a.id, usuario: a.usuario,
            detalle: herramienta,
            ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
        });
        return ok({ herramienta: herramienta, autorizado: true }, request, env);
    }

    // ── Predios, cupo y pagos ───────────────────────────────────────
    if (ruta === '/api/predios/estado' && metodo === 'GET') {
        const sesion = await sesionActual(env, request);
        if (!sesion) return error('Sesion no valida o expirada.', 401, request, env);
        return responder(await estadoPredio(env, sesion, url.searchParams.get('clave') || ''));
    }

    if (ruta === '/api/cuenta/cobros' && metodo === 'GET') {
        const sesion = await sesionActual(env, request);
        if (!sesion) return error('Sesion no valida o expirada.', 401, request, env);
        return responder(await resumenCuenta(env, sesion));
    }

    if (ruta === '/api/pagos' && metodo === 'POST') {
        const sesion = await sesionActual(env, request);
        if (!sesion) return error('Inicie sesion para pagar.', 401, request, env);
        const datos = await cuerpoJSON(request);
        if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);
        return responder(await prepararPago(env, request, sesion, datos));
    }

    if (ruta === '/api/pagos/confirmar' && metodo === 'POST') {
        const sesion = await sesionActual(env, request);
        if (!sesion) return error('Inicie sesion para confirmar el pago.', 401, request, env);
        const datos = await cuerpoJSON(request);
        if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);
        return responder(await confirmarPago(env, request, sesion, datos));
    }

    // ── Declaracion de equipo (planimetria) ─────────────────────────
    if (ruta === '/api/equipo') {
        const sesion = await sesionActual(env, request);
        if (!sesion) return error('Sesion no valida o expirada.', 401, request, env);
        if (metodo === 'GET') return responder(await leerDeclaracion(env, sesion));
        if (metodo === 'POST') {
            const datos = await cuerpoJSON(request);
            if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);
            return responder(await declararEquipo(env, request, sesion, datos));
        }
    }

    // ── Registro publico ────────────────────────────────────────────
    if (ruta === '/api/registro' && metodo === 'POST') {
        const datos = await cuerpoJSON(request);
        if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);
        return responder(await registrar(env, request, datos));
    }

    if (ruta === '/api/registro/verificar' && metodo === 'GET') {
        return verificarCorreo(env, request, url);   // devuelve una redireccion
    }

    if (ruta === '/api/registro/reenviar' && metodo === 'POST') {
        const datos = await cuerpoJSON(request);
        if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);
        return responder(await reenviarVerificacion(env, request, datos));
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
            // ?pendientes=1 devuelve la bandeja de numeros de registro por cotejar.
            if (metodo === 'GET') return responder(await listarAfiliados(env, url));
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

        // Habilitar un predio a mano (pago en sede, cortesia).
        const mPredio = /^\/api\/admin\/afiliados\/([A-Za-z0-9_-]+)\/predios$/.exec(ruta);
        if (mPredio && metodo === 'POST') {
            const datos = await cuerpoJSON(request);
            if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);
            return responder(await habilitarPredioAdmin(env, request, sesion, mPredio[1], datos));
        }

        // Solicitudes presenciales del DICAT: la hoja del mostrador de la sede.
        if (ruta === '/api/admin/solicitudes') {
            // ?estado=recibida|entregada|anulada, ?q=<texto>, ?limite=
            if (metodo === 'GET') return responder(await listarSolicitudes(env, url));
            if (metodo === 'POST') {
                const datos = await cuerpoJSON(request);
                if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);
                return responder(await crearSolicitud(env, request, sesion, datos));
            }
        }

        const mSolicitud = /^\/api\/admin\/solicitudes\/([A-Za-z0-9_-]+)$/.exec(ruta);
        if (mSolicitud && metodo === 'PATCH') {
            const datos = await cuerpoJSON(request);
            if (!datos) return error('Cuerpo JSON invalido.', 400, request, env);
            return responder(await actualizarSolicitud(env, request, sesion, mSolicitud[1], datos));
        }
        // Borrado real, no marcado: es el derecho de eliminacion de la LOPDP.
        if (mSolicitud && metodo === 'DELETE') {
            return responder(await eliminarSolicitud(env, request, sesion, mSolicitud[1]));
        }

        if (ruta === '/api/admin/pagos'     && metodo === 'GET') return responder(await listarPagos(env, url));

        // Escoba de pagos 'preparados' que nunca se ejecutaron. La ruta en
        // plural va ANTES que la de un id suelto, que si no se la comeria.
        if (ruta === '/api/admin/pagos/preparados' && metodo === 'DELETE') {
            return responder(await eliminarPagosPreparados(env, request, sesion, null));
        }
        const mPago = /^\/api\/admin\/pagos\/([A-Za-z0-9_-]+)$/.exec(ruta);
        if (mPago && metodo === 'DELETE') {
            return responder(await eliminarPagosPreparados(env, request, sesion, mPago[1]));
        }

        if (ruta === '/api/admin/descargas' && metodo === 'GET') return responder(await listarDescargas(env, url));
        if (ruta === '/api/admin/eventos'   && metodo === 'GET') return responder(await listarEventos(env, url));
        if (ruta === '/api/admin/pases'     && metodo === 'GET') return responder(await listarPases(env, url));
    }

    return null;
}
