// ─────────────────────────────────────────────────────────────────────────────
//  Registro de capas (capas.json) — que la portada y el visor digan lo mismo
//
//  El 10/09/2026 se abrio la capa 5 (telecomunicaciones) en el visor y la
//  portada siguio anunciandola como "Proximamente"; el catastro decia "mayo
//  2026" en un archivo y "septiembre 2026" en el otro. Eran dos listas escritas
//  a mano que se separaban solas. Ahora manda "capas.json" y "build_capas.js"
//  escribe los dos HTML; esta prueba es la que impide que vuelvan a divergir.
//
//  Comprueba cuatro cosas:
//    1. index.html y geovisor.html coinciden con capas.json (si no, hay que
//       ejecutar "node build_capas.js"; nadie deberia editar esos bloques).
//    2. Cada capa del registro existe de verdad en el visor y esta habilitada.
//    3. Cada tarjeta de la portada enlaza al visor con capas que existen.
//    4. Toda capa declara la institucion que la publica — que es justo lo que
//       la portada le promete al lector.
//
//  Ejecutar:  node test/capas.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');
const H    = require('./lib/harness');

const build    = require(path.join(H.RAIZ, 'build_capas.js'));
const registro = build.leerRegistro();
const index    = fs.readFileSync(path.join(H.RAIZ, 'index.html'), 'utf8');
const visor    = fs.readFileSync(path.join(H.RAIZ, 'geovisor.html'), 'utf8');

console.log('REGISTRO DE CAPAS — capas.json contra los dos HTML\n');

// ═════════════════════════════════════════════════════════════════════════════
//  1. Los HTML estan al dia
// ═════════════════════════════════════════════════════════════════════════════
console.log('1. Sincronia con capas.json');

const sueltos = build.desviados();
H.chequear('index.html y geovisor.html salen de capas.json',
    sueltos.length === 0,
    sueltos.length ? 'desviados: ' + sueltos.join(', ') + ' — ejecute: node build_capas.js' : '');

// ═════════════════════════════════════════════════════════════════════════════
//  2. Las capas del registro existen en el visor
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n2. Cada capa del registro existe en el visor');

const capas = [];
registro.fuentes.forEach(function (f) {
    f.visor.forEach(function (c) { capas.push({ fuente: f, capa: c }); });
});

function casilla(id) {
    const re = new RegExp('<input[^>]*id="layer-' + id + '"[^>]*>');
    const m  = visor.match(re);
    return m ? m[0] : null;
}

capas.forEach(function (par) {
    const cb = casilla(par.capa.id);
    H.chequear('capa ' + par.capa.id + ' (' + par.capa.nombre + ') tiene casilla en el visor',
        cb !== null);
    H.chequear('capa ' + par.capa.id + ' no esta deshabilitada',
        cb !== null && !/disabled/.test(cb));
    H.chequear('capa ' + par.capa.id + ' imprime su fuente en el visor',
        visor.indexOf('id="layer-' + par.capa.id + '-source">' + par.capa.fuente + '</div>') !== -1);
});

const ids = capas.map(function (p) { return p.capa.id; });
H.chequear('no hay ids de capa repetidos en el registro',
    new Set(ids).size === ids.length, ids.join(', '));

// ═════════════════════════════════════════════════════════════════════════════
//  3. Las tarjetas de la portada llevan a capas reales
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n3. Las tarjetas de la portada abren el visor');

const tarjetas = registro.fuentes.filter(function (f) { return !!f.tarjeta; });
H.chequear('la portada tiene tarjetas', tarjetas.length > 0);

tarjetas.forEach(function (f) {
    const t    = f.tarjeta;
    const enl  = 'geovisor.html?capa=' + f.visor.map(function (c) { return c.id; }).join(',');
    const viva = !t.proximamente;

    if (viva) {
        H.chequear('«' + t.titulo + '» enlaza a ' + enl,
            index.indexOf('href="' + enl + '"') !== -1);
        // La regresion de septiembre de 2026: capa abierta, tarjeta apagada.
        H.chequear('«' + t.titulo + '» no queda marcada como Próximamente',
            index.indexOf('<h3>' + t.titulo + '</h3>') !== -1 &&
            index.indexOf('proximamente" href="' + enl) === -1);
    } else {
        H.chequear('«' + t.titulo + '» esta pendiente y no enlaza al visor',
            index.indexOf('href="' + enl + '"') === -1);
    }

    H.chequear('«' + t.titulo + '» aparece una sola vez en la portada',
        index.split('<h3>' + t.titulo + '</h3>').length === 2);
});

// ═════════════════════════════════════════════════════════════════════════════
//  4. Toda capa declara quien la publica
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n4. Procedencia declarada');

capas.forEach(function (par) {
    H.chequear('capa ' + par.capa.id + ' declara institucion',
        typeof par.capa.fuente === 'string' && par.capa.fuente.trim().length >= 4,
        par.capa.fuente);
});

// Esto es lo que la portada le promete al lector en la tarjeta de
// interoperabilidad; si deja de ser cierto, hay que quitar la frase.
H.chequear('la portada solo promete lo que el registro cumple',
    index.indexOf('Cada capa declara la institución que la publica') !== -1);
H.chequear('la portada no promete sincronizacion en tiempo real',
    index.indexOf('Sincronización en tiempo real') === -1);

H.resumen('REGISTRO DE CAPAS');
