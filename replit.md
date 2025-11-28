# WebSocket Matchmaking Server

## Overview
This is a Node.js WebSocket matchmaking server that provides:
- MMR-based (Matchmaking Rating) player pairing
- WebRTC signaling relay for peer-to-peer connections
- Dynamic tolerance for wait times to prevent long queue times
- Heartbeat monitoring for client connection health

## Project Architecture

### Technology Stack
- **Runtime**: Node.js 20
- **WebSocket Library**: ws (v8.13.0)
- **HTTP Server**: Built-in Node.js http module

### Core Components
1. **HTTP Server**: Provides basic health endpoint and binds to port
2. **WebSocket Server**: Handles player connections and messaging
3. **Matchmaking Queue**: In-memory queue for players waiting to be matched
4. **WebRTC Signaling**: Relays offer/answer/ICE candidates between matched players

### Key Features
- **MMR-Based Matching**: Players are matched based on similar skill ratings
- **Dynamic Tolerance**: Allowed MMR difference increases with wait time (up to 600 max)
- **Role Assignment**: First player is "host", second is "client" for WebRTC
- **Heartbeat System**: Detects and cleans up dead connections every 30 seconds

## Configuration

### Environment Variables
- `PORT`: Server port (default: 8080 in Replit)

### Matchmaking Settings (in server.js)
- `MAX_MMR_DIFF`: Base allowed MMR difference (200)
- `HEARTBEAT_INTERVAL`: Client heartbeat interval (30000ms)

## Message Protocol

### Client → Server
1. **join_queue**: Join the matchmaking queue
   ```json
   {
     "type": "join_queue",
     "player_id": "string",
     "mmr": number
   }
   ```

2. **WebRTC Signaling**: offer, answer, ice
   ```json
   {
     "type": "offer|answer|ice",
     "sdp": "...",
     "candidate": {...}
   }
   ```

### Server → Client
1. **match_start**: Match found
   ```json
   {
     "type": "match_start",
     "role": "host|client",
     "opponent": "player_id"
   }
   ```

2. **opponent_disconnected**: Opponent left
   ```json
   {
     "type": "opponent_disconnected"
   }
   ```

3. **error**: Error message
   ```json
   {
     "type": "error",
     "message": "string"
   }
   ```

## Running the Server

### Development
The server runs via the "Matchmaking Server" workflow on port 8080.

### Health Check
Access `/health` endpoint to verify server is running.

## Recent Changes
- **2025-11-28**: Initial Replit environment setup
  - Configured Node.js 20
  - Set up workflow to run on port 8080
  - Added .gitignore for Node.js
  - Created documentation

## Deployment Notes
This is a backend WebSocket server. When deploying:
- Use "vm" deployment target (always-running, stateful)
- Server maintains in-memory queue and connection state
- Binds to 0.0.0.0 for external access
