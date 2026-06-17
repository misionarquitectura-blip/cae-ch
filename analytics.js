/* ════════════════════════════════════════════════════════════════════
   Analítica CAE-CH — Google Analytics 4
   --------------------------------------------------------------------
   PASO ÚNICO DE CONFIGURACIÓN:
   1. Entra a https://analytics.google.com  → Administrar → Crear propiedad.
   2. Crea un flujo de datos "Web" con la URL del sitio
      (https://misionarquitectura-blip.github.io/cae-ch/).
   3. Copia el "ID de medición" (formato G-XXXXXXXXXX).
   4. Pégalo abajo en GA_ID, reemplazando el valor de ejemplo.

   Mientras GA_ID contenga "XXXX", la analítica queda desactivada (no
   carga nada ni rompe el sitio). Al poner el ID real, empieza a medir.

   Qué se mide:
   - Visitas, usuarios únicos, ubicación y dispositivo  → automático (GA4).
   - Descarga de DICAT      → evento "descargar_dicat".
   - Predio consultado      → evento "consultar_predio".
   Verás todo en el panel de Google Analytics (Informes → Tiempo real /
   Interacción → Eventos).
   ════════════════════════════════════════════════════════════════════ */
(function () {
    var GA_ID = 'G-XXXXXXXXXX'; // ← REEMPLAZAR con tu ID de medición real

    // No activar hasta que se configure un ID válido
    if (!GA_ID || GA_ID.indexOf('XXXX') !== -1) {
        window.caechTrack = function () {}; // no-op para no romper llamadas
        console.info('[CAE-CH] Analítica desactivada: configura GA_ID en analytics.js');
        return;
    }

    // Snippet estándar de Google Analytics 4 (gtag.js)
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);

    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_ID);

    // Helper para registrar eventos personalizados desde cualquier página
    window.caechTrack = function (evento, params) {
        try { window.gtag('event', evento, params || {}); } catch (e) {}
    };
})();
