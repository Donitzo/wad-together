import Line from './geometries/line.class.js';
import Sector from './geometries/sector.class.js';
import Thing from './geometries/thing.class.js';
import Vertex from './geometries/vertex.class.js';
import MapMetadata from './properties/mapmetadata.class.js';
import Utility from './utility.class.js';
import MapTransformer from './wad/maptransformer.class.js';

/**
 * Doom-style map data structure.
 */
export default class DoomMap extends EventTarget {
    /** @type {number} Minimum coordinate of map. */
    static COORDINATE_MIN = -32768;
    /** @type {number} Maximum coordinate of map. */
    static COORDINATE_MAX = 32767;

    /** @type {number} Spatial grid size in map units. */
    static #SPATIAL_GRID_CELL_SIZE = 64;

    /**
     * Class for logging composite operations for undo/apply.
     */
    static Transaction = class Transaction {
        /** @type {Array<Object>} Operations performed when the transaction is undone. */
        undoOperations = [];
        /** @type {Array<Object>} Operations performed when the transaction is applied. */
        applyOperations = [];
    };

    #metadata = new MapMetadata();
    /** @type {MapMetadata} Map metadata and global properties. */
    get metadata() {
        return this.#metadata;
    }

    /** @type {Set<Vertex>} All vertices in the map. */
    #vertices = new Set();
    /** @type {Map<string, Vertex>} Vertex lookup by "x,y" key. */
    #vertexMap = new Map();

    /** @type {Map<string, Set<string>>} Temporary line descendants by logical line key. */
    #lineLineages = new Map();

    /** @type {Set<Line>} All lines in the map. */
    #lines = new Set();
    /** @type {Map<string, Line>} Line lookup by "x0,y0:x1,y1" key. */
    #lineMap = new Map();
    /** @type {Set<Line>} Lines modified since last sector rebuild. */
    #modifiedLines = new Set();

    /** @type {Set<Sector>} All sectors in the map. */
    #sectors = new Set();

    /** @type {Set<Thing>} All things in the map. */
    #things = new Set();
    /** @type {Map<string, Thing[]>} Thing lookup buckets by thing key (toKey()). */
    #thingsMap = new Map();

    /** @type {Set<Geometry>} Currently selected geometries. */
    #selection = new Set();
    /** @type {Set<Line>} Selected front sides. */
    #selectedFront = new Set();
    /** @type {Set<Line>} Selected back sides. */
    #selectedBack = new Set();
    /** @type {Set<Line>} Selected upper textures. */
    #selectedUpper = new Set();
    /** @type {Set<Line>} Selected middle textures. */
    #selectedMiddle = new Set();
    /** @type {Set<Line>} Selected lower textures. */
    #selectedLower = new Set();

    /** @type {Map<number, Map<number, Set<Vertex>>>} Vertex spatial index. */
    #spatialGridVertex = new Map();
    /** @type {Map<number, Map<number, Set<Line>>>} Line spatial index. */
    #spatialGridLine = new Map();
    /** @type {Map<number, Map<number, Set<Sector>>>} Sector spatial index. */
    #spatialGridSector = new Map();
    /** @type {Map<number, Map<number, Set<Thing>>>} Thing spatial index. */
    #spatialGridThing = new Map();

    /** @type {?Function} Bound helper for adding geometry to grid. */
    #addGeometryToSpatialGridBound = null;
    /** @type {?Function} Bound helper for removing geometry from grid. */
    #removeGeometryFromSpatialGridBound = null;
    /** @type {?Function} Bound helper for iterating grid cells. */
    #iterateCellWithCallbackBound = null;

    /** @type {?DoomMap.Transaction} Active transaction (operations create undo/redos). */
    #transaction = null;

    ////////////////////////////////////////////////////////////////////////////
    // Constructor

    /**
     * Constructor.
     */
    constructor() {
        super();

        this.#addGeometryToSpatialGridBound = this.#addGeometryToSpatialGrid.bind(this);
        this.#removeGeometryFromSpatialGridBound = this.#removeGeometryFromSpatialGrid.bind(this);
        this.#iterateCellWithCallbackBound = this.#iterateCellWithCallback.bind(this);
    }

    ////////////////////////////////////////////////////////////////////////////
    // String keys

    /**
     * Creates a lookup key for a vertex coordinate.
     *
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     * @returns {string} The vertex lookup key.
     */
    static createVertexKey(x, y) {
        return `${x},${y}`;
    }

    /**
     * Creates an order-independent lookup key for a line segment.
     *
     * @param {number} x0 - The first x-coordinate.
     * @param {number} y0 - The first y-coordinate.
     * @param {number} x1 - The second x-coordinate.
     * @param {number} y1 - The second y-coordinate.
     * @returns {string} The line lookup key.
     */
    static createLineKey(x0, y0, x1, y1) {
        return (x0 < x1) || (x0 === x1 && y0 <= y1)
            ? `${x0},${y0}:${x1},${y1}`
            : `${x1},${y1}:${x0},${y0}`;
    }

    ////////////////////////////////////////////////////////////////////////////
    // Events

    /**
     * Dispatches a map event.
     *
     * @param {string} type - The event type.
     * @param {Object} [detail={}] - Additional event detail values.
     */
    #emitEvent(type, detail = {}) {
        this.dispatchEvent(new CustomEvent(type, {
            detail: { map: this, ...detail },
            bubbles: false,
        }));
    }

    ////////////////////////////////////////////////////////////////////////////
    // Registration helpers

    /**
     * Registers a vertex in the map.
     * Adds the required undo operations to the current transaction.
     *
     * @param {Vertex} vertex - The vertex to register.
     * @param {boolean} [skipBackwardHistory=false] - Whether to omit the undo operation.
     */
    #addVertexPrimitive(vertex, skipBackwardHistory = false) {
        const key = DoomMap.createVertexKey(vertex.x, vertex.y);

        if (this.#vertexMap.has(key)) {
            console.warn(`Attempted to add existing ${vertex}`);
            return;
        }

        this.#vertices.add(vertex);
        this.#vertexMap.set(key, vertex);
        this.#addToSpatialGrid(this.#spatialGridVertex, vertex);

        if (this.#transaction !== null && !skipBackwardHistory) {
            this.#transaction.undoOperations.push({
                op: 'removeVertex',
                args: [vertex.x, vertex.y],
            });
        }

        this.#emitEvent('vertexadded', { vertex });
    }

    /**
     * Unregisters a vertex from the map.
     * Adds the required undo operations to the current transaction.
     *
     * @param {Vertex} vertex - The vertex to unregister.
     */
    #removeVertexPrimitive(vertex) {
        if (!this.#vertices.has(vertex)) {
            console.warn(`Attempted to remove non-existent ${vertex}`);
            return;
        }

        if (this.#selection.has(vertex)) {
            this.select([vertex], 'deselect');
        }

        const key = DoomMap.createVertexKey(vertex.x, vertex.y);

        this.#removeFromSpatialGrid(this.#spatialGridVertex, vertex);
        this.#vertices.delete(vertex);
        this.#vertexMap.delete(key);

        if (this.#transaction !== null) {
            this.#transaction.undoOperations.push({
                op: 'addVertex',
                args: [vertex.x, vertex.y],
            });
        }

        this.#emitEvent('vertexremoved', { vertex });
    }

    /**
     * Registers a line in the map.
     * Adds the required undo operations to the current transaction.
     *
     * @param {Line} line - The line to register.
     */
    #addLinePrimitive(line) {
        const key = DoomMap.createLineKey(line.v0.x, line.v0.y, line.v1.x, line.v1.y);

        if (this.#lineMap.has(key)) {
            console.warn(`Attempted to add existing ${line}`);
            return;
        }

        this.#modifiedLines.add(line);
        this.#lines.add(line);
        this.#lineMap.set(key, line);
        this.#addToSpatialGrid(this.#spatialGridLine, line);

        if (this.#transaction !== null) {
            this.#transaction.undoOperations.push({
                op: 'removeLine',
                args: [line.v0.x, line.v0.y, line.v1.x, line.v1.y],
            });
        }

        this.#emitEvent('lineadded', { line });
    }

    /**
     * Unregisters a line from the map.
     * Adds the required undo operations to the current transaction.
     *
     * @param {Line} line - The line to unregister.
     */
    #removeLinePrimitive(line) {
        if (!this.#lines.has(line)) {
            console.warn(`Attempted to remove non-existent ${line}`);
            return;
        }

        if (this.#selection.has(line)) {
            this.select([line], 'deselect');
        }

        const key = DoomMap.createLineKey(line.v0.x, line.v0.y, line.v1.x, line.v1.y);

        this.#modifiedLines.add(line);

        this.#removeFromSpatialGrid(this.#spatialGridLine, line);

        line.removeFromVertexLines();

        this.#lines.delete(line);
        this.#lineMap.delete(key);

        if (this.#transaction !== null) {
            DoomMap.createCopyLineOperations(this.#transaction.undoOperations, line,
                line.v0.x, line.v0.y, line.v1.x, line.v1.y
            );

            this.#transaction.undoOperations.push({
                op: 'addLine',
                args: [line.v0.x, line.v0.y, line.v1.x, line.v1.y],
            });
        }

        this.#emitEvent('lineremoved', { line });
    }

    /**
     * Registers a thing in the map.
     * Adds the required undo operations to the current transaction.
     *
     * @param {Thing} thing - The thing to register.
     */
    #addThingPrimitive(thing) {
        const key = thing.toKey();

        let bucket = this.#thingsMap.get(key);
        if (bucket === undefined) {
            bucket = [];
            this.#thingsMap.set(key, bucket);
        } else if (bucket.includes(thing)) {
            console.warn(`Attempted to add existing ${thing}`);
            return;
        }
        bucket.push(thing);

        this.#things.add(thing);

        this.#addToSpatialGrid(this.#spatialGridThing, thing);

        if (this.#transaction !== null) {
            const x = thing.x;
            const y = thing.y;
            const z = thing.properties.getValue('z');
            const typeId = thing.properties.getValue('type');
            const angle = thing.properties.getValue('angle');

            this.#transaction.undoOperations.push({
                op: 'removeThing',
                args: [x, y, z, typeId, angle],
            });

            this.#transaction.applyOperations.push({
                op: 'addThing',
                args: [x, y, z, typeId, angle],
            });

            thing.properties.iterate((property, value) => {
                this.#transaction.applyOperations.push({
                    op: 'setThingProperty',
                    args: [x, y, z, typeId, angle, property, value],
                });
            });
        }

        this.#emitEvent('thingadded', { thing });
    }

    /**
     * Unregisters a thing from the map.
     * Adds the required undo operations to the current transaction.
     *
     * @param {Thing} thing - The thing to unregister.
     */
    #removeThingPrimitive(thing) {
        if (!this.#things.has(thing)) {
            console.warn(`Attempted to remove non-existent ${thing}`);
            return;
        }

        if (this.#selection.has(thing)) {
            this.select([thing], 'deselect');
        }

        const key = thing.toKey();

        this.#removeFromSpatialGrid(this.#spatialGridThing, thing);

        this.#things.delete(thing);

        const bucket = this.#thingsMap.get(key);
        if (bucket !== undefined) {
            const i = bucket.indexOf(thing);
            if (i > -1) {
                bucket.splice(i, 1);
            }
            if (bucket.length === 0) {
                this.#thingsMap.delete(key);
            }
        }

        if (this.#transaction !== null) {
            const x = thing.x;
            const y = thing.y;
            const z = thing.properties.getValue('z');
            const typeId = thing.properties.getValue('type');
            const angle = thing.properties.getValue('angle');

            thing.properties.iterate((property, value) => {
                this.#transaction.undoOperations.push({
                    op: 'setThingProperty',
                    args: [x, y, z, typeId, angle, property, value],
                });
            });

            this.#transaction.undoOperations.push({
                op: 'addThing',
                args: [x, y, z, typeId, angle],
            });
        }

        this.#emitEvent('thingremoved', { thing });
    }

    /**
     * Registers a sector in the map.
     *
     * @param {Sector} sector - The sector to register.
     */
    #addSectorPrimitive(sector) {
        this.#sectors.add(sector);

        this.#addToSpatialGrid(this.#spatialGridSector, sector);

        this.#emitEvent('sectoradded', { sector });
    }

    /**
     * Unregisters a sector from the map.
     *
     * @param {Sector} sector - The sector to unregister.
     */
    #removeSectorPrimitive(sector) {
        if (!this.#sectors.has(sector)) {
            console.error(`Attempted to remove non-existent ${sector}`);
            throw new Error(`Attempted to remove non-existent ${sector}`);
        }

        if (this.#selection.has(sector)) {
            this.select([sector], 'deselect');
        }

        sector.removeFromMap();

        this.#removeFromSpatialGrid(this.#spatialGridSector, sector);

        this.#sectors.delete(sector);

        this.#emitEvent('sectorremoved', { sector });
    }

    /**
     * Appends operations that copy all properties from a line to another line definition.
     *
     * @param {Array<Object>} operations - The operation array to append to.
     * @param {Line} originalLine - The line whose properties are copied.
     * @param {number} x0 - The destination start x-coordinate.
     * @param {number} y0 - The destination start y-coordinate.
     * @param {number} x1 - The destination end x-coordinate.
     * @param {number} y1 - The destination end y-coordinate.
     * @param {boolean} [flip=false] - Whether to swap the front and back side properties.
     */
    static createCopyLineOperations(operations, originalLine, x0, y0, x1, y1, flip = false) {
        originalLine.properties.iterate((property, value) => {
            operations.push({
                op: 'setLineProperty',
                args: [x0, y0, x1, y1, property, value],
            });
        });

        originalLine.frontProperties.iterate((property, value) => {
            operations.push({
                op: 'setSideProperty',
                args: [x0, y0, x1, y1, !flip, property, value, false],
            });
        });

        originalLine.backProperties.iterate((property, value) => {
            operations.push({
                op: 'setSideProperty',
                args: [x0, y0, x1, y1, flip, property, value, false],
            });
        });

        originalLine.frontSectorProperties.iterate((property, value) => {
            operations.push({
                op: 'setLineSectorPropertyBySide',
                args: [x0, y0, x1, y1, !flip, property, value],
            });
        });

        originalLine.backSectorProperties.iterate((property, value) => {
            operations.push({
                op: 'setLineSectorPropertyBySide',
                args: [x0, y0, x1, y1, flip, property, value],
            });
        });
    }

    ////////////////////////////////////////////////////////////////////////////
    // Sector construction

    /**
     * Rebuilds sectors affected by lines modified since the previous rebuild.
     */
    rebuildSectors() {
        // Nothing to do if no geometry was touched since last rebuild
        if (this.#modifiedLines.size === 0) {
            return;
        }

        // Collect affected sectors
        const sectorsToRemove = new Set();

        const addLineSectors = line => {
            if (line.frontSector !== null) {
                sectorsToRemove.add(line.frontSector);
            }

            if (line.backSector !== null) {
                sectorsToRemove.add(line.backSector);
            }
        };

        // Trace modified lines until the next non-degenerate line.
        // These lines are those with the affected sectors.
        this.#modifiedLines.forEach(startLine => {
            const visitedLines = new Set();
            const stack = [startLine];

            while (stack.length > 0) {
                const line = stack.pop();

                if (visitedLines.has(line)) {
                    continue;
                }

                visitedLines.add(line);

                if (line.frontSector !== null || line.backSector !== null) {
                    addLineSectors(line);
                    continue;
                }

                line.v0.lines.forEach(connectedLine => {
                    if (!visitedLines.has(connectedLine)) {
                        stack.push(connectedLine);
                    }
                });

                line.v1.lines.forEach(connectedLine => {
                    if (!visitedLines.has(connectedLine)) {
                        stack.push(connectedLine);
                    }
                });
            }
        });

        // Add sector lines to the modified lines list (handles disconnected parent sectors)
        sectorsToRemove.forEach(sector => {
            sector.lines.forEach(line => {
                this.#modifiedLines.add(line);
            });
        });

        // Remove affected sectors and open sides
        sectorsToRemove.forEach(sector => {
            this.#removeSectorPrimitive(sector);
        });

        // Seed open edges to traverse (front- / backside of a line based on direction).
        // Any edge blocked by a sector is considered unchanged.
        // edges = [{ from, to, line, front }]
        const edges = [];

        for (const line of this.#modifiedLines) {
            if (line.frontSector === null) {
                edges.push({
                    from: line.v0,
                    to: line.v1,
                    line,
                    front: true,
                    key: `${line.v0.x},${line.v0.y}:${line.v1.x},${line.v1.y}:true`
                });
            }
            if (line.backSector === null) {
                edges.push({
                    from: line.v1,
                    to: line.v0,
                    line,
                    front: false,
                    key: `${line.v1.x},${line.v1.y}:${line.v0.x},${line.v0.y}:false`
                });
            }
        }

        // Temporary and permanent list of visited edges to ignore.
        // Temporary edges are for the current loop.
        // Persistent edges are for closed loops.
        const visitedEdgeTemporary = new Set();
        const visitedEdgePersistent = new Set();

        // Outgoing left-side half-edges from vertex, sorted by angle
        const outgoing = new Map();

        const getOutgoing = vertex => {
            let list = outgoing.get(vertex);
            if (list !== undefined) {
                return list;
            }

            list = [];

            // Outgoing open half-edges
            vertex.lines.forEach(line => {
                if (line.v0 === vertex && line.frontSector === null) {
                    list.push({
                        from: vertex,
                        to: line.v1,
                        line,
                        front: true,
                        key: `${vertex.x},${vertex.y}:${line.v1.x},${line.v1.y}:true`
                    });
                } else if (line.v1 === vertex && line.backSector === null) {
                    list.push({
                        from: vertex,
                        to: line.v0,
                        line,
                        front: false,
                        key: `${vertex.x},${vertex.y}:${line.v0.x},${line.v0.y}:false`
                    });
                }
            });

            // Sort by angle
            list.sort((a, b) => {
                const a0 = Utility.angleTo(vertex.x, vertex.y, a.to.x, a.to.y);
                const b0 = Utility.angleTo(vertex.x, vertex.y, b.to.x, b.to.y);
                return a0 - b0;
            });

            outgoing.set(vertex, list);

            return list;
        }

        // Given an incoming half-edge, pick the outgoing edge that makes the smallest positive CCW turn
        // from the reverse direction. Basically, this function traces the continuing left edge.
        const nextLeft = edge => {
            // The pivot is the end of the edge
            const pivot = edge.to;

            // Outgoing edges from the pivot
            const outs = getOutgoing(pivot);

            // What angle is the original edge at relative to the pivot?
            const baseAngle = Utility.angleTo(pivot.x, pivot.y, edge.from.x, edge.from.y);

            let best = null;
            let bestDelta = Infinity;
            let returnEdge = null;

            outs.forEach(candidate => {
                // Do not consider temporarily, permanently finished edges, or the original edge
                if (visitedEdgeTemporary.has(candidate.key) ||
                    visitedEdgePersistent.has(candidate.key) ||
                    candidate.key === edge.key) {
                    return;
                }

                // CCW turn size
                const angle = Utility.angleTo(pivot.x, pivot.y, candidate.to.x, candidate.to.y);
                const delta = Utility.angleToCcw(baseAngle, angle);

                // Smallest valid angle = atan(1 / 65536) = 0.000015. Any smaller is an error.
                if (delta < 1e-10) {
                    returnEdge = candidate;
                } else if (delta < bestDelta) {
                    best = candidate;
                    bestDelta = delta;
                }
            });

            // The best CCW edge, or if no other edge, the return edge.
            // Returns null if no open edge exists.
            return best ?? returnEdge;
        };

        // Visited vertices (used for revisitation / pruning within the current loop).
        // Reaching the same vertex again before closure means the walk has backtracked
        // or formed a spur, so the loop must be pruned back to the previous visit.
        const visitedVertex = new Set();

        // Finished loops
        const loops = [];

        // Trace CCW loops (follow left edges). Mark edges visited once we confirm a valid CCW loop.
        // Keep only positive-area loops (CCW), which are interior faces.
        edges.forEach(start => {
            // The edge has already been used in a loop
            if (visitedEdgePersistent.has(start.key)) {
                return;
            }

            // Clear temporary visitations
            visitedEdgeTemporary.clear();
            visitedVertex.clear();

            // Keep track of constructed edges and coordinates
            const loopEdges = [];
            const xy = [];

            let current = start;
            let attempts = 0;
            let closed = false;

            // Walk edges until we return to the start edge (closed) or run out of non-visited edges
            while (true) {
                // If we visited the same vertex again (ie. we backtracked to it)
                // then remove all the edges after that vertex
                const vertexKey = `${current.to.x},${current.to.y}`;

                if (visitedVertex.has(vertexKey)) {
                    // Remove all edges after the last occurrence of this vertex.
                    // Since visitations remain, the edges will not be revisited, pruning the full branch.
                    while (loopEdges.length > 0) {
                        const e = loopEdges.pop();
                        xy.pop();
                        xy.pop();
                        if (`${e.from.x},${e.from.y}` === vertexKey) {
                            break;
                        }
                    }

                    // Nothing left to remove
                    if (loopEdges.length === 0) {
                        break;
                    }

                    // Rewind to the vertex before the problematic branch
                    current = loopEdges[loopEdges.length - 1];
                } else {
                    visitedVertex.add(vertexKey);

                    loopEdges.push(current);
                    xy.push(current.from.x, current.from.y);
                }

                // Select the next left edge (but not itself)
                current = nextLeft(current);
                if (current === null) {
                    break;
                }

                // Add current edge to ignore list (note: start was never added so we can return)
                visitedEdgeTemporary.add(current.key);

                if (attempts++ > 1000000) {
                    console.warn('Stuck in an edge loop');
                    break;
                }

                // The next edge is the start edge. Loop is finished.
                if (current.key === start.key) {
                    closed = true;
                    break;
                }
            }

            // Must be a closed polygon with at least 3 vertices
            if (!closed || xy.length < 6) {
                return;
            }

            // Close ring for area test
            xy.push(xy[0], xy[1]);

            // Negative area means interior face
            if (Utility.signedArea2d(xy) < 0) {
                // Valid loop. Add to persistent ignore list and loops.
                loopEdges.forEach(edge => {
                    visitedEdgePersistent.add(edge.key);
                });
                loops.push(loopEdges);
            }
        });

        const newSectors = [];

        // For each interior loop, construct a sector and assign it to the left side of each edge
        loops.forEach(loop => {
            const newLines = loop.map(edge => ({
                v0: edge.line.v0,
                v1: edge.line.v1,
                front: edge.front,
            }));
            const sector = new Sector(this, this.#lineMap, newLines);
            newSectors.push(sector);
            this.#addSectorPrimitive(sector);
        });

        this.#modifiedLines.forEach(l => {
            const hasFront = l.frontSector !== null && !l.frontSector.properties.getValue('is_void');
            const hasBack = l.backSector !== null && !l.backSector.properties.getValue('is_void');
            const isDoubleSided = hasFront && hasBack;
            if (isDoubleSided && l.properties.getValue('clear_double_sided')) {
                this.setLineProperty(l.v0.x, l.v0.y, l.v1.x, l.v1.y, 'clear_double_sided', false);

                if (!l.properties.getValue('texture_middle_explicit')) {
                    this.setSideProperty(l.v0.x, l.v0.y, l.v1.x, l.v1.y, true, 'texture_middle', '-');
                    this.setSideProperty(l.v0.x, l.v0.y, l.v1.x, l.v1.y, false, 'texture_middle', '-');
                }

                if (!l.properties.getValue('impassable_explicit')) {
                    this.setLineProperty(l.v0.x, l.v0.y, l.v1.x, l.v1.y, 'impassable', false);
                }
            }
        });

        this.#modifiedLines.clear();

        this.#emitEvent('sectorsrebuilt', { sectors: this.#sectors });
    }

    ////////////////////////////////////////////////////////////////////////////
    // Spatial grid

    /**
     * Adds the grid cells surrounding a point to the visited set.
     *
     * @param {Set<number>} visited - The grid-cell keys to update.
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     * @param {number} margin - The margin around the point.
     */
    static #visitSpatialGridCell(visited, x, y, margin) {
        const xMin = Math.floor(x - margin);
        const xMax = Math.floor(x + margin);
        const yMin = Math.floor(y - margin);
        const yMax = Math.floor(y + margin);

        for (let xi = xMin; xi <= xMax; xi++) {
            for (let yi = yMin; yi <= yMax; yi++) {
                visited.add((xi + 5_000_000) + (yi + 5_000_000) * 10_000_000);
            }
        }
    }

    /**
     * Traverses grid cells touched by a line segment and invokes a callback for each cell.
     *
     * @param {Map<number, Map<number, Set<object>>>} grid - The spatial grid to traverse.
     * @param {number} x0 - The segment start x-coordinate.
     * @param {number} y0 - The segment start y-coordinate.
     * @param {number} x1 - The segment end x-coordinate.
     * @param {number} y1 - The segment end y-coordinate.
     * @param {Function} callback - The function called for each visited cell.
     * @param {*} [callbackArgument=null] - An optional value passed to the callback.
     */
    static #traverseSpatialGrid(grid, x0, y0, x1, y1, callback, callbackArgument = null) {
        const cellSize = DoomMap.#SPATIAL_GRID_CELL_SIZE;
        const marginUnits = 8;
        const margin = marginUnits / cellSize;

        const dx = x1 - x0;
        const dy = y1 - y0;

        const length = Math.hypot(dx, dy);

        const visited = new Set();

        DoomMap.#visitSpatialGridCell(visited, x0, y0, margin);

        if (length > 0) {
            DoomMap.#visitSpatialGridCell(visited, x1, y1, margin);

            const stepX = dx > 0 ? 1 : -1;
            const stepY = dy > 0 ? 1 : -1;

            const tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
            const tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);

            let x = Math.floor(x0);
            let y = Math.floor(y0);

            let tMaxX = dx === 0 ? Infinity : tDeltaX * (stepX > 0 ? (x + 1) - x0 : x0 - x);
            let tMaxY = dy === 0 ? Infinity : tDeltaY * (stepY > 0 ? (y + 1) - y0 : y0 - y);

            while (true) {
                const tNext = Math.min(tMaxX, tMaxY);
                if (tNext > 1) {
                    break;
                }

                const hitX = x0 + dx * tNext;
                const hitY = y0 + dy * tNext;

                DoomMap.#visitSpatialGridCell(visited, hitX, hitY, margin);

                if (tMaxX < tMaxY) {
                    tMaxX += tDeltaX;
                    x += stepX;
                } else if (tMaxY < tMaxX) {
                    tMaxY += tDeltaY;
                    y += stepY;
                } else {
                    tMaxX += tDeltaX;
                    tMaxY += tDeltaY;
                    x += stepX;
                    y += stepY;
                }
            }
        }

        for (const key of visited) {
            const x = (key % 10_000_000) - 5_000_000;
            const y = Math.floor(key / 10_000_000) - 5_000_000;
            if (callback(grid, x, y, callbackArgument) === false) {
                return;
            }
        }
    }

    /**
     * Adds geometry to spatial-grid by point.
     *
     * @param {Map<number, Map<number, Set<object>>>} grid - The spatial grid to update.
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     * @param {Object} geometry - The geometry to add.
     */
    #addGeometryToSpatialGrid(grid, x, y, geometry) {
        let column = grid.get(x);
        if (column === undefined) {
            grid.set(x, (column = new Map()));
        }
        let geometries = column.get(y);
        if (geometries === undefined) {
            column.set(y, (geometries = new Set()));
        }
        geometries.add(geometry);
    }

    /**
     * Removes geometry from spatial-grid by point.
     *
     * @param {Map<number, Map<number, Set<object>>>} grid - The spatial grid to update.
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     * @param {Object} geometry - The geometry to remove.
     */
    #removeGeometryFromSpatialGrid(grid, x, y, geometry) {
        const column = grid.get(x);
        if (column !== undefined) {
            const geometries = column.get(y);
            if (geometries !== undefined) {
                geometries.delete(geometry)
                if (geometries.size === 0) {
                    column.delete(y);
                }
            }
            if (column.size === 0) {
                grid.delete(x);
            }
        }
    }

    /**
     * Adds geometry to every spatial-grid cell covered by its bounds.
     *
     * @param {Map<number, Map<number, Set<object>>>} grid - The spatial grid to update.
     * @param {Object} geometry - The geometry to add.
     */
    #addToSpatialGrid(grid, geometry) {
        const cellSize = DoomMap.#SPATIAL_GRID_CELL_SIZE;

        if (grid === this.#spatialGridLine) {
            DoomMap.#traverseSpatialGrid(
                grid,
                geometry.v0.x / cellSize,
                geometry.v0.y / cellSize,
                geometry.v1.x / cellSize,
                geometry.v1.y / cellSize,
                this.#addGeometryToSpatialGridBound,
                geometry
            );
            return;
        }

        const bounds = geometry.bounds;

        const minX = Math.floor(bounds.min.x / cellSize);
        const minY = Math.floor(bounds.min.y / cellSize);
        const maxX = Math.floor(bounds.max.x / cellSize);
        const maxY = Math.floor(bounds.max.y / cellSize);

        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                this.#addGeometryToSpatialGrid(grid, x, y, geometry);
            }
        }
    }

    /**
     * Removes geometry from every spatial-grid cell covered by its bounds.
     *
     * @param {Map<number, Map<number, Set<object>>>} grid - The spatial grid to update.
     * @param {Object} geometry - The geometry to remove.
     */
    #removeFromSpatialGrid(grid, geometry) {
        const cellSize = DoomMap.#SPATIAL_GRID_CELL_SIZE;

        if (grid === this.#spatialGridLine) {
            DoomMap.#traverseSpatialGrid(
                grid,
                geometry.v0.x / cellSize,
                geometry.v0.y / cellSize,
                geometry.v1.x / cellSize,
                geometry.v1.y / cellSize,
                this.#removeGeometryFromSpatialGridBound,
                geometry
            );
            return;
        }

        const bounds = geometry.bounds;

        const minX = Math.floor(bounds.min.x / cellSize);
        const minY = Math.floor(bounds.min.y / cellSize);
        const maxX = Math.floor(bounds.max.x / cellSize);
        const maxY = Math.floor(bounds.max.y / cellSize);

        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                this.#removeGeometryFromSpatialGrid(grid, x, y, geometry);
            }
        }
    }

    ////////////////////////////////////////////////////////////////////////////
    // Geometry iterators

    /**
     * Invokes a callback for each geometry in one spatial-grid cell.
     *
     * @param {Map<number, Map<number, Set<object>>>} grid - The spatial grid to query.
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     * @param {Function} callback - The callback invoked for each geometry.
     */
    #iterateCellWithCallback(grid, x, y, callback) {
        const column = grid.get(x);
        if (column !== undefined) {
            const geometries = column.get(y);
            if (geometries !== undefined) {
                geometries.forEach(callback)
            }
        }
    }

    /**
     * Invokes a callback for geometry stored in cells touched by a line segment.
     *
     * @param {number} x0 - The segment start x-coordinate.
     * @param {number} y0 - The segment start y-coordinate.
     * @param {number} x1 - The segment end x-coordinate.
     * @param {number} y1 - The segment end y-coordinate.
     * @param {Map<number, Map<number, Set<object>>>} grid - The spatial grid to query.
     * @param {Function} callback - The callback invoked for matching geometry.
     */
    #iterateGeometryWithLine(x0, y0, x1, y1, grid, callback) {
        const cellSize = DoomMap.#SPATIAL_GRID_CELL_SIZE;

        DoomMap.#traverseSpatialGrid(
            grid,
            x0 / cellSize,
            y0 / cellSize,
            x1 / cellSize,
            y1 / cellSize,
            this.#iterateCellWithCallbackBound,
            callback
        );
    }

    /**
     * Iterates geometry of a given type with optional bounds and selection filtering.
     *
     * @param {Function} type - The geometry constructor used for type filtering.
     * @param {Map<number, Map<number, Set<object>>>} grid - The spatial grid to query.
     * @param {Iterable<object>} array - The complete geometry collection used for unbounded iteration.
     * @param {Function} callback - The callback invoked for each matching geometry.
     * @param {?object} [boundsMin=null] - The minimum query bounds, or `null` for no bounds.
     * @param {?object} [boundsMax=null] - The maximum query bounds, or `null` for no bounds.
     * @param {boolean} [selectionOnly=false] - Whether to include only selected geometry.
     */
    #iterateGeometry(type, grid, array, callback, boundsMin = null, boundsMax = null, selectionOnly = false) {
        if (boundsMin === null || boundsMax === null) {
            if (selectionOnly) {
                this.#selection.forEach(geometry => {
                    if (geometry instanceof type) {
                        callback(geometry, true);
                    }
                });
                return;
            }

            for (const geometry of array) {
                if (callback(geometry, this.#selection.has(geometry)) === false) {
                    return;
                }
            }
            return;
        }

        const cellSize = DoomMap.#SPATIAL_GRID_CELL_SIZE;
        const marginUnits = 8;

        const boundsMinX = boundsMin.x - marginUnits;
        const boundsMinY = boundsMin.y - marginUnits;
        const boundsMaxX = boundsMax.x + marginUnits;
        const boundsMaxY = boundsMax.y + marginUnits;

        const minX = Math.floor(boundsMinX / cellSize);
        const minY = Math.floor(boundsMinY / cellSize);
        const maxX = Math.floor(boundsMaxX / cellSize);
        const maxY = Math.floor(boundsMaxY / cellSize);

        const visited = new Set();

        for (let x = minX; x <= maxX; x++) {
            const column = grid.get(x);
            if (column === undefined) {
                continue;
            }

            for (let y = minY; y <= maxY; y++) {
                const cell = column.get(y);
                if (cell === undefined) {
                    continue;
                }

                for (const geometry of cell) {
                    if (visited.has(geometry)) {
                        continue;
                    }
                    visited.add(geometry);

                    const selected = this.#selection.has(geometry);

                    const bounds = geometry.bounds;
                    if ((!selectionOnly || selected) &&
                        bounds.max.x >= boundsMinX &&
                        bounds.min.x <= boundsMaxX &&
                        bounds.max.y >= boundsMinY &&
                        bounds.min.y <= boundsMaxY) {
                        if (callback(geometry, selected) === false) {
                            return;
                        }
                    }
                }
            }
        }
    }

    /**
     * Iterates vertices within the bounds.
     *
     * @param {function(Vertex, boolean): (boolean|void)} callback - Receives each vertex and its selected state; return `false` to stop.
     * @param {?object} [boundsMin=null] - The minimum query bounds, or `null` for no bounds.
     * @param {?object} [boundsMax=null] - The maximum query bounds, or `null` for no bounds.
     * @param {boolean} [selectionOnly=false] - Whether to include only selected vertices.
     */
    iterateVertices(callback, boundsMin = null, boundsMax = null, selectionOnly = false) {
        this.#iterateGeometry(Vertex, this.#spatialGridVertex, this.#vertices,
            callback, boundsMin, boundsMax, selectionOnly
        );
    }

    /**
     * Iterates lines within the bounds.
     *
     * @param {function(Line, boolean): (boolean|void)} callback - Receives each line and its selected state; return `false` to stop.
     * @param {?object} [boundsMin=null] - The minimum query bounds, or `null` for no bounds.
     * @param {?object} [boundsMax=null] - The maximum query bounds, or `null` for no bounds.
     * @param {boolean} [selectionOnly=false] - Whether to include only selected lines.
     */
    iterateLines(callback, boundsMin = null, boundsMax = null, selectionOnly = false) {
        this.#iterateGeometry(Line, this.#spatialGridLine, this.#lines, callback, boundsMin, boundsMax,
            selectionOnly
        );
    }

    /**
     * Iterates lines stored in spatial-grid cells touched by a segment.
     *
     * @param {number} x0 - The segment start x-coordinate.
     * @param {number} y0 - The segment start y-coordinate.
     * @param {number} x1 - The segment end x-coordinate.
     * @param {number} y1 - The segment end y-coordinate.
     * @param {function(Line): (boolean|void)} callback - The callback invoked for each candidate line.
     */
    iterateLinesWithLine(x0, y0, x1, y1, callback) {
        this.#iterateGeometryWithLine(x0, y0, x1, y1, this.#spatialGridLine, callback);
    }

    /**
     * Iterates sectors within the bounds.
     *
     * @param {function(Sector, boolean): (boolean|void)} callback - Receives each sector and its selected state; return `false` to stop.
     * @param {?object} [boundsMin=null] - The minimum query bounds, or `null` for no bounds.
     * @param {?object} [boundsMax=null] - The maximum query bounds, or `null` for no bounds.
     * @param {boolean} [selectionOnly=false] - Whether to include only selected sectors.
     */
    iterateSectors(callback, boundsMin = null, boundsMax = null, selectionOnly = false) {
        this.#iterateGeometry(Sector, this.#spatialGridSector, this.#sectors, callback, boundsMin, boundsMax,
            selectionOnly
        );
    }

    /**
     * Iterates things within the bounds.
     *
     * @param {function(Thing, boolean): (boolean|void)} callback - Receives each thing and its selected state; return `false` to stop.
     * @param {?object} [boundsMin=null] - The minimum query bounds, or `null` for no bounds.
     * @param {?object} [boundsMax=null] - The maximum query bounds, or `null` for no bounds.
     * @param {boolean} [selectionOnly=false] - Whether to include only selected things.
     */
    iterateThings(callback, boundsMin = null, boundsMax = null, selectionOnly = false) {
        this.#iterateGeometry(Thing, this.#spatialGridThing, this.#things, callback, boundsMin, boundsMax,
            selectionOnly
        );
    }

    ////////////////////////////////////////////////////////////////////////////
    // Transactions

    /**
     * Begins recording map mutations in a new transaction.
     */
    beginTransaction() {
        if (this.#transaction !== null) {
            console.error('Attempted to start a new transaction while one is active');
            throw new Error('Attempted to start a new transaction while one is active');
        }

        console.log('Begin transaction');

        this.#transaction = new DoomMap.Transaction();
    }

    /**
     * Ends and returns the created transaction.
     *
     * @returns {DoomMap.Transaction} The completed transaction.
     */
    endTransaction() {
        if (this.#transaction === null) {
            console.error('Attempted to end non-existent transaction');
            throw new Error('Attempted to end non-existent transaction');
        }

        const t = this.#transaction;
        t.undoOperations.reverse();
        this.#transaction = null;

        console.log(`Ended transaction (${t.undoOperations.length} undos, ${t.applyOperations.length} redos)`);
        //console.debug('Full transaction:', t);

        return t;
    }

    ////////////////////////////////////////////////////////////////////////////
    // Geometry manipulation

    /**
     * Creates and / or returns a vertex at a point.
     * Adds the required apply and undo operations to the current transaction.
     *
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     * @returns {Vertex} The old or newly created vertex.
     */
    addVertex(x, y) {
        const cellSize = DoomMap.#SPATIAL_GRID_CELL_SIZE;

        const vx = Math.round(x);
        const vy = Math.round(y);

        if (vx < DoomMap.COORDINATE_MIN || vx > DoomMap.COORDINATE_MAX ||
            vy < DoomMap.COORDINATE_MIN || vy > DoomMap.COORDINATE_MAX) {
            console.error(`Vertex out of bounds: (${vx}, ${vy})`);
            throw new Error(`Vertex out of bounds: (${vx}, ${vy})`);
        }

        const key = DoomMap.createVertexKey(vx, vy);

        const existing = this.#vertexMap.get(key);
        if (existing !== undefined) {
            return existing;
        }

        const linesToSplit = [];

        const cellX = Math.floor(vx / cellSize);
        const cellY = Math.floor(vy / cellSize);

        const column = this.#spatialGridLine.get(cellX);
        if (column !== undefined) {
            const lines = column.get(cellY);
            if (lines !== undefined) {
                lines.forEach(line => {
                    if (line.containsPoint(vx, vy)) {
                        linesToSplit.push(line);
                    }
                });
            }
        }

        const vertex = new Vertex(vx, vy);

        // Do not record undo operations if this vertex splits lines
        this.#addVertexPrimitive(vertex, linesToSplit.length > 0);

        if (linesToSplit.length > 0) {
            // First remove all old lines
            linesToSplit.forEach(line => {
                this.#removeLinePrimitive(line);
            });

            // Then record the undo
            if (this.#transaction !== null) {
                this.#transaction.undoOperations.push({
                    op: 'removeVertex',
                    args: [vx, vy],
                });
            }

            linesToSplit.forEach(line => {
                const keyA = DoomMap.createLineKey(line.v0.x, line.v0.y, vertex.x, vertex.y);
                if (!this.#lineMap.has(keyA)) {
                    const newLine = line.clone(this.#vertexMap, line.v0, vertex);
                    if (newLine === null) {
                        console.error(`Failed to split line between ${line.v0} to ${line.v1}`);
                        throw new Error(`Failed to split line between ${line.v0} to ${line.v1}`);
                    }
                    this.#addLinePrimitive(newLine);
                }

                const keyB = DoomMap.createLineKey(vertex.x, vertex.y, line.v1.x, line.v1.y);
                if (!this.#lineMap.has(keyB)) {
                    const newLine = line.clone(this.#vertexMap, vertex, line.v1);
                    if (newLine === null) {
                        console.error(`Failed to split line between ${line.v0} to ${line.v1}`);
                        throw new Error(`Failed to split line between ${line.v0} to ${line.v1}`);
                    }
                    this.#addLinePrimitive(newLine);
                }
            });
        }

        // Applying operation only needs to add the single vertex
        if (this.#transaction !== null) {
            this.#transaction.applyOperations.push({
                op: 'addVertex',
                args: [vx, vy],
            });
        }

        return vertex;
    }

    /**
     * Removes a vertex and all lines attached to it.
     * Adds the required apply and undo operations to the current transaction.
     *
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     */
    removeVertex(x, y) {
        const vx = Math.round(x);
        const vy = Math.round(y);

        const key = DoomMap.createVertexKey(vx, vy);

        const vertex = this.#vertexMap.get(key);
        if (vertex === undefined) {
            return;
        }

        while (vertex.lines.length > 0) {
            this.#removeLinePrimitive(vertex.lines[0]);
        }

        this.#removeVertexPrimitive(vertex);

        if (this.#transaction !== null) {
            this.#transaction.applyOperations.push({
                op: 'removeVertex',
                args: [vx, vy],
            });
        }
    }

    /**
     * Adds a line segment and automatically splits intersected geometry.
     * Adds the required apply and undo operations to the current transaction.
     *
     * @param {number} fromX - The start x-coordinate.
     * @param {number} fromY - The start y-coordinate.
     * @param {number} toX - The end x-coordinate.
     * @param {number} toY - The end y-coordinate.
     * @param {?Line} [templateLine=null] - A line whose properties are copied to new segments.
     * @param {boolean} [skipForwardHistory=false] - Whether to omit the apply operation from transaction history.
     * @param {?boolean} [templateFlip=null] - An optional override for template-side flipping.
     * @param {?boolean} [autoclearTexture=true]
     *     Whether to automatically clear the middle texture when the line turns double-sided.
     * @param {?Set<string>} [lineage=null] - Descendant line keys.
     */
    addLine(fromX, fromY, toX, toY, templateLine = null, skipForwardHistory = false, templateFlip = null,
        autoclearTexture = true, lineage = null) {
        const x0 = Math.round(fromX);
        const y0 = Math.round(fromY);
        const x1 = Math.round(toX);
        const y1 = Math.round(toY);

        // Is a point
        if (x0 === x1 && y0 === y1) {
            return;
        }

        // Keep track of line lineage
        const createLineage = lineage === null;
        if (createLineage) {
            lineage = new Set();
        }

        const oldKey = DoomMap.createLineKey(x0, y0, x1, y1);

        // Create vertices
        const v0 = this.addVertex(x0, y0);
        const v1 = this.addVertex(x1, y1);

        // Does a line already exist?
        if (this.#lineMap.has(oldKey)) {
            // If this is the first line, add transaction and return
            if (this.#transaction !== null && !skipForwardHistory) {
                this.#transaction.applyOperations.push({
                    op: 'addLine',
                    args: [x0, y0, x1, y1],
                });
            }
            return;
        }

        const temp = { x: 0, y: 0 };
        const intersection = { x: 0, y: 0, t: 0, u: 0 };

        const boundsMin = { x: 0, y: 0 };
        const boundsMax = { x: 0, y: 0 };

        if (templateLine === null) {
            if (v0.lines.length > 0) {
                templateLine = v0.lines[0];
            } else if (v1.lines.length > 0) {
                templateLine = v1.lines[0];
            }
        }

        // Iteratively keep finding intersecting points or lines to join the line with
        let current = v0;

        while (true) {
            // Recompute direction from the last hit (lines are not always straight due to rounding)
            const dx = v1.x - current.x;
            const dy = v1.y - current.y;
            const length2 = dx * dx + dy * dy;

            boundsMin.x = Math.min(current.x, v1.x);
            boundsMin.y = Math.min(current.y, v1.y);
            boundsMax.x = Math.max(current.x, v1.x);
            boundsMax.y = Math.max(current.y, v1.y);

            let nearestVertex = null;
            let nearestDist2 = Infinity;
            let nearestLine = null;

            // Find collinear vertex ahead
            this.iterateVertices(vertex => {
                if (vertex === current) {
                    return true;
                }

                const vx = vertex.x - current.x;
                const vy = vertex.y - current.y;

                // Collinearity test via cross product
                const cross = vx * dy - vy * dx;
                if (cross !== 0) {
                    return true;
                }

                // Direction parameter along (dx, dy)
                const dot = vx * dx + vy * dy;
                if (dot <= 0) {
                    // Behind current
                    return true;
                }
                if (dot >= length2) {
                    // Past end
                    return true;
                }

                // There's a vertex exactly on the segment
                const dist2 = vx * vx + vy * vy;
                if (dist2 < nearestDist2) {
                    nearestVertex = vertex;
                    nearestDist2 = dist2;
                }

                return true;
            }, boundsMin, boundsMax);

            // Find nearest line intersection
            this.iterateLinesWithLine(current.x, current.y, v1.x, v1.y, line => {
                // Skip any line whose endpoint lies at the current point
                if (line.v0.x === current.x && line.v0.y === current.y ||
                    line.v1.x === current.x && line.v1.y === current.y) {
                    return true;
                }

                // Check if the lines intersect
                const hit = Utility.segmentIntersection(
                    current.x, current.y, v1.x, v1.y,
                    line.v0.x, line.v0.y, line.v1.x, line.v1.y,
                    intersection
                );
                if (hit === null) {
                    return true;
                }

                const hitX = Math.round(hit.x);
                const hitY = Math.round(hit.y);

                if (hitX === current.x && hitY === current.y) {
                    return true;
                }

                // Was the rounded hit an endpoint?
                const endpoint = hitX === line.v0.x && hitY === line.v0.y
                    ? line.v0
                    : hitX === line.v1.x && hitY === line.v1.y
                    ? line.v1
                    : null;

                const distX = hitX - current.x;
                const distY = hitY - current.y;
                const dist2 = distX * distX + distY * distY;

                if (dist2 < nearestDist2) {
                    if (endpoint !== null) {
                        // Do not remove or split its line
                        nearestVertex = endpoint;
                        nearestLine = null;
                    } else {
                         // Save the vertex position and nearest line to split
                        nearestVertex = temp;
                        nearestVertex.x = hitX;
                        nearestVertex.y = hitY;
                        nearestLine = line;
                    }

                    nearestDist2 = dist2;
                }
            });

            let next;

            // Determine how to handle the next line point
            if (nearestLine !== null) {
                // Another line was hit and must be split. Use it as a template for the new lines.
                templateLine = nearestLine;

                // Remove the old line before putting an old vertex under it
                this.#removeLinePrimitive(nearestLine);

                // Create a vertex at the intersection point
                next = this.addVertex(nearestVertex.x, nearestVertex.y);

                // Recursively add the new line to account for any new intersections after rounding
                this.addLine(current.x, current.y, next.x, next.y, templateLine, true, null, true, lineage);
            } else {
                // No line intersection. The new line will not be realigned so we can add it directly

                if (nearestVertex !== null) {
                    // The nearest point is an existing vertex
                    if (nearestVertex.lines.length > 0) {
                        // Use its first line as the new template line
                        templateLine = nearestVertex.lines[0];
                    }
                    next = nearestVertex;
                } else {
                    // No nearest point. The next point is the final point in the original line.
                    next = v1;
                }

                // Create the new line segment directly without recursion
                const key = DoomMap.createLineKey(current.x, current.y, next.x, next.y);
                if (!this.#lineMap.has(key)) {
                    const line = new Line(current, next);

                    if (templateLine !== null) {
                        const templateLength = Math.round(Math.hypot(
                            templateLine.v1.x - templateLine.v0.x,
                            templateLine.v1.y - templateLine.v0.y
                        ));

                        const newLength = Math.round(Math.hypot(
                            next.x - current.x,
                            next.y - current.y
                        ));

                        let flip = false;
                        let offset = 0;

                        if (templateLine.v1 === current) {
                            flip = false;
                            offset = templateLength;
                        } else if (templateLine.v0 === current) {
                            flip = true;
                            offset = 0;
                        } else if (templateLine.v0 === next) {
                            flip = false;
                            offset = -newLength;
                        } else if (templateLine.v1 === next) {
                            flip = true;
                            offset = templateLength - newLength;
                        }

                        if (templateFlip !== null) {
                            flip = templateFlip;
                        }

                        line.properties.copy(templateLine.properties);

                        const templateUnresolved =
                            templateLine.frontSector === null &&
                            templateLine.backSector === null;

                        const templateHasFront = templateUnresolved ||
                            templateLine.frontSector !== null &&
                            !templateLine.frontSector.properties.getValue('is_void');

                        const templateHasBack = templateUnresolved ||
                            templateLine.backSector !== null &&
                            !templateLine.backSector.properties.getValue('is_void');

                        if (templateHasFront !== templateHasBack) {
                            const sourceProperties = templateHasFront
                                ? templateLine.frontProperties
                                : templateLine.backProperties;

                            const sourceSectorProperties = templateHasFront
                                ? templateLine.frontSectorProperties
                                : templateLine.backSectorProperties;

                            line.frontProperties.copy(sourceProperties);
                            line.backProperties.copy(sourceProperties);

                            line.frontSectorProperties.copy(sourceSectorProperties);
                            line.backSectorProperties.copy(sourceSectorProperties);
                        } else if (templateHasFront && templateHasBack) {
                            if (flip) {
                                line.frontProperties.copy(templateLine.backProperties);
                                line.backProperties.copy(templateLine.frontProperties);
                                line.frontSectorProperties.copy(templateLine.backSectorProperties);
                                line.backSectorProperties.copy(templateLine.frontSectorProperties);
                            } else {
                                line.frontProperties.copy(templateLine.frontProperties);
                                line.backProperties.copy(templateLine.backProperties);
                                line.frontSectorProperties.copy(templateLine.frontSectorProperties);
                                line.backSectorProperties.copy(templateLine.backSectorProperties);
                            }
                        }

                        if (autoclearTexture) {
                            line.properties.setValue('clear_double_sided', true);
                        }

                        line.frontProperties.setValue(
                            'x_offset',
                            (((line.frontProperties.getValue('x_offset') + offset) % 512) + 512) % 512
                        );

                        line.backProperties.setValue(
                            'x_offset',
                            (((line.backProperties.getValue('x_offset') + offset) % 512) + 512) % 512
                        );
                    } else {
                        const parentSector = this.getSector(
                            (current.x + next.x) * 0.5,
                            (current.y + next.y) * 0.5
                        );

                        if (parentSector !== null && !parentSector.properties.getValue('is_void')) {
                            line.frontSectorProperties.copy(parentSector.properties);
                            line.backSectorProperties.copy(parentSector.properties);
                        }
                    }

                    // Log the line lineage
                    lineage.add(key);

                    this.#addLinePrimitive(line);
                }
            }

            // Only after the new line segment has been added do we recursively add the split line
            if (nearestLine !== null) {
                const l2 = nearestLine;
                const key2 = DoomMap.createLineKey(l2.v0.x, l2.v0.y, l2.v1.x, l2.v1.y);
                const lineage2 = new Set();
                this.addLine(l2.v0.x, l2.v0.y, next.x, next.y, templateLine, true, false, true, lineage2);
                this.addLine(next.x, next.y, l2.v1.x, l2.v1.y, templateLine, true, false, true, lineage2);
                if (lineage2.size > 0) {
                    this.#lineLineages.set(key2, lineage2);
                }
            }

            // Has the end been reached?
            if (next === v1) {
                break;
            }
            current = next;
        }

        if (createLineage && lineage.size > 1) {
            this.#lineLineages.set(oldKey, lineage);
        }

        if (this.#transaction !== null && !skipForwardHistory) {
            this.#transaction.applyOperations.push({
                op: 'addLine',
                args: [v0.x, v0.y, v1.x, v1.y],
            });
        }
    }

    /**
     * Clear line lineages. Should be used at the end of transactions.
     */
    clearLineLineages() {
        this.#lineLineages.clear();
    }

    /**
     * Removes the line identified by two endpoints.
     * Adds the required apply and undo operations to the current transaction.
     *
     * @param {number} fromX - The first x-coordinate.
     * @param {number} fromY - The first y-coordinate.
     * @param {number} toX - The second x-coordinate.
     * @param {number} toY - The second y-coordinate.
     */
    removeLine(fromX, fromY, toX, toY) {
        const fx = Math.round(fromX);
        const fy = Math.round(fromY);
        const tx = Math.round(toX);
        const ty = Math.round(toY);

        const key = DoomMap.createLineKey(fx, fy, tx, ty);

        const line = this.#lineMap.get(key);
        if (line === undefined) {
            return;
        }

        this.#removeLinePrimitive(line);

        if (this.#transaction !== null) {
            this.#transaction.applyOperations.push({
                op: 'removeLine',
                args: [fx, fy, tx, ty],
            });
        }
    }

    /**
     * Splits an existing line at a rounded coordinate.
     * Adds the required apply and undo operations to the current transaction.
     *
     * @param {number} x0 - The line start x-coordinate.
     * @param {number} y0 - The line start y-coordinate.
     * @param {number} x1 - The line end x-coordinate.
     * @param {number} y1 - The line end y-coordinate.
     * @param {number} splitX - The split x-coordinate.
     * @param {number} splitY - The split y-coordinate.
     */
    splitLine(x0, y0, x1, y1, splitX, splitY) {
        const key = DoomMap.createLineKey(x0, y0, x1, y1);
        const line = this.#lineMap.get(key);
        if (line === undefined) {
            return;
        }

        const x = Math.round(splitX);
        const y = Math.round(splitY);

        if (x === x0 && y === y0 || x === x1 && y === y1) {
            return;
        }

        this.#removeLinePrimitive(line);

        this.addLine(x0, y0, x, y, line, true, false, false);
        this.addLine(x, y, x1, y1, line, true, false, false);

        if (this.#transaction !== null) {
            this.#transaction.applyOperations.push({
                op: 'splitLine',
                args: [x0, y0, x1, y1, x, y],
            });
        }
    }

    /**
     * Reverses a line and swaps its front and back properties.
     *
     * @param {number} x0 - The first x-coordinate.
     * @param {number} y0 - The first y-coordinate.
     * @param {number} x1 - The second x-coordinate.
     * @param {number} y1 - The second y-coordinate.
     */
    flipLine(x0, y0, x1, y1) {
        const fx = Math.round(x0);
        const fy = Math.round(y0);
        const tx = Math.round(x1);
        const ty = Math.round(y1);

        const key = DoomMap.createLineKey(fx, fy, tx, ty);

        const line = this.#lineMap.get(key);
        if (line === undefined) {
            console.warn(`Attempted to flip non-existent line "${key}"`);
            return;
        }

        this.#modifiedLines.add(line);

        this.#removeLinePrimitive(line);

        const newLine = new Line(line.v1, line.v0);

        this.#addLinePrimitive(newLine);

        newLine.properties.copy(line.properties);

        newLine.frontProperties.copy(line.backProperties);
        newLine.backProperties.copy(line.frontProperties);

        newLine.frontSectorProperties.copy(line.backSectorProperties);
        newLine.backSectorProperties.copy(line.frontSectorProperties);

        this.#modifiedLines.add(newLine);

        if (this.#transaction !== null) {
            this.#transaction.undoOperations.push({
                op: 'flipLine',
                args: [fx, fy, tx, ty],
            });
            this.#transaction.applyOperations.push({
                op: 'flipLine',
                args: [fx, fy, tx, ty],
            });
        }
    }

    /**
     * Creates and registers a thing.
     *
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     * @param {number} z - The z-coordinate.
     * @param {number} typeId - The type identifier.
     * @param {number} angle - The angle.
     * @returns {?Thing} The new thing or ´null´.
     */
    addThing(x, y, z, typeId, angle) {
        if (x < DoomMap.COORDINATE_MIN || x > DoomMap.COORDINATE_MAX ||
            y < DoomMap.COORDINATE_MIN || y > DoomMap.COORDINATE_MAX) {
            console.warn(`Thing position out of bounds: (${x}, ${y})`);
            return null;
        }

        const thing = new Thing(
            Math.round(x), Math.round(y), Math.round(z), Math.round(typeId), Math.round(angle)
        );
        this.#addThingPrimitive(thing);
        return thing;
    }

    /**
     * Removes the first thing matching the identifying values.
     *
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     * @param {number} z - The z-coordinate.
     * @param {number} typeId - The type identifier.
     * @param {number} angle - The angle.
     */
    removeThing(x, y, z, typeId, angle) {
        const thing = this.getThing(
            Math.round(x), Math.round(y), Math.round(z), Math.round(typeId), Math.round(angle)
        );
        if (thing === null) {
            console.warn('Attempted to remove non-existent Thing');
            return;
        }

        this.#removeThingPrimitive(thing);

        if (this.#transaction !== null) {
            this.#transaction.applyOperations.push({
                op: 'removeThing',
                args: [thing.x, thing.y, z, typeId, angle],
            });
        }
    }

    /**
     * Removes all geometry, things and sectors from the map.
     */
    clear() {
        this.select(null, 'deselect_all');

        while (this.#things.size > 0) {
            this.#removeThingPrimitive(this.#things.values().next().value);
        }
        while (this.#sectors.size > 0) {
            this.#removeSectorPrimitive(this.#sectors.values().next().value);
        }
        while (this.#lines.size > 0) {
            this.#removeLinePrimitive(this.#lines.values().next().value);
        }
        while (this.#vertices.size > 0) {
            this.#removeVertexPrimitive(this.#vertices.values().next().value);
        }

        this.clearLineLineages();
    }

    /**
     * Creates removal operations for the supplied geometries.
     *
     * @param {Set<Geometry>|Array<Geometry>} geometries - The geometries to remove.
     * @returns {Array<Object>} The generated removal operations.
     */
    static createRemoveOperations(geometries) {
        const operations = [];

        geometries.forEach(geometry => {
            if (geometry instanceof Vertex) {
                operations.push({
                    op: 'removeVertex',
                    args: [geometry.x, geometry.y],
                });
            } else if (geometry instanceof Line) {
                operations.push({
                    op: 'removeLine',
                    args: [geometry.v0.x, geometry.v0.y, geometry.v1.x, geometry.v1.y],
                });
            } else if (geometry instanceof Thing) {
                operations.push({
                    op: 'removeThing',
                    args: [
                        geometry.x,
                        geometry.y,
                        geometry.properties.getValue('z'),
                        geometry.properties.getValue('type'),
                        geometry.properties.getValue('angle')
                    ],
                });
            }
        });

        return operations;
    }

    /**
     * Creates operations that remove a vertex and reconnect opposite collinear lines.
     *
     * @param {Vertex} vertex - The vertex to dissolve.
     * @returns {Array<Object>} The generated dissolve operations.
     */
    static createDissolveVertexOperations(vertex) {
        const operations = [{
            op: 'removeVertex',
            args: [vertex.x, vertex.y],
        }];

        const handledLines = new Set();

        vertex.lines.forEach(lineA => {
            if (handledLines.has(lineA)) {
                return;
            }
            handledLines.add(lineA);

            const otherA = lineA.v0 === vertex ? lineA.v1 : lineA.v0;

            let lineB = null;
            let otherB = null;

            const ax = otherA.x - vertex.x;
            const ay = otherA.y - vertex.y;

            for (const candidate of vertex.lines) {
                if (candidate === lineA || handledLines.has(candidate)) {
                    continue;
                }

                const candidateOther = candidate.v0 === vertex ? candidate.v1 : candidate.v0;

                const bx = candidateOther.x - vertex.x;
                const by = candidateOther.y - vertex.y;

                const cross = ax * by - ay * bx;
                const dot = ax * bx + ay * by;

                if (Math.abs(cross) < 1e-10 && dot < 0) {
                    lineB = candidate;
                    otherB = candidateOther;
                    break;
                }
            }

            if (lineB !== null) {
                handledLines.add(lineB);

                const x0 = otherA.x;
                const y0 = otherA.y;
                const x1 = otherB.x;
                const y1 = otherB.y;
                const flip = lineA.v0 === vertex;

                operations.push({
                    op: 'addLine',
                    args: [x0, y0, x1, y1],
                });

                DoomMap.createCopyLineOperations(operations, lineA, x0, y0, x1, y1, flip);
            }
        });

        return operations;
    }

    /**
     * Creates operations that dissolve selected geometry while preserving continuous lines.
     *
     * @param {Set<Geometry>} geometries - The geometry set to dissolve.
     * @returns {Array<Object>} The generated dissolve operations.
     */
    static createDissolveOperations(geometries) {
        const operations = [];

        const vertices = new Set();

        geometries.forEach(geometry => {
            if (geometry instanceof Vertex) {
                vertices.add(geometry);
            }

            if (geometry instanceof Thing) {
                const x = geometry.x;
                const y = geometry.y;
                const z = geometry.properties.getValue('z');
                const typeId = geometry.properties.getValue('type');
                const angle = geometry.properties.getValue('angle');

                operations.push({
                    op: 'removeThing',
                    args: [x, y, z, typeId, angle],
                });
            }
        });

        const deletedLines = new Set();
        const newLines = [];

        while (vertices.size > 0) {
            let bestVertex = null;
            let bestLines = null;

            vertices.forEach(vertex => {
                const lines = [];

                vertex.lines.forEach(line => {
                    if (!deletedLines.has(line)) {
                        lines.push(line);
                    }
                });
                newLines.forEach(line => {
                    if (!deletedLines.has(line) && (line.v0 === vertex || line.v1 === vertex)) {
                        lines.push(line);
                    }
                });

                if (bestLines === null || lines.length < bestLines.length) {
                    bestVertex = vertex;
                    bestLines = lines;
                }
            });

            if (bestVertex === null) {
                break;
            }

            vertices.delete(bestVertex);

            if (bestLines.every(line =>
                geometries.has(line) &&
                (line.frontSector === null || geometries.has(line.frontSector)) &&
                (line.backSector === null || geometries.has(line.backSector))
            )) {
                bestLines.forEach(line => {
                    deletedLines.add(line);
                });

                operations.push({
                    op: 'removeVertex',
                    args: [bestVertex.x, bestVertex.y],
                });

                continue;
            }

            if (bestLines.length !== 2) {
                continue;
            }

            const lineA = bestLines[0];
            const lineB = bestLines[1];

            const fromA0 = lineA.v0 === bestVertex;
            const fromB0 = lineB.v0 === bestVertex;

            const x0 = fromA0 ? lineA.v1.x : lineA.v0.x;
            const y0 = fromA0 ? lineA.v1.y : lineA.v0.y;
            const x1 = fromB0 ? lineB.v1.x : lineB.v0.x;
            const y1 = fromB0 ? lineB.v1.y : lineB.v0.y;

            const ax = x0 - bestVertex.x;
            const ay = y0 - bestVertex.y;
            const bx = x1 - bestVertex.x;
            const by = y1 - bestVertex.y;

            const cross = ax * by - ay * bx;
            const dot = ax * bx + ay * by;

            if (Math.abs(cross) > 1e-10 || dot >= 0) {
                continue;
            }

            deletedLines.add(lineA);
            deletedLines.add(lineB);

            operations.push({
                op: 'removeVertex',
                args: [bestVertex.x, bestVertex.y],
            });

            operations.push({
                op: 'addLine',
                args: [x0, y0, x1, y1],
            });

            const sourceLine = !geometries.has(lineA) ? lineA : lineB;
            const sourceFrom0 = sourceLine === lineA ? fromA0 : fromB0;
            const template = sourceLine instanceof Line ? sourceLine : sourceLine.template;
            const templateFlip = sourceLine instanceof Line ? false : sourceLine.flip;
            const flip = templateFlip !== sourceFrom0;

            newLines.push({
                v0: fromA0 ? lineA.v1 : lineA.v0,
                v1: fromB0 ? lineB.v1 : lineB.v0,
                template,
                flip,
            });

            DoomMap.createCopyLineOperations(operations, template, x0, y0, x1, y1, flip);
        }

        return operations;
    }

    ////////////////////////////////////////////////////////////////////////////
    // Selection

    /**
     * Finds a vertex by its exact coordinate.
     *
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     * @returns {?Vertex} The matching vertex, or `null` when not found.
     */
    getVertex(x, y) {
        const key = DoomMap.createVertexKey(x, y);
        return this.#vertexMap.get(key) ?? null;
    }

    /**
     * Finds a line by its endpoint coordinates.
     *
     * @param {number} x0 - The first x-coordinate.
     * @param {number} y0 - The first y-coordinate.
     * @param {number} x1 - The second x-coordinate.
     * @param {number} y1 - The second y-coordinate.
     * @returns {?Line} The matching line, or `null` when not found.
     */
    getLine(x0, y0, x1, y1) {
        const key = DoomMap.createLineKey(x0, y0, x1, y1);
        return this.#lineMap.get(key) ?? null;
    }

    /**
     * Finds the deepest sector containing a map coordinate.
     *
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     * @returns {?Sector} The containing sector, or `null` when not found.
     */
    getSector(x, y) {
        const cellSize = DoomMap.#SPATIAL_GRID_CELL_SIZE;

        const cellX = Math.floor(x / cellSize);
        const cellY = Math.floor(y / cellSize);

        const column = this.#spatialGridSector.get(cellX);
        if (column === undefined) {
            return null;
        }
        let sectors = column.get(cellY);
        if (sectors === undefined) {
            return null;
        }

        if (sectors.size > 1) {
            sectors = Array.from(sectors);
            sectors.sort((a, b) => b.depth - a.depth);
        }

        for (const sector of sectors) {
            if (sector.containsPoint(x, y)) {
                return sector;
            }
        }

        return null;
    }

    /**
     * Finds the first thing matching the identifying values.
     *
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     * @param {number} z - The z-coordinate.
     * @param {number} typeId - The type identifier.
     * @param {number} angle - The angle.
     * @param {boolean} lastCreated - Whether to return the last created thing in the bucket.
     * @returns {?Thing} The matching thing, or `null` when not found.
     */
    getThing(x, y, z, typeId, angle, lastCreated = false) {
        const key = Thing.createKey(x, y, z, typeId, angle);
        const bucket = this.#thingsMap.get(key);
        return bucket !== undefined && bucket.length > 0 ? lastCreated
            ? bucket[bucket.length - 1] : bucket[0] : null;
    }

    /**
     * Returns geometry contained by or intersecting a bounding box.
     *
     * @param {Object} boundsMin - The minimum x and y bounds.
     * @param {Object} boundsMax - The maximum x and y bounds.
     * @param {boolean} [intersects=false] - Whether partially intersecting geometry should be included.
     * @returns {Array<Geometry>} The matching vertices, lines, sectors, and things.
     */
    getGeometryInBox(boundsMin, boundsMax, intersects = false) {
        const geometries = [];

        this.iterateVertices(v => {
            if (v.isInsideRectangle(boundsMin.x, boundsMin.y, boundsMax.x, boundsMax.y, intersects)) {
                geometries.push(v);
            }
        }, boundsMin, boundsMax);
        this.iterateLines(l => {
            if (l.isInsideRectangle(boundsMin.x, boundsMin.y, boundsMax.x, boundsMax.y, intersects)) {
                geometries.push(l);
            }
        }, boundsMin, boundsMax);
        this.iterateSectors(s => {
            if (s.isInsideRectangle(boundsMin.x, boundsMin.y, boundsMax.x, boundsMax.y, intersects)) {
                geometries.push(s);
            }
        }, boundsMin, boundsMax);
        this.iterateThings(t => {
            if (t.isInsideRectangle(boundsMin.x, boundsMin.y, boundsMax.x, boundsMax.y, intersects)) {
                geometries.push(t);
            }
        }, boundsMin, boundsMax);

        return geometries;
    }

    /**
     * Returns the current live geometry selection.
     *
     * NOTE: Do not edit the collection outside this class.
     *
     * @returns {Set<object>} The current selection.
     */
    getSelection() {
        return this.#selection;
    }

    /**
     * Checks whether geometry is selected and optionally matches side or texture-section filters.
     *
     * @param {Object} geometry - The geometry to test.
     * @param {?boolean} [isFront=null] - The required front-side selection state, or `null` to ignore it.
     * @param {?boolean} [isBack=null] - The required back-side selection state, or `null` to ignore it.
     * @param {?boolean} [isUpper=null] - The required upper-texture selection state, or `null` to ignore it.
     * @param {?boolean} [isMiddle=null] - The required middle-texture selection state, or `null` to ignore it.
     * @param {?boolean} [isLower=null] - The required lower-texture selection state, or `null` to ignore it.
     * @returns {boolean} Whether the geometry is selected according to the filters.
     */
    isSelected(geometry, isFront = null, isBack = null, isUpper = null, isMiddle = null, isLower = null) {
        return !(!this.#selection.has(geometry) ||
            isFront !== null && this.#selectedFront.has(geometry) !== isFront ||
            isBack !== null && this.#selectedBack.has(geometry) !== isBack ||
            isUpper !== null && this.#selectedUpper.has(geometry) !== isUpper ||
            isMiddle !== null && this.#selectedMiddle.has(geometry) !== isMiddle ||
            isLower !== null && this.#selectedLower.has(geometry) !== isLower
        );
    }

    /**
     * Updates geometry, side, and texture-section selection state.
     *
     * @param {?Array<Object>} [geometries=[]] - The geometries to select, or `null` for `deselect_all`.
     * @param {'select'|'deselect'|'toggle'|'deselect_all'} mode - The selection operation to perform.
     * @param {boolean} [skipEvents=false] - Whether to suppress selection events.
     * @param {boolean} [skipLines=false] - Whether sector selection should avoid selecting its lines.
     * @param {boolean} [skipSectors=false] - Whether line selection should avoid selecting completed sectors.
     * @param {boolean} [selectFront=true] - Whether to include line front sides.
     * @param {boolean} [selectBack=true] - Whether to include line back sides.
     * @param {boolean} [selectUpper=true] - Whether to include upper texture sections.
     * @param {boolean} [selectMiddle=true] - Whether to include middle texture sections.
     * @param {boolean} [selectLower=true] - Whether to include lower texture sections.
     */
    select(geometries = [], mode,
        skipEvents = false, skipLines = false, skipSectors = false,
        selectFront = true, selectBack = true, selectUpper = true, selectMiddle = true, selectLower = true) {
        if ((mode === 'deselect' || mode === 'deselect_all') && this.#selection.size === 0) {
            return;
        }
        if (mode === 'deselect' && geometries.every(geometry => !this.#selection.has(geometry))) {
            return;
        }

        if (!skipEvents) {
            this.#emitEvent('beforeselect', {
                selection: this.#selection,
                selectedFront: this.#selectedFront,
                selectedBack: this.#selectedBack,
                selectedUpper: this.#selectedUpper,
                selectedMiddle: this.#selectedMiddle,
                selectedLower: this.#selectedLower,
            });
        }

        if (mode === 'deselect_all') {
            this.#selection.clear();
            this.#selectedFront.clear();
            this.#selectedBack.clear();
            this.#selectedUpper.clear();
            this.#selectedMiddle.clear();
            this.#selectedLower.clear();
            if (!skipEvents) {
                this.#emitEvent('select', {
                    selection: this.#selection,
                    selectedFront: this.#selectedFront,
                    selectedBack: this.#selectedBack,
                });
            }
            return;
        }

        geometries.forEach(geometry => {
            if (geometry instanceof Thing) {
                switch (mode) {
                    case 'select':
                        this.#selection.add(geometry);
                        break;
                    case 'deselect':
                        this.#selection.delete(geometry);
                        break;
                    case 'toggle':
                        this.select([geometry], this.#selection.has(geometry) ? 'deselect' : 'select', true);
                        break;
                }
            } else if (geometry instanceof Vertex) {
                switch (mode) {
                    case 'select':
                        this.#selection.add(geometry);
                        geometry.lines.forEach(line => {
                            if (!this.#selection.has(line) &&
                                this.#selection.has(line.v0) &&
                                this.#selection.has(line.v1)) {
                                this.select([line], 'select', true);
                            }
                        });
                        break;
                    case 'deselect':
                        this.#selection.delete(geometry);
                        geometry.lines.forEach(line => {
                            if (this.#selection.has(line) &&
                                (!this.#selection.has(line.v0) ||
                                !this.#selection.has(line.v1))) {
                                this.select([line], 'deselect', true);
                            }
                        });
                        break;
                    case 'toggle':
                        this.select([geometry], this.#selection.has(geometry) ? 'deselect' : 'select', true);
                        break;
                }
                geometry.lines.forEach(line => {
                    [line.frontSector, line.backSector].forEach(sector => {
                        if (sector !== null) {
                            if (this.#selection.has(sector) &&
                                !sector.lines.every(l => this.#selection.has(l))) {
                                this.#selection.delete(sector);
                            } else if (!this.#selection.has(sector) &&
                                sector.lines.every(l => this.#selection.has(l))) {
                                this.#selection.add(sector);
                            }
                        }
                    });
                });
            } else if (geometry instanceof Line) {
                switch (mode) {
                    case 'select':
                        [geometry.v0, geometry.v1].forEach(v => {
                            this.#selection.add(v);
                        });
                        if (this.#selection.has(geometry.v0) && this.#selection.has(geometry.v1)) {
                            this.#selection.add(geometry);
                            if (selectFront) {
                                this.#selectedFront.add(geometry);
                            }
                            if (selectBack) {
                                this.#selectedBack.add(geometry);
                            }
                            if (selectUpper) {
                                this.#selectedUpper.add(geometry);
                            }
                            if (selectMiddle) {
                                this.#selectedMiddle.add(geometry);
                            }
                            if (selectLower) {
                                this.#selectedLower.add(geometry);
                            }
                        }
                        if (!skipSectors) {
                            [geometry.frontSector, geometry.backSector].forEach(sector => {
                                if (sector !== null && sector.lines.every(l => this.#selection.has(l))) {
                                    this.#selection.add(sector);
                                }
                            });
                        }
                        break;
                    case 'deselect':
                        this.#selection.delete(geometry);
                        this.#selectedFront.delete(geometry);
                        this.#selectedBack.delete(geometry);
                        this.#selectedUpper.delete(geometry);
                        this.#selectedMiddle.delete(geometry);
                        this.#selectedLower.delete(geometry);
                        [geometry.frontSector, geometry.backSector].forEach(sector => {
                            this.#selection.delete(sector);
                        });
                        [geometry.v0, geometry.v1].forEach(v => {
                            if (v.lines.every(l => !this.#selection.has(l))) {
                                this.#selection.delete(v);
                            }
                        });
                        break;
                    case 'toggle':
                        this.select([geometry], this.#selection.has(geometry) ? 'deselect' : 'select', true);
                        break;
                }
            } else if (geometry instanceof Sector) {
                switch (mode) {
                    case 'select':
                        if (!skipLines) {
                            geometry.lines.forEach(line => {
                                [line.v0, line.v1].forEach(v => {
                                    this.#selection.add(v);
                                });
                                this.#selection.add(line);
                                if (selectFront) {
                                    this.#selectedFront.add(line);
                                }
                                if (selectBack) {
                                    this.#selectedBack.add(line);
                                }
                                if (selectUpper) {
                                    this.#selectedUpper.add(line);
                                }
                                if (selectMiddle) {
                                    this.#selectedMiddle.add(line);
                                }
                                if (selectLower) {
                                    this.#selectedLower.add(line);
                                }
                            });
                        }
                        this.#selection.add(geometry);
                        if (selectUpper) {
                            this.#selectedUpper.add(geometry);
                        }
                        if (selectLower) {
                            this.#selectedLower.add(geometry);
                        }
                        break;
                    case 'deselect':
                        if (!skipLines) {
                            const toDeselect = new Set();
                            geometry.lines.forEach(line => {
                                [line.v0, line.v1].forEach(v => {
                                    const hasOtherSector = v.lines.some(l =>
                                        this.#selection.has(l.backSector) && l.backSector !== geometry ||
                                        this.#selection.has(l.frontSector) && l.frontSector !== geometry);
                                    if (!hasOtherSector) {
                                        toDeselect.add(v);
                                    }
                                });
                            });
                            toDeselect.forEach(v => {
                                this.#selection.delete(v);
                            });
                            geometry.lines.forEach(line => {
                                if (!this.#selection.has(line.v0) || !this.#selection.has(line.v1)) {
                                    this.#selection.delete(line);
                                    this.#selectedFront.delete(line);
                                    this.#selectedBack.delete(line);
                                    this.#selectedUpper.delete(line);
                                    this.#selectedMiddle.delete(line);
                                    this.#selectedLower.delete(line);
                                }
                            });
                        }
                        this.#selection.delete(geometry);
                        this.#selectedUpper.delete(geometry);
                        this.#selectedLower.delete(geometry);
                        break;
                    case 'toggle': {
                        this.select([geometry], this.#selection.has(geometry) ? 'deselect' : 'select', true);
                        break;
                    }
                }
            }
        });

        if (!skipEvents) {
            this.#emitEvent('select', {
                selection: this.#selection,
                selectedFront: this.#selectedFront,
                selectedBack: this.#selectedBack,
            });
        }
    }

    /**
     * Expands a geometry collection by traversing connected vertices, lines, and sectors.
     *
     * @param {Iterable<Geometry>} geometries - The initial geometry collection.
     * @param {number} [steps=1] - The maximum number of expansion steps.
     * @returns {Set<object>} The expanded geometry set.
     */
    #growConnectedGeometry(geometries, steps = 1) {
        let current = new Set(geometries);

        for (let i = 0; i < steps; i++) {
            const next = new Set(current);

            current.forEach(g => {
                if (g instanceof Vertex) {
                    g.lines.forEach(line => {
                        next.add(line);
                        next.add(line.v0);
                        next.add(line.v1);
                    });
                    return;
                }

                if (g instanceof Line) {
                    next.add(g.v0);
                    next.add(g.v1);
                    g.v0.lines.forEach(l => {
                        next.add(l);
                    });
                    g.v1.lines.forEach(l => {
                        next.add(l);
                    });
                    return;
                }

                else if (g instanceof Sector) {
                    g.lines.forEach(line => {
                        next.add(line);
                        next.add(line.v0);
                        next.add(line.v1);
                    });
                }
            });

            if (next.size === current.size) {
                break;
            }

            current = next;
        }

        return current;
    }

    /**
     * Removes boundary geometry from a collection for a number of steps.
     *
     * @param {Iterable<Geometry>} geometries - The initial geometry collection.
     * @param {number} [steps=1] - The maximum number of shrink steps.
     * @returns {Set<object>} The reduced geometry set.
     */
    #shrinkConnectedGeometry(geometries, steps = 1) {
        let current = new Set(geometries);

        for (let i = 0; i < steps; i++) {
            const next = new Set(current);

            current.forEach(g => {
                if (g instanceof Vertex) {
                    if (!g.lines.every(line => current.has(line))) {
                        next.delete(g);
                    }
                }
            });

            current.forEach(g => {
                if (g instanceof Line) {
                    if (!next.has(g.v0) || !next.has(g.v1)) {
                        next.delete(g);
                    }
                }
            });

            current.forEach(g => {
                if (g instanceof Sector) {
                    if (!g.lines.every(line => next.has(line))) {
                        next.delete(g);
                    }
                }
            });

            if (next.size === current.size) {
                break;
            }

            current = next;
        }

        return current;
    }

    /**
     * Expands the current selection by one connected-geometry step.
     */
    growSelection() {
        const newSelection = this.#growConnectedGeometry(this.#selection, 1);

        this.select(null, 'deselect_all');
        this.select([...newSelection], 'select');
    }

    /**
     * Shrinks the current selection by one boundary step.
     */
    shrinkSelection() {
        const newSelection = this.#shrinkConnectedGeometry(this.#selection, 1);

        this.select(null, 'deselect_all');
        this.select([...newSelection], 'select');
    }

    /**
     * Selects all geometry connected to a starting geometry object.
     *
     * @param {Geometry} geometry - The geometry from which to begin traversal.
     */
    selectLinked(geometry) {
        const newSelection = this.#growConnectedGeometry([geometry], Infinity);

        this.select([...newSelection], 'select');
    }

    /**
     * Selects connected line-side texture sections that use the starting texture.
     *
     * @param {Line} line - The starting line.
     * @param {boolean} startFront - Whether to start from the front side.
     * @param {'upper'|'middle'|'lower'} [startSection='middle'] - The starting texture section.
     */
    selectLinkedSides(line, startFront, startSection = 'middle') {
        const startProperties = startFront ? line.frontProperties : line.backProperties;
        const textureName = startSection === 'upper' ? startProperties.getValue('texture_upper') :
            startSection === 'middle' ?
                startProperties.getValue('texture_middle') :
                startProperties.getValue('texture_lower');

        const stack = [{
            line,
            isFront: startFront,
            matchUpper: startSection === 'upper',
            matchMiddle: startSection === 'middle',
            matchLower: startSection === 'lower',
        }];

        const visited = new Set();

        while (stack.length > 0) {
            const { line: l, isFront, matchUpper, matchMiddle, matchLower } = stack.pop();
            let key;
            if (isFront) {
                key = `${l.v0.x},${l.v0.y}:${l.v1.x},${l.v1.y}:${matchUpper}:${matchMiddle}:${matchLower}`;
            } else {
                key = `${l.v1.x},${l.v1.y}:${l.v0.x},${l.v0.y}:${matchUpper}:${matchMiddle}:${matchLower}`;
            }
            if (visited.has(key)) {
                continue;
            }
            visited.add(key);

            const sideProperties = isFront ? l.frontProperties : l.backProperties;
            const sector = isFront ? l.frontSector : l.backSector;
            const otherSector = isFront ? l.backSector : l.frontSector;

            if (sector === null || sector.properties.getValue('is_void')) {
                continue;
            }

            const twoSided = otherSector !== null && !otherSector.properties.getValue('is_void');

            const floorHeight = sector.properties.getValue('floor_height');
            const ceilingHeight = sector.properties.getValue('ceiling_height');
            const otherFloor = twoSided ? otherSector.properties.getValue('floor_height') : 0;
            const otherCeiling = twoSided ? otherSector.properties.getValue('ceiling_height') : 0;

            const upperVisible = twoSided && ceilingHeight > otherCeiling;
            const lowerVisible = twoSided && floorHeight < otherFloor;
            const middleTexture = sideProperties.getValue('texture_middle');
            const middleVisible = !twoSided || middleTexture !== '-' && middleTexture !== '';

            const upperTouchesLower = twoSided && otherFloor === otherCeiling;

            const middleIsSame = textureName === sideProperties.getValue('texture_middle') && middleVisible;
            const upperIsSame = textureName === sideProperties.getValue('texture_upper') && upperVisible;
            const lowerIsSame = textureName === sideProperties.getValue('texture_lower') && lowerVisible;

            const newMatchMiddle = (matchMiddle || matchUpper || matchLower) && middleIsSame;
            const newMatchUpper = (matchUpper || matchMiddle || matchLower && upperTouchesLower) && upperIsSame;
            const newMatchLower = (matchLower || matchMiddle || matchUpper && upperTouchesLower) && lowerIsSame;

            if (!newMatchUpper && !newMatchMiddle && !newMatchLower) {
                continue;
            }

            this.select(
                [l], 'select',
                true, false, true,
                isFront, !isFront,
                newMatchUpper, newMatchMiddle, newMatchLower
            );

            l.v0.lines.forEach(nextLine => {
                if (nextLine === l) {
                    return;
                }

                stack.push({
                    line: nextLine,
                    isFront: (nextLine.v1 === l.v0) === isFront,
                    matchUpper: newMatchUpper,
                    matchMiddle: newMatchMiddle,
                    matchLower: newMatchLower,
                });
            });

            l.v1.lines.forEach(nextLine => {
                if (nextLine === l) {
                    return;
                }

                stack.push({
                    line: nextLine,
                    isFront: (nextLine.v0 === l.v1) === isFront,
                    matchUpper: newMatchUpper,
                    matchMiddle: newMatchMiddle,
                    matchLower: newMatchLower,
                });
            });
        }

        this.#emitEvent('select', {
            selection: this.#selection,
            selectedFront: this.#selectedFront,
            selectedBack: this.#selectedBack,
        });
    }

    /**
     * Selects connected sectors that optionally match a floor or ceiling height and texture.
     *
     * @param {Sector} sector - The starting sector.
     * @param {boolean} selectFloorNotCeiling - `true` to select floors; `false` to select ceilings.
     * @param {boolean} matchHeight - Whether connected sectors must match the starting height.
     * @param {boolean} matchTexture - Whether connected sectors must match the starting texture.
     */
    selectLinkedSectors(sector, selectFloorNotCeiling, matchHeight, matchTexture) {
        const stack = [sector];

        const visited = new Set();

        while (stack.length > 0) {
            const s = stack.pop();

            if (visited.has(s)) {
                continue;
            }
            visited.add(s);

            const heightSame = !matchHeight || (selectFloorNotCeiling
                ? s.properties.getValue('floor_height') === sector.properties.getValue('floor_height')
                : s.properties.getValue('ceiling_height') === sector.properties.getValue('ceiling_height')
            );

            const textureSame = !matchTexture || (selectFloorNotCeiling
                ? s.properties.getValue('floor_texture') === sector.properties.getValue('floor_texture')
                : s.properties.getValue('ceiling_texture') === sector.properties.getValue('ceiling_texture')
            );

            if (!heightSame || !textureSame) {
                continue;
            }

            this.select(
                [s], 'select',
                true, true, false,
                false, false,
                !selectFloorNotCeiling, false, selectFloorNotCeiling
            );

            s.lines.forEach(line => {
                const nextSector = line.frontSector === s ? line.backSector : line.frontSector;
                if (nextSector !== null) {
                    stack.push(nextSector);
                }
            });

            s.children.forEach(child => {
                stack.push(child);
            });

            if (s.parent !== null) {
                stack.push(s.parent);
            }
        }

        this.#emitEvent('select', {
            selection: this.#selection,
            selectedFront: this.#selectedFront,
            selectedBack: this.#selectedBack,
        });
    }

    /**
     * Removes geometry whose required connected components are not also present.
     * Can be used for only deleting fully connected geomtries.
     *
     * @param {Set<Geometry>|Array<Geometry>} geometries - The geometry collection to filter.
     * @returns {Set<Geometry>} A set containing only self-contained geometry.
     */
    static excludeNonExclusiveGeometries(geometries) {
        const result = new Set(geometries);

        geometries.forEach(geometry => {
            if (geometry instanceof Vertex) {
                if (!geometry.lines.every(line => result.has(line))) {
                    result.delete(geometry);
                }
            }
        });

        geometries.forEach(geometry => {
            if (geometry instanceof Line) {
                if (!result.has(geometry.v0) || !result.has(geometry.v1)) {
                    result.delete(geometry);
                }
            }
        });

        geometries.forEach(geometry => {
            if (geometry instanceof Sector) {
                if (!geometry.lines.every(line => result.has(line))) {
                    result.delete(geometry);
                }
            }
        });

        return result;
    }

    ////////////////////////////////////////////////////////////////////////////
    // Texture alignment

    /**
     * Creates property operations that align textures across the selected line sides.
     *
     * @param {boolean} alignHorizontally - Whether to align horizontal texture offsets.
     * @param {boolean} alignVertically - Whether to align vertical texture offsets.
     * @returns {Array<Object>} The generated side-property operations.
     */
    createTextureAlignmentOperations(alignHorizontally, alignVertically) {
        const textureSize = 512;

        const sides = [];
        const sideKeys = new Set();

        this.#selection.forEach(geometry => {
            if (!(geometry instanceof Line) ||
                !this.#selectedUpper.has(geometry) &&
                !this.#selectedMiddle.has(geometry) &&
                !this.#selectedLower.has(geometry)) {
                return;
            }

            for (let i = 0; i < 2; i++) {
                if (i === 0 && this.#selectedFront.has(geometry) ||
                    i === 1 && this.#selectedBack.has(geometry)) {
                    sides.push({
                        line: geometry,
                        isFront: i === 0,
                        isUpper: this.#selectedUpper.has(geometry),
                        isMiddle: this.#selectedMiddle.has(geometry),
                        isLower: this.#selectedLower.has(geometry),
                    });
                    sideKeys.add(
                        i === 0 ?
                            `${geometry.v0.x},${geometry.v0.y}:${geometry.v1.x},${geometry.v1.y}:true` :
                            `${geometry.v1.x},${geometry.v1.y}:${geometry.v0.x},${geometry.v0.y}:false`
                    );
                }
            }
        });

        const operations = [];

        if (sides.length === 0) {
            return operations;
        }

        if (alignHorizontally) {
            const visited = new Set();

            sides.forEach(side => {
                const startLine = side.line;
                const startKey = side.isFront ?
                    `${startLine.v0.x},${startLine.v0.y}:${startLine.v1.x},${startLine.v1.y}:true` :
                    `${startLine.v1.x},${startLine.v1.y}:${startLine.v0.x},${startLine.v0.y}:false`;

                if (visited.has(startKey)) {
                    return;
                }

                const startProperties = side.isFront ?
                    startLine.frontProperties :
                    startLine.backProperties;
                const referenceOffsetX = startProperties.getValue('x_offset');

                const stack = [{
                    line: startLine,
                    isFront: side.isFront,
                    distance: 0,
                }];

                while (stack.length > 0) {
                    const current = stack.pop();
                    const line = current.line;

                    const key = current.isFront ?
                        `${line.v0.x},${line.v0.y}:${line.v1.x},${line.v1.y}:true` :
                        `${line.v1.x},${line.v1.y}:${line.v0.x},${line.v0.y}:false`;

                    if (visited.has(key) || !sideKeys.has(key)) {
                        continue;
                    }

                    visited.add(key);

                    const properties = current.isFront ? line.frontProperties : line.backProperties;
                    const currentOffset = properties.getValue('x_offset');
                    const nextOffset = (((referenceOffsetX + current.distance) % textureSize) +
                        textureSize) % textureSize;

                    if (currentOffset !== nextOffset) {
                        operations.push({
                            op: 'setSideProperty',
                            args: [
                                line.v0.x,
                                line.v0.y,
                                line.v1.x,
                                line.v1.y,
                                current.isFront,
                                'x_offset',
                                nextOffset,
                                false,
                            ],
                        });
                    }

                    const length = Math.round(Math.hypot(
                        line.v1.x - line.v0.x,
                        line.v1.y - line.v0.y
                    ));

                    const v0 = current.isFront ? line.v0 : line.v1;
                    const v1 = current.isFront ? line.v1 : line.v0;

                    v1.lines.forEach(nextLine => {
                        if (nextLine === line) {
                            return;
                        }

                        if (nextLine.v0 === v1) {
                            stack.push({
                                line: nextLine,
                                isFront: true,
                                distance: current.distance + length,
                            });
                        }

                        if (nextLine.v1 === v1) {
                            stack.push({
                                line: nextLine,
                                isFront: false,
                                distance: current.distance + length,
                            });
                        }
                    });

                    v0.lines.forEach(nextLine => {
                        if (nextLine === line) {
                            return;
                        }

                        const nextLength = Math.round(Math.hypot(
                            nextLine.v1.x - nextLine.v0.x,
                            nextLine.v1.y - nextLine.v0.y
                        ));

                        if (nextLine.v1 === v0) {
                            stack.push({
                                line: nextLine,
                                isFront: true,
                                distance: current.distance - nextLength,
                            });
                        }

                        if (nextLine.v0 === v0) {
                            stack.push({
                                line: nextLine,
                                isFront: false,
                                distance: current.distance - nextLength,
                            });
                        }
                    });
                }
            });
        }

        if (alignVertically) {
            let referenceOrigin = null;

            sides.forEach(side => {
                const line = side.line;
                const properties = side.isFront ? line.frontProperties : line.backProperties;
                const sector = side.isFront ? line.frontSector : line.backSector;
                const otherSector = side.isFront ? line.backSector : line.frontSector;

                if (sector === null) {
                    return;
                }

                const floor = sector.properties.getValue('floor_height');
                const ceiling = sector.properties.getValue('ceiling_height');

                let bottom = 0;
                let top = 0;
                let offset = 0;
                let found = false;

                if (side.isUpper && otherSector !== null) {
                    const otherCeiling = otherSector.properties.getValue('ceiling_height');

                    if (ceiling > otherCeiling) {
                        bottom = otherCeiling;
                        top = ceiling;
                        offset = (textureSize - (top - bottom)) * line.properties.getValue('upper_unpegged');
                        found = true;
                    }
                }

                if (!found && side.isMiddle) {
                    if (otherSector === null) {
                        bottom = floor;
                        top = ceiling;
                    } else {
                        const otherFloor = otherSector.properties.getValue('floor_height');
                        const otherCeiling = otherSector.properties.getValue('ceiling_height');

                        bottom = Math.max(floor, otherFloor);
                        top = Math.min(ceiling, otherCeiling);

                        const height = Math.min(top - bottom, textureSize);

                        if (line.properties.getValue('lower_unpegged')) {
                            top = bottom + height;
                        } else {
                            bottom = top - height;
                        }
                    }

                    if (bottom < top) {
                        offset = (textureSize - (top - bottom)) * !line.properties.getValue('lower_unpegged');
                        found = true;
                    }
                }

                if (!found && side.isLower && otherSector !== null) {
                    const frontFloor = line.frontSector.properties.getValue('floor_height');
                    const frontCeiling = line.frontSector.properties.getValue('ceiling_height');
                    const backFloor = line.backSector.properties.getValue('floor_height');
                    const backCeiling = line.backSector.properties.getValue('ceiling_height');

                    if (frontFloor !== backFloor) {
                        const isLowerFront = frontFloor < backFloor;

                        if (side.isFront === isLowerFront) {
                            bottom = Math.min(frontFloor, backFloor);

                            const lowerTop = Math.max(frontFloor, backFloor);
                            const upperTop = Math.max(frontCeiling, backCeiling);

                            offset = line.properties.getValue('lower_unpegged') ?
                                textureSize - (upperTop - bottom) :
                                textureSize - (lowerTop - bottom);

                            found = true;
                        }
                    }
                }

                if (!found) {
                    return;
                }

                const origin = -properties.getValue('y_offset') + offset - bottom;

                if (referenceOrigin === null) {
                    referenceOrigin = origin;
                    return;
                }

                const offsetY = (((Math.round(offset - bottom - referenceOrigin) % textureSize) +
                    textureSize) % textureSize);

                if (properties.getValue('y_offset') !== offsetY) {
                    operations.push({
                        op: 'setSideProperty',
                        args: [
                            line.v0.x,
                            line.v0.y,
                            line.v1.x,
                            line.v1.y,
                            side.isFront,
                            'y_offset',
                            offsetY,
                            false,
                        ],
                    });
                }
            });
        }

        return operations;
    }

    /**
     * Creates property operations that offset textures on selected line sides.
     *
     * @param {number} offsetX - The horizontal texture offset delta.
     * @param {number} offsetY - The vertical texture offset delta.
     * @returns {Array<Object>} The generated side-property operations.
     */
    createTextureScrollingOperations(offsetX, offsetY) {
        const textureSize = 512;

        const dx = Math.round(offsetX);
        const dy = Math.round(offsetY);

        const operations = [];

        this.#selection.forEach(geometry => {
            if (!(geometry instanceof Line) ||
                !this.#selectedUpper.has(geometry) &&
                !this.#selectedMiddle.has(geometry) &&
                !this.#selectedLower.has(geometry)) {
                return;
            }

            if (this.#selectedFront.has(geometry)) {
                const offsetX = (((geometry.frontProperties.getValue('x_offset') + dx) % textureSize) +
                    textureSize) % textureSize;
                operations.push({
                    op: 'setSideProperty',
                    args: [
                        geometry.v0.x,
                        geometry.v0.y,
                        geometry.v1.x,
                        geometry.v1.y,
                        true,
                        'x_offset',
                        offsetX,
                        true,
                    ],
                });

                const offsetY = (((geometry.frontProperties.getValue('y_offset') + dy) % textureSize) +
                    textureSize) % textureSize;
                operations.push({
                    op: 'setSideProperty',
                    args: [
                        geometry.v0.x,
                        geometry.v0.y,
                        geometry.v1.x,
                        geometry.v1.y,
                        true,
                        'y_offset',
                        offsetY,
                        true,
                    ],
                });
            }

            if (this.#selectedBack.has(geometry)) {
                const offsetX = (((geometry.backProperties.getValue('x_offset') + dx) %  textureSize) +
                    textureSize) % textureSize;
                operations.push({
                    op: 'setSideProperty',
                    args: [
                        geometry.v0.x,
                        geometry.v0.y,
                        geometry.v1.x,
                        geometry.v1.y,
                        false,
                        'x_offset',
                        offsetX,
                        true,
                    ],
                });

                const offsetY = (((geometry.backProperties.getValue('y_offset') + dy) % textureSize) +
                    textureSize) % textureSize;
                operations.push({
                    op: 'setSideProperty',
                    args: [
                        geometry.v0.x,
                        geometry.v0.y,
                        geometry.v1.x,
                        geometry.v1.y,
                        false,
                        'y_offset',
                        offsetY,
                        true,
                    ],
                });
            }
        });

        return operations;
    }

    ////////////////////////////////////////////////////////////////////////////
    // Properties

    /**
     * Resolves a line and all of its temporary lineage descendants.
     *
     * @param {string} key - Line key.
     * @returns {Set<Line>} Current descendant lines.
     */
    #getLineageLines(key) {
        const pending = [key];
        const lines = new Set();

        while (pending.length > 0) {
            const key = pending.pop();
            const lineage = this.#lineLineages.get(key);

            if (lineage !== undefined) {
                pending.push(...lineage);
            } else {
                lines.add(this.#lineMap.get(key));
            }
        }

        return lines;
    }

    /**
     * Sets a property on one side of a line.
     *
     * @param {number} x0 - The first line x-coordinate.
     * @param {number} y0 - The first line y-coordinate.
     * @param {number} x1 - The second line x-coordinate.
     * @param {number} y1 - The second line y-coordinate.
     * @param {boolean} isFront - `true` to modify the front side; `false` for the back side.
     * @param {string} property - The property name.
     * @param {*} value - The property value.
     * @param {boolean} [recordNoOp=false] - Whether to record an unchanged value in transaction history.
     * @returns {boolean} Whether the property was applied or recorded.
     */
    setSideProperty(x0, y0, x1, y1, isFront, property, value, recordNoOp = false) {
        let found = false;

        const key = DoomMap.createLineKey(x0, y0, x1, y1);
        const hasLineage = this.#lineLineages.has(key);
        const lines = hasLineage ? this.#getLineageLines(key) : [this.#lineMap.get(key)];

        lines.forEach(line => {
            if (line === undefined) {
                console.warn(`Attempted to modify non-existent line "${line}"`);
                return;
            }

            const sideProperties = isFront ? line.frontProperties : line.backProperties;

            if (property === 'texture_middle') {
                line.properties.setValue('texture_middle_explicit', true);
            }

            const last = sideProperties.getValue(property);
            if (last !== value) {
                sideProperties.setValue(property, value);
            } else if (!recordNoOp) {
                return;
            }

            this.#emitEvent('sidechanged', { line, property, isFront, value });

            if (!found && this.#transaction !== null) {
                if (!hasLineage) {
                    this.#transaction.undoOperations.push({
                        op: 'setSideProperty',
                        args: [x0, y0, x1, y1, isFront, property, last, false],
                    });
                }

                this.#transaction.applyOperations.push({
                    op: 'setSideProperty',
                    args: [x0, y0, x1, y1, isFront, property, value, false],
                });
            }

            found = true;
        });

        return found;
    }

    /**
     * Sets a property on a line.
     *
     * @param {number} x0 - The first line x-coordinate.
     * @param {number} y0 - The first line y-coordinate.
     * @param {number} x1 - The second line x-coordinate.
     * @param {number} y1 - The second line y-coordinate.
     * @param {string} property - The property name.
     * @param {*} value - The property value.
     * @returns {boolean} Whether the property changed.
     */
    setLineProperty(x0, y0, x1, y1, property, value) {
        let found = false;

        const key = DoomMap.createLineKey(x0, y0, x1, y1);
        const hasLineage = this.#lineLineages.has(key);
        const lines = hasLineage ? this.#getLineageLines(key) : [this.#lineMap.get(key)];

        lines.forEach(line => {
            if (line === undefined) {
                console.warn(`Attempted to modify non-existent line "${key}"`);
                return;
            }

            if (property === 'impassable') {
                line.properties.setValue('impassable_explicit', true);
            }

            const last = line.properties.getValue(property);
            if (last === value) {
                return;
            }

            line.properties.setValue(property, value);

            this.#emitEvent('linechanged', { line, property, value });

            if (!found && this.#transaction !== null) {
                if (!hasLineage) {
                    this.#transaction.undoOperations.push({
                        op: 'setLineProperty',
                        args: [x0, y0, x1, y1, property, last],
                    });
                }

                this.#transaction.applyOperations.push({
                    op: 'setLineProperty',
                    args: [x0, y0, x1, y1, property, value],
                });
            }

            found = true;
        });

        return found;
    }

    /**
     * Sets a line-local sector property for one side of a line.
     * This does not update any existing sector.
     *
     * @param {number} x0 - The first line x-coordinate.
     * @param {number} y0 - The first line y-coordinate.
     * @param {number} x1 - The second line x-coordinate.
     * @param {number} y1 - The second line y-coordinate.
     * @param {boolean} isFront - `true` to modify the front side; `false` for the back side.
     * @param {string} property - The property name.
     * @param {*} value - The property value.
     * @returns {boolean} Whether the property changed.
     */
    setLineSectorPropertyBySide(x0, y0, x1, y1, isFront, property, value) {
        const changedSectors = new Set();

        let found = false;

        const key = DoomMap.createLineKey(x0, y0, x1, y1);
        const hasLineage = this.#lineLineages.has(key);
        const lines = hasLineage ? this.#getLineageLines(key) : [this.#lineMap.get(key)];

        lines.forEach(line => {
            if (line === undefined) {
                console.warn(`Attempted to modify non-existent line "${key}"`);
                return;
            }

            const properties = isFront ? line.frontSectorProperties : line.backSectorProperties;

            const last = properties.getValue(property);
            if (last === value) {
                return;
            }

            properties.setValue(property, value);

            if (isFront) {
                if (line.frontSector !== null) {
                    changedSectors.add(line.frontSector);
                }
            } else if (line.backSector !== null) {
                changedSectors.add(line.backSector);
            }

            if (!found && this.#transaction !== null) {
                if (!hasLineage) {
                    this.#transaction.undoOperations.push({
                        op: 'setLineSectorPropertyBySide',
                        args: [x0, y0, x1, y1, isFront, property, last],
                    });
                }

                this.#transaction.applyOperations.push({
                    op: 'setLineSectorPropertyBySide',
                    args: [x0, y0, x1, y1, isFront, property, value],
                });
            }

            found = true;
        });

        changedSectors.forEach(sector => {
            this.#emitEvent('sectorchanged', { sector, property, value });
        });

        return found;
    }

    /**
     * Sets a sector property by resolving the sector from one side of a line.
     *
     * @param {number} x0 - The first line x-coordinate.
     * @param {number} y0 - The first line y-coordinate.
     * @param {number} x1 - The second line x-coordinate.
     * @param {number} y1 - The second line y-coordinate.
     * @param {boolean} isFront - `true` to use the front sector; `false` for the back sector.
     * @param {string} property - The property name.
     * @param {*} value - The property value.
     * @returns {boolean} Whether the property changed.
     */
    setSectorPropertyBySide(x0, y0, x1, y1, isFront, property, value) {
        const changedSectors = new Set();

        let found = false;

        const key = DoomMap.createLineKey(x0, y0, x1, y1);
        const hasLineage = this.#lineLineages.has(key);
        const lines = hasLineage ? this.#getLineageLines(key) : [this.#lineMap.get(key)];

        lines.forEach(line => {
            if (line === undefined) {
                console.warn(`Attempted to modify non-existent line "${key}"`);
                return;
            }

            const sector = isFront ? line.frontSector : line.backSector;
            if (sector === null) {
                console.warn(`${isFront ? 'Front' : 'Back'} side sector not found in line "${key}"`);
                return;
            }

            const last = sector.properties.getValue(property);
            if (last === value) {
                return;
            }

            sector.properties.setValue(property, value);

            sector.lines.forEach(line => {
                const properties =
                    line.frontSector === sector ? line.frontSectorProperties :
                    line.backSector === sector ? line.backSectorProperties :
                    null;

                if (properties === null) {
                    console.error(`${sector} has an unassociated line`);
                    throw new Error(`${sector} has an unassociated line`);
                }

                properties.setValue(property, value);
            });

            if (isFront) {
                if (line.frontSector !== null) {
                    changedSectors.add(line.frontSector);
                }
            } else if (line.backSector !== null) {
                changedSectors.add(line.backSector);
            }

            if (!found && this.#transaction !== null) {
                this.#transaction.undoOperations.push({
                    op: 'setSectorPropertyBySide',
                    args: [x0, y0, x1, y1, isFront, property, last],
                });

                this.#transaction.applyOperations.push({
                    op: 'setSectorPropertyBySide',
                    args: [x0, y0, x1, y1, isFront, property, value],
                });
            }

            found = true;
        });

        changedSectors.forEach(sector => {
            this.#emitEvent('sectorchanged', { sector, property, value });
        });

        return found;
    }

    /**
     * Sets a global map metadata property.
     *
     * @param {string} property - The property name.
     * @param {*} value - The property value.
     * @returns {boolean} Whether the property changed.
     */
    setMapProperty(property, value) {
        const last = this.#metadata.getValue(property);
        if (last === value) {
            return false;
        }

        this.#metadata.setValue(property, value);

        if (this.#transaction !== null) {
            this.#transaction.undoOperations.push({
                op: 'setMapProperty',
                args: [property, last],
            });
            this.#transaction.applyOperations.push({
                op: 'setMapProperty',
                args: [property, value],
            });
        }

        this.#emitEvent('metadatachanged', { property, value });

        return true;
    }

    /**
     * Sets a property on the first thing matching the supplied identifying values.
     *
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     * @param {number} z - The z-coordinate.
     * @param {number} typeId - The type identifier.
     * @param {number} angle - The angle.
     * @param {string} property - The property name.
     * @param {*} value - The property value.
     * @returns {boolean} Whether the property changed.
     */
    setThingProperty(x, y, z, typeId, angle, property, value) {
        const key = Thing.createKey(x, y, z, typeId, angle);

        const bucket = this.#thingsMap.get(key);
        const thing = bucket !== undefined && bucket.length > 0 ? bucket[0] : null;
        if (thing === null) {
            console.warn(`Thing "${key}" not found`);
            return false;
        }

        const last = thing.properties.getValue(property);
        if (last === value) {
            return false;
        }

        thing.properties.setValue(property, value);

        const i = bucket.indexOf(thing);
        if (i > -1) {
            bucket.splice(i, 1);
        }
        if (bucket.length === 0) {
            this.#thingsMap.delete(key);
        }

        const newKey = thing.toKey();
        let newBucket = this.#thingsMap.get(newKey);
        if (newBucket === undefined) {
            newBucket = [];
            this.#thingsMap.set(newKey, newBucket);
        }
        newBucket.push(thing);

        if (this.#transaction !== null) {
            this.#transaction.undoOperations.push({
                op: 'setThingProperty',
                args: [x, y, z, typeId, angle, property, last],
            });
            this.#transaction.applyOperations.push({
                op: 'setThingProperty',
                args: [x, y, z, typeId, angle, property, value],
            });
        }

        this.#emitEvent('thingchanged', { thing, property, value });

        return true;
    }

    ////////////////////////////////////////////////////////////////////////////
    // Serialization

    /**
     * Serializes the complete map into plain data.
     *
     * @returns {Object} The serialized map data.
     */
    serialize() {
        return {
            vertices: Array.from(this.#vertices).map(vertex => vertex.serialize()),
            lines: Array.from(this.#lines).map(line => line.serialize()),
            things: Array.from(this.#things).map(thing => thing.serialize()),
            metadata: this.#metadata.serialize(),
        };
    }

    /**
     * Replaces the map contents with serialized map data.
     *
     * @param {Object} data - The serialized map data to restore.
     */
    deserialize(data) {
        this.clear();

        let broken = false;

        if (data.metadata !== undefined) {
            this.#metadata.deserialize(data.metadata);
        }

        data.vertices.forEach(vData => {
            if (broken) {
                return;
            }

            const vertex = Vertex.deserialize(vData);

            if (vertex === null) {
                console.warn(`Failed to deserialize ${vData}`);
                broken = true;
                return;
            }

            this.#addVertexPrimitive(vertex);
        });

        data.lines.forEach(lData => {
            if (broken) {
                return;
            }

            const line = Line.deserialize(lData, this.#vertexMap);

            if (line === null) {
                console.warn(`Failed to deserialize ${lData}`);
                broken = true;
                return;
            }

            this.#addLinePrimitive(line);
        });

        data.things.forEach(tData => {
            if (broken) {
                return;
            }

            const thing = Thing.deserialize(tData);

            if (thing === null) {
                console.warn(`Failed to deserialize ${tData}`);
                broken = true;
                return;
            }

            this.#addThingPrimitive(thing);
        });

        this.clearLineLineages();

        this.rebuildSectors();

        if (broken) {
            console.warn('Map data is broken');
            this.clear();
        }

        this.#emitEvent('select', {
            selection: this.#selection,
            selectedFront: this.#selectedFront,
            selectedBack: this.#selectedBack,
        });
    }

    /**
     * Serializes a geometry collection into vertex, line, and thing data.
     *
     * @param {Set<Geometry>|Array<Geometry>} geometries - The geometry collection to serialize.
     * @returns {Object} The serialized geometry data.
     */
    static serializeGeometries(geometries) {
        const vertexIndex = new Map();

        const vertices = [];
        const lines = [];
        const things = [];

        geometries.forEach(g => {
            if (g instanceof Vertex) {
                const key = DoomMap.createVertexKey(g.x, g.y);
                if (!vertexIndex.has(key)) {
                    vertexIndex.set(key, vertices.length);
                    vertices.push({ x: g.x, y: g.y });
                }
            }
        });

        geometries.forEach(g => {
            if (g instanceof Line) {
                [g.v0, g.v1].forEach(v => {
                    const key = DoomMap.createVertexKey(v.x, v.y);
                    if (!vertexIndex.has(key)) {
                        vertexIndex.set(key, vertices.length);
                        vertices.push({ x: v.x, y: v.y });
                    }
                });
            }
        });

        geometries.forEach(g => {
            if (g instanceof Line) {
                lines.push({
                    v0: vertexIndex.get(DoomMap.createVertexKey(g.v0.x, g.v0.y)),
                    v1: vertexIndex.get(DoomMap.createVertexKey(g.v1.x, g.v1.y)),

                    properties: g.properties.serialize(),
                    front: g.frontProperties.serialize(),
                    back: g.backProperties.serialize(),
                    frontSector: g.frontSectorProperties.serialize(),
                    backSector: g.backSectorProperties.serialize(),
                });
            }
        });

        geometries.forEach(g => {
            if (g instanceof Thing) {
                things.push({
                    x: g.x,
                    y: g.y,
                    properties: g.properties.serialize()
                });
            }
        });

        return { vertices, lines, things };
    }

    /**
     * Creates geometry objects from serialized vertex, line, and thing data.
     *
     * @param {Object} data - The serialized geometry data.
     * @returns {Object} An object containing deserialized `vertices`, `lines`, and `things` arrays.
     */
    static deserializeGeometries(data) {
        const vertices = [];
        const lines = [];
        const things = [];

        data.vertices.forEach(v => {
            vertices.push(new Vertex(v.x, v.y));
        });

        data.lines.forEach(l => {
            const v0 = vertices[l.v0];
            const v1 = vertices[l.v1];

            const line = new Line(v0, v1);

            line.properties.deserialize(l.properties);
            line.frontProperties.deserialize(l.front);
            line.backProperties.deserialize(l.back);
            line.frontSectorProperties.deserialize(l.frontSector);
            line.backSectorProperties.deserialize(l.backSector);

            lines.push(line);
        });

        data.things.forEach(t => {
            const thing = new Thing(t.x, t.y);

            thing.properties.deserialize(t.properties);

            things.push(thing);
        });

        return {
            vertices,
            lines,
            things
        };
    }

    ////////////////////////////////////////////////////////////////////////////
    // Export and import

    /**
     * Exports the map to the internal document format used by MapTransformer.
     *
     * @param {ResourceManager} resourceManager - Resource manager.
     * @returns {Object} Document data.
     */
    export(resourceManager) {
        const port = this.#metadata.getValue('port');
        const format = MapTransformer.PORT_EXPORT_FORMAT.get(port);

        if (format === undefined) {
            throw new Error(`Invalid port "${port}"`);
        }

        const document = {
            port,

            vertexes: [],
            linedefs: [],
            sidedefs: [],
            sectors: [],
            things: [],

            metadata: this.#metadata.export(port),
            extraBlocks: {},
        };

        const vertexIndex = new Map();

        this.iterateVertices(v => {
            const index = document.vertexes.length;
            vertexIndex.set(`${v.x},${v.y}`, index);
            document.vertexes.push({ x: v.x, y: v.y });
        });

        const sectorIndex = new Map();

        this.iterateSectors(sector => {
            if (sector.properties.getValue('is_void')) {
                return;
            }

            const index = document.sectors.length;
            sectorIndex.set(sector, index);

            document.sectors.push(sector.properties.export(port));
        });

        const fallbackTexture = [
            'STARTAN3',
            'STARTAN2',
            'STARTAN1',
            'STONE2',
            'STONE3',
            'BROWN1',
            'GRAY1',
            'BRICK1',
            'WOOD1',
        ].find(name => resourceManager.textures.has(name));

        const addSide = (sideProperties, sector, otherSector) => {
            if (sector === null || sector.properties.getValue('is_void')) {
                return -1;
            }

            const properties = sideProperties.export(port);
            properties.sector = sectorIndex.get(sector);

            const isOuterFacing = otherSector === null || otherSector.properties.getValue('is_void');
            const missingMiddle =
                properties.texturemiddle === '' ||
                properties.texturemiddle === '-' ||
                !resourceManager.textures.has(properties.texturemiddle);

            if (isOuterFacing && missingMiddle && fallbackTexture !== undefined) {
                properties.texturemiddle = fallbackTexture;
            }

            document.sidedefs.push(properties);
            return document.sidedefs.length - 1;
        };

        this.iterateLines(line => {
            const properties = line.properties.export(port);

            const v0 = vertexIndex.get(`${line.v0.x},${line.v0.y}`);
            const v1 = vertexIndex.get(`${line.v1.x},${line.v1.y}`);

            const frontSide = addSide(line.frontProperties, line.frontSector, line.backSector);
            const backSide = addSide(line.backProperties, line.backSector, line.frontSector);

            if (frontSide === -1 && backSide === -1) {
                return;
            }

            if (frontSide === -1 && backSide !== -1) {
                properties.v1 = v1;
                properties.v2 = v0;
                properties.sidefront = backSide;
                properties.sideback = -1;
            } else {
                properties.v1 = v0;
                properties.v2 = v1;
                properties.sidefront = frontSide;
                properties.sideback = backSide;
            }

            const twoSided = properties.sidefront !== -1 && properties.sideback !== -1;

            switch (format) {
                case 'udmf':
                    properties.twosided = twoSided;

                    break;

                case 'wad':
                    if (twoSided) {
                        properties.flags = (properties.flags ?? 0) | 4;
                    } else {
                        properties.flags = (properties.flags ?? 0) & ~4;
                    }

                    break;
            }

            document.linedefs.push(properties);
        });

        this.iterateThings(thing => {
            const properties = thing.properties.export(port);
            properties.x = thing.x;
            properties.y = thing.y;
            document.things.push(properties);
        });

        return document;
    }

    /**
     * Replaces the map with data from the internal MapTransformer document format.
     *
     * @param {Object} document - Document data.
     * @param {string} [mapName='MAP01'] - Map name.
     * @param {boolean} [importLooseVertices=false] - Whether to import vertices not referenced by lines.
     */
    import(document, mapName = 'MAP01', importLooseVertices = false) {
        const port = document.port;
        const format = MapTransformer.PORT_EXPORT_FORMAT.get(port);

        if (format === undefined) {
            throw new Error(`Invalid port "${port}"`);
        }

        this.clear();

        this.#metadata.import(port, document.metadata ?? {});
        this.#metadata.setValue('port', port);
        this.#metadata.setValue('mapname', mapName);

        const sectors = document.sectors ?? [];
        const sidedefs = document.sidedefs ?? [];

        const emptySides = [];

        (document.linedefs ?? []).forEach(l => {
            const v0 = document.vertexes[l.v1];
            const v1 = document.vertexes[l.v2];

            const x0 = Math.round(v0.x);
            const y0 = Math.round(v0.y);
            const x1 = Math.round(v1.x);
            const y1 = Math.round(v1.y);

            this.addLine(x0, y0, x1, y1, null, false, null, false);

            const line = this.getLine(x0, y0, x1, y1);
            if (line === null) {
                return;
            }

            const flipped = !(line.v0.x === v0.x && line.v0.y === v0.y);

            const front = sidedefs[flipped ? l.sideback : l.sidefront];
            const back = sidedefs[flipped ? l.sidefront : l.sideback];

            line.properties.import(port, l);

            if (front !== undefined) {
                line.frontProperties.import(port, front);
                line.frontSectorProperties.import(port, sectors[front.sector] ?? {});
            } else {
                emptySides.push({
                    line,
                    isFront: true,
                });
            }

            if (back !== undefined) {
                line.backProperties.import(port, back);
                line.backSectorProperties.import(port, sectors[back.sector] ?? {});
            } else {
                emptySides.push({
                    line,
                    isFront: false,
                });
            }
        });

        if (importLooseVertices) {
            (document.vertexes ?? []).forEach(v => {
                this.addVertex(Math.round(v.x), Math.round(v.y));
            });
        }

        this.rebuildSectors();

        emptySides.forEach(side => {
            if (side.isFront) {
                if (side.line.frontSector !== null) {
                    side.line.frontSectorProperties.setValue('is_void', true);
                    side.line.frontSector.properties.setValue('is_void', true);
                    side.line.properties.setValue('clear_double_sided', true);
                }
            } else if (side.line.backSector !== null) {
                side.line.backSectorProperties.setValue('is_void', true);
                side.line.backSector.properties.setValue('is_void', true);
                side.line.properties.setValue('clear_double_sided', true);
            }

        });

        (document.things ?? []).forEach(t => {
            const thing = this.addThing(
                t.x,
                t.y,
                t.z ?? t.height ?? 0,
                t.type ?? 0,
                t.angle ?? 0
            );

            thing.properties.import(port, t);
        });

        this.clearLineLineages();

        this.#emitEvent('metadatachanged', { property: 'port', value: port });
    }
}
