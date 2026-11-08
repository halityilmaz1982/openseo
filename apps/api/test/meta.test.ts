/** TEY fork: Meta ads logins, ad accounts and reports, against the fake Graph API in fake-google.ts. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, schema } from "../src/db";
import { decrypt } from "../src/lib/crypto";
import { todayIn } from "../src/services/ads";
import { metaTotals } from "../src/services/meta";
import { client, readyUser } from "./client";
import { harness } from "./harness";

type User = Awaited<ReturnType<typeof readyUser>>;
const SYSTEM_TOKEN = "sys-0123456789abcdefghijklmnop";

async function withToken(token = SYSTEM_TOKEN) {
  const user = await readyUser();
  const login = await user.api.ok<{ id: string }>("POST", "/meta/accounts", { token });
  return { ...user, loginId: login.id };
}

async function withAdAccount(adAccountId = "act_111") {
  const user = await withToken();
  await user.api.ok("PUT", `/projects/${user.project.id}/meta`, { accountId: user.loginId, adAccountId });
  return user;
}

async function facebook(user: User, query: (state: string) => Record<string, string>) {
  const start = await user.api.request("GET", `/api/meta/connect?returnTo=${encodeURIComponent(`/p/${user.project.id}/settings`)}`);
  expect(start.status).toBe(302);
  const dialog = new URL(String(start.headers.location));
  const back = await user.api.request("GET", `/api/meta/callback?${new URLSearchParams(query(dialog.searchParams.get("state")!))}`);
  expect(back.status).toBe(302);
  return { dialog, back: new URL(String(back.headers.location)) };
}

describe("Meta logins", () => {
  it("connects with Facebook for ads_read and keeps a 60-day token, once per state", async () => {
    const user = await readyUser();
    const { dialog, back } = await facebook(user, (state) => ({ code: "code-1", state }));
    expect(dialog.pathname).toBe("/dialog/v26.0/dialog/oauth");
    expect(Object.fromEntries(dialog.searchParams)).toMatchObject({ client_id: "123456789", redirect_uri: "http://localhost:3200/api/meta/callback", scope: "ads_read", response_type: "code" });
    expect(back.pathname).toBe(`/p/${user.project.id}/settings`);
    expect(back.searchParams.get("meta_connected")).toBe("1");

    const [row] = await db.select().from(schema.metaAccounts).where(eq(schema.metaAccounts.userId, user.userId));
    expect(row).toMatchObject({ kind: "user", metaUserId: "10001", name: "Halit Ajans" });
    expect(decrypt(row!.tokenEnc)).toBe("long-short-code-1");
    expect(row!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(59 * 86_400_000);

    const replay = await user.api.request("GET", `/api/meta/callback?code=code-1&state=${dialog.searchParams.get("state")}`);
    expect(new URL(String(replay.headers.location)).searchParams.get("meta_error")).toBe("state_mismatch");
  });

  it("reports a refused or failed sign-in back on the dashboard, and only starts from a session", async () => {
    const user = await readyUser();
    expect((await facebook(user, (state) => ({ error: "access_denied", state }))).back.searchParams.get("meta_error")).toBe("access_denied");
    expect((await facebook(user, (state) => ({ code: "bad-code", state }))).back.searchParams.get("meta_error")).toBe("token_exchange_failed");
    expect(await db.select().from(schema.metaAccounts).where(eq(schema.metaAccounts.userId, user.userId))).toHaveLength(0);

    const { key } = await user.api.ok<{ key: string }>("POST", "/api-keys", { name: "agent" });
    expect((await client({ apiKey: key }).request("GET", "/api/meta/connect")).status).toBe(403);
  });

  it("takes a pasted system-user token, signed with the app secret, and refuses unusable ones", async () => {
    const user = await readyUser();
    const login = await user.api.ok("POST", "/meta/accounts", { token: SYSTEM_TOKEN });
    expect(login).toMatchObject({ name: "TEY Sistem Kullanıcısı", expiresAt: null });
    // Pasting it again updates the same login.
    await user.api.ok("POST", "/meta/accounts", { token: SYSTEM_TOKEN });
    expect(await user.api.ok("GET", "/meta/accounts")).toHaveLength(1);
    const call = harness.google.requests.filter((r) => r.path.startsWith("/graph/v26.0/me?")).at(-1)!;
    expect(new URL(call.path, "http://x").searchParams.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);

    const noAds = await user.api.post("/meta/accounts", { token: "noads-0123456789abcdefghijklmnop" });
    expect(noAds.status).toBe(400);
    expect(noAds.body.error?.message).toContain("ads_read");
    const expired = await user.api.post("/meta/accounts", { token: "expired-0123456789abcdefghijklmnop" });
    expect(expired.status).toBe(409);
    expect(expired.body.error?.code).toBe("meta_reconnect_required");
    expect((await user.api.post("/meta/accounts", { token: "short" })).status).toBe(400);
  });
});

describe("Meta ad accounts", () => {
  it("lists every ad account across pages, active ones first", async () => {
    const user = await withToken();
    const accounts = await user.api.ok<{ adAccountId: string; name: string; active: boolean; status: string; business: string | null }[]>(
      "GET",
      `/projects/${user.project.id}/meta/ad-accounts?accountId=${user.loginId}`,
    );
    expect(accounts).toHaveLength(33);
    expect(accounts[0]).toMatchObject({ adAccountId: "act_222", name: "Butik Moda", active: true, business: "Partner" });
    expect(accounts.at(-1)).toMatchObject({ adAccountId: "act_333", active: false, status: "closed" });
  });

  it("connects one ad account per project, only one the login reaches", async () => {
    const user = await withToken();
    expect((await user.api.put(`/projects/${user.project.id}/meta`, { accountId: user.loginId, adAccountId: "act_999999" })).status).toBe(400);
    expect((await user.api.put(`/projects/${user.project.id}/meta`, { accountId: user.loginId, adAccountId: "111" })).status).toBe(400);
    await user.api.ok("PUT", `/projects/${user.project.id}/meta`, { accountId: user.loginId, adAccountId: "act_111" });
    const state = await user.api.ok("GET", `/projects/${user.project.id}/meta`);
    expect(state.configured).toBe(true);
    expect(state.connection).toMatchObject({ adAccountId: "act_111", name: "HSM Meta", currency: "TRY", timeZone: "Europe/Istanbul", login: "TEY Sistem Kullanıcısı", kind: "token" });

    await user.api.ok("DELETE", `/projects/${user.project.id}/meta`);
    expect((await user.api.ok("GET", `/projects/${user.project.id}/meta`)).connection).toBeNull();
  });
});

describe("Meta reports", () => {
  it("compares the period with the one before, in the account's days", async () => {
    const user = await withAdAccount();
    const report = await user.api.ok("GET", `/projects/${user.project.id}/meta/overview?range=last_28_days`);
    const yesterday = new Date(Date.parse(`${todayIn("Europe/Istanbul")}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    expect(report.periods.current.endDate).toBe(yesterday);
    expect(report.daily).toHaveLength(28);
    expect(report.current.spend).toBeGreaterThan(0);
    expect(report.current.purchases).toBeGreaterThan(0);
    expect(report.current.roas).toBeCloseTo(report.current.purchaseValue / report.current.spend, 1);
    expect(report.previous.spend).not.toBe(report.current.spend);
  });

  it("lists campaigns with status, objective and budget, and gives spend per campaign per day", async () => {
    const user = await withAdAccount();
    const campaigns = await user.api.ok("GET", `/projects/${user.project.id}/meta/campaigns?range=last_7_days`);
    const sales = campaigns.rows.find((r: { campaignId: string }) => r.campaignId === "c1");
    const awareness = campaigns.rows.find((r: { campaignId: string }) => r.campaignId === "c2");
    expect(sales).toMatchObject({ name: "HSM Satış", status: "ACTIVE", objective: "OUTCOME_SALES", dailyBudget: 250, lifetimeBudget: null });
    expect(awareness).toMatchObject({ status: "PAUSED", objective: "OUTCOME_AWARENESS", dailyBudget: null, lifetimeBudget: 1000, purchases: 0, roas: 0 });
    expect(awareness.leads).toBeGreaterThan(0);
    expect(campaigns.rows[0].spend).toBeGreaterThanOrEqual(campaigns.rows[1].spend);

    // 28 days × 2 campaigns = 56 rows, over two pages of 30.
    const daily = await user.api.ok("GET", `/projects/${user.project.id}/meta/campaign-daily?from=2026-10-01&to=2026-10-28`);
    expect(daily.rows).toHaveLength(56);
    expect(daily.rows[0]).toMatchObject({ date: "2026-10-01", campaignId: "c1", campaign: "HSM Satış" });
    expect((await user.api.get(`/projects/${user.project.id}/meta/campaign-daily?from=2026-01-01&to=2026-10-28`)).status).toBe(400);
  });

  it("explains error 274 and asks to reconnect when a 60-day token ran out", async () => {
    const closed = await withAdAccount("act_333");
    const res = await closed.api.get(`/projects/${closed.project.id}/meta/overview`);
    expect(res.status).toBe(403);
    expect(res.body.error?.message).toContain("development mode");

    const user = await withAdAccount();
    await db.update(schema.metaAccounts).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.metaAccounts.id, user.loginId));
    const stale = await user.api.get(`/projects/${user.project.id}/meta/campaigns`);
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("meta_reconnect_required");
  });

  it("says where to connect, and removing a login disconnects its projects", async () => {
    const empty = await readyUser();
    const res = await empty.api.get(`/projects/${empty.project.id}/meta/overview`);
    expect(res.status).toBe(409);
    expect(res.body.error?.message).toContain("Project settings");

    const user = await withAdAccount();
    expect(await user.api.ok("DELETE", `/meta/accounts/${user.loginId}`)).toEqual({ projects: 1 });
    expect((await user.api.ok("GET", `/projects/${user.project.id}/meta`)).connection).toBeNull();
    expect(await user.api.ok("GET", "/meta/accounts")).toHaveLength(0);
  });
});

describe("Meta totals", () => {
  it("counts a purchase once though Meta reports it under several names", () => {
    const totals = metaTotals([
      {
        spend: "100.00",
        impressions: "10000",
        clicks: "120",
        inline_link_clicks: "100",
        actions: [
          { action_type: "omni_purchase", value: "4" },
          { action_type: "purchase", value: "4" },
          { action_type: "offsite_conversion.fb_pixel_purchase", value: "4" },
          { action_type: "lead", value: "2" },
        ],
        action_values: [
          { action_type: "omni_purchase", value: "800" },
          { action_type: "purchase", value: "800" },
        ],
      },
    ]);
    expect(totals).toMatchObject({ spend: 100, linkClicks: 100, purchases: 4, purchaseValue: 800, leads: 2, ctr: 1, cpc: 1, cpm: 10, costPerPurchase: 25, costPerLead: 50, roas: 8 });
    expect(metaTotals([]).roas).toBeNull();
  });
});
