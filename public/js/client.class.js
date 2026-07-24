import LineProperties from './properties/lineproperties.class.js';
import MapMetadata from './properties/mapmetadata.class.js';
import SectorProperties from './properties/sectorproperties.class.js';
import SideProperties from './properties/sideproperties.class.js';
import ThingProperties from './properties/thingproperties.class.js';

import { io } from './lib/socket.io.esm.min.js';

/**
 * Multiplayer client and local transaction-history.
 */
export default class Client extends EventTarget {
    /** @type {string} Network protocol version expected from the server. */
    static #VERSION = '0';

    /** @type {number} Maximum permitted chat-message length. */
    static #MAX_MESSAGE_LENGTH = 256;
    /** @type {number} Delay before retrying a failed map request, in seconds. */
    static #REQUEST_MAP_RETRY_SECONDS = 10;

    /** @type {?DoomMap} Edited map. */
    #map = null;

    /** @type {boolean} */
    #offlineMode = true;
    /** @type {boolean} Whether the client is operating without a server connection. */
    get offlineMode() {
        return this.#offlineMode;
    }

    /** @type {?Socket} Socket.IO connection to the server. */
    #socket = null;

    /** @type {Array<Object>} */
    #users = [];
    /** @type {Array<Object>} Users currently present in the room. */
    get users() {
        return this.#users;
    }
    /** @type {?number} Index assigned to the local user. */
    #userIndex = null;
    /** @type {?object} */
    #ownUser = null;
    /** @type {?object} Local user. */
    get ownUser() {
        return this.#ownUser;
    }

    /** @type {?Date} Time at which the most recent map request was sent. */
    #mapRequestAt = null;

    /** @type {?number} Index of the most recently applied network transaction. */
    #lastTransactionIndex = null;
    /** @type {Set<string>} Locally submitted transactions awaiting validation. */
    #unvalidatedTransactionIds = new Set();
    /** @type {Set<string>} Submitted transactions that must not enter local history. */
    #skipHistoryTransactionIds = new Set();

    /** @type {Array<DoomMap.Transaction>} Local undo and redo transaction history. */
    #history = [];
    /** @type {number} Index of the most recently applied local history entry. */
    #historyIndex = -1;
    /** @type {number} Barrier index used to prevent unrelated history entries from merging. */
    #historyBarrierIndex = 0;

    /** @type {?HTMLElement} Undo button. */
    #buttonUndo = null;
    /** @type {?HTMLElement} Redo button. */
    #buttonRedo = null;

    /**
     * Creates a client for a Doom map. Configures offline mode or establishes a Socket.IO connection.
     *
     * @param {DoomMap} map - Edited map.
     */
    constructor(map) {
        super();

        this.#map = map;

        this.#buttonUndo = document.querySelector('.editor-button__undo');
        this.#buttonRedo = document.querySelector('.editor-button__redo');

        this.#updateUndoVisibility();

        const connectionStatus = document.querySelector('.editor__connection');

        const params = new URLSearchParams(window.location.search);

        this.#offlineMode = !params.has('online');

        const username = this.#offlineMode ? 'Me' :
            params.get('username') ?? prompt('What is your username?', 'Noname');
        let roomName = params.get('room') ?? 'test room';
        let roomToken = params.get('token') ?? null;

        let userId = localStorage.getItem('userId') ?? null;

        if (this.#offlineMode) {
            this.#userIndex = 0;
            this.#updateUsers([{
                color: '#4995C6',
                index: 0,
                isAdmin: true,
                username: 'Me',
            }]);

            connectionStatus.textContent = 'Offline mode';

            document.querySelector('.editor__chat').style.visibility = 'hidden';
            document.querySelector('.tab-button__users').style.visibility = 'hidden';

            return;
        }

        const serverUrl = params.get('server') ?? window.location.origin;

        this.#socket = io(serverUrl, { transports: ['websocket'], reconnection: true });

        this.#socket.on('connect', () => {
            console.log('[client] Connected to server');

            connectionStatus.textContent = 'Connecting to room...';
            connectionStatus.classList.remove('editor__connection--error');
            connectionStatus.classList.add('editor__connection--ok');

            this.#socket.emit('join', {
                username,
                roomName,
                roomToken,
                userId,
            });
        });

        this.#socket.on('disconnect', (reason) => {
            console.warn('[client] Disconnected from server:', reason);

            connectionStatus.textContent = 'Disconnected from server';
            connectionStatus.classList.remove('editor__connection--ok');
            connectionStatus.classList.add('editor__connection--error');
        });

        this.#socket.io.on('reconnect', attempt => {
            console.warn(`[client] Reconnected (attempt ${attempt})`);

            connectionStatus.textContent = 'Reconnected – joining room...';
            connectionStatus.classList.remove('editor__connection--error');
            connectionStatus.classList.add('editor__connection--ok');

            this.#lastTransactionIndex = null;

            this.#socket.emit('join', {
                username,
                roomName,
                roomToken,
                userId,
            });
        });

        this.#socket.on('welcome', data => {
            if (data.version !== Client.#VERSION) {
                console.log(`[client] Server version mismatch`);
                alert('Client and server versions are incompatible. Please refresh page.');
                this.#socket.disconnect();
                return;
            }

            roomName = data.roomName;

            connectionStatus.textContent = `Online in "${roomName}"`;
            connectionStatus.classList.remove('editor__connection--error');
            connectionStatus.classList.add('editor__connection--ok');

            this.#userIndex = data.userIndex;

            this.#updateUsers(data.users);

            userId = data.userId;
            localStorage.setItem('userId', userId);

            roomToken = data.roomToken;
            const url = new URL(window.location.href);
            url.searchParams.set('token', roomToken);
            window.history.replaceState({}, '', url);

            console.log(`[client] Welcome ${Client.#userToString(this.#ownUser)} to Room<${roomName}:${this.#users.length}>`);

            if (!this.#ownUser.isAdmin) {
                this.#socket.emit('request_map');

                this.#mapRequestAt = new Date();
            }
        });

        this.#socket.on('kicked', ({ reason, type }) => {
            console.warn(`[client] [${type}] You left the room due to: ${reason}`);

            alert(`You were kicked: ${reason}`);

            this.#socket.disconnect();
        });

        this.#socket.on('request_map_response', ({ to }) => {
            const transactionId = crypto.randomUUID();

            const user = this.#users.find(u => u.socketId === to);
            console.log(`[client] Serialized map T<?:${transactionId.slice(0, 4)}:deserialize:1> for ${Client.#userToString(user)}`);

            this.#socket.emit('transaction', {
                operations: [{
                    op: 'deserialize',
                    args: [this.#map.serialize()],
                }],
                transactionId,
                senderIndex: this.#ownUser.index,
                to,
            });
        });

        this.#socket.on('validate', ({ operations, transactionId, senderIndex, to }) => {
            const user = this.#users.find(user => user.index === senderIndex);
            if (user === undefined) {
                this.#socket.emit('transaction', { operations: [], transactionId, to });
                return;
            }

            const valid = this.#validateTransaction(operations, user);

            const firstOp = String(operations?.[0]?.op ?? 'invalid');
            const opCount = operations?.length ?? 0;

            console.log(`[client] Validated T<?:${String(transactionId).slice(0, 4)}:${firstOp}:${opCount}> from ${Client.#userToString(user)} (valid=${valid})`);

            if (!valid) {
                this.#socket.emit('transaction', { operations: [], transactionId, to });
                return;
            }

            this.#socket.emit('transaction', { operations, transactionId, senderIndex });

            console.log(`[client] Applying validated T<?:${String(transactionId).slice(0, 4)}:${firstOp}:${opCount}>`);

            this.#applyTransaction(transactionId, operations, user);
        });

        this.#socket.on('transaction', data => {
            const { operations, transactionId, transactionIndex, senderIndex } = data;

            const user = this.#users.find(user => user.index === senderIndex);

            const firstOp = String(operations?.[0]?.op ?? 'nop');
            const opCount = operations?.length ?? 0;
            const isNoOp = firstOp === 'nop';

            const isOwn = this.#unvalidatedTransactionIds.has(transactionId);
            const skipHistory = this.#skipHistoryTransactionIds.has(transactionId);
            if (isOwn) {
                this.#unvalidatedTransactionIds.delete(transactionId);
                this.#skipHistoryTransactionIds.delete(transactionId);

                console.log(`[client] Got own validated T<${transactionIndex}:${String(transactionId).slice(0, 4)}:${firstOp}:${opCount}> (valid = ${!isNoOp})`);

                if (isNoOp) {
                    this.requestMap();
                    this.#mapRequestAt = new Date();
                }
            } else {
                console.log(`[client] Got T<${transactionIndex}:${String(transactionId).slice(0, 4)}:${firstOp}:${opCount}> from ${Client.#userToString(user)}`);
            }

            if (this.#lastTransactionIndex === null && firstOp !== 'deserialize') {
                console.warn(`[client] Ignoring transaction (waiting for deserialize)`);

                const now = new Date();
                if (this.#mapRequestAt !== null &&
                    (now - this.#mapRequestAt) > Client.#REQUEST_MAP_RETRY_SECONDS * 1000) {
                    this.#socket.emit('request_map');
                    this.#mapRequestAt = now;
                }

                return;
            }

            if (this.#lastTransactionIndex !== null && transactionIndex !== this.#lastTransactionIndex + 1) {
                console.warn(`[client] Out-of-sequence T<${transactionIndex}...>, expected T<${this.#lastTransactionIndex + 1}...>`);

                this.#lastTransactionIndex = null;

                this.#socket.emit('request_map');
                this.#mapRequestAt = new Date();

                return;
            }

            console.log(`[client] Applying network T<${transactionIndex}:${String(transactionId).slice(0, 4)}:${firstOp}:${opCount}>`);

            if (!isNoOp) {
                this.#applyTransaction(transactionId, operations, user, skipHistory);
            }

            this.#lastTransactionIndex = transactionIndex;
        });

        this.#socket.on('users', ({ users }) => {
            this.#updateUsers(users);

            this.dispatchEvent(new CustomEvent('users', {
                detail: { users, ownUser: this.#ownUser },
                bubbles: false,
            }));
        });

        this.#socket.on('update_player', ({ userIndex, cx, cy, x, y, z, angle }) => {
            const user = this.#users.find(user => user.index === userIndex);
            if (user !== undefined && user !== this.#ownUser) {
                user.cursor.x = cx;
                user.cursor.y = cy;
                user.player.x = x;
                user.player.y = y;
                user.player.z = z;
                user.player.angle = angle;
            }
        });

        this.#socket.on('chat', ({ message, senderUsername, isAdmin, color, time }) => {
            const date = new Date(time);
            const timestamp = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

            console.log(
                `%c[${timestamp}] <${senderUsername}${isAdmin ? ' (admin)' : ''}> ${message}`,
                `color: ${color}`
            );

            this.dispatchEvent(new CustomEvent('chat', {
                detail: { senderUsername, message, color, isAdmin, time },
                bubbles: false,
            }));
        });
    }

    /**
     * Replaces the room user list.
     *
     * @param {Array<Object>} newUsers - Updated room user list.
     */
    #updateUsers(newUsers) {
        const oldUsers = this.#users;

        this.#users = newUsers;
        this.#users.forEach(user => {
            const oldUser = oldUsers.find(u => u.index === user.index);
            user.cursor = oldUser?.cursor ?? { x: 0, y: 0 };
            user.player = oldUser?.player ?? { x: 0, y: 0, z: 0, angle: 0 };
            user.sprite = oldUser?.sprite ?? null;
        });

        this.#ownUser = this.#users.find(user => user.index === this.#userIndex) ?? null;
    }

    /**
     * Submits a map transaction for local application or server validation.
     *
     * Administrators apply transactions immediately before broadcasting them.
     * Other users forward transactions to the server for administrator validation.
     *
     * @param {Array<Object>} operations - Map operations.
     * @param {boolean} [skipHistory=false] - Whether to omit the transaction from local history.
     * @returns {?string} The transaction ID, or `null` when applied entirely offline.
     */
    sendTransaction(operations, skipHistory = false) {
        if (this.#ownUser === null) {
            console.warn('[Client] Can not send transactions before joining room');
            return;
        }

        if (!this.#ownUser.isAdmin && this.#lastTransactionIndex === null) {
            console.warn('[Client] Can not send transactions before loading map');
            return;
        }

        const firstOp = String(operations?.[0]?.op ?? 'invalid');
        const opCount = operations?.length ?? 0;
        const transactionId = crypto.randomUUID();

        if (!this.#offlineMode && !this.#ownUser?.isAdmin) {
            this.#unvalidatedTransactionIds.add(transactionId);
            if (skipHistory) {
                this.#skipHistoryTransactionIds.add(transactionId);
            }
        }

        if (this.#ownUser.isAdmin) {
            console.log(`[client] Applying own T<?:${String(transactionId).slice(0, 4)}:${firstOp}:${opCount}>`);

            this.#applyTransaction(transactionId, operations, this.#ownUser, skipHistory);

            if (!this.#offlineMode) {
                console.log(`[client] Broadcasting T<?:${String(transactionId).slice(0, 4)}:${firstOp}:${opCount}>`);
            }
        } else {
            console.log(`[client] Forwarding T<?:${String(transactionId).slice(0, 4)}:${firstOp}:${opCount}> for validation`);
        }

        if (!this.#offlineMode) {
            this.#socket.emit('transaction', { operations, transactionId, senderIndex: this.#ownUser.index });

            return transactionId;
        }

        return this.#ownUser.isAdmin ? null : transactionId;
    }

    /**
     * Applies a transaction to the map and records local undo history.
     *
     * @param {string} transactionId - Unique transaction identifier.
     * @param {Array<Object>} operations - Map operations to apply.
     * @param {Object} user - User responsible for the transaction.
     * @param {boolean} [skipHistory=false] - Whether to omit the transaction from local history.
     */
    #applyTransaction(transactionId, operations, user, skipHistory = false) {
        if (operations.length === 0) {
            console.warn('Transaction lacks operations');
            return;
        }

        const createTransaction =
            user === this.#ownUser &&
            operations[0].op !== 'deserialize' &&
            !skipHistory;

        if (createTransaction) {
            this.#map.beginTransaction();
        }

        operations.forEach(operation => {
            const op = operation.op;
            const args = operation.args;

            switch (op) {
                case 'addVertex':
                    this.#map.addVertex(...args);
                    break;
                case 'removeVertex':
                    this.#map.removeVertex(...args);
                    break;
                case 'addLine':
                    this.#map.addLine(...args);
                    break;
                case 'removeLine':
                    this.#map.removeLine(...args);
                    break;
                case 'splitLine':
                    this.#map.splitLine(...args);
                    break;
                case 'flipLine':
                    this.#map.flipLine(...args);
                    break;
                case 'addThing':
                    this.#map.addThing(...args);
                    break;
                case 'removeThing':
                    this.#map.removeThing(...args);
                    break;
                case 'setSideProperty':
                    this.#map.setSideProperty(...args);
                    break;
                case 'setLineProperty':
                    this.#map.setLineProperty(...args);
                    break;
                case 'setThingProperty':
                    this.#map.setThingProperty(...args);
                    break;
                case 'setLineSectorPropertyBySide':
                    this.#map.setLineSectorPropertyBySide(...args);
                    break;
                case 'setSectorPropertyBySide':
                    this.#map.setSectorPropertyBySide(...args);
                    break;
                case 'setMapProperty':
                    this.#map.setMapProperty(...args);
                    break;
                case 'deserialize':
                    this.#map.deserialize(...args);

                    this.#unvalidatedTransactionIds.clear();
                    this.#skipHistoryTransactionIds.clear();

                    this.#history.length = 0;
                    this.#historyIndex = -1;

                    this.#mapRequestAt = null;
                    break;
                default:
                    console.error(`[client] Unknown op "${op}"`);
                    return;
            }
        });

        this.#map.rebuildSectors();

        this.#map.clearLineLineages();

        if (createTransaction) {
            const transaction = this.#map.endTransaction();
            this.#pushHistoryTransaction(transaction);

            this.#updateUndoVisibility();
        }

        this.dispatchEvent(new CustomEvent('transactionapplied', {
            detail: { transactionId },
        }));
    }

    /**
     * Creates a boundary that prevents subsequent operations from merging with the previous history entry.
     */
    createUndoBarrier() {
        this.#historyBarrierIndex = (this.#historyBarrierIndex + 1) % Number.MAX_SAFE_INTEGER;
    }

    /**
     * Adds a map transaction to local undo history.
     * Compatible consecutive property-edit transactions on the same targets are merged.
     *
     * @param {DoomMap.Transaction} transaction - Transaction to add to history.
     */
    #pushHistoryTransaction(transaction) {
        transaction.barrierIndex = this.#historyBarrierIndex;

        if (this.#historyIndex < this.#history.length - 1) {
            this.#history.splice(this.#historyIndex + 1);
        }

        const previous = this.#history[this.#history.length - 1];

        const getOperationIdentity = op => {
            const a = op.args;

            switch (op.op) {
                case 'setLineProperty':
                    return `${op.op}:${a[0]},${a[1]}:${a[2]},${a[3]}:${a[4]}`;

                case 'setSideProperty':
                    return `${op.op}:${a[0]},${a[1]}:${a[2]},${a[3]}:${a[4]}:${a[5]}:`;

                case 'setLineSectorPropertyBySide':
                case 'setSectorPropertyBySide':
                    return `${op.op}:${a[0]},${a[1]}:${a[2]},${a[3]}:${a[4]}:${a[5]}`;

                case 'setThingProperty':
                    return `${op.op}:${a[0]},${a[1]},${a[2]},${a[3]},${a[4]}:${a[5]}`;

                case 'setMapProperty':
                    return `${op.op}:${a[0]}`;

                default:
                    return null;
            }
        };

        const getKey = t => {
            const identities = [];

            for (const op of t.applyOperations) {
                const identity = getOperationIdentity(op);
                if (identity === null) {
                    return null;
                }

                identities.push(identity);
            }

            return `${t.barrierIndex}:${identities.join('|')}`;
        };

        const previousKey = previous === undefined ? null : getKey(previous);
        const newKey = getKey(transaction);

        if (previousKey !== null && previousKey === newKey) {
            previous.applyOperations = transaction.applyOperations;
            return;
        }

        this.#history.push(transaction);
        this.#historyIndex = this.#history.length - 1;
    }

    /**
     * Tests whether a coordinate pair contains integers within the permitted range.
     *
     * @param {number} x - Value to validate as a x-coordinate.
     * @param {number} y - Value to validate as a y-coordinate.
     * @param {number} [min=-32768] - Minimum permitted coordinate.
     * @param {number} [max=32767] - Maximum permitted coordinate.
     * @returns {boolean} Whether both coordinates are valid.
     */
    static #validateCoordinate(x, y, min = -32768, max = 32767) {
        return Number.isInteger(x) && Number.isInteger(y) &&
            x >= min && x <= max && y >= min && y <= max;
    };

    /**
     * Validates a transaction submitted by another user.
     *
     * @param {Array<Object>} operations - Transaction operations to validate.
     * @param {Object} user - User who submitted the transaction.
     * @returns {boolean} Whether every operation in the transaction is valid.
     */
    #validateTransaction(operations, user) {
        if (!Array.isArray(operations) || operations.length === 0) {
            return false;
        }

        if (!user.allowEditing) {
            return false;
        }

        const port = this.#map.metadata.getValue('port');

        return operations.every(operation => {
            const op = operation.op;
            const args = operation.args;

            if (!Array.isArray(args) || args.length === 0) {
                return false;
            }

            switch (op) {
                case 'addVertex':
                case 'removeVertex': {
                    const [x, y] = args;
                    return Client.#validateCoordinate(x, y);
                }
                case 'addLine': {
                    const [x0, y0, x1, y1] = args;
                    return Client.#validateCoordinate(x0, y0) &&
                        Client.#validateCoordinate(x1, y1);
                }
                case 'removeLine': {
                    const [x0, y0, x1, y1] = args;
                    return Client.#validateCoordinate(x0, y0) &&
                        Client.#validateCoordinate(x1, y1);
                }
                case 'splitLine': {
                    const [x0, y0, x1, y1, splitX, splitY] = args;
                    return Client.#validateCoordinate(x0, y0) &&
                        Client.#validateCoordinate(x1, y1) &&
                        Client.#validateCoordinate(splitX, splitY);
                }
                case 'flipLine': {
                    const [x0, y0, x1, y1] = args;
                    return Client.#validateCoordinate(x0, y0) &&
                        Client.#validateCoordinate(x1, y1);
                }
                case 'addThing': {
                    const [x, y, z, typeId, angle] = args;
                    return Client.#validateCoordinate(x, y) &&
                        ThingProperties.validate('z', z, port) &&
                        ThingProperties.validate('type', typeId, port) &&
                        ThingProperties.validate('angle', angle, port);
                }
                case 'removeThing': {
                    const [x, y, z, typeId, angle] = args;
                    const thing = this.#map.getThing(x, y, z, typeId, angle);
                    return thing !== undefined;
                }
                case 'setSideProperty': {
                    const [x0, y0, x1, y1, isFront, property, value, recordNoOp] = args;
                    return Client.#validateCoordinate(x0, y0) &&
                        Client.#validateCoordinate(x1, y1) &&
                        typeof isFront === 'boolean' &&
                        typeof recordNoOp === 'boolean' &&
                        SideProperties.validate(property, value, port);
                }
                case 'setLineProperty': {
                    const [x0, y0, x1, y1, property, value] = args;
                    return Client.#validateCoordinate(x0, y0) &&
                        Client.#validateCoordinate(x1, y1) &&
                        LineProperties.validate(property, value, port);
                }
                case 'setLineSectorPropertyBySide':
                case 'setSectorPropertyBySide': {
                    const [x0, y0, x1, y1, isFront, property, value] = args;
                    return Client.#validateCoordinate(x0, y0) &&
                        Client.#validateCoordinate(x1, y1) &&
                        typeof isFront === 'boolean' &&
                        SectorProperties.validate(property, value, port);
                }
                case 'setThingProperty': {
                    const [x, y, z, typeId, angle, property, value] = args;
                    return this.#map.getThing(x, y, z, typeId, angle) !== undefined &&
                        Client.#validateCoordinate(x, y) &&
                        ThingProperties.validate(property, value, port);
                }
                case 'setMapProperty': {
                    const [property, value] = args;
                    if (property === 'port') {
                        return false;
                    }
                    return MapMetadata.validate(property, value, port);
                }
                default:
                    console.warn(`[validate] Unknown op "${op}"`);
                    return false;
            }
        });
    }

    /**
     * Calculates the map-coordinate bounds affected by a set of operations.
     *
     * @param {Array<Object>} operations - Map operations.
     * @returns {?{minX: number, minY: number, maxX: number, maxY: number}} - Affected bounds, or `null`.
     */
    static #getOperationBounds(operations) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        const expand = (x, y) => {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        };

        operations.forEach(op => {
            const a = op.args;

            switch (op.op) {
                case 'addVertex':
                case 'removeVertex':
                    expand(a[0], a[1]);
                    break;

                case 'addLine':
                case 'removeLine':
                    expand(a[0], a[1]);
                    expand(a[2], a[3]);
                    break;

                case 'splitLine':
                    expand(a[0], a[1]);
                    expand(a[2], a[3]);
                    expand(a[4], a[5]);
                    break;

                case 'flipLine':
                    expand(a[0], a[1]);
                    expand(a[2], a[3]);
                    break;

                case 'addThing':
                case 'removeThing':
                    expand(a[0], a[1]);
                    break;

                case 'setSideProperty':
                case 'setLineProperty':
                case 'setLineSectorPropertyBySide':
                case 'setSectorPropertyBySide':
                    expand(a[0], a[1]);
                    expand(a[2], a[3]);
                    break;

                case 'setThingProperty':
                    expand(a[0], a[1]);
                    break;

                case 'deserialize':
                    return null;
            }
        });

        if (minX === Infinity) {
            return null;
        }

        return { minX, minY, maxX, maxY };
    }

    /**
     * Sends a public or direct chat message.
     *
     * @param {string} message - Message to send.
     * @param {?string} [socketId=null] - Optional recipient socket ID for a direct message.
     */
    chat(message, socketId = null) {
        if (this.#offlineMode) {
            return;
        }

        if (typeof message !== 'string' || message.trim().length === 0 ||
            message.length > Client.#MAX_MESSAGE_LENGTH) {
            console.warn('[client] Invalid chat message');
            return;
        }

        this.#socket.emit('chat', { to: socketId, message });
    }

    /**
     * Applies the undo operations from the current history entry.
     *
     * @returns {?{minX: number, minY: number, maxX: number, maxY: number}} Bounds of the changed geometry.
     */
    undo() {
        if (this.#historyIndex < 0) {
            console.warn('[client] Nothing to undo');
            return null;
        }

        console.log(`[client] Undoing transaction ${this.#historyIndex}`);
        const operations = this.#history[this.#historyIndex].undoOperations;
        this.sendTransaction(operations, true);
        this.#historyIndex--;

        this.#updateUndoVisibility();

        // Return bounding box of changed geometry
        return Client.#getOperationBounds(operations);
    }

    /**
     * Reapplies the next transaction in local history.
     *
     * @returns {?{minX: number, minY: number, maxX: number, maxY: number}} Bounds of the changed geometry.
     */
    redo() {
        if (this.#historyIndex + 1 >= this.#history.length) {
            console.warn('[client] Nothing to redo');
            return null;
        }

        this.#historyIndex++;
        console.log(`[client] Redoing transaction ${this.#historyIndex}`);
        const operations = this.#history[this.#historyIndex].applyOperations;
        this.sendTransaction(operations, true);

        this.#updateUndoVisibility();

        // Return bounding box of changed geometry
        return Client.#getOperationBounds(operations);
    }

    /**
     * Updates the visibility of the undo and redo buttons.
     */
    #updateUndoVisibility() {
        this.#buttonUndo.style.visibility = this.#historyIndex >= 0 ? 'visible' : 'hidden';
        this.#buttonRedo.style.visibility =
            this.#historyIndex < this.#history.length - 1 ? 'visible' : 'hidden';
    }

    /**
     * Updates the local user's cursor and player state and broadcasts it.
     *
     * A `null` or `undefined` value preserves the previous value.
     *
     * @param {?number} cx - Cursor x-coordinate in map units.
     * @param {?number} cy - Cursor y-coordinate in map units.
     * @param {?number} x - Player x-coordinate in map units.
     * @param {?number} y - Player y-coordinate in map units.
     * @param {?number} z - Player z-coordinate in map units.
     * @param {?number} angle - Player angle in degrees.
     */
    sendPlayerInfo(cx, cy, x, y, z, angle) {
        const user = this.#ownUser;
        if (user === null) {
            return;
        }

        user.cursor.x = cx ?? user.cursor.x;
        user.cursor.y = cy ?? user.cursor.y;
        user.player.x = x ?? user.player.x;
        user.player.y = y ?? user.player.y;
        user.player.z = z ?? user.player.z;
        user.player.angle = angle ?? user.player.angle;

        if (!this.#offlineMode) {
            this.#socket.emit('update_player', {
                cx: Math.round(user.cursor.x),
                cy: Math.round(user.cursor.y),
                x: Math.round(user.player.x),
                y: Math.round(user.player.y),
                z: Math.round(user.player.z),
                angle: Math.round(user.player.angle),
            });
        }
    }

    /**
     * Changes whether a room user may submit map edits.
     *
     * @param {number} userIndex - Index of the user to update.
     * @param {boolean} allowEditing - Whether the user may edit the map.
     */
    setAllowEditing(userIndex, allowEditing) {
        if (!this.#offlineMode) {
            this.#socket.emit('set_allow_editing', { userIndex, allowEditing });
        }
    }

    /**
     * Removes a user from the room.
     *
     * @param {number} userIndex - Index of the user to remove.
     */
    kickUser(userIndex) {
        if (!this.#offlineMode) {
            this.#socket.emit('kick', { userIndex });
        }
    }

    /**
     * Bans a user from the room.
     *
     * @param {number} userIndex - Index of the user to ban.
     */
    banUser(userIndex) {
        if (!this.#offlineMode) {
            this.#socket.emit('ban', { userIndex });
        }
    }

    /**
     * Requests a serialized copy of the current room map.
     */
    requestMap() {
        if (!this.#offlineMode) {
            this.#socket.emit('request_map');
        }
    }

    /**
     * Broadcasts the complete serialized map as a deserialize transaction.
     */
    sendMap() {
        if (this.#offlineMode) {
            return;
        }

        const transactionId = crypto.randomUUID();

        console.log(`[client] Serialized map T<?:${transactionId.slice(0, 4)}:deserialize:1>`);

        this.#socket.emit('transaction', {
            operations: [{
                op: 'deserialize',
                args: [this.#map.serialize()],
            }],
            transactionId,
            senderIndex: this.#ownUser.index,
        });
    }

    /**
     * Formats a room user for logging.
     *
     * @param {?object} user - User to format.
     * @returns {string} User description.
     */
    static #userToString(user) {
        return !user ? 'User<?>' :
            `${user.isAdmin ? 'Admin' : 'User'}<${user.index}:${user.username}:${user.connected}:${(user.socketId ?? '?').slice(0, 4)}>`;
    }
}
