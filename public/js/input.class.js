/**
 * Tracks keyboard, mouse, wheel, cursor, and touch input state.
 */
export default class Input {
    /** @type {Set<string>} Keys pressed since the last state reset. */
    static #keyDown = new Set();
    /** @type {Set<string>} Keys released since the last state reset. */
    static #keyUp = new Set();
    /** @type {Set<string>} Keys held. */
    static #key = new Set();

    /** @type {Set<number>} Mouse buttons pressed since the last state reset. */
    static #mouseButtonDown = new Set();
    /** @type {Set<number>} Mouse buttons released since the last state reset. */
    static #mouseButtonUp = new Set();
    /** @type {Set<number>} Mouse buttons held. */
    static #mouseButton = new Set();
    /** @type {number} Accumulated mouse-wheel movement. */
    static #mouseWheelDelta = 0;

    /** @type {{x: number, y: number}} Latest cursor position in client coordinates. */
    static #cursorPosition = { x: 0, y: 0 };

    /** @type {Array<Touch>} Touch points from the previous touch event. */
    static #lastTouches = [];
    /** @type {number} Change in distance between the two most recent touch points. */
    static #pinchZoomDelta = 0;
    /** @type {{x: number, y: number}} Center point of the two-finger gesture in client coordinates. */
    static #pinchCenter = { x: 0, y: 0 };

    /**
     * Registers the input event listeners after the page has loaded.
     */
    static {
        window.addEventListener('load', Input.#handleLoad);
    }

    /**
     * Attaches keyboard, mouse, wheel, and touch event listeners.
     */
    static #handleLoad() {
        // Mouse/Touch interactions are only started the primary canvas
        const container = document.querySelector('canvas') ?? document.body;

        const cursorMove = (x, y) => {
            Input.#cursorPosition.x = x;
            Input.#cursorPosition.y = y;
        };

        document.addEventListener('keydown', e => {
            if (e.repeat) {
                return;
            }

            Input.#keyDown.add(e.code);
            Input.#key.add(e.code);
        });

        document.addEventListener('keyup', e => {
            if (e.repeat) {
                return;
            }

            if (Input.#key.has(e.code)) {
                Input.#keyUp.add(e.code);
                Input.#key.delete(e.code);
            }
        });

        container.addEventListener('mousedown', e => {
            Input.#mouseButtonDown.add(e.button);
            Input.#mouseButton.add(e.button);
        });

        document.addEventListener('mouseup', e => {
            if (Input.#mouseButton.has(e.button)) {
                Input.#mouseButtonUp.add(e.button);
                Input.#mouseButton.delete(e.button);
            }
        });

        document.addEventListener('mousemove', e => {
            cursorMove(e.clientX, e.clientY);
        });

        container.addEventListener('wheel', e => {
            Input.#mouseWheelDelta += e.deltaY;

            e.preventDefault();
        }, { passive: false });

        container.addEventListener('touchstart', e => {
            Input.#lastTouches = Array.from(e.touches);
        }, { passive: false });

        document.addEventListener('touchend', e => {
            Input.#lastTouches = Array.from(e.touches);
        }, { passive: false });

        document.querySelector('.editor').addEventListener('selectstart', e => {
            e.preventDefault();
        });
        
        document.addEventListener('touchcancel', e => {
            Input.#lastTouches = Array.from(e.touches);
        }, { passive: false });

        document.addEventListener('touchmove', e => {
            if (e.touches.length === 2 && Input.#lastTouches.length === 2) {
                const t1 = e.touches[0];
                const t2 = e.touches[1];
                const l1 = Input.#lastTouches[0];
                const l2 = Input.#lastTouches[1];

                const previousDistance = Math.hypot(l2.clientX - l1.clientX, l2.clientY - l1.clientY);
                const newDistance = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

                Input.#pinchZoomDelta = newDistance - previousDistance;

                Input.#pinchCenter.x = (t1.clientX + t2.clientX) / 2;
                Input.#pinchCenter.y = (t1.clientY + t2.clientY) / 2;
            }

            Input.#lastTouches = Array.from(e.touches);
        }, { passive: false });
    }

    /**
     * Get whether a key was pressed since the last state reset.
     *
     * @param {string} key - Key
     * @returns {boolean} Whether the key was newly pressed.
     */
    static getKeyDown(key) {
        return Input.#keyDown.has(key);
    }

    /**
     * Get whether a key was released since the last state reset.
     *
     * @param {string} key - Key
     * @returns {boolean} Whether the key was newly released.
     */
    static getKeyUp(key) {
        return Input.#keyUp.has(key);
    }

    /**
     * Get whether a key is held.
     *
     * @param {string} key - Key
     * @returns {boolean} Whether the key is held.
     */
    static getKey(key) {
        return Input.#key.has(key);
    }

    /**
     * Get whether a mouse button was pressed since the last state reset.
     *
     * @param {number} [button=0] - Mouse button.
     * @returns {boolean} Whether the button was newly pressed.
     */
    static getMouseButtonDown(button = 0) {
        return Input.#mouseButtonDown.has(button);
    }

    /**
     * Get whether a mouse button was released since the last state reset.
     *
     * @param {number} [button=0] - Mouse button.
     * @returns {boolean} Whether the button was newly released.
     */
    static getMouseButtonUp(button = 0) {
        return Input.#mouseButtonUp.has(button);
    }

    /**
     * Get whether a mouse button is held.
     *
     * @param {number} [button=0] - Mouse button.
     * @param {boolean} [clear=false] - Whether to clear the button.
     * @returns {boolean} Whether the button is held.
     */
    static getMouseButton(button = 0, clear = false) {
        const temp = Input.#mouseButton.has(button);
        if (clear) {
            Input.#mouseButton.delete(button);
        }
        return temp;
    }

    /**
     * Returns the accumulated vertical mouse-wheel movement.
     *
     * @param {boolean} [clear=false] - Whether to clear the delta.
     * @returns {number} Mouse-wheel movement.
     */
    static getMouseWheelDelta(clear = false) {
        const temp = Input.#mouseWheelDelta;
        if (clear) {
            Input.#mouseWheelDelta = 0;
        }
        return temp;
    }

    /**
     * Copies the current cursor position into a target object.
     *
     * @param {{x:number, y:number}} target - Target object.
     * @returns {{x:number, y:number}} Target object.
     */
    static getCursorPosition(target) {
        if (target === undefined) {
            throw new Error('No target object supplied (target = { x, y })');
        }

        target.x = Input.#cursorPosition.x;
        target.y = Input.#cursorPosition.y;
        return target;
    }

    /**
     * Converts client-space coordinates to canvas-space coordinates.
     *
     * @param {HTMLCanvasElement} canvas - Canvas.
     * @param {{x:number, y:number}} target - Target object.
     * @returns {{x:number, y:number}} Target object.
     */
    static clientToCanvas(canvas, target) {
        if (target === undefined) {
            throw new Error('No target object supplied (target = { x, y })');
        }

        const rect = canvas.getBoundingClientRect();
        target.x = (target.x - rect.left) / rect.width * canvas.width;
        target.y = (target.y - rect.top) / rect.height * canvas.height;
        return target;
    }

    /**
     * Returns the latest two-finger pinch distance change.
     *
     * @param {boolean} [clear=true] - Whether to clear the stored pinch delta.
     * @returns {number} Difference between the current and previous touch-point distances.
     */
    static getPinchZoomDelta(clear = true) {
        const delta = Input.#pinchZoomDelta;
        if (clear) {
            Input.#pinchZoomDelta = 0;
        }
        return delta;
    }

    /**
     * Copies the current pinch center position into a target object.
     *
     * @param {{x:number, y:number}} target - Target object.
     * @returns {{x:number, y:number}} Target object.
     */
    static getPinchCenter(target) {
        if (target === undefined) {
            throw new Error('No target object supplied (target = { x, y })');
        }

        target.x = Input.#pinchCenter.x;
        target.y = Input.#pinchCenter.y;
        return target;
    }

    /**
     * Applies a CSS cursor style to an element.
     *
     * The document body is used when no container is supplied.
     *
     * @param {string} style - CSS cursor property value.
     * @param {HTMLElement | null} [container=null] - Element that receives the cursor style.
     */
    static setCursorStyle(style, container = null) {
        (container ?? document.body).style.cursor = style;
    }

    /**
     * Clears transient key and mouse-button states.
     */
    static resetState() {
        Input.#mouseButtonDown.clear();
        Input.#mouseButtonUp.clear();
        Input.#keyDown.clear();
        Input.#keyUp.clear();
    }
}
