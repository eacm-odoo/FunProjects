/**
 * How fast the teacher speaks (TTS_SPEED), as each provider takes it.
 *
 * The provider speeds the voice up itself, so it keeps its pitch and sounds
 * natural. Each one has its own range, and the value is clamped to it. At 1
 * nothing is sent: the request is exactly the one without the setting.
 *
 * Should a provider refuse the setting (a 400 that goes away without it), the
 * sentence is asked again without it and the voice keeps its normal pace from
 * then on: a voice a little slow beats no voice.
 */

/** Ranges from the providers' docs: ElevenLabs voice_settings.speed, Deepgram Aura-2 `speed`. */
export const SPEED_RANGES = Object.freeze({
    elevenlabs: Object.freeze([0.7, 1.2]),
    deepgram: Object.freeze([0.7, 1.5]),
});

/**
 * @param {"elevenlabs"|"deepgram"} provider
 * @param {number} speed TTS_SPEED
 * @returns {number|null} the value to send, or null to send nothing (normal pace)
 */
export function speedFor(provider, speed) {
    const [min, max] = SPEED_RANGES[provider];
    const value = Math.round(Math.min(max, Math.max(min, speed)) * 100) / 100;
    return value === 1 ? null : value;
}

/**
 * Runs `request(speed)`, and once more at normal pace when the provider
 * refuses the speed. `state.refused` remembers it for the next sentences.
 *
 * @param {{refused: boolean}} state one per adapter
 * @param {string} label the provider's name, for the log
 * @param {number|null} speed from speedFor()
 * @param {(speed: number|null) => Promise<T>} request
 * @returns {Promise<T>}
 * @template T
 */
export async function withSpeed(state, label, speed, request) {
    const sent = state.refused ? null : speed;
    try {
        return await request(sent);
    } catch (error) {
        if (sent === null || error.code !== "tts_bad_request") {
            throw error;
        }
        // If it fails again without the speed, the speed was not the problem: that error goes up.
        const result = await request(null);
        state.refused = true;
        console.warn(`${label} refused TTS_SPEED=${sent} (${error.message}); the voice speaks at normal pace from now on`);
        return result;
    }
}
