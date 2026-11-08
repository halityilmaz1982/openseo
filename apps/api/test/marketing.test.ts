/** TEY fork: Google Analytics 4 and Google Ads connections and reports, against the fake Google. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { dataDb, db, schema } from "../src/db";
import { adsPeriods, adsTotals, customerDigits, todayIn } from "../src/services/ads";
import { readyUser } from "./client";
import { harness } from "./harness";

type Provider = "gsc" | "ga4" | "ads";

/** Connects a Google account for one product, as the dashboard does: start, then Google's redirect back. */
async function connected(provider: Provider, user?: Awaited<ReturnType<typeof readyUser>>) {
  const u = user ?? (await readyUser());
  const start = await u.api.request("GET", `/api/google/${provider}/connect?returnTo=${encodeURIComponent(`/p/${u.project.id}/settings`)}`);
  expect(start.status).toBe(302);
  const consent = new URL(String(start.headers.location));
  const back = await u.api.request("GET", `/api/google/${provider}/callback?${new URLSearchParams({ code: `code:sub-${provider}:agency@example.test:${provider}`, state: consent.searchParams.get("state")! })}`);
  expect(new URL(String(back.headers.location)).searchParams.get("google_connected")).toBe(provider);
  const [account] = await db.select().from(schema.googleAccounts).where(eq(schema.googleAccounts.userId, u.userId));
  const accounts = await db.select().from(schema.googleAccounts).where(eq(schema.googleAccounts.userId, u.userId));
  return { ...u, consent, account: accounts.find((a) => a.provider === provider) ?? account! };
}

async function withGa4() {
  const user = await connected("ga4");
  await user.api.ok("PUT", `/projects/${user.project.id}/google/ga4`, { accountId: user.account.id, propertyId: "properties/123" });
  return user;
}

async function withAds() {
  const user = await connected("ads");
  await user.api.ok("PUT", `/projects/${user.project.id}/google/ads`, { accountId: user.account.id, customerId: "777-888-9999", loginCustomerId: "1112223333" });
  return user;
}

const lastRunReport = () => harness.google.requests.filter((r) => r.path.endsWith(":runReport")).at(-1)!;

describe("Google Analytics 4", () => {
  it("asks for read-only Analytics on its own redirect URI", async () => {
    const user = await connected("ga4");
    expect(user.consent.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/analytics.readonly");
    expect(user.consent.searchParams.get("redirect_uri")).toBe("http://localhost:3200/api/google/ga4/callback");
    expect(user.account.provider).toBe("ga4");
  });

  it("lists properties and connects one per project, refusing others", async () => {
    const user = await connected("ga4");
    const properties = await user.api.ok("GET", `/projects/${user.project.id}/google/ga4/properties?accountId=${user.account.id}`);
    expect(properties).toEqual([
      { propertyId: "properties/123", displayName: "acme.com - GA4", account: "Acme Inc" },
      { propertyId: "properties/456", displayName: "Old site", account: "Acme Inc" },
    ]);
    expect((await user.api.put(`/projects/${user.project.id}/google/ga4`, { accountId: user.account.id, propertyId: "123" })).status).toBe(400);
    expect((await user.api.put(`/projects/${user.project.id}/google/ga4`, { accountId: user.account.id, propertyId: "properties/999" })).status).toBe(400);
    // A Search Console grant cannot be used for Analytics.
    const gsc = await connected("gsc", user);
    expect((await user.api.put(`/projects/${user.project.id}/google/ga4`, { accountId: gsc.account.id, propertyId: "properties/123" })).status).toBe(404);

    await user.api.ok("PUT", `/projects/${user.project.id}/google/ga4`, { accountId: user.account.id, propertyId: "properties/123" });
    const state = await user.api.ok("GET", `/projects/${user.project.id}/google`);
    expect(state.ga4).toMatchObject({ propertyId: "properties/123", displayName: "acme.com - GA4", timeZone: "Europe/Istanbul", currencyCode: "TRY", email: "agency@example.test" });
    expect(state.redirectUris).toMatchObject({ ga4: "http://localhost:3200/api/google/ga4/callback", ads: "http://localhost:3200/api/google/ads/callback" });
  });

  it("reports the period against the one before, by channel, source and landing page", async () => {
    const user = await withGa4();
    const all = await user.api.ok("GET", `/projects/${user.project.id}/analytics/overview?range=last_28_days`);
    expect(all.current.sessions).toBeGreaterThan(0);
    expect(all.previous.sessions).toBeGreaterThan(0);
    expect(all.current).toHaveProperty("transactions");
    expect(all.daily[0].date).toBe("2026-10-01");
    expect(lastRunReport().body.dimensionFilter).toBeUndefined();

    await user.api.ok("GET", `/projects/${user.project.id}/analytics/overview?range=last_7_days&channel=paid`);
    expect(lastRunReport().body.dimensionFilter.filter.inListFilter.values).toContain("Paid Search");
    await user.api.ok("GET", `/projects/${user.project.id}/analytics/overview?channel=organic`);
    expect(lastRunReport().body.dimensionFilter.filter.stringFilter.value).toBe("Organic Search");

    const channels = await user.api.ok("GET", `/projects/${user.project.id}/analytics/channels`);
    expect(channels.rows.find((r: { sessionDefaultChannelGroup: string }) => r.sessionDefaultChannelGroup === "Paid Search").paid).toBe(true);
    expect(channels.rows.find((r: { sessionDefaultChannelGroup: string }) => r.sessionDefaultChannelGroup === "Organic Search").paid).toBe(false);

    const sources = await user.api.ok("GET", `/projects/${user.project.id}/analytics/sources?limit=3`);
    expect(sources.rows).toHaveLength(3);
    expect(sources.rows[0]).toHaveProperty("sessionCampaignName");
    const pages = await user.api.ok("GET", `/projects/${user.project.id}/analytics/landing-pages?channel=organic`);
    expect(pages.rows[0]).toHaveProperty("landingPage");
  });

  it("says where to connect when the project has no property", async () => {
    const user = await readyUser();
    const res = await user.api.get(`/projects/${user.project.id}/analytics/overview`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "google_not_connected" });
    expect(res.body.error?.message).toContain("Project settings");
  });
});

describe("Google Ads", () => {
  it("asks for the adwords scope and lists client accounts directly and through the manager", async () => {
    const user = await connected("ads");
    expect(user.consent.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/adwords");
    const customers = await user.api.ok("GET", `/projects/${user.project.id}/google/ads/customers?accountId=${user.account.id}`);
    // The manager itself has no campaigns and the cancelled account cannot be read: neither is listed.
    expect(customers).toEqual([
      { customerId: "4445556666", descriptiveName: "Direct Shop", currencyCode: "EUR", timeZone: "Europe/Berlin", loginCustomerId: "4445556666", managerName: null, testAccount: false },
      { customerId: "7778889999", descriptiveName: "HSM Ads", currencyCode: "TRY", timeZone: "Europe/Istanbul", loginCustomerId: "1112223333", managerName: "TEY MCC", testAccount: false },
    ]);
  });

  it("connects only an account reachable the way it was listed", async () => {
    const user = await connected("ads");
    const wrongWay = await user.api.put(`/projects/${user.project.id}/google/ads`, { accountId: user.account.id, customerId: "7778889999", loginCustomerId: "7778889999" });
    expect(wrongWay.status).toBe(400);
    expect((await user.api.put(`/projects/${user.project.id}/google/ads`, { accountId: user.account.id, customerId: "12345", loginCustomerId: "1112223333" })).status).toBe(400);
    await user.api.ok("PUT", `/projects/${user.project.id}/google/ads`, { accountId: user.account.id, customerId: "777-888-9999", loginCustomerId: "111-222-3333" });
    const state = await user.api.ok("GET", `/projects/${user.project.id}/google`);
    expect(state.ads).toMatchObject({ customerId: "7778889999", loginCustomerId: "1112223333", descriptiveName: "HSM Ads", currencyCode: "TRY", timeZone: "Europe/Istanbul" });
  });

  it("reports spend and results against the period before, through the manager account", async () => {
    const user = await withAds();
    const before = harness.google.requests.length;
    const report = await user.api.ok("GET", `/projects/${user.project.id}/ads/overview?range=last_28_days`);
    const calls = harness.google.requests.slice(before).filter((r) => r.path.includes("/googleAds:search"));
    // Totals for both periods, and the 28-day series in two pages of 25.
    expect(calls).toHaveLength(4);
    expect(calls.every((r) => r.path === "/ads/v26/customers/7778889999/googleAds:search" && r.loginCustomerId === "1112223333")).toBe(true);

    const yesterday = new Date(Date.parse(`${todayIn("Europe/Istanbul")}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    expect(report.periods.current.endDate).toBe(yesterday);
    expect(report.daily).toHaveLength(28);
    expect(report.current.cost).toBeGreaterThan(0);
    expect(report.current.roas).toBeCloseTo(report.current.conversionsValue / report.current.cost, 1);
    expect(report.account).toMatchObject({ customerId: "7778889999", currencyCode: "TRY" });
  });

  it("lists campaigns and flags search terms that cost money and converted nothing", async () => {
    const user = await withAds();
    const campaigns = await user.api.ok("GET", `/projects/${user.project.id}/ads/campaigns?range=last_7_days`);
    expect(campaigns.rows.map((r: { name: string }) => r.name)).toEqual(["HSM Arama", "HSM PMax"]);
    expect(campaigns.rows[0]).toMatchObject({ campaignId: "101", status: "ENABLED", channelType: "SEARCH", dailyBudget: 250 });

    const terms = await user.api.ok("GET", `/projects/${user.project.id}/ads/search-terms?limit=10`);
    const flagged = terms.rows.filter((r: { noConversions: boolean }) => r.noConversions).map((r: { searchTerm: string }) => r.searchTerm);
    expect(flagged).toEqual(["sanal market", "migros sanal market"]);
    expect(terms.summary.noConversionTerms).toBe(2);
    expect(terms.summary.noConversionCost).toBeGreaterThan(0);
    expect(terms.summary.noConversionCost).toBeLessThan(terms.summary.cost);
  });

  it("gives spend per campaign per day, following Google's pages", async () => {
    const user = await withAds();
    const daily = await user.api.ok("GET", `/projects/${user.project.id}/ads/campaign-daily?from=2026-10-01&to=2026-10-28`);
    expect(daily.rows).toHaveLength(56);
    expect(daily.rows[0]).toMatchObject({ date: "2026-10-01", campaignId: "101", campaign: "HSM Arama" });
    expect((await user.api.get(`/projects/${user.project.id}/ads/campaign-daily?from=2026-01-01&to=2026-10-28`)).status).toBe(400);
    expect((await user.api.get(`/projects/${user.project.id}/ads/campaign-daily?from=2026-10-28&to=2026-10-01`)).status).toBe(400);
  });

  it("passes on Google's own reason when access is refused", async () => {
    const user = await withAds();
    // As if the manager link were removed in Google Ads: the client is no longer reachable that way.
    await dataDb.update(schema.adsConnections).set({ loginCustomerId: "7778889999" }).where(eq(schema.adsConnections.projectId, user.project.id));
    const res = await user.api.get(`/projects/${user.project.id}/ads/overview`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "google_permission" });
    expect(res.body.error?.message).toContain("login-customer-id");
  });
});

describe("disconnecting", () => {
  it("removes one product's connection, and a removed Google account takes its connections along", async () => {
    const user = await withAds();
    const ga4 = await connected("ga4", user);
    await user.api.ok("PUT", `/projects/${user.project.id}/google/ga4`, { accountId: ga4.account.id, propertyId: "properties/123" });

    await user.api.ok("DELETE", `/projects/${user.project.id}/google/ads`);
    let state = await user.api.ok("GET", `/projects/${user.project.id}/google`);
    expect(state.ads).toBeNull();
    expect(state.ga4).not.toBeNull();

    const removed = await user.api.ok("DELETE", `/google/accounts/${ga4.account.id}`);
    expect(removed).toEqual({ projects: 1 });
    state = await user.api.ok("GET", `/projects/${user.project.id}/google`);
    expect(state.ga4).toBeNull();
    expect(await dataDb.select().from(schema.ga4Connections).where(eq(schema.ga4Connections.projectId, user.project.id))).toHaveLength(0);
  });
});

describe("Ads helpers", () => {
  it("normalises customer IDs, periods and ratios", () => {
    expect(customerDigits("123-456-7890")).toBe("1234567890");
    expect(customerDigits("customers/1234567890")).toBe("1234567890");
    // 22:30 UTC on 31 Oct is already 1 Nov in Istanbul (UTC+3): yesterday there is 31 Oct.
    const now = new Date("2026-10-31T22:30:00Z");
    expect(adsPeriods("last_7_days", "Europe/Istanbul", now)).toEqual({
      current: { startDate: "2026-10-25", endDate: "2026-10-31" },
      previous: { startDate: "2026-10-18", endDate: "2026-10-24" },
    });
    expect(adsPeriods("last_7_days", "Not/AZone", now).current.endDate).toBe("2026-10-30");
    expect(adsTotals([{ costMicros: "12500000", clicks: "5", impressions: "100", conversions: 2, conversionsValue: 50 }, undefined])).toEqual({
      cost: 12.5,
      clicks: 5,
      impressions: 100,
      conversions: 2,
      conversionsValue: 50,
      ctr: 5,
      cpc: 2.5,
      costPerConversion: 6.25,
      roas: 4,
    });
    expect(adsTotals([]).roas).toBeNull();
  });
});
