# Immersive Teacher

A virtual teacher for Meta Quest 3 mixed reality. You ask a question out loud,
the teacher answers in Spanish and, while it explains, a 3D diagram builds up
next to it, one step per sentence.

The project is built in phases, and each phase is tested before the next one starts:

| Phase | Content | State |
|---|---|---|
| 1 | Backend + desktop view: type a question, read the answer, see the 3D diagram | done |
| 2 | Voice on the PC: push-to-talk, transcription (Deepgram), streamed speech (ElevenLabs) | done |
| 3 | The teacher character: idle animation, lip sync, listening/thinking/speaking states | done |
| 4 | WebXR on the Quest 3: `immersive-ar`, hit-test placement, controllers and hands, emulator | built, to test on the headset |
| 5 | Polish: errors (offline, API down, microphone denied), limits, response times | |

## Requirements

- Node.js 22.23.4 or newer in the 22 line, 24.22.1+ or 26.12.1+. Those are the
  October 2026 security releases (10 CVEs, among them an actively exploited Brotli
  decoder flaw that matters here: the server decompresses the APIs' responses).
  Node 20 and older get no fixes. Tested on 22.23.4 and 26.13.0. `.env` is read
  with Node's own `process.loadEnvFile`, no dotenv.
- An Anthropic API key (or `LLM_PROVIDER=fake`).
- For the voice: a Deepgram key, plus an ElevenLabs key and the ID of a Spanish
  voice, or only the Deepgram key with `TTS_PROVIDER=deepgram` (or
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

The language of the transcription and the voice is `TEACHER_LANGUAGE` (default
`es`). It is not called `LANGUAGE` on purpose: Linux shells already export
`LANGUAGE` for the system locale (for example `en_US:en`), and a variable from
the shell wins over the one in `.env`.

The fakes:
- **LLM:** streams canned answers in the real format, with realistic pauses. A
  question about photosynthesis or plants gets the photosynthesis answer. One
  containing "error" gets an answer with broken diagram lines, to see the speech
  go on while the bad parts of the diagram are dropped. Anything else gets the
  water cycle.
- **STT:** whatever you say, it "hears" the next of those three questions, in turn.
- **TTS:** a hum with the rhythm of speech, as long as reading the sentence aloud.

Every variable is described in [.env.example](.env.example).

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
  It has 17 native Spanish voices, but no equivalent of `previous_text`, so each
  sentence is read on its own.

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
| Choose a new place | A or X (again to cancel) | leave the session and enter again |

- A green ring shows where the teacher will stand; grey means the surface is
  not flat enough (a wall, a slope).
- On the floor the teacher is about 1.45 m tall and the diagram floats at 1.4 m.
  On anything 30 cm or more above the floor (a desk, a coffee table) it becomes a
  small desk teacher (0.35 scale) with the diagram 0.35 m over the surface.
- Captions under the diagram say what to do, what the teacher heard, the
  sentence being said, and any warning: the side panel is not visible there.
- A short vibration confirms each placement, recording and grab.

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

## The teacher

A character made of primitives (a turned body with a flat base, a sphere for
the head, arms, eyes, brows and mouth) standing on the floor, with the diagram
0.95 m to its left at reading height (1.4 m). Both live in one group whose
origin is the teacher's feet, so the headset only has to place that point.

What it does all the time:
- breathes (the body swells a little, about every 4 s) and blinks every 2 to 6 s,
  sometimes twice;
- looks at you: the head turns up to about 55 degrees, and past 30 degrees to a
  side the body turns too, so it faces you wherever you walk;
- when a diagram step appears, glances at it and points with the arm on that
  side for about a second.

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
    DRAW: {"nodes":[{"id":"planta","label":"Planta","shape":"capsule","color":"#3A9D23"}]}
    SAY: Todo empieza cuando la luz del sol llega a las hojas.
    DRAW: {"nodes":[{"id":"sol","label":"Luz solar","shape":"sphere","color":"#F5B700"}],"edges":[{"from":"sol","to":"planta","label":"ilumina"}]}

- The server assigns the `step` of a DRAW line: it is the number of the last SAY line
  before it. Claude never counts.
- Each DRAW line is validated on its own (`server/src/protocol/diagram.js`):
  - Broken JSON loses that line only.
  - Ids are normalized (`"Luz solar"` becomes `luz_solar`), and duplicates are dropped.
  - Labels are cut at 28 characters.
  - An unknown `shape` becomes `box`, and an invalid `color` takes one from a palette.
  - Edges must point to nodes that already appeared.
  - At most 12 nodes and 16 edges.
- Lines without a marker are still spoken (split into sentences), so a reply that
  ignores the format is heard without a diagram.
- A line cut by `MAX_TOKENS_PER_ANSWER` is dropped. Past 8 sentences the stream is
  cut, to stop paying for tokens.

The final diagram, sent in the `done` event, follows this shape:

    {"title": "...", "nodes": [{"id", "label", "shape", "color", "step"}], "edges": [{"from", "to", "label", "step"}]}

### The layout

The browser computes it (`client/src/diagram/layout.js`):

- A graph with a cycle of 3 or more nodes is drawn as a circle, clockwise from the
  top. Every other node hangs outside, next to its neighbour.
- Anything else flows left to right in layers, ordered by barycenter. A chain longer
  than 4 layers folds into rows like a snake.
- The layout is recomputed at every step, and existing nodes glide to their new place.

### WebSocket messages

| Direction | Message |
|---|---|
| browser -> server | `ask_text {turn, text}`, `ask_audio {turn, mime}` followed by one binary message (the recording), `cancel {turn}` |
| server -> browser | `hello`, `transcript`, `title`, `sentence {step, text}`, `diagram_step {step, nodes, edges}`, `audio_start {step, sampleRate}`, `audio_end {step, ok}`, `warning {code, message}`, `done {diagram, stopReason, timings}`, `error {code, message}` |

Every server message carries the `turn` it belongs to. A new question cancels the
one in progress.

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
  validation and the layout;
- whole turns with the fake providers: event order, steps, max_tokens, refusals,
  the sentence cap, cancellation, errors, a recorded question, speech per
  sentence, speech failures;
- the Deepgram (ears and voice) and ElevenLabs adapters against a stand-in for
  `fetch`: the exact request, PCM alignment, and an error code for each failure;
  a refused key, voice or payment stops the rest of the turn's speech requests;
- the speech queue (two at a time, `previous_text`), the binary frames, and the
  browser's audio narrator (strict order, buffering, silent fallback);
- the headset logic without a headset: what each press does in each mode (place,
  talk, grab, A/X, a controller that disappears), floor or desk placement facing
  the viewer, the desk layout's sizes, the grab bar, and the captions' priority;
- the teacher, without a renderer (three.js builds the scene graph in Node):
  blinking, the mouth only while speaking, the head and body following the
  viewer wherever the teacher was placed, a sign per state, sleep, the glance
  and the pointing arm; and the lip sync (attack and release, quiet and loud
  voices, noise, the made-up rhythm).

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
    |  |- turn.js                   one question: Claude stream -> parser -> events, timings
    |  |- history.js                last questions and answers, text only
    |  |- limits.js                 questions per hour
    |  |- timing.js                 per-turn stopwatch
    |  |- llm/claude.js             Claude through the official SDK
    |  |- llm/fake.js               canned answers, no key
    |  |- llm/system_prompt.js      the teacher prompt and the answer format
    |  |- speech/stt/               deepgram.js, fake.js: recording -> text
    |  |- speech/tts/               elevenlabs.js, deepgram.js, fake.js: sentence -> PCM
    |  |- speech/tts_queue.js       two sentences at a time, previous_text
    |  |- speech/http.js            deadlines and error codes for the providers
    |  \- protocol/
    |     |- line_parser.js         TITLE / SAY / DRAW lines from the stream
    |     |- diagram.js             validation of each DRAW line
    |     \- audio_frame.js         binary speech frames
    |- client/
    |  |- index.html
    |  \- src/
    |     |- main.js                desktop view
    |     |- status.js              app state, shared by the panel and the teacher
    |     |- turn_controller.js     holds diagram steps until their sentence starts
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
    |     |- xr/emulator.js         IWER, development only (?emulate)
    |     |- teacher/teacher.js     the character, its animations and state signs
    |     |- teacher/lip_sync.js    voice loudness -> mouth opening
    |     |- diagram/               layout, 3D view, text sprites
    |     |- ui/push_to_talk.js     talk button and space bar
    |     \- ui/desktop_panel.js    question box, status, conversation
    \- test/                        node:test suites
