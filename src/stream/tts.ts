import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import path from "path";
import type { Readable } from "stream";
import { fileURLToPath } from "url";
import { AudioFileStore, saveAudioStream } from "./audio-files.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, "../../overlay/audio");

const audioFiles = new AudioFileStore(AUDIO_DIR);

let ttsInstance: MsEdgeTTS | null = null;
let initPromise: Promise<MsEdgeTTS> | null = null;

// Voice options — pick one that sounds good for a chaotic game character
// en-US-GuyNeural is a male voice with good range
// en-US-ChristopherNeural is another solid male option
const VOICE = "en-US-GuyNeural";

/**
 * Single-flight accessor for the shared Edge TTS connection.
 *
 * All five bot brains call generateSpeech() fire-and-forget, so this runs
 * concurrently. Without the shared initPromise every racer constructed its
 * own MsEdgeTTS and opened its own WebSocket to Microsoft, and all but one
 * were orphaned — an open TLS socket is a live libuv handle, so dropping the
 * last reference makes it unreachable AND immortal.
 *
 * ttsInstance is published only after setMetadata() resolves; exposing it
 * earlier makes concurrent toStream() calls throw "Speech synthesis not
 * configured yet".
 */
async function getTTS(): Promise<MsEdgeTTS> {
  if (ttsInstance) return ttsInstance;

  if (!initPromise) {
    initPromise = (async () => {
      const instance = new MsEdgeTTS();
      try {
        await instance.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      } catch (err) {
        // Never drop a half-open socket on the floor — it leaks permanently.
        closeQuietly(instance);
        throw err;
      }
      ttsInstance = instance;
      return instance;
    })().finally(() => {
      // Settled either way: successful callers now hit the ttsInstance fast
      // path, and a failed init leaves the slot clear for a fresh retry.
      initPromise = null;
    });
  }

  return initPromise;
}

function closeQuietly(instance: MsEdgeTTS | null): void {
  try {
    instance?.close();
  } catch {
    /* socket already dead — nothing to reclaim */
  }
}

/**
 * Tear down the shared connection so the next call reconnects cleanly.
 * Closing before dropping the reference is what prevents the socket leak.
 */
function discardTTS(): void {
  closeQuietly(ttsInstance);
  ttsInstance = null;
}

/**
 * Only one synthesis runs at a time.
 *
 * MsEdgeTTS._send() reconnects whenever its socket is not OPEN:
 *
 *   for (let i = 1; i <= 3 && this._ws.readyState !== this._ws.OPEN; i++)
 *       await this._initClient();   // overwrites this._ws, never closes it
 *
 * Concurrent callers all observe the same non-OPEN socket and each drive that
 * loop, so the orphans multiply. Measured: 5 concurrent calls after a 45s idle
 * gap orphaned ~692 sockets, and a 19h session accumulated 55,219. Serialising
 * keeps at most one _initClient() in flight.
 */
let synthesizing = false;

/**
 * Microsoft drops idle Edge TTS connections. Letting _send() discover that and
 * reconnect is the unsafe path, so retire the instance ourselves once it has
 * been idle long enough to be suspect.
 */
const IDLE_RECYCLE_MS = 15_000;
let lastSynthesisAt = 0;

/**
 * Generate a TTS audio file from text and return the filename.
 * Files are saved to overlay/audio/ and served via the overlay HTTP server.
 */
export async function generateSpeech(text: string): Promise<string | null> {
  // Local-only operation must never send bot thoughts to an external speech service.
  if (process.env.TTS_ENABLED === "false") return null;
  // Thoughts are ephemeral livestream flavour. Dropping one while another is
  // mid-flight beats queueing a backlog that never drains.
  if (synthesizing) return null;
  synthesizing = true;

  let audioStream: Readable | undefined;

  try {
    if (ttsInstance && Date.now() - lastSynthesisAt > IDLE_RECYCLE_MS) {
      discardTTS();
    }

    const tts = await getTTS();
    audioStream = tts.toStream(text).audioStream;
    const audioUrl = await saveAudioStream(audioStream, audioFiles);

    lastSynthesisAt = Date.now();
    return audioUrl;
  } catch (err) {
    console.error("[TTS] Error generating speech:", err);
    // Close before dropping the reference so the WebSocket is actually
    // reclaimed; the next call re-inits via getTTS().
    discardTTS();
    return null;
  } finally {
    // MsEdgeTTS only releases _streams[requestId] from the stream's destroy()
    // handler. Listening for "end" alone retained one entry per synthesis,
    // which is 19k+ live stream objects in a 19h session.
    try {
      audioStream?.destroy();
    } catch {
      /* already destroyed */
    }
    synthesizing = false;
  }
}
