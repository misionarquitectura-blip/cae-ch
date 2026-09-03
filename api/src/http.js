// ════════════════════════════════════════════════════════════════════
//  Helpers HTTP: CORS con lista blanca de origenes y respuestas JSON.
// ════════════════════════════════════════════════════════════════════

/** Origenes permitidos: coma-separados en la variable ORIGENES_PERMITIDOS. */
function listaOrigenes(env) {
    return String(env.ORIGENES_PERMITIDOS || '')
        .split(',').map(s => s.trim()).filter(Boolean);
}

export function cabecerasCORS(request, env) {
    const origen = request.headers.get('Origin');
    const permitidos = listaOrigenes(env);
    const cabeceras = {
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
    };
    // Sin lista configurada no se abre a nadie: fallar cerrado, no abierto.
    if (origen && permitidos.includes(origen)) {
        cabeceras['Access-Control-Allow-Origin'] = origen;
    }
    return cabeceras;
}

export function json(datos, estado, request, env) {
    return new Response(JSON.stringify(datos), {
        status: estado || 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...cabecerasCORS(request, env)
        }
    });
}

export function error(mensaje, estado, request, env, extra) {
    return json({ ok: false, error: mensaje, ...(extra || {}) }, estado, request, env);
}

export function ok(datos, request, env) {
    return json({ ok: true, ...(datos || {}) }, 200, request, env);
}

export function preflight(request, env) {
    return new Response(null, { status: 204, headers: cabecerasCORS(request, env) });
}

/** IP del cliente segun el borde de Cloudflare. */
export function ipCliente(request) {
    return request.headers.get('CF-Connecting-IP') || null;
}

/** Lee y valida el cuerpo JSON; devuelve null si no es un objeto. */
export async function cuerpoJSON(request) {
    try {
        const datos = await request.json();
        return (datos && typeof datos === 'object' && !Array.isArray(datos)) ? datos : null;
    } catch (e) {
        return null;
    }
}

export function texto(valor, maximo) {
    if (typeof valor !== 'string') return '';
    return valor.trim().slice(0, maximo || 200);
}

export function correoValido(valor) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(valor) && valor.length <= 254;
}

export const ahora = () => new Date().toISOString();

export function enFuturo(minutos) {
    return new Date(Date.now() + minutos * 60000).toISOString();
}

export function vencido(iso) {
    return !iso || new Date(iso).getTime() <= Date.now();
}
