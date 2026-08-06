# Ping Pong 3D (Odoo 19.0 Community)

Juego de tenis de mesa 3D contra la máquina, servido como página del sitio web
de Odoo, con los resultados guardados en un modelo consultable desde el backend.

## Instalación

    cp -r pingpong_3d /ruta/a/odoo/addons/
    odoo-bin -d midb -i pingpong_3d

Luego abre **/pingpong** o el menú *Ping Pong 3D -> Jugar*.

## Estructura

    pingpong_3d/
    |- __manifest__.py                 version 19.0.1.0.0, depende de "website"
    |- controllers/main.py             /pingpong (pagina) y /pingpong/score (POST JSON)
    |- models/pingpong_match.py        modelo pingpong.match, victoria y diferencia calculadas
    |- security/ir.model.access.csv    lectura para usuarios internos, escritura para admins
    |- views/pingpong_templates.xml    plantilla QWeb de la pagina a pantalla completa
    |- views/pingpong_match_views.xml  list / form / graph / search + menus
    |- views/website_menu.xml          entrada "Ping Pong" en el menu del sitio web
    \- static/src/
       |- css/pingpong.css             HUD y pantallas (paleta Odoo)
       \- js/pingpong.js               motor 3D, fisica e IA (three.js via importmap)

## Notas técnicas

* **three.js** se carga por *importmap* desde unpkg con hashes de integridad. Para
  una instalación sin salida a internet, descarga `three.module.js`,
  `three.core.js` y los *addons* a `static/lib/three/` y reescribe el importmap
  de `views/pingpong_templates.xml`.
* El juego es un módulo ES independiente (no pasa por los *assets bundles* de
  Odoo) porque necesita el importmap; por eso la plantilla es una página
  autónoma en lugar de heredar `website.layout`.
* La ruta de guardado usa `type="http"` + `request.make_json_response` en lugar
  del envoltorio JSON-RPC, para aceptar un `fetch` con
  `Content-Type: application/json` desde el propio juego. Es pública y sanea
  los valores recibidos (rango y dificultad).
* La física corre a paso fijo (6 subpasos por frame): gravedad, arrastre
  cuadrático, efecto Magnus, decaimiento del efecto y transferencia
  efecto -> velocidad en cada bote.

## Siguientes pasos sugeridos

* Ranking público (`/pingpong/ranking`) con los mejores resultados por dificultad.
* Sonido y repetición del último punto.
* Tests con `odoo.tests.HttpCase` sobre `/pingpong/score`.
