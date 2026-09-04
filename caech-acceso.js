/* ════════════════════════════════════════════════════════════════════
   CAE-CH · Control de acceso a los productos del GeoVisor
   Cliente del Worker `caech-afiliados` (api/).

   Reglas:
     · DXF y CSV  — solo afiliados con la afiliacion vigente.
     · PDF        — afiliados, o publico general con un (1) pase de
                    cortesia por correo verificado.

   `activo` es el interruptor general. Si alguna vez hay que apagar el
   control -por una caida del Worker, por ejemplo- basta ponerlo en false
   y el visor vuelve a comportarse como antes, sin candados.
   ══════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    const CONFIG = {
        activo: true,
        api: 'https://api.cae-ch.org',
        // Formatos que exigen afiliacion. El PDF no esta aqui: lo cubre
        // el pase de cortesia.
        soloAfiliados: ['dxf', 'csv']
    };

    // Permite apuntar a otro Worker sin tocar este archivo: basta definir
    // window.CAECH_ACCESO_CONFIG antes de cargarlo. Se usa para probar
    // contra `wrangler dev` en local.
    if (window.CAECH_ACCESO_CONFIG) Object.assign(CONFIG, window.CAECH_ACCESO_CONFIG);

    const LLAVE_TOKEN = 'caech_sesion_token';
    const LLAVE_PASE  = 'caech_pase_freemium';

    let perfil = null;
    let permisos = { pdf: false, dxf: false, csv: false };

    // ── Utilidades ──────────────────────────────────────────────────

    const el = id => document.getElementById(id);

    // localStorage y no sessionStorage: este ultimo es POR PESTANA, de modo
    // que abrir el visor en una pestana nueva dejaba al afiliado sin sesion
    // y sin el boton, sin ninguna explicacion visible. La sesion sigue
    // caducando a las 8 horas en el servidor y "Salir" la revoca, que es
    // donde de verdad se controla su duracion.
    function leer(llave)   { try { return localStorage.getItem(llave); } catch (e) { return null; } }
    function grabar(llave, v) {
        try { v ? localStorage.setItem(llave, v) : localStorage.removeItem(llave); } catch (e) {}
    }

    function token()          { return leer(LLAVE_TOKEN); }
    function guardarToken(t)  { grabar(LLAVE_TOKEN, t); }
    function pase()           { return leer(LLAVE_PASE); }
    function guardarPase(p)   { grabar(LLAVE_PASE, p); }

    async function api(metodo, ruta, cuerpo) {
        const cabeceras = {};
        if (cuerpo) cabeceras['Content-Type'] = 'application/json';
        const t = token();
        if (t) cabeceras['Authorization'] = 'Bearer ' + t;

        let r;
        try {
            r = await fetch(CONFIG.api + ruta, {
                method: metodo,
                headers: cabeceras,
                body: cuerpo ? JSON.stringify(cuerpo) : undefined
            });
        } catch (e) {
            // Sin red o Worker caido. Se falla cerrado y se dice por que.
            return { estado: 0, datos: { ok: false, error: 'No se pudo contactar el servicio de acceso del CAE-CH. Revise su conexion.' } };
        }
        let datos = null;
        try { datos = await r.json(); } catch (e) { datos = {}; }
        if (r.status === 401 && t) { guardarToken(null); perfil = null; pintarBarra(); }
        return { estado: r.status, datos };
    }

    // ── Estilos ─────────────────────────────────────────────────────

    function inyectarEstilos() {
        if (el('caech-acceso-estilos')) return;
        const s = document.createElement('style');
        s.id = 'caech-acceso-estilos';
        s.textContent = `
        .caech-acc-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;
            align-items:center;justify-content:center;z-index:100000;padding:16px}
        .caech-acc-overlay.activo{display:flex}
        .caech-acc-caja{background:#fff;border-radius:10px;max-width:420px;width:100%;
            box-shadow:0 12px 40px rgba(0,0,0,.3);overflow:hidden;font-size:14px}
        .caech-acc-cab{background:var(--rojo-oscuro,#8B0000);color:#fff;padding:14px 18px;
            display:flex;justify-content:space-between;align-items:center}
        .caech-acc-cab h3{margin:0;font-size:16px;font-weight:600}
        .caech-acc-cerrar{background:none;border:0;color:#fff;font-size:22px;line-height:1;
            cursor:pointer;opacity:.85}
        .caech-acc-cerrar:hover{opacity:1}
        .caech-acc-cuerpo{padding:18px}
        .caech-acc-cuerpo p{margin:0 0 14px;line-height:1.55;color:#444}
        .caech-acc-campo{margin-bottom:12px}
        .caech-acc-campo label{display:block;font-size:12px;font-weight:600;color:#555;margin-bottom:4px}
        .caech-acc-campo input{width:100%;padding:9px 10px;border:1px solid #ccc;border-radius:5px;
            font-size:14px;box-sizing:border-box;font-family:inherit}
        .caech-acc-campo input:focus{outline:none;border-color:var(--rojo-medio,#A52A2A)}
        .caech-acc-btn{width:100%;padding:10px;background:var(--rojo-medio,#A52A2A);color:#fff;
            border:0;border-radius:5px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
        .caech-acc-btn:hover{background:var(--rojo-oscuro,#8B0000)}
        .caech-acc-btn:disabled{background:#bbb;cursor:not-allowed}
        .caech-acc-btn-sec{margin-top:8px;background:transparent;color:var(--rojo-medio,#A52A2A);
            border:1px solid var(--rojo-medio,#A52A2A)}
        .caech-acc-btn-sec:hover{background:var(--rojo-medio,#A52A2A);color:#fff}
        .caech-acc-aviso{padding:9px 11px;border-radius:5px;font-size:13px;line-height:1.5;margin-bottom:12px;display:none}
        .caech-acc-aviso.error{display:block;background:#FDECEA;color:#8B0000;border:1px solid #F5C6C0}
        .caech-acc-aviso.exito{display:block;background:#E8F5E9;color:#1B5E20;border:1px solid #C8E6C9}
        .caech-acc-aviso.info{display:block;background:#E3F2FD;color:#0D47A1;border:1px solid #BBDEFB}
        .caech-acc-pie{font-size:12px;color:#777;margin:12px 0 0;line-height:1.5;text-align:center}
        .caech-acc-enlace{background:none;border:0;color:var(--rojo-medio,#A52A2A);
            text-decoration:underline;cursor:pointer;font-size:12px;padding:0;font-family:inherit}
        .caech-acc-sesion{display:flex;align-items:center;gap:8px;color:inherit;
            font-size:13px;min-width:0}
        .caech-acc-sesion .caech-acc-quien{display:inline-flex;align-items:center;gap:6px;
            min-width:0;max-width:150px;overflow:hidden;text-overflow:ellipsis;
            white-space:nowrap;color:var(--gris-oscuro,#2F2F2F)}
        .caech-acc-sesion .caech-acc-quien i{color:var(--rojo-oscuro,#8B0000);flex-shrink:0}
        .caech-acc-sesion b{font-weight:600}
        @media (max-width:1100px){ .caech-acc-sesion .caech-acc-quien{display:none} }
        .caech-acc-clave{font-family:ui-monospace,Consolas,monospace;font-size:16px;
            letter-spacing:1px;background:#F5F5F5;padding:10px;border-radius:5px;
            text-align:center;user-select:all;margin-bottom:12px}
        `;
        document.head.appendChild(s);
    }

    // ── Modal generico ──────────────────────────────────────────────

    function modal(id, titulo, contenidoHTML, alAbrir) {
        let overlay = el(id);
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.id = id;
        overlay.className = 'caech-acc-overlay activo';
        overlay.innerHTML =
            '<div class="caech-acc-caja" role="dialog" aria-modal="true">' +
            '  <div class="caech-acc-cab"><h3>' + titulo + '</h3>' +
            '    <button class="caech-acc-cerrar" data-cerrar aria-label="Cerrar">&times;</button></div>' +
            '  <div class="caech-acc-cuerpo">' + contenidoHTML + '</div>' +
            '</div>';
        document.body.appendChild(overlay);

        const cerrar = () => overlay.remove();
        overlay.querySelector('[data-cerrar]').addEventListener('click', cerrar);
        overlay.addEventListener('click', e => { if (e.target === overlay) cerrar(); });
        document.addEventListener('keydown', function esc(e) {
            if (e.key === 'Escape') { cerrar(); document.removeEventListener('keydown', esc); }
        });

        if (alAbrir) alAbrir(overlay, cerrar);
        return { overlay, cerrar };
    }

    function avisar(overlay, clase, mensaje) {
        const caja = overlay.querySelector('.caech-acc-aviso');
        if (!caja) return;
        caja.className = 'caech-acc-aviso ' + clase;
        caja.textContent = mensaje;
    }

    // ── Ingreso de afiliados ────────────────────────────────────────

    function abrirIngreso(alEntrar) {
        modal('caech-modal-ingreso', 'Ingresar',
            '<div class="caech-acc-aviso"></div>' +
            '<div class="caech-acc-campo"><label for="caech-usuario">Usuario o correo</label>' +
            '  <input id="caech-usuario" type="text" autocomplete="username" autocapitalize="off" spellcheck="false"></div>' +
            '<div class="caech-acc-campo"><label for="caech-clave">Contrase&ntilde;a</label>' +
            '  <input id="caech-clave" type="password" autocomplete="current-password"></div>' +
            '<button class="caech-acc-btn" id="caech-entrar">Ingresar</button>' +
            '<button class="caech-acc-btn caech-acc-btn-sec" id="caech-reenviar" hidden>Reenviarme el enlace de confirmaci&oacute;n</button>' +
            '<p class="caech-acc-pie">&iquest;No tiene cuenta? ' +
            '<button class="caech-acc-enlace" id="caech-ir-registro">Cree una</button><br>' +
            'Los afiliados del CAE-CH reciben sus credenciales en la sede.</p>',
            (overlay, cerrar) => {
                const usuario = el('caech-usuario');
                const clave = el('caech-clave');
                const boton = el('caech-entrar');
                const reenviar = el('caech-reenviar');
                usuario.focus();

                el('caech-ir-registro').addEventListener('click', () => { cerrar(); abrirRegistro(alEntrar); });

                reenviar.addEventListener('click', async () => {
                    reenviar.disabled = true;
                    reenviar.textContent = 'Enviando...';
                    const r = await api('POST', '/api/registro/reenviar', { correo: reenviar.dataset.correo || '' });
                    reenviar.textContent = 'Reenviarme el enlace de confirmación';
                    avisar(overlay, r.estado === 200 ? 'exito' : 'error',
                        (r.datos && (r.datos.mensaje || r.datos.error)) || 'No se pudo reenviar.');
                });

                async function entrar() {
                    if (!usuario.value.trim() || !clave.value) {
                        return avisar(overlay, 'error', 'Escriba su usuario y su contraseña.');
                    }
                    boton.disabled = true;
                    boton.textContent = 'Verificando...';
                    const r = await api('POST', '/api/sesion', { usuario: usuario.value, clave: clave.value });
                    boton.disabled = false;
                    boton.textContent = 'Ingresar';

                    if (r.estado !== 200) {
                        // Cuenta creada pero sin confirmar: se ofrece el reenvio
                        // en el acto, que es lo unico que la desbloquea.
                        if (r.datos && r.datos.correo_sin_verificar) {
                            reenviar.hidden = false;
                            reenviar.dataset.correo = usuario.value.trim();
                        }
                        return avisar(overlay, 'error', r.datos.error || 'No se pudo ingresar.');
                    }

                    guardarToken(r.datos.token);
                    perfil = r.datos.afiliado;
                    permisos = r.datos.permisos;
                    cerrar();
                    pintarBarra();

                    if (perfil.requiere_cambio_clave) {
                        abrirCambioClave(clave.value, alEntrar);
                    } else if (alEntrar) {
                        alEntrar();
                    }
                }

                boton.addEventListener('click', entrar);
                [usuario, clave].forEach(campo => campo.addEventListener('keydown', e => {
                    if (e.key === 'Enter') entrar();
                }));
            });
    }

    // ── Registro publico ────────────────────────────────────────────

    /**
     * Alta de cuenta para el publico general. Nace con rol 'usuario': abre
     * el GeoVisor y tiene un DICAT de cortesia; DXF y CSV siguen siendo de
     * los afiliados. No se pide nombre de usuario: el servidor lo deriva
     * del correo, y el correo tambien sirve para ingresar.
     */
    function abrirRegistro(alTerminar) {
        modal('caech-modal-registro', 'Crear una cuenta',
            '<div class="caech-acc-aviso"></div>' +
            '<p>Con una cuenta puede abrir el GeoVisor y consultar el mapa. ' +
            'Las exportaciones DXF y CSV son exclusivas de los afiliados del CAE-CH.</p>' +
            '<div class="caech-acc-campo"><label for="caech-reg-nombre">Nombre completo</label>' +
            '  <input id="caech-reg-nombre" type="text" autocomplete="name"></div>' +
            '<div class="caech-acc-campo"><label for="caech-reg-correo">Correo electr&oacute;nico</label>' +
            '  <input id="caech-reg-correo" type="email" autocomplete="email" autocapitalize="off" spellcheck="false"></div>' +
            '<div class="caech-acc-campo"><label for="caech-reg-clave">Contrase&ntilde;a</label>' +
            '  <input id="caech-reg-clave" type="password" autocomplete="new-password"></div>' +
            '<div class="caech-acc-campo"><label for="caech-reg-repetir">Rep&iacute;tala</label>' +
            '  <input id="caech-reg-repetir" type="password" autocomplete="new-password"></div>' +
            '<button class="caech-acc-btn" id="caech-reg-crear">Crear mi cuenta</button>' +
            '<p class="caech-acc-pie">M&iacute;nimo 12 caracteres, con may&uacute;sculas, min&uacute;sculas y n&uacute;meros.<br>' +
            '&iquest;Ya tiene cuenta? <button class="caech-acc-enlace" id="caech-ir-ingreso-2">Ingrese</button></p>',
            (overlay, cerrar) => {
                const nombre = el('caech-reg-nombre');
                const correo = el('caech-reg-correo');
                const clave = el('caech-reg-clave');
                const repetir = el('caech-reg-repetir');
                const boton = el('caech-reg-crear');
                nombre.focus();

                el('caech-ir-ingreso-2').addEventListener('click', () => { cerrar(); abrirIngreso(alTerminar); });

                async function crear() {
                    if (!nombre.value.trim() || !correo.value.trim() || !clave.value) {
                        return avisar(overlay, 'error', 'Complete todos los campos.');
                    }
                    if (clave.value !== repetir.value) {
                        return avisar(overlay, 'error', 'Las dos contraseñas no coinciden.');
                    }
                    boton.disabled = true;
                    boton.textContent = 'Creando...';
                    const r = await api('POST', '/api/registro', {
                        nombre: nombre.value, correo: correo.value, clave: clave.value
                    });
                    boton.disabled = false;
                    boton.textContent = 'Crear mi cuenta';

                    if (r.estado !== 201) {
                        return avisar(overlay, 'error', (r.datos && r.datos.error) || 'No se pudo crear la cuenta.');
                    }
                    // La cuenta existe pero no sirve hasta confirmar el correo,
                    // asi que no se inicia sesion: se explica el paso que falta.
                    avisar(overlay, 'exito', r.datos.mensaje);
                    [nombre, correo, clave, repetir].forEach(c => { c.disabled = true; });
                    boton.disabled = true;
                }

                boton.addEventListener('click', crear);
                [nombre, correo, clave, repetir].forEach(campo => campo.addEventListener('keydown', e => {
                    if (e.key === 'Enter') crear();
                }));
            });
    }

    // ── Cambio de clave temporal (obligatorio) ──────────────────────

    function abrirCambioClave(claveActual, alTerminar) {
        modal('caech-modal-clave', 'Cambie su contrase&ntilde;a temporal',
            '<div class="caech-acc-aviso info">Su contrase&ntilde;a fue entregada en la sede. ' +
            'Debe reemplazarla por una propia antes de descargar reportes.</div>' +
            (claveActual ? '' :
                '<div class="caech-acc-campo"><label for="caech-clave-actual">Contrase&ntilde;a actual</label>' +
                '  <input id="caech-clave-actual" type="password" autocomplete="current-password"></div>') +
            '<div class="caech-acc-campo"><label for="caech-clave-nueva">Nueva contrase&ntilde;a</label>' +
            '  <input id="caech-clave-nueva" type="password" autocomplete="new-password"></div>' +
            '<div class="caech-acc-campo"><label for="caech-clave-repetir">Rep&iacute;tala</label>' +
            '  <input id="caech-clave-repetir" type="password" autocomplete="new-password"></div>' +
            '<button class="caech-acc-btn" id="caech-guardar-clave">Guardar contrase&ntilde;a</button>' +
            '<p class="caech-acc-pie">M&iacute;nimo 12 caracteres, con may&uacute;sculas, min&uacute;sculas y n&uacute;meros.</p>',
            (overlay, cerrar) => {
                const nueva = el('caech-clave-nueva');
                const repetir = el('caech-clave-repetir');
                const boton = el('caech-guardar-clave');
                nueva.focus();

                boton.addEventListener('click', async () => {
                    const actual = claveActual || (el('caech-clave-actual') || {}).value || '';
                    if (nueva.value !== repetir.value) {
                        return avisar(overlay, 'error', 'Las dos contraseñas no coinciden.');
                    }
                    boton.disabled = true;
                    boton.textContent = 'Guardando...';
                    const r = await api('POST', '/api/sesion/clave', { clave_actual: actual, clave_nueva: nueva.value });
                    boton.disabled = false;
                    boton.textContent = 'Guardar contraseña';

                    if (r.estado !== 200) return avisar(overlay, 'error', r.datos.error || 'No se pudo cambiar la contraseña.');

                    perfil = r.datos.afiliado;
                    permisos = r.datos.permisos;
                    cerrar();
                    pintarBarra();
                    if (alTerminar) alTerminar();
                });
            });
    }

    // ── Pase de cortesia (publico general) ──────────────────────────

    function abrirFreemium() {
        modal('caech-modal-freemium', 'Reporte DICAT de cortes&iacute;a',
            '<div class="caech-acc-aviso"></div>' +
            '<p>Por lanzamiento, el CAE-CH entrega <b>un (1) reporte DICAT en PDF</b> ' +
            'por cada correo verificado. Escriba el suyo y le enviaremos el enlace de acceso.</p>' +
            '<div class="caech-acc-campo"><label for="caech-correo">Correo electr&oacute;nico</label>' +
            '  <input id="caech-correo" type="email" autocomplete="email" placeholder="nombre@correo.com"></div>' +
            '<button class="caech-acc-btn" id="caech-pedir-pase">Enviarme el enlace</button>' +
            '<p class="caech-acc-pie">&iquest;Es afiliado del CAE-CH? ' +
            '<button class="caech-acc-enlace" id="caech-ir-ingreso">Ingrese con su usuario</button></p>',
            (overlay, cerrar) => {
                const correo = el('caech-correo');
                const boton = el('caech-pedir-pase');
                correo.focus();

                el('caech-ir-ingreso').addEventListener('click', () => { cerrar(); abrirIngreso(); });

                async function pedir() {
                    if (!correo.value.trim()) return avisar(overlay, 'error', 'Escriba su correo electrónico.');
                    boton.disabled = true;
                    boton.textContent = 'Enviando...';
                    const r = await api('POST', '/api/freemium/solicitar', { correo: correo.value });
                    boton.disabled = false;
                    boton.textContent = 'Enviarme el enlace';

                    if (r.estado === 200) {
                        avisar(overlay, 'exito', r.datos.mensaje);
                        correo.disabled = true;
                        boton.disabled = true;
                    } else {
                        avisar(overlay, 'error', r.datos.error || 'No se pudo procesar la solicitud.');
                    }
                }

                boton.addEventListener('click', pedir);
                correo.addEventListener('keydown', e => { if (e.key === 'Enter') pedir(); });
            });
    }

    // ── Barra de sesion en la cabecera ──────────────────────────────

    /**
     * Muestra u oculta lo que depende de la sesion:
     *   [data-caech="modulo"]     todo el bloque de acceso; solo aparece si
     *                             el control esta activo (Worker desplegado)
     *   [data-caech="con-sesion"] visible con la sesion iniciada
     *   [data-caech="sin-sesion"] visible sin sesion
     * En el HTML nacen ocultos, de modo que la pagina se comporta como antes
     * mientras CONFIG.activo sea false.
     */
    function pintarEstadoSesion() {
        const hay = !!perfil;
        document.querySelectorAll('[data-caech="modulo"]').forEach(function (el) { el.hidden = !CONFIG.activo; });
        document.querySelectorAll('[data-caech="con-sesion"]').forEach(function (el) { el.hidden = !(CONFIG.activo && hay); });
        document.querySelectorAll('[data-caech="sin-sesion"]').forEach(function (el) { el.hidden = !(CONFIG.activo && !hay); });
    }

    function pintarBarra() {
        pintarEstadoSesion();

        const contenedor = document.querySelector('.nav-buttons');
        if (!contenedor) return;

        let caja = el('caech-acc-barra');
        if (!caja) {
            caja = document.createElement('div');
            caja.id = 'caech-acc-barra';
            caja.className = 'caech-acc-sesion';
            contenedor.insertBefore(caja, contenedor.firstChild);
        }

        if (perfil) {
            const corto = String(perfil.nombre || perfil.usuario).split(/\s+/).slice(0, 2).join(' ');
            caja.innerHTML = '';
            const etiqueta = document.createElement('span');
            etiqueta.className = 'caech-acc-quien';
            etiqueta.innerHTML = '<i class="fas fa-user-check"></i><b></b>';
            etiqueta.title = perfil.nombre || perfil.usuario;
            etiqueta.querySelector('b').textContent = corto;
            const salir = document.createElement('button');
            salir.className = 'btn btn-outline';
            salir.title = 'Cerrar sesion';
            salir.innerHTML = '<i class="fas fa-sign-out-alt"></i> Salir';
            salir.addEventListener('click', cerrarSesion);
            caja.appendChild(etiqueta);
            caja.appendChild(salir);
        } else {
            caja.innerHTML = '';
            const entrar = document.createElement('button');
            entrar.className = 'btn btn-outline';
            entrar.title = 'Ingresar o crear una cuenta';
            entrar.innerHTML = '<i class="fas fa-user"></i> Ingresar';
            entrar.addEventListener('click', () => abrirIngreso());
            caja.appendChild(entrar);
        }
    }

    async function cerrarSesion() {
        await api('DELETE', '/api/sesion');
        guardarToken(null);
        perfil = null;
        permisos = { pdf: false, dxf: false, csv: false };
        pintarBarra();
    }

    async function recuperarSesion() {
        if (!token()) return;
        const r = await api('GET', '/api/sesion');
        if (r.estado === 200) {
            perfil = r.datos.afiliado;
            permisos = r.datos.permisos;
        }
        pintarBarra();
    }

    // ── Puerta de autorizacion ──────────────────────────────────────

    /**
     * Punto unico por el que pasan DXF, CSV y PDF antes de generarse.
     * @returns {Promise<boolean>} true si se puede continuar.
     */
    async function autorizar(formato, claveCatastral) {
        if (!CONFIG.activo) return true;   // interruptor de despliegue

        // Afiliado con sesion viva: se pide autorizacion y queda auditada.
        if (perfil) {
            const r = await api('POST', '/api/descargas', {
                formato: formato,
                clave_catastral: claveCatastral || null
            });
            if (r.estado === 200) return true;
            if (r.datos && r.datos.requiere_cambio_clave) {
                abrirCambioClave(null, () => reintentar(formato, claveCatastral));
                return false;
            }
            alert(r.datos.error || 'No se pudo autorizar la descarga.');
            return false;
        }

        // Sin sesion: DXF y CSV exigen afiliacion, sin excepcion.
        if (CONFIG.soloAfiliados.indexOf(formato) !== -1) {
            abrirIngreso(() => reintentar(formato, claveCatastral));
            return false;
        }

        // PDF sin sesion: sirve el pase de cortesia si lo hay.
        const p = pase();
        if (p) {
            const r = await api('POST', '/api/freemium/consumir', {
                pase: p, clave_catastral: claveCatastral || null
            });
            guardarPase(null);   // el pase es de un solo uso, valga o no
            if (r.estado === 200) return true;
            alert(r.datos.error || 'El pase de cortesia ya no es valido.');
            abrirFreemium();
            return false;
        }

        abrirFreemium();
        return false;
    }

    // Tras ingresar o cambiar la clave, se retoma la accion pendiente.
    const acciones = {};
    function reintentar(formato) {
        const fn = acciones[formato];
        if (typeof fn === 'function') setTimeout(fn, 60);
    }

    // ── Retorno desde el enlace del correo ──────────────────────────

    const MOTIVOS = {
        token_ausente:   'El enlace de verificacion esta incompleto.',
        enlace_invalido: 'El enlace de verificacion no es valido.',
        enlace_caducado: 'El enlace de verificacion caduco. Solicite uno nuevo.',
        ya_utilizado:    'Ese correo ya uso su reporte de cortesia.'
    };

    const CUENTA = {
        verificada:      ['exito', 'Correo confirmado. Ya puede ingresar con su cuenta.'],
        ya_verificada:   ['info',  'Esta cuenta ya estaba confirmada. Ingrese con su correo y contraseña.'],
        enlace_caducado: ['error', 'El enlace de confirmación caducó. Ingrese y pida que se lo reenviemos.'],
        enlace_invalido: ['error', 'El enlace de confirmación no es válido.']
    };

    /** Vuelta desde el enlace de confirmacion del registro. */
    function procesarRetornoCuenta() {
        const params = new URLSearchParams(location.search);
        const clave = params.get('cuenta');
        if (!clave) return;

        params.delete('cuenta');
        history.replaceState(null, '',
            location.pathname + (params.toString() ? '?' + params : '') + location.hash);

        const aviso = CUENTA[clave] || ['error', 'No se pudo confirmar la cuenta.'];
        setTimeout(function () {
            alert(aviso[1]);
            if (clave === 'verificada' || clave === 'ya_verificada') abrirIngreso();
        }, 400);
    }

    function procesarRetorno() {
        const params = new URLSearchParams(location.search);
        const p = params.get('pase');
        const err = params.get('pase_error');
        if (!p && !err) return;

        // Se limpia la URL: el pase no debe quedar en el historial ni
        // filtrarse por Referer a los servidores de teselas.
        params.delete('pase');
        params.delete('pase_error');
        const limpia = location.pathname + (params.toString() ? '?' + params : '') + location.hash;
        history.replaceState(null, '', limpia);

        if (p) {
            guardarPase(p);
            setTimeout(() => alert(
                'Correo verificado. Ya puede generar su reporte DICAT de cortesia: '
                + 'seleccione un predio en el mapa y pulse "Generar DICAT".'
            ), 400);
        } else {
            setTimeout(() => alert(MOTIVOS[err] || 'No se pudo verificar el enlace.'), 400);
        }
    }

    // ── Arranque ────────────────────────────────────────────────────

    function arrancar() {
        inyectarEstilos();
        if (!CONFIG.activo) return;
        pintarBarra();
        procesarRetornoCuenta();
        procesarRetorno();
        recuperarSesion();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', arrancar);
    } else {
        arrancar();
    }

    // API que consume geovisor.html
    window.caechAcceso = {
        config: CONFIG,
        autorizar: autorizar,
        abrirIngreso: abrirIngreso,
        abrirRegistro: abrirRegistro,
        abrirFreemium: abrirFreemium,
        cerrarSesion: cerrarSesion,
        perfil: () => perfil,
        refrescar: pintarBarra,
        permisos: () => permisos,
        /** Registra la accion a retomar si hay que ingresar primero. */
        registrarAccion: (formato, fn) => { acciones[formato] = fn; }
    };
})();
