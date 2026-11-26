// The browser control layer in the worker: one controller for the product's agent sessions and the developer's test
// panel. A prompt from the layer goes to whoever holds its tab: the conversation that owns the tab (the PromptBroker),
// or else the test panel. The mouse input it sends is shown to Bash AI's cursor first (./cursor, watchPointerInput).
import { Controller, chromeAttacher, chromeEpochStore, chromeTabHost } from '@src/browser-control';
import type { AskAnswer, AskRequest, ConfirmAnswer, ConfirmRequest, UserPrompt } from '@src/browser-control';
import { watchPointerInput } from './cursor';
import type { MouseInput } from './cursor';

/** A handler for the prompts of tabs a product session holds. */
export interface PromptRoute {
  owns(tabId: number): boolean;
  prompt: UserPrompt;
}

const routes: PromptRoute[] = [];
let fallback: UserPrompt | null = null;

export function addPromptRoute(route: PromptRoute): void {
  routes.push(route);
}

/** The test panel's prompts, for tabs no product session holds. */
export function setFallbackPrompt(prompt: UserPrompt): void {
  fallback = prompt;
}

function pick(tabId: number): UserPrompt {
  const route = routes.find(r => r.owns(tabId));
  if (route) return route.prompt;
  if (fallback) return fallback;
  return {
    confirm: async () => 'decline',
    ask: async () => ({ outcome: 'cancel' }),
  };
}

const routedPrompt: UserPrompt = {
  confirm: (request: ConfirmRequest, signal: AbortSignal): Promise<ConfirmAnswer> =>
    pick(request.tabId).confirm(request, signal),
  ask: (request: AskRequest, signal: AbortSignal): Promise<AskAnswer> => pick(request.tabId).ask(request, signal),
};

let pointerWatcher: ((tabId: number, input: MouseInput) => Promise<void> | void) | null = null;

/** Who sees the layer's mouse input before it is sent: the RunManager's cursor. */
export function watchPointer(watcher: typeof pointerWatcher): void {
  pointerWatcher = watcher;
}

/** The controller wired to Chrome, as createChromeController makes it, with the attacher watched for the cursor. */
export const controllerReady: Promise<Controller> = Controller.create({
  attacher: watchPointerInput(chromeAttacher, (tabId, input) => pointerWatcher?.(tabId, input)),
  tabs: chromeTabHost,
  epochStore: chromeEpochStore,
  prompt: routedPrompt,
}).then(c => {
  console.info('[layer] controller ready, epoch', c.epoch.prefix, c.epoch.persisted ? '' : '(not persisted)');
  return c;
});
