// The notetaker's recording when Chrome won't hand the worker the Meet tab (Bash AI's icon wasn't clicked on that tab):
// the person picks the tab in Chrome's share picker, and the panel records it. It then lives in the panel (closing the
// panel stops it); otherwise the offscreen document records (src/ui/meeting-recorder.ts, src/extension/meet-notes.ts).
import { startRecordingUpload } from '@src/store/command-center';
import { MeetingRecorder, RecorderHost, openMicrophone } from '@src/ui/meeting-recorder';

const host = new RecorderHost();
let listening = false;

/** Records the tab the person picks; call it while the click still counts (Chrome's picker needs one). */
export async function recordWithPicker(key: string, title: string): Promise<{ withMic: boolean }> {
  if (!listening) {
    listening = true;
    chrome.runtime.onMessage.addListener((message, _sender, reply) => host.handle(message, reply));
  }
  const tab = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser', frameRate: 15 },
    audio: true,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'exclude',
    systemAudio: 'exclude',
  } as unknown as DisplayMediaStreamOptions);
  try {
    const mic = await openMicrophone();
    const upload = await startRecordingUpload({ title, startedAt: new Date().toISOString(), mimeType: 'video/webm' });
    // The picker doesn't silence the tab, so nothing is played back.
    const recorder = new MeetingRecorder({ tab, mic, uploadUrl: upload.uploadUrl, playBack: false });
    host.add(key, recorder);
    return { withMic: recorder.withMic };
  } catch (error) {
    for (const track of tab.getTracks()) track.stop();
    throw error;
  }
}
