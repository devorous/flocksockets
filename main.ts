const users = new Map();

const MAX_NAME_LENGTH = 50;
const MAX_ROOM_LENGTH = 50;
const PING_INTERVAL = 45000;
const PONG_TIMEOUT = 10000;
const RATE_LIMIT_WINDOW = 10000;
const MAX_MESSAGES_PER_WINDOW = 20;

let heartbeatInitialized = false;

function broadcastUserJoined(user) {
    const message = JSON.stringify({
        type: 'userJoined',
        user: { id: user.id, name: user.name, room: user.room }
    });

    for (const [_, u] of users) {
        if (u.socket.readyState === WebSocket.OPEN && u.id !== user.id && u.room === user.room) {
            u.socket.send(message);
        }
    }
}

function broadcastUserLeft(user) {
    const message = JSON.stringify({ type: 'userLeft', id: user.id });

    for (const [_, u] of users) {
        if (u.socket.readyState === WebSocket.OPEN && u.room === user.room) {
            u.socket.send(message);
        }
    }
}

function broadcastUserList(socket) {
    const userList = Array.from(users.values())
        .filter(u => u.room)
        .map(u => ({ id: u.id, name: u.name, room: u.room }));

    const message = JSON.stringify({ type: 'userList', users: userList });

    try {
        socket.send(message);
    } catch (e) {
        console.error("Error sending user list:", e);
    }
}

function setupHeartbeat() {
    if (heartbeatInitialized) return;
    heartbeatInitialized = true;

    setInterval(() => {
        const now = Date.now();

        for (const [id, user] of users) {
            if (user.socket.readyState === WebSocket.OPEN) {
                if (user.awaitingPong && now - user.lastPing > PONG_TIMEOUT) {
                    console.log(`User ${id} failed to respond to ping. Closing.`);
                    user.socket.close();
                    continue;
                }

                try {
                    user.awaitingPong = true;
                    user.lastPing = now;
                    user.socket.send(JSON.stringify({ type: 'PING' }));
                } catch (e) {
                    console.error(`Error sending ping to user ${id}:`, e);
                }
            }
        }
    }, PING_INTERVAL);
}

setupHeartbeat();

Deno.serve((req) => {
    if (req.headers.get("upgrade") !== "websocket") {
        return new Response("WebSocket server running", { status: 200 });
    }

    const { socket, response } = Deno.upgradeWebSocket(req);
    const id = crypto.randomUUID();

    socket.onopen = () => {
        console.log(`User ${id} connected`);
        users.set(id, {
            id,
            name: null,
            room: null,
            socket,
            awaitingPong: false,
            lastPing: Date.now(),
            messageCount: 0,
            windowStart: Date.now()
        });

        broadcastUserList(socket);
    };

    socket.onmessage = (event) => {
        const user = users.get(id);
        if (!user) return;

        const now = Date.now();
        if (now - user.windowStart > RATE_LIMIT_WINDOW) {
            user.messageCount = 0;
            user.windowStart = now;
        }

        user.messageCount++;
        if (user.messageCount > MAX_MESSAGES_PER_WINDOW) {
            console.warn(`Rate limit exceeded for user ${id}`);
            socket.close(1008, "Rate limit exceeded");
            return;
        }

        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            console.error(`[User: ${id}] Failed to parse JSON:`, e);
            return;
        }

        if (data.type === 'JOIN') {
            const newName = data.name;
            const newRoom = data.room;

            if (
                typeof newName === 'string' &&
                newName.length > 0 &&
                newName.length <= MAX_NAME_LENGTH &&
                typeof newRoom === 'string' &&
                newRoom.length > 0 &&
                newRoom.length <= MAX_ROOM_LENGTH
            ) {
                user.name = newName;
                user.room = newRoom;
                broadcastUserJoined(user);
            } else {
                console.warn(`[User: ${id}] Invalid JOIN data`);
            }
        } else if (data.type === 'PONG') {
            user.awaitingPong = false;
        }
    };

    socket.onerror = (error) => {
        console.error(`WebSocket error for user ${id}:`, error);
    };

    socket.onclose = () => {
        const user = users.get(id);
        if (user) {
            console.log(`User ${id} disconnected`);
            broadcastUserLeft(user);
        }
        users.delete(id);
    };

    return response;
});
