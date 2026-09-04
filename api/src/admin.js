// ════════════════════════════════════════════════════════════════════
//  Panel de administracion: alta, baja y vigencia de los afiliados.
//
//  Las credenciales se entregan en mano (decision institucional), asi que
//  el alta devuelve UNA sola vez la clave temporal generada. No se guarda
//  en claro en ningun lado: si se pierde, se restablece.
// ════════════════════════════════════════════════════════════════════

import { generarId, generarClaveTemporal, hashearClave, hashIP } from './cripto.js';
import { ahora, texto, correoValido } from './http.js';
import { iteraciones, registrarEvento, perfilPublico, permisos } from './sesiones.js';

const ESTADOS = ['activo', 'suspendido', 'baja'];
const ROLES   = ['usuario', 'afiliado', 'admin'];

function usuarioValido(u) {
    return /^[a-z0-9](?:[a-z0-9._-]{2,29})$/.test(u);
}

async function contarAdminsActivos(env, excluyendoId) {
    const fila = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM afiliados WHERE rol = 'admin' AND estado = 'activo' AND id != ?"
    ).bind(excluyendoId || '').first();
    return fila ? fila.n : 0;
}

// ── Listado ─────────────────────────────────────────────────────────

export async function listarAfiliados(env) {
    const { results } = await env.DB.prepare(
        'SELECT * FROM afiliados ORDER BY estado, nombre COLLATE NOCASE'
    ).all();
    const afiliados = (results || []).map(f => Object.assign(perfilPublico(f), {
        permisos: permisos(f),
        creado_en: f.creado_en,
        bloqueado: !!(f.bloqueado_hasta && new Date(f.bloqueado_hasta) > new Date())
    }));
    return { estado: 200, cuerpo: { ok: true, total: afiliados.length, afiliados: afiliados } };
}

// ── Alta ────────────────────────────────────────────────────────────

export async function crearAfiliado(env, request, sesion, datos) {
    const nombre  = texto(datos.nombre, 120);
    const usuario = texto(datos.usuario, 30).toLowerCase();
    const correo  = texto(datos.correo, 254).toLowerCase();
    const rol     = ROLES.includes(datos.rol) ? datos.rol : 'afiliado';
    const registro = texto(datos.registro_profesional, 40) || null;
    const nucleo   = texto(datos.nucleo, 60) || 'Chimborazo';
    const vigencia = datos.vigencia_hasta ? texto(datos.vigencia_hasta, 30) : null;

    if (nombre.length < 3)      return malo('Indique el nombre completo del afiliado.');
    if (!usuarioValido(usuario)) return malo('El usuario debe tener entre 3 y 30 caracteres: minusculas, numeros, punto, guion o guion bajo.');
    if (!correoValido(correo))   return malo('El correo no tiene un formato valido.');
    if (vigencia && Number.isNaN(Date.parse(vigencia))) return malo('La fecha de vigencia no es valida (use AAAA-MM-DD).');

    const choque = await env.DB.prepare(
        'SELECT usuario, correo FROM afiliados WHERE usuario = ? OR correo = ? LIMIT 1'
    ).bind(usuario, correo).first();
    if (choque) {
        return malo(choque.usuario === usuario
            ? 'Ya existe un afiliado con ese usuario.'
            : 'Ya existe un afiliado con ese correo.', 409);
    }

    const id = generarId('afi');
    const claveTemporal = generarClaveTemporal();
    const hash = await hashearClave(claveTemporal, iteraciones(env));
    const t = ahora();

    await env.DB.prepare(
        'INSERT INTO afiliados (id, usuario, correo, nombre, registro_profesional, nucleo, rol, origen, estado, ' +
        ' hash_clave, requiere_cambio_clave, correo_verificado, verificado_en, vigencia_hasta, creado_en, actualizado_en) ' +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', 'activo', ?, 1, 1, ?, ?, ?, ?)"
    ).bind(id, usuario, correo, nombre, registro, nucleo, rol, hash, t,
            vigencia ? new Date(vigencia).toISOString() : null, t, t).run();

    await registrarEvento(env, {
        tipo: 'afiliado_creado', afiliado_id: id, usuario: usuario,
        detalle: 'alta por ' + sesion.afiliado.usuario,
        ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
    });

    const fila = await env.DB.prepare('SELECT * FROM afiliados WHERE id = ?').bind(id).first();
    return {
        estado: 201,
        cuerpo: {
            ok: true,
            afiliado: perfilPublico(fila),
            // Se muestra una unica vez: anotela y entreguela en persona.
            clave_temporal: claveTemporal,
            aviso: 'Anote esta clave ahora: no vuelve a mostrarse. El afiliado debera cambiarla en su primer ingreso.'
        }
    };
}

// ── Modificacion ────────────────────────────────────────────────────

export async function actualizarAfiliado(env, request, sesion, id, datos) {
    const fila = await env.DB.prepare('SELECT * FROM afiliados WHERE id = ?').bind(id).first();
    if (!fila) return malo('Afiliado no encontrado.', 404);

    const campos = [];
    const valores = [];
    const cambios = [];

    if (typeof datos.nombre === 'string') {
        const nombre = texto(datos.nombre, 120);
        if (nombre.length < 3) return malo('El nombre es demasiado corto.');
        campos.push('nombre = ?'); valores.push(nombre); cambios.push('nombre');
    }
    if (typeof datos.correo === 'string') {
        const correo = texto(datos.correo, 254).toLowerCase();
        if (!correoValido(correo)) return malo('El correo no tiene un formato valido.');
        const choque = await env.DB.prepare('SELECT id FROM afiliados WHERE correo = ? AND id != ?').bind(correo, id).first();
        if (choque) return malo('Ese correo ya pertenece a otro afiliado.', 409);
        campos.push('correo = ?'); valores.push(correo); cambios.push('correo');
    }
    if (typeof datos.registro_profesional === 'string') {
        campos.push('registro_profesional = ?'); valores.push(texto(datos.registro_profesional, 40) || null); cambios.push('registro');
    }
    if (datos.vigencia_hasta !== undefined) {
        const v = datos.vigencia_hasta;
        if (v === null || v === '') {
            campos.push('vigencia_hasta = ?'); valores.push(null); cambios.push('vigencia sin caducidad');
        } else {
            if (Number.isNaN(Date.parse(v))) return malo('La fecha de vigencia no es valida (use AAAA-MM-DD).');
            campos.push('vigencia_hasta = ?'); valores.push(new Date(v).toISOString()); cambios.push('vigencia');
        }
    }
    if (typeof datos.estado === 'string') {
        if (!ESTADOS.includes(datos.estado)) return malo('Estado no valido.');
        if (id === sesion.afiliado.id && datos.estado !== 'activo') {
            return malo('No puede desactivar su propia cuenta.');
        }
        if (fila.rol === 'admin' && datos.estado !== 'activo' && await contarAdminsActivos(env, id) === 0) {
            return malo('No puede dejar el sistema sin ningun administrador activo.');
        }
        campos.push('estado = ?'); valores.push(datos.estado); cambios.push('estado=' + datos.estado);
        if (datos.estado !== 'activo') {
            await env.DB.prepare('DELETE FROM sesiones WHERE afiliado_id = ?').bind(id).run();
        }
    }
    if (typeof datos.rol === 'string') {
        if (!ROLES.includes(datos.rol)) return malo('Rol no valido.');
        if (id === sesion.afiliado.id && datos.rol !== 'admin') {
            return malo('No puede quitarse a si mismo el rol de administrador.');
        }
        if (fila.rol === 'admin' && datos.rol !== 'admin' && await contarAdminsActivos(env, id) === 0) {
            return malo('No puede dejar el sistema sin ningun administrador activo.');
        }
        campos.push('rol = ?'); valores.push(datos.rol); cambios.push('rol=' + datos.rol);
    }
    if (datos.desbloquear === true) {
        campos.push('intentos_fallidos = 0', 'bloqueado_hasta = NULL'); cambios.push('desbloqueo');
    }

    if (!campos.length) return malo('No se indico ningun cambio.');

    campos.push('actualizado_en = ?'); valores.push(ahora());
    valores.push(id);
    await env.DB.prepare('UPDATE afiliados SET ' + campos.join(', ') + ' WHERE id = ?').bind(...valores).run();

    await registrarEvento(env, {
        tipo: 'afiliado_actualizado', afiliado_id: id, usuario: fila.usuario,
        detalle: cambios.join(', ') + ' por ' + sesion.afiliado.usuario,
        ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
    });

    const nuevo = await env.DB.prepare('SELECT * FROM afiliados WHERE id = ?').bind(id).first();
    return { estado: 200, cuerpo: { ok: true, afiliado: perfilPublico(nuevo), cambios: cambios } };
}

// ── Restablecer clave ───────────────────────────────────────────────

export async function restablecerClave(env, request, sesion, id) {
    const fila = await env.DB.prepare('SELECT * FROM afiliados WHERE id = ?').bind(id).first();
    if (!fila) return malo('Afiliado no encontrado.', 404);

    const claveTemporal = generarClaveTemporal();
    const hash = await hashearClave(claveTemporal, iteraciones(env));

    await env.DB.prepare(
        'UPDATE afiliados SET hash_clave = ?, requiere_cambio_clave = 1, intentos_fallidos = 0, ' +
        ' bloqueado_hasta = NULL, actualizado_en = ? WHERE id = ?'
    ).bind(hash, ahora(), id).run();
    await env.DB.prepare('DELETE FROM sesiones WHERE afiliado_id = ?').bind(id).run();

    await registrarEvento(env, {
        tipo: 'clave_restablecida', afiliado_id: id, usuario: fila.usuario,
        detalle: 'por ' + sesion.afiliado.usuario,
        ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
    });

    return {
        estado: 200,
        cuerpo: {
            ok: true,
            usuario: fila.usuario,
            clave_temporal: claveTemporal,
            aviso: 'Entreguela en persona. Sus sesiones abiertas fueron cerradas.'
        }
    };
}

// ── Bitacora ────────────────────────────────────────────────────────

export async function listarDescargas(env, url) {
    const limite = Math.min(parseInt(url.searchParams.get('limite'), 10) || 100, 500);
    const { results } = await env.DB.prepare(
        'SELECT d.id, d.creado_en, d.formato, d.origen, d.clave_catastral, ' +
        '       a.usuario, a.nombre, p.correo AS correo_freemium ' +
        '  FROM descargas d ' +
        '  LEFT JOIN afiliados a ON a.id = d.afiliado_id ' +
        '  LEFT JOIN pases_freemium p ON p.id = d.pase_id ' +
        ' ORDER BY d.creado_en DESC LIMIT ?'
    ).bind(limite).all();

    const resumen = await env.DB.prepare(
        'SELECT formato, origen, COUNT(*) AS n FROM descargas GROUP BY formato, origen'
    ).all();

    return { estado: 200, cuerpo: { ok: true, descargas: results || [], resumen: resumen.results || [] } };
}

export async function listarEventos(env, url) {
    const limite = Math.min(parseInt(url.searchParams.get('limite'), 10) || 100, 500);
    const { results } = await env.DB.prepare(
        'SELECT id, creado_en, tipo, usuario, detalle FROM eventos ORDER BY creado_en DESC LIMIT ?'
    ).bind(limite).all();
    return { estado: 200, cuerpo: { ok: true, eventos: results || [] } };
}

export async function listarPases(env, url) {
    const limite = Math.min(parseInt(url.searchParams.get('limite'), 10) || 100, 500);
    const { results } = await env.DB.prepare(
        'SELECT id, correo, creado_en, verificado_en, consumido_en, clave_catastral, reenvios ' +
        '  FROM pases_freemium ORDER BY creado_en DESC LIMIT ?'
    ).bind(limite).all();
    return { estado: 200, cuerpo: { ok: true, pases: results || [] } };
}

function malo(mensaje, estado) {
    return { estado: estado || 400, cuerpo: { ok: false, error: mensaje } };
}
