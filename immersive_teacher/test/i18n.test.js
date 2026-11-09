/**
 * The page's two languages: complete, switchable, and remembered only when
 * the user picks one (Node has no localStorage, which must not break it).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { LANGUAGES, language, languageChosen, list, onLanguageChange, setLanguage, t, textKeys } from "../client/src/i18n.js";

test("both languages have every text", () => {
    assert.deepEqual(LANGUAGES, ["es", "en"]);
    assert.deepEqual(textKeys("en").sort(), textKeys("es").sort());
    for (const lang of LANGUAGES) {
        setLanguage(lang, { remember: false });
        for (const key of textKeys(lang)) {
            assert.notEqual(t(key), key, `${lang}: ${key}`);
        }
        assert.equal(list("suggestions").length, 4);
    }
    setLanguage("es", { remember: false });
});

test("a switch tells the listeners once, and fills in the values", () => {
    const seen = [];
    const stop = onLanguageChange((lang) => seen.push(lang));
    assert.equal(language(), "es");
    assert.equal(languageChosen(), false);
    setLanguage("en", { remember: false });
    setLanguage("en", { remember: false });
    setLanguage("fr");
    assert.equal(language(), "en");
    assert.equal(languageChosen(), false, "a default from the server is not the user's choice");
    assert.equal(t("info.limit", { count: 30 }), "30 questions per hour");
    setLanguage("es");
    assert.equal(languageChosen(), true);
    stop();
    setLanguage("en", { remember: false });
    assert.deepEqual(seen, ["en", "es"]);
    setLanguage("es", { remember: false });
    assert.equal(t("info.limit", { count: 30 }), "30 preguntas por hora");
});
