// What Bash AI's notetaker runs inside the person's own Google Meet tab (Aaron 2026-11-27: a notetaker that does not
// join the call, for when Bash AI is not added or is not admitted). Injected with chrome.scripting.executeScript, so
// each function here is self-contained (no imports, nothing from outside its body) and runs in the page's isolated
// world, where it can message the extension.
//
// The transcript comes from Meet's own live captions, which name the speaker (Aaron's choice). The captions are read
// the way OpenClaw's Meet plugin reads them (MIT, read Nov 26 2026): the caption regions are `[role="region"]` or
// `[aria-live="polite"]` whose label mentions captions; in each caption block the first line is the speaker and the
// rest is what they said. Captions only show in this person's own tab; nobody else sees them turn on.

/** What a caption scan reports to the side panel (message type `kai-meet-notes`). */
export interface CaptionScan {
  type: 'kai-meet-notes';
  key: string;
  rows: Array<{ id: string; speaker: string; text: string }>;
  captionsOn: boolean;
  inCall: boolean;
  title: string;
}

/** Caption lines that are Meet's own words, not speech (OpenClaw's list, trimmed). */
export const CAPTION_NOISE =
  /^(turn on captions|turn off captions|captions|live captions are (on|off)|jump to (the )?(bottom|most recent captions)|arrow_downward.*|more_vert|language|english)$/i;

/**
 * One caption block's text as speaker + words. Pure and exported for the tests; startMeetNotes repeats it inline
 * because injected code can't import.
 */
export function parseCaption(raw: string): { speaker: string; text: string } | null {
  const parts = raw
    .split(/\n+/)
    .map(s => s.trim())
    .filter(s => s && !CAPTION_NOISE.test(s));
  if (!parts.length) return null;
  if (parts.length === 1) return { speaker: '', text: parts[0] };
  return { speaker: parts[0].slice(0, 80), text: parts.slice(1).join(' ') };
}

/**
 * Starts reading the captions in this Meet tab and reporting them, every change and every 2 s. Turns captions on when
 * Meet offers a button for it (at most three tries). Returns 'started', or 'already' when this key is running.
 */
export function startMeetNotes(key: string): string {
  type W = Window & { __bashAiNotes?: { key: string; stop(): void } };
  const w = window as W;
  if (w.__bashAiNotes?.key === key) return 'already';
  w.__bashAiNotes?.stop();
  const SELECTOR = '[role="region"][aria-label*="aption" i], [aria-live="polite"][aria-label*="aption" i]';
  const NOISE =
    /^(turn on captions|turn off captions|captions|live captions are (on|off)|jump to (the )?(bottom|most recent captions)|arrow_downward.*|more_vert|language|english)$/i;
  const ids = new WeakMap<Element, string>();
  let next = 1;
  const textOf = (el: Element) => ((el as HTMLElement).innerText || '').trim();
  const parse = (raw: string) => {
    const parts = raw
      .split(/\n+/)
      .map(s => s.trim())
      .filter(s => s && !NOISE.test(s));
    if (!parts.length) return null;
    if (parts.length === 1) return { speaker: '', text: parts[0] };
    return { speaker: parts[0].slice(0, 80), text: parts.slice(1).join(' ') };
  };
  // A region holding several speakers' blocks: read each block; otherwise the region is one block.
  const blocksOf = (region: Element) => {
    const kids = [...region.children].filter(c => textOf(c));
    const multi = kids.filter(c => textOf(c).split(/\n+/).length >= 2);
    return kids.length > 1 && multi.length ? multi : [region];
  };
  const idOf = (el: Element) => {
    let id = ids.get(el);
    if (!id) {
      id = `${key}:${next++}`;
      ids.set(el, id);
    }
    return id;
  };
  const label = (el: Element) => (el.getAttribute('aria-label') || el.textContent || '').trim();
  const findButton = (re: RegExp) =>
    [...document.querySelectorAll('button,[role="button"]')].find(b => re.test(label(b)));
  const inCall = () => Boolean(findButton(/^leave call$/i));
  let tries = 0;
  let last = '';
  const send = (payload: Omit<CaptionScan, 'type' | 'key'>) => {
    const json = JSON.stringify(payload);
    if (json === last) return;
    last = json;
    try {
      void chrome.runtime.sendMessage({ type: 'kai-meet-notes', key, ...payload }).catch(() => {});
    } catch {
      // The extension was reloaded: this observer is orphaned.
      stop();
    }
  };
  const scan = () => {
    const regions = [...document.querySelectorAll(SELECTOR)];
    const rows: CaptionScan['rows'] = [];
    for (const region of regions) {
      for (const block of blocksOf(region)) {
        const row = parse(textOf(block));
        if (row?.text) rows.push({ id: idOf(block), ...row });
      }
    }
    const calling = inCall();
    if (!regions.length && calling && tries < 3) {
      const button = findButton(/^(turn on captions|captions)$/i);
      if (button) {
        (button as HTMLElement).click();
        tries += 1;
      }
    }
    send({ rows, captionsOn: regions.length > 0, inCall: calling, title: document.title });
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const observer = new MutationObserver(() => {
    if (!timer)
      timer = setTimeout(() => {
        timer = null;
        scan();
      }, 250);
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  const poll = setInterval(scan, 2000);
  function stop() {
    observer.disconnect();
    clearInterval(poll);
    if (w.__bashAiNotes?.key === key) delete w.__bashAiNotes;
  }
  w.__bashAiNotes = { key, stop };
  scan();
  return 'started';
}

/** Stops the caption reader in this tab. */
export function stopMeetNotes(): void {
  (window as Window & { __bashAiNotes?: { stop(): void } }).__bashAiNotes?.stop();
}

/**
 * Posts a message in the Meet chat from this person's account: opens the chat panel when it is closed, writes the
 * message, sends it. Returns 'sent', or why it could not ('no-chat', 'no-box').
 */
export async function postMeetChat(text: string): Promise<string> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const label = (el: Element) => (el.getAttribute('aria-label') || el.textContent || '').trim();
  const findButton = (re: RegExp) =>
    [...document.querySelectorAll('button,[role="button"]')].find(b => re.test(label(b))) as HTMLElement | undefined;
  const findBox = () =>
    document.querySelector(
      'textarea[aria-label*="message" i], [contenteditable="true"][aria-label*="message" i], textarea[placeholder*="message" i]',
    ) as HTMLElement | null;
  let box = findBox();
  if (!box) {
    const chat = findButton(/^(chat with everyone|open chat|chat)$/i);
    if (!chat) return 'no-chat';
    chat.click();
    for (let i = 0; i < 10 && !box; i++) {
      await sleep(250);
      box = findBox();
    }
  }
  if (!box) return 'no-box';
  box.focus();
  // insertText fires the input events Meet's own editor listens to.
  document.execCommand('insertText', false, text);
  await sleep(200);
  const send = findButton(/^send( a)? message/i);
  if (send && !(send as HTMLButtonElement).disabled) {
    send.click();
    return 'sent';
  }
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  return 'sent';
}
