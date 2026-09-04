// ════════════════════════════════════════════════════════════════════
//  Envio de correo. Cloudflare Email Routing solo RECIBE, no envia, asi
//  que el emisor es un proveedor externo. Se elige con MAIL_PROVEEDOR:
//
//    resend   produccion (requiere dominio verificado + RESEND_API_KEY)
//    consola  desarrollo: no envia, escribe el enlace en los logs del
//             Worker (`npx wrangler tail`). Es el modo util mientras
//             cae-ch.org.ec todavia no resuelve.
// ════════════════════════════════════════════════════════════════════

const SALTO = String.fromCharCode(10);

function escapar(s) {
    return String(s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/**
 * @returns {Promise<{enviado: boolean, proveedor: string, detalle?: string}>}
 * Nunca lanza: un fallo del proveedor no debe tumbar la peticion, solo
 * quedar registrado para que el admin lo vea en la bitacora.
 */
export async function enviarCorreo(env, { para, asunto, html, textoPlano }) {
    const proveedor = String(env.MAIL_PROVEEDOR || 'consola').toLowerCase();

    if (proveedor === 'consola') {
        console.log('[correo:consola]', JSON.stringify({ para, asunto, textoPlano }));
        return { enviado: true, proveedor: 'consola' };
    }

    if (proveedor === 'resend') {
        if (!env.RESEND_API_KEY) {
            return { enviado: false, proveedor, detalle: 'falta RESEND_API_KEY' };
        }
        try {
            const r = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    from: env.MAIL_REMITENTE || 'CAE-CH <no-responder@cae-ch.org.ec>',
                    to: [para],
                    subject: asunto,
                    html,
                    text: textoPlano
                })
            });
            if (!r.ok) {
                return { enviado: false, proveedor, detalle: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` };
            }
            return { enviado: true, proveedor };
        } catch (e) {
            return { enviado: false, proveedor, detalle: String(e).slice(0, 200) };
        }
    }

    return { enviado: false, proveedor, detalle: 'proveedor no reconocido' };
}

// ── Plantillas ──────────────────────────────────────────────────────

const PIE = `
  <p style="margin:24px 0 0;font-size:12px;color:#777;line-height:1.6">
    Colegio de Arquitectos del Ecuador &mdash; N&uacute;cleo Chimborazo<br>
    Este es un correo autom&aacute;tico; no responda a esta direcci&oacute;n.
  </p>`;

export function plantillaVerificacionRegistro(enlace, nombre) {
    const url = escapar(enlace);
    const saludo = nombre ? escapar(String(nombre).split(/\s+/)[0]) : '';
    return {
        asunto: 'Confirme su correo para activar su cuenta del CAE-CH',
        html: `
  <div style="font-family:Montserrat,system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#2E3238">
    <h2 style="color:#E31E24;margin:0 0 16px;font-size:20px;font-weight:700">Confirme su correo</h2>
    <p style="line-height:1.65;margin:0 0 20px">
      ${saludo ? 'Hola ' + saludo + ': su' : 'Su'} cuenta del CAE-CH ya est&aacute; creada.
      Solo falta confirmar esta direcci&oacute;n para poder ingresar y abrir el GeoVisor.
    </p>
    <p style="margin:0 0 20px">
      <a href="${url}" style="display:inline-block;background:#E31E24;color:#fff;text-decoration:none;padding:13px 24px;border-radius:4px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:13px">
        Confirmar mi correo
      </a>
    </p>
    <p style="font-size:13px;color:#565B63;line-height:1.6;margin:0">
      El enlace dura 24 horas. Si usted no creo esta cuenta, ignore este mensaje:
      sin confirmar, la cuenta no puede usarse.
    </p>
    ${PIE}
  </div>`,
        textoPlano:
            'Confirme su correo para activar su cuenta del CAE-CH y abrir el GeoVisor.' + SALTO + SALTO
            + enlace + SALTO + SALTO
            + 'El enlace dura 24 horas. Si usted no creo esta cuenta, ignore este mensaje.'
    };
}

export function plantillaPaseFreemium(enlace, minutos) {
    const url = escapar(enlace);
    return {
        asunto: 'Verifique su correo para descargar su reporte DICAT',
        html: `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#222">
    <h2 style="color:#B71C1C;margin:0 0 16px;font-size:20px">Su reporte DICAT est&aacute; a un clic</h2>
    <p style="line-height:1.6;margin:0 0 20px">
      Confirme que esta direcci&oacute;n es suya para habilitar la descarga de
      <strong>un (1) reporte DICAT en PDF</strong> desde el GeoVisor del CAE-CH.
    </p>
    <p style="margin:0 0 20px">
      <a href="${url}" style="display:inline-block;background:#B71C1C;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600">
        Verificar mi correo
      </a>
    </p>
    <p style="font-size:13px;color:#666;line-height:1.6;margin:0">
      El enlace caduca en ${minutos} minutos y sirve una sola vez.
      Si usted no solicit&oacute; este reporte, ignore este mensaje.
    </p>
    ${PIE}
  </div>`,
        textoPlano:
            'Verifique su correo para habilitar un (1) reporte DICAT en PDF del GeoVisor CAE-CH.\n\n'
            + enlace + '\n\n'
            + `El enlace caduca en ${minutos} minutos y sirve una sola vez.`
    };
}
