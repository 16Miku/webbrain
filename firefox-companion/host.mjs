#!/usr/bin/env node
import { BidiSession } from './session.mjs';
const session = new BidiSession();
let buffer = Buffer.alloc(0);
function reply(value) {
  const data = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
  process.stdout.write(Buffer.concat([header, data]));
}
async function dispatch(message) {
  const { id, command, ...args } = message;
  try {
    let result;
    switch (command) {
      case 'connect': result = await session.connect(args.port); break;
      case 'openRun': result = await session.openRun(args.runId, args.token, args.url); break;
      case 'closeRun': result = await session.closeRun(args.runId); break;
      case 'perform': result = await session.perform(args.runId, args.action, args.payload || {}); break;
      default: throw new Error('Unknown companion command');
    }
    reply({ id, result });
  } catch (error) { reply({ id, error: error.message }); }
}
process.stdin.on('data', data => {
  buffer = Buffer.concat([buffer, data]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (length > 40 * 1024 * 1024) process.exit(1);
    if (buffer.length < length + 4) break;
    const data = buffer.subarray(4, length + 4); buffer = buffer.subarray(length + 4);
    try { void dispatch(JSON.parse(data)); } catch { process.exit(1); }
  }
});
process.stdin.on('end', () => { void session.close().finally(() => process.exit()); });
