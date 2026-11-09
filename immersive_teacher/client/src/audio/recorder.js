/**
 * Push-to-talk recording with MediaRecorder.
 *
 * The microphone stream is opened on the first press and kept open, so later
 * presses start recording at once (and, in the headset, the permission prompt
 * never shows up inside the immersive session). The browser picks the format;
 * Chrome and the Quest browser give webm/opus, which Deepgram takes as is.
 */

import { t } from "../i18n.js";

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

/** Message for the user when the microphone cannot be opened. */
export function microphoneErrorMessage(error) {
    switch (error?.name) {
        case "NotAllowedError":
        case "SecurityError":
            return t("mic.denied");
        case "NotFoundError":
        case "OverconstrainedError":
            return t("mic.notFound");
        case "NotReadableError":
            return t("mic.busy");
        default:
            return t("mic.failed");
    }
}

export class PushToTalkRecorder {
    /**
     * @param {object} [options]
     * @param {number} [options.maxSeconds] the recording stops on its own after this
     * @param {() => void} [options.onLimit] called when maxSeconds is reached
     */
    constructor({ maxSeconds = 20, onLimit } = {}) {
        this.maxSeconds = maxSeconds;
        this.onLimit = onLimit;
        this.stream = null;
        this.recorder = null;
        this.chunks = [];
        this.startedAt = 0;
        this.limitTimer = null;
        this.starting = null;
        this.stopRequested = false;
    }

    static get supported() {
        return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
    }

    get isRecording() {
        return this.recorder?.state === "recording";
    }

    /**
     * Opens the microphone without recording. The headset calls it before the
     * immersive session starts: a permission prompt inside the session is easy
     * to miss, and on some browsers it cannot show at all.
     */
    async prepare() {
        await this.#openStream();
    }

    async #openStream() {
        if (!this.stream || this.stream.getAudioTracks().every((track) => track.readyState === "ended")) {
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
        }
        return this.stream;
    }

    /**
     * Starts recording. Rejects when the microphone cannot be opened (see
     * microphoneErrorMessage). If stop() is called while the permission prompt
     * is still open, nothing is recorded.
     */
    async start() {
        if (this.isRecording || this.starting) {
            return;
        }
        this.stopRequested = false;
        this.starting = (async () => {
            const stream = await this.#openStream();
            if (this.stopRequested) {
                return;
            }
            const mimeType = MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
            this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
            this.chunks = [];
            this.recorder.addEventListener("dataavailable", (event) => {
                if (event.data.size) {
                    this.chunks.push(event.data);
                }
            });
            // Small timeslices: on release only the last fraction is left to flush.
            this.recorder.start(250);
            this.startedAt = performance.now();
            this.limitTimer = setTimeout(() => this.onLimit?.(), this.maxSeconds * 1000);
        })();
        try {
            await this.starting;
        } finally {
            this.starting = null;
        }
    }

    /**
     * Stops recording.
     * @returns {Promise<{blob: Blob, mime: string, durationMs: number} | null>}
     *   null when nothing was recorded
     */
    async stop() {
        this.stopRequested = true;
        clearTimeout(this.limitTimer);
        if (this.starting) {
            await this.starting.catch(() => {});
        }
        const recorder = this.recorder;
        if (!recorder || recorder.state === "inactive") {
            return null;
        }
        const durationMs = performance.now() - this.startedAt;
        await new Promise((resolve) => {
            recorder.addEventListener("stop", resolve, { once: true });
            recorder.stop();
        });
        this.recorder = null;
        const mime = recorder.mimeType || this.chunks[0]?.type || "audio/webm";
        const blob = new Blob(this.chunks, { type: mime });
        this.chunks = [];
        return blob.size ? { blob, mime, durationMs } : null;
    }
}
