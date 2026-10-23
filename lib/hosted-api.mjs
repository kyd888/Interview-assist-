import { timingSafeEqual } from 'node:crypto';
import { readEvents } from '../public/stream.js';
import { validateInput, responseRequest } from './prompts.mjs';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (status, body) => Response.json(body, { status, headers });
function matchesToken(request, token) {
  const actual = Buffer.from(request.headers.get('Authorization') || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readBody(request) {
  if (!request.body) throw new Error('Send a question and your notes.');
  const reader = request.body.getReader(); let size = 0; const parts = [];
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 48000) { await reader.cancel(); const e = new Error('Request too large.'); e.status = 413; throw e; }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new Error('Send valid JSON.'); }
  return validateInput(parsed);
}

export function createHostedAPI({ env = {}, fetchImpl = fetch, timeoutMs = 45000 } = {}) {
  return async request => {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json(403, { error: 'Use the app from its own site.' });
    const apiKey = env.OPENAI_API_KEY || '';
    const token = env.APP_ACCESS_TOKEN || '';
    const tokenValid = token.length >= 24;
    const model = env.OPENAI_MODEL || 'gpt-5.6-terra';
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return json(200, { hosting: 'netlify', ready: Boolean(apiKey) && tokenValid,
        needsToken: true, needsServerToken: !tokenValid, needsApiKey: !apiKey, model });
    }
    if (url.pathname !== '/api/suggest') return json(404, { error: 'Not found.' });
    if (request.method !== 'POST') return json(405, { error: 'Use POST for suggestions.' });
    // Unlike loopback-only local mode, a hosted endpoint must always be locked.
    if (!tokenValid) return json(503, { error: 'Set APP_ACCESS_TOKEN (at least 24 random characters) in Netlify environment variables and redeploy.' });
    if (!matchesToken(request, token)) return json(401, { error: 'Enter your app access token in Setup. This is not your OpenAI API key.' });
    if (!apiKey) return json(503, { error: 'Set OPENAI_API_KEY in Netlify environment variables and redeploy. Saved cards still work.' });
    if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json(415, { error: 'Send JSON content.' });
    let data;
    try { data = await readBody(request); }
    catch (error) { return json(error.status || 400, { error: error.message }); }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) controller.abort();
    const timer = setTimeout(onAbort, timeoutMs);
    const cleanup = () => { clearTimeout(timer); request.signal.removeEventListener('abort', onAbort); };
    let upstream;
    try {
      upstream = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(responseRequest(data, model, env.OPENAI_REASONING_EFFORT ?? 'none'))
      });
      if (!upstream.ok) {
        await upstream.body?.cancel(); cleanup();
        return json(502, { error: upstream.status === 401 ? 'OpenAI rejected the API key. Check the Netlify environment variable.'
          : upstream.status === 429 ? 'OpenAI usage or rate limit reached. Check API billing or try again shortly.'
          : upstream.status === 400 || upstream.status === 404 ? 'OpenAI rejected the model or request settings. Check the Netlify model and reasoning settings.'
          : 'The AI service is unavailable. Use a saved card and try again.' });
      }
    } catch {
      cleanup();
      return json(502, { error: controller.signal.aborted ? 'The request stopped or timed out. Try again or use a saved card.' : 'Could not connect to the AI service. Use a saved card and try again.' });
    }
    const encoder = new TextEncoder(); let cancelled = false;
    const stream = new ReadableStream({
      async start(destination) {
        const send = event => { if (!cancelled) destination.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); };
        let completed = false, hasText = false;
        try {
          for await (const event of readEvents(upstream.body)) {
            if (cancelled) break;
            if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
              hasText = true; send({ type: 'delta', text: event.delta });
            } else if (event.type === 'response.completed') { completed = true; break; }
            else if (['error', 'response.failed', 'response.incomplete', 'response.refusal.delta'].includes(event.type)) throw new Error('incomplete');
          }
          if (!completed || !hasText) throw new Error('incomplete');
          send({ type: 'done' });
        } catch {
          send({ type: 'error', message: controller.signal.aborted ? 'The request stopped or timed out. Any visible text may be incomplete.' : 'The connection ended before the answer finished. Any visible text is incomplete.' });
        } finally { cleanup(); if (!cancelled) destination.close(); }
      },
      cancel() { cancelled = true; controller.abort(); cleanup(); }
    });
    return new Response(stream, { headers: { ...headers, 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' } });
  };
}
