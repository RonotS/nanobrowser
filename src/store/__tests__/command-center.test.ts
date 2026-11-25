import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** chrome.storage.local in memory, enough for createStorage. */
function stubChrome(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])),
        set: async (items: Record<string, unknown>) => void Object.assign(data, items),
        onChanged: { addListener: () => undefined },
      },
    },
    identity: { getRedirectURL: (path: string) => `https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/${path}` },
  });
  return data;
}

const BASE = 'https://cc.example';

function connection(overrides: Record<string, unknown> = {}) {
  return {
    url: BASE,
    clientId: 'client-1',
    accessToken: 'ks_oauth_at_old',
    refreshToken: 'ks_oauth_rt_1',
    expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    user: { id: 'm1', name: 'Aaron', email: 'a@example.com', role: 'developer' },
    models: [
      { provider: 'claude', name: 'claude-sonnet-5-5' },
      { provider: 'openai', name: 'gpt-6.2-sol' },
    ],
    defaultModel: { provider: 'claude', name: 'claude-sonnet-5-5' },
    tools: [],
    syncedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_COMMAND_CENTER_URL', BASE);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the tools Command Center lists', () => {
  it('leaves out the tools only Command Center’s own assistant can fill, and reads the read-only mark', async () => {
    stubChrome();
    const { usableTools } = await import('../command-center');
    const tools = usableTools([
      { name: 'list_clients', description: 'List clients.', annotations: { readOnlyHint: true } },
      { name: 'add_client_note', inputSchema: { type: 'object', required: ['clientId'] } },
      { name: 'remember', inputSchema: { type: 'object', required: ['text', 'memberToken'] } },
      { name: 'client_performance', inputSchema: { type: 'object', required: ['clientPass'] } },
    ]);
    expect(tools.map(t => [t.name, t.readOnly])).toEqual([
      ['list_clients', true],
      ['add_client_note', false],
    ]);
  });

  it('makes a PKCE pair Command Center can check (S256)', async () => {
    stubChrome();
    const { pkcePair } = await import('../command-center');
    const { verifier, challenge } = await pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });
});

describe('the provider cards', () => {
  it('makes one card per provider with models, pointed at Command Center, and drops every other provider', async () => {
    stubChrome();
    const { commandCenterProviders } = await import('../command-center-providers');
    const cards = commandCenterProviders(connection() as never, [
      { id: 'own-key', kind: 'openai', name: 'My OpenAI', models: [{ name: 'gpt-4o' }] },
    ]);
    expect(cards).toEqual([
      {
        id: 'cc-claude',
        kind: 'anthropic',
        name: 'Claude',
        baseUrl: `${BASE}/api/ai-browser/llm/anthropic`,
        models: [{ name: 'claude-sonnet-5-5' }],
      },
      {
        id: 'cc-openai',
        kind: 'openai',
        name: 'OpenAI',
        baseUrl: `${BASE}/api/ai-browser/llm/openai`,
        models: [{ name: 'gpt-6.2-sol' }],
      },
    ]);
    expect(commandCenterProviders(null, cards)).toEqual([]);
  });

  it('keeps what a run learnt about a model while the address is the same', async () => {
    stubChrome();
    const { commandCenterProviders } = await import('../command-center-providers');
    const learnt = { name: 'claude-sonnet-5-5', tested: { contextWindow: 900_000, at: 'x' } };
    const previous = [
      {
        id: 'cc-claude',
        kind: 'anthropic' as const,
        name: 'Claude',
        baseUrl: `${BASE}/api/ai-browser/llm/anthropic`,
        models: [learnt],
      },
    ];
    expect(commandCenterProviders(connection() as never, previous)[0].models).toEqual([learnt]);
    const moved = commandCenterProviders(connection({ url: 'https://other.example' }) as never, previous);
    expect(moved[0].models).toEqual([{ name: 'claude-sonnet-5-5' }]);
  });

  it('sets the default model to Command Center’s when the current one is gone', async () => {
    stubChrome({ 'nb.settings': { defaultModel: { providerId: 'own-key', model: 'gpt-4o' } } });
    const { syncCommandCenterProviders } = await import('../command-center-providers');
    const { settingsStorage, providersStorage } = await import('../settings');
    await syncCommandCenterProviders(connection() as never);
    expect((await settingsStorage.get()).defaultModel).toEqual({ providerId: 'cc-claude', model: 'claude-sonnet-5-5' });
    expect((await providersStorage.get()).map(p => p.id)).toEqual(['cc-claude', 'cc-openai']);
  });
});

describe('model requests through Command Center', () => {
  it('puts the access token where the SDK put its placeholder key', async () => {
    stubChrome({ 'kai.commandCenter': connection() });
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init.headers).entries()));
      return new Response('{}', { status: 200 });
    });
    const { commandCenterFetch } = await import('../command-center');
    await commandCenterFetch(`${BASE}/api/ai-browser/llm/anthropic/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'command-center' },
    });
    await commandCenterFetch(`${BASE}/api/ai-browser/llm/openai/responses`, {
      method: 'POST',
      headers: { Authorization: 'Bearer command-center' },
    });
    expect(seen[0]['x-api-key']).toBe('ks_oauth_at_old');
    expect(seen[0].authorization).toBeUndefined();
    expect(seen[1].authorization).toBe('Bearer ks_oauth_at_old');
  });

  it('renews an access token that is about to run out, before the request', async () => {
    stubChrome({ 'kai.commandCenter': connection({ expiresAt: new Date(Date.now() + 60_000).toISOString() }) });
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push(String(url));
      if (String(url).endsWith('/api/oauth/token')) {
        expect(String(init.body)).toContain('grant_type=refresh_token');
        return Response.json({ access_token: 'ks_oauth_at_new', refresh_token: 'ks_oauth_rt_1', expires_in: 43200 });
      }
      if (String(url).endsWith('/api/ai-browser/me')) {
        return Response.json({ user: connection().user, models: connection().models });
      }
      if (String(url).endsWith('/api/mcp')) return Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
      return new Response(new Headers(init.headers).get('authorization'), { status: 200 });
    });
    const { commandCenterFetch, commandCenterStorage } = await import('../command-center');
    const answer = await commandCenterFetch(`${BASE}/api/ai-browser/llm/openai/responses`, {
      method: 'POST',
      headers: { Authorization: 'Bearer command-center' },
    });
    expect(await answer.text()).toBe('Bearer ks_oauth_at_new');
    expect(calls[0]).toBe(`${BASE}/api/oauth/token`);
    expect((await commandCenterStorage.get())?.accessToken).toBe('ks_oauth_at_new');
  });

  it('signs out when Command Center refuses the refresh token', async () => {
    stubChrome({ 'kai.commandCenter': connection({ expiresAt: new Date(Date.now() - 1000).toISOString() }) });
    vi.stubGlobal('fetch', async () =>
      Response.json({ error: 'invalid_grant', error_description: 'Refresh token is not valid.' }, { status: 400 }),
    );
    const { freshConnection, commandCenterStorage } = await import('../command-center');
    await expect(freshConnection()).rejects.toThrow(/Sign in again/);
    expect(await commandCenterStorage.get()).toBeNull();
  });
});

describe('Command Center tool calls', () => {
  it('sends a JSON-RPC tools/call and returns the text and the error mark', async () => {
    stubChrome({ 'kai.commandCenter': connection() });
    let body: { method?: string; params?: { name?: string; arguments?: unknown } } = {};
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { isError: true, content: [{ type: 'text', text: 'Not permitted' }] },
      });
    });
    const { callCommandCenterTool } = await import('../command-center');
    const result = await callCommandCenterTool('get_payment_analytics', { window: 'MTD' });
    expect(body.method).toBe('tools/call');
    expect(body.params).toEqual({ name: 'get_payment_analytics', arguments: { window: 'MTD' } });
    expect(result).toEqual({ text: 'Not permitted', isError: true });
  });
});

describe('the address each SDK calls', () => {
  it('is Command Center’s model route plus only the endpoint, with the token where the key goes', async () => {
    stubChrome({
      'kai.commandCenter': connection({ models: [...connection().models, { provider: 'grok', name: 'grok-4.7' }] }),
    });
    const sent: Array<{ url: string; key: string | null; auth: string | null; model?: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      sent.push({
        url: String(url),
        key: headers.get('x-api-key'),
        auth: headers.get('authorization'),
        model: JSON.parse(String(init.body)).model,
      });
      return Response.json({ error: { message: 'stop here' } }, { status: 400 });
    });
    const { generateText } = await import('ai');
    const { createModel } = await import('@src/llm');
    const { commandCenterFetch } = await import('../command-center');
    const { commandCenterProviders } = await import('../command-center-providers');
    const cards = commandCenterProviders(
      connection({ models: [...connection().models, { provider: 'grok', name: 'grok-4.7' }] }) as never,
      [],
    );
    for (const card of cards) {
      const chat = createModel(
        { kind: card.kind, modelName: card.models[0].name, apiKey: 'command-center', baseUrl: card.baseUrl },
        { fetch: commandCenterFetch },
      );
      await generateText({ model: chat.model, prompt: 'hi', maxRetries: 0 }).catch(() => undefined);
    }
    // Command Center's route is /api/ai-browser/llm/<service>/<path>, and <path> must be the bare endpoint.
    expect(sent.map(s => s.url)).toEqual([
      `${BASE}/api/ai-browser/llm/anthropic/messages`,
      `${BASE}/api/ai-browser/llm/openai/responses`,
      `${BASE}/api/ai-browser/llm/xai/chat/completions`,
    ]);
    expect(sent[0].key).toBe('ks_oauth_at_old');
    expect(sent[1].auth).toBe('Bearer ks_oauth_at_old');
    expect(sent[2].auth).toBe('Bearer ks_oauth_at_old');
    expect(sent.map(s => s.model)).toEqual(['claude-sonnet-5-5', 'gpt-6.2-sol', 'grok-4.7']);
    expect(JSON.stringify(sent)).not.toContain('command-center');
  });
});
