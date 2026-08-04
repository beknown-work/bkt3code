import { describe, expect, it } from "vite-plus/test";

import {
  LEGACY_PLANNOTATOR_CLIENT_ID,
  PLANNOTATOR_CLIENT_LEASE_MS,
  PlannotatorClientLease,
} from "./PlannotatorClientLease.ts";

const token = "review-token";
const browserA = "11111111-1111-4111-8111-111111111111";
const browserB = "22222222-2222-4222-8222-222222222222";

describe("PlannotatorClientLease", () => {
  it("keeps a review owned until its final browser releases", () => {
    const leases = new PlannotatorClientLease();
    leases.registerReview(token, 0);
    leases.renew(token, browserA, 1);
    leases.renew(token, browserB, 2);

    expect(leases.release(token, browserA, 3)).toBe(false);
    expect(leases.isOwned(token, 3)).toBe(true);
    expect(leases.release(token, browserB, 4)).toBe(true);
    expect(leases.isOwned(token, 4)).toBe(false);
    expect(leases.release(token, browserB, 5)).toBe(false);
  });

  it("keeps one current browser when another expires", () => {
    const leases = new PlannotatorClientLease();
    leases.renew(token, browserA, 0);
    leases.renew(token, browserB, PLANNOTATOR_CLIENT_LEASE_MS - 1);

    expect(leases.collectExpired(PLANNOTATOR_CLIENT_LEASE_MS + 1)).toEqual([]);
    expect(leases.isOwned(token, PLANNOTATOR_CLIENT_LEASE_MS + 1)).toBe(true);
  });

  it("reports a review once when every browser expires", () => {
    const leases = new PlannotatorClientLease();
    leases.renew(token, browserA, 0);
    leases.renew(token, browserB, 1);

    expect(leases.collectExpired(PLANNOTATOR_CLIENT_LEASE_MS + 2)).toEqual([token]);
    expect(leases.collectExpired(PLANNOTATOR_CLIENT_LEASE_MS + 3)).toEqual([]);
  });

  it("keeps a hidden review alive with thirty-second heartbeats", () => {
    const leases = new PlannotatorClientLease();
    leases.registerReview(token, 0);

    for (let now = 30_000; now <= 180_000; now += 30_000) {
      leases.renew(token, browserA, now);
      expect(leases.collectExpired(now)).toEqual([]);
    }

    expect(leases.isOwned(token, 180_000)).toBe(true);
  });

  it("expires a launch that no browser acquires", () => {
    const leases = new PlannotatorClientLease();
    leases.registerReview(token, 0);

    expect(leases.collectExpired(PLANNOTATOR_CLIENT_LEASE_MS - 1)).toEqual([]);
    expect(leases.collectExpired(PLANNOTATOR_CLIENT_LEASE_MS)).toEqual([token]);
  });

  it("creates a fresh acquisition window when reopened", () => {
    const leases = new PlannotatorClientLease();
    leases.registerReview(token, 0);
    expect(leases.collectExpired(PLANNOTATOR_CLIENT_LEASE_MS)).toEqual([token]);

    leases.registerReview(token, PLANNOTATOR_CLIENT_LEASE_MS + 1);

    expect(leases.collectExpired(PLANNOTATOR_CLIENT_LEASE_MS * 2)).toEqual([]);
    expect(leases.isOwned(token, PLANNOTATOR_CLIENT_LEASE_MS * 2)).toBe(true);
  });

  it("shares one compatible lease for legacy clients", () => {
    const leases = new PlannotatorClientLease();

    leases.renew(token, null, 0);
    leases.renew(token, null, 1);

    expect(leases.clientIds(token)).toEqual([LEGACY_PLANNOTATOR_CLIENT_ID]);
    expect(leases.collectExpired(PLANNOTATOR_CLIENT_LEASE_MS)).toEqual([]);
    expect(leases.collectExpired(PLANNOTATOR_CLIENT_LEASE_MS + 2)).toEqual([token]);
  });

  it("makes duplicate renew, release, and removal calls idempotent", () => {
    const leases = new PlannotatorClientLease();

    leases.renew(token, browserA, 0);
    leases.renew(token, browserA, 1);
    expect(leases.clientIds(token)).toEqual([browserA]);
    expect(leases.release(token, browserA, 2)).toBe(true);
    expect(leases.release(token, browserA, 3)).toBe(false);

    leases.removeReview(token);
    leases.removeReview(token);
    expect(leases.collectExpired(PLANNOTATOR_CLIENT_LEASE_MS * 2)).toEqual([]);
  });
});
