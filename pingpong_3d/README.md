# Ping Pong 3D (Odoo 19.0 Community)

Juego de tenis de mesa 3D contra la máquina, servido como página del sitio web
de Odoo, con los resultados guardados en un modelo consultable desde el backend.

## Instalación

    cp -r pingpong_3d /ruta/a/odoo/addons/
    odoo-bin -d midb -i pingpong_3d

Luego abre **/pingpong** o el menú *Ping Pong 3D -> Jugar*.

## Estructura

    pingpong_3d/
    |- __manifest__.py                 version 19.0.2.0.0, depende de web, bus y website
    |- controllers/main.py             /pingpong, /pingpong/score y las rutas /pingpong/online/*
    |- models/pingpong_match.py        modelo pingpong.match, victoria y diferencia calculadas
    |- models/pingpong_session.py      sala online: codigo, token de canal, marcador
    |- models/pingpong_participant.py  jugador de una sala, con token propio
    |- models/ir_websocket.py          autoriza los canales de bus por capacidad
    |- security/ir.model.access.csv    lectura para usuarios internos, escritura para admins
    |- views/pingpong_templates.xml    plantilla QWeb de la pagina a pantalla completa
    |- views/pingpong_match_views.xml  list / form / graph / search + menus
    |- views/pingpong_session_views.xml  salas en vivo (solo para depurar)
    |- views/website_menu.xml          entrada "Ping Pong" en el menu del sitio web
    \- static/
       |- lib/three/                   three.js 0.184 vendorizado (MIT, ver LICENSE)
       \- src/
          |- scss/pingpong.scss        HUD y pantallas (paleta Odoo), todo bajo .o_pingpong_root
          |- boot/pingpong_boot.js  carga el bundle del juego solo en su pagina
          |- xml/pingpong_game_templates.xml  plantillas OWL de las pantallas
          |- xml/pingpong_lab_templates.xml   plantilla del banco de netcode
          \- js/
             |- pingpong_game.js       componente OWL y montaje de la pagina
             |- pingpong_engine.js     fachada: simulacion + vista + entrada + bucle
             |- loopback_lab.js        banco: anfitrion e invitado en una pestana
             |- engine/constants.js    medidas, dificultades, paso fijo, codigos de motivo
             |- engine/rng.js          PRNG sembrado (mulberry32) para saques replicables
             |- engine/physics.js      integracion pura: gravedad, arrastre, Magnus, bote
             |- engine/sim.js          partido headless: fases, golpes, puntuacion
             |- engine/ai.js           prediccion de caida y controlador de la maquina
             |- engine/history.js      buffer circular de estados, indexado por tick
             |- net/protocol.js        formato de cable (enteros: mm y rad/s x10)
             |- net/clock.js           MatchClock (tiempo -> tick) y ClockSync (NTP)
             |- net/transport.js       interfaz de transporte y enlace loopback
             |- net/netgame.js         snapshots, claims, rebobinado, reconciliacion
             |- net/bus_transport.js   el transporte real, sobre el bus de Odoo
             |- render/scene.js        construccion de la escena three.js y su dispose
             \- render/view.js         dibujo por frame, camara y efectos

## Notas técnicas

* **three.js 0.184 está vendorizado** en `static/lib/three/` (`three.module.js` y
  `three.core.js`, MIT). Llevan la cabecera `/** @odoo-module **/` para que el
  transpilador de Odoo los convierta en módulos `odoo.define`; el juego los
  importa con `import * as THREE from "../../lib/three/three.module.js"`. Deben
  ser las builds **sin minificar**: el transpilador está anclado a líneas y no
  procesa un bundle de una sola línea. No hay ninguna petición a un CDN.
* Los assets del juego viven en un bundle propio, `pingpong_3d.assets_game`, que
  solo carga la página del juego. No están en `web.assets_frontend` porque
  three.js son ~2 MB de fuente y se descargarían en todo el sitio.
* Todo el CSS está anidado bajo `.o_pingpong_root`, y las clases genéricas se
  llaman `o_pp_*`. La hoja original era para un documento autónomo y traía un
  reset global `*` y clases (`.btn`, `.card`, `.row`, `.hidden`) que chocan con
  Bootstrap.
* La carga tiene dos pasos por una razón concreta. Odoo emite el cargador de
  módulos (`web.assets_frontend_minimal`) como script con `defer` y el resto
  (`web.assets_frontend_lazy`) de forma diferida por JS, así que un
  `t-call-assets` en el `<head>` correría **antes de que exista `odoo.define`**.
  Por eso `pingpong_boot.js` vive en `web.assets_frontend` y pide el bundle del
  juego con `loadBundle()` en tiempo de ejecución, cuando el cargador y los
  módulos `@web` ya están.
* La interfaz es una **app OWL standalone** montada sobre `.o_pingpong_root`.
  Reutiliza el `env` que el frontend público ya construyó y publicó en
  `Component.env` (`web/legacy/js/public/public_root.js`). **No** llames a
  `startServices()` otra vez: vuelve a ejecutar el `start()` de cada servicio y
  el de notificaciones falla al reinscribir `NotificationContainer`.
* El motor vive mientras vive la página, no una instancia por pantalla: el menú
  y la pantalla final son capas sobre la mesa ya renderizada, y recrear el
  contexto WebGL en cada cambio filtraría contextos sin necesidad.
* Los medidores de potencia y efecto se escriben directamente en el DOM con
  `t-ref`: se actualizan en cada golpe y nadie más los lee, así que no pasan por
  la reactividad.
* La ruta de guardado usa `type="http"` + `request.make_json_response` en lugar
  del envoltorio JSON-RPC, para aceptar un `fetch` con
  `Content-Type: application/json` desde el propio juego. Es pública y sanea
  los valores recibidos (rango y dificultad).
* La física corre a **paso fijo real** de 1/240 s con un acumulador y un
  contador de ticks. Antes eran 6 subpasos por frame, así que el tamaño del
  paso dependía de los FPS y un cliente a 144 Hz y otro a 60 Hz divergían. Con
  el paso fijo, el flujo de eventos de un partido es idéntico de 24 a 240 fps.
* Los lados son numéricos: **0 es el extremo +Z y 1 el extremo -Z**, igual en
  las dos máquinas. Solo se invierten la cámara y el mapeo del ratón. La física
  es equivariante bajo espejo: el mismo golpe jugado desde cada extremo produce
  trayectorias espejo exactas. Antes no lo era — el efecto lateral curvaba
  siempre hacia el mismo lado absoluto, sin importar quién había golpeado.
* Los saques usan un PRNG sembrado por (semilla de partido, número de punto),
  de modo que dos clientes pueden reproducir el mismo saque. En modo contra la
  máquina no hay semilla y se usa `Math.random`.

## Modo online (en curso)

Autoridad repartida: el anfitrión simula la bola y puntúa, **cada lado posee su
propia pala sin latencia**, y el invitado predice su propio golpe y el anfitrión
lo confirma. Sin esa última parte el juego no es jugable cuando un viaje de ida
y vuelta es una fracción apreciable de un intercambio.

* **Base de tiempo compartida.** Los dos extremos derivan su tick del mismo
  instante (`MatchClock` + `ClockSync` estilo NTP sobre el propio transporte),
  así que sus contadores coinciden por construcción y el invitado puede indexar
  su historial con el tick que trae un snapshot del anfitrión.
* **Dirigido por eventos.** 10 Hz de snapshot base y 12 Hz de paletas en lotes,
  más un mensaje **inmediato** en cada golpe, saque y punto. El del golpe del
  anfitrión es el más valioso del protocolo: sin él la corrección mediana en el
  invitado es de 469 mm, con él baja a 43 mm.
* **Reclamación de golpe.** El invitado golpea y lo dibuja al instante; el
  anfitrión rebobina al tick reclamado y **recalcula el tiro él mismo** desde su
  propia bola y la pala reclamada. El tiro que mandó el invitado solo se guarda
  como métrica. Eso elimina la clase entera de trampas de "tiro a medida" y,
  como el golpe es determinista, aceptar no cuesta ninguna corrección visible.
* **Veredicto retrasado.** "No llegó" y "fuera" son los dos únicos fallos que una
  reclamación puede revocar, así que el anfitrión los retiene mientras la ventana
  de rebobinado siga abierta. La ventana y el retraso se dimensionan con el RTT
  medido: una ventana más corta que el enlace convierte golpes legítimos en
  rechazos.
* **Banco de pruebas**: `/pingpong?net=loopback` monta anfitrión e invitado lado
  a lado con deslizadores de latencia, jitter y pérdida. Todo el netcode corre de
  verdad salvo el transporte.
* **Identidad sin cuenta.** El servidor emite un `token` por jugador y lo
  devuelve una sola vez; el cliente lo guarda en `sessionStorage`, o sea por
  pestaña. Es una desviación deliberada de `neon_strike`, que deriva la identidad
  de la sesión HTTP y por eso no distingue dos pestañas del mismo navegador, lo
  que hace imposible probar un juego de dos en local.
* **Canales autorizados por capacidad.** Todos los jugadores son el usuario
  público, así que no hay nada que comprobar en `env.user`. Lo que el nombre del
  canal lleva es un secreto — el `access_token` de la sala o el `token` del
  jugador — y conocerlo es la prueba de que te dejaron entrar, porque el único
  sitio donde se entregan es la respuesta a crear o unirse. Una sala terminada
  deja de conceder suscripción, y los canales ajenos se pasan a `super()`:
  olvidarlo rompería Discuss en la misma página.
* **Dos planos.** El canal de sala (`pingpong_session_<token>`) lleva el control
  — lobby, arranque, marcador, fin. Cada jugador tiene además un buzón privado
  (`pingpong_player_<token>`) para los datos, de modo que el anfitrión no recibe
  de vuelta sus propios snapshots ni el invitado el flujo de pala del otro.
* **El servidor manda el arranque.** `/pingpong/online/start` fija `t0` y la
  semilla y los difunde por el canal de sala; los dos clientes anclan su tick al
  mismo instante. Si lo anunciara el anfitrión, estaríamos confiando a un cliente
  el reloj contra el que se mide cada rebobinado.
* **Nada se reenvía tal cual.** `/pingpong/online/relay` reconstruye cada payload
  desde una lista blanca por tipo (`RELAY_TYPES` en el modelo de sala). Reenviar
  el diccionario del cliente convertiría el buzón en una vía para inyectar
  objetos arbitrarios en el cliente del rival.
* **El marcador lo lleva el servidor.** El anfitrión reporta por
  `/pingpong/online/point` *quién ganó el punto y por qué*, nunca el marcador; el
  servidor incrementa su propia cuenta de uno en uno. Para cuando llega
  `/pingpong/online/finish`, el resultado ya se conoce en el servidor y la cifra
  que mande el cliente **se ignora**. Es la diferencia entre un marcador que se
  afirma y uno que hay que ganarse punto a punto.
* **Cada tipo tiene un remitente permitido.** Solo el anfitrión difunde estado y
  eventos; solo el invitado manda su pala y reclama un golpe (`RELAY_ROLES`).
* **Las rutas de relay no escriben.** Odoo trabaja en REPEATABLE READ y reintenta
  los fallos de serialización con hasta segundos de espera; si los mensajes de
  los dos jugadores actualizaran la misma fila a estas tasas se serializarían
  entre sí y ese backoff destrozaría el netcode. Solo escribe el latido, y con
  throttle.

Medido sobre partidos completos simulados (26 mensajes/s por partida en todos los
casos, y el marcador siempre coincide entre los dos extremos):

| RTT   | error medio | corrección mediana | rechazo de claims |
|-------|-------------|--------------------|-------------------|
| 0 ms  | 4 mm        | 3 mm               | 2,3 %             |
| 20 ms | 4 mm        | 8 mm               | 2,3 %             |
| 100 ms| 30 mm       | 43 mm              | 2,2 %             |
| 200 ms| 96 mm       | 61 mm              | 2,0 %             |
| 300 ms| 130 mm      | 45 mm              | 5-15 %            |

Por encima de ~250 ms de RTT la experiencia se degrada de forma apreciable; ahí
conviene avisar al jugador y no emparejar automáticamente.

## Siguientes pasos sugeridos

* **Partida rápida**: cola pública que empareja a quien esté esperando. El modelo
  ya lleva `is_public_queue` y el emparejamiento sin carrera está diseñado con
  `try_lock_for_update`, que emite `FOR UPDATE SKIP LOCKED`.
* **Limpieza**: cron que cierre salas abandonadas (`state` en `waiting`/`ready`
  sin señal, o `playing` con un jugador ido) y borre las viejas. Hoy quedan como
  basura, que es lo que pasa con un endpoint público.
* **Límites de tasa** en las rutas públicas: hoy cualquiera puede crear salas sin
  freno. El core de Odoo no trae nada reutilizable para esto.
* **Reclamar victoria por abandono**: si el rival lleva 15 s sin latido, el que
  queda debería poder cerrar el partido a su favor, validándolo el servidor
  contra `last_seen` y no contra lo que diga el cliente.
* **Reconexión** tras un F5: el token vive en `sessionStorage` y `/info` ya
  devuelve la sala entera, así que falta sobre todo la parte de interfaz.
* Ranking público (`/pingpong/ranking`) con los mejores resultados por dificultad.
* Sonido y repetición del último punto.
