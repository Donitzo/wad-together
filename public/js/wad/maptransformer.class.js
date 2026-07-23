import UdmfParser from './udmfparser.class.js';

/**
 * Converts maps between the editor's internal document format, UDMF, classic Doom binary lumps,
 * Hexen binary lumps, and complete WAD files.
 *
 * `Document` is the name of the internal map format.
 */
export default class MapTransformer {
    /** @type {Array<string>} List of supported ports. */
    static PORTS = [
        'doom_wad',
        'doom_udmf',

        'boom_wad',

        'hexen_wad',
        'hexen_udmf',

        'zdoom_doom_wad',
        'zdoom_hexen_wad',
        'zdoom_udmf',

        'gzdoom_doom_wad',
        'gzdoom_hexen_wad',
        'gzdoom_udmf',
    ];

    /** @type {Map<string, string>} Export format used by each supported port. */
    static PORT_EXPORT_FORMAT = new Map([
        ['doom_wad', 'wad'],
        ['doom_udmf', 'udmf'],

        ['boom_wad', 'wad'],

        ['hexen_wad', 'wad'],
        ['hexen_udmf', 'udmf'],

        ['zdoom_doom_wad', 'wad'],
        ['zdoom_hexen_wad', 'wad'],
        ['zdoom_udmf', 'udmf'],

        ['gzdoom_doom_wad', 'wad'],
        ['gzdoom_hexen_wad', 'wad'],
        ['gzdoom_udmf', 'udmf'],
    ]);

    /** @type {Map<string, string>} Port corresponding to each recognized UDMF namespace. */
    static UDMF_NAMESPACE_TO_PORT = new Map([
        ['doom', 'doom_udmf'],
        ['hexen', 'hexen_udmf'],
        ['zdoom', 'zdoom_udmf'],
        ['gzdoom', 'gzdoom_udmf'],
    ]);

    /** @type {Map<string, string>} UDMF namespace emitted for each UDMF port. */
    static PORT_TO_UDMF_NAMESPACE = new Map([
        ['doom_udmf', 'doom'],
        ['hexen_udmf', 'hexen'],
        ['zdoom_udmf', 'zdoom'],
        ['gzdoom_udmf', 'gzdoom'],
    ]);

    /**
     * Converts a generic loaded map into the editor document format.
     *
     * The map's port determines whether UDMF, Doom-format lumps, or Hexen-format lumps are parsed.
     *
     * @param {Object} data - Map data.
     * @returns {Object} Document data.
     */
    static genericMapToDocument(data) {
        const format = MapTransformer.PORT_EXPORT_FORMAT.get(data.port);
        if (format === 'udmf') {
            return MapTransformer.udmfAstToDocument(data.textmap);
        }

        if (format === 'wad') {
            if (data.port === 'hexen_wad'
                || data.port === 'zdoom_hexen_wad'
                || data.port === 'gzdoom_hexen_wad') {
                return MapTransformer.hexenLumpsToDocument(data);
            }
            return MapTransformer.doomLumpsToDocument(data);
        }

        throw new Error(`Invalid map format "${format}"`);
    }


    /**
     * Converts a parsed UDMF syntax tree into the editor document format.
     *
     * Unknown block types are preserved in `extraBlocks`.
     *
     * @param {Object} ast - UDMF syntax tree.
     * @returns {Object} Document data.
     */
    static udmfAstToDocument(ast) {
        const doc = {
            port: MapTransformer.UDMF_NAMESPACE_TO_PORT
                .get(String(ast.namespace ?? '').toLowerCase()) ?? 'zdoom_udmf',

            vertexes: [],
            linedefs: [],
            sidedefs: [],
            sectors: [],
            things: [],

            metadata: Object.create(null),
            extraBlocks: Object.create(null),
        };

        ast.blocks.forEach(block => {
            const type = String(block.type).toLowerCase();

            switch (type) {
                case 'vertex':
                    doc.vertexes.push({ ...block.fields });
                    break;

                case 'linedef':
                    doc.linedefs.push({ ...block.fields });
                    break;

                case 'sidedef':
                    doc.sidedefs.push({ ...block.fields });
                    break;

                case 'sector':
                    doc.sectors.push({ ...block.fields });
                    break;

                case 'thing':
                    doc.things.push({ ...block.fields });
                    break;

                default:
                    if (doc.extraBlocks[type] === undefined) {
                        doc.extraBlocks[type] = [];
                    }
                    doc.extraBlocks[type].push({ ...block.fields });
                    break;
            }
        });

        for (const [key, value] of Object.entries(ast.fields ?? Object.create(null))) {
            doc.metadata[key] = value;
        }

        return doc;
    }

    /**
     * Converts an editor map document into a UDMF syntax tree.
     *
     * @param {Object} doc - Document data.
     * @returns {Object} UDMF syntax tree.
     */
    static documentToUdmfAst(doc) {
        const ast = {
            namespace: MapTransformer.PORT_TO_UDMF_NAMESPACE.get(doc.port) ?? 'zdoom',
            fields: { ...doc.metadata },
            blocks: [],
        };

        const push = (type, list) => {
            for (const entry of list) {
                ast.blocks.push({
                    type,
                    fields: { ...entry },
                });
            }
        };

        push('vertex', doc.vertexes);
        push('sidedef', doc.sidedefs);
        push('linedef', doc.linedefs);
        push('sector', doc.sectors);
        push('thing', doc.things);

        for (const [type, list] of Object.entries(doc.extraBlocks)) {
            push(type, list);
        }

        return ast;
    }

    /**
     * Converts classic Doom-format map lumps into an editor document.
     *
     * @param {Object} data - Map lump data.
     * @returns {Object} Document data.
     */
    static doomLumpsToDocument(data) {
        const doc = {
            port: data.port ?? 'doom_wad',

            vertexes: [],
            linedefs: [],
            sidedefs: [],
            sectors: [],
            things: [],

            metadata: Object.create(null),
            extraBlocks: Object.create(null),
        };

        doc.vertexes = data.vertexes !== null ? MapTransformer.#parseDoomVertices(data.vertexes) : [];
        doc.sidedefs = data.sidedefs !== null ? MapTransformer.#parseDoomSideDefs(data.sidedefs) : [];
        doc.linedefs = data.linedefs !== null ? MapTransformer.#parseDoomLineDefs(data.linedefs) : [];
        doc.sectors = data.sectors !== null ? MapTransformer.#parseDoomSectors(data.sectors) : [];
        doc.things = data.things !== null ? MapTransformer.#parseDoomThings(data.things) : [];

        return doc;
    }

    /**
     * Converts an editor document into classic Doom-format map lumps.
     *
     * @param {Object} doc - Document data.
     * @returns {Object} Map lump data.
     */
    static documentToDoomLumps(doc) {
        return {
            port: doc.port,

            vertexes: MapTransformer.#writeDoomVertices(doc.vertexes),
            sidedefs: MapTransformer.#writeDoomSideDefs(doc.sidedefs),
            linedefs: MapTransformer.#writeDoomLineDefs(doc.linedefs),
            sectors: MapTransformer.#writeDoomSectors(doc.sectors),
            things: MapTransformer.#writeDoomThings(doc.things),
        };
    }

    /**
     * Converts Hexen-format map lumps into an editor document.
     *
     * @param {Object} data - Map lump data.
     * @returns {Object} Document data.
     */
    static hexenLumpsToDocument(data) {
        const doc = {
            port: data.port ?? 'hexen_wad',

            vertexes: [],
            linedefs: [],
            sidedefs: [],
            sectors: [],
            things: [],

            metadata: Object.create(null),
            extraBlocks: Object.create(null),
        };

        doc.vertexes = data.vertexes !== null ? MapTransformer.#parseDoomVertices(data.vertexes) : [];
        doc.sidedefs = data.sidedefs !== null ? MapTransformer.#parseDoomSideDefs(data.sidedefs) : [];
        doc.linedefs = data.linedefs !== null ? MapTransformer.#parseHexenLineDefs(data.linedefs) : [];
        doc.sectors = data.sectors !== null ? MapTransformer.#parseDoomSectors(data.sectors) : [];
        doc.things = data.things !== null ? MapTransformer.#parseHexenThings(data.things) : [];

        return doc;
    }

    /**
     * Converts an editor document into Hexen-format map lumps.
     *
     * @param {Object} doc - Document data.
     * @returns {Object} Map lump data.
     */
    static documentToHexenLumps(doc) {
        return {
            port: doc.port,

            vertexes: MapTransformer.#writeDoomVertices(doc.vertexes),
            sidedefs: MapTransformer.#writeDoomSideDefs(doc.sidedefs),
            linedefs: MapTransformer.#writeHexenLineDefs(doc.linedefs),
            sectors: MapTransformer.#writeDoomSectors(doc.sectors),
            things: MapTransformer.#writeHexenThings(doc.things),
        };
    }

    /**
     * Serializes a map document into a complete PWAD.
     *
     * UDMF documents produce MAP, TEXTMAP, and ENDMAP lumps.
     *
     * Binary maps produce the standard THINGS, LINEDEFS, SIDEDEFS, VERTEXES, and SECTORS lumps,
     * plus BEHAVIOR for Hexen-format maps.
     *
     * @param {Object} doc - Document data.
     * @param {string} mapName - Map header lump name.
     * @returns {Uint8Array} PWAD file data.
     */
    static documentToWadBytes(doc, mapName) {
        let lumps = [];

        const format = MapTransformer.PORT_EXPORT_FORMAT.get(doc.port);

        switch (format) {
            case 'udmf':
                const ast = MapTransformer.documentToUdmfAst(doc);
                const text = UdmfParser.serialize(ast);

                lumps = [{
                    name: mapName,
                    data: new Uint8Array(0),
                }, {
                    name: 'TEXTMAP',
                    data: new TextEncoder().encode(text),
                }, {
                    name: 'ENDMAP',
                    data: new Uint8Array(0),
                }];

                break;

            case 'wad':
                const isHexenWad = doc.port === 'hexen_wad'
                    || doc.port === 'zdoom_hexen_wad'
                    || doc.port === 'gzdoom_hexen_wad';

                const mapLumps = isHexenWad
                    ? MapTransformer.documentToHexenLumps(doc)
                    : MapTransformer.documentToDoomLumps(doc);

                lumps = [{
                    name: mapName,
                    data: new Uint8Array(0),
                }, {
                    name: 'THINGS',
                    data: mapLumps.things,
                }, {
                    name: 'LINEDEFS',
                    data: mapLumps.linedefs,
                }, {
                    name: 'SIDEDEFS',
                    data: mapLumps.sidedefs,
                }, {
                    name: 'VERTEXES',
                    data: mapLumps.vertexes,
                }, {
                    name: 'SECTORS',
                    data: mapLumps.sectors,
                }];

                if (isHexenWad) {
                    lumps.push({
                        name: 'BEHAVIOR',
                        data: new Uint8Array(0),
                    });
                }

                break;

            default:
                throw new Error(`Invalid format "${format}"`);
        }

        let dataOffset = 12;

        lumps.forEach(lump => {
            lump.offset = dataOffset;
            dataOffset += lump.data.byteLength;
        });

        const directoryOffset = dataOffset;
        const wadByteLength = directoryOffset + lumps.length * 16;

        const bytes = new Uint8Array(wadByteLength);
        const view = new DataView(bytes.buffer);
        const encoder = new TextEncoder();

        bytes.set(encoder.encode('PWAD'), 0);
        view.setInt32(4, lumps.length, true);
        view.setInt32(8, directoryOffset, true);

        lumps.forEach((lump, i) => {
            bytes.set(lump.data, lump.offset);

            const entryOffset = directoryOffset + i * 16;

            view.setInt32(entryOffset + 0, lump.offset, true);
            view.setInt32(entryOffset + 4, lump.data.byteLength, true);

            bytes.set(encoder.encode(lump.name.slice(0, 8)), entryOffset + 8);
        });

        return bytes;
    }

    /**
     * Parses classic Doom VERTEXES lump data.
     *
     * @param {Uint8Array} data - Raw VERTEXES lump data.
     * @returns {Array<{x: number, y: number}>} Vertices.
     */
    static #parseDoomVertices(data) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        const count = Math.floor(data.byteLength / 4);
        const out = new Array(count);

        for (let i = 0; i < count; i++) {
            const x = view.getInt16(i * 4 + 0, true);
            const y = view.getInt16(i * 4 + 2, true);
            out[i] = { x: x, y: y };
        }

        return out;
    }

    /**
     * Serializes vertices into classic Doom VERTEXES lump data.
     *
     * @param {Array<object>} vertices - Vertex entries.
     * @returns {Uint8Array} Raw VERTEXES lump data.
     */
    static #writeDoomVertices(vertices) {
        const buffer = new ArrayBuffer(vertices.length * 4);
        const view = new DataView(buffer);

        for (let i = 0; i < vertices.length; i++) {
            const offset = i * 4;
            const vertex = vertices[i];

            view.setInt16(offset + 0, vertex.x ?? 0, true);
            view.setInt16(offset + 2, vertex.y ?? 0, true);
        }

        return new Uint8Array(buffer);
    }

    /**
     * Parses classic Doom SIDEDEFS lump data.
     *
     * @param {Uint8Array} data - Raw SIDEDEFS lump data.
     * @returns {Array<object>} Sidedefs.
     */
    static #parseDoomSideDefs(data) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const decoder = new TextDecoder();

        const count = Math.floor(data.byteLength / 30);
        const out = new Array(count);

        for (let i = 0; i < count; i++) {
            const offset = i * 30;
            const xoffset = view.getInt16(offset + 0, true);
            const yoffset = view.getInt16(offset + 2, true);
            const texturetop = decoder.decode(data.slice(offset + 4, offset + 12)).replace(/\0+$/, '');
            const texturebottom = decoder.decode(data.slice(offset + 12, offset + 20)).replace(/\0+$/, '');
            const texturemiddle = decoder.decode(data.slice(offset + 20, offset + 28)).replace(/\0+$/, '');
            const sector = view.getInt16(offset + 28, true);

            out[i] = {
                xoffset,
                yoffset,
                texturetop,
                texturebottom,
                texturemiddle,
                sector,
            };
        }

        return out;
    }


    /**
     * Serializes sidedefs into classic Doom SIDEDEFS lump data.
     *
     * @param {Array<object>} sidedefs - Sidedef entries.
     * @returns {Uint8Array} Raw SIDEDEFS lump data.
     */
    static #writeDoomSideDefs(sidedefs) {
        const buffer = new ArrayBuffer(sidedefs.length * 30);
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);

        for (let i = 0; i < sidedefs.length; i++) {
            const offset = i * 30;
            const side = sidedefs[i];

            view.setInt16(offset + 0, side.xoffset ?? 0, true);
            view.setInt16(offset + 2, side.yoffset ?? 0, true);

            MapTransformer.#writeFixedString(bytes, offset + 4, 8, side.texturetop);
            MapTransformer.#writeFixedString(bytes, offset + 12, 8, side.texturebottom);
            MapTransformer.#writeFixedString(bytes, offset + 20, 8, side.texturemiddle);

            view.setInt16(offset + 28, side.sector ?? 0, true);
        }

        return bytes;
    }

    /**
     * Parses classic Doom LINEDEFS lump data.
     *
     * @param {Uint8Array} data - Raw LINEDEFS lump data.
     * @returns {Array<object>} Linedefs.
     */
    static #parseDoomLineDefs(data) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        const count = Math.floor(data.byteLength / 14);
        const out = new Array(count);

        for (let i = 0; i < count; i++) {
            const offset = i * 14;

            const v1 = view.getUint16(offset + 0, true);
            const v2 = view.getUint16(offset + 2, true);
            const flags = view.getUint16(offset + 4, true);
            const special = view.getUint16(offset + 6, true);
            const tag = view.getUint16(offset + 8, true);
            const sidefront = view.getInt16(offset + 10, true);
            const sideback = view.getInt16(offset + 12, true);

            out[i] = {
                v1,
                v2,
                flags,
                special,
                tag,
                sidefront,
                sideback,
            };
        }

        return out;
    }

    /**
     * Serializes linedefs into classic Doom LINEDEFS lump data.
     *
     * @param {Array<object>} linedefs - Linedef entries.
     * @returns {Uint8Array} Raw LINEDEFS lump data.
     */
    static #writeDoomLineDefs(linedefs) {
        const buffer = new ArrayBuffer(linedefs.length * 14);
        const view = new DataView(buffer);

        for (let i = 0; i < linedefs.length; i++) {
            const offset = i * 14;
            const line = linedefs[i];

            view.setUint16(offset + 0, line.v1 ?? 0, true);
            view.setUint16(offset + 2, line.v2 ?? 0, true);
            view.setUint16(offset + 4, line.flags ?? 0, true);
            view.setUint16(offset + 6, line.special ?? 0, true);
            view.setUint16(offset + 8, line.tag ?? 0, true);
            view.setInt16(offset + 10, line.sidefront ?? -1, true);
            view.setInt16(offset + 12, line.sideback ?? -1, true);
        }

        return new Uint8Array(buffer);
    }

    /**
     * Parses Hexen-format LINEDEFS lump data.
     *
     * @param {Uint8Array} data - Raw Hexen LINEDEFS lump data.
     * @returns {Array<object>} Linedefs.
     */
    static #parseHexenLineDefs(data) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        const count = Math.floor(data.byteLength / 16);
        const out = new Array(count);

        for (let i = 0; i < count; i++) {
            const offset = i * 16;

            const v1 = view.getUint16(offset + 0, true);
            const v2 = view.getUint16(offset + 2, true);
            const flags = view.getUint16(offset + 4, true);
            const special = view.getUint8(offset + 6);

            const sidefront = view.getInt16(offset + 12, true);
            const sideback = view.getInt16(offset + 14, true);

            out[i] = {
                v1,
                v2,
                flags,
                special,
                arg0: view.getUint8(offset + 7),
                arg1: view.getUint8(offset + 8),
                arg2: view.getUint8(offset + 9),
                arg3: view.getUint8(offset + 10),
                arg4: view.getUint8(offset + 11),
                sidefront,
                sideback,
            };
        }

        return out;
    }

    /**
     * Serializes linedefs into Hexen-format LINEDEFS lump data.
     *
     * @param {Array<object>} linedefs - Linedef entries.
     * @returns {Uint8Array} Raw Hexen LINEDEFS lump data.
     */
    static #writeHexenLineDefs(linedefs) {
        const buffer = new ArrayBuffer(linedefs.length * 16);
        const view = new DataView(buffer);

        for (let i = 0; i < linedefs.length; i++) {
            const offset = i * 16;
            const line = linedefs[i];

            view.setUint16(offset + 0, line.v1 ?? 0, true);
            view.setUint16(offset + 2, line.v2 ?? 0, true);
            view.setUint16(offset + 4, line.flags ?? 0, true);
            view.setUint8(offset + 6, line.special ?? 0);

            for (let j = 0; j < 5; j++) {
                view.setUint8(offset + 7 + j, line[`arg${j}`] ?? 0);
            }

            view.setInt16(offset + 12, line.sidefront ?? -1, true);
            view.setInt16(offset + 14, line.sideback ?? -1, true);
        }

        return new Uint8Array(buffer);
    }

    /**
     * Parses classic Doom SECTORS lump data.
     *
     * @param {Uint8Array} data - Raw SECTORS lump data.
     * @returns {Array<object>} Sectors.
     */
    static #parseDoomSectors(data) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const decoder = new TextDecoder();

        const count = Math.floor(data.byteLength / 26);
        const out = new Array(count);

        for (let i = 0; i < count; i++) {
            const offset = i * 26;
            const heightfloor = view.getInt16(offset + 0, true);
            const heightceiling = view.getInt16(offset + 2, true);
            const texturefloor = decoder.decode(data.slice(offset + 4, offset + 12)).replace(/\0+$/, '');
            const textureceiling = decoder.decode(data.slice(offset + 12, offset + 20)).replace(/\0+$/, '');
            const lightlevel = view.getInt16(offset + 20, true);
            const special = view.getInt16(offset + 22, true);
            const tag = view.getInt16(offset + 24, true);

            out[i] = {
                heightfloor,
                heightceiling,
                texturefloor,
                textureceiling,
                lightlevel,
                special,
                tag,
            };
        }

        return out;
    }

    /**
     * Serializes sectors into classic Doom SECTORS lump data.
     *
     * @param {Array<object>} sectors - Sector entries.
     * @returns {Uint8Array} Raw SECTORS lump data.
     */
    static #writeDoomSectors(sectors) {
        const buffer = new ArrayBuffer(sectors.length * 26);
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);

        for (let i = 0; i < sectors.length; i++) {
            const offset = i * 26;
            const sector = sectors[i];

            view.setInt16(offset + 0, sector.heightfloor ?? 0, true);
            view.setInt16(offset + 2, sector.heightceiling ?? 0, true);

            MapTransformer.#writeFixedString(bytes, offset + 4, 8, sector.texturefloor ?? 'FLOOR0');
            MapTransformer.#writeFixedString(bytes, offset + 12, 8, sector.textureceiling ?? 'CEIL1');

            view.setInt16(offset + 20, sector.lightlevel ?? 0, true);
            view.setInt16(offset + 22, sector.special ?? 0, true);
            view.setInt16(offset + 24, sector.tag ?? 0, true);
        }

        return bytes;
    }

    /**
     * Parses classic Doom THINGS lump data.
     *
     * @param {Uint8Array} data - Raw THINGS lump data.
     * @returns {Array<object>} Things.
     */
    static #parseDoomThings(data) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        const count = Math.floor(data.byteLength / 10);
        const out = new Array(count);

        for (let i = 0; i < count; i++) {
            const offset = i * 10;

            const x = view.getInt16(offset + 0, true);
            const y = view.getInt16(offset + 2, true);
            const angle = view.getUint16(offset + 4, true);
            const type = view.getUint16(offset + 6, true);
            const flags = view.getUint16(offset + 8, true);

            out[i] = {
                x,
                y,
                z: 0,
                angle,
                type,
                flags,
            };
        }

        return out;
    }

    /**
     * Serializes things into classic Doom THINGS lump data.
     *
     * @param {Array<object>} things - Thing entries.
     * @returns {Uint8Array} Raw THINGS lump data.
     */
    static #writeDoomThings(things) {
        const buffer = new ArrayBuffer(things.length * 10);
        const view = new DataView(buffer);

        for (let i = 0; i < things.length; i++) {
            const offset = i * 10;
            const thing = things[i];

            view.setInt16(offset + 0, thing.x ?? 0, true);
            view.setInt16(offset + 2, thing.y ?? 0, true);
            view.setUint16(offset + 4, thing.angle ?? 0, true);
            view.setUint16(offset + 6, thing.type ?? 0, true);
            view.setUint16(offset + 8, thing.flags ?? 0, true);
        }

        return new Uint8Array(buffer);
    }

    /**
     * Parses Hexen-format THINGS lump data.
     *
     * @param {Uint8Array} data - Raw Hexen THINGS lump data.
     * @returns {Array<object>} Things.
     */
    static #parseHexenThings(data) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        const count = Math.floor(data.byteLength / 20);
        const out = new Array(count);

        for (let i = 0; i < count; i++) {
            const offset = i * 20;

            const tid = view.getInt16(offset + 0, true);
            const x = view.getInt16(offset + 2, true);
            const y = view.getInt16(offset + 4, true);
            const height = view.getInt16(offset + 6, true);
            const angle = view.getUint16(offset + 8, true);
            const type = view.getUint16(offset + 10, true);
            const flags = view.getUint16(offset + 12, true);
            const special = view.getUint8(offset + 14);

            out[i] = {
                tid,
                x,
                y,
                height,
                angle,
                type,
                flags,
                special,
                arg0: view.getUint8(offset + 15),
                arg1: view.getUint8(offset + 16),
                arg2: view.getUint8(offset + 17),
                arg3: view.getUint8(offset + 18),
                arg4: view.getUint8(offset + 19),
            };
        }

        return out;
    }

    /**
     * Serializes things into Hexen-format THINGS lump data.
     *
     * @param {Array<object>} things - Thing entries.
     * @returns {Uint8Array} Raw Hexen THINGS lump data.
     */
    static #writeHexenThings(things) {
        const buffer = new ArrayBuffer(things.length * 20);
        const view = new DataView(buffer);

        for (let i = 0; i < things.length; i++) {
            const offset = i * 20;
            const thing = things[i];

            view.setInt16(offset + 0, thing.tid ?? 0, true);
            view.setInt16(offset + 2, thing.x ?? 0, true);
            view.setInt16(offset + 4, thing.y ?? 0, true);
            view.setInt16(offset + 6, thing.height ?? 0, true);
            view.setUint16(offset + 8, thing.angle ?? 0, true);
            view.setUint16(offset + 10, thing.type ?? 0, true);
            view.setUint16(offset + 12, thing.flags ?? 0, true);
            view.setUint8(offset + 14, thing.special ?? 0);

            for (let j = 0; j < 5; j++) {
                view.setUint8(offset + 15 + j, thing[`arg${j}`] ?? 0);
            }
        }

        return new Uint8Array(buffer);
    }

    /**
     * Writes a null-padded fixed-length string into a byte array.
     * Characters beyond the requested length are truncated.
     *
     * @param {Uint8Array} bytes - Destination byte array.
     * @param {number} offset - Destination byte offset.
     * @param {number} length - Fixed string length.
     * @param {string} [text=''] - Text to write.
     */
    static #writeFixedString(bytes, offset, length, text = '') {
        for (let i = 0; i < length; i++) {
            bytes[offset + i] = i < text.length ? text.charCodeAt(i) : 0;
        }
    }
}
