// server.js
// WebSocket matchmaking + rank pairing + WebRTC signaling

const http = require('http');
const WebSocket = require("ws");

// Create a simple HTTP server so we can bind to the port provided by Replit
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const server = http.createServer((req, res) => {
    // basic health endpoint
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Matchmaking server');
});

const wss = new WebSocket.Server({ server });

let queue = []; // players waiting for match

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Matchmaking server running on port ${PORT}`);
});

// Configuration
const MAX_MMR_DIFF = 200; // base allowed MMR difference
const HEARTBEAT_INTERVAL = 30000; // ms

// Utility: absolute MMR difference
function mmrDiff(a, b) {
    return Math.abs(a.mmr - b.mmr);
}

// Safe send wrapper (checks ready state, handles exceptions)
function safeSend(ws, obj) {
    if (!ws) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
        ws.send(JSON.stringify(obj));
    } catch (e) {
        console.error('WebSocket send error:', e);
        try { ws.terminate(); } catch (e2) {}
    }
}

// Try to match players in queue according to MMR
function attemptMatch() {
    if (queue.length < 2) return;

    // Sort by mmr (small queues ok; for large scale use buckets / Redis sorted sets)
    queue.sort((a, b) => a.mmr - b.mmr);

    for (let i = 0; i < queue.length - 1; i++) {
        const p1 = queue[i];
        const p2 = queue[i + 1];

        // Dynamic tolerance increases with wait time (in seconds) to avoid long waits
        const wait1 = Math.floor((Date.now() - (p1.joinedAt || Date.now())) / 1000);
        const wait2 = Math.floor((Date.now() - (p2.joinedAt || Date.now())) / 1000);
        const dynamicAllowance = Math.min(600, (wait1 + wait2) * 10); // cap growth
        const allowed = MAX_MMR_DIFF + dynamicAllowance;

        if (mmrDiff(p1, p2) <= allowed) {
            // Found a match
            queue.splice(i, 2); // remove both

            p1.opponent = p2;
            p2.opponent = p1;

            // p1 is host, p2 is client
            safeSend(p1.ws, { type: "match_start", role: "host", opponent: p2.player_id });
            safeSend(p2.ws, { type: "match_start", role: "client", opponent: p1.player_id });

            console.log(`Matched ${p1.player_id} (MMR ${p1.mmr}) vs ${p2.player_id} (MMR ${p2.mmr}); allowed=${allowed}`);
            return;
        }
    }
}

wss.on("connection", ws => {
    console.log("Client connected");

    let player = null;

    // heartbeat
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on("message", data => {
        let msg;
        try {
            msg = JSON.parse(data);
        } catch (e) {
            console.error("Bad JSON from client:", e);
            return;
        }

        // Player wants to enter ranked queue
        if (msg.type === "join_queue") {
            // Expected payload: { type:"join_queue", player_id:"string", mmr:number }
            if (player) {
                safeSend(ws, { type: 'error', message: 'already joined' });
                return;
            }

            if (!msg || typeof msg.player_id !== 'string' || typeof msg.mmr !== 'number' || !isFinite(msg.mmr)) {
                safeSend(ws, { type: 'error', message: 'invalid join_queue payload' });
                return;
            }

            player = {
                ws: ws,
                player_id: msg.player_id,
                mmr: msg.mmr,
                opponent: null,
                joinedAt: Date.now()
            };

            queue.push(player);
            console.log(`Player joined queue: ${player.player_id} (MMR ${player.mmr})`);

            attemptMatch();
            return;
        }

        // WebRTC signaling relay (offer / answer / ice)
        if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice") {
            // Only forward signaling messages to the current opponent
            if (player && player.opponent && player.opponent.ws && player.opponent.ws.readyState === WebSocket.OPEN) {
                // Forward only expected fields to reduce accidental leakage
                const forward = { type: msg.type };
                if (msg.sdp) forward.sdp = msg.sdp;
                if (msg.candidate) forward.candidate = msg.candidate;
                if (msg.data) forward.data = msg.data; // optional

                safeSend(player.opponent.ws, forward);
            } else {
                safeSend(ws, { type: 'error', message: 'no opponent to forward to' });
            }
            return;
        }
    });

    ws.on("close", () => {
        console.log("Client disconnected");

        // Remove from queue if waiting
        queue = queue.filter(p => p.ws !== ws);

        // Notify opponent if in a match
        if (player && player.opponent && player.opponent.ws && player.opponent.ws.readyState === WebSocket.OPEN) {
            safeSend(player.opponent.ws, { type: "opponent_disconnected" });
            player.opponent.opponent = null;
        }
    });
});

// Heartbeat loop to detect and clean dead clients
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            try { ws.terminate(); } catch (e) {}
            return;
        }
        ws.isAlive = false;
        try { ws.ping(() => {}); } catch (e) {}
    });
}, HEARTBEAT_INTERVAL);

process.on('exit', () => clearInterval(heartbeatInterval));
