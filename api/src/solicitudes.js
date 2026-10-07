// ════════════════════════════════════════════════════════════════════
//  Solicitudes presenciales del DICAT
//
//  La via principal del reporte es la persona que se acerca a la sede.
//  Esto es la hoja de ese mostrador: correlativo institucional por ano,
//  la misma lista desde cualquier equipo y constancia de las dos
//  clausulas que el solicitante firma en papel.
//
//  Todo lo de aqui es solo para administradores: index.js ya corta el
//  paso antes de llamar a estas funciones.
//
//  La validacion se repite entera en el servidor aunque el panel ya la
//  haga. Lo del navegador es cortesia para quien escribe; lo que decide
//  que entra en la base es esto.
// ════════════════════════════════════════════════════════════════════

import { generarId, hashIP } from './cripto.js';
import { ahora, texto, correoValido } from './http.js';
import { registrarEvento, VERSION_TERMINOS } from './sesiones.js';

const DOCUMENTOS = ['cedula', 'ruc', 'pasaporte'];
const ESTADOS    = ['recibida', 'entregada', 'anulada'];

const CALIDADES = [
    'Propietario/a', 'Copropietario/a', 'Apoderado/a o autorizado/a',
    'Profesional a cargo', 'Posible comprador/a', 'Otra'
];

const ENTREGAS = [
    'PDF al correo', 'Impreso', 'Impreso con firma y sello',
    'PDF firmado electronicamente', 'En memoria USB'
];

// ── Validadores ─────────────────────────────────────────────────────

const soloDigitos = t => String(t || '').replace(/\D+/g, '');

/** Cedula ecuatoriana: modulo 10 sobre los nueve primeros digitos. */
export function cedulaValida(c) {
    if (!/^\d{10}$/.test(c)) return false;
    const prov = parseInt(c.slice(0, 2), 10);
    if ((prov < 1 || prov > 24) && prov !== 30) return false;
    if (parseInt(c[2], 10) > 5) return false;
    let suma = 0;
    for (let i = 0; i < 9; i++) {
        const v = parseInt(c[i], 10) * (i % 2 === 0 ? 2 : 1);
        suma += v > 9 ? v - 9 : v;
    }
    return (10 - (suma % 10)) % 10 === parseInt(c[9], 10);
}

/**
 * RUC: 13 digitos. El de persona natural es la cedula mas el numero de
 * establecimiento; los de sociedad (tercer digito 9) y sector publico
 * (tercer digito 6) llevan su propio verificador, modulo 11.
 */
export function rucValido(r) {
    if (!/^\d{13}$/.test(r)) return false;
    if (r.slice(10) === '000') return false;
    const tercero = parseInt(r[2], 10);
    if (tercero < 6) return cedulaValida(r.slice(0, 10));

    let coef, corte;
    if (tercero === 6)      { coef = [3, 2, 7, 6, 5, 4, 3, 2];    corte = 8; }
    else if (tercero === 9) { coef = [4, 3, 2, 7, 6, 5, 4, 3, 2]; corte = 9; }
    else return false;

    let suma = 0;
    for (let i = 0; i < corte; i++) suma += parseInt(r[i], 10) * coef[i];
    const resto = suma % 11;
    return (resto === 0 ? 0 : 11 - resto) === parseInt(r[corte], 10);
}

/** Celular 09……… (10 digitos) o fijo con codigo provincial (9). */
export function telefonoValido(t) {
    let d = soloDigitos(t);
    if (d.startsWith('593')) d = '0' + d.slice(3);
    return /^09\d{8}$/.test(d) || /^0[2-7]\d{7}$/.test(d);
}

const fechaCortaValida = f => /^\d{4}-\d{2}-\d{2}$/.test(f) && !Number.isNaN(Date.parse(f));

// ── Numeracion ──────────────────────────────────────────────────────

/**
 * DICAT-AAAA-NNNN, correlativo por ano sobre toda la institucion.
 *
 * El mayor se busca en DOS sitios: la tabla y la bitacora de seguridad.
 * La tabla sola no basta, porque una solicitud se puede borrar -el derecho
 * de eliminacion de la LOPDP- y entonces su numero volveria a salir; si ese
 * numero ya se habia impreso y firmado, dos papeles distintos dirian lo
 * mismo. `eventos` no se borra nunca y guarda el numero de cada alta, asi
 * que hace de marca de agua: un numero usado no vuelve, haya o no fila.
 *
 * Dos altas simultaneas si podrian calcular el mismo numero; el UNIQUE de
 * `numero` lo impide y `crearSolicitud` reintenta una vez.
 */
async function siguienteNumero(env) {
    const prefijo = 'DICAT-' + new Date().getFullYear() + '-';

    const enTabla = await env.DB.prepare(
        'SELECT numero FROM solicitudes_dicat WHERE numero LIKE ? ORDER BY numero DESC LIMIT 1'
    ).bind(prefijo + '%').first();

    // El detalle del evento de alta empieza por el numero: «DICAT-2026-0001 · predio …».
    const enBitacora = await env.DB.prepare(
        "SELECT MAX(substr(detalle, 1, ?)) AS numero FROM eventos " +
        " WHERE tipo = 'solicitud_dicat_creada' AND detalle LIKE ?"
    ).bind(prefijo.length + 4, prefijo + '%').first();

    const leer = fila => {
        if (!fila || !fila.numero) return 0;
        const n = parseInt(String(fila.numero).slice(prefijo.length), 10);
        return Number.isFinite(n) ? n : 0;
    };

    const ultimo = Math.max(leer(enTabla), leer(enBitacora));
    return prefijo + String(ultimo + 1).padStart(4, '0');
}

// ── Lectura ─────────────────────────────────────────────────────────

/**
 * @param {URL} url  ?estado=recibida|entregada|anulada, ?q=<texto>, ?limite=
 *        `q` busca por numero, nombre, documento, clave y direccion: lo que
 *        se tiene a mano cuando alguien vuelve a preguntar por su tramite.
 */
export async function listarSolicitudes(env, url) {
    const limite = Math.min(parseInt(url.searchParams.get('limite'), 10) || 200, 500);
    const estado = url.searchParams.get('estado');
    const q      = texto(url.searchParams.get('q'), 80);

    const filtros = [];
    const enlaces = [];
    if (ESTADOS.includes(estado)) {
        filtros.push('estado = ?');
        enlaces.push(estado);
    }
    if (q) {
        const aguja = '%' + q + '%';
        filtros.push('(numero LIKE ? OR solicitante LIKE ? OR documento LIKE ?'
                   + ' OR clave_catastral LIKE ? OR direccion LIKE ?)');
        enlaces.push(aguja, aguja, aguja, aguja, aguja);
    }
    enlaces.push(limite);

    const sql = 'SELECT * FROM solicitudes_dicat'
              + (filtros.length ? ' WHERE ' + filtros.join(' AND ') : '')
              + ' ORDER BY creado_en DESC LIMIT ?';

    const { results } = await env.DB.prepare(sql).bind(...enlaces).all();

    const resumen = await env.DB.prepare(
        'SELECT estado, COUNT(*) AS n FROM solicitudes_dicat GROUP BY estado'
    ).all();

    return {
        estado: 200,
        cuerpo: {
            ok: true,
            solicitudes: results || [],
            resumen: resumen.results || [],
            siguiente_numero: await siguienteNumero(env)
        }
    };
}

// ── Alta ────────────────────────────────────────────────────────────

/** Toma del cuerpo solo lo que la tabla conoce, ya recortado. */
function leerCampos(datos) {
    return {
        solicitante:          texto(datos.solicitante, 120),
        documento_tipo:       DOCUMENTOS.includes(datos.documento_tipo) ? datos.documento_tipo : '',
        documento:            texto(datos.documento, 20).toUpperCase(),
        telefono:             texto(datos.telefono, 25),
        correo:               texto(datos.correo, 254).toLowerCase() || null,
        registro_profesional: texto(datos.registro_profesional, 40).toUpperCase() || null,
        calidad:              texto(datos.calidad, 60),
        clave_catastral:      soloDigitos(datos.clave_catastral),
        clave_auxiliar:       soloDigitos(datos.clave_auxiliar) || null,
        direccion:            texto(datos.direccion, 200),
        parroquia:            texto(datos.parroquia, 60) || null,
        barrio:               texto(datos.barrio, 80) || null,
        propietario_catastro: texto(datos.propietario_catastro, 160) || null,
        entrega:              texto(datos.entrega, 60),
        ejemplares:           Math.min(Math.max(parseInt(datos.ejemplares, 10) || 1, 1), 20),
        finalidad:            texto(datos.finalidad, 60) || null,
        entrega_ofrecida:     texto(datos.entrega_ofrecida, 10) || null,
        observaciones:        texto(datos.observaciones, 1000) || null
    };
}

function revisar(c, datos, esAlta) {
    if (c.solicitante.length < 5)  return 'Indique nombres y apellidos del solicitante.';
    if (!c.documento_tipo)         return 'Indique el tipo de documento (cedula, RUC o pasaporte).';

    const d = soloDigitos(c.documento);
    if (c.documento_tipo === 'cedula' && !cedulaValida(d))  return 'La cedula no es valida: el digito verificador no cuadra.';
    if (c.documento_tipo === 'ruc'    && !rucValido(d))     return 'El RUC no es valido.';
    if (c.documento_tipo === 'pasaporte' && c.documento.length < 5) return 'El numero de pasaporte es demasiado corto.';

    if (!telefonoValido(c.telefono)) return 'El telefono no parece un celular ni un fijo del pais.';
    if (c.correo && !correoValido(c.correo)) return 'El correo no tiene un formato valido.';

    // La entrega en PDF sin correo deja el tramite sin salida: se corta aqui.
    if (c.entrega.startsWith('PDF') && !c.correo) {
        return 'La entrega elegida es en PDF: hace falta el correo del solicitante.';
    }

    if (!c.calidad) return 'Indique en que calidad solicita.';
    if (!c.entrega) return 'Indique la forma de entrega.';

    // La clave catastral del GADMR es casi siempre de 27 digitos, pero no
    // siempre: en el catastro de octubre de 2026, 66.571 predios la tienen de
    // 27 y 1.363 no -1.314 de ellos de 15 digitos-, un 2 % del padron. Exigir
    // 27 dejaba fuera a uno de cada cincuenta predios reales, asi que aqui
    // solo se comprueba que sean digitos y que el largo sea plausible; que
    // sea LA clave del predio se ve en el visor, no contandole las cifras.
    if (!/^\d{10,30}$/.test(c.clave_catastral)) {
        return 'La clave catastral debe ser un numero de entre 10 y 30 digitos.';
    }
    // La auxiliar NO tiene largo fijo. Es un identificador historico del
    // GADMR que la vista de publicacion ya no expone y que se arrastra de la
    // capa anterior: en el catastro de octubre de 2026 hay 32.431 de 18
    // digitos, 1.949 de 27, 537 de 15 y colas de casi todos los largos entre
    // 1 y 27. Exigir 18 rechazaba predios legitimos.
    if (c.clave_auxiliar && c.clave_auxiliar.length > 27) return 'La clave auxiliar no puede pasar de 27 digitos.';
    if (c.direccion.length < 5) return 'Indique la direccion o una referencia del predio.';
    if (c.entrega_ofrecida && !fechaCortaValida(c.entrega_ofrecida)) return 'La fecha ofrecida no es valida (use AAAA-MM-DD).';

    // Las dos constancias se exigen SOLO al dar de alta: una solicitud ya
    // guardada se firmo en su momento y corregir un telefono no vuelve a
    // pedir la firma.
    if (esAlta && !(datos.consentimiento_datos === true && datos.consentimiento_alcance === true)) {
        return 'El solicitante debe aceptar las dos constancias antes de registrar la solicitud.';
    }
    return null;
}

export async function crearSolicitud(env, request, sesion, datos) {
    const c = leerCampos(datos);
    const falla = revisar(c, datos, true);
    if (falla) return malo(falla);

    const atendido = texto(datos.atendido_por, 120) || sesion.afiliado.nombre || sesion.afiliado.usuario;
    const recibida = texto(datos.recibida_en, 40);
    const t = ahora();
    const ip = await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA);

    // Dos intentos: el segundo cubre la carrera de dos altas a la vez, que
    // el UNIQUE de `numero` rechaza.
    for (let intento = 0; intento < 2; intento++) {
        const id = generarId('sol');
        const numero = await siguienteNumero(env);
        try {
            await env.DB.prepare(
                'INSERT INTO solicitudes_dicat (' +
                ' id, numero, creado_en, actualizado_en, recibida_en,' +
                ' solicitante, documento_tipo, documento, telefono, correo,' +
                ' registro_profesional, calidad, clave_catastral, clave_auxiliar,' +
                ' direccion, parroquia, barrio, propietario_catastro,' +
                ' entrega, ejemplares, finalidad, entrega_ofrecida, observaciones,' +
                ' consentimiento_datos, consentimiento_alcance, texto_version,' +
                ' estado, atendido_por, registrada_por, ip_hash' +
                ') VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?, 1,1,?, ?,?,?,?)'
            ).bind(
                id, numero, t, t, (recibida && !Number.isNaN(Date.parse(recibida))) ? recibida : t,
                c.solicitante, c.documento_tipo, c.documento, c.telefono, c.correo,
                c.registro_profesional, c.calidad, c.clave_catastral, c.clave_auxiliar,
                c.direccion, c.parroquia, c.barrio, c.propietario_catastro,
                c.entrega, c.ejemplares, c.finalidad, c.entrega_ofrecida, c.observaciones,
                VERSION_TERMINOS,
                'recibida', atendido, sesion.afiliado.id, ip
            ).run();
        } catch (e) {
            if (intento === 0 && /UNIQUE/i.test(String(e && e.message))) continue;
            throw e;
        }

        // En la bitacora de seguridad va el numero y el predio, nunca el
        // nombre ni el documento del ciudadano: esa tabla se consulta por
        // otros motivos y no tiene por que arrastrarlos.
        await registrarEvento(env, {
            tipo: 'solicitud_dicat_creada',
            afiliado_id: sesion.afiliado.id,
            usuario: sesion.afiliado.usuario,
            detalle: numero + ' · predio ' + c.clave_catastral,
            ip_hash: ip
        });

        const fila = await env.DB.prepare('SELECT * FROM solicitudes_dicat WHERE id = ?').bind(id).first();
        return { estado: 201, cuerpo: { ok: true, solicitud: fila } };
    }

    return malo('No se pudo asignar un numero de solicitud. Intentelo otra vez.', 409);
}

// ── Modificacion ────────────────────────────────────────────────────

export async function actualizarSolicitud(env, request, sesion, id, datos) {
    const fila = await env.DB.prepare('SELECT * FROM solicitudes_dicat WHERE id = ?').bind(id).first();
    if (!fila) return malo('Solicitud no encontrada.', 404);

    // Cambio de estado a secas: es la accion de un clic en la tabla.
    if (Object.keys(datos).length === 1 && typeof datos.estado === 'string') {
        if (!ESTADOS.includes(datos.estado)) return malo('Estado no valido.');
        const t = ahora();
        await env.DB.prepare(
            'UPDATE solicitudes_dicat SET estado = ?, entregada_en = ?, actualizado_en = ? WHERE id = ?'
        ).bind(datos.estado, datos.estado === 'entregada' ? t : null, t, id).run();

        await registrarEvento(env, {
            tipo: 'solicitud_dicat_estado',
            afiliado_id: sesion.afiliado.id, usuario: sesion.afiliado.usuario,
            detalle: fila.numero + ' → ' + datos.estado,
            ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
        });
        const nueva = await env.DB.prepare('SELECT * FROM solicitudes_dicat WHERE id = ?').bind(id).first();
        return { estado: 200, cuerpo: { ok: true, solicitud: nueva } };
    }

    // Correccion completa de la hoja.
    const c = leerCampos(datos);
    const falla = revisar(c, datos, false);
    if (falla) return malo(falla);

    const estado = ESTADOS.includes(datos.estado) ? datos.estado : fila.estado;
    const atendido = texto(datos.atendido_por, 120) || fila.atendido_por;
    const t = ahora();

    await env.DB.prepare(
        'UPDATE solicitudes_dicat SET' +
        ' solicitante = ?, documento_tipo = ?, documento = ?, telefono = ?, correo = ?,' +
        ' registro_profesional = ?, calidad = ?, clave_catastral = ?, clave_auxiliar = ?,' +
        ' direccion = ?, parroquia = ?, barrio = ?, propietario_catastro = ?,' +
        ' entrega = ?, ejemplares = ?, finalidad = ?, entrega_ofrecida = ?, observaciones = ?,' +
        ' estado = ?, entregada_en = ?, atendido_por = ?, actualizado_en = ?' +
        ' WHERE id = ?'
    ).bind(
        c.solicitante, c.documento_tipo, c.documento, c.telefono, c.correo,
        c.registro_profesional, c.calidad, c.clave_catastral, c.clave_auxiliar,
        c.direccion, c.parroquia, c.barrio, c.propietario_catastro,
        c.entrega, c.ejemplares, c.finalidad, c.entrega_ofrecida, c.observaciones,
        estado, estado === 'entregada' ? (fila.entregada_en || t) : null, atendido, t,
        id
    ).run();

    await registrarEvento(env, {
        tipo: 'solicitud_dicat_corregida',
        afiliado_id: sesion.afiliado.id, usuario: sesion.afiliado.usuario,
        detalle: fila.numero,
        ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
    });

    const nueva = await env.DB.prepare('SELECT * FROM solicitudes_dicat WHERE id = ?').bind(id).first();
    return { estado: 200, cuerpo: { ok: true, solicitud: nueva } };
}

// ── Borrado ─────────────────────────────────────────────────────────

/**
 * Borra la fila de verdad. No es un `estado = 'anulada'` disfrazado: la
 * LOPDP reconoce el derecho de eliminacion y el titular de estos datos no
 * tiene cuenta con la que ejercerlo por si mismo, asi que lo ejerce la
 * administracion en su nombre. Queda el rastro en `eventos`, con el numero
 * de la solicitud y sin un solo dato personal.
 */
export async function eliminarSolicitud(env, request, sesion, id) {
    const fila = await env.DB.prepare('SELECT numero FROM solicitudes_dicat WHERE id = ?').bind(id).first();
    if (!fila) return malo('Solicitud no encontrada.', 404);

    await env.DB.prepare('DELETE FROM solicitudes_dicat WHERE id = ?').bind(id).run();
    await registrarEvento(env, {
        tipo: 'solicitud_dicat_borrada',
        afiliado_id: sesion.afiliado.id, usuario: sesion.afiliado.usuario,
        detalle: fila.numero,
        ip_hash: await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)
    });
    return { estado: 200, cuerpo: { ok: true, numero: fila.numero } };
}

// ── Catalogos, para que el panel no los repita ──────────────────────

export const CATALOGO = { calidades: CALIDADES, entregas: ENTREGAS, documentos: DOCUMENTOS, estados: ESTADOS };

function malo(mensaje, estado) {
    return { estado: estado || 400, cuerpo: { ok: false, error: mensaje } };
}
