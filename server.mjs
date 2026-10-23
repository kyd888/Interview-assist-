import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { networkInterfaces } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { readEvents } from './public/stream.js';
import { validateInput, responseRequest } from './lib/prompts.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'],
  '/stream.js': ['stream.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'] };
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
function authorized(req, token) {
  if (!token) return true;
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function bodyJSON(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 48000) { const error = new Error('Request too large.'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new Error('Send valid JSON.'); }
}

export function createApp({ apiKey = '', model = 'gpt-5.6-terra', effort = 'none', token = '',
  allowedHosts = ['localhost', '127.0.0.1', '[::1]'], fetchImpl = fetch, timeoutMs = 45000 } = {}) {
  let active = 0;
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let url;
    try { url = new URL(req.url, `http://${req.headers.host}`); }
    catch { return json(res, 400, { error: 'Invalid request.' }); }
    if (!allowedHosts.includes(url.hostname)) return json(res, 403, { error: 'Unrecognized host.' });
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) throw new Error(); }
      catch { return json(res, 403, { error: 'Use this app from its own browser tab.' }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, { ready: Boolean(apiKey), model, needsToken: Boolean(token) });
    }
    if (req.method === 'GET' && files[url.pathname]) {
      const [name, type] = files[url.pathname];
      try { res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(await readFile(resolve(root, 'public', name))); }
      catch { res.end(); }
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/api/suggest') return json(res, 404, { error: 'Not found.' });
    if (!authorized(req, token)) return json(res, 401, { error: 'Enter the laptop access token in Setup.' });
    if (!apiKey) return json(res, 503, { error: 'Live AI needs an OpenAI API key in the laptop’s .env file. Saved cards and Copy prompt still work.' });
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'Send JSON content.' });
    if (active >= 2) return json(res, 429, { error: 'Two suggestions are already running. Stop one or try again shortly.' });
    let data;
    try { data = validateInput(await bodyJSON(req)); }
    catch (error) { return json(res, error.status || 400, { error: error.message }); }
    if (active >= 2) return json(res, 429, { error: 'Two suggestions are already running. Try again shortly.' });
    active++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    res.on('close', () => controller.abort());
    const send = event => { if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    try {
      const upstream = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(responseRequest(data, model, effort))
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        const message = upstream.status === 401 ? 'The API key was rejected. Check the laptop’s .env file.'
          : upstream.status === 429 ? 'OpenAI usage or rate limit reached. Check API billing or try again shortly.'
          : upstream.status === 400 || upstream.status === 404 ? 'OpenAI rejected the model or request settings. Check OPENAI_MODEL and OPENAI_REASONING_EFFORT.'
          : 'The AI service is unavailable. Use a saved card and try again.';
        return json(res, 502, { error: message });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      let completed = false, hasText = false;
      for await (const event of readEvents(upstream.body)) {
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          hasText = true; send({ type: 'delta', text: event.delta });
        } else if (event.type === 'response.completed') { completed = true; break; }
        else if (['error', 'response.failed', 'response.incomplete', 'response.refusal.delta'].includes(event.type)) {
          throw new Error('incomplete');
        }
      }
      if (!completed || !hasText) throw new Error('incomplete');
      send({ type: 'done' });
      res.end();
    } catch {
      const message = controller.signal.aborted ? 'The request stopped or timed out. Try again or use a saved card.'
        : 'The connection ended before the answer finished. Any visible text is incomplete.';
      if (!res.destroyed) {
        if (res.headersSent) { send({ type: 'error', message }); res.end(); }
        else json(res, 502, { error: message });
      }
    } finally { clearTimeout(timeout); active--; }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(resolve(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const preview = process.argv.includes('--preview');
  const lan = process.argv.includes('--lan');
  const port = preview ? 4173 : Number(process.env.PORT || 3210);
  const token = preview ? '' : process.env.APP_ACCESS_TOKEN || '';
  if (lan && token.length < 24) throw new Error('Set APP_ACCESS_TOKEN to at least 24 random characters before using --lan.');
  const addresses = Object.values(networkInterfaces()).flat().filter(x => x?.family === 'IPv4' && !x.internal).map(x => x.address);
  const app = createApp({
    apiKey: preview ? '' : process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
    effort: process.env.OPENAI_REASONING_EFFORT ?? 'none', token,
    allowedHosts: ['localhost', '127.0.0.1', '[::1]', ...(lan ? addresses : []), ...(preview ? ['terminal.local'] : [])]
  });
  app.listen(port, lan || preview ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(`Interview Assist: http://localhost:${port}`);
    if (preview) console.log('Preview mode: live AI disabled.');
    if (lan) for (const address of addresses) console.log(`Phone on the same trusted Wi-Fi: http://${address}:${port}`);
  });
}
