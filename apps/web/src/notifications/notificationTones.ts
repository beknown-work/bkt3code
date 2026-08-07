/**
 * T3-CUSTOM(expbkt3): Built-in alert tones.
 *
 * Tones are synthesized from these specs at play time rather than shipped as
 * audio files. That keeps binary assets out of a fork that merges from upstream
 * weekly, makes every tone diffable and reviewable, and costs nothing at
 * runtime — each one is a handful of oscillators.
 *
 * Frequencies are equal-temperament notes; the pleasant ones are intervals that
 * consonate (a fifth, a major third, an octave). Every voice decays
 * exponentially, because an abrupt gate sounds like a click, not a chime.
 */

export interface ToneVoice {
  /** Hz. */
  readonly frequency: number;
  /** Milliseconds after the tone starts. */
  readonly startMs: number;
  readonly durationMs: number;
  readonly type: OscillatorType;
  /** Peak gain before the user's volume preference is applied, 0..1. */
  readonly gain: number;
}

export interface ToneSpec {
  readonly id: string;
  readonly label: string;
  readonly voices: ReadonlyArray<ToneVoice>;
}

const note = (
  frequency: number,
  startMs: number,
  durationMs: number,
  gain: number,
  type: OscillatorType = "sine",
): ToneVoice => ({ frequency, startMs, durationMs, type, gain });

export const BUILT_IN_TONES: ReadonlyArray<ToneSpec> = [
  {
    id: "chime",
    label: "Chime",
    // A rising fifth with a soft harmonic on top: the classic "look at me" that
    // does not read as an error.
    voices: [
      note(880, 0, 700, 0.5, "triangle"),
      note(1318.51, 90, 900, 0.4, "triangle"),
      note(2637.02, 90, 500, 0.09, "sine"),
    ],
  },
  {
    id: "ping",
    label: "Ping",
    voices: [note(1174.66, 0, 420, 0.55, "sine"), note(2349.32, 0, 200, 0.1, "sine")],
  },
  {
    id: "marimba",
    label: "Marimba",
    voices: [
      note(659.25, 0, 380, 0.5, "triangle"),
      note(987.77, 80, 380, 0.45, "triangle"),
      note(1318.51, 160, 700, 0.4, "triangle"),
    ],
  },
  {
    id: "bell",
    label: "Bell",
    // Inharmonic partials are what make a bell sound like a bell.
    voices: [
      note(587.33, 0, 1500, 0.42, "sine"),
      note(1396.91, 0, 1200, 0.16, "sine"),
      note(2093, 0, 900, 0.07, "sine"),
    ],
  },
  {
    id: "pulse",
    label: "Pulse",
    voices: [
      note(440, 0, 160, 0.4, "square"),
      note(440, 200, 160, 0.4, "square"),
      note(659.25, 400, 320, 0.4, "square"),
    ],
  },
  {
    id: "alarm",
    label: "Alarm",
    // Reserved for the pile-up alert: three rising notes read as escalation.
    voices: [
      note(523.25, 0, 260, 0.5, "triangle"),
      note(698.46, 170, 260, 0.5, "triangle"),
      note(1046.5, 340, 900, 0.55, "triangle"),
      note(1567.98, 340, 500, 0.12, "sine"),
    ],
  },
  {
    id: "knock",
    label: "Knock",
    voices: [note(180, 0, 130, 0.6, "sine"), note(150, 170, 200, 0.6, "sine")],
  },
] as const;

export const DEFAULT_TONE_ID = "chime";
export const CUSTOM_TONE_ID_PREFIX = "custom:";

export function isCustomToneId(toneId: string): boolean {
  return toneId.startsWith(CUSTOM_TONE_ID_PREFIX);
}

export function customToneIdFor(recordId: string): string {
  return `${CUSTOM_TONE_ID_PREFIX}${recordId}`;
}

export function customToneRecordId(toneId: string): string {
  return toneId.slice(CUSTOM_TONE_ID_PREFIX.length);
}

export function findBuiltInTone(toneId: string): ToneSpec | null {
  return BUILT_IN_TONES.find((tone) => tone.id === toneId) ?? null;
}

/** Total wall-clock length of a tone, used to bound the audio graph's lifetime. */
export function toneDurationMs(tone: ToneSpec): number {
  return tone.voices.reduce(
    (longest, voice) => Math.max(longest, voice.startMs + voice.durationMs),
    0,
  );
}
