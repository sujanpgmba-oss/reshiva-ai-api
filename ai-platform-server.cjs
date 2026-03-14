/**
 * AI Platform Backend (Express.js)
 *
 * This server is designed to run as a single-node backend for the AI platform
 * (B2C + B2B + BYOK) and includes:
 *   - API key selection logic (personal, platform, institution)
 *   - Usage logging (ai_usage_logs)
 *   - Quota / expiry checks
 *   - Provider proxying (OpenAI-compatible)
 *
 * DEPLOYMENT (Render):
 *   1. Set environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   2. (Optional) Set CORS_ORIGIN to restrict to your frontend URL.
 *   3. Add a Render service using `node ai-platform-server.js`.
 *
 * NOTE: This file is intentionally standalone so it can coexist with the existing
 * backend-server.js (HMS proxy) in the same repo.
 */

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

// Node 18+ includes fetch globally. For older Node versions, fall back to node-fetch.
let fetchFn = globalThis.fetch;
if (!fetchFn) {
  fetchFn = require('node-fetch');
}

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3001);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('⚠️ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// In-memory cache to reduce DB hits (good for short-lived config / key lookups)
// NOTE: For multi-instance scaling, replace with Redis/ElastiCache.
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 30_000);
const cacheStore = new Map();

function cacheKey(namespace, key) {
  return `${namespace}:${key}`;
}

function cacheGet(key) {
  const entry = cacheStore.get(key);
  if (!entry) return { found: false, value: null };
  if (entry.expiresAt < Date.now()) {
    cacheStore.delete(key);
    return { found: false, value: null };
  }
  return { found: true, value: entry.value };
}

function cacheSet(key, value, ttl = CACHE_TTL_MS) {
  cacheStore.set(key, {
    value,
    expiresAt: Date.now() + ttl,
  });
}

async function cacheFetch(key, ttl, fetcher) {
  const cached = cacheGet(key);
  if (cached.found) return cached.value;

  const value = await fetcher();
  // Cache the result even if it is null (to avoid repeated DB hits on missing records)
  cacheSet(key, value, ttl);
  return value;
}

async function cacheFetchDebug(key, ttl, fetcher) {
  const cached = cacheGet(key);
  if (cached.found) {
    return { value: cached.value, cached: true };
  }

  const value = await fetcher();
  cacheSet(key, value, ttl);
  return { value, cached: false };
}

function clearCache(namespace) {
  for (const key of cacheStore.keys()) {
    if (key.startsWith(`${namespace}:`)) {
      cacheStore.delete(key);
    }
  }
}

app.use(express.json());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
  })
);

const DEFAULT_COST_PER_1K_TOKENS = 0.002; // USD per 1k tokens (approx)

function toCents(usd) {
  return Math.round(usd * 100);
}

function formatDate(date) {
  if (!date) return null;
  return new Date(date).toISOString();
}

function isExpired(timestamp) {
  if (!timestamp) return false;
  const ts = new Date(timestamp);
  if (Number.isNaN(ts.getTime())) return false;
  return ts.getTime() < Date.now();
}

async function queryOne(table, cols, filter) {
  const { data, error } = await supabase
    .from(table)
    .select(cols)
    .match(filter)
    .limit(1)
    .single();
  if (error && error.code !== 'PGRST116') {
    throw error;
  }
  return data || null;
}

async function cachedQueryOne(table, cols, filter, ttl = CACHE_TTL_MS) {
  const key = cacheKey(table, JSON.stringify({ cols, filter }));
  return cacheFetch(key, ttl, () => queryOne(table, cols, filter));
}

async function resolveUserContext({ userId, facultyId }) {
  // Returns a context object including provider/model/apiVersion and the selected key + metadata.
  // If both userId + facultyId are provided, faculty takes precedence.
  const ctx = {
    userId: userId || null,
    facultyId: facultyId || null,
    keySource: null,
    apiKey: null,
    provider: null,
    model: null,
    apiVersion: null,
    institutionId: null,
    costMultiplier: 1,
    disabledReason: null,
    debug: {
      cache: [],
      selected: null,
    },
  };

  function maskKey(key) {
    if (!key || typeof key !== 'string') return '';
    if (key.length <= 8) return key.replace(/.(?=.{2})/g, '*');
    return key.slice(0, 4) + '…' + key.slice(-4);
  }

  function logSelection() {
    if (!ctx.keySource || !ctx.provider || !ctx.model) return;
    console.log('✅ AI key selected', {
      source: ctx.keySource,
      provider: ctx.provider,
      model: ctx.model,
      apiVersion: ctx.apiVersion,
      apiKey: maskKey(ctx.apiKey),
      cache: ctx.debug.cache,
    });
  }


  // 1) Faculty (if provided)
  if (facultyId) {
    const { value: faculty, cached: facultyCached } = await cacheFetchDebug(
      cacheKey('faculty_profiles_upv', JSON.stringify({ user_id: facultyId })),
      CACHE_TTL_MS,
      () => queryOne('faculty_profiles_upv', '*', { user_id: facultyId })
    );

    if (!faculty) {
      ctx.disabledReason = 'faculty_not_found';
      return ctx;
    }

    // If faculty is linked to an institution, keep it so we can inherit defaults
    ctx.institutionId = faculty.institution_id || null;

    // 1a) personal faculty key
    if (faculty.use_personal_api_key && faculty.personal_api_key) {
      ctx.apiKey = faculty.personal_api_key;
      ctx.provider = faculty.personal_provider;
      ctx.model = faculty.personal_model;
      ctx.apiVersion = faculty.personal_api_version;
      ctx.keySource = 'faculty_personal';
      ctx.debug.selected = {
        source: 'faculty_personal',
        provider: ctx.provider,
        model: ctx.model,
        cache: facultyCached,
      };
      logSelection();
      return ctx;
    }

    // 1b) platform subscription key
    const { value: subscription, cached: subscriptionCached } = await cacheFetchDebug(
      cacheKey('faculty_subscriptions', facultyId),
      CACHE_TTL_MS,
      async () => {
        const { data, error } = await supabase
          .from('faculty_subscriptions')
          .select('*')
          .eq('faculty_id', facultyId)
          .order('updated_at', { ascending: false })
          .limit(1)
          .single();

        if (error && error.code !== 'PGRST116') {
          throw error;
        }
        return data || null;
      }
    );

    if (subscription && subscription.platform_api_key) {
      ctx.apiKey = subscription.platform_api_key;
      ctx.provider = subscription.platform_provider;
      ctx.model = subscription.platform_model;
      ctx.apiVersion = subscription.platform_api_version;
      ctx.keySource = 'faculty_subscription';
      ctx.debug.selected = {
        source: 'faculty_subscription',
        provider: ctx.provider,
        model: ctx.model,
        cache: subscriptionCached,
      };
      logSelection();
      return ctx;
    }

    ctx.disabledReason = 'no_faculty_key_available';
    return ctx;
  }

  // 2) Student
  if (userId) {
    const { value: profile, cached: profileCached } = await cacheFetchDebug(
      cacheKey('profiles', JSON.stringify({ id: userId })),
      CACHE_TTL_MS,
      () => queryOne('profiles', '*', { id: userId })
    );
    if (!profile) {
      ctx.disabledReason = 'student_not_found';
      return ctx;
    }

    ctx.institutionId = profile.institution_id || null;

    // 2a) personal student key
    if (profile.use_personal_api_key && profile.personal_api_key) {
      ctx.apiKey = profile.personal_api_key;
      ctx.provider = profile.personal_provider;
      ctx.model = profile.personal_model;
      ctx.apiVersion = profile.personal_api_version;
      ctx.keySource = 'student_personal';
      ctx.debug.selected = {
        source: 'student_personal',
        provider: ctx.provider,
        model: ctx.model,
        cache: profileCached,
      };
      logSelection();
      return ctx;
    }

    // 2b) platform-per-user key (app mode)
    const { value: verification, cached: verificationCached } = await cacheFetchDebug(
      cacheKey('student_institution_verification', userId),
      CACHE_TTL_MS,
      async () => {
        const { data, error } = await supabase
          .from('student_institution_verification')
          .select('*')
          .eq('student_id', userId)
          .limit(1)
          .single();

        if (error && error.code !== 'PGRST116') {
          throw error;
        }
        return data || null;
      }
    );

    if (!verification) {
      ctx.disabledReason = 'student_not_verified';
    } else {
      const v = verification;
      // If the student has an app-mode platform key, prefer it
      if (v.platform_api_key && v.platform_api_key_enabled && !isExpired(v.platform_api_key_expires_at)) {
        ctx.apiKey = v.platform_api_key;
        ctx.provider = v.platform_provider;
        ctx.model = v.platform_model;
        ctx.apiVersion = v.platform_api_version;
        ctx.keySource = 'student_platform';
        ctx.costMultiplier = v.cost_multiplier || ctx.costMultiplier;
        ctx.debug.selected = {
          source: 'student_platform',
          provider: ctx.provider,
          model: ctx.model,
          cache: verificationCached,
        };
        logSelection();
        return ctx;
      }

      // Fallback to institution defaults (B2B) if available
      if (ctx.institutionId) {
        const { value: inst, cached: institutionCached } = await cacheFetchDebug(
          cacheKey('institutions', JSON.stringify({ id: ctx.institutionId })),
          CACHE_TTL_MS,
          () => queryOne('institutions', '*', { id: ctx.institutionId })
        );
        if (inst) {
          ctx.costMultiplier = inst.cost_multiplier || ctx.costMultiplier;

          // B2B app-mode: use platform key
          if (inst.b2b_model === 'app' && inst.platform_api_key && inst.platform_api_key_enabled && !isExpired(inst.platform_api_key_expires_at)) {
            ctx.apiKey = inst.platform_api_key;
            ctx.provider = inst.platform_provider;
            ctx.model = inst.platform_model;
            ctx.apiVersion = inst.platform_api_version;
            ctx.keySource = 'institution_platform';
            ctx.debug.selected = {
              source: 'institution_platform',
              provider: ctx.provider,
              model: ctx.model,
              cache: institutionCached,
            };
            logSelection();
            return ctx;
          }

          // B2B BYOK: use institution default/buyown key
          if (inst.b2b_model === 'byok' && inst.default_api_key && inst.default_api_key_enabled && !isExpired(inst.default_api_key_expires_at)) {
            ctx.apiKey = inst.default_api_key;
            ctx.provider = inst.default_provider;
            ctx.model = inst.default_model;
            ctx.apiVersion = inst.default_api_version;
            ctx.keySource = 'institution_byok';
            ctx.debug.selected = {
              source: 'institution_byok',
              provider: ctx.provider,
              model: ctx.model,
              cache: institutionCached,
            };
            logSelection();
            return ctx;
          }

          // Fallback: try using institution platform key even if b2b_model not set
          if (inst.platform_api_key && inst.platform_api_key_enabled && !isExpired(inst.platform_api_key_expires_at)) {
            ctx.apiKey = inst.platform_api_key;
            ctx.provider = inst.platform_provider;
            ctx.model = inst.platform_model;
            ctx.apiVersion = inst.platform_api_version;
            ctx.keySource = 'institution_platform_fallback';
            ctx.debug.selected = {
              source: 'institution_platform_fallback',
              provider: ctx.provider,
              model: ctx.model,
              cache: institutionCached,
            };
            logSelection();
            return ctx;
          }
        }
      }

      if (!ctx.apiKey) {
        ctx.disabledReason = 'no_valid_key_found';
      }
    }

    return ctx;
  }

  ctx.disabledReason = 'missing_user_or_faculty_id';
  return ctx;
}

function normalizeProvider(provider) {
  if (!provider) return 'openai';
  return provider.toLowerCase();
}

function getCostPer1kTokens(model) {
  // These are rough estimates to help with cost tracking.
  const map = {
    'gpt-4': 0.06,
    'gpt-4.1': 0.06,
    'gpt-4o': 0.03,
    'gpt-4o-mini': 0.01,
    'gpt-3.5-turbo': 0.002,
    'gpt-3.5-turbo-16k': 0.003,
  };
  if (!model) return DEFAULT_COST_PER_1K_TOKENS;
  const normalized = model.toLowerCase();
  return map[normalized] ?? DEFAULT_COST_PER_1K_TOKENS;
}

function estimateCostCents({ model, tokensIn, tokensOut, multiplier }) {
  const per1k = getCostPer1kTokens(model);
  const tokens = (tokensIn || 0) + (tokensOut || 0);
  const usd = (tokens / 1000) * per1k * (multiplier || 1);
  return toCents(usd);
}

async function logUsage({
  userId,
  facultyId,
  institutionId,
  verificationId,
  appSubscriptionId,
  facultySubscriptionId,
  workflow,
  provider,
  model,
  apiVersion,
  tokensIn,
  tokensOut,
  estimatedCostCents,
}) {
  await supabase.from('ai_usage_logs').insert([{
    user_id: userId,
    faculty_id: facultyId,
    institution_id: institutionId,
    verification_id: verificationId,
    app_subscription_id: appSubscriptionId,
    faculty_subscription_id: facultySubscriptionId,
    workflow,
    provider,
    model,
    api_version: apiVersion,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    estimated_cost_cents: estimatedCostCents,
  }]);
}

async function proxyToProvider({
  provider,
  apiKey,
  model,
  apiVersion,
  payload,
}) {
  const normalized = normalizeProvider(provider);

  // --- OpenAI ---
  if (normalized === 'openai') {
    const url = `https://api.openai.com/v1/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };

    const body = {
      model,
      ...payload,
    };

    const res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (err) {
      console.warn('⚠️ OpenAI response is not valid JSON (may be empty):', text);
      data = { raw: text };
    }

    console.log('🔁 proxy response', {
      provider: 'openai',
      model,
      status: res.status,
      snippet: text ? text.slice(0, 400) : '',
    });

    return { status: res.status, data };
  }

  // --- Gemini (Google Generative Language API) ---
  if (normalized === 'gemini' || normalized === 'google') {
    // Gemini is hosted under v1beta2; API key is passed via query param.
    // Normalize common version values (e.g. `v1beta` -> `v1beta2`).
    const geminiApiVersion = apiVersion && apiVersion.startsWith('v') ? apiVersion : 'v1beta2';
    const normalizedGeminiApiVersion = geminiApiVersion === 'v1beta' ? 'v1beta2' : geminiApiVersion;
    const url = `https://generativelanguage.googleapis.com/${normalizedGeminiApiVersion}/models/${model}:generateMessage?key=${apiKey}`;
    const headers = {
      'Content-Type': 'application/json',
    };

    const messages = (payload?.messages || []).map((m) => {
      const author = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
      return {
        author,
        content: {
          type: 'text',
          text: m.content,
        },
      };
    });

    const body = {
      model,
      messages,
      ...(payload?.temperature ? { temperature: payload.temperature } : {}),
      ...(payload?.max_tokens ? { maxOutputTokens: payload.max_tokens } : {}),
    };

    const res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    let text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (err) {
      console.warn('⚠️ Gemini response is not valid JSON (may be empty):', text);
      data = { raw: text };
    }

    // ### Fallback: some Gemini endpoints expect `generateText` style payloads
    if (
      res.status === 400 &&
      typeof text === 'string' &&
      text.includes('Unknown name "messages"')
    ) {
      const prompt = (payload?.messages || [])
        .map((m) => {
          const role = m.role === 'assistant' ? 'Assistant' : 'User';
          return `${role}: ${m.content}`;
        })
        .join('\n');

      const fallbackUrl = `https://generativelanguage.googleapis.com/${geminiApiVersion}/models/${model}:generateText?key=${apiKey}`;
      const fallbackBody = {
        instances: [{ input: prompt }],
        ...(payload?.temperature ? { temperature: payload.temperature } : {}),
        ...(payload?.max_tokens ? { maxOutputTokens: payload.max_tokens } : {}),
      };

      const fallbackRes = await fetchFn(fallbackUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(fallbackBody),
      });

      const fallbackText = await fallbackRes.text();
      let fallbackData = null;
      try {
        fallbackData = fallbackText ? JSON.parse(fallbackText) : null;
      } catch (err) {
        console.warn('⚠️ Gemini generateText response is not valid JSON:', fallbackText);
        fallbackData = { raw: fallbackText };
      }

      console.log('🔁 proxy response (Gemini fallback generateText)', {
        provider: 'gemini',
        model,
        status: fallbackRes.status,
        snippet: fallbackText ? fallbackText.slice(0, 400) : '',
      });

      return { status: fallbackRes.status, data: fallbackData };
    }

    console.log('🔁 proxy response', {
      provider: 'gemini',
      model,
      status: res.status,
      snippet: text ? text.slice(0, 400) : '',
    });

    return { status: res.status, data };
  }

  // --- Claude (Anthropic) ---
  if (normalized === 'claude' || normalized === 'anthropic') {
    const url = `https://api.anthropic.com/v1/complete`;
    const headers = {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    };

    // Convert chat messages into a single prompt
    const messages = payload?.messages || [];
    const prompt = messages
      .map((m) => {
        const role = m.role === 'assistant' ? 'Assistant' : 'Human';
        return `${role}: ${m.content}`;
      })
      .join('\n') + '\nAssistant:';

    const body = {
      model,
      prompt,
      ...(payload?.max_tokens ? { max_tokens_to_sample: payload.max_tokens } : {}),
      ...(payload?.temperature ? { temperature: payload.temperature } : {}),
    };

    const res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (err) {
      console.warn('⚠️ Claude response is not valid JSON (may be empty):', text);
      data = { raw: text };
    }

    console.log('🔁 proxy response', {
      provider: 'claude',
      model,
      status: res.status,
      snippet: text ? text.slice(0, 400) : '',
    });

    return { status: res.status, data };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * POST /api/ai/request
 * Body: { userId?, facultyId?, workflow, payload }
 * - payload is provider-specific request body (e.g., messages for OpenAI Chat)
 */
app.post('/api/ai/request', async (req, res) => {
  try {
    const { userId, facultyId, workflow, payload } = req.body || {};
    if (!workflow) {
      return res.status(400).json({ error: 'Missing required field: workflow' });
    }

    const context = await resolveUserContext({ userId, facultyId });
    if (!context.apiKey || context.disabledReason) {
      return res.status(403).json({
        error: 'No valid API key available',
        reason: context.disabledReason || 'no_key',
      });
    }

    // Allow caller to override provider/model/apiVersion via payload (optional)
    const provider = payload?.provider || context.provider || 'openai';
    const model = payload?.model || context.model || 'gpt-3.5-turbo';
    const apiVersion = payload?.apiVersion || context.apiVersion || '2024-12-01';

    const result = await proxyToProvider({
      provider,
      apiKey: context.apiKey,
      model,
      apiVersion,
      payload,
    });

    // Attempt to estimate tokens from OpenAI response
    let tokensIn = 0;
    let tokensOut = 0;

    if (result.data?.usage) {
      tokensIn = Number(result.data.usage.prompt_tokens || 0);
      tokensOut = Number(result.data.usage.completion_tokens || 0);
    }

    const estimatedCostCents = estimateCostCents({
      model,
      tokensIn,
      tokensOut,
      multiplier: context.costMultiplier,
    });

    await logUsage({
      userId,
      facultyId,
      institutionId: context.institutionId,
      verificationId: null,
      appSubscriptionId: null,
      facultySubscriptionId: null,
      workflow,
      provider,
      model,
      apiVersion,
      tokensIn,
      tokensOut,
      estimatedCostCents,
    });

    res.status(result.status).json(result.data);
  } catch (error) {
    console.error('❌ /api/ai/request error', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 AI platform backend listening on http://localhost:${PORT}`);
});
