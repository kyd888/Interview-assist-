// Shared by the browser and server. Handles SSE frames split at any byte boundary.
export async function* readEvents(body) {
  if (!body) throw new Error('The response did not include a stream.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (data && data !== '[DONE]') yield JSON.parse(data);
      }
      if (buffer.length > 1024 * 1024) throw new Error('Stream frame too large.');
      if (done) break;
    }
    if (buffer.trim()) throw new Error('The stream ended mid-message.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
