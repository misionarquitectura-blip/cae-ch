// ─────────────────────────────────────────────────────────────────────────────
//  Puente: el servidor local, dentro del navegador
//
//  La interfaz (app.js) habla con el motor por HTTP: /api/analizar,
//  /api/exportar/pdf, etc. En la web no hay servidor que responda, pero el
//  motor entero ya esta aqui —planimetria-web/nucleo.js, que es lib/ sin
//  tocar—, asi que este archivo intercepta esas llamadas y las resuelve en la
//  misma pagina.
//
//  Gracias a eso `app.js` es EL MISMO archivo en las dos versiones: no hay una
//  interfaz de escritorio y otra web que se vayan separando con los meses.
//
//  Lo unico que aqui se hace distinto del servidor:
//    · las capas se bajan por fetch y se siembran con `ingerir()`, en vez de
//      leerse del disco;
//    · el nucleo geometrico recibe el texto de geovisor.html por `fijarFuente`;
//    · el logo del PDF y pdf.js llegan por CDN.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const P = window.Planimetria;
    if (!P) throw new Error('Falta planimetria-web/nucleo.js');

    // La pagina vive en la raiz del sitio; las capas y el visor, tambien.
    const RAIZ = new URL('.', location.href).href;

    const VERSION = '0.7.0-web';
    const ARRANCADO = new Date().toISOString();

    let config = null, manifiesto = null, capas = null;
    let preparando = null, fuente = null;

    // Quien quiera enterarse del avance de la descarga se suscribe aqui.
    const oyentes = [];
    const avisar = (texto, hecho, total) => oyentes.forEach(f => { try { f(texto, hecho, total); } catch (e) { } });

    // ── Descarga y siembra de capas ──────────────────────────────────────────

    async function json(url) {
        const r = await fetch(url, { cache: 'force-cache' });
        if (!r.ok) throw new Error('No se pudo bajar ' + url.split('/').pop() + ' (' + r.status + ')');
        return r.json();
    }

    /**
     * El nucleo geometrico sale del propio geovisor.html, igual que en
     * escritorio: la planimetria y el DICAT miden con el mismo codigo.
     *
     * Hay que hacerlo ANTES de tocar ningun otro modulo: `capas.js` llama a
     * `cargarNucleo()` en su cuerpo, y `analisis`, `lamina`, `dxf` y `pdf`
     * acaban dependiendo de el. Sin la fuente puesta, el primer `require`
     * revienta buscando un archivo que en el navegador no existe.
     */
    function cargarFuente() {
        if (fuente) return fuente;
        fuente = (async () => {
            avisar('Leyendo el núcleo del GeoVisor…', 0, 1);
            const r = await fetch(RAIZ + 'geovisor.html', { cache: 'force-cache' });
            if (!r.ok) throw new Error('No se pudo leer geovisor.html (' + r.status + ')');
            P.nucleo.fijarFuente(await r.text());
        })().catch(e => { fuente = null; throw e; });
        return fuente;
    }

    /**
     * Baja todo lo que el analisis puede llegar a tocar y lo siembra. Tiene que
     * ser ANTES del analisis y no durante: `consultar()` es sincrono hasta el
     * fondo, y volverlo asincrono seria reescribir el motor. Como el navegador
     * guarda los archivos en su cache, esto se paga una sola vez.
     */
    function preparar() {
        if (preparando) return preparando;
        preparando = (async () => {
            await cargarFuente();
            config = await json(RAIZ + 'planimetria-web/config.json');
            manifiesto = await json(RAIZ + 'DATA SET/planimetria/manifiesto.json');
            capas = P.capas.crearCapasWeb(config, id => RAIZ + ((manifiesto.capas[id] || {}).url || ''));

            const ids = Object.keys(manifiesto.capas);
            let hecho = 0;
            for (const id of ids) {
                const info = manifiesto.capas[id];
                avisar('Bajando ' + id.replace(/^el_/, '') + '…', hecho, ids.length);
                const fc = await json(RAIZ + info.url);
                capas[id.startsWith('el_') ? 'el:' + id.slice(3) : id]
                    .ingerir(fc, info.url.split('/').pop().replace(/\.geojson$/, ''));
                avisar('Bajando ' + id.replace(/^el_/, '') + '…', ++hecho, ids.length);
            }
            avisar('Listo', ids.length, ids.length);
            return capas;
        })().catch(e => { preparando = null; throw e; });
        return preparando;
    }

    // ── Sustitutos de Buffer para lo que llega del usuario ───────────────────

    function deBase64(b64) {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return u8;
    }

    /**
     * Lo justo para que `decodificar()` funcione igual que en Node. El latin1
     * se hace a mano —byte a carácter— porque TextDecoder no trae ISO-8859-1
     * puro: el que ofrece es windows-1252, que difiere justo en el tramo
     * 0x80-0x9F donde los DXF viejos guardan comillas y guiones.
     */
    function comoBuffer(u8) {
        return {
            length: u8.length,
            toString(codificacion) {
                if (codificacion === 'latin1' || codificacion === 'binary') {
                    let s = '';
                    for (let i = 0; i < u8.length; i += 8192) {
                        s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
                    }
                    return s;
                }
                return new TextDecoder('utf-8').decode(u8);
            }
        };
    }

    // ── Rutas ────────────────────────────────────────────────────────────────

    const nombreArchivo = (datos, ext) => {
        const base = String((datos && (datos.propietario || datos.claveCatastral)) || 'predio')
            .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_')
            .replace(/^_|_$/g, '').slice(0, 40) || 'predio';
        return 'PLANIMETRIA_' + base + '_' + new Date().toISOString().slice(0, 10) + '.' + ext;
    };

    // Mismo trato que en servidor.js: un proyecto analizado con una version
    // anterior no trae el entorno del mapa de ubicacion, y se rehace aqui.
    async function validarProyecto(p) {
        if (!p || !p.analisis || !Array.isArray(p.analisis.vertices)) throw new Error('Primero analice el predio.');
        const d = p.datos || {};
        if (d.ubicacion !== false && p.analisis.contexto && !p.analisis.contexto.ubicacion
            && Array.isArray(p.analisis.centroide)) {
            try { p.analisis.contexto.ubicacion = P.analisis.entornoUbicacion(p.analisis.centroide, await preparar(), config); }
            catch (e) { console.warn('No se pudo rehacer el entorno de ubicacion:', e.message); }
        }
        p.conciliacion = p.registral
            ? P.conciliacion.conciliar(p.analisis, p.registral, p.opcionesConciliacion || {}, config)
            : null;
    }

    const rutas = {
        'GET /api/estado': async () => {
            if (!config) {
                config = await json(RAIZ + 'planimetria-web/config.json');
                manifiesto = await json(RAIZ + 'DATA SET/planimetria/manifiesto.json');
            }
            const hay = id => !!manifiesto.capas[id];
            return {
                capas: Object.fromEntries(['catastro', 'lineas_fabrica', 'pugs', 'parroquias', 'limite_urbano']
                    .map(k => [k, {
                        disponible: hay(k),
                        cargada: !!(capas && capas[k] && capas[k].features),
                        elementos: capas && capas[k] && capas[k].features ? capas[k].features.length : null
                    }])),
                certificadas: { generado: manifiesto.generado, capas: manifiesto.capas },
                version: VERSION,
                arrancado: ARRANCADO,
                tolerancias: config.tolerancias,
                conciliacion: config.conciliacion,
                elementos: config.elementos.map(e => ({
                    id: e.id, nombre: e.nombre, grupo: e.grupo, margen_m: e.margen_m,
                    verificado: e.verificado, base_legal: e.base_legal, disponible: hay('el_' + e.id)
                })),
                informe: config.informe
            };
        },

        'POST /api/leer': async c => {
            if (!c.contenido && !c.base64) throw new Error('No se recibio el contenido del archivo.');
            const bytes = c.base64 ? deBase64(c.base64) : new TextEncoder().encode(c.contenido);
            const { texto, esDXF } = P.entrada.decodificar(comoBuffer(bytes), c.nombre);
            return esDXF ? P.entrada.leerDXF(texto) : P.entrada.leerCSV(texto);
        },

        'POST /api/registral': async c => {
            if (!c.base64) throw new Error('No se recibio el PDF del certificado.');
            return P.registral.leerCertificado(deBase64(c.base64));
        },

        'POST /api/conciliar': async c => {
            if (!c.analisis || !c.registral) throw new Error('Faltan el analisis o la informacion registral.');
            if (!config) await rutas['GET /api/estado']();
            return P.conciliacion.conciliar(c.analisis, c.registral, c.opciones || {}, config);
        },

        'POST /api/normalizar': async c => {
            if (!Array.isArray(c.puntos)) throw new Error('Faltan los puntos del poligono.');
            if (!config) await rutas['GET /api/estado']();
            const t = config.tolerancias || {};
            return P.entrada.normalizarPoligono(c.puntos, {
                inicio: c.inicio, tolDuplicado: t.vertice_duplicado_m, ladoMinimo: t.lado_minimo_m
            });
        },

        'POST /api/analizar': async c => {
            if (!Array.isArray(c.vertices) || c.vertices.length < 3) throw new Error('El poligono necesita al menos 3 vertices.');
            const cp = await preparar();
            const t0 = Date.now();
            const r = await P.analisis.analizar(c.vertices, c.opciones || {}, cp, config);
            r.ms = Date.now() - t0;
            return r;
        },

        'GET /api/catastro': async (_c, url) => {
            const b = String(url.searchParams.get('bbox') || '').split(',').map(Number);
            if (!b.every(isFinite) || b.length !== 4 || (b[2] - b[0]) * (b[3] - b[1]) > 4e6) {
                return { type: 'FeatureCollection', features: [] };
            }
            const cp = await preparar();
            const fs2 = cp.catastro.consultar(b, 0).slice(0, 4000);
            return {
                type: 'FeatureCollection',
                features: fs2.map(f => ({
                    type: 'Feature',
                    properties: { clave: String(f.props.claves || '').trim(), nombre: f.props.gis_predio || f.props.nombre_c || '' },
                    geometry: P.capas.geojsonWGS84(f)
                }))
            };
        }
    };

    async function exportar(tipo, proyecto) {
        await validarProyecto(proyecto);
        if (tipo === 'dxf') {
            return {
                cuerpo: new Blob([P.dxf.construirDXFPlanimetria(proyecto)], { type: 'application/dxf' }),
                nombre: nombreArchivo(proyecto.datos, 'dxf')
            };
        }
        return {
            cuerpo: new Blob([P.pdf.construirPDF(proyecto)], { type: 'application/pdf' }),
            nombre: nombreArchivo(proyecto.datos, 'pdf')
        };
    }

    // ── Interceptor ──────────────────────────────────────────────────────────

    const fetchReal = window.fetch.bind(window);

    window.fetch = async function (recurso, opciones) {
        const crudo = typeof recurso === 'string' ? recurso : (recurso && recurso.url) || '';
        if (crudo.indexOf('/api/') !== 0) return fetchReal(recurso, opciones);

        const url = new URL(crudo, location.href);
        const metodo = ((opciones && opciones.method) || 'GET').toUpperCase();
        const clave = metodo + ' ' + url.pathname;

        try {
            const cuerpo = opciones && opciones.body ? JSON.parse(opciones.body) : {};

            const exp = /^\/api\/exportar\/(dxf|pdf)$/.exec(url.pathname);
            if (exp && metodo === 'POST') {
                const r = await exportar(exp[1], cuerpo);
                return new Response(r.cuerpo, {
                    status: 200,
                    headers: { 'Content-Disposition': 'attachment; filename="' + r.nombre + '"' }
                });
            }

            const fn = rutas[clave];
            if (!fn) return new Response(JSON.stringify({ error: 'Ruta no encontrada.' }), { status: 404 });

            const datos = await fn(cuerpo, url);
            return new Response(JSON.stringify(datos), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        } catch (e) {
            console.error('[planimetria]', clave, e);
            return new Response(JSON.stringify({ error: e.message || String(e) }), {
                status: 500, headers: { 'Content-Type': 'application/json' }
            });
        }
    };

    // ── Piezas que en Node salian del disco ──────────────────────────────────

    window.PlanimetriaPuente = {
        version: VERSION,
        preparar: preparar,
        alAvanzar: f => oyentes.push(f),

        /**
         * pdf.js llega como modulo ES, o sea que aparece DESPUES de esta
         * linea. Por eso se conecta aparte y se puede llamar en cualquier
         * momento: solo hace falta cuando alguien sube un certificado.
         */
        conectarPDFJS(lib, base) {
            const l = lib || window.pdfjsLib;
            if (!l) return false;
            const cdn = base || 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
            try { l.GlobalWorkerOptions.workerSrc = cdn + 'build/pdf.worker.min.mjs'; } catch (e) { }
            P.registral.fijarPDFJS(l, cdn + 'standard_fonts/');
            return true;
        },

        /** El logo del informe, que aqui llega por red. */
        async inicializar() {
            await cargarFuente();
            this.conectarPDFJS();
            // El try cubre solo la descarga: si envolviera tambien la llamada
            // a fijarLogo, un fallo al cargar el modulo pdf se disfrazaria de
            // "no hay logo" y el informe saldria mal sin que nadie se entere.
            let dataURL = '';
            try {
                const r = await fetch(RAIZ + 'LOGO/logo-caech.png', { cache: 'force-cache' });
                const b = await r.blob();
                dataURL = await new Promise(res => {
                    const fr = new FileReader();
                    fr.onload = () => res(fr.result);
                    fr.readAsDataURL(b);
                });
            } catch (e) { console.warn('[planimetria] sin logo para el informe:', e.message); }
            P.pdf.fijarLogo(dataURL);
        }
    };
}());
