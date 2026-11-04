/**
 * Minimal server-sent events writer. Browsers read the stream with the
 * built-in EventSource; each `send` becomes one named event with a JSON
 * payload. A comment line is written periodically so proxies and browsers
 * do not drop an idle connection.
 */
export function openEventStream(res, { heartbeatMs = 15_000 } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();

  let closed = false;
  const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
  res.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
  });

  return {
    send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      res.end();
    },
  };
}
