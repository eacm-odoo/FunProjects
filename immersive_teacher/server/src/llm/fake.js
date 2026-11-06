/**
 * Fake LLM: streams canned answers in the real format, with realistic pauses.
 *
 * It needs no key and no network, so the whole app can run and be tested for
 * free. The question picks the answer:
 * - mentions "fotosíntesis" or "planta": photosynthesis
 * - mentions "roto", "error" or "malformado": an answer with broken DRAW lines,
 *   to see the speech go on while the bad parts of the diagram are dropped
 * - anything else: the water cycle
 */

import { sleep } from "../sleep.js";

const ANSWERS = {
    photosynthesis: `TITLE: La fotosíntesis
SAY: La fotosíntesis es la forma en que las plantas fabrican su propio alimento.
DRAW: {"nodes":[{"id":"planta","label":"Planta","shape":"capsule","color":"#3A9D23"}]}
SAY: Todo empieza cuando la luz del sol llega a las hojas.
DRAW: {"nodes":[{"id":"sol","label":"Luz solar","shape":"sphere","color":"#F5B700"}],"edges":[{"from":"sol","to":"planta","label":"ilumina"}]}
SAY: Por las raíces entra agua, y por las hojas entra dióxido de carbono del aire.
DRAW: {"nodes":[{"id":"agua","label":"Agua","shape":"cylinder","color":"#2E86DE"},{"id":"co2","label":"Dióxido de carbono","shape":"sphere","color":"#9AA5B1"}],"edges":[{"from":"agua","to":"planta","label":"entra"},{"from":"co2","to":"planta","label":"entra"}]}
SAY: Con la energía de la luz, la planta convierte el agua y el dióxido de carbono en glucosa.
DRAW: {"nodes":[{"id":"glucosa","label":"Glucosa","shape":"box","color":"#E67E22"}],"edges":[{"from":"planta","to":"glucosa","label":"produce"}]}
SAY: Y como regalo, libera al aire el oxígeno que respiramos.
DRAW: {"nodes":[{"id":"oxigeno","label":"Oxígeno","shape":"sphere","color":"#48C9B0"}],"edges":[{"from":"planta","to":"oxigeno","label":"libera"}]}
`,
    waterCycle: `TITLE: El ciclo del agua
SAY: El agua de la Tierra viaja sin parar entre el mar, el aire y la tierra.
DRAW: {"nodes":[{"id":"mar","label":"Mar","shape":"cylinder","color":"#2E86DE"}]}
SAY: El sol calienta el mar y parte del agua se evapora como vapor invisible.
DRAW: {"nodes":[{"id":"sol","label":"Sol","shape":"sphere","color":"#F5B700"},{"id":"vapor","label":"Vapor","shape":"sphere","color":"#C9D6E3"}],"edges":[{"from":"sol","to":"mar","label":"calienta"},{"from":"mar","to":"vapor","label":"evapora"}]}
SAY: Al subir, el vapor se enfría y se junta en gotitas que forman nubes.
DRAW: {"nodes":[{"id":"nube","label":"Nubes","shape":"capsule","color":"#8C99A6"}],"edges":[{"from":"vapor","to":"nube","label":"condensa"}]}
SAY: Cuando las gotas pesan demasiado, caen como lluvia o nieve.
DRAW: {"nodes":[{"id":"lluvia","label":"Lluvia","shape":"cone","color":"#4C9BE8"}],"edges":[{"from":"nube","to":"lluvia","label":"precipita"}]}
SAY: Esa agua corre por ríos y vuelve al mar, y el ciclo empieza otra vez.
DRAW: {"nodes":[{"id":"rio","label":"Ríos","shape":"box","color":"#2BB3A3"}],"edges":[{"from":"lluvia","to":"rio","label":"escurre"},{"from":"rio","to":"mar","label":"regresa"}]}
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
};

function pickAnswer(question) {
    const text = question.toLowerCase();
    if (/(roto|error|malformad)/.test(text)) {
        return ANSWERS.broken;
    }
    if (/(fotos[ií]ntesis|planta)/.test(text)) {
        return ANSWERS.photosynthesis;
    }
    return ANSWERS.waterCycle;
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

        async *stream({ messages, signal }) {
            const question = messages.at(-1)?.content ?? "";
            const text = answer ?? pickAnswer(typeof question === "string" ? question : "");
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
