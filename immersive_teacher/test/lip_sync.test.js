import assert from "node:assert/strict";
import { test } from "node:test";

import { LipSync, syntheticSpeechLevel } from "../client/src/teacher/lip_sync.js";

const FRAME = 1 / 60;

/** Feeds `levelAt(t)` for `seconds` and returns every mouth value. */
function run(lipSync, seconds, levelAt) {
    const values = [];
    for (let t = 0; t < seconds; t += FRAME) {
        values.push(lipSync.update(levelAt(t), FRAME));
    }
    return values;
}

/** A voice-like level: five syllables a second with a gap between them, at `loudness`. */
function syllables(loudness) {
    return (t) => loudness * Math.max(0, Math.sin(2 * Math.PI * 5 * t));
}

test("the mouth opens faster than it closes", () => {
    const lipSync = new LipSync();
    const opened = lipSync.update(0.2, 0.04);
    assert.ok(Math.abs(opened - (1 - Math.exp(-1))) < 0.01, `opened ${opened}`);

    lipSync.value = 1;
    const closed = lipSync.update(0, 0.04);
    // In the same 40 ms it closes less than half as much as it opened.
    assert.ok(closed > 0.7, `closed to ${closed}`);
    assert.ok(Math.abs(lipSync.update(0, 0.08) - Math.exp(-1)) < 0.01);
});

test("a quiet voice opens the mouth as wide as a loud one", () => {
    const widest = [];
    for (const loudness of [0.06, 0.4]) {
        const late = run(new LipSync(), 2, syllables(loudness)).slice(60);
        widest.push(Math.max(...late));
        assert.ok(Math.max(...late) > 0.8, `loudness ${loudness}: max ${Math.max(...late)}`);
        // It visibly closes between syllables, not just trembles.
        assert.ok(Math.max(...late) - Math.min(...late) > 0.45, `loudness ${loudness}: min ${Math.min(...late)}`);
    }
    assert.ok(Math.abs(widest[0] - widest[1]) < 0.05, `quiet ${widest[0]} vs loud ${widest[1]}`);
});

test("silence and faint noise keep the mouth shut", () => {
    const lipSync = new LipSync();
    run(lipSync, 1, syllables(0.2));
    const silence = run(lipSync, 0.8, () => 0);
    assert.ok(silence.at(-1) < 0.01);
    const noise = run(lipSync, 3, (t) => 0.004 * (1 + Math.sin(t * 40)));
    assert.ok(Math.max(...noise.slice(30)) < 0.1, `noise opened it to ${Math.max(...noise.slice(30))}`);
});

test("the made-up speech level stays in range and keeps a syllable rhythm", () => {
    let openings = 0;
    let open = false;
    for (let t = 0; t < 2; t += FRAME) {
        const level = syntheticSpeechLevel(t);
        assert.ok(level >= 0 && level <= 1, `level ${level} at ${t}`);
        if (!open && level > 0.5) {
            openings += 1;
        }
        open = level > 0.5;
    }
    assert.ok(openings >= 8 && openings <= 16, `${openings} openings in 2 s`);
});
