import * as THREE from './lib/three.js/three.module.js';

const vertexShader = `
varying vec4 vClipPosition;
varying vec2 vUv;
varying float vYaw;
varying float vViewDistance;

void main() {
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    vec4 clip = projectionMatrix * view;

    vClipPosition = clip;
    vUv = uv;
    vViewDistance = length(view.xyz);

    gl_Position = clip;
    vYaw = atan(-viewMatrix[2][0], -viewMatrix[2][2]);
}`;

const fragmentShader = `
uniform sampler2D uTexture;
// .r color index, .g alpha, .b > 0 = rgb
uniform sampler2D uLut;
uniform float uFrameIndex;
uniform float uFrameCount;
uniform float uPaletteIndex;
uniform float uPaletteCount;
uniform float uColormapIndex;
uniform float uColormapCount;

uniform float uHovered;
uniform float uSelected;

uniform float uIsSky;

uniform vec3 uLightColor;
uniform vec3 uFadeColor;
uniform float uFogDensity;

varying vec4 vClipPosition;
varying vec2 vUv;
varying float vYaw;
varying float vViewDistance;

void main() {
    // Get sky or regular UV coordinate
    vec2 ndc = (vClipPosition.xy / vClipPosition.w) * 0.5 + 0.5;
    vec2 uv = mix(
        vec2(
            (vUv.x + uFrameIndex) / uFrameCount,
            vUv.y
        ),
        vec2(
            -fract((vYaw - 1.57079632679 + atan((ndc.x * 2.0 - 1.0) * 1.2)) / (3.14159265 / 2.0)),
            (ndc.y - 1.0) * 200.0 / 128.0
        ),
        uIsSky
    );

    // Get base color index
    vec3 base = texture2D(uTexture, uv).rgb;

    // Discard pixels marked as transparent in the source texture
    float dither = mod(gl_FragCoord.x + gl_FragCoord.y, 8.0);
    if (base.g < 0.5 && (uHovered + uSelected < 0.5 || dither < 4.0) && base.b < 1e-6) {
        discard;
    }

    // Get the PLAYPAL color index from the COLORMAP LUT
    float colormapIndex = mix(uColormapIndex, 0.0, uIsSky);
    float colorIndex = texture2D(
        uLut,
        vec2(
            (base.r * 255.0 + 0.5) / 256.0,
            (uPaletteCount + colormapIndex + 0.5) / (uPaletteCount + uColormapCount)
        )
    ).r * 255.0;

    // Get the PLAYPAL color from the palette
    vec3 baseColor = texture2D(
        uLut,
        vec2(
            (colorIndex + 0.5) / 256.0,
            (uPaletteIndex + 0.5) / (uPaletteCount + uColormapCount)
        )
    ).rgb;
    vec3 color = mix(baseColor, base, step(1e-6, base.b));

    // Apply light tint
    color *= mix(uLightColor, vec3(1.0), uIsSky);

    // Apply fog
    float fogDistance = vViewDistance * 64.0;
    float fogFactor = mix(exp2((-uFogDensity / 64000.0) * fogDistance), 1.0, uIsSky);
    color = mix(uFadeColor, color, clamp(fogFactor, 0.0, 1.0));

    // Mix the final color
    gl_FragColor = vec4(
        mix(
            color,
            mix(vec3(0.3, 0.5, 1.0), vec3(1.0, 0.3, 1.0), uSelected),
            min(uHovered + uSelected, 0.4)
        ), 1.0);
}`;


/**
 * Shader material for rendering Doom textures using PLAYPAL palettes and COLORMAP lighting tables.
 */
export default class DoomMaterial extends THREE.ShaderMaterial {
    /** @type {Array<Object>} Lookup textures cached by palette-array and colormap-array identity. */
    static #luts = [];

    /**
     * Creates a Doom shader material.
     *
     * @param {Object} options - Material configuration.
     */
    constructor(options) {
        const lut = DoomMaterial.#getLut(options.palettes, options.colormaps);

        super({
            uniforms: {
                uTexture: { value: options.texture ?? null },
                uLut: { value: lut.texture },
                uHovered: { value: 0 },
                uSelected: { value: 0 },
                uFrameIndex: { value: 0 },
                uFrameCount: { value: options.frameCount },
                uPaletteIndex: { value: 0 },
                uPaletteCount: { value: lut.palettes.length },
                uColormapIndex: { value: 12 },
                uColormapCount: { value: lut.colormaps.length },
                uIsSky: { value: options.isSky ?? false },
                uLightColor: { value: new THREE.Color(0xffffff) },
                uFadeColor: { value: new THREE.Color(0x000000) },
                uFogDensity: { value: 0.0 },
            },
            vertexShader,
            fragmentShader,
        });
    }

    /**
     * Gets or creates a lookup texture for a palette and colormap collection.
     *
     * @param {Array<Uint8Array>} palettes - PLAYPAL palettes.
     * @param {Array<Uint8Array>} colormaps - COLORMAP tables.
     * @returns {Object} The cached or newly generated lookup texture object.
     */
    static #getLut(palettes, colormaps) {
        let lut = DoomMaterial.#luts.find(lut => lut.palettes === palettes && lut.colormaps === colormaps);
        if (lut !== undefined) {
            return lut;
        }

        const width = 256;
        const height = palettes.length + colormaps.length;

        const data = new Uint8Array(width * height * 4);

        // PLAYPAL rows
        for (let j = 0; j < palettes.length; j++) {
            const palette = palettes[j];
            for (let i = 0; i < 256; i++) {
                const i0 = (j * width + i) * 4;
                const i1 = i * 3;

                data[i0 + 0] = palette[i1 + 0];
                data[i0 + 1] = palette[i1 + 1];
                data[i0 + 2] = palette[i1 + 2];
                data[i0 + 3] = 255;
            }
        }

        // COLORMAP rows
        for (let j = 0; j < colormaps.length; j++) {
            const colormap = colormaps[j];
            for (let i = 0; i < 256; i++) {
                const i0 = ((palettes.length + j) * width + i) * 4;

                data[i0 + 0] = colormap[i];
                data[i0 + 1] = colormap[i];
                data[i0 + 2] = colormap[i];
                data[i0 + 3] = 255;
            }
        }

        const texture = new THREE.DataTexture(data, width, height);

        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;

        texture.needsUpdate = true;

        lut = { palettes, colormaps, texture };

        DoomMaterial.#luts.push(lut);

        return lut;
    }

    /**
     * Clear the lookup texture cache.
     */
    static clearLuts() {
        DoomMaterial.#luts.length = 0;
    }
}
