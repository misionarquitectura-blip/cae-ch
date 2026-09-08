# Línea 3 · Economía y base productiva

Cómo se rehace `RESEARCH/economia.html` desde cero.

**Dos fuentes independientes**, y esa independencia es el argumento de la línea:

| | Quién | Qué mide | Hasta |
|---|---|---|---|
| 1 | Banco Central (Cuentas Regionales) | **valor producido** por habitante | 2024 |
| 2 | INEC (ESED) | **obra autorizada**: permisos de construcción | 2025 |

## 1. Bajar las fuentes

Ninguna está en el repositorio (12 MB en total, y son descargas públicas que no
hay por qué duplicar). Todas van en `fuentes/`:

```bash
mkdir -p fuentes
# Banco Central — VAB per cápita y VAB por sección CIIU
curl -L -o fuentes/vab_percapita_2018_2024.xlsx \
  "https://contenido.bce.fin.ec/documentos/informacioneconomica/cuentasnacionales/regionales/VAB_PerCapita_CNRC_2018_2024p_publicaci%C3%B3n_val.xlsx"
curl -L -o fuentes/vab_cantonal_ciiu_2024.xlsx \
  "https://contenido.bce.fin.ec/documentos/informacioneconomica/cuentasnacionales/regionales/cantonales/corrientes_2024_cant_p.xlsx"
# INEC — microdatos de permisos de construcción y tabulados
curl -L -o fuentes/esed_2025_datos_abiertos.zip \
  "https://www.ecuadorencifras.gob.ec/documentos/web-inec/Estadisticas_Economicas/Encuesta_Edificaciones/2025/anual/datos_abiertos.zip"
curl -L -o fuentes/esed_2025_tabulados.xlsx \
  "https://www.ecuadorencifras.gob.ec/documentos/web-inec/Estadisticas_Economicas/Encuesta_Edificaciones/2025/anual/5.2025_ESED_Tabulados.xlsx"
```

Índices por si cambian las rutas:
<https://contenido.bce.fin.ec/documentos/informacioneconomica/cuentasnacionales/regionales/>
y <https://www.ecuadorencifras.gob.ec/edificaciones/>.

## 2. Regenerar la página

```bash
python extraer_bce.py    # fuentes/*.xlsx -> datos.json
python extraer_esed.py   # fuentes/*.zip  -> datos_esed.json
node build.js            # los dos + plantilla.html -> ../economia.html
```

Los dos extractores abortan solos si la fuente cambia de forma:
`extraer_bce.py` exige leer exactamente 221 cantones, y `extraer_esed.py` exige
encontrar el cantón 0601 en cada año.

## Comprobación que conviene repetir

Los totales calculados desde el microdato del INEC **reproducen exactamente** los
del visualizador ESED público: 25 736 permisos nacionales en 2022, y para
Chimborazo 884 (2022) y 598 permisos / 673 edificaciones / 1 052 viviendas
(2025). Si alguna vez dejan de cuadrar, el filtro o el formato cambiaron.

## Los archivos

| Archivo | Qué hace |
|---|---|
| `xlsxlee.py` | Lector mínimo de xlsx con la stdlib de Python (un xlsx es un ZIP con XML). Evita instalar `openpyxl` o `pandas`. |
| `extraer_esed.py` | Abre el zip anidado del INEC, filtra por código de cantón y escribe `datos_esed.json`. |
| `datos_esed.json` | Salida intermedia, 2 KB. Versionada. |
| `extraer_bce.py` | Lee las dos hojas, deflacta la serie, calcula el promedio nacional ponderado y el ranking de los 221 cantones, y escribe `datos.json`. |
| `plantilla.html` | La página, con `__DATOS__` como marcador. **Sí está versionada**, a diferencia de `equipamiento/plantilla.html`. |
| `build.js` | Cuelga `datos_esed.json` de `datos.json` y los incrusta en la plantilla. |
| `datos.json` | Salida intermedia, 32 KB. Versionada, para poder regenerar la página sin volver a bajar los xlsx. |

## Decisiones que conviene no deshacer sin pensarlo

- **Solo el año base 2018 (2018-2024).** La serie anterior del BCE
  (`Can2007.xlsx` … `Can2020.xlsx`, otro año base) existe y llega hasta 2007,
  pero empalmarlas compara niveles que no son comparables. Si algún día se
  quiere la serie larga, hay que marcar el quiebre en el gráfico.
- **La serie se deflacta.** El BCE publica el VAB cantonal solo a precios
  corrientes. Sin deflactar no se puede decir si el cantón crece.
- **Es VAB, no PIB.** El Ecuador no publica PIB cantonal. Toda la página lo
  dice con ese nombre y conviene que siga siendo así.
- **Las cifras del texto se calculan en el navegador**, no están escritas a
  mano: si el BCE revisa la serie, las frases se recolocan solas al
  reconstruir. No sustituir por números literales.
- **El morado `--linea-3` está validado** contra daltonismo junto al azul de
  la línea 1, el verde de la línea 2 y el rojo de la identidad. Si se cambia,
  hay que volver a comprobarlo, no elegirlo a ojo.
- **El microdato del INEC se filtra por CANTÓN, no por provincia.** Riobamba pasó
  de ser el 59,0 % de los permisos de Chimborazo en 2022 al 49,5 % en 2025: leer
  la cifra provincial como si fuera del cantón exageraría el nivel y escondería
  esa pérdida de peso. El visualizador público del INEC solo llega a provincia;
  por eso hace falta el microdato.
- **Falta 2024 en la ESED.** El paquete de datos abiertos de 2025 trae dentro
  2022, 2023 y 2025, pero no 2024, que solo está en el catálogo ANDA (sin ruta
  pública estable). La página lleva el hueco declarado con un «s/d» en la
  gráfica; no se interpola.
- **El valor declarado del INEC va nominal.** El deflactor del PIB que usa el
  resto de la página llega hasta 2024 y no cubre 2025. Las otras tres magnitudes
  (permisos, viviendas, m²) son físicas y no necesitan deflactor: por eso son las
  que llevan la gráfica.
