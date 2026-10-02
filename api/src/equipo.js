// ════════════════════════════════════════════════════════════════════
//  Declaracion del equipo de levantamiento (planimetria).
//
//  La planimetria es gratis para toda cuenta, pero solo con datos de
//  equipo de alta precision (convenio, 2026-10-01): receptor GNSS RTK,
//  estacion total, escaner LiDAR 3D u ortofoto verificada de 4 cm/px o
//  mejor. Quien la usa declara marca, modelo y numero de serie y asume la
//  responsabilidad por los datos que carga. Sin esa declaracion la puerta
//  de la planimetria no se abre.
//
//  La vigente es la ultima de cada cuenta; las anteriores se conservan
//  como constancia. Si cambia el texto de responsabilidad se sube
//  VERSION_DECLARACION y todas las cuentas vuelven a declarar.
// ════════════════════════════════════════════════════════════════════

import { hashIP } from './cripto.js';
import { ahora, texto } from './http.js';
import { registrarEvento } from './sesiones.js';

export const VERSION_DECLARACION = '2026-10-02';

export const TIPOS_EQUIPO = {
    gnss_rtk:       'Receptor GNSS RTK',
    estacion_total: 'Estacion total',
    lidar:          'Escaner laser LiDAR 3D',
    ortofoto:       'Ortofoto verificada (4 cm/px o mejor)'
};

const GSD_MAXIMO_CM = 4;

/** Ultima declaracion vigente de la cuenta, o null. */
export async function declaracionVigente(env, afiliadoId) {
    const fila = await env.DB.prepare(
        'SELECT * FROM declaraciones_equipo WHERE afiliado_id = ? ORDER BY id DESC LIMIT 1'
    ).bind(afiliadoId).first();
    return fila && fila.texto_version === VERSION_DECLARACION ? fila : null;
}

function vista(f) {
    if (!f) return null;
    return {
        tipo: f.tipo, tipo_nombre: TIPOS_EQUIPO[f.tipo] || f.tipo,
        marca: f.marca, modelo: f.modelo, serie: f.serie, gsd_cm: f.gsd_cm,
        version: f.texto_version, declarado_en: f.creado_en
    };
}

export async function leerDeclaracion(env, sesion) {
    return {
        estado: 200,
        cuerpo: {
            ok: true,
            declaracion: vista(await declaracionVigente(env, sesion.afiliado.id)),
            version: VERSION_DECLARACION,
            tipos: TIPOS_EQUIPO
        }
    };
}

export async function declararEquipo(env, request, sesion, datos) {
    const fila = sesion.afiliado;
    const tipo = texto(datos.tipo, 30);
    const marca = texto(datos.marca, 60);
    const modelo = texto(datos.modelo, 60);
    const serie = texto(datos.serie, 60);
    const malo = m => ({ estado: 400, cuerpo: { ok: false, error: m } });

    if (!TIPOS_EQUIPO[tipo]) return malo('Elija el tipo de equipo.');
    if (marca.length < 2 || modelo.length < 1) return malo('Indique la marca y el modelo del equipo.');
    if (serie.length < 3) return malo('Indique el numero de serie del equipo.');

    let gsd = null;
    if (tipo === 'ortofoto') {
        gsd = parseFloat(String(datos.gsd_cm || '').replace(',', '.'));
        if (!Number.isFinite(gsd) || gsd <= 0) return malo('Indique la resolucion verificada de la ortofoto en cm/px.');
        if (gsd > GSD_MAXIMO_CM) {
            return malo('La ortofoto debe tener ' + GSD_MAXIMO_CM + ' cm/px o mejor. Con ' + gsd
                + ' cm/px no alcanza la precision que exige la planimetria.');
        }
    }
    if (datos.acepta_responsabilidad !== true) {
        return malo('Debe aceptar la declaracion de responsabilidad sobre los datos del levantamiento.');
    }

    await env.DB.prepare(
        'INSERT INTO declaraciones_equipo (afiliado_id, tipo, marca, modelo, serie, gsd_cm, texto_version, creado_en, ip_hash) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(fila.id, tipo, marca, modelo, serie, gsd, VERSION_DECLARACION, ahora(),
           await hashIP(request.headers.get('CF-Connecting-IP'), env.PIMIENTA)).run();

    await registrarEvento(env, {
        tipo: 'equipo_declarado', afiliado_id: fila.id, usuario: fila.usuario,
        detalle: TIPOS_EQUIPO[tipo] + ' ' + marca + ' ' + modelo + ' serie ' + serie
    });

    return leerDeclaracion(env, sesion).then(r => Object.assign(r, { estado: 201 }));
}
