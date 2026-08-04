import DoomMaterial from './doommaterial.class.js';
import Line from './geometries/line.class.js';
import Sector from './geometries/sector.class.js';
import Thing from './geometries/thing.class.js';
import ImageManager from './imagemanager.class.js';
import Utility from './utility.class.js';

import * as THREE from './lib/three.js/three.module.js';

/**
 * Three-dimensional renderer for a Doom map.
 */
export default class Map3D {
    /** @type {number} Width and height of each spatial-index cell, in map units. */
    static #SPATIAL_INDEX_CELL_SIZE = 1024;
    /** @type {number} Number of cells along each spatial-index axis. */
    static #SPATIAL_INDEX_SIZE = 1024;

    /** @type {number} Three.js world-space meters represented by one map unit. */
    static METERS_PER_UNIT = 1 / 64;
    /** @type {number} Scale applied to vertical map coordinates. */
    static VERTICAL_SCALE = 1.2;

    static #tmpRaycaster = new THREE.Raycaster();
    static #tmpIntersections = [];

    static #tmpSet0 = new Set();
    static #tmpSet1 = new Set();
    static #tmpSet2 = new Set();

    static #tmpV30 = new THREE.Vector3();

    /** @type {Map<string, THREE.Texture>} Texture lookup cache. */
    #textureCache = new Map();
    /** @type {?Array<THREE.Texture>} Placeholder textures for missing assets. */
    #missingTexture = null;

    /** @type {?ResourceManager} Resource manager. */
    #resourceManager = null;
    /** @type {?DoomMap} Doom map represented by this renderer. */
    #doomMap = null;
    /** @type {?Client} Multiplayer client. */
    #client = null;

    /** @type {?THREE.Object3D} Parent object containing all generated map meshes. */
    #container = null;

    /** @type {Set<Sector>} Sectors currently registered with the renderer. */
    #sectors = new Set();
    /** @type {Set<Sector>} Sectors requiring mesh reconstruction. */
    #dirtySectors = new Set();

    /** @type {Map<Sector, THREE.Mesh[]>} Floor and ceiling meshes by sector. */
    #sectorMeshes = new Map();
    /** @type {Map<Line, THREE.Mesh[]>} Wall meshes by line. */
    #wallMeshes = new Map();
    /** @type {Map<Line, Set<Sector>>} Visible sectors requiring each line's wall meshes. */
    #wallPickerSectors = new Map();
    /** @type {Map<Line, boolean>} Lines whose wall meshes are currently attached. */
    #wallVisible = new Map();
    /** @type {Map<Thing, THREE.Mesh>} Sprite meshes by thing. */
    #thingMeshes = new Map();

    /** @type {Set<Sector>} Sectors currently visible and attached to the scene. */
    #visibleSectors = new Set();
    /** @type {Set<Thing>} Things currently visible and attached to the scene. */
    #visibleThings = new Set();

    /** @type {Array<THREE.Mesh>} Meshes included in geometry-picking raycasts. */
    #pickableMeshes = [];
    /** @type {Set<THREE.Mesh>} Meshes currently displayed as hovered. */
    #hoveredMeshes = new Set();
    /** @type {Set<THREE.Mesh>} Meshes currently displayed as selected. */
    #selectedMeshes = new Set();

    /** @type {Map<number, Sector[]>} Sector spatial index by flattened cell index. */
    #spatialIndexSector = new Map();
    /** @type {Map<number, Thing[]>} Thing spatial index by flattened cell index. */
    #spatialIndexThing = new Map();

    /**
     * @param {ResourceManager} resourceManager - Resource manager.
     * @param {DoomMap} doomMap - Doom map.
     * @param {Client} client - Multiplayer client.
     * @param {THREE.Object3D} container - Parent object for generated meshes.
     */
    constructor(resourceManager, doomMap, client, container) {
        this.#resourceManager = resourceManager;
        this.#doomMap = doomMap;
        this.#client = client;
        this.#container = container;

        if (this.#missingTexture === null) {
            this.#missingTexture = [
                Map3D.#createMissingTexture({ backgroundColor0: '#682e37', backgroundColor1: '#491e24' }),
                Map3D.#createMissingTexture({ backgroundColor0: '#313763', backgroundColor1: '#ffffff00' }),
                Map3D.#createMissingTexture({ backgroundColor0: '#422e45', backgroundColor1: '#2d1e2f' }),
            ];
        }

        const texture = ImageManager.getThreeTexture('player.png');
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.userData.frameCount = 8;
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////
    // Public API
    //////////////////////////////////////////////////////////////////////////////////////////////////////////

    /**
     * Registers a sector and schedules its meshes for construction.
     *
     * @param {Sector} sector - Sector to register.
     */
    addSector(sector) {
        if (!this.#sectors.has(sector)) {
            this.#sectors.add(sector);
            this.#markDirty(sector);
            this.#addToSpatialIndexSector(sector);
        }
    }

    /**
     * Unregisters a sector and disposes its generated meshes.
     *
     * @param {Sector} sector - Sector to unregister.
     */
    removeSector(sector) {
        if (!this.#sectors.has(sector)) {
            return;
        }

        const affectedSectors = new Set();

        sector.lines.forEach(line => {
            if (line.frontSector !== sector && this.#sectors.has(line.frontSector)) {
                affectedSectors.add(line.frontSector);
            }

            if (line.backSector !== sector && this.#sectors.has(line.backSector)) {
                affectedSectors.add(line.backSector);
            }
        });

        affectedSectors.forEach(affectedSector => {
            this.#markDirty(affectedSector);
        });

        this.#sectors.delete(sector);
        this.#removeFromSpatialIndexSector(sector);
        this.#dirtySectors.delete(sector);
        this.#removeSectorMeshes(sector);
    }

    /**
     * Schedules a registered sector for mesh reconstruction.
     *
     * @param {Sector} sector - Sector whose geometry or properties changed.
     */
    updateSector(sector) {
        if (this.#sectors.has(sector)) {
            this.#markDirty(sector);
        }
    }

    /**
     * Creates and indexes a sprite mesh for a thing.
     *
     * @param {Thing} thing - Thing to add.
     */
    addThing(thing) {
        if (this.#thingMeshes.has(thing)) {
            return;
        }

        const cellSize = Map3D.#SPATIAL_INDEX_CELL_SIZE;
        const gridSize = Map3D.#SPATIAL_INDEX_SIZE;
        const gridOffset = Math.floor(gridSize / 2);

        // Create a mesh for the thing
        const mesh = this.#createThingMesh(thing);
        this.#thingMeshes.set(thing, mesh);

        // Assign the mesh to the spatial index
        const x = Math.min(Math.max(Math.floor(thing.bounds.min.x / cellSize) + gridOffset, 0), gridSize - 1);
        const y = Math.min(Math.max(Math.floor(thing.bounds.min.y / cellSize) + gridOffset, 0), gridSize - 1);
        const index = x + y * gridSize;
        let things = this.#spatialIndexThing.get(index);
        if (things === undefined) {
            things = [];
            this.#spatialIndexThing.set(index, things)
        }
        things.push(thing);
    }

    /**
     * Removes and disposes a thing's sprite mesh.
     *
     * @param {Thing} thing - Thing to remove.
     */
    removeThing(thing) {
        const mesh = this.#thingMeshes.get(thing);
        if (mesh === undefined) {
            return;
        }

        const cellSize = Map3D.#SPATIAL_INDEX_CELL_SIZE;
        const gridSize = Map3D.#SPATIAL_INDEX_SIZE;
        const gridOffset = Math.floor(gridSize / 2);

        // Dispose mesh
        this.#disposeMesh(mesh);

        this.#visibleThings.delete(thing);

        // Delete thing
        this.#thingMeshes.delete(thing);
        const i = this.#pickableMeshes.indexOf(mesh);
        if (i > -1) {
            this.#pickableMeshes.splice(i, 1);
        }

        // Remove thing from spatial index
        const x = Math.min(Math.max(Math.floor(thing.bounds.min.x / cellSize) + gridOffset, 0), gridSize - 1);
        const y = Math.min(Math.max(Math.floor(thing.bounds.min.y / cellSize) + gridOffset, 0), gridSize - 1);
        const index = x + y * gridSize;
        const things = this.#spatialIndexThing.get(index);
        things.splice(things.indexOf(thing), 1);
    }

    /**
     * Updates thing heights and lighting from their containing sectors.
     */
    updateThings() {
        this.#thingMeshes.forEach(mesh => {
            const thing = mesh.userData.thing;

            const sector = this.#doomMap.getSector(thing.x, thing.y);

            if (sector !== null) {
                mesh.position.y = (sector.properties.getValue('floor_height') +
                    thing.properties.getValue('z')) * Map3D.VERTICAL_SCALE;
            }

            const lightLevel = sector?.properties.getValue('light_level') ?? 12;
            mesh.material.uniforms.uColormapIndex.value = Math.min((255 - lightLevel) >> 3, 31);
        });
    }

    /**
     * Updates mesh-selection uniforms from the current map selection.
     *
     * @param {Iterable<object>} selection - Selected sectors, lines, and things.
     */
    updateSelection(selection) {
        this.#selectedMeshes.forEach(mesh => {
            mesh.material.uniforms.uSelected.value = 0;
        });
        this.#selectedMeshes.clear();

        selection.forEach(g => {
            if (g instanceof Sector) {
                const meshes = this.#sectorMeshes.get(g);
                if (meshes !== undefined) {
                    meshes.forEach(mesh => {
                        const selected = this.#doomMap.isSelected(
                            g,
                            null,
                            null,
                            mesh.userData.section === 'ceiling' ? true : null,
                            null,
                            mesh.userData.section === 'floor' ? true : null
                        );
                        if (selected) {
                            mesh.material.uniforms.uSelected.value = 1;
                            this.#selectedMeshes.add(mesh);
                        }
                    });
                }
            }

            if (g instanceof Line) {
                const meshes = this.#wallMeshes.get(g);
                if (meshes !== undefined) {
                    meshes.forEach(mesh => {
                        const selected = this.#doomMap.isSelected(
                            g,
                            mesh.userData.isFront ? true : null,
                            !mesh.userData.isFront ? true : null,
                            mesh.userData.section === 'upper' ? true : null,
                            mesh.userData.section === 'middle' ? true : null,
                            mesh.userData.section === 'lower' ? true : null
                        );
                        if (selected) {
                            mesh.material.uniforms.uSelected.value = 1;
                            this.#selectedMeshes.add(mesh);
                        }
                    });
                }
            }

            if (g instanceof Thing) {
                const mesh = this.#thingMeshes.get(g);
                if (mesh !== undefined) {
                    const selected = this.#doomMap.isSelected(g);
                    if (selected) {
                        mesh.material.uniforms.uSelected.value = 1;
                        this.#selectedMeshes.add(mesh);
                    }
                }
            }
        });
    }

    /**
     * Clears the visual hover state from all currently hovered meshes.
     */
    clearHover() {
        this.#hoveredMeshes.forEach(mesh => {
            mesh.material.uniforms.uHovered.value = 0;
        });
        this.#hoveredMeshes.clear();
    }

    /**
     * Returns the map geometry intersected first by a ray.
     *
     * @param {THREE.Ray} ray - World-space picking ray.
     * @param {boolean} [hover=true] - Whether to apply the visual hover state.
     * @returns {?object} Mesh user data describing the hit geometry, or `null`.
     */
    getHoveredGeometry(ray, hover = true) {
        const raycaster = Map3D.#tmpRaycaster;
        raycaster.ray.copy(ray);

        const intersections = Map3D.#tmpIntersections;
        intersections.length = 0;
        raycaster.intersectObjects(this.#pickableMeshes, false, intersections);
        if (intersections.length === 0) {
            return null;
        }

        const hit = intersections[0];
        const mesh = hit.object;

        if (hover) {
            mesh.material.uniforms.uHovered.value = 1;
            this.#hoveredMeshes.add(mesh);
        }

        return mesh.userData;
    }

    /**
     * Updates visible geometry around the camera. Rebuilds a limited number of dirty sectors,
     * culls distant sectors and things, creates multiplayer sprites, and rotates billboard sprites.
     *
     * @param {THREE.Object3D} camera - Camera or camera rig used for culling and billboarding.
     * @param {boolean} [renderEverything=false] - Whether to ignore distance culling.
     * @param {number} [cullingDistance=200] - Visibility radius in world-space units.
     * @param {number} [maxSectorBuilds=8] - Maximum dirty sectors rebuilt this frame.
     */
    update(camera, renderEverything = false, cullingDistance = 200, maxSectorBuilds = 8) {
        const cellSize = Map3D.#SPATIAL_INDEX_CELL_SIZE;
        const gridSize = Map3D.#SPATIAL_INDEX_SIZE;
        const gridOffset = Math.floor(gridSize / 2);
        const metersPerUnit = Map3D.METERS_PER_UNIT;

        const cameraPosition = camera.getWorldPosition(Map3D.#tmpV30);
        this.#container.worldToLocal(cameraPosition);

        const cameraMinX = cameraPosition.x - cullingDistance / metersPerUnit;
        const cameraMaxX = cameraPosition.x + cullingDistance / metersPerUnit;
        const cameraMinY = cameraPosition.z - cullingDistance / metersPerUnit;
        const cameraMaxY = cameraPosition.z + cullingDistance / metersPerUnit;

        const cameraCellMinX = Math.max(0, Math.floor(cameraMinX / cellSize) + gridOffset);
        const cameraCellMaxX = Math.min(gridSize - 1, Math.floor(cameraMaxX / cellSize) + gridOffset);
        const cameraCellMinY = Math.max(0, Math.floor(cameraMinY / cellSize) + gridOffset);
        const cameraCellMaxY = Math.min(gridSize - 1, Math.floor(cameraMaxY / cellSize) + gridOffset);

        const sectorsToBuild = Map3D.#tmpSet0;
        sectorsToBuild.clear();


        if (renderEverything) {
            this.#dirtySectors.forEach(sector => {
                if (sectorsToBuild.size < maxSectorBuilds) {
                    sectorsToBuild.add(sector);
                }
            });

            this.#sectors.forEach(sector => {
                if (this.#dirtySectors.has(sector)) {
                    return;
                }

                if (!this.#visibleSectors.has(sector)) {
                    this.#attachSectorMeshes(sector);
                    this.#visibleSectors.add(sector);
                    this.#attachVisibleSectorWallMeshes(sector);
                }
            });
        } else {
            for (let x = cameraCellMinX; x <= cameraCellMaxX; x++) {
                for (let y = cameraCellMinY; y <= cameraCellMaxY; y++) {
                    const sectors = this.#spatialIndexSector.get(x + y * gridSize);
                    if (sectors !== undefined) {
                        sectors.forEach(sector => {
                            if (this.#dirtySectors.has(sector)) {
                                // Rebuild dirty sector (remove or rebuild)
                                if (sectorsToBuild.size < maxSectorBuilds) {
                                    sectorsToBuild.add(sector);
                                }
                            } else if (!this.#visibleSectors.has(sector)) {
                                // Make a hidden sector visible
                                this.#attachSectorMeshes(sector);
                                this.#visibleSectors.add(sector);
                                this.#attachVisibleSectorWallMeshes(sector);
                            }
                        });
                    }
                }
            }
        }

        sectorsToBuild.forEach(sector => {
            // Remove sector meshes
            this.#removeSectorMeshes(sector);

            // If the sector still exists, rebuild it
            if (this.#sectors.has(sector)) {
                this.#buildSector(sector);

                // Also make it visible
                this.#attachSectorMeshes(sector);
                this.#visibleSectors.add(sector);
                this.#attachVisibleSectorWallMeshes(sector);
            } else {
                this.#removeFromSpatialIndexSector(sector);
            }

            // Mark sector as not dirty (rebuilt or removed)
            this.#dirtySectors.delete(sector);
        });

        // Hide visible sectors not seen
        const sectorsToHide = Map3D.#tmpSet2;
        sectorsToHide.clear();

        this.#visibleSectors.forEach(sector => {
            const bounds = sector.bounds;

            if (bounds.max.x < cameraMinX ||
                bounds.min.x > cameraMaxX ||
                bounds.max.y < cameraMinY ||
                bounds.min.y > cameraMaxY) {
                sectorsToHide.add(sector);
            }
        });

        sectorsToHide.forEach(sector => {
            this.#detachSectorMeshes(sector);
            this.#detachSectorWallMeshes(sector);
            this.#visibleSectors.delete(sector);
        });

        // Find things in camera range
        const thingsInRange = Map3D.#tmpSet0;
        thingsInRange.clear();

        for (let x = cameraCellMinX; x <= cameraCellMaxX; x++) {
            for (let y = cameraCellMinY; y <= cameraCellMaxY; y++) {
                const things = this.#spatialIndexThing.get(x + y * gridSize);
                if (things !== undefined) {
                    things.forEach(thing => {
                        thingsInRange.add(thing);
                    });
                }
            }
        }

        // Find visible things not in camera range
        const thingsToHide = Map3D.#tmpSet1;
        thingsToHide.clear();

        this.#visibleThings.forEach(thing => {
            if (!thingsInRange.has(thing)) {
                thingsToHide.add(thing);
            }
        });

        // Hide visible things
        thingsToHide.forEach(thing => {
            this.#visibleThings.delete(thing);
            this.#detachThingMesh(thing);
        });

        // Show hidden things
        thingsInRange.forEach(thing => {
            if (!this.#visibleThings.has(thing)) {
                this.#attachThingMesh(thing);
                this.#visibleThings.add(thing);
            }
        });

        // Create multiplayer sprites
        this.#client.users.forEach(user => {
            if (user === this.#client.ownUser) {
                return;
            }

            if (user.sprite === null) {
                const texture = ImageManager.getThreeTexture('player.png');
                user.sprite = this.#createThingMesh(user.player, texture);
                this.#container.add(user.sprite);
            }

            user.sprite.visible = user.connected;
            user.sprite.position.set(user.player.x, user.player.z - 45, -user.player.y);

            this.#rotateSpriteMesh(cameraPosition, user.sprite, user.player.angle);
        });

        // Turn visible things towards the camera
        this.#visibleThings.forEach(thing => {
            const mesh = this.#thingMeshes.get(thing);

            this.#rotateSpriteMesh(cameraPosition, mesh, thing.properties.getValue('angle'));
        });
    }

    /**
     * Rotates a billboard sprite toward the camera and chooses its directional frame.
     *
     * @param {THREE.Vector3} cameraPosition - Camera world position.
     * @param {THREE.Mesh} mesh - Sprite mesh to rotate.
     * @param {number} angle - Sprite's map-facing angle in degrees.
     */
    #rotateSpriteMesh(cameraPosition, mesh, angle) {
        const metersPerUnit = Map3D.METERS_PER_UNIT;

        const dx = cameraPosition.x - mesh.position.x;
        const dz = cameraPosition.z - mesh.position.z;

        const angleToCamera = (Math.atan2(dx, dz) * 180 / Math.PI + 360 - 90) % 360;
        const relativeAngle = ((angleToCamera - angle + 180) % 360) - 180;

        mesh.material.uniforms.uFrameIndex.value = Math.floor((relativeAngle + 22.5) / 45) & 7;
        mesh.rotation.y = Math.atan2(dx, dz);
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////
    // Internals
    //////////////////////////////////////////////////////////////////////////////////////////////////////////

    /**
     * Marks a sector and its related parent or child sectors for reconstruction.
     *
     * @param {Sector} sector - Sector.
     * @param {boolean} [skipChildren=false] - Whether to avoid marking child sectors.
     * @param {boolean} [skipParent=false] - Whether to avoid marking the parent sector.
     */
    #markDirty(sector, skipChildren = false, skipParent = false) {
        this.#dirtySectors.add(sector);

        if (sector.parent !== null && !skipParent) {
            this.#markDirty(sector.parent, true, false);
        }

        if (!skipChildren) {
            sector.children.forEach(child => {
                this.#markDirty(child, false, true);
            });
        }
    }

    /**
     * Detaches a sector's floor and ceiling meshes from the scene and picker.
     *
     * @param {Sector} sector - Sector.
     */
    #detachSectorMeshes(sector) {
        const meshes = this.#sectorMeshes.get(sector);
        if (meshes === undefined) {
            return;
        }

        meshes.forEach(mesh => {
            this.#container.remove(mesh);

            const i = this.#pickableMeshes.indexOf(mesh);
            if (i === -1) {
                throw new Error('Attempted to detach non-existent mesh');
            }

            this.#pickableMeshes.splice(i, 1);
        });
    }

    /**
     * Attaches a sector's floor and ceiling meshes to the scene and picker.
     *
     * @param {Sector} sector - Sector.
     */
    #attachSectorMeshes(sector) {
        const meshes = this.#sectorMeshes.get(sector);
        if (meshes === undefined) {
            return;
        }

        meshes.forEach(mesh => {
            this.#container.add(mesh);

            if (this.#pickableMeshes.includes(mesh)) {
                throw new Error('Attempted to attach mesh twice');
            }

            this.#pickableMeshes.push(mesh);
        });
    }

    /**
     * Removes a sector's claim on its line-wall meshes.
     *
     * @param {Sector} sector - Sector.
     * @param {boolean} [forceDetach=false] - Whether to detach walls regardless of remaining users.
     */
    #detachSectorWallMeshes(sector, forceDetach = false) {
        sector.lines.forEach(line => {
            if (!this.#wallVisible.has(line)) {
                return;
            }

            const walls = this.#wallMeshes.get(line);
            if (walls === undefined) {
                return;
            }

            const sectors = this.#wallPickerSectors.get(line);
            if (sectors === undefined) {
                return;
            }

            sectors.delete(sector);

            if (sectors.size === 0) {
                this.#wallPickerSectors.delete(line);
            }

            if (sectors.size === 0 || forceDetach) {
                walls.forEach(mesh => {
                    this.#container.remove(mesh);
                    const i = this.#pickableMeshes.indexOf(mesh);
                    if (i === -1) {
                        throw new Error('Attempted to detach non-existent mesh');
                    }
                    this.#pickableMeshes.splice(i, 1);
                });

                this.#wallVisible.delete(line);
            }
        });
    }

    /**
     * Attaches wall meshes required by a sector's current visibility state.
     *
     * @param {Sector} sector - Sector.
     */
    #attachVisibleSectorWallMeshes(sector) {
        const visible = this.#visibleSectors.has(sector);

        sector.lines.forEach(line => {
            const walls = this.#wallMeshes.get(line);
            if (walls === undefined) {
                return;
            }

            const sectors = this.#wallPickerSectors.get(line);

            if (sectors === undefined && !visible) {
                return;
            }

            if (sectors === undefined) {
                this.#wallPickerSectors.set(line, new Set([sector]));
            } else if (visible) {
                sectors.add(sector);
            }

            if (this.#wallVisible.has(line)) {
                return;
            }

            walls.forEach(mesh => {
                this.#container.add(mesh);
                if (this.#pickableMeshes.includes(mesh)) {
                    throw new Error('Attempted to attach mesh twice');
                }
                this.#pickableMeshes.push(mesh);
            });

            this.#wallVisible.set(line, true);
        });
    }

    /**
     * Detaches a thing mesh from the scene and picker.
     *
     * @param {Thing} thing - Thing.
     */
    #detachThingMesh(thing) {
        const mesh = this.#thingMeshes.get(thing);
        if (mesh !== undefined) {
            this.#container.remove(mesh);

            const i = this.#pickableMeshes.indexOf(mesh);
            if (i === -1) {
                throw new Error('Attempted to detach non-existent mesh');
            }

            this.#pickableMeshes.splice(i, 1);
        }
    }

    /**
     * Attaches a thing mesh to the scene and picker.
     *
     * @param {Thing} thing - Thing.
     */
    #attachThingMesh(thing) {
        const mesh = this.#thingMeshes.get(thing);
        if (mesh !== undefined) {
            this.#container.add(mesh);

            if (this.#pickableMeshes.includes(mesh)) {
                throw new Error('Attempted to attach mesh twice');
            }

            this.#pickableMeshes.push(mesh);
        }
    }

    /**
     * Rebuilds the floor, ceiling, and line-wall meshes for a sector.
     *
     * @param {Sector} sector - Sector.
     */
    #buildSector(sector) {
        const meshes = [];

        if (!sector.isVoid &&
            sector.properties.getValue('floor_height') < sector.properties.getValue('ceiling_height')) {
            const floorMesh = this.#createFlatMesh(sector, true);
            if (floorMesh !== null) {
                meshes.push(floorMesh);
            }

            const ceilingMesh = this.#createFlatMesh(sector, false);
            if (ceilingMesh !== null) {
                meshes.push(ceilingMesh);
            }
        }

        this.#sectorMeshes.set(sector, meshes);

        sector.lines.forEach(line => {
            if (!this.#wallMeshes.has(line)) {
                this.#wallMeshes.set(line, this.#createWallsForLine(line));
            }
        });

        this.#attachVisibleSectorWallMeshes(sector);
    }

    /**
     * Adds a sector to every spatial-index cell overlapped by its bounds.
     *
     * @param {Sector} sector - Sector.
     */
    #addToSpatialIndexSector(sector) {
        const cellSize = Map3D.#SPATIAL_INDEX_CELL_SIZE;
        const gridSize = Map3D.#SPATIAL_INDEX_SIZE;
        const gridOffset = Math.floor(gridSize / 2);

        const bounds = sector.bounds;

        const minCellX = Math.max(0, Math.floor(bounds.min.x / cellSize) + gridOffset);
        const maxCellX = Math.min(gridSize - 1, Math.floor(bounds.max.x / cellSize) + gridOffset);
        const minCellY = Math.max(0, Math.floor(bounds.min.y / cellSize) + gridOffset);
        const maxCellY = Math.min(gridSize - 1, Math.floor(bounds.max.y / cellSize) + gridOffset);

        for (let x = minCellX; x <= maxCellX; x++) {
            for (let y = minCellY; y <= maxCellY; y++) {
                const index = x + y * gridSize;
                let sectors = this.#spatialIndexSector.get(index);
                if (sectors === undefined) {
                    sectors = [];
                    this.#spatialIndexSector.set(index, sectors)
                }
                sectors.push(sector);
            }
        }
    }

    /**
     * Removes a sector from every spatial-index cell overlapped by its bounds.
     *
     * @param {Sector} sector - Sector.
     */
    #removeFromSpatialIndexSector(sector) {
        const cellSize = Map3D.#SPATIAL_INDEX_CELL_SIZE;
        const gridSize = Map3D.#SPATIAL_INDEX_SIZE;
        const gridOffset = Math.floor(gridSize / 2);

        const bounds = sector.bounds;

        const minCellX = Math.max(0, Math.floor(bounds.min.x / cellSize) + gridOffset);
        const maxCellX = Math.min(gridSize - 1, Math.floor(bounds.max.x / cellSize) + gridOffset);
        const minCellY = Math.max(0, Math.floor(bounds.min.y / cellSize) + gridOffset);
        const maxCellY = Math.min(gridSize - 1, Math.floor(bounds.max.y / cellSize) + gridOffset);

        for (let x = minCellX; x <= maxCellX; x++) {
            for (let y = minCellY; y <= maxCellY; y++) {
                const index = x + y * gridSize;
                const sectors = this.#spatialIndexSector.get(index);
                const i = sectors.indexOf(sector);
                if (i !== -1) {
                    sectors.splice(i, 1);
                }
            }
        }
    }

    /**
     * Detaches, disposes, and unregisters all meshes associated with a sector.
     *
     * @param {Sector} sector - Sector.
     */
    #removeSectorMeshes(sector) {
        const meshes = this.#sectorMeshes.get(sector);
        if (meshes === undefined) {
            return;
        }

        if (this.#visibleSectors.has(sector)) {
            this.#detachSectorMeshes(sector);
            this.#visibleSectors.delete(sector);
        }
        this.#detachSectorWallMeshes(sector, true);

        meshes.forEach(mesh => {
            this.#selectedMeshes.delete(mesh);
            this.#hoveredMeshes.delete(mesh);
            this.#disposeMesh(mesh);
        });
        this.#sectorMeshes.delete(sector);

        sector.lines.forEach(line => {
            const walls = this.#wallMeshes.get(line);
            if (walls !== undefined) {
                walls.forEach(mesh => {
                    this.#selectedMeshes.delete(mesh);
                    this.#hoveredMeshes.delete(mesh);
                    this.#disposeMesh(mesh);
                });
                this.#wallMeshes.delete(line);
            }
        });
    }

    /**
     * Creates a floor or ceiling mesh for a sector.
     *
     * @param {Sector} sector - Sector.
     * @param {boolean} isFloor - Whether to create the floor rather than the ceiling.
     * @returns {?THREE.Mesh} The generated mesh, or `null` for invalid geometry.
     */
    #createFlatMesh(sector, isFloor) {
        if (sector.flatXY.length < 6) {
            return null;
        }

        const shape = new THREE.Shape();
        const coordinates = sector.flatXY;

        shape.moveTo(coordinates[0], coordinates[1]);
        for (let i = 2; i < coordinates.length; i += 2) {
            shape.lineTo(coordinates[i], coordinates[i + 1]);
        }

        sector.mergedChildLoops.forEach(loop => {
            if (loop.length < 6) {
                return;
            }
            const path = new THREE.Path();
            path.moveTo(loop[0], loop[1]);
            for (let i = 2; i < loop.length; i += 2) {
                path.lineTo(loop[i], loop[i + 1]);
            }
            shape.holes.push(path);
        });

        const geometry = new THREE.ShapeGeometry(shape);

        const height = isFloor ? sector.properties.getValue('floor_height') :
            sector.properties.getValue('ceiling_height');

        geometry.rotateX(-Math.PI / 2);
        if (!isFloor) {
            for (let i = 0; i < geometry.index.array.length; i += 3) {
                const temp = geometry.index.array[i];
                geometry.index.array[i] = geometry.index.array[i + 2];
                geometry.index.array[i + 2] = temp;
            }
        }
        geometry.translate(0, height * Map3D.VERTICAL_SCALE, 0);

        const textureName = isFloor ? sector.properties.getValue('floor_texture') :
            sector.properties.getValue('ceiling_texture');

        const isSky = textureName === this.#doomMap.metadata.getValue('sky_texture');

        const texture = isSky ?
            this.#getSkyTexture(isFloor ? 0 : 2) :
            this.getTextureByName('flat', textureName, isFloor ? 0 : 2);

        const position = geometry.attributes.position;
        const uvs = new Float32Array(position.count * 2);

        const textureWidth = texture.image.width;
        const textureHeight = texture.image.height;

        for (let i = 0; i < position.count; i++) {
            uvs[i * 2 + 0] = position.getX(i) / textureWidth;
            uvs[i * 2 + 1] = position.getZ(i) / textureHeight;
        }

        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

        const mesh = new THREE.Mesh(geometry, this.#createMaterial(texture, isSky));

        const lightLevel = sector.properties.getValue('light_level');
        mesh.material.uniforms.uColormapIndex.value = Math.min((255 - lightLevel) >> 3, 31);

        const selected = this.#doomMap.isSelected(
            sector,
            null,
            null,
            !isFloor ? true : null,
            null,
            isFloor ? true : null
        );

        mesh.material.uniforms.uSelected.value = +selected;

        if (selected) {
            this.#selectedMeshes.add(mesh);
        }

        mesh.matrixAutoUpdate = false;

        mesh.userData = {
            type: 'sector',
            line: null,
            side: null,
            section: isFloor ? 'floor' : 'ceiling',
            sector,
        };

        return mesh;
    }

    /**
     * Creates all visible wall-section meshes for a line.
     *
     * @param {Line} line - Line.
     * @returns {Array<THREE.Mesh>} Generated wall meshes.
     */
    #createWallsForLine(line) {
        const result = [];

        const frontProperties = line.frontProperties;
        const backProperties = line.backProperties;
        const frontSector = line.frontSector;
        const backSector = line.backSector;

        if ((frontSector === null || frontSector.isVoid) &&
            (backSector === null || backSector.isVoid)) {
            return result;
        }

        for (const isFront of [false, true]) {
            const sideProperties = isFront ? frontProperties : backProperties;
            const sector = isFront ? frontSector : backSector;
            const otherSector = !isFront ? frontSector : backSector;
            const isOuterFacing = otherSector === null || otherSector.isVoid;

            if (sector === null || sector.isVoid || !isOuterFacing) {
                continue;
            }

            const bottom = sector.properties.getValue('floor_height');
            const top = sector.properties.getValue('ceiling_height');

            if (bottom < top) {
                const texture = this.getTextureByName('texture',
                    sideProperties.getValue('texture_middle'), 1);

                const xOffset = sideProperties.getValue('x_offset');
                const yOffset = -sideProperties.getValue('y_offset') +
                    (texture.image.height - (top - bottom)) * !line.properties.getValue('lower_unpegged');

                result.push(this.#createWallMesh(
                    line,
                    isFront,
                    'middle',
                    bottom,
                    top,
                    xOffset,
                    yOffset,
                    texture,
                    false
                ));
            }
        }

        if (frontSector === null || frontSector.isVoid ||
            backSector === null || backSector.isVoid ||
            result.length > 0) {
            return result;
        }

        const skyTexture = this.#doomMap.metadata.getValue('sky_texture');

        const frontFloor = frontSector.properties.getValue('floor_height');
        const frontCeiling = frontSector.properties.getValue('ceiling_height');
        const backFloor = backSector.properties.getValue('floor_height');
        const backCeiling = backSector.properties.getValue('ceiling_height');

        if (frontFloor !== backFloor) {
            const lowerBottom = Math.min(frontFloor, backFloor);
            const lowerTop = Math.max(frontFloor, backFloor);
            const upperTop = Math.max(frontCeiling, backCeiling);

            if (lowerBottom < lowerTop) {
                const isFront = frontFloor < backFloor;
                const lowerSideProperties = isFront ? frontProperties : backProperties;

                const frontFloorTexture = frontSector.properties.getValue('floor_texture') ?? '';
                const backFloorTexture = backSector.properties.getValue('floor_texture') ?? '';
                const isSky = skyTexture !== '' &&
                    frontFloorTexture === skyTexture &&
                    backFloorTexture === skyTexture;

                const texture = isSky ? this.#getSkyTexture(1) :
                    this.getTextureByName('texture', lowerSideProperties.getValue('texture_lower'), 1);

                const xOffset = lowerSideProperties.getValue('x_offset');
                const yOffset = -lowerSideProperties.getValue('y_offset') +
                    (line.properties.getValue('lower_unpegged') ? texture.image.height -
                    (upperTop - lowerBottom) : texture.image.height - (lowerTop - lowerBottom));

                result.push(this.#createWallMesh(
                    line,
                    isFront,
                    'lower',
                    lowerBottom,
                    lowerTop,
                    xOffset,
                    yOffset,
                    texture,
                    isSky
                ));
            }
        }

        const middleBottom = Math.max(frontFloor, backFloor);
        const middleTop = Math.min(frontCeiling, backCeiling);

        if (middleBottom < middleTop) {
            for (let isFront = 0; isFront < 2; isFront++) {
                const middleSideProperties = isFront ? frontProperties : backProperties;

                const middleTexture = middleSideProperties.getValue('texture_middle');
                if (middleTexture !== '' && middleTexture !== '-') {
                    const texture = this.getTextureByName('texture',
                        middleSideProperties.getValue('texture_middle'), 1);

                    const height = Math.min(middleTop - middleBottom, texture.image.height);
                    const clampedBottom = line.properties.getValue('lower_unpegged') ?
                        middleBottom : middleTop - height;
                    const clampedTop = !line.properties.getValue('lower_unpegged') ?
                        middleTop : clampedBottom + height;

                    const xOffset = middleSideProperties.getValue('x_offset');
                    const yOffset = -middleSideProperties.getValue('y_offset') + (texture.image.height -
                        (clampedTop - clampedBottom)) * !line.properties.getValue('lower_unpegged');

                    result.push(this.#createWallMesh(
                        line,
                        isFront,
                        'middle',
                        clampedBottom,
                        clampedTop,
                        xOffset,
                        yOffset,
                        texture,
                        false
                    ));
                }
            }
        }

        const upperBottom = Math.min(frontCeiling, backCeiling);
        const upperTop = Math.max(frontCeiling, backCeiling);

        if (upperBottom < upperTop) {
            const isFront = frontCeiling > backCeiling;
            const upperSideProperties = isFront ? frontProperties : backProperties;

            const frontCeilingTexture = frontSector.properties.getValue('ceiling_texture') ?? '';
            const backCeilingTexture = backSector.properties.getValue('ceiling_texture') ?? '';
            const isSky = skyTexture !== '' &&
                frontCeilingTexture === skyTexture &&
                backCeilingTexture === skyTexture;

            const texture = isSky ?
                this.#getSkyTexture(1) :
                this.getTextureByName('texture', upperSideProperties.getValue('texture_upper'), 1);

            const xOffset = upperSideProperties.getValue('x_offset');
            const yOffset = -upperSideProperties.getValue('y_offset') + (texture.image.height -
                (upperTop - upperBottom)) * line.properties.getValue('upper_unpegged');

            const mesh = this.#createWallMesh(
                line,
                isFront,
                'upper',
                upperBottom,
                upperTop,
                xOffset,
                yOffset,
                texture,
                isSky
            );

            result.push(mesh);
        }

        return result;
    }

    /**
     * Creates one textured wall-section mesh.
     *
     * @param {Line} line - Line represented by the wall.
     * @param {boolean} isFront - Whether the wall belongs to the line's front side.
     * @param {string} section - Wall section: `upper`, `middle`, or `lower`.
     * @param {number} bottom - Bottom height in map units.
     * @param {number} top - Top height in map units.
     * @param {number} xOffset - Horizontal texture offset.
     * @param {number} yOffset - Vertical texture offset.
     * @param {THREE.Texture} texture - Texture applied to the wall.
     * @param {boolean} isSky - Whether the material renders as sky.
     * @returns {THREE.Mesh} Generated wall mesh.
     */
    #createWallMesh(line, isFront, section, bottom, top, xOffset, yOffset, texture, isSky) {
        const geometry = new THREE.BufferGeometry();

        const v0 = isFront ? line.v0 : line.v1;
        const v1 = isFront ? line.v1 : line.v0;

        const positions = new Float32Array([
            v0.x, bottom * Map3D.VERTICAL_SCALE, -v0.y,
            v1.x, bottom * Map3D.VERTICAL_SCALE, -v1.y,
            v1.x, top * Map3D.VERTICAL_SCALE, -v1.y,
            v0.x, top * Map3D.VERTICAL_SCALE, -v0.y,
        ]);

        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setIndex([0, 1, 2, 0, 2, 3]);

        const textureWidth = texture.image.width;
        const textureHeight = texture.image.height;

        const deltaX = line.v1.x - line.v0.x;
        const deltaY = line.v1.y - line.v0.y;
        const wallLength = Math.hypot(deltaX, deltaY);

        const uStart = xOffset / textureWidth;
        const uEnd = (xOffset + wallLength) / textureWidth;
        const vStart = yOffset / textureHeight;
        const vEnd = (yOffset + (top - bottom)) / textureHeight;

        const uvs = new Float32Array([
            uStart, vStart,
            uEnd, vStart,
            uEnd, vEnd,
            uStart, vEnd,
        ]);
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

        const mesh = new THREE.Mesh(geometry, this.#createMaterial(texture, isSky));

        const sectorProperties = isFront ? line.frontSectorProperties : line.backSectorProperties;
        const lightLevel = sectorProperties.getValue('light_level');
        mesh.material.uniforms.uColormapIndex.value = Math.min((255 - lightLevel) >> 3, 31);

        const selected = this.#doomMap.isSelected(
            line,
            isFront ? true : null,
            !isFront ? true : null,
            section === 'upper' ? true : null,
            section === 'middle' ? true : null,
            section === 'lower' ? true : null
        );

        mesh.material.uniforms.uSelected.value = +selected;

        if (selected) {
            this.#selectedMeshes.add(mesh);
        }

        mesh.matrixAutoUpdate = false;

        mesh.userData = {
            type: 'line',
            line,
            isFront,
            section,
            sector: null,
        };

        return mesh;
    }

    /**
     * Creates a billboard sprite mesh for a thing or multiplayer player.
     *
     * @param {Thing|object} thing - Thing-like object containing position data.
     * @param {?THREE.Texture} [overrideTexture=null] - Optional texture override.
     * @returns {THREE.Mesh} Generated sprite mesh.
     */
    #createThingMesh(thing, overrideTexture = null) {
        const texture = overrideTexture ?? this.getThingTexture(thing.properties.getValue('type'));
        const geometry = new THREE.PlaneGeometry(texture.image.width, texture.image.height);
        geometry.translate(0, texture.image.height / 2, 0);
        const material = this.#createMaterial(texture);

        const mesh = new THREE.Mesh(geometry, material);

        const sector = this.#doomMap.getSector(thing.x, thing.y);

        const lightLevel = sector?.properties.getValue('light_level') ?? 12;
        mesh.material.uniforms.uColormapIndex.value = Math.min((255 - lightLevel) >> 3, 31);

        const positionX = thing.x;
        const positionY = ((sector?.properties.getValue('floor_height') ?? 0) +
            (thing.z ?? thing.properties.getValue('z'))) * Map3D.VERTICAL_SCALE;
        const positionZ = -thing.y;

        mesh.position.set(positionX, positionY, positionZ);
        mesh.scale.x = 1 / (texture.userData.frameCount ?? 1);
        mesh.scale.y = Map3D.VERTICAL_SCALE;

        const selected = this.#doomMap.isSelected(thing);

        mesh.material.uniforms.uSelected.value = +selected;

        if (selected) {
            this.#selectedMeshes.add(mesh);
        }

        mesh.userData = {
            type: 'thing',
            thing,
        };

        return mesh;
    }

    /**
     * Detaches a mesh and disposes its geometry.
     *
     * Materials and shared textures are retained for reuse.
     *
     * @param {THREE.Mesh} mesh - Mesh.
     */
    #disposeMesh(mesh) {
        if (mesh.parent !== null) {
            this.#container.remove(mesh);
        }

        if (mesh.geometry !== undefined) {
            mesh.geometry.dispose();
        }

        if (mesh.material !== undefined) {
            mesh.material.dispose();
        }
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////
    // Materials and textures
    //////////////////////////////////////////////////////////////////////////////////////////////////////////

    /**
     * Creates a generated placeholder texture.
     *
     * @param {Object} [options={}] - Preview-image generation options.
     * @returns {THREE.CanvasTexture} Generated placeholder texture.
     */
    static #createMissingTexture(options = {}) {
        const canvas = Utility.createPreviewImage(options);

        const texture = new THREE.CanvasTexture(canvas);
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;

        texture.userData.frameCount = 1;

        return texture;
    }

    /**
     * Creates and optionally caches a texture from decoded image data.
     *
     * @param {ImageData|object} imageData - Pixel data with width and height.
     * @param {string} type - Texture category used in the cache key.
     * @param {?string} name - Texture name, or `null` to avoid caching.
     * @param {number} [frameCount=1] - Number of horizontal animation or direction frames.
     */
    addTexture(imageData, type, name, frameCount = 1) {
        const texture = new THREE.DataTexture(imageData, imageData.width, imageData.height);

        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;

        texture.flipY = true;

        texture.needsUpdate = true;

        texture.userData.frameCount = frameCount;

        if (name !== null) {
            this.#textureCache.set(`${type}:${String(name).toUpperCase()}`, texture);
        }
    }

    /**
     * Disposes and removes all cached textures.
     */
    clearTextureCache() {
        this.#textureCache.forEach(texture => {
            texture.dispose();
        });
        this.#textureCache.clear();
    }

    /**
     * Marks all sectors dirty and rebuilds all thing meshes after resource changes.
     */
    refreshTextures() {
        this.#sectors.forEach(sector => {
            this.#dirtySectors.add(sector);
        });

        Array.from(this.#thingMeshes.keys()).forEach(thing => {
            this.removeThing(thing);
            this.addThing(thing);
        });
    }

    /**
     * Looks up a cached texture by category and name.
     *
     * @param {string} type - Texture category.
     * @param {*} name - Texture name.
     * @param {number} [axis=0] - Missing-texture variant used as fallback.
     * @returns {THREE.Texture} Cached texture or placeholder texture.
     */
    getTextureByName(type, name, axis = 0) {
        return this.#textureCache.get(`${type}:${String(name).toUpperCase()}`) ?? this.#missingTexture[axis];
    }

    /**
     * Returns a texture for a thing type.
     *
     * Creates and caches a labeled placeholder when no sprite texture exists.
     *
     * @param {number} typeId - Doom thing type identifier.
     * @returns {THREE.Texture} Thing texture or generated placeholder.
     */
    getThingTexture(typeId) {
        const textureName = `thing:${typeId}`;
        let texture = this.#textureCache.get(textureName);
        if (texture !== undefined) {
            return texture;
        }

        const definition = this.#resourceManager.thingDefinitions.find(definition => definition.id === typeId);
        texture = Map3D.#createMissingTexture({
            backgroundColor0: '#ff00ff',
            backgroundColor1: '#cc00cc',
            size: 64,
            borderWidth: 2,
            labelLines: [`#${typeId}`, definition === undefined ? '' : definition.name.substring(0, 6)],
        });
        this.#textureCache.set(textureName, texture);
        return texture;
    }

    /**
     * Returns the current map sky texture.
     *
     * @param {number} [axis=2] - Missing-texture variant used as fallback.
     * @returns {THREE.Texture} Sky texture.
     */
    #getSkyTexture(axis = 2) {
        const skyTexture = this.#doomMap.metadata.getValue('sky_texture');
        return this.getTextureByName('texture', skyTexture.replace(/^F_/i, ''), axis);
    }

    /**
     * Creates a Doom material for a texture.
     *
     * @param {THREE.Texture} texture - Base texture.
     * @param {boolean} [isSky=false] - Whether the material renders as sky.
     * @returns {DoomMaterial} Generated Doom material.
     */
    #createMaterial(texture, isSky = false) {
        return new DoomMaterial({
            texture,
            frameCount: texture.userData.frameCount ?? 1,
            palettes: this.#resourceManager.palettes,
            colormaps: this.#resourceManager.colormaps,
            isSky,
        });
    }
}
