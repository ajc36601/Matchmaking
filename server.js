// server.js
// WebSocket-only matchmaking + chat (no UDP, no ENet)

const http = require('http');
const WebSocket = require('ws');

// --- Config ---
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const MAX_MMR_DIFF = 200;
const HEARTBEAT_INTERVAL = 30000;

let queue = []; // players waiting for match

// --- Simple HTTP server ---
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebSocket matchmaking server');
});

const wss = new WebSocket.Server({ server });

server.listen(PORT, '0.0.0.0', () => {
    console.log(`WebSocket matchmaking server running on port ${PORT}`);
});

// Safe send wrapper
function safeSend(ws, obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
        ws.send(JSON.stringify(obj));
    } catch (e) {
        console.error("Send error:", e);
    }
}

function mmrDiff(a, b) {
    return Math.abs(a.mmr - b.mmr);
}

// Matchmaking logic (WebSocket only)
function attemptMatch() {
    if (queue.length < 2) return;

    queue.sort((a, b) => a.mmr - b.mmr);

    const now = Date.now();

    for (let i = 0; i < queue.length - 1; i++) {
        const p1 = queue[i];
        const p2 = queue[i + 1];

        const wait1 = Math.floor((now - p1.joinedAt) / 1000);
        const wait2 = Math.floor((now - p2.joinedAt) / 1000);

        const dynamicAllowance = Math.min(600, (wait1 + wait2) * 10);
        const allowed = MAX_MMR_DIFF + dynamicAllowance;

        if (mmrDiff(p1, p2) <= allowed) {
            // Match found
            queue.splice(i, 2);

            p1.opponent = p2;
            p2.opponent = p1;

            console.log(`Matched ${p1.player_id} vs ${p2.player_id}`);

            // Send start messages
            safeSend(p1.ws, {
                type: "match_start",
                role: "host",
                opponent: p2.player_id
            });

            safeSend(p2.ws, {
                type: "match_start",
                role: "client",
                opponent: p1.player_id
            });

            return;
        }
    }
}

// --- WebSocket Handling ---
wss.on('connection', ws => {
    console.log("Client connected.");

    let player = null;

    // heartbeat
    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', data => {
        let msg;

        try {
            msg = JSON.parse(data);
        } catch (e) {
            safeSend(ws, { type: "error", message: "Invalid JSON" });
            return;
        }

        if (!msg.type) return;

        // join_queue
        if (msg.type === "join_queue") {
            if (player) {
                safeSend(ws, { type: "error", message: "already joined" });
                return;
            }

            if (typeof msg.player_id !== "string" ||
                typeof msg.mmr !== "number") {
                safeSend(ws, { type: "error", message: "invalid join_queue payload" });
                return;
            }

            player = {
                ws,
                player_id: msg.player_id,
                mmr: msg.mmr,
                opponent: null,
                joinedAt: Date.now()
            };

            queue.push(player);
            console.log(`Player queued: ${player.player_id} (${player.mmr})`);

            attemptMatch();
            return;
        }

        // Chat message forwarding
        if (msg.type === "chat") {
            if (!player || !player.opponent) {
                safeSend(ws, { type: "error", message: "No opponent to forward chat" });
                return;
            }

            if (!msg.text || typeof msg.text !== "string") {
                safeSend(ws, { type: "error", message: "Invalid chat text" });
                return;
            }

            safeSend(player.opponent.ws, {
                type: "chat",
                from: player.player_id,
                text: msg.text
            });

            return;
        }
        
        // game_update: { type:"game_update", payload: {...} }
        if (msg.type === "game_update") {
            if (!player || !player.opponent) {
                safeSend(ws, { type: 'error', message: 'no opponent to forward update to' });
                return;
            }

            // forward to opponent
            safeSend(player.opponent.ws, {
                type: "game_update",
                from: player.player_id,
                payload: msg.payload   // can be any object
            });
            return;
        }


        safeSend(ws, { type: "error", message: "Unknown message type" });
    });

    ws.on('close', () => {
        console.log("Client disconnected.");

        // Remove from queue
        queue = queue.filter(p => p.ws !== ws);

        // Notify opponent
        if (player && player.opponent) {
            safeSend(player.opponent.ws, {
                type: "opponent_disconnected"
            });
            player.opponent.opponent = null;
        }
    });
});

// Heartbeat (disconnect dead clients)
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping(() => {});
    });
}, HEARTBEAT_INTERVAL);
