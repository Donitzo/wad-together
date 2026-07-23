import DoomMap from './doommap.class.js';
import Input from './input.class.js';
import Line from './geometries/line.class.js';
import Sector from './geometries/sector.class.js';
import Thing from './geometries/thing.class.js';
import Vertex from './geometries/vertex.class.js';
import Utility from './utility.class.js';
import ResourceUtility from './wad/resourceutility.class.js';

/**
 * Vector editor for Doom maps.
 */
export default class VectorEditor {
    /** @type {Object} Input sensitivity. */
    static #INPUT = {
        scroll: {
            mouseSpeed: 1.1,
            pinchSpeed: 0.005,
        },
        hover: {
            lineDistance: 20,
            vertexDistance: 25,
        },
    };

    /** @type {Object} Color theme used to render the editor. */
    static #THEME = {
        background: '#1c110a',

        boxSelect: {
            leftFill: '#00f4ff20',
            leftStroke: '#00f4ff',
            rightFill: '#fffa0020',
            rightStroke: '#fffa00',
        },

        gizmos: {
            drawFill: '#ffffff',
            commitFill: '#444444',
            pivotFill: '#ffff00',
            snapGridStroke: '#ff0000',
            snapGridAlpha: 0.2,
            textFill: '#ffffff80',
        },

        grid: {
            lines: '#2a1b1ba0',
            x: '#ff000080',
            y: '#00ff0040',
        },

        line: {
            floating: '#ff00af',
            guide: '#ffffff30',
            hover: '#ffffff',
            impassable: '#ca1600',
            inner: '#c8665a',
            outer: '#ff6811',
            selected: '#00f4ff',
            special: '#b93dc1',
        },

        vertex: {
            corner: '#ecd2ad70',
            outline: '#ecd2ad',
            fill: '#0f0804',
            hoverFill: '#ffffff',
            hoverOutline: '#0f0804',
            selectedFill: '#00f4ff',
            selectedOutline: '#00f4ff',
        },

        sector: {
            fill: '#b7450340',
            hoverSpecialFill: '#d843e260',
            hoverVoidFill: '#c14a4a80',
            hoverFill: '#a24e1c80',
            selectedFill: '#00f4ff40',
            selectedHoverFill: '#31f5ff60',
            selectedHoverVoidFill: '#e94c5960',
            selectedVoidFill: '#e94c5940',
            specialFill: '#93289a60',
            voidFill: '#c0000080',
        },

        thing: {
            outline: '#ff0000',
            fill: '#ff000010',
            hoverFill: '#a24e1c80',
            hoverOutline: '#ffffff',
            selectedFill: '#00f4ff40',
            selectedOutline: '#00f4ff',
            selectedHoverFill: '#31f5ff60',
            selectedHoverOutline: '#ffffff',
            shadow: '#00000020',
        },
    };

    /** @type {number} Number of subdivisions between major grid sizes. */
    static #GRID_SUBDIVISIONS = 8;
    /** @type {number} Padding around the editable map coordinate range. */
    static #MAP_BORDER_PADDING = 8;
    /** @type {number} Maximum camera zoom scale. */
    static #ZOOM_MAX = 32;

    /** @type {number} Canvas chunk size in pixels. */
    static #CANVAS_CHUNK_SIZE = 256;
    /** @type {number} Extra padding rendered around each chunk. */
    static #CANVAS_CHUNK_PADDING = 8;
    /** @type {number} Margin used when invalidating chunks. */
    static #CANVAS_CHUNK_DIRTY_MARGIN = 8;
    /** @type {number} Scale difference that forces all chunks to be repainted. */
    static #ZOOM_REPAINT_TOLERANCE = 0.15;

    /** @type {number} Brush-selection radius in pixels. */
    static #BRUSH_SELECT_SIZE = 24;

    /** @type {number} Thing bounding box size in map units. */
    static #THING_SIZE = 32;
    /** @type {number} Thing sprite size in map units. */
    static #THING_SPRITE_SIZE = 48;

    /** @type {number} Minimum mouse movement that starts a drag. */
    static #DRAG_START_LENGTH = 16;
    /** @type {boolean} Whether sectors can be dragged directly. */
    static #ALLOW_DRAG_SECTORS = false;

    /** @type {Map<string, HTMLCanvasElement>} Multiplayer cursors cached by color. */
    static #cursorByColor = new Map();

    /** @type {Array<Object>} Reusable offscreen canvas chunks. */
    static #chunkPool = [];

    /** @type {{x: number, y: number}} */
    static #tmpV20 = { x: 0, y: 0 };
    /** @type {{x: number, y: number}} */
    static #tmpV21 = { x: 0, y: 0 };
    /** @type {{x: number, y: number}} */
    static #tmpV22 = { x: 0, y: 0 };
    /** @type {{x: number, y: number}} */
    static #tmpV23 = { x: 0, y: 0 };
    /** @type {{x: number, y: number}} */
    static #tmpV24 = { x: 0, y: 0 };

    /** @type {Array<*>} */
    static #tmpDraw0 = [];
    /** @type {Array<*>} */
    static #tmpDraw1 = [];
    /** @type {Array<Geometry>} */
    static #tmpHover = [];

    /** @type {Map<number, HTMLCanvasElement>} Thing preview images cached by type ID. */
    #thingImageCache = new Map();

    /** @type {Map<object, CanvasPattern>} Flat patterns cached by flat data. */
    #flatPatternCache = new Map();

    /** @type {boolean} Whether the 2D editor currently has focus. */
    #focused = true;

    /** @type {?HTMLCanvasElement} Main editor canvas. */
    #canvas = null;
    /** @type {?CanvasRenderingContext2D} Main canvas rendering context. */
    #ctx = null;
    /** @type {{x: number, y: number}} Last canvas size. */
    #lastCanvasSize = { x: 0, y: 0 };

    /** @type {?HTMLElement} Editor status element. */
    #elementStatus = null;

    /** @type {Map<string, object>} Cached canvas chunks. */
    #canvasMap = new Map();

    /** @type {?ResourceManager} Resource manager. */
    #resourceManager = null;
    /** @type {?DoomMap} Map being edited. */
    #map = null;
    /** @type {?Client} Multiplayer client. */
    #client = null;
    /** @type {?Editor3D} 3D editor. */
    #editor3d = null;

    /** @type {boolean} */
    #showTextures = false;
    /** @type {boolean} Whether sector flats are rendered in the 2D view. */
    get showTextures() {
        return this.#showTextures;
    }
    set showTextures(value) {
        this.#showTextures = value;

        for (const chunk of this.#canvasMap.values()) {
            chunk.dirty = true;
        }
    }

    /** @type {Object} Camera position. */
    #camera = {
        lastScale: 1,
        position: { x: 0, y: 0 },
        scale: 1,
    };

    /** @type {Object} */
    #hovered = {
        line: null,
        thing: null,
        sector: null,
        vertex: null,
    };
    /** @type {Object} Geometry currently under the cursor. */
    get hovered() {
        return this.#hovered;
    }

    /** @type {Map<number, Array<Object>>} Selections awaiting transactions. */
    #pendingSelections = new Map();

    /** @type {{x: number, y: number}} Current cursor position. */
    #cursorPosition = { x: 0, y: 0 };
    /** @type {{x: number, y: number}} Current snapped map position. */
    #snappedCursorPosition = { x: 0, y: 0 };
    /** @type {{x: number, y: number}} Cursor position from the previous update. */
    #lastCursorPosition = { x: 0, y: 0 };
    /** @type {?string} Last cursor CSS value applied to the canvas. */
    #lastCursorPositionStyle = null;

    /** @type {{x: number, y: number}} Left-drag start in canvas space. */
    #leftDragFrom = { x: 0, y: 0 };
    /** @type {{x: number, y: number}} Right-drag start in canvas space. */
    #rightDragFrom = { x: 0, y: 0 };
    /** @type {Object} Left-drag endpoints in map space. */
    #leftDragWorld = {
        from: { x: 0, y: 0 },
        to: { x: 0, y: 0 },
    };

    /** @type {boolean} Whether the next left-button release should be ignored. */
    #suppressNextLeftRelease = false;

    /** @type {number} Index used to cycle overlapping hovered things. */
    #clickIndex = 0;

    /** @type {boolean} Whether a left-button drag is active. */
    #isLeftDragStarted = false;
    /** @type {boolean} Whether a right-button drag is active. */
    #isRightDragStarted = false;
    /** @type {boolean} Whether the left button has moved far enough to drag. */
    #isLeftDragging = false;
    /** @type {boolean} Whether the right button has moved far enough to drag. */
    #isRightDragging = false;

    /** @type {Array<Geometry>} Geometries captured when a drag begins. */
    #draggedGeometries = [];

    /** @type {boolean} Whether the camera is being panned. */
    #isPanning = false;
    /** @type {boolean} Whether brush selection is active. */
    #isBrushSelecting = false;
    /** @type {boolean} Whether box selection is active. */
    #isBoxSelecting = false;

    /** @type {number} */
    #snapSize = 8;
    /** @type {number} Current map-grid snap size. */
    get snapSize() {
        return this.#snapSize;
    }
    set snapSize(value) {
        this.#snapSize = value;
    }

    /** @type {?string} */
    #mode = null;
    /** @type {?string} Active editing mode. */
    get mode() {
        return this.#mode;
    }
    /** @type {?number} */
    #subMode = null;
    /** @type {?number} Active editing submode. */
    get subMode() {
        return this.#subMode;
    }

    /** @type {Object} State for transform operations. */
    #modeTransform = {
        // Current transform
        pivot: { x: 0, y: 0 },
        rotation: 0,
        rotationSum: 0,
        scale: { x: 1, y: 1 },
        translate: { x: 0, y: 0 },
        // Reference cursor world position
        start: { x: 0, y: 0 },
        // Whether new geometry is being added as opposed to moved
        adding: false,
        // Geometries being transformed
        geometries: new Set(),
        // The transformed position of the geometry
        transformedPositions: new Map(),
        // The committed position of the geometry
        committedPositions: new Map(),
        // Whether to apply on release instead of press
        applyOnRelease: false,
    };

    /** @type {{x: number, y: number}} Line-mode start point. */
    #modeLineStart = { x: 0, y: 0 };
    /** @type {{x: number, y: number}} Line-mode end point. */
    #modeLineEnd = { x: 0, y: 0 };
    /** @type {Array<{x: number, y: number}>} Previous line-mode start points. */
    #modeLineHistory = [];

    /** @type {{x: number, y: number}} Rectangle-mode first corner. */
    #modeRectangleStart = { x: 0, y: 0 };
    /** @type {{x: number, y: number}} Rectangle-mode opposite corner. */
    #modeRectangleEnd = { x: 0, y: 0 };

    /** @type {{x: number, y: number}} Ellipse center. */
    #modeEllipseCenter = { x: 0, y: 0 };
    /** @type {{x: number, y: number}} Ellipse radii. */
    #modeEllipseRadius = { x: 0, y: 0 };
    /** @type {number} Number of vertices used in ellipse. */
    #modeEllipseVertices = 16;
    /** @type {number} Ellipse or arc start angle in radians. */
    #modeEllipseStartAngle = 0;
    /** @type {number} Final vertex index used for ellipse arcs. */
    #modeEllipseEndVertex = 16;

    /** @type {?Array<Line>} Lines currently being extruded. */
    #modeExtrudeLines = null;
    /** @type {Array<number>} Extrusion distance for each selected line. */
    #modeExtrudeDistances = [];

    /** @type {number} Thing type created by thing mode. */
    #modeThingTypeId = 1;

    /** @type {string} Default cursor CSS value. */
    #cursorDefault = Utility.createCrosshairCursor('#ecd2ad');
    /** @type {string} Selection cursor CSS value. */
    #cursorSelect = Utility.createCrosshairCursor('#6be663');
    /** @type {string} Hover cursor CSS value. */
    #cursorHover = Utility.createCrosshairCursor('#ffdd00');
    /** @type {string} Transform cursor CSS value. */
    #cursorDrag = Utility.createMoveCursor('#ffffff');
    /** @type {string} Pan cursor CSS value. */
    #cursorPan = Utility.createCrosshairCursor('#ecd2ad');
    /** @type {string} Brush-selection cursor CSS value. */
    #cursorBrushSelect = Utility.createBrushCursor('#00f4ff', VectorEditor.#BRUSH_SELECT_SIZE);
    /** @type {string} Brush-deselection cursor CSS value. */
    #cursorBrushDeselect = Utility.createBrushCursor('#ff4444', VectorEditor.#BRUSH_SELECT_SIZE);
    /** @type {string} Drawing cursor CSS value. */
    #cursorPen = Utility.createPenCursor('#6be663');

    /**
     * @param {HTMLCanvasElement} canvas - Canvas element.
     * @param {ResourceManager} resourceManager - Resource manager.
     * @param {DoomMap} map - Map being edited.
     * @param {Client} client - Multiplayer client.
     * @param {Editor3D} editor3d - Synchronized 3D editor.
     */
    constructor(canvas, resourceManager, map, client, editor3d) {
        this.#canvas = canvas;
        this.#resourceManager = resourceManager;

        this.#map = map;
        this.#attachMapHandlers();

        this.#client = client;

        this.#client.addEventListener('transactionapplied', e => {
            const selection = this.#pendingSelections.get(e.detail.transactionId);
            if (selection === undefined) {
                return;
            }
            this.#pendingSelections.delete(e.detail.transactionId);
            this.#applyPendingSelection(selection);
        });

        this.#editor3d = editor3d;

        this.#ctx = this.#canvas.getContext('2d', { desynchronized: true });
        this.#ctx.lineJoin = 'round';
        this.#ctx.textBaseline = 'middle';

        this.#elementStatus = document.querySelector('.editor__status');

        this.#updateCursorStyle();
    }

    /**
     * Moves the editor canvas between the full-screen and inset containers.
     *
     * @param {boolean} focused - Whether the 2D editor should have focus.
     */
    setFocused(focused) {
        this.#focused = focused;
        if (focused) {
            document.querySelector('.editor__fullscreen').appendChild(this.#canvas);
            this.#ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
        } else {
            document.querySelector('.editor__inset').appendChild(this.#canvas);
        }

        // Reset mode
        if (!this.#focused) {
            this.setMode(null);
        }
    }

    /**
     * Checks whether the pointer is currently over the 2D editor.
     *
     * @returns {boolean} Whether the editor is hovered.
     */
    isHovered() {
        if (this.#editor3d.isHovered()) {
            return false;
        }
        const position = Input.clientToCanvas(this.#canvas, Input.getCursorPosition(VectorEditor.#tmpV20));
        return position.x >= 0 &&
            position.y >= 0 &&
            position.x <= this.#canvas.width &&
            position.y <= this.#canvas.height;
    }

    /**
     * Resizes the canvas to match its container.
     */
    #updateCanvasSize() {
        const container = this.#canvas.parentElement;
        const rect = container.getBoundingClientRect();

        const width = Math.round(rect.right) - Math.round(rect.left);
        const height = Math.round(rect.bottom) - Math.round(rect.top);

        if (width === this.#lastCanvasSize.x && height === this.#lastCanvasSize.y) {
            return;
        }

        const dpi = window.devicePixelRatio === undefined ? 1 : window.devicePixelRatio;

        this.#canvas.style.width = `${rect.width}px`;
        this.#canvas.style.height = `${rect.height}px`;

        this.#canvas.width = Math.round(rect.right * dpi) - Math.round(rect.left * dpi);
        this.#canvas.height = Math.round(rect.bottom * dpi) - Math.round(rect.top * dpi);
    }

    /**
     * Marks cached chunks overlapping a changed geometry as dirty.
     *
     * @param {Geometry} geometry - Geometry whose rendered area changed.
     */
    #handleGeometryChanged(geometry) {
        const isThing = geometry instanceof Thing;
        const margin = VectorEditor.#CANVAS_CHUNK_DIRTY_MARGIN + isThing * VectorEditor.#THING_SPRITE_SIZE;

        const bounds = geometry.bounds;

        const chunkSize = VectorEditor.#CANVAS_CHUNK_SIZE / this.#camera.lastScale;

        const chunkMinX = Math.floor((bounds.min.x - margin) / chunkSize);
        const chunkMinY = Math.floor((bounds.min.y - margin) / chunkSize);
        const chunkMaxX = Math.floor((bounds.max.x + margin) / chunkSize);
        const chunkMaxY = Math.floor((bounds.max.y + margin) / chunkSize);

        for (let cx = chunkMinX; cx <= chunkMaxX; cx++) {
            for (let cy = chunkMinY; cy <= chunkMaxY; cy++) {
                const key = `${cx},${cy}`;
                const chunk = this.#canvasMap.get(key);
                if (chunk) {
                    chunk.dirty = true;
                }
            }
        }
    }

    /**
     * Attaches map event listeners that invalidate affected canvas chunks.
     */
    #attachMapHandlers() {
        const map = this.#map;

        // Vertices
        map.addEventListener('vertexadded', e => this.#handleGeometryChanged(e.detail.vertex));
        map.addEventListener('vertexremoved', e => this.#handleGeometryChanged(e.detail.vertex));

        // Lines
        map.addEventListener('lineadded', e => this.#handleGeometryChanged(e.detail.line));
        map.addEventListener('lineremoved', e => this.#handleGeometryChanged(e.detail.line));
        map.addEventListener('linechanged', e => this.#handleGeometryChanged(e.detail.line));
        map.addEventListener('sidechanged', e => this.#handleGeometryChanged(e.detail.line));

        // Sectors
        map.addEventListener('sectoradded', e => this.#handleGeometryChanged(e.detail.sector));
        map.addEventListener('sectorremoved', e => this.#handleGeometryChanged(e.detail.sector));
        map.addEventListener('sectorchanged', e => this.#handleGeometryChanged(e.detail.sector));
        map.addEventListener('sectorsrebuilt', () => {
            for (const chunk of this.#canvasMap.values()) {
                chunk.dirty = true;
            }
        });

        // Things
        map.addEventListener('thingadded', e => this.#handleGeometryChanged(e.detail.thing));
        map.addEventListener('thingremoved', e => this.#handleGeometryChanged(e.detail.thing));
        map.addEventListener('thingchanged', e => this.#handleGeometryChanged(e.detail.thing));

        // Selection changes
        map.addEventListener('beforeselect', e => {
            for (const geometry of e.detail.selection) {
                this.#handleGeometryChanged(geometry);
            }
        });
        map.addEventListener('select', e => {
            for (const geometry of e.detail.selection) {
                this.#handleGeometryChanged(geometry);
            }
        });
    }

    /**
     * Updates input, editor state and rendering for one frame.
     *
     * @param {number} elapsedSeconds - Seconds since the previous frame.
     */
    update(elapsedSeconds) {
        this.#updateCanvasSize();
        this.#updateInput();
        this.#updateStatusText();
        // Send the player client info after panning, to reduce latency
        this.#editor3d.sendPlayerInfo(this.#isPanning);
        this.#updateCursorStyle();

        this.#draw();
    }

    /**
     * Processes keyboard, pointer, gesture and editing-mode input.
     */
    #updateInput() {
        // Skip if any HTML input element has focus
        if (document.activeElement !== document.body) {
            return;
        }

        const input = VectorEditor.#INPUT;
        const map = this.#map;
        const camera = this.#camera;
        const canvas = this.#canvas;
        const canvasWidth = this.#canvas.width;
        const canvasHeight = this.#canvas.height;
        const thingSize = VectorEditor.#THING_SIZE;
        const mapBorderPadding = VectorEditor.#MAP_BORDER_PADDING;
        const zoomMax = VectorEditor.#ZOOM_MAX;
        const coordinateMin = DoomMap.COORDINATE_MIN;
        const coordinateMax = DoomMap.COORDINATE_MAX;
        const transform = this.#modeTransform;

        // Modifier keys
        const ctrlHeld = Input.getKey('ControlLeft') ||
            Input.getKey('ControlRight') ||
            Input.getKey('MetaLeft') ||
            Input.getKey('MetaRight');
        const shiftHeld = Input.getKey('ShiftLeft') || Input.getKey('ShiftRight');
        const altHeld = Input.getKey('AltLeft') || Input.getKey('AltRight');

        // Mouse buttons
        const leftMouseHeld = Input.getMouseButton(0);
        const leftMousePressed = Input.getMouseButtonDown(0);
        let leftMouseReleased = Input.getMouseButtonUp(0);
        if (this.#suppressNextLeftRelease && leftMouseReleased) {
            this.#suppressNextLeftRelease = false;
            leftMouseReleased = false;
        }
        const middleMouseHeld = Input.getMouseButton(1);
        const middleMousePressed = Input.getMouseButtonDown(1);
        const rightMouseHeld = Input.getMouseButton(2);
        const rightMousePressed = Input.getMouseButtonDown(2);
        const rightMouseReleased = Input.getMouseButtonUp(2);

        // Get cursor position
        const screenCursor = VectorEditor.#tmpV20;
        Input.getCursorPosition(screenCursor);
        Input.clientToCanvas(canvas, screenCursor);
        const worldCursor = VectorEditor.#tmpV24;
        worldCursor.x = screenCursor.x;
        worldCursor.y = screenCursor.y;
        this.#screenToWorld(worldCursor);

        // Start panning camera
        if (!this.#isPanning && rightMouseHeld) {
            this.#isPanning = true;
            this.#lastCursorPosition.x = screenCursor.x;
            this.#lastCursorPosition.y = screenCursor.y;
        }

        // Stop panning camera
        if (this.#isPanning && !rightMouseHeld) {
            this.#isPanning = false;
        }

        // Continue panning
        if (this.#isPanning) {
            camera.position.x -= (screenCursor.x - this.#lastCursorPosition.x) / camera.scale;
            camera.position.y += (screenCursor.y - this.#lastCursorPosition.y) / camera.scale;

            this.#lastCursorPosition.x = screenCursor.x;
            this.#lastCursorPosition.y = screenCursor.y;
        }

        const transforming = this.#mode === 'move' || this.#mode === 'scale' || this.#mode === 'rotate';
        const selectMode = this.#mode === null;

        if (!transforming && this.isHovered()) {
            // Grow selection
            if (Input.getKeyDown('Digit1')) {
                this.#map.growSelection();
            }

            // Shrink selection
            if (Input.getKeyDown('Digit2')) {
                this.#map.shrinkSelection();
            }

            // Select linked
            if (Input.getKeyDown('Digit3')) {
                const geometry = this.#hovered.sector ?? this.#hovered.line ?? this.#hovered.vertex ?? null;
                if (geometry !== null) {
                    if (!shiftHeld) {
                        map.select(null, 'deselect_all');
                    }
                    this.#map.selectLinked(geometry);
                }
            }
        }

        if (selectMode) {
            // Start brush selecting
            if (!this.#isBrushSelecting && (ctrlHeld || middleMouseHeld)) {
                this.#isBrushSelecting = true;
            }

            // Stop brush selecting
            if (this.#isBrushSelecting && !ctrlHeld && !middleMouseHeld) {
                this.#isBrushSelecting = false;
            }
        } else {
            this.#isBrushSelecting = false;
        }

        // Mouse wheel and pinch zoom
        const wheelDelta = Input.getMouseWheelDelta(true);
        const pinchDelta = Input.getPinchZoomDelta(true);
        const wheelZoom = wheelDelta !== 0 && !ctrlHeld;
        const pinchZoom = pinchDelta !== 0;
        if (wheelZoom || pinchZoom) {
            const zoomSpeed = wheelZoom ? input.scroll.mouseSpeed : input.scroll.pinchSpeed;
            const zoomFactor = wheelZoom ?
                wheelDelta < 0 ?
                zoomSpeed : 1 / zoomSpeed :
                1 + pinchDelta * zoomSpeed;
            let pinchCenter = VectorEditor.#tmpV23;
            if (pinchZoom) {
                Input.getPinchCenter(pinchCenter);
            }

            // Zoom around cursor position
            const x = wheelZoom ? screenCursor.x : pinchCenter.x;
            const y = wheelZoom ? screenCursor.y : pinchCenter.y;
            const worldBefore = VectorEditor.#tmpV21;
            const worldAfter = VectorEditor.#tmpV22;
            worldBefore.x = x;
            worldBefore.y = y;
            this.#screenToWorld(worldBefore);
            const minScale = Math.max(canvasWidth, canvasHeight) / (coordinateMax + mapBorderPadding) / 2;
            camera.scale = Math.min(Math.max(camera.scale * zoomFactor, minScale), zoomMax);
            worldAfter.x = x;
            worldAfter.y = y;
            this.#screenToWorld(worldAfter);
            camera.position.x += worldBefore.x - worldAfter.x;
            camera.position.y += worldBefore.y - worldAfter.y;
        }

        // Reset hover
        const lastHoveredVertex = this.#hovered.vertex;
        const lastHoveredLine = this.#hovered.line;
        const lastHoveredSector = this.#hovered.sector;
        const lastHoveredThing = this.#hovered.thing;

        this.#hovered.thing = null;
        this.#hovered.vertex = null;
        this.#hovered.line = null;
        this.#hovered.sector = null;

        const vertexRadius = input.hover.vertexDistance / camera.scale;
        const lineRadius = input.hover.lineDistance / camera.scale;

        let minVertexDistance2 = vertexRadius * vertexRadius;
        let minLineDistance2 = lineRadius * lineRadius;

        const boundsMin = VectorEditor.#tmpV21;
        const boundsMax = VectorEditor.#tmpV22;

        boundsMin.x = worldCursor.x - vertexRadius;
        boundsMin.y = worldCursor.y - vertexRadius;
        boundsMax.x = worldCursor.x + vertexRadius;
        boundsMax.y = worldCursor.y + vertexRadius;

        // Hover things
        const hovered = VectorEditor.#tmpHover;
        hovered.length = 0;
        map.iterateThings(thing => {
            if (thing.isInsideRectangle(
                worldCursor.x - thingSize / 2,
                worldCursor.y - thingSize / 2,
                worldCursor.x + thingSize / 2,
                worldCursor.y + thingSize / 2)) {
                hovered.push(thing);
            }
        }, boundsMin, boundsMax);
        if (hovered.length > 0) {
            this.#hovered.thing = hovered[this.#clickIndex % hovered.length];
        }
        if (leftMouseReleased) {
            this.#clickIndex++;
        }

        if (this.#hovered.thing === null) {
            // Hover vertices
            map.iterateVertices(vertex => {
                const dx = worldCursor.x - vertex.x;
                const dy = worldCursor.y - vertex.y;
                const distance2 = dx * dx + dy * dy;

                // Shrink the radius if it the cursor faces along a short line
                const distance = Math.hypot(dx, dy);
                const lineRatio = 0.25;

                let shrunkRadius = vertexRadius;

                if (vertex.lines.length > 0 && distance > 1e-6) {
                    const px = dx / distance;
                    const py = dy / distance;

                    vertex.lines.forEach(line => {
                        const dxl = line.v1.x - line.v0.x;
                        const dyl = line.v1.y - line.v0.y;
                        const length = Math.hypot(dxl, dyl);

                        if (length * lineRatio > vertexRadius) {
                            return;
                        }

                        let ux;
                        let uy;
                        if (vertex === line.v0) {
                            ux = dxl / length;
                            uy = dyl / length;
                        } else {
                            ux = -dxl / length;
                            uy = -dyl / length;
                        }
                        const dot = px * ux + py * uy;
                        if (dot > 0.25) {
                            const t = (dot - 0.25) / 0.75;
                            shrunkRadius = Math.min(shrunkRadius,
                                shrunkRadius * (1 - t) + length * lineRatio * t);
                        }
                    });
                }

                if (distance2 < shrunkRadius * shrunkRadius && distance2 < minVertexDistance2) {
                    minVertexDistance2 = distance2;
                    this.#hovered.vertex = vertex;
                }
            }, boundsMin, boundsMax);

            if (this.#hovered.vertex === null) {
                // Hover lines
                boundsMin.x = worldCursor.x - lineRadius;
                boundsMin.y = worldCursor.y - lineRadius;
                boundsMax.x = worldCursor.x + lineRadius;
                boundsMax.y = worldCursor.y + lineRadius;

                map.iterateLines(line => {
                    const distance2 = line.getDistanceSquaredToPoint(worldCursor.x, worldCursor.y);
                    if (distance2 !== null && distance2 < minLineDistance2) {
                        minLineDistance2 = distance2;
                        this.#hovered.line = line;
                    }
                }, boundsMin, boundsMax);

                const line = this.#hovered.line;
                let nx;
                let ny;
                if (line !== null) {
                    const dx = line.v1.x - line.v0.x;
                    const dy = line.v1.y - line.v0.y;
                    const length = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy));
                    nx = -(dy / length);
                    ny = dx / length;
                }

                // Hover sectors
                const sector = map.getSector(worldCursor.x, worldCursor.y);

                if (sector !== null) {
                    // Compare with the maximum thickness at the intersection point
                    const thicknessRatio = 0.25;
                    const thickness = line === null ? null :
                        sector.getThicknessThroughPoint(worldCursor.x, worldCursor.y, nx, ny);
                    if (line === null || minLineDistance2 > Math.pow(thickness * thicknessRatio, 2)) {
                        this.#hovered.line = null;
                        this.#hovered.sector = sector;
                    }
                }
            }
        }

        // Repaint hovered chunks
        if (lastHoveredThing !== this.#hovered.thing) {
            if (this.#hovered.thing !== null) {
                this.#handleGeometryChanged(this.#hovered.thing);
            }
            if (lastHoveredThing !== null) {
                this.#handleGeometryChanged(lastHoveredThing);
            }
        }
        if (lastHoveredVertex !== this.#hovered.vertex) {
            if (this.#hovered.vertex !== null) {
                this.#handleGeometryChanged(this.#hovered.vertex);
            }
            if (lastHoveredVertex !== null) {
                this.#handleGeometryChanged(lastHoveredVertex);
            }
        }
        if (lastHoveredLine !== this.#hovered.line) {
            if (this.#hovered.line !== null) {
                this.#handleGeometryChanged(this.#hovered.line);
            }
            if (lastHoveredLine !== null) {
                this.#handleGeometryChanged(lastHoveredLine);
            }
        }
        if (lastHoveredSector !== this.#hovered.sector) {
            if (this.#hovered.sector !== null) {
                this.#handleGeometryChanged(this.#hovered.sector);
            }
            if (lastHoveredSector !== null) {
                this.#handleGeometryChanged(lastHoveredSector);
            }
        }

        // Brush select
        if (this.#isBrushSelecting && (leftMouseHeld || middleMouseHeld)) {
            const brushSize = VectorEditor.#BRUSH_SELECT_SIZE / camera.scale;

            boundsMin.x = worldCursor.x - brushSize;
            boundsMin.y = worldCursor.y - brushSize;
            boundsMax.x = worldCursor.x + brushSize;
            boundsMax.y = worldCursor.y + brushSize;

            const isDeselecting = middleMouseHeld;

            map.iterateThings(thing => {
                if (thing.isInsideCircle(worldCursor.x, worldCursor.y, brushSize + thingSize / 2)) {
                    map.select([thing], isDeselecting ? 'deselect' : 'select');
                    this.#resetPivot();
                }
            }, boundsMin, boundsMax);

            map.iterateVertices(vertex => {
                if (vertex.isInsideCircle(worldCursor.x, worldCursor.y, brushSize)) {
                    map.select([vertex], isDeselecting ? 'deselect' : 'select');
                    this.#resetPivot();
                }
            }, boundsMin, boundsMax);

            map.iterateLines(line => {
                if (line.isInsideCircle(worldCursor.x, worldCursor.y, brushSize)) {
                    map.select([line], isDeselecting ? 'deselect' : 'select');
                    this.#resetPivot();
                }
            }, boundsMin, boundsMax);

            map.iterateSectors(sector => {
                if (sector.isInsideCircle(worldCursor.x, worldCursor.y, brushSize)) {
                    if (isDeselecting || sector.lines.every(line => map.isSelected(line))) {
                        map.select([sector], isDeselecting ? 'deselect' : 'select', false, true);
                        this.#resetPivot();
                    }
                }
            }, boundsMin, boundsMax);
        }

        // Select geometry
        if (leftMouseReleased && selectMode && !this.#isBrushSelecting && !this.#isBoxSelecting) {
            // Determine selection mode
            const mode = !ctrlHeld && shiftHeld ? 'toggle' : 'select';

            // Deselect first
            if (!ctrlHeld && !shiftHeld) {
                 map.select(null, 'deselect_all');
            }

            // Apply selection to hovered elements
            if (this.#hovered.vertex !== null) {
                map.select([this.#hovered.vertex], mode);
            } else if (this.#hovered.line !== null) {
                map.select([this.#hovered.line], mode);
            } else if (this.#hovered.sector !== null) {
                map.select([this.#hovered.sector], mode);
            } else if (this.#hovered.thing !== null) {
                map.select([this.#hovered.thing], mode);
            } else {
                map.select(null, 'deselect_all');
            }
            this.#resetPivot();
        }

        // Determine snap size
        const snapSize = ctrlHeld ? 1 : this.#snapSize;
        const snappedCursor = this.#snappedCursorPosition;
        snappedCursor.x = Math.round(worldCursor.x / snapSize) * snapSize;
        snappedCursor.y = Math.round(worldCursor.y / snapSize) * snapSize;

        // Snap to vertices or lines
        if (this.#hovered.vertex !== null && !transform.geometries.has(this.#hovered.vertex)) {
            this.#hovered.vertex.copyTo(snappedCursor);
        } else if (this.#hovered.line !== null && !transform.geometries.has(this.#hovered.line)) {
            const closestPoint = this.#hovered.line.getClosestPoint(worldCursor.x, worldCursor.y);
            snappedCursor.x = Math.round(closestPoint.x / snapSize) * snapSize;
            snappedCursor.y = Math.round(closestPoint.y / snapSize) * snapSize;
        } else if (shiftHeld) {
            // Edit snap (usually polar)
            switch (this.#mode) {
                case 'move': {
                    const dx = snappedCursor.x - transform.start.x;
                    const dy = snappedCursor.y - transform.start.y;

                    const distance = Math.hypot(dx, dy);
                    const snapAngle = Math.PI / 8;
                    const angle = Math.round(Math.atan2(dy, dx) / snapAngle) * snapAngle;

                    snappedCursor.x = Math.round((transform.start.x
                        + Math.cos(angle) * distance) / snapSize) * snapSize;
                    snappedCursor.y = Math.round((transform.start.y
                        + Math.sin(angle) * distance) / snapSize) * snapSize;

                    break;
                }
                case 'line':
                    if (this.#subMode === 1) {
                        const dx = worldCursor.x - this.#modeLineStart.x;
                        const dy = worldCursor.y - this.#modeLineStart.y;

                        const distance = Math.hypot(dx, dy);
                        const snapAngle = Math.PI / 8;
                        const angle = Math.round(Math.atan2(dy, dx) / snapAngle) * snapAngle;

                        snappedCursor.x = Math.round((this.#modeLineStart.x
                            + Math.cos(angle) * distance) / snapSize) * snapSize;
                        snappedCursor.y = Math.round((this.#modeLineStart.y
                            + Math.sin(angle) * distance) / snapSize) * snapSize;
                    }

                    break;

                case 'rectangle':
                case 'ellipse':
                    if (this.#subMode === 1) {
                        const from = this.#mode === 'rectangle' ?
                            this.#modeRectangleStart : this.#modeEllipseCenter;
                        const dx = worldCursor.x - from.x;
                        const dy = worldCursor.y - from.y;

                        const size = Math.max(Math.abs(dx), Math.abs(dy));

                        snappedCursor.x = Math.round((from.x + Math.sign(dx) * size) / snapSize) * snapSize;
                        snappedCursor.y = Math.round((from.y + Math.sign(dy) * size) / snapSize) * snapSize;
                    }

                    break;
            }
        }

        // Detect right mouse drag
        if (rightMousePressed) {
            this.#rightDragFrom.x = screenCursor.x;
            this.#rightDragFrom.y = screenCursor.y;

            this.#isRightDragStarted = true;
        } else if (rightMouseHeld && this.#isRightDragStarted && !this.#isRightDragging) {
            const dx = this.#rightDragFrom.x - screenCursor.x;
            const dy = this.#rightDragFrom.y - screenCursor.y;
            const distance = Math.hypot(dx, dy);

            this.#isRightDragging = distance >= VectorEditor.#DRAG_START_LENGTH;
        } else if (!rightMouseHeld) {
            // Update transform pivot
            if (rightMouseReleased && !this.#isRightDragging) {
                transform.pivot.x = snappedCursor.x;
                transform.pivot.y = snappedCursor.y;
            }
            this.#isRightDragStarted = false;
            this.#isRightDragging = false;
        }

        // Detect left mouse drag
        if (leftMousePressed && !ctrlHeld) {
            this.#leftDragFrom.x = screenCursor.x;
            this.#leftDragFrom.y = screenCursor.y;
            this.#leftDragWorld.from.x = worldCursor.x;
            this.#leftDragWorld.from.y = worldCursor.y;
            this.#isLeftDragStarted = true;

            // Get dragged geometries
            this.#draggedGeometries.length = 0;

            const hoveredIsSelected =
                this.#hovered.line !== null && this.#map.isSelected(this.#hovered.line) ||
                this.#hovered.thing !== null && this.#map.isSelected(this.#hovered.thing) ||
                this.#hovered.sector !== null && this.#map.isSelected(this.#hovered.sector) &&
                VectorEditor.#ALLOW_DRAG_SECTORS ||
                this.#hovered.vertex !== null && this.#map.isSelected(this.#hovered.vertex);

            if (hoveredIsSelected) {
                this.#map.getSelection().forEach(geometry => {
                    this.#draggedGeometries.push(geometry);
                });
            } else if (this.#hovered.thing !== null) {
                this.#draggedGeometries.push(this.#hovered.thing);
            } else if (this.#hovered.vertex !== null) {
                this.#draggedGeometries.push(this.#hovered.vertex);
            } else if (this.#hovered.line !== null) {
                this.#draggedGeometries.push(this.#hovered.line);
            }
        } else if (leftMouseHeld && this.#isLeftDragStarted && !this.#isLeftDragging) {
            const dx = this.#leftDragFrom.x - screenCursor.x;
            const dy = this.#leftDragFrom.y - screenCursor.y;
            const distance = Math.hypot(dx, dy);

            this.#isLeftDragging = distance >= VectorEditor.#DRAG_START_LENGTH;
        } else if (!leftMouseHeld) {
            this.#isLeftDragStarted = false;
            this.#isLeftDragging = false;
        }
        if (this.#isLeftDragging) {
            this.#leftDragWorld.to.x = worldCursor.x;
            this.#leftDragWorld.to.y = worldCursor.y;
        }

        // Start dragging geometry
        if (this.#draggedGeometries.length > 0 && this.#isLeftDragging && this.#mode === null) {
            this.setMode('move', this.#draggedGeometries, false, true);
        }

        // Only box select in select mode
        if (selectMode) {
            // Start box selecting
            if (!this.#isBoxSelecting && this.#isLeftDragging) {
                this.#isBoxSelecting = true;
            }

            // Stop box selecting
            if (this.#isBoxSelecting && !this.#isLeftDragging) {
                this.#isBoxSelecting = false;

                const from = this.#leftDragWorld.from;
                const to = this.#leftDragWorld.to;

                const intersects = to.x < from.x;
                const geometries = this.#map.getGeometryInBox({
                    x: Math.min(from.x, to.x),
                    y: Math.min(from.y, to.y),
                }, {
                    x: Math.max(from.x, to.x),
                    y: Math.max(from.y, to.y),
                }, intersects);

                if (!shiftHeld) {
                    map.select(null, 'deselect_all');
                }
                this.#map.select(geometries, altHeld ? 'toggle' : 'select');
                this.#resetPivot();
            }
        } else {
            this.#isBoxSelecting = false;
        }

        // Mode actions
        switch (this.#mode) {
            case 'move':
            case 'scale':
            case 'rotate':
                // Transform modes
                switch (this.#mode) {
                    case 'move': {
                        const translateX = snappedCursor.x - transform.start.x;
                        const translateY = snappedCursor.y - transform.start.y;

                        if (translateX !== transform.translate.x ||
                            translateY !== transform.translate.y) {
                            transform.translate.x = translateX;
                            transform.translate.y = translateY;

                            this.#applyTemporaryTransform();
                        }

                        break;
                    }
                    case 'scale': {
                        const vx = transform.pivot.x - transform.start.x;
                        const vy = transform.pivot.y - transform.start.y;
                        const dx = transform.pivot.x - worldCursor.x;
                        const dy = transform.pivot.y - worldCursor.y;

                        const newScaleX = Math.abs(vx) > 1e-6 ? dx / vx : 1;
                        const newScaleY = shiftHeld ? newScaleX : Math.abs(vy) > 1e-6 ? dy / vy : 1;

                        if (newScaleX !== transform.scale.x ||
                            newScaleY !== transform.scale.y) {
                            transform.scale.x = newScaleX;
                            transform.scale.y = newScaleY;

                            this.#applyTemporaryTransform();
                        }

                        break;
                    }
                    case 'rotate': {
                        const vx = transform.pivot.x - transform.start.x;
                        const vy = transform.pivot.y - transform.start.y;
                        const dx = transform.pivot.x - worldCursor.x;
                        const dy = transform.pivot.y - worldCursor.y;

                        const a0 = Math.atan2(vy, vx);
                        const a1 = Math.atan2(dy, dx);

                        let rotation = (a1 - a0 + Math.PI * 4) % (Math.PI * 2);

                        if (shiftHeld) {
                            const snapAngle = Math.PI / 16;
                            rotation = Math.round(rotation / snapAngle) * snapAngle;
                        }

                        if (rotation !== transform.rotation) {
                            transform.rotation = rotation;

                            this.#applyTemporaryTransform();
                        }

                        break;
                    }
                }

                // Stamp transform into map
                if (middleMousePressed) {
                    this.#applyTransformToMap(true, true);
                }

                // Apply transform changes
                if (leftMouseReleased && transform.applyOnRelease || leftMousePressed) {
                    this.#applyTemporaryTransform(true);
                    this.#applyTransformToMap();
                    this.#suppressNextLeftRelease = !leftMouseReleased;
                }

                break;

            case 'line':
                if (this.#subMode === 0) {
                    this.#modeLineStart.x = snappedCursor.x;
                    this.#modeLineStart.y = snappedCursor.y;

                    if (leftMousePressed || middleMousePressed) {
                        if (this.#hovered.line !== null && this.#hovered.vertex === null) {
                            const operations = [{
                                op: 'splitLine',
                                args: [
                                    this.#hovered.line.v0.x,
                                    this.#hovered.line.v0.y,
                                    this.#hovered.line.v1.x,
                                    this.#hovered.line.v1.y,
                                    Math.round(this.#modeLineStart.x),
                                    Math.round(this.#modeLineStart.y),
                                ],
                            }];
                            this.#client.sendTransaction(operations);
                        }

                        this.#modeLineEnd.x = snappedCursor.x;
                        this.#modeLineEnd.y = snappedCursor.y;

                        this.#subMode++;
                    }
                } else if (this.#subMode === 1) {
                    this.#modeLineEnd.x = snappedCursor.x;
                    this.#modeLineEnd.y = snappedCursor.y;

                    if ((leftMousePressed || middleMousePressed) && (
                        this.#modeLineStart.x !== this.#modeLineEnd.x ||
                        this.#modeLineStart.y !== this.#modeLineEnd.y)) {
                        const operations = [];

                        if (this.#hovered.line !== null && this.#hovered.vertex === null) {
                            operations.push({
                                op: 'splitLine',
                                args: [
                                    this.#hovered.line.v0.x,
                                    this.#hovered.line.v0.y,
                                    this.#hovered.line.v1.x,
                                    this.#hovered.line.v1.y,
                                    Math.round(this.#modeLineEnd.x),
                                    Math.round(this.#modeLineEnd.y),
                                ],
                            });
                        }

                        operations.push({
                            op: 'addLine',
                            args: [
                                Math.round(this.#modeLineStart.x),
                                Math.round(this.#modeLineStart.y),
                                Math.round(this.#modeLineEnd.x),
                                Math.round(this.#modeLineEnd.y),
                            ],
                        });

                        this.#client.sendTransaction(operations);

                        if (this.#hovered.vertex === null && this.#hovered.line === null ||
                            middleMousePressed) {
                            this.#modeLineHistory.push({
                                x: this.#modeLineStart.x,
                                y: this.#modeLineStart.y,
                            });

                            this.#modeLineStart.x = Math.round(this.#modeLineEnd.x);
                            this.#modeLineStart.y = Math.round(this.#modeLineEnd.y);
                        } else {
                            this.#subMode = 0;

                            this.#modeLineHistory.length = 0;
                        }
                    }
                }

                break;

            case 'rectangle':
                if (this.#subMode === 0) {
                    this.#modeRectangleStart.x = snappedCursor.x;
                    this.#modeRectangleStart.y = snappedCursor.y;

                    if (leftMousePressed || middleMousePressed) {
                        this.#modeRectangleEnd.x = snappedCursor.x;
                        this.#modeRectangleEnd.y = snappedCursor.y;
                        this.#subMode++;
                    }
                } else if (this.#subMode === 1) {
                    this.#modeRectangleEnd.x = snappedCursor.x;
                    this.#modeRectangleEnd.y = snappedCursor.y;

                    if ((leftMousePressed || middleMousePressed) && (
                        this.#modeRectangleStart.x !== this.#modeRectangleEnd.x ||
                        this.#modeRectangleStart.y !== this.#modeRectangleEnd.y)) {

                        const x0 = Math.round(this.#modeRectangleStart.x);
                        const y0 = Math.round(this.#modeRectangleStart.y);
                        const x1 = Math.round(this.#modeRectangleEnd.x);
                        const y1 = Math.round(this.#modeRectangleEnd.y);

                        const operations = this.#createLineAddOperations([
                            [{ x: x0, y: y0 }, { x: x1, y: y0 }],
                            [{ x: x1, y: y0 }, { x: x1, y: y1 }],
                            [{ x: x1, y: y1 }, { x: x0, y: y1 }],
                            [{ x: x0, y: y1 }, { x: x0, y: y0 }],
                        ]);

                        this.#client.sendTransaction(operations);

                        if (middleMousePressed) {
                            this.#modeRectangleStart.x = this.#modeRectangleEnd.x;
                            this.#modeRectangleStart.y = this.#modeRectangleEnd.y;
                        } else {
                            this.#subMode = 0;
                        }
                    }
                }

                break;

            case 'ellipse':
                if (this.#subMode === 0) {
                    this.#modeEllipseCenter.x = snappedCursor.x;
                    this.#modeEllipseCenter.y = snappedCursor.y;

                    if (leftMousePressed || middleMousePressed) {
                        this.#modeEllipseRadius.x = 0;
                        this.#modeEllipseRadius.y = 0;
                        this.#modeEllipseEndVertex = this.#modeEllipseVertices;
                        this.#subMode++;
                    }
                } else if (this.#subMode === 1) {
                    this.#modeEllipseRadius.x = Math.abs(snappedCursor.x - this.#modeEllipseCenter.x);
                    this.#modeEllipseRadius.y = Math.abs(snappedCursor.y - this.#modeEllipseCenter.y);

                    if (ctrlHeld && wheelDelta !== 0) {
                        this.#modeEllipseVertices = Math.max(3,
                            Math.min(256, this.#modeEllipseVertices - Math.sign(wheelDelta)));
                        this.#modeEllipseEndVertex = this.#modeEllipseVertices;
                    }

                    if ((leftMousePressed || middleMousePressed) &&
                        this.#modeEllipseRadius.x > 0 && this.#modeEllipseRadius.y > 0) {
                        this.#modeEllipseStartAngle = 0;
                        this.#modeEllipseEndVertex = this.#modeEllipseVertices;
                        this.#subMode++;
                    }
                } else {
                    this.#modeEllipseStartAngle = Math.atan2(
                        this.#modeEllipseCenter.y - snappedCursor.y,
                        this.#modeEllipseCenter.x - snappedCursor.x
                    );

                    if (ctrlHeld && wheelDelta !== 0) {
                        this.#modeEllipseEndVertex = Math.max(1,
                            Math.min(this.#modeEllipseVertices, this.#modeEllipseEndVertex -
                            Math.sign(wheelDelta)));
                    }

                    if (leftMousePressed || middleMousePressed) {
                        const isSlice = this.#modeEllipseEndVertex < this.#modeEllipseVertices;

                        let lastX = this.#modeEllipseCenter.x;
                        let lastY = this.#modeEllipseCenter.y;

                        const lines = [];

                        for (let i = 0; i <= this.#modeEllipseEndVertex; i++) {
                            const angle = this.#modeEllipseStartAngle +
                                i / this.#modeEllipseVertices * Math.PI * 2;
                            const x = Math.round(this.#modeEllipseCenter.x +
                                Math.cos(angle) * this.#modeEllipseRadius.x);
                            const y = Math.round(this.#modeEllipseCenter.y +
                                Math.sin(angle) * this.#modeEllipseRadius.y);
                            if (i > 0 || isSlice) {
                                lines.push([
                                    {
                                        x: Math.round(lastX),
                                        y: Math.round(lastY),
                                    }, {
                                        x: Math.round(x),
                                        y: Math.round(y),
                                    },
                                ]);
                            }
                            lastX = x;
                            lastY = y;
                        }
                        if (isSlice) {
                            lines.push([
                                {
                                    x: Math.round(lastX),
                                    y: Math.round(lastY),
                                }, {
                                    x: Math.round(this.#modeEllipseCenter.x),
                                    y:  Math.round(this.#modeEllipseCenter.y),
                                },
                            ]);
                        }

                        const operations = this.#createLineAddOperations(lines);

                        this.#client.sendTransaction(operations);

                        this.#subMode = 0;
                    }
                }

                break;

            case 'extrude':
                this.#modeExtrudeLines.forEach((line, i) => {
                    const dx = line.v1.x - line.v0.x;
                    const dy = line.v1.y - line.v0.y;

                    const length = Math.hypot(dx, dy);

                    const nx = -dy / length;
                    const ny = dx / length;

                    const px = snappedCursor.x - line.v0.x;
                    const py = snappedCursor.y - line.v0.y;

                    this.#modeExtrudeDistances[i] = px * nx + py * ny;
                });

                if (leftMousePressed || middleMousePressed) {
                    const operations = [];

                    this.#modeExtrudeLines.forEach((line, i) => {
                        const distance = this.#modeExtrudeDistances[i];

                        const dx = line.v1.x - line.v0.x;
                        const dy = line.v1.y - line.v0.y;

                        const length = Math.hypot(dx, dy);

                        const nx = -dy / length;
                        const ny = dx / length;

                        const v0x = Math.round(line.v0.x + nx * distance);
                        const v0y = Math.round(line.v0.y + ny * distance);
                        const v1x = Math.round(line.v1.x + nx * distance);
                        const v1y = Math.round(line.v1.y + ny * distance);

                        operations.push({
                            op: 'addLine',
                            args: [v0x, v0y, v1x, v1y],
                        });
                        operations.push({
                            op: 'addLine',
                            args: [line.v0.x, line.v0.y, v0x, v0y],
                        });
                        operations.push({
                            op: 'addLine',
                            args: [line.v1.x, line.v1.y, v1x, v1y],
                        });
                    });

                    this.#client.sendTransaction(operations);

                    if (!middleMousePressed) {
                        this.setMode(null);
                    }
                }

                break;

            case 'thing':
                const x = Math.round(snappedCursor.x);
                const y = Math.round(snappedCursor.y);

                if (leftMousePressed && (this.#hovered.thing === null ||
                    this.#hovered.thing.x !== x || this.#hovered.thing.y !== y)) {

                    const operations = [{
                        op: 'addThing',
                        args: [x, y, 0, this.#modeThingTypeId, 0],
                    }];

                    const newSelection = [{
                        type: 'thing',
                        x,
                        y,
                        z: 0,
                        typeId: this.#modeThingTypeId,
                        angle: 0,
                    }];

                    this.#map.select(null, 'deselect_all');

                    const id = this.#client.sendTransaction(operations);

                    if (id === null) {
                        this.#applyPendingSelection(newSelection);
                    } else {
                        this.#pendingSelections.set(id, newSelection);
                    }
                }
                break;
        }

        // Limit camera range
        const viewHalfWidth = (canvasWidth / camera.scale) * 0.5;
        const viewHalfHeight = (canvasHeight / camera.scale) * 0.5;

        const cameraMinX = coordinateMin - mapBorderPadding + viewHalfWidth;
        const cameraMaxX = coordinateMax + mapBorderPadding - viewHalfWidth;
        const cameraMinY = coordinateMin - mapBorderPadding + viewHalfHeight;
        const cameraMaxY = coordinateMax + mapBorderPadding - viewHalfHeight;

        camera.position.x = Math.min(Math.max(camera.position.x, cameraMinX), cameraMaxX);
        camera.position.y = Math.min(Math.max(camera.position.y, cameraMinY), cameraMaxY);

        // Move 3D camera
        if (this.#isPanning || wheelZoom || pinchZoom) {
            this.#editor3d.setCameraPosition(camera.position.x, camera.position.y);
        }
    }

    /**
     * Changes the active editing mode.
     *
     * @param {?string} mode - Mode name, or `null` for selection mode.
     * @param {?(Set<Geometry>|Array<Geometry>)} [overrideGeometries=null] -
     *     Geometries used instead of the current selection.
     * @param {boolean} [isNewGeometry=false] - Whether the geometries have not yet been added to the map.
     * @param {boolean} [applyOnRelease=false] - Whether the transform is committed on mouse release.
     */
    setMode(mode, overrideGeometries = null, isNewGeometry = false, applyOnRelease = false) {
        if (!this.isHovered() && mode !== null) {
            return;
        }

        const transform = this.#modeTransform;

        const selection = this.#map.getSelection();

        const transformingLast = this.#mode === 'move' || this.#mode === 'scale' || this.#mode === 'rotate';

        if (mode !== 'move' && mode !== 'scale' && mode !== 'rotate' && transformingLast) {
            transform.geometries.forEach(geometry => {
                this.#handleGeometryChanged(geometry);
            });

            transform.geometries.clear();
        }

        this.#mode = mode;
        this.#subMode = 0;

        switch (this.#mode) {
            case null:
                break;

            case 'move':
            case 'scale':
            case 'rotate':
                if (!transformingLast && selection.size === 0 && overrideGeometries === null) {
                    this.#mode = null;
                    break;
                }

                transform.start.x = this.#snappedCursorPosition.x;
                transform.start.y = this.#snappedCursorPosition.y;

                if (!transformingLast) {
                    transform.rotation = 0;
                    transform.rotationSum = 0;
                    transform.scale.x = 1;
                    transform.scale.y = 1;
                    transform.translate.x = 0;
                    transform.translate.y = 0;

                    transform.applyOnRelease = applyOnRelease;

                    transform.transformedPositions.clear();
                    transform.committedPositions.clear();

                    transform.geometries.clear();

                    const geometries = overrideGeometries ?? selection;

                    if (geometries.length === 1 && geometries[0] instanceof Vertex && this.#mode === 'move') {
                        geometries[0].copyTo(transform.start);
                    }

                    geometries.forEach(g => {
                        if (g instanceof Vertex) {
                            transform.geometries.add(g);
                            g.lines.forEach(line => {
                                if (line.backSector !== null) {
                                    this.#handleGeometryChanged(line.backSector);
                                }
                                if (line.frontSector !== null) {
                                    this.#handleGeometryChanged(line.frontSector);
                                }
                            });
                        } else if (g instanceof Line) {
                            transform.geometries.add(g);
                            [g.v0, g.v1].forEach(vertex => {
                                transform.geometries.add(vertex);
                                vertex.lines.forEach(line => {
                                    if (line.backSector !== null) {
                                        this.#handleGeometryChanged(line.backSector);
                                    }
                                    if (line.frontSector !== null) {
                                        this.#handleGeometryChanged(line.frontSector);
                                    }
                                });
                            });
                        } else if (g instanceof Sector) {
                            g.lines.forEach(line => {
                                transform.geometries.add(line);
                                transform.geometries.add(line.v0);
                                transform.geometries.add(line.v1);
                            });
                        } else if (g instanceof Thing) {
                            transform.geometries.add(g);
                        }
                        if (!isNewGeometry) {
                            this.#handleGeometryChanged(g);
                        }
                    });

                    transform.adding = isNewGeometry;

                    if (isNewGeometry) {
                        let minX = Infinity;
                        let minY = Infinity;
                        let maxX = -Infinity;
                        let maxY = -Infinity;

                        transform.geometries.forEach(g => {
                            const b = g.bounds;
                            minX = Math.min(minX, b.min.x);
                            minY = Math.min(minY, b.min.y);
                            maxX = Math.max(maxX, b.max.x);
                            maxY = Math.max(maxY, b.max.y);
                        });

                        transform.pivot.x = (minX + maxX) * 0.5;
                        transform.pivot.y = (minY + maxY) * 0.5;

                        transform.translate.x = this.#snappedCursorPosition.x - transform.pivot.x;
                        transform.translate.y = this.#snappedCursorPosition.y - transform.pivot.y;
                    }
                }

                this.#applyTemporaryTransform(true);

                break;
            case 'line':
                break;

            case 'rectangle':
                break;

            case 'ellipse':
                break;

            case 'extrude':
                this.#modeExtrudeLines = Array.from(selection).filter(g => g instanceof Line);
                this.#modeExtrudeDistances = this.#modeExtrudeLines.map(() => 0);
                if (this.#modeExtrudeLines.length === 0) {
                    this.#mode = null;
                }
                break;

            case 'thing':
                break;
        }

        document.querySelectorAll('.mode-button').forEach(button => {
            button.classList.toggle('selected', (button.dataset.mode ?? null) === this.#mode);
        });
    }

    /**
     * Rewinds the current mode by one step.
     */
    rewindMode() {
        if (this.#mode === 'line') {
            if (this.#subMode === 1 && this.#modeLineHistory.length > 0) {
                const p = this.#modeLineHistory.pop();
                this.#modeLineStart.x = p.x;
                this.#modeLineStart.y = p.y;
            } else {
                this.#subMode = 0;
            }
        }
    }

    /**
     * Updates the status text for the active mode and cursor position.
     */
    #updateStatusText() {
        if (!this.#focused) {
            this.#elementStatus.innerText = '';
            return;
        }

        const coordinate = `${Math.round(this.#snappedCursorPosition.x)},${Math.round(this.#snappedCursorPosition.y)}`;

        switch (this.#mode) {
            case null:
                this.#elementStatus.innerText = coordinate;
                break;

            case 'move':
                this.#elementStatus.innerText =
                    `Move: Pick move offset\nEsc / E to cancel\n${coordinate}`;
                break;

            case 'scale':
                this.#elementStatus.innerText =
                    `Scale: Pick scale\nEsc / E to cancel\n${coordinate}`;
                break;

            case 'rotate':
                this.#elementStatus.innerText =
                    `Rotate: Pick rotation\nEsc / E to cancel\n${coordinate}`;
                break;

            case 'line':
                switch (this.#subMode) {
                    case 0:
                        this.#elementStatus.innerText = `Line: Pick start point\nEsc / E to cancel\n${coordinate}`;
                        break;

                    case 1: {
                        this.#elementStatus.innerText =
                            `Line: Pick end point\nEsc / E to cancel\n${coordinate}`;
                        break;
                    }
                }
                break;

            case 'rectangle':
                switch (this.#subMode) {
                    case 0:
                        this.#elementStatus.innerText = `Rectangle: Pick first corner\nEsc / E to cancel\n${coordinate}`;
                        break;

                    case 1:
                        this.#elementStatus.innerText =
                            `Rectangle: Pick opposite corner\nEsc / E to cancel\n${coordinate}`;
                        break;
                }
                break;

            case 'ellipse':
                switch (this.#subMode) {
                    case 0:
                        this.#elementStatus.innerText = `Circle: Pick center\nEsc / E to cancel\n${coordinate}`;
                        break;

                    case 1:
                        this.#elementStatus.innerText =
                            `Circle: Pick radius\nCtrl + scroll to adjust corner count\nEsc / E to cancel\n${coordinate}`;
                        break;

                    case 2:
                        this.#elementStatus.innerText =
                            `Circle: Pick start angle\nCtrl + scroll to adjust arc length\nEsc / E to cancel\n${coordinate}`;
                        break;
                }
                break;

            case 'extrude':
                this.#elementStatus.innerText = `Extrude: Pick extrude distance\nEsc / E to cancel\n${coordinate}`;
                break;

            case 'thing':
                const definition = this.#resourceManager.thingDefinitions.find(
                    definition => definition.id === this.#modeThingTypeId);
                this.#elementStatus.innerText = `Thing: Add thing (${definition?.name ?? 'missing'})\nEsc / E to cancel\n${coordinate}`;
                break;
        }
    }

    /**
     * Chooses and applies the cursor for the current editor state.
     */
    #updateCursorStyle() {
        let nextCursor;

        const shiftHeld = Input.getKey('ShiftLeft') || Input.getKey('ShiftRight');
        if (this.#mode === 'move' || this.#mode === 'scale' || this.#mode === 'rotate') {
            nextCursor = this.#cursorDrag;
        } else if (this.#mode !== null) {
            nextCursor = this.#cursorPen;
        } else if (shiftHeld) {
            nextCursor = this.#cursorSelect;
        } else if (this.#isBrushSelecting) {
            const isDeselecting = Input.getMouseButton(1);
            nextCursor = isDeselecting ? this.#cursorBrushDeselect : this.#cursorBrushSelect;
        } else if (this.#isPanning) {
            nextCursor = this.#cursorPan;
        } else if (this.#hovered.vertex !== null ||
            this.#hovered.line !== null ||
            this.#hovered.sector !== null) {
            nextCursor = this.#cursorHover;
        } else {
            nextCursor = this.#cursorDefault;
        }
        if (nextCursor === this.#lastCursorPositionStyle) {
            return;
        }
        this.#lastCursorPositionStyle = nextCursor;
        Input.setCursorStyle(nextCursor, this.#canvas);
    }

    /**
     * Draws visible cached chunks and dynamic editor overlays.
     */
    #draw() {
        const chunkSize = VectorEditor.#CANVAS_CHUNK_SIZE;
        const tolerance = VectorEditor.#ZOOM_REPAINT_TOLERANCE;
        const camera = this.#camera;
        const mainCtx = this.#ctx;
        const canvasWidth = this.#canvas.width;
        const canvasHeight = this.#canvas.height;

        // Check if rescaling tolerance was exceeded
        const scaleRatio = camera.scale / camera.lastScale;
        if (scaleRatio < 1 - tolerance || scaleRatio > 1 + tolerance) {
            // Reset all chunks
            for (const chunk of this.#canvasMap.values()) {
                VectorEditor.#poolChunk(chunk);
            }
            this.#canvasMap.clear();
            camera.lastScale = camera.scale;
        }

        // Actual world-space size of each chunk
        const worldChunkSize = chunkSize / camera.lastScale;

        // Compute visible chunk range based
        const boundsMinX = camera.position.x - (canvasWidth / 2) / camera.scale;
        const boundsMinY = camera.position.y - (canvasHeight / 2) / camera.scale;
        const boundsMaxX = camera.position.x + (canvasWidth / 2) / camera.scale;
        const boundsMaxY = camera.position.y + (canvasHeight / 2) / camera.scale;

        const chunkMinX = Math.floor(boundsMinX / worldChunkSize);
        const chunkMaxX = Math.floor(boundsMaxX / worldChunkSize);
        const chunkMinY = Math.floor(boundsMinY / worldChunkSize);
        const chunkMaxY = Math.floor(boundsMaxY / worldChunkSize);

        // Iterate chunks across screen
        for (let cx = chunkMinX; cx <= chunkMaxX; cx++) {
            for (let cy = chunkMinY; cy <= chunkMaxY; cy++) {
                const key = `${cx},${cy}`;
                let chunk = this.#canvasMap.get(key);

                if (!chunk) {
                    // Create missing chunk
                    chunk = VectorEditor.#createChunk();
                    chunk.scale = camera.lastScale;
                    chunk.min.x = cx * worldChunkSize;
                    chunk.min.y = cy * worldChunkSize;
                    chunk.max.x = (cx + 1) * worldChunkSize;
                    chunk.max.y = (cy + 1) * worldChunkSize;
                    chunk.dirty = true;
                    this.#canvasMap.set(key, chunk);
                }

                // Repaint modified chunk
                if (chunk.dirty) {
                    this.#repaint(chunk.ctx, chunk.min, chunk.max, chunk.scale);

                    chunk.dirty = false;
                }

                const screenX = (chunk.min.x - boundsMinX) * camera.scale;
                const screenY = (chunk.min.y - boundsMinY) * camera.scale;
                const screenSize = worldChunkSize * camera.scale;

                mainCtx.drawImage(
                    chunk.canvas,
                    screenX,
                    canvasHeight - screenY - screenSize,
                    screenSize,
                    screenSize
                );
            }
        }

        this.#drawSelectionBox();
        this.#drawEditGizmos();
        this.#drawPlayerIndicators();
        this.#drawUsers();
    }

    /**
     * Repaints one cached map chunk.
     *
     * @param {CanvasRenderingContext2D} ctx - Chunk rendering context.
     * @param {{x: number, y: number}} boundsMin - Minimum world bounds.
     * @param {{x: number, y: number}} boundsMax - Maximum world bounds.
     * @param {number} scale - World scale.
     */
    #repaint(ctx, boundsMin, boundsMax, scale) {
        const chunkSize = VectorEditor.#CANVAS_CHUNK_SIZE;
        const chunkPadding = VectorEditor.#CANVAS_CHUNK_PADDING;
        const map = this.#map;
        const theme = VectorEditor.#THEME;
        const thingSize = VectorEditor.#THING_SIZE;
        const thingSpriteSize = VectorEditor.#THING_SPRITE_SIZE;

        const v0 = VectorEditor.#tmpV20;
        const v1 = VectorEditor.#tmpV21;
        const verticesToDraw = VectorEditor.#tmpDraw0;
        verticesToDraw.length = 0;
        const linesToDraw = VectorEditor.#tmpDraw1;
        linesToDraw.length = 0;

        const transforming = this.#mode === 'move' || this.#mode === 'scale' || this.#mode === 'rotate';

        /////////////////////////
        // Draw background

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = theme.background;
        ctx.fillRect(0, 0, chunkSize, chunkSize);

        // Apply chunk transform
        ctx.setTransform(scale, 0, 0, -scale, -boundsMin.x * scale, boundsMax.y * scale);

        /////////////////////////
        // Draw grid

        // Select a reasonable grid subdivision
        let gridSize = 1;
        while (scale * gridSize < 16) {
            gridSize *= VectorEditor.#GRID_SUBDIVISIONS;
        }
        gridSize = Math.min(gridSize, 1024);

        // Determine grid bounds in world space
        const boundsMinX = Math.floor(boundsMin.x / gridSize - chunkPadding) * gridSize;
        const boundsMinY = Math.floor(boundsMin.y / gridSize - chunkPadding) * gridSize;
        const boundsMaxX = Math.ceil(boundsMax.x / gridSize + chunkPadding) * gridSize;
        const boundsMaxY = Math.ceil(boundsMax.y / gridSize + chunkPadding) * gridSize;

        // Draw grid
        ctx.beginPath();
        for (let x = boundsMinX; x <= boundsMaxX; x += gridSize) {
            ctx.moveTo(x, boundsMinY);
            ctx.lineTo(x, boundsMaxY);
        }
        for (let y = boundsMinY; y <= boundsMaxY; y += gridSize) {
            ctx.moveTo(boundsMinX, y);
            ctx.lineTo(boundsMaxX, y);
        }

        ctx.lineWidth = 2 / scale;
        ctx.strokeStyle = theme.grid.lines;
        ctx.stroke();

        /////////////////////////
        // Draw world axes

        ctx.lineWidth = 2 / scale;

        ctx.beginPath();
        ctx.moveTo(boundsMinX, 0);
        ctx.lineTo(boundsMaxX, 0);
        ctx.strokeStyle = theme.grid.x;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(0, boundsMinY);
        ctx.lineTo(0, boundsMaxY);
        ctx.strokeStyle = theme.grid.y;
        ctx.stroke();

        /////////////////////////
        // Draw map border

        const coordinateMin = DoomMap.COORDINATE_MIN;
        const coordinateMax = DoomMap.COORDINATE_MAX;

        const minLimitX = coordinateMin;
        const maxLimitX = coordinateMax;
        const minLimitY = coordinateMin;
        const maxLimitY = coordinateMax;

        ctx.beginPath();

        if (boundsMin.x <= minLimitX) {
            ctx.moveTo(minLimitX - 4, minLimitY - 4);
            ctx.lineTo(minLimitX - 4, maxLimitY + 4);
        }
        if (boundsMax.x >= maxLimitX) {
            ctx.moveTo(maxLimitX + 4, minLimitY - 4);
            ctx.lineTo(maxLimitX + 4, maxLimitY + 4);
        }
        if (boundsMin.y <= minLimitY) {
            ctx.moveTo(minLimitX - 4, minLimitY - 4);
            ctx.lineTo(maxLimitX + 4, minLimitY - 4);
        }
        if (boundsMax.y >= maxLimitY) {
            ctx.moveTo(minLimitX - 4, maxLimitY + 4);
            ctx.lineTo(maxLimitX + 4, maxLimitY + 4);
        }

        ctx.lineWidth = 8 / scale;
        ctx.strokeStyle = '#ff0000';
        ctx.stroke();

        /////////////////////////
        // Draw sectors

        map.iterateSectors((sector, selected) => {
            if (transforming) {
                if (sector.lines.some(line =>
                    this.#modeTransform.geometries.has(line.v0) ||
                    this.#modeTransform.geometries.has(line.v1))) {
                    return;
                }
            }

            const hovered = this.#hovered.sector === sector;

            ctx.beginPath();
            const vertices = sector.flatXY;
            for (let i = 0; i < vertices.length; i += 2) {
                v0.x = vertices[i];
                v0.y = vertices[i + 1];

                if (i === 0) {
                    ctx.moveTo(v0.x, v0.y);
                } else {
                    ctx.lineTo(v0.x, v0.y);
                }
            }
            sector.mergedChildLoops.forEach(loop => {
                for (let i = 0; i < loop.length; i += 2) {
                    v0.x = loop[i];
                    v0.y = loop[i + 1];

                    if (i === 0) {
                        ctx.moveTo(v0.x, v0.y);
                    } else {
                        ctx.lineTo(v0.x, v0.y);
                    }
                }
            });
            ctx.closePath();

            if (this.#showTextures) {
                if (sector.properties.getValue('is_void')) {
                    return;
                }

                const flat = this.#resourceManager.flats.get(sector.properties.getValue('floor_texture'));
                if (flat !== undefined) {
                    let pattern = this.#flatPatternCache.get(flat);
                    if (pattern === undefined) {
                        const palette = this.#resourceManager.palettes[0];
                        const imageData = ResourceUtility.indexedImageToColorData(flat, palette);
                        const image = Utility.imageDataToCanvas(imageData);
                        pattern = ctx.createPattern(image, 'repeat');
                        this.#flatPatternCache.set(flat, pattern);
                    }
                    ctx.fillStyle = pattern;
                    ctx.fill();
                }

                if (!selected && !hovered) {
                    return;
                }
            }

            let fillColor;

            if (hovered && selected) {
                fillColor = sector.properties.getValue('is_void')
                    ? theme.sector.selectedHoverVoidFill
                    : theme.sector.selectedHoverFill;
            } else if (selected) {
                fillColor = sector.properties.getValue('is_void')
                    ? theme.sector.selectedVoidFill
                    : theme.sector.selectedFill;
            } else if (hovered) {
                fillColor = sector.properties.getValue('is_void')
                    ? theme.sector.hoverVoidFill
                    : sector.properties.getValue('special') > 0
                    ? theme.sector.hoverSpecialFill
                    : theme.sector.hoverFill;
            } else {
                fillColor = sector.properties.getValue('is_void')
                    ? theme.sector.voidFill
                    : sector.properties.getValue('special') > 0
                    ? theme.sector.specialFill
                    : theme.sector.fill;
            }

            ctx.fillStyle = fillColor;
            ctx.fill();
        }, boundsMin, boundsMax);

        /////////////////////////
        // Draw line shadows

        ctx.lineWidth = 2 / scale;

        map.iterateLines((line, selected) => {
            line.v0.copyTo(v0);
            line.v1.copyTo(v1);

            if (transforming &&
                this.#modeTransform.geometries.has(line.v0) ||
                this.#modeTransform.geometries.has(line.v1)) {
                return;
            }

            const dx = v1.x - v0.x;
            const dy = v1.y - v0.y;
            const length = Math.hypot(dx, dy);
            if (length < 1e-6) {
                return;
            }

            const frontSector = line.frontSector;
            const backSector = line.backSector;
            const frontIsVoid = frontSector === null || frontSector.properties.getValue('is_void');
            const backIsVoid = backSector === null || backSector.properties.getValue('is_void');

            let baseColor;
            let fadeSign = 0;

            const hovered = this.#hovered.line === line;

            if (hovered) {
                baseColor = theme.line.hover;
            } else if (selected) {
                baseColor = theme.line.selected;
            } else if (frontIsVoid && backIsVoid) {
                baseColor = theme.line.floating;
            } else if (!frontIsVoid && !backIsVoid) {
                baseColor = line.properties.getValue('impassable')
                    ? theme.line.impassable
                    : line.properties.getValue('special') > 0
                    ? theme.line.special
                    : theme.line.inner;
                fadeSign = Math.sign(frontSector.properties.getValue('floor_height') -
                    backSector.properties.getValue('floor_height'));
            } else {
                baseColor = theme.line.outer;
                fadeSign = frontIsVoid ? 1 : (backIsVoid ? -1 : 0);
            }

            linesToDraw.push(v0.x, v0.y, v1.x, v1.y, baseColor, selected || hovered);

            if (fadeSign === 0) {
                return;
            }

            const nx = -dy / length;
            const ny =  dx / length;

            for (let i = 0; i < 6; i++) {
                const offset = i + 1;
                const offsetX = nx * fadeSign * offset * 1.5 / scale;
                const offsetY = ny * fadeSign * offset * 1.5 / scale;

                ctx.beginPath();
                ctx.moveTo(v0.x + offsetX, v0.y + offsetY);
                ctx.lineTo(v1.x + offsetX, v1.y + offsetY);
                ctx.strokeStyle = `rgba(0,0,0,${0.33 - 0.05 * i})`;
                ctx.stroke();
            }
        }, boundsMin, boundsMax);

        /////////////////////////
        // Draw vertex corners

        const smallVertices = scale < 0.25;

        const cornerRadius = 7 / scale;
        const halfCornerRadius2 = (cornerRadius * 0.5) * (cornerRadius * 0.5);

        ctx.strokeStyle = theme.vertex.corner;
        ctx.lineWidth = 1 / scale;

        map.iterateVertices((vertex, selected) => {
            if (transforming && this.#modeTransform.geometries.has(vertex)) {
                return;
            }

            vertex.copyTo(v0);

            verticesToDraw.push(v0.x, v0.y, this.#hovered.vertex === vertex, selected);

            const lines = vertex.lines;
            const lineCount = lines.length;

            if (lineCount < 2 || smallVertices) {
                return;
            }

            const lineAngles = vertex.lineAngles;

            for (let i = 0; i < lineCount; i++) {
                const j = (i + 1) % lineCount;
                const l0 = lines[i];
                const l1 = lines[j];

                const dx0 = l0.v1.x - l0.v0.x;
                const dy0 = l0.v1.y - l0.v0.y;
                const dx1 = l1.v1.x - l1.v0.x;
                const dy1 = l1.v1.y - l1.v0.y;

                const length20 = dx0 * dx0 + dy0 * dy0;
                const length21 = dx1 * dx1 + dy1 * dy1;

                if (Math.max(length20, length21) < halfCornerRadius2) {
                    continue;
                }

                const a0 = lineAngles[i];
                const a1 = lineAngles[j];

                const delta = (a0 - a1 + Math.PI * 2) % (Math.PI * 2);

                // 90 degree corner square
                if (Math.abs(delta - Math.PI * 0.5) < 1e-3) {
                    const x0 = v0.x + Math.cos(a0) * cornerRadius;
                    const y0 = v0.y + Math.sin(a0) * cornerRadius;
                    const x1 = v0.x + Math.cos(a1) * cornerRadius;
                    const y1 = v0.y + Math.sin(a1) * cornerRadius;

                    const inner = cornerRadius * 1.414214;
                    const angle = a0 - Math.PI * 0.25;
                    const cx = v0.x + Math.cos(angle) * inner;
                    const cy = v0.y + Math.sin(angle) * inner;

                    ctx.beginPath();
                    ctx.moveTo(x0, y0);
                    ctx.lineTo(cx, cy);
                    ctx.lineTo(x1, y1);

                    ctx.stroke();

                    continue;
                }

                // 45 degree corner bisector
                if (Math.abs(delta - Math.PI * 0.25) < 1e-3) {
                    const bisector = a0 + delta * 0.5;
                    const bx = Math.cos(bisector);
                    const by = Math.sin(bisector);

                    const startX = v0.x + bx * (cornerRadius * 0.4);
                    const startY = v0.y + by * (cornerRadius * 0.4);
                    const endX = v0.x + bx * (cornerRadius * 1.0);
                    const endY = v0.y + by * (cornerRadius * 1.0);

                    ctx.beginPath();
                    ctx.moveTo(startX, startY);
                    ctx.lineTo(endX, endY);

                    ctx.stroke();
                }
            }
        }, boundsMin, boundsMax);

        /////////////////////////
        // Draw lines

        ctx.lineWidth = 6 / scale;
        ctx.strokeStyle = '#00000050';

        for (let i = 0; i < linesToDraw.length; i += 6) {
            const x0 = linesToDraw[i];
            const y0 = linesToDraw[i + 1];
            const x1 = linesToDraw[i + 2];
            const y1 = linesToDraw[i + 3];
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            if (linesToDraw[i + 5]) {
                const dx = x1 - x0;
                const dy = y1 - y0;
                const l = Math.sqrt(dx * dx + dy * dy);
                const nx = dx / l;
                const ny = dy / l;
                const length = 6 / scale;
                ctx.moveTo(x0 + nx * l * 0.5, y0 + ny * l * 0.5);
                ctx.lineTo(x0 + nx * l * 0.5 + ny * length, y0 + ny * l * 0.5 - nx * length);
            }
            ctx.stroke();
        }

        ctx.lineWidth = 2 / scale;

        for (let i = 0; i < linesToDraw.length; i += 6) {
            const x0 = linesToDraw[i];
            const y0 = linesToDraw[i + 1];
            const x1 = linesToDraw[i + 2];
            const y1 = linesToDraw[i + 3];
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            if (linesToDraw[i + 5]) {
                const dx = x1 - x0;
                const dy = y1 - y0;
                const l = Math.sqrt(dx * dx + dy * dy);
                const nx = dx / l;
                const ny = dy / l;
                const length = 6 / scale;
                ctx.moveTo(x0 + nx * l * 0.5, y0 + ny * l * 0.5);
                ctx.lineTo(x0 + nx * l * 0.5 + ny * length, y0 + ny * l * 0.5 - nx * length);
            }
            ctx.strokeStyle = linesToDraw[i + 4];
            ctx.stroke();
        }

        /////////////////////////
        // Draw vertices

        ctx.lineWidth = 1 / scale;

        const largeVertexSize = Math.max(2.5, Math.min(4, scale * 4)) / scale;

        for (let i = 0; i < verticesToDraw.length; i += 4) {
            const x = verticesToDraw[i];
            const y = verticesToDraw[i + 1];
            const hovered = verticesToDraw[i + 2];
            const selected = verticesToDraw[i + 3];
            const vertexHalfSize = smallVertices ? (selected ? 2 : 1) / scale : largeVertexSize;

            ctx.beginPath();
            ctx.rect(x - vertexHalfSize, y - vertexHalfSize, vertexHalfSize * 2, vertexHalfSize * 2);
            if (!smallVertices) {
                ctx.fillStyle = hovered ? theme.vertex.hoverFill
                    : selected ? theme.vertex.selectedFill : theme.vertex.fill;
                ctx.strokeStyle = hovered ? theme.vertex.hoverOutline
                    : selected ? theme.vertex.selectedOutline : theme.vertex.outline;
                ctx.fill();
                ctx.stroke();
            } else {
                ctx.fillStyle = hovered ? theme.vertex.hoverFill
                    : selected ? theme.vertex.selectedOutline : theme.vertex.outline;
                ctx.fill();
            }
        }

        /////////////////////////
        // Draw things

        const thingStacks = new Map();

        map.iterateThings((thing, selected) => {
            if (transforming && this.#modeTransform.geometries.has(thing)) {
                return;
            }

            const id = thing.properties.getValue('type');
            const image = this.#getThingImage(id);

            let outlineColor;
            let fillColor;

            const hovered = this.#hovered.thing === thing;

            if (hovered && selected) {
                outlineColor = theme.thing.selectedHoverOutline
                fillColor = theme.thing.selectedHoverFill;
            } else if (hovered) {
                outlineColor = theme.thing.hoverOutline
                fillColor = theme.thing.hoverFill;
            } else if (selected) {
                outlineColor = theme.thing.selectedOutline
                fillColor = theme.thing.selectedFill;
            } else {
                outlineColor = theme.thing.outline
                fillColor = theme.thing.fill;
            }

            v0.x = thing.x;
            v0.y = thing.y;

            const angle = thing.properties.getValue('angle');

            const key = `${thing.x},${thing.y}`;
            const stack = thingStacks.get(key);
            if (stack === undefined) {
                thingStacks.set(key, { x: thing.x, y: thing.y, count: 1 });
            } else {
                stack.count++;
            }

            const x = v0.x;
            const y = v0.y;

            const dx = Math.cos(angle * Math.PI / 180);
            const dy = Math.sin(angle * Math.PI / 180);

            ctx.fillStyle = theme.thing.shadow;
            for (let i = 1; i < 4; i++) {
                ctx.fillRect(
                    x - thingSize / 2 - i / 2 / scale,
                    y - thingSize / 2 - i / 2 / scale,
                    thingSize + i / scale,
                    thingSize + i / scale
                );
            }

            ctx.lineWidth = 1 / scale;
            ctx.strokeStyle = outlineColor;
            ctx.strokeRect(x - thingSize / 2, y - thingSize / 2, thingSize, thingSize);

            ctx.fillStyle = fillColor;
            ctx.fillRect(x - thingSize / 2, y - thingSize / 2, thingSize, thingSize);

            ctx.drawImage(
                image,
                x - thingSpriteSize / 2,
                y - thingSpriteSize / 2,
                thingSpriteSize,
                thingSpriteSize
            );

            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + dx * (thingSpriteSize + 2) / 2, y + dy * (thingSpriteSize + 2) / 2);
            ctx.strokeStyle = '#00000080';
            ctx.lineWidth = 4 / scale;
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + dx * thingSpriteSize / 2, y + dy * thingSpriteSize / 2);
            ctx.strokeStyle = outlineColor;
            ctx.lineWidth = 1 / scale;
            ctx.stroke();
        });

        let first = true;

        thingStacks.forEach(stack => {
            if (stack.count <= 1) {
                return;
            }

            if (first) {
                ctx.setTransform(scale, 0, 0, scale, -boundsMin.x * scale, boundsMax.y * scale);

                ctx.font = '12px monospace';
                ctx.textAlign = 'center';
                ctx.fillStyle = '#ffffff';
                ctx.strokeStyle = '#000000';
                ctx.lineWidth = 1.5;
                first = false;
            }

            ctx.strokeText(stack.count, stack.x, -stack.y - 3.6);
            ctx.fillText(stack.count, stack.x, -stack.y - 3.6);
        });

        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    /**
     * Draws editing guides, previews, measurements and the pivot.
     */
    #drawEditGizmos() {
        const ctx = this.#ctx;
        const map = this.#map;
        const camera = this.#camera;
        const scale = camera.scale;
        const canvas = this.#canvas;
        const theme = VectorEditor.#THEME;
        const thingSize = VectorEditor.#THING_SIZE;
        const thingSpriteSize = VectorEditor.#THING_SPRITE_SIZE;
        const transform = this.#modeTransform;

        const v0 = VectorEditor.#tmpV20;
        const v1 = VectorEditor.#tmpV21;
        const v2 = VectorEditor.#tmpV22;
        const v3 = VectorEditor.#tmpV23;

        const snappedCursor = this.#snappedCursorPosition;
        const cx = snappedCursor.x;
        const cy = snappedCursor.y;

        v0.x = cx;
        v0.y = cy;
        this.#worldToScreen(v0);
        const sx = v0.x;
        const sy = v0.y;

        // Draw snap grid
        if (this.#mode !== null) {
            const ctrlHeld = Input.getKey('ControlLeft') ||
                Input.getKey('ControlRight') ||
                Input.getKey('MetaLeft') ||
                Input.getKey('MetaRight');

            const snapSize = this.#snapSize;

            if (!ctrlHeld) {
                const spacing = snapSize * scale;
                const alpha = Math.min(theme.gizmos.snapGridAlpha, Math.max(0, (spacing - 4) / 12));

                if (alpha > 0 && snapSize > 1) {
                    const size = Math.max(128 / scale, snapSize * 3);

                    const minX = cx - size;
                    const minY = cy - size;
                    const maxX = cx + size;
                    const maxY = cy + size;

                    const minCellX = Math.ceil(minX / snapSize) * snapSize;
                    const minCellY = Math.ceil(minY / snapSize) * snapSize;
                    const maxCellX = Math.floor(maxX / snapSize) * snapSize;
                    const maxCellY = Math.floor(maxY / snapSize) * snapSize;

                    ctx.lineWidth = 1;

                    ctx.beginPath();

                    const r2 = size * size;

                    if ((maxCellX - minCellX) / snapSize < 50.5) {
                        for (let x = minCellX; x <= maxCellX; x += snapSize) {
                            const dx = x - cx;
                            const inside = r2 - dx * dx;
                            if (inside < 0) {
                                continue;
                            }

                            const dy = Math.sqrt(inside);

                            ctx.moveTo(sx + (x - cx) * scale, sy - dy * scale);
                            ctx.lineTo(sx + (x - cx) * scale, sy + dy * scale);
                        }

                        for (let y = minCellY; y <= maxCellY; y += snapSize) {
                            const dy = y - cy;
                            const inside = r2 - dy * dy;
                            if (inside < 0) {
                                continue;
                            }

                            const dx = Math.sqrt(inside);

                            ctx.moveTo(sx - dx * scale, sy + (y - cy) * scale);
                            ctx.lineTo(sx + dx * scale, sy + (y - cy) * scale);
                        }
                    }

                    ctx.strokeStyle = theme.gizmos.snapGridStroke;
                    ctx.globalAlpha = alpha;
                    ctx.stroke();
                    ctx.globalAlpha = 1;
                }
            }

            ctx.font = '11px monospace';
            ctx.fillStyle = theme.gizmos.snapGridStroke;
            ctx.textAlign = 'right';
            ctx.globalAlpha = 0.7;
            ctx.fillText(
                snapSize,
                sx - 12,
                sy - 14
            );
            ctx.globalAlpha = 1;
        }

        // Draw polar indiactors
        let polarMinX = Infinity;
        let polarMaxX = -Infinity;
        let polarMinY = Infinity;
        let polarMaxY = -Infinity;

        v0.x = cx - canvas.width / scale;
        v0.y = cy - 1;
        v1.x = cx + canvas.width / scale;
        v1.y = cy + 1;

        map.iterateVertices(vertex => {
            if (vertex.y === cy && vertex.x !== cx) {
                if (vertex.x > cx) {
                    polarMinX = Math.min(polarMinX, vertex.x);
                }
                if (vertex.x < cx) {
                    polarMaxX = Math.max(polarMaxX, vertex.x);
                }
            }
        }, v0, v1);

        v0.x = cx - 1;
        v0.y = cy - canvas.height / scale;
        v1.x = cx + 1;
        v1.y = cy + canvas.height / scale;

        map.iterateVertices(vertex => {
            if (vertex.x === cx && vertex.y !== cy) {
                if (vertex.y > cy) {
                    polarMinY = Math.min(polarMinY, vertex.y);
                }
                if (vertex.y < cy) {
                    polarMaxY = Math.max(polarMaxY, vertex.y);
                }
            }
        }, v0, v1);

        ctx.beginPath();

        if (polarMinX !== Infinity) {
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx + (polarMinX - cx) * scale, sy);
        }
        if (polarMaxX !== -Infinity) {
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx + (polarMaxX - cx) * scale, sy);
        }
        if (polarMinY !== Infinity) {
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx, sy + (cy - polarMinY) * scale);
        }
        if (polarMaxY !== -Infinity) {
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx, sy + (cy - polarMaxY) * scale);
        }

        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = theme.line.guide;
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw mode gizmos
        switch (this.#mode) {
            case null:
                break;

            case 'move':
            case 'scale':
            case 'rotate':
                ctx.lineWidth = 2;

                for (let i = 0; i < 2; i++) {
                    const color = i === 0 ? theme.gizmos.commitFill : theme.gizmos.drawFill;
                    ctx.strokeStyle = color;
                    ctx.fillStyle = color;

                    transform.geometries.forEach(geometry => {
                        const tp = i === 0 ?
                            transform.committedPositions.get(geometry) :
                            transform.transformedPositions.get(geometry);

                        if (geometry instanceof Vertex) {
                            v0.x = tp.x;
                            v0.y = tp.y;

                            this.#worldToScreen(v0);

                            ctx.fillRect(v0.x - 4, v0.y - 4, 8, 8);

                            geometry.lines.forEach(line => {
                                if (!transform.geometries.has(line)) {
                                    const v = line.v0 === geometry ? line.v1 : line.v0;
                                    v1.x = v.x;
                                    v1.y = v.y;

                                    this.#worldToScreen(v1);

                                    ctx.beginPath();
                                    ctx.moveTo(v0.x, v0.y);
                                    ctx.lineTo(v1.x, v1.y);
                                    ctx.stroke();
                                }
                            });
                        } else if (geometry instanceof Line) {
                            v0.x = tp.x0;
                            v0.y = tp.y0;
                            v1.x = tp.x1;
                            v1.y = tp.y1;

                            this.#worldToScreen(v0);
                            this.#worldToScreen(v1);

                            ctx.fillRect(v0.x - 4, v0.y - 4, 8, 8);
                            ctx.fillRect(v1.x - 4, v1.y - 4, 8, 8);

                            ctx.beginPath();
                            ctx.moveTo(v0.x, v0.y);
                            ctx.lineTo(v1.x, v1.y);
                            ctx.stroke();
                        } else if (geometry instanceof Thing) {
                            const id = geometry.properties.getValue('type');
                            const image = this.#getThingImage(id);

                            v0.x = tp.x;
                            v0.y = tp.y;

                            this.#worldToScreen(v0);

                            const dx = Math.cos(tp.angle * Math.PI / 180);
                            const dy = Math.sin(tp.angle * Math.PI / 180);

                            ctx.strokeRect(
                                v0.x - thingSize / 2 * scale,
                                v0.y - thingSize / 2 * scale,
                                thingSize * scale,
                                thingSize * scale
                            );

                            if (i === 1) {
                                ctx.save();
                                ctx.translate(v0.x, v0.y);
                                ctx.scale(1, -1);
                                ctx.drawImage(
                                    image,
                                    -thingSpriteSize / 2 * scale,
                                    -thingSpriteSize / 2 * scale,
                                    thingSpriteSize * scale,
                                    thingSpriteSize * scale
                                );
                                ctx.restore();
                            }

                            ctx.beginPath();
                            ctx.moveTo(v0.x, v0.y);
                            ctx.lineTo(
                                v0.x + dx * thingSpriteSize / 2 * scale,
                                v0.y - dy * thingSpriteSize / 2 * scale
                            );
                            ctx.stroke();
                        }
                    });
                }

                break;

            case 'line':
                v0.x = this.#modeLineStart.x;
                v0.y = this.#modeLineStart.y;
                v1.x = this.#modeLineEnd.x;
                v1.y = this.#modeLineEnd.y;

                this.#worldToScreen(v0);
                this.#worldToScreen(v1);

                ctx.fillStyle = theme.gizmos.drawFill;
                ctx.fillRect(v0.x - 4, v0.y - 4, 8, 8);

                if (this.#subMode === 1) {
                    const dx = this.#modeLineEnd.x - this.#modeLineStart.x;
                    const dy = this.#modeLineEnd.y - this.#modeLineStart.y;
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    const angle = Math.atan2(dy, dx) * (180 / Math.PI);
                    const is45Step = Math.abs(angle - Math.round(angle / 45) * 45) < 1e-6;

                    if (is45Step) {
                        ctx.setLineDash([15, 5]);
                    }

                    ctx.fillRect(v1.x - 4, v1.y - 4, 8, 8);
                    ctx.beginPath();
                    ctx.moveTo(v0.x, v0.y);
                    ctx.lineTo(v1.x, v1.y);
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = theme.gizmos.drawFill;
                    ctx.stroke();

                    if (is45Step) {
                        ctx.setLineDash([]);
                    }

                    ctx.font = '11px monospace';
                    ctx.fillStyle = theme.gizmos.textFill;
                    ctx.textAlign = 'right';
                    ctx.fillText(
                        Math.round(distance * 100) / 100,
                        v1.x - 12,
                        v1.y - 8 * Math.sign(dy + 0.1) + 4
                    );
                    ctx.textAlign = 'left';
                    ctx.fillText(
                        (Math.floor(angle * 100) / 100) + String.fromCharCode(176),
                        v1.x + 24,
                        v1.y - 8 * Math.sign(dy + 0.1) + 4
                    );
                }
                break;

            case 'rectangle':
                v0.x = this.#modeRectangleStart.x;
                v0.y = this.#modeRectangleStart.y;
                v1.x = this.#modeRectangleEnd.x;
                v1.y = this.#modeRectangleEnd.y;
                this.#worldToScreen(v0);
                this.#worldToScreen(v1);

                ctx.fillStyle = theme.gizmos.drawFill;
                ctx.fillRect(v0.x - 4, v0.y - 4, 8, 8);

                if (this.#subMode === 1) {
                    const dx = this.#modeRectangleEnd.x - this.#modeRectangleStart.x;
                    const dy = this.#modeRectangleEnd.y - this.#modeRectangleStart.y;

                    if (Math.abs(dx) === Math.abs(dy)) {
                        ctx.beginPath();
                        ctx.moveTo(v0.x, v0.y);
                        ctx.lineTo(v1.x, v1.y);
                        ctx.setLineDash([5, 5]);
                        ctx.lineWidth = 2;
                        ctx.strokeStyle = theme.line.guide;
                        ctx.stroke();
                        ctx.setLineDash([]);
                    }

                    ctx.fillRect(v1.x - 4, v1.y - 4, 8, 8);
                    ctx.fillRect(v0.x - 4, v1.y - 4, 8, 8);
                    ctx.fillRect(v1.x - 4, v0.y - 4, 8, 8);
                    ctx.beginPath();
                    ctx.moveTo(v0.x, v0.y);
                    ctx.lineTo(v1.x, v0.y);
                    ctx.lineTo(v1.x, v1.y);
                    ctx.lineTo(v0.x, v1.y);
                    ctx.lineTo(v0.x, v0.y);
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = theme.gizmos.drawFill;
                    ctx.stroke();

                    ctx.font = '11px monospace';
                    ctx.fillStyle = theme.gizmos.textFill;
                    ctx.textAlign = 'right';
                    ctx.fillText(
                        `${Math.abs(dx)},${Math.abs(dy)}`,
                        v1.x - 12,
                        v1.y - 8 * Math.sign(dy + 0.1) * (dx > 0) + 4
                    );
                }

                break;

            case 'ellipse':
                v0.x = this.#modeEllipseCenter.x;
                v0.y = this.#modeEllipseCenter.y;
                this.#worldToScreen(v0);

                if (this.#subMode === 1 && this.#modeEllipseRadius.x === this.#modeEllipseRadius.y) {
                    ctx.beginPath();
                    ctx.moveTo(v0.x, v0.y);
                    const r = this.#modeEllipseRadius.x * 0.7071;
                    ctx.lineTo(
                        v0.x + r * scale,
                        v0.y + r * scale
                    );
                    ctx.setLineDash([5, 5]);
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = theme.line.guide;
                    ctx.stroke();
                    ctx.setLineDash([]);
                }

                ctx.fillStyle = theme.gizmos.drawFill;
                ctx.fillRect(v0.x - 4, v0.y - 4, 8, 8);

                const isSlice = this.#modeEllipseEndVertex < this.#modeEllipseVertices;
                if (this.#subMode > 0) {
                    ctx.beginPath();
                    if (isSlice) {
                        ctx.moveTo(v0.x, v0.y);
                    }
                    for (let i = 0; i <= this.#modeEllipseEndVertex; i++) {
                        const angle = this.#modeEllipseStartAngle +
                            i / this.#modeEllipseVertices * Math.PI * 2;
                        const x = Math.round(v0.x +
                            Math.cos(angle) * this.#modeEllipseRadius.x * scale);
                        const y = Math.round(v0.y -
                            Math.sin(angle) * this.#modeEllipseRadius.y * scale);
                        ctx.fillRect(x - 4, y - 4, 8, 8);
                        if (i === 0 && !isSlice) {
                            ctx.moveTo(x, y);
                        } else {
                            ctx.lineTo(x, y);
                        }
                    }
                    if (isSlice) {
                        ctx.lineTo(v0.x, v0.y);
                    }
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = theme.gizmos.drawFill;
                    ctx.stroke();
                }

                if (this.#subMode > 0) {
                    ctx.font = '11px monospace';
                    ctx.fillStyle = theme.gizmos.textFill;
                    ctx.textAlign = 'right';
                    ctx.fillText(
                        `r=${this.#modeEllipseRadius.x},${Math.abs(this.#modeEllipseRadius.y)}`,
                        sx - 12,
                        sy - 12
                    );
                    if (this.#subMode === 2) {
                        const ellipse = String.fromCodePoint(0x2B2D);
                        const arc = String.fromCodePoint(0x2312);
                        ctx.fillText(
                            `${ellipse}${this.#modeEllipseVertices} ${isSlice ? arc + this.#modeEllipseEndVertex : ''}`,
                            sx - 12,
                            sy + 4
                        );
                    }
                }

                break;

            case 'extrude':
                ctx.font = '11px monospace';
                ctx.textAlign = 'right';

                this.#modeExtrudeLines.forEach((line, i) => {
                    const distance = this.#modeExtrudeDistances[i];

                    const dx = line.v1.x - line.v0.x;
                    const dy = line.v1.y - line.v0.y;

                    const length = Math.hypot(dx, dy);

                    const fx = dx / length;
                    const fy = dy / length;
                    const nx = -fy;
                    const ny = fx;

                    v0.x = line.v0.x;
                    v0.y = line.v0.y;
                    v1.x = line.v1.x;
                    v1.y = line.v1.y;
                    v2.x = Math.round(line.v0.x + nx * distance);
                    v2.y = Math.round(line.v0.y + ny * distance);
                    v3.x = Math.round(line.v1.x + nx * distance);
                    v3.y = Math.round(line.v1.y + ny * distance);

                    this.#worldToScreen(v0);
                    this.#worldToScreen(v1);
                    this.#worldToScreen(v2);
                    this.#worldToScreen(v3);

                    ctx.fillStyle = theme.gizmos.drawFill;
                    ctx.fillRect(v2.x - 4, v2.y - 4, 8, 8);
                    ctx.fillRect(v3.x - 4, v3.y - 4, 8, 8);
                    ctx.beginPath();
                    ctx.moveTo(v0.x, v0.y);
                    ctx.lineTo(v2.x, v2.y);
                    ctx.moveTo(v1.x, v1.y);
                    ctx.lineTo(v3.x, v3.y);
                    ctx.moveTo(v2.x, v2.y);
                    ctx.lineTo(v3.x, v3.y);
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = theme.gizmos.drawFill;
                    ctx.stroke();

                    const angle = -Math.atan2(dy, dx);
                    const flipped = nx > 0;

                    ctx.fillStyle = theme.gizmos.textFill;
                    ctx.setTransform(1, 0, 0, 1,
                        (v0.x + v2.x) * 0.5 + fx * (8 + flipped * 8),
                        (v0.y + v2.y) * 0.5 + fy * (8 + flipped * 8)
                    );
                    ctx.rotate(angle + Math.PI * 0.5 + Math.PI * flipped);
                    ctx.fillText(Math.round(distance * 100) / 100, 0, 0);
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                });

                break;

            case 'thing':
                ctx.fillStyle = theme.gizmos.drawFill;
                ctx.fillRect(sx - 4, sy - 4, 8, 8);

                break;
        }

        // Draw line information and split
        const line = this.#hovered.line;
        if (line !== null) {
            line.v0.copyTo(v0);
            line.v1.copyTo(v1);

            const worldLength = Math.hypot(v1.x - v0.x, v1.y - v0.y);
            const splitDistance = Math.hypot(snappedCursor.x - v0.x, snappedCursor.y - v0.y);

            this.#worldToScreen(v0);
            this.#worldToScreen(v1);

            const dx = v1.x - v0.x;
            const dy = v1.y - v0.y;

            const length = Math.hypot(dx, dy);

            const fx = dx / length;
            const fy = dy / length;
            const nx = -fy;
            const ny = fx;

            const hasSplit = this.#mode !== null;

            const angle = Math.atan2(fy, fx);

            if (hasSplit) {
                ctx.beginPath();
                ctx.moveTo(
                    v0.x - 8 * nx + fx * splitDistance * scale,
                    v0.y - 8 * ny + fy * splitDistance * scale
                );
                ctx.lineTo(
                    v0.x + 8 * nx + fx * splitDistance * scale,
                    v0.y + 8 * ny + fy * splitDistance * scale
                );
                ctx.lineWidth = 2;
                ctx.strokeStyle = theme.gizmos.drawFill;
                ctx.stroke();
            }

            ctx.font = '11px monospace';
            ctx.textAlign = 'center';
            ctx.fillStyle = theme.gizmos.textFill;
            const flipped = ny < 0;
            for (let i = 0; i < 1 + hasSplit; i++) {
                const startDistance = i === 0 ? 0 : splitDistance;
                const distance = hasSplit ? i === 0 ? splitDistance
                    : worldLength - splitDistance : worldLength;
                if (distance * scale < Math.max(50, 160 * Math.abs(fx))) {
                    continue;
                }
                ctx.setTransform(1, 0, 0, 1,
                    v0.x - (5 + flipped * 8) * nx + fx * (startDistance + distance * 0.5) * scale,
                    v0.y - (5 + flipped * 8) * ny + fy * (startDistance + distance * 0.5) * scale
                );
                ctx.rotate(angle + flipped * Math.PI);
                const percent = hasSplit ? ` ${Math.round(distance / worldLength * 1000) / 10}%` : '';
                ctx.fillText(`${Math.round(distance * 100) / 100}${percent}`, 0, 0);
            }
            ctx.setTransform(1, 0, 0, 1, 0, 0);
        }

        // Draw pivot whenever something is selected
        if (this.#map.getSelection().size > 0) {
            v0.x = transform.pivot.x;
            v0.y = transform.pivot.y;

            this.#worldToScreen(v0);

            ctx.lineWidth = 2;
            ctx.strokeStyle = theme.background;
            ctx.strokeRect(v0.x - 3, v0.y - 3, 6, 6);
            ctx.strokeStyle = theme.gizmos.pivotFill;
            ctx.strokeRect(v0.x - 4, v0.y - 4, 8, 8);
        }
    }

    /**
     * Draws the active box-selection rectangle.
     */
    #drawSelectionBox() {
        if (!this.#isBoxSelecting) {
            return;
        }

        const ctx = this.#ctx;

        const from = VectorEditor.#tmpV20;
        const to = VectorEditor.#tmpV21;
        from.x = this.#leftDragWorld.from.x;
        from.y = this.#leftDragWorld.from.y;
        to.x = this.#leftDragWorld.to.x;
        to.y = this.#leftDragWorld.to.y;
        this.#worldToScreen(from);
        this.#worldToScreen(to);

        ctx.setLineDash([5, 5]);
        ctx.fillStyle = from.x < to.x
            ? VectorEditor.#THEME.boxSelect.rightFill
            : VectorEditor.#THEME.boxSelect.leftFill;
        ctx.strokeStyle = from.x < to.x
            ? VectorEditor.#THEME.boxSelect.rightStroke
            : VectorEditor.#THEME.boxSelect.leftStroke;
        ctx.lineWidth = 2;
        ctx.fillRect(from.x, from.y, to.x - from.x, to.y - from.y);
        ctx.strokeRect(from.x, from.y, to.x - from.x, to.y - from.y);
        ctx.setLineDash([]);
    }

    /**
     * Draws remote user cursors and names.
     */
    #drawUsers() {
        const ctx = this.#ctx;
        const users = this.#client.users;
        const ownUser = this.#client.ownUser;

        const canvasWidth = this.#canvas.width;
        const canvasHeight = this.#canvas.height;

        const v0 = VectorEditor.#tmpV20;

        users.forEach(user => {
            const color = user === ownUser ? '#ffffff' : user.color;

            if (user === ownUser) {
                return;
            }

            v0.x = user.cursor.x;
            v0.y = user.cursor.y;

            this.#worldToScreen(v0);

            if (v0.x < -32 ||
                v0.y < -32 ||
                v0.x > canvasWidth + 32 ||
                v0.y > canvasHeight + 32) {
                return;
            }

            const cursor = VectorEditor.#getCursorByColor(color);

            ctx.drawImage(cursor, v0.x - cursor.width / 2, v0.y - cursor.height / 2);

            ctx.font = '16px monospace';
            ctx.textAlign = 'center';
            ctx.fillStyle = user.color;
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#00000080';
            ctx.strokeText(user.username, v0.x, v0.y - 20);
            ctx.fillText(user.username, v0.x, v0.y - 20);
        });
    }

    /**
     * Draws player position and facing indicators.
     */
    #drawPlayerIndicators() {
        const ctx = this.#ctx;
        const size = 10;
        const canvasWidth = this.#canvas.width;
        const canvasHeight = this.#canvas.height;

        this.#client.users.forEach(user => {
            const player = user.player;
            const position = VectorEditor.#tmpV20;
            position.x = player.x;
            position.y = player.y;
            this.#worldToScreen(position);

            if (position.x < -size ||
                position.y < -size ||
                position.x > canvasWidth + size ||
                position.y > canvasHeight + size) {
                return;
            }

            ctx.translate(position.x, position.y);
            ctx.rotate((-player.angle + 90) * Math.PI / 180);
            ctx.beginPath();
            ctx.moveTo(0, -size);
            ctx.lineTo(size * 0.6, size * 0.8);
            ctx.lineTo(0, size * 0.4);
            ctx.lineTo(-size * 0.6, size * 0.8);
            ctx.closePath();

            ctx.strokeStyle = '#000000ff';
            ctx.lineWidth = 3;
            ctx.stroke();
            ctx.strokeStyle = user.color;
            ctx.lineWidth = 1.5;
            ctx.stroke();

            ctx.setTransform(1, 0, 0, 1, 0, 0);
        });
    }

    /**
     * Repositions the transform pivot to the center of the selection.
     */
    #resetPivot() {
        const selection = this.#map.getSelection();

        if (selection.size === 0) {
            return;
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        this.#map.getSelection().forEach(geometry => {
            const bounds = geometry.bounds;

            minX = Math.min(minX, bounds.min.x);
            minY = Math.min(minY, bounds.min.y);
            maxX = Math.max(maxX, bounds.max.x);
            maxY = Math.max(maxY, bounds.max.y);
        });

        const transform = this.#modeTransform;
        transform.pivot.x = (minX + maxX) / 2;
        transform.pivot.y = (minY + maxY) / 2;
    }

    /**
     * Resolves geometry identities and selects the map objects.
     *
     * @param {Array<Object>} selection - Geometry identities.
     */
    #applyPendingSelection(selection) {
        const geometries = [];

        selection.forEach(item => {
            switch (item.type) {
                case 'vertex':
                    geometries.push(this.#map.getVertex(item.x, item.y));
                    break;

                case 'line':
                    geometries.push(this.#map.getLine(
                        item.x0, item.y0,
                        item.x1, item.y1
                    ));
                    break;

                case 'thing':
                    geometries.push(this.#map.getThing(
                        item.x,
                        item.y,
                        item.z,
                        item.typeId,
                        item.angle
                    ));
                    break;
            }
        });

        this.#map.select(geometries, 'select');
        this.#resetPivot();
    }

    /**
     * Applies the current transform to a point.
     *
     * @param {{x: number, y: number}} point - Point to transform.
     * @returns {{x: number, y: number}} The transformed point.
     */
    #transformPoint(point) {
        const transform = this.#modeTransform;

        const x = point.x - transform.pivot.x;
        const y = point.y - transform.pivot.y;

        const toLocalRotation = transform.rotationSum;

        const c0 = Math.cos(-toLocalRotation);
        const s0 = Math.sin(-toLocalRotation);

        const scaledLocalX = (x * c0 - y * s0) * transform.scale.x;
        const scaledLocalY = (x * s0 + y * c0) * transform.scale.y;

        const c1 = Math.cos(toLocalRotation);
        const s1 = Math.sin(toLocalRotation);

        const scaledX = scaledLocalX * c1 - scaledLocalY * s1;
        const scaledY = scaledLocalX * s1 + scaledLocalY * c1;

        const c2 = Math.cos(transform.rotation);
        const s2 = Math.sin(transform.rotation);

        const rotatedX = scaledX * c2 - scaledY * s2;
        const rotatedY = scaledX * s2 + scaledY * c2;

        point.x = transform.pivot.x + rotatedX + transform.translate.x;
        point.y = transform.pivot.y + rotatedY + transform.translate.y;

        return point;
    }

    /**
     * Calculates transformed positions for the active transform.
     *
     * @param {boolean} [commit=false] - Whether to commit the temporary state.
     */
    #applyTemporaryTransform(commit = false) {
        const transform = this.#modeTransform;

        const v0 = VectorEditor.#tmpV20;
        const v1 = VectorEditor.#tmpV21;

        if (commit) {
            v0.x = transform.pivot.x;
            v0.y = transform.pivot.y;

            this.#transformPoint(v0);

            transform.pivot.x = Math.round(v0.x);
            transform.pivot.y = Math.round(v0.y);

            transform.rotationSum += transform.rotation;
        }

        const hasCommit = transform.committedPositions.size > 0;

        transform.transformedPositions.clear();

        transform.geometries.forEach(g => {
            const c = transform.committedPositions.get(g);

            if (g instanceof Vertex) {
                if (hasCommit) {
                    v0.x = c.x;
                    v0.y = c.y;
                } else {
                    v0.x = g.x;
                    v0.y = g.y;
                }

                this.#transformPoint(v0);

                transform.transformedPositions.set(g, {
                    x: v0.x,
                    y: v0.y,
                });

            } else if (g instanceof Line) {
                const flipped = transform.scale.x * transform.scale.y <= 0;

                if (hasCommit) {
                    v0.x = flipped ? c.x1 : c.x0;
                    v0.y = flipped ? c.y1 : c.y0;
                    v1.x = flipped ? c.x0 : c.x1;
                    v1.y = flipped ? c.y0 : c.y1;
                } else {
                    v0.x = flipped ? g.v1.x : g.v0.x;
                    v0.y = flipped ? g.v1.y : g.v0.y;
                    v1.x = flipped ? g.v0.x : g.v1.x;
                    v1.y = flipped ? g.v0.y : g.v1.y;
                }

                this.#transformPoint(v0);
                this.#transformPoint(v1);

                transform.transformedPositions.set(g, {
                    x0: v0.x,
                    y0: v0.y,
                    x1: v1.x,
                    y1: v1.y,
                });

            } else if (g instanceof Thing) {
                const oldAngle = hasCommit ? c.angle : g.properties.getValue('angle');

                if (hasCommit) {
                    v0.x = c.x;
                    v0.y = c.y;
                } else {
                    v0.x = g.x;
                    v0.y = g.y;
                }

                this.#transformPoint(v0);

                const angle = Math.round(oldAngle + transform.rotation * 180 / Math.PI + 360) % 360

                transform.transformedPositions.set(g, {
                    x: v0.x,
                    y: v0.y,
                    angle,
                });
            }
        });

        if (commit) {
            transform.committedPositions.clear();
            transform.transformedPositions.forEach((p, g) => {
                transform.committedPositions.set(g, p);
            });

            transform.rotation = 0;
            transform.scale.x = 1;
            transform.scale.y = 1;
            transform.translate.x = 0;
            transform.translate.y = 0;
        }
    }

    /**
     * Converts the active transform into map transaction operations.
     *
     * @param {boolean} [addOnly=false] - Whether to remove the originals.
     * @param {boolean} [fromTemporary=false] - Whether to use uncommitted transformed positions.
     */
    #applyTransformToMap(addOnly = false, fromTemporary = false) {
        const transform = this.#modeTransform;
        const positions = fromTemporary ? transform.transformedPositions : transform.committedPositions;

        const operations = [];

        const isNew = transform.adding;

        const newSelection = [];

        if (!isNew && !addOnly) {
            transform.geometries.forEach(g => {
                if (g instanceof Vertex) {
                    operations.push({
                        op: 'removeVertex',
                        args: [g.x, g.y],
                    });
                } else if (g instanceof Line) {
                    operations.push({
                        op: 'removeLine',
                        args: [g.v0.x, g.v0.y, g.v1.x, g.v1.y],
                    });
                } else if (g instanceof Thing) {
                    operations.push({
                        op: 'removeThing',
                        args: [
                            g.x,
                            g.y,
                            g.properties.getValue('z'),
                            g.properties.getValue('type'),
                            g.properties.getValue('angle'),
                        ],
                    });
                }
            });
        }

        transform.geometries.forEach(g => {
            const c = positions.get(g);

            const createdLines = new Set();

            if (g instanceof Vertex) {
                const x = Math.round(c.x);
                const y = Math.round(c.y);

                operations.push({
                    op: 'addVertex',
                    args: [x, y],
                });

                if (!isNew) {
                    g.lines.forEach(line => {
                        if (positions.has(line) || createdLines.has(line)) {
                            return;
                        }
                        createdLines.add(line);

                        const v0 = positions.get(line.v0) ?? line.v0;
                        const v1 = positions.get(line.v1) ?? line.v1;

                        const x0 = Math.round(v0.x);
                        const y0 = Math.round(v0.y);
                        const x1 = Math.round(v1.x);
                        const y1 = Math.round(v1.y);

                        if (x0 === x1 && y0 === y1) {
                            return;
                        }

                        operations.push({
                            op: 'addLine',
                            args: [x0, y0, x1, y1],
                        });

                        DoomMap.createCopyLineOperations(operations, line, x0, y0, x1, y1);
                    });
                }

                newSelection.push({
                    type: 'vertex',
                    x,
                    y,
                });
            } else if (g instanceof Line) {
                const x0 = Math.round(c.x0);
                const y0 = Math.round(c.y0);
                const x1 = Math.round(c.x1);
                const y1 = Math.round(c.y1);

                if (x0 === x1 && y0 === y1) {
                    return;
                }

                operations.push({
                    op: 'addLine',
                    args: [x0, y0, x1, y1],
                });

                DoomMap.createCopyLineOperations(operations, g, x0, y0, x1, y1);

                newSelection.push({
                    type: 'line',
                    x0,
                    y0,
                    x1,
                    y1,
                });
            } else if (g instanceof Thing) {
                const x = Math.round(c.x);
                const y = Math.round(c.y);
                const z = g.properties.getValue('z');
                const typeId = g.properties.getValue('type');
                const newAngle = c.angle;

                operations.push({
                    op: 'addThing',
                    args: [x, y, z, typeId, newAngle],
                });

                g.properties.iterate((property, value) => {
                    if (property !== 'z' && property !== 'angle') {
                        operations.push({
                            op: 'setThingProperty',
                            args: [x, y, z, typeId, newAngle, property, value],
                        });
                    }
                }, true);

                newSelection.push({
                    type: 'thing',
                    x,
                    y,
                    z,
                    typeId: typeId,
                    angle: newAngle,
                });
            }
        });

        if (operations.length) {
            const id = this.#client.sendTransaction(operations);

            if (!addOnly) {
                if (id === null) {
                    this.#applyPendingSelection(newSelection);
                } else {
                    this.#pendingSelections.set(id, newSelection);
                }
            }
        }

        if (!addOnly) {
            this.setMode(null);
        }
    }

    /**
     * Converts a point from map space to canvas space.
     *
     * @param {{x: number, y: number}} vertex - Point to convert.
     * @returns {{x: number, y: number}} The converted point.
     */
    #worldToScreen(vertex) {
        const position = this.#camera.position;
        const scale = this.#camera.scale;
        vertex.x = (vertex.x - position.x) * scale + this.#canvas.width / 2;
        vertex.y = (position.y - vertex.y) * scale + this.#canvas.height / 2;
        return vertex;
    }

    /**
     * Converts a point from canvas space to map space.
     *
     * @param {{x: number, y: number}} vertex - Point to convert.
     * @returns {{x: number, y: number}} The converted point.
     */
    #screenToWorld(vertex) {
        const position = this.#camera.position;
        const scale = this.#camera.scale;
        vertex.x = (vertex.x - this.#canvas.width / 2) / scale + position.x;
        vertex.y = position.y - (vertex.y - this.#canvas.height / 2) / scale;
        return vertex;
    }

    /**
     * Moves the camera to reveal bounds that are not fully visible.
     *
     * @param {{minX: number, minY: number, maxX: number, maxY: number}} bounds - Bounding box to reveal.
     */
    focusBounds(bounds) {
        const camera = this.#camera;

        const canvasWidth = this.#canvas.width;
        const canvasHeight = this.#canvas.height;

        const boundsMinX = camera.position.x - (canvasWidth / 2) / camera.scale;
        const boundsMinY = camera.position.y - (canvasHeight / 2) / camera.scale;
        const boundsMaxX = camera.position.x + (canvasWidth / 2) / camera.scale;
        const boundsMaxY = camera.position.y + (canvasHeight / 2) / camera.scale;

        const fullyContained =
            bounds.minX >= boundsMinX &&
            bounds.maxX <= boundsMaxX &&
            bounds.minY >= boundsMinY &&
            bounds.maxY <= boundsMaxY;

        if (!fullyContained) {
            camera.position.x = (bounds.minX + bounds.maxX) * 0.5;
            camera.position.y = (bounds.minY + bounds.maxY) * 0.5;
        }
    }

    /**
     * Sets the 2D camera position.
     *
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     */
    setCameraPosition(x, y) {
        this.#camera.position.x = x;
        this.#camera.position.y = y;
    }

    /**
     * Copies the current cursor position into a target object.
     *
     * @param {{x: number, y: number}} target - Target object.
     * @returns {{x: number, y: number}} The target object.
     */
    getCursorPosition(target) {
        target.x = this.#cursorPosition.x;
        target.y = this.#cursorPosition.y;
        return target;
    }

    /**
     * Orders line segments and converts them to add-line operations.
     *
     * @param {Array<[{x: number, y: number}, {x: number, y: number}]>} lines - Line segments to add.
     * @returns {Array<Object>} Transaction operations.
     */
    #createLineAddOperations(lines) {
        if (lines.length === 0) {
            return [];
        }

        const offsets = [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
        const intersection = { x: 0, y: 0, t: 0, u: 0 };

        const items = lines.map(([a, b], index) => {
            let intersectsLine = false;

            this.#map.iterateLinesWithLine(a.x, a.y, b.x, b.y, line => {
                const hit = Utility.segmentIntersection(
                    a.x, a.y, b.x, b.y,
                    line.v0.x, line.v0.y, line.v1.x, line.v1.y,
                    intersection
                );
                if (hit === null) {
                    return true;
                }
                intersectsLine = true;
                return false;
            });

            const sectorA = offsets.some(([dx, dy]) => this.#map.getSector(a.x + dx, a.y + dy) !== null);
            const sectorB = offsets.some(([dx, dy]) => this.#map.getSector(b.x + dx, b.y + dy) !== null);

            return {
                a,
                b,
                index,
                intersectsLine,
                overlapsSector: sectorA || sectorB,
            };
        });

        let best = items[0];

        items.forEach(item => {
            if (item.intersectsLine > best.intersectsLine ||
                item.intersectsLine === best.intersectsLine &&
                item.overlapsSector > best.overlapsSector) {
                best = item;
            }
        });

        items.splice(items.indexOf(best), 1);

        const result = [best];

        while (items.length > 0) {
            const current = result[result.length - 1].b;

            let nextIndex = items.findIndex(item =>
                item.a.x === current.x && item.a.y === current.y ||
                item.b.x === current.x && item.b.y === current.y
            );

            if (nextIndex === -1) {
                nextIndex = 0;
            }

            const next = items.splice(nextIndex, 1)[0];

            if (next.b.x === current.x && next.b.y === current.y) {
                [next.a, next.b] = [next.b, next.a];
            }

            result.push(next);
        }

        return result.map(item => ({
            op: 'addLine',
            args: [item.a.x, item.a.y, item.b.x, item.b.y],
        }));
    }

    /**
     * Applies a wall texture to selected line surfaces.
     *
     * @param {string} name - Texture name.
     */
    setTextureName(name) {
        const operations = [];

        this.#map.iterateLines(line => {
            [{
                selected: this.#map.isSelected(line, true),
                isFront: true,
                sector: line.frontSector,
                otherSector: line.backSector,
                properties: line.frontProperties,
            }, {
                selected: this.#map.isSelected(line, null, true),
                isFront: false,
                sector: line.backSector,
                otherSector: line.frontSector,
                properties: line.backProperties,
            }].forEach(side => {
                if (!side.selected || side.sector === null) {
                    return;
                }


                const frontSelected = side.isFront ? true : null;
                const backSelected = side.isFront ? null : true;

                const isUpper = this.#map.isSelected(line, frontSelected, backSelected, true);
                const isMiddle = this.#map.isSelected(line, frontSelected, backSelected, null, true);
                const isLower = this.#map.isSelected(line, frontSelected, backSelected, null, null, true);

                const middleTexture = side.properties.getValue('texture_middle');

                if (side.otherSector === null || side.otherSector.properties.getValue('is_void')) {
                    if (isMiddle) {
                        operations.push({
                            op: 'setSideProperty',
                            args: [
                                line.v0.x, line.v0.y,
                                line.v1.x, line.v1.y,
                                side.isFront,
                                'texture_middle',
                                name,
                                false,
                            ],
                        });
                    }
                    return;
                }

                const floorHeight = side.sector.properties.getValue('floor_height');
                const ceilingHeight = side.sector.properties.getValue('ceiling_height');
                const otherFloorHeight = side.otherSector.properties.getValue('floor_height');
                const otherCeilingHeight = side.otherSector.properties.getValue('ceiling_height');

                if (isUpper && ceilingHeight > otherCeilingHeight) {
                    operations.push({
                        op: 'setSideProperty',
                        args: [
                            line.v0.x,
                            line.v0.y,
                            line.v1.x,
                            line.v1.y,
                            side.isFront,
                            'texture_upper',
                            name,
                            false,
                        ],
                    });
                }

                if (isLower && floorHeight < otherFloorHeight) {
                    operations.push({
                        op: 'setSideProperty',
                        args: [
                            line.v0.x,
                            line.v0.y,
                            line.v1.x,
                            line.v1.y,
                            side.isFront,
                            'texture_lower',
                            name,
                            false,
                        ],
                    });
                }
            });
        }, null, null, true);

        if (operations.length > 0) {
            this.#client.sendTransaction(operations);
        }
    }

    /**
     * Applies a flat texture to selected floors and ceilings.
     *
     * @param {string} name - Flat name.
     */
    setFlatName(name) {
        const operations = [];

        this.#map.iterateSectors(sector => {
            const line = sector.lines[0]
            const isFront = line.frontSector === sector;
            if (this.#map.isSelected(sector, null, null, true)) {
                operations.push({
                    op: 'setSectorPropertyBySide',
                    args: [
                        line.v0.x, line.v0.y,
                        line.v1.x, line.v1.y,
                        isFront,
                        'ceiling_texture',
                        name,
                    ],
                });
            }
            if (this.#map.isSelected(sector, null, null, null, null, true)) {
                operations.push({
                    op: 'setSectorPropertyBySide',
                    args: [
                        line.v0.x, line.v0.y,
                        line.v1.x, line.v1.y,
                        isFront,
                        'floor_texture',
                        name,
                    ],
                });
            }
        }, null, null, true);

        if (operations.length > 0) {
            this.#client.sendTransaction(operations);
        }
    }

    /**
     * Sets the active thing type and applies it to selected things.
     *
     * @param {number} typeId - Thing type identifier.
     */
    setThingTypeId(typeId) {
        this.#modeThingTypeId = typeId;

        const operations = [];

        const things = [];

        this.#map.iterateThings(thing => {
            things.push(thing);
        }, null, null, true);

        things.forEach(thing => {
            operations.push({
                op: 'setThingProperty',
                args: [
                    thing.x,
                    thing.y,
                    thing.properties.getValue('z'),
                    thing.properties.getValue('type'),
                    thing.properties.getValue('angle'),
                    'type',
                    typeId,
                ],
            });
        });

        if (things.length > 0) {
            const newSelection = things.map(thing => ({
                type: 'thing',
                x: thing.x,
                y: thing.y,
                z: thing.properties.getValue('z'),
                typeId,
                angle: thing.properties.getValue('angle'),
            }));

            const id = this.#client.sendTransaction(operations);

            if (id === null) {
                this.#applyPendingSelection(newSelection);
            } else {
                this.#pendingSelections.set(id, newSelection);
            }
        }
    }

    /**
     * Gets or creates the preview image for a thing type.
     *
     * @param {number} id - Thing type identifier.
     * @returns {HTMLCanvasElement} Thing preview image.
     */
    #getThingImage(id) {
        let image = this.#thingImageCache.get(id);
        if (image === undefined) {
            const definition = this.#resourceManager.thingDefinitions.find(
                definition => definition.id === id);
            const palette = this.#resourceManager.palettes[0];
            let backgroundImage = null;
            if (definition !== undefined) {
                const frame = definition.rotationFrames[0];
                if (frame !== null) {
                    backgroundImage = Utility.imageDataToCanvas(
                        ResourceUtility.indexedImageToColorData(frame, palette));
                }
            }

            image = Utility.createPreviewImage({
                backgroundColor0: '#ff00ff',
                backgroundColor1: '#cc00cc',
                backgroundImage,
                backgroundImageScale: 2,
                checkersMargin: 2,
                flipY: true,
                labelLines: [`#${id}`, definition === undefined ? '' : definition.name.substring(0, 16)],
                labelY: 16,
            });
            this.#thingImageCache.set(id, image)
        }
        return image;
    }

    /**
     * Clears cached thing images and flat patterns.
     */
    clearCaches() {
        this.#thingImageCache.clear();
        this.#flatPatternCache.clear();
    }

    /**
     * Gets or creates an offscreen canvas chunk.
     *
     * @returns {Object} Canvas chunk record.
     */
    static #createChunk() {
        const chunk = VectorEditor.#chunkPool.pop();
        if (chunk !== undefined) {
            return chunk;
        }

        const canvas = document.createElement('canvas');
        canvas.width = VectorEditor.#CANVAS_CHUNK_SIZE;
        canvas.height = VectorEditor.#CANVAS_CHUNK_SIZE;

        return {
            canvas,
            ctx: canvas.getContext('2d', { desynchronized: true }),
            min: { x: 0, y: 0 },
            max: { x: 0, y: 0 },
            scale: 1,
            dirty: true,
        };
    }

    /**
     * Returns an offscreen canvas chunk to the reuse pool.
     *
     * @param {Object} chunk - Chunk to pool.
     */
    static #poolChunk(chunk) {
        VectorEditor.#chunkPool.push(chunk);
    }

    /**
     * Gets or creates a multiplayer cursor image for a color.
     *
     * @param {string} color - CSS color.
     * @returns {HTMLCanvasElement} Cursor image.
     */
    static #getCursorByColor(color) {
        let cursor = VectorEditor.#cursorByColor.get(color);
        if (cursor === undefined) {
            cursor = Utility.createCrosshairCursor(color, false);
            this.#cursorByColor.set(color, cursor);
        }
        return cursor;
    }
}
