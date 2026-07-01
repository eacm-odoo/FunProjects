/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - motor del juego (canvas 2D + Web Audio sintetizado).
 * Sin dependencias externas: el componente OWL solo instancia esta clase.
 */

export class NeonStrikeEngine {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {Object} callbacks - { onGameOver({score, wave, best}) }
     */
    constructor(canvas, callbacks = {}) {
        this.cv = canvas;
        this.g = canvas.getContext("2d");
        this.cb = callbacks;

        this.state = "start";
        this.muted = false;
        this.AC = null;

        this.W = 680;
        this.H = 540;
        this.frame = 0;
        this.slowMo = 0;

        this.ship = { x: 0, y: 0, tx: 0, ty: 0, inv: 0, shield: 0 };
        this.bullets = [];
        this.ebullets = [];
        this.enemies = [];
        this.parts = [];
        this.pops = [];
        this.pups = [];
        this.stars = [];

        this.score = 0;
        this.best = 0;
        this.lives = 3;
        this.wave = 0;
        this.combo = 1;
        this.comboT = 0;
        this.shake = 0;
        this.fireT = 0;
        this.weapon = "single";
        this.weaponT = 0;
        this.flashT = 0;
        this.waveDelay = 0;
        this.bossAlive = false;

        this._raf = null;
        this._loop = this._loopFn.bind(this);
        this._pd = (e) => this._pointerDown(e);
        this._pm = (e) => this._pointerMove(e);
        this.cv.addEventListener("pointerdown", this._pd);
        this.cv.addEventListener("pointermove", this._pm);
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(this.cv.parentElement);

        this.resize();
        this.initStars();
        this.ship.x = this.ship.tx = this.W / 2;
        this.ship.y = this.ship.ty = this.H - 70;
    }

    /* ------------------------------------------------------------------ */
    /* Ciclo de vida                                                       */
    /* ------------------------------------------------------------------ */

    start() {
        if (!this._raf) {
            this._raf = requestAnimationFrame(this._loop);
        }
    }

    destroy() {
        if (this._raf) {
            cancelAnimationFrame(this._raf);
            this._raf = null;
        }
        this._ro.disconnect();
        this.cv.removeEventListener("pointerdown", this._pd);
        this.cv.removeEventListener("pointermove", this._pm);
        if (this.AC) {
            try {
                this.AC.close();
            } catch (e) {
                /* AudioContext ya cerrado */
            }
        }
    }

    setMuted(muted) {
        this.muted = muted;
        if (!muted) {
            this.audio();
        }
    }

    restartToMenu() {
        this.reset();
        this.state = "start";
    }

    resize() {
        const el = this.cv.parentElement;
        if (!el) {
            return;
        }
        this.W = Math.max(320, el.clientWidth || 680);
        this.H = Math.max(360, el.clientHeight || 540);
        const dpr = window.devicePixelRatio || 1;
        this.cv.width = this.W * dpr;
        this.cv.height = this.H * dpr;
        this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    _loopFn() {
        this.frame++;
        const ts = this.slowMo > 0 ? 0.35 : 1;
        if (this.slowMo > 0) {
            this.slowMo--;
        }
        this.update(ts);
        this.render();
        this._raf = requestAnimationFrame(this._loop);
    }

    /* ------------------------------------------------------------------ */
    /* Audio sintetizado                                                   */
    /* ------------------------------------------------------------------ */

    audio() {
        try {
            if (!this.AC) {
                this.AC = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (this.AC.state === "suspended") {
                this.AC.resume();
            }
        } catch (e) {
            /* navegador sin Web Audio */
        }
    }

    tone(f, dur, type, vol, slide) {
        if (this.muted || !this.AC) {
            return;
        }
        try {
            const o = this.AC.createOscillator();
            const gn = this.AC.createGain();
            const t = this.AC.currentTime;
            o.type = type;
            o.frequency.setValueAtTime(f, t);
            if (slide) {
                o.frequency.exponentialRampToValueAtTime(slide, t + dur);
            }
            gn.gain.setValueAtTime(vol, t);
            gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
            o.connect(gn);
            gn.connect(this.AC.destination);
            o.start(t);
            o.stop(t + dur);
        } catch (e) {
            /* noop */
        }
    }

    noise(dur, vol, freq) {
        if (this.muted || !this.AC) {
            return;
        }
        try {
            const n = Math.floor(this.AC.sampleRate * dur);
            const buf = this.AC.createBuffer(1, n, this.AC.sampleRate);
            const d = buf.getChannelData(0);
            for (let i = 0; i < n; i++) {
                d[i] = (Math.random() * 2 - 1) * (1 - i / n);
            }
            const s = this.AC.createBufferSource();
            s.buffer = buf;
            const f = this.AC.createBiquadFilter();
            f.type = "lowpass";
            f.frequency.value = freq || 1200;
            const gn = this.AC.createGain();
            gn.gain.value = vol;
            s.connect(f);
            f.connect(gn);
            gn.connect(this.AC.destination);
            s.start();
        } catch (e) {
            /* noop */
        }
    }

    sShoot() { this.tone(760, 0.07, "square", 0.04, 320); }
    sBoom() { this.noise(0.32, 0.3, 900); this.tone(130, 0.28, "sawtooth", 0.14, 40); }
    sBigBoom() { this.noise(0.6, 0.4, 600); this.tone(90, 0.5, "sawtooth", 0.2, 30); }
    sHit() { this.noise(0.35, 0.35, 500); this.tone(80, 0.3, "sawtooth", 0.18, 35); }
    sPup() {
        this.tone(523, 0.09, "square", 0.08);
        setTimeout(() => this.tone(659, 0.09, "square", 0.08), 80);
        setTimeout(() => this.tone(880, 0.14, "square", 0.09), 160);
    }
    sWave() { this.tone(220, 0.25, "triangle", 0.1, 440); }
    sTick() { this.tone(1200, 0.03, "square", 0.03); }

    /* ------------------------------------------------------------------ */
    /* Helpers                                                             */
    /* ------------------------------------------------------------------ */

    glow(hex, a) {
        const n = parseInt(hex.slice(1), 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }

    initStars() {
        this.stars = [];
        for (let i = 0; i < 110; i++) {
            this.stars.push({
                x: Math.random() * this.W,
                y: Math.random() * this.H,
                z: Math.random() * 2 + 0.5,
                s: Math.random() * 1.4 + 0.4,
            });
        }
    }

    pop(x, y, txt, color, size, life) {
        this.pops.push({
            x, y, txt, color,
            size: size || 14,
            life: life || 55,
            ml: life || 55,
            vy: -0.6,
        });
    }

    burst(x, y, color, n, pw) {
        for (let i = 0; i < n; i++) {
            const a = Math.random() * 6.2832;
            const v = Math.random() * (pw || 4) + 1;
            this.parts.push({
                x, y,
                vx: Math.cos(a) * v,
                vy: Math.sin(a) * v,
                r: Math.random() * 2.5 + 1,
                c: color,
                life: Math.random() * 30 + 20,
                ml: 50,
            });
        }
    }

    /* ------------------------------------------------------------------ */
    /* Entidades                                                           */
    /* ------------------------------------------------------------------ */

    mkEnemy(type, x, y) {
        if (type === "drone") {
            return { type, x, y, r: 14, hp: 1, mhp: 1, c: "#ff5d8f", t: Math.random() * 6.28, val: 100, flash: 0 };
        }
        if (type === "speedy") {
            return { type, x, y, r: 10, hp: 1, mhp: 1, c: "#ffd166", t: 0, val: 150, flash: 0 };
        }
        if (type === "tank") {
            return { type, x, y, r: 20, hp: 4, mhp: 4, c: "#9b5de5", t: Math.random() * 200, val: 300, flash: 0 };
        }
        const hp = 35 + this.wave * 9;
        return { type: "boss", x, y, r: 44, hp, mhp: hp, c: "#ff4d4d", t: 0, val: 5000, flash: 0 };
    }

    spawnWave() {
        this.wave++;
        this.sWave();
        if (this.wave % 4 === 0) {
            this.enemies.push(this.mkEnemy("boss", this.W / 2, -90));
            this.bossAlive = true;
            this.pop(this.W / 2, this.H / 2 - 50, "¡JEFE!", "#ff6b6b", 36, 90);
            return;
        }
        this.pop(this.W / 2, this.H / 2 - 50, "Oleada " + this.wave, "#8be9ff", 30, 80);
        const n = 4 + this.wave * 2;
        for (let i = 0; i < n; i++) {
            const r = Math.random();
            let type = "drone";
            if (this.wave > 1 && r < 0.28) {
                type = "speedy";
            }
            if (this.wave > 2 && r > 0.8) {
                type = "tank";
            }
            this.enemies.push(
                this.mkEnemy(type, 40 + Math.random() * (this.W - 80), -30 - i * 55 - Math.random() * 40)
            );
        }
    }

    dropPup(x, y) {
        const r = Math.random();
        let t = "T";
        if (r > 0.35) { t = "S"; }
        if (r > 0.62) { t = "B"; }
        if (r > 0.85) { t = "L"; }
        this.pups.push({ x, y, t, vy: 1.1, r: 13, ph: 0 });
    }

    killEnemy(e, i) {
        this.enemies.splice(i, 1);
        this.burst(e.x, e.y, e.c, e.type === "boss" ? 90 : 24, e.type === "boss" ? 8 : 4.5);
        this.burst(e.x, e.y, "#ffffff", e.type === "boss" ? 30 : 8, 3);
        const pts = e.val * this.combo;
        this.score += pts;
        this.pop(e.x, e.y, "+" + pts.toLocaleString(), "#fff", e.type === "boss" ? 24 : 13);
        this.combo = Math.min(this.combo + 1, 15);
        this.comboT = 170;
        this.shake = Math.min(this.shake + (e.type === "boss" ? 22 : 5), 24);
        if (e.type === "boss") {
            this.sBigBoom();
            this.bossAlive = false;
            this.slowMo = 40;
            this.dropPup(e.x - 30, e.y);
            this.dropPup(e.x + 30, e.y);
            this.lives = Math.min(5, this.lives + 1);
            this.pop(e.x, e.y - 40, "¡Vida extra!", "#7bffb0", 16);
        } else {
            this.sBoom();
            if (Math.random() < 0.13) {
                this.dropPup(e.x, e.y);
            }
        }
    }

    bomb() {
        this.flashT = 12;
        this.sBigBoom();
        this.shake = 20;
        for (let i = this.enemies.length - 1; i >= 0; i--) {
            const e = this.enemies[i];
            if (e.type === "boss") {
                e.hp -= 14;
                this.burst(e.x, e.y, "#ffb347", 30, 6);
                if (e.hp <= 0) {
                    this.killEnemy(e, i);
                }
            } else {
                this.killEnemy(e, i);
            }
        }
        this.ebullets = [];
    }

    hurtShip() {
        const sp = this.ship;
        if (sp.inv > 0) {
            return;
        }
        if (sp.shield > 0) {
            sp.shield = 0;
            this.burst(sp.x, sp.y, "#7bffb0", 26, 5);
            this.noise(0.25, 0.2, 2000);
            sp.inv = 50;
            this.pop(sp.x, sp.y - 30, "¡Escudo roto!", "#7bffb0", 14);
            return;
        }
        this.lives--;
        this.sHit();
        this.shake = 18;
        this.slowMo = 28;
        this.burst(sp.x, sp.y, "#5ee1ff", 50, 7);
        this.burst(sp.x, sp.y, "#ff8f5d", 30, 5);
        sp.inv = 110;
        this.combo = 1;
        if (this.lives <= 0) {
            this.state = "over";
            this.best = Math.max(this.best, this.score);
            if (this.cb.onGameOver) {
                this.cb.onGameOver({ score: this.score, wave: this.wave, best: this.best });
            }
        }
    }

    reset() {
        this.score = 0;
        this.lives = 3;
        this.wave = 0;
        this.combo = 1;
        this.comboT = 0;
        this.weapon = "single";
        this.weaponT = 0;
        this.bullets = [];
        this.ebullets = [];
        this.enemies = [];
        this.parts = [];
        this.pops = [];
        this.pups = [];
        this.shake = 0;
        this.slowMo = 0;
        this.flashT = 0;
        this.bossAlive = false;
        this.ship.x = this.ship.tx = this.W / 2;
        this.ship.y = this.ship.ty = this.H - 70;
        this.ship.inv = 90;
        this.ship.shield = 0;
        this.waveDelay = 40;
    }

    /* ------------------------------------------------------------------ */
    /* Update                                                              */
    /* ------------------------------------------------------------------ */

    update(ts) {
        const W = this.W;
        const H = this.H;
        const sp = this.ship;

        for (const s of this.stars) {
            s.y += s.z * (1.2 + this.wave * 0.06) * ts;
            if (s.y > H) {
                s.y = -4;
                s.x = Math.random() * W;
            }
        }

        if (this.state !== "playing") {
            for (let i = this.parts.length - 1; i >= 0; i--) {
                const p = this.parts[i];
                p.x += p.vx * ts;
                p.y += p.vy * ts;
                p.life -= ts;
                if (p.life <= 0) {
                    this.parts.splice(i, 1);
                }
            }
            for (let i = this.pops.length - 1; i >= 0; i--) {
                const p = this.pops[i];
                p.y += p.vy * ts;
                p.life -= ts;
                if (p.life <= 0) {
                    this.pops.splice(i, 1);
                }
            }
            return;
        }

        sp.x += (sp.tx - sp.x) * 0.2 * ts;
        sp.y += (sp.ty - sp.y) * 0.2 * ts;
        sp.x = Math.max(20, Math.min(W - 20, sp.x));
        sp.y = Math.max(70, Math.min(H - 24, sp.y));
        if (sp.inv > 0) {
            sp.inv -= ts;
        }
        if (this.frame % 2 === 0) {
            this.parts.push({
                x: sp.x + (Math.random() - 0.5) * 6,
                y: sp.y + 16,
                vx: (Math.random() - 0.5) * 0.6,
                vy: 2.2,
                r: Math.random() * 2 + 1,
                c: "#3fa9ff",
                life: 16,
                ml: 16,
            });
        }

        this.fireT -= ts;
        if (this.fireT <= 0) {
            this.fireT = this.weapon === "triple" ? 8 : 9;
            this.sShoot();
            this.burst(sp.x, sp.y - 20, "#aef1ff", 3, 1.5);
            if (this.weapon === "triple") {
                this.bullets.push(
                    { x: sp.x, y: sp.y - 16, vx: 0, vy: -11 },
                    { x: sp.x - 8, y: sp.y - 10, vx: -1.8, vy: -10.5 },
                    { x: sp.x + 8, y: sp.y - 10, vx: 1.8, vy: -10.5 }
                );
            } else {
                this.bullets.push({ x: sp.x, y: sp.y - 16, vx: 0, vy: -11 });
            }
        }
        if (this.weaponT > 0) {
            this.weaponT -= ts;
            if (this.weaponT <= 0) {
                this.weapon = "single";
                this.pop(sp.x, sp.y - 30, "Disparo normal", "#8be9ff", 12);
            }
        }
        if (this.comboT > 0) {
            this.comboT -= ts;
            if (this.comboT <= 0) {
                this.combo = 1;
            }
        }

        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const b = this.bullets[i];
            b.x += b.vx * ts;
            b.y += b.vy * ts;
            if (b.y < -20 || b.x < -20 || b.x > W + 20) {
                this.bullets.splice(i, 1);
            }
        }
        for (let i = this.ebullets.length - 1; i >= 0; i--) {
            const b = this.ebullets[i];
            b.x += b.vx * ts;
            b.y += b.vy * ts;
            if (b.y > H + 20 || b.y < -20 || b.x < -20 || b.x > W + 20) {
                this.ebullets.splice(i, 1);
                continue;
            }
            const dx = b.x - sp.x;
            const dy = b.y - sp.y;
            if (dx * dx + dy * dy < 270) {
                this.ebullets.splice(i, 1);
                this.hurtShip();
            }
        }

        for (let i = this.enemies.length - 1; i >= 0; i--) {
            const e = this.enemies[i];
            e.t += ts;
            if (e.type === "drone") {
                e.y += (1.2 + this.wave * 0.05) * ts;
                e.x += Math.sin(e.t * 0.05) * 1.1 * ts;
            } else if (e.type === "speedy") {
                e.y += (3 + this.wave * 0.08) * ts;
                e.x += (sp.x - e.x) * 0.006 * ts;
            } else if (e.type === "tank") {
                e.y += 0.65 * ts;
                if (e.y > 0 && Math.floor(e.t) % 150 === 0) {
                    const dx = sp.x - e.x;
                    const dy = sp.y - e.y;
                    const d = Math.sqrt(dx * dx + dy * dy) || 1;
                    this.ebullets.push({ x: e.x, y: e.y, vx: (dx / d) * 2.6, vy: (dy / d) * 2.6 });
                    this.sTick();
                }
            } else {
                if (e.y < 95) {
                    e.y += 1.4 * ts;
                } else {
                    e.x = W / 2 + Math.sin(e.t * 0.016) * (W * 0.32);
                }
                if (e.y >= 90) {
                    if (Math.floor(e.t) % 85 === 0) {
                        for (let k = 0; k < 9; k++) {
                            const a = (k / 9) * 6.2832 + e.t * 0.01;
                            this.ebullets.push({ x: e.x, y: e.y, vx: Math.cos(a) * 2.3, vy: Math.sin(a) * 2.3 });
                        }
                        this.sTick();
                    }
                    if (Math.floor(e.t) % 55 === 27) {
                        const dx = sp.x - e.x;
                        const dy = sp.y - e.y;
                        const d = Math.sqrt(dx * dx + dy * dy) || 1;
                        for (let k = -1; k <= 1; k++) {
                            this.ebullets.push({ x: e.x, y: e.y, vx: (dx / d) * 3 + k * 0.7, vy: (dy / d) * 3 });
                        }
                        this.sTick();
                    }
                }
            }
            if (e.y > H + 50) {
                this.enemies.splice(i, 1);
                continue;
            }
            const dx = e.x - sp.x;
            const dy = e.y - sp.y;
            const rr = e.r + 13;
            if (dx * dx + dy * dy < rr * rr) {
                this.hurtShip();
                if (e.type !== "boss") {
                    this.killEnemy(e, i);
                }
                continue;
            }
            for (let j = this.bullets.length - 1; j >= 0; j--) {
                const b = this.bullets[j];
                const bx = b.x - e.x;
                const by = b.y - e.y;
                if (bx * bx + by * by < (e.r + 4) * (e.r + 4)) {
                    this.bullets.splice(j, 1);
                    e.hp--;
                    this.burst(b.x, b.y, "#fff", 4, 2);
                    if (e.hp <= 0) {
                        this.killEnemy(e, i);
                        break;
                    } else {
                        e.flash = 6;
                        this.noise(0.05, 0.06, 3000);
                    }
                }
            }
        }

        for (let i = this.pups.length - 1; i >= 0; i--) {
            const p = this.pups[i];
            p.y += p.vy * ts;
            p.ph += 0.1 * ts;
            if (p.y > H + 20) {
                this.pups.splice(i, 1);
                continue;
            }
            const dx = p.x - sp.x;
            const dy = p.y - sp.y;
            if (dx * dx + dy * dy < 650) {
                this.pups.splice(i, 1);
                this.sPup();
                this.burst(p.x, p.y, "#7bffb0", 14, 3);
                if (p.t === "T") {
                    this.weapon = "triple";
                    this.weaponT = 650;
                    this.pop(sp.x, sp.y - 30, "¡Triple disparo!", "#5ee1ff", 15);
                } else if (p.t === "S") {
                    sp.shield = 1;
                    this.pop(sp.x, sp.y - 30, "¡Escudo!", "#7bffb0", 15);
                } else if (p.t === "B") {
                    this.bomb();
                    this.pop(sp.x, sp.y - 30, "¡BOMBA!", "#ffb347", 18);
                } else {
                    this.lives = Math.min(5, this.lives + 1);
                    this.pop(sp.x, sp.y - 30, "¡Vida extra!", "#ff8fb3", 15);
                }
            }
        }

        for (let i = this.parts.length - 1; i >= 0; i--) {
            const p = this.parts[i];
            p.x += p.vx * ts;
            p.y += p.vy * ts;
            p.vx *= 0.98;
            p.vy *= 0.98;
            p.life -= ts;
            if (p.life <= 0) {
                this.parts.splice(i, 1);
            }
        }
        for (let i = this.pops.length - 1; i >= 0; i--) {
            const p = this.pops[i];
            p.y += p.vy * ts;
            p.life -= ts;
            if (p.life <= 0) {
                this.pops.splice(i, 1);
            }
        }

        if (this.enemies.length === 0) {
            this.waveDelay -= ts;
            if (this.waveDelay <= 0) {
                this.spawnWave();
                this.waveDelay = 70;
            }
        }
        if (this.shake > 0) {
            this.shake *= 0.88;
        }
        if (this.flashT > 0) {
            this.flashT -= ts;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Render                                                              */
    /* ------------------------------------------------------------------ */

    drawShipBody() {
        const g = this.g;
        const sp = this.ship;
        if (sp.inv > 0 && (this.frame >> 2) % 2 === 0) {
            return;
        }
        g.save();
        g.translate(sp.x, sp.y);
        const tilt = Math.max(-0.35, Math.min(0.35, (sp.tx - sp.x) * 0.02));
        g.rotate(tilt);
        g.globalCompositeOperation = "lighter";
        g.fillStyle = "rgba(94,225,255,0.12)";
        g.beginPath();
        g.arc(0, 0, 26, 0, 6.2832);
        g.fill();
        const fl = 10 + Math.random() * 8;
        g.fillStyle = "rgba(255,170,70,0.85)";
        g.beginPath();
        g.moveTo(-5, 14);
        g.lineTo(0, 14 + fl);
        g.lineTo(5, 14);
        g.closePath();
        g.fill();
        g.globalCompositeOperation = "source-over";
        g.fillStyle = "#5ee1ff";
        g.beginPath();
        g.moveTo(0, -18);
        g.lineTo(13, 14);
        g.lineTo(0, 7);
        g.lineTo(-13, 14);
        g.closePath();
        g.fill();
        g.fillStyle = "#eafcff";
        g.beginPath();
        g.moveTo(0, -14);
        g.lineTo(5, 6);
        g.lineTo(-5, 6);
        g.closePath();
        g.fill();
        if (sp.shield > 0) {
            g.strokeStyle = "rgba(123,255,176," + (0.5 + Math.sin(this.frame * 0.15) * 0.3) + ")";
            g.lineWidth = 2;
            g.beginPath();
            g.arc(0, 0, 24, 0, 6.2832);
            g.stroke();
        }
        g.restore();
    }

    drawEnemy(e) {
        const g = this.g;
        g.save();
        g.translate(e.x, e.y);
        g.globalCompositeOperation = "lighter";
        g.fillStyle = this.glow(e.c, 0.14);
        g.beginPath();
        g.arc(0, 0, e.r + 10, 0, 6.2832);
        g.fill();
        g.globalCompositeOperation = "source-over";
        g.fillStyle = e.flash > 0 ? "#ffffff" : e.c;
        if (e.flash > 0) {
            e.flash--;
        }
        if (e.type === "drone") {
            g.beginPath();
            g.moveTo(0, -e.r);
            g.lineTo(e.r, 0);
            g.lineTo(0, e.r);
            g.lineTo(-e.r, 0);
            g.closePath();
            g.fill();
            g.fillStyle = "#3a0d1e";
            g.beginPath();
            g.arc(0, 0, 4, 0, 6.2832);
            g.fill();
        } else if (e.type === "speedy") {
            g.beginPath();
            g.moveTo(0, e.r);
            g.lineTo(e.r * 0.9, -e.r);
            g.lineTo(0, -e.r * 0.4);
            g.lineTo(-e.r * 0.9, -e.r);
            g.closePath();
            g.fill();
        } else if (e.type === "tank") {
            g.beginPath();
            for (let k = 0; k < 6; k++) {
                const a = (k / 6) * 6.2832 + 0.5;
                const px = Math.cos(a) * e.r;
                const py = Math.sin(a) * e.r;
                if (k) { g.lineTo(px, py); } else { g.moveTo(px, py); }
            }
            g.closePath();
            g.fill();
            g.fillStyle = "#2a1246";
            g.beginPath();
            g.arc(0, 0, 7, 0, 6.2832);
            g.fill();
        } else {
            const p = 1 + Math.sin(e.t * 0.08) * 0.04;
            g.scale(p, p);
            g.beginPath();
            for (let k = 0; k < 8; k++) {
                const a = (k / 8) * 6.2832;
                const rr = k % 2 ? e.r * 0.72 : e.r;
                const px = Math.cos(a) * rr;
                const py = Math.sin(a) * rr;
                if (k) { g.lineTo(px, py); } else { g.moveTo(px, py); }
            }
            g.closePath();
            g.fill();
            g.fillStyle = "#ffd7d7";
            g.beginPath();
            g.arc(0, 0, 12, 0, 6.2832);
            g.fill();
            g.fillStyle = "#5c0f0f";
            g.beginPath();
            g.arc(0, 0, 6, 0, 6.2832);
            g.fill();
        }
        g.restore();
        if (e.mhp > 1) {
            const w2 = e.r * 2;
            g.fillStyle = "rgba(255,255,255,0.18)";
            g.fillRect(e.x - w2 / 2, e.y - e.r - 12, w2, 4);
            g.fillStyle = e.type === "boss" ? "#ff6b6b" : "#c9a4ff";
            g.fillRect(e.x - w2 / 2, e.y - e.r - 12, w2 * Math.max(0, e.hp / e.mhp), 4);
        }
    }

    render() {
        const g = this.g;
        const W = this.W;
        const H = this.H;
        g.save();
        g.fillStyle = "#05060e";
        g.fillRect(0, 0, W, H);
        if (this.shake > 0.5) {
            g.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
        }
        for (const s of this.stars) {
            g.fillStyle = "rgba(200,220,255," + (0.25 + s.z * 0.25) + ")";
            g.fillRect(s.x, s.y, s.s, s.s + s.z * 2);
        }
        g.globalCompositeOperation = "lighter";
        for (const p of this.parts) {
            g.globalAlpha = Math.max(0, p.life / p.ml);
            g.fillStyle = p.c;
            g.beginPath();
            g.arc(p.x, p.y, p.r, 0, 6.2832);
            g.fill();
        }
        g.globalAlpha = 1;
        for (const b of this.bullets) {
            g.fillStyle = "rgba(94,225,255,0.25)";
            g.fillRect(b.x - 3, b.y - 2, 6, 16);
            g.fillStyle = "#d8f8ff";
            g.fillRect(b.x - 1.5, b.y, 3, 12);
        }
        for (const b of this.ebullets) {
            g.fillStyle = "rgba(255,110,110,0.3)";
            g.beginPath();
            g.arc(b.x, b.y, 7, 0, 6.2832);
            g.fill();
            g.fillStyle = "#ffdada";
            g.beginPath();
            g.arc(b.x, b.y, 3.5, 0, 6.2832);
            g.fill();
        }
        g.globalCompositeOperation = "source-over";
        for (const p of this.pups) {
            const col = p.t === "T" ? "#5ee1ff" : p.t === "S" ? "#7bffb0" : p.t === "B" ? "#ffb347" : "#ff8fb3";
            const bob = Math.sin(p.ph) * 2;
            g.fillStyle = "rgba(255,255,255,0.1)";
            g.beginPath();
            g.arc(p.x, p.y + bob, p.r + 5, 0, 6.2832);
            g.fill();
            g.fillStyle = col;
            g.beginPath();
            g.arc(p.x, p.y + bob, p.r, 0, 6.2832);
            g.fill();
            g.fillStyle = "#0a0d18";
            g.font = "500 13px system-ui,sans-serif";
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.fillText(p.t === "L" ? "+" : p.t, p.x, p.y + bob + 1);
        }
        for (const e of this.enemies) {
            this.drawEnemy(e);
        }
        if (this.state !== "start") {
            this.drawShipBody();
        }
        for (const p of this.pops) {
            g.globalAlpha = Math.max(0, p.life / p.ml);
            g.fillStyle = p.color;
            g.font = "500 " + p.size + "px system-ui,sans-serif";
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.fillText(p.txt, p.x, p.y);
        }
        g.globalAlpha = 1;
        if (this.flashT > 0) {
            g.fillStyle = "rgba(255,255,255," + ((this.flashT / 12) * 0.55) + ")";
            g.fillRect(-30, -30, W + 60, H + 60);
        }
        g.restore();

        g.textBaseline = "middle";
        if (this.state === "playing" || this.state === "over") {
            g.textAlign = "left";
            g.fillStyle = "#eaf6ff";
            g.font = "500 16px system-ui,sans-serif";
            g.fillText(this.score.toLocaleString(), 14, 22);
            if (this.combo > 1) {
                g.fillStyle = "#ffd166";
                g.font = "500 13px system-ui,sans-serif";
                g.fillText("combo x" + this.combo, 14, 42);
                g.fillStyle = "rgba(255,209,102,0.3)";
                g.fillRect(14, 52, 60, 3);
                g.fillStyle = "#ffd166";
                g.fillRect(14, 52, 60 * (this.comboT / 170), 3);
            }
            g.textAlign = "center";
            g.fillStyle = "rgba(180,210,255,0.7)";
            g.font = "500 13px system-ui,sans-serif";
            g.fillText("Oleada " + this.wave, W / 2, 22);
            for (let i = 0; i < this.lives; i++) {
                g.fillStyle = "#5ee1ff";
                g.beginPath();
                g.moveTo(W - 20 - i * 20, 14);
                g.lineTo(W - 14 - i * 20, 26);
                g.lineTo(W - 26 - i * 20, 26);
                g.closePath();
                g.fill();
            }
            if (this.weapon === "triple") {
                g.textAlign = "right";
                g.fillStyle = "#5ee1ff";
                g.font = "500 12px system-ui,sans-serif";
                g.fillText("triple " + Math.ceil(this.weaponT / 60) + "s", W - 14, 42);
            }
        }
        if (this.state === "start") {
            g.textAlign = "center";
            const pul = 0.7 + Math.sin(this.frame * 0.06) * 0.3;
            g.fillStyle = "rgba(94,225,255," + pul * 0.25 + ")";
            g.font = "500 46px system-ui,sans-serif";
            g.fillText("NEON STRIKE", W / 2, H / 2 - 62);
            g.fillStyle = "#eaf6ff";
            g.font = "500 44px system-ui,sans-serif";
            g.fillText("NEON STRIKE", W / 2, H / 2 - 64);
            g.fillStyle = "rgba(180,210,255,0.8)";
            g.font = "400 15px system-ui,sans-serif";
            g.fillText("Arrastra para moverte · disparo automático", W / 2, H / 2 - 16);
            g.fillText("Sobrevive las oleadas y derrota a los jefes", W / 2, H / 2 + 8);
            g.fillStyle = "rgba(255,255,255," + pul + ")";
            g.font = "500 18px system-ui,sans-serif";
            g.fillText("Toca para jugar", W / 2, H / 2 + 58);
            g.fillStyle = "#b78bad";
            g.font = "500 12px system-ui,sans-serif";
            g.fillText("Odoo 19 · módulo neon_strike", W / 2, H / 2 + 88);
        }
        if (this.state === "over") {
            g.fillStyle = "rgba(4,5,12,0.72)";
            g.fillRect(0, 0, W, H);
            g.textAlign = "center";
            g.fillStyle = "#ff8f8f";
            g.font = "500 38px system-ui,sans-serif";
            g.fillText("Fin del juego", W / 2, H / 2 - 58);
            g.fillStyle = "#eaf6ff";
            g.font = "500 22px system-ui,sans-serif";
            g.fillText("Puntos: " + this.score.toLocaleString(), W / 2, H / 2 - 12);
            g.fillStyle = "rgba(180,210,255,0.85)";
            g.font = "400 15px system-ui,sans-serif";
            g.fillText("Récord: " + this.best.toLocaleString() + " · Oleada " + this.wave, W / 2, H / 2 + 16);
            const pul = 0.7 + Math.sin(this.frame * 0.08) * 0.3;
            g.fillStyle = "rgba(255,255,255," + pul + ")";
            g.font = "500 17px system-ui,sans-serif";
            g.fillText("Toca para reintentar", W / 2, H / 2 + 62);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Input                                                               */
    /* ------------------------------------------------------------------ */

    _ptr(e) {
        const r = this.cv.getBoundingClientRect();
        return {
            x: e.clientX - r.left,
            y: e.clientY - r.top,
            touch: e.pointerType === "touch",
        };
    }

    _pointerDown(e) {
        this.audio();
        const p = this._ptr(e);
        if (this.state !== "playing") {
            this.reset();
            this.state = "playing";
        }
        this.ship.tx = p.x;
        this.ship.ty = p.touch ? p.y - 60 : p.y;
    }

    _pointerMove(e) {
        const p = this._ptr(e);
        this.ship.tx = p.x;
        this.ship.ty = p.touch ? p.y - 60 : p.y;
    }
}
