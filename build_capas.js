// ─────────────────────────────────────────────────────────────────────────────
//  build_capas.js — un solo registro de capas para todo el sitio
//
//  Motivo: la capa 5 (telecomunicaciones) se abrio en el visor el 10/09/2026 y
//  la portada siguio anunciandola como "Proximamente"; el catastro decia
//  "mayo 2026" en el visor y "septiembre 2026" en la portada. Las dos listas se
//  escribian a mano, en archivos distintos, asi que se separaban solas.
//
//  Desde aqui manda "capas.json" y este script escribe:
//    · index.html    -> la rejilla de "Integracion de Datos Institucionales",
//                       entre los marcadores <!-- capas:inicio --> y <!-- capas:fin -->
//    · geovisor.html -> el pie de fuente de cada capa (#layer-N-source)
//
//  Uso:
//    node build_capas.js           escribe los dos archivos
//    node build_capas.js --check   no escribe: solo dice si estan al dia
//                                  (es lo que ejecuta test/capas.js)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');

const RAIZ     = __dirname;
const REGISTRO = path.join(RAIZ, 'capas.json');
const INDEX    = path.join(RAIZ, 'index.html');
const GEOVISOR = path.join(RAIZ, 'geovisor.html');

const MARCA_INICIO = '<!-- capas:inicio · generado por build_capas.js desde capas.json -->';
const MARCA_FIN    = '<!-- capas:fin -->';

// ── Utilidades ───────────────────────────────────────────────────────────────
function leerRegistro() {
    return JSON.parse(fs.readFileSync(REGISTRO, 'utf8'));
}

// Lee conservando BOM y finales de linea: estos dos HTML estan en CRLF y no
// tiene sentido que este script los reescriba enteros.
function leerHTML(archivo) {
    let texto = fs.readFileSync(archivo, 'utf8');
    const bom = texto.charCodeAt(0) === 0xFEFF;
    if (bom) texto = texto.slice(1);
    const crlf = texto.indexOf('\r\n') !== -1;
    return { texto: texto, bom: bom, crlf: crlf };
}

function escribirHTML(archivo, doc, textoNuevo) {
    fs.writeFileSync(archivo, (doc.bom ? '\uFEFF' : '') + textoNuevo, 'utf8');
}

function escapar(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// El texto de las tarjetas lleva rayas y comillas, pero nunca marcado: se
// escapa. Los colores del badge no: son literales de estilo del registro.
function badgeHTML(badge) {
    if (!badge) return '';
    return ' <span style="display:inline-block;background:' + badge.fondo +
           ';color:' + badge.color +
           ';font-size:11px;padding:1px 7px;border-radius:10px;margin-top:4px">' +
           escapar(badge.texto) + '</span>';
}

// ── 1. La rejilla de la portada ──────────────────────────────────────────────
function generarRejilla(registro, sangria) {
    const s = sangria;
    const lineas = [];

    registro.fuentes.forEach(function (f) {
        if (!f.tarjeta) return;                       // capa del visor sin tarjeta
        const t      = f.tarjeta;
        const ids    = f.visor.map(function (c) { return c.id; }).join(',');
        const clases = 'integration-item' + (t.proximamente ? ' proximamente' : '');
        const estilo = t.acento ? ' style="border-top:3px solid ' + t.acento + ';"' : '';
        const icono  = t.acento ? ' style="color:' + t.acento + '"' : '';

        if (t.proximamente) {
            // Sin enlace: todavia no hay nada que abrir en el visor.
            lineas.push(s + '<div class="' + clases + '"' + estilo + '>');
            lineas.push(s + '    <div class="integration-icon"' + icono + '><i class="' + t.icono + '"></i></div>');
            lineas.push(s + '    <h3>' + escapar(t.titulo) + '</h3>');
            lineas.push(s + '    <p>' + escapar(t.texto) + badgeHTML(t.badge) + '</p>');
            lineas.push(s + '    <span class="badge-prox">Próximamente</span>');
            lineas.push(s + '</div>');
            return;
        }

        lineas.push(s + '<a class="' + clases + '" href="geovisor.html?capa=' + ids + '"' + estilo + '>');
        lineas.push(s + '    <div class="integration-icon"' + icono + '><i class="' + t.icono + '"></i></div>');
        lineas.push(s + '    <h3>' + escapar(t.titulo) + '</h3>');
        lineas.push(s + '    <p>' + escapar(t.texto) + badgeHTML(t.badge) + '</p>');
        lineas.push(s + '    <span class="integration-link">Ver en el mapa <i class="fas fa-arrow-right"></i></span>');
        lineas.push(s + '</a>');
    });

    return lineas.join('\n');
}

function aplicarIndex(registro, doc) {
    const i = doc.texto.indexOf(MARCA_INICIO);
    const j = doc.texto.indexOf(MARCA_FIN);
    if (i === -1 || j === -1 || j < i) {
        throw new Error('index.html no tiene los marcadores de capas (' + MARCA_INICIO + ').');
    }
    // Sangria: los espacios que preceden al marcador de inicio.
    const inicioLinea = doc.texto.lastIndexOf('\n', i) + 1;
    const sangria     = doc.texto.slice(inicioLinea, i);
    const salto       = doc.crlf ? '\r\n' : '\n';
    const rejilla     = generarRejilla(registro, sangria).split('\n').join(salto);

    return doc.texto.slice(0, i + MARCA_INICIO.length) +
           salto + rejilla + salto + sangria +
           doc.texto.slice(j);
}

// ── 2. El pie de fuente de cada capa del visor ───────────────────────────────
function aplicarGeovisor(registro, doc) {
    let texto = doc.texto;

    registro.fuentes.forEach(function (f) {
        f.visor.forEach(function (capa) {
            const re = new RegExp(
                '(<div class="layer-source" id="layer-' + capa.id + '-source">)([\\s\\S]*?)(</div>)');
            if (!re.test(texto)) {
                throw new Error('geovisor.html no tiene #layer-' + capa.id + '-source.');
            }
            texto = texto.replace(re, function (_, abre, __, cierra) {
                return abre + escapar(capa.fuente) + cierra;
            });
        });
    });

    return texto;
}

// ── Orquestacion ─────────────────────────────────────────────────────────────
function construir() {
    const registro = leerRegistro();
    const docIndex = leerHTML(INDEX);
    const docVisor = leerHTML(GEOVISOR);
    return {
        registro: registro,
        archivos: [
            { ruta: INDEX,    doc: docIndex, nuevo: aplicarIndex(registro, docIndex) },
            { ruta: GEOVISOR, doc: docVisor, nuevo: aplicarGeovisor(registro, docVisor) }
        ]
    };
}

// Los archivos que NO estan al dia respecto de capas.json.
function desviados() {
    return construir().archivos
        .filter(function (a) { return a.nuevo !== a.doc.texto; })
        .map(function (a) { return path.basename(a.ruta); });
}

function main() {
    const soloComprobar = process.argv.includes('--check');
    const r = construir();
    const nCapas = r.registro.fuentes.reduce(function (n, f) { return n + f.visor.length; }, 0);
    const nCards = r.registro.fuentes.filter(function (f) { return !!f.tarjeta; }).length;

    let cambiados = 0;
    r.archivos.forEach(function (a) {
        const nombre = path.basename(a.ruta);
        if (a.nuevo === a.doc.texto) {
            console.log('  = ' + nombre + ' ya estaba al dia');
            return;
        }
        cambiados++;
        if (soloComprobar) {
            console.log('  ! ' + nombre + ' NO coincide con capas.json');
        } else {
            escribirHTML(a.ruta, a.doc, a.nuevo);
            console.log('  > ' + nombre + ' actualizado');
        }
    });

    console.log('\n  ' + nCapas + ' capas del visor, ' + nCards + ' tarjetas en la portada.');
    if (soloComprobar && cambiados > 0) {
        console.log('  Ejecute: node build_capas.js');
        process.exitCode = 1;
    }
}

if (require.main === module) main();

module.exports = { leerRegistro, generarRejilla, construir, desviados, RAIZ };
