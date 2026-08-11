/**
 * T3-CUSTOM(expbkt3): Browser-local storage for user-uploaded alert tones.
 *
 * IndexedDB rather than localStorage because these are audio blobs, and rather
 * than the server because the fork deliberately keeps notification preferences
 * client-side — nothing here needs to survive a different machine.
 */

export interface CustomToneRecord {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly blob: Blob;
}

export type CustomToneSummary = Omit<CustomToneRecord, "blob">;

const DB_NAME = "t3code-notification-tones";
const DB_VERSION = 1;
const STORE_NAME = "tones";

/** Generous for a notification sound, small enough that IndexedDB stays healthy. */
export const MAX_CUSTOM_TONE_BYTES = 2 * 1024 * 1024;
export const ACCEPTED_TONE_MIME_PREFIX = "audio/";

export class CustomToneError extends Error {}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new CustomToneError("This browser cannot store custom tones."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new CustomToneError("IndexedDB unavailable.")),
    );
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () =>
        reject(request.error ?? new CustomToneError("Tone storage failed.")),
      );
    });
  } finally {
    database.close();
  }
}

export function validateCustomToneFile(file: {
  readonly type: string;
  readonly size: number;
}): string | null {
  if (!file.type.startsWith(ACCEPTED_TONE_MIME_PREFIX)) {
    return "Choose an audio file.";
  }
  if (file.size > MAX_CUSTOM_TONE_BYTES) {
    return `Audio must be under ${Math.round(MAX_CUSTOM_TONE_BYTES / (1024 * 1024))} MB.`;
  }
  if (file.size === 0) {
    return "That file is empty.";
  }
  return null;
}

export function toSummary(record: CustomToneRecord): CustomToneSummary {
  const { blob: _blob, ...summary } = record;
  return summary;
}

export async function listCustomTones(): Promise<ReadonlyArray<CustomToneSummary>> {
  const records = await withStore<Array<CustomToneRecord>>("readonly", (store) => store.getAll());
  return records
    .map(toSummary)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function readCustomTone(id: string): Promise<CustomToneRecord | null> {
  const record = await withStore<CustomToneRecord | undefined>("readonly", (store) =>
    store.get(id),
  );
  return record ?? null;
}

export async function saveCustomTone(input: {
  readonly id: string;
  readonly name: string;
  readonly file: File;
  readonly createdAt: string;
}): Promise<CustomToneSummary> {
  const record: CustomToneRecord = {
    id: input.id,
    name: input.name,
    mimeType: input.file.type,
    sizeBytes: input.file.size,
    createdAt: input.createdAt,
    blob: input.file,
  };
  await withStore("readwrite", (store) => store.put(record));
  return toSummary(record);
}

export async function deleteCustomTone(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}
