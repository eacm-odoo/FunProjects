/**
 * The teacher's languages, and everything the server says in each of them:
 * the errors the browser shows, the warnings when the voice fails, the
 * apologies the teacher says out loud, the sentence for a refused question,
 * why a source could not be added and the question for a tapped node.
 *
 * The browser sends the language with every question, so one page can switch
 * between them while the server keeps running. Both languages must define the
 * same keys (a test checks it).
 */

export const LANGUAGES = Object.freeze(["es", "en"]);

export function isLanguage(value) {
    return LANGUAGES.includes(value);
}

/** Replaces each {name} in `template` with values[name]. */
/** How deep the teacher explains: "normal" adds nothing to the question. */
export const LEVELS = Object.freeze(["kid", "normal", "expert"]);

export function isLevel(value) {
    return LEVELS.includes(value);
}

export function format(template, values = {}) {
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
}

export const MESSAGES = Object.freeze({
    es: Object.freeze({
        /** Errors that end the turn, as the browser shows them. */
        errors: Object.freeze({
            llm_auth: "La llave de Claude no es válida. Revisa ANTHROPIC_API_KEY en el servidor.",
            llm_rate_limited: "Claude está recibiendo demasiadas peticiones. Espera un momento y vuelve a preguntar.",
            llm_bad_request: "Claude rechazó la petición. Revisa CLAUDE_MODEL y el log del servidor.",
            llm_unavailable: "Claude no está disponible ahora mismo. Intenta de nuevo en un rato.",
            llm_network: "El servidor no logra conectarse con Claude. Revisa su conexión a internet.",
            llm_timeout: "Claude dejó de responder durante 10 segundos. Prueba otra vez en un momento.",
            llm_failed: "Algo falló al pedir la respuesta. El detalle está en el log del servidor.",
            stt_auth: "Deepgram rechazó la llave. Revisa DEEPGRAM_API_KEY en el servidor.",
            stt_payment_required: "Deepgram pide un pago: se acabó el crédito de la cuenta. Escribe la pregunta mientras tanto.",
            stt_rate_limited: "Deepgram está recibiendo demasiadas peticiones. Espera un momento y vuelve a preguntar.",
            stt_bad_request: "Deepgram rechazó la petición. El detalle está en el log del servidor: puede ser la grabación, DEEPGRAM_MODEL o TEACHER_LANGUAGE.",
            stt_unavailable: "Deepgram no está disponible ahora mismo. Escribe la pregunta mientras tanto.",
            stt_network: "El servidor no logra conectarse con Deepgram. Revisa su conexión a internet.",
            stt_timeout: "Deepgram tardó demasiado en transcribir. Prueba otra vez o escribe la pregunta.",
            empty_transcript: "No te escuché. Mantén presionado mientras hablas y suelta al terminar.",
            empty_answer: "No llegó ninguna explicación. Prueba a preguntarlo de otra forma.",
            internal: "Algo falló en el servidor. El detalle está en su log.",
            bad_request: "La pregunta debe tener entre 1 y {max} caracteres.",
            bad_audio: "El navegador mandó un audio en un formato que no reconozco.",
            audio_too_long: "La grabación es demasiado larga. Haz la pregunta más corta.",
            rate_limited: "Llegaste al límite de {max} preguntas por hora. Podrás preguntar de nuevo en {minutes} min.",
            node_gone: "Ese diagrama ya no está en la memoria del profe. Pregúntalo de nuevo.",
            share_off: "Este servidor no guarda exploraciones compartidas (MAX_SHARES=0).",
            share_gone: "Ese link ya no existe: caducó o se borró.",
            share_invalid: "No pude compartirlo: el servidor ya no reconoce esas explicaciones como suyas. Pregúntalas de nuevo y compártelas.",
            share_failed: "No pude guardar el link. El detalle está en el log del servidor.",
        }),
        /**
         * Speech failures do not end the turn: the text goes on and this note
         * explains the silence. {voice} is the speech provider. Neither does
         * an Odoo AI failure: the teacher answers on its own.
         */
        warnings: Object.freeze({
            tts_auth: "{voice} rechazó la llave o la voz: sigo en texto. Revisa la llave y la voz en el .env del servidor.",
            tts_payment_required: "{voice} pide un plan de pago para esta voz, o se acabó el crédito: sigo en texto. El detalle está en el log del servidor.",
            tts_rate_limited: "{voice} está limitando las peticiones o se acabó la cuota: sigo en texto.",
            tts_bad_request: "{voice} rechazó la frase: esa parte sigue en texto. El detalle está en el log del servidor.",
            tts_unavailable: "{voice} no está disponible ahora mismo: sigo en texto.",
            tts_network: "El servidor no logra conectarse con {voice}: sigo en texto.",
            tts_timeout: "{voice} tardó demasiado: esa parte sigue en texto.",
            tts_failed: "La voz falló: esa parte sigue en texto. El detalle está en el log del servidor.",
            odoo_ai_failed: "No pude consultar a Odoo AI: el profe responde con lo que sabe. El detalle está en el log del servidor.",
            odoo_ai_timeout: "Odoo AI tardó demasiado: el profe responde con lo que sabe.",
            odoo_ai_empty: "Odoo AI no devolvió una respuesta: el profe responde con lo que sabe.",
        }),
        /** What the teacher says out loud when a turn fails, before the written error. */
        apologies: Object.freeze({
            heard: "Perdón, no te escuché bien. ¿Me lo repites?",
            think: "Perdón, ahora no logro pensar la respuesta. Pregúntamelo otra vez en un momento.",
            explain: "Mmm, no supe cómo explicarlo. ¿Me lo preguntas de otra forma?",
        }),
        /** Why a document or a page could not be added as a source. */
        sources: Object.freeze({
            source_limit: "Ya hay {max} fuentes. Quita una para agregar otra.",
            source_too_large: "«{name}» pesa más de {max} MB, el máximo por fuente.",
            source_total_too_large: "Con esta, las fuentes pasarían de {max} MB, lo máximo que Claude acepta por pregunta. Quita una.",
            source_too_long: "«{name}» es demasiado largo: unos {tokens} tokens, y quedan {left} de {max}. Prueba con una parte del documento.",
            source_unsupported: "No sé leer «{name}». Sube un PDF, un Word (.docx), texto, Markdown, CSV o HTML.",
            source_empty: "«{name}» no tiene texto que leer.",
            source_empty_page: "«{name}» casi no tiene texto: puede que la página se arme con JavaScript. Prueba con otra página, o guárdala como PDF y súbela.",
            source_unreadable: "Claude no pudo leer «{name}»: puede estar dañado, tener contraseña o pasar de 600 páginas.",
            source_bad_request: "La fuente no llegó bien. Vuelve a intentarlo.",
            source_failed: "No pude cargar la fuente. El detalle está en el log del servidor.",
            url_invalid: "Esa dirección no es válida. Escribe una que empiece con https://.",
            url_blocked: "Esa dirección es de una red privada o de este equipo: solo se pueden cargar páginas públicas.",
            url_not_found: "No encontré el sitio {host}. Revisa la dirección.",
            url_status: "La página respondió con el error {status}. Revisa la dirección o prueba con otra.",
            url_timeout: "La página tardó demasiado en responder. Prueba otra vez.",
            url_failed: "No pude descargar la página ({detail}).",
        }),
        /**
         * The question for a node the person tapped (see dive.js): for Claude,
         * the node in its diagram and the question the chain started from;
         * for Odoo AI, a plain question with that same starting point.
         */
        dive: Object.freeze({
            prompt: "Profundiza en «{label}» (id {id}), un nodo de tu diagrama «{title}».\nLa pregunta inicial fue: «{root}».",
            links: "En ese diagrama: {links}.",
            hook: "La duda que dejaste abierta: «{hook}».",
            odoo: "Sobre «{root}»: cuéntame más de «{label}».",
            odooHook: "Sobre «{root}»: {hook}",
        }),
        /**
         * The note added after the question for a level other than "normal"
         * (see LEVELS): it goes in the message, not in the system prompt, so
         * the cached prompt is the same for every level.
         */
        levels: Object.freeze({
            kid: "(Nota de nivel: explícalo para un niño de 10 años, con palabras sencillas y comparaciones con cosas de todos los días, sin términos técnicos.)",
            expert: "(Nota de nivel: explícalo para alguien que ya domina el tema, con los términos técnicos precisos, los mecanismos y los matices, sin repetir lo básico.)",
        }),
        /** Said when Claude declines the question and no fallback model answered it. */
        refusal: "Prefiero no responder esa pregunta. ¿Te explico otro tema?",
        voice: "La voz",
        /** The card of a shared link (see share_page.js); {title} is the explanation's. */
        preview: Object.freeze({
            site: "Profesor inmersivo",
            title: "{title} - Profesor inmersivo",
            description: "Una explicación con un diagrama en 3D. Ábrela para escucharla y seguir explorando.",
        }),
    }),
    en: Object.freeze({
        errors: Object.freeze({
            llm_auth: "The Claude key is not valid. Check ANTHROPIC_API_KEY on the server.",
            llm_rate_limited: "Claude is getting too many requests. Wait a moment and ask again.",
            llm_bad_request: "Claude refused the request. Check CLAUDE_MODEL and the server log.",
            llm_unavailable: "Claude is not available right now. Try again in a while.",
            llm_network: "The server cannot reach Claude. Check its internet connection.",
            llm_timeout: "Claude stopped answering for 10 seconds. Try again in a moment.",
            llm_failed: "Something failed while asking for the answer. The details are in the server log.",
            stt_auth: "Deepgram refused the key. Check DEEPGRAM_API_KEY on the server.",
            stt_payment_required: "Deepgram asks for a payment: the account ran out of credit. Type your question meanwhile.",
            stt_rate_limited: "Deepgram is getting too many requests. Wait a moment and ask again.",
            stt_bad_request: "Deepgram refused the request. The details are in the server log: it may be the recording, DEEPGRAM_MODEL or TEACHER_LANGUAGE.",
            stt_unavailable: "Deepgram is not available right now. Type your question meanwhile.",
            stt_network: "The server cannot reach Deepgram. Check its internet connection.",
            stt_timeout: "Deepgram took too long to transcribe. Try again or type your question.",
            empty_transcript: "I did not hear you. Hold while you talk and release when you are done.",
            empty_answer: "No explanation came back. Try asking it another way.",
            internal: "Something failed on the server. The details are in its log.",
            bad_request: "The question must be between 1 and {max} characters long.",
            bad_audio: "The browser sent audio in a format I do not recognize.",
            audio_too_long: "The recording is too long. Make the question shorter.",
            rate_limited: "You reached the limit of {max} questions per hour. You can ask again in {minutes} min.",
            node_gone: "The teacher no longer has that diagram in memory. Ask it again.",
            share_off: "This server does not keep shared explorations (MAX_SHARES=0).",
            share_gone: "That link no longer exists: it expired or was deleted.",
            share_invalid: "I could not share it: the server no longer knows those explanations as its own. Ask them again and share them.",
            share_failed: "I could not save the link. The details are in the server log.",
        }),
        warnings: Object.freeze({
            tts_auth: "{voice} refused the key or the voice: going on in text. Check the key and the voice in the server's .env.",
            tts_payment_required: "{voice} needs a paid plan for this voice, or the credit ran out: going on in text. The details are in the server log.",
            tts_rate_limited: "{voice} is limiting requests or the quota ran out: going on in text.",
            tts_bad_request: "{voice} refused the sentence: that part stays in text. The details are in the server log.",
            tts_unavailable: "{voice} is not available right now: going on in text.",
            tts_network: "The server cannot reach {voice}: going on in text.",
            tts_timeout: "{voice} took too long: that part stays in text.",
            tts_failed: "The voice failed: that part stays in text. The details are in the server log.",
            odoo_ai_failed: "I could not reach Odoo AI: the teacher answers from what it knows. The details are in the server log.",
            odoo_ai_timeout: "Odoo AI took too long: the teacher answers from what it knows.",
            odoo_ai_empty: "Odoo AI did not send an answer: the teacher answers from what it knows.",
        }),
        apologies: Object.freeze({
            heard: "Sorry, I did not hear you well. Could you say it again?",
            think: "Sorry, I cannot work out the answer right now. Ask me again in a moment.",
            explain: "Hmm, I did not know how to explain it. Could you ask it another way?",
        }),
        sources: Object.freeze({
            source_limit: "There are already {max} sources. Remove one to add another.",
            source_too_large: "“{name}” is larger than {max} MB, the most for one source.",
            source_total_too_large: "With this one, the sources would pass {max} MB, the most Claude takes per question. Remove one.",
            source_too_long: "“{name}” is too long: about {tokens} tokens, and {left} of {max} are left. Try with a part of the document.",
            source_unsupported: "I cannot read “{name}”. Upload a PDF, a Word file (.docx), text, Markdown, CSV or HTML.",
            source_empty: "“{name}” has no text to read.",
            source_empty_page: "“{name}” has almost no text: the page may be built with JavaScript. Try another page, or save it as a PDF and upload it.",
            source_unreadable: "Claude could not read “{name}”: it may be damaged, have a password or pass 600 pages.",
            source_bad_request: "The source did not arrive well. Try again.",
            source_failed: "I could not load the source. The details are in the server log.",
            url_invalid: "That address is not valid. Type one that starts with https://.",
            url_blocked: "That address belongs to a private network or to this computer: only public pages can be loaded.",
            url_not_found: "I could not find the site {host}. Check the address.",
            url_status: "The page answered with error {status}. Check the address or try another one.",
            url_timeout: "The page took too long to answer. Try again.",
            url_failed: "I could not download the page ({detail}).",
        }),
        dive: Object.freeze({
            prompt: "Go deeper into “{label}” (id {id}), a node of your diagram “{title}”.\nThe first question was: “{root}”.",
            links: "In that diagram: {links}.",
            hook: "The question you left open: “{hook}”.",
            odoo: "About “{root}”: tell me more about “{label}”.",
            odooHook: "About “{root}”: {hook}",
        }),
        levels: Object.freeze({
            kid: "(Level note: explain it for a 10-year-old, with simple words and comparisons to everyday things, and no technical terms.)",
            expert: "(Level note: explain it for someone who already knows the subject well, with the precise technical terms, the mechanisms and the nuances, without repeating the basics.)",
        }),
        refusal: "I would rather not answer that question. Shall I explain something else?",
        voice: "The voice",
        preview: Object.freeze({
            site: "Immersive teacher",
            title: "{title} - Immersive teacher",
            description: "An explanation with a 3D diagram. Open it to hear it and keep exploring.",
        }),
    }),
});
