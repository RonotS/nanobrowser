// Google Meet's caption feed (Aaron 2026-11-27: notes without opening Meet's captions box). Meet's servers transcribe
// every call and send the captions on a WebRTC data channel labelled `captions_v2`, to any client that asks, whether
// or not the page shows them. The Meet tab's two content scripts tap that channel (entrypoints/meet-feed.content.ts in
// Meet's own world, entrypoints/meet-notes.content.ts in the extension's) and ask for captions the way Meet's CC button
// does; this file reads and writes those protobuf messages.
//
// Learned from CallScribe (github.com/SahajJain01/callscribe, MIT, src/shared/meet-proto.js, read Nov 27 2026), whose
// field numbers come from real Meet traffic:
//
//   client -> server  { 1: { 2: { 1: seq, 2: { 1: { 2: lang, 3: lang } } } } }   captions on, in `lang`
//                     { 1: { 2: { 1: seq, 2: { 1: "" } } } }                      captions off
//   server -> client  { 1: { 2: { 1: seq, 3: "" } } }                             the answer to a request
//                     { 1: { 1: utterance*, 6: { 1: unixSeconds } } }             caption updates
//   utterance         { 1: id, 2: version, 3: { 2: final?, 3: text, 4: lang, 6: deviceId } }
//
// Each update carries an utterance's whole text so far; a higher version replaces a lower one, and the last has the
// final flag. The device id ("spaces/…/devices/…") is the speaker's, named on Meet's `collections` channel and on the
// participant tiles (`data-participant-id`). Undocumented by Google: if Meet changes it, nothing decodes, the notes
// say the feed is down, and the notetaker transcribes the tab's sound instead.

type Field = { f: number; w: number; v: number | Uint8Array };

/** One protobuf message's fields; null when it doesn't parse. */
export function fields(b: Uint8Array): Field[] | null {
  const out: Field[] = [];
  let i = 0;
  const varint = (): number | null => {
    let r = 0;
    let mul = 1;
    for (let n = 0; n < 10; n++) {
      if (i >= b.length) return null;
      const x = b[i++];
      r += (x & 127) * mul;
      if (!(x & 128)) return r;
      mul *= 128;
    }
    return null;
  };
  while (i < b.length) {
    const k = varint();
    if (k === null) return null;
    const f = Math.floor(k / 8);
    const w = k % 8;
    if (f < 1) return null;
    if (w === 0) {
      const v = varint();
      if (v === null) return null;
      out.push({ f, w, v });
    } else if (w === 2) {
      const n = varint();
      if (n === null || i + n > b.length) return null;
      out.push({ f, w, v: b.subarray(i, i + n) });
      i += n;
    } else if (w === 1 || w === 5) {
      const n = w === 1 ? 8 : 4;
      if (i + n > b.length) return null;
      out.push({ f, w, v: b.subarray(i, i + n) });
      i += n;
    } else return null;
  }
  return out;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const get = (fs: Field[] | null, f: number) => fs?.find(x => x.f === f);
const all = (fs: Field[] | null, f: number) => fs?.filter(x => x.f === f) ?? [];
const sub = (x: Field | undefined) => (x && x.w === 2 ? fields(x.v as Uint8Array) : null);
const num = (x: Field | undefined) => (x && x.w === 0 ? (x.v as number) : undefined);
function str(x: Field | undefined): string | undefined {
  if (!x || x.w !== 2) return undefined;
  try {
    return utf8.decode(x.v as Uint8Array);
  } catch {
    return undefined;
  }
}

/** One caption update: an utterance's whole text so far. */
export interface FeedUtterance {
  id: string;
  version: number;
  final: boolean;
  text: string;
  lang: string;
  /** The speaker's device ("spaces/…/devices/…"). */
  device: string;
}

function utterance(x: Field): FeedUtterance | null {
  const u = sub(x);
  const cap = sub(get(u, 3));
  const id = num(get(u, 1));
  const device = str(get(cap, 6));
  if (id === undefined || !cap || !device) return null;
  return {
    id: String(id),
    version: num(get(u, 2)) ?? 0,
    final: num(get(cap, 2)) === 1,
    text: str(get(cap, 3)) ?? '',
    lang: str(get(cap, 4)) ?? '',
    device,
  };
}

export type IncomingFeed =
  { kind: 'captions'; utterances: FeedUtterance[] } | { kind: 'reply'; seq: number } | { kind: 'other' };

/** A message Meet's server sent on captions_v2; null when it doesn't parse. */
export function decodeIncoming(bytes: Uint8Array): IncomingFeed | null {
  const body = sub(get(fields(bytes), 1));
  if (!body) return null;
  const utterances = all(body, 1)
    .map(utterance)
    .filter((u): u is FeedUtterance => u !== null);
  if (utterances.length) return { kind: 'captions', utterances };
  const reply = sub(get(body, 2));
  const seq = num(get(reply, 1));
  if (seq !== undefined && get(reply, 3)) return { kind: 'reply', seq };
  return { kind: 'other' };
}

/** A message the Meet page sent on captions_v2: a caption language request ("" = captions off), or something else. */
export function decodeOutgoing(bytes: Uint8Array): { kind: 'language'; seq: number; lang: string } | { kind: 'other' } {
  const body = sub(get(fields(bytes), 1));
  const req = sub(get(body, 2));
  const seq = num(get(req, 1));
  const prefs = sub(get(req, 2));
  if (seq !== undefined && prefs) {
    const pair = get(prefs, 1);
    if (pair && pair.w === 2 && (pair.v as Uint8Array).length === 0) return { kind: 'language', seq, lang: '' };
    const p = sub(pair);
    if (p) return { kind: 'language', seq, lang: str(get(p, 2)) ?? str(get(p, 3)) ?? '' };
  }
  return { kind: 'other' };
}

function varintBytes(n: number): number[] {
  const o: number[] = [];
  while (n > 127) {
    o.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  o.push(n);
  return o;
}
const ld = (f: number, b: number[]) => [(f << 3) | 2, ...varintBytes(b.length), ...b];

/** Our own requests are numbered from here, far above Meet's, so their answers can't be mixed up. */
export const OWN_SEQ = 100_000;

/** The request Meet's CC button sends: captions in `lang` ("" turns them off). */
export function encodeLanguage(seq: number, lang: string): Uint8Array {
  const l = [...new TextEncoder().encode(lang)];
  const prefs = lang ? ld(1, [...ld(2, l), ...ld(3, l)]) : ld(1, []);
  return new Uint8Array(ld(1, ld(2, [0x08, ...varintBytes(seq), ...ld(2, prefs)])));
}

/**
 * Participant names in a `collections` message: any nested message whose field 1 is a device id and field 2 a name.
 */
export function findDeviceNames(
  bytes: Uint8Array,
  depth = 0,
  out: Array<[string, string]> = [],
): Array<[string, string]> {
  if (depth > 14) return out;
  const fs = fields(bytes);
  if (!fs) return out;
  const id = str(get(fs, 1));
  const name = str(get(fs, 2));
  // eslint-disable-next-line no-control-regex
  if (id && /^spaces\/[^/]+\/devices\/[^/]+$/.test(id) && name && !/[\u0000-\u001f]/.test(name)) out.push([id, name]);
  for (const x of fs)
    if (x.w === 2 && (x.v as Uint8Array).length > 2) findDeviceNames(x.v as Uint8Array, depth + 1, out);
  return out;
}

/** What the Meet tab's notes script reports to the worker (runtime message `kai-meet-feed`). */
export interface FeedReport {
  type: 'kai-meet-feed';
  key: string;
  /**
   * `live`: captions are coming. `asked`: asked, no answer yet. `waiting`: the caption channel isn't open (not in the
   * call yet). `no-hook`: this tab was opened before Bash AI loaded, so the feed can't be tapped (reload the tab).
   */
  feed: 'live' | 'asked' | 'waiting' | 'no-hook';
  inCall: boolean;
  /** Utterances that changed since the last report, with the speaker's name. */
  utterances: Array<{ id: string; speaker: string; text: string; final: boolean }>;
}

/** Keeps the newest version of each utterance; answers whether this update changed it. */
export class UtteranceBook {
  readonly #byId = new Map<string, FeedUtterance>();

  add(u: FeedUtterance): boolean {
    const had = this.#byId.get(u.id);
    if (had && (had.version > u.version || (had.version === u.version && had.text === u.text))) return false;
    this.#byId.set(u.id, u);
    return true;
  }

  get(id: string): FeedUtterance | undefined {
    return this.#byId.get(id);
  }
}

/** What a feed session needs from the Meet page (the content script wires it; the tests fake it). */
export interface FeedIO {
  send(label: 'captions_v2', bytes: Uint8Array): void;
  /** Names on the participant tiles, by device id. */
  tileNames(): Map<string, string>;
  inCall(): boolean;
  now(): number;
}

/**
 * One notes session's side of the feed in the Meet tab: asks for captions when the caption channel is open (and again
 * whenever Meet's own CC button changes them, so a person turning CC off doesn't stop the notes), keeps each
 * utterance's newest text, names the speaker, and reports what changed.
 */
export class FeedSession {
  readonly #key: string;
  readonly #lang: string;
  readonly #io: FeedIO;
  readonly #book = new UtteranceBook();
  readonly #names = new Map<string, string>();
  readonly #changed = new Set<string>();
  readonly #startedAt: number;
  #seq = OWN_SEQ;
  #hooked = false;
  #open = false;
  #answered = false;
  #flowing = false;

  constructor(key: string, lang: string, io: FeedIO) {
    this.#key = key;
    this.#lang = lang;
    this.#io = io;
    this.#startedAt = io.now();
  }

  /** The page's hook answered: the feed can be tapped. */
  hooked(): void {
    this.#hooked = true;
  }

  opened(label: string): void {
    if (label !== 'captions_v2') return;
    this.#open = true;
    this.ask();
  }

  closed(label: string): void {
    if (label !== 'captions_v2') return;
    this.#open = false;
    this.#answered = false;
    this.#flowing = false;
  }

  /** Asks for captions in our language (Meet's CC button sends the same request). */
  ask(): void {
    if (!this.#open) return;
    this.#seq += 1;
    this.#io.send('captions_v2', encodeLanguage(this.#seq, this.#lang));
  }

  /** A message on one of the two channels. Returns true when Meet's own CC changed captions (ask again soon). */
  message(label: string, dir: 'in' | 'out', bytes: Uint8Array): boolean {
    if (label === 'collections' && dir === 'in') {
      for (const [device, name] of findDeviceNames(bytes)) this.#names.set(device, name);
      return false;
    }
    if (label !== 'captions_v2') return false;
    if (dir === 'out') {
      const sent = decodeOutgoing(bytes);
      return sent.kind === 'language' && sent.seq < OWN_SEQ;
    }
    const got = decodeIncoming(bytes);
    if (got?.kind === 'reply' && got.seq > OWN_SEQ) this.#answered = true;
    if (got?.kind === 'captions') {
      this.#flowing = true;
      for (const u of got.utterances) if (this.#book.add(u)) this.#changed.add(u.id);
    }
    return false;
  }

  get feed(): FeedReport['feed'] {
    if (!this.#hooked) return this.#io.now() - this.#startedAt > 2000 ? 'no-hook' : 'waiting';
    if (!this.#open) return 'waiting';
    return this.#flowing || this.#answered ? 'live' : 'asked';
  }

  /** The report of what changed since the last one (an empty list is a heartbeat). */
  flush(): FeedReport {
    const tiles = this.#io.tileNames();
    const utterances = [...this.#changed].flatMap(id => {
      const u = this.#book.get(id);
      if (!u) return [];
      const speaker = this.#names.get(u.device) ?? tiles.get(u.device) ?? '';
      return [{ id: u.id, speaker, text: u.text, final: u.final }];
    });
    this.#changed.clear();
    return { type: 'kai-meet-feed', key: this.#key, feed: this.feed, inCall: this.#io.inCall(), utterances };
  }
}
