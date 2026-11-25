// The Command Center connection. Bash AI signs in through Command Center's own OAuth, the same flow Claude's
// connector uses: the person logs in to Command Center and approves Bash AI once, and Bash AI then acts as that person,
// with their current role. With the token it:
//   - runs Command Center's tools (the company's data and SOPs) through its MCP endpoint, which limits them to the
//     person's role;
//   - sends every model call through Command Center, which adds the company's Claude, OpenAI and Grok keys. No API
//     key is ever stored in the browser.
// The tokens are kept like API keys: never exported, never logged, sent only to Command Center.
import { syncCommandCenterProviders } from './command-center-providers';
import type { CommandCenterProvider } from './command-center-providers';
import { createStorage } from './storage';

export { CC_PROVIDER_IDS, isCommandCenterProvider } from './command-center-providers';

/** The live Command Center. A build can point at another one (a local server) with VITE_COMMAND_CENTER_URL. */
export const DEFAULT_COMMAND_CENTER_URL = 'https://kinetic-command-center-production.up.railway.app';

export function commandCenterUrl(): string {
  const fromBuild = import.meta.env?.VITE_COMMAND_CENTER_URL?.trim();
  return (fromBuild || DEFAULT_COMMAND_CENTER_URL).replace(/\/+$/, '');
}

export interface CommandCenterUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

/** A model Command Center lets Bash AI use, on one of its three providers. */
export interface CommandCenterModel {
  /** `claude`, `openai` or `grok`: the provider card it belongs to. */
  provider: CommandCenterProvider;
  /** The model's API name, such as claude-sonnet-5-5. */
  name: string;
  /** A short name for the picker. */
  label?: string;
}

/** A Command Center tool, as Command Center describes it for this person's role. */
export interface CommandCenterTool {
  name: string;
  description: string;
  /** JSON Schema of the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /** The tool only reads. A tool without the mark is treated as one that changes something. */
  readOnly: boolean;
}

/** A media or voice model Command Center offers, on OpenAI or Grok. */
export interface CommandCenterMediaModel {
  provider: 'openai' | 'grok';
  name: string;
  label?: string;
}

/** A realtime voice model for the voice agent, with the voices it speaks in. */
export interface CommandCenterVoiceAgent extends CommandCenterMediaModel {
  voices: string[];
  /** The voice used unless the person picks another. */
  voice: string;
}

/** What Command Center offers beyond chat: media generation and voice. Each list is empty without the key. */
export interface CommandCenterExtras {
  media: { image: CommandCenterMediaModel[]; video: CommandCenterMediaModel[] };
  voice: { transcription: CommandCenterMediaModel | null; agents: CommandCenterVoiceAgent[] };
}

export const NO_EXTRAS: CommandCenterExtras = {
  media: { image: [], video: [] },
  voice: { transcription: null, agents: [] },
};

export interface CommandCenterConnection {
  /** The Command Center these tokens belong to. */
  url: string;
  /** This browser's registration with Command Center's OAuth. */
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** When the access token stops working, as an ISO time; it is renewed with the refresh token before then. */
  expiresAt: string;
  user: CommandCenterUser;
  models: CommandCenterModel[];
  /** The model a new conversation starts on. */
  defaultModel?: { provider: CommandCenterModel['provider']; name: string };
  tools: CommandCenterTool[];
  /** Image and video generation, dictation and the voice agent; absent in a connection saved by an older build. */
  extras?: CommandCenterExtras;
  /** When the models and tools were last read from Command Center. */
  syncedAt: string;
}

/** Null when nobody is signed in. */
export const commandCenterStorage = createStorage<CommandCenterConnection | null>('kai.commandCenter', null, {
  liveUpdate: true,
});

/** This browser's OAuth registration, kept across sign-outs so signing in again does not register again. */
interface ClientRegistration {
  url: string;
  redirectUri: string;
  clientId: string;
}

const registrationStorage = createStorage<ClientRegistration | null>('kai.ccClient', null);

/** Why Command Center refused, said in plain words for the panel and the settings page. */
export class CommandCenterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The address Chrome hands back to this extension at the end of the sign-in window. */
function redirectUri(): string {
  return chrome.identity.getRedirectURL('command-center');
}

function base64url(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE: a random verifier and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

async function oauthError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: string | { message?: string };
    error_description?: string;
  } | null;
  if (body?.error_description) return body.error_description;
  if (typeof body?.error === 'string') return body.error;
  if (body?.error?.message) return body.error.message;
  if (response.status === 401) return 'Sign in to Command Center again.';
  if (response.status === 403) return 'Your Command Center role cannot use Bash AI.';
  return `Command Center answered ${response.status}.`;
}

/** The OAuth client for this browser: registered once with Command Center, then reused. */
async function clientId(base: string): Promise<string> {
  const redirect = redirectUri();
  const saved = await registrationStorage.get();
  if (saved && saved.url === base && saved.redirectUri === redirect) return saved.clientId;
  const response = await fetch(`${base}/api/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Bash AI (Chrome)',
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      software_id: 'kinetic-the-ai',
    }),
  });
  if (!response.ok) throw new CommandCenterError(await oauthError(response), response.status);
  const { client_id } = (await response.json()) as { client_id?: string };
  if (!client_id) throw new CommandCenterError('Command Center did not register Bash AI.');
  await registrationStorage.set({ url: base, redirectUri: redirect, clientId: client_id });
  return client_id;
}

interface TokenAnswer {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function tokenRequest(base: string, params: Record<string, string>): Promise<TokenAnswer> {
  const response = await fetch(`${base}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) throw new CommandCenterError(await oauthError(response), response.status);
  const tokens = (await response.json()) as TokenAnswer;
  if (!tokens.access_token || !tokens.refresh_token) throw new CommandCenterError('Command Center sent no token.');
  return tokens;
}

/**
 * Opens Command Center's approval page in Chrome's sign-in window. Command Center asks the person to log in first if
 * they are not, then hands back a one-time code for this extension, which is exchanged for the tokens.
 */
async function authorize(base: string): Promise<{ clientId: string; tokens: TokenAnswer }> {
  const id = await clientId(base);
  const redirect = redirectUri();
  const { verifier, challenge } = await pkcePair();
  const state = crypto.randomUUID();
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: id,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: 'mcp',
    resource: `${base}/api/mcp`,
  }).toString();
  let answer: string | undefined;
  try {
    answer = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
  } catch (error) {
    // A registration Command Center no longer knows shows an error page instead of coming back: register again next
    // time.
    await registrationStorage.set(null);
    throw new CommandCenterError(`Sign-in did not finish: ${(error as Error)?.message ?? error}`);
  }
  const params = new URL(answer ?? '').searchParams;
  if (params.get('state') !== state) throw new CommandCenterError('Sign-in was refused: the answer did not match.');
  if (params.get('error')) {
    throw new CommandCenterError(
      params.get('error') === 'access_denied'
        ? 'You declined Bash AI in Command Center.'
        : (params.get('error_description') ?? params.get('error') ?? 'Sign-in failed.'),
    );
  }
  const code = params.get('code');
  if (!code) throw new CommandCenterError('Command Center sent no sign-in code.');
  const tokens = await tokenRequest(base, {
    grant_type: 'authorization_code',
    code,
    client_id: id,
    redirect_uri: redirect,
    code_verifier: verifier,
  });
  return { clientId: id, tokens };
}

const expiry = (tokens: TokenAnswer) => new Date(Date.now() + tokens.expires_in * 1000).toISOString();

/** What `/api/ai-browser/me` answers. */
interface MeAnswer {
  user: CommandCenterUser;
  models: CommandCenterModel[];
  defaultModel?: CommandCenterConnection['defaultModel'];
  media?: Partial<CommandCenterExtras['media']>;
  voice?: Partial<CommandCenterExtras['voice']>;
}

/** The extras from `/me`, with every part present. */
export function extrasOf(me: Pick<MeAnswer, 'media' | 'voice'>): CommandCenterExtras {
  return {
    media: { image: me.media?.image ?? [], video: me.media?.video ?? [] },
    voice: { transcription: me.voice?.transcription ?? null, agents: me.voice?.agents ?? [] },
  };
}

async function readMe(base: string, token: string): Promise<MeAnswer> {
  const response = await fetch(`${base}/api/ai-browser/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new CommandCenterError(await oauthError(response), response.status);
  const me = (await response.json()) as MeAnswer;
  if (!me?.user?.id) throw new CommandCenterError('Command Center did not say who signed in.');
  return { ...me, models: me.models ?? [] };
}

/** One JSON-RPC call to Command Center's MCP endpoint. */
async function mcp(
  base: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
    signal,
  });
}

/**
 * Tool arguments that only Command Center's own assistant can fill (its conversation's member token, a client chat's
 * pass). A tool that requires one cannot work from Bash AI, so it is left out.
 */
const ASSISTANT_ONLY_ARGUMENTS = ['memberToken', 'clientPass'];

interface WireTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

/** The tools this person's role may use, without the ones that need Command Center's own assistant. */
export function usableTools(tools: WireTool[]): CommandCenterTool[] {
  return tools
    .filter(
      t => !((t.inputSchema?.required as string[] | undefined) ?? []).some(r => ASSISTANT_ONLY_ARGUMENTS.includes(r)),
    )
    .map(t => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      readOnly: t.annotations?.readOnlyHint === true,
    }));
}

async function listTools(base: string, token: string): Promise<CommandCenterTool[]> {
  const response = await mcp(base, token, 'tools/list', {});
  if (!response.ok) throw new CommandCenterError(await oauthError(response), response.status);
  const body = (await response.json()) as { result?: { tools?: WireTool[] }; error?: { message?: string } };
  if (body.error) throw new CommandCenterError(body.error.message ?? 'Command Center refused to list its tools.');
  return usableTools(body.result?.tools ?? []);
}

/** Reads who signed in, their models and their tools, and saves the connection. */
async function saveConnection(
  base: string,
  id: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: string },
): Promise<CommandCenterConnection> {
  const [me, tools] = await Promise.all([readMe(base, tokens.accessToken), listTools(base, tokens.accessToken)]);
  const connection: CommandCenterConnection = {
    url: base,
    clientId: id,
    ...tokens,
    user: me.user,
    models: me.models,
    ...(me.defaultModel ? { defaultModel: me.defaultModel } : {}),
    tools,
    extras: extrasOf(me),
    syncedAt: new Date().toISOString(),
  };
  await commandCenterStorage.set(connection);
  await syncCommandCenterProviders(connection);
  return connection;
}

/** Signs in with the approval window, reads the models and tools, and puts the model cards in the provider list. */
export async function signInToCommandCenter(): Promise<CommandCenterConnection> {
  const base = commandCenterUrl();
  const { clientId: id, tokens } = await authorize(base);
  return saveConnection(base, id, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: expiry(tokens),
  });
}

/** Signs out: Command Center ends the connection, and the tokens and the model cards are removed here. */
export async function signOutOfCommandCenter(): Promise<void> {
  const connection = await commandCenterStorage.get();
  await commandCenterStorage.set(null);
  await syncCommandCenterProviders(null);
  if (connection) {
    await fetch(`${connection.url}/api/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: connection.refreshToken, client_id: connection.clientId }).toString(),
    }).catch(() => undefined);
  }
}

let renewing: Promise<CommandCenterConnection> | null = null;

/**
 * A new access token from the refresh token, and a fresh read of the models and tools (the person's role may have
 * changed). One renewal at a time in each page: Command Center keeps only the newest access token, so two renewals at
 * once would end the first one's token.
 */
export function renewCommandCenter(): Promise<CommandCenterConnection> {
  renewing ??= (async () => {
    const connection = await commandCenterStorage.get();
    if (!connection) throw new CommandCenterError('Sign in to Command Center to use Bash AI.');
    let tokens: TokenAnswer;
    try {
      tokens = await tokenRequest(connection.url, {
        grant_type: 'refresh_token',
        refresh_token: connection.refreshToken,
        client_id: connection.clientId,
      });
    } catch (error) {
      // A refused refresh token (revoked in Command Center, or unused for 90 days) means signing in again.
      if (error instanceof CommandCenterError && error.status && error.status < 500) {
        await commandCenterStorage.set(null);
        await syncCommandCenterProviders(null);
        throw new CommandCenterError('Your Command Center sign-in has ended. Sign in again in Settings.');
      }
      throw error;
    }
    return saveConnection(connection.url, connection.clientId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: expiry(tokens),
    });
  })().finally(() => {
    renewing = null;
  });
  return renewing;
}

/** The connection with an access token good for at least five more minutes, renewed when it is not. */
export async function freshConnection(): Promise<CommandCenterConnection> {
  const connection = await commandCenterStorage.get();
  if (!connection) throw new CommandCenterError('Sign in to Command Center to use Bash AI.');
  if (Date.parse(connection.expiresAt) - 5 * 60_000 > Date.now()) return connection;
  return renewCommandCenter();
}

/**
 * Sends a request with the newest access token, put where the request already carries its key (`x-api-key` for
 * Claude, `Authorization` for OpenAI and Grok). A 401 is retried once: with a token another page renewed meanwhile,
 * else after renewing it here.
 */
export async function withCommandCenterToken(send: (token: string) => Promise<Response>): Promise<Response> {
  const first = await freshConnection();
  const response = await send(first.accessToken);
  if (response.status !== 401) return response;
  const stored = await commandCenterStorage.get();
  const next = stored && stored.accessToken !== first.accessToken ? stored : await renewCommandCenter();
  return send(next.accessToken);
}

/** A fetch for the model providers: the SDK's key, which is a placeholder, is replaced by the access token. */
export const commandCenterFetch: typeof fetch = (input, init) =>
  withCommandCenterToken(token => {
    const headers = new Headers(init?.headers);
    if (headers.has('x-api-key')) headers.set('x-api-key', token);
    else headers.set('Authorization', `Bearer ${token}`);
    return globalThis.fetch(input, { ...init, headers });
  });

/** Runs one Command Center tool as the signed-in person. The answer is text for the model. */
export async function callCommandCenterTool(
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<{ text: string; isError: boolean }> {
  const connection = await freshConnection();
  const response = await withCommandCenterToken(token =>
    mcp(connection.url, token, 'tools/call', { name, arguments: args ?? {} }, signal),
  );
  if (!response.ok) return { text: `error: ${await oauthError(response)}`, isError: true };
  const body = (await response.json()) as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    error?: { message?: string };
  };
  if (body.error) return { text: `error: ${body.error.message ?? 'Command Center refused the call.'}`, isError: true };
  const text = (body.result?.content ?? []).map(c => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n');
  return { text, isError: !!body.result?.isError };
}

/** Where and how the panel connects to a realtime voice session (see src/side-panel/voice-agent.ts). */
export interface VoiceSessionGrant {
  provider: 'openai' | 'grok';
  url: string;
  protocols: string[];
  model: string;
  voice: string;
}

/**
 * A realtime voice session: Command Center asks the provider for a short-lived secret with the company's key and says
 * how to connect with it. The secret is good for one connection, started within about a minute.
 */
export async function requestVoiceSession(
  provider: 'openai' | 'grok',
  options: { model?: string; voice?: string } = {},
): Promise<VoiceSessionGrant> {
  const connection = await freshConnection();
  const response = await withCommandCenterToken(token =>
    fetch(`${connection.url}/api/ai-browser/realtime/${provider}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    }),
  );
  if (!response.ok) throw new CommandCenterError(await oauthError(response), response.status);
  return (await response.json()) as VoiceSessionGrant;
}
