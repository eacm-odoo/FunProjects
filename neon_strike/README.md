# Neon Strike — módulo Odoo 19

Shooter espacial neón corriendo como acción cliente (OWL 2 + canvas 2D) en el backend de Odoo 19 Community, con marcadores persistidos en PostgreSQL vía ORM.

Creado con Odoo · guía de marca: https://www.odoo.com/page/brand-assets

## Requisitos

- Odoo 19.0 Community (o Enterprise)
- Nada más: cero dependencias Python o JS externas

## Instalación local

1. Descomprime este módulo en tu carpeta de addons personalizados:

```bash
unzip neon_strike-19.0.1.0.0.zip -d ~/odoo/custom_addons/
```

2. Arranca Odoo apuntando a esa ruta e instala el módulo:

```bash
./odoo-bin -d neon_dev \
    --addons-path=addons,~/odoo/custom_addons \
    -i neon_strike \
    --dev=all
```

3. Entra al backend → menú **Neon Strike → Jugar**. Sube el volumen 🔊

Con `--dev=all` los cambios en JS/SCSS/XML se recargan sin reconstruir assets manualmente (refresca el navegador). Para cambios en Python o vistas: `-u neon_strike`.

## Qué incluye

| Pieza | Dónde | Qué hace |
|---|---|---|
| Motor del juego | `static/src/js/game_engine.js` | Clase `NeonStrikeEngine`: física, enemigos, jefe, power-ups, partículas, audio sintetizado (Web Audio) |
| Acción cliente | `static/src/js/neon_strike_game.js` | Componente OWL `NeonStrikeGame`, registrado como `neon_strike.game_action` |
| Template | `static/src/xml/neon_strike_templates.xml` | Toolbar + canvas + leaderboard en vivo |
| Modelo | `models/neon_strike_score.py` | `neon.strike.score` (user_id, score, wave) — el leaderboard es multi-usuario |
| Vistas/menús | `views/neon_strike_views.xml` | App con menú raíz, acción de juego y lista de marcadores |
| Seguridad | `security/ir.model.access.csv` | Usuarios internos: leer/crear; admin: todo |

## Cómo funciona el guardado

Al morir, el componente llama `orm.create("neon.strike.score", [{score, wave}])`. El `user_id` se asigna por default al usuario conectado en el servidor, así que cada usuario de la instancia compite en el mismo leaderboard.

## Desarrollo con Claude Code

Este repo incluye un `CLAUDE.md` con el contexto del proyecto, comandos y backlog de ideas. Abre la carpeta del módulo y corre `claude` desde ahí.

## Licencia

LGPL-3. Ver `LICENSE`.
