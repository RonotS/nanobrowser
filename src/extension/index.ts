// The product's wiring in the service worker. Listener registration stays synchronous at worker start.
import './panel';
import { addFirstShortcuts } from './first-run';
import { listenForPanels } from './panel-port';
import { RunManager } from './run-manager';
import { listenForSelections } from './selection';
import { upgradeFromOldVersion } from './upgrade';
import { analyticsReady, listenForSwitches, recordInstall } from './analytics';
import { DATA_REQUEST } from '@src/ui/protocol';
import { settingsStorage } from '@src/store/settings';
import { refreshIfStale } from '@src/store/command-center';
import { START_SWEEP_DELAY_MS } from './temporary';

const DARK_DEFAULT_KEY = 'kai.darkDefault';

export const runManager = new RunManager();
listenForPanels(runManager);
listenForSelections(runManager);
// The watchdog alarm only wakes the worker; starting it is what restores an unfinished run.
// The welcome page and the first shortcut on install. Unattended check builds are installed on every run, so they
// skip both.
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'update') {
    console.info(`[install] updated from ${details.previousVersion}`);
    // Nanobrowser's What's new card is not shown: its highlights describe Nanobrowser's releases, not Bash AI's.
  }
  // Analytics records a real install's week; autorun builds too, so their check can see it.
  if (details.reason === 'install')
    void recordInstall().catch(error => console.error('[analytics] install failed', error));
  if (details.reason !== 'install' || import.meta.env.WXT_AUTORUN_URL) return;
  void addFirstShortcuts().catch(error => console.error('[install] first shortcut failed', error));
  void chrome.tabs.create({ url: chrome.runtime.getURL('/welcome.html') });
});
// Settings → Data → Delete everything goes through the RunManager, which stops running tasks first.
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  const m = message as { type?: string; op?: 'delete-all' };
  if (m?.type !== DATA_REQUEST || sender.id !== chrome.runtime.id) return;
  const done = m.op === 'delete-all' ? runManager.deleteAll() : Promise.reject(new Error('unknown request'));
  done.then(
    () => reply({ ok: true }),
    error => reply({ ok: false, error: String(error) }),
  );
  return true;
});
chrome.alarms?.onAlarm.addListener(() => undefined);
void runManager.restore().catch(error => console.error('[runs] restore failed', error));
// The company brief and Command Center's tools, read again when the saved copy is old or has no brief.
void refreshIfStale().catch(error => console.warn('[command-center] refresh failed', error));
// A temporary chat left by a panel that crashed or a worker that stopped goes, once the open panels have connected again.
setTimeout(
  () => void runManager.sweepTemporary().catch(error => console.warn('[temporary] start sweep failed', error)),
  START_SWEEP_DELAY_MS,
);
// Conversations from before Command Center kept the history go there once.
void runManager.saveAllHistoryOnce().catch(error => console.error('[history] backfill failed', error));
// Dark became the default (2026-11-25, as Command Center is): a theme still on the old default, System, moves to Dark
// once. The panel's sun and moon switch it back at any time.
void chrome.storage.local
  .get(DARK_DEFAULT_KEY)
  .then(async stored => {
    if (stored[DARK_DEFAULT_KEY]) return;
    await settingsStorage.set(s => (s.theme === 'system' ? { ...s, theme: 'dark' } : s));
    await chrome.storage.local.set({ [DARK_DEFAULT_KEY]: true });
  })
  .catch(error => console.error('[theme] dark default failed', error));
// An update from the old Nanobrowser: its data is moved on the first start that finds it, whenever that comes.
void upgradeFromOldVersion().catch(error => console.error('[upgrade] move failed', error));
// Analytics waits for that move, then applies the old version's choice once; nothing is sent before.
void analyticsReady();
listenForSwitches();
