/**
 * The page's language: Spanish or English, for the interface and for the
 * teacher at once. The choice is remembered in this browser; until there is
 * one, the page follows the server's TEACHER_LANGUAGE (from its hello).
 *
 *     t(key, values)          the text for `key` in the current language
 *     setLanguage("en")       switches, remembers it, and tells the listeners
 *     onLanguageChange(fn)    fn(language) after every switch
 *     translatePage(root)     fills [data-i18n], [data-i18n-placeholder], [data-i18n-title]...
 *
 * Every question sent to the server carries the language, so the server's
 * messages and the teacher's answers come back in it.
 */

export const LANGUAGES = Object.freeze(["es", "en"]);
const STORAGE_KEY = "immersive-teacher.language";

const TEXTS = Object.freeze({
    es: {
        "app.title": "Profesor inmersivo",
        "language.label": "Idioma",
        "language.switchTo": "English",
        "status.connecting": "Conectando…",
        "status.ready": "Listo",
        "status.listening": "Escuchando…",
        "status.thinking": "Pensando…",
        "status.explaining": "Explicando",
        "status.offline": "Sin conexión",
        "status.error": "Error",
        "xr.enter": "Entrar en realidad mixta",
        "xr.hint.emulated": "Quest 3 emulado: mueve los controles con el panel de IWER.",
        "xr.hint.microphone": "Te pedirá el micrófono antes de entrar.",
        "xr.hint.unsupported": "Realidad mixta: abre esta página en el navegador del Quest 3.",
        "xr.enterFailed": "No se pudo entrar en realidad mixta ({error}). El detalle está en la consola.",
        "xr.noMicrophone": "Sin micrófono: elige una de las preguntas de la izquierda con el rayo.",
        "talk.hold": "Mantén para hablar",
        "talk.release": "Suelta para enviar",
        "talk.hint": "Mantén el botón o la barra espaciadora mientras hablas, o escribe la pregunta.",
        "talk.tooShort": "Mantén presionado mientras hablas y suelta al terminar.",
        "talk.unsupported": "Este navegador no puede grabar audio.",
        "talk.offline": "Sin conexión con el servidor.",
        "ask.label": "Pregunta",
        "ask.placeholder": "Por ejemplo: ¿cómo hacen las plantas la fotosíntesis?",
        "ask.submit": "Preguntar",
        "info.line": "Modelo: {model} · oído: {stt} · {voice} · {limit}",
        "info.voice": "voz: {provider}",
        "info.noVoice": "sin voz",
        "info.limit": "{count} preguntas por hora",
        "info.unlimited": "sin límite de preguntas",
        "turn.transcribing": "Transcribiendo tu pregunta…",
        "turn.nothingHeard": "(no se entendió nada)",
        "turn.noDiagram": "Esta respuesta llegó sin diagrama.",
        "turn.offline": "No hay conexión con el servidor. Reintentando…",
        "turn.connectionLost": "Se perdió la conexión con el servidor a mitad de la respuesta.",
        "mic.denied": "El navegador no tiene permiso para usar el micrófono. Actívalo en el candado de la barra de direcciones y vuelve a intentar.",
        "mic.notFound": "No encontré ningún micrófono. Conecta uno o escribe la pregunta.",
        "mic.busy": "Otra aplicación está usando el micrófono. Ciérrala y vuelve a intentar.",
        "mic.failed": "No pude abrir el micrófono. Escribe la pregunta mientras tanto.",
        "captions.connecting": "Conectando con el servidor…",
        "captions.offline": "Sin conexión con el servidor. Reintentando…",
        "captions.listening": "Te escucho… suelta para enviar.",
        "captions.thinking": "Pensando…",
        "captions.thinkingAbout": "«{question}» Pensando…",
        "hint.placing": "Apunta al piso o a una mesa y presiona el gatillo (o junta índice y pulgar) para poner al profesor.",
        "hint.teaching": "Mantén el gatillo o la pinza para preguntar. Apunta a un nodo y presiona para profundizar. La barra bajo el diagrama lo mueve. B o Y: preguntas sugeridas.",
        "menu.move": "Mover al profesor",
        "sources.title": "Fuentes",
        "sources.hint": "Sube un documento o carga una página pública: el profe responde con lo que dicen.",
        "sources.upload": "Subir",
        "sources.uploadTitle": "Subir un documento: PDF, Word, texto, Markdown, CSV o HTML",
        "sources.urlLabel": "Dirección de una página pública",
        "sources.urlPlaceholder": "https://… página de documentación",
        "sources.load": "Cargar",
        "sources.loading": "Leyendo…",
        "sources.remove": "Quitar {name}",
        "sources.explain": "Explícamelo",
        "sources.explainQuestion": "Explícame de qué trata «{name}».",
        "sources.tokens": "≈{tokens} tokens",
        "sources.kind.pdf": "PDF",
        "sources.kind.docx": "Word",
        "sources.kind.html": "Web",
        "sources.kind.text": "Texto",
        "sources.full": "Ya hay {max} fuentes. Quita una para agregar otra.",
        "sources.tooBig": "«{name}» pesa {size} MB y el máximo es {max} MB.",
        "sources.drop": "Suelta el archivo para que el profe lo lea.",
        "sources.offline": "Sin conexión: se cargará al volver la conexión.",
        "odoo.toggle": "Consultar primero a Odoo AI",
        "odoo.title": "Cada pregunta va primero al asistente de soporte de odoo.com/help, y el profe explica su respuesta",
        "odoo.answerTitle": "Respuesta de Odoo AI",
        "odoo.menuOn": "Odoo AI: sí",
        "odoo.menuOff": "Odoo AI: no",
        "explore.question": "Cuéntame más de «{label}»",
        "explore.back": "‹ Volver a «{title}»",
        "explore.hint": "Toca un nodo del diagrama para profundizar, o una de estas dudas:",
        "explore.replay": "Volver a explicar",
        suggestions: [
            "¿Cómo funciona el ciclo del agua?",
            "¿Cómo hacen las plantas la fotosíntesis?",
            "¿Qué es un átomo?",
            "¿Cómo funciona el corazón?",
        ],
    },
    en: {
        "app.title": "Immersive teacher",
        "language.label": "Language",
        "language.switchTo": "Español",
        "status.connecting": "Connecting…",
        "status.ready": "Ready",
        "status.listening": "Listening…",
        "status.thinking": "Thinking…",
        "status.explaining": "Explaining",
        "status.offline": "Offline",
        "status.error": "Error",
        "xr.enter": "Enter mixed reality",
        "xr.hint.emulated": "Emulated Quest 3: move the controllers with the IWER panel.",
        "xr.hint.microphone": "It will ask for the microphone before going in.",
        "xr.hint.unsupported": "Mixed reality: open this page in the Quest 3 browser.",
        "xr.enterFailed": "Could not enter mixed reality ({error}). The details are in the console.",
        "xr.noMicrophone": "No microphone: pick one of the questions on the left with the ray.",
        "talk.hold": "Hold to talk",
        "talk.release": "Release to send",
        "talk.hint": "Hold the button or the space bar while you talk, or type your question.",
        "talk.tooShort": "Hold while you talk and release when you are done.",
        "talk.unsupported": "This browser cannot record audio.",
        "talk.offline": "No connection to the server.",
        "ask.label": "Question",
        "ask.placeholder": "For example: how do plants do photosynthesis?",
        "ask.submit": "Ask",
        "info.line": "Model: {model} · ears: {stt} · {voice} · {limit}",
        "info.voice": "voice: {provider}",
        "info.noVoice": "no voice",
        "info.limit": "{count} questions per hour",
        "info.unlimited": "no question limit",
        "turn.transcribing": "Transcribing your question…",
        "turn.nothingHeard": "(nothing understood)",
        "turn.noDiagram": "This answer came without a diagram.",
        "turn.offline": "No connection to the server. Retrying…",
        "turn.connectionLost": "The connection to the server was lost in the middle of the answer.",
        "mic.denied": "The browser is not allowed to use the microphone. Allow it from the lock in the address bar and try again.",
        "mic.notFound": "I found no microphone. Plug one in or type your question.",
        "mic.busy": "Another app is using the microphone. Close it and try again.",
        "mic.failed": "I could not open the microphone. Type your question meanwhile.",
        "captions.connecting": "Connecting to the server…",
        "captions.offline": "No connection to the server. Retrying…",
        "captions.listening": "I am listening… release to send.",
        "captions.thinking": "Thinking…",
        "captions.thinkingAbout": "“{question}” Thinking…",
        "hint.placing": "Aim at the floor or a table and press the trigger (or pinch index and thumb) to place the teacher.",
        "hint.teaching": "Hold the trigger or pinch to ask. Aim at a node and press to go deeper. The bar under the diagram moves it. B or Y: suggested questions.",
        "menu.move": "Move the teacher",
        "sources.title": "Sources",
        "sources.hint": "Upload a document or load a public page: the teacher answers from what they say.",
        "sources.upload": "Upload",
        "sources.uploadTitle": "Upload a document: PDF, Word, text, Markdown, CSV or HTML",
        "sources.urlLabel": "Address of a public page",
        "sources.urlPlaceholder": "https://… documentation page",
        "sources.load": "Load",
        "sources.loading": "Reading…",
        "sources.remove": "Remove {name}",
        "sources.explain": "Explain it",
        "sources.explainQuestion": "Explain to me what “{name}” is about.",
        "sources.tokens": "≈{tokens} tokens",
        "sources.kind.pdf": "PDF",
        "sources.kind.docx": "Word",
        "sources.kind.html": "Web",
        "sources.kind.text": "Text",
        "sources.full": "There are already {max} sources. Remove one to add another.",
        "sources.tooBig": "“{name}” is {size} MB and the most is {max} MB.",
        "sources.drop": "Drop the file for the teacher to read.",
        "sources.offline": "Offline: it will load when the connection is back.",
        "odoo.toggle": "Check with Odoo AI first",
        "odoo.title": "Each question goes first to the support assistant of odoo.com/help, and the teacher explains its answer",
        "odoo.answerTitle": "Odoo AI's answer",
        "odoo.menuOn": "Odoo AI: on",
        "odoo.menuOff": "Odoo AI: off",
        "explore.question": "Tell me more about “{label}”",
        "explore.back": "‹ Back to “{title}”",
        "explore.hint": "Tap a node of the diagram to go deeper, or one of these questions:",
        "explore.replay": "Explain it again",
        suggestions: [
            "How does the water cycle work?",
            "How do plants do photosynthesis?",
            "What is an atom?",
            "How does the heart work?",
        ],
    },
});

function readStored() {
    try {
        const value = globalThis.window?.localStorage?.getItem(STORAGE_KEY);
        return LANGUAGES.includes(value) ? value : null;
    } catch {
        return null; // storage blocked: the choice just is not remembered
    }
}

let current = readStored() ?? LANGUAGES[0];
let chosen = readStored() !== null;
const listeners = new Set();

/** The current language, "es" or "en". */
export function language() {
    return current;
}

/** Whether the user picked the language (in this visit or an earlier one). */
export function languageChosen() {
    return chosen;
}

/**
 * @param {string} next "es" or "en"
 * @param {{remember?: boolean}} [options] false for a default that is not the user's choice
 */
export function setLanguage(next, { remember = true } = {}) {
    if (!LANGUAGES.includes(next)) {
        return;
    }
    if (remember) {
        chosen = true;
        try {
            globalThis.window?.localStorage?.setItem(STORAGE_KEY, next);
        } catch {
            // Not remembered; the page still switches.
        }
    }
    if (next === current) {
        return;
    }
    current = next;
    for (const listener of listeners) {
        listener(next);
    }
}

/** Calls `listener(language)` after every switch; returns the function that stops it. */
export function onLanguageChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The text for `key` in the current language, with each {name} replaced by values[name]. */
export function t(key, values = {}) {
    const text = TEXTS[current][key] ?? TEXTS[LANGUAGES[0]][key] ?? key;
    return String(text).replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
}

/** A list of texts, such as the suggested questions. */
export function list(key) {
    return [...(TEXTS[current][key] ?? TEXTS[LANGUAGES[0]][key] ?? [])];
}

/** Every key, per language: for the test that checks both are complete. */
export function textKeys(lang) {
    return Object.keys(TEXTS[lang]);
}

/** Fills the static texts of the page, and its lang and title. */
export function translatePage(root = document) {
    root.documentElement.lang = current;
    root.title = t("app.title");
    for (const element of root.querySelectorAll("[data-i18n]")) {
        element.textContent = t(element.dataset.i18n);
    }
    for (const element of root.querySelectorAll("[data-i18n-placeholder]")) {
        element.placeholder = t(element.dataset.i18nPlaceholder);
    }
    for (const element of root.querySelectorAll("[data-i18n-aria-label]")) {
        element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
    }
    for (const element of root.querySelectorAll("[data-i18n-title]")) {
        element.title = t(element.dataset.i18nTitle);
    }
}
