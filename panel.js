// ════════════════════════════════════════════════════════════════════
//  Panel de administracion del CAE-CH (panel.html).
//
//  Vive en archivo propio y no dentro de panel.html para que la pagina
//  pueda declarar una CSP sin 'unsafe-inline': el panel maneja el token
//  del administrador, y asi ningun texto inyectado en la pagina llega a
//  ejecutarse. No vuelva a poner <script> en linea ni onclick= en el
//  panel: la CSP los bloquea.
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // El panel no habla con el API por su cuenta: reutiliza el cliente de
    // caech-acceso.js, que ya pone el token, trata el 401 y explica los
    // fallos de red en castellano.
    const acceso = window.caechAcceso;
    const pedir = (metodo, ruta, cuerpo) => acceso.peticion(metodo, ruta, cuerpo);

    const $ = id => document.getElementById(id);
    let perfil = null;
    let misPermisos = {};
    let cuentas = [];

    // Herramientas que se conceden cuenta por cuenta: las de HERRAMIENTAS en
    // api/src/sesiones.js que NO están en HERRAMIENTAS_ABIERTAS. Hoy no hay
    // ninguna —la planimetría se abrió a toda cuenta el 2026-10-02—; si se
    // añade una, basta ponerla aquí para que el padrón dibuje su casilla.
    const HERRAMIENTAS = [];

    const COBRO = {
        libre: ['admin', 'libre'],
        cupo:  ['si', 'cupo'],
        pago:  ['neutra', 'pago']
    };
    const VIA = { cupo: 'cupo del mes', pago: 'pago en línea', admin: 'administración' };
    const usd = c => 'USD ' + (c / 100).toFixed(2).replace('.', ',');

    // ── Utilidades de presentación ──────────────────────────────

    /** Nunca se arma HTML con datos del servidor sin pasar por aquí. */
    function esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function fecha(iso, conHora) {
        if (!iso) return '—';
        const d = new Date(iso);
        if (isNaN(d)) return '—';
        const opciones = conHora
            ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
            : { day: '2-digit', month: 'short', year: 'numeric' };
        return d.toLocaleString('es-EC', opciones);
    }

    function avisar(id, clase, mensaje) {
        const caja = $(id);
        if (!caja) return;
        caja.innerHTML = mensaje ? '<div class="aviso ' + clase + '">' + mensaje + '</div>' : '';
    }

    const insignia = (clase, texto) => '<span class="insignia ' + clase + '">' + esc(texto) + '</span>';

    /**
     * Ventana de un solo uso para las claves temporales. No se puede volver
     * a consultar una clave: o se copia ahora, o se restablece otra vez.
     */
    function mostrarClave(usuario, clave, aviso) {
        const fondo = document.createElement('div');
        fondo.style.cssText = 'position:fixed;inset:0;background:rgba(46,50,56,.62);display:flex;'
            + 'align-items:center;justify-content:center;z-index:1000;padding:16px';
        fondo.innerHTML =
            '<div class="tarjeta" style="max-width:440px;width:100%;margin:0">'
            + '<h2><i class="fas fa-key"></i> Clave temporal de ' + esc(usuario) + '</h2>'
            + '<div class="clave-temporal">' + esc(clave) + '</div>'
            + '<div class="aviso info">' + esc(aviso || '') + '</div>'
            + '<button class="btn" data-cerrar style="width:100%">Ya la anoté</button></div>';
        document.body.appendChild(fondo);
        fondo.querySelector('[data-cerrar]').addEventListener('click', () => fondo.remove());
    }

    // ── Sesión ──────────────────────────────────────────────────

    async function cargarSesion() {
        const r = await pedir('GET', '/api/sesion');
        perfil = r.estado === 200 ? r.datos.afiliado : null;
        misPermisos = (r.estado === 200 && r.datos.permisos) || {};
        pintar();
        if (!perfil) return;
        // El padrón se trae de entrada aunque la pestaña abierta sea otra:
        // es lo que alimenta el contador de registros por cotejar, y ese
        // aviso tiene que verse sin tener que ir a buscarlo.
        if (perfil.rol === 'admin') cargarPadron();
        cargarHoja(hojaActual());
    }

    function pintar() {
        const hay = !!perfil;
        $('puerta').hidden = hay;
        $('panel').hidden = !hay;

        // Las pestañas de administración solo existen para quien lo es. El
        // Worker vuelve a comprobarlo en cada llamada: esto es comodidad,
        // no seguridad.
        const admin = hay && perfil.rol === 'admin';
        document.querySelectorAll('[data-admin]').forEach(b => { b.hidden = !admin; });

        const caja = $('sesion');
        if (!hay) {
            caja.innerHTML = '';
            return;
        }
        caja.innerHTML =
            '<span class="quien"><i class="fas fa-user-check"></i><b>'
            + esc(perfil.nombre || perfil.usuario) + '</b></span>'
            + (admin ? insignia('admin', 'Administrador') : insignia('neutra', perfil.rol))
            + '<button class="btn btn-outline" id="btn-salir"><i class="fas fa-sign-out-alt"></i> Salir</button>';
        $('btn-salir').addEventListener('click', async () => {
            await acceso.cerrarSesion();
            perfil = null;
            cuentas = [];
            pintar();
        });

        pintarMiCuenta();
        pintarHerramientas();
        cargarCobros();
        cargarEquipo();
    }

    // ── Mis predios, pagos y equipo ─────────────────────────────

    async function cargarCobros() {
        const r = await pedir('GET', '/api/cuenta/cobros');
        if (r.estado !== 200) return;
        const d = r.datos;
        const t = d.tarifa || {};

        $('cobro-sub').innerHTML = d.cobro === 'libre'
            ? 'Su cuenta descarga cualquier predio sin cupo ni pago.'
            : 'Cada predio habilitado abre su DICAT, su CSV y su DXF durante ' + (t.dias_acceso || 30)
              + ' días. ' + (d.cobro === 'cupo'
                ? 'Como colegiado tiene ' + (d.cupo.total === 1 ? '1 predio gratuito' : d.cupo.total + ' predios gratuitos')
                  + ' al mes; los adicionales tienen el 50 % de descuento y cuestan '
                : 'Cada predio cuesta ') + usd(t.precio || 0) + ', IVA incluido.'
              + (t.cobro_en_linea ? '' : ' <b>El pago en línea aún no está habilitado</b>: puede pagar en la sede.');

        $('mis-cifras').innerHTML = d.cupo
            ? '<div class="cifra"><b>' + d.cupo.restantes + '</b><span>gratis este mes</span></div>'
              + '<div class="cifra"><b>' + d.cupo.usados + '</b><span>de ' + d.cupo.total + ' usados</span></div>'
            : '';
        $('mis-cifras').hidden = !d.cupo;

        const predios = d.predios || [];
        $('tabla-mis-predios').innerHTML = predios.length
            ? predios.map(p => '<tr><td class="mono">' + esc(p.clave_catastral) + '</td>'
                + '<td>' + esc(VIA[p.via] || p.via) + '</td>'
                + '<td class="tenue">' + fecha(p.creado_en) + '</td>'
                + '<td class="tenue">' + fecha(p.vence_en) + '</td>'
                + '<td>' + (/^GEO-/.test(p.clave_catastral) ? ''
                    : '<a class="btn btn-outline chico" href="geovisor.html?clave=' + encodeURIComponent(p.clave_catastral)
                      + '">Abrir</a>') + '</td></tr>').join('')
            : '<tr><td colspan="5" class="vacio">' + (d.cobro === 'libre'
                ? 'No hace falta habilitar predios en su cuenta.'
                : 'Todavía no tiene predios habilitados. Elija uno en el GeoVisor y pida su DICAT.') + '</td></tr>';

        const pagos = d.pagos || [];
        $('mis-pagos').innerHTML = pagos.length
            ? '<h2 style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:8px">Pagos</h2>'
              + '<div class="tabla-marco"><table><thead><tr><th>Fecha</th><th>Predio</th><th>Monto</th><th>Estado</th>'
              + '<th>Transacción</th></tr></thead><tbody>'
              + pagos.map(p => '<tr><td class="tenue">' + fecha(p.creado_en, true) + '</td>'
                + '<td class="mono">' + esc(p.clave_catastral) + '</td><td>' + usd(p.monto) + '</td>'
                + '<td>' + insigniaPago(p.estado) + '</td>'
                + '<td class="mono">' + esc(p.transaccion || '—') + '</td></tr>').join('')
              + '</tbody></table></div>'
            : '';
    }

    function insigniaPago(estado) {
        const clases = { aprobado: 'si', cancelado: 'neutra', rechazado: 'no', preparado: 'espera' };
        return insignia(clases[estado] || 'neutra', estado);
    }

    // La declaración vigente, para poder abrir el formulario relleno cuando
    // lo que hace falta no es cambiar de equipo sino corregir un dato.
    let miEquipo = null;

    async function cargarEquipo() {
        const r = await pedir('GET', '/api/equipo');
        if (r.estado !== 200) return;
        const e = miEquipo = r.datos.declaracion;
        $('mi-equipo').innerHTML = e
            ? '<div class="tabla-marco" style="margin-bottom:14px"><table><tbody>'
              + fila('Equipo', esc(e.tipo_nombre)) + fila('Marca y modelo', esc(e.marca + ' ' + e.modelo))
              + fila('Serie', '<span class="mono">' + esc(e.serie) + '</span>')
              + (e.gsd_cm ? fila('Resolución', esc(e.gsd_cm) + ' cm/px') : '')
              + fila('Declarado', fecha(e.declarado_en, true)) + '</tbody></table></div>'
            : '<div class="aviso info">Todavía no declaró su equipo. Hace falta para abrir la planimetría.</div>';

        // «Corregir» solo tiene sentido si hay algo que corregir.
        $('btn-equipo-corregir').hidden = !e;
        $('btn-equipo').innerHTML = '<i class="fas fa-' + (e ? 'satellite-dish' : 'pen') + '"></i> '
            + (e ? 'Declarar otro equipo' : 'Declarar equipo');
    }

    const trasDeclarar = () => { cargarEquipo(); pintarHerramientas(); };

    // Dos puertas a la misma declaración: en blanco cuando se cambia de
    // equipo, y rellena cuando solo hay que arreglar un dato. En los dos
    // casos se guarda una fila nueva —ver abrirDeclaracion()—, porque las
    // anteriores son la constancia de con qué equipo se trabajó.
    $('btn-equipo').addEventListener('click', () => acceso.abrirDeclaracion(trasDeclarar));
    $('btn-equipo-corregir').addEventListener('click', () => acceso.abrirDeclaracion(trasDeclarar, miEquipo));

    function pintarMiCuenta() {
        const p = perfil;
        const validado = p.rol === 'afiliado' || p.rol === 'admin' || p.registro_validado;
        $('mi-cuenta').innerHTML =
            '<div class="tabla-marco"><table><tbody>'
            + fila('Nombre', esc(p.nombre))
            + fila('Usuario', '<span class="mono">' + esc(p.usuario) + '</span>')
            + fila('Correo', esc(p.correo) + ' '
                + (p.correo_verificado ? insignia('si', 'confirmado') : insignia('no', 'sin confirmar')))
            + fila('N.º de registro', (p.registro_profesional ? '<span class="mono">' + esc(p.registro_profesional) + '</span> ' : '—' )
                + (p.registro_profesional
                    ? (validado ? insignia('si', 'validado') : insignia('espera', 'por cotejar'))
                    : ''))
            + fila('Rol', esc(p.rol))
            + fila('Predios', misPermisos.cobro === 'libre' ? 'libres, sin cupo ni pago'
                : misPermisos.cobro === 'cupo' ? 'cupo mensual de colegiado; los adicionales se pagan'
                : 'se habilitan con un pago por predio')
            + fila('Estado', esc(p.estado))
            + fila('Vigencia', p.vigencia_hasta ? fecha(p.vigencia_hasta) : 'sin caducidad')
            + fila('Último acceso', fecha(p.ultimo_acceso, true))
            + '</tbody></table></div>';
    }

    const fila = (rotulo, valor) =>
        '<tr><th style="width:180px">' + rotulo + '</th><td>' + valor + '</td></tr>';

    function pintarHerramientas() {
        // Lo que se muestra aquí no se deduce del perfil: es el veredicto que
        // dio el Worker en `permisos`, el mismo que aplica al pedir de verdad.
        const cobro = misPermisos.cobro;
        const planimetria = !!misPermisos.planimetria;

        const tarjetas = [
            {
                icono: 'fa-map-location-dot', nombre: 'GeoVisor',
                texto: 'El mapa completo, con todas las capas. Es público: no hace falta cuenta.',
                estado: insignia('si', 'abierto'),
                enlace: '<a class="btn btn-outline chico" href="geovisor.html">Abrir</a>'
            },
            {
                icono: 'fa-file-pdf', nombre: 'DICAT, CSV y DXF',
                texto: 'Las tres descargas del visor, que se habilitan por predio: libres para el '
                     + 'administrador, con cupo mensual para el colegiado y con un pago para el resto.',
                estado: cobro ? insignia(COBRO[cobro][0], COBRO[cobro][1]) : insignia('espera', 'pendiente'),
                enlace: '<a class="btn btn-outline chico" href="geovisor.html">Ir al visor</a>'
            },
            {
                icono: 'fa-drafting-compass', nombre: 'Planimetría',
                texto: 'Planimetrías de predios: DXF georreferenciado e informe de '
                     + 'linderación en PDF. Gratuita para toda cuenta, con el equipo de levantamiento '
                     + 'declarado.',
                estado: planimetria ? insignia('si', 'gratuita') : insignia('no', 'sin acceso'),
                enlace: planimetria
                    ? '<a class="btn btn-outline chico" href="planimetria.html">Abrir</a>'
                    : '<span class="tenue">Cambie su contraseña temporal para abrirla.</span>'
            }
        ];

        $('lista-herramientas').innerHTML = tarjetas.map(t =>
            '<div class="herramienta"><h3><i class="fas ' + t.icono + '"></i>' + t.nombre
            + '</h3><p>' + t.texto + '</p><div>' + t.estado + '</div>'
            + (t.enlace ? '<div>' + t.enlace + '</div>' : '') + '</div>').join('');
    }

    // ── Pestañas ────────────────────────────────────────────────

    const hojaActual = () => {
        const b = document.querySelector('.pestanas button.activa');
        return b ? b.dataset.hoja : 'cuenta';
    };

    $('pestanas').addEventListener('click', e => {
        const boton = e.target.closest('button[data-hoja]');
        if (!boton) return;
        document.querySelectorAll('.pestanas button').forEach(b => b.classList.toggle('activa', b === boton));
        document.querySelectorAll('section[data-hoja]').forEach(s => { s.hidden = s.dataset.hoja !== boton.dataset.hoja; });
        cargarHoja(boton.dataset.hoja);
    });

    function cargarHoja(hoja) {
        if (!perfil) return;
        if (hoja === 'padron'    && perfil.rol === 'admin') cargarPadron();
        if (hoja === 'pagos'     && perfil.rol === 'admin') cargarPagos();
        if (hoja === 'descargas' && perfil.rol === 'admin') cargarDescargas();
        if (hoja === 'bitacora'  && perfil.rol === 'admin') cargarEventos();
        if (hoja === 'solicitudes' && perfil.rol === 'admin') cargarSolicitudes();
    }

    // ── Padrón ──────────────────────────────────────────────────

    async function cargarPadron() {
        const r = await pedir('GET', '/api/admin/afiliados');
        if (r.estado !== 200) {
            return avisar('aviso-padron', 'error', esc((r.datos && r.datos.error) || 'No se pudo leer el padrón.'));
        }
        avisar('aviso-padron', '', '');
        cuentas = r.datos.afiliados || [];
        pintarPadron();
        pintarPendientes();
    }

    /**
     * La bandeja sale de la misma lista que el padrón —son las cuentas del
     * registro público con el número todavía sin cotejar—, así que no hace
     * falta una segunda llamada con ?pendientes=1.
     */
    function pintarPendientes() {
        const pendientes = cuentas.filter(c => c.origen === 'registro' && c.registro_profesional
            && !c.registro_validado && c.estado === 'activo');

        $('caja-pendientes').hidden = pendientes.length === 0;
        const contador = $('contador-pendientes');
        contador.hidden = pendientes.length === 0;
        contador.textContent = pendientes.length;
        $('etiqueta-pendientes').textContent = pendientes.length === 1
            ? '1 en espera' : pendientes.length + ' en espera';

        $('tabla-pendientes').innerHTML = pendientes.map(c =>
            '<tr><td><span class="nombre">' + esc(c.nombre) + '</span><br>'
            + '<span class="tenue mono">' + esc(c.usuario) + '</span></td>'
            + '<td><span class="mono">' + esc(c.registro_profesional || '—') + '</span></td>'
            + '<td>' + esc(c.correo) + ' '
            + (c.correo_verificado ? insignia('si', 'confirmado') : insignia('no', 'sin confirmar')) + '</td>'
            + '<td>' + fecha(c.creado_en) + '</td>'
            + '<td class="acciones">'
            + '<button class="btn chico" data-validar="' + esc(c.id) + '">'
            + '<i class="fas fa-check"></i> Validar</button></td></tr>').join('');
    }

    function pintarPadron() {
        const filtro = $('buscar').value.trim().toLowerCase();
        const lista = filtro
            ? cuentas.filter(c => [c.nombre, c.usuario, c.correo, c.registro_profesional]
                .some(v => String(v || '').toLowerCase().includes(filtro)))
            : cuentas;

        $('etiqueta-total').textContent = lista.length === cuentas.length
            ? cuentas.length + ' cuentas'
            : lista.length + ' de ' + cuentas.length;

        if (!lista.length) {
            $('tabla-padron').innerHTML = '<tr><td colspan="7" class="vacio">No hay cuentas que coincidan.</td></tr>';
            return;
        }

        $('tabla-padron').innerHTML = lista.map(c => {
            const cobro = c.permisos && c.permisos.cobro;
            const validado = c.rol === 'afiliado' || c.rol === 'admin' || c.registro_validado;
            // Sobre la propia cuenta no se ofrece ni suspenderse ni degradarse:
            // el Worker lo rechaza —para no dejar el sistema sin administrador—
            // y no tiene sentido ofrecer un botón que siempre va a fallar.
            const propia = c.id === perfil.id;
            const vencida = c.vigencia_hasta && new Date(c.vigencia_hasta) < new Date();

            const acciones = [];
            if (c.registro_profesional && !c.registro_validado) {
                acciones.push('<button class="btn chico" data-validar="' + esc(c.id) + '"><i class="fas fa-check"></i> Validar</button>');
            } else if (c.registro_validado && c.origen === 'registro') {
                acciones.push('<button class="btn btn-outline chico" data-invalidar="' + esc(c.id) + '">Quitar validación</button>');
            }
            acciones.push('<button class="btn btn-outline chico" data-clave="' + esc(c.id) + '"><i class="fas fa-key"></i> Clave</button>');
            if (cobro && cobro !== 'libre') {
                acciones.push('<button class="btn btn-outline chico" data-predio="' + esc(c.id) + '"><i class="fas fa-plus"></i> Predio</button>');
            }
            if (!propia) {
                acciones.push(c.estado === 'activo'
                    ? '<button class="btn btn-outline chico" data-suspender="' + esc(c.id) + '">Suspender</button>'
                    : '<button class="btn btn-outline chico" data-activar="' + esc(c.id) + '">Reactivar</button>');
            }
            if (c.bloqueado) {
                acciones.push('<button class="btn btn-outline chico" data-desbloquear="' + esc(c.id) + '">Desbloquear</button>');
            }

            return '<tr>'
                + '<td><span class="nombre">' + esc(c.nombre) + '</span><br>'
                + '<span class="tenue mono">' + esc(c.usuario) + '</span><br>'
                + '<span class="tenue">' + esc(c.correo) + '</span>'
                + (c.correo_verificado ? '' : ' ' + insignia('no', 'sin confirmar')) + '</td>'
                + '<td><span class="mono">' + esc(c.registro_profesional || '—') + '</span>'
                + (c.registro_profesional
                    ? '<br>' + (validado ? insignia('si', 'validado') : insignia('espera', 'por cotejar'))
                    // Sin confirmar el correo el numero no se reserva: pasa a la
                    // cuenta al confirmar, si sigue libre.
                    : c.registro_pendiente
                        ? '<br><span class="tenue mono">' + esc(c.registro_pendiente) + '</span> '
                          + insignia('no', 'al confirmar')
                        : '') + '</td>'
                + '<td>' + (propia
                    ? insignia('admin', 'usted')
                    : '<select class="rol-sel" data-rol="' + esc(c.id) + '">'
                      + ['usuario', 'afiliado', 'admin'].map(r =>
                          '<option value="' + r + '"' + (c.rol === r ? ' selected' : '') + '>' + r + '</option>').join('')
                      + '</select>') + '</td>'
                + '<td>' + (c.estado === 'activo' ? insignia('si', 'activo') : insignia('no', c.estado))
                + (c.bloqueado ? '<br>' + insignia('espera', 'bloqueado') : '')
                + (c.vigencia_hasta
                    ? '<br><span class="tenue">' + (vencida ? 'venció ' : 'vence ') + fecha(c.vigencia_hasta) + '</span>'
                    : '') + '</td>'
                + '<td><div class="tenue">Predios ' + (cobro ? insignia(COBRO[cobro][0], COBRO[cobro][1]) : insignia('no', 'no'))
                + '</div>' + HERRAMIENTAS.map(h => {
                    // El administrador las tiene por su rol: la casilla se
                    // muestra marcada y bloqueada, para que se vea el porque.
                    const suya = c.rol === 'admin' || (c.herramientas || []).indexOf(h.id) !== -1;
                    return '<label class="permiso" title="'
                        + (c.rol === 'admin' ? 'El administrador tiene todas las herramientas por su rol'
                                             : 'Conceder o quitar ' + h.nombre) + '">'
                        + '<input type="checkbox" data-herr="' + h.id + '" data-cuenta="' + esc(c.id) + '"'
                        + (suya ? ' checked' : '') + (c.rol === 'admin' ? ' disabled' : '') + '> '
                        + esc(h.nombre) + '</label>';
                }).join('') + '</td>'
                + '<td class="tenue">' + fecha(c.ultimo_acceso, true) + '</td>'
                + '<td><div class="acciones">' + acciones.join('') + '</div></td>'
                + '</tr>';
        }).join('');
    }

    $('buscar').addEventListener('input', pintarPadron);

    // Un solo oyente para toda la hoja del padrón: las filas se repintan
    // enteras en cada cambio y así no quedan oyentes huérfanos.
    document.querySelector('section[data-hoja="padron"]').addEventListener('click', async e => {
        const boton = e.target.closest('button[data-validar], button[data-invalidar], button[data-clave],'
            + ' button[data-suspender], button[data-activar], button[data-desbloquear], button[data-predio]');
        if (!boton) return;

        const d = boton.dataset;
        const id = d.validar || d.invalidar || d.clave || d.suspender || d.activar || d.desbloquear || d.predio;
        const cuenta = cuentas.find(c => c.id === id) || {};
        const quien = cuenta.nombre || cuenta.usuario || 'esta cuenta';

        // Habilitar un predio a mano: pago en la sede o un pago en línea que
        // PayPhone aprobó pero no llegó a confirmarse aquí.
        if (d.predio !== undefined) {
            const clave = (prompt('Clave catastral del predio que se habilita a ' + quien + ':') || '').trim();
            if (!clave) return;
            const motivo = (prompt('Motivo (queda en la bitácora):', 'pago en sede') || '').trim();
            boton.disabled = true;
            const r = await pedir('POST', '/api/admin/afiliados/' + id + '/predios', { clave_catastral: clave, motivo: motivo });
            boton.disabled = false;
            return avisar('aviso-padron', r.estado === 201 ? 'exito' : 'error', esc(r.estado === 201
                ? quien + ': predio ' + r.datos.clave_catastral + ' habilitado hasta el ' + fecha(r.datos.vence_en) + '.'
                : (r.datos.error || 'No se pudo habilitar el predio.')));
        }

        if (d.clave !== undefined) {
            if (!confirm('¿Restablecer la contraseña de ' + quien + '?\n\n'
                + 'Se cerrarán todas sus sesiones y tendrá que usar una clave temporal '
                + 'que deberá entregarle en persona.')) return;
            boton.disabled = true;
            const r = await pedir('POST', '/api/admin/afiliados/' + id + '/clave');
            boton.disabled = false;
            if (r.estado !== 200) return avisar('aviso-padron', 'error', esc(r.datos.error || 'No se pudo restablecer.'));
            mostrarClave(r.datos.usuario, r.datos.clave_temporal, r.datos.aviso);
            return cargarPadron();
        }

        let cambios = null;
        if (d.validar    !== undefined) cambios = { registro_validado: true };
        if (d.invalidar  !== undefined) {
            if (!confirm('¿Quitar la validación a ' + quien + '?\n\nPerderá el cupo de colegiado y pagará cada predio nuevo.')) return;
            cambios = { registro_validado: false };
        }
        if (d.suspender  !== undefined) {
            if (!confirm('¿Suspender a ' + quien + '?\n\nSe cerrarán sus sesiones abiertas.')) return;
            cambios = { estado: 'suspendido' };
        }
        if (d.activar    !== undefined) cambios = { estado: 'activo' };
        if (d.desbloquear!== undefined) cambios = { desbloquear: true };
        if (!cambios) return;

        boton.disabled = true;
        const r = await pedir('PATCH', '/api/admin/afiliados/' + id, cambios);
        boton.disabled = false;
        if (r.estado !== 200) {
            return avisar('aviso-padron', 'error', esc(r.datos.error || 'No se pudo aplicar el cambio.'));
        }
        avisar('aviso-padron', 'exito', esc(quien + ': ' + (r.datos.cambios || []).join(', ') + '.'));
        cargarPadron();
    });

    // Herramientas: la casilla manda la lista COMPLETA de esa cuenta, no el
    // cambio suelto. Así dar y quitar son la misma petición.
    document.querySelector('section[data-hoja="padron"]').addEventListener('change', async e => {
        const casilla = e.target.closest('input[data-herr]');
        if (!casilla) return;

        const id = casilla.dataset.cuenta;
        const cuenta = cuentas.find(c => c.id === id) || {};
        const quien = cuenta.nombre || cuenta.usuario || 'esta cuenta';
        const fila = casilla.closest('tr');
        const lista = [...fila.querySelectorAll('input[data-herr]:checked')].map(i => i.dataset.herr);

        casilla.disabled = true;
        const r = await pedir('PATCH', '/api/admin/afiliados/' + id, { herramientas: lista });
        casilla.disabled = false;
        avisar('aviso-padron', r.estado === 200 ? 'exito' : 'error',
            esc(r.estado === 200
                ? quien + ': ' + (r.datos.cambios || []).join(', ') + '.'
                : (r.datos.error || 'No se pudo cambiar las herramientas.')));
        cargarPadron();
    });

    // Cambio de rol. Se pregunta siempre: subir a administrador entrega el
    // padrón entero, y bajar a un afiliado le quita las descargas.
    document.querySelector('section[data-hoja="padron"]').addEventListener('change', async e => {
        const sel = e.target.closest('select[data-rol]');
        if (!sel) return;

        const id = sel.dataset.rol;
        const cuenta = cuentas.find(c => c.id === id) || {};
        const quien = cuenta.nombre || cuenta.usuario || 'esta cuenta';

        if (!confirm('¿Cambiar el rol de ' + quien + ' a «' + sel.value + '»?'
            + (sel.value === 'admin' ? '\n\nUn administrador ve y modifica todo el padrón.' : ''))) {
            return cargarPadron();
        }

        sel.disabled = true;
        const r = await pedir('PATCH', '/api/admin/afiliados/' + id, { rol: sel.value });
        sel.disabled = false;
        avisar('aviso-padron', r.estado === 200 ? 'exito' : 'error',
            esc(r.estado === 200
                ? quien + ': ' + (r.datos.cambios || []).join(', ') + '.'
                : (r.datos.error || 'No se pudo cambiar el rol.')));
        cargarPadron();
    });

    // ── Alta ────────────────────────────────────────────────────

    $('btn-alta').addEventListener('click', async () => {
        const datos = {
            nombre: $('alta-nombre').value,
            usuario: $('alta-usuario').value,
            correo: $('alta-correo').value,
            registro_profesional: $('alta-registro').value,
            rol: $('alta-rol').value,
            vigencia_hasta: $('alta-vigencia').value || null
        };
        if (!datos.nombre.trim() || !datos.usuario.trim() || !datos.correo.trim()) {
            return avisar('aviso-alta', 'error', 'Nombre, usuario y correo son obligatorios.');
        }

        const boton = $('btn-alta');
        boton.disabled = true;
        const r = await pedir('POST', '/api/admin/afiliados', datos);
        boton.disabled = false;

        if (r.estado !== 201) {
            return avisar('aviso-alta', 'error', esc((r.datos && r.datos.error) || 'No se pudo crear la cuenta.'));
        }
        avisar('aviso-alta', 'exito', 'Cuenta creada: ' + esc(r.datos.afiliado.usuario) + '.');
        mostrarClave(r.datos.afiliado.usuario, r.datos.clave_temporal, r.datos.aviso);
        ['alta-nombre', 'alta-usuario', 'alta-correo', 'alta-registro', 'alta-vigencia']
            .forEach(id => { $(id).value = ''; });
        cargarPadron();
    });

    // ── Pagos ───────────────────────────────────────────────────

    async function cargarPagos() {
        const r = await pedir('GET', '/api/admin/pagos?limite=200');
        if (r.estado !== 200) return;

        const por = {};
        (r.datos.resumen || []).forEach(f => { por[f.estado] = f; });
        const aprobados = por.aprobado || { n: 0, monto: 0 };
        $('cifras-pagos').innerHTML =
            '<div class="cifra"><b>' + aprobados.n + '</b><span>aprobados</span></div>'
            + '<div class="cifra"><b>' + usd(aprobados.monto) + '</b><span>cobrado, IVA incl.</span></div>'
            + ['cancelado', 'rechazado', 'preparado'].map(e =>
                '<div class="cifra"><b>' + ((por[e] && por[e].n) || 0) + '</b><span>' + e + 's</span></div>').join('');

        // La escoba solo se ofrece si hay algo que barrer.
        $('btn-pagos-limpiar').hidden = !((por.preparado && por.preparado.n) > 0);

        const filas = r.datos.pagos || [];
        $('tabla-pagos').innerHTML = filas.length
            ? filas.map(p =>
                '<tr><td class="tenue">' + fecha(p.creado_en, true) + '</td>'
                + '<td>' + esc(p.nombre || '—') + (p.usuario ? '<br><span class="tenue mono">' + esc(p.usuario) + '</span>' : '') + '</td>'
                + '<td class="mono">' + esc(p.clave_catastral) + '</td>'
                + '<td>' + usd(p.monto) + '<br><span class="tenue">base ' + usd(p.base) + ' + IVA ' + usd(p.iva) + '</span></td>'
                + '<td>' + insigniaPago(p.estado) + (p.detalle ? '<br><span class="tenue">' + esc(p.detalle) + '</span>' : '') + '</td>'
                + '<td class="mono">' + esc(p.transaccion || '—')
                + (p.autorizacion ? '<br><span class="tenue">aut. ' + esc(p.autorizacion) + '</span>' : '')
                + '<br><span class="tenue">' + esc(p.id) + '</span></td>'
                // El borrado solo aparece en los 'preparados': los demas son
                // constancia de que algo paso con el dinero de alguien.
                + '<td>' + (p.estado === 'preparado'
                    ? '<button class="btn btn-linea chico" data-pago="' + esc(p.id) + '"'
                      + ' title="Borrar este pago preparado"><i class="fas fa-trash"></i></button>'
                    : '') + '</td></tr>').join('')
            : '<tr><td colspan="7" class="vacio">Todavía no hay pagos.</td></tr>';
    }

    /** Borra un preparado suelto o todos los que pasaron la ventana de gracia. */
    async function borrarPreparados(id) {
        const r = id
            ? await pedir('DELETE', '/api/admin/pagos/' + encodeURIComponent(id))
            : await pedir('DELETE', '/api/admin/pagos/preparados');

        if (r.estado !== 200) {
            return avisar('aviso-pagos', 'error', esc((r.datos && r.datos.error) || 'No se pudo borrar.'));
        }
        const n = r.datos.borrados || 0;
        avisar('aviso-pagos', n ? 'exito' : 'info',
            esc(r.datos.aviso || (n === 1 ? 'Pago preparado borrado.' : n + ' pagos preparados borrados.')));
        cargarPagos();
    }

    $('btn-pagos-limpiar').addEventListener('click', () => {
        if (!confirm('¿Borrar todos los pagos en «preparado» sin ejecutar?\n\n'
            + 'Son intentos que nunca llegaron a cobrarse. Los de los últimos 30 minutos no se '
            + 'tocan: todavía podrían estar confirmándose en PayPhone.')) return;
        borrarPreparados(null);
    });

    $('tabla-pagos').addEventListener('click', e => {
        const b = e.target.closest('button[data-pago]');
        if (!b) return;
        if (!confirm('¿Borrar el pago preparado ' + b.dataset.pago + '?\n\nNo hubo cobro: es un intento que no se completó.')) return;
        borrarPreparados(b.dataset.pago);
    });

    // ── Descargas ───────────────────────────────────────────────

    async function cargarDescargas() {
        const r = await pedir('GET', '/api/admin/descargas?limite=200');
        if (r.estado !== 200) return;

        const total = {};
        (r.datos.resumen || []).forEach(f => { total[f.formato] = (total[f.formato] || 0) + f.n; });
        const suma = Object.values(total).reduce((a, b) => a + b, 0);

        $('cifras-descargas').innerHTML =
            '<div class="cifra"><b>' + suma + '</b><span>en total</span></div>'
            + ['pdf', 'csv', 'dxf'].map(f =>
                '<div class="cifra"><b>' + (total[f] || 0) + '</b><span>' + f.toUpperCase() + '</span></div>').join('');

        const filas = r.datos.descargas || [];
        $('tabla-descargas').innerHTML = filas.length
            ? filas.map(d =>
                '<tr><td class="tenue">' + fecha(d.creado_en, true) + '</td>'
                + '<td>' + insignia('neutra', String(d.formato).toUpperCase()) + '</td>'
                + '<td>' + esc(d.nombre || d.correo_freemium || '—')
                + (d.usuario ? '<br><span class="tenue mono">' + esc(d.usuario) + '</span>' : '') + '</td>'
                + '<td class="mono">' + esc(d.clave_catastral || '—') + '</td></tr>').join('')
            : '<tr><td colspan="4" class="vacio">Todavía no hay descargas registradas.</td></tr>';
    }

    // ── Bitácora ────────────────────────────────────────────────

    async function cargarEventos() {
        const r = await pedir('GET', '/api/admin/eventos?limite=200');
        if (r.estado !== 200) return;
        const filas = r.datos.eventos || [];
        $('tabla-eventos').innerHTML = filas.length
            ? filas.map(e =>
                '<tr><td class="tenue">' + fecha(e.creado_en, true) + '</td>'
                + '<td class="mono">' + esc(e.tipo) + '</td>'
                + '<td>' + esc(e.usuario || '—') + '</td>'
                + '<td class="tenue">' + esc(e.detalle || '') + '</td></tr>').join('')
            : '<tr><td colspan="4" class="vacio">Sin eventos registrados.</td></tr>';
    }

    // ── Solicitudes presenciales ────────────────────────────────
    //
    // La hoja del mostrador de la sede. A diferencia de la versión que
    // vivía en un solo navegador, esto habla con el Worker: el número es
    // institucional y la lista es la misma desde cualquier equipo.
    //
    // La validación de aquí es cortesía para quien escribe con alguien
    // esperando delante. La que decide qué entra en la base está en
    // api/src/solicitudes.js, y es la misma.

    const CALIDADES = [
        'Propietario/a', 'Copropietario/a', 'Apoderado/a o autorizado/a',
        'Profesional a cargo', 'Posible comprador/a', 'Otra'
    ];
    const ENTREGAS = [
        'PDF al correo', 'Impreso', 'Impreso con firma y sello',
        'PDF firmado electronicamente', 'En memoria USB'
    ];
    const DOCTIPO = { cedula: 'Cédula', ruc: 'RUC', pasaporte: 'Pasaporte' };
    const ESTADO_SOL = {
        recibida:  ['espera', 'Recibida'],
        entregada: ['si', 'Entregada'],
        anulada:   ['no', 'Anulada']
    };

    let solicitudes = [];
    let solEditando = null;      // id de la solicitud abierta, si se corrige una
    let solSiguiente = '—';      // número que el Worker dice que tocará

    const digitos = t => String(t || '').replace(/\D+/g, '');

    /** La clave se lee por grupos, no como un chorro de 27 cifras. */
    function claveLegible(c) {
        if (!/^\d{27}$/.test(c)) return c || '';
        return c.slice(0, 2) + '-' + c.slice(2, 4) + '-' + c.slice(4, 6) + '-' + c.slice(6, 9)
             + '-' + c.slice(9, 12) + '-' + c.slice(12, 15) + '-' + c.slice(15, 18) + '-' + c.slice(18);
    }

    function cedulaValida(c) {
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

    function rucValido(r) {
        if (!/^\d{13}$/.test(r) || r.slice(10) === '000') return false;
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

    function telefonoValido(t) {
        let d = digitos(t);
        if (d.indexOf('593') === 0) d = '0' + d.slice(3);
        return /^09\d{8}$/.test(d) || /^0[2-7]\d{7}$/.test(d);
    }

    const correoValido = c => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(c);

    function pista(id, texto, clase) {
        const p = $('pista-' + id);
        if (!p) return;
        p.textContent = texto || '';
        p.className = 'pista' + (clase ? ' ' + clase : '');
    }
    function marcar(id, mal) {
        const e = $(id);
        if (e) e.classList.toggle('mal', !!mal);
    }

    /** Dibuja un grupo de opciones en fichas. */
    function pintarOpciones(contenedor, nombre, opciones) {
        $(contenedor).innerHTML = opciones.map(o =>
            '<label><input type="radio" name="' + nombre + '" value="' + esc(o) + '">'
            + '<span>' + esc(o) + '</span></label>').join('');
    }

    const elegido = nombre => {
        const r = document.querySelector('input[name="' + nombre + '"]:checked');
        return r ? r.value : '';
    };
    function elegir(nombre, valor) {
        document.querySelectorAll('input[name="' + nombre + '"]').forEach(r => {
            r.checked = r.value === valor;
        });
    }

    // ── Validación de cortesía ──────────────────────────────────

    function revisarDocumento() {
        const tipo = $('sol-doctipo').value;
        const v = $('sol-documento').value.trim();
        if (!v) { pista('sol-documento', ''); marcar('sol-documento', false); return; }
        if (tipo === 'cedula') {
            const ok = cedulaValida(digitos(v));
            pista('sol-documento', ok ? 'Cédula válida' : 'El dígito verificador no cuadra.', ok ? 'bien' : 'mal');
            return marcar('sol-documento', !ok);
        }
        if (tipo === 'ruc') {
            const ok = rucValido(digitos(v));
            pista('sol-documento', ok ? 'RUC válido' : 'No parece un RUC válido.', ok ? 'bien' : 'mal');
            return marcar('sol-documento', !ok);
        }
        pista('sol-documento', '');
        marcar('sol-documento', false);
    }

    function revisarClave() {
        const v = digitos($('sol-clave').value);
        if (!v) { pista('sol-clave', 'Normalmente 27 dígitos; los separadores se descartan.'); return marcar('sol-clave', false); }
        if (v.length < 10 || v.length > 30) {
            pista('sol-clave', 'Van ' + v.length + ' dígitos: la clave tiene entre 10 y 30.', 'mal');
            return marcar('sol-clave', true);
        }
        // El 2 % de los predios del catastro no tiene 27 dígitos —1.314 los
        // tienen de 15—, así que un largo distinto se comenta, no se bloquea.
        if (v.length !== 27) {
            pista('sol-clave', v + ' · ' + v.length + ' dígitos, no los 27 habituales. Compruébelo en el visor.');
            return marcar('sol-clave', false);
        }
        // 0601 = provincia 06 Chimborazo, cantón 01 Riobamba. Fuera de ahí el
        // predio no está en la capa del visor, pero no se bloquea: el caso
        // puede ser legítimo y el mostrador no se puede trabar.
        if (v.slice(0, 4) !== '0601') {
            pista('sol-clave', claveLegible(v) + ' · ojo: no empieza en 0601 (Riobamba).', 'mal');
            return marcar('sol-clave', true);
        }
        pista('sol-clave', claveLegible(v), 'bien');
        marcar('sol-clave', false);
    }

    function revisarSolicitud() {
        const faltas = [];
        const campo = (id, malo, mensaje, etiqueta) => {
            if (malo) { faltas.push(etiqueta); pista(id, mensaje, 'mal'); marcar(id, true); }
            else { pista(id, ''); marcar(id, false); }
        };

        campo('sol-solicitante', $('sol-solicitante').value.trim().length < 5,
              'Escriba nombres y apellidos.', 'el nombre del solicitante');

        const doc = $('sol-documento').value.trim(), tipo = $('sol-doctipo').value;
        if (!doc) campo('sol-documento', true, 'Obligatorio.', 'el documento');
        else if (tipo === 'cedula' && !cedulaValida(digitos(doc))) campo('sol-documento', true, 'El dígito verificador no cuadra.', 'una cédula válida');
        else if (tipo === 'ruc' && !rucValido(digitos(doc))) campo('sol-documento', true, 'No parece un RUC válido.', 'un RUC válido');
        else revisarDocumento();

        const tel = $('sol-telefono').value.trim();
        campo('sol-telefono', !tel || !telefonoValido(tel),
              tel ? 'No parece un celular ni un fijo del país.' : 'Obligatorio.', 'el teléfono');

        const entrega = elegido('sol-entrega');
        const correo = $('sol-correo').value.trim();
        if (correo && !correoValido(correo)) campo('sol-correo', true, 'La dirección no está bien formada.', 'un correo bien escrito');
        else if (!correo && entrega.indexOf('PDF') === 0) campo('sol-correo', true, 'Hace falta para enviar el PDF.', 'el correo (la entrega es en PDF)');
        else campo('sol-correo', false);

        if (!elegido('sol-calidad')) { faltas.push('la calidad en que solicita'); pista('sol-calidad', 'Elija una opción.', 'mal'); }
        else pista('sol-calidad', '');

        const claveDigitos = digitos($('sol-clave').value).length;
        if (claveDigitos < 10 || claveDigitos > 30) faltas.push('la clave catastral');
        revisarClave();

        const aux = digitos($('sol-auxiliar').value);
        if (aux.length > 27) { faltas.push('una clave auxiliar de 27 dígitos o menos'); pista('sol-auxiliar', 'No puede pasar de 27 dígitos.', 'mal'); }
        else pista('sol-auxiliar', '');

        campo('sol-direccion', $('sol-direccion').value.trim().length < 5, 'Obligatoria.', 'la dirección del predio');

        if (!entrega) { faltas.push('la forma de entrega'); pista('sol-entrega', 'Elija una opción.', 'mal'); }
        else pista('sol-entrega', '');

        // Las constancias solo se exigen al dar de alta: una solicitud ya
        // registrada se firmó en su momento, y corregir un teléfono no
        // vuelve a pedir la firma. El Worker aplica la misma regla.
        if (!solEditando) {
            const c1 = $('sol-c-datos').checked, c2 = $('sol-c-alcance').checked;
            $('caja-sol-datos').classList.toggle('mal', !c1);
            $('caja-sol-alcance').classList.toggle('mal', !c2);
            if (!c1 || !c2) { faltas.push('las dos constancias'); pista('sol-constancia', 'El solicitante debe aceptar ambas antes de firmar.', 'mal'); }
            else pista('sol-constancia', '');
        }

        campo('sol-atendido', !$('sol-atendido').value.trim(), 'Obligatorio.', 'quién atiende');
        return faltas;
    }

    // ── Búsqueda por propietario ────────────────────────────────
    //
    // Quien llega al mostrador suele traer el nombre y no la clave. El
    // GeoVisor ya resuelve eso, pero lo hace recorriendo la capa de catastro
    // que tiene cargada: 43 MB de geometría que aquí no pintan nada. El panel
    // usa un extracto sin coordenadas —nombre, clave, auxiliar y superficie—
    // que genera DATA SET/build_indice_propietarios.js, y lo trae una sola
    // vez, la primera vez que alguien escribe en la caja.

    const INDICE_URL = 'DATA SET/capas/indice_propietarios.json';
    const TOPE_RESULTADOS = 12;   // titulares distintos que se listan
    const TOPE_PREDIOS = 8;       // predios que se muestran de un mismo titular

    let indice = null;          // [[nombre, [[clave, area, aux?], …]], …]
    let indiceCargando = null;  // la promesa en vuelo, para no pedirlo dos veces

    /** Sin tildes y en mayúsculas: se teclea «lema» y encuentra «LEMÁ». */
    function plano(t) {
        return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
    }

    async function cargarIndice() {
        if (indice) return indice;
        if (indiceCargando) return indiceCargando;

        pista('sol-buscar-prop', 'Cargando el padrón de propietarios…');
        indiceCargando = fetch(INDICE_URL)
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(d => {
                indice = (d.datos || []).map(([nombre, predios]) => [nombre, plano(nombre), predios]);
                pista('sol-buscar-prop', indice.length.toLocaleString('es-EC') + ' propietarios · catastro al '
                    + (d.generado || '—'));
                return indice;
            })
            .catch(e => {
                indiceCargando = null;
                pista('sol-buscar-prop', 'No se pudo cargar el padrón de propietarios: escriba la clave a mano.', 'mal');
                console.warn('índice de propietarios:', e);
                return null;
            });
        return indiceCargando;
    }

    /**
     * Todas las palabras tecleadas tienen que aparecer, en cualquier orden:
     * «lema maria» encuentra a «LEMA GUARACA MARIA FERNANDA» tanto si el
     * mostrador escribe primero el apellido como si empieza por el nombre.
     */
    function buscarPropietarios(texto) {
        const palabras = plano(texto).split(/\s+/).filter(Boolean);
        if (!palabras.length) return [];
        const hallados = [];
        for (const fila of indice) {
            if (palabras.every(p => fila[1].includes(p))) {
                hallados.push(fila);
                if (hallados.length > TOPE_RESULTADOS) break;
            }
        }
        return hallados;
    }

    function resaltar(nombre, texto) {
        const palabras = plano(texto).split(/\s+/).filter(Boolean);
        const llano = plano(nombre);
        // Se marcan posiciones sobre la versión sin tildes y se recortan
        // sobre la original: ambas tienen el mismo número de caracteres
        // porque NFD solo separa los diacríticos, que se eliminan.
        const marcas = new Array(nombre.length).fill(false);
        palabras.forEach(p => {
            let desde = 0, i;
            while ((i = llano.indexOf(p, desde)) !== -1) {
                for (let k = i; k < i + p.length; k++) marcas[k] = true;
                desde = i + p.length;
            }
        });
        let html = '', abierta = false;
        for (let i = 0; i < nombre.length; i++) {
            if (marcas[i] && !abierta) { html += '<mark>'; abierta = true; }
            if (!marcas[i] && abierta) { html += '</mark>'; abierta = false; }
            html += esc(nombre[i]);
        }
        return html + (abierta ? '</mark>' : '');
    }

    function cerrarResultados() {
        $('sol-resultados').hidden = true;
        $('sol-resultados').innerHTML = '';
    }

    function pintarResultados(texto, hallados) {
        const caja = $('sol-resultados');
        if (!hallados.length) {
            caja.innerHTML = '<div class="nota">Ningún propietario coincide. '
                + 'Pruebe solo con el primer apellido, o escriba la clave a mano.</div>';
            caja.hidden = false;
            return;
        }

        const sobran = hallados.length > TOPE_RESULTADOS;
        const filas = sobran ? hallados.slice(0, TOPE_RESULTADOS) : hallados;

        caja.innerHTML = filas.map(([nombre, , predios]) => {
            const muestra = predios.slice(0, TOPE_PREDIOS);
            return muestra.map((pr, i) => {
                const [clave, area, aux] = pr;
                return '<button type="button" data-clave="' + esc(clave) + '"'
                     + ' data-aux="' + esc(aux || clave.slice(0, 18)) + '"'
                     + ' data-nombre="' + esc(nombre) + '">'
                     + '<span class="titular">' + resaltar(nombre, texto)
                     + (predios.length > 1 ? ' <span class="tenue">· predio ' + (i + 1) + ' de ' + predios.length + '</span>' : '')
                     + '</span><br>'
                     + '<span class="detalle">' + esc(claveLegible(clave) || clave)
                     + (area ? '  ·  ' + area.toLocaleString('es-EC') + ' m²' : '') + '</span></button>';
            }).join('')
            + (predios.length > TOPE_PREDIOS
                ? '<div class="nota">' + esc(nombre) + ' tiene ' + predios.length
                  + ' predios registrados; se muestran los ' + TOPE_PREDIOS
                  + ' primeros. Si no está el que busca, escriba la clave a mano.</div>'
                : '');
        }).join('')
        + (sobran ? '<div class="nota">Hay más coincidencias. Añada el segundo apellido o el nombre.</div>' : '');
        caja.hidden = false;
    }

    function tomarPredio(boton) {
        $('sol-clave').value = boton.dataset.clave;
        // La auxiliar solo se escribe si difiere de la clave: el campo es
        // opcional y repetir el prefijo no informa de nada.
        const aux = boton.dataset.aux;
        $('sol-auxiliar').value = (aux && aux !== boton.dataset.clave.slice(0, 18)) ? aux : '';
        $('sol-propietario').value = boton.dataset.nombre;
        $('sol-buscar-prop').value = '';
        cerrarResultados();
        revisarClave();
        pista('sol-auxiliar', '');
        // La dirección no está en el catastro y sigue siendo obligatoria: se
        // lleva el foco ahí, que es lo único que queda por preguntar.
        $('sol-direccion').focus();
    }

    function engancharBusquedaPropietario() {
        const caja = $('sol-buscar-prop');
        let temporizador;

        caja.addEventListener('input', () => {
            clearTimeout(temporizador);
            const texto = caja.value.trim();
            if (texto.length < 3) { cerrarResultados(); return; }
            temporizador = setTimeout(async () => {
                if (!await cargarIndice()) return;
                if (caja.value.trim().length < 3) return;   // se vació mientras cargaba
                pintarResultados(caja.value.trim(), buscarPropietarios(caja.value.trim()));
            }, 220);
        });

        // Se precarga al enfocar: mientras el mostrador teclea el primer
        // apellido, el padrón ya viene en camino.
        caja.addEventListener('focus', () => { cargarIndice(); });

        $('sol-resultados').addEventListener('click', e => {
            const b = e.target.closest('button[data-clave]');
            if (b) tomarPredio(b);
        });

        caja.addEventListener('keydown', e => { if (e.key === 'Escape') cerrarResultados(); });
        document.addEventListener('click', e => {
            if (!e.target.closest('.buscador-predio')) cerrarResultados();
        });
    }

    // ── Formulario ↔ registro ───────────────────────────────────

    function recogerSolicitud() {
        return {
            solicitante: $('sol-solicitante').value.trim(),
            documento_tipo: $('sol-doctipo').value,
            documento: $('sol-documento').value.trim(),
            telefono: $('sol-telefono').value.trim(),
            correo: $('sol-correo').value.trim(),
            registro_profesional: $('sol-registro').value.trim(),
            calidad: elegido('sol-calidad'),
            clave_catastral: digitos($('sol-clave').value),
            clave_auxiliar: digitos($('sol-auxiliar').value),
            direccion: $('sol-direccion').value.trim(),
            parroquia: $('sol-parroquia').value,
            barrio: $('sol-barrio').value.trim(),
            propietario_catastro: $('sol-propietario').value.trim(),
            entrega: elegido('sol-entrega'),
            ejemplares: parseInt($('sol-ejemplares').value, 10) || 1,
            finalidad: $('sol-finalidad').value,
            entrega_ofrecida: $('sol-ofrecida').value,
            observaciones: $('sol-observaciones').value.trim(),
            atendido_por: $('sol-atendido').value.trim(),
            estado: $('sol-estado').value,
            consentimiento_datos: $('sol-c-datos').checked,
            consentimiento_alcance: $('sol-c-alcance').checked
        };
    }

    function volcarSolicitud(s) {
        solEditando = s.id;
        $('sol-solicitante').value = s.solicitante || '';
        $('sol-doctipo').value = s.documento_tipo || 'cedula';
        $('sol-documento').value = s.documento || '';
        $('sol-telefono').value = s.telefono || '';
        $('sol-correo').value = s.correo || '';
        $('sol-registro').value = s.registro_profesional || '';
        elegir('sol-calidad', s.calidad);
        $('sol-clave').value = s.clave_catastral || '';
        $('sol-auxiliar').value = s.clave_auxiliar || '';
        $('sol-direccion').value = s.direccion || '';
        $('sol-parroquia').value = s.parroquia || '';
        $('sol-barrio').value = s.barrio || '';
        $('sol-propietario').value = s.propietario_catastro || '';
        elegir('sol-entrega', s.entrega);
        $('sol-ejemplares').value = s.ejemplares || 1;
        $('sol-finalidad').value = s.finalidad || '';
        $('sol-ofrecida').value = s.entrega_ofrecida || '';
        $('sol-observaciones').value = s.observaciones || '';
        $('sol-atendido').value = s.atendido_por || '';
        $('sol-estado').value = s.estado || 'recibida';
        $('sol-c-datos').checked = true;
        $('sol-c-alcance').checked = true;
        $('caja-sol-datos').classList.remove('mal');
        $('caja-sol-alcance').classList.remove('mal');
        $('sol-numero').textContent = s.numero;
        $('sol-buscar-prop').value = '';
        cerrarResultados();
        marcarEdicionSolicitud();
        revisarClave();
        revisarDocumento();
        $('sol-solicitante').scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    /** Avisa de si lo que hay en pantalla es una hoja nueva o una ya guardada. */
    function marcarEdicionSolicitud() {
        const m = $('sol-editando');
        m.hidden = !solEditando;
        m.textContent = solEditando ? 'Corrigiendo' : '';
        $('btn-sol-guardar').lastChild.textContent = solEditando ? ' Guardar cambios' : ' Solo registrar';
        $('btn-sol-imprimir').lastChild.textContent = solEditando ? ' Guardar e imprimir' : ' Registrar e imprimir';
    }

    function limpiarSolicitud() {
        solEditando = null;
        ['sol-solicitante', 'sol-documento', 'sol-telefono', 'sol-correo', 'sol-registro',
         'sol-clave', 'sol-auxiliar', 'sol-direccion', 'sol-barrio', 'sol-propietario',
         'sol-observaciones', 'sol-ofrecida', 'sol-buscar-prop'].forEach(id => { $(id).value = ''; });
        cerrarResultados();
        $('sol-doctipo').value = 'cedula';
        $('sol-parroquia').value = '';
        $('sol-finalidad').value = '';
        $('sol-ejemplares').value = 1;
        $('sol-estado').value = 'recibida';
        elegir('sol-calidad', '');
        elegir('sol-entrega', '');
        $('sol-c-datos').checked = false;
        $('sol-c-alcance').checked = false;
        $('caja-sol-datos').classList.remove('mal');
        $('caja-sol-alcance').classList.remove('mal');
        // Quien atiende suele ser el mismo durante todo el turno.
        $('sol-atendido').value = (perfil && (perfil.nombre || perfil.usuario)) || '';
        ['sol-solicitante', 'sol-documento', 'sol-telefono', 'sol-correo', 'sol-clave',
         'sol-auxiliar', 'sol-direccion', 'sol-atendido'].forEach(id => { pista(id, ''); marcar(id, false); });
        pista('sol-calidad', ''); pista('sol-entrega', ''); pista('sol-constancia', '');
        pista('sol-clave', 'Normalmente 27 dígitos; los separadores se descartan.');
        $('sol-numero').textContent = solSiguiente;
        avisar('aviso-solicitud', '', '');
        marcarEdicionSolicitud();
    }

    async function guardarSolicitud() {
        const faltas = revisarSolicitud();
        if (faltas.length) {
            avisar('aviso-solicitud', 'error', 'Falta ' + esc(faltas.slice(0, 3).join(', '))
                + (faltas.length > 3 ? ' y ' + (faltas.length - 3) + ' más' : '') + '.');
            const primero = document.querySelector('#aviso-solicitud ~ .campos .mal, .casilla.mal');
            if (primero) primero.scrollIntoView({ block: 'center', behavior: 'smooth' });
            return null;
        }

        const cuerpo = recogerSolicitud();
        const r = solEditando
            ? await pedir('PATCH', '/api/admin/solicitudes/' + encodeURIComponent(solEditando), cuerpo)
            : await pedir('POST', '/api/admin/solicitudes', cuerpo);

        if (r.estado !== 200 && r.estado !== 201) {
            avisar('aviso-solicitud', 'error', esc((r.datos && r.datos.error) || 'No se pudo registrar la solicitud.'));
            return null;
        }

        const s = r.datos.solicitud;
        solEditando = s.id;
        $('sol-numero').textContent = s.numero;
        marcarEdicionSolicitud();
        avisar('aviso-solicitud', 'exito', 'Solicitud <b>' + esc(s.numero) + '</b> guardada.');
        await cargarSolicitudes();
        return s;
    }

    // ── La constancia impresa ───────────────────────────────────

    function llenarHoja(s) {
        const o = (id, v) => { $(id).textContent = (v === '' || v == null) ? '—' : v; };
        o('h-numero', s.numero);
        o('h-fecha', fecha(s.recibida_en, true));
        o('h-solicitante', s.solicitante);
        $('h-doctipo').textContent = DOCTIPO[s.documento_tipo] || 'Documento';
        o('h-documento', s.documento);
        o('h-telefono', s.telefono);
        o('h-correo', s.correo);
        o('h-calidad', s.calidad);
        $('h-caja-registro').style.display = s.registro_profesional ? '' : 'none';
        o('h-registro', s.registro_profesional);
        o('h-clave', claveLegible(s.clave_catastral) || s.clave_catastral);
        o('h-auxiliar', s.clave_auxiliar);
        o('h-direccion', s.direccion);
        o('h-parroquia', s.parroquia);
        o('h-barrio', s.barrio);
        o('h-propietario', s.propietario_catastro);
        o('h-entrega', s.entrega);
        o('h-ejemplares', s.ejemplares);
        o('h-finalidad', s.finalidad);
        o('h-ofrecida', s.entrega_ofrecida ? fecha(s.entrega_ofrecida + 'T00:00:00') : '');
        o('h-observaciones', s.observaciones);
        $('h-firma-nombre').textContent = s.solicitante || 'Firma del solicitante';
        $('h-firma-doc').textContent = s.documento ? ((DOCTIPO[s.documento_tipo] || '') + ' ' + s.documento) : '';
        $('h-firma-atendio').textContent = s.atendido_por || 'Recibido por';
    }

    // ── Lista ───────────────────────────────────────────────────

    async function cargarSolicitudes() {
        // El formulario se deja listo antes de que haya sesión, así que el
        // nombre de quien atiende no se puede poner entonces: se rellena
        // aquí, la primera vez que se abre la pestaña con sesión abierta.
        if (!solEditando && !$('sol-atendido').value && perfil) {
            $('sol-atendido').value = perfil.nombre || perfil.usuario;
        }

        const parametros = new URLSearchParams();
        const filtro = $('sol-filtro').value;
        const busca = $('sol-buscar').value.trim();
        if (filtro) parametros.set('estado', filtro);
        if (busca) parametros.set('q', busca);
        const cola = parametros.toString();

        const r = await pedir('GET', '/api/admin/solicitudes' + (cola ? '?' + cola : ''));
        if (r.estado !== 200) {
            return avisar('aviso-solicitudes', 'error',
                esc((r.datos && r.datos.error) || 'No se pudieron leer las solicitudes.'));
        }
        avisar('aviso-solicitudes', '', '');
        solicitudes = r.datos.solicitudes || [];
        solSiguiente = r.datos.siguiente_numero || '—';
        if (!solEditando) $('sol-numero').textContent = solSiguiente;

        const resumen = {};
        (r.datos.resumen || []).forEach(f => { resumen[f.estado] = f.n; });
        const total = Object.values(resumen).reduce((a, b) => a + b, 0);
        $('sol-total').textContent = total + (total === 1 ? ' solicitud' : ' solicitudes');
        $('cifras-solicitudes').innerHTML = ['recibida', 'entregada', 'anulada'].map(e =>
            '<div class="cifra"><b>' + (resumen[e] || 0) + '</b><span>'
            + esc(ESTADO_SOL[e][1] + 's') + '</span></div>').join('');

        pintarSolicitudes();
    }

    function pintarSolicitudes() {
        const cuerpo = $('tabla-solicitudes');
        if (!solicitudes.length) {
            cuerpo.innerHTML = '<tr><td colspan="8" class="vacio">'
                + 'No hay solicitudes que coincidan.</td></tr>';
            return;
        }
        cuerpo.innerHTML = solicitudes.map(s => {
            const est = ESTADO_SOL[s.estado] || ESTADO_SOL.recibida;
            return '<tr>'
                + '<td class="mono" style="white-space:nowrap">' + esc(s.numero) + '</td>'
                + '<td style="white-space:nowrap">' + fecha(s.recibida_en) + '</td>'
                + '<td><div class="nombre">' + esc(s.solicitante) + '</div>'
                +     '<div class="tenue">' + esc(DOCTIPO[s.documento_tipo] || '') + ' ' + esc(s.documento)
                +     ' · ' + esc(s.telefono) + '</div>'
                +     '<div class="tenue">' + esc(s.direccion) + '</div></td>'
                + '<td class="mono">' + esc(claveLegible(s.clave_catastral) || s.clave_catastral) + '</td>'
                + '<td>' + esc(s.entrega) + (Number(s.ejemplares) > 1 ? ' <span class="tenue">×' + esc(s.ejemplares) + '</span>' : '') + '</td>'
                + '<td>' + esc(s.atendido_por) + '</td>'
                + '<td>' + insignia(est[0], est[1]) + '</td>'
                + '<td><div class="acciones">'
                +     '<button class="btn btn-linea chico" data-sol="abrir"    data-id="' + esc(s.id) + '" title="Abrir para corregir o reimprimir"><i class="fas fa-pen-to-square"></i></button>'
                +     '<button class="btn btn-linea chico" data-sol="visor"    data-id="' + esc(s.id) + '" title="Ver el predio en el GeoVisor"><i class="fas fa-map-location-dot"></i></button>'
                +     '<button class="btn btn-linea chico" data-sol="imprimir" data-id="' + esc(s.id) + '" title="Reimprimir la constancia"><i class="fas fa-print"></i></button>'
                +     '<button class="btn btn-linea chico" data-sol="estado"   data-id="' + esc(s.id) + '" title="Marcar como entregada o recibida"><i class="fas fa-circle-check"></i></button>'
                +     '<button class="btn btn-linea chico" data-sol="borrar"   data-id="' + esc(s.id) + '" title="Borrar (derecho de eliminación)"><i class="fas fa-trash"></i></button>'
                + '</div></td></tr>';
        }).join('');
    }

    /**
     * CSV con BOM y punto y coma: es lo que abre Excel en español sin pedir
     * nada. Con coma, un Excel con la configuración regional del país mete
     * la fila entera en la primera columna. El apóstrofo delante de las
     * claves evita que las convierta en notación científica.
     */
    function exportarSolicitudesCSV() {
        if (!solicitudes.length) {
            return avisar('aviso-solicitudes', 'info', 'No hay nada que exportar con este filtro.');
        }
        const cols = [
            ['numero', 'N. de solicitud'], ['recibida_en', 'Recibida'],
            ['solicitante', 'Solicitante'], ['documento_tipo', 'Tipo de documento'],
            ['documento', 'Documento'], ['telefono', 'Telefono'], ['correo', 'Correo'],
            ['registro_profesional', 'Registro CAE'], ['calidad', 'Calidad'],
            ['clave_catastral', 'Clave catastral'], ['clave_auxiliar', 'Clave auxiliar'],
            ['direccion', 'Direccion'], ['parroquia', 'Parroquia'], ['barrio', 'Barrio'],
            ['propietario_catastro', 'Propietario segun catastro'], ['entrega', 'Forma de entrega'],
            ['ejemplares', 'Ejemplares'], ['finalidad', 'Finalidad'],
            ['entrega_ofrecida', 'Fecha ofrecida'], ['observaciones', 'Observaciones'],
            ['atendido_por', 'Atendio'], ['estado', 'Estado'], ['entregada_en', 'Entregada']
        ];
        const campo = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        const filas = [cols.map(c => campo(c[1])).join(';')];
        solicitudes.forEach(s => {
            filas.push(cols.map(c => {
                let v = s[c[0]];
                if (c[0] === 'recibida_en' || c[0] === 'entregada_en') v = v ? fecha(v, true) : '';
                if (c[0] === 'clave_catastral' || c[0] === 'clave_auxiliar' || c[0] === 'documento') v = "'" + (v || '');
                return campo(v);
            }).join(';'));
        });

        const blob = new Blob(['﻿' + filas.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'solicitudes-dicat-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    function abrirVisorPredio(clave) {
        if (!/^\d{10,30}$/.test(clave || '')) {
            return avisar('aviso-solicitud', 'info', 'Escriba primero la clave catastral del predio.');
        }
        window.open('geovisor.html?clave=' + encodeURIComponent(clave), '_blank', 'noopener');
    }

    function engancharSolicitudes() {
        pintarOpciones('sol-calidad', 'sol-calidad', CALIDADES);
        pintarOpciones('sol-entrega', 'sol-entrega', ENTREGAS);

        $('sol-clave').addEventListener('input', revisarClave);
        $('sol-auxiliar').addEventListener('input', function () {
            // Sin largo fijo a proposito: ver el comentario de revisar() en
            // api/src/solicitudes.js. Solo se avisa del tope.
            const v = digitos(this.value);
            pista('sol-auxiliar', v.length > 27 ? 'No puede pasar de 27 dígitos.' : '', v.length > 27 ? 'mal' : '');
        });
        $('sol-documento').addEventListener('blur', revisarDocumento);
        $('sol-doctipo').addEventListener('change', revisarDocumento);
        engancharBusquedaPropietario();

        $('btn-sol-visor').addEventListener('click', () => abrirVisorPredio(digitos($('sol-clave').value)));
        $('btn-sol-guardar').addEventListener('click', () => guardarSolicitud());
        $('btn-sol-imprimir').addEventListener('click', async () => {
            const s = await guardarSolicitud();
            if (!s) return;
            llenarHoja(s);
            setTimeout(() => window.print(), 80);
        });
        $('btn-sol-nueva').addEventListener('click', () => {
            if (solEditando && !confirm('¿Empezar una solicitud nueva? Lo que no se haya guardado se pierde.')) return;
            limpiarSolicitud();
        });

        let temporizador;
        $('sol-buscar').addEventListener('input', () => {
            clearTimeout(temporizador);
            temporizador = setTimeout(cargarSolicitudes, 300);
        });
        $('sol-filtro').addEventListener('change', cargarSolicitudes);
        $('btn-sol-csv').addEventListener('click', exportarSolicitudesCSV);

        $('tabla-solicitudes').addEventListener('click', async e => {
            const b = e.target.closest('button[data-sol]');
            if (!b) return;
            const s = solicitudes.find(x => x.id === b.dataset.id);
            if (!s) return;

            if (b.dataset.sol === 'abrir') return volcarSolicitud(s);
            if (b.dataset.sol === 'visor') return abrirVisorPredio(s.clave_catastral);
            if (b.dataset.sol === 'imprimir') { llenarHoja(s); return setTimeout(() => window.print(), 80); }

            if (b.dataset.sol === 'estado') {
                const nuevo = s.estado === 'entregada' ? 'recibida' : 'entregada';
                const r = await pedir('PATCH', '/api/admin/solicitudes/' + encodeURIComponent(s.id), { estado: nuevo });
                if (r.estado !== 200) {
                    return avisar('aviso-solicitudes', 'error', esc((r.datos && r.datos.error) || 'No se pudo cambiar el estado.'));
                }
                if (solEditando === s.id) $('sol-estado').value = nuevo;
                return cargarSolicitudes();
            }

            if (b.dataset.sol === 'borrar') {
                if (!confirm('¿Borrar ' + s.numero + ' (' + s.solicitante + ')?\n\n'
                    + 'La fila se elimina de verdad de la base, con sus datos personales. '
                    + 'En la bitácora queda solo el número. No se puede deshacer.')) return;
                const r = await pedir('DELETE', '/api/admin/solicitudes/' + encodeURIComponent(s.id));
                if (r.estado !== 200) {
                    return avisar('aviso-solicitudes', 'error', esc((r.datos && r.datos.error) || 'No se pudo borrar.'));
                }
                if (solEditando === s.id) limpiarSolicitud();
                avisar('aviso-solicitudes', 'exito', 'Solicitud <b>' + esc(s.numero) + '</b> borrada.');
                return cargarSolicitudes();
            }
        });

        // Ctrl+P imprime lo que haya en pantalla, guardado o no: se rellena
        // la hoja con el estado actual para que nunca salga en blanco.
        window.addEventListener('beforeprint', () => {
            const s = recogerSolicitud();
            s.numero = $('sol-numero').textContent;
            s.recibida_en = new Date().toISOString();
            llenarHoja(s);
        });
    }

    // ── Cambio de contraseña propia ─────────────────────────────

    $('btn-clave').addEventListener('click', async () => {
        const actual = $('clave-actual').value;
        const nueva = $('clave-nueva').value;
        const repetir = $('clave-repetir').value;

        if (!actual || !nueva) return avisar('aviso-clave', 'error', 'Escriba su contraseña actual y la nueva.');
        if (nueva !== repetir) return avisar('aviso-clave', 'error', 'Las dos contraseñas nuevas no coinciden.');

        const boton = $('btn-clave');
        boton.disabled = true;
        const r = await pedir('POST', '/api/sesion/clave', { clave_actual: actual, clave_nueva: nueva });
        boton.disabled = false;

        if (r.estado !== 200) {
            return avisar('aviso-clave', 'error', esc((r.datos && r.datos.error) || 'No se pudo cambiar la contraseña.'));
        }
        avisar('aviso-clave', 'exito', 'Contraseña actualizada.');
        ['clave-actual', 'clave-nueva', 'clave-repetir'].forEach(id => { $(id).value = ''; });
        // Cambiar la clave temporal desbloquea los permisos, así que el
        // veredicto que acompaña a la respuesta ya no es el de antes.
        perfil = r.datos.afiliado;
        misPermisos = r.datos.permisos || misPermisos;
        pintar();
    });

    // ── Arranque ────────────────────────────────────────────────

    $('btn-ingresar').addEventListener('click', () => acceso.abrirIngreso(cargarSesion));

    // Las fichas de opciones se dibujan una sola vez, antes de que haya
    // sesión: limpiarSolicitud() cuenta con que ya existen.
    engancharSolicitudes();
    limpiarSolicitud();

    cargarSesion();
})();
