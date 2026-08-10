/** @odoo-module **/
/** Tiny WebAudio SFX kit — no assets to ship. */
let ctx = null;

function audio() {
    if (!ctx) {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctx.state === "suspended") {
        ctx.resume();
    }
    return ctx;
}

export const sound = {
    enabled: true,
    tone(freq, dur, type = "sine", gain = 0.18, slide = 0) {
        if (!this.enabled) {
            return;
        }
        const c = audio();
        const osc = c.createOscillator();
        const amp = c.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, c.currentTime);
        if (slide) {
            osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), c.currentTime + dur);
        }
        amp.gain.setValueAtTime(gain, c.currentTime);
        amp.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
        osc.connect(amp).connect(c.destination);
        osc.start();
        osc.stop(c.currentTime + dur);
    },
    noise(dur, gain = 0.2, lowpass = 1400) {
        if (!this.enabled) {
            return;
        }
        const c = audio();
        const n = Math.floor(c.sampleRate * dur);
        const buffer = c.createBuffer(1, n, c.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < n; i++) {
            data[i] = (Math.random() * 2 - 1) * (1 - i / n);
        }
        const src = c.createBufferSource();
        src.buffer = buffer;
        const filter = c.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = lowpass;
        const amp = c.createGain();
        amp.gain.value = gain;
        src.connect(filter).connect(amp).connect(c.destination);
        src.start();
    },
    miss() {
        this.noise(0.35, 0.16, 900);
        this.tone(320, 0.18, "sine", 0.05, -180);
    },
    hit() {
        this.noise(0.5, 0.34, 500);
        this.tone(90, 0.45, "sawtooth", 0.18, -55);
    },
    sunk() {
        this.noise(0.8, 0.3, 380);
        [140, 105, 70].forEach((f, i) => setTimeout(() => this.tone(f, 0.5, "triangle", 0.16, -20), i * 130));
    },
    place() {
        this.tone(420, 0.07, "square", 0.06);
    },
    win() {
        [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, 0.3, "triangle", 0.14), i * 110));
    },
    lose() {
        [392, 330, 262, 196].forEach((f, i) => setTimeout(() => this.tone(f, 0.35, "triangle", 0.13), i * 130));
    },
};
