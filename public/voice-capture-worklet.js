// The voice agent's microphone tap: an AudioWorklet that gathers the microphone's samples into chunks of about 100 ms
// and posts them to the side panel, which turns them into 16-bit PCM for the voice model. A file of its own because an
// extension page may only load worklet code from the extension itself. No audio is kept here.
const CHUNK = 2400;

class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(CHUNK);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let read = 0;
    while (read < channel.length) {
      const take = Math.min(CHUNK - this.filled, channel.length - read);
      this.buffer.set(channel.subarray(read, read + take), this.filled);
      this.filled += take;
      read += take;
      if (this.filled === CHUNK) {
        this.port.postMessage(this.buffer.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('voice-capture', VoiceCapture);
