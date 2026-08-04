import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createPlannotatorPollingController,
  PLANNOTATOR_CLIENT_ID_HEADER,
  releasePlannotatorClientLease,
} from "./PlannotatorFocusSurface.polling";

const reviewUrl = "/plannotator/review_token/" as const;
const clientId = "11111111-1111-4111-8111-111111111111";

function jsonResponse(value: unknown): Response {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue(value),
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Plannotator status polling", () => {
  it.each(["exited", "error"] as const)(
    "stops permanently after the terminal %s status",
    async (status) => {
      const fetchStatus = vi.fn().mockResolvedValue(jsonResponse({ status, decision: null }));
      const onTerminal = vi.fn();
      const controller = createPlannotatorPollingController({
        url: reviewUrl,
        clientId,
        visible: true,
        fetch: fetchStatus,
        onDecision: vi.fn(),
        onTerminal,
      });

      controller.start();
      await vi.advanceTimersByTimeAsync(750);

      expect(fetchStatus).toHaveBeenCalledTimes(1);
      expect(fetchStatus).toHaveBeenCalledWith(
        "/plannotator/review_token/__t3/status",
        expect.objectContaining({
          cache: "no-store",
          credentials: "same-origin",
          headers: { [PLANNOTATOR_CLIENT_ID_HEADER]: clientId },
        }),
      );
      expect(onTerminal).toHaveBeenCalledOnce();
      expect(onTerminal).toHaveBeenCalledWith(status);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchStatus).toHaveBeenCalledTimes(1);
      expect(onTerminal).toHaveBeenCalledOnce();
    },
  );

  it("backs off while hidden and resumes immediately when visible", async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: "running", decision: null }));
    const controller = createPlannotatorPollingController({
      url: reviewUrl,
      clientId,
      visible: false,
      fetch: fetchStatus,
      onDecision: vi.fn(),
      onTerminal: vi.fn(),
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchStatus).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    controller.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStatus).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(499);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("adopts hidden cadence without leaving a visible timer behind", async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: "running", decision: null }));
    const controller = createPlannotatorPollingController({
      url: reviewUrl,
      clientId,
      visible: true,
      fetch: fetchStatus,
      onDecision: vi.fn(),
      onTerminal: vi.fn(),
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(750);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    controller.setVisible(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_500);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("never overlaps a slow request and uses the latest visibility afterward", async () => {
    const slowResponse = deferred<Response>();
    const fetchStatus = vi
      .fn()
      .mockImplementationOnce(() => slowResponse.promise)
      .mockResolvedValue(jsonResponse({ status: "running", decision: null }));
    const controller = createPlannotatorPollingController({
      url: reviewUrl,
      clientId,
      visible: true,
      fetch: fetchStatus,
      onDecision: vi.fn(),
      onTerminal: vi.fn(),
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(750);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    controller.setVisible(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    slowResponse.resolve(jsonResponse({ status: "running", decision: null }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("aborts on stop and suppresses late terminal callbacks", async () => {
    const slowResponse = deferred<Response>();
    const fetchStatus = vi.fn().mockImplementation(() => slowResponse.promise);
    const onTerminal = vi.fn();
    const controller = createPlannotatorPollingController({
      url: reviewUrl,
      clientId,
      visible: true,
      fetch: fetchStatus,
      onDecision: vi.fn(),
      onTerminal,
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(750);
    const signal = fetchStatus.mock.calls[0]?.[1]?.signal as AbortSignal;

    controller.stop();
    expect(signal.aborted).toBe(true);
    slowResponse.resolve(jsonResponse({ status: "error", decision: null }));
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it("retries network, non-2xx, and malformed pending responses", async () => {
    const fetchStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce(jsonResponse({ unexpected: true }))
      .mockResolvedValue(jsonResponse({ status: "running", decision: null }));
    const onDecision = vi.fn();
    const onTerminal = vi.fn();
    const controller = createPlannotatorPollingController({
      url: reviewUrl,
      clientId,
      visible: true,
      fetch: fetchStatus,
      onDecision,
      onTerminal,
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(750 + 500 * 3);

    expect(fetchStatus).toHaveBeenCalledTimes(4);
    expect(onDecision).not.toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it.each(["approved", "feedback", "denied"] as const)(
    "preserves the %s decision callback and stops",
    async (decision) => {
      const fetchStatus = vi.fn().mockResolvedValue(jsonResponse({ status: decision, decision }));
      const onDecision = vi.fn();
      const controller = createPlannotatorPollingController({
        url: reviewUrl,
        clientId,
        visible: true,
        fetch: fetchStatus,
        onDecision,
        onTerminal: vi.fn(),
      });

      controller.start();
      await vi.advanceTimersByTimeAsync(750);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(onDecision).toHaveBeenCalledOnce();
      expect(onDecision).toHaveBeenCalledWith(decision);
      expect(fetchStatus).toHaveBeenCalledTimes(1);
    },
  );

  it("releases browser ownership with an independent keepalive request", async () => {
    const release = vi.fn().mockResolvedValue(jsonResponse(null));

    releasePlannotatorClientLease({ url: reviewUrl, clientId, fetch: release });
    await vi.advanceTimersByTimeAsync(0);

    expect(release).toHaveBeenCalledWith("/plannotator/review_token/__t3/status", {
      method: "DELETE",
      cache: "no-store",
      credentials: "same-origin",
      headers: { [PLANNOTATOR_CLIENT_ID_HEADER]: clientId },
      keepalive: true,
    });
  });
});
