/**
 * Ask by voice (hold the talk button or the space bar) or by typing, and the
 * teacher answers out loud while the diagram builds up beside it. On a Quest
 * 3, "Entrar en realidad mixta" puts the teacher in the room: aim at the floor
 * or a table to place it, and hold the trigger or pinch to talk.
 *
 * URL options:
 *   ?q=...      asks that question as soon as the server is connected. Without
 *               a click first the browser keeps audio muted, so that answer is
 *               paced as text.
 *   ?emulate    (development only) emulates a Quest 3 with Meta's IWER, to try
 *               the headset mode in a desktop browser.
 */

import "./styles.css";

import { PushToTalkRecorder, microphoneErrorMessage } from "./audio/recorder.js";
import { DiagramView } from "./diagram/diagram_view.js";
import { AudioNarrator } from "./narration/audio_narrator.js";
import { TimedNarrator } from "./narration/timed_narrator.js";
import { Connection } from "./net/connection.js";
import { Lesson } from "./scene/lesson.js";
import { Stage } from "./scene/stage.js";
import { Status } from "./status.js";
import { syntheticSpeechLevel } from "./teacher/lip_sync.js";
import { Teacher } from "./teacher/teacher.js";
import { TurnController } from "./turn_controller.js";
import { DesktopPanel } from "./ui/desktop_panel.js";
import { bindPushToTalk } from "./ui/push_to_talk.js";
import { XrCaptions } from "./xr/captions.js";
import { XrMode } from "./xr/xr_mode.js";

/** Shorter presses are taken as accidental taps. */
const MIN_RECORDING_MS = 350;

/** What the teacher does for each state of the app. */
const TEACHER_STATE = {
    connecting: "asleep",
    offline: "asleep",
    listening: "listening",
    thinking: "thinking",
    explaining: "speaking",
};

/** Desktop view: the teacher a little left of center, so teacher and diagram share the view. */
const DESKTOP_SPOT = Object.freeze({ x: -0.5, y: 0, z: 0 });

/**
 * One object that forwards every call to each panel that has that method:
 * the side panel on the desktop and the captions in the headset hear the
 * same things.
 */
function combinePanels(...panels) {
    return new Proxy({}, {
        get: (_, name) => (...args) => {
            for (const panel of panels) {
                panel[name]?.(...args);
            }
        },
    });
}

const params = new URLSearchParams(window.location.search);
let emulator = null;
if (import.meta.env.DEV && params.has("emulate")) {
    const { installEmulator } = await import("./xr/emulator.js");
    emulator = await installEmulator();
}

const stage = new Stage(document.getElementById("stage"));
const teacher = new Teacher();
const diagram = new DiagramView({ onReveal: (point) => teacher.glanceAt(point) });
const lesson = new Lesson(teacher, diagram);
stage.add(lesson.group);

function placeForDesktop() {
    lesson.placeAt(DESKTOP_SPOT, 0, "floor");
    lesson.group.visible = true;
    stage.frame([0.05, 1.0, 0], [0.05, 1.45, 2.9]);
}
placeForDesktop();

const captions = new XrCaptions();
stage.add(captions.group);

const connection = new Connection();
const status = new Status();
const audioNarrator = new AudioNarrator({ onStepStart() {}, onIdle() {} });
const timedNarrator = new TimedNarrator({ onStepStart() {}, onIdle() {} });
let controller = null;
const panel = new DesktopPanel(document.getElementById("panel"), {
    onAsk: (question) => {
        audioNarrator.unlock();
        controller.ask(question);
    },
});
const ui = combinePanels(panel, captions);
controller = new TurnController({ connection, panel: ui, status, diagram, audioNarrator, timedNarrator });
status.subscribe((state) => {
    ui.setStatus(state);
    teacher.setState(TEACHER_STATE[state] ?? "idle");
});

// Any click or key unlocks audio for the rest of the visit.
for (const type of ["pointerdown", "keydown"]) {
    window.addEventListener(type, () => audioNarrator.unlock(), { once: true, capture: true });
}

const canRecord = PushToTalkRecorder.supported;
const recorder = new PushToTalkRecorder({ onLimit: () => stopTalking() });
let recording = false;

async function startTalking() {
    if (!canRecord || !connection.isOpen || recording) {
        return;
    }
    audioNarrator.unlock();
    controller.interrupt();
    recording = true;
    panel.setRecording(true);
    status.set("listening");
    try {
        await recorder.start();
    } catch (error) {
        recording = false;
        panel.setRecording(false);
        status.set("ready");
        ui.showError(null, microphoneErrorMessage(error));
        console.warn("Microphone unavailable:", error);
    }
}

async function stopTalking() {
    if (!recording) {
        return;
    }
    recording = false;
    const releasedAt = performance.now();
    panel.setRecording(false);
    status.set("thinking");
    const clip = await recorder.stop();
    if (!clip || clip.durationMs < MIN_RECORDING_MS) {
        status.set("ready");
        ui.flashHint("Mantén presionado mientras hablas y suelta al terminar.");
        return;
    }
    await controller.askAudio(clip, releasedAt);
}

if (!canRecord) {
    panel.setTalkEnabled(false, "Este navegador no puede grabar audio.");
}

bindPushToTalk({
    button: document.getElementById("talk"),
    onPress: () => startTalking(),
    onRelease: () => stopTalking(),
});

// --- Headset -------------------------------------------------------------

const enterButton = document.getElementById("enter-xr");
const xrHint = document.getElementById("xr-hint");
const xr = new XrMode({
    stage,
    lesson,
    captions,
    onTalkStart: () => startTalking(),
    onTalkEnd: () => stopTalking(),
    onSessionChange: (active) => {
        enterButton.disabled = active;
        if (!active) {
            placeForDesktop();
        }
    },
});

if (await XrMode.isSupported()) {
    enterButton.hidden = false;
    xrHint.textContent = emulator
        ? "Quest 3 emulado: mueve los controles con el panel de IWER."
        : "Te pedirá el micrófono antes de entrar.";
} else {
    xrHint.textContent = "Realidad mixta: abre esta página en el navegador del Quest 3.";
}

enterButton.addEventListener("click", async () => {
    audioNarrator.unlock();
    controller.interrupt();
    // The microphone prompt goes before the session: inside it, it is easy
    // to miss or does not show at all.
    if (canRecord) {
        try {
            await recorder.prepare();
        } catch (error) {
            ui.showError(null, microphoneErrorMessage(error));
        }
    }
    try {
        await xr.enter();
    } catch (error) {
        console.warn("Could not start the immersive session:", error);
        ui.showError(null, `No se pudo entrar en realidad mixta (${error.name ?? "error"}). El detalle está en la consola.`);
    }
});

// --- Every frame -----------------------------------------------------------

let clock = 0;
stage.onUpdate((dt, frame) => {
    clock += dt;
    xr.update(dt, frame);
    // The real voice when there is one; a speech-like rhythm when the answer
    // is paced as text, so the mouth moves either way.
    const voiceLevel = timedNarrator.busy ? syntheticSpeechLevel(clock) : audioNarrator.level();
    teacher.update(dt, { viewer: stage.camera.position, voiceLevel });
    diagram.update(dt);
    lesson.update(dt);
    captions.update(dt);
});

if (import.meta.env.DEV) {
    // To poke at the scene from the browser console (or chrome://inspect on the Quest).
    window.immersiveTeacher = { stage, teacher, diagram, lesson, captions, xr, emulator, status };
}

// --- Server ----------------------------------------------------------------

let pendingQuestion = params.get("q");
connection.onStatus((connectionStatus) => {
    const open = connectionStatus === "open";
    panel.setAskEnabled(open);
    panel.setTalkEnabled(open && canRecord, open ? "" : "Sin conexión con el servidor.");
    if (open) {
        status.set("ready");
        if (pendingQuestion) {
            controller.ask(pendingQuestion);
            pendingQuestion = null;
        }
    } else {
        status.set(connectionStatus === "connecting" ? "connecting" : "offline");
    }
});
connection.on("hello", ({ llm, stt, tts, maxQuestionsPerHour }) => {
    controller.setSpeechEnabled(tts.enabled);
    recorder.maxSeconds = stt.maxSeconds;
    const limit = maxQuestionsPerHour ? `${maxQuestionsPerHour} preguntas por hora` : "sin límite de preguntas";
    const voice = tts.enabled ? `voz: ${tts.provider}` : "sin voz";
    panel.setInfo(`Modelo: ${llm.model} · oído: ${stt.provider} · ${voice} · ${limit}`);
});
connection.connect();
