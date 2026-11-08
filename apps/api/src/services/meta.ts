/**
 * TEY fork: Meta (Facebook and Instagram) ads, read only, through the Marketing API.
 *
 * Two ways in, both stored encrypted in meta_accounts (core database):
 * - "Continue with Facebook" (needs META_APP_ID and META_APP_SECRET): the ads_read grant of the
 *   person signing in, swapped for a 60-day token. It ends after 60 days; connecting again renews it.
 * - A pasted token, normally a system user's from Business settings, which does not expire. An
 *   agency assigns its clients' ad accounts (shared with it as a partner) to that system user.
 * While the Meta app is in development mode, only people with a role on the app can sign in, and
 * ad accounts may need adding under the app's Marketing API settings (error 274 says so).
 *
 * A project reads one ad account (meta_connections, project database). Reports read Meta live;
 * nothing else is stored. Dates are the ad account's own days, ending yesterday.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, eq, like, lt } from "drizzle-orm";
import { dataDb, db, schema } from "../db";
import { env } from "../env";
import { decrypt, encrypt } from "../lib/crypto";
import { AppError, badRequest, notFound } from "../lib/errors";
import { adsPeriods } from "./ads";
import { DAY_MS, type Range } from "./google";

type Project = typeof schema.projects.$inferSelect;
type MetaAccount = typeof schema.metaAccounts.$inferSelect;
type Connection = typeof schema.metaConnections.$inferSelect;

// ── Where requests go ───────────────────────────────────────────────────────

const base = () => env.META_API_BASE_URL?.replace(/\/+$/, "");
const graphRoot = () => (base() ? `${base()}/graph` : "https://graph.facebook.com");
const graphUrl = (path: string) => `${graphRoot()}/${env.META_GRAPH_VERSION}${path}`;
const dialogUrl = () => `${base() ? `${base()}/dialog` : "https://www.facebook.com"}/${env.META_GRAPH_VERSION}/dialog/oauth`;

export const metaConfigured = () => Boolean(env.META_APP_ID && env.META_APP_SECRET);
export const metaRedirectUri = () => `${env.APP_URL}/api/meta/callback`;

const notConfigured = () =>
  new AppError(503, "meta_not_configured", "Connecting with Facebook is not set up on this server (META_APP_ID and META_APP_SECRET). Paste a system-user access token instead.");
const reconnect = (who: string | null) =>
  new AppError(409, "meta_reconnect_required", `The Meta access${who ? ` of ${who}` : ""} has expired or was revoked. Connect again, or paste a new token, under Project settings.`);
const notConnected = () => new AppError(409, "meta_not_connected", "Connect a Meta ad account to this project first, under Project settings.");

/** Proves the call comes from the app's server; Meta can require it (Settings → Advanced → Require app secret). */
const appSecretProof = (token: string) => (env.META_APP_SECRET ? createHmac("sha256", env.META_APP_SECRET).update(token).digest("hex") : null);

type GraphError = { error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_user_msg?: string } };

function graphError(status: number, body: GraphError, who: string | null): AppError {
  const e = body.error ?? {};
  const message = e.error_user_msg || e.message || `HTTP ${status}`;
  if (e.code === 190) return reconnect(who);
  if (e.code === 274)
    return new AppError(403, "meta_permission", `${message} While the Meta app is in development mode, add this ad account under the app's Marketing API settings, and make sure the token's user has a role on it.`);
  if (e.code === 10 || (e.code != null && e.code >= 200 && e.code < 300) || e.code === 270) return new AppError(403, "meta_permission", `Meta refused access: ${message}`);
  if (e.code === 4 || e.code === 17 || e.code === 32 || e.code === 613 || (e.code != null && e.code >= 80000 && e.code < 80100))
    return new AppError(429, "meta_quota", `Meta's rate limit is reached for now. Try again later. (${message})`);
  if (status === 400) return badRequest(`Meta rejected the request: ${message}`);
  return new AppError(502, "meta_error", `Meta returned an error: ${message}`);
}

/** One Graph API GET with a token. `who` names the login in a reconnect message. */
async function graphGet<T>(token: string, path: string, params: Record<string, string> = {}, who: string | null = null): Promise<T> {
  const query = new URLSearchParams({ ...params, access_token: token });
  const proof = appSecretProof(token);
  if (proof) query.set("appsecret_proof", proof);
  return fetchGraph<T>(`${graphUrl(path)}?${query}`, who);
}

async function fetchGraph<T>(url: string, who: string | null): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const json = (await res.json().catch(() => ({}))) as GraphError & T;
  if (res.ok && !json.error) return json;
  throw graphError(res.status, json, who);
}

type Page<T> = { data?: T[]; paging?: { next?: string } };

/** A list across pages. Meta's `next` links already carry the token; only links back to the Graph API are followed. */
async function graphList<T>(token: string, path: string, params: Record<string, string>, who: string | null, maxPages = 10): Promise<T[]> {
  const out: T[] = [];
  let page = await graphGet<Page<T>>(token, path, params, who);
  for (let i = 0; ; i++) {
    out.push(...(page.data ?? []));
    const next = page.paging?.next;
    if (!next || i + 1 >= maxPages || !next.startsWith(graphRoot())) break;
    page = await fetchGraph<Page<T>>(next, who);
  }
  return out;
}

// ── Logins: Continue with Facebook, or a pasted token ───────────────────────

const STATE_TTL_MS = 10 * 60_000;
const stateId = (state: string) => `meta-link:${state}`;

/** Only paths on the dashboard itself. */
const safeReturnTo = (value: unknown) => (typeof value === "string" && /^\/(?![/\\])[^\s]*$/.test(value) && value.length <= 500 ? value : "/projects");

export async function startMetaLink(userId: string, returnTo: unknown): Promise<string> {
  if (!metaConfigured()) throw notConfigured();
  const state = randomBytes(32).toString("base64url");
  const now = new Date();
  await db.delete(schema.verification).where(and(like(schema.verification.identifier, "meta-link:%"), lt(schema.verification.expiresAt, now)));
  await db.insert(schema.verification).values({
    id: randomUUID(),
    identifier: stateId(state),
    value: JSON.stringify({ userId, returnTo: safeReturnTo(returnTo) }),
    expiresAt: new Date(now.getTime() + STATE_TTL_MS),
  });
  const params = new URLSearchParams({ client_id: env.META_APP_ID!, redirect_uri: metaRedirectUri(), state, scope: "ads_read", response_type: "code" });
  return `${dialogUrl()}?${params}`;
}

export class MetaLinkError extends Error {
  constructor(
    public code: "state_mismatch" | "access_denied" | "scope_denied" | "token_exchange_failed",
    public returnTo = "/projects",
  ) {
    super(code);
  }
}

async function consumeState(state: string, userId: string): Promise<string> {
  const [row] = await db.delete(schema.verification).where(eq(schema.verification.identifier, stateId(state))).returning();
  if (!row || row.expiresAt < new Date()) throw new MetaLinkError("state_mismatch");
  let value: { userId?: string; returnTo?: string };
  try {
    value = JSON.parse(row.value);
  } catch {
    throw new MetaLinkError("state_mismatch");
  }
  if (value.userId !== userId) throw new MetaLinkError("state_mismatch");
  return safeReturnTo(value.returnTo);
}

type Identity = { id: string; name: string | null };

/** Who a token belongs to, after checking it may read ads. */
async function identify(token: string): Promise<Identity> {
  const permissions = await graphGet<{ data?: { permission: string; status: string }[] }>(token, "/me/permissions");
  if (!permissions.data?.some((p) => p.permission === "ads_read" && p.status === "granted")) throw badRequest("This token has no ads_read permission, so it cannot read ad reports.");
  const me = await graphGet<{ id?: string; name?: string }>(token, "/me", { fields: "id,name" });
  if (!me.id) throw badRequest("Meta did not say whom this token belongs to.");
  return { id: me.id, name: me.name ?? null };
}

async function storeAccount(userId: string, kind: "user" | "token", identity: Identity, token: string, expiresAt: Date | null) {
  const values = { userId, kind, metaUserId: identity.id, name: identity.name, tokenEnc: encrypt(token), expiresAt };
  const [row] = await db
    .insert(schema.metaAccounts)
    .values(values)
    .onConflictDoUpdate({ target: [schema.metaAccounts.userId, schema.metaAccounts.metaUserId], set: { ...values, updatedAt: new Date() } })
    .returning({ id: schema.metaAccounts.id });
  return row!.id;
}

/** Completes "Continue with Facebook": checks the state, swaps the code for a 60-day token and stores it. */
export async function finishMetaLink(userId: string, query: { code?: string; state?: string; error?: string }): Promise<string> {
  if (!metaConfigured()) throw notConfigured();
  if (!query.state) throw new MetaLinkError("state_mismatch");
  const returnTo = await consumeState(query.state, userId);
  if (query.error || !query.code) throw new MetaLinkError("access_denied", returnTo);
  const app = { client_id: env.META_APP_ID!, client_secret: env.META_APP_SECRET! };
  let long: { access_token?: string; expires_in?: number };
  try {
    const short = await fetchGraph<{ access_token?: string }>(`${graphUrl("/oauth/access_token")}?${new URLSearchParams({ ...app, redirect_uri: metaRedirectUri(), code: query.code })}`, null);
    if (!short.access_token) throw new Error("no token");
    long = await fetchGraph(`${graphUrl("/oauth/access_token")}?${new URLSearchParams({ ...app, grant_type: "fb_exchange_token", fb_exchange_token: short.access_token })}`, null);
    if (!long.access_token) throw new Error("no token");
  } catch {
    throw new MetaLinkError("token_exchange_failed", returnTo);
  }
  let identity: Identity;
  try {
    identity = await identify(long.access_token);
  } catch (error) {
    if (error instanceof AppError && error.code === "bad_request") throw new MetaLinkError("scope_denied", returnTo);
    throw error;
  }
  await storeAccount(userId, "user", identity, long.access_token, new Date(Date.now() + (long.expires_in ?? 60 * 86_400) * 1000));
  return returnTo;
}

/** A pasted token (a system user's, usually). Its expiry is read when the server knows the app; otherwise it is taken as lasting. */
export async function addMetaToken(userId: string, token: string) {
  const identity = await identify(token);
  let expiresAt: Date | null = null;
  if (metaConfigured()) {
    const debug = await graphGet<{ data?: { expires_at?: number } }>(`${env.META_APP_ID}|${env.META_APP_SECRET}`, "/debug_token", { input_token: token }).catch(() => null);
    if (debug?.data?.expires_at) expiresAt = new Date(debug.data.expires_at * 1000);
  }
  const id = await storeAccount(userId, "token", identity, token, expiresAt);
  return { id, name: identity.name, expiresAt };
}

export async function listMetaAccounts(userId: string) {
  return db
    .select({ id: schema.metaAccounts.id, kind: schema.metaAccounts.kind, name: schema.metaAccounts.name, expiresAt: schema.metaAccounts.expiresAt, createdAt: schema.metaAccounts.createdAt })
    .from(schema.metaAccounts)
    .where(eq(schema.metaAccounts.userId, userId))
    .orderBy(schema.metaAccounts.createdAt);
}

async function ownMetaAccount(userId: string, id: string): Promise<MetaAccount> {
  const [row] = await db.select().from(schema.metaAccounts).where(and(eq(schema.metaAccounts.id, id), eq(schema.metaAccounts.userId, userId))).limit(1);
  if (!row) throw notFound("Meta login");
  return row;
}

/** Removes a login and every project connection that read through it. Connections go first (see google.ts). */
export async function removeMetaAccount(userId: string, id: string): Promise<{ projects: number }> {
  const account = await ownMetaAccount(userId, id);
  const gone = await dataDb.delete(schema.metaConnections).where(eq(schema.metaConnections.metaAccountId, account.id)).returning({ id: schema.metaConnections.projectId });
  await db.delete(schema.metaAccounts).where(eq(schema.metaAccounts.id, account.id));
  return { projects: gone.length };
}

function tokenOf(account: MetaAccount): string {
  if (account.expiresAt && account.expiresAt.getTime() <= Date.now()) throw reconnect(account.name);
  return decrypt(account.tokenEnc);
}

// ── Ad accounts and the connection ──────────────────────────────────────────

const ACCOUNT_STATUS: Record<number, string> = {
  1: "active",
  2: "disabled",
  3: "unsettled",
  7: "pending risk review",
  8: "pending settlement",
  9: "in grace period",
  100: "pending closure",
  101: "closed",
};

export type MetaAdAccount = { adAccountId: string; name: string; currency: string | null; timeZone: string | null; status: string; active: boolean; business: string | null };

export async function listAdAccounts(userId: string, metaAccountId: string): Promise<MetaAdAccount[]> {
  const account = await ownMetaAccount(userId, metaAccountId);
  const rows = await graphList<{ id: string; name?: string; currency?: string; timezone_name?: string; account_status?: number; business?: { name?: string } }>(
    tokenOf(account),
    "/me/adaccounts",
    { fields: "id,name,currency,timezone_name,account_status,business{name}", limit: "200" },
    account.name,
  );
  return rows
    .map((r) => ({
      adAccountId: r.id,
      name: r.name || r.id,
      currency: r.currency ?? null,
      timeZone: r.timezone_name ?? null,
      status: ACCOUNT_STATUS[r.account_status ?? 0] ?? `status ${r.account_status}`,
      active: r.account_status === 1 || r.account_status === 9,
      business: r.business?.name ?? null,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

export async function connectMeta(project: Project, userId: string, metaAccountId: string, adAccountId: string) {
  const match = (await listAdAccounts(userId, metaAccountId)).find((a) => a.adAccountId === adAccountId);
  if (!match) throw badRequest("That ad account is not reachable with this Meta login");
  const values = { projectId: project.id, metaAccountId, adAccountId: match.adAccountId, name: match.name, currency: match.currency, timeZone: match.timeZone };
  await dataDb.insert(schema.metaConnections).values(values).onConflictDoUpdate({ target: schema.metaConnections.projectId, set: values });
  return values;
}

export async function disconnectMeta(project: Pick<Project, "id">) {
  await dataDb.delete(schema.metaConnections).where(eq(schema.metaConnections.projectId, project.id));
}

/** Everything the settings card needs. */
export async function metaState(project: Pick<Project, "id">, userId: string) {
  const [row] = await dataDb.select().from(schema.metaConnections).where(eq(schema.metaConnections.projectId, project.id)).limit(1);
  const [login] = row ? await db.select().from(schema.metaAccounts).where(eq(schema.metaAccounts.id, row.metaAccountId)).limit(1) : [];
  return {
    configured: metaConfigured(),
    redirectUri: metaRedirectUri(),
    connection:
      row && login
        ? { adAccountId: row.adAccountId, name: row.name, currency: row.currency, timeZone: row.timeZone, accountId: login.id, login: login.name, kind: login.kind, expiresAt: login.expiresAt, createdAt: row.createdAt }
        : null,
    accounts: await listMetaAccounts(userId),
  };
}

async function metaFor(project: Pick<Project, "id">): Promise<{ connection: Connection; account: MetaAccount }> {
  const [connection] = await dataDb.select().from(schema.metaConnections).where(eq(schema.metaConnections.projectId, project.id)).limit(1);
  const [account] = connection ? await db.select().from(schema.metaAccounts).where(eq(schema.metaAccounts.id, connection.metaAccountId)).limit(1) : [];
  if (!connection || !account) throw notConnected();
  return { connection, account };
}

// ── Insights ────────────────────────────────────────────────────────────────

type ActionStat = { action_type: string; value: string };
type InsightRow = {
  date_start?: string;
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  inline_link_clicks?: string;
  actions?: ActionStat[];
  action_values?: ActionStat[];
};

const METRIC_FIELDS = "spend,impressions,clicks,inline_link_clicks,actions,action_values";
// The first type present counts, so the same purchase is not counted twice under two names.
const PURCHASE_TYPES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase"];
const LEAD_TYPES = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"];

function actionValue(list: ActionStat[] | undefined, types: string[]): number {
  for (const type of types) {
    const hit = list?.find((a) => a.action_type === type);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Sums with the ratios Meta reports are read by: link CTR %, cost per link click, CPM, cost per purchase and ROAS. */
export function metaTotals(rows: InsightRow[]) {
  const s = rows.reduce(
    (sum, r) => ({
      spend: sum.spend + (Number(r.spend) || 0),
      impressions: sum.impressions + (Number(r.impressions) || 0),
      clicks: sum.clicks + (Number(r.clicks) || 0),
      linkClicks: sum.linkClicks + (Number(r.inline_link_clicks) || 0),
      purchases: sum.purchases + actionValue(r.actions, PURCHASE_TYPES),
      purchaseValue: sum.purchaseValue + actionValue(r.action_values, PURCHASE_TYPES),
      leads: sum.leads + actionValue(r.actions, LEAD_TYPES),
    }),
    { spend: 0, impressions: 0, clicks: 0, linkClicks: 0, purchases: 0, purchaseValue: 0, leads: 0 },
  );
  return {
    spend: round(s.spend),
    impressions: s.impressions,
    clicks: s.clicks,
    linkClicks: s.linkClicks,
    purchases: round(s.purchases),
    purchaseValue: round(s.purchaseValue),
    leads: round(s.leads),
    ctr: s.impressions ? round((s.linkClicks / s.impressions) * 100) : null,
    cpc: s.linkClicks ? round(s.spend / s.linkClicks) : null,
    cpm: s.impressions ? round((s.spend / s.impressions) * 1000) : null,
    costPerPurchase: s.purchases ? round(s.spend / s.purchases) : null,
    costPerLead: s.leads ? round(s.spend / s.leads) : null,
    roas: s.spend ? round(s.purchaseValue / s.spend) : null,
  };
}

function insights(c: { connection: Connection; account: MetaAccount }, period: { startDate: string; endDate: string }, options: { level: "account" | "campaign"; daily?: boolean }) {
  return graphList<InsightRow>(
    tokenOf(c.account),
    `/${c.connection.adAccountId}/insights`,
    {
      level: options.level,
      fields: options.level === "campaign" ? `campaign_id,campaign_name,${METRIC_FIELDS}` : METRIC_FIELDS,
      time_range: JSON.stringify({ since: period.startDate, until: period.endDate }),
      ...(options.daily ? { time_increment: "1" } : {}),
      limit: "500",
    },
    c.account.name,
    20,
  );
}

const accountInfo = (connection: Connection) => ({ adAccountId: connection.adAccountId, name: connection.name, currency: connection.currency, timeZone: connection.timeZone });

/** Spend, link clicks, purchases, revenue and leads for the period against the one before, with a daily series. */
export async function metaOverview(project: Project, range: Range) {
  const c = await metaFor(project);
  const periods = adsPeriods(range, c.connection.timeZone);
  const [current, previous, daily] = await Promise.all([
    insights(c, periods.current, { level: "account" }),
    insights(c, periods.previous, { level: "account" }),
    insights(c, periods.current, { level: "account", daily: true }),
  ]);
  return {
    account: accountInfo(c.connection),
    range,
    periods,
    current: metaTotals(current),
    previous: metaTotals(previous),
    daily: daily.map((r) => ({ date: r.date_start ?? "", ...metaTotals([r]) })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** Campaigns with delivery in the period, most spend first, with status, objective and budget. */
export async function metaCampaigns(project: Project, range: Range) {
  const c = await metaFor(project);
  const { current } = adsPeriods(range, c.connection.timeZone);
  const [rows, campaigns] = await Promise.all([
    insights(c, current, { level: "campaign" }),
    graphList<{ id: string; effective_status?: string; objective?: string; daily_budget?: string; lifetime_budget?: string }>(
      tokenOf(c.account),
      `/${c.connection.adAccountId}/campaigns`,
      { fields: "id,effective_status,objective,daily_budget,lifetime_budget", limit: "500" },
      c.account.name,
      4,
    ),
  ]);
  const byId = new Map(campaigns.map((x) => [x.id, x]));
  // Budgets come in the currency's minor unit (kuruş, cents).
  const budget = (value?: string) => (value ? round(Number(value) / 100) : null);
  return {
    account: accountInfo(c.connection),
    range,
    period: current,
    rows: rows
      .map((r) => {
        const meta = byId.get(r.campaign_id ?? "");
        return {
          campaignId: r.campaign_id ?? "",
          name: r.campaign_name ?? "",
          status: meta?.effective_status ?? null,
          objective: meta?.objective ?? null,
          dailyBudget: budget(meta?.daily_budget),
          lifetimeBudget: budget(meta?.lifetime_budget),
          ...metaTotals([r]),
        };
      })
      .sort((a, b) => b.spend - a.spend),
  };
}

/** Spend and results per campaign per day, for other systems (an e-commerce panel's ROAS report). At most 93 days. */
export async function metaCampaignDaily(project: Project, from: string, to: string) {
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  if (!Number.isFinite(days) || days < 1 || days > 93) throw badRequest("from and to are YYYY-MM-DD, from on or before to, at most 93 days apart");
  const c = await metaFor(project);
  const rows = await insights(c, { startDate: from, endDate: to }, { level: "campaign", daily: true });
  return {
    account: accountInfo(c.connection),
    from,
    to,
    rows: rows
      .map((r) => {
        const t = metaTotals([r]);
        return { date: r.date_start ?? "", campaignId: r.campaign_id ?? "", campaign: r.campaign_name ?? "", spend: t.spend, impressions: t.impressions, linkClicks: t.linkClicks, purchases: t.purchases, purchaseValue: t.purchaseValue, leads: t.leads };
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.campaignId.localeCompare(b.campaignId)),
  };
}
