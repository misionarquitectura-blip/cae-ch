# Pruebas geométricas — GeoVisor CAE-CH

Verifican que el cálculo de superficie, perímetro, coordenadas UTM, afectación
vial y linderos del DICAT sigue siendo exacto, y que el reporte no se contradice
a sí mismo entre secciones.

Las pruebas **extraen las funciones reales de `geovisor.html`** y las ejecutan en
Node contra los GeoJSON de producción. No hay una copia del algoritmo en `test/`:
si cambia `geovisor.html`, estas pruebas miden el código nuevo. Por eso el arnés
falla si se renombra o se borra alguna función geométrica — eso es intencional.

## Ejecutar

```bash
node test/exactitud-predio.js
```

```bash
node test/regresion-catastro.js
```

```bash
node test/servicios-basicos.js
```

```bash
node test/linderos-dicat.js
```

Si tienes el `package.json` local (está en `.gitignore`, no se publica), también vale:

```bash
npm test
```

`regresion-catastro.js` acepta un paso de muestreo: `node test/regresion-catastro.js 100`
recorre 1 de cada 100 predios (más lento, más cobertura). Por defecto usa 350
(~210 predios, alrededor de un minuto).

## Qué cubre cada una

### `exactitud-predio.js`

Contrasta el predio `060104007003003002` contra el levantamiento con estación
total del CAE-CH. Es la prueba que protege el requisito no negociable: **las
coordenadas y el área del predio en consulta deben coincidir con el
levantamiento topográfico**.

Las cifras del patrón viven en `test/fixtures/predio-060104007003003002.json`.
El DXF original del levantamiento **no se publica en este repositorio** (queda en
poder del CAE-CH); el fixture recoge únicamente las magnitudes que el propio
DICAT ya publica: superficie, perímetro, coordenadas UTM de los vértices y áreas
de afectación.

| Comprobación | Tolerancia |
|---|---|
| Superficie medida | 0,01 m² sobre 35 972 m² |
| Perímetro medido | 0,01 m |
| Coordenadas UTM de los vértices | 1 mm |
| Área de afectación vial | 2 % frente al dibujo CAD |
| Coherencia afectación + área útil = superficie | 0,5 m² |

Incluye **guardias anti-regresión** con los valores que producía la versión
anterior (36 184,00 m², 809,52 m, 28 084,01 m²). Si una prueba vuelve a
arrojarlos, se reintrodujo el error.

El margen del 2 % en la afectación es deliberado: el trazado de la línea de
fábrica municipal muere dentro de este predio y su cierre es una interpretación,
así que no cabe exigir coincidencia exacta con el dibujo hecho a mano en CAD.

### `regresion-catastro.js`

Recorre una muestra de todo el catastro y comprueba:

- que ningún predio lanza excepción;
- que la superficie calculada reproduce `Shape__Area` (la geometría GIS del
  GADMR), con tolerancia de 0,01 % o 0,05 cm²;
- que ninguna afectación vial iguala o supera el área del predio, y que
  afectación + área útil cuadra con el polígono principal;
- que el rendimiento se mantiene (media < 150 ms, ningún predio > 400 ms).

### `servicios-basicos.js`

Cubre las capas de EMAPAR: cobertura de agua potable (capa 4) y alcantarillado
(capa 11), y el análisis que alimenta la sección 4 del DICAT.

- **Las capas publicadas son sanas**: las 8 zonas de cobertura cierran anillo, no
  se solapan entre sí (se muestrea el interior en rejilla, no los vértices: las
  zonas comparten linderos), suman ~4 665 ha y todos los tramos de alcantarillado
  llevan red y diámetro extraídos del nombre de capa CAD.
- **La reproyección EPSG:32717 → WGS84 conserva las longitudes**: cada tramo se
  vuelve a medir desde el archivo publicado y se contrasta con la longitud
  calculada en UTM antes de convertir. Tolerancia 0,20 m por tramo — las
  coordenadas se publican con 6 decimales (~11 cm), así que el error máximo
  teórico de un tramo ronda los 17 cm — y 0,01 % sobre los 566,72 km de red.
- **`analizarServiciosBasicos()` acierta**: sobre predios reales del catastro, la
  distancia al tramo más cercano se contrasta con una búsqueda exhaustiva sobre
  los 7 990 tramos, sin el prefiltro por bounding box de ~600 m que usa el visor.
  Si ese prefiltro perdiera el tramo más cercano, la prueba lo delata.
- Un predio sintético montado sobre un tramo real comprueba la rama de "la red
  atraviesa el predio", que un muestreo del catastro rara vez toca porque la red
  va por la vía.

Acepta paso de muestreo: `node test/servicios-basicos.js 1500`.

### `linderos-dicat.js`

Coherencia interna del DICAT: **todo lo que el reporte declara en metros tiene
que salir del mismo plano UTM WGS84 17S**. La sección 3 (colindantes y
dimensiones de linderos) y la sección 8 (plano acotado) deben coincidir con la
tabla de vértices de la sección 6 y con el CSV/DXF que descarga el usuario.

Sobre el predio `060101004001061001` comprueba que los cuatro lados miden
12,87 / 17,66 / 13,56 / 17,18 m con tolerancia de **1 mm**, que cada uno orienta
según su normal exterior, que el tramo compartido con cada vecino es el lado
completo y que la suma cierra el perímetro de 61,28 m.

Incluye **guardias anti-regresión** con los valores que producía la versión
anterior: 10,84 m (lindero compartido por resta de perímetros), 15,95 y 19,71 m
(ancho del bounding box declarado como frente a calle). Y un guardia sobre el
propio fuente: las cotas de la sección 8 no pueden volver a invocar
`turf.distance`, que mide sobre una esfera de 6371 km y desvía hasta 5 mm/m
frente a la proyección oficial.

Después barre una muestra del catastro para confirmar que los invariantes se
cumplen en **todos** los predios, no sólo en el de referencia: ninguna
excepción, toda dimensión finita y contenida en el perímetro, orientación
siempre Norte/Sur/Este/Oeste, el perímetro de los lados nunca supera al de
`medirGeometria()` y la tabla se mantiene acotada — sin agrupar por
(orientación, colindante) un predio rural de 368 lados generaría 368 renglones.

Acepta paso de muestreo: `node test/linderos-dicat.js 25`.

## Notas sobre los datos

**`sup_pred_c` no es la superficie de la geometría.** Es la superficie declarada
en escritura o ficha catastral y difiere legítimamente de lo que mide el
polígono: mediana ~1 %, percentil 90 ~19 %. Para validar el cálculo hay que usar
`Shape__Area`. El DICAT muestra ambas cifras por separado y su diferencia.

**Hay esquirlas y solapes.** El catastro trae unas pocas features de área ~0
(líneas dibujadas como polígono) y polígonos que se superponen: unidades de
propiedad horizontal sobre su lote madre, o digitalizaciones duplicadas. En esos
casos la sección 3 lista más de un colindante sobre el mismo lado y la suma de
linderos puede superar el perímetro. Es fiel al dato de origen, no un error del
cálculo: cada dimensión declarada sigue siendo la de un lado real del predio.

**Hay predios multiparte.** El catastro codifica algunos predios (propiedad
horizontal, lotes partidos por una vía) como `Polygon` con varios anillos, algo
que el estándar GeoJSON reservaría para huecos. `medirGeometria()` decide por
geometría: el anillo contenido en el exterior es hueco y resta, el que queda
fuera es otra parte y suma. Medir sólo `coordinates[0]` subestimaba el área
hasta un 12 %.

## Requisitos

Node ≥ 18 y los GeoJSON presentes en `DATA SET/` (`Catastro GADMR.geojson`,
`LINEAS_FABRICA.geojson`, `agua_potable.geojson` y `alcantarillado.geojson`).
No hay dependencias externas: `servicios-basicos.js` trae su propia
implementación mínima de las cuatro funciones de turf que usa el visor, para no
arrastrar la dependencia al repositorio.
