import type { ServerResponse } from 'node:http';
import type { Emit, StreamEvent } from '../graph/types.js';

export function createEmitter(res: ServerResponse): Emit {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  return (event: StreamEvent) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`${JSON.stringify(event)}\n`);
  };
}
