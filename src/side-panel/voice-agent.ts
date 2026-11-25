// The voice agent: a live spoken conversation with OpenAI's or Grok's realtime voice model, in the side panel. The
// person talks; the voice model answers aloud, looks things up in Command Center, and hands work in the browser to the
// browser agent (the same agent the composer runs), then says what came of it.
//
// Command Center mints a short-lived secret for the session with the company's key; the panel connects to the
// provider with that secret, so the key never reaches the browser. Audio is streamed, never kept.
import { MicStream, PcmPlayer } from '@src/ui/realtime-audio';
import type { MicError } from '@src/ui/realtime-audio';

export type VoiceProvider = 'openai' | 'grok';

/** What Command Center hands back for a session: where to connect and how to present the secret. */
export interface VoiceGrant {
  provider: VoiceProvider;
  /** The provider's realtime WebSocket address. */
  url: string;
  /** WebSocket subprotocols that carry the short-lived secret (a browser WebSocket cannot set headers). */
  protocols: string[];
  model: string;
  voice: string;
}

export interface VoiceToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type VoiceState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'closed';

export interface VoiceLine {
  who: 'you' | 'ai';
  text: string;
}

export interface VoiceAgentOptions {
  instructions: string;
  tools: VoiceToolDefinition[];
  /** Runs a tool the voice model called; the text goes back to it. */
  runTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  onState: (state: VoiceState) => void;
  /** A finished line of the conversation, the person's or the voice model's. */
  onLine: (line: VoiceLine) => void;
  onError: (message: string) => void;
}

/**
 * The session settings for a provider: instructions, tools, the voice, 24 kHz PCM both ways, turn detection on the
 * server, and captions of what the person says. The two APIs share event names but not this shape: OpenAI keeps the
 * voice and turn detection under `audio` and needs `type`; xAI keeps them at the top.
 *   OpenAI: developers.openai.com, realtime client events (session.update)
 *   xAI: docs.x.ai, audio/speech-to-speech
 */
export function sessionUpdate(grant: VoiceGrant, options: Pick<VoiceAgentOptions, 'instructions' | 'tools'>): object {
  const tools = options.tools.map(t => ({ type: 'function', ...t }));
  const pcm = { type: 'audio/pcm', rate: 24_000 };
  if (grant.provider === 'openai') {
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: options.instructions,
        tools,
        tool_choice: 'auto',
        audio: {
          input: {
            format: pcm,
            turn_detection: { type: 'server_vad' },
            // gpt-transcribe works in a realtime session over WebSocket, which this is.
            transcription: { model: 'gpt-transcribe' },
          },
          output: { format: pcm, voice: grant.voice },
        },
      },
    };
  }
  return {
    type: 'session.update',
    session: {
      instructions: options.instructions,
      voice: grant.voice,
      turn_detection: { type: 'server_vad' },
      audio: { input: { format: pcm, transcription: { model: 'grok-transcribe' } }, output: { format: pcm } },
      tools,
    },
  };
}

/** The connection opened but no session started: try again with a new secret (xAI documents ~1 in 10). */
export class NoSessionError extends Error {}

interface ServerEvent {
  type: string;
  delta?: string;
  transcript?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  error?: { message?: string };
}

/** Event names the two providers use for the same thing, read as one. */
export function eventKind(type: string): string {
  switch (type) {
    case 'response.output_audio.delta':
    case 'response.audio.delta':
      return 'audio';
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      return 'ai-said';
    case 'conversation.item.input_audio_transcription.completed':
      return 'you-said';
    case 'input_audio_buffer.speech_started':
      return 'barge-in';
    case 'input_audio_buffer.speech_stopped':
      return 'thinking';
    case 'response.function_call_arguments.done':
      return 'tool';
    case 'session.created':
      return 'session';
    case 'response.done':
      return 'done';
    case 'error':
      return 'error';
    default:
      return 'other';
  }
}

export class VoiceAgent {
  #socket: WebSocket | null = null;
  #mic: MicStream | null = null;
  #player = new PcmPlayer();
  #closed = false;
  #idleTimer: ReturnType<typeof setInterval> | null = null;
  #sessionStarted: (() => void) | null = null;
  /** Tool calls of the reply being made: answered together when the reply is done, then one new reply is asked for. */
  #calls: Array<Promise<{ call_id: string; output: string }>> = [];

  constructor(
    readonly grant: VoiceGrant,
    readonly options: VoiceAgentOptions,
  ) {}

  /**
   * Connects, waits for the provider to start the session (five seconds at most: NoSessionError, so the caller can try
   * a new secret), sets the session up and opens the microphone. Resolves with the microphone's error, if any.
   */
  async start(): Promise<MicError | null> {
    this.options.onState('connecting');
    const socket = new WebSocket(this.grant.url, this.grant.protocols);
    this.#socket = socket;
    const started = new Promise<void>(resolve => (this.#sessionStarted = resolve));
    socket.onmessage = event => void this.#onEvent(JSON.parse(String(event.data)) as ServerEvent);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('The voice service could not be reached.'));
    });
    const timeout = new Promise<'late'>(resolve => setTimeout(() => resolve('late'), 5_000));
    if ((await Promise.race([started, timeout])) === 'late') {
      socket.onclose = null;
      socket.close();
      throw new NoSessionError('The voice session did not start.');
    }
    socket.onclose = () => this.stop();
    socket.onerror = () => this.options.onError('The voice connection failed.');
    this.#send(sessionUpdate(this.grant, this.options));
    const mic = await MicStream.start(chunk => this.#send({ type: 'input_audio_buffer.append', audio: chunk }));
    if (typeof mic === 'string') {
      this.stop();
      return mic;
    }
    this.#mic = mic;
    this.options.onState('listening');
    // The speaking state ends when the last of the answer has played.
    this.#idleTimer = setInterval(() => {
      if (!this.#player.speaking && !this.#closed) this.options.onState('listening');
    }, 400);
    return null;
  }

  /** How loud each side is right now, 0 to 1, for the wave: the person (microphone) and the answer (speaker). */
  levels(): { input: number; output: number } {
    return { input: this.#mic?.level() ?? 0, output: this.#player.level() };
  }

  /**
   * Tells the voice model something happened (a browser task ended) and has it say so. Sent as the person's side of
   * the conversation in brackets, which both providers accept.
   */
  report(text: string): void {
    this.#send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    this.#send({ type: 'response.create' });
  }

  stop(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#idleTimer) clearInterval(this.#idleTimer);
    this.#mic?.stop();
    this.#player.close();
    if (this.#socket && this.#socket.readyState <= WebSocket.OPEN) this.#socket.close();
    this.options.onState('closed');
  }

  #send(event: object): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(event));
  }

  async #onEvent(event: ServerEvent): Promise<void> {
    switch (eventKind(event.type)) {
      case 'audio':
        if (event.delta) {
          this.#player.play(event.delta);
          this.options.onState('speaking');
        }
        return;
      case 'ai-said':
        if (event.transcript?.trim()) this.options.onLine({ who: 'ai', text: event.transcript.trim() });
        return;
      case 'you-said':
        if (event.transcript?.trim()) this.options.onLine({ who: 'you', text: event.transcript.trim() });
        return;
      case 'barge-in':
        // The person talks over the answer: stop playing it at once.
        this.#player.clear();
        this.options.onState('listening');
        return;
      case 'thinking':
        this.options.onState('thinking');
        return;
      case 'session':
        this.#sessionStarted?.();
        return;
      case 'tool': {
        if (!event.call_id || !event.name) return;
        let args: Record<string, unknown> = {};
        try {
          args = event.arguments ? (JSON.parse(event.arguments) as Record<string, unknown>) : {};
        } catch {
          // Left empty: the tool says what it is missing.
        }
        const callId = event.call_id;
        this.options.onState('thinking');
        this.#calls.push(
          this.options
            .runTool(event.name, args)
            .catch((error: Error) => `error: ${error?.message ?? error}`)
            .then(output => ({ call_id: callId, output })),
        );
        return;
      }
      case 'done': {
        // Every answer goes back before one new reply is asked for, as both providers document.
        if (!this.#calls.length) return;
        const answers = await Promise.all(this.#calls.splice(0));
        for (const answer of answers) {
          this.#send({ type: 'conversation.item.create', item: { type: 'function_call_output', ...answer } });
        }
        this.#send({ type: 'response.create' });
        return;
      }
      case 'error':
        this.options.onError(event.error?.message ?? 'The voice service reported an error.');
        return;
      default:
        return;
    }
  }
}
