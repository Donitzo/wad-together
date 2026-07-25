import Line from './line.class.js';
import DoomMap from '../doommap.class.js';
import Geometry from '../geometry.class.js';
import SectorProperties from '../properties/sectorproperties.class.js';
import Utility from '../utility.class.js';

/**
 * Represents a 2D sector enclosed by lines.
 */
export default class Sector extends Geometry {
    /** @type {Array<Line>} */
    #lines = [];
    /** @type {Array<Line>} Boundary lines of this sector. */
    get lines() {
        return this.#lines;
    }

    /** @type {Array<number>} */
    #flatXY = [];
    /** @type {Array<number>} Flat vertex coordinates. */
    get flatXY() {
        return this.#flatXY;
    }

    /** @type {Array<Array<number>>} */
    #mergedChildLoops = null;
    /** @type {Array<Array<number>>} Boundary loops of child sectors. */
    get mergedChildLoops() {
        if (this.#mergedChildLoops === null) {
            this.#mergedChildLoops = this.#mergeChildLoops();
        }
        return this.#mergedChildLoops;
    }

    /** @type {Array<number>} Cached coefficients. */
    #edgeCoefficients = [];

    /** @type {?Sector} */
    #parent = null;
    /** @type {?Sector} Parent sector this sector is contained within. */
    get parent() {
        return this.#parent;
    }

    /** @type {Array<Sector>} */
    #children = [];
    /** @type {Array<Sector>} Direct child sectors contained within this sector. */
    get children() {
        return this.#children;
    }

    /** @type {number} */
    #depth = 0;
    /** @type {number} Depth of this sector in the parent/child hierarchy (0 = root). */
    get depth() {
        return this.#depth;
    }

    /** @type {SectorProperties} */
    #properties = new SectorProperties();
    /** @type {SectorProperties} Sector properties. */
    get properties() {
        return this.#properties;
    }

    /** @type {boolean} Whether the sector has been permanently removed from the map. */
    #removedFromMap = false;

    /** @type {boolean} Whether this is a void sector. */
    get isVoid() {
        return this.#properties.getValue('is_void');
    }

    /**
     * Constructs a sector from connected line-side descriptors.
     *
     * @param {DoomMap} map - The map containing the sector.
     * @param {Map<string, Line>} lineMap - Existing lines indexed by their coordinate keys.
     * @param {Array<{v0:Vertex, v1:Vertex, front:boolean}>} lines - Ordered line-side descriptors.
     */
    constructor(map, lineMap, lines) {
        if (lines.length < 3) {
            throw new Error(`Cannot create sector with ${lines.length} lines`);
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        lines.forEach(line => {
            minX = Math.min(minX, line.v0.x, line.v1.x);
            minY = Math.min(minY, line.v0.y, line.v1.y);
            maxX = Math.max(maxX, line.v0.x, line.v1.x);
            maxY = Math.max(maxY, line.v0.y, line.v1.y);
        });

        super({ min: { x: minX, y: minY }, max: { x: maxX, y: maxY } });

        const flatXY = this.#flatXY;

        // Register sector for lines and create flat coordinate loop
        lines.forEach((line, i) => {
            const key = DoomMap.createLineKey(line.v0.x, line.v0.y, line.v1.x, line.v1.y);
            const l = lineMap.get(key);
            if (l === undefined) {
                console.error(`${this} references missing line "${key}"`);
                throw new Error(`${this} references missing line "${key}"`);
            }

            this.#lines.push(l);

            if (line.front) {
                if (l.frontSector !== null && !l.frontSectorIsParent) {
                    console.error(`${l} already has a front sector`);
                    throw new Error(`${l} already has a front sector`);
                }
                l.frontSector = this;
                l.frontSectorIsParent = false;

                if (i === 0) {
                    flatXY.push(l.v0.x, l.v0.y);
                }
                flatXY.push(l.v1.x, l.v1.y);
            } else {
                if (l.backSector !== null && !l.backSectorIsParent) {
                    console.error(`${l} already has a back sector`);
                    throw new Error(`${l} already has a back sector`);
                }
                l.backSector = this;
                l.backSectorIsParent = false;

                if (i === 0) {
                    flatXY.push(l.v1.x, l.v1.y);
                }
                flatXY.push(l.v0.x, l.v0.y);
            }
        });

        // Select the most common sector properties from sector lines
        this.#selectMostCommonSectorProperties();

        // Pre-calculate edge coefficients for containsPoint
        for (let i = 0, j = flatXY.length - 2; i < flatXY.length; j = i, i += 2) {
            const x0 = flatXY[j];
            const y0 = flatXY[j + 1];
            const x1 = flatXY[i];
            const y1 = flatXY[i + 1];
            if (y0 === y1) {
                continue;
            }

            const ymin = Math.min(y0, y1);
            const ymax = Math.max(y0, y1);
            const xAtYmin = y0 < y1 ? x0 : x1;
            const slope = (x1 - x0) / (y1 - y0);

            this.#edgeCoefficients.push({ ymin, ymax, xAtYmin, slope });
        }

        const b1 = this.bounds;

        // Find the most immediate parent that fully contains this sector
        map.iterateSectors(other => {
            const b2 = other.bounds;
            const flat = this.flatXY;
            let contains = (
                b1.min.x >= b2.min.x &&
                b1.min.y >= b2.min.y &&
                b1.max.x <= b2.max.x &&
                b1.max.y <= b2.max.y);
            for (let i = 0; i < flat.length && contains; i += 2) {
                if (!other.containsPoint(flat[i], flat[i + 1], false)) {
                    contains = false;
                }
            }

            if (contains && (!this.#parent || other.childOf(this.#parent))) {
                this.#parent = other;
            }
        }, b1.min, b1.max);

        // Register as a child of a parent sector
        if (this.#parent !== null) {
            // Connect empty outside line sides to parent sector
            this.#lines.forEach(line => {
                if (line.frontSector === this && line.backSector === null) {
                    line.backSector = this.#parent;
                    line.backSectorIsParent = true;
                }

                if (line.backSector === this && line.frontSector === null) {
                    line.frontSector = this.#parent;
                    line.frontSectorIsParent = true;
                }
            });

            this.#parent.#children.push(this);
            this.#parent.#mergedChildLoops = null;
            this.#depth = this.#parent.#depth + 1;
        } else {
            this.#depth = 0;
        }

        // Adopt any pre-existing children that fall fully within this sector
        map.iterateSectors(other => {
            // Only adopt child sectors inside the same parent sector
            if (other.#parent !== this.#parent) {
                return;
            }

            const b2 = other.bounds;
            const flat = other.flatXY;
            let contains = (
                b2.min.x >= b1.min.x &&
                b2.min.y >= b1.min.y &&
                b2.max.x <= b1.max.x &&
                b2.max.y <= b1.max.y);
            for (let i = 0; i < flat.length && contains; i += 2) {
                if (!this.containsPoint(flat[i], flat[i + 1], false)) {
                    contains = false;
                }
            }

            if (contains) {
                // If there is an old parent, remove the child
                if (other.#parent !== null) {
                    const i = other.#parent.#children.indexOf(other);
                    other.#parent.#children.splice(i, 1);
                    other.#parent.#mergedChildLoops = null;
                }

                // Adopt the child sector
                this.#children.push(other);
                this.#mergedChildLoops = null;

                other.#parent = this;
                other.#updateDepth(this.#depth + 1);

                // Connect adopted child outside line sides to this sector
                other.#lines.forEach(line => {
                    if (line.frontSector === this.#parent) {
                        line.frontSector = this;
                        line.frontSectorIsParent = true;
                    }
                    if (line.backSector === this.#parent) {
                        line.backSector = this;
                        line.backSectorIsParent = true;
                    }
                });

                // Make child sector line sides copy the sector properties
                other.#copyPropertiesToLines();
            }
        }, b1.min, b1.max);

        // Copy the front / back sector properties to all lines
        this.#copyPropertiesToLines();
    }

    /**
     * Copies the most common boundary-side properties into the sector properties.
     */
    #selectMostCommonSectorProperties() {
        const counts = new Map();

        let bestCount = 0;
        let mostCommon = null;

        this.#lines.forEach(line => {
            const properties =
                line.frontSector === this ? line.frontSectorProperties :
                line.backSector === this ? line.backSectorProperties :
                null;

            if (properties === null) {
                console.error(`${this} has an unassociated line`);
                throw new Error(`${this} has an unassociated line`);
            }

            const hash = properties.hash();
            const count = (counts.get(hash) ?? 0) + 1;
            counts.set(hash, count);

            if (count > bestCount) {
                bestCount = count;
                mostCommon = properties;
            }
        });

        this.#properties.copy(mostCommon);
    }

    /**
     * Copies the sector properties to each associated boundary side.
     */
    #copyPropertiesToLines() {
        this.#lines.forEach(line => {
            const properties =
                line.frontSector === this ? line.frontSectorProperties :
                line.backSector === this ? line.backSectorProperties :
                null;

            if (properties === null) {
                console.error(`${this} has an unassociated line`);
                throw new Error(`${this} has an unassociated line`);
            }

            properties.copy(this.#properties);
        });
    }

    /**
     * Detaches the sector and repairs its line, parent, and child relationships.
     */
    removeFromMap() {
        if (this.#removedFromMap) {
            console.error(`${this} has already been removed`);
            throw new Error(`${this} has already been removed`);
        }
        this.#removedFromMap = true;

        // Remove this sector from own line sides.
        // If the opposite side is this sector's parent filler, remove that too (degenerate line)
        this.#lines.forEach(line => {
            const isFront = line.frontSector === this;
            const isBack = line.backSector === this;

            const backIsParent = this.#parent !== null &&
                line.backSector === this.#parent && line.backSectorIsParent;

            const frontIsParent = this.#parent !== null &&
                line.frontSector === this.#parent && line.frontSectorIsParent;

            if (isFront) {
                line.frontSector = null;
                line.frontSectorIsParent = false;

                if (backIsParent) {
                    line.backSector = null;
                    line.backSectorIsParent = false;
                }
            }

            if (isBack) {
                line.backSector = null;
                line.backSectorIsParent = false;

                if (frontIsParent) {
                    line.frontSector = null;
                    line.frontSectorIsParent = false;
                }
            }
        });

        // Reparent child sectors
        this.#children.forEach(child => {
            // Change child parent
            child.#parent = this.#parent;

            // Add child to parent sector (if it exists)
            if (this.#parent !== null) {
                this.#parent.#children.push(child);
                this.#parent.#mergedChildLoops = null;
                child.#updateDepth(this.#parent.#depth + 1);
            } else {
                child.#updateDepth(0);
            }

            // Re-parent child line sides from this sector to the parent sector if outward facing
            child.#lines.forEach(line => {
                if (line.frontSector === this) {
                    line.frontSector = this.#parent;
                    line.frontSectorIsParent = this.#parent !== null;
                }
                if (line.backSector === this) {
                    line.backSector = this.#parent;
                    line.backSectorIsParent = this.#parent !== null;
                }
            });

            // Copy the front / back sector properties to all child lines
            child.#copyPropertiesToLines();
        });

        // Remove from parent's child list
        if (this.#parent !== null) {
            const i = this.#parent.#children.indexOf(this);
            if (i === -1) {
                console.error(`Missing child in ${this}`);
                throw new Error(`Missing child in ${this}`);
            }
            this.#parent.#children.splice(i, 1);
            this.#parent.#mergedChildLoops = null;
        }
    }

    /**
     * Updates this sector's hierarchy depth and recursively updates its children.
     *
     * @param {number} depth - The new hierarchy depth.
     */
    #updateDepth(depth) {
        this.#depth = depth;
        this.children.forEach(child => {
            child.#updateDepth(depth + 1);
        });
    }

    /**
     * Tests whether this sector is a descendant of another sector.
     *
     * @param {Sector} parent - The potential ancestor sector.
     * @returns {boolean} Whether this sector is a direct or indirect child of the sector.
     */
    childOf(parent) {
        let p = this.#parent;
        while (p) {
            if (p === parent) {
                return true;
            }
            p = p.#parent;
        }
        return false;
    }

    /**
     * Computes merged vertex loops representing the boundaries between this sector and all its child sectors.
     * Each loop corresponds to the visible border of one or more directly connected child sectors.
     *
     * @returns {Array<Array<number>>} Array of flat XY loops.
     */
    #mergeChildLoops() {
        const loops = [];

        const visitedLines = new Set();

        // Trace a continuous loop along any edges where one side is this sector
        const traceLoop = startLine => {
            const loop = [];

            let current = startLine;

            let v0;
            let v1;
            if (current.frontSector === this) {
                v0 = current.v1;
                v1 = current.v0;
            } else {
                v0 = current.v0;
                v1 = current.v1;
            }

            loop.push(v0.x, v0.y);

            while (true) {
                loop.push(v1.x, v1.y);
                visitedLines.add(current);

                // Find next line sharing this vertex that still borders this sector
                const nextLine = v1.lines.find(line => !visitedLines.has(line) &&
                    ((line.frontSector === this && line.backSector !== this) ||
                    (line.backSector === this && line.frontSector !== this)));

                if (nextLine === undefined || nextLine === startLine) {
                    break;
                }

                current = nextLine;
                v1 = current.v0 === v1 ? current.v1 : current.v0;
            }

            // Ensure CCW winding
            if (Utility.signedArea2d(loop) < 0) {
                for (let i = 0, j = loop.length - 2; i < j; i += 2, j -= 2) {
                    const tx = loop[i];
                    const ty = loop[i + 1];
                    loop[i] = loop[j];
                    loop[i + 1] = loop[j + 1];
                    loop[j] = tx;
                    loop[j + 1] = ty;
                }
            }

            return loop;
        };

        // Iterate over all direct child sectors
        this.children.forEach(child => {
            child.lines.forEach(line => {
                // The line is on the outer boundary if it touches this sector
                const isBoundary = line.backSector === this || line.frontSector === this;
                if (!isBoundary || visitedLines.has(line)) {
                    return;
                }

                const loop = traceLoop(line);
                if (loop.length >= 6) {
                    loops.push(loop);
                }
            });
        });

        return loops;
    }

    /**
     * Tests whether a point lies inside the sector boundary.
     *
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     * @param {boolean} [allowEdge=true] - Whether points on boundary lines count as inside.
     * @returns {boolean} Whether the point lies inside the sector.
     */
    containsPoint(x, y, allowEdge = true) {
        const bounds = this.bounds;
        if (x < bounds.min.x ||
            x > bounds.max.x ||
            y < bounds.min.y ||
            y > bounds.max.y) {
            return false;
        }

        if (!allowEdge) {
            for (const line of this.#lines) {
                const v0 = line.v0;
                const v1 = line.v1;
                const dx = v1.x - v0.x;
                const dy = v1.y - v0.y;
                const cross = (x - v0.x) * dy - (y - v0.y) * dx;
                if (Math.abs(cross) < 1e-6) {
                    const dot = (x - v0.x) * (x - v1.x) + (y - v0.y) * (y - v1.y);
                    if (dot <= 0) {
                        return false;
                    }
                }
            }
        }

        let inside = false;
        this.#edgeCoefficients.forEach(e => {
            if (y >= e.ymin && y < e.ymax) {
                const xInt = (y - e.ymin) * e.slope + e.xAtYmin;
                if (x < xInt) {
                    inside = !inside;
                }
            }
        });
        return inside;
    }

    /**
     * Measures the sector thickness through a point along a direction vector.
     *
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     * @param {number} nx - The direction x-component.
     * @param {number} ny - The direction y-component.
     * @returns {number} The distance between the nearest intersections in both directions, or zero.
     */
    getThicknessThroughPoint(x, y, nx, ny) {
        let tPos = Infinity;
        let tNeg = -Infinity;

        this.#lines.forEach(line => {
            const x0 = line.v0.x;
            const y0 = line.v0.y;
            const x1 = line.v1.x;
            const y1 = line.v1.y;

            const ex = x1 - x0;
            const ey = y1 - y0;

            const denom = ex * ny - ey * nx;
            if (Math.abs(denom) < 1e-6) {
                return;
            }

            const dx = x0 - x;
            const dy = y0 - y;

            const t = (ex * dy - ey * dx) / denom;
            const u = (nx * dy - ny * dx) / denom;

            if (u < 0 || u > 1) {
                return;
            }

            if (t > 0 && t < tPos) {
                tPos = t;
            } else if (t < 0 && t > tNeg) {
                tNeg = t;
            }
        });

        return tPos < Infinity && tNeg > -Infinity ? tPos - tNeg : 0;
    }

    /**
     * Tests whether the sector intersects a circle.
     *
     * @param {number} x - The circle center x-coordinate.
     * @param {number} y - The circle center y-coordinate.
     * @param {number} radius - The circle radius.
     * @returns {boolean} Whether the sector intersects the circle.
     */
    isInsideCircle(x, y, radius) {
        if (this.containsPoint(x, y)) {
            return true;
        }

        const radius2 = radius * radius;
        for (const line of this.lines) {
            const d2 = line.getDistanceSquaredToPoint(x, y);
            if (d2 !== null && d2 < radius2) {
                return true;
            }
        }

        return false;
    }

    /**
     * Tests whether the sector is contained by or intersects a rectangle.
     *
     * @param {number} x0 - The first rectangle x-coordinate.
     * @param {number} y0 - The first rectangle y-coordinate.
     * @param {number} x1 - The opposite rectangle x-coordinate.
     * @param {number} y1 - The opposite rectangle y-coordinate.
     * @param {boolean} [intersects=false] - Whether partial intersection is sufficient.
     * @returns {boolean} Whether the sector satisfies the rectangle test.
     */
    isInsideRectangle(x0, y0, x1, y1, intersects = false) {
        const minX = Math.min(x0, x1);
        const maxX = Math.max(x0, x1);
        const minY = Math.min(y0, y1);
        const maxY = Math.max(y0, y1);

        if (this.bounds.max.x < minX || this.bounds.min.x > maxX ||
            this.bounds.max.y < minY || this.bounds.min.y > maxY) {
            return false;
        }

        const flat = this.#flatXY;
        const n = flat.length;

        if (!intersects) {
            for (let i = 0; i < n; i += 2) {
                const vx = flat[i];
                const vy = flat[i + 1];

                if (vx < minX || vx > maxX || vy < minY || vy > maxY) {
                    return false;
                }
            }
            return true;
        }

        for (let i = 0; i < n; i += 2) {
            const vx = flat[i];
            const vy = flat[i + 1];
            if (vx >= minX && vx <= maxX && vy >= minY && vy <= maxY) {
                return true;
            }
        }

        if (this.containsPoint(minX, minY)) {
            return true;
        }
        if (this.containsPoint(minX, maxY)) {
            return true;
        }
        if (this.containsPoint(maxX, minY)) {
            return true;
        }
        if (this.containsPoint(maxX, maxY)) {
            return true;
        }

        for (let i = 0; i < n; i += 2) {
            const x0 = flat[i];
            const y0 = flat[i + 1];
            const x1 = flat[(i + 2) % n];
            const y1 = flat[(i + 3) % n];

            if (Utility.segmentsProperlyIntersect(x0, y0, x1, y1,minX, minY, maxX, minY) ||
                Utility.segmentsProperlyIntersect(x0, y0, x1, y1,maxX, minY, maxX, maxY) ||
                Utility.segmentsProperlyIntersect(x0, y0, x1, y1,maxX, maxY, minX, maxY) ||
                Utility.segmentsProperlyIntersect(x0, y0, x1, y1,minX, maxY, minX, minY)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @returns {string} The sector description.
     */
    toString() {
        return `Sector(lines=${this.#lines.length}, start=(${this.#lines[0].v0.x}, ${this.#lines[0].v0.y}))`;
    }
}
