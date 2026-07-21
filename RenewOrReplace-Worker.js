/**
 * Renew or Replace — Cloudflare Worker Proxy (Google Gemini backend — free tier)
 *
 * SETUP (one-time, ~5 minutes):
 * ──────────────────────────────
 * 1. Get a free Gemini API key (no credit card required):
 *    https://aistudio.google.com/apikey
 * 2. Go to https://workers.cloudflare.com  →  sign up free
 * 3. Click "Create a Worker"
 * 4. Delete all existing code in the editor and paste THIS entire file
 * 5. Click "Save and Deploy"
 * 6. Copy your Worker URL (looks like: https://renew-or-replace.YOURNAME.workers.dev)
 *
 * ADD YOUR API KEY AS A SECRET:
 * 7. In the Worker dashboard → click "Settings" tab → "Variables and Secrets"
 * 8. Click "Add" →
 *    Name:  GEMINI_API_KEY
 *    Value: your key from aistudio.google.com/apikey
 * 9. Save (encrypted) and redeploy if prompted.
 *
 * PASTE YOUR WORKER URL INTO THE APP:
 * 10. Open RenewOrReplace.html → Settings → AI Proxy (Worker URL), paste the URL from step 6.
 *     Done — the app keeps working exactly as before, now backed by Gemini's free tier.
 */

// Newer flagship models (like gemini-3.5-flash) often ship with very tight
// free-tier quotas, so a busy key can get "high demand" on every single call,
// not just an occasional spike. Retrying the same model won't help with that.
// Fall back through progressively more available models instead.
const MODEL_CHAIN = ['gemini-3.5-flash', 'gemini-2.5-flash-lite'];
const RETRY_DELAYS_MS = [1000, 2000];

function isRetryableGeminiError(status, message) {
  if (status === 429 || status === 503) return true;
  const m = (message || '').toLowerCase();
  return m.includes('overloaded') || m.includes('high demand') || m.includes('unavailable');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callGeminiModel(model, geminiBody, apiKey) {
  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(geminiBody)
    }
  );

  const upstreamData = await upstream.json();

  if (upstream.ok) {
    return { ok: true, data: upstreamData };
  }

  const status = upstream.status;
  const message = upstreamData.error?.message || `Gemini error (HTTP ${status})`;
  return { ok: false, status, message };
}

async function callGeminiWithRetry(geminiBody, apiKey) {
  let lastResult;

  for (const model of MODEL_CHAIN) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const result = await callGeminiModel(model, geminiBody, apiKey);

      if (result.ok) return result;

      lastResult = result;

      if (attempt < RETRY_DELAYS_MS.length && isRetryableGeminiError(result.status, result.message)) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      break;
    }
    // If the last model's failure wasn't demand-related (e.g. bad request,
    // blocked content), there's no reason to expect a different model to help.
    if (!isRetryableGeminiError(lastResult.status, lastResult.message)) break;
  }

  return lastResult;
}

export default {
  async fetch(request, env) {

    // ── CORS preflight ──
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (!env.GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({ error: { message: 'Gemini API key not configured in Worker secrets. See setup instructions.' } }),
        { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      );
    }

    try {
      const body = await request.json();

      // The app sends an Anthropic-Messages-shaped request — translate it to Gemini's format.
      // The image block is optional (text-only "goal/known issues" submissions are allowed);
      // the text block (analysis instructions) is always required.
      const userMessage = body.messages?.[0];
      const blocks = Array.isArray(userMessage?.content) ? userMessage.content : [];
      const imageBlock = blocks.find(b => b.type === 'image');
      const textBlock = blocks.find(b => b.type === 'text');

      if (!textBlock) {
        return new Response(
          JSON.stringify({ error: { message: 'Request missing text content.' } }),
          { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
        );
      }

      const parts = [];
      if (imageBlock) {
        parts.push({ inline_data: { mime_type: imageBlock.source.media_type, data: imageBlock.source.data } });
      }
      parts.push({ text: textBlock.text });

      const geminiBody = {
        contents: [{ parts }],
        generationConfig: {
          maxOutputTokens: body.max_tokens || 8192
        }
      };

      const result = await callGeminiWithRetry(geminiBody, env.GEMINI_API_KEY);

      if (!result.ok) {
        return new Response(
          JSON.stringify({ error: { message: result.message } }),
          { status: result.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
        );
      }

      const upstreamData = result.data;

      const text = (upstreamData.candidates?.[0]?.content?.parts || [])
        .map(p => p.text || '').join('');

      if (!text) {
        const blockReason = upstreamData.promptFeedback?.blockReason;
        return new Response(
          JSON.stringify({ error: { message: blockReason ? `Gemini blocked the request: ${blockReason}` : 'Gemini returned an empty response.' } }),
          { status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
        );
      }

      // Reshape into the Anthropic-style envelope the app already knows how to parse.
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text }] }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      );

    } catch (err) {
      return new Response(
        JSON.stringify({ error: { message: err.message || 'Worker error' } }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        }
      );
    }
  }
};
