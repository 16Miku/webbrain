#!/usr/bin/env node
// Minimal local WebSocket backend for the Cloud Bridge browser approval flow.
// Dependency-free (RFC 6455 text frames only). For local testing, not production.
//
//   node examples/cloud-bridge-approval-server.mjs --token dev-token [--port 17374] [--auto-approve]
//
// Interactive commands on stdin once a browser is pending/approved:
//   approve | reject | run <task> | status [runId] | send {"id":"1","action":"cloud_status","payload":{"runId":"run_x"}}

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(text) {
  const payload = Buffer.from(text);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n])
    : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255])
      : Buffer.concat([Buffer.from([0x81, 127]), Buffer.alloc(4), Buffer.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255])]);
  return Buffer.concat([head, payload]);
}

// Returns { messages, rest, close } for the frames buffered so far.
function decodeFrames(buf) {
  const messages = [];
  let close = false;
  while (buf.length >= 2) {
    const opcode = buf[0] & 15;
    let len = buf[1] & 127;
    let off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    const masked = (buf[1] & 128) !== 0;
    if (buf.length < off + (masked ? 4 : 0) + len) break;
    const mask = masked ? buf.subarray(off, off + 4) : null;
    if (masked) off += 4;
    const data = Buffer.from(buf.subarray(off, off + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    buf = buf.subarray(off + len);
    if (opcode === 8) { close = true; break; }
    if (opcode === 1) messages.push(data.toString('utf8'));
  }
  return { messages, rest: buf, close };
}

export function startApprovalServer({ port = 17374, host = '127.0.0.1', token = 'dev-token', autoApprove = false, onMessage = () => {} } = {}) {
  const sessions = new Set();
  const server = createServer((_req, res) => { res.writeHead(426).end(); });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${createHash('sha1').update(key + GUID).digest('base64')}`,
      '', '',
    ].join('\r\n'));
    const session = {
      socket,
      hello: null,
      state: 'connected',
      send: (obj) => socket.write(encodeFrame(JSON.stringify(obj))),
      approve() {
        session.state = 'approved';
        session.send({ type: 'connection_approved', browserId: session.hello?.browserId });
      },
      reject(reason = 'Rejected by user') {
        session.state = 'rejected';
        session.send({ type: 'connection_rejected', browserId: session.hello?.browserId, reason });
      },
    };
    sessions.add(session);
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      const decoded = decodeFrames(Buffer.concat([buffered, chunk]));
      buffered = decoded.rest;
      for (const text of decoded.messages) {
        let msg;
        try { msg = JSON.parse(text); } catch { continue; }
        if (msg.type === 'hello') {
          session.hello = msg;
          if (msg.auth?.token !== token || !msg.browserId) session.reject('Invalid token');
          else {
            session.state = 'pending';
            session.send({ type: 'connection_pending', browserId: msg.browserId });
            if (autoApprove) session.approve();
          }
        }
        onMessage(msg, session);
      }
      if (decoded.close) socket.end();
    });
    socket.on('close', () => sessions.delete(session));
    socket.on('error', () => sessions.delete(session));
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({
    port: server.address().port,
    sessions,
    close: () => new Promise((done) => {
      for (const s of sessions) s.socket.destroy();
      server.closeAllConnections?.();
      server.close(done);
    }),
  })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const srv = await startApprovalServer({
    port: Number(opt('--port', 17374)),
    token: opt('--token', 'dev-token'),
    autoApprove: args.includes('--auto-approve'),
    onMessage: (msg) => console.log('<-', JSON.stringify(msg)),
  });
  console.log(`Listening on ws://127.0.0.1:${srv.port}/extension`);
  const current = () => [...srv.sessions].at(-1);
  createInterface({ input: process.stdin }).on('line', (line) => {
    const session = current();
    if (!session) return console.log('No browser connected.');
    if (line === 'approve') session.approve();
    else if (line === 'reject') session.reject();
    else if (line.startsWith('run ')) session.send({ id: `run-${Date.now()}`, action: 'cloud_run', payload: { task: line.slice(4), mode: 'act' } });
    else if (line.startsWith('status')) session.send({ id: `st-${Date.now()}`, action: 'cloud_status', payload: line.slice(6).trim() ? { runId: line.slice(6).trim() } : {} });
    else if (line.startsWith('send ')) session.send(JSON.parse(line.slice(5)));
  });
}
