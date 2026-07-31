import crypto from 'crypto';
import express from 'express';
import http from 'http';
import os from 'os';
import path from 'path';
import { Server } from 'socket.io';

// Version of the multiplayer server protocol
const VERSION = '0.9';

// Whether the server automatically shuts down after inactivity
const ENABLE_TIMEOUT = false;
// Number of inactive seconds before closing a server that still has rooms
const IDLE_CLOSE_SECONDS = 1800;
// Number of inactive seconds before closing a server with no rooms
const IDLE_CLOSE_SECONDS_NO_ROOMS = 300;
// Maximum number of seconds allowed for a graceful shutdown before forcing exit
const FORCE_CLOSE_SECONDS = 60;

// Network port
const PORT = process.env.PORT || 8080;

// Maximum number of rooms that can exist at the same time
const MAX_ROOMS = 64;
// Maximum number of users allowed in a single room
const MAX_USERS_PER_ROOM = 256;
// Maximum number of characters allowed in room names and usernames
const MAX_NAME_LENGTH = 64;
// Maximum number of characters allowed in a chat message
const MAX_MESSAGE_LENGTH = 256;
// Number of seconds a disconnected user has to reconnect before being removed
const USER_RECONNECT_GRACE_SECONDS = 30;
// Determines whether newly connected users can edit by default
const DEFAULT_ALLOW_EDITING = true;

// Absolute path to the directory containing the client-side static files
const STATIC_PATH = path.resolve('public');

// Chat color assigned to the room administrator
const ADMIN_COLOR = '#4995C6';
// Chat color used for automated server messages
const SERVER_COLOR = '#B9181A';
// Available chat colors assigned to regular users
const CHAT_COLORS = [
    '#FAB6E6', '#FC8002', '#ADDB88', '#369F2D',
    '#FAC7B3', '#EE4431'/*, '#B9181A'*/, '#CEDFEF',
    '#92C2DD'/*, '#4995C6'*/, '#1663A9', '#BAB4D5',
    '#8481BA', '#614099'
];

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: process.env.ORIGIN ?? '*' },
    transports: ['websocket'],
    // Maximum packet size = 50 MB
    maxHttpBufferSize: 50_000_000,
});

let closeTimeout = null;
let closing = false;

const close = () => {
    if (closing) {
        return;
    }
    closing = true;

    console.log('[server] Closing due to inactivity');

    io.emit('kicked', { reason: 'Server shutting down due to inactivity.', type: 'room_closure' });

    setTimeout(() => {
        const forceCloseTimeout = setTimeout(() => {
            console.error('[server] Force closing process');
            process.exit(1);
        }, FORCE_CLOSE_SECONDS * 1000);

        forceCloseTimeout.unref();

        io.close(() => {
            clearTimeout(forceCloseTimeout);
            console.log('[server] Closed');
            process.exit(0);
        });
    }, 250);
};

const resetCloseTimeout = () => {
    if (!ENABLE_TIMEOUT) {
        return;
    }

    if (closeTimeout !== null) {
        clearTimeout(closeTimeout);
        closeTimeout = null;
    }

    if (closing) {
        return;
    }

    const seconds = rooms.size === 0
        ? IDLE_CLOSE_SECONDS_NO_ROOMS
        : IDLE_CLOSE_SECONDS;

    closeTimeout = setTimeout(() => {
        closeTimeout = null;
        close();
    }, seconds * 1000);

    closeTimeout.unref();
};

app.get('/', (req, res, next) => {
    resetCloseTimeout();
    next();
});

app.use(express.static(STATIC_PATH));

app.get('/', (req, res) => {
    res.sendFile(path.join(STATIC_PATH, 'index.html'));
});

const rooms = new Map();

io.on('connection', socket => {
    const ip = socket.handshake.address.replace(/^::ffff:/, '');
    socket.ip = crypto.createHash('sha256').update(ip).digest('hex');

    console.log(`\x1b[32m[server] New connection from User<?:${socket.id}> (IP hash=${socket.ip.slice(0, 4)})`);

    socket.user = null;

    socket.on('join', data => {
        if (socket.user !== null) {
            return;
        }

        if (typeof data !== 'object' || data === null) {
            return;
        }
        let { roomToken, roomName, username, userId } = data;

        let room = null;

        const createRoom = !rooms.has(roomToken);

        if (createRoom) {
            if (rooms.size >= MAX_ROOMS) {
              socket.emit('kicked', { reason: 'Server room limit reached.', type: 'server_full' });
              socket.disconnect(true);
              return;
            }

            if (typeof roomName !== 'string' || roomName.trim().length === 0) {
                roomName = 'New Room';
            } else {
                roomName = roomName.trim().substring(0, MAX_NAME_LENGTH);
            }

            room = {
                token: crypto.randomBytes(8).toString('hex'),
                roomName: roomName ?? 'Untitled Room',
                users: [],
                bannedIps: new Map(),
                admin: null,
                transactionIndex: 0,
                toString: () => `Room<${room.roomName}:${room.users.filter(user => user !== null).length}>`,
            };
            rooms.set(room.token, room);

            console.log(`\x1b[32m[server] ${room}: Created (token=${room.token.slice(0,4)})`);
        } else {
            room = rooms.get(roomToken);

            const bannedUsername = room.bannedIps.get(socket.ip);
            if (bannedUsername !== undefined) {
                console.warn(`\x1b[33m[server] Rejected banned IP for User<${bannedUsername}:${socket.id}> (IP hash=${socket.ip.slice(0, 4)})`);

                socket.emit('kicked', { reason: 'You have been banned from the room.', type: 'banned' });

                socket.disconnect(true);

                return;
            }

            let userCount = 0;

            room.users.forEach(user => {
                if (user !== null) {
                    userCount++;
                }
            });

            if (userCount >= MAX_USERS_PER_ROOM) {
              socket.emit('kicked', { reason: 'Room user limit reached.', type: 'server_full' });
              socket.disconnect(true);
              return;
            }
        }

        let user = room.users.find(candidate => candidate !== null && userId === candidate.id);

        if (user === undefined) {
            if (typeof username !== 'string' || username.trim().length === 0) {
                username = 'anonymous';
            } else {
                username = username.trim().substring(0, MAX_NAME_LENGTH);
            }

            const newUserId = crypto.randomBytes(32).toString('hex');

            let hash = 0;
            for (let i = 0; i < newUserId.length; i++) {
                hash = (hash * 31 + newUserId.charCodeAt(i)) >>> 0;
            }

            const color = CHAT_COLORS[hash % CHAT_COLORS.length];

            let userIndex = room.users.findIndex(candidate => candidate === null);

            if (userIndex === -1) {
                userIndex = room.users.length;
            }

            user = {
                index: userIndex,
                id: newUserId,
                room,
                socket: null,
                removalTimeout: null,
                username,
                color,
                isAdmin: false,
                allowEditing: DEFAULT_ALLOW_EDITING,
                toString: () => `${user.isAdmin ? 'Admin' : 'User'}<${user.index}:${user.username}:${(user.socket?.id ?? '?').slice(0, 4)}>`,
            };

            if (userIndex === room.users.length) {
                room.users.push(user);
            } else {
                room.users[userIndex] = user;
            }

            if (room.admin === null) {
                room.admin = user;
                user.isAdmin = true;
                user.allowEditing = true;
                user.color = ADMIN_COLOR;
            }
        }

        if (user.removalTimeout !== null) {
            clearTimeout(user.removalTimeout);
            user.removalTimeout = null;
        }

        const previousSocket = user.socket;

        socket.user = user;
        user.socket = socket;

        if (previousSocket !== null && previousSocket.connected) {
            console.log(`\x1b[32m[server] ${room}: Disconnecting old socket for ${user}`);
            previousSocket.emit('kicked', {
                reason: 'You connected from another session.',
                type: 'kick',
            });
            previousSocket.disconnect(true);
        }

        socket.join(room.token);

        if (createRoom) {
            socket.emit('chat', {
                message: `Room [${room.roomName}] was created.`,
                senderUsername: 'SERVER',
                isAdmin: false,
                color: SERVER_COLOR,
                time: Date.now(),
            });
        }

        socket.emit('welcome', {
            version: VERSION,
            userIndex: user.index,
            userId: user.id,
            users: createUserList(room),
            roomToken: room.token,
            roomName: room.roomName,
        });

        socket.to(room.token).emit('chat', {
            message: `User <${user.username}> joined the room [${room.roomName}].`,
            senderUsername: 'SERVER',
            isAdmin: false,
            color: SERVER_COLOR,
            time: Date.now(),
        });

        console.log(`\x1b[32m[server] ${room}: ${user} joined`);

        sendUsers(room);

        resetCloseTimeout();
    });

    socket.on('request_map', () => {
        const user = socket.user;
        if (!user) {
            return;
        }
        const room = user.room;

        resetCloseTimeout();

        if (room.admin.socket !== null) {
            console.log(`\x1b[36m[server] ${room}: ${user} requested map from admin`);

            room.admin.socket.emit('request_map_response', { to: socket.id, username: user.username });
        }
    });

    socket.on('chat', data => {
        if (typeof data !== 'object' || data === null) {
            return;
        }
        const { to, message } = data;

        const user = socket.user;
        if (!user) {
            return;
        }
        const room = user.room;

        if (typeof message !== 'string' || message.trim().length === 0 || message.length > MAX_MESSAGE_LENGTH) {
            console.warn(`\x1b[33m[server] ${room}: Invalid chat message from ${user}`);
            return;
        }

        resetCloseTimeout();

        const payload = {
            message,
            senderUsername: user.username,
            isAdmin: user.isAdmin,
            color: user.color,
            time: Date.now(),
        };

        if (to) {
            io.to(to).emit('chat', payload);
            socket.emit('chat', payload);
            console.log(`\x1b[32m[server] ${room}: Private chat from ${user} to ${to}`);
        } else {
            io.to(room.token).emit('chat', payload);
            console.log(`\x1b[32m[server] ${room}: Broadcast chat from ${user}: "${message}"`);
        }
    });

    socket.on('transaction', data => {
        if (typeof data !== 'object' || data === null) {
            return;
        }
        const { operations, transactionId, senderIndex, to } = data;

        const user = socket.user;
        if (!user) {
            return;
        }
        const room = user.room;

        if (!Array.isArray(operations)) {
            console.warn(`[server] ${user} sent invalid operations array`);
            return;
        }

        resetCloseTimeout();

        const firstOp = String(operations[0]?.op ?? 'nop');
        const opCount = operations.length ?? 0;

        if (user.isAdmin) {
            const transactionIndex = room.transactionIndex++;

            const payload = {
                operations,
                transactionId,
                transactionIndex,
                senderIndex: senderIndex ?? user.index,
            };

            if (typeof to === 'string') {
                socket.broadcast.to(to).emit('transaction', payload);
                socket.broadcast
                    .to(room.token)
                    .except(to)
                    .emit('transaction', {
                        operations: [],
                        transactionId,
                        transactionIndex,
                        senderIndex: null,
                    });
            } else {
                socket.broadcast.to(room.token).emit('transaction', payload);
            }

            if (operations.length === 0) {
                console.log(`\x1b[36m[server] ${room}: ${user} issued NOP to "${to}"`);
            } else {
                console.log(`\x1b[36m[server] ${room}: Broadcast T<${transactionIndex}:${String(transactionId).slice(0, 4)}:${firstOp}:${opCount}>`);
            }
        } else if (room.admin.socket !== null) {
            room.admin.socket.emit('validate', {
                operations,
                transactionId,
                senderIndex: user.index,
                to: socket.id,
            });

            console.log(`\x1b[36m[server] ${room}: Forwarded T<?:${String(transactionId).slice(0, 4)}:${firstOp}:${opCount}> from ${user}`);
        } else {
            console.log(`\x1b[36m[server] ${room}: No admin is connected for validation`);
        }
    });

    socket.on('ban', data => {
        if (typeof data !== 'object' || data === null) {
            return;
        }
        const { userIndex } = data;
        if (!Number.isInteger(userIndex)) {
            return;
        }

        const user = socket.user;
        if (!user || !user.isAdmin) {
            return;
        }
        const room = user.room;

        const target = room.users[userIndex];
        if (target === undefined || target === null || target.socket === null) {
            return;
        }

        if (target === user) {
            console.warn(`\x1b[33m[server] ${room}: ${user} was refused from banning themselves`);
            return;
        }

        resetCloseTimeout();

        room.bannedIps.set(target.socket.ip, target.username);

        console.warn(`\x1b[33m[server] ${room}: ${user} banned ${target}`);

        target.socket.emit('kicked', { reason: 'You have been banned from the room.', type: 'banned' });
        target.socket.disconnect(true);

        io.to(room.token).emit('chat', {
            message: `Banned user <${target.username}>`,
            senderUsername: user.username,
            isAdmin: true,
            color: ADMIN_COLOR,
            time: Date.now(),
        });

        sendUsers(room);
    });

    socket.on('kick', data => {
        if (typeof data !== 'object' || data === null) {
            return;
        }
        const { userIndex } = data;
        if (!Number.isInteger(userIndex)) {
            return;
        }

        const user = socket.user;
        if (!user || !user.isAdmin) {
            return;
        }
        const room = user.room;

        const target = room.users[userIndex];
        if (target === undefined || target === null || target.socket === null) {
            return;
        }

        if (target === user) {
            console.warn(`\x1b[33m[server] ${room}: ${user} was refused from kicking themselves`);
            return;
        }

        resetCloseTimeout();

        target.socket.emit('kicked', { reason: 'You have been kicked from the server.', type: 'kick' });
        target.socket.disconnect(true);

        io.to(room.token).emit('chat', {
            message:`Kicked user <${target.username}>`,
            senderUsername: user.username,
            isAdmin: true,
            color: ADMIN_COLOR,
            time: Date.now(),
        });

        sendUsers(room);
    });

    socket.on('set_allow_editing', data => {
        if (typeof data !== 'object' || data === null) {
            return;
        }
        const { userIndex, allowEditing } = data;
        if (!Number.isInteger(userIndex) || typeof allowEditing !== 'boolean') {
            return;
        }

        const user = socket.user;
        if (!user || !user.isAdmin) {
            return;
        }
        const room = user.room;

        const target = room.users[userIndex];
        if (target === undefined || target === null) {
            return;
        }

        resetCloseTimeout();

        target.allowEditing = !!allowEditing;

        console.log(`\x1b[32m[server] ${room}: Updated allow editing for ${target}`);

        sendUsers(room);
    });

    socket.on('update_player', data => {
        if (typeof data !== 'object' || data === null) {
            return;
        }
        const { cx, cy, x, y, z, angle } = data;

        const user = socket.user;
        if (!user) {
            return;
        }
        const room = user.room;

        socket.to(room.token).emit('update_player', {
            userIndex: user.index,
            cx: Number.isInteger(cx) ? cx : 0,
            cy: Number.isInteger(cy) ? cy : 0,
            x: Number.isInteger(x) ? x : 0,
            y: Number.isInteger(y) ? y : 0,
            z: Number.isInteger(z) ? z : 0,
            angle: Number.isInteger(angle) ? angle : 0,
        });
    });

    socket.on('disconnect', () => {
        const user = socket.user;
        if (user === null || user.socket !== socket) {
            return;
        }
        user.socket = null;

        const room = user.room;

        console.log(`\x1b[32m[server] ${room}: ${user} disconnected`);

        socket.to(room.token).emit('chat', {
            message: `User <${user.username}> left the room.`,
            senderUsername: 'SERVER',
            isAdmin: false,
            color: SERVER_COLOR,
            time: Date.now(),
        });

        if (closing) {
            return;
        }

        user.removalTimeout = setTimeout(() => {
            user.removalTimeout = null;

            if (user.socket !== null ||
                room.users[user.index] !== user) {
                return;
            }

            if (!user.isAdmin) {
                room.users[user.index] = null;

                console.log(`\x1b[32m[server] ${room}: Removed disconnected ${user}`);

                sendUsers(room);

                return;
            }

            console.log(`\x1b[32m[server] ${room}: Closed (token=${room.token.slice(0,4)})`);

            io.to(room.token).emit('kicked', { reason: 'Room closed due to admin leaving.', type: 'room_closure' });

            room.users.forEach(user => {
                if (user !== null) {
                    if (user.removalTimeout !== null) {
                        clearTimeout(user.removalTimeout);
                        user.removalTimeout = null;
                    }

                    if (user.socket !== null) {
                        user.socket.disconnect(true);
                        user.socket = null;
                    }
                }
            });

            rooms.delete(room.token);

            resetCloseTimeout();
        }, USER_RECONNECT_GRACE_SECONDS * 1000);

        user.removalTimeout.unref();

        resetCloseTimeout();

        sendUsers(room);
    });
});

const createUserList = room => {
    const users = [];

    room.users.forEach((user, i) => {
        if (user !== null && (user.socket !== null || user.isAdmin)) {
            users.push({
                index: i,
                socketId: user.socket?.id ?? null,
                connected: user.socket !== null,
                username: user.username,
                color: user.color,
                isAdmin: user.isAdmin,
                allowEditing: user.allowEditing,
            });
        }
    });

    return users;
};

const sendUsers = room => {
    if (room.users.length === 0) {
        return;
    }

    io.to(room.token).emit('users', {
        users: createUserList(room),
    });
};

server.listen(PORT, '0.0.0.0', () => {
    console.log('\x1b[0m[server] js Doom Builder multiplayer server running on the following addresses:');

    resetCloseTimeout();

    const interfaces = os.networkInterfaces();
    const rows = [];

    for (const name in interfaces) {
        for (const iface of interfaces[name] ?? []) {
            if (iface.family === 'IPv4') {
                const url = `http://${iface.address}:${PORT}`;
                rows.push({
                    name,
                    address: `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`,
                });
            }
        }
    }

    const nameWidth = Math.max(...rows.map(row => row.name.length));

    for (const row of rows) {
        console.log(`\x1b[0m[server]   ${row.name.padEnd(nameWidth)} : ${row.address}`);
    }
});
