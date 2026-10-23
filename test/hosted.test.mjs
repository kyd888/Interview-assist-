import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedAPI } from '../lib/hosted-api.mjs';
import { readEvents } from '../public/stream.js';
import { config } from '../netlify/functions/api.mjs';

const token = 'test-access-token-with-enough-characters';
const env = { OPENAI_API_KEY: 'test-secret', APP_ACCESS_TOKEN: token };
const request = (path = '/api/suggest', options = {}) => new Request('https://example.netlify.app' + path, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ question: 'Tell me about yourself.', facts: 'I test cable runs.' }), ...options
});
const provider = events => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
const delta = { type: 'response.output_text.delta', delta: 'Opening sentence.' };
const completed = { type: 'response.completed' };

test('Netlify routes and platform rate limit are configured', () => {
  assert.deepEqual(config.path, ['/api/config', '/api/suggest']);
  assert.equal(config.rateLimit.windowLimit, 30);
});
test('hosted readiness requires both secrets, reveals neither', async () => {
  for (const settings of [{}, { OPENAI_API_KEY: 'test-secret' }, env]) {
    const result = await createHostedAPI({ env: settings })(new Request('https://example.netlify.app/api/config'));
    const data = await result.json(); assert.equal(data.ready, settings === env); assert.equal(data.needsToken, true);
    assert(!JSON.stringify(data).includes('test-secret')); assert(!JSON.stringify(data).includes(token));
  }
});
test('public requests fail closed without a strong configured token', async () => {
  let calls = 0;
  for (const value of ['', 'short']) {
    const api = createHostedAPI({ env: { OPENAI_API_KEY: 'test-secret', APP_ACCESS_TOKEN: value }, fetchImpl: () => { calls++; } });
    assert.equal((await api(request())).status, 503);
  }
  const api = createHostedAPI({ env, fetchImpl: () => { calls++; } });
  assert.equal((await api(request('/api/suggest', { headers: { 'Content-Type': 'application/json' } }))).status, 401);
  assert.equal(calls, 0);
});
test('hosted endpoint rejects origin mismatch, wrong methods and invalid bodies', async () => {
  const api = createHostedAPI({ env, fetchImpl: () => { throw new Error('should not reach provider'); } });
  assert.equal((await api(request('/api/suggest', { headers: { Origin: 'https://other.invalid' } }))).status, 403);
  assert.equal((await api(new Request('https://example.netlify.app/api/suggest'))).status, 405);
  assert.equal((await api(request('/api/unknown'))).status, 404);
  assert.equal((await api(request('/api/suggest', { body: '{' }))).status, 400);
  assert.equal((await api(request('/api/suggest', { body: JSON.stringify({ question: '' }) }))).status, 400);
  assert.equal((await api(request('/api/suggest', { body: 'x'.repeat(48001) }))).status, 413);
});
test('hosted output is an SSE stream with grounding and no stored response', async () => {
  let payload;
  const api = createHostedAPI({ env, fetchImpl: async (_, options) => { payload = JSON.parse(options.body); return provider([delta, completed]); } });
  const result = await api(request()); const events = []; for await (const e of readEvents(result.body)) events.push(e);
  assert.deepEqual(events, [{ type: 'delta', text: 'Opening sentence.' }, { type: 'done' }]);
  assert.equal(result.headers.get('Content-Type'), 'text/event-stream'); assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(payload.store, false); assert.match(payload.instructions, /Never invent/);
});
test('hosted errors and incomplete output cannot masquerade as finished answers', async () => {
  for (const events of [[delta], [delta, { type: 'response.incomplete' }], [completed], [{ type: 'response.failed' }]]) {
    const api = createHostedAPI({ env, fetchImpl: async () => provider(events) }); const result = await api(request());
    const text = await result.text(); assert.match(text, /"type":"error"/); assert(!text.includes('"type":"done"'));
  }
  const api = createHostedAPI({ env, fetchImpl: async () => new Response('test-secret internal error', { status: 401 }) });
  const result = await api(request()); assert.equal(result.status, 502); assert(!(await result.text()).includes('test-secret'));
});
test('hosted timeout aborts the provider request', async () => {
  let aborted = false;
  const api = createHostedAPI({ env, timeoutMs: 10, fetchImpl: async (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('stopped')); });
  }) });
  const result = await api(request()); assert.equal(result.status, 502); assert(aborted);
});
test('cancelling hosted response cancels upstream work', async () => {
  let aborted = false;
  const api = createHostedAPI({ env, fetchImpl: async (_, { signal }) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta)}\n\n`));
    signal.addEventListener('abort', () => { aborted = true; controller.close(); });
  } })) });
  const result = await api(request()); const reader = result.body.getReader(); await reader.read(); await reader.cancel(); assert(aborted);
});
