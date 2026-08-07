# CLAUDE.md — Neon Strike (módulo Odoo 19)

Contexto para Claude Code. Lee esto antes de tocar el código.

## Qué es esto

Módulo de Odoo 19.0 Community que corre un shooter espacial (canvas 2D, OWL 2) en una **página pública `/neon`** publicada en el menú del website (igual que `pingpong_3d`), jugable **sin login**: entras con un apodo y juegas. Soporta **cooperativo remoto de hasta 4 jugadores** sobre el bus de Odoo (sala por código, host-autoritativo) además del modo 1 jugador. La identidad de cada jugador es un **token de sesión + apodo** (no `res.users`). Marcador global único en `neon.strike.score`. Sin dependencias externas más allá de `web`, `bus` y `website`.

## Arquitectura

- `static/src/js/game_engine.js` — Clase `NeonStrikeEngine(canvas, {onGameOver, onLocalInput, role, players, localSlot, names, hotseat})`. TODO el gameplay vive aquí: loop rAF, física, enemigos (drone/speedy/tank/boss), **asteroides** (`rocks`), power-ups (T/S/B/L), combos (tope x25), partículas, screen shake, slow-mo, audio sintetizado. **N naves** en `this.ships` (array por slot), vidas individuales, caída (`down`) y revivir volando junto al resto. Se simula en un **espacio lógico fijo 680×540** (render escalado con letterbox) para que las coordenadas sean idénticas en todas las máquinas. Roles:
  - `solo` — simulación local 1 jugador.
  - `host` — simula todo; `snapshot()` serializa estado compacto para difundir; aplica input remoto con `setRemoteInput(slot, tx, ty)`.
  - `guest` — no simula; `applySnapshot(snap)` y renderiza; reporta puntero por `onLocalInput`.
  No importa nada de Odoo: agnóstica y testeable.
- `static/src/js/neon_strike_game.js` — Componente OWL `NeonStrikeGame` (template `neon_strike.Game`). Pantallas `state.screen` = `menu | lobby | game`. Usa `rpc` (a `/neon/*`) y `bus_service` (NO `orm`: `call_kw` es `auth="user"`). Crea/destruye el motor con `useEffect` al entrar/salir de `game`. Host difunde snapshot ~15 Hz (`/neon/state`); guest reenvía puntero ~20 Hz (`/neon/input`). Suscribe `ns_lobby|ns_start|ns_state|ns_input|ns_end`. **No** es acción cliente: al final del archivo, un `whenReady` monta el componente como app OWL standalone (`makeEnv`+`startServices`+`mount` con `getTemplate`) en `.o_neon_strike_root` si existe.
- `controllers/main.py` — `NeonStrikeController` (`http.Controller`). `GET /neon` (`auth="public"`, `website=True`, `sitemap=False`) renderiza `neon_strike.page` y asegura el token de sesión. Rutas JSON `auth="public"` (`/neon/create|join|start|input|state|score|solo_score|leave|scores`) que operan con `sudo()` y resuelven al jugador por `request.session["neon_token"]`.
- `static/src/xml/neon_strike_templates.xml` — Templates OWL: `neon_strike.Game` (toolbar + menú con **input de apodo** / lobby / juego) y `neon_strike.Leaderboard`. `t-out` (no `t-esc`).
- `views/neon_strike_page.xml` — QWeb `neon_strike.page`: usa `t-call="web.frontend_layout"` (solo depende de `web`; trae assets frontend + session info) y contiene `.o_neon_strike_root` (posicionado a pantalla completa por CSS). Añade meta `generator`/`author` = Odoo vía `additional_head` y quita el chrome con `no_header`/`no_footer`.
- `static/src/scss/neon_strike.scss` — Estilos. `body.o_neon_strike_page`/`.o_neon_strike_root` a pantalla completa. Morado Odoo `#714B67` (brand assets: https://www.odoo.com/page/brand-assets) en toolbar/paneles; stage oscuro. Estilos de menú/lobby/apodo/badge co-op.
- `models/neon_strike_score.py` — `neon.strike.score`: `user_id` (opcional), `nickname`, `player_name` (computed stored: apodo o nombre de usuario), `score`, `wave`, `mode` (solo/coop), `player_count`, `match_id`. `_order = "score desc, id asc"`.
- `models/neon_strike_match.py` — `neon.strike.match`: `code`, `access_token` (uuid, canal), `host_token`, `host_user_id` (opcional/informativo), `state` (lobby/playing/over), `participant_ids`, `MAX_PLAYERS=4`. API llamada por los controladores (con token): `create_match`, `join_by_code`, `start`, `player_input`, `broadcast_state`, `submit_score`, `leave`. `_channel()` = `neon_strike_match_<access_token>`. La autoridad (start/broadcast/submit sólo host) se valida comparando `host_token`.
- `models/neon_strike_participant.py` — `neon.strike.participant`: `match_id`, `token`, `nickname`, `user_id` (opcional), `slot`, `name` (computed: apodo o usuario), `color` (computado por slot). Colores = SHIP_COLORS del motor.
- `models/ir_websocket.py` — hereda `ir.websocket`, sobreescribe `_build_bus_channel_list` para autorizar `neon_strike_match_<access_token>` **por capacidad**: se permite si existe un match con ese token (no depende de `env.user`, todos son el usuario público).
- `views/neon_strike_views.xml` — `ir.actions.act_url` a `/neon` (menú "Jugar" abre la página) + `ir.actions.act_window` de Marcadores + menús. Lista con `mode`/`player_count`. Odoo 19 usa `<list>`, NO `<tree>`.
- `views/website_menu.xml` — record `website.menu` "Neon Strike" → `/neon` bajo `website.main_menu` (mismo patrón que `pingpong_3d/views/website_menu.xml`). Es lo que hace que el juego sea alcanzable desde la navegación pública del sitio.
- `security/ir.model.access.csv` — score: `group_user` read; match/participant/score admin: `group_system`. El público NO accede por ORM directo (todo va por controladores con `sudo()`), así que no hay ACL de `group_user` para match/participant ni reglas de registro.

## Comandos

```bash
# Instalar / primera vez
./odoo-bin -d neon_dev --addons-path=addons,/ruta/custom_addons -i neon_strike --dev=all

# Tras cambios Python / vistas XML / seguridad
./odoo-bin -d neon_dev --addons-path=... -u neon_strike --dev=all

# JS/SCSS/templates OWL: con --dev=all basta refrescar el navegador
```

Verificación rápida sin levantar Odoo:
```bash
python3 -m py_compile models/*.py __manifest__.py
python3 -c "import ast; ast.literal_eval(open('__manifest__.py').read().split('{',1)[0] and open('__manifest__.py').read()[open('__manifest__.py').read().index('{'):])"
node --check <(cat static/src/js/game_engine.js)  # requiere copiar a .mjs si falla por ESM
```

## Convenciones del proyecto

- Cabecera estándar en todos los archivos: `Part of Odoo. See LICENSE file...` — mantenerla en archivos nuevos.
- Branding Odoo obligatorio en UI/documentos generados (morado #714B67, enlace a brand assets, autor "Odoo" en manifest). No quitarlo.
- Versión en manifest: `19.0.x.y.z` — subir el tercer dígito en features, cuarto en fixes.
- JS: ES modules con `/** @odoo-module **/`, OWL 2 (hooks `onMounted`/`onWillUnmount`, `useState`, `useRef`, `useService`).
- El motor NO debe importar nada de `@web/*`: mantener la separación motor/componente.
- Textos de UI en español (es-MX).

## Backlog de ideas (por prioridad)

Hecho: **cooperativo remoto hasta 4 (bus de Odoo, sala por código)**, vidas individuales + revivir, asteroides, combo x25, marcador de equipo, **página pública `/neon` sin login (apodo + token de sesión)**.

1. **Interpolación de entidades en guest**: hoy enemigos/balas se pintan directos del snapshot (~15 Hz, algo entrecortado); interpolar entre los dos últimos snapshots.
2. **Migración de host**: si el host cierra, la partida termina; permitir pasar el rol a otro participante.
3. **Limpieza de partidas viejas**: cron que borre `neon.strike.match` en estado `over` o abandonadas (hoy quedan como basura al ser público).
4. **Anti-abuso**: rate-limit / validación en los controladores públicos (hoy cualquiera puede crear matches y postear scores).
5. **Dificultades**: selector fácil/normal/brutal que escale `wave*factor` en spawns y HP del jefe.
6. **Gráfica de progresión**: vista graph/pivot sobre `neon.strike.score`.
7. **Logros** y **tests** (`TransactionCase` + `HttpCase`/tour JS sobre `/neon`).

## Gotchas conocidos

- El `AudioContext` requiere gesto del usuario: se inicializa en `pointerdown` (método `audio()`). No moverlo a `onMounted`.
- **Espacio lógico fijo 680×540**: toda la simulación usa `this.W/H` fijos; el render escala al canvas (`resize()` calcula `scale/ox/oy`) y el input mapea físico→lógico en `_ptr`. NO volver a atar `W/H` al tamaño del contenedor: rompería la coherencia host/guest.
- **Host-autoritativo**: sólo el host simula. El guest es render puro; su `update()` es `_guestUpdate` (interpola posición de naves, regenera partículas/audio locales desde `snapshot.ev`). No meter lógica de juego en la rama guest.
- **Coste del bus**: host difunde ~15 Hz y cada guest manda input ~20 Hz vía RPC (cada envío = fila `bus.bus` + push websocket). Aceptable para 2–4 jugadores en dev; no es netcode de baja latencia.
- **`website=True` en `/neon` es obligatorio**: `web.frontend_layout` es heredado por `portal.frontend_layout` y, a su vez, por `website.layout`, que usa `website.id` sin guarda. Ese `website` sólo entra en el contexto de render si `request.is_frontend` es True, y eso lo decide `routing.get('website')` (`http_routing/models/ir_http.py`). Con `website=False` la página falla con `KeyError: 'website'` en cualquier BD que tenga `website` instalado. El flag no molesta si `website` no está.
- **Público sin login**: no hay `orm`/`call_kw` en el cliente (es `auth="user"`). Todo pasa por controladores JSON `auth="public"` con `sudo()`. La identidad es `request.session["neon_token"]` (uuid), NO `res.users`.
- **Canal por capacidad**: el canal es `neon_strike_match_<access_token>` (uuid del match). `_build_bus_channel_list` lo permite si existe un match con ese token; conocer el token = te uniste. No usar el `id` en el canal (es adivinable).
- **Montaje standalone**: el juego se monta con `mount(...)` sobre `.o_neon_strike_root` en `whenReady` (no es acción cliente). Necesita que `bus_service` y `rpc` estén en `web.assets_frontend`.
- `player_name`/`participant.name` son **computed stored** (apodo o `user_id.name`): no escribirlos directo.
- El leaderboard usa `t-out` (no `t-esc`, deprecado en OWL 2).
- API Odoo 19 usada de memoria (fuente no montado): `bus.bus._sendone`, `bus_service.addChannel/subscribe/unsubscribe`, `ir.websocket._build_bus_channel_list`, `mountComponent`/`makeEnv`/`startServices`/`getTemplate`, `<t t-call-assets ... t-js/t-css>`. Verificar firmas al probar contra 19.0 real.
