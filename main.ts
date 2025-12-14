const users = new Map();

// --- Configuration ---
const MAX_NAME_LENGTH = 50;
const MAX_ROOM_LENGTH = 50;
const PING_INTERVAL = 45000;
const PONG_TIMEOUT = 10000;
const RATE_LIMIT_WINDOW = 10000;
const MAX_MESSAGES_PER_WINDOW = 20;

let heartbeatInitialized = false;

function broadcastUser(newUser) {
  const message = JSON.stringify({type: 'newUser', user: newUser});

  for (const [_, u] of users) {
    if (u.socket.readyState === WebSocket.OPEN) {
      if(newUser.id !== u.id){
        try {
          u.socket.send(message);
        } catch (e) {
          console.error(`Error broadcasting to user ${u.id}:`, e);
        }
      }
    }
  }
}

function broadcastUserList() {
  const userList = Array.from(users.values()).map(u => ({
    id: u.id,
    name: u.name,
    room: u.room
  }));
  
  const message = JSON.stringify({ type: 'userList', users: userList });
  
  for (const [_, user] of users) {
    if (user.socket.readyState === WebSocket.OPEN) {
      try {
        user.socket.send(message);
      } catch (e) {
        console.error(`Error sending user list to ${user.id}:`, e);
      }
    }
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
          try {
            user.socket.close();
          } catch (e) {
            console.error(`Error closing socket for ${id}:`, e);
          }
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

// Initialize heartbeat once
setupHeartbeat();

// --- Main Server ---
Deno.serve((req) => {
  // Handle non-WebSocket requests
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
    
    try {
      socket.send(JSON.stringify({ type: 'init', id }));
      broadcastUserList();
    } catch (e) {
      console.error(`Error in onopen for ${id}:`, e);
    }
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

      if (typeof newName === 'string' && newName.length > 0 && newName.length <= MAX_NAME_LENGTH &&
          typeof newRoom === 'string' && newRoom.length > 0 && newRoom.length <= MAX_ROOM_LENGTH) 
      {
        user.name = newName;
        user.room = newRoom;
        broadcastUser(user);
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
    console.log(`User ${id} disconnected`);
    users.delete(id);
    broadcastUserList();
  };

  return response;
});