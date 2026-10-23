# Interview Assist

A focused interview practice and notes companion for a laptop or phone. Type a question or dictate it, then get a short opening sentence and a few supporting talking points streamed onto a large, readable card.

## Run on your laptop

Install **Node.js 22 or newer**, then:

```sh
git clone https://github.com/kyd888/Interview-assist-.git
cd Interview-assist-
npm start
```

Open **http://localhost:3210**. There are no packages to install. Saved cards, editable notes, exports, and Copy prompt for ChatGPT work without an API key. Keep the terminal running while using the app.

1. Open **My experience**, enter your actual background and one concrete example, and save.
2. Edit the starter frameworks into your own saved talking points.
3. Enter a question and choose **Suggest an answer** (or Ctrl/Cmd + Enter).
4. Use **Make it shorter**, **Next point**, text size controls, and **Focus view** as needed. Escape stops an active response or exits focus. **Copy prompt for ChatGPT** copies your question and notes for manual use in ChatGPT.

## Connect live AI

Copy `.env.example` to `.env` using your file manager or `cp .env.example .env` (PowerShell: `Copy-Item .env.example .env`). Open the new file and set:

```dotenv
OPENAI_API_KEY=your_api_key_here
OPENAI_MODEL=gpt-5.6-terra
OPENAI_REASONING_EFFORT=none
```

Restart `npm start`. The key stays on the server and is never sent to the browser or included in exports. Do not commit `.env` or paste your key into the app’s access-token field. OpenAI API billing and model access are separate from a ChatGPT subscription. Configure billing and limits in your OpenAI account before use.

The default model supports `none` reasoning effort for a fast first response. You can change model and effort together to values supported by your account; set effort to an empty value to omit it. Actual latency depends on model access, load, question length, and network conditions. The interface reports time to first words; no fixed response-time guarantee.

If the key, model, network, or usage limit fails, the app displays an error and leaves saved cards available. It does not simulate an AI answer. Stop and starting a new suggestion cancel the prior server request; already processed tokens can still be billed.

## Phone on the same Wi-Fi

The laptop runs the server; the phone opens its web interface. Both devices need to stay on the same trusted local network, and the laptop must remain awake.

1. Generate a random access token: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.
2. Put that value in `.env` as `APP_ACCESS_TOKEN=...` (at least 24 characters).
3. Run `npm start -- --lan`. The terminal prints the laptop’s network URL, such as `http://192.168.1.10:3210`.
4. Open that printed URL on your phone. In **Setup**, enter the **app access token**, not the OpenAI key.
5. Export notes from your laptop and import the file on your phone if needed. Notes are browser-local; they do not automatically synchronize.

Allow the Node process on your private-network firewall if necessary. Guest/work Wi-Fi may isolate devices. Local HTTP is not encrypted: use this LAN option only on a trusted private network, never port-forward it or expose it publicly. For mic access on a phone, use keyboard dictation or a separately configured trusted HTTPS connection. This project does not configure HTTPS hosting or a tunnel.

## Voice input

**Dictate question** uses browser speech recognition, where available, with a visible microphone state. Click again to finish, review the text, and request a suggestion. Listening stops after 60 seconds or when the page is hidden. A browser may send audio to its own speech service. Keyboard dictation, typing, and pasting remain available when browser recognition is unsupported or permission is denied.

This is microphone dictation, not automatic Teams audio capture. It will not hear the interviewer through your headphones. Capture another speaker only with their permission. Use AI during an interview only when permitted; saved notes and mock practice are useful before the meeting too. No stealth overlay, hidden recording, or screen-sharing evasion is included.

## What is stored and sent

- Your profile and saved cards are stored in this browser’s `localStorage`. Private browsing, clearing site data, or moving to a different URL/device can remove or separate them. Export a backup.
- Exported JSON includes your notes and saved cards, but not access tokens, API keys, or unsaved generated answers. Keep exports private; do not add them to this public repository.
- AI requests send the question, role, background, job details, and (for a follow-up) prior answer to OpenAI through the laptop server. The server does not write them to disk or application logs. Responses use `store: false`; this does not override OpenAI’s other applicable data-retention policies.
- Only user-clicked requests call the API. There is no passive meeting listening, cross-device session relay, or connection to your ChatGPT account/history.
- Instructions ground personal claims in supplied facts and distinguish actual experience from hypothetical approaches. These are model instructions, not a guarantee: review suggestions and do not present invented qualifications.

## Development and verification

```sh
npm test
npm run dev
```

`npm run dev` is a UI preview on port 4173 with AI disabled, regardless of API key environment variables. Normal use is `npm start`.

The zero-dependency Node test suite uses mocked OpenAI responses. It covers streaming across arbitrary UTF-8 boundaries, validation, host/origin and token checks, missing credentials, provider errors, partial/refused responses, cancellation, and timeouts. These tests do not establish real API availability or microphone compatibility. Make a short live test with your own key and browser before relying on it.

## API references

- [Streaming Responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
- [Browser SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)
