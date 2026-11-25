// The provider cards Command Center gives Bash AI: Claude, OpenAI and Grok, each pointed at Command Center's model
// route, which adds the company's key on the server. They are written into the ordinary provider list, so the model
// picker, the model profiles and the run work on them as on any provider. They hold no key: each request carries the
// person's Command Center token (commandCenterFetch).
import type { ProviderKind } from '../llm/providers';
import type { CommandCenterConnection } from './command-center';
import { providersStorage, settingsStorage } from './settings';
import type { ModelEntry, ProviderConfig } from './settings';

export const CC_PROVIDER_IDS = {
  claude: 'cc-claude',
  openai: 'cc-openai',
  grok: 'cc-grok',
} as const;

export type CommandCenterProvider = keyof typeof CC_PROVIDER_IDS;

const CARDS: Record<CommandCenterProvider, { kind: ProviderKind; name: string; service: string }> = {
  // Claude through Anthropic's Messages API.
  claude: { kind: 'anthropic', name: 'Claude', service: 'anthropic' },
  // OpenAI through its Responses API.
  openai: { kind: 'openai', name: 'OpenAI', service: 'openai' },
  // Grok through xAI's OpenAI-compatible chat completions.
  grok: { kind: 'openai-compatible', name: 'Grok', service: 'xai' },
};

export function isCommandCenterProvider(providerId: string): boolean {
  return (Object.values(CC_PROVIDER_IDS) as string[]).includes(providerId);
}

/**
 * Command Center's model route for a provider, as the SDK's base URL. No `/v1`: the SDK adds the endpoint (`/messages`,
 * `/responses`, `/chat/completions`) and Command Center adds the provider's own `/v1`.
 */
export function commandCenterBaseUrl(url: string, provider: CommandCenterProvider): string {
  return `${url}/api/ai-browser/llm/${CARDS[provider].service}`;
}

/**
 * The provider list for a connection: one card per provider Command Center offers, with its models. What a run learnt
 * about a model is kept while the card's address stays the same. Every other provider is removed: Bash AI's answers
 * come only from Command Center's keys. Null (signed out) leaves no provider at all.
 */
export function commandCenterProviders(
  connection: Pick<CommandCenterConnection, 'url' | 'models'> | null,
  previous: ProviderConfig[],
): ProviderConfig[] {
  if (!connection) return [];
  const out: ProviderConfig[] = [];
  for (const provider of Object.keys(CARDS) as CommandCenterProvider[]) {
    const names = connection.models.filter(m => m.provider === provider).map(m => m.name);
    if (!names.length) continue;
    const id = CC_PROVIDER_IDS[provider];
    const baseUrl = commandCenterBaseUrl(connection.url, provider);
    const old = previous.find(p => p.id === id && (p.baseUrl ?? '') === baseUrl);
    const models: ModelEntry[] = names.map(name => old?.models.find(m => m.name === name) ?? { name });
    out.push({ id, kind: CARDS[provider].kind, name: CARDS[provider].name, baseUrl, models });
  }
  return out;
}

/**
 * Writes the provider list for a connection and makes sure the default model is one of its models: Command Center's
 * default when the current one is gone.
 */
export async function syncCommandCenterProviders(
  connection: Pick<CommandCenterConnection, 'url' | 'models' | 'defaultModel'> | null,
): Promise<void> {
  let next: ProviderConfig[] = [];
  await providersStorage.set(previous => (next = commandCenterProviders(connection, previous)));
  await settingsStorage.set(settings => {
    const current = settings.defaultModel;
    const stillThere =
      current && next.some(p => p.id === current.providerId && p.models.some(m => m.name === current.model));
    if (stillThere) return settings;
    const wanted = connection?.defaultModel;
    const fallback = next[0]?.models[0] ? { providerId: next[0].id, model: next[0].models[0].name } : null;
    const defaultModel =
      wanted && next.some(p => p.id === CC_PROVIDER_IDS[wanted.provider] && p.models.some(m => m.name === wanted.name))
        ? { providerId: CC_PROVIDER_IDS[wanted.provider], model: wanted.name }
        : fallback;
    return { ...settings, defaultModel };
  });
}
