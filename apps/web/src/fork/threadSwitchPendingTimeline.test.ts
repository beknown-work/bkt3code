import { describe, expect, it } from "vite-plus/test";

import {
  shouldFollowEndAfterHistoryLoads,
  withRememberedHistoryWhileLoading,
} from "./threadSwitchPendingTimeline";

const history = [{ id: "first" }, { id: "reply" }, { id: "latest" }];
const sent = { id: "sent" };

describe("withRememberedHistoryWhileLoading", () => {
  const loadingWithSend = {
    loading: true,
    serverMessageCount: 0,
    entries: [sent],
    remembered: history,
  };

  it("keeps the remembered history above a message sent while it loads", () => {
    expect(withRememberedHistoryWhileLoading(loadingWithSend).map((entry) => entry.id)).toEqual([
      "first",
      "reply",
      "latest",
      "sent",
    ]);
  });

  it("does not repeat a pending row the remembered history already shows", () => {
    expect(
      withRememberedHistoryWhileLoading({ ...loadingWithSend, entries: [{ id: "latest" }] }),
    ).toBe(history);
  });

  it("hands over to the live timeline once the server has delivered messages", () => {
    const live = [...history, sent];
    expect(
      withRememberedHistoryWhileLoading({
        ...loadingWithSend,
        serverMessageCount: 3,
        entries: live,
      }),
    ).toBe(live);
  });

  it("leaves the live timeline alone when loading has finished", () => {
    expect(withRememberedHistoryWhileLoading({ ...loadingWithSend, loading: false })).toEqual([
      sent,
    ]);
  });

  it("has nothing to keep for a thread that was never painted", () => {
    expect(withRememberedHistoryWhileLoading({ ...loadingWithSend, remembered: null })).toEqual([
      sent,
    ]);
  });
});

describe("shouldFollowEndAfterHistoryLoads", () => {
  const finishedUnderSend = {
    wasLoading: true,
    loading: false,
    pendingSendCount: 1,
    followingEnd: true,
  };

  it("follows the end when history finishes loading under a send", () => {
    expect(shouldFollowEndAfterHistoryLoads(finishedUnderSend)).toBe(true);
  });

  it("leaves a reader who scrolled away where they are", () => {
    expect(shouldFollowEndAfterHistoryLoads({ ...finishedUnderSend, followingEnd: false })).toBe(
      false,
    );
  });

  it("does nothing for an ordinary thread open without a send", () => {
    expect(shouldFollowEndAfterHistoryLoads({ ...finishedUnderSend, pendingSendCount: 0 })).toBe(
      false,
    );
  });

  it("only fires on the transition out of loading", () => {
    expect(shouldFollowEndAfterHistoryLoads({ ...finishedUnderSend, wasLoading: false })).toBe(
      false,
    );
    expect(shouldFollowEndAfterHistoryLoads({ ...finishedUnderSend, loading: true })).toBe(false);
  });
});
