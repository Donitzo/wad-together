import MapTransformer from './maptransformer.class.js';
import UdmfParser from './udmfparser.class.js';

/**
 * Loads lumps from WAD and PK3 sources.
 */
export default class LumpManager {
    /**
     * Immutable lump.
     */
    static Lump = class Lump {
        /** @type {number} */
        #sourceIndex = 0;
        /** @type {number} Lump index in source. */
        get sourceIndex() {
            return this.#sourceIndex;
        }

        /** @type {string} */
        #name = '';
        /** @type {string} Lump name or PK3-relative path (without extension). */
        get name() {
            return this.#name;
        }

        /** @type {string} Filename without extension for PK3 entries. */
        get resourceName() {
            const normalized = this.#name.replaceAll('\\', '/');
            const basename = normalized.split('/').at(-1) ?? normalized;
            return this.#extension === null ? basename : basename.slice(0, -(this.#extension.length + 1));
        }

        /** @type {string} Relative name without extension and root directory for PK3 entries. */
        get relativePath() {
            const normalized = this.#name.replaceAll('\\', '/');
            const parts = normalized.split('/');
            return parts.length < 2 ? this.resourceName : parts.slice(1).join('/').replace(/\.[^/.]+$/, '');
        }

        /** @type {?Uint8Array} */
        #data = null;
        /** @type {?Uint8Array} Raw lump data. */
        get data() {
            return this.#data;
        }

        /** @type {?string} */
        #extension = null;
        /** @type {?string} Filename extension for PK3 entries. */
        get extension() {
            return this.#extension;
        }

        /**
         * @param {number} sourceIndex - Lump index in source.
         * @param {string} name - Lump name or PK3-relative path.
         * @param {Uint8Array} data - Raw lump data.
         * @param {?string} [extension=null] - Filename extension.
         */
        constructor(sourceIndex, name, data, extension = null) {
            this.#sourceIndex = sourceIndex;
            this.#name = name;
            this.#data = data;
            this.#extension = extension;
        }
    };

    /** @type {Array<string>} Recognized map lump names. */
    static #MAP_LUMP_NAMES = [
        'textmap',
        'linedefs',
        'sidedefs',
        'vertexes',
        'sectors',
        'things',
        'segs',
        'ssectors',
        'nodes',
        'reject',
        'blockmap',
        'behavior',
        'scripts',
        'endmap',
        'znodes',
        'dialogue',
    ];

    /** @type {Array<{id: string, name: string}>} */
    #sources = [];
    /** @type {Array<{id: string, name: string}>} Lump sources. */
    get sources() {
        return this.#sources.slice();
    }
    /** @type {Array<LumpManager.Lump>} Lumps loaded from base IWAD sources. */
    #lumpsIwad = [];
    /** @type {Array<LumpManager.Lump>} Lumps loaded from override PWAD sources. */
    #lumpsPwad = [];
    /** @type {Array<LumpManager.Lump>} Lumps loaded from PK3 sources. */
    #lumpsPk3 = [];
    /** @type {Array<LumpManager.Lump>} */
    #lumps = [];
    /** @type {Array<LumpManager.Lump>} Canonical merged lump list. */
    get lumps() {
        return this.#lumps.slice();
    }
    /** @type {Array<object>} */
    #maps = [];
    /** @type {Array<object>} Map definitions. */
    get maps() {
        return this.#maps.slice();
    }

    /**
     * Loads lumps and maps from a PK3 archive.
     *
     * Loose files are stored as PK3 lumps. UDMF map directories are parsed directly,
     * while WAD files inside the `maps` directory are loaded as embedded WAD sources.
     *
     * @param {ArrayBuffer} buffer - PK3 archive data.
     * @param {string} name - Display name of the source.
     * @returns {Promise}
     */
    async addSourcePk3(buffer, name) {
        const zip = await JSZip.loadAsync(buffer);

        const sourceIndex = this.#sources.length;
        this.#sources.push({
            id: 'PK3',
            name,
        });

        const embeddedWads = [];

        for (const [path, entry] of Object.entries(zip.files)) {
            if (entry.dir) {
                continue;
            }

            const lumpName = path.replace(/\\/g, '/');
            const lumpNameCI = lumpName.toLowerCase();
            const parts = lumpNameCI.split('/');

            const data = new Uint8Array(await entry.async('arraybuffer'));

            // Embedded WADs
            if (lumpNameCI.endsWith('.wad')) {
                embeddedWads.push({ data, lumpName });
                continue;
            }

            const lumpName2 = parts[parts.length - 1];

            // Is it a UDMF map?
            const isMapLump =
                parts[0] === 'maps' &&
                parts.length >= 3 &&
                LumpManager.#MAP_LUMP_NAMES.includes(lumpName2);

            if (isMapLump) {
                // Store the map
                const mapName = parts[1].toUpperCase();

                let map = this.#maps.find(map => map.name === mapName && map.sourceIndex === sourceIndex);

                if (map === undefined) {
                    const oldIndex = this.#maps.findIndex(map2 => map2.name === mapName);

                    if (oldIndex !== -1) {
                        this.#maps.splice(oldIndex, 1);
                    }

                    map = {
                        name: mapName,
                        sourceIndex,
                        port: 'doom_wad',
                        namespace: null,
                    };

                    LumpManager.#MAP_LUMP_NAMES.forEach(mapLumpName => {
                        map[mapLumpName] = null;
                    });

                    this.#maps.push(map);
                }

                if (lumpName2 === 'textmap') {
                    const text = new TextDecoder().decode(data);
                    const ast = UdmfParser.parse(text);

                    if (!ast.namespace) {
                        console.warn(`UDMF map "${map.name}" has no namespace`);
                    }

                    map.port = MapTransformer.UDMF_NAMESPACE_TO_PORT
                        .get(String(ast.namespace ?? '').toLowerCase()) ?? 'zdoom_udmf';
                    map.namespace = ast.namespace;
                    map.textmap = ast;
                } else {
                    // Use heuristics to guess if this is a Hexen map
                    if (map.textmap === null &&
                        (lumpName2 === 'behavior' || lumpName2 === 'linedefs' &&
                        data.byteLength % 16 === 0 &&
                        data.byteLength % 14 !== 0)) {
                        map.port = 'hexen_wad';
                    }

                    map[lumpName2] = data;
                }
            } else {
                // Other lump
                const basename = lumpName.split('/').at(-1) ?? lumpName;
                const dotIndex = basename.lastIndexOf('.');
                const extension = dotIndex > 0 && dotIndex < basename.length - 1
                    ? basename.slice(dotIndex + 1).toLowerCase()
                    : null;

                const lump = new LumpManager.Lump(sourceIndex, lumpName.toUpperCase(), data, extension);
                this.#lumpsPk3.push(lump);
            }
        }

        // Load embedded wads
        embeddedWads.forEach(wad => {
            this.addSourceWad(wad.data.buffer, wad.lumpName);
        });

        this.#updateMergedLumps();
        this.#validateMaps();
    }

    /**
     * Loads lumps and maps from a WAD file.
     *
     * @param {ArrayBuffer} buffer - WAD file data.
     * @param {string} name - Display name.
     */
    addSourceWad(buffer, name) {
        const view = new DataView(buffer);
        const decoder = new TextDecoder();

        // Get WAD type
        const id = decoder.decode(buffer.slice(0, 4));
        if (id !== 'IWAD' && id !== 'PWAD') {
            console.warn(`Unknown WAD type "${id}"`);
            return;
        }

        // Keep track of sources
        const sourceIndex = this.#sources.length;
        this.#sources.push({
            id,
            name,
        });

        // Load lumps
        const lumpCount = view.getInt32(4, true);
        const directoryOffset = view.getInt32(8, true);

        const lumps = [];

        for (let i = 0; i < lumpCount; i++) {
            const entryOffset = directoryOffset + i * 16;
            const dataOffset = view.getInt32(entryOffset, true);
            const dataSize = view.getInt32(entryOffset + 4, true);
            const name = decoder
                .decode(buffer.slice(entryOffset + 8, entryOffset + 16))
                .replace(/\0+$/, '');
            const data = new Uint8Array(buffer.slice(dataOffset, dataOffset + dataSize));
            lumps.push(new LumpManager.Lump(sourceIndex, name.toUpperCase(), data));
        }

        // Find maps
        let map = null;

        lumps.forEach(lump => {
            // Is this lump a map header?
            const isMapHeader = /^(MAP\d\d|E\dM\d)$/.test(lump.name);
            if (isMapHeader) {
                const mapName = lump.name;
                const oldIndex = this.#maps.findIndex(map => map.name === mapName);
                if (oldIndex > -1) {
                    this.#maps.splice(oldIndex, 1);
                }
                map = {
                    name: mapName,
                    sourceIndex,
                    port: 'doom_wad',
                    namespace: null,
                };
                LumpManager.#MAP_LUMP_NAMES.forEach(name => {
                    map[name] = null;
                });
                this.#maps.push(map);
                return;
            }

            if (map !== null) {
                // Is this lump part of the previous map
                const lumpName = lump.name.toLowerCase();
                if (LumpManager.#MAP_LUMP_NAMES.includes(lumpName)) {
                    if (lumpName === 'endmap') {
                        map.endmap = lump.data;
                        map = null;
                        return;
                    }

                    if (map[lumpName] !== null) {
                        console.warn(`Map "${map.name}" contains more than one "${lumpName}"`);
                    }

                    if (lumpName === 'textmap') {
                        const text = new TextDecoder().decode(lump.data);
                        const ast = UdmfParser.parse(text);

                        if (!ast.namespace) {
                            console.warn(`UDMF map "${map.name}" has no namespace`);
                        }

                        map.port = MapTransformer.UDMF_NAMESPACE_TO_PORT
                            .get(String(ast.namespace ?? '').toLowerCase()) ?? 'zdoom_udmf';
                        map.namespace = ast.namespace;
                        map.textmap = ast;
                    } else {
                        // Use heuristics to guess if this is a Hexen map
                        if (map.textmap === null &&
                            (lumpName === 'behavior' || lumpName === 'linedefs' &&
                            lump.data.length % 16 === 0 &&
                            lump.data.length % 14 !== 0)) {
                            map.port = 'hexen_wad';
                        }

                        map[lumpName] = lump.data;
                    }

                    return;
                }
            }

            // Not part of a map, store the lump based on source type
            if (id === 'IWAD') {
                this.#lumpsIwad.push(lump);
            } else {
                this.#lumpsPwad.push(lump);
            }
        });

        this.#updateMergedLumps();
        this.#validateMaps();
    }

    /**
     * Rebuilds the canonical lump list in IWAD, PWAD, then PK3 order.
     *
     * Later entries override earlier entries during reverse lookup.
     */
    #updateMergedLumps() {
        this.#lumps.length = 0;
        this.#lumpsIwad.forEach(lump => {
            this.#lumps.push(lump);
        });
        this.#lumpsPwad.forEach(lump => {
            this.#lumps.push(lump);
        });
        this.#lumpsPk3.forEach(lump => {
            this.#lumps.push(lump);
        });
    }

    /**
     * Checks discovered maps for required format-specific lumps.
     */
    #validateMaps() {
        this.#maps.forEach(map => {
            const format = MapTransformer.PORT_EXPORT_FORMAT.get(map.port);
            if (format === 'udmf') {
                if (map.textmap === null) {
                    console.warn(`UDMF map "${map.name}" is missing TEXTMAP`);
                }
                if (map.endmap === null) {
                    console.warn(`UDMF map "${map.name}" is missing ENDMAP`);
                }
            }
        });
    }

    /**
     * Removes all loaded sources, lumps, and maps.
     */
    clearSources() {
        this.#sources.length = 0;
        this.#lumpsIwad.length = 0;
        this.#lumpsPwad.length = 0;
        this.#lumpsPk3.length = 0;
        this.#lumps.length = 0;
        this.#maps.length = 0;
    }

    /**
     * Returns the latest lump with a given name.
     *
     * @param {string} name - Lump name.
     * @param {boolean} [allowPk3=true] - Whether PK3 lumps may be returned.
     * @returns {?LumpManager.Lump} Matching lump, or `null`.
     */
    getLump(name, allowPk3 = true) {
        const nameCI = name.toUpperCase();

        for (let i = this.#lumps.length - 1; i >= 0; i -= 1) {
            const lump = this.#lumps[i];
            const source = this.#sources[lump.sourceIndex];

            if (!allowPk3 && source.id === 'PK3') {
                continue;
            }

            if (lump.name === nameCI) {
                return lump;
            }

            // Ignore extensions for root PK3 lumps
            const isRootPk3Lump = source.id === 'PK3' && !lump.name.includes('/');
            if (isRootPk3Lump && !nameCI.includes('/') && lump.resourceName === nameCI) {
                return lump;
            }
        }

        return null;
    }

    /**
     * Returns lumps from all matching marker ranges.
     *
     * Only markers from non-PK3 sources are considered.
     * Ranges are processed in source and lump load order, with later lumps overriding earlier ones.
     *
     * @param {string} startName - Opening marker lump name.
     * @param {string} endName - Closing marker lump name.
     * @returns {Array<LumpManager.Lump>} Lumps between the markers.
     */
    getLumpsBetweenTags(startName, endName) {
        const startNameCI = startName.toUpperCase();
        const endNameCI = endName.toUpperCase();
        const lumpsByName = new Map();

        for (let i = 0; i < this.#lumps.length; i++) {
            const startLump = this.#lumps[i];
            const source = this.#sources[startLump.sourceIndex];

            if (source.id === 'PK3' || startLump.name !== startNameCI) {
                continue;
            }

            for (i += 1; i < this.#lumps.length; i++) {
                const lump = this.#lumps[i];

                if (lump.sourceIndex !== startLump.sourceIndex) {
                    i -= 1;
                    break;
                }

                if (lump.name === endNameCI) {
                    break;
                }

                // Place the new lump last
                lumpsByName.delete(lump.name);
                lumpsByName.set(lump.name, lump);
            }
        }

        return Array.from(lumpsByName.values());
    }

    /**
     * Returns lumps located within a PK3-source directory.
     *
     * @param {string} directory - Directory path.
     * @param {boolean} [recursive=true] - Whether to include lumps from nested directories.
     * @returns {Array<LumpManager.Lump>} Matching lumps in load order.
     */
    getLumpsInDirectory(directory, recursive = true) {
        const prefix = directory
            .replaceAll('\\', '/')
            .replace(/^\/+|\/+$/g, '')
            .toUpperCase() + '/';

        return this.#lumps.filter(lump => {
            const source = this.#sources[lump.sourceIndex];

            if (source.id !== 'PK3') {
                return false;
            }

            const path = lump.name
                .replaceAll('\\', '/')
                .replace(/^\/+/, '')
                .toUpperCase();

            if (!path.startsWith(prefix)) {
                return false;
            }

            if (recursive) {
                return true;
            }

            return !path.slice(prefix.length).includes('/');
        });
    }
}
