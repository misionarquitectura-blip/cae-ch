/* ════════════════════════════════════════════════════════════════════
   CAE-CH · Aviso de privacidad y almacenamiento en el navegador
   --------------------------------------------------------------------
   Reemplaza a analytics.js. El sitio ya NO carga Google Analytics ni
   ninguna otra herramienta de seguimiento, de modo que no hay cookies
   que pedir permiso para instalar: lo que queda en el navegador es
   estrictamente necesario (la sesion de quien ingresa con su cuenta) o
   no sale nunca del equipo (el contador local del visor).

   Por eso esto es un AVISO y no un gestor de consentimiento: informa,
   enlaza el detalle (legal.html#cookies) y recuerda que ya se leyo. Si
   algun dia se vuelve a medir con un tercero, hay que convertirlo en un
   consentimiento previo -opt-in, sin casillas marcadas y con "Rechazar"
   tan visible como "Aceptar"- y bloquear ese script hasta la aceptacion.

   Al cambiar la politica, subir VERSION: el aviso vuelve a mostrarse
   una vez a todos. Debe coincidir con la vigencia de legal.html.

   window.caechPrivacidad.mostrar() lo reabre (enlace del pie).
   ════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var VERSION = '2026-10-02';
    var LLAVE = 'caech_aviso_privacidad';

    // legal.html vive en la raiz; este archivo tambien. Resolverlo contra
    // la URL del propio script sirve igual desde RESEARCH/ que desde la raiz.
    var base = (document.currentScript && document.currentScript.src) || location.href;
    var LEGAL = new URL('legal.html', base).href;

    function leido() {
        try { return localStorage.getItem(LLAVE) === VERSION; } catch (e) { return false; }
    }
    function marcarLeido() {
        try { localStorage.setItem(LLAVE, VERSION); } catch (e) { /* modo privado */ }
    }

    function estilos() {
        if (document.getElementById('caech-priv-estilos')) return;
        var s = document.createElement('style');
        s.id = 'caech-priv-estilos';
        // Los var() llevan reserva: la pagina puede no cargar caech-ui.css.
        // z-index por debajo de los modales de acceso (100000) y por
        // encima del mapa y los paneles del visor (<= 10000).
        s.textContent =
            '.caech-priv{position:fixed;left:16px;bottom:16px;z-index:20000;max-width:460px;' +
            'width:calc(100% - 32px);box-sizing:border-box;background:#fff;color:var(--grafito,#2E3238);' +
            'border:1px solid var(--borde,rgba(46,50,56,.12));border-top:3px solid var(--rojo-caech,#E31E24);' +
            'border-radius:var(--radio,4px);box-shadow:0 6px 18px rgba(46,50,56,.12),0 18px 40px rgba(46,50,56,.12);' +
            'padding:16px 18px;font:13px/1.55 var(--fuente-ui,"Montserrat","Segoe UI",Tahoma,sans-serif)}' +
            '.caech-priv h2{margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}' +
            '.caech-priv p{margin:0 0 12px;color:var(--grafito-med,#565B63)}' +
            '.caech-priv a{color:var(--rojo-hondo,#B2141A);font-weight:600}' +
            '.caech-priv-acciones{display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:flex-end}' +
            '.caech-priv-btn{font:600 12px var(--fuente-ui,"Montserrat",sans-serif);letter-spacing:.04em;' +
            'border:0;border-radius:var(--radio,4px);padding:9px 18px;cursor:pointer;' +
            'background:var(--rojo-caech,#E31E24);color:#fff}' +
            '.caech-priv-btn:hover{background:var(--rojo-hondo,#B2141A)}' +
            '.caech-priv-btn:focus-visible,.caech-priv a:focus-visible{outline:2px solid var(--grafito,#2E3238);outline-offset:2px}' +
            '@media print{.caech-priv{display:none}}';
        document.head.appendChild(s);
    }

    function cerrar(caja) {
        if (caja && caja.parentNode) caja.parentNode.removeChild(caja);
    }

    function mostrar() {
        if (document.getElementById('caech-priv')) return;
        estilos();
        var caja = document.createElement('section');
        caja.id = 'caech-priv';
        caja.className = 'caech-priv';
        caja.setAttribute('role', 'region');
        caja.setAttribute('aria-label', 'Aviso de privacidad');
        caja.innerHTML =
            '<h2>Privacidad y cookies</h2>' +
            '<p>Este sitio <b>no usa cookies</b> ni herramientas de anal&iacute;tica o publicidad. ' +
            'En su navegador s&oacute;lo se guarda lo t&eacute;cnicamente necesario: la sesi&oacute;n, ' +
            'si ingresa con su cuenta, y un contador local del visor que no sale de su equipo. ' +
            'Los datos personales se tratan conforme a la LOPDP.</p>' +
            '<div class="caech-priv-acciones">' +
            '  <a href="' + LEGAL + '#cookies">Ver el detalle</a>' +
            '  <a href="' + LEGAL + '#privacidad">Pol&iacute;tica de privacidad</a>' +
            '  <button type="button" class="caech-priv-btn">Entendido</button>' +
            '</div>';
        caja.querySelector('button').addEventListener('click', function () {
            marcarLeido();
            cerrar(caja);
        });
        document.body.appendChild(caja);
    }

    window.caechPrivacidad = { mostrar: mostrar, version: VERSION };

    function iniciar() { if (!leido()) mostrar(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
    else iniciar();
})();
