// Reading and acting on the Google Meet page for the notetaker (entrypoints/meet-notes.content.ts): whether the person
// is in the call, the names on the participant tiles, and posting the consent notice in Meet's chat. Meet's wording
// is English here only; the extension asks Meet for nothing else.

const label = (el: Element) => (el.getAttribute('aria-label') || el.textContent || '').trim();

function findButton(re: RegExp): HTMLElement | undefined {
  return [...document.querySelectorAll('button,[role="button"]')].find(b => re.test(label(b))) as
    HTMLElement | undefined;
}

/** In the call: Meet shows its Leave call button (not in the waiting room or the joining screen). */
export function inMeetCall(): boolean {
  return Boolean(findButton(/^leave call$/i));
}

/** A tile's "(Presentation)" suffix is not part of the name. */
const PRESENTING = /\s*\((?:[^()]*\s)?(?:presentation|presenting)(?:\s[^()]*)?\)$/i;

/**
 * The names on the participant tiles, by the device id Meet's caption feed uses (`data-participant-id`). One person can
 * have two tiles (camera and presentation): the shortest name is kept, so it doesn't flip. CallScribe's reading (MIT).
 */
export function tileNames(): Map<string, string> {
  const byId = new Map<string, string>();
  for (const tile of document.querySelectorAll('[data-participant-id]')) {
    const id = tile.getAttribute('data-participant-id');
    const span = [...tile.querySelectorAll('span.notranslate')].find(s => !s.children.length && s.textContent?.trim());
    if (!id || !span) continue;
    const shown = span.textContent!.trim();
    const name = shown.replace(PRESENTING, '') || shown;
    const had = byId.get(id);
    if (!had || name.length < had.length) byId.set(id, name);
  }
  return byId;
}

/**
 * Posts a message in the Meet chat from this person's account: opens the chat panel when it is closed, writes the
 * message, sends it. Returns 'sent', or why not ('no-chat', 'no-box').
 */
export async function postMeetChat(text: string): Promise<'sent' | 'no-chat' | 'no-box'> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
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
