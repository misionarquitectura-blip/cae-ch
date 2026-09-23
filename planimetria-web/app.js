// ─────────────────────────────────────────────────────────────────────────────
//  Planimetría CAE-Ch — interfaz
//  Todo el cálculo ocurre en el servidor local (lib/). Aquí solo se lee el
//  archivo, se muestra el resultado sobre el mapa y se recogen las ediciones
//  del profesional (colindantes, márgenes, datos del informe).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const $ = s => document.querySelector(s);
const fmt = (v, d = 2) => (v === null || v === undefined || !isFinite(v)) ? '-' :
    Number(v).toLocaleString('es-EC', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const estado = {
    config: null,
    nombreArchivo: '',
    lectura: null,          // respuesta de /api/leer
    codigos: new Set(),     // códigos de punto incluidos (CSV)
    candidato: 0,           // contorno elegido (DXF)
    normal: null,           // respuesta de /api/normalizar
    analisis: null,
    ediciones: {},          // colindantes editados, por coordenadas de los extremos del tramo
    cortes: [],             // vertices [x, y] donde el profesional parte un lindero
    propietarios: [],       // titulares: conyuges, herederos, donatarios, socios
    registral: null,        // informacion del titulo (certificado o a mano)
    conciliacion: null
};

// ── Utilidades de red y avisos ───────────────────────────────────────────────
async function api(ruta, cuerpo) {
    const r = await fetch(ruta, cuerpo === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo)
    });
    if (!r.ok) {
        let msg = r.statusText;
        try { msg = (await r.json()).error || msg; } catch (e) { }
        throw new Error(msg);
    }
    return r;
}
let _toast;
function aviso(texto, error) {
    const t = $('#toast');
    t.textContent = texto; t.className = 'toast' + (error ? ' error' : ''); t.hidden = false;
    clearTimeout(_toast); _toast = setTimeout(() => { t.hidden = true; }, error ? 8000 : 3500);
}
function ocupado(el, si) { el.classList.toggle('cargando', si); if (el.tagName === 'BUTTON') el.disabled = si; }

// ── Proyección UTM 17S → WGS84 (solo para dibujar; el cálculo va en el servidor) ─
function utmALatLng(E, N) {
    const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
    const x = E - 500000, y = N - 10000000, lon0 = -81 * Math.PI / 180;
    const M = y / k0, mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
        + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
    const N1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2), T1 = Math.tan(p1) ** 2, C1 = ep2 * Math.cos(p1) ** 2;
    const R1 = a * (1 - e2) / Math.pow(1 - e2 * Math.sin(p1) ** 2, 1.5), D = x / (N1 * k0);
    const lat = p1 - (N1 * Math.tan(p1) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
        + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
    const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(p1);
    return [lat * 180 / Math.PI, lon * 180 / Math.PI];
}
const ll = p => utmALatLng(p[0], p[1]);

// ── Mapa ─────────────────────────────────────────────────────────────────────
const mapa = L.map('mapa', { zoomControl: true, preferCanvas: true, maxZoom: 22 }).setView([-1.664, -78.654], 14);
const bases = {
    'Satélite (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 22, maxNativeZoom: 18, attribution: 'Esri, Maxar' }),
    'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 22, maxNativeZoom: 19, attribution: '© OpenStreetMap' })
};
bases['Satélite (Esri)'].addTo(mapa);
const capas = {
    catastro: L.layerGroup().addTo(mapa),
    contexto: L.layerGroup().addTo(mapa),
    afectaciones: L.layerGroup().addTo(mapa),
    predio: L.layerGroup().addTo(mapa),
    resalte: L.layerGroup().addTo(mapa)
};
L.control.layers(bases, {
    'Catastro GADMR': capas.catastro, 'Líneas de fábrica y elementos': capas.contexto,
    'Afectaciones': capas.afectaciones, 'Predio levantado': capas.predio
}, { collapsed: true }).addTo(mapa);
L.control.scale({ imperial: false }).addTo(mapa);

// Catastro de fondo cuando hay zoom suficiente
let _catTimer = null;
mapa.on('moveend', () => {
    clearTimeout(_catTimer);
    _catTimer = setTimeout(async () => {
        capas.catastro.clearLayers();
        if (mapa.getZoom() < 17 || !mapa.hasLayer(capas.catastro)) return;
        const b = mapa.getBounds();
        const sw = latLngAUTM(b.getSouth(), b.getWest()), ne = latLngAUTM(b.getNorth(), b.getEast());
        try {
            const fc = await (await api(`/api/catastro?bbox=${sw[0]},${sw[1]},${ne[0]},${ne[1]}`)).json();
            L.geoJSON(fc, {
                style: { color: '#FFFFFF', weight: 1, opacity: .75, fill: false },
                onEachFeature: (f, l) => l.bindTooltip(`${esc(f.properties.clave)}<br>${esc(f.properties.nombre)}`, { sticky: true })
            }).addTo(capas.catastro);
        } catch (e) { }
    }, 250);
});
function latLngAUTM(lat, lon) {
    // Solo para pedir el recuadro del catastro: basta con precisión métrica
    const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
    const phi = lat * Math.PI / 180, lam = lon * Math.PI / 180, lam0 = -81 * Math.PI / 180;
    const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2), T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * (lam - lam0);
    const M = a * ((1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256) * phi - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
        + (15 * e2 * e2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
    const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
    const y = k0 * (M + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720)) + 10000000;
    return [x, y];
}

function dibujarPoligonoPrevio(vertices) {
    capas.predio.clearLayers(); capas.contexto.clearLayers(); capas.afectaciones.clearLayers(); capas.resalte.clearLayers();
    const pts = vertices.map(v => ll([v.x, v.y]));
    const pol = L.polygon(pts, { color: '#E31E24', weight: 3, fillColor: '#E31E24', fillOpacity: .12 }).addTo(capas.predio);
    const dens = vertices.length > 40 ? 3 : vertices.length > 20 ? 2 : 1;
    vertices.forEach((v, i) => {
        const m = L.circleMarker(pts[i], { radius: 3.5, color: '#E31E24', weight: 1.5, fillColor: '#fff', fillOpacity: 1 }).addTo(capas.predio);
        m.bindTooltip(`${esc(v.id)} · campo ${esc(v.idCampo)}<br>E ${fmt(v.x, 3)}<br>N ${fmt(v.y, 3)}`);
        if (i % dens === 0) L.tooltip({ permanent: true, direction: 'top', className: 'rotulo-vertice', offset: [0, -4] }).setLatLng(pts[i]).setContent(esc(v.id)).addTo(capas.predio);
    });
    mapa.fitBounds(pol.getBounds(), { padding: [60, 60], maxZoom: 20 });
}

function dibujarAnalisis(a) {
    dibujarPoligonoPrevio(a.vertices);
    for (const l of a.contexto.lineasFabrica) L.polyline(l.map(ll), { color: '#E67E22', weight: 1.5, dashArray: '5 4' }).addTo(capas.contexto);
    const lf = a.afectaciones.lineaFabrica;
    if (lf) lf.franjas.forEach(fr => L.polygon(fr.anillo.map(ll), { color: '#2563A8', weight: 1, fillColor: '#2563A8', fillOpacity: .35 })
        .bindTooltip(`Afectación línea de fábrica: ${fmt(fr.area)} m²`).addTo(capas.afectaciones));
    for (const e of a.afectaciones.elementos) {
        const color = e.grupo === 'hidrografia' ? '#0E7490' : '#7A3E9D';
        e.dibujo.forEach(l => L.polyline(l.map(ll), { color, weight: 2.5 }).bindTooltip(`${esc(e.nombre)}${e.cercanos[0].nombre ? ' · ' + esc(e.cercanos[0].nombre) : ''}`).addTo(capas.contexto));
        e.poligonos.forEach(pol => L.polygon(pol.map(r => r.map(ll)), { color, weight: 1, fillColor: color, fillOpacity: .3 })
            .bindTooltip(`Margen ${esc(e.nombre)} (${fmt(e.margen, 1)} m): ${fmt(e.area)} m²`).addTo(capas.afectaciones));
    }
    a.catastro.solapes.forEach(s => s.poligonos.forEach(pol => L.polygon(pol.map(r => r.map(ll)), { color: '#B7791F', weight: 1, dashArray: '3 3', fillOpacity: 0 }).addTo(capas.afectaciones)));
    capas.predio.eachLayer(l => l.bringToFront && l.bringToFront());
}

function resaltarLindero(li) {
    capas.resalte.clearLayers();
    if (!li || !estado.analisis) return;
    const v = estado.analisis.vertices, n = v.length;
    li.lados.forEach(i => L.polyline([ll([v[i].x, v[i].y]), ll([v[(i + 1) % n].x, v[(i + 1) % n].y])], { color: '#FFD60A', weight: 7, opacity: .9 }).addTo(capas.resalte));
}

// ── 1 · Lectura del archivo ──────────────────────────────────────────────────
async function aBase64(archivo) {
    const bytes = new Uint8Array(await archivo.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

async function leerContenido(nombre, contenido, base64) {
    const caja = $('#lectura');
    ocupado($('#paso-1'), true);
    try {
        estado.nombreArchivo = nombre;
        estado.lectura = await (await api('/api/leer', base64 ? { nombre, base64 } : { nombre, contenido })).json();
        estado.codigos = new Set(estado.lectura.codigos || []);
        estado.candidato = 0;
        estado.analisis = null; estado.ediciones = {}; estado.cortes = [];
        $('#excluir').value = '';
        pintarLectura();
        await normalizar();
    } catch (e) {
        caja.hidden = false;
        caja.innerHTML = `<div class="aviso error">${esc(e.message)}</div>`;
        capas.predio.clearLayers();
    } finally { ocupado($('#paso-1'), false); }
}

function pintarLectura() {
    const r = estado.lectura, caja = $('#lectura');
    caja.hidden = false;
    let h = `<div class="fila-info"><span>Archivo</span><b>${esc(estado.nombreArchivo)}</b></div>`;
    if (r.tipo === 'csv') {
        h += `<div class="fila-info"><span>Puntos leídos</span><b>${r.puntos.length}</b></div>`;
        if (r.codigos.length) {
            h += `<p class="ayuda">Códigos de punto: marque los que forman el lindero.</p><div class="chips">` +
                r.codigos.map(c => `<label class="chip"><input type="checkbox" data-codigo="${esc(c)}" ${estado.codigos.has(c) ? 'checked' : ''}> ${esc(c)} <small>(${r.puntos.filter(p => p.cod === c).length})</small></label>`).join('') + `</div>`;
        }
    } else {
        h += `<p class="ayuda">Contornos cerrados encontrados (ordenados por área):</p><div class="candidatos">` +
            r.candidatos.map((c, i) => `<label class="candidato"><input type="radio" name="candidato" value="${i}" ${i === estado.candidato ? 'checked' : ''}>
                <span><b>Capa ${esc(c.capa)}</b> · ${c.origen}${i === 0 && r.candidatos.length > 1 ? ' · <em>propuesto</em>' : ''}<br>${c.vertices} vértices · ${fmt(c.area)} m²</span></label>`).join('') + `</div>`;
        if ((r.textos || []).length) h += `<p class="ayuda">${r.textos.length} textos del dibujo: los nombres junto a cada lado se ofrecerán como colindantes.</p>`;
    }
    h += `<label class="campo">Numeración de vértices
        <select id="inicio"><option value="noroeste">P1 en el vértice noroeste, sentido horario</option><option value="original">Orden del archivo (sentido horario)</option></select></label>`;
    (r.avisos || []).forEach(t => { h += `<div class="aviso">${esc(t)}</div>`; });
    h += `<div id="validacion"></div>`;
    caja.innerHTML = h;
    caja.querySelectorAll('[data-codigo]').forEach(el => el.addEventListener('change', () => {
        el.checked ? estado.codigos.add(el.dataset.codigo) : estado.codigos.delete(el.dataset.codigo); normalizar();
    }));
    caja.querySelectorAll('input[name=candidato]').forEach(el => el.addEventListener('change', () => { estado.candidato = Number(el.value); normalizar(); }));
    $('#inicio').addEventListener('change', normalizar);
}

async function normalizar() {
    const r = estado.lectura;
    if (!r) return;
    let puntos;
    if (r.tipo === 'csv') puntos = r.codigos.length ? r.puntos.filter(p => !p.cod || estado.codigos.has(p.cod)) : r.puntos;
    else puntos = r.candidatos[estado.candidato].puntos.map((p, i) => ({ x: p[0], y: p[1], id: String(i + 1) }));
    const val = $('#validacion');
    try {
        estado.normal = await (await api('/api/normalizar', { puntos, inicio: $('#inicio') ? $('#inicio').value : 'noroeste' })).json();
    } catch (e) { val.innerHTML = `<div class="aviso error">${esc(e.message)}</div>`; return; }
    const nr = estado.normal;
    let h = '';
    nr.errores.forEach(t => { h += `<div class="aviso error">${esc(t)}</div>`; });
    nr.avisos.forEach(t => { h += `<div class="aviso alerta">${esc(t)}</div>`; });
    if (!nr.errores.length) h += `<div class="aviso ok">Polígono válido: ${nr.vertices.length} vértices.</div>`;
    val.innerHTML = h;
    if (nr.vertices.length >= 3) dibujarPoligonoPrevio(nr.vertices);
    $('#paso-2').hidden = !!nr.errores.length;
    estado.analisis = null;
    PASOS_RESULTADO.forEach(s => { $(s).hidden = true; });
    $('#guardar-proyecto').disabled = true;
}

const PASOS_RESULTADO = ['#paso-3', '#paso-registral', '#paso-4', '#paso-5'];

$('#archivo').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) leerContenido(f.name, null, await aBase64(f));
    e.target.value = '';
});
function zonaArrastre(zona, alSoltar) {
    ['dragenter', 'dragover'].forEach(ev => zona.addEventListener(ev, e => { e.preventDefault(); zona.classList.add('encima'); }));
    ['dragleave', 'drop'].forEach(ev => zona.addEventListener(ev, e => { e.preventDefault(); zona.classList.remove('encima'); }));
    zona.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) alSoltar(f); });
}
zonaArrastre($('#zona-carga'), async f => leerContenido(f.name, null, await aBase64(f)));
$('#leer-texto').addEventListener('click', () => {
    const t = $('#texto-coord').value.trim();
    if (t) leerContenido('coordenadas pegadas.csv', t);
});

// ── 2 · Márgenes y análisis ──────────────────────────────────────────────────
function pintarMargenes() {
    const cont = $('#lista-margenes');
    cont.innerHTML = estado.config.elementos.map(e => `
        <div class="margen-fila">
            <span>${esc(e.nombre)} ${e.disponible ? '' : '<span class="etiqueta no">sin datos</span>'}
                ${e.margen_m !== null && !e.verificado ? '<span class="etiqueta">por verificar</span>' : ''}</span>
            <input type="number" min="0" step="0.5" data-margen="${e.id}" placeholder="${e.margen_m === null ? 'ancho m' : e.margen_m}">
            <small>${esc(e.base_legal)}</small>
        </div>`).join('');
}

async function analizar() {
    const nr = estado.normal;
    if (!nr || nr.errores.length) return;
    const margenes = {};
    document.querySelectorAll('[data-margen]').forEach(i => { if (i.value !== '') margenes[i.dataset.margen] = Number(i.value); });
    const opciones = {
        tolLindero: Number($('#tol-lindero').value) || 1,
        osm: $('#osm').checked, margenes,
        excluirClaves: ($('#excluir').value || '').split(',').map(s => s.trim()).filter(Boolean),
        cortes: estado.cortes,
        textos: estado.lectura && estado.lectura.tipo === 'dxf' ? estado.lectura.textos : undefined
    };
    const btn = $('#analizar');
    const primera = !estado.analisis;
    ocupado(btn, true); btn.textContent = 'Analizando…';
    try {
        const a = await (await api('/api/analizar', { vertices: nr.vertices, opciones })).json();
        estado.opciones = Object.assign({}, opciones, { textos: undefined });
        aplicarEdiciones(a);
        estado.analisis = a;
        dibujarAnalisis(a);
        pintarResultados();
        PASOS_RESULTADO.forEach(s => { $(s).hidden = false; });
        $('#guardar-proyecto').disabled = false;
        $('#estado').textContent = `Análisis en ${fmt(a.ms / 1000, 1)} s · ${a.ubicacion.parroquia || 'fuera de parroquias'} · ${a.ubicacion.zona || ''}`;
        if (estado.registral) await conciliar();
        if (primera) $('#paso-3').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { aviso(e.message, true); }
    finally { ocupado(btn, false); btn.textContent = 'Analizar predio'; }
}
$('#analizar').addEventListener('click', analizar);

// Las ediciones se guardan por coordenadas de los extremos del tramo: siguen
// valiendo si se reanaliza o si al dividir un lado cambia la numeracion.
const claveTramo = l => !l.desdeXY ? `${l.desde}|${l.hasta}`
    : `${l.desdeXY[0].toFixed(2)},${l.desdeXY[1].toFixed(2)}|${l.hastaXY[0].toFixed(2)},${l.hastaXY[1].toFixed(2)}`;
const CAMPOS_EDITABLES = ['colindante', 'dir', 'tipo', 'antecesor', 'observacion'];
function aplicarEdiciones(a) {
    for (const l of a.linderos) {
        l.tipo = l.tipo || ({ manual: 'campo' }[l.fuente] || l.fuente);
        const ed = estado.ediciones[claveTramo(l)];
        if (!ed) continue;
        for (const c of CAMPOS_EDITABLES) if (ed[c] !== undefined) l[c] = ed[c];
        l.editado = true;
        l.pendiente = !String(l.colindante || '').trim();
    }
}
function editar(li, campo, valor) {
    const k = claveTramo(li);
    estado.ediciones[k] = estado.ediciones[k] || {};
    estado.ediciones[k][campo] = valor;
    li[campo] = valor;
    li.editado = true;
    li.pendiente = !String(li.colindante || '').trim();
    programarConciliacion();
}

// ── 3 · Resultados ───────────────────────────────────────────────────────────
function pintarResultados() {
    const a = estado.analisis;
    const diag = a.catastro.diagnostico;
    const clase = { libre: 'ok', roce: 'ok', solape: 'alerta', contenido: 'error' }[diag.tipo];
    let dh = esc(diag.texto);
    const excluidas = ($('#excluir').value || '').split(',').filter(Boolean);
    if (a.catastro.solapes.length) {
        dh += '<br><small>' + a.catastro.solapes.slice(0, 5).map(s => `${esc(s.clave)} · ${fmt(s.area)} m² (${fmt(s.pctPredio, 1)} %)` +
            (s.pctPredio < 90 ? ` <button class="enlace" data-excluir="${esc(s.clave)}">${excluidas.includes(s.clave) ? 'volver a incluir' : 'no es colindante'}</button>` : '')).join('<br>') + '</small>';
    }
    $('#diagnostico').className = 'aviso ' + clase;
    $('#diagnostico').innerHTML = dh;
    // Un predio madre parcial (o un error del catastro) no debe figurar como vecino
    $('#diagnostico').querySelectorAll('[data-excluir]').forEach(b => b.addEventListener('click', () => {
        const set = new Set(($('#excluir').value || '').split(',').filter(Boolean));
        set.has(b.dataset.excluir) ? set.delete(b.dataset.excluir) : set.add(b.dataset.excluir);
        $('#excluir').value = [...set].join(',');
        analizar();
    }));

    const af = a.afectaciones;
    $('#metricas').innerHTML = `
        <div class="metrica"><span>Superficie</span><b>${fmt(a.area)}</b> <small>m²</small></div>
        <div class="metrica"><span>Afectada</span><b>${fmt(af.areaAfectada)}</b> <small>m²</small></div>
        <div class="metrica"><span>Útil</span><b>${fmt(af.areaUtil)}</b> <small>m²</small></div>
        <div class="metrica"><span>Perímetro</span><b>${fmt(a.perimetro)}</b> <small>m</small></div>
        <div class="metrica"><span>Vértices</span><b>${a.vertices.length}</b></div>
        <div class="metrica"><span>Zona</span><b style="font-size:13px">${esc(a.ubicacion.zona || '-')}</b><br><small>${esc(a.ubicacion.parroquia || '')}</small></div>`;

    pintarLinderos();

    let ah = '';
    if (af.lineaFabrica && af.lineaFabrica.total > 0) {
        ah += `<div class="fila-info"><span>Línea de fábrica (${af.lineaFabrica.franjas.length} franja/s)</span><b>${fmt(af.lineaFabrica.total)} m²</b></div>`;
    } else ah += `<div class="fila-info"><span>Línea de fábrica</span><b>sin afectación</b></div>`;
    for (const e of af.elementos) {
        const margen = e.margen === null ? '<span class="etiqueta">sin margen</span>' : `margen ${fmt(e.margen, 1)} m ${e.margenEditado ? '' : e.verificado ? '' : '<span class="etiqueta">por verificar</span>'}`;
        ah += `<div class="fila-info"><span>${esc(e.nombre)}${e.cercanos[0].nombre ? ' · ' + esc(e.cercanos[0].nombre) : ''}<br><small>a ${fmt(e.distancia)} m · ${margen}</small></span><b>${e.afecta ? fmt(e.area) + ' m²' : '—'}</b></div>`;
    }
    if (!af.elementos.length) ah += `<p class="ayuda">Sin ríos, quebradas, vías certificadas ni líneas férreas a menos de 50 m.</p>`;
    $('#afectaciones').innerHTML = ah;

    const p = a.ubicacion.pugs;
    $('#normativa').innerHTML = p ? `<h3>PUGS · ${esc(p.codigo || '')}</h3>
        <p class="ayuda">${esc(p.subclasificacion || '')} · ${esc(p.tratamiento || '')} · lote mín. ${esc(p.loteMinimo)} m² · frente mín. ${esc(p.frenteMinimo)} m</p>
        ${(p.verificacion || []).map(v => `<div class="fila-info"><span>${esc(v.item)}: ${esc(v.predio)} (norma ${esc(v.norma)})</span><span class="etiqueta ${v.cumple ? 'ok' : 'no'}">${v.cumple ? 'Cumple' : 'No cumple'}</span></div>`).join('')}` : '';

    $('#tabla-vertices').innerHTML = `<tr><th>Pto</th><th>Campo</th><th>Este</th><th>Norte</th><th>Lado</th><th>Rumbo</th><th>Vért. cat.</th></tr>` +
        a.vertices.map((v, i) => `<tr><td>${esc(v.id)}</td><td>${esc(v.idCampo)}</td><td class="num">${fmt(v.x, 3)}</td><td class="num">${fmt(v.y, 3)}</td>
            <td class="num">${fmt(a.lados[i].L, 3)}</td><td>${esc(a.lados[i].rumbo)}</td>
            <td class="num" title="${v.catastral ? esc(v.catastral.clave) : ''}">${v.catastral ? fmt(v.catastral.dist, 3) + ' m' : '—'}</td></tr>`).join('');

    $('#avisos').innerHTML = a.avisos.map(t => `<li>${esc(t)}</li>`).join('');
}

const TIPOS = [
    ['catastro', 'Catastro GADMR'], ['campo', 'Declarado en campo'], ['escritura', 'Según título'],
    ['dxf', 'Plano del profesional'], ['via', 'Vía'], ['agua', 'Río / quebrada / canal'], ['otro', 'Otro']
];

function pintarLinderos() {
    const a = estado.analisis;
    const pend = a.linderos.filter(l => !String(l.colindante || '').trim()).length;
    $('#pendientes').textContent = pend ? `${pend} por completar` : '';
    const dirs = ['Norte', 'Sur', 'Este', 'Oeste'];
    const conc = estado.conciliacion;
    $('#lista-linderos').innerHTML = a.linderos.map((l, i) => {
        const lado = conc && conc.lados.find(x => x.dir === l.dir && x.registral);
        const chips = [];
        if (l.sugerenciaDXF && l.sugerenciaDXF.texto !== l.colindante) chips.push(`<button type="button" class="chip-accion" data-accion="dxf">DXF: ${esc(l.sugerenciaDXF.texto)}</button>`);
        if (lado && lado.registral.colindante && lado.registral.colindante !== l.antecesor) chips.push(`<button type="button" class="chip-accion" data-accion="titulo" title="Anotar como colindante según el título">Título: ${esc(lado.registral.colindante)}</button>`);
        if (l.clave && l.fuente === 'catastro') chips.push(`<span class="chip-info" title="Clave catastral del colindante">${esc(l.clave.slice(0, 18))}</span>`);
        return `<div class="lindero ${String(l.colindante || '').trim() ? '' : 'pendiente'}" data-i="${i}">
            <div class="lindero-cab">
                <select data-campo="dir" aria-label="Orientación">${dirs.map(d => `<option ${d === l.dir ? 'selected' : ''}>${d}</option>`).join('')}</select>
                <span class="tramo">${esc(l.desde)} – ${esc(l.hasta)}</span>
                <b class="long">${fmt(l.longitud, 2)} m</b>
                <span class="acciones">
                    ${l.interiores && l.interiores.length ? `<select data-accion="cortar" title="Partir el lindero en un vértice"><option value="">Cortar en…</option>${l.interiores.map(v => `<option value="${v.xy[0]},${v.xy[1]}">${esc(v.id)}</option>`).join('')}</select>` : ''}
                    <button type="button" class="btn btn-linea btn-sm" data-accion="dividir" title="Insertar un punto de lindero a una distancia">Dividir</button>
                </span>
            </div>
            <div class="lindero-fila">
                <input data-campo="colindante" value="${esc(l.colindante)}" placeholder="Colindante actual (nombre, vía, quebrada…)">
                <select data-campo="tipo" aria-label="Fuente del colindante">${TIPOS.map(([v, t]) => `<option value="${v}" ${v === l.tipo ? 'selected' : ''}>${t}</option>`).join('')}</select>
            </div>
            <div class="lindero-fila">
                <input data-campo="antecesor" value="${esc(l.antecesor || '')}" placeholder="Colindante según el título (antes)">
                <input data-campo="observacion" value="${esc(l.observacion || '')}" placeholder="Relación: heredero, comprador 2021, posesionario…">
            </div>
            ${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}
        </div>`;
    }).join('');

    document.querySelectorAll('#lista-linderos .lindero').forEach(card => {
        const li = a.linderos[Number(card.dataset.i)];
        card.addEventListener('mouseenter', () => resaltarLindero(li));
        card.addEventListener('mouseleave', () => capas.resalte.clearLayers());
        card.querySelectorAll('[data-campo]').forEach(inp => inp.addEventListener('change', () => {
            editar(li, inp.dataset.campo, inp.dataset.campo === 'dir' || inp.dataset.campo === 'tipo' ? inp.value : inp.value.trim());
            card.classList.toggle('pendiente', !String(li.colindante || '').trim());
            const p = a.linderos.filter(l => !String(l.colindante || '').trim()).length;
            $('#pendientes').textContent = p ? `${p} por completar` : '';
        }));
        card.querySelectorAll('[data-accion]').forEach(b => {
            const accion = b.dataset.accion;
            if (accion === 'cortar') b.addEventListener('change', () => { if (b.value) cortarEn(b.value.split(',').map(Number)); });
            else b.addEventListener('click', () => {
                if (accion === 'dxf') { editar(li, 'colindante', li.sugerenciaDXF.texto); if (li.tipo === 'catastro') editar(li, 'tipo', 'dxf'); pintarLinderos(); }
                else if (accion === 'titulo') {
                    const lado = estado.conciliacion.lados.find(x => x.dir === li.dir && x.registral);
                    editar(li, 'antecesor', lado.registral.colindante);
                    if (!String(li.colindante || '').trim()) { editar(li, 'colindante', lado.registral.colindante); editar(li, 'tipo', 'escritura'); }
                    pintarLinderos();
                }
                else if (accion === 'dividir') dividirLindero(li);
            });
        });
    });

    const nombres = estado.cortes.map(c => {
        const v = a.vertices.find(q => Math.hypot(q.x - c[0], q.y - c[1]) < 0.005);
        return { c, id: v ? v.id : '?' };
    });
    $('#cortes-activos').innerHTML = nombres.length ? 'Linderos cortados en: ' + nombres.map((x, k) => `${esc(x.id)} <button type="button" class="enlace" data-quitar-corte="${k}">quitar</button>`).join(' · ') : '';
    $('#cortes-activos').querySelectorAll('[data-quitar-corte]').forEach(b => b.addEventListener('click', () => {
        estado.cortes.splice(Number(b.dataset.quitarCorte), 1);
        analizar();
    }));
}

// Parte el lindero en un vertice existente
function cortarEn(xy) {
    if (!estado.cortes.some(c => Math.hypot(c[0] - xy[0], c[1] - xy[1]) < 0.005)) estado.cortes.push(xy);
    analizar();
}

// Inserta un punto de lindero a una distancia medida desde el inicio del
// tramo, recorriendo sus lados, y corta ahi. El punto entra al cuadro de
// coordenadas como vertice (Lk), igual que un cambio de cerramiento en campo.
function dividirLindero(li) {
    const txt = prompt(`¿A cuántos metros desde ${li.desde} cambia el colindante? (0 – ${fmt(li.longitud, 2)} m)`);
    if (txt === null) return;
    const d = Number(String(txt).replace(',', '.'));
    if (!(d > 0.05 && d < li.longitud - 0.05)) { aviso('La distancia tiene que quedar dentro del lindero.', true); return; }
    const V = estado.normal.vertices, n = V.length;
    // punto de partida: desdeXY, que puede estar a mitad de un lado
    let lado = li.lados[0];
    let p = li.desdeXY.slice();
    let resto = d;
    for (let paso = 0; paso <= n; paso++) {
        const b = V[(lado + 1) % n];
        const L = Math.hypot(b.x - p[0], b.y - p[1]);
        if (resto <= L + 1e-9) {
            const t = resto / L;
            const q = [p[0] + (b.x - p[0]) * t, p[1] + (b.y - p[1]) * t];
            const cerca = V.find(v => Math.hypot(v.x - q[0], v.y - q[1]) < 0.01);
            if (cerca) { cortarEn([cerca.x, cerca.y]); return; }
            const nuevos = estado.normal.vertices.filter(v => /^L\d+$/.test(v.idCampo)).length + 1;
            V.splice(lado + 1, 0, { x: Math.round(q[0] * 1e4) / 1e4, y: Math.round(q[1] * 1e4) / 1e4, idCampo: 'L' + nuevos, cod: 'LINDERO' });
            V.forEach((v, k) => { v.id = 'P' + (k + 1); });
            estado.cortes.push([V[lado + 1].x, V[lado + 1].y]);
            dibujarPoligonoPrevio(V);
            analizar();
            return;
        }
        resto -= L;
        lado = (lado + 1) % n;
        p = [b.x, b.y];
    }
}

// ── 4 · Título registral y conciliación ─────────────────────────────────────
const ORIENTACIONES = ['frente', 'fondo', 'derecho', 'izquierdo', 'un lado', 'otro lado', 'Norte', 'Sur', 'Este', 'Oeste', 'Noreste', 'Noroeste', 'Sureste', 'Suroeste'];

async function cargarCertificado(f) {
    const zona = $('#zona-certificado');
    ocupado(zona, true);
    try {
        const r = await (await api('/api/registral', { base64: await aBase64(f) })).json();
        r.archivo = f.name;
        estado.registral = r;
        pintarRegistral();
        completarDatosDesdeTitulo();
        await conciliar();
    } catch (e) { aviso(e.message, true); }
    finally { ocupado(zona, false); }
}
$('#archivo-certificado').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) cargarCertificado(f); });
zonaArrastre($('#zona-certificado'), cargarCertificado);
$('#registral-manual').addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    if (!estado.registral) estado.registral = { tipo: 'manual', linderos: [{ orientacion: 'frente', colindante: '', longitud: null }], propietarios: [], movimientos: [], historia: [], avisos: [] };
    pintarRegistral();
});

function pintarRegistral() {
    const R = estado.registral;
    $('#registral').hidden = !R;
    if (!R) return;
    $('#registral-avisos').innerHTML = (R.avisos || []).map(t => `<div class="aviso alerta">${esc(t)}</div>`).join('') +
        (R.archivo ? `<div class="aviso ok">Leído de ${esc(R.archivo)}${R.ficha ? ` · ficha ${esc(R.ficha)}` : ''}. Revise los datos antes de continuar.</div>` : '');
    const set = (k, v) => { const el = document.querySelector(`[data-reg="${k}"]`); if (el) el.value = v == null ? '' : v; };
    set('ficha', R.ficha);
    set('certificado', [R.certificado, R.emitido].filter(Boolean).join(' · '));
    set('propietarios', (R.propietarios || []).map(p => p.nombre).join('\n'));
    set('ubicacion', [R.ubicacion, R.parroquia].filter(Boolean).join(' · '));
    set('area', R.area && R.area.valor != null ? String(R.area.valor).replace('.', ',') : '');
    set('unidad', R.area ? R.area.unidad : 'm2');
    set('gravamenes', R.gravamenes ? ((R.gravamenes.vigentes || []).length ? 'VIGENTES: ' + R.gravamenes.vigentes.map(v => v.acto).join(', ') + '. ' : '') + (R.gravamenes.texto || '') : '');
    pintarLinderosRegistrales();
    const hist = (R.historia || []).filter(h => h.linderos.length);
    $('#historia-registral').innerHTML = hist.length > 1 ? `<p class="ayuda">El título trae linderos en ${hist.length} actos. Compare con uno anterior:</p><div class="chips">` +
        hist.map((h, k) => `<button type="button" class="chip-accion" data-hist="${k}">${esc((h.fecha || '').slice(0, 4))} · ${esc(h.acto)}</button>`).join('') + '</div>' : '';
    $('#historia-registral').querySelectorAll('[data-hist]').forEach(b => b.addEventListener('click', () => {
        R.linderos = JSON.parse(JSON.stringify(hist[Number(b.dataset.hist)].linderos));
        pintarLinderosRegistrales();
        conciliar();
    }));
}

function pintarLinderosRegistrales() {
    const R = estado.registral;
    $('#tabla-registral').innerHTML = `<tr><th>Orientación</th><th>Colindante según título</th><th>m</th><th></th></tr>` +
        R.linderos.map((l, i) => `<tr data-i="${i}">
            <td><select data-lr="orientacion">${ORIENTACIONES.map(o => `<option ${o === l.orientacion ? 'selected' : ''}>${o}</option>`).join('')}</select></td>
            <td><input data-lr="colindante" value="${esc(l.colindante)}"></td>
            <td><input data-lr="longitud" class="corto" inputmode="decimal" value="${l.longitud != null ? String(l.longitud).replace('.', ',') : ''}"></td>
            <td><button type="button" class="enlace" data-lr-quitar>quitar</button></td></tr>`).join('');
    $('#tabla-registral').querySelectorAll('tr[data-i]').forEach(tr => {
        const l = R.linderos[Number(tr.dataset.i)];
        tr.querySelectorAll('[data-lr]').forEach(inp => inp.addEventListener('change', () => {
            const c = inp.dataset.lr;
            l[c] = c === 'longitud' ? (inp.value.trim() === '' ? null : Number(inp.value.replace(',', '.'))) : inp.value.trim();
            conciliar();
        }));
        tr.querySelector('[data-lr-quitar]').addEventListener('click', () => { R.linderos.splice(Number(tr.dataset.i), 1); pintarLinderosRegistrales(); conciliar(); });
    });
}
$('#agregar-lindero-reg').addEventListener('click', () => {
    estado.registral.linderos.push({ orientacion: 'Norte', colindante: '', longitud: null });
    pintarLinderosRegistrales();
});
document.querySelectorAll('[data-reg]').forEach(inp => inp.addEventListener('change', () => {
    const R = estado.registral, v = inp.value.trim();
    switch (inp.dataset.reg) {
        case 'ficha': R.ficha = v; break;
        case 'certificado': R.certificado = v; break;
        case 'propietarios': R.propietarios = v.split('\n').map(s => s.trim()).filter(Boolean).map(nombre => Object.assign({}, (R.propietarios || []).find(p => p.nombre === nombre) || {}, { nombre })); break;
        case 'ubicacion': R.ubicacion = v; R.parroquia = ''; break;
        case 'area': R.area = v ? Object.assign({}, R.area || { unidad: 'm2' }, { valor: Number(v.replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')) }) : null; break;
        case 'unidad': if (R.area) R.area.unidad = v; break;
        case 'gravamenes': R.gravamenes = Object.assign({}, R.gravamenes || {}, { texto: v, vigentes: [] }); break;
    }
    conciliar();
}));
$('#frente').addEventListener('change', () => conciliar());

function completarDatosDesdeTitulo() {
    const R = estado.registral, form = $('#datos');
    if (!R) return;
    if (!estado.propietarios.some(p => p.nombre)) (R.propietarios || []).forEach(p => anadirPropietario(p));
    pintarPropietarios();
    pintarPersonasCertificado();
    if (!form.claveCatastral.value && R.claveCatastral) form.claveCatastral.value = R.claveCatastral;
    if (!form.sector.value && R.ubicacion) form.sector.value = R.ubicacion.replace(/^INMUEBLE (UBICADO )?EN (EL )?/i, '');
}

let _concTimer = null;
function programarConciliacion() { clearTimeout(_concTimer); _concTimer = setTimeout(conciliar, 400); }

async function conciliar() {
    if (!estado.registral || !estado.analisis) return;
    try {
        estado.conciliacion = await (await api('/api/conciliar', { analisis: estado.analisis, registral: estado.registral, opciones: opcionesConciliacion() })).json();
        pintarConciliacion();
        pintarLinderos();
    } catch (e) { aviso(e.message, true); }
}
const opcionesConciliacion = () => ({ frente: $('#frente').value || null });

function pintarConciliacion() {
    const C = estado.conciliacion;
    if (!C) { $('#conciliacion').innerHTML = ''; return; }
    const est = { mismo: ['ok', 'mismo'], cambio: ['no', 'cambió · anote relación'], cambio_documentado: ['', 'cambió · anotado'], dividido: ['no', 'varios · anote relación'], dividido_documentado: ['', 'varios · anotado'], sin_dato: ['', '—'] };
    let h = C.predioCatastral && C.predioCatastral.coincide
        ? `<div class="aviso ok">La clave del título (${esc(C.predioCatastral.clave)}) es la del predio catastral que contiene el levantamiento: no es un fraccionamiento.</div>` : '';
    h += C.usaRelativas ? `<p class="ayuda">Frente al <b>${esc(C.frente || '¿?')}</b>${C.origenFrente ? ' (' + esc(C.origenFrente) + ')' : ''}.</p>` : '';
    h += `<div class="tabla-scroll"><table class="tabla compacta"><tr><th>Lindero</th><th>Título (antes)</th><th>Hoy</th><th>Dif.</th><th>Colindante</th></tr>` +
        C.lados.map(l => `<tr>
            <td><b>${esc(l.dir)}</b>${l.relativo ? `<br><small>${esc(l.relativo)}</small>` : ''}</td>
            <td>${l.registral ? `${esc(l.registral.colindante || '-')}<br><small>${l.registral.longitud != null ? fmt(l.registral.longitud) + ' m' : 'sin medida'}</small>` : '<small>sin dato</small>'}</td>
            <td>${l.hoy.linderos.map(x => esc(x.colindante || '¿?')).join('<br>')}<br><small>${fmt(l.hoy.longitud)} m</small></td>
            <td class="num ${l.estadoLongitud === 'difiere' ? 'resaltar' : ''}">${l.dif != null ? (l.dif > 0 ? '+' : '') + fmt(l.dif) + ' m<br><small>' + (l.pct > 0 ? '+' : '') + fmt(l.pct, 1) + ' %</small>' : '—'}</td>
            <td><span class="etiqueta ${est[l.estadoColindante][0]}">${est[l.estadoColindante][1]}</span></td></tr>`).join('') + '</table></div>';
    if (C.area) {
        const clase = C.area.estado === 'dentro' ? 'ok' : C.area.estado === 'sin_etam' ? '' : 'error';
        h += `<div class="aviso ${clase}">${esc(C.area.texto)}${C.area.etamVerificado ? '' : ' <span class="etiqueta">ETAM por verificar</span>'}</div>`;
    }
    const hist = C.lados.filter(l => (l.historia || []).length > 1 && new Set(l.historia.map(x => x.longitud)).size > 1);
    if (hist.length) h += `<p class="ayuda">Cambios entre actos inscritos: ${hist.map(l => `${esc(l.dir)} ${l.historia.map(x => `${esc((x.fecha || '').slice(0, 4))}: ${fmt(x.longitud)}`).join(' → ')} → hoy ${fmt(l.hoy.longitud)} m`).join(' · ')}</p>`;
    C.avisos.filter(t => !C.area || t !== C.area.texto).forEach(t => { h += `<div class="aviso alerta">${esc(t)}</div>`; });
    $('#conciliacion').innerHTML = h;
}

// ── 5 · Datos del informe (lo del profesional se recuerda en este equipo) ────

// Un predio puede tener varios titulares: conyuges, herederos, donatarios,
// socios. Cada fila lleva su calidad y, si el titulo la declara, su cuota.
const CALIDADES = ['Propietario/a', 'Copropietario/a', 'Cónyuge', 'Conviviente', 'Heredero/a', 'Sucesión indivisa',
    'Posesionario/a', 'Donatario/a', 'Donante', 'Usufructuario/a', 'Nudo/a propietario/a', 'Accionista o socio/a',
    'Representante legal', 'Apoderado/a', 'Otro'];

function pintarPropietarios() {
    const cont = $('#propietarios');
    if (!estado.propietarios.length) estado.propietarios.push({ nombre: '', documento: '', calidad: 'Propietario/a', participacion: '', observacion: '' });
    cont.innerHTML = estado.propietarios.map((p, i) => `<div class="propietario" data-i="${i}">
        <div class="propietario-fila">
            <input data-prop="nombre" value="${esc(p.nombre)}" placeholder="Apellidos y nombres">
            <input data-prop="documento" value="${esc(p.documento)}" placeholder="Cédula / RUC">
        </div>
        <div class="propietario-fila">
            <select data-prop="calidad">${CALIDADES.map(c => `<option ${c === p.calidad ? 'selected' : ''}>${c}</option>`).join('')}</select>
            <input data-prop="participacion" value="${esc(p.participacion)}" placeholder="Cuota (50 %, 1/3…)">
            <button type="button" class="enlace" data-quitar-prop>quitar</button>
        </div>
        <input data-prop="observacion" value="${esc(p.observacion)}" placeholder="Observación: estado civil, acto por el que adquiere, futuro donatario…">
    </div>`).join('');
    cont.querySelectorAll('.propietario').forEach(fila => {
        const p = estado.propietarios[Number(fila.dataset.i)];
        fila.querySelectorAll('[data-prop]').forEach(inp => inp.addEventListener('change', () => { p[inp.dataset.prop] = inp.value.trim(); }));
        fila.querySelector('[data-quitar-prop]').addEventListener('click', () => {
            estado.propietarios.splice(Number(fila.dataset.i), 1);
            pintarPropietarios();
        });
    });
}
$('#agregar-propietario').addEventListener('click', () => {
    estado.propietarios.push({ nombre: '', documento: '', calidad: 'Copropietario/a', participacion: '', observacion: '' });
    pintarPropietarios();
});

// Anade una persona del certificado si no estaba ya en la lista
function anadirPropietario(p, calidad) {
    const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[^A-Z ]/g, ' ').replace(/ +/g, ' ').trim();
    if (estado.propietarios.some(q => q.nombre && norm(q.nombre) === norm(p.nombre))) return false;
    const vacia = estado.propietarios.find(q => !q.nombre);
    const ficha = {
        nombre: p.nombre,
        documento: p.documento || '',
        calidad: calidad || CALIDADES.find(c => p.calidad && norm(c).startsWith(norm(p.calidad).slice(0, 6))) || 'Propietario/a',
        participacion: '',
        observacion: [p.estadoCivil ? 'Estado civil: ' + p.estadoCivil : '', p.calidad && p.acto ? p.calidad + ' en ' + p.acto : (p.calidad || '')].filter(Boolean).join(' · ')
    };
    if (vacia) Object.assign(vacia, ficha); else estado.propietarios.push(ficha);
    return true;
}
$('#propietarios-certificado').addEventListener('click', () => {
    const R = estado.registral;
    if (!R) return;
    const n = (R.propietarios || []).filter(p => anadirPropietario(p)).length;
    pintarPropietarios();
    aviso(n ? n + ' propietario(s) tomados del certificado.' : 'Los propietarios del certificado ya estaban en la lista.');
});

// Personas nombradas en el titulo que hoy pueden ser titulares
function pintarPersonasCertificado() {
    const R = estado.registral, cont = $('#personas-certificado');
    $('#propietarios-certificado').hidden = !(R && (R.propietarios || []).length);
    const personas = (R && R.personas) || [];
    cont.innerHTML = personas.length
        ? '<small class="ayuda ancho">Otras personas del título (ex cónyuge, herederos, dueños anteriores): añádalas solo si hoy son titulares.</small>' +
        personas.map((p, i) => `<button type="button" class="chip-accion" data-persona="${i}" title="${esc((p.actos || []).map(x => x.acto).join(' · '))}">+ ${esc(p.nombre)}${p.calidad ? ' · ' + esc(p.calidad) : ''}</button>`).join('')
        : '';
    cont.querySelectorAll('[data-persona]').forEach(b => b.addEventListener('click', () => {
        anadirPropietario(personas[Number(b.dataset.persona)], 'Copropietario/a');
        pintarPropietarios();
    }));
}

function leerDatos() {
    const d = Object.fromEntries(new FormData($('#datos')).entries());
    d.propietarios = estado.propietarios.filter(p => String(p.nombre || '').trim());
    // Compatibilidad: el cajetin, el titulo del PDF y el nombre de archivo
    d.propietario = d.propietarios.map(p => p.nombre).join(' y ');
    d.documento = (d.propietarios[0] || {}).documento || '';
    d.formato = $('#formato').value;
    d.escala = $('#escala').value;
    d.ubicacion = $('#mapa-ubicacion').checked;
    d.institucion = estado.config && estado.config.informe ? estado.config.informe.institucion : undefined;
    return d;
}
document.querySelectorAll('#datos [data-recordar]').forEach(inp => {
    try { const v = localStorage.getItem('planimetria:' + inp.name); if (v) inp.value = v; } catch (e) { }
    inp.addEventListener('change', () => { try { localStorage.setItem('planimetria:' + inp.name, inp.value); } catch (e) { } });
});

// ── Foto satelital del entorno ──────────────────────────────────────────────
// Se compone con las teselas de Esri World Imagery sobre un lienzo y el PDF la
// empotra en el recuadro de ubicación. Cubre el doble de ancho que de alto,
// igual que el recuadro. El DXF no la lleva: R12 no admite imágenes.
let _fotoCache = null;
async function capturarSatelital(centro, radio) {
    const clave = centro.map(v => v.toFixed(0)).join(',') + '/' + radio;
    if (_fotoCache && _fotoCache.clave === clave) return _fotoCache.foto;
    const ancho = 2 * radio, alto = ancho / 2;
    const [latS, lonO] = utmALatLng(centro[0] - ancho / 2, centro[1] - alto / 2);
    const [latN, lonE] = utmALatLng(centro[0] + ancho / 2, centro[1] + alto / 2);
    const latMed = (latS + latN) / 2;
    const resDeseada = ancho / 1600;                                  // metros por píxel
    const zIdeal = Math.min(19, Math.max(12, Math.ceil(Math.log2(156543.03392 * Math.cos(latMed * Math.PI / 180) / resDeseada))));

    const componer = async z => {
        const n = Math.pow(2, z);
        const xT = lon => (lon + 180) / 360 * n;
        const yT = lat => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n;
        const px0 = xT(lonO) * 256, px1 = xT(lonE) * 256, py0 = yT(latN) * 256, py1 = yT(latS) * 256;
        const W = Math.round(px1 - px0), H = Math.round(py1 - py0);
        if (!(W > 0 && H > 0 && W < 6000 && H < 6000)) return null;
        const lienzo = document.createElement('canvas');
        lienzo.width = W; lienzo.height = H;
        const ctx = lienzo.getContext('2d');
        ctx.fillStyle = '#EDEDED'; ctx.fillRect(0, 0, W, H);
        const teselas = [];
        for (let tx = Math.floor(px0 / 256); tx <= Math.floor(px1 / 256); tx++) {
            for (let ty = Math.floor(py0 / 256); ty <= Math.floor(py1 / 256); ty++) teselas.push([tx, ty]);
        }
        let fallos = 0;
        await Promise.all(teselas.map(async ([tx, ty]) => {
            const url = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + z + '/' + ty + '/' + tx;
            try {
                const r = await fetch(url, { mode: 'cors' });
                if (!r.ok) throw new Error(String(r.status));
                const bmp = await createImageBitmap(await r.blob());
                ctx.drawImage(bmp, tx * 256 - px0, ty * 256 - py0);
            } catch (e) { fallos++; }
        }));
        if (fallos === teselas.length) return null;
        // Esri devuelve teselas de relleno ("Map data not yet available") donde no
        // tiene imagen a ese zoom: son casi lisas. Se miden y, si lo son, se baja.
        const datos = ctx.getImageData(0, 0, W, H).data;
        let suma = 0, suma2 = 0, n2 = 0;
        for (let i = 0; i < datos.length; i += 4 * 17) {
            const l = 0.299 * datos[i] + 0.587 * datos[i + 1] + 0.114 * datos[i + 2];
            suma += l; suma2 += l * l; n2++;
        }
        const desv = Math.sqrt(Math.max(0, suma2 / n2 - Math.pow(suma / n2, 2)));
        return { lienzo, W, H, z, teselas: teselas.length, fallos, desv };
    };

    let mejor = null;
    for (let z = zIdeal; z >= 15; z--) {
        const r = await componer(z);
        if (!r) continue;
        if (!mejor || r.desv > mejor.desv) mejor = r;
        if (r.desv > 14) break;                                       // hay imagen de verdad
    }
    if (!mejor) return null;
    const foto = {
        png: mejor.lienzo.toDataURL('image/jpeg', 0.82), formato: 'JPEG',
        centro, ancho, alto, zoom: mejor.z, teselas: mejor.teselas, fallos: mejor.fallos,
        detalle: Math.round(mejor.desv), atribucion: 'Esri, Maxar'
    };
    _fotoCache = { clave, foto };
    return foto;
}

// ── 5 · Exportar ─────────────────────────────────────────────────────────────
[100, 150, 200, 250, 300, 500, 750, 1000, 1500, 2000, 2500, 5000].forEach(s => {
    const o = document.createElement('option'); o.value = s; o.textContent = '1:' + s; $('#escala').appendChild(o);
});

async function exportar(tipo, btn) {
    if (!estado.analisis) return;
    const pend = estado.analisis.linderos.filter(l => !String(l.colindante || '').trim()).length;
    if (pend && !confirm(`Hay ${pend} lindero(s) sin colindante. ¿Exportar de todas formas? Saldrán como "POR COMPLETAR".`)) return;
    const texto = btn.textContent;
    ocupado(btn, true); btn.textContent = 'Generando…';
    try {
        const datos = leerDatos();
        // La foto satelital solo tiene sentido en el PDF y solo si hay recuadro
        if (tipo === 'pdf' && datos.ubicacion && $('#foto-satelital').checked) {
            btn.textContent = 'Bajando imagen…';
            const ub = estado.analisis.contexto && estado.analisis.contexto.ubicacion;
            const centro = (ub && ub.centro) || estado.analisis.centroide;
            const radio = (ub && ub.radio) || ((estado.config.tolerancias || {}).radio_ubicacion_m) || 250;
            try { datos.satelital = await capturarSatelital(centro, radio); } catch (e) { datos.satelital = null; }
            if (!datos.satelital) aviso('No se pudo bajar la imagen satelital; el recuadro va con el esquema de predios.', true);
            btn.textContent = 'Generando…';
        }
        const r = await api('/api/exportar/' + tipo, {
            analisis: estado.analisis, datos,
            registral: estado.registral, opcionesConciliacion: opcionesConciliacion()
        });
        const nombre = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
        descargar(await r.blob(), nombre ? nombre[1] : 'planimetria.' + tipo);
    } catch (e) { aviso(e.message, true); }
    finally { ocupado(btn, false); btn.textContent = texto; }
}
function descargar(blob, nombre) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}
$('#exportar-pdf').addEventListener('click', e => exportar('pdf', e.currentTarget));
$('#exportar-dxf').addEventListener('click', e => exportar('dxf', e.currentTarget));

// ── Proyecto: guardar y abrir ────────────────────────────────────────────────
$('#guardar-proyecto').addEventListener('click', () => {
    if (!estado.analisis) return;
    const proyecto = {
        tipo: 'planimetria-caech', version: 2, guardado: new Date().toISOString(),
        archivo: estado.nombreArchivo, lectura: estado.lectura, codigos: [...estado.codigos], candidato: estado.candidato,
        normal: estado.normal, opciones: estado.opciones, ediciones: estado.ediciones, cortes: estado.cortes,
        registral: estado.registral, opcionesConciliacion: opcionesConciliacion(),
        analisis: estado.analisis, datos: Object.assign(leerDatos(), { satelital: undefined })
    };
    const d = proyecto.datos;
    const base = String(d.propietario || 'predio').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40);
    descargar(new Blob([JSON.stringify(proyecto)], { type: 'application/json' }), `PROYECTO_${base}.planimetria.json`);
});
$('#abrir-proyecto').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
        const p = JSON.parse(await f.text());
        if (p.tipo !== 'planimetria-caech') throw new Error('El archivo no es un proyecto de Planimetría CAE-Ch.');
        Object.assign(estado, {
            nombreArchivo: p.archivo, lectura: p.lectura, codigos: new Set(p.codigos || []), candidato: p.candidato || 0,
            normal: p.normal, opciones: p.opciones, ediciones: p.ediciones || {}, analisis: p.analisis,
            cortes: p.cortes || [], registral: p.registral || null, conciliacion: null
        });
        $('#frente').value = (p.opcionesConciliacion && p.opcionesConciliacion.frente) || '';
        $('#excluir').value = ((p.opciones && p.opciones.excluirClaves) || []).join(',');
        const form = $('#datos');
        for (const [k, v] of Object.entries(p.datos || {})) if (form.elements[k] && typeof v === 'string') form.elements[k].value = v;
        const dd = p.datos || {};
        estado.propietarios = Array.isArray(dd.propietarios) && dd.propietarios.length ? dd.propietarios
            : dd.propietario ? [{ nombre: dd.propietario, documento: dd.documento || '', calidad: 'Propietario/a', participacion: '', observacion: '' }] : [];
        pintarPropietarios();
        pintarPersonasCertificado();
        if (p.datos && p.datos.formato) $('#formato').value = p.datos.formato;
        if (p.datos && p.datos.escala !== undefined) $('#escala').value = p.datos.escala;
        if (p.datos && p.datos.ubicacion !== undefined) $('#mapa-ubicacion').checked = p.datos.ubicacion !== false;
        if (p.datos && p.datos.satelital !== undefined) $('#foto-satelital').checked = !!p.datos.satelital;
        if (p.opciones) {
            $('#tol-lindero').value = p.opciones.tolLindero || 1;
            $('#osm').checked = !!p.opciones.osm;
            document.querySelectorAll('[data-margen]').forEach(i => { i.value = p.opciones.margenes && p.opciones.margenes[i.dataset.margen] !== undefined ? p.opciones.margenes[i.dataset.margen] : ''; });
        }
        if (estado.lectura) pintarLectura();
        if (estado.normal) {
            let h = estado.normal.avisos.map(t => `<div class="aviso alerta">${esc(t)}</div>`).join('');
            $('#validacion').innerHTML = h + `<div class="aviso ok">Proyecto abierto: ${estado.normal.vertices.length} vértices.</div>`;
        }
        ['#paso-2'].concat(PASOS_RESULTADO).forEach(s => { $(s).hidden = false; });
        aplicarEdiciones(estado.analisis);
        dibujarAnalisis(estado.analisis);
        pintarResultados();
        pintarRegistral();
        await conciliar();
        $('#guardar-proyecto').disabled = false;
        aviso('Proyecto abierto. Puede volver a analizar para actualizar con las capas vigentes; las ediciones de colindantes se conservan.');
    } catch (err) { aviso(err.message, true); }
});

// ── Arranque ─────────────────────────────────────────────────────────────────
(async () => {
    try {
        estado.config = await (await api('/api/estado')).json();
        if (estado.config.tolerancias && estado.config.tolerancias.lindero_m) $('#tol-lindero').value = estado.config.tolerancias.lindero_m;
        pintarMargenes();
        pintarPropietarios();
        const arranque = new Date(estado.config.arrancado);
        $('#estado').textContent = `Planimetría ${estado.config.version} · servidor iniciado ${arranque.toLocaleString('es-EC')}`;
        const faltan = estado.config.elementos.filter(e => !e.disponible);
        if (faltan.length) aviso(`Faltan capas certificadas (${faltan.length}). Ejecute "npm run preparar" en planimetria/.`, true);
    } catch (e) { aviso('No se pudo conectar con el servidor local: ' + e.message, true); }
})();
