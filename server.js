// server.js
// WebSocket matchmaking + rank pairing + WebRTC signaling

const http = require('http');
const WebSocket = require('ws');

// --- Config ---
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const MAX_MMR_DIFF = 200;          // base allowed MMR difference
const HEARTBEAT_INTERVAL = 30000;  // ms

// --- Simple HTTP server (for Replit / health checks) ---
const server = http.createServer((req, res) => {
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

// Utility: absolute MMR difference
function mmrDiff(a, b) {
    return Math.abs(a.mmr - b.mmr);
}

// Safe send wrapper
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

    // sort by mmr
    queue.sort((a, b) => a.mmr - b.mmr);

    for (let i = 0; i < queue.length - 1; i++) {
        const p1 = queue[i];
        const p2 = queue[i + 1];

        const now = Date.now();
        const wait1 = Math.floor((now - (p1.joinedAt || now)) / 1000);
        const wait2 = Math.floor((now - (p2.joinedAt || now)) / 1000);

        // widen allowed MMR difference the longer they wait (capped)
        const dynamicAllowance = Math.min(600, (wait1 + wait2) * 10);
        const allowed = MAX_MMR_DIFF + dynamicAllowance;

        if (mmrDiff(p1, p2) <= allowed) {
            // Found a match
            queue.splice(i, 2);

            p1.opponent = p2;
            p2.opponent = p1;

            // p1 is host, p2 is client
            safeSend(p1.ws, { type: "match_start", role: "host", opponent: p2.player_id });
            safeSend(p2.ws, { type: "match_start", role: "client", opponent: p1.player_id });

            console.log(`Matched ${p1.player_id} (${p1.mmr}) vs ${p2.player_id} (${p2.mmr}); allowed=${allowed}`);
            return;
        }
    }
}

// --- WebSocket handling ---
wss.on('connection', ws => {
    console.log('Client connected');

    let player = null;

    // heartbeat
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', data => {
        let msg;
        try {
            msg = JSON.parse(data);
        } catch (e) {
            console.error('Bad JSON from client:', e);
            return;
        }

        // join_queue: { type:"join_queue", player_id:string, mmr:number }
        if (msg.type === 'join_queue') {
            if (player) {
                safeSend(ws, { type: 'error', message: 'already joined' });
                return;
            }

            if (!msg || typeof msg.player_id !== 'string' ||
                typeof msg.mmr !== 'number' || !isFinite(msg.mmr)) {
                safeSend(ws, { type: 'error', message: 'invalid join_queue payload' });
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
            console.log(`Player joined queue: ${player.player_id} (MMR ${player.mmr})`);

            attemptMatch();
            return;
        }

        // --- WebRTC signaling relay ---

        // offer / answer: { type:"offer"|"answer", sdp:string }
        if (msg.type === 'offer' || msg.type === 'answer') {
            if (player && player.opponent && player.opponent.ws?.readyState === WebSocket.OPEN) {
                safeSend(player.opponent.ws, {
                    type: msg.type,
                    sdp: msg.sdp
                });
            } else {
                safeSend(ws, { type: 'error', message: 'no opponent to forward to' });
            }
            return;
        }

        // ice: { type:"ice", media:string, index:number, name:string }
        if (msg.type === 'ice') {
            if (player && player.opponent && player.opponent.ws?.readyState === WebSocket.OPEN) {
                safeSend(player.opponent.ws, {
                    type: 'ice',
                    media: msg.media,
                    index: msg.index,
                    name: msg.name
                });
            } else {
                safeSend(ws, { type: 'error', message: 'no opponent to forward to' });
            }
            return;
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');

        // Remove from queue
        queue = queue.filter(p => p.ws !== ws);

        // Notify opponent if in a match
        if (player && player.opponent && player.opponent.ws?.readyState === WebSocket.OPEN) {
            safeSend(player.opponent.ws, { type: 'opponent_disconnected' });
            player.opponent.opponent = null;
        }
    });
});

// Heartbeat loop to drop dead connections
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) {
            try { ws.terminate(); } catch (e) {}
            return;
        }
        ws.isAlive = false;
        try { ws.ping(() => {}); } catch (e) {}
    });
}, HEARTBEAT_INTERVAL);

process.on('exit', () => clearInterval(heartbeatInterval));
