import BaseProperties from './baseproperties.class.js';
import DoomMap from './doommap.class.js';
import DoomMaterial from './doommaterial.class.js';
import Line from './geometries/line.class.js';
import Sector from './geometries/sector.class.js';
import Thing from './geometries/thing.class.js';
import { io } from './lib/socket.io.esm.min.js';
import MapTransformer from './wad/maptransformer.class.js';
import ResourceUtility from './wad/resourceutility.class.js';
import UdmfParser from './wad/udmfparser.class.js';
import Utility from './utility.class.js';

/**
 * Browser interface for map editing, resource management and multiplayer controls.
 */
export default class Interface {
    /** @type {Map<string, string>} Background colors used to visually distinguish thing categories. */
    static #CATEGORY_COLORS = new Map([
        ['Player', 'rgba(70, 130, 180, 0.18)'],
        ['Special', 'rgba(147, 112, 219, 0.18)'],
        ['Key', 'rgba(255, 215, 0, 0.18)'],
        ['Monster', 'rgba(220, 20, 60, 0.18)'],
        ['Weapon', 'rgba(255, 140, 0, 0.18)'],
        ['Ammo', 'rgba(205, 133, 63, 0.18)'],
        ['Health', 'rgba(50, 205, 50, 0.18)'],
        ['Armor', 'rgba(30, 144, 255, 0.18)'],
        ['Powerup', 'rgba(0, 206, 209, 0.18)'],
        ['Decoration', 'rgba(128, 128, 128, 0.12)'],
    ]);

    /** @type {?ResourceManager} Resource manager. */
    #resourceManager = null;
    /** @type {?DoomMap} Edited map. */
    #doomMap = null;
    /** @type {?Client} Multiplayer client. */
    #client = null;

    /** @type {boolean} Whether an inspector update is already scheduled. */
    #pendingInspectorUpdate = false;

    /** @type {Set<Geometry>} Currently selected geometries. */
    #selection = new Set();
    /** @type {Set<Line>} Selected front sides. */
    #selectedFront = new Set();
    /** @type {Set<Line>} Selected back sides. */
    #selectedBack = new Set();

    /** @type {Object} Textures copied from selected surfaces. */
    #copiedTextures = {
        texture: null,
        flat: null,
    };

    /** @type {Object} Cached HTML elements. */
    #elements = {
        buttonLoadMiniwad: null,
        buttonLoadWad: null,
        buttonLoadPk3: null,
        buttonClearAll: null,
        buttonLoadMap: null,
        buttonClearMap: null,
        buttonLoadUdmf: null,
        buttonSaveMap: null,

        containerTextures: null,
        containerFlats: null,
        containerThings: null,
        containerSounds: null,

        filterTextures: null,
        filterFlats: null,
        filterThings: null,

        inspectorMap: null,
        inspectorLine: null,
        inspectorSideFront: null,
        inspectorSideBack: null,
        inspectorSector: null,
        inspectorThing: null,

        propertiesMap: null,
        propertiesLine: null,
        propertiesSideFront: null,
        propertiesSideBack: null,
        propertiesThing: null,
        propertiesSector: null,
    };

    /**
     * @param {ResourceManager} resourceManager - Resource manager.
     * @param {DoomMap} doomMap - Map being edited.
     * @param {Editor3D} editor3d - 3D editor.
     * @param {VectorEditor} vectorEditor - 2D vector editor.
     * @param {Client} client - Multiplayer client.
     */
    constructor(resourceManager, doomMap, editor3d, vectorEditor, client) {
        this.#resourceManager = resourceManager;
        this.#doomMap = doomMap;
        this.#client = client;

        const map3d = editor3d.map3d;

        // Cache elements
        this.#elements.buttonLoadMiniwad = document.querySelector('.wad-button__load-miniwad');
        this.#elements.buttonLoadWad = document.querySelector('.wad-button__load-wad');
        this.#elements.buttonLoadPk3 = document.querySelector('.wad-button__load-pk3');
        this.#elements.buttonClearAll = document.querySelector('.wad-button__clear-all');
        this.#elements.buttonLoadMap = document.querySelector('.map-button__load-map');
        this.#elements.buttonClearMap = document.querySelector('.map-button__clear-map');
        this.#elements.buttonLoadUdmf = document.querySelector('.map-button__load-udmf');
        this.#elements.buttonSaveMap = document.querySelector('.map-button__save-map');

        this.#elements.containerTextures = document.querySelector('.panel-textures .gallery');
        this.#elements.containerFlats = document.querySelector('.panel-flats .gallery');
        this.#elements.containerThings = document.querySelector('.panel-things .gallery');
        this.#elements.containerSounds = document.querySelector('.panel-sounds select');

        this.#elements.filterTextures = document.querySelector('.panel-textures input');
        this.#elements.filterFlats = document.querySelector('.panel-flats input');
        this.#elements.filterThings = document.querySelector('.panel-things input');

        this.#elements.inspectorMap = document.querySelector('.inspector__map');
        this.#elements.inspectorLine = document.querySelector('.inspector__line');
        this.#elements.inspectorSideFront = document.querySelector('.inspector__side-front');
        this.#elements.inspectorSideBack = document.querySelector('.inspector__side-back');
        this.#elements.inspectorSector = document.querySelector('.inspector__sector');
        this.#elements.inspectorThing = document.querySelector('.inspector__thing');

        this.#elements.propertiesMap = document.querySelector('.inspector__map .property-table');
        this.#elements.propertiesLine = document.querySelector('.inspector__line .property-table');
        this.#elements.propertiesSideFront = document.querySelector('.inspector__side-front .property-table');
        this.#elements.propertiesSideBack = document.querySelector('.inspector__side-back .property-table');
        this.#elements.propertiesSector = document.querySelector('.inspector__sector .property-table');
        this.#elements.propertiesThing = document.querySelector('.inspector__thing .property-table');

        // Show / hide panels
        const panelToggleButtons = document.querySelectorAll('.sidebar__tab-buttons button');
        panelToggleButtons.forEach(button => {
            button.addEventListener('click', () => {
                panelToggleButtons.forEach(button2 => {
                    const visible = button === button2;
                    button2.classList.toggle('selected', visible);
                    const panel = document.querySelector(button2.dataset.panel);
                    panel.classList.toggle('panel--hidden', !visible);
                    if (document.activeElement) {
                        document.activeElement.blur();
                    }
                });
            });
        });

        // Expand / collapse inspector sections
        const inspectorToggleButtons = document.querySelectorAll('.inspector__toggle');
        inspectorToggleButtons.forEach(button => {
            button.addEventListener('click', () => {
                const section = button.closest('.inspector__section');
                const expanded = !section.classList.contains('inspector__section--expanded');
                section.classList.toggle('inspector__section--expanded', expanded);
                button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
                if (document.activeElement) {
                    document.activeElement.blur();
                }
            });
        });

        // Switch editing mode
        const modeButtons = document.querySelectorAll('.mode-button');
        modeButtons.forEach(button => {
            button.addEventListener('click', () => {
                vectorEditor.setMode(button.dataset.mode ?? null);
                if (document.activeElement) {
                    document.activeElement.blur();
                }
            });
        });

        // Redo / Undo
        const undo = () => {
            const bounds = client.undo();
            if (bounds !== null) {
                vectorEditor.focusBounds(bounds);
            }
        };
        const redo = () => {
            const bounds = client.redo();
            if (bounds !== null) {
                vectorEditor.focusBounds(bounds);
            }
        };
        document.querySelector('.editor-button__undo').addEventListener('click', undo);
        document.querySelector('.editor-button__redo').addEventListener('click', redo);

        // Map launcher socket
        const socket = io('http://127.0.0.1:38571', {
            transports: ['websocket'],
            autoConnect: false,
            reconnection: false,
        });

        socket.on('launched', () => {
            console.log('Doom launched');
        });

        socket.on('error', message => {
            console.error(`Doom launcher: ${message}`);
            alert(message);
        });

        socket.on('connect_error', () => {
            alert('Could not connect to Doom launcher. Is doom_launcher running?');
        });

        // Run map
        const run = async () => {
            const doc = this.#doomMap.export(this.#resourceManager);

            const bytes = MapTransformer.documentToWadBytes(doc, 'MAP01');

            let binary = '';

            const chunkSize = 0x8000;

            for (let offset = 0; offset < bytes.length; offset += chunkSize) {
                const chunk = bytes.subarray(offset, offset + chunkSize);
                binary += String.fromCharCode(...chunk);
            }

            const base64 = btoa(binary);
            const resourceNames = this.#resourceManager.lumpManager.sources.map(source => source.name);

            if (!socket.connected) {
                socket.connect();
            }

            socket.emit('launch', {
                resourceNames,
                mapName: 'MAP01',
                base64,
            });

            if (document.activeElement) {
                document.activeElement.blur();
            }
        };

        document.querySelector('.editor-button__run').addEventListener('click', () => run());

        // Show / hide inset viewport
        const buttonInsetShow = document.querySelector('.editor-button__inset');
        buttonInsetShow.addEventListener('click', () => {
            const selected = buttonInsetShow.classList.contains('selected');
            buttonInsetShow.classList.toggle('selected', !selected);
            document.querySelector('.editor__inset').style.visibility = selected ? 'hidden' : 'visible';
            if (document.activeElement) {
                document.activeElement.blur();
            }
        });

        // Show / hide shortcuts
        const buttonShortcuts = document.querySelector('.editor-button__shortcuts');
        buttonShortcuts.addEventListener('click', () => {
            const selected = buttonShortcuts.classList.contains('selected');
            buttonShortcuts.classList.toggle('selected', !selected);
            document.querySelector('.editor__shortcuts').style.visibility = selected ? 'hidden' : 'visible';
            if (document.activeElement) {
                document.activeElement.blur();
            }
        });

        // Show / hide texture fill
        const buttonTextures = document.querySelector('.editor-button__textures');
        buttonTextures.addEventListener('click', () => {
            const selected = buttonTextures.classList.contains('selected');
            buttonTextures.classList.toggle('selected', !selected);
            vectorEditor.showTextures = !selected;
            if (document.activeElement) {
                document.activeElement.blur();
            }
        });

        // Handle 2D / 3D viewport focus
        let focused2d = false;

        // Swap inset viewport
        const swapFocus = () => {
            focused2d = !focused2d;

            if (focused2d) {
                editor3d.setFocused(false);
                vectorEditor.setFocused(true);
            } else {
                editor3d.setFocused(true);
                vectorEditor.setFocused(false);
            }

            if (document.activeElement) {
                document.activeElement.blur();
            }
        };

        const buttonInsetSwap = document.querySelector('.editor-button__inset-swap');
        buttonInsetSwap.addEventListener('click', swapFocus);

        swapFocus();

        window.addEventListener('keydown', async e => {
            // Clear input on enter
            if (e.key === 'Enter') {
                e.preventDefault();
                e.target.blur();
                return;
            }

            // Switch tab (F1-F7)
            const functionKey = /^F([1-7])$/.exec(e.key);
            if (functionKey !== null) {
                const index = Number(functionKey[1]) - 1;
                const button = panelToggleButtons[index];

                if (button !== undefined) {
                    button.click();
                    e.preventDefault();
                }

                return;
            }

            // Do not hijack input boxes
            const active = document.activeElement;
            if (active.tagName === 'INPUT') {
                return;
            }

            switch (e.key) {
                case 'Escape':
                case ' ':
                    // Select mode / deselect all
                    vectorEditor.setMode(null);
                    this.#doomMap.select(null, 'deselect_all');

                    e.preventDefault();
                    break;

                case 'Tab':
                    // Switch between 3D / 2D
                    swapFocus();

                    e.preventDefault();
                    break;

                case 'Delete':
                    if (e.shiftKey) {
                        // Dissolve selected geometries
                        const selection = this.#doomMap.getSelection();
                        if (selection.size > 0) {
                            const operations = DoomMap.createDissolveOperations(selection);
                            if (operations.length > 0) {
                                this.#client.sendTransaction(operations);
                            }
                        }

                        e.preventDefault();
                    } else if (!e.ctrlKey) {
                        // Delete selected geometries
                        const selection = this.#doomMap.getSelection();
                        const exclusive = DoomMap.excludeNonExclusiveGeometries(selection);
                        const geometries = exclusive.size === 0 ? selection : exclusive;
                        const operations = DoomMap.createRemoveOperations(geometries);
                        if (operations.length > 0) {
                            this.#client.sendTransaction(operations);
                        }

                        e.preventDefault();
                    }
                    break;

                case 'b':
                    if (!e.ctrlKey && !e.shiftKey) {
                        // Rectangle mode
                        vectorEditor.setMode(vectorEditor.mode === 'rectangle' ? null : 'rectangle');

                        e.preventDefault();
                    }
                    break;

                case 'c':
                case 'C':
                    if (e.ctrlKey) {
                        // Serialize and copy selected geometries
                        const geometries = this.#doomMap.getSelection();
                        const data = DoomMap.serializeGeometries(geometries);
                        data.type = 'doom-geometries';
                        await navigator.clipboard.write([
                            new ClipboardItem({
                                'text/plain': new Blob([JSON.stringify(data)], { type: 'text/plain' }),
                            })
                        ]);

                        e.preventDefault();
                    } else if (e.shiftKey) {
                        // Copy the selected texture
                        this.#copiedTextures.texture = null;
                        this.#copiedTextures.flat = null;

                        const geometries = this.#doomMap.getSelection();

                        geometries.forEach(geometry => {
                            if (geometry instanceof Line) {
                                if (this.#copiedTextures.texture === null) {
                                    const sideProperties = this.#doomMap.isSelected(geometry, true)
                                        ? geometry.frontProperties
                                        : geometry.backProperties;

                                    const doubleSided =
                                        geometry.frontSector !== null &&
                                        !geometry.frontSector.properties.getValue('is_void') &&
                                        geometry.backSector !== null &&
                                        !geometry.backSector.properties.getValue('is_void');

                                    const property = !doubleSided
                                        ? 'texture_middle'
                                        : this.#doomMap.isSelected(geometry, null, null, true)
                                        ? 'texture_upper'
                                        : this.#doomMap.isSelected(geometry, null, null, null, null, true)
                                        ? 'texture_lower'
                                        : 'texture_middle';

                                    this.#copiedTextures.texture = sideProperties.getValue(property);
                                }
                            } else if (geometry instanceof Sector) {
                                for (const isUpper of [false, true]) {
                                    if (this.#copiedTextures.flat === null &&
                                        this.#doomMap.isSelected(geometry, null, null,
                                            isUpper ? true : null, null,
                                            isUpper ? null : true)) {
                                        this.#copiedTextures.flat = geometry.properties.getValue(
                                            isUpper ? 'ceiling_texture' : 'floor_texture'
                                        );
                                    }
                                }
                            }
                        });

                        e.preventDefault();
                    } else {
                        // Ellipse mode
                        vectorEditor.setMode('ellipse');

                        e.preventDefault();
                    }
                    break;

                case 'e':
                    if (!e.ctrlKey && !e.shiftKey) {
                        // Extrude mode
                        vectorEditor.setMode(
                            vectorEditor.mode !== 'extrude' ||
                            vectorEditor.subMode !== 0 ? 'extrude' : null);

                        e.preventDefault();
                    }
                    break;

                case 'f':
                    if (e.ctrlKey) {
                        // Flip the hovered line
                        const line = vectorEditor.hovered.line;
                        if (line !== null) {
                            const operations = [{
                                op: 'flipLine',
                                args: [
                                    line.v0.x, line.v0.y,
                                    line.v1.x, line.v1.y,
                                ],
                            }];
                            this.#client.sendTransaction(operations);
                        }

                        e.preventDefault();
                    } else if (!e.shiftKey) {
                        // Equalize height
                        const operations = [];

                        for (let i = 0; i < 2; i++) {
                            const property = i === 0 ? 'floor_height' : 'ceiling_height';

                            let sum = 0;
                            let count = 0;

                            const sectors = [];

                            this.#doomMap.iterateSectors(sector => {
                                if (this.#doomMap.isSelected(
                                    sector, null, null, i === 1 ? true : null, null, i === 0 ? true : null)) {
                                    sectors.push(sector);
                                    sum += sector.properties.getValue(property);
                                    count += 1;
                                }
                            });

                            sum = Math.round(sum / count);

                            sectors.forEach(sector => {
                                const line = sector.lines[0];
                                operations.push({
                                    op: 'setSectorPropertyBySide',
                                    args: [
                                        line.v0.x, line.v0.y,
                                        line.v1.x, line.v1.y,
                                        line.frontSector === sector,
                                        property,
                                        sum,
                                    ],
                                });
                            });
                        }

                        if (operations.length > 0) {
                            this.#client.sendTransaction(operations);
                        }

                        e.preventDefault();
                    }
                    break;

                case 'g':
                    if (!e.ctrlKey && !e.shiftKey) {
                        // Move mode
                        vectorEditor.setMode('move');

                        e.preventDefault();
                    }
                    break;

                case 'h':
                    if (!e.ctrlKey && !e.shiftKey) {
                        // Scale mode
                        vectorEditor.setMode('scale');

                        e.preventDefault();
                    }
                    break;

                case 'r':
                    if (!e.ctrlKey && !e.shiftKey) {
                        // Rotate mode
                        vectorEditor.setMode('rotate');

                        e.preventDefault();
                    }
                    break;

                case 'q':
                    if (!e.ctrlKey && !e.shiftKey) {
                        // Thing mode
                        vectorEditor.setMode(vectorEditor.mode === 'thing' ? null : 'thing');

                        e.preventDefault();
                    }
                    break;

                case 't':
                    if (!e.ctrlKey && !e.shiftKey) {
                        // Horizontal texture alignment
                        const operations = this.#doomMap.createTextureAlignmentOperations(true, false);
                        if (operations.length > 0) {
                            this.#client.sendTransaction(operations);
                        }

                        e.preventDefault();
                    }

                    break;

                case 'v':
                case 'V':
                    if (e.ctrlKey) {
                        // Paste from clipboard
                        const items = await navigator.clipboard.read();

                        for (const item of items) {
                            if (item.types.includes('text/plain')) {
                                const blob = await item.getType('text/plain');
                                const text = await blob.text();

                                const geometries = [];
                                try {
                                    const data = JSON.parse(text);
                                    if (data.type === 'doom-geometries') {
                                        const geometriesByType = DoomMap.deserializeGeometries(data);
                                        geometriesByType.vertices.forEach(vertex => {
                                            geometries.push(vertex);
                                        });
                                        geometriesByType.lines.forEach(line => {
                                            geometries.push(line);
                                        });
                                        geometriesByType.things.forEach(thing => {
                                            geometries.push(thing);
                                        });
                                    }
                                } catch {
                                    console.error('Problem parsing clipboard data');
                                    continue;
                                }
                                if (geometries.length > 0) {
                                    this.#doomMap.select(null, 'deselect_all');
                                    vectorEditor.setMode('move', geometries, true);
                                    break;
                                }
                            }
                        }

                        e.preventDefault();
                    } else if (e.shiftKey) {
                        const operations = [];
                        const geometries = this.#doomMap.getSelection();

                        geometries.forEach(geometry => {
                            if (geometry instanceof Line) {
                                if (this.#copiedTextures.texture === null) {
                                    return;
                                }

                                const doubleSided =
                                    geometry.frontSector !== null &&
                                    !geometry.frontSector.properties.getValue('is_void') &&
                                    geometry.backSector !== null &&
                                    !geometry.backSector.properties.getValue('is_void');

                                for (const isFront of [true, false]) {
                                    if (!this.#doomMap.isSelected(
                                        geometry,
                                        isFront ? true : null,
                                        isFront ? null : true
                                    )) {
                                        continue;
                                    }

                                    const sideProperties = isFront
                                        ? geometry.frontProperties
                                        : geometry.backProperties;

                                    const properties = [];

                                    if (!doubleSided) {
                                        properties.push('texture_middle');
                                    } else {
                                        if (this.#doomMap.isSelected(geometry, null, null, true)) {
                                            properties.push('texture_upper');
                                        }

                                        if (this.#doomMap.isSelected(geometry, null, null, null, true)) {
                                            properties.push('texture_middle');
                                        }

                                        if (this.#doomMap.isSelected(
                                            geometry, null, null, null, null, true
                                        )) {
                                            properties.push('texture_lower');
                                        }
                                    }

                                    properties.forEach(property => {
                                        if (sideProperties.getValue(property) ===
                                            this.#copiedTextures.texture) {
                                            return;
                                        }

                                        operations.push({
                                            op: 'setSideProperty',
                                            args: [
                                                geometry.v0.x,
                                                geometry.v0.y,
                                                geometry.v1.x,
                                                geometry.v1.y,
                                                isFront,
                                                property,
                                                this.#copiedTextures.texture,
                                                false,
                                            ],
                                        });
                                    });
                                }
                            } else if (geometry instanceof Sector) {
                                if (this.#copiedTextures.flat === null) {
                                    return;
                                }

                                for (const isUpper of [false, true]) {
                                    if (this.#doomMap.isSelected(geometry, null, null,
                                        isUpper ? true : null, null,
                                        isUpper ? null : true)) {
                                        const property = isUpper
                                            ? 'ceiling_texture'
                                            : 'floor_texture';

                                        if (geometry.properties.getValue(property) ===
                                            this.#copiedTextures.flat) {
                                            continue;
                                        }

                                        const line = geometry.lines[0];

                                        const isFront = line.frontSector === geometry;

                                        operations.push({
                                            op: 'setSectorPropertyBySide',
                                            args: [
                                                line.v0.x,
                                                line.v0.y,
                                                line.v1.x,
                                                line.v1.y,
                                                isFront,
                                                property,
                                                this.#copiedTextures.flat,
                                            ],
                                        });
                                    }
                                }
                            }
                        });

                        if (operations.length > 0) {
                            this.#client.sendTransaction(operations);
                        }

                        e.preventDefault();
                    } else {
                        // Line mode
                        vectorEditor.setMode(
                            vectorEditor.mode !== 'line' ||
                            vectorEditor.subMode !== 0 ? 'line' : null
                        );

                        e.preventDefault();
                    }
                    break;

                case 'x':
                    if (e.ctrlKey) {
                        // Serialize and cut selected geometries
                        const selection = this.#doomMap.getSelection();
                        const exclusive = DoomMap.excludeNonExclusiveGeometries(selection);
                        const geometries = exclusive.size === 0 ? selection : exclusive;
                        const data = DoomMap.serializeGeometries(selection);
                        data.type = 'doom-geometries';
                        await navigator.clipboard.write([
                            new ClipboardItem({
                                'text/plain': new Blob([JSON.stringify(data)], { type: 'text/plain' }),
                            })
                        ]);

                        if (geometries.size > 0) {
                            const operations = DoomMap.createRemoveOperations(geometries);
                            this.#client.sendTransaction(operations);
                        }

                        e.preventDefault();
                    } else if (!e.shiftKey) {
                        // Delete hovered geometry
                        if (vectorEditor.hovered.thing !== null) {
                            const operations = DoomMap.createRemoveOperations([vectorEditor.hovered.thing]);
                            if (operations.length > 0) {
                                this.#client.sendTransaction(operations);
                            }
                        } else if (vectorEditor.hovered.vertex !== null) {
                            const operations = DoomMap.createDissolveVertexOperations(
                                vectorEditor.hovered.vertex);
                            if (operations.length > 0) {
                                this.#client.sendTransaction(operations);
                            }
                        } else if (vectorEditor.hovered.line !== null) {
                            const operations = DoomMap.createRemoveOperations([vectorEditor.hovered.line]);
                            if (operations.length > 0) {
                                this.#client.sendTransaction(operations);
                            }
                        } else if (vectorEditor.hovered.sector !== null) {
                            const operations = DoomMap.createRemoveOperations([vectorEditor.hovered.sector]);
                            if (operations.length > 0) {
                                this.#client.sendTransaction(operations);
                            }
                        }

                        e.preventDefault();
                    }
                    break;

                case 'z':
                    if (e.ctrlKey) {
                        // Undo or rewind edit action
                        undo();
                        vectorEditor.rewindMode();

                        e.preventDefault();
                    }
                    break;

                case 'y':
                    if (e.ctrlKey) {
                        // Redo
                        redo();

                        e.preventDefault();
                    } else if (!e.shiftKey) {
                        // Vertical texture alignment
                        const operations = this.#doomMap.createTextureAlignmentOperations(false, true);
                        if (operations.length > 0) {
                            this.#client.sendTransaction(operations);
                        }
                    }
                    break;

                case 'n':
                case 'N':
                    if (!e.ctrlKey && !e.shiftKey) {
                        // Flip selection void
                        const geometries = this.#doomMap.getSelection();

                        let setVoid = null;

                        geometries.forEach(geometry => {
                            if (geometry instanceof Sector) {
                                if (setVoid === null) {
                                    setVoid = !geometry.properties.getValue('is_void');
                                }
                            }
                        });

                        const operations = [];

                        geometries.forEach(geometry => {
                            if (geometry instanceof Sector) {
                                if (geometry.properties.getValue('is_void') !== setVoid) {
                                    const line = geometry.lines[0];
                                    operations.push({
                                        op: 'setSectorPropertyBySide',
                                        args: [
                                            line.v0.x, line.v0.y,
                                            line.v1.x, line.v1.y,
                                            line.frontSector === geometry,
                                            'is_void',
                                            setVoid,
                                        ],
                                    });
                                }
                            }
                        });

                        if (operations.length > 0) {
                            this.#client.sendTransaction(operations);
                        }

                        e.preventDefault();
                    }
                    break;

                case '4':
                    if (!e.ctrlKey && !e.shiftKey) {
                        // Decrease snap grid
                        vectorEditor.snapSize = Math.max(1, vectorEditor.snapSize / 2);

                        e.preventDefault();
                    }
                    break;

                case '5':
                    if (!e.ctrlKey && !e.shiftKey) {
                        // Increase snap grid
                        vectorEditor.snapSize = Math.min(256, vectorEditor.snapSize * 2);

                        e.preventDefault();
                    }
                    break;
            }
        });

        // Create a gallery item (texture, flat, thing)
        const createGalleryItem = (imageData, label, name, selected = false, category = null) => {
            const figure = document.createElement('figure');
            figure.className = 'gallery__item' + (selected ? ' gallery__item--selected' : '');

            figure.dataset.filter = label.toLowerCase();
            figure.dataset.name = name;

            if (category !== null) {
                figure.dataset.category = category;

                const backgroundColor = Interface.#CATEGORY_COLORS.get(category);
                if (backgroundColor !== undefined) {
                    figure.style.backgroundColor = backgroundColor;
                }
            }

            const preview = document.createElement('div');
            preview.className = 'gallery__preview';

            if (imageData !== null) {
                const image = Utility.imageDataToCanvas(imageData);
                preview.style.backgroundImage = `url(${image.toDataURL()})`;
            }

            const caption = document.createElement('figcaption');
            caption.className = 'gallery__label';
            caption.textContent = label;

            figure.append(preview, caption);

            return figure;
        };

        // Apply a filter to the current gallery
        const applyGalleryFilter = (container, filterText) => {
            const query = filterText.trim().toLowerCase();
            const items = container.querySelectorAll('.gallery__item');

            items.forEach(item => {
                const match = query === '' || item.dataset.filter.includes(query);
                item.style.display = match ? '' : 'none';
            });
        };

        // Reverse select gallery item
        const selectGalleryItemByName = (container, name) => {
            const item = [...container.querySelectorAll('.gallery__item')].find(item =>
                item.dataset.name === String(name)
            );

            if (item === undefined) {
                return;
            }

            selectGalleryItem(container, item);

            item.scrollIntoView({
                block: 'center',
                inline: 'nearest',
            });
        };

        // Select a gallery item
        const selectGalleryItem = (container, item, selectCallback = null) => {
            container.querySelectorAll('.gallery__item--selected').forEach(element => {
                element.classList.remove('gallery__item--selected');
            });

            item.classList.add('gallery__item--selected');

            if (selectCallback !== null) {
                selectCallback(item);
            }
        };

        // Create gallery selectors
        this.#elements.containerTextures.addEventListener('click', e => {
            const item = e.target.closest('.gallery__item');
            if (item) {
                selectGalleryItem(this.#elements.containerTextures, item, selected => {
                    vectorEditor.setTextureName(selected.dataset.name);
                });
            }
        });

        this.#elements.containerFlats.addEventListener('click', e => {
            const item = e.target.closest('.gallery__item');
            if (item) {
                selectGalleryItem(this.#elements.containerFlats, item, selected => {
                    vectorEditor.setFlatName(selected.dataset.name);
                });
            }
        });

        this.#elements.containerThings.addEventListener('click', e => {
            const item = e.target.closest('.gallery__item');
            if (item) {
                selectGalleryItem(this.#elements.containerThings, item, selected => {
                    vectorEditor.setThingTypeId(parseInt(selected.dataset.name, 10));
                });
            }
        });

        this.#doomMap.addEventListener('select', event => {
            for (const geometry of event.detail.selection) {
                if (geometry instanceof Thing) {
                    selectGalleryItemByName(
                        this.#elements.containerThings,
                        geometry.properties.getValue('type')
                    );
                    return;
                }

                if (geometry instanceof Sector) {
                    if (this.#doomMap.isSelected(geometry, null, null, false, false, true)) {
                        selectGalleryItemByName(
                            this.#elements.containerFlats,
                            geometry.properties.getValue('floor_texture')
                        );
                        return;
                    }

                    if (this.#doomMap.isSelected(geometry, null, null, true, false, false)) {
                        selectGalleryItemByName(
                            this.#elements.containerFlats,
                            geometry.properties.getValue('ceiling_texture')
                        );
                        return;
                    }
                }

                if (geometry instanceof Line) {
                    const sides = [{
                        isFront: false,
                        isBack: true,
                        properties: geometry.backProperties,
                    }, {
                        isFront: true,
                        isBack: false,
                        properties: geometry.frontProperties,
                    }];

                    const textures = [{
                        isUpper: false,
                        isMiddle: false,
                        isLower: true,
                        key: 'texture_lower',
                    }, {
                        isUpper: true,
                        isMiddle: false,
                        isLower: false,
                        key: 'texture_upper',
                    }, {
                        isUpper: false,
                        isMiddle: true,
                        isLower: false,
                        key: 'texture_middle',
                    }];

                    for (const side of sides) {
                        for (const texture of textures) {
                            if (!this.#doomMap.isSelected(
                                geometry,
                                side.isFront,
                                side.isBack,
                                texture.isUpper,
                                texture.isMiddle,
                                texture.isLower
                            )) {
                                continue;
                            }

                            selectGalleryItemByName(
                                this.#elements.containerTextures,
                                side.properties.getValue(texture.key)
                            );
                            return;
                        }
                    }
                }
            }
        });

        // Create gallery filter listeners
        this.#elements.filterTextures.addEventListener('input', e => {
            applyGalleryFilter(this.#elements.containerTextures, e.target.value);
        });

        this.#elements.filterFlats.addEventListener('input', e => {
            applyGalleryFilter(this.#elements.containerFlats, e.target.value);
        });

        this.#elements.filterThings.addEventListener('input', e => {
            applyGalleryFilter(this.#elements.containerThings, e.target.value);
        });

        this.#elements.filterTextures.addEventListener('focus', e => {
            this.#elements.filterTextures.value = '';
            applyGalleryFilter(this.#elements.containerTextures, e.target.value);
        });

        this.#elements.filterFlats.addEventListener('focus', e => {
            this.#elements.filterFlats.value = '';
            applyGalleryFilter(this.#elements.containerFlats, e.target.value);
        });

        this.#elements.filterThings.addEventListener('focus', e => {
            this.#elements.filterThings.value = '';
            applyGalleryFilter(this.#elements.containerThings, e.target.value);
        });

        const mapSelect = document.querySelector('.panel-wad__maps');

        // Refresh WAD resources
        const refreshResources = async () => {
            await this.#resourceManager.refreshResources();

            const rows = document.querySelectorAll('.panel-wad .property-table tr td:nth-child(2)');
            rows[0].textContent = this.#resourceManager.lumpManager.sources.map(source => source.name).join('\n');
            rows[0].style.whiteSpace = 'pre-line';
            rows[1].textContent = this.#resourceManager.lumpManager.lumps.length;
            rows[2].textContent = this.#resourceManager.mapNames.length;
            rows[3].textContent = this.#resourceManager.textures.size;
            rows[4].textContent = this.#resourceManager.flats.size;
            rows[5].textContent = this.#resourceManager.thingDefinitions.length;

            while (mapSelect.firstChild) {
                mapSelect.removeChild(mapSelect.firstChild);
            }
            const mapNames = this.#resourceManager.mapNames;
            if (mapNames.length === 0) {
                const option = document.createElement('option');
                option.textContent = 'No maps found';
                option.disabled = true;
                mapSelect.appendChild(option);
            } else {
                mapNames.forEach(name => {
                    const option = document.createElement('option');
                    option.value = name;
                    option.textContent = name;
                    mapSelect.appendChild(option);
                });
            }

            this.#elements.containerTextures.innerHTML = '';
            this.#elements.containerFlats.innerHTML = '';
            this.#elements.containerThings.innerHTML = '';
            this.#elements.containerSounds.innerHTML = '';

            this.#elements.filterTextures.value = '';
            this.#elements.filterFlats.value = '';
            this.#elements.filterThings.value = '';

            vectorEditor.clearCaches();
            map3d.clearTextureCache();
            DoomMaterial.clearLuts();

            const palette = this.#resourceManager.palettes[0];

            let first = true;
            this.#resourceManager.textures.forEach((texture, name) => {
                const maskData = ResourceUtility.indexedImageToIndexMaskData(texture);
                map3d.addTexture(maskData, 'texture', name);

                const colorData = ResourceUtility.indexedImageToColorData(texture, palette);
                const item = createGalleryItem(colorData, name, name, first);
                this.#elements.containerTextures.appendChild(item);
                first = false;
            });

            first = true;
            this.#resourceManager.flats.forEach((flat, name) => {
                const maskData = ResourceUtility.indexedImageToIndexMaskData(flat);
                map3d.addTexture(maskData, 'flat', name);

                const colorData = ResourceUtility.indexedImageToColorData(flat, palette);
                const item = createGalleryItem(colorData, name, name, first);
                this.#elements.containerFlats.appendChild(item);
                first = false;
            });

            this.#resourceManager.sprites.forEach((sprite, name) => {
                const maskData = ResourceUtility.indexedImageToIndexMaskData(sprite);
                map3d.addTexture(maskData, 'sprite', name);
            });

            first = true;
            this.#resourceManager.thingDefinitions.forEach(definition => {
                if (definition.rotationAtlas !== null) {
                    const maskData = ResourceUtility.indexedImageToIndexMaskData(definition.rotationAtlas);
                    map3d.addTexture(maskData, 'thing', definition.id, 8);
                }

                const colorData = definition.rotationFrames[0] === null ? null :
                    ResourceUtility.indexedImageToColorData(definition.rotationFrames[0], palette);
                    const item = createGalleryItem(
                        colorData, definition.name, definition.id, first, definition.category
                    );
                this.#elements.containerThings.appendChild(item);
                first = false;
            });

            this.#resourceManager.soundNames.forEach(name => {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                this.#elements.containerSounds.appendChild(option);
            });

            map3d.refreshTextures();

            client.requestMap();
        };

        const setBusy = busy => {
            const app = document.querySelector('.app');
            const overlay = document.querySelector('.busy-overlay');

            app.inert = busy;
            app.setAttribute('aria-busy', String(busy));

            overlay.hidden = !busy;
            document.body.classList.toggle('busy', busy);
        };

        // Load MiniWAD file
        this.#elements.buttonLoadMiniwad.addEventListener('click', async () => {
            setBusy(true);

            const response = await fetch('./wad/miniwad.wad');
            const buffer = await response.arrayBuffer();

            this.#resourceManager.lumpManager.addSourceWad(buffer, 'miniwad.wad');

            await refreshResources();

            setBusy(false);
        });

        // Load WAD file
        const wadFileInput = document.createElement('input');
        wadFileInput.type = 'file';
        wadFileInput.accept = '.wad,application/octet-stream';
        wadFileInput.style.display = 'none';
        document.body.appendChild(wadFileInput);

        wadFileInput.addEventListener('change', async e => {
            const file = e.target.files && e.target.files[0];
            if (file) {
                const buffer = await file.arrayBuffer();
                setBusy(true);
                this.#resourceManager.lumpManager.addSourceWad(buffer, file.name);
                await refreshResources();
                setBusy(false);
            }
            wadFileInput.value = '';
        });

        this.#elements.buttonLoadWad.addEventListener('click', () => {
            wadFileInput.click();
        });

        // Load PK3 file
        const pk3FileInput = document.createElement('input');
        pk3FileInput.type = 'file';
        pk3FileInput.accept = '.pk3,application/octet-stream';
        pk3FileInput.style.display = 'none';
        document.body.appendChild(pk3FileInput);

        pk3FileInput.addEventListener('change', async e => {
            const file = e.target.files && e.target.files[0];
            if (file) {
                const buffer = await file.arrayBuffer();
                setBusy(true);
                await this.#resourceManager.lumpManager.addSourcePk3(buffer, file.name);
                await refreshResources();
                setBusy(false);
            }
            pk3FileInput.value = '';
        });

        this.#elements.buttonLoadPk3.addEventListener('click', () => {
            pk3FileInput.click();
        });

        // Clear loaded WAD files
        this.#elements.buttonClearAll.addEventListener('click', async () => {
            setBusy(true);
            this.#resourceManager.lumpManager.clearSources();
            await refreshResources();
            setBusy(false);
        });

        // Update player start position according to the map
        const updatePlayerStartPosition = () => {
            this.#doomMap.iterateThings(thing => {
                if (thing.properties.getValue('type') === 1) {
                    const angle = -thing.properties.getValue('angle') + 180;
                    editor3d.setCameraPosition(thing.x, thing.y, angle, true);
                    vectorEditor.setCameraPosition(thing.x, thing.y);
                }
            });
        };

        // Load selected map
        this.#elements.buttonLoadMap.addEventListener('click', () => {
            if (!this.#client.ownUser?.isAdmin) {
                alert('Only the admin can load maps');
                return;
            }

            const selectedMapName = mapSelect.value;
            if (!selectedMapName || selectedMapName === 'No maps') {
                return;
            }

            const doc = this.#resourceManager.loadMapAsDocument(selectedMapName);
            this.#doomMap.import(doc);
            updatePlayerStartPosition();

            this.#client.sendMap();
        });

        // Clear map
        this.#elements.buttonClearMap.addEventListener('click', () => {
            if (!this.#client.ownUser?.isAdmin) {
                alert('Only the admin can clear maps');
                return;
            }

            this.#doomMap.clear();
            this.#client.sendMap();
            this.#updateInspector();
        });

        // Load UDMF map
        const udmfFileInput = document.createElement('input');
        udmfFileInput.type = 'file';
        udmfFileInput.accept = '.txt,.udmf';
        udmfFileInput.style.display = 'none';
        document.body.appendChild(udmfFileInput);

        udmfFileInput.addEventListener('change', async e => {
            if (!this.#client.ownUser?.isAdmin) {
                alert('Only the admin can load maps');
                return;
            }

            const file = e.target.files && e.target.files[0];
            if (file) {
                const text = await file.text();
                const ast = UdmfParser.parse(text);
                const doc = MapTransformer.udmfAstToDocument(ast);

                this.#doomMap.import(doc);
                updatePlayerStartPosition();

                this.#client.sendMap();
            }

            udmfFileInput.value = '';
        });

        this.#elements.buttonLoadUdmf.addEventListener('click', () => {
            if (!this.#client.ownUser?.isAdmin) {
                alert('Only the admin can load maps');
                return;
            }

            udmfFileInput.click();
        });

        const downloadFile = (bytes, name) => {
            const blob = new Blob([bytes], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = name;
            a.click();
            URL.revokeObjectURL(url);
        };

        // Save map file
        this.#elements.buttonSaveMap.addEventListener('click', () => {
            const doc = this.#doomMap.export(this.#resourceManager);
            downloadFile(MapTransformer.documentToWadBytes(doc), `${doc.port}.wad`);
        });

        // User panel population
        const userList = document.querySelector('.panel-users__users');

        let pmTo = null;

        this.#client.addEventListener('users', e => {
            const { users, ownUser } = e.detail;

            userList.innerHTML = '';

            users.forEach(user => {
                const entry = document.createElement('div');
                entry.className = 'panel-users__item';
                if (user.isAdmin) {
                    entry.classList.add('panel-users__item--admin');
                }
                if (!user.connected) {
                    entry.classList.add('panel-users__item--disconnected');
                }

                const name = document.createElement('div');
                name.className = 'panel-users__name';
                name.textContent = user.username + (user.index === ownUser.index ? ' (You)' :
                    user.allowEditing ? ' (Editor)' : '');
                entry.appendChild(name);

                if (user !== ownUser) {
                    const makeButton = (label, title, clickCallback) => {
                        const button = document.createElement('button');
                        button.title = title;
                        button.className = 'panel-users__action';
                        button.textContent = label;
                        button.addEventListener('click', clickCallback);
                        return button;
                    };

                    // Private message
                    entry.appendChild(makeButton('PM', 'Send private message', () => {
                        pmTo = user;
                        chatTarget.innerText = 'to ' + user.username;

                        chatInput.focus();
                    }));

                    // Limit, kick and ban
                    if (ownUser.isAdmin) {
                        if (!user.allowEditing) {
                            entry.appendChild(makeButton('Allow', 'Allow editing', () => {
                                this.#client.setAllowEditing(user.index, true);
                            }));
                        } else {
                            entry.appendChild(makeButton('Forbid', 'Forbid editing', () => {
                                this.#client.setAllowEditing(user.index, false);
                            }));
                        }

                        entry.appendChild(makeButton('Kick', 'Kick user', () => {
                            if (confirm(`Kick user "${user.username}?"`)) {
                                this.#client.kickUser(user.index);
                            }
                        }));

                        entry.appendChild(makeButton('Ban', 'Ban user', () => {
                            if (confirm(`Ban user "${user.username}?"`)) {
                                this.#client.banUser(user.index);
                            }
                        }));
                    }
                }

                userList.appendChild(entry);
            });
        });

        // Chat handling
        const chatTarget = document.querySelector('.chat__target');
        const chatInput = document.querySelector('.chat__input');
        const chatLog = document.querySelector('.chat__log');

        this.#client.addEventListener('chat', e => {
            const { message, senderUsername, isAdmin, color, time } = e.detail;

            const entry = document.createElement('div');
            entry.className = 'chat__entry';
            entry.style.color = color;
            entry.textContent = `<${senderUsername}${isAdmin ? ' (admin)' : ''}> ${message}`;
            chatLog.appendChild(entry);

            const maxMessages = 20;

            while (chatLog.children.length > maxMessages) {
                chatLog.removeChild(chatLog.firstChild);
            }

            chatLog.scrollTop = chatLog.scrollHeight;
        });

        const setChatFadeEnabled = enabled => {
            chatLog.querySelectorAll('.chat__entry').forEach(entry => {
                if (enabled) {
                    entry.style.animation = 'none';
                    entry.offsetHeight;
                    entry.style.animation = '';
                } else {
                    entry.style.animation = 'none';
                    entry.style.opacity = 1;
                }
            });
        };

        chatInput.addEventListener('focus', () => setChatFadeEnabled(false));
        chatInput.addEventListener('click', () => setChatFadeEnabled(false));
        chatInput.addEventListener('keydown', () => setChatFadeEnabled(false));
        chatInput.addEventListener('blur', () => setChatFadeEnabled(true));

        chatInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                const message = chatInput.value.trim();
                if (message.length > 0) {
                    this.#client.chat(message, pmTo?.socketId ?? null);
                    chatInput.value = '';
                    setTimeout(() => chatInput.focus(), 0);
                }
                e.preventDefault();
            }
        });

        chatInput.addEventListener('blur', () => {
            chatInput.value = '';
            pmTo = null;
            chatTarget.innerText = '';
        });

        // Inspector updates due to map updates
        this.#doomMap.addEventListener('select', event => {
            this.#selection = new Set(event.detail.selection);
            this.#selectedFront = new Set(event.detail.selectedFront);
            this.#selectedBack = new Set(event.detail.selectedBack);
            this.#scheduleInspectorUpdate();
        });

        this.#doomMap.addEventListener('metadatachanged', () => {
            this.#scheduleInspectorUpdate();
        });

        this.#doomMap.addEventListener('linechanged', e => {
            if (this.#selection.has(e.detail.line)) {
                this.#scheduleInspectorUpdate();
            }
        });

        this.#doomMap.addEventListener('sidechanged', e => {
            if (this.#selection.has(e.detail.line) && (
                e.detail.isFront && this.#selectedFront.has(e.detail.line) ||
                !e.detail.isFront && this.#selectedBack.has(e.detail.line))) {
                this.#scheduleInspectorUpdate();
            }
        });

        this.#doomMap.addEventListener('sectorchanged', e => {
            if (this.#selection.has(e.detail.sector)) {
                this.#scheduleInspectorUpdate();
            }
        });

        this.#doomMap.addEventListener('thingchanged', e => {
            if (this.#selection.has(e.detail.thing)) {
                this.#scheduleInspectorUpdate();
            }
        });

        this.#scheduleInspectorUpdate();

        refreshResources();
    }

    /**
     * Schedules an inspector update for the next animation frame.
     */
    #scheduleInspectorUpdate() {
        if (this.#pendingInspectorUpdate) {
            return;
        }
        this.#pendingInspectorUpdate = true;

        requestAnimationFrame(() => {
            this.#updateInspector();
            this.#pendingInspectorUpdate = false;
        });
    }

    /**
     * Rebuilds the property inspector from the current selection.
     */
    #updateInspector() {
        const mapProperties = [this.#doomMap.metadata];
        const lineProperties = [];
        const sidePropertiesFront = [];
        const sidePropertiesBack = [];
        const sectorProperties = [];
        const thingProperties = [];

        this.#selection.forEach(g => {
            if (g instanceof Thing) {
                thingProperties.push(g.properties);
            } else if (g instanceof Sector) {
                sectorProperties.push(g.properties);
            } else if (g instanceof Line) {
                lineProperties.push(g.properties);
                if (this.#selectedFront.has(g) && g.frontSector !== null &&
                    !g.frontSector.properties.getValue('is_void')) {
                    sidePropertiesFront.push(g.frontProperties);
                }
                if (this.#selectedBack.has(g) && g.backSector !== null &&
                    !g.backSector.properties.getValue('is_void')) {
                    sidePropertiesBack.push(g.backProperties);
                }
            }
        });

        const showMapProperties = lineProperties.length === 0 && sidePropertiesFront.length === 0 &&
            sidePropertiesBack.length === 0 && sectorProperties.length === 0 && thingProperties.length === 0;

        this.#elements.inspectorMap.hidden = !showMapProperties;
        this.#elements.inspectorLine.hidden = lineProperties.length === 0;
        this.#elements.inspectorSideFront.hidden = sidePropertiesFront.length === 0;
        this.#elements.inspectorSideBack.hidden = sidePropertiesBack.length === 0;
        this.#elements.inspectorSector.hidden = sectorProperties.length === 0;
        this.#elements.inspectorThing.hidden = thingProperties.length === 0;

        const port = this.#doomMap.metadata.getValue('port');

        if (showMapProperties) {
            BaseProperties.createInspector(this.#resourceManager, mapProperties,
                this.#elements.propertiesMap, port, (key, value) => {
                this.#client.sendTransaction([{
                    op: 'setMapProperty',
                    args: [key, value],
                }]);
            });
        }

        if (lineProperties.length > 0) {
            BaseProperties.createInspector(this.#resourceManager, lineProperties,
                this.#elements.propertiesLine, port, (key, value) => {
                const operations = [];

                this.#selection.forEach(g => {
                    if (g instanceof Line) {
                        operations.push({
                            op: 'setLineProperty',
                            args: [g.v0.x, g.v0.y, g.v1.x, g.v1.y, key, value],
                        });
                    }
                });

                this.#client.sendTransaction(operations);
            });
        }

        if (sidePropertiesFront.length > 0) {
            BaseProperties.createInspector(this.#resourceManager, sidePropertiesFront,
                this.#elements.propertiesSideFront, port, (key, value) => {
                const operations = [];

                this.#selection.forEach(g => {
                    if (g instanceof Line && this.#selectedFront.has(g) && g.frontSector !== null &&
                    !g.frontSector.properties.getValue('is_void')) {
                        operations.push({
                            op: 'setSideProperty',
                            args: [g.v0.x, g.v0.y, g.v1.x, g.v1.y, true, key, value, false],
                        });
                    }
                });

                this.#client.sendTransaction(operations);
            });
        }

        if (sidePropertiesBack.length > 0) {
            BaseProperties.createInspector(this.#resourceManager, sidePropertiesBack,
                this.#elements.propertiesSideBack, port, (key, value) => {
                const operations = [];

                this.#selection.forEach(g => {
                    if (g instanceof Line && this.#selectedBack.has(g) && g.backSector !== null &&
                    !g.backSector.properties.getValue('is_void')) {
                        operations.push({
                            op: 'setSideProperty',
                            args: [g.v0.x, g.v0.y, g.v1.x, g.v1.y, false, key, value, false],
                        });
                    }
                });

                this.#client.sendTransaction(operations);
            });
        }

        if (sectorProperties.length > 0) {
            BaseProperties.createInspector(this.#resourceManager, sectorProperties,
                this.#elements.propertiesSector, port, (key, value) => {
                const operations = [];

                this.#selection.forEach(g => {
                    if (g instanceof Sector) {
                        const line = g.lines[0];
                        const isFront = line.frontSector === g;
                        operations.push({
                            op: 'setSectorPropertyBySide',
                            args: [line.v0.x, line.v0.y, line.v1.x, line.v1.y, isFront, key, value],
                        });
                    }
                });

                this.#client.sendTransaction(operations);
            });
        }

        if (thingProperties.length > 0) {
            BaseProperties.createInspector(this.#resourceManager, thingProperties,
                this.#elements.propertiesThing, port, (key, value) => {
                const operations = [];

                this.#selection.forEach(g => {
                    if (g instanceof Thing) {
                        operations.push({
                            op: 'setThingProperty',
                            args: [
                                g.x,
                                g.y,
                                g.properties.getValue('z'),
                                g.properties.getValue('type'),
                                g.properties.getValue('angle'),
                                key,
                                value,
                            ],
                        });
                    }
                });

                this.#client.sendTransaction(operations);
            });
        }

        window.createNumberScrubbers();
    }
}
