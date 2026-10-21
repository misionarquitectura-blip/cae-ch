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

/**
 * Lo que entra a PBKDF2. Con pimienta, la clave pasa antes por un
 * HMAC-SHA256 con un secreto del Worker (PIMIENTA_CLAVES) que no vive en
 * la base: una copia filtrada de D1 sola no sirve para probar claves fuera
 * de linea, por bajas que sean las iteraciones que permite el plan
 * gratuito. Sin pimienta, la clave tal cual (formato historico).
 */
async function entrada(clave, pimienta) {
    const bytes = new TextEncoder().encode(clave);
    if (!pimienta) return bytes;
    const llave = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(pimienta), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', llave, bytes));
}

async function derivar(clave, salt, iteraciones, pimienta) {
    const material = await crypto.subtle.importKey(
        'raw', await entrada(clave, pimienta), 'PBKDF2', false, ['deriveBits']
    );
    return crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iteraciones },
        material, 256
    );
}

const FORMATO      = 'pbkdf2-sha256';    // historico: sin pimienta
const FORMATO_PIM  = 'pbkdf2p-sha256';   // con pimienta (HMAC previo)

/**
 * Devuelve `pbkdf2p-sha256$<iter>$<salt_b64>$<hash_b64>` con pimienta, o
 * `pbkdf2-sha256$...` sin ella (el script de alta del admin, que corre
 * fuera del Worker y no conoce el secreto).
 */
export async function hashearClave(clave, iteraciones = ITERACIONES_POR_DEFECTO, pimienta) {
    const iter = Number(iteraciones) || ITERACIONES_POR_DEFECTO;
    const salt = aleatorio(16);
    const bits = await derivar(clave, salt, iter, pimienta);
    return `${pimienta ? FORMATO_PIM : FORMATO}$${iter}$${b64.codificar(salt)}$${b64.codificar(bits)}`;
}

/**
 * Verifica una clave contra su hash almacenado. Compara en tiempo constante
 * y respeta las iteraciones grabadas en el propio hash, de modo que subir
 * HASH_ITERACIONES no invalida las cuentas ya creadas. Acepta los dos
 * formatos; el de pimienta solo verifica si el Worker tiene el secreto.
 */
export async function verificarClave(clave, almacenado, pimienta) {
    if (typeof almacenado !== 'string') return false;
    const partes = almacenado.split('$');
    if (partes.length !== 4) return false;
    const conPimienta = partes[0] === FORMATO_PIM;
    if (!conPimienta && partes[0] !== FORMATO) return false;
    if (conPimienta && !pimienta) return false;

    const iter = parseInt(partes[1], 10);
    if (!Number.isFinite(iter) || iter < 1000) return false;

    let salt, esperado;
    try {
        salt = b64.decodificar(partes[2]);
        esperado = b64.decodificar(partes[3]);
    } catch (e) { return false; }

    const bits = new Uint8Array(await derivar(clave, salt, iter, conPimienta ? pimienta : null));
    return comparacionConstante(bits, esperado);
}

/**
 * True si el hash fue creado con menos iteraciones de las vigentes, o sin
 * pimienta habiendo ya una: el ingreso correcto lo rehace al formato nuevo.
 */
export function requiereRehash(almacenado, iteracionesVigentes, pimienta) {
    const partes = String(almacenado).split('$');
    const iter = parseInt(partes[1], 10);
    if (pimienta && partes[0] !== FORMATO_PIM) return true;
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

/**
 * Folio de un producto descargado: `DICAT-AAAA-XXXX-XXXX`. Ocho simbolos
 * del mismo alfabeto sin ambiguos (40 bits): se lee en voz alta y se copia
 * de un papel, y no se adivina uno valido probando. El ano es el de Ecuador.
 */
export function generarFolio(ms) {
    const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const chars = Array.from(aleatorio(8), b => alfabeto[b % alfabeto.length]).join('');
    const ano = new Date((ms || Date.now()) - 5 * 3600000).getUTCFullYear();
    return `DICAT-${ano}-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export { ITERACIONES_POR_DEFECTO };
