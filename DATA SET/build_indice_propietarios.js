// Genera el indice de propietarios que usa la busqueda por nombre de la
// pestana «Solicitudes» del panel:
//
//   DATA SET/capas/Catastro GADMR.geojson  ->  DATA SET/capas/indice_propietarios.json
//
// POR QUE UN INDICE Y NO LA CAPA. El mostrador necesita pasar de «el senor
// dice llamarse Lema Guaraca» a una clave catastral de 27 digitos. El
// GeoVisor resuelve eso recorriendo la capa que ya tiene cargada, pero esa
// capa son 43 MB de geometria: pedirselos al panel solo para rellenar un
// campo de un formulario no tiene sentido. Aqui se queda lo unico que hace
// falta para buscar -nombre, clave, clave auxiliar y superficie- sin un solo
// par de coordenadas, y el panel lo carga una vez, la primera vez que
// alguien escribe en la caja de busqueda.
//
// NO ANADE INFORMACION PUBLICA NUEVA. Es un extracto de la misma capa que
// el sitio ya publica y que el visor descarga entero a quien abra el mapa; la
// busqueda por nombre del propietario ya existe ahi y es publica por decision
// expresa (ver legal.html, privacidad punto 5). Lo que cambia es el peso, no
// el alcance.
//
// SE EJECUTA SOLO: build_catastro.js lo llama al terminar, para que el indice
// no pueda quedarse atras del catastro. Tambien se puede correr a mano:
//
//   node "DATA SET/build_indice_propietarios.js"

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RAIZ    = path.join(__dirname, 'capas');
const ENTRADA = path.join(RAIZ, 'Catastro GADMR.geojson');
const SALIDA  = path.join(RAIZ, 'indice_propietarios.json');

if (!fs.existsSync(ENTRADA)) {
    console.error('No se encuentra ' + ENTRADA);
    process.exit(1);
}

console.log('\nIndice de propietarios');
console.log('  Leyendo ' + path.basename(ENTRADA) + ' …');

const capa = JSON.parse(fs.readFileSync(ENTRADA, 'utf8'));

const stats = { total: capa.features.length, sinClave: 0, sinNombre: 0, escritos: 0 };
const porNombre = new Map();

for (const f of capa.features) {
    const p = f.properties || {};

    // El mismo orden de preferencia que usa el buscador del visor: primero el
    // nombre de la base grafica, y si viene vacio el de la alfanumerica.
    const nombre = ((p.gis_predio || '').trim() || (p.nombre_c || '').trim());
    const clave  = (p.claves || '').trim();

    if (!clave)  { stats.sinClave++;  continue; }
    if (!nombre) { stats.sinNombre++; continue; }

    const aux = (p.claves_aux || '').trim();
    // La auxiliar casi siempre es el prefijo de 18 digitos de la clave; solo
    // se guarda cuando NO lo es, que son unos 5.000 predios. Ver el punto 3
    // de la cabecera de build_catastro.js: no se puede derivar.
    const auxPropia = (aux && aux !== clave.slice(0, 18)) ? aux : '';

    // La superficie es lo unico que distingue a simple vista dos predios del
    // mismo titular cuando el mostrador tiene que elegir.
    const area = Math.round(parseFloat(p.sup_pred_c) || 0);

    if (!porNombre.has(nombre)) porNombre.set(nombre, []);
    porNombre.get(nombre).push(auxPropia ? [clave, area, auxPropia] : [clave, area]);
    stats.escritos++;
}

// Agrupado por nombre y ordenado alfabeticamente: el panel busca sobre esta
// lista tal cual, y asi los predios de un mismo titular salen juntos sin que
// tenga que reagruparlos.
const datos = [...porNombre.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'es'))
    .map(([nombre, predios]) => [nombre, predios]);

const salida = {
    _lea_esto: [
        'Indice de busqueda por propietario de la pestana Solicitudes del panel.',
        'NO SE EDITA A MANO: lo genera DATA SET/build_indice_propietarios.js,',
        'que build_catastro.js llama al terminar de regenerar la capa.',
        'Formato de "datos": [nombre, [[clave, superficie_m2, clave_auxiliar?], ...]].',
        'La clave auxiliar solo aparece cuando no es el prefijo de 18 digitos de la clave.'
    ],
    generado: new Date().toISOString().slice(0, 10),
    propietarios: datos.length,
    predios: stats.escritos,
    datos: datos
};

fs.writeFileSync(SALIDA, JSON.stringify(salida));

const bytes = fs.statSync(SALIDA).size;
const comprimido = zlib.gzipSync(fs.readFileSync(SALIDA)).length;

console.log('  Predios en la capa : ' + stats.total);
console.log('  Indexados          : ' + stats.escritos);
console.log('  Propietarios       : ' + datos.length);
console.log('  Sin clave          : ' + stats.sinClave);
console.log('  Sin propietario    : ' + stats.sinNombre);
console.log('\n  ' + path.basename(SALIDA) + ' — ' + (bytes / 1048576).toFixed(1) + ' MB'
          + ' (' + (comprimido / 1048576).toFixed(1) + ' MB servidos con gzip)');
