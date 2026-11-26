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
const AT_NOW = new Date().toISOString();

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

describe("Bash AI's own tools and the brief", () => {
  const own = {
    name: 'read_sop',
    description: 'Read one SOP.',
    inputSchema: {},
    readOnly: true,
    via: 'bash-ai' as const,
  };

  it('lists its own tools first and drops an MCP tool of the same name', async () => {
    stubChrome();
    const { allCommandCenterTools } = await import('../command-center');
    const tools = allCommandCenterTools({
      tools: [
        { name: 'read_sop', description: 'old', inputSchema: {}, readOnly: true },
        { name: 'list_clients', description: '', inputSchema: {}, readOnly: true },
      ],
      knowledge: { brief: 'b', tools: [own], at: AT_NOW },
    });
    expect(tools.map(t => [t.name, t.via])).toEqual([
      ['read_sop', 'bash-ai'],
      ['list_clients', undefined],
    ]);
  });

  it("sends its own tools to Bash AI's route and the rest to MCP", async () => {
    stubChrome({ 'kai.commandCenter': connection({ knowledge: { brief: 'b', tools: [own], at: AT_NOW } }) });
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      urls.push(String(url));
      if (String(url).endsWith('/api/ai-browser/tools/call')) {
        expect(JSON.parse(String(init.body))).toEqual({ name: 'read_sop', arguments: { id: 'doc1' } });
        return Response.json({ text: 'Step 1…', isError: false });
      }
      return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'clients' }] } });
    });
    const { callCommandCenterTool } = await import('../command-center');
    expect(await callCommandCenterTool('read_sop', { id: 'doc1' })).toEqual({ text: 'Step 1…', isError: false });
    expect(await callCommandCenterTool('list_clients', {})).toEqual({ text: 'clients', isError: false });
    expect(urls).toEqual([`${BASE}/api/ai-browser/tools/call`, `${BASE}/api/mcp`]);
  });

  it("keeps Command Center's read-only mark on its own tools, so remember asks first", async () => {
    stubChrome({ 'kai.commandCenter': connection({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) });
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).endsWith('/api/ai-browser/knowledge')) {
        return Response.json({
          brief: 'new brief',
          tools: [
            { name: 'search_knowledge', description: 'Search.', inputSchema: {}, annotations: { readOnlyHint: true } },
            { name: 'remember', description: 'Save.', inputSchema: {}, annotations: { readOnlyHint: false } },
          ],
          at: AT_NOW,
        });
      }
      return new Response('unexpected', { status: 500 });
    });
    const { refreshKnowledge, commandCenterStorage } = await import('../command-center');
    await refreshKnowledge();
    const saved = await commandCenterStorage.get();
    expect(saved?.knowledge?.brief).toBe('new brief');
    expect(saved?.knowledge?.tools.map(t => [t.name, t.readOnly, t.via])).toEqual([
      ['search_knowledge', true, 'bash-ai'],
      ['remember', false, 'bash-ai'],
    ]);
  });

  it('keeps working with a Command Center that has no brief yet', async () => {
    stubChrome({ 'kai.commandCenter': connection({ expiresAt: new Date(Date.now() + 60_000).toISOString() }) });
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).endsWith('/api/oauth/token')) {
        return Response.json({ access_token: 'ks_oauth_at_new', refresh_token: 'ks_oauth_rt_1', expires_in: 43200 });
      }
      if (String(url).endsWith('/api/ai-browser/me')) return Response.json({ user: connection().user, models: [] });
      if (String(url).endsWith('/api/ai-browser/knowledge')) return new Response('not found', { status: 404 });
      return Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    });
    const { renewCommandCenter } = await import('../command-center');
    const renewed = await renewCommandCenter();
    expect(renewed.knowledge).toBeUndefined();
    expect(renewed.accessToken).toBe('ks_oauth_at_new');
  });
});

describe('view as (a developer sees Bash AI as another member)', () => {
  const VIEWED = { id: 'm2', name: 'Zach', role: 'csm' };
  const headerOf = (init?: RequestInit) => new Headers(init?.headers).get('X-Bash-AI-View-As');

  it('sends the view-as header on every Command Center request only while viewing as someone', async () => {
    stubChrome({ 'kai.commandCenter': connection(), 'kai.viewAs': VIEWED });
    const seen: Array<[string, string | null]> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      seen.push([String(url).replace(BASE, ''), headerOf(init)]);
      if (String(url).endsWith('/api/ai-browser/view-as'))
        return Response.json({ data: { allowed: true, members: [] } });
      if (String(url).endsWith('/api/mcp')) {
        return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } });
      }
      return Response.json({});
    });
    const { callCommandCenterTool, commandCenterFetch, listViewAsMembers, viewAsStorage } =
      await import('../command-center');
    await callCommandCenterTool('list_clients', {});
    await commandCenterFetch(`${BASE}/api/ai-browser/llm/anthropic/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'placeholder' },
    });
    // The member list is always asked as the person signed in.
    await listViewAsMembers();
    await viewAsStorage.set(null);
    await callCommandCenterTool('list_clients', {});
    expect(seen).toEqual([
      ['/api/mcp', 'm2'],
      ['/api/ai-browser/llm/anthropic/messages', 'm2'],
      ['/api/ai-browser/view-as', null],
      ['/api/mcp', null],
    ]);
  });

  it('reads the member viewed as, with the real person beside it, and back again on exit', async () => {
    stubChrome({ 'kai.commandCenter': connection() });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/ai-browser/me')) {
        return headerOf(init)
          ? Response.json({
              user: { id: 'm2', name: 'Zach', email: 'z@example.com', role: 'csm' },
              viewer: { id: 'm1', name: 'Aaron' },
              models: [],
            })
          : Response.json({ user: connection().user, models: [] });
      }
      if (String(url).endsWith('/api/ai-browser/knowledge')) return new Response('not found', { status: 404 });
      return Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    });
    const { setViewAs } = await import('../command-center');
    const viewing = await setViewAs(VIEWED);
    expect([viewing.user.name, viewing.viewer?.name]).toEqual(['Zach', 'Aaron']);
    const back = await setViewAs(null);
    expect([back.user.name, back.viewer]).toEqual(['Aaron', undefined]);
  });

  it('drops a view-as Command Center refuses, says why, and reads as the person signed in again', async () => {
    stubChrome({ 'kai.commandCenter': connection() });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/ai-browser/me')) {
        return headerOf(init)
          ? Response.json({ error: 'That member is not active.' }, { status: 403 })
          : Response.json({ user: connection().user, models: [] });
      }
      if (String(url).endsWith('/api/ai-browser/knowledge')) return new Response('not found', { status: 404 });
      return Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    });
    const { commandCenterStorage, setViewAs, viewAsStorage } = await import('../command-center');
    await expect(setViewAs({ id: 'gone', name: 'Former', role: 'isa' })).rejects.toThrow('That member is not active.');
    expect(await viewAsStorage.get()).toBeNull();
    const saved = await commandCenterStorage.get();
    expect([saved?.user.name, saved?.viewer]).toEqual(['Aaron', undefined]);
  });

  it('hides the picker from a person Command Center does not let view as others', async () => {
    stubChrome({ 'kai.commandCenter': connection() });
    vi.stubGlobal('fetch', async () => Response.json({ error: 'Developers only.' }, { status: 403 }));
    const { listViewAsMembers } = await import('../command-center');
    expect(await listViewAsMembers()).toEqual({ allowed: false, members: [] });
  });
});
