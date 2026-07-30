import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { Server } from 'socket.io';

const HOST = '127.0.0.1';
const PORT = 38571;

const DOOM_EXECUTABLE_PATH = 'C:/Users/myname/Desktop/gzdoom-4-14-2-windows/gzdoom.exe';

const RESOURCE_DIRECTORIES = [
    'C:/Program Files (x86)/Steam/steamapps/common/Ultimate Doom/base',
    'C:/Program Files (x86)/Steam/steamapps/common/Ultimate Doom/base/doom2',
];

const DOOM_ARGUMENTS = [
    '-window',
];

const SKILL = '4';

const SUPPORTED_RESOURCE_FILE_EXTENSIONS = [
    '.wad',
    '.pk3',
    '.pk7',
    '.zip',
    '.deh',
    '.bex',
];

const SERVER_FILE_PATH = fileURLToPath(import.meta.url);
const SERVER_DIRECTORY = path.dirname(SERVER_FILE_PATH);
const MAP_DIRECTORY = path.join(SERVER_DIRECTORY, 'maps');

await fs.mkdir(MAP_DIRECTORY, {
    recursive: true,
});

const httpServer = createServer();

const socketServer = new Server(httpServer, {
    maxHttpBufferSize: 128 * 1024 * 1024,
    cors: {
        origin: '*',
    },
});

socketServer.on('connection', socket => {
    socket.on('launch', async message => {
        console.log('\nAttempting to launch game');

        const resourcePathsByName = new Map();

        for (const resourceDirectory of RESOURCE_DIRECTORIES) {
            const directoriesToSearch = [
                resourceDirectory,
            ];

            while (directoriesToSearch.length > 0) {
                const directory = directoriesToSearch.pop();

                let entries;

                try {
                    entries = await fs.readdir(directory, {
                        withFileTypes: true,
                    });
                } catch {
                    continue;
                }

                for (const entry of entries) {
                    const entryPath = path.resolve(directory, entry.name);

                    if (entry.isDirectory()) {
                        directoriesToSearch.push(entryPath);
                        continue;
                    }

                    if (!entry.isFile()) {
                        continue;
                    }

                    const lowerEntryName = entry.name.toLowerCase();

                    if (!SUPPORTED_RESOURCE_FILE_EXTENSIONS.some(
                        extension => lowerEntryName.endsWith(extension)
                    )) {
                        continue;
                    }

                    if (!resourcePathsByName.has(lowerEntryName)) {
                        resourcePathsByName.set(lowerEntryName, entryPath);
                    }
                }
            }
        }

        const resourcePaths = [];

        let first = true;

        for (const resourceName of message.resourceNames ?? []) {
            const resourcePath = resourcePathsByName.get(String(resourceName).toLowerCase());

            if (resourcePath === undefined) {
                if (first) {
                    const message = `IWAD not found (load IWAD first): ${resourceName}`;
                    console.warn(message);
                    socket.emit('error', message);
                    return;
                }
                console.warn(`Ignoring missing resource: ${resourceName}`);
                continue;
            }
            first = false;

            resourcePaths.push(resourcePath);
        }

        if (resourcePaths.length === 0) {
            console.log('No resource files supplied');
            socket.emit('error', 'No resource files supplied');
            return;
        }

        const timestamp = new Date()
            .toISOString()
            .replaceAll(':', '-')
            .replaceAll('.', '-');

        const generatedMapPath = path.join(
            MAP_DIRECTORY,
            `generated-map-${timestamp}.wad`
        );

        await fs.writeFile(
            generatedMapPath,
            Buffer.from(message.base64, 'base64')
        );

        const mapName = message.mapName.replaceAll(/[^a-zA-Z0-9]/g, '');

        const [iwadPath, ...extraPaths] = resourcePaths;

        const args = [
            ...DOOM_ARGUMENTS,
            '-iwad',
            iwadPath,
            '-file',
            ...extraPaths,
            generatedMapPath,
            '-skill',
            SKILL,
            '+map',
            mapName,
        ];

        console.log(`Launching: "${DOOM_EXECUTABLE_PATH}" "${args.join('" "')}"`);

        const child = spawn(DOOM_EXECUTABLE_PATH, args, {
            cwd: path.dirname(DOOM_EXECUTABLE_PATH),
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
        });

        child.unref();

        socket.emit('launched');
    });
});

httpServer.listen(PORT, HOST, () => {
    console.log(`Doom launcher started.
Listening on http://${HOST}:${PORT}
Map directory: ${MAP_DIRECTORY}`);
});
