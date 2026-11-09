/**
 * Ask by voice (hold the talk button or the space bar) or by typing, and the
 * teacher answers out loud while the diagram builds up beside it. On a Quest
 * 3, "Entrar en realidad mixta" puts the teacher in the room: aim at the floor
 * or a table to place it, and hold the trigger or pinch to talk.
 *
 * The ES / EN switch (and a button in the headset menu) changes the language
 * of the page and of the teacher at once; see i18n.js.
 *
 * "Sources" takes documents (upload or drop a file) and public pages (by
 * their address); the teacher answers from them, and "Explain it" asks about
 * one. In the headset, those questions lead the suggested ones.
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
import { LANGUAGES, language, languageChosen, onLanguageChange, setLanguage, t, translatePage } from "./i18n.js";
import { AudioNarrator } from "./narration/audio_narrator.js";
import { TimedNarrator } from "./narration/timed_narrator.js";
import { Connection } from "./net/connection.js";
import { Lesson } from "./scene/lesson.js";
import { Stage } from "./scene/stage.js";
import { Status } from "./status.js";
import { syntheticSpeechLevel } from "./teacher/lip_sync.js";
import { SourceManager } from "./sources.js";
import { Teacher } from "./teacher/teacher.js";
import { TurnController } from "./turn_controller.js";
import { DesktopPanel } from "./ui/desktop_panel.js";
import { bindPushToTalk } from "./ui/push_to_talk.js";
import { SourcesPanel } from "./ui/sources_panel.js";
import { XrCaptions } from "./xr/captions.js";
import { XrMenu } from "./xr/xr_menu.js";
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
/** A source's name in a question is cut here, so the question stays short to read and to say. */
const MAX_NAME_IN_QUESTION = 80;

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

translatePage(document);

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
    onLanguage: (next) => setLanguage(next),
});
panel.applyLanguage();
const ui = combinePanels(panel, captions);
controller = new TurnController({
    connection,
    panel: ui,
    status,
    diagram,
    audioNarrator,
    timedNarrator,
    onTrouble: () => teacher.react("confused"),
});
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
        if (xr.active) {
            xr.showSuggestions();
            captions.flash(t("xr.noMicrophone"));
        }
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
        ui.flashHint(t("talk.tooShort"));
        return;
    }
    await controller.askAudio(clip, releasedAt);
}

/** The talk button works with a microphone API and a server to send to. */
function refreshTalkButton() {
    const reason = !canRecord ? t("talk.unsupported") : (connection.isOpen ? "" : t("talk.offline"));
    panel.setTalkEnabled(canRecord && connection.isOpen, reason);
}
refreshTalkButton();

bindPushToTalk({
    button: document.getElementById("talk"),
    onPress: () => startTalking(),
    onRelease: () => stopTalking(),
});

// --- Headset -------------------------------------------------------------

const enterButton = document.getElementById("enter-xr");
const xrHint = document.getElementById("xr-hint");
const menu = new XrMenu();
lesson.side.add(menu.group);
const xr = new XrMode({
    stage,
    lesson,
    captions,
    menu,
    onTalkStart: () => startTalking(),
    onTalkEnd: () => stopTalking(),
    onAsk: (question) => {
        if (connection.isOpen) {
            controller.ask(question);
        }
    },
    onSwitchLanguage: () => setLanguage(LANGUAGES.find((other) => other !== language())),
    onSessionChange: (active) => {
        enterButton.disabled = active;
        if (!active) {
            placeForDesktop();
        }
    },
});

const xrSupported = await XrMode.isSupported();
enterButton.hidden = !xrSupported;
function refreshXrHint() {
    if (!xrSupported) {
        xrHint.textContent = t("xr.hint.unsupported");
    } else {
        xrHint.textContent = t(emulator ? "xr.hint.emulated" : "xr.hint.microphone");
    }
}
refreshXrHint();

enterButton.addEventListener("click", async () => {
    audioNarrator.unlock();
    controller.interrupt();
    // The microphone prompt goes before the session: inside it, it is easy
    // to miss or does not show at all.
    let microphone = canRecord;
    if (canRecord) {
        try {
            await recorder.prepare();
        } catch (error) {
            microphone = false;
            ui.showError(null, microphoneErrorMessage(error));
        }
    }
    try {
        await xr.enter();
        if (!microphone) {
            xr.showSuggestions();
            captions.flash(t("xr.noMicrophone"), 10);
        }
    } catch (error) {
        console.warn("Could not start the immersive session:", error);
        ui.showError(null, t("xr.enterFailed", { error: error.name ?? "error" }));
    }
});

// --- Sources ---------------------------------------------------------------

const sources = new SourceManager(connection);

function explainQuestion(entry) {
    const name = entry.title.length > MAX_NAME_IN_QUESTION ? `${entry.title.slice(0, MAX_NAME_IN_QUESTION - 1)}…` : entry.title;
    return t("sources.explainQuestion", { name });
}

const sourcesPanel = new SourcesPanel(document.getElementById("sources"), {
    sources,
    onExplain: (entry) => {
        audioNarrator.unlock();
        controller.ask(explainQuestion(entry));
    },
});
sourcesPanel.acceptDrops(document.getElementById("app"));

function refreshMenuSources() {
    menu.setExtraQuestions(sources.ready.map(explainQuestion));
}
sources.onChange(refreshMenuSources);

// --- Every frame -----------------------------------------------------------

let clock = 0;
stage.onUpdate((dt, frame) => {
    clock += dt;
    xr.update(dt, frame);
    // The real voice when there is one; a speech-like rhythm when the answer
    // is paced as text or a sentence lost its voice, so the mouth moves anyway.
    const silent = timedNarrator.busy || audioNarrator.speakingSilently();
    const voiceLevel = silent ? syntheticSpeechLevel(clock) : audioNarrator.level();
    teacher.update(dt, { viewer: stage.camera.position, voiceLevel });
    diagram.update(dt);
    lesson.update(dt);
    captions.update(dt);
});

if (import.meta.env.DEV) {
    // To poke at the scene from the browser console (or chrome://inspect on the Quest).
    window.immersiveTeacher = { stage, teacher, diagram, lesson, captions, menu, xr, emulator, status, sources };
}

// --- Server ----------------------------------------------------------------

let pendingQuestion = params.get("q");
let hello = null;

/** The line under the panel: model, ears, voice and limit, from the server's hello. */
function refreshInfo() {
    if (!hello) {
        return;
    }
    const { llm, stt, tts, maxQuestionsPerHour } = hello;
    panel.setInfo(t("info.line", {
        model: llm.model,
        stt: stt.provider,
        voice: tts.enabled ? t("info.voice", { provider: tts.provider }) : t("info.noVoice"),
        limit: maxQuestionsPerHour ? t("info.limit", { count: maxQuestionsPerHour }) : t("info.unlimited"),
    }));
}

// The next question goes in the new language; what is on screen stays as it was said.
onLanguageChange(() => {
    translatePage(document);
    panel.applyLanguage();
    captions.relabel();
    menu.relabel();
    refreshMenuSources();
    sourcesPanel.applyLanguage();
    refreshTalkButton();
    refreshXrHint();
    refreshInfo();
});

connection.onStatus((connectionStatus) => {
    const open = connectionStatus === "open";
    panel.setAskEnabled(open);
    sourcesPanel.setOnline(open);
    refreshTalkButton();
    if (open) {
        status.set("ready");
    } else {
        controller.connectionLost();
        status.set(connectionStatus === "connecting" ? "connecting" : "offline");
    }
});
connection.on("hello", (message) => {
    hello = message;
    controller.setSpeechEnabled(message.tts.enabled);
    recorder.maxSeconds = message.stt.maxSeconds;
    // Until the user picks one, the page follows the server's TEACHER_LANGUAGE.
    if (!languageChosen() && message.language) {
        setLanguage(message.language, { remember: false });
    }
    refreshInfo();
    // A new connection is a new session on the server: it gets the sources again.
    sources.setLimits(message.sources ?? { maxCount: 0 });
    sources.resend();
    // After the hello, so a ?q= question goes in the page's language.
    if (pendingQuestion) {
        controller.ask(pendingQuestion);
        pendingQuestion = null;
    }
});
connection.connect();
