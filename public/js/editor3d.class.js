import Input from './input.class.js';
import Map3D from './map3d.class.js';

import * as THREE from './lib/three.js/three.module.js';
import { GLTFLoader } from './lib/three.js/GLTFLoader.js';

/**
 * First-person 3D editor for Doom maps.
 */
export default class Editor3D {
    /** @type {number} Camera eye height in map units. */
    static #EYE_HEIGHT = 41;
    /** @type {number} Minimum space retained between the camera and ceiling, in map units. */
    static #MIN_HEADROOM = 16;
    /** @type {number} Exponential damping factor used for camera-height smoothing. */
    static #CAMERA_HEIGHT_DAMPING = 0.00005;
    /** @type {number} First-person movement speed in map units per second. */
    static #MOVE_SPEED = 300;
    /** @type {number} Vertical fly speed in map units per secon. */
    static #VERTICAL_SPEED = 5;
    /** @type {number} Turn speed in radians per second. */
    static #TURN_SPEED = 3;
    /** @type {number} Turn speed in VR in radians per second. */
    static #VR_TURN_SPEED = 3;
    /** @type {number} Level move speed in map units per second. */
    static #VR_OVERHEAD_MOVE_SPEED = 150;
    /** @type {number} Level turn speed in radians per second. */
    static #VR_OVERHEAD_TURN_SPEED = 0.5;
    /** @type {number} Level scale speed. */
    static #VR_OVERHEAD_SCALE_SPEED = 0.03;
    /** @type {number} Stick deadzone in VR. */
    static #VR_STICK_DEAD_ZONE = 0.2;
    /** @type {number} Texture-scrolling distance applied per cursor pixel during drag. */
    static #TEXTURE_SCROLL_SPEED = 0.25;

    static #tmpV20 = { x: 0, y: 0};
    static #tmpV21 = { x: 0, y: 0};
    static #tmpV30 = new THREE.Vector3();
    static #tmpV31 = new THREE.Vector3();

    static #tmpRaycaster = new THREE.Raycaster();

    /** @type {boolean} Whether the 3D editor currently has focus. */
    #focused = true;

    /** @type {?HTMLCanvasElement} Canvas used by the WebGL renderer. */
    #canvas = null;

    /** @type {{x: number, y: number}} Last renderer size in CSS pixels. */
    #lastCanvasSize = { x: 0, y: 0 };

    /** @type {?DoomMap} Map being edited. */
    #map = null;
    /** @type {?Map3D} */
    #map3d = null;
    /** @type {?Map3D} 3D representation of the Doom map. */
    get map3d() {
        return this.#map3d;
    }
    /** @type {?Client} Multiplayer client. */
    #client = null;
     /** @type {?VectorEditor} 2D editor. */
    #vectorEditor = null;
     /** @type {?VectorEditor} */
    set vectorEditor(value) {
        this.#vectorEditor = value;
    }

    /** @type {?THREE.WebGLRenderer} */
    #renderer = null;
    /** @type {?THREE.WebGLRenderer} THREE.js renderer. */
    get renderer() {
        return this.#renderer;
    }

    /** @type {?THREE.WebGLRenderer} THREE.js scene. */
    #scene = null;

    /** @type {?THREE.Group} Scene group containing the rendered map. */
    #mapContainer = null;

    /** @type {?THREE.Group} Parent transform controlling camera position. */
    #cameraRig = null;
    /** @type {?THREE.PerspectiveCamera} First-person camera. */
    #camera = null;
    /** @type {number} Smoothed target camera height in world units. */
    #cameraTargetY = 0;
    /** @type {boolean} Whether the camera is resting on the current sector floor. */
    #grounded = false;
    /** @type {boolean} Whether right-drag flying controls are active. */
    #flying = false;

    /** @type {number} Accumulated mouse-wheel delta. */
    #mouseWheelDelta = 0;

    /** @type {?HTMLElement} Editor status element. */
    #elementStatus = null;

    /** @type {boolean} Whether the primary mouse button is held. */
    #leftHeld = false;
    /** @type {boolean} Whether the primary mouse button was released this frame. */
    #leftReleased = false;

    /** @type {boolean} Whether the middle mouse button is held. */
    #middleHeld = false;
    /** @type {{x: number, y: number}} Cursor position where the current middle drag began. */
    #middleDragFrom = { x: 0, y: 0 };
    /** @type {{x: number, y: number}} Most recently processed middle-drag cursor position. */
    #middleDragCursorPosition = { x: 0, y: 0 };

     /** @type {boolean} Whether selection dragging has left the initially hovered geometry. */
    #leftFirstHovered = false;
    /** @type {?object} Geometry first hovered during the current primary-button gesture. */
    #firstHovered = null;
    /** @type {boolean} Whether the initially hovered geometry was selected. */
    #firstHoveredSelected = false;

    /** @type {?Array<object>} VR controllers. */
    #vrControllers = null;
    /** @type {boolean} VR in overhead mode. */
    #vrOverheadMode = false;
    /** @type {THREE.Vector3} Level position in overhead mode. */
    #vrLevelPosition = new THREE.Vector3();
    /** @type {THREE.Euler} Level rotation in overhead mode. */
    #vrLevelRotation = new THREE.Euler();
    /** @type {THREE.Vector3} Level scale in overhead mode. */
    #vrLevelScale = new THREE.Vector3(0.002, 0.002, 0.002);

    /**
     * @param {HTMLCanvasElement} canvas - Canvas element.
     * @param {ResourceManager} resourceManager - Resource manager.
     * @param {DoomMap} map - Map being edited.
     * @param {Client} client - Multiplayer client.
     */
    constructor(canvas, resourceManager, map, client) {
        this.#canvas = canvas;
        this.#map = map;
        this.#client = client;

        this.#canvas.addEventListener('mousedown', e => {
            switch (e.button) {
                case 0:
                    this.#leftHeld = true;
                    this.#firstHovered = null;
                    break;

                case 1:
                    this.#middleHeld = true;
                    Input.getCursorPosition(this.#middleDragFrom);
                    Input.getCursorPosition(this.#middleDragCursorPosition);
                    break;

                case 2:
                    this.#flying = true;
                    break;
            }
        });

        document.addEventListener('mouseup', e => {
            switch (e.button) {
                case 0:
                    this.#leftHeld = false;
                    this.#leftReleased = true;
                    break;

                case 1:
                    this.#middleHeld = false;
                    break;

                case 2:
                    this.#flying = false;
                    break;
            }
        });

        this.#canvas.addEventListener('wheel', e => {
            this.#mouseWheelDelta += e.deltaY;
        });

        this.#renderer = new THREE.WebGLRenderer({
            canvas,
            powerPreference: 'high-performance',
        });

        this.#renderer.xr.enabled = true;
        this.#renderer.setPixelRatio(window.devicePixelRatio);
        this.#renderer.outputEncoding = THREE.sRGBEncoding;

        this.#scene = new THREE.Scene();

        const metersPerUnit = Map3D.METERS_PER_UNIT;

        this.#mapContainer = new THREE.Group();
        this.#mapContainer.scale.set(metersPerUnit, metersPerUnit, metersPerUnit);
        this.#scene.add(this.#mapContainer);

        const ambientLight = new THREE.AmbientLight(0xaaaaaa);
        this.#scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff);
        directionalLight.position.set(0, 1, 0);
        this.#scene.add(directionalLight);

        this.#camera = new THREE.PerspectiveCamera(90, 1, 0.05, 500);
        this.#cameraRig = new THREE.Group();
        this.#cameraRig.add(this.#camera);
        this.#scene.add(this.#cameraRig);

        this.#map3d = new Map3D(resourceManager, map, client, this.#mapContainer);

        this.#elementStatus = document.querySelector('.editor__status');

        this.#bindMapEvents();

        if ('xr' in navigator) {
            this.#setupVR();
        }
    }

    #setupVR() {
        const vrButton = document.querySelector('.editor-button__vr');
        const xrButton = document.querySelector('.editor-button__xr');

        let currentSession = null;

        const handleSessionStarted = async session => {
            this.#vrControllers.forEach(controller => {
                controller.userData.grip.visible = true;
            });

            session.addEventListener('end', handleSessionEnded);

            await this.#renderer.xr.setSession(session);
            currentSession = session;

            this.#flying = false;
            this.#grounded = true;

            session.addEventListener('visibilitychange', () => {
                if (session.visibilityState === 'hidden') {
                    session.end();
                }
            });
        }

        const handleSessionEnded = () => {
            this.#vrControllers.forEach(controller => {
                controller.userData.grip.visible = false;
            });

            const metersPerUnit = Map3D.METERS_PER_UNIT;

            this.#mapContainer.position.set(0, 0, 0);
            this.#mapContainer.rotation.set(0, 0, 0);
            this.#mapContainer.scale.set(metersPerUnit, metersPerUnit, metersPerUnit);

            this.#camera.rotation.set(0, 0, 0);

            this.#vrOverheadMode = false;

            currentSession.removeEventListener('end', handleSessionEnded);
            currentSession = null;
        }

        const startVR = mode => {
            if (currentSession == null) {
                navigator.xr.requestSession(mode, {
                    optionalFeatures: ['local-floor', 'bounded-floor'],
                }).then(handleSessionStarted);
            } else {
                currentSession.end();
            }
        };

        vrButton.addEventListener('click', () => {
            startVR('immersive-vr');
        });

        xrButton.addEventListener('click', () => {
            startVR('immersive-ar');
        });

        const checkSupport = async () => {
            if (await navigator.xr.isSessionSupported('immersive-vr')) {
                vrButton.style.visibility = 'visible';
            }
            if (await navigator.xr.isSessionSupported('immersive-ar')) {
                xrButton.style.visibility = 'visible';
            }
        }

        checkSupport();

        this.#vrControllers = [0, 1].map(i => {
            const controller = this.#renderer.xr.getController(i);

            controller.userData.connected = false;
            controller.userData.gamepad = null;
            controller.userData.gripHeld = false;
            controller.userData.selectHeld = false;
            controller.userData.selectHeldLast = false;
            controller.userData.inputSource = null;

            controller.addEventListener('connected', event => {
                controller.userData.connected = true;
                controller.userData.gamepad = event.data.gamepad;
                controller.userData.inputSource = event.data;
            });

            controller.addEventListener('disconnected', () => {
                controller.userData.connected = false;
            });

            controller.addEventListener('selectstart', () => {
                controller.userData.selectHeld = true;
            });

            controller.addEventListener('selectend', () => {
                controller.userData.selectHeld = false;
            });

            controller.addEventListener('squeezestart', () => {
                controller.userData.gripHeld = true;
            });

            controller.addEventListener('squeezeend', () => {
                controller.userData.gripHeld = false;
            });

            controller.userData.grip = this.#renderer.xr.getControllerGrip(i);
            controller.userData.grip.visible = false;

            this.#cameraRig.add(controller);
            this.#cameraRig.add(controller.userData.grip);

            return controller;
        });

        const gltfLoader = new GLTFLoader();

        gltfLoader.load('models/hand.glb', gltf => {
            this.#vrControllers.forEach(controller => {
                const hand = gltf.scene.clone();
                hand.rotation.y = Math.PI;
                controller.userData.grip.add(hand);
            });
        });
    }

    /**
     * Moves the editor canvas between the full-screen and inset containers.
     *
     * @param {boolean} focused - Whether the 3D editor should have focus.
     */
    setFocused(focused) {
        this.#focused = focused;
        if (focused) {
            document.querySelector('.editor__fullscreen').appendChild(this.#canvas);
        } else {
            document.querySelector('.editor__inset').appendChild(this.#canvas);
        }
    }

    /**
     * Checks whether the pointer is currently over the 3D editor.
     *
     * @returns {boolean} Whether the editor is hovered.
     */
    isHovered() {
        return this.#canvas.matches(':hover');
    }

    /**
     * Resizes the renderer and camera projection to match the canvas container.
     */
    #updateCanvasSize() {
        const container = this.#canvas.parentElement;
        const rect = container.getBoundingClientRect();

        const width = Math.round(rect.right) - Math.round(rect.left);
        const height = Math.round(rect.bottom) - Math.round(rect.top);

        if (width === this.#lastCanvasSize.x && height === this.#lastCanvasSize.y) {
            return;
        }

        this.#lastCanvasSize.x = width;
        this.#lastCanvasSize.y = height;

        this.#renderer.setSize(width, height);

        this.#camera.aspect = width / height;
        this.#camera.updateProjectionMatrix();
    }

    /**
     * Binds Doom map mutation events to the corresponding 3D view updates.
     */
    #bindMapEvents() {
        const map = this.#map;
        const map3d = this.#map3d;

        map.addEventListener('select', e => {
            map3d.updateSelection(e.detail.selection);
            this.#client.createUndoBarrier();
        });

        map.addEventListener('sectoradded', e => {
            map3d.addSector(e.detail.sector);
        });
        map.addEventListener('sectorremoved', e => {
            map3d.removeSector(e.detail.sector);
        });
        map.addEventListener('sectorchanged', e => {
            map3d.updateSector(e.detail.sector);
            map3d.updateThings();
        });

        const updateLineSectors = line => {
            if (line.frontSector !== null) {
                map3d.updateSector(line.frontSector);
            }
            if (line.backSector !== null) {
                map3d.updateSector(line.backSector);
            }
        };

        map.addEventListener('linechanged', e => {
            updateLineSectors(e.detail.line);
        });
        map.addEventListener('sidechanged', e => {
            updateLineSectors(e.detail.line);
        });

        map.addEventListener('thingadded', e => {
            map3d.addThing(e.detail.thing);
        });
        map.addEventListener('thingremoved', e => {
            map3d.removeThing(e.detail.thing);
        });
        map.addEventListener('thingchanged', e => {
            map3d.removeThing(e.detail.thing);
            map3d.addThing(e.detail.thing);
        });
        map.addEventListener('sectorsrebuilt', () => {
            map3d.updateThings();
        });
    }

    /**
     * Positions the first-person camera using Doom map coordinates.
     *
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     * @param {?number} [rotation=null] - Camera rotation in degrees.
     * @param {boolean} [updateHeight=false] - Whether to place the camera at the sector floor eye height.
     */
    setCameraPosition(x, y, rotation = null, updateHeight = false) {
        const metersPerUnit = Map3D.METERS_PER_UNIT;

        this.#cameraRig.position.x = x * metersPerUnit;
        this.#cameraRig.position.z = -y * metersPerUnit;
        if (rotation !== null) {
            this.#cameraRig.rotation.y = -rotation * Math.PI / 180 + Math.PI * 0.5;
        }

        if (updateHeight) {
            const sector = this.#map.getSector(x, y);
            if (sector !== null) {
                this.#cameraRig.position.y = (sector.properties.getValue('floor_height') +
                    Editor3D.#EYE_HEIGHT) * metersPerUnit * Map3D.VERTICAL_SCALE;
            }
        }
    }

    /**
     * Sends the current player and cursor positions to the multiplayer client.
     *
     * @param {boolean} [skipCursor=false] - Whether to omit the vector-editor cursor position.
     */
    sendPlayerInfo(skipCursor = false) {
        const cursor = this.#vectorEditor.getCursorPosition(Editor3D.#tmpV20);
        const playerX = this.#cameraRig.position.x / Map3D.METERS_PER_UNIT;
        const playerY = -this.#cameraRig.position.z / Map3D.METERS_PER_UNIT;
        const playerZ = this.#cameraRig.position.y / Map3D.METERS_PER_UNIT;
        const playerAngle = this.#cameraRig.rotation.y / (Math.PI * 2) * 360 + 90;

        this.#client.sendPlayerInfo(
            skipCursor ? null : cursor.x,
            skipCursor ? null : cursor.y,
            playerX,
            playerY,
            playerZ,
            playerAngle
        );
    }

    /**
     * Updates first-person movement, hovering, selection, and direct map editing.
     *
     * @param {number} elapsedSeconds - Time elapsed since the previous update, in seconds.
     */
    #updateFirstPersonControls(elapsedSeconds) {
        // Skip if any input element has focus
        const inVr = this.#renderer.xr.isPresenting;

        if (!inVr && document.activeElement !== document.body) {
            return;
        }

        const metersPerUnit = Map3D.METERS_PER_UNIT;
        const verticalScale = Map3D.VERTICAL_SCALE;
        const eyeHeight = Editor3D.#EYE_HEIGHT;
        const minHeadroom = Editor3D.#MIN_HEADROOM;
        const heightDamping = Editor3D.#CAMERA_HEIGHT_DAMPING;
        const moveSpeed = Editor3D.#MOVE_SPEED;
        const turnSpeed = Editor3D.#TURN_SPEED;
        const verticalSpeed = Editor3D.#VERTICAL_SPEED;
        const vrTurnSpeed = Editor3D.#VR_TURN_SPEED;

        const camera = this.#camera;

        let leftController;
        let rightController;
        let selectReleased;
        let leftStickX;
        let leftStickY;
        let rightStickX;
        let rightStickY;

        if (inVr) {
            const vrDeadzone = Editor3D.#VR_STICK_DEAD_ZONE;

            leftController = this.#vrControllers.find(controller =>
                controller.userData.inputSource?.handedness === 'left'
            ) ?? this.#vrControllers[0];
            rightController = leftController === this.#vrControllers[0]
                ? this.#vrControllers[1]
                : this.#vrControllers[0];

            leftController.userData.grip.children[0].scale.x = -1;
            rightController.userData.grip.children[0].scale.x = 1;

            selectReleased = !leftController.userData.selectHeld && leftController.userData.selectHeldLast;

            leftStickX = leftController.userData.gamepad?.axes[2] ?? 0;
            leftStickX = Math.abs(leftStickX) < vrDeadzone ? 0 : leftStickX;
            leftStickY = leftController.userData.gamepad?.axes[3] ?? 0;
            leftStickY = Math.abs(leftStickY) < vrDeadzone ? 0 : leftStickY;
            rightStickX = rightController.userData.gamepad?.axes[2] ?? 0;
            rightStickX = Math.abs(rightStickX) < vrDeadzone ? 0 : rightStickX;
            rightStickY = rightController.userData.gamepad?.axes[3] ?? 0;
            rightStickY = Math.abs(rightStickY) < vrDeadzone ? 0 : rightStickY;

            this.#flying = rightStickY !== 0;

            this.#vrControllers.forEach(controller => {
                controller.userData.selectHeldLast = controller.userData.selectHeld;
            });
        }

        // Get cursor position within the 3D viewport
        const cursorPosition = Input.getCursorPosition(Editor3D.#tmpV20);
        const ndc = Editor3D.#tmpV21;
        ndc.x = cursorPosition.x;
        ndc.y = cursorPosition.y;
        Input.clientToCanvas(this.#canvas, ndc);
        ndc.x = ndc.x / this.#canvas.width * 2 - 1;
        ndc.y = (1 - ndc.y / this.#canvas.height) * 2 - 1;

        const shiftHeld = Input.getKey('ShiftLeft') || Input.getKey('ShiftRight');
        const sideMovement = Input.getKey('KeyA') - Input.getKey('KeyD');
        const leftMovement = inVr
            ? -leftStickX
            : sideMovement * shiftHeld - this.#flying * ndc.x;
        const forwardMovement = inVr
            ? leftStickY
            : Input.getKey('KeyS') - Input.getKey('KeyW');
        const verticalMovement = inVr
            ? -rightStickY * verticalSpeed
            : Math.sign(ndc.y) * Math.min(Math.abs(ndc.y) * 20, verticalSpeed);
        const rotation = inVr
            ? -rightStickX * vrTurnSpeed * elapsedSeconds
            : sideMovement * turnSpeed * elapsedSeconds * !shiftHeld;

        // Get the position and direction of the actual camera
        const worldPosition = camera.getWorldPosition(Editor3D.#tmpV30);
        const worldDirection = camera.getWorldDirection(Editor3D.#tmpV31).setY(1e-6).normalize();
        const yaw = -Math.atan2(worldDirection.z, worldDirection.x) - Math.PI * 0.5;
        const yawSide = yaw - Math.PI * 0.5;

        // Get the current sector and vertical boundaries
        const sector = this.#map.getSector(worldPosition.x / metersPerUnit, -worldPosition.z / metersPerUnit);
        const minSectorY = sector?.properties.getValue('floor_height') ?? -Infinity;
        const maxSectorY = sector?.properties.getValue('ceiling_height') ?? Infinity;

        const desiredEyeHeight = eyeHeight * metersPerUnit * verticalScale;
        const trackedEyeHeight = inVr ? camera.position.y : 0;
        const minY = minSectorY * metersPerUnit * verticalScale + desiredEyeHeight - trackedEyeHeight;
        const maxY = (maxSectorY - minHeadroom) * metersPerUnit * verticalScale - trackedEyeHeight;

        if (inVr && this.#vrOverheadMode) {
            const moveSpeed = Editor3D.#VR_OVERHEAD_MOVE_SPEED;
            const turnSpeed = Editor3D.#VR_OVERHEAD_TURN_SPEED;
            const scaleSpeed = Editor3D.#VR_OVERHEAD_SCALE_SPEED;
            const metersPerUnit = Map3D.METERS_PER_UNIT;

            // Move level
            this.#mapContainer.position.x += (
                Math.sin(yaw) * leftStickY +
                Math.sin(yawSide) * leftStickX
            ) * elapsedSeconds * moveSpeed * metersPerUnit;
            this.#mapContainer.position.z += (
                Math.cos(yaw) * leftStickY +
                Math.cos(yawSide) * leftStickX
            ) * elapsedSeconds * moveSpeed * metersPerUnit;
            if (leftController.userData.gripHeld || rightController.userData.gripHeld) {
                const scale = THREE.MathUtils.clamp(
                    this.#mapContainer.scale.x + scaleSpeed * metersPerUnit * elapsedSeconds * rightStickY,
                    metersPerUnit * 0.005,
                    metersPerUnit * 0.5
                );
                this.#mapContainer.scale.set(scale, scale, scale);
            } else {
                this.#mapContainer.position.y -= rightStickY * elapsedSeconds * moveSpeed * metersPerUnit *
                    verticalScale;
                this.#mapContainer.rotation.y -= rightStickX * elapsedSeconds * turnSpeed;
            }

            this.#vrLevelPosition.copy(this.#mapContainer.position);
            this.#vrLevelRotation.copy(this.#mapContainer.rotation);
            this.#vrLevelScale.copy(this.#mapContainer.scale);

            // Land player at hand position
            if (selectReleased) {
                const handMapPosition = new THREE.Vector3();
                leftController.userData.grip.getWorldPosition(handMapPosition);
                this.#mapContainer.worldToLocal(handMapPosition);

                const sector = this.#map.getSector(handMapPosition.x, -handMapPosition.z);

                this.#mapContainer.position.set(0, 0, 0);
                this.#mapContainer.rotation.set(0, 0, 0);
                this.#mapContainer.scale.set(metersPerUnit, metersPerUnit, metersPerUnit);

                this.#cameraRig.position.x = handMapPosition.x * metersPerUnit;
                this.#cameraRig.position.z = handMapPosition.z * metersPerUnit;

                if (sector !== null) {
                    this.#cameraRig.position.y =
                        sector.properties.getValue('floor_height') *
                        metersPerUnit *
                        verticalScale;

                    this.#cameraTargetY = this.#cameraRig.position.y;
                }

                this.#flying = false;
                this.#grounded = true;
                this.#vrOverheadMode = false;
            }
        } else {
            // Vertically ground the camera
            if (this.#flying) {
                this.#cameraTargetY = this.#cameraTargetY + elapsedSeconds * verticalMovement;
                if (this.#cameraTargetY > minY - 1 && this.#cameraTargetY < maxY + 1) {
                    this.#cameraTargetY = Math.max(minY, Math.min(maxY, this.#cameraTargetY));
                }
                this.#grounded = false;
            } else if (this.#grounded && sector !== null) {
                this.#cameraTargetY = Math.min(minY, maxY);
            } else {
                this.#cameraTargetY = Math.max(minY, Math.min(maxY, this.#cameraTargetY));
                if (this.#cameraTargetY === minY) {
                    this.#grounded = true;
                }
            }

            // Rotate camera
            this.#cameraRig.rotation.y += rotation;

            // Vertical movement
            const t = 1 - Math.pow(heightDamping, elapsedSeconds);
            this.#cameraRig.position.y = this.#cameraRig.position.y * (1 - t) + this.#cameraTargetY * t;

            // Horizontal movement
            if (forwardMovement !== 0 || leftMovement !== 0) {
                const speed = moveSpeed * elapsedSeconds * metersPerUnit;

                this.#cameraRig.position.x += (
                    Math.sin(yaw) * forwardMovement +
                    Math.sin(yawSide) * leftMovement
                ) * speed;
                this.#cameraRig.position.z += (
                    Math.cos(yaw) * forwardMovement +
                    Math.cos(yawSide) * leftMovement
                ) * speed;
            }

            // Update player position in the vector editor
            if (forwardMovement !== 0 || leftMovement !== 0 || rotation !== 0) {
                this.#vectorEditor.setCameraPosition(
                    worldPosition.x / metersPerUnit,
                    -worldPosition.z / metersPerUnit,
                    yaw
                );
            }

            if (inVr) {
                // Enter overhead mode
                if (selectReleased) {
                    this.#vrOverheadMode = true;

                    this.#cameraRig.position.set(0, 0, 0);

                    this.#mapContainer.position.copy(this.#vrLevelPosition);
                    this.#mapContainer.rotation.copy(this.#vrLevelRotation);
                    this.#mapContainer.scale.copy(this.#vrLevelScale);
                }

                return;
            }
        }

        // Raycast selection and hovering
        const leftReleased = this.#leftReleased;
        const mouseWheelDelta = this.#mouseWheelDelta;
        const selectLinkedPressed = Input.getKeyDown('Digit3') && this.isHovered();

        this.#leftReleased = false;
        this.#mouseWheelDelta = 0;

        // Only when inside the editor
        const isInside = ndc.x >= -1 && ndc.y >= -1 && ndc.x <= 1 && ndc.y <= 1;
        if (!isInside) {
            return;
        }

        // Clear any previous hover
        this.#map3d.clearHover();

        // Deselect
        if (!shiftHeld && (this.#leftHeld || selectLinkedPressed)) {
            this.#map.select(null, 'deselect_all');
        }

        // Scroll texture
        if (this.#middleHeld) {
            const scrollSpeed = Editor3D.#TEXTURE_SCROLL_SPEED;
            const newDragX = cursorPosition.x - this.#middleDragFrom.x;
            const newDragY = cursorPosition.y - this.#middleDragFrom.y;
            const lastDragX = this.#middleDragCursorPosition.x - this.#middleDragFrom.x;
            const lastDragY = this.#middleDragCursorPosition.y - this.#middleDragFrom.y;
            this.#middleDragCursorPosition.x = cursorPosition.x;
            this.#middleDragCursorPosition.y = cursorPosition.y;
            const scrollX = Math.round(newDragX * scrollSpeed);
            const scrollY = Math.round(newDragY * scrollSpeed);
            const lastScrollX = Math.round(lastDragX * scrollSpeed);
            const lastScrollY = Math.round(lastDragY * scrollSpeed);
            if (scrollX !== lastScrollX || scrollY !== lastScrollY) {
                const deltaX = scrollX - lastScrollX;
                const deltaY = scrollY - lastScrollY;
                const operations = this.#map.createTextureScrollingOperations(-deltaX, -deltaY);
                if (operations.length > 0) {
                    this.#client.sendTransaction(operations);
                }
            }
            return;
        }

        // Get the hovered geometry
        const raycaster = Editor3D.#tmpRaycaster;
        raycaster.setFromCamera(ndc, camera);
        const hovered = this.#map3d.getHoveredGeometry(raycaster.ray);

        if (hovered === null) {
            return;
        }

        // Update status text
        if (this.#focused) {
            if (hovered.section === 'floor' || hovered.section === 'ceiling') {
                const ceilingHeight = hovered.sector.properties.getValue('ceiling_height');
                const floorHeight = hovered.sector.properties.getValue('floor_height');
                const height = ceilingHeight - floorHeight;
                this.#elementStatus.innerText = `F: ${floorHeight} C: ${ceilingHeight}  H: ${height}`;
            } else {
                this.#elementStatus.innerText = '';
            }
        }

        // Is the select geometry and upper, middle or lower section?
        const isUpper = hovered.section === 'ceiling' || hovered.section === 'upper';
        const isMiddle = hovered.section === 'middle';
        const isLower = hovered.section === 'floor' || hovered.section === 'lower';

        // Keep track of the first selected hovered geometry for toggle select
        if (this.#firstHovered === null) {
            this.#leftFirstHovered = false;
            this.#firstHovered = hovered;

            switch (hovered.type) {
                case 'line':
                    this.#firstHoveredSelected = this.#map.isSelected(
                        hovered.line,
                        hovered.isFront ? true : null,
                        !hovered.isFront ? true : null,
                        isUpper ? true : null,
                        isMiddle ? true : null,
                        isLower ? true : null
                    );
                    break;
                case 'sector':
                    this.#firstHoveredSelected = this.#map.isSelected(
                        hovered.sector,
                        null,
                        null,
                        isUpper ? true : null,
                        null,
                        isLower ? true : null
                    );
                    break;
                case 'thing':
                    this.#firstHoveredSelected = this.#map.isSelected(hovered.thing);
                    break;
            }
        } else if (hovered !== this.#firstHovered) {
            // Was the first hovered geometry left?
            this.#leftFirstHovered = true;
        }

        // Select linked sides/sectors
        if (selectLinkedPressed) {
            switch (hovered.type) {
                case 'line':
                    this.#map.selectLinkedSides(hovered.line, hovered.isFront,
                        isUpper ? 'upper' : isMiddle ? 'middle' : 'lower');
                    break;
                case 'sector':
                    this.#map.selectLinkedSectors(hovered.sector, isLower, true, true);
                    break;
                case 'thing':
                    this.#map.select([hovered.thing], 'select');
                    break;
            }
        }

        // Add to selection or toggle select depending on if shift is held and the hovered geometry was left
        const toggleSelect = leftReleased && this.#firstHoveredSelected && !this.#leftFirstHovered;

        if (this.#leftHeld && (this.#leftFirstHovered || !this.#firstHoveredSelected) || toggleSelect) {
            switch (hovered.type) {
                case 'line':
                    this.#map.select([hovered.line], toggleSelect ? 'toggle' : 'select',
                        false, false, false,
                        hovered.isFront, !hovered.isFront,
                        isUpper, isMiddle, isLower
                    );
                    break;
                case 'sector':
                    this.#map.select([hovered.sector], toggleSelect ? 'toggle' : 'select',
                        false, true, false,
                        false, false,
                        isUpper, false, isLower
                    );
                    break;
                case 'thing':
                    this.#map.select([hovered.thing], toggleSelect ? 'toggle' : 'select');
                    break;
            }
        }

        // Scroll sector height up or down
        if (mouseWheelDelta !== 0 && (hovered.type === 'sector' || hovered.type === 'line')) {
            const delta = Math.sign(-mouseWheelDelta) * (shiftHeld ? 1 : 8)

            const sector = hovered.type === 'sector' ? hovered.sector :
                hovered.isFront ? hovered.line.backSector :
                hovered.line.frontSector ?? hovered.line.backSector;

            if (sector === null) {
                return;
            }

            const line = sector.lines[0];

            // Create the required property operation to scroll the hovered sector
            const operations = [{
                op: 'setSectorPropertyBySide',
                args: [
                    line.v0.x, line.v0.y,
                    line.v1.x, line.v1.y,
                    line.frontSector === sector,
                    isLower ? 'floor_height' : 'ceiling_height',
                    Math.max(isLower ? -32768 : sector.properties.getValue('floor_height'),
                        Math.min(isLower ? sector.properties.getValue('ceiling_height') : 32768,
                            (isLower ? sector.properties.getValue('floor_height')
                            : sector.properties.getValue('ceiling_height')) + delta
                        )
                    ),
                ],
            }];


            // Iterate and also scroll selected sectors if hovered was selected
            if (this.#map.isSelected(sector)) {
                const property = isLower ? 'floor_height' : 'ceiling_height';

                this.#map.iterateSectors(sector2 => {
                    if (sector2 !== sector && this.#map.isSelected(
                        sector2, null, null, isLower ? null : true, null, isLower ? true : null)) {
                        const line2 = sector2.lines[0];
                        operations.push({
                            op: 'setSectorPropertyBySide',
                            args: [
                                line2.v0.x, line2.v0.y,
                                line2.v1.x, line2.v1.y,
                                line2.frontSector === sector2,
                                property,
                                Math.max(isLower ? -32768 : sector2.properties.getValue('floor_height'),
                                    Math.min(isLower ? sector2.properties.getValue('ceiling_height') : 32768,
                                        (isLower ? sector2.properties.getValue('floor_height')
                                        : sector2.properties.getValue('ceiling_height')) + delta
                                    )
                                ),
                            ],
                        });
                    }
                }, null, null, true);
            }

            // Send transaction to server
            this.#client.sendTransaction(operations);
        }
    }

    /**
     * Updates editor state and renders one frame.
     *
     * @param {number} elapsedSeconds - Time elapsed since the previous update, in seconds.
     */
    update(elapsedSeconds) {
        this.#updateCanvasSize();

        this.#updateFirstPersonControls(elapsedSeconds);

        const cullingDistance = this.#renderer.xr.isPresenting && this.#vrOverheadMode ? 3000 : 200;
        this.#map3d.update(this.#cameraRig, cullingDistance);

        this.#renderer.render(this.#scene, this.#camera);
    }
}
