import LumpManager from './lumpmanager.class.js';
import MapTransformer from './maptransformer.class.js';
import ResourceUtility from './resourceutility.class.js';

import defaultThingDefinitions from './defaultthingdefinitions.js';
import defaultPalettes from './defaultpalettes.js';

/**
 * Manages WAD and PK3 lumps, palettes, colormaps, patches, flats, sprites,
 * textures, sounds, thing definitions, and maps.
 */
export default class ResourceManager {
    /** @type {LumpManager} */
    #lumpManager = new LumpManager();
    /** @type {LumpManager} Lump manager. */
    get lumpManager() {
        return this.#lumpManager;
    }

    /** @type {Array<string>} Names of maps discovered in loaded sources. */
    get mapNames() {
        return this.#lumpManager.maps.map(map => map.name);
    }
    /** @type {Array<Uint8Array>} */
    #palettes = defaultPalettes.slice(0);
    /** @type {Array<Uint8Array>} RGB palettes. */
    get palettes() {
        return this.#palettes;
    }
    /** @type {Array<Uint8Array>} */
    #colormaps = [Uint8Array.from({ length: 256 }, (_, i) => i)];
    /** @type {Array<Uint8Array>} Palette-index colormaps. */
    get colormaps() {
        return this.#colormaps;
    }
    /** @type {Map<string, object>} */
    #patches = new Map();
    /** @type {Map<string, object>} Palette-index colormaps. */
    get patches() {
        return this.#patches;
    }
    /** @type {Map<string, object>} */
    #flats = new Map();
    /** @type {Map<string, object>} Indexed patch images by lump name. */
    get flats() {
        return this.#flats;
    }
    /** @type {Map<string, object>} */
    #sprites = new Map();
    /** @type {Map<string, object>} Indexed sprite images by lump name. */
    get sprites() {
        return this.#sprites;
    }
    /** @type {Map<string, object>} */
    #textures = new Map();
    /** @type {Map<string, object>} Indexed textures by texture name. */
    get textures() {
        return this.#textures;
    }
    /** @type {Array<string>} */
    #soundNames = [];
    /** @type {Array<string>} Names of sound resources. */
    get soundNames() {
        return this.#soundNames;
    }
    /** @type {Array<object>} */
    #thingDefinitions = [];
    /** @type {Array<object>} Loaded and default thing definitions. */
    get thingDefinitions() {
        return this.#thingDefinitions;
    }

    /**
     * Refreshes all resources from the current lump sources.
     */
    async refreshResources() {
        this.#updateSoundList();
        this.#loadPalettes();
        this.#loadColormaps();
        await this.#loadPatches();
        await this.#loadFlats();
        await this.#loadSprites();
        await this.#loadTextures();
        this.#loadThingDefinitions();
    }

    /**
     * Rebuilds the list of likely sound resources.
     */
    #updateSoundList() {
        this.#soundNames.length = 0;

        if (this.#lumpManager.sources.length === 0) {
            return;
        }

        const soundLumps = [
            ...this.#lumpManager.lumps.filter(lump => !lump.name.includes('/')),
            ...this.#lumpManager.getLumpsInDirectory('sounds')
        ];

        soundLumps.forEach(lump => {
            const isLikelySound =
                lump.resourceName.startsWith('DS') ||
                ResourceUtility.isWav(lump.data) ||
                ResourceUtility.isOgg(lump.data);

            if (isLikelySound) {
                this.#soundNames.push(lump.resourceName);
            }
        });
    }

    /**
     * Loads palettes from the PLAYPAL lump.
     *
     * Falls back to the bundled default palettes when PLAYPAL is unavailable.
     */
    #loadPalettes() {
        const lump = this.#lumpManager.getLump('PLAYPAL');
        if (lump !== null) {
            this.#palettes = ResourceUtility.parsePlaypal(lump.data);
        } else {
            if (this.#lumpManager.sources.length > 0) {
                console.warn('WAD file is missing palettes');
            }

            this.#palettes = defaultPalettes.slice(0);
        }
    }

    /**
     * Loads colormaps from the COLORMAP lump.
     *
     * Falls back to an identity colormap when COLORMAP is unavailable.
     */
    #loadColormaps() {
        const lump = this.#lumpManager.getLump('COLORMAP');
        if (lump !== null) {
            this.#colormaps = ResourceUtility.parseColormaps(lump.data);
        } else {
            if (this.#lumpManager.sources.length > 0) {
                console.warn('WAD file is missing colormaps');
            }

            this.#colormaps = [Uint8Array.from({ length: 256 }, (_, i) => i)];
        }
    }

    /**
     * Loads indexed patch images from classic patch marker ranges and PK3 patches.
     *
     * PNG patches are currently skipped. Doom picture patches are parsed into indexed image data.
     */
    async #loadPatches() {
        this.#patches.clear();

        if (this.#lumpManager.sources.length === 0) {
            return;
        }

        const lumpsClassic = this.#lumpManager.getLumpsBetweenTags('P_START', 'P_END');
        const lumpsTx = this.#lumpManager.getLumpsBetweenTags('TX_START', 'TX_END');
        const lumpsHi = this.#lumpManager.getLumpsBetweenTags('HI_START', 'HI_END');
        const lumps = [
            ...lumpsClassic,
            ...lumpsTx,
            ...lumpsHi,
            ...this.#lumpManager.getLumpsInDirectory('patches'),
            ...this.#lumpManager.getLumpsInDirectory('graphics'),
        ];

        if (lumps.length === 0) {
            console.warn('WAD file is missing patches');
            return;
        }

        for (const lump of lumps) {
            if (/_(START|END)$/i.test(lump.name)) {
                continue;
            }

            const data = lump.data;
            const resourceName = lump.resourceName;
            const relativePath = lump.relativePath;

            if (lump.extension === 'png' || ResourceUtility.isPng(data)) {
                const texture = await ResourceUtility.parsePngImageData(lump.name, data, this.#palettes[0]);
                this.#patches.set(resourceName, texture);
                if (relativePath !== resourceName) {
                    this.#patches.set(relativePath, texture);
                }
                continue;
            }

            if ((lump.extension === null || lump.extension === 'lmp') &&
                ResourceUtility.isDoomPicture(data)) {
                const texture = ResourceUtility.parseSpriteIndexedImage(lump.name, data);
                this.#patches.set(resourceName, texture);
                if (relativePath !== resourceName) {
                    this.#patches.set(relativePath, texture);
                }
                continue;
            }

            console.warn(`Patch "${lump.name}" is in an unsupported format`);
        }
    }

    /**
     * Loads indexed flat images from classic flat marker ranges and PK3 flats.
     *
     * PNG flats are currently skipped. Raw 64-by-64 flats are parsed directly.
     */
    async #loadFlats() {
        this.#flats.clear();

        if (this.#lumpManager.sources.length === 0) {
            return;
        }

        const lumpsClassicF = this.#lumpManager.getLumpsBetweenTags('F_START', 'F_END');
        const lumpsClassicDoubleF = this.#lumpManager.getLumpsBetweenTags('FF_START', 'FF_END');
        const lumpsTx = this.#lumpManager.getLumpsBetweenTags('TX_START', 'TX_END');
        const lumps = [
            ...lumpsClassicF,
            ...lumpsClassicDoubleF,
            ...lumpsTx,
            ...this.#lumpManager.getLumpsInDirectory('flats'),
        ];

        if (lumps.length === 0) {
            console.warn('WAD file is missing flats');
            return;
        }

        for (const lump of lumps) {
            if (/_(START|END)$/i.test(lump.name)) {
                continue;
            }

            const data = lump.data;

            if (ResourceUtility.isPng(data)) {
                const texture = await ResourceUtility.parsePngImageData(lump.name, data, this.#palettes[0]);
                this.#flats.set(lump.resourceName, texture);
                continue;
            }

            if (data.byteLength === 4096) {
                this.#flats.set(lump.resourceName, ResourceUtility.parseFlatIndexedImage(data));
                continue;
            }

            console.warn(`Flat "${lump.name}" is in an unsupported format`);
        }
    }

    /**
     * Loads indexed sprite images from the sprite marker range AND PK3 sprites.
     *
     * PNG sprites are currently skipped. Doom picture sprites are parsed into indexed image data.
     */
    async #loadSprites() {
        this.#sprites.clear();

        if (this.#lumpManager.sources.length === 0) {
            return;
        }

        const lumps = [
            ...this.#lumpManager.getLumpsBetweenTags('S_START', 'S_END'),
            ...this.#lumpManager.getLumpsInDirectory('sprites'),
        ];

        if (lumps.length === 0) {
            console.warn('WAD file is missing sprites');
            return;
        }

        for (const lump of lumps) {
            if (/_(START|END)$/i.test(lump.name)) {
                continue;
            }

            const data = lump.data;
            const resourceName = lump.resourceName;
            const relativePath = lump.relativePath;

            if (lump.extension === 'png' || ResourceUtility.isPng(data)) {
                const texture = await ResourceUtility.parsePngImageData(lump.name, data, this.#palettes[0]);
                this.#sprites.set(resourceName, texture);
                if (relativePath !== resourceName) {
                    this.#sprites.set(relativePath, texture);
                }
                continue;
            }

            if ((lump.extension === null || lump.extension === 'lmp') &&
                ResourceUtility.isDoomPicture(data)) {
                const texture = ResourceUtility.parseSpriteIndexedImage(lump.name, data);
                this.#sprites.set(resourceName, texture);
                if (relativePath !== resourceName) {
                    this.#sprites.set(relativePath, texture);
                }
                continue;
            }

            console.warn(`Sprite "${lump.name}" is in an unsupported format`);
        }
    }

    /**
     * Loads composite textures from TEXTURE1, TEXTURE2, and TEXTURES lumps.
     * Direct textures come from TX_START/TX_END and PK3 textures.
     *
     * Binary texture definitions use PNAMES to resolve patch references.
     * Text-based definitions are parsed directly from each TEXTURES lump.
     */
    async #loadTextures() {
        this.#textures.clear();

        if (this.#lumpManager.sources.length === 0) {
            return;
        }

        let foundAnyTextures = false;

        const directTextureLumps = [
            ...this.#lumpManager.getLumpsBetweenTags('TX_START', 'TX_END'),
            ...this.#lumpManager.getLumpsInDirectory('textures'),
            ...this.#lumpManager.getLumpsInDirectory('hires'),
        ];

        for (const lump of directTextureLumps) {
            if (/_(START|END)$/i.test(lump.name)) {
                continue;
            }

            const data = lump.data;
            const resourceName = lump.resourceName;

            if (lump.extension === 'png' || ResourceUtility.isPng(data)) {
                const texture = await ResourceUtility.parsePngImageData(lump.name, data, this.#palettes[0]);
                this.#textures.set(resourceName, texture);
                foundAnyTextures = true;
                continue;
            }

            if ((lump.extension === null || lump.extension === 'lmp') &&
                ResourceUtility.isDoomPicture(data)) {
                this.#textures.set(resourceName, ResourceUtility.parseSpriteIndexedImage(lump.name, data));
                foundAnyTextures = true;
                continue;
            }

            console.warn(`Texture "${lump.name}" is in an unsupported format`);
        }

        const compositeSources = new Map([
            ...this.#sprites,
            ...this.#textures,
            ...this.#patches,
        ]);

        const loadDefinitions = definitions => {
            definitions.forEach(definition => {
                const name = definition.name.toUpperCase();
                const texture = ResourceUtility.buildTextureIndexedImage(definition, compositeSources);
                this.#textures.set(name, texture);
                compositeSources.set(name, texture);
                foundAnyTextures = true;
            });
        };

        const binaryLumpsBySource = new Map();
        const binarySourceOrder = [];

        this.#lumpManager.lumps.forEach(lump => {
            if (lump.name !== 'PNAMES' &&
                lump.name !== 'TEXTURE1' &&
                lump.name !== 'TEXTURE2') {
                return;
            }

            let sourceLumps = binaryLumpsBySource.get(lump.sourceIndex);

            if (sourceLumps === undefined) {
                sourceLumps = new Map();
                binaryLumpsBySource.set(lump.sourceIndex, sourceLumps);
                binarySourceOrder.push(lump.sourceIndex);
            }

            sourceLumps.set(lump.name, lump);
        });


        let inheritedPnamesData = null;

        binarySourceOrder.forEach(sourceIndex => {
            const sourceLumps = binaryLumpsBySource.get(sourceIndex);
            const sourcePnames = sourceLumps.get('PNAMES');
            const texture1 = sourceLumps.get('TEXTURE1');
            const texture2 = sourceLumps.get('TEXTURE2');

            if (sourcePnames !== undefined) {
                inheritedPnamesData = sourcePnames.data;
            }
            if (texture1 !== undefined) {
                loadDefinitions(
                    ResourceUtility.parseTextureDefinitions(texture1.data, inheritedPnamesData)
                );
            }
            if (texture2 !== undefined) {
                loadDefinitions(
                    ResourceUtility.parseTextureDefinitions(texture2.data, inheritedPnamesData)
                );
            }
        });

        if (!foundAnyTextures) {
            console.warn('No supported textures were found');
        }
    }

    /**
     * Loads built-in and custom thing definitions.
     *
     * DECORATE and ZScript definitions extend the bundled defaults.
     * Directional sprite frames are assembled into eight-frame rotation atlases.
     */
    #loadThingDefinitions() {
        this.#thingDefinitions = JSON.parse(JSON.stringify(defaultThingDefinitions));

        const decorate = this.#lumpManager.getLump('DECORATE');
        if (decorate !== null) {
            ResourceUtility.parseDecorate(decorate, this.#thingDefinitions);
        }

        const zscript = this.#lumpManager.getLump('ZSCRIPT');
        if (zscript !== null) {
            ResourceUtility.parseZScript(zscript, this.#thingDefinitions);
        }

        this.#thingDefinitions.forEach(definition => {
            const rotations = [
                { pattern: /^A1(?:[A-Z]1)?$/, flip: false },
                { pattern: /^A2(?:[A-Z]8)?$/, flip: false },
                { pattern: /^A3(?:[A-Z]7)?$/, flip: false },
                { pattern: /^A4(?:[A-Z]6)?$/, flip: false },
                { pattern: /^A5(?:[A-Z]5)?$/, flip: false },
                { pattern: /^A4(?:[A-Z]6)?$/, flip: true },
                { pattern: /^A3(?:[A-Z]7)?$/, flip: true },
                { pattern: /^A2(?:[A-Z]8)?$/, flip: true },
            ];

            let firstImage = null;

            const rotationless = [...this.#sprites.entries()].find(([name]) => {
                if (!name.startsWith(definition.sprite)) {
                    return false;
                }

                const suffix = name.slice(definition.sprite.length);
                return /^[A-Z]0$/.test(suffix);
            });

            if (rotationless !== undefined) {
                firstImage = rotationless[1];
            }

            const frames = [];

            for (let r = 0; r < rotations.length; r += 1) {
                const { pattern, flip } = rotations[r];

                const entry = [...this.#sprites.entries()].find(([name]) => {
                    if (!name.startsWith(definition.sprite)) {
                        return false;
                    }

                    const suffix = name.slice(
                        definition.sprite.length
                    );

                    return pattern.test(suffix);
                });

                const sprite = entry === undefined ? null : entry[1];

                if (sprite !== null && firstImage === null) {
                    firstImage = sprite;
                }

                frames.push(sprite === null
                    ? null : flip
                    ? ResourceUtility.flipIndexedImage(sprite) : sprite
                );
            }

            for (let r = 0; r < frames.length; r += 1) {
                if (frames[r] === null) {
                    frames[r] = firstImage;
                }
            }

            definition.rotationFrames = frames;

            definition.rotationAtlas = firstImage === null
                ? null
                : ResourceUtility.buildIndexedImageAtlas(frames);
        });
    }

    /**
     * Converts a loaded map into the internal document format.
     *
     * @param {string} mapName - Map name.
     * @returns {Object} Converted map document.
     */
    loadMapAsDocument(mapName) {
        const map = this.#lumpManager.maps.find(map => map.name === mapName);

        if (map === undefined) {
            throw new Error(`Map "${mapName}" not found in loaded lumps`);
        }

        return MapTransformer.genericMapToDocument(map);
    }
}
