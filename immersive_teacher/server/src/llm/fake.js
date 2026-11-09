/**
 * Fake LLM: streams canned answers in the real format, with realistic pauses.
 *
 * It needs no key and no network, so the whole app can run and be tested for
 * free. The question picks the answer, in the language of the question:
 * - mentions photosynthesis or a plant: photosynthesis
 * - mentions "error", "roto" / "broken" or "malformado" / "malformed": an
 *   answer with broken DRAW lines, to see the speech go on while the bad
 *   parts of the diagram are dropped
 * - anything else: the water cycle, or, when the user added sources, a
 *   short answer about the first one (its title and how it starts)
 *
 * countTokens() estimates instead of counting: four characters a token.
 */

import { sleep } from "../sleep.js";

const ANSWERS = {
    es: {
        photosynthesis: `TITLE: La fotosíntesis
SAY: La fotosíntesis es la forma en que las plantas fabrican su propio alimento.
DRAW: {"nodes":[{"id":"planta","label":"Planta","icon":"🌱","shape":"capsule","color":"#3A9D23"}]}
SAY: Todo empieza cuando la luz del sol llega a las hojas.
DRAW: {"nodes":[{"id":"sol","label":"Luz solar","icon":"☀️","shape":"sphere","color":"#F5B700"}],"edges":[{"from":"sol","to":"planta","label":"ilumina"}]}
SAY: Por las raíces entra agua, y por las hojas entra dióxido de carbono del aire.
DRAW: {"nodes":[{"id":"agua","label":"Agua","icon":"💧","shape":"cylinder","color":"#2E86DE"},{"id":"co2","label":"Dióxido de carbono","icon":"💨","shape":"sphere","color":"#9AA5B1"}],"edges":[{"from":"agua","to":"planta","label":"entra"},{"from":"co2","to":"planta","label":"entra"}]}
SAY: Con la energía de la luz, la planta convierte el agua y el dióxido de carbono en glucosa.
DRAW: {"nodes":[{"id":"glucosa","label":"Glucosa","icon":"🍬","shape":"box","color":"#E67E22"}],"edges":[{"from":"planta","to":"glucosa","label":"produce"}]}
SAY: Y como regalo, libera al aire el oxígeno que respiramos.
DRAW: {"nodes":[{"id":"oxigeno","label":"Oxígeno","shape":"sphere","color":"#48C9B0"}],"edges":[{"from":"planta","to":"oxigeno","label":"libera"}]}
`,
        waterCycle: `TITLE: El ciclo del agua
SAY: El agua de la Tierra viaja sin parar entre el mar, el aire y la tierra.
DRAW: {"nodes":[{"id":"mar","label":"Mar","icon":"🌊","shape":"cylinder","color":"#2E86DE"}]}
SAY: El sol calienta el mar y parte del agua se evapora como vapor invisible.
DRAW: {"nodes":[{"id":"sol","label":"Sol","icon":"☀️","shape":"sphere","color":"#F5B700"},{"id":"vapor","label":"Vapor","icon":"♨️","shape":"sphere","color":"#C9D6E3"}],"edges":[{"from":"sol","to":"mar","label":"calienta"},{"from":"mar","to":"vapor","label":"evapora"}]}
SAY: Al subir, el vapor se enfría y se junta en gotitas que forman nubes.
DRAW: {"nodes":[{"id":"nube","label":"Nubes","icon":"☁️","shape":"capsule","color":"#8C99A6"}],"edges":[{"from":"vapor","to":"nube","label":"condensa"}]}
SAY: Cuando las gotas pesan demasiado, caen como lluvia o nieve.
DRAW: {"nodes":[{"id":"lluvia","label":"Lluvia","icon":"🌧️","shape":"cone","color":"#4C9BE8"}],"edges":[{"from":"nube","to":"lluvia","label":"precipita"}]}
SAY: Esa agua corre por ríos y vuelve al mar, y el ciclo empieza otra vez.
DRAW: {"nodes":[{"id":"rio","label":"Ríos","icon":"🏞️","shape":"box","color":"#2BB3A3"}],"edges":[{"from":"lluvia","to":"rio","label":"escurre"},{"from":"rio","to":"mar","label":"regresa"}]}
`,
        broken: `TITLE: Respuesta con errores
SAY: Esta respuesta trae a propósito algunas líneas de diagrama mal formadas.
DRAW: {"nodes":[{"id":"inicio","label":"Inicio","shape":"box","color":"#4C9BE8"}]}
SAY: La siguiente línea de diagrama no es JSON válido, así que se descarta entera.
DRAW: {"nodes":[{"id":"roto","label":"Roto"
SAY: Aquí una conexión apunta a un nodo que no existe, y solo ella se pierde.
DRAW: {"nodes":[{"id":"medio","label":"Medio","shape":"hexagono","color":"verde"}],"edges":[{"from":"inicio","to":"medio"},{"from":"medio","to":"fantasma"}]}
SAY: Aun así, la explicación hablada sigue completa hasta el final.
DRAW: {"nodes":[{"id":"fin","label":"Fin","shape":"sphere","color":"#3A9D23"}],"edges":[{"from":"medio","to":"fin","label":"termina"}]}
`,
    },
    en: {
        photosynthesis: `TITLE: Photosynthesis
SAY: Photosynthesis is how plants make their own food.
DRAW: {"nodes":[{"id":"plant","label":"Plant","icon":"🌱","shape":"capsule","color":"#3A9D23"}]}
SAY: It all starts when sunlight reaches the leaves.
DRAW: {"nodes":[{"id":"sun","label":"Sunlight","icon":"☀️","shape":"sphere","color":"#F5B700"}],"edges":[{"from":"sun","to":"plant","label":"lights"}]}
SAY: Water comes in through the roots, and carbon dioxide from the air comes in through the leaves.
DRAW: {"nodes":[{"id":"water","label":"Water","icon":"💧","shape":"cylinder","color":"#2E86DE"},{"id":"co2","label":"Carbon dioxide","icon":"💨","shape":"sphere","color":"#9AA5B1"}],"edges":[{"from":"water","to":"plant","label":"enters"},{"from":"co2","to":"plant","label":"enters"}]}
SAY: With the energy of the light, the plant turns the water and the carbon dioxide into glucose.
DRAW: {"nodes":[{"id":"glucose","label":"Glucose","icon":"🍬","shape":"box","color":"#E67E22"}],"edges":[{"from":"plant","to":"glucose","label":"makes"}]}
SAY: And as a gift, it releases into the air the oxygen we breathe.
DRAW: {"nodes":[{"id":"oxygen","label":"Oxygen","shape":"sphere","color":"#48C9B0"}],"edges":[{"from":"plant","to":"oxygen","label":"releases"}]}
`,
        waterCycle: `TITLE: The water cycle
SAY: The water on Earth keeps traveling between the sea, the air and the land.
DRAW: {"nodes":[{"id":"sea","label":"Sea","icon":"🌊","shape":"cylinder","color":"#2E86DE"}]}
SAY: The sun warms the sea, and some of the water evaporates as invisible vapor.
DRAW: {"nodes":[{"id":"sun","label":"Sun","icon":"☀️","shape":"sphere","color":"#F5B700"},{"id":"vapor","label":"Vapor","icon":"♨️","shape":"sphere","color":"#C9D6E3"}],"edges":[{"from":"sun","to":"sea","label":"warms"},{"from":"sea","to":"vapor","label":"evaporates"}]}
SAY: As it rises, the vapor cools down and gathers into droplets that form clouds.
DRAW: {"nodes":[{"id":"cloud","label":"Clouds","icon":"☁️","shape":"capsule","color":"#8C99A6"}],"edges":[{"from":"vapor","to":"cloud","label":"condenses"}]}
SAY: When the drops get too heavy, they fall as rain or snow.
DRAW: {"nodes":[{"id":"rain","label":"Rain","icon":"🌧️","shape":"cone","color":"#4C9BE8"}],"edges":[{"from":"cloud","to":"rain","label":"falls"}]}
SAY: That water runs down rivers back to the sea, and the cycle starts again.
DRAW: {"nodes":[{"id":"river","label":"Rivers","icon":"🏞️","shape":"box","color":"#2BB3A3"}],"edges":[{"from":"rain","to":"river","label":"runs off"},{"from":"river","to":"sea","label":"returns"}]}
`,
        broken: `TITLE: An answer with errors
SAY: This answer brings a few broken diagram lines on purpose.
DRAW: {"nodes":[{"id":"start","label":"Start","shape":"box","color":"#4C9BE8"}]}
SAY: The next diagram line is not valid JSON, so it is dropped whole.
DRAW: {"nodes":[{"id":"broken","label":"Broken"
SAY: Here a connection points to a node that does not exist, and only that connection is lost.
DRAW: {"nodes":[{"id":"middle","label":"Middle","shape":"hexagon","color":"green"}],"edges":[{"from":"start","to":"middle"},{"from":"middle","to":"ghost"}]}
SAY: Even so, the spoken explanation goes on to the end.
DRAW: {"nodes":[{"id":"end","label":"End","shape":"sphere","color":"#3A9D23"}],"edges":[{"from":"middle","to":"end","label":"ends"}]}
`,
    },
};

const SOURCE_TEXTS = {
    es: {
        read: (title) => `Leí «${title}» y te cuento de qué trata.`,
        opening: (words, start) => `Tiene unas ${words} palabras y empieza así: ${start}.`,
        pdf: "Es un PDF: el modo de prueba no lo abre, pero Claude sí lo lee completo.",
        fake: "Esta es una respuesta de prueba; con la llave de Claude te explicaría el contenido de verdad.",
        start: "Inicio",
        teacher: "Profe",
        verbs: ["empieza", "explica"],
    },
    en: {
        read: (title) => `I read “${title}” and I will tell you what it is about.`,
        opening: (words, start) => `It has about ${words} words and starts like this: ${start}.`,
        pdf: "It is a PDF: the test mode does not open it, but Claude reads all of it.",
        fake: "This is a test answer; with Claude's key I would explain what it really says.",
        start: "Start",
        teacher: "Prof",
        verbs: ["starts", "explains"],
    },
};

function oneLine(text) {
    return String(text).replace(/\s+/g, " ").trim();
}

/** A canned answer about a document block, to try sources without a key. */
function sourceAnswer(document, language) {
    const texts = SOURCE_TEXTS[language] ?? SOURCE_TEXTS.es;
    const title = oneLine(document.title ?? "?");
    const label = title.length > 24 ? `${title.slice(0, 23)}…` : title;
    const body = document.source?.type === "text" ? document.source.data : "";
    const words = body.split(/\s+/).filter(Boolean);
    const start = oneLine(body.replace(/[#*`|>_-]+/g, " ")).split(" ").slice(0, 10).join(" ");
    const node = (id, nodeLabel, icon, shape, color) => ({ id, label: nodeLabel, icon, shape, color });
    return [
        `TITLE: ${title.split(" ").slice(0, 5).join(" ")}`,
        `SAY: ${texts.read(title)}`,
        `DRAW: ${JSON.stringify({ nodes: [node("source", label, "📄", "box", "#714B67")] })}`,
        `SAY: ${body ? texts.opening(words.length, start) : texts.pdf}`,
        `DRAW: ${JSON.stringify({
            nodes: [node("start", texts.start, "🔎", "sphere", "#017E84")],
            edges: [{ from: "source", to: "start", label: texts.verbs[0] }],
        })}`,
        `SAY: ${texts.fake}`,
        `DRAW: ${JSON.stringify({
            nodes: [node("teacher", texts.teacher, "🧑‍🏫", "capsule", "#F5B700")],
            edges: [{ from: "start", to: "teacher", label: texts.verbs[1] }],
        })}`,
        "",
    ].join("\n");
}

/** The text of a message: a plain string, or its text blocks. */
function textOf(message) {
    const content = message?.content ?? "";
    return typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function documentsIn(messages) {
    const content = messages[0]?.content;
    return Array.isArray(content) ? content.filter((block) => block.type === "document") : [];
}

function pickAnswer(question, language, documents = []) {
    const answers = ANSWERS[language] ?? ANSWERS.es;
    const text = question.toLowerCase();
    if (/(roto|broken|error|malformad|malformed)/.test(text)) {
        return answers.broken;
    }
    if (/(fotos[ií]ntesis|planta|photosynthesis|plant)/.test(text)) {
        return answers.photosynthesis;
    }
    return documents.length ? sourceAnswer(documents[0], language) : answers.waterCycle;
}

/**
 * @param {{firstTokenMs?: number, chunkMs?: number, chunkSize?: number, answer?: string}} options
 *   timings default to roughly what Claude does; tests pass 0 to run instantly,
 *   and `answer` to stream a fixed text.
 */
export function createFakeLlm({ firstTokenMs = 350, chunkMs = 25, chunkSize = 6, answer } = {}) {
    return {
        name: "fake",
        model: "fake",

        async countTokens({ messages }) {
            let characters = 0;
            for (const message of messages) {
                for (const block of typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content) {
                    if (block.type === "text") {
                        characters += block.text.length;
                    } else if (block.source?.type === "text") {
                        characters += block.source.data.length;
                    } else if (block.source?.type === "base64") {
                        characters += block.source.data.length / 10; // a PDF: a rough guess from its size
                    }
                }
            }
            return Math.ceil(characters / 4);
        },

        async *stream({ messages, language = "es", signal }) {
            const text = answer ?? pickAnswer(textOf(messages.at(-1)), language, documentsIn(messages));
            await sleep(firstTokenMs, signal);
            for (let index = 0; index < text.length; index += chunkSize) {
                yield { type: "text", text: text.slice(index, index + chunkSize) };
                if (chunkMs) {
                    await sleep(chunkMs, signal);
                }
            }
            yield {
                type: "end",
                stopReason: "end_turn",
                usage: { input_tokens: 0, output_tokens: Math.round(text.length / 4) },
                model: "fake",
            };
        },
    };
}
