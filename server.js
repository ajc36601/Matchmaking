// server.js
// Matchmaking + chat over WebSocket + UDP NAT punch-through introducer for ENet

const http = require('http');
const WebSocket = require('ws');
const dgram = require('dgram');

// --- Config ---
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;         // HTTP + WebSocket
const UDP_PORT = process.env.UDP_PORT ? parseInt(process.env.UDP_PORT, 10) : 9000; // NAT punch-through UDP port
const ENET_PORT = process.env.ENET_PORT ? parseInt(process.env.ENET_PORT, 10) : 4242; // ENet port to use in Godot

const MAX_MMR_DIFF = 200;          // base allowed MMR difference
const HEARTBEAT_INTERVAL = 30000;  // ms
const UDP_REGISTRY_TTL = 60 * 1000; // 60s: drop stale UDP registrations

// --- Simple HTTP server (for health checks / Replit) ---
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Matchmaking + NAT punch-through server');
});

const wss = new WebSocket.Server({ server });
const udpServer = dgram.createSocket('udp4');

let queue = []; // players waiting for match

// Map: player_id -> { address, port, lastSeen }
const udpRegistry = new Map();

server.listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP/WebSocket server running on port ${PORT}`);
});

udpServer.bind(UDP_PORT, '0.0.0.0', () => {
    console.log(`UDP NAT punch-through server listening on port ${UDP_PORT}`);
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

// UDP: handle registration / keepalive from clients
// Expected from client (via PacketPeerUDP or similar):
//   { "type": "register", "player_id": "string" }
udpServer.on('message', (msg, rinfo) => {
    let data;
    try {
        data = JSON.parse(msg.toString());
    } catch (e) {
        // Ignore non-JSON packets; this is fine if you mix with ENet or other UDP
        return;
    }

    if (!data || typeof data !== 'object') return;

    if (data.type === 'register' && typeof data.player_id === 'string') {
        udpRegistry.set(data.player_id, {
            address: rinfo.address,
            port: rinfo.port,
            lastSeen: Date.now()
        });
        // Optionally log:
        // console.log(`UDP register from ${data.player_id} at ${rinfo.address}:${rinfo.port}`);
    }
});

// Clean up stale UDP registry entries
setInterval(() => {
    const now = Date.now();
    for (const [player_id, info] of udpRegistry.entries()) {
        if (now - info.lastSeen > UDP_REGISTRY_TTL) {
            udpRegistry.delete(player_id);
        }
    }
}, 30 * 1000);

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

            // Look up UDP registrations for NAT punching
            const p1Udp = udpRegistry.get(p1.player_id) || null;
            const p2Udp = udpRegistry.get(p2.player_id) || null;

            // p1 is ENet host, p2 is ENet client (pure convention)
            // We send both WebSocket "match_start" messages that include:
            // - ENet role
            // - ENet port
            // - peer's public UDP address/port (if known)
            safeSend(p1.ws, {
                type: "match_start",
                role: "host",                 // general match role
                opponent: p2.player_id,
                enet_role: "host",            // host should create ENet server
                enet_port: ENET_PORT,         // port host should listen on (in Godot)
                self_udp: p1Udp,              // { address, port } or null
                opponent_udp: p2Udp,          // where host can try sending initial UDP packets
                udp_server_port: UDP_PORT     // for clients to know where to register
            });

            safeSend(p2.ws, {
                type: "match_start",
                role: "client",
                opponent: p1.player_id,
                enet_role: "client",          // client should connect to host via ENet
                enet_port: ENET_PORT,
                self_udp: p2Udp,
                opponent_udp: p1Udp,
                udp_server_port: UDP_PORT
            });

            console.log(
                `Matched ${p1.player_id} (${p1.mmr}) vs ${p2.player_id} (${p2.mmr}); allowed=${allowed}`
            );

            // Optional: send a small UDP "punch" message to both sides
            // so their NATs see incoming+outgoing traffic and open holes.
            if (p1Udp && p2Udp) {
                const msgToP1 = Buffer.from(JSON.stringify({
                    type: 'punch',
                    peer: { address: p2Udp.address, port: p2Udp.port },
                    role: 'host'
                }));
                udpServer.send(msgToP1, p1Udp.port, p1Udp.address, err => {
                    if (err) console.error('UDP punch to p1 failed:', err);
                });

                const msgToP2 = Buffer.from(JSON.stringify({
                    type: 'punch',
                    peer: { address: p1Udp.address, port: p1Udp.port },
                    role: 'client'
                }));
                udpServer.send(msgToP2, p2Udp.port, p2Udp.address, err => {
                    if (err) console.error('UDP punch to p2 failed:', err);
                });
            }

            return;
        }
    }
}

// --- WebSocket handling ---
wss.on('connection', ws => {
    console.log('Client connected via WebSocket');

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

        if (!msg || typeof msg.type !== 'string') {
            safeSend(ws, { type: 'error', message: 'invalid message format' });
            return;
        }

        // join_queue: { type:"join_queue", player_id:string, mmr:number }
        if (msg.type === 'join_queue') {
            if (player) {
                safeSend(ws, { type: 'error', message: 'already joined' });
                return;
            }

            if (typeof msg.player_id !== 'string' ||
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

        // chat: { type:"chat", text:string }
        if (msg.type === 'chat') {
            if (typeof msg.text !== 'string') {
                safeSend(ws, { type: 'error', message: 'invalid chat text' });
                return;
            }

            if (player && player.opponent && player.opponent.ws?.readyState === WebSocket.OPEN) {
                // Relay chat to opponent
                safeSend(player.opponent.ws, {
                    type: 'chat',
                    from: player.player_id,
                    text: msg.text
                });
            } else {
                safeSend(ws, { type: 'error', message: 'no opponent to forward chat to' });
            }
            return;
        }

        // Unknown message type
        safeSend(ws, { type: 'error', message: 'unknown message type' });
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
