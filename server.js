// server.js
// WebSocket-only matchmaking + chat + HEARTBEAT + LATENCY TESTING

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

// Helpers
function mmrDiff(a, b) {
    return Math.abs(a.mmr - b.mmr);
}

// Matchmaking logic
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

    // Standard WebSocket heartbeat
    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', data => {
        let msg;
        try {
            msg = JSON.parse(data);
        } catch (e) {
            return safeSend(ws, { type: "error", message: "Invalid JSON" });
        }
        if (!msg.type) return;

        // -------------------------------
        // JOIN QUEUE
        // -------------------------------
        if (msg.type === "join_queue") {
            if (player) {
                return safeSend(ws, { type: "error", message: "already joined" });
            }

            if (typeof msg.player_id !== "string" ||
                typeof msg.mmr !== "number") {
                return safeSend(ws, { type: "error", message: "invalid join_queue payload" });
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

        // --------------------------------------
        // HEARTBEAT: client ↔ server, host ↔ server
        // --------------------------------------

        if (msg.type === "ping_client_server") {
            return safeSend(ws, {
                type: "pong_client_server",
                timestamp: msg.timestamp
            });
        }

        if (msg.type === "ping_host_server") {
            return safeSend(ws, {
                type: "pong_host_server",
                timestamp: msg.timestamp
            });
        }

        // --------------------------------------
        // LATENCY TESTS
        // --------------------------------------

        // Direct server ping reply
        if (msg.type === "latency_request") {
            return safeSend(ws, {
                type: "latency_reply",
                timestamp: msg.timestamp
            });
        }

        // Relay latency from client → host (via server)
        if (msg.type === "latency_request_to_host") {
            if (!player || !player.opponent) {
                return safeSend(ws, { type: "error", message: "No host/client available" });
            }
            return safeSend(player.opponent.ws, {
                type: "relay_latency_to_host",
                from: player.player_id,
                timestamp: msg.timestamp
            });
        }

        // Host responded to client
        if (msg.type === "latency_reply_to_client") {
            if (!player || !player.opponent) {
                return safeSend(ws, { type: "error", message: "No opponent to relay to" });
            }
            return safeSend(player.opponent.ws, {
                type: "relay_latency_to_client",
                timestamp: msg.timestamp
            });
        }

        // --------------------------------------
        // CHAT
        // --------------------------------------
        if (msg.type === "chat") {
            if (!player || !player.opponent) {
                return safeSend(ws, { type: "error", message: "No opponent to forward chat" });
            }
            if (!msg.text || typeof msg.text !== "string") {
                return safeSend(ws, { type: "error", message: "Invalid chat text" });
            }

            safeSend(player.opponent.ws, {
                type: "chat",
                from: player.player_id,
                text: msg.text
            });
            return;
        }

        // --------------------------------------
        // GAME UPDATE
        // --------------------------------------
        if (msg.type === "game_update") {
            if (!player || !player.opponent) {
                return safeSend(ws, { type: 'error', message: 'no opponent to forward update to' });
            }

            safeSend(player.opponent.ws, {
                type: "game_update",
                from: player.player_id,
                payload: msg.payload
            });
            return;
        }

        return safeSend(ws, { type: "error", message: "Unknown message type" });
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

// Standard WebSocket heartbeat (disconnect dead clients)
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping(() => {});
    });
}, HEARTBEAT_INTERVAL);
