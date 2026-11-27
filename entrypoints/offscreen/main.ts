// The offscreen document: it does what the worker cannot. It turns text into a Blob and a URL for chrome.downloads,
// and revokes the URL when the worker says the download ended. And it holds the notetaker's meeting recordings
// (src/ui/meeting-recorder.ts), so closing the side panel doesn't stop one. It uses only the runtime API.
import { MeetingRecorder, RecorderHost, openMicrophone } from '@src/ui/meeting-recorder';

const urls = new Set<string>();
const recordings = new RecorderHost();

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  const later = recordings.handle(message, reply);
  if (later !== undefined || (message?.target === 'recorder' && recordings.has(message.key))) return later;
  if (message?.target === 'recorder' && message.type === 'rec-start') {
    void startRecording(message as { key: string; streamId: string; uploadUrl: string }).then(reply, (error: Error) =>
      reply({ error: error.message }),
    );
    return true;
  }
  if (message?.target !== 'offscreen') return undefined;
  if (message.type === 'blob-url') {
    const url = URL.createObjectURL(new Blob([message.content as string], { type: message.mimeType as string }));
    urls.add(url);
    reply({ url });
  } else if (message.type === 'revoke') {
    URL.revokeObjectURL(message.url as string);
    urls.delete(message.url as string);
    // A recording keeps the document open as a held URL does.
    reply({ held: urls.size + recordings.size });
  }
  return undefined;
});

/** The Meet tab Chrome handed the worker (a tabCapture stream id), with the person's microphone mixed in. */
async function startRecording(input: { key: string; streamId: string; uploadUrl: string }) {
  const tab = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: input.streamId } },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: input.streamId,
        maxWidth: 1280,
        maxHeight: 720,
        maxFrameRate: 15,
      },
    },
  } as unknown as MediaStreamConstraints);
  const mic = await openMicrophone();
  const recorder = new MeetingRecorder({ tab, mic, uploadUrl: input.uploadUrl, playBack: true });
  recordings.add(input.key, recorder);
  return { ok: true, withMic: recorder.withMic };
}
