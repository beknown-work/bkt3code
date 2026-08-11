/**
 * T3-CUSTOM(expbkt3): Web Audio playback for alert tones.
 *
 * Browsers refuse to start an AudioContext without a user gesture, so the
 * context is created lazily and `unlockAudio` is called from the settings
 * panel's Test button. Until that happens the first alert of a session may be
 * silent — the settings panel says so rather than pretending otherwise.
 */
import {
  customToneRecordId,
  findBuiltInTone,
  isCustomToneId,
  toneDurationMs,
  type ToneSpec,
} from "./notificationTones";
import { readCustomTone } from "./customToneStorage";

let context: AudioContext | null = null;
const decodedCustomTones = new Map<string, AudioBuffer>();

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Constructor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) return null;
  context ??= new Constructor();
  return context;
}

/** True once the context is running and tones will actually be audible. */
export function isAudioUnlocked(): boolean {
  return context !== null && context.state === "running";
}

export async function unlockAudio(): Promise<boolean> {
  const audio = audioContext();
  if (!audio) return false;
  if (audio.state === "suspended") {
    try {
      await audio.resume();
    } catch {
      return false;
    }
  }
  return audio.state === "running";
}

function playSpec(audio: AudioContext, tone: ToneSpec, volume: number): void {
  const master = audio.createGain();
  master.gain.value = Math.min(1, Math.max(0, volume));
  master.connect(audio.destination);

  const startedAt = audio.currentTime;
  for (const voice of tone.voices) {
    const oscillator = audio.createOscillator();
    const envelope = audio.createGain();
    oscillator.type = voice.type;
    oscillator.frequency.value = voice.frequency;

    const voiceStart = startedAt + voice.startMs / 1_000;
    const voiceEnd = voiceStart + voice.durationMs / 1_000;
    // A short linear attack avoids the click that a hard gate produces; the
    // exponential release is what makes the tail sound like a struck object.
    envelope.gain.setValueAtTime(0.0001, voiceStart);
    envelope.gain.linearRampToValueAtTime(voice.gain, voiceStart + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, voiceEnd);

    oscillator.connect(envelope);
    envelope.connect(master);
    oscillator.start(voiceStart);
    oscillator.stop(voiceEnd + 0.02);
  }

  window.setTimeout(() => master.disconnect(), toneDurationMs(tone) + 400);
}

async function playCustom(audio: AudioContext, toneId: string, volume: number): Promise<boolean> {
  const recordId = customToneRecordId(toneId);
  let buffer = decodedCustomTones.get(recordId);
  if (!buffer) {
    const record = await readCustomTone(recordId);
    if (!record) return false;
    try {
      buffer = await audio.decodeAudioData(await record.blob.arrayBuffer());
    } catch {
      return false;
    }
    decodedCustomTones.set(recordId, buffer);
  }

  const source = audio.createBufferSource();
  const gain = audio.createGain();
  gain.gain.value = Math.min(1, Math.max(0, volume));
  source.buffer = buffer;
  source.connect(gain);
  gain.connect(audio.destination);
  source.start();
  source.addEventListener("ended", () => gain.disconnect());
  return true;
}

/** Drops a decoded tone so a re-upload under the same id is not served stale. */
export function forgetCustomTone(recordId: string): void {
  decodedCustomTones.delete(recordId);
}

/**
 * Plays a tone, resolving to false when nothing was audible — audio is locked,
 * the tone id is unknown, or a custom upload failed to decode.
 */
export async function playTone(toneId: string, volume: number): Promise<boolean> {
  const audio = audioContext();
  if (!audio) return false;
  if (audio.state === "suspended") {
    // Best effort: some browsers allow resume() while a gesture is still in the
    // task queue, which covers "clicked something, then an alert arrived".
    try {
      await audio.resume();
    } catch {
      return false;
    }
  }
  if (audio.state !== "running") return false;

  if (isCustomToneId(toneId)) return playCustom(audio, toneId, volume);

  const spec = findBuiltInTone(toneId);
  if (!spec) return false;
  playSpec(audio, spec, volume);
  return true;
}
