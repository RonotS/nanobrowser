// Sending a meeting recording to Google Drive while the call goes on (Aaron 2026-11-27: the notetaker's video + audio
// goes to Command Center's Drive folder). Command Center opens a Drive resumable upload and hands over its address;
// this sends the video to it in pieces, in order, so a long meeting never piles up in the browser. No Chrome APIs:
// the offscreen document and the side panel both use it.

/** Drive takes a resumable upload's pieces in multiples of 256 KiB (all but the last). */
export const GRAIN = 256 * 1024;
/** Pieces of 8 MiB: few requests, and little held in memory. */
export const PIECE = 32 * GRAIN;

/** How much of what is buffered to send now: whole 256 KiB grains once 8 MiB has gathered, everything at the end. */
export function sendable(buffered: number, final: boolean): number {
  if (final) return buffered;
  return buffered >= PIECE ? Math.floor(buffered / GRAIN) * GRAIN : 0;
}

/** Drive's Content-Range for a piece: "bytes 0-8388607/*", or with the total on the last one. */
export function contentRange(start: number, length: number, total: number | null): string {
  if (length === 0) return `bytes */${total ?? '*'}`;
  return `bytes ${start}-${start + length - 1}/${total ?? '*'}`;
}

/** The first byte Drive does not have yet, from a 308's Range header ("bytes=0-8388607"). */
export function confirmedUpTo(range: string | null): number {
  const m = /bytes=0-(\d+)/.exec(range ?? '');
  return m ? Number(m[1]) + 1 : 0;
}

/**
 * Sends a recording to a Drive resumable upload, in order, one piece at a time. A piece that fails is tried again
 * (after asking Drive how much it has) up to four times.
 */
export class ResumableUpload {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  #pending: Blob = new Blob([]);
  #sent = 0;
  #chain: Promise<void> = Promise.resolve();
  #error: Error | null = null;
  fileId: string | null = null;

  // The default calls the browser's fetch on its own: kept as a field and called as `this.#fetch(...)`, Chrome throws
  // "Illegal invocation" (live Nov 27: the first recording was lost to it).
  constructor(url: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
    this.#url = url;
    this.#fetch = fetchImpl;
  }

  get sentBytes(): number {
    return this.#sent;
  }

  /** Everything recorded so far: sent, and waiting for its piece. */
  get recordedBytes(): number {
    return this.#sent + this.#pending.size;
  }

  get error(): Error | null {
    return this.#error;
  }

  add(data: Blob): void {
    this.#pending = new Blob([this.#pending, data]);
    this.#chain = this.#chain.then(() => this.#pump(false));
  }

  /** Sends what is left as the last piece; resolves with Drive's file id. */
  async finish(): Promise<string> {
    this.#chain = this.#chain.then(() => this.#pump(true));
    await this.#chain;
    if (this.#error) throw this.#error;
    if (!this.fileId) throw new Error('Drive did not confirm the recording.');
    return this.fileId;
  }

  async #pump(final: boolean): Promise<void> {
    if (this.#error) return;
    for (;;) {
      const size = sendable(this.#pending.size, final);
      if (!size && !(final && !this.fileId)) return;
      const piece = this.#pending.slice(0, size);
      const total = final && size === this.#pending.size ? this.#sent + size : null;
      try {
        await this.#put(piece, total);
      } catch (error) {
        this.#error = error as Error;
        return;
      }
      if (total !== null) return;
    }
  }

  /**
   * Sends one piece. Drive answers 308 with how much it has (`Range`) while the upload goes on, and 200/201 with the
   * file when the last piece (with the total) is in. On a network error or a 5xx/429 it asks Drive how much it has and
   * sends the rest, four tries at most; another 4xx ends the upload.
   */
  async #put(piece: Blob, total: number | null): Promise<void> {
    const accept = (upTo: number) => {
      const took = Math.max(0, upTo - this.#sent);
      this.#pending = this.#pending.slice(took);
      this.#sent += took;
      return took;
    };
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.#fetch(this.#url, {
          method: 'PUT',
          headers: { 'Content-Range': contentRange(this.#sent, piece.size, total) },
          body: piece,
        });
        if (res.status === 308) {
          const took = accept(confirmedUpTo(res.headers.get('range')));
          if (total === null) return; // more pieces follow; the pump sends what Drive didn't keep
          piece = piece.slice(took); // the last piece: Drive kept part of it, send the rest
          continue;
        }
        if (res.ok) {
          const body = (await res.json().catch(() => ({}))) as { id?: string };
          accept(this.#sent + piece.size);
          this.fileId = body.id ?? null;
          return;
        }
        if (res.status < 500 && res.status !== 429)
          throw new RefusedError(`Drive refused the recording (${res.status}).`);
        throw new Error(`Drive answered ${res.status}.`);
      } catch (error) {
        if (attempt >= 4 || error instanceof RefusedError) throw error;
        await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
        // Ask Drive what it has before sending again.
        const status = await this.#fetch(this.#url, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes */${total ?? '*'}` },
        }).catch(() => null);
        if (status?.status === 308) {
          piece = piece.slice(accept(confirmedUpTo(status.headers.get('range'))));
          if (total === null && !piece.size) return;
        } else if (status?.ok) {
          this.fileId = ((await status.json().catch(() => ({}))) as { id?: string }).id ?? null;
          accept(this.#sent + this.#pending.size);
          return;
        }
      }
    }
  }
}

class RefusedError extends Error {}

/** The best WebM the browser records. */
export function recordingMime(
  isTypeSupported: (type: string) => boolean = t => MediaRecorder.isTypeSupported(t),
): string {
  for (const type of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    if (isTypeSupported(type)) return type;
  }
  return 'video/webm';
}
