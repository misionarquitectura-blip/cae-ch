# API de afiliados del CAE-CH

Control de acceso a los productos del GeoVisor, sobre **Cloudflare Workers + D1**.

| Formato | Quién puede | Cómo |
|---|---|---|
| **PDF** (DICAT) | afiliados · público general | afiliados sin límite; el público, **un (1) reporte por correo verificado** |
| **DXF** | solo afiliados | sesión activa y afiliación vigente |
| **CSV** | solo afiliados | sesión activa y afiliación vigente |

Cada descarga queda registrada en la tabla `descargas` con quién, qué formato y qué clave catastral.

---

## Alcance real del control — léalo antes de prometer nada

El visor se sirve estático desde GitHub Pages y `DATA SET/Catastro GADMR.geojson`
es un archivo **público del repositorio**. Este API blinda la *herramienta* de
exportación y deja auditoría de cada descarga; **no vuelve secreta la geometría**,
que además es información municipal pública. Quien sepa manejar QGIS puede
descargar ese GeoJSON y armarse su propio DXF sin pasar por aquí.

Para 10 afiliados institucionales eso es suficiente: el objetivo es ordenar y
registrar el acceso, no impedir la copia. Si algún día hiciera falta control
real sobre el dato, habría que sacar el catastro del repositorio y servirlo
desde R2 detrás de este Worker — lo que dejaría sin mapa al sitio público.

---

## Despliegue paso a paso

### 1. Requisitos

- Cuenta de Cloudflare (el plan gratuito alcanza para empezar, ver punto 6).
- Node.js 18 o superior.

```bash
cd api
npm install
npx wrangler login
```

### 2. Crear la base D1

```bash
npx wrangler d1 create caech-afiliados
```

Copie el `database_id` que imprime y péguelo en `wrangler.toml`, reemplazando
`PENDIENTE-PEGAR-EL-ID-DE-D1`. Luego cree las tablas:

```bash
npx wrangler d1 execute caech-afiliados --remote --file=schema.sql
```

### 3. Cargar el secreto obligatorio

`PIMIENTA` es la sal global con la que se hashean las IP: permite contar y
limitar sin guardar ninguna dirección en claro.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npx wrangler secret put PIMIENTA
```

### 4. Desplegar

```bash
npx wrangler deploy
```

Anote la URL que devuelve (`https://caech-afiliados.SU-CUENTA.workers.dev`) y
péguela en `wrangler.toml` como `API_URL`. Ajuste también `SITIO_URL` a la raíz
pública del visor. Vuelva a desplegar para que los cambios tomen efecto.

### 5. Crear el primer administrador

No existe endpoint de registro: sería justo la puerta que no queremos en un
sistema institucional cerrado. El primer admin nace por SQL directo.

```bash
node scripts/crear-admin.mjs --usuario admin --correo suCorreo@dominio.com \
     --nombre "Nombre Apellido"
```

Imprime la clave temporal y la sentencia `INSERT`. Ejecute la sentencia con
`npx wrangler d1 execute caech-afiliados --remote --command "..."`, entre al
visor con esa clave y cámbiela de inmediato: el sistema lo exige antes de
permitir cualquier descarga.

### 6. Elegir el número de iteraciones (importante para el plan gratuito)

`HASH_ITERACIONES` fija el coste de PBKDF2-SHA256 en cada ingreso. Medido sobre
el mismo motor nativo que usa Workers:

| Iteraciones | CPU por ingreso |
|---|---|
| 50 000 | ~6 ms |
| 100 000 | ~12 ms |
| 210 000 | ~24 ms |
| 600 000 | ~69 ms |

El **plan gratuito de Workers corta en 10 ms de CPU por invocación**, así que:

- **Workers gratuito** → ponga `HASH_ITERACIONES = "50000"`.
- **Workers Paid** (5 USD/mes, 30 s de CPU) → deje `"210000"`, que es el valor
  recomendado. Para 10 afiliados es la opción sensata.

Subir el valor después no invalida las cuentas: cada hash guarda sus propias
iteraciones y se re-hashea solo, en el siguiente ingreso correcto.

### 7. Activar el candado en el visor

Mientras `activo` sea `false` en [`caech-acceso.js`](../caech-acceso.js), el
visor funciona exactamente como antes, sin candados. Recién cuando el Worker
esté desplegado y probado:

```js
const CONFIG = {
    activo: true,                                              // ← aquí
    api: 'https://caech-afiliados.SU-CUENTA.workers.dev',      // ← y aquí
    soloAfiliados: ['dxf', 'csv']
};
```

Confirme que `ORIGENES_PERMITIDOS` en `wrangler.toml` incluye el dominio real
desde el que se sirve el visor. Sin coincidencia el API no emite la cabecera
CORS y el navegador bloquea la llamada: **falla cerrado, no abierto**.

### 8. Correo del pase de cortesía

Cloudflare Email Routing **solo recibe** correo, no envía. El emisor es externo:

- `MAIL_PROVEEDOR = "consola"` — no envía nada; escribe el enlace en los logs
  (`npx wrangler tail`). Útil mientras `cae-ch.org.ec` no resuelva.
- `MAIL_PROVEEDOR = "resend"` — envía de verdad. Requiere el dominio verificado
  en [Resend](https://resend.com) (gratis hasta 3.000 correos/mes) y el secreto
  `RESEND_API_KEY`:

```bash
npx wrangler secret put RESEND_API_KEY
```

Con el freemium en modo `consola` nadie del público recibirá su enlace. Si el
lanzamiento va a ocurrir antes de tener el dominio, apague la promoción con
`FREEMIUM_ACTIVO = "no"` y deje solo el acceso de afiliados.

---

## Gestión diaria

Todo se hace desde `/api/admin/*` con la sesión de un administrador.

| Acción | Petición |
|---|---|
| Listar afiliados | `GET /api/admin/afiliados` |
| Dar de alta | `POST /api/admin/afiliados` `{nombre, usuario, correo, registro_profesional?, vigencia_hasta?}` |
| Suspender / reactivar | `PATCH /api/admin/afiliados/:id` `{estado: "suspendido"\|"activo"}` |
| Renovar afiliación | `PATCH /api/admin/afiliados/:id` `{vigencia_hasta: "2027-12-31"}` |
| Desbloquear tras intentos fallidos | `PATCH /api/admin/afiliados/:id` `{desbloquear: true}` |
| Restablecer contraseña | `POST /api/admin/afiliados/:id/clave` |
| Ver descargas | `GET /api/admin/descargas` |
| Ver bitácora | `GET /api/admin/eventos` |
| Ver pases de cortesía | `GET /api/admin/pases` |

El alta y el restablecimiento devuelven la clave temporal **una sola vez** —
anótela y entréguela en persona. No queda en claro en ninguna parte; si se
pierde, se restablece.

Ejemplo de alta con `curl`:

```bash
curl -X POST https://caech-afiliados.SU-CUENTA.workers.dev/api/admin/afiliados \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Origin: https://www.cae-ch.org.ec" \
  -d '{"nombre":"Arq. Maria Paredes","usuario":"mparedes","correo":"mparedes@ejemplo.com","registro_profesional":"CAE-CH-0421","vigencia_hasta":"2027-12-31"}'
```

---

## Decisiones de seguridad

- **Contraseñas**: PBKDF2-SHA256 con sal por usuario, formato
  `pbkdf2-sha256$iter$salt$hash`. Comparación en tiempo constante.
- **Clave temporal**: 20 caracteres de un alfabeto sin ambigüedades (~103 bits),
  en grupos de 4 para poder dictarla. `requiere_cambio_clave` bloquea toda
  descarga hasta que el afiliado ponga la suya.
- **Sesiones**: token opaco de 32 bytes; en la base se guarda solo su SHA-256.
  Una filtración de la base no entrega sesiones utilizables. Caducan a las 8 h.
- **Token en cabecera, no en cookie**: el visor está en GitHub Pages y el API en
  `workers.dev` — dominios distintos, donde una cookie sería de terceros y
  Safari y Chrome la bloquean. Cuando el API pase a `api.cae-ch.org.ec` conviene
  migrar a cookie `HttpOnly; Secure; SameSite=Lax`, que resiste mejor un XSS.
- **Enumeración de cuentas**: usuario inexistente y clave incorrecta devuelven
  el mismo mensaje y gastan el mismo tiempo de CPU.
- **Fuerza bruta**: 5 intentos fallidos bloquean la cuenta 15 minutos. El bloqueo
  es por cuenta, no global.
- **Cambio de clave**: cierra todas las demás sesiones del afiliado.
- **Suspensión**: borra las sesiones abiertas en el acto.
- **Último administrador**: no se puede suspender ni degradar al único admin
  activo, ni puede uno hacérselo a sí mismo.
- **IP**: nunca se guarda en claro, solo `SHA-256(PIMIENTA + ip)`.
- **Pase de cortesía**: el token del correo se **rota** al verificarse, de modo
  que el enlace que queda en la bandeja deja de servir. El consumo usa
  `WHERE consumido_en IS NULL` para cerrar la carrera de dos pestañas.

---

## Pruebas

`test/api.test.mjs` levanta 69 comprobaciones contra el Worker real corriendo en
local: ingreso, cambio de clave obligatorio, permisos por formato, separación
admin/afiliado, suspensión, vigencia, fuerza bruta, ciclo completo del freemium,
CORS y bitácora.

```bash
cd api
CLAVE=$(bash test/reiniciar.sh)          # base limpia + admin + wrangler dev
node test/api.test.mjs "$CLAVE" /tmp/caech-wrangler.log
```

`test/reiniciar.sh` borra la base local, siembra un administrador y deja
`wrangler dev` escuchando en el 8787; imprime la clave temporal del admin.

Para probar la interfaz, sirva el repositorio y abra el banco de pruebas, que
carga `caech-acceso.js` apuntado al Worker local:

```bash
python -m http.server 8788        # desde la raíz del repositorio
# luego abra http://localhost:8788/api/test/prueba-acceso.html
```
