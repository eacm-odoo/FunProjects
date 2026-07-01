# CLAUDE.md — Neon Strike (módulo Odoo 19)

Contexto para Claude Code. Lee esto antes de tocar el código.

## Qué es esto

Módulo de Odoo 19.0 Community que corre un shooter espacial (canvas 2D, OWL 2) como acción cliente en el backend, con marcadores guardados en el modelo `neon.strike.score` vía ORM. Sin dependencias externas.

## Arquitectura

- `static/src/js/game_engine.js` — Clase `NeonStrikeEngine(canvas, {onGameOver})`. TODO el gameplay vive aquí: loop rAF, física, enemigos (drone/speedy/tank/boss), power-ups (T/S/B/L), combos, partículas, screen shake, slow-mo, audio 100% sintetizado con Web Audio (métodos `tone`, `noise`, `sShoot`, `sBoom`...). No importa nada de Odoo: es agnóstica y testeable.
- `static/src/js/neon_strike_game.js` — Componente OWL `NeonStrikeGame` (template `neon_strike.Game`). Monta el motor en `onMounted`, lo destruye en `onWillUnmount`, guarda score con `orm.create` en `onGameOver` y refresca el leaderboard con `orm.searchRead`. Registrado en `registry.category("actions")` con tag `neon_strike.game_action`.
- `static/src/xml/neon_strike_templates.xml` — Template OWL: toolbar (mute/reiniciar), stage del canvas, panel de marcadores.
- `static/src/scss/neon_strike.scss` — Estilos. Toolbar en morado Odoo `#714B67` (brand assets: https://www.odoo.com/page/brand-assets), stage oscuro `#0a0b14`.
- `models/neon_strike_score.py` — `neon.strike.score`: `user_id` (default usuario actual), `player_name` (related stored), `score`, `wave`. `_order = "score desc"`.
- `views/neon_strike_views.xml` — `ir.actions.client` + `ir.actions.act_window` + menús. OJO: Odoo 19 usa `<list>`, NO `<tree>`.
- `security/ir.model.access.csv` — group_user: read+create; group_system: todo.

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

1. **Récord personal vs global**: mostrar en el HUD el mejor score del usuario (searchRead con domain `[("user_id","=",uid)]`) además del top global.
2. **Modo 2 jugadores local**: segundo ship controlado con teclado (WASD + espacio); el motor ya soporta múltiples entidades.
3. **Página pública `/neon`**: controlador `http.route` + template QWeb website para jugar sin login (scores anónimos con `sudo()` y campo `nickname`).
4. **Dificultades**: selector fácil/normal/brutal que escale `wave*factor` en spawns y HP del jefe.
5. **Gráfica de progresión**: vista graph/pivot sobre `neon.strike.score` (score por día, por usuario).
6. **Logros**: modelo `neon.strike.achievement` + m2m en score (primer jefe, combo x15, oleada 10...).
7. **Tests**: `tests/test_score.py` con `TransactionCase` (create asigna user, order correcto) y un tour JS que abre la acción.

## Gotchas conocidos

- El `AudioContext` requiere gesto del usuario: se inicializa en `pointerdown` (método `audio()`). No moverlo a `onMounted`.
- `ResizeObserver` observa el padre del canvas: si cambias el layout del template, verifica que `.ns_stage` siga teniendo altura (flex `min-height: 0` en `.ns_body`).
- `player_name` es related-stored de `user_id.name`: no escribirlo directo.
- El leaderboard usa `t-out` (no `t-esc`, deprecado en OWL 2).
