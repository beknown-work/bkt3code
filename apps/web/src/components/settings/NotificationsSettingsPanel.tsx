/**
 * T3-CUSTOM(expbkt3): Notification settings surface.
 *
 * A dedicated panel behind a guarded route, so the only upstream-facing seams
 * are one settings path entry and one nav icon.
 */
import { BellIcon, PlayIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { randomUUID } from "../../lib/utils";

import {
  browserNotificationPermission,
  requestBrowserNotificationPermission,
  type BrowserNotificationPermission,
} from "../../notifications/browserNotifications";
import {
  deleteCustomTone,
  listCustomTones,
  saveCustomTone,
  validateCustomToneFile,
  type CustomToneSummary,
} from "../../notifications/customToneStorage";
import {
  MAX_UNREAD_THRESHOLD,
  MIN_UNREAD_THRESHOLD,
  NOTIFICATION_EVENT_DESCRIPTIONS,
  NOTIFICATION_EVENT_IDS,
  NOTIFICATION_EVENT_LABELS,
  type NotificationEventId,
} from "../../notifications/notificationEvents.logic";
import { useNotificationPreferences } from "../../notifications/notificationPreferences";
import { forgetCustomTone, playTone, unlockAudio } from "../../notifications/notificationSound";
import {
  BUILT_IN_TONES,
  customToneIdFor,
  isCustomToneId,
} from "../../notifications/notificationTones";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function permissionStatusLabel(permission: BrowserNotificationPermission): string {
  switch (permission) {
    case "granted":
      return "Allowed by this browser.";
    case "denied":
      return "Blocked by this browser. Re-allow notifications in site settings.";
    case "unsupported":
      return "This browser does not support native notifications.";
    case "default":
      return "Not requested yet.";
  }
}

function toneLabel(
  toneId: string,
  customTones: ReadonlyArray<CustomToneSummary>,
): string | undefined {
  if (isCustomToneId(toneId)) {
    return customTones.find((tone) => customToneIdFor(tone.id) === toneId)?.name;
  }
  return BUILT_IN_TONES.find((tone) => tone.id === toneId)?.label;
}

function EventToneRow({
  eventId,
  customTones,
  onPreview,
}: {
  readonly eventId: NotificationEventId;
  readonly customTones: ReadonlyArray<CustomToneSummary>;
  readonly onPreview: (toneId: string, volume: number) => void;
}) {
  const preference = useNotificationPreferences((state) => state.events[eventId]);
  const setEventPreference = useNotificationPreferences((state) => state.setEventPreference);
  const label = toneLabel(preference.toneId, customTones);

  return (
    <SettingsRow
      title={NOTIFICATION_EVENT_LABELS[eventId]}
      description={NOTIFICATION_EVENT_DESCRIPTIONS[eventId]}
      control={
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Select
            value={preference.toneId}
            onValueChange={(value) => setEventPreference(eventId, { toneId: String(value) })}
          >
            <SelectTrigger
              className="w-full sm:w-40"
              aria-label={`Tone for ${NOTIFICATION_EVENT_LABELS[eventId]}`}
              disabled={!preference.enabled}
            >
              <SelectValue>{label ?? "Missing tone"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {BUILT_IN_TONES.map((tone) => (
                <SelectItem hideIndicator key={tone.id} value={tone.id}>
                  {tone.label}
                </SelectItem>
              ))}
              {customTones.map((tone) => (
                <SelectItem hideIndicator key={tone.id} value={customToneIdFor(tone.id)}>
                  {tone.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            size="sm"
            variant="outline"
            aria-label={`Test ${NOTIFICATION_EVENT_LABELS[eventId]} tone`}
            onClick={() => onPreview(preference.toneId, preference.volume)}
          >
            <PlayIcon className="size-3.5" />
          </Button>
          <Switch
            checked={preference.enabled}
            aria-label={`Enable ${NOTIFICATION_EVENT_LABELS[eventId]}`}
            onCheckedChange={(checked) => setEventPreference(eventId, { enabled: checked })}
          />
        </div>
      }
    >
      <label className="flex items-center gap-3 pb-3 text-xs text-muted-foreground">
        <span className="w-12 shrink-0">Volume</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(preference.volume * 100)}
          disabled={!preference.enabled}
          aria-label={`Volume for ${NOTIFICATION_EVENT_LABELS[eventId]}`}
          className="h-1 w-full max-w-56 cursor-pointer accent-primary"
          onChange={(event) =>
            setEventPreference(eventId, { volume: Number(event.target.value) / 100 })
          }
        />
        <span className="w-8 shrink-0 text-right tabular-nums">
          {Math.round(preference.volume * 100)}%
        </span>
      </label>
    </SettingsRow>
  );
}

export function NotificationsSettingsPanel() {
  const enabled = useNotificationPreferences((state) => state.enabled);
  const setEnabled = useNotificationPreferences((state) => state.setEnabled);
  const browserNotifications = useNotificationPreferences((state) => state.browserNotifications);
  const setBrowserNotifications = useNotificationPreferences(
    (state) => state.setBrowserNotifications,
  );
  const unreadThreshold = useNotificationPreferences((state) => state.unreadThreshold);
  const setUnreadThreshold = useNotificationPreferences((state) => state.setUnreadThreshold);
  const resetToneUsage = useNotificationPreferences((state) => state.resetToneUsage);

  const [permission, setPermission] = useState<BrowserNotificationPermission>("default");
  const [customTones, setCustomTones] = useState<ReadonlyArray<CustomToneSummary>>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [thresholdDraft, setThresholdDraft] = useState(String(unreadThreshold));

  useEffect(() => setPermission(browserNotificationPermission()), []);
  useEffect(() => setThresholdDraft(String(unreadThreshold)), [unreadThreshold]);
  const refreshTones = useCallback(() => {
    listCustomTones()
      .then(setCustomTones)
      .catch(() => setCustomTones([]));
  }, []);
  useEffect(refreshTones, [refreshTones]);

  // Doubles as the AudioContext unlock: browsers only start audio from inside a
  // user gesture, so previewing a tone is what makes later alerts audible.
  const preview = useCallback((toneId: string, volume: number) => {
    void unlockAudio().then(() => playTone(toneId, volume));
  }, []);

  const handleUpload = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      const problem = validateCustomToneFile(file);
      if (problem !== null) {
        setUploadError(problem);
        return;
      }
      setUploadError(null);
      const id = randomUUID();
      saveCustomTone({ id, name: file.name, file, createdAt: new Date().toISOString() })
        .then(() => refreshTones())
        .catch(() => setUploadError("Could not save that file."));
    },
    [refreshTones],
  );

  const handleDelete = useCallback(
    (tone: CustomToneSummary) => {
      deleteCustomTone(tone.id)
        .then(() => {
          forgetCustomTone(tone.id);
          resetToneUsage(customToneIdFor(tone.id));
          refreshTones();
        })
        .catch(() => setUploadError("Could not remove that tone."));
    },
    [refreshTones, resetToneUsage],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Notifications"
        icon={<BellIcon className="size-5 text-muted-foreground" />}
      >
        <SettingsRow
          title="Alerts"
          description="Master switch. Off silences every tone and native notification below."
          control={
            <Switch checked={enabled} aria-label="Enable alerts" onCheckedChange={setEnabled} />
          }
        />
        <SettingsRow
          title="Native notifications"
          description="Shows an operating-system notification when this tab is not visible. Tones still play either way."
          status={permissionStatusLabel(permission)}
          control={
            <div className="flex items-center gap-2">
              {permission === "default" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void requestBrowserNotificationPermission().then(setPermission)}
                >
                  Allow
                </Button>
              ) : null}
              <Switch
                checked={browserNotifications}
                aria-label="Enable native notifications"
                disabled={!enabled || permission === "unsupported"}
                onCheckedChange={setBrowserNotifications}
              />
            </div>
          }
        />
        <SettingsRow
          title="Unread pile-up threshold"
          description="How many finished-but-unopened sessions it takes to trigger the pile-up alert. Counted per browser, like the unread badge itself."
          control={
            <Input
              value={thresholdDraft}
              inputMode="numeric"
              aria-label="Unread pile-up threshold"
              className="w-full sm:w-24"
              disabled={!enabled}
              onChange={(event) => setThresholdDraft(event.target.value)}
              onBlur={() => {
                const parsed = Number.parseInt(thresholdDraft, 10);
                setUnreadThreshold(Number.isFinite(parsed) ? parsed : unreadThreshold);
              }}
              min={MIN_UNREAD_THRESHOLD}
              max={MAX_UNREAD_THRESHOLD}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Events">
        {NOTIFICATION_EVENT_IDS.map((eventId) => (
          <EventToneRow
            key={eventId}
            eventId={eventId}
            customTones={customTones}
            onPreview={preview}
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Your tones">
        <SettingsRow
          title="Upload a tone"
          description="Any audio file under 2 MB. Stored in this browser only, and selectable for any event above."
          status={uploadError ?? undefined}
          control={
            <Button size="sm" variant="outline" render={<label />}>
              <UploadIcon className="size-3.5" />
              Choose file
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(event) => {
                  handleUpload(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </Button>
          }
        />
        {customTones.map((tone) => (
          <SettingsRow
            key={tone.id}
            title={tone.name}
            description={`${Math.max(1, Math.round(tone.sizeBytes / 1024))} KB · ${tone.mimeType || "audio"}`}
            control={
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Play ${tone.name}`}
                  onClick={() => preview(customToneIdFor(tone.id), 0.7)}
                >
                  <PlayIcon className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Remove ${tone.name}`}
                  onClick={() => handleDelete(tone)}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            }
          />
        ))}
        {customTones.length === 0 ? (
          <p className="px-3 pb-3 text-[13px] text-muted-foreground/80 sm:px-4">
            No uploaded tones yet.
          </p>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
