/**
 * Text as sprites drawn on a canvas: no font files to load, accents work, and
 * sprites always face the viewer, which also suits the headset.
 */

import * as THREE from "three";

const FONT_PX = 64;
const LINE_HEIGHT = 1.22;
const FONT_FAMILY = "system-ui, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif";

/** Greedy word wrap into at most `maxLines` lines; the last line takes the rest. */
export function wrapText(text, maxChars, maxLines = 2) {
    if (text.length <= maxChars) {
        return [text];
    }
    const words = text.split(" ");
    const lines = [];
    let line = "";
    for (const word of words) {
        if (lines.length === maxLines - 1) {
            line = line ? `${line} ${word}` : word;
            continue;
        }
        if (line && `${line} ${word}`.length > maxChars) {
            lines.push(line);
            line = word;
        } else {
            line = line ? `${line} ${word}` : word;
        }
    }
    if (line) {
        lines.push(line);
    }
    return lines;
}

/**
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.lineHeight] world height of one line, in meters
 * @param {number} [options.maxChars] wrap after this many characters (0 = never)
 * @param {number} [options.maxLines] the last line takes whatever is left
 * @param {string} [options.color]
 * @param {string|null} [options.background] null for no box
 * @param {number} [options.weight] font weight
 * @param {[number, number]} [options.anchor] sprite center: [0.5, 1] hangs below its position
 * @param {boolean} [options.onTop] drawn over the meshes (set a renderOrder too)
 * @returns {THREE.Sprite}
 */
export function createTextSprite(text, {
    lineHeight = 0.034,
    maxChars = 14,
    maxLines = 2,
    color = "#F2F5F8",
    background = "rgba(16, 19, 24, 0.78)",
    weight = 500,
    anchor = [0.5, 0.5],
    onTop = false,
} = {}) {
    const lines = maxChars ? wrapText(text, maxChars, maxLines) : [text];
    const font = `${weight} ${FONT_PX}px ${FONT_FAMILY}`;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    context.font = font;
    const padX = FONT_PX * 0.4;
    const padY = FONT_PX * 0.22;
    const textWidth = Math.max(...lines.map((line) => context.measureText(line).width));
    canvas.width = Math.ceil(textWidth + padX * 2);
    canvas.height = Math.ceil(lines.length * FONT_PX * LINE_HEIGHT + padY * 2);

    // Resizing the canvas resets the context state.
    context.font = font;
    if (background) {
        context.fillStyle = background;
        context.beginPath();
        context.roundRect(0, 0, canvas.width, canvas.height, FONT_PX * 0.3);
        context.fill();
    }
    context.fillStyle = color;
    context.textAlign = "center";
    context.textBaseline = "middle";
    lines.forEach((line, index) => {
        const y = padY + (index + 0.5) * FONT_PX * LINE_HEIGHT;
        context.fillText(line, canvas.width / 2, y);
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        // Labels on top stay readable when an arrow passes in front of them.
        depthTest: !onTop,
    });
    const sprite = new THREE.Sprite(material);
    const metersPerPixel = lineHeight / (FONT_PX * LINE_HEIGHT);
    sprite.scale.set(canvas.width * metersPerPixel, canvas.height * metersPerPixel, 1);
    sprite.center.set(anchor[0], anchor[1]);
    return sprite;
}

export function disposeSprite(sprite) {
    sprite.material.map?.dispose();
    sprite.material.dispose();
}
