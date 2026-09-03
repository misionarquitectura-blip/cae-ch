// ════════════════════════════════════════════════════════════════════
//  Primitivas criptograficas sobre WebCrypto (disponible en Workers).
//
//  Coste medido de PBKDF2-SHA256 (mismo motor nativo):
//     50 000 iteraciones ->  ~6 ms      100 000 -> ~12 ms
//    210 000 iteraciones -> ~24 ms      600 000 -> ~69 ms
//  El plan gratuito de Workers corta en 10 ms de CPU por invocacion, asi
//  que HASH_ITERACIONES es configurable. Ver README.
// ════════════════════════════════════════════════════════════════════

const ITERACIONES_POR_DEFECTO = 210000;

const b64 = {
    codificar(bytes) {
        let s = '';
        for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
        return btoa(s);
    },
    decodificar(texto) {
        const s = atob(texto);
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
    }
};

function aleatorio(bytes) {
    return crypto.getRandomValues(new Uint8Array(bytes));
}

/** Token opaco en base64url, apto para URL y cabecera Authorization. */
export function generarToken(bytes = 32) {
    return b64.codificar(aleatorio(bytes))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Identificador corto y legible para filas de la base. */
export function generarId(prefijo) {
    return `${prefijo}_${generarToken(12)}`;
}

export async function sha256(texto) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
    return b64.codificar(digest);
}

/** Hash de la IP con pimienta del entorno: permite contar sin guardar la IP. */
export async function hashIP(ip, pimienta) {
    if (!ip) return null;
    return sha256(`${pimienta || ''}:${ip}`);
}

async function derivar(clave, salt, iteraciones) {
    const material = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(clave), 'PBKDF2', false, ['deriveBits']
    );
    return crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iteraciones },
        material, 256
    );
}

/** Devuelve `pbkdf2-sha256$<iter>$<salt_b64>$<hash_b64>`. */
export async function hashearClave(clave, iteraciones = ITERACIONES_POR_DEFECTO) {
    const iter = Number(iteraciones) || ITERACIONES_POR_DEFECTO;
    const salt = aleatorio(16);
    const bits = await derivar(clave, salt, iter);
    return `pbkdf2-sha256$${iter}$${b64.codificar(salt)}$${b64.codificar(bits)}`;
}

/**
 * Verifica una clave contra su hash almacenado. Compara en tiempo constante
 * y respeta las iteraciones grabadas en el propio hash, de modo que subir
 * HASH_ITERACIONES no invalida las cuentas ya creadas.
 */
export async function verificarClave(clave, almacenado) {
    if (typeof almacenado !== 'string') return false;
    const partes = almacenado.split('$');
    if (partes.length !== 4 || partes[0] !== 'pbkdf2-sha256') return false;

    const iter = parseInt(partes[1], 10);
    if (!Number.isFinite(iter) || iter < 1000) return false;

    let salt, esperado;
    try {
        salt = b64.decodificar(partes[2]);
        esperado = b64.decodificar(partes[3]);
    } catch (e) { return false; }

    const bits = new Uint8Array(await derivar(clave, salt, iter));
    return comparacionConstante(bits, esperado);
}

/** True si el hash fue creado con menos iteraciones de las vigentes. */
export function requiereRehash(almacenado, iteracionesVigentes) {
    const iter = parseInt(String(almacenado).split('$')[1], 10);
    return Number.isFinite(iter) && iter < (Number(iteracionesVigentes) || ITERACIONES_POR_DEFECTO);
}

export function comparacionConstante(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

/**
 * Clave temporal legible para dictarla o anotarla en la entrega presencial.
 * Alfabeto sin caracteres ambiguos (0/O, 1/l/I). 5 grupos de 4 = ~103 bits.
 */
export function generarClaveTemporal() {
    const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = aleatorio(20);
    const chars = Array.from(bytes, b => alfabeto[b % alfabeto.length]);
    return [0, 4, 8, 12, 16].map(i => chars.slice(i, i + 4).join('')).join('-');
}

export { ITERACIONES_POR_DEFECTO };
