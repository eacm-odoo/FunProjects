/**
 * Turns the loudness of the teacher's voice into how open its mouth is.
 *
 * The input is the RMS of what the speakers play right now (AudioNarrator's
 * level()), or a made-up level while there is no audio (TimedNarrator). Each
 * voice and each provider has its own loudness, so the level is measured
 * against the recent peak instead of a fixed scale: a quiet voice opens the
 * mouth as much as a loud one. The result follows the voice quickly when it
 * gets louder (attack) and lets go a little slower (release), the way a real
 * mouth closes between syllables.
 */

function clamp01(value) {
    return Math.min(1, Math.max(0, value));
}

export class LipSync {
    /**
     * @param {object} [options]
     * @param {number} [options.attack] seconds to open about two thirds of the way
     * @param {number} [options.release] seconds to close about two thirds of the way
     * @param {number} [options.gate] share of the peak below which the mouth stays shut
     * @param {number} [options.full] share of the peak from which it is wide open
     * @param {number} [options.peakSeconds] how fast the remembered peak fades
     * @param {number} [options.minPeak] keeps background noise from opening the mouth
     */
    constructor({ attack = 0.04, release = 0.12, gate = 0.12, full = 0.8, peakSeconds = 1.5, minPeak = 0.05 } = {}) {
        this.attack = attack;
        this.release = release;
        this.gate = gate;
        this.full = full;
        this.peakSeconds = peakSeconds;
        this.minPeak = minPeak;
        this.reset();
    }

    reset() {
        this.peak = this.minPeak;
        this.value = 0;
    }

    /**
     * @param {number} level loudness now (RMS, or 0..1)
     * @param {number} dt seconds since the last call
     * @returns {number} mouth opening, 0 (shut) to 1 (wide open)
     */
    update(level, dt) {
        if (dt <= 0) {
            return this.value;
        }
        this.peak = Math.max(level, this.peak * Math.exp(-dt / this.peakSeconds), this.minPeak);
        const target = clamp01((level / this.peak - this.gate) / (this.full - this.gate));
        const tau = target > this.value ? this.attack : this.release;
        this.value += (target - this.value) * (1 - Math.exp(-dt / tau));
        return this.value;
    }
}

/**
 * A speech-like level for when the answer is shown without audio: five or six
 * syllables a second with a short silence between them, an uneven rhythm, and
 * louder and quieter stretches, so the mouth does not flap like a metronome.
 *
 * @param {number} time seconds
 * @returns {number} 0..1
 */
export function syntheticSpeechLevel(time) {
    const phase = time * 5.5 + 0.6 * Math.sin(time * 1.9);
    const syllable = Math.max(0, Math.sin(2 * Math.PI * phase)) ** 0.8;
    const phrase = 0.65 + 0.35 * Math.sin(time * 0.83 + 1.1);
    return syllable * phrase;
}
