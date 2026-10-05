/* ════════════════════════════════════════════════════════════════════
   CAE-CH · Control de acceso a los productos del GeoVisor
   Cliente del Worker `caech-afiliados` (api/).

   Reglas (desde el 2026-10-02, convenio CAE-CH):
     · El GeoVisor  — abierto. El mapa entero se consulta sin cuenta.
     · Cuentas      — cualquiera puede crearla; el numero de registro del
                      CAE es opcional y, cotejado, da el cupo de colegiado.
     · PDF, CSV, DXF — se habilitan POR PREDIO: libre para el admin, con
                      cupo mensual para el colegiado y con pago para el
                      resto. Un predio habilitado abre los tres formatos.
                      Si el Worker responde 402, aqui se ofrece el pago
                      (pago.html, Cajita de PayPhone).
     · Planimetria  — gratis para toda cuenta, previa declaracion del
                      equipo de alta precision.

   `activo` es el interruptor general. Si alguna vez hay que apagar el
   control -por una caida del Worker, por ejemplo- basta ponerlo en false
   y el visor vuelve a comportarse como antes, sin candados.
   ══════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    const CONFIG = {
        activo: true,
        api: 'https://api.cae-ch.org',
        // Formatos que exigen cuenta. Estan los tres: el mapa es libre,
        // los productos no.
        conCuenta: ['pdf', 'dxf', 'csv']
    };

    // Permite apuntar a otro Worker sin tocar este archivo: basta definir
    // window.CAECH_ACCESO_CONFIG antes de cargarlo. Se usa para probar
    // contra `wrangler dev` en local.
    if (window.CAECH_ACCESO_CONFIG) Object.assign(CONFIG, window.CAECH_ACCESO_CONFIG);

    const LLAVE_TOKEN = 'caech_sesion_token';

    // legal.html vive junto a este archivo: se resuelve contra la URL del
    // propio script para que el enlace sirva desde cualquier carpeta.
    const BASE_SCRIPT = (document.currentScript && document.currentScript.src) || location.href;
    const LEGAL = new URL('legal.html', BASE_SCRIPT).href;
    // La pagina de pago tambien vive junto a este archivo.
    const PAGO = new URL('pago.html', BASE_SCRIPT).href;

    const SIN_PERMISOS = { pdf: false, dxf: false, csv: false, planimetria: false, cobro: null };
    let perfil = null;
    let permisos = Object.assign({}, SIN_PERMISOS);

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
        /* Identidad CAE-Ch 2025-2027. Los valores de reserva de var()
           llevan el hex correcto porque este archivo se inyecta tambien
           en paginas que quiza no carguen caech-ui.css. */
        .caech-acc-overlay{position:fixed;inset:0;background:rgba(46,50,56,.62);display:none;
            align-items:flex-start;justify-content:center;z-index:100000;padding:16px;overflow-y:auto;
            font-family:'Montserrat','Segoe UI',Tahoma,sans-serif}
        .caech-acc-overlay.activo{display:flex}
        .caech-acc-caja{margin:auto;background:#fff;border-radius:var(--radio,4px);max-width:430px;width:100%;
            box-shadow:0 18px 50px rgba(46,50,56,.32);overflow:hidden;font-size:14px}
        .caech-acc-cab{background:var(--grafito,#2E3238);color:#fff;padding:15px 20px;
            display:flex;justify-content:space-between;align-items:center;gap:12px;
            border-bottom:3px solid var(--rojo-caech,#E31E24)}
        .caech-acc-cab h3{margin:0;font-size:14px;font-weight:700;letter-spacing:.04em;
            text-transform:uppercase}
        .caech-acc-cerrar{background:none;border:0;color:#fff;font-size:24px;line-height:1;
            cursor:pointer;opacity:.75;padding:0 2px;font-family:inherit}
        .caech-acc-cerrar:hover{opacity:1}
        .caech-acc-cuerpo{padding:20px}
        .caech-acc-cuerpo p{margin:0 0 14px;line-height:1.6;color:var(--grafito-med,#565B63)}
        .caech-acc-campo{margin-bottom:13px}
        .caech-acc-campo label{display:block;font-size:11px;font-weight:600;
            letter-spacing:.08em;text-transform:uppercase;color:var(--grafito-med,#565B63);
            margin-bottom:5px}
        .caech-acc-campo input,.caech-acc-campo select{width:100%;padding:10px 12px;background:#fff;
            border:1px solid var(--borde-marcado,rgba(46,50,56,.24));border-radius:var(--radio,4px);
            font-size:14px;box-sizing:border-box;font-family:inherit;color:var(--grafito,#2E3238)}
        /* Campo de contrasena con el boton del ojo dentro, a la derecha. */
        .caech-acc-clave-caja{position:relative;display:block}
        .caech-acc-clave-caja input{padding-right:44px !important;width:100%;box-sizing:border-box}
        .caech-acc-ojo{position:absolute;top:0;right:0;bottom:0;width:42px;display:flex;
            align-items:center;justify-content:center;background:none;border:0;padding:0;
            cursor:pointer;color:var(--grafito-sua,#8B9098);border-radius:0 var(--radio,4px) var(--radio,4px) 0}
        .caech-acc-ojo:hover,.caech-acc-ojo[aria-pressed="true"]{color:var(--rojo-caech,#E31E24)}
        .caech-acc-ojo:focus-visible{outline:2px solid var(--rojo-caech,#E31E24);outline-offset:-4px}
        .caech-acc-campo small{display:block;font-size:12px;color:var(--grafito-sua,#8B9098);margin-top:4px;line-height:1.5}
        .caech-acc-opciones{display:flex;gap:8px;margin-bottom:13px}
        .caech-acc-opciones label{flex:1;display:flex;gap:8px;align-items:flex-start;padding:10px 12px;
            border:1px solid var(--borde-marcado,rgba(46,50,56,.24));border-radius:var(--radio,4px);
            font-size:13px;line-height:1.4;cursor:pointer;color:var(--grafito,#2E3238)}
        .caech-acc-opciones label:has(input:checked){border-color:var(--rojo-caech,#E31E24);
            box-shadow:0 0 0 1px var(--rojo-caech,#E31E24)}
        .caech-acc-opciones input{accent-color:var(--rojo-caech,#E31E24);margin:2px 0 0}
        .caech-acc-precio{display:flex;justify-content:space-between;align-items:baseline;gap:12px;
            padding:12px 14px;background:var(--hueso,#F7F7F8);border:1px solid var(--borde,rgba(46,50,56,.12));
            border-radius:var(--radio,4px);margin-bottom:13px}
        .caech-acc-precio b{font-size:22px;color:var(--grafito,#2E3238)}
        .caech-acc-precio span{font-size:12px;color:var(--grafito-med,#565B63);text-align:right;line-height:1.5}
        .caech-acc-mono{font-family:var(--fuente-mono,ui-monospace),Consolas,monospace;word-break:break-all}
        .caech-acc-campo input:focus,.caech-acc-campo select:focus{outline:none;border-color:var(--rojo-caech,#E31E24);
            box-shadow:0 0 0 3px rgba(227,30,36,.12)}
        /* La forma del boton la pone caech-ui.css; aqui solo el matiz
           secundario, que no existe en la hoja compartida. */
        .caech-acc-btn:disabled{background:var(--grafito-sua,#8B9098)}
        .caech-acc-btn-sec{margin-top:8px;background:transparent;
            color:var(--rojo-caech,#E31E24);border:1px solid var(--rojo-caech,#E31E24)}
        .caech-acc-btn-sec:hover{background:var(--rojo-caech,#E31E24);color:#fff}
        .caech-acc-aviso{padding:10px 12px;border-radius:var(--radio,4px);font-size:13px;
            line-height:1.55;margin-bottom:13px;display:none;border-left-width:3px}
        .caech-acc-aviso.error{display:block;background:#FDECEA;color:#8E1015;border:1px solid #F5C6C0;border-left:3px solid var(--rojo-caech,#E31E24)}
        .caech-acc-aviso.exito{display:block;background:#E9F5EC;color:#14532D;border:1px solid #C8E6D0;border-left:3px solid #1E8449}
        .caech-acc-aviso.info{display:block;background:#EAF1F8;color:#17375E;border:1px solid #C7DAEC;border-left:3px solid #2563A8}
        .caech-acc-pie{font-size:12px;color:var(--grafito-sua,#8B9098);margin:14px 0 0;
            line-height:1.6;text-align:center}
        .caech-acc-check{display:flex;gap:10px;align-items:flex-start;margin:4px 0 15px;
            font-size:13px;line-height:1.55;color:var(--grafito-med,#565B63);cursor:pointer}
        .caech-acc-check input{flex-shrink:0;width:17px;height:17px;margin:2px 0 0;
            accent-color:var(--rojo-caech,#E31E24);cursor:pointer}
        .caech-acc-check a{color:var(--rojo-hondo,#B2141A);font-weight:600}
        .caech-acc-enlace{background:none;border:0;color:var(--rojo-caech,#E31E24);
            text-decoration:underline;cursor:pointer;font-size:12px;padding:0;font-family:inherit}
        /* Reserva por si caech-ui.css no esta cargada en esta pagina:
           sin ella, el boton del modal se quedaria sin forma. */
        .caech-acc-btn{display:inline-flex;align-items:center;justify-content:center;gap:.55em;
            box-sizing:border-box;width:100%;min-height:42px;padding:.8em 1.4em;background:var(--rojo-caech,#E31E24);
            color:#fff;border:1px solid transparent;border-radius:var(--radio,4px);
            font-family:inherit;font-size:13px;font-weight:600;letter-spacing:.06em;
            line-height:1.15;text-transform:uppercase;cursor:pointer}
        .caech-acc-sesion{display:flex;align-items:center;gap:8px;color:inherit;
            font-size:13px;min-width:0}
        .caech-acc-sesion .caech-acc-quien{display:inline-flex;align-items:center;gap:6px;
            min-width:0;max-width:150px;overflow:hidden;text-overflow:ellipsis;
            white-space:nowrap;color:var(--gris-oscuro,#2F2F2F)}
        .caech-acc-sesion .caech-acc-quien i{color:var(--rojo-caech,#E31E24);flex-shrink:0}
        .caech-acc-sesion b{font-weight:600}
        @media (max-width:1100px){ .caech-acc-sesion .caech-acc-quien{display:none} }
        .caech-acc-clave{font-family:var(--fuente-mono,ui-monospace),Consolas,monospace;
            font-size:16px;letter-spacing:1px;background:var(--hueso,#F7F7F8);
            border:1px solid var(--borde,rgba(46,50,56,.12));padding:12px;
            border-radius:var(--radio,4px);text-align:center;user-select:all;margin-bottom:13px}
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

        mostrarClaves(overlay);
        if (alAbrir) alAbrir(overlay, cerrar);
        return { overlay, cerrar };
    }

    // ── Ver la contrasena ───────────────────────────────────────────

    // SVG en linea y no Font Awesome: la planimetria y el panel no cargan
    // la fuente de iconos.
    const OJO = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z"/>' +
        '<circle cx="12" cy="12" r="3.2"/></svg>';
    const OJO_TACHADO = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M10.6 5.1A10 10 0 0 1 12 4.5c6.5 0 10.5 7.5 10.5 7.5a17 17 0 0 1-3.1 3.9"/>' +
        '<path d="M6.3 6.8C3.3 8.8 1.5 12 1.5 12s4 7.5 10.5 7.5a9.6 9.6 0 0 0 5.2-1.5"/>' +
        '<path d="M9.9 9.9a3.2 3.2 0 0 0 4.2 4.2"/><path d="M2 2l20 20"/></svg>';

    /**
     * Pone junto a cada campo de contrasena un boton para verla y volver a
     * ocultarla. Sirve para los modales de este archivo y para los campos
     * fijos de las paginas (panel.html). No toca un campo dos veces.
     */
    function mostrarClaves(raiz) {
        (raiz || document).querySelectorAll('input[type="password"]').forEach(function (campo) {
            if (campo.dataset.caechOjo) return;
            campo.dataset.caechOjo = '1';

            const envoltura = document.createElement('span');
            envoltura.className = 'caech-acc-clave-caja';
            campo.parentNode.insertBefore(envoltura, campo);
            envoltura.appendChild(campo);

            const boton = document.createElement('button');
            boton.type = 'button';
            boton.className = 'caech-acc-ojo';
            envoltura.appendChild(boton);

            function pintar() {
                const visible = campo.type === 'text';
                boton.innerHTML = visible ? OJO_TACHADO : OJO;
                boton.setAttribute('aria-label', visible ? 'Ocultar la contraseña' : 'Mostrar la contraseña');
                boton.title = boton.getAttribute('aria-label');
                boton.setAttribute('aria-pressed', visible ? 'true' : 'false');
            }
            boton.addEventListener('click', function () {
                const inicio = campo.selectionStart, fin = campo.selectionEnd;
                campo.type = campo.type === 'password' ? 'text' : 'password';
                pintar();
                campo.focus();
                try { campo.setSelectionRange(inicio, fin); } catch (e) {}
            });
            pintar();
        });
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
            '<button class="caech-acc-enlace" id="caech-ir-registro">Cr&eacute;ela aqu&iacute;</button><br>' +
            'El mapa del GeoVisor es libre; la cuenta hace falta para descargar y para la planimetr&iacute;a.</p>',
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

                    const seguir = conTerminos(alEntrar);
                    if (perfil.requiere_cambio_clave) {
                        abrirCambioClave(clave.value, seguir);
                    } else {
                        seguir();
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
     * Alta de cuenta, abierta a cualquiera desde el 2026-10-02. El numero
     * de registro del CAE es opcional: quien lo da entra como colegiado por
     * cotejar (y mientras tanto paga como cualquiera); quien no, como cuenta
     * publica. Una vez cotejado el numero, la cuenta recibe el cupo mensual.
     *
     * No se pide nombre de usuario: el servidor lo deriva del correo, y el
     * correo tambien sirve para ingresar.
     */
    function abrirRegistro(alTerminar) {
        modal('caech-modal-registro', 'Crear una cuenta',
            '<div class="caech-acc-aviso"></div>' +
            '<p>El mapa del GeoVisor se consulta libremente, sin cuenta. La cuenta sirve para ' +
            '<b>usar la planimetr&iacute;a</b> y para <b>descargar el DICAT, el CSV y el DXF</b> ' +
            'de un predio.</p>' +
            '<div class="caech-acc-opciones" role="radiogroup" aria-label="Tipo de cuenta">' +
            '  <label><input type="radio" name="caech-reg-tipo" value="publica" checked>' +
            '    <span><b>No soy colegiado</b><br>Pago cada predio</span></label>' +
            '  <label><input type="radio" name="caech-reg-tipo" value="colegiado">' +
            '    <span><b>Soy colegiado del CAE</b><br>1 predio gratis al mes</span></label>' +
            '</div>' +
            '<div class="caech-acc-campo"><label for="caech-reg-nombre">Nombre completo</label>' +
            '  <input id="caech-reg-nombre" type="text" autocomplete="name"></div>' +
            '<div class="caech-acc-campo" id="caech-reg-registro-caja" hidden>' +
            '  <label for="caech-reg-registro">N&uacute;mero de registro del CAE</label>' +
            '  <input id="caech-reg-registro" type="text" autocapitalize="characters" spellcheck="false" ' +
            '         placeholder="Como consta en su credencial">' +
            '  <small>Lo cotejamos contra el padr&oacute;n del colegio. Mientras tanto la cuenta ' +
            '  funciona como cualquier otra.</small></div>' +
            '<div class="caech-acc-campo"><label for="caech-reg-correo">Correo electr&oacute;nico</label>' +
            '  <input id="caech-reg-correo" type="email" autocomplete="email" autocapitalize="off" spellcheck="false"></div>' +
            '<div class="caech-acc-campo"><label for="caech-reg-clave">Contrase&ntilde;a</label>' +
            '  <input id="caech-reg-clave" type="password" autocomplete="new-password"></div>' +
            '<div class="caech-acc-campo"><label for="caech-reg-repetir">Rep&iacute;tala</label>' +
            '  <input id="caech-reg-repetir" type="password" autocomplete="new-password"></div>' +
            casillaTerminos('caech-reg-acepto') +
            '<button class="caech-acc-btn" id="caech-reg-crear">Crear mi cuenta</button>' +
            '<p class="caech-acc-pie">Contrase&ntilde;a: m&iacute;nimo 12 caracteres, con may&uacute;sculas, min&uacute;sculas y n&uacute;meros.<br>' +
            'Confirmar&aacute; su correo por enlace antes de poder ingresar.<br>' +
            '&iquest;Ya tiene cuenta? <button class="caech-acc-enlace" id="caech-ir-ingreso-2">Ingrese</button></p>',
            (overlay, cerrar) => {
                const nombre = el('caech-reg-nombre');
                const registro = el('caech-reg-registro');
                const correo = el('caech-reg-correo');
                const clave = el('caech-reg-clave');
                const repetir = el('caech-reg-repetir');
                const acepto = el('caech-reg-acepto');
                const boton = el('caech-reg-crear');
                const esColegiado = () => !!overlay.querySelector('input[name="caech-reg-tipo"][value="colegiado"]:checked');
                nombre.focus();

                overlay.querySelectorAll('input[name="caech-reg-tipo"]').forEach(r => r.addEventListener('change', () => {
                    el('caech-reg-registro-caja').hidden = !esColegiado();
                    if (esColegiado()) registro.focus();
                }));

                el('caech-ir-ingreso-2').addEventListener('click', () => { cerrar(); abrirIngreso(alTerminar); });

                async function crear() {
                    if (!nombre.value.trim() || !correo.value.trim() || !clave.value) {
                        return avisar(overlay, 'error', 'Complete todos los campos.');
                    }
                    if (esColegiado() && !registro.value.trim()) {
                        return avisar(overlay, 'error', 'Escriba su número de registro del CAE, o elija «No soy colegiado».');
                    }
                    if (clave.value !== repetir.value) {
                        return avisar(overlay, 'error', 'Las dos contraseñas no coinciden.');
                    }
                    if (!acepto.checked) {
                        return avisar(overlay, 'error', 'Para crear la cuenta debe aceptar los Términos y condiciones y la Política de privacidad.');
                    }
                    boton.disabled = true;
                    boton.textContent = 'Creando...';
                    const r = await api('POST', '/api/registro', {
                        nombre: nombre.value,
                        registro_profesional: esColegiado() ? registro.value : '',
                        correo: correo.value,
                        clave: clave.value,
                        acepta_terminos: true
                    });
                    boton.disabled = false;
                    boton.textContent = 'Crear mi cuenta';

                    if (r.estado !== 201) {
                        return avisar(overlay, 'error', (r.datos && r.datos.error) || 'No se pudo crear la cuenta.');
                    }
                    // La cuenta existe pero no sirve hasta confirmar el correo,
                    // asi que no se inicia sesion: se explica el paso que falta.
                    avisar(overlay, 'exito', r.datos.mensaje);
                    [nombre, registro, correo, clave, repetir, acepto,
                     ...overlay.querySelectorAll('input[name="caech-reg-tipo"]')].forEach(c => { c.disabled = true; });
                    boton.disabled = true;
                }

                boton.addEventListener('click', crear);
                [nombre, registro, correo, clave, repetir].forEach(campo => campo.addEventListener('keydown', e => {
                    if (e.key === 'Enter') crear();
                }));
            });
    }

    // ── Terminos y Politica de Privacidad ───────────────────────────

    /**
     * Casilla de aceptacion. Nace SIN marcar: el consentimiento tiene que
     * ser un acto expreso de quien se registra (LOPDP), no un valor por
     * defecto. Los enlaces abren en otra pestana para no perder el formulario.
     */
    function casillaTerminos(id) {
        return '<label class="caech-acc-check" for="' + id + '">' +
            '<input type="checkbox" id="' + id + '">' +
            '<span>He le&iacute;do y acepto los <a href="' + LEGAL + '#terminos" target="_blank" rel="noopener">' +
            'T&eacute;rminos y condiciones</a> y la <a href="' + LEGAL + '#privacidad" target="_blank" rel="noopener">' +
            'Pol&iacute;tica de privacidad</a>, y consiento el tratamiento de mis datos para los fines ah&iacute; descritos.</span>' +
            '</label>';
    }

    /**
     * Envuelve lo que sigue al ingreso: si la cuenta no acepto la version
     * vigente -cuentas creadas por la administracion, anteriores al
     * 2026-10-01 o tras un cambio de los textos- se le pide antes de
     * seguir. No bloquea: "Ahora no" continua y se volvera a pedir en el
     * proximo ingreso. Las herramientas de la cuenta no cambian.
     */
    function conTerminos(siguiente) {
        const fin = siguiente || function () {};
        return function () {
            if (perfil && perfil.terminos_pendientes) abrirTerminos(fin);
            else fin();
        };
    }

    function abrirTerminos(alTerminar) {
        modal('caech-modal-terminos', 'T&eacute;rminos y privacidad',
            '<div class="caech-acc-aviso"></div>' +
            '<p>Para dejar constancia de su consentimiento, conforme a la Ley Org&aacute;nica de ' +
            'Protecci&oacute;n de Datos Personales, le pedimos aceptar la versi&oacute;n vigente de los ' +
            'T&eacute;rminos y de la Pol&iacute;tica de privacidad de la plataforma.</p>' +
            casillaTerminos('caech-ter-acepto') +
            '<button class="caech-acc-btn" id="caech-ter-aceptar">Aceptar y continuar</button>' +
            '<p class="caech-acc-pie"><button class="caech-acc-enlace" id="caech-ter-luego">' +
            'Ahora no; record&aacute;rmelo en el pr&oacute;ximo ingreso</button></p>',
            (overlay, cerrar) => {
                const acepto = el('caech-ter-acepto');
                const boton = el('caech-ter-aceptar');

                el('caech-ter-luego').addEventListener('click', () => { cerrar(); alTerminar(); });

                boton.addEventListener('click', async () => {
                    if (!acepto.checked) {
                        return avisar(overlay, 'error', 'Marque la casilla para aceptar, o elija «Ahora no».');
                    }
                    boton.disabled = true;
                    boton.textContent = 'Guardando...';
                    const r = await api('POST', '/api/sesion/terminos', { acepta_terminos: true });
                    boton.disabled = false;
                    boton.textContent = 'Aceptar y continuar';
                    if (r.estado !== 200) {
                        return avisar(overlay, 'error', (r.datos && r.datos.error) || 'No se pudo registrar la aceptación.');
                    }
                    perfil = r.datos.afiliado;
                    permisos = r.datos.permisos;
                    cerrar();
                    pintarBarra();
                    alTerminar();
                });
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
            caja.appendChild(etiqueta);

            // El panel solo se anuncia a quien ya tiene sesion: es donde se
            // ve la propia cuenta y, si es administrador, el padron. No se
            // enlaza desde el sitio publico porque sin sesion no muestra nada.
            if (!/panel\.html$/i.test(location.pathname)) {
                const panel = document.createElement('a');
                panel.className = 'btn btn-outline';
                panel.href = 'panel.html';
                panel.title = 'Mi cuenta y administracion';
                panel.innerHTML = '<i class="fas fa-cog"></i> Panel';
                caja.appendChild(panel);
            }

            salir.addEventListener('click', cerrarSesion);
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
        permisos = Object.assign({}, SIN_PERMISOS);
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

    // La sesion guardada se recupera en segundo plano al cargar la pagina.
    // Quien necesite saber si hay sesion -las puertas de abajo- espera a
    // esa misma consulta en vez de mirar `perfil` antes de que llegue: la
    // planimetria pregunta nada mas cargar y, sin esta espera, pedia
    // ingresar de nuevo a quien ya tenia la sesion abierta.
    let recuperando = null;
    function asegurarSesion() {
        if (!recuperando) recuperando = recuperarSesion();
        return recuperando;
    }

    // ── Puerta de autorizacion ──────────────────────────────────────

    /**
     * Punto unico por el que pasan PDF, CSV y DXF antes de generarse. El
     * mapa NO pasa por aqui: se consulta sin cuenta.
     * @returns {Promise<boolean>} true si se puede continuar.
     */
    async function autorizar(formato, claveCatastral) {
        if (!CONFIG.activo) return true;   // interruptor de despliegue

        if (!perfil && token()) await asegurarSesion();

        // Con sesion viva: se pide autorizacion y la descarga queda auditada.
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
            // 402: el predio no esta habilitado y no queda cupo. No es un
            // error, es un paso: se explica el precio y se ofrece pagar.
            if (r.estado === 402 && r.datos && r.datos.requiere_pago) {
                abrirPago(r.datos);
                return false;
            }
            alert(r.datos.error || 'No se pudo autorizar la descarga.');
            return false;
        }

        // Sin sesion: los tres productos exigen cuenta, sin excepcion.
        if (CONFIG.conCuenta.indexOf(formato) !== -1) {
            abrirIngreso(() => reintentar(formato, claveCatastral));
            return false;
        }
        return true;
    }

    /**
     * Puerta de las herramientas que no son descargas -la planimetria, de
     * momento-. La planimetria esta abierta a toda cuenta, pero pide antes
     * la declaracion del equipo: ese es el "no" mas probable, y se resuelve
     * aqui mismo con el formulario. Las herramientas que no sean abiertas
     * las concede la administracion cuenta por cuenta.
     * @returns {Promise<boolean>} true si se puede continuar.
     */
    async function autorizarHerramienta(herramienta, alEntrar) {
        if (!CONFIG.activo) return true;

        if (!perfil && token()) await asegurarSesion();
        if (!perfil) {
            abrirIngreso(alEntrar || function () { location.reload(); });
            return false;
        }

        const r = await api('POST', '/api/herramientas', { herramienta: herramienta });
        if (r.estado === 200) return true;

        if (r.datos && r.datos.requiere_cambio_clave) {
            abrirCambioClave(null, alEntrar || function () { location.reload(); });
            return false;
        }
        if (r.datos && r.datos.requiere_declaracion) {
            abrirDeclaracion(alEntrar || function () { location.reload(); });
            return false;
        }
        modal('caech-modal-herramienta', 'Herramienta no habilitada',
            '<div class="caech-acc-aviso info">' +
            esc((r.datos && r.datos.error) || 'Su cuenta no tiene habilitada esta herramienta.') +
            '</div>' +
            '<p>Si la necesita para su trabajo, escriba a ' +
            '<a href="mailto:caechoficial@gmail.com">caechoficial@gmail.com</a>.</p>');
        return false;
    }

    function esc(v) {
        return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    const usd = centavos => 'USD ' + (centavos / 100).toFixed(2).replace('.', ',');

    // ── Pago de un predio ───────────────────────────────────────────

    /**
     * Lo que se ve cuando el Worker responde 402 a una descarga: el precio,
     * lo que incluye y el boton que lleva a pago.html. El cobro ocurre alla
     * -la Cajita de PayPhone valida el dominio y vuelve a esa pagina-; aqui
     * solo se explica y se envia. Sin credenciales de PayPhone cargadas, el
     * Worker dice `cobro_en_linea: false` y se ofrece el pago en la sede.
     */
    function abrirPago(datos) {
        const t = datos.tarifa || {};
        const cupo = datos.cupo;
        const clave = datos.clave_catastral || '';
        const destino = PAGO + '?clave=' + encodeURIComponent(clave);

        modal('caech-modal-pago', 'Habilitar este predio',
            '<div class="caech-acc-aviso info">' + esc(datos.error || '') + '</div>' +
            '<div class="caech-acc-precio"><b>' + usd(t.precio || 0) + '</b>' +
            '<span>IVA incluido<br>base ' + usd(t.base || 0) + ' + IVA ' + usd(t.iva || 0) +
            (t.descuento_colegiado ? '<br>precio de colegiado: 50 % menos que ' + usd(t.precio_publico || 0) : '') +
            '</span></div>' +
            '<p>Incluye el <b>DICAT en PDF, el CSV y el DXF</b> de este predio, que podr&aacute; volver ' +
            'a descargar durante <b>' + (t.dias_acceso || 30) + ' d&iacute;as</b>.<br>' +
            'Predio: <span class="caech-acc-mono">' + esc(clave) + '</span></p>' +
            (cupo ? '<p class="caech-acc-pie" style="text-align:left;margin-top:0">Predios gratuitos de este mes: ' +
                cupo.usados + ' de ' + cupo.total + ' usados.</p>' : '') +
            (t.cobro_en_linea
                ? '<a class="caech-acc-btn" href="' + esc(destino) + '" style="text-decoration:none">Pagar con tarjeta</a>' +
                  '<p class="caech-acc-pie">El pago lo procesa PayPhone; la plataforma no ve ni guarda los datos ' +
                  'de su tarjeta. Al terminar volver&aacute; al visor con el predio abierto.</p>'
                : '<div class="caech-acc-aviso exito" style="display:block">El pago en l&iacute;nea se habilita en breve. ' +
                  'Mientras tanto puede pagar en la sede del CAE-CH (lunes a viernes, 09:00&ndash;13:00 y ' +
                  '15:00&ndash;18:00) y la administraci&oacute;n habilitar&aacute; el predio en su cuenta.</div>' +
                  '<p class="caech-acc-pie">Escriba a <a href="mailto:caechoficial@gmail.com">caechoficial@gmail.com</a> ' +
                  'indicando la clave del predio.</p>'));
    }

    // ── Declaracion de equipo (planimetria) ─────────────────────────

    const TIPOS_EQUIPO = [
        ['gnss_rtk', 'Receptor GNSS RTK'],
        ['estacion_total', 'Estación total'],
        ['lidar', 'Escáner láser LiDAR 3D'],
        ['ortofoto', 'Ortofoto verificada (4 cm/px o mejor)']
    ];

    /**
     * La planimetria solo trabaja con levantamientos de alta precision. Antes
     * de abrirla, la cuenta declara el equipo -marca, modelo, serie- y asume
     * la responsabilidad por los datos. Queda en el Worker con fecha; se
     * puede volver a declarar si cambia de equipo.
     */
    function abrirDeclaracion(alTerminar) {
        modal('caech-modal-equipo', 'Declaraci&oacute;n de equipo',
            '<div class="caech-acc-aviso"></div>' +
            '<p>La planimetr&iacute;a es gratuita, pero solo admite levantamientos tomados con ' +
            '<b>equipo de alta precisi&oacute;n</b>. Indique el equipo con que trabaja.</p>' +
            '<div class="caech-acc-campo"><label for="caech-eq-tipo">Tipo de equipo</label>' +
            '  <select id="caech-eq-tipo">' + TIPOS_EQUIPO.map(t =>
                '<option value="' + t[0] + '">' + t[1] + '</option>').join('') + '</select></div>' +
            '<div class="caech-acc-campo"><label for="caech-eq-marca">Marca</label>' +
            '  <input id="caech-eq-marca" type="text" autocomplete="off" placeholder="Trimble, Leica, Topcon, DJI…"></div>' +
            '<div class="caech-acc-campo"><label for="caech-eq-modelo">Modelo</label>' +
            '  <input id="caech-eq-modelo" type="text" autocomplete="off"></div>' +
            '<div class="caech-acc-campo"><label for="caech-eq-serie">N&uacute;mero de serie</label>' +
            '  <input id="caech-eq-serie" type="text" autocomplete="off" spellcheck="false"></div>' +
            '<div class="caech-acc-campo" id="caech-eq-gsd-caja" hidden><label for="caech-eq-gsd">Resoluci&oacute;n verificada (cm/px)</label>' +
            '  <input id="caech-eq-gsd" type="text" inputmode="decimal" placeholder="4 o menos">' +
            '  <small>Para la ortofoto, indique la marca, el modelo y la serie del dron o la c&aacute;mara.</small></div>' +
            '<label class="caech-acc-check" for="caech-eq-acepto"><input type="checkbox" id="caech-eq-acepto">' +
            '<span>Declaro bajo mi responsabilidad que los levantamientos que procese en la planimetr&iacute;a ' +
            'fueron tomados con este equipo, en buen estado y calibrado; que <b>no provienen</b> de Google Earth ' +
            'o Google Maps, de GPS recreativos ni de tel&eacute;fonos m&oacute;viles; y que respondo por su ' +
            'exactitud y por el uso de los planos e informes que genere.</span></label>' +
            '<button class="caech-acc-btn" id="caech-eq-guardar">Declarar y continuar</button>',
            (overlay, cerrar) => {
                const tipo = el('caech-eq-tipo');
                const boton = el('caech-eq-guardar');
                tipo.addEventListener('change', () => { el('caech-eq-gsd-caja').hidden = tipo.value !== 'ortofoto'; });
                el('caech-eq-marca').focus();

                boton.addEventListener('click', async () => {
                    if (!el('caech-eq-acepto').checked) {
                        return avisar(overlay, 'error', 'Marque la declaración de responsabilidad para continuar.');
                    }
                    boton.disabled = true;
                    boton.textContent = 'Guardando...';
                    const r = await api('POST', '/api/equipo', {
                        tipo: tipo.value,
                        marca: el('caech-eq-marca').value,
                        modelo: el('caech-eq-modelo').value,
                        serie: el('caech-eq-serie').value,
                        gsd_cm: tipo.value === 'ortofoto' ? el('caech-eq-gsd').value : null,
                        acepta_responsabilidad: true
                    });
                    boton.disabled = false;
                    boton.textContent = 'Declarar y continuar';
                    if (r.estado !== 201) {
                        return avisar(overlay, 'error', (r.datos && r.datos.error) || 'No se pudo guardar la declaración.');
                    }
                    cerrar();
                    if (alTerminar) alTerminar();
                });
            });
    }

    // Tras ingresar o cambiar la clave, se retoma la accion pendiente.
    const acciones = {};
    function reintentar(formato) {
        const fn = acciones[formato];
        if (typeof fn === 'function') setTimeout(fn, 60);
    }

    // ── Retorno desde el enlace del correo ──────────────────────────

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

    // ── Arranque ────────────────────────────────────────────────────

    function arrancar() {
        inyectarEstilos();
        if (!CONFIG.activo) return;
        pintarBarra();
        procesarRetornoCuenta();
        asegurarSesion();
        mostrarClaves(document);
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
        autorizarHerramienta: autorizarHerramienta,
        abrirIngreso: abrirIngreso,
        abrirRegistro: abrirRegistro,
        /** Formulario de declaracion de equipo; tambien lo usa el panel. */
        abrirDeclaracion: abrirDeclaracion,
        cerrarSesion: cerrarSesion,
        perfil: () => perfil,
        refrescar: pintarBarra,
        permisos: () => permisos,
        /** Registra la accion a retomar si hay que ingresar primero. */
        registrarAccion: (formato, fn) => { acciones[formato] = fn; },
        /** Espera a que la sesion guardada se haya recuperado. */
        sesion: asegurarSesion,
        /** Anade el boton de ver la contrasena a los campos de `raiz`. */
        mostrarClaves: mostrarClaves,
        /**
         * Llamada autenticada al API, con el token de la sesion puesto y el
         * 401 ya tratado (cierra la sesion y repinta). La usa panel.html para
         * hablar con /api/admin/* sin duplicar aqui el manejo del token.
         * @returns {Promise<{estado:number, datos:object}>}
         */
        peticion: api
    };
})();
