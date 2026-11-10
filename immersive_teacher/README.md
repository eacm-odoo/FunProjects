# Immersive Teacher

A virtual teacher for Meta Quest 3 mixed reality. You ask a question out loud,
the teacher answers in Spanish or English (an ES / EN switch on the page) and,
while it explains, a 3D diagram builds up next to it, one step per sentence.
It can also answer from your own material: upload a document or load a public
documentation page, and ask about it. For Odoo questions, it can first ask Odoo AI,
the support assistant of odoo.com/help, and then explain that answer.

The project is built in phases, and each phase is tested before the next one starts:

| Phase | Content | State |
|---|---|---|
| 1 | Backend + desktop view: type a question, read the answer, see the 3D diagram | done |
| 2 | Voice on the PC: push-to-talk, transcription (Deepgram), streamed speech (ElevenLabs) | done |
| 3 | The teacher character: idle animation, lip sync, listening/thinking/speaking states | done |
| 4 | WebXR on the Quest 3: `immersive-ar`, hit-test placement, controllers and hands, emulator | built, to test on the headset |
| 5 | Polish: errors (offline, API down, microphone denied), limits, response times | built; latency tuning waits for headset numbers |

## Requirements

- Node.js 22.23.4 or newer in the 22 line, 24.22.1+ or 26.12.1+. Those are the
  October 2026 security releases (10 CVEs, among them an actively exploited Brotli
  decoder flaw that matters here: the server decompresses the APIs' responses).
  Node 20 and older get no fixes. Tested on 22.23.4 and 26.13.0. `.env` is read
  with Node's own `process.loadEnvFile`, no dotenv.
- An Anthropic API key (or `LLM_PROVIDER=fake`).
- For the voice: a Deepgram key, plus an ElevenLabs key and the ID of a voice
  (it speaks both languages; an English one can be added), or only the Deepgram
  key with `TTS_PROVIDER=deepgram` (or
  `STT_PROVIDER=fake` and `TTS_PROVIDER=fake` or `none`). Every provider has a
  fake that needs no key, so any mix works.

## Setup

    cd immersive_teacher
    npm install
    cp .env.example .env      # then fill in the keys
    npm run dev

Open http://localhost:8787. Hold the **Mantén para hablar** button (or the space
bar, when the cursor is not in the text box), ask, and release: the teacher
answers out loud and the diagram follows the voice. Talking again while it
explains interrupts it. You can also type the question. The browser asks for the
microphone on the first press.

`http://localhost:8787/?q=...` asks that question as soon as the page connects.
Browsers keep audio muted until the first click or key, so that first answer is
paced as text.

Three useful mixes in `.env`:

| Goal | Settings |
|---|---|
| Everything real, ElevenLabs voice | the three keys and `ELEVENLABS_VOICE_ID` |
| Everything real, one speech account | Claude and Deepgram keys, `TTS_PROVIDER=deepgram` (voice in `DEEPGRAM_VOICE`) |
| Claude only (phase 1 test) | `STT_PROVIDER=fake`, `TTS_PROVIDER=none` |
| No cost at all | `LLM_PROVIDER=fake`, `STT_PROVIDER=fake`, `TTS_PROVIDER=fake` |

### Languages

The page and the teacher speak Spanish or English. The **ES / EN** switch in the
side panel (and an **English** / **Español** button beside the teacher in the
headset) changes both at once. It is named in the language it switches to, so
whoever speaks that language finds it. The browser remembers the choice.

- Every question carries its language. The server picks from it:
  - the system prompt (one per language, each with its own example);
  - Deepgram's `language`;
  - the voice;
  - its own messages (errors, apologies).
- Switching mid-conversation keeps the history: each prompt tells Claude to
  answer in its language whatever the earlier turns were in.
- What is already on screen stays as it was said.
- Each prompt is cached separately, so the first question after a switch writes
  the cache again (about one cent), then it costs as usual.
- Voices:
  - Deepgram has one per language: `DEEPGRAM_VOICE` (Spanish) and
    `DEEPGRAM_VOICE_EN` (default `aura-2-thalia-en`).
  - An ElevenLabs voice speaks both languages, with `language_code` set per
    sentence. `ELEVENLABS_VOICE_ID_EN` gives English a native voice.
- `TEACHER_LANGUAGE` (default `es`) is the language a page starts in until the
  user picks one. A region (`es-419`, `en-GB`) only reaches the transcription of
  that language.
  - It is not called `LANGUAGE` on purpose: Linux shells already export
    `LANGUAGE` for the system locale (for example `en_US:en`), and a variable
    from the shell wins over the one in `.env`.
- The interface texts live in `client/src/i18n.js`, the server's in
  `server/src/i18n.js`. A test checks that both languages have every text.

The fakes (both in the question's language):
- **LLM:** streams canned answers in the real format, with realistic pauses. A
  question about photosynthesis or plants gets the photosynthesis answer. One
  containing "error" gets an answer with broken diagram lines, to see the speech
  go on while the bad parts of the diagram are dropped. Anything else gets the
  water cycle.
- **STT:** whatever you say, it "hears" the next of those three questions, in turn.
- **TTS:** a hum with the rhythm of speech, as long as reading the sentence aloud.

Every variable is described in [.env.example](.env.example).

### Sources: documents and pages

The **Fuentes / Sources** part of the panel gives the teacher material to answer from:
- **Subir / Upload** (or drop a file anywhere on the page): PDF, Word (.docx),
  Markdown, plain text, CSV, JSON, HTML or code. Claude reads a PDF's text and also
  sees its pages, so tables and figures count. Of a Word file only the text is kept.
- **A public URL** in the field next to it (`https://` is optional): the server
  downloads that one page and keeps its main content, without menus. It does not
  follow links: for several pages of the same documentation, load each one. A page
  that builds its content with JavaScript comes back nearly empty, and the error
  suggests saving it as a PDF and uploading that.
- **Explícamelo / Explain it** on a source asks the teacher what it is about. Any
  other question uses the sources too; when they do not cover it, the teacher says so
  and answers from what it knows. In the headset, the suggested questions (B or Y)
  start with "explain" ones for each source. Add sources on the page before entering.

Each source shows its size in tokens. Limits: `MAX_SOURCES` at once (3),
`MAX_SOURCE_MB` per file or page (10), `MAX_SOURCE_TOKENS` for all of them together
(100,000). The size comes from Claude's `count_tokens` when the source is added, so
a document that does not fit is refused right away, not at the first question.

How it works: a source is read once, when it is added, and becomes a document block
that goes first in the first message of every request, with `cache_control` on the
last one. Every question sends the same documents in the same place, so Claude
reads them from its cache. Sources belong to the page's connection: after a
reconnect the page sends them again, and a reload of the page forgets them.

Safety: the server only downloads `http` and `https` addresses on the public
internet. It refuses this computer, private networks and cloud metadata addresses,
checks every redirect again, and stops after 15 seconds or `MAX_SOURCE_MB`. This
matters when colleagues reach the server through a tunnel. The prompt tells Claude
that what a document says is information, not instructions.

### Odoo AI: the teacher explains Odoo support's answer

With **Consultar primero a Odoo AI / Check with Odoo AI first** ticked (under the
conversation, or the **Odoo AI** button in the headset), each question goes first to
Odoo AI, the chat of [odoo.com/help](https://www.odoo.com/help). Its answer comes from
Odoo's documentation. Meanwhile the teacher shows it is thinking. Then Claude
explains that answer, with the same steps and menus and nothing added, and the
diagram shows its steps. It does not announce where the answer came from: the user
chose that. Under the explanation, **Respuesta de Odoo AI / Odoo AI's answer**
unfolds the original text and the documentation pages it used. The choice is
remembered in the browser.

- Odoo AI takes about 4 seconds, which comes before Claude's first word.
- Follow-up questions keep their context: the server sends Odoo AI the last
  `HISTORY_TURNS` exchanges, in its own format. Claude gets only the answer to the
  current question; its own earlier explanations carry the rest.
- If Odoo AI fails (no network, timeout after 30 s, an error), a note says so and
  the teacher answers on its own, saying that this did not come from support.
- `ODOO_AI=off` hides the switch. `ODOO_AI=fake` gives a canned answer without
  calling odoo.com, to try the flow.

How it works: the server calls `POST /help/generate_text` (JSON-RPC), the same route
the help page's chat uses. It sends `{conversation_history}` in Gemini's format and
gets back `{parts, grounding}`. Each answer goes back in the next request as it came,
`thoughtSignature` included. For Claude, the answer becomes a document titled
"Odoo AI" in the question's message, after the sources' cache breakpoint, so the
cached prefix stays the same.

This is an internal route of odoo.com, without a public contract: it can change or
start refusing clients that are not its page. Each question also costs Odoo a model
call. Keep it for personal use and demos.

### Going deeper into a node

Every answer leaves a question open: Claude marks one or two nodes with a `hook`
(for example "¿Adónde va la glucosa?") and its last sentence asks it out loud,
without answering. When the teacher is done talking, those nodes show a beating
**?**, and the panel lists their questions as buttons.

- **Click a node** (or aim at it and press the trigger or pinch in the headset).
  The rest of the diagram shrinks away, the arrows pull back, and the node glides
  to the center while the teacher points at it. Then the teacher explains that
  node, and the new diagram builds up around it. If the node had a question
  open, that is the one answered first, and a new one is left.
- **‹ La fotosíntesis** above the title (or **Volver a...** in the panel) shows
  the diagram one level up again. Nothing is asked: it costs nothing. The node
  already opened has a green ring and a **✓**.
- **A node already opened** brings back the diagram it gave, silently: nothing
  is asked and nothing is said again.
- **Volver a explicar / Explain it again**, under each answer and in the
  headset's side menu while its diagram is on screen, says that explanation
  again. It plays the speech received the first time, kept in the page, so
  nothing goes to the server: no tokens and no speech characters. The sentences
  light up as they are said, and talking over it stops it. Without speech (no
  voice, or audio still locked) the sentences are paced as text.
- Pointing at a node with a question in the headset shows that question in the
  captions.

The browser only names the diagram (by its turn) and the node (by its id). The
server builds the question from the diagram it kept (`server/src/dive.js`):
- the node and its connections;
- its open question;
- the first question of the chain, so even three levels down the teacher stays
  on what was asked at the start.

The node is sent again as the first step of the new diagram, so Claude connects to
it instead of drawing it again. With Odoo AI on, Odoo AI gets a plain question,
"Sobre «first question»: open question". Each server connection keeps its last 12
diagrams. An older one, or one from before a reconnection, answers
`node_gone`: ask it again.

Going deeper is one more question: it counts for `MAX_QUESTIONS_PER_HOUR` and
costs what a question costs. Opening the same node again and **Volver a
explicar** cost nothing. The page keeps the speech of its last 12 answers, about
50 KB per second of voice.

### Costs

List prices as of November 2026, for a typical answer of 400 to 500 characters:
- Claude Sonnet 5.5: about 1 cent per question.
- Deepgram Nova-3: 0.0043 USD per audio minute, about 0.0007 USD per question. New
  accounts get 200 USD of credit.
- ElevenLabs Flash v2.5: 0.04 USD per 1,000 characters, about 0.02 USD per answer.
  The free plan covers about 40 answers a month, but only with ElevenLabs' default
  voices: Voice Library voices need a paid plan to be used through the API. The
  default voices also stop working on December 31, 2026, according to ElevenLabs.
- Deepgram Aura-2 (the alternative voice): 0.030 USD per 1,000 characters, about
  0.014 USD per answer, paid from the same Deepgram credit as the transcription.
  It has 17 native Spanish voices and many English ones, but no equivalent of
  `previous_text`, so each sentence is read on its own.
- Sources go with every question. With Claude Sonnet 5.5, 50,000 tokens of
  documents cost about 0.125 USD on the first question (writing the cache) and
  about 0.01 USD on each question less than 5 minutes after the previous one
  (reading it). After a longer pause the cache is written again. Big documents
  also delay the first word a little, mostly on that first question.
- Odoo AI costs you nothing, but its answer adds 500 to 1,500 input tokens to
  Claude's request, about 0.003 USD per question.

## How a question flows

1. While the button is held, MediaRecorder records webm/opus. On release the
   browser sends `ask_audio` and the recording over the WebSocket (`/ws`).
2. The server sends the recording to Deepgram as is and gets the text back.
3. The server streams Claude's answer and splits it line by line (see the format below).
4. Each sentence goes to the browser and to the voice (ElevenLabs or Deepgram)
   as soon as its line is complete. Up to two sentences synthesize at once. With
   ElevenLabs each one carries the previous sentence as `previous_text`, so the
   intonation flows.
5. Speech comes back as 24 kHz PCM, forwarded chunk by chunk as binary frames.
6. The browser plays the sentences strictly in order and reveals each diagram step
   when its sentence starts sounding. Without speech (`TTS_PROVIDER=none`) a timer
   paces them at reading-aloud speed instead.

If the speech of a sentence fails, the text goes on: that sentence keeps its time in
silence, and a note explains why.

## Mixed reality on the Quest 3

The Quest's browser opens the same page. **Entrar en realidad mixta** asks for
the microphone first (a prompt inside the immersive session is easy to miss),
then opens an `immersive-ar` session over the passthrough view.

### Connecting the headset (once per session: steps 3 to 6)

1. Turn on developer mode: in the Meta Horizon app on your phone, open the
   headset's settings and switch on **Developer mode**. Meta asks you to create a
   free developer organization at developers.meta.com first.
2. Install adb on the PC: `sudo apt install adb` (or Android's platform-tools).
3. Plug the headset into the PC with a USB-C cable, run `adb devices`, and accept
   **Allow USB debugging** inside the headset. `adb devices` must then list it as
   `device`, not `unauthorized`.
4. Start the server on the PC: `npm run dev`.
5. `adb reverse tcp:8787 tcp:8787`, so the headset's `localhost:8787` is the PC's.
   Repeat it whenever the cable is plugged in again.
6. In the Quest browser open `http://localhost:8787` and press
   **Entrar en realidad mixta**.

`localhost` counts as a secure context, so WebXR and the microphone work
without HTTPS, and the server can keep `HOST=127.0.0.1`. To see the headset's
console (the `release->...` timings, errors), open `chrome://inspect/#devices`
in Chrome on the PC and pick the Quest browser tab.

### In the headset

| To | Controllers | Hands |
|---|---|---|
| Place the teacher | aim at the floor or a table, trigger | aim, pinch (index and thumb) |
| Ask a question | hold the trigger, release to send | hold the pinch, release to send |
| Move the diagram | aim at the bar under it, hold trigger or grip, move | aim at the bar, hold the pinch, move |
| Choose a new place | A or X (again to cancel), or the **Mover al profesor** button | aim at **Mover al profesor**, pinch |
| Switch language | aim at **English** / **Español**, trigger | aim at it, pinch |
| Turn Odoo AI on or off | aim at **Odoo AI: sí/no**, trigger | aim at it, pinch |
| Show or hide suggested questions | B or Y | (shown on their own without a microphone) |
| Ask a suggested question | aim at it, trigger | aim at it, pinch |
| Go deeper into a node | aim at it (it grows), trigger | aim at it, pinch |
| Back to the diagram before | aim at **‹ ...** above the title, trigger | aim at it, pinch |
| Hear an explanation again | aim at **Volver a explicar**, trigger | aim at it, pinch |

- A green ring shows where the teacher will stand; grey means the surface is
  not flat enough (a wall, a slope).
- On the floor the teacher is about 1.45 m tall and the diagram floats at 1.4 m.
  On anything 30 cm or more above the floor (a desk, a coffee table) it becomes a
  small desk teacher (0.35 scale) with the diagram 0.35 m over the surface.
- Captions under the diagram say what to do, what the teacher heard, the
  sentence being said, and any warning: the side panel is not visible there.
- A short vibration confirms each placement, recording and grab.
- On the teacher's other side float its buttons: **Mover al profesor**, the
  language switch, **Odoo AI** (when the server has it; highlighted when on)
  and, when there is no microphone (or after B/Y), four suggested questions.

### Without a headset: the emulator

    npm run dev
    # then open http://localhost:8787/?emulate

`?emulate` loads Meta's Immersive Web Emulation Runtime (IWER 2.7.0): an emulated
Quest 3, its DevUI panel to move the head, controllers and hands, and a synthetic
room (`sunlit_living_room`) that the hit-test treats as the real one. It exists
only in development: the production build does not contain it. The console warns
about "multiple instances of Three.js" because the emulator brings its own copy;
that is expected. Meta's "Immersive Web Emulator" Chrome extension also works.

Inside the session the IWER panel has a toolbar at the top and one panel per
controller. Two ways to drive it:

- **Panels:** in **Controller [R]** set **Rot X** to about `-40` so the ray points
  at the floor (a green ring appears), then raise **Trig** to 1 and back to 0 to
  place the teacher. Keep it at 1 while "talking" (Chrome uses your real
  microphone), back to 0 to send. **A** is the button under **Trig** and **Grip**.
- **Play mode** (the play button in the toolbar): the mouse turns your head and
  the controllers follow; left click is the right trigger (hold it to talk),
  right click the right grip, Enter is A, X is X, Esc leaves play mode.

From the console, `immersiveTeacher.emulator.device` drives the emulated device,
for example `immersiveTeacher.emulator.device.controllers.right.updateButtonValue("trigger", 1)`.

## When something fails

The rule: the teacher never goes silent without a reason you can see.

| What fails | What happens |
|---|---|
| The microphone is denied or missing | Desktop: a message, and the text box still works. Headset: the suggested questions appear next to the teacher. |
| Nothing was heard, or Deepgram fails | The teacher says "Perdón, no te escuché bien. ¿Me lo repites?", then the reason shows in writing. |
| Claude fails (down, network, key, rate limit) | Whatever was already said plays to the end; the teacher apologizes out loud with a confused shrug; the details show in writing after it. |
| Claude goes quiet | After 10 s without a token (30 s inside a thinking block, which streams without text) the request is cut as `llm_timeout`, then the same apology. |
| The voice fails for one sentence | That sentence keeps its time in silence, the mouth keeps moving, the text goes on, one note explains it. |
| The voice refuses the key, voice or payment | One note, and no more voice requests for the rest of that answer. |
| The server connection drops | Mid-answer the turn stops with "Se perdió la conexión…"; the teacher falls asleep until the page reconnects (it retries on its own). |

The apology is one more sentence of the answer (with `"kind": "apology"`), so it
is spoken, captioned and paced like the others; the error event that follows
carries `"apologized": true`. Limits: `MAX_QUESTIONS_PER_HOUR`, at most 8
sentences per answer (the stream is cut after that), recordings up to 2 MB and
`MAX_RECORDING_SECONDS`, and `MAX_TOKENS_PER_ANSWER` (thinking included: a high
`CLAUDE_EFFORT` spends part of it before the first word).

## The teacher

A round character made of primitives (a turned body with a flat base, a sphere
for the head, eyes, brows and mouth) dressed as a teacher: a jacket with lapels
and two buttons over a shirt and tie, a pencil in the breast pocket, trousers,
shoe tips, and round hands with a thumb. The clothes are thin layers that follow
the body's outline, so they breathe and turn with it. It stands on the floor, with the diagram
0.95 m to its left at reading height (1.4 m). Both live in one group whose
origin is the teacher's feet, so the headset only has to place that point.

What it does all the time:
- breathes (the body swells a little, about every 4 s) and blinks every 2 to 6 s,
  sometimes twice;
- looks at you: the head turns up to about 55 degrees, and past 30 degrees to a
  side the body turns too, so it faces you wherever you walk;
- when a diagram step appears, glances at it and points with the arm on that
  side for about a second, stretching the index finger.

What it shows, by app state:

| App state | Teacher | Above its head |
|---|---|---|
| connecting, offline | asleep: eyes closed, head down, slow breathing | nothing |
| ready | idle | nothing |
| listening (button held) | head tilted, brows up | red ring, pulsing |
| thinking | looks up and to a side | three orbiting dots |
| explaining | mouth follows the voice, small nods | soft glow that follows the voice |

Lip sync: an AnalyserNode sits right before the speakers, and every frame the
loudness (RMS) of what is playing drives the mouth. The level is measured against
the recent peak, so quiet and loud voices both open it fully, and it is smoothed
with a 40 ms attack and a 120 ms release so the mouth closes between syllables.
Without speech (`TTS_PROVIDER=none`, or no click yet) a made-up rhythm of five
or six syllables a second moves the mouth instead.

In development, `window.immersiveTeacher` holds the stage, the teacher, the
diagram and the lesson group, to try things from the browser console (for
example `immersiveTeacher.teacher.setState("thinking")`).

### The answer format

Claude answers with one item per line, each starting with a marker:

    TITLE: La fotosíntesis
    SAY: La fotosíntesis es la forma en que las plantas fabrican su propio alimento.
    DRAW: {"nodes":[{"id":"planta","label":"Planta","icon":"🌱","shape":"capsule","color":"#3A9D23"}]}
    SAY: Todo empieza cuando la luz del sol llega a las hojas.
    DRAW: {"nodes":[{"id":"sol","label":"Luz solar","icon":"☀️","shape":"sphere","color":"#F5B700"}],"edges":[{"from":"sol","to":"planta","label":"ilumina"}]}

- The server assigns the `step` of a DRAW line: it is the number of the last SAY line
  before it. Claude never counts.
- Each DRAW line is validated on its own (`server/src/protocol/diagram.js`):
  - Broken JSON loses that line only.
  - Ids are normalized (`"Luz solar"` becomes `luz_solar`), and duplicates are dropped.
  - Labels are cut at 28 characters.
  - An unknown `shape` becomes `box`, and an invalid `color` takes one from a palette.
  - `icon` is optional and must be exactly one emoji (`🍎`, `🧑‍🔬`, a flag);
    anything else is dropped and the node keeps its shape.
  - Edges must point to nodes that already appeared.
  - At most 12 nodes and 16 edges.
  - `hook`, the question a node leaves open, is cut at 90 characters, and only
    the first two in an answer are kept.
- Lines without a marker are still spoken (split into sentences), so a reply that
  ignores the format is heard without a diagram.
- A line cut by `MAX_TOKENS_PER_ANSWER` is dropped. Past 8 sentences the stream is
  cut, to stop paying for tokens.

The final diagram, sent in the `done` event, follows this shape:

    {"title": "...", "nodes": [{"id", "label", "icon"?, "shape", "color", "step", "hook"?}], "edges": [{"from", "to", "label", "step"}]}

A node with an `icon` is drawn as a medallion: a coin in the node's color with
the emoji on both faces, swaying gently so it never turns edge-on. Claude is
asked to pick an emoji that shows the thing itself and to leave it out for
abstract ideas, which keep their primitive shape. The emoji come from the
system's color emoji font (Noto Color Emoji on the Quest and on most Linux
desktops).

### The layout

The browser computes it (`client/src/diagram/layout.js`):

- A graph with a cycle of 3 or more nodes is drawn as a circle, clockwise from the
  top. Every other node hangs outside, next to its neighbour.
- Anything else flows left to right in columns (longest path), in the style of a
  Sugiyama layout:
  - an arrow that skips columns gets a lane in each column it crosses and is
    drawn as a curve through them, so it goes around the nodes in between;
  - the order inside each column comes from barycenter sweeps and swaps of
    neighbours that count the exact crossings, started from three orders (as
    revealed, reversed, depth first), keeping the best;
  - then each column slides toward what it connects to, so arrows run straight.
- Longer than five columns, a plain chain folds into rows like a snake, and any
  other graph flows top to bottom instead.
- Arrows both ways between two nodes curve to opposite sides.
- Groups with no arrow between them are laid out apart and placed side by side
  when they fit, otherwise one under the other; nodes with no arrow yet share a row.
- A rare very tall result is squeezed vertically (to 1.3 m, at most by a quarter).
- The layout is recomputed at every step; nodes and arrows glide to their new place.

On 300 random diagrams of 5 to 12 nodes, against the first version: arrows over
a node went from 521 to 0, crossings from 541 to 239, and fully clean diagrams
from 32 to 164. The tests check the gravity diagram that showed the problem.

### WebSocket messages

| Direction | Message |
|---|---|
| browser -> server | `ask_text {turn, text, language, odoo?}`, `ask_audio {turn, mime, language, odoo?}` followed by one binary message (the recording), `ask_node {turn, from, node, language, odoo?}` (go deeper into node `node` of the diagram of turn `from`; `error {code: "node_gone"}` when it is no longer kept), `cancel {turn}`; `odoo: true` asks Odoo AI first |
| browser -> server (sources) | `source_file {id, name, mime, language}` followed by one binary message (the file), `source_url {id, url, language}`, `source_remove {id}` |
| server -> browser | `hello {llm, stt, tts, maxQuestionsPerHour, language, sources, odooAi}`, `transcript`, `title`, `sentence {step, text, kind?}` (`kind: "apology"` after a failure), `odoo_answer {text, links}`, `diagram_step {step, nodes, edges}`, `audio_start {step, sampleRate}`, `audio_end {step, ok}`, `warning {code, message}`, `done {diagram, stopReason, timings}`, `error {code, message}` |
| server -> browser (sources) | `source_added {id, source: {kind, origin, name, title, url, tokens}}`, `source_error {id, code, message}` |

Every server message about a question carries the `turn` it belongs to. A new
question cancels the one in progress. Messages about a source carry the `id` the
browser gave it.

Speech travels as binary frames with an 8-byte header, so the samples start
aligned and the browser reads them without copying:

    uint32 LE turn | uint16 LE step | uint16 reserved | int16 LE PCM samples, mono

Only pages from `ALLOWED_ORIGINS` may open the socket. Without that check, any
website could reach `localhost` and spend your keys.

## Latency log

The server prints one line per question, with every stage measured from the moment
the question arrived:

    [turn 2.3] stt=+310ms claude_request=+310ms claude_ttft=+905ms first_sentence=+1340ms tts_first_chunk=+1610ms done=+9400ms | tokens in=1650 out=410 cache_read=1520 | stop=end_turn | model=claude-sonnet-5-5

- `2.3` is the third question of the second page load (the browser numbers its own turns).
- `stt` is when the transcript came back.
- `claude_ttft` is Claude's first token. `first_sentence` is when the first SAY line
  was complete, which is when it goes to speech.
- `tts_first_chunk` is the first audio from ElevenLabs. `done` comes after the last
  sentence's audio.
- `cache_read` shows that the system prompt came from the prompt cache.

The browser console adds what the page sees, from the moment the button is
released (or the question sent): `release->transcript`, `release->first_sentence`,
`release->first_audio` (the number that matters: silence before the voice) and
`release->done`.

If the first sentence is slow, try `CLAUDE_THINKING=off` (Claude Sonnet 5.5 only)
and compare.

## Tests

    npm test

They cover:
- the line parser (any chunking, markdown, missing markers), the diagram
  validation (icons included) and the layout: measured on the drawn routes, no
  arrow crosses another or passes over a node in the gravity, shortcut, hub and
  photosynthesis diagrams; arrows both ways part; unconnected groups sit close;
- whole turns with the fake providers: event order, steps, max_tokens, refusals,
  the sentence cap, cancellation, errors, a recorded question, speech per
  sentence, speech failures;
- the Deepgram (ears and voice) and ElevenLabs adapters against a stand-in for
  `fetch`: the exact request, PCM alignment, and an error code for each failure;
  a refused key, voice or payment stops the rest of the turn's speech requests;
- the speech queue (two at a time, `previous_text`), the binary frames, and the
  browser's audio narrator (strict order, buffering, silent fallback);
- the headset logic without a headset: what each press does in each mode (place,
  talk, grab, floating buttons, A/X, a controller that disappears), floor or desk
  placement facing the viewer, the desk layout's sizes, the grab bar, the side
  menu, and the captions' priority;
- failures: an answer cut mid-way keeps what was said and apologizes, nothing
  heard is said out loud, and the real Claude adapter (official SDK) against a
  local stand-in for the API: a silent stream ends as `llm_timeout`, thinking
  gets more time, a cancel stays a cancel;
- the teacher, without a renderer (three.js builds the scene graph in Node):
  blinking, the mouth only while speaking, the head and body following the
  viewer wherever the teacher was placed, a sign per state, sleep, the glance,
  the pointing arm with its index finger and the shrug's open palms; and the lip
  sync (attack and release, quiet and loud voices, noise, the made-up rhythm);
- the two languages: every text exists in both, on the page and on the server;
  an English question gets the English prompt, transcription, voice, answer and
  apology; the headset menu and captions relabel on a switch;
- sources: the readable text of a documentation page (main part, headings, lists,
  code blocks, tables, entities), Word documents built in the test, the kind of
  each file from its bytes, public and private addresses, downloads from a local
  site (redirects, gzip, 404, size, timeout, a redirect to a private address), the
  limits of the list, `count_tokens` against the API stand-in, and a whole session:
  a file and a page are added, every question carries them first with the cache
  breakpoint on the last, and what cannot be read or does not fit is refused in the
  language of the request;
- Odoo AI: the adapter against a local stand-in of odoo.com's route (the JSON-RPC
  body and history, links filtered and each listed once, the signature kept, every
  failure with its code, the timeout, a cancel that stays a cancel), the turn (the
  answer before Claude's, as a document after the sources, follow-ups, a failure
  answered without it), the session (only questions with `odoo: true`, typed or
  spoken), the headset button, and the markdown shown as plain text;
- going deeper: hooks (cut, two at most) and the seeded node, the question the
  server builds (the first question of the chain, the connections, the open
  question, in each language), Odoo AI's plain question, `node_gone`, the memory
  of 12 diagrams, the hourly limit, the page's chain of parents and explored nodes,
  and a node pressed in the headset;
- the page's turn controller with a fake connection, panel and narrators: a node
  opened again comes back without a message to the server or a word, and
  **Volver a explicar** replays the kept sentences and speech, or paces them as
  text without speech; the headset's button shows only when there is something
  to say again.

## Production build

    npm run build
    npm start

`npm start` serves `client/dist` and the WebSocket on the same port, without Vite.

## Structure

    immersive_teacher/
    |- .env.example                 every variable, with its default
    |- server/src/
    |  |- index.js                  HTTP + Vite middleware (dev) or static files (prod) + /ws
    |  |- config.js                 reads and checks the environment
    |  |- session.js                one per connection: history, turn in progress, cancel
    |  |- turn.js                   one question: [Odoo AI ->] Claude stream -> parser -> events, timings
    |  |- odoo_ai.js                Odoo AI (odoo.com/help's assistant): the call, its history, a fake
    |  |- dive.js                   going deeper into a node: the diagrams kept, the question built
    |  |- history.js                last questions and answers, text only
    |  |- limits.js                 questions per hour
    |  |- timing.js                 per-turn stopwatch
    |  |- llm/claude.js             Claude through the official SDK
    |  |- llm/fake.js               canned answers, no key
    |  |- i18n.js                   the languages, and the server's messages in each
    |  |- llm/system_prompt.js      the teacher prompt and the answer format, per language
    |  |- speech/stt/               deepgram.js, fake.js: recording -> text
    |  |- speech/tts/               elevenlabs.js, deepgram.js, fake.js: sentence -> PCM
    |  |- speech/tts_queue.js       two sentences at a time, previous_text
    |  |- speech/http.js            deadlines and error codes for the providers
    |  |- sources/index.js          the sources of a connection, their limits, reading and counting
    |  |- sources/documents.js      file or page -> document block (PDF, Word, HTML, text)
    |  |- sources/fetch_url.js      downloads one public page: redirects, size, timeout
    |  |- sources/net_guard.js      public addresses only
    |  |- sources/html_text.js      readable text of an HTML page
    |  |- sources/docx_text.js      text of a .docx, without a library
    |  \- protocol/
    |     |- line_parser.js         TITLE / SAY / DRAW lines from the stream
    |     |- diagram.js             validation of each DRAW line
    |     \- audio_frame.js         binary speech frames
    |- client/
    |  |- index.html
    |  \- src/
    |     |- main.js                desktop view
    |     |- i18n.js                Spanish / English: texts, the switch, remembered choice
    |     |- status.js              app state, shared by the panel and the teacher
    |     |- turn_controller.js     holds diagram steps until their sentence starts
    |     |- sources.js             the sources on the browser's side, sent again after a reconnect
    |     |- odoo_mode.js           the Odoo AI switch: offered by the server, remembered choice
    |     |- exploration.js         which diagram came from which node, explored nodes, open questions
    |     |- net/connection.js      WebSocket with reconnection
    |     |- audio/recorder.js      push-to-talk with MediaRecorder
    |     |- audio/audio_frame.js   reads the binary speech frames
    |     |- narration/audio_narrator.js   plays speech in order, announces each sentence
    |     |- narration/timed_narrator.js   paces sentences when there is no speech
    |     |- scene/stage.js         renderer, camera, lights, frame loop
    |     |- scene/lesson.js        teacher + diagram (+ grab bar), floor and desk layouts
    |     |- xr/xr_mode.js          immersive-ar session, rays, hit-test, placing, grabbing
    |     |- xr/interaction.js      what each press does (pure logic)
    |     |- xr/placement.js        floor or desk, facing the viewer (pure logic)
    |     |- xr/captions.js         text inside the headset
    |     |- xr/xr_menu.js          "Mover al profesor", the language, Odoo AI and the suggested questions (sources first)
    |     |- xr/emulator.js         IWER, development only (?emulate)
    |     |- teacher/teacher.js     the character, its animations and state signs
    |     |- teacher/lip_sync.js    voice loudness -> mouth opening
    |     |- diagram/               layout, 3D view (with focus, back and badges), text sprites
    |     |- ui/push_to_talk.js     talk button and space bar
    |     |- ui/sources_panel.js    upload, URL, drop, the list and "Explícamelo"
    |     |- ui/node_picker.js      the mouse on the diagram: hover and click on nodes and "‹ ..."
    |     \- ui/desktop_panel.js    question box, status, Odoo AI switch, conversation
    \- test/                        node:test suites
