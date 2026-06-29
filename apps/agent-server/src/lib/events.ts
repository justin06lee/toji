import type { WebSocket } from 'ws';
import type { ServerEvent } from '../types.js';

const sockets = new Set<WebSocket>();
type BroadcastEvent = Omit<ServerEvent, 'at'> | ServerEvent;

function withTimestamp(event: BroadcastEvent): ServerEvent {
  const at = 'at' in event ? event.at : new Date().toISOString();
  return { ...(event as object), at } as ServerEvent;
}

export function addSocket(ws: WebSocket) {
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
  ws.on('error', () => sockets.delete(ws));
}

export function sendToSocket(socket: WebSocket, event: BroadcastEvent) {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(withTimestamp(event)));
  } catch {
    // Socket died between the readyState check and send (backpressure / drop).
    sockets.delete(socket);
  }
}

export function broadcast(event: BroadcastEvent) {
  const payload = JSON.stringify(withTimestamp(event));
  for (const socket of sockets) {
    if (socket.readyState !== socket.OPEN) continue;
    try {
      socket.send(payload);
    } catch {
      sockets.delete(socket);
    }
  }
}

export function logAgent(sessionId: string, message: string, level: 'info' | 'warn' | 'error' = 'info') {
  broadcast({ type: 'agent_log', sessionId, level, message });
}
