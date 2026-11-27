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

/** One line of speech as the notes keep it: Meet's newest text for it, and when it was heard (this machine's clock). */
export interface FeedLine {
  /** Stable for the session, whatever ids Meet used for it. */
  id: string;
  speaker: string;
  text: string;
  final: boolean;
  /** When its first and latest updates arrived (ms). */
  start: number;
  end: number;
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
  /** Lines that changed since the last report, with the speaker's name. */
  utterances: FeedLine[];
}

/** Words, lowercased, for comparing two versions of one line. */
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** How many words two texts start with in common. */
function sharedStart(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/** One text begins with the other (word by word): the same speech, one copy further along. */
function sameSpeech(a: string, b: string): boolean {
  const n = Math.min(words(a).length, words(b).length);
  return n >= 1 && sharedStart(a, b) === n;
}

/** Copies of one line under two ids start this close together. */
const TWIN_MS = 2000;
/** An unfinished line cut off by a new request is carried on by the new one within this long. */
const CONTINUE_MS = 15_000;

/**
 * Meet's caption updates as lines of speech, the way CallScribe (MIT, src/shared/merge.js) learned they behave live:
 * - every request for captions starts a new round (`epoch`), and ids start over in it, so an id is only known within
 *   its round and its speaker's device;
 * - an id that comes back with a much lower version and other words is new speech, not a late copy;
 * - the same speech sometimes comes under two ids, starting within 2 s: it stays one line;
 * - an unfinished line cut off by a new round is carried on by the new round's first line from that device.
 * Each line gets an id of its own, so a reused Meet id never overwrites an earlier line.
 */
export class LineBook {
  readonly #byKey = new Map<string, { line: FeedLine; version: number; device: string; epoch: number }>();
  readonly #lines: Array<{ line: FeedLine; device: string; epoch: number }> = [];
  #next = 1;

  /** Adds an update; answers the line it changed, or null when it changed nothing. */
  add(u: FeedUtterance, epoch: number, at: number): FeedLine | null {
    const key = `${epoch}|${u.device}|${u.id}`;
    const text = u.text.trim();
    const had = this.#byKey.get(key);
    if (had) {
      if (u.version < had.version) {
        // Ids started over under us: other words at a much lower version are new speech.
        const restarted = had.version - u.version > 1 && text && sharedStart(text, had.line.text) < 2;
        if (!restarted) return null;
        this.#byKey.delete(key);
        return this.add(u, epoch, at);
      }
      const final = u.version === had.version ? had.line.final || u.final : u.final;
      const changed = (text && text !== had.line.text) || final !== had.line.final;
      had.version = u.version;
      if (!changed) return null;
      if (text) had.line.text = text;
      had.line.final = final;
      had.line.end = at;
      return had.line;
    }
    if (!text) return null;
    // A line from an earlier round that this one carries on, or a twin of a line that just began.
    const same = this.#carriedOn(u.device, epoch, text, at) ?? this.#twin(u.device, text, at);
    if (same) {
      this.#byKey.set(key, { line: same.line, version: u.version, device: u.device, epoch });
      same.epoch = epoch;
      if (words(text).length >= words(same.line.text).length) same.line.text = text;
      same.line.final = u.final;
      same.line.end = at;
      return same.line;
    }
    const line: FeedLine = { id: String(this.#next++), speaker: '', text, final: u.final, start: at, end: at };
    const entry = { line, device: u.device, epoch };
    this.#lines.push(entry);
    this.#byKey.set(key, { line, version: u.version, device: u.device, epoch });
    return line;
  }

  /** The device each line was heard from (for naming). */
  deviceOf(line: FeedLine): string {
    return this.#lines.find(e => e.line === line)?.device ?? '';
  }

  #carriedOn(device: string, epoch: number, text: string, at: number) {
    for (let i = this.#lines.length - 1; i >= 0; i--) {
      const e = this.#lines[i];
      if (e.device !== device) continue;
      if (e.epoch === epoch || e.line.final || at - e.line.end > CONTINUE_MS) return undefined;
      return sharedStart(text, e.line.text) >= 2 && sameSpeech(text, e.line.text) ? e : undefined;
    }
    return undefined;
  }

  #twin(device: string, text: string, at: number) {
    for (let i = this.#lines.length - 1; i >= 0; i--) {
      const e = this.#lines[i];
      if (at - e.line.start > TWIN_MS) return undefined;
      if (e.device === device && !e.line.final && sameSpeech(text, e.line.text)) return e;
    }
    return undefined;
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
 * whenever Meet's own CC button changes them, so a person turning CC off doesn't stop the notes), keeps each line's
 * newest text (LineBook), names the speaker, and reports what changed.
 */
export class FeedSession {
  readonly #key: string;
  readonly #lang: string;
  readonly #io: FeedIO;
  readonly #book = new LineBook();
  readonly #names = new Map<string, string>();
  readonly #changed = new Set<FeedLine>();
  readonly #startedAt: number;
  #seq = OWN_SEQ;
  #epoch = 0;
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
    if (label !== 'captions_v2' || this.#open) return;
    this.#open = true;
    this.ask();
  }

  closed(label: string): void {
    if (label !== 'captions_v2') return;
    this.#open = false;
    this.#answered = false;
    this.#flowing = false;
  }

  /** Asks for captions in our language (Meet's CC button sends the same request); a new round of ids begins. */
  ask(): void {
    if (!this.#open) return;
    this.#seq += 1;
    this.#epoch += 1;
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
      if (sent.kind !== 'language' || sent.seq >= OWN_SEQ) return false;
      // Meet's own request starts a round too.
      this.#epoch += 1;
      return true;
    }
    const got = decodeIncoming(bytes);
    if (got?.kind === 'reply' && got.seq > OWN_SEQ) this.#answered = true;
    if (got?.kind === 'captions') {
      this.#flowing = true;
      const at = this.#io.now();
      for (const u of got.utterances) {
        const line = this.#book.add(u, this.#epoch, at);
        if (line) this.#changed.add(line);
      }
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
    const utterances = [...this.#changed].map(line => {
      const device = this.#book.deviceOf(line);
      return { ...line, speaker: this.#names.get(device) ?? tiles.get(device) ?? '' };
    });
    this.#changed.clear();
    return { type: 'kai-meet-feed', key: this.#key, feed: this.feed, inCall: this.#io.inCall(), utterances };
  }
}
