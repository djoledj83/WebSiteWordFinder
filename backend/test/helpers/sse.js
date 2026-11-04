import assert from 'node:assert/strict';

/** Reads a server-sent event stream until it ends; `onEvent` may react to each event. */
export async function readEvents(url, onEvent = async () => {}) {
  const response = await fetch(url);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const events = [];
  let buffer = '';
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let separator;
    while ((separator = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const event = parseEvent(raw);
      if (!event) continue; // heartbeat comment
      events.push(event);
      await onEvent(event);
    }
  }
  return events;
}

function parseEvent(raw) {
  let name = 'message';
  const data = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return null;
  return { name, data: JSON.parse(data.join('\n')) };
}
