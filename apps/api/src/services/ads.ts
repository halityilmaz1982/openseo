/**
 * TEY fork: Google Ads, read only. An agency connects one Google login that reaches its clients'
 * accounts through a manager account (MCC); each project reads one client account.
 *
 * - The grant is its own (the adwords scope), made as in services/google.ts.
 * - Calls go to the REST API (googleads.googleapis.com/<GOOGLE_ADS_API_VERSION>) with GAQL. A client
 *   reached through a manager needs that manager's ID in the login-customer-id header.
 * - Access belongs to the Google Cloud project since developer tokens were retired (2026-09-09); a
 *   token is still sent when GOOGLE_ADS_DEVELOPER_TOKEN is set.
 * - Nothing is changed in the account and nothing is stored but the connection. Dates are the
 *   account's own days, in its time zone, ending yesterday.
 */
import { eq } from "drizzle-orm";
import { dataDb, schema } from "../db";
import { env } from "../env";
import { badRequest } from "../lib/errors";
import { accountById, assertGoogleConfigured, DAY_MS, googleCall, isoDate, notConnected, ownAccount, RANGES, type Range } from "./google";

type Project = typeof schema.projects.$inferSelect;
type Account = typeof schema.googleAccounts.$inferSelect;
type Connection = typeof schema.adsConnections.$inferSelect;

const api = (path: string) => `/${env.GOOGLE_ADS_API_VERSION}${path}`;

/** Ten digits, as the API wants them: "123-456-7890" and "customers/1234567890" both become "1234567890". */
export const customerDigits = (id: string) => id.replace(/^customers\//, "").replace(/\D/g, "");

function headers(loginCustomerId?: string): Record<string, string> {
  return {
    ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
    ...(env.GOOGLE_ADS_DEVELOPER_TOKEN ? { "developer-token": env.GOOGLE_ADS_DEVELOPER_TOKEN } : {}),
  };
}

type AdsMetrics = { costMicros?: string; clicks?: string; impressions?: string; conversions?: number; conversionsValue?: number };
type AdsRow = {
  customer?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean; testAccount?: boolean };
  customerClient?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean; status?: string; testAccount?: boolean };
  campaign?: { id?: string; name?: string; status?: string; advertisingChannelType?: string };
  campaignBudget?: { amountMicros?: string };
  adGroup?: { name?: string };
  searchTermView?: { searchTerm?: string; status?: string };
  segments?: { date?: string };
  metrics?: AdsMetrics;
};

/** One GAQL query, following pages up to `maxPages` (Google returns up to 10,000 rows a page). */
async function search(account: Account, customerId: string, loginCustomerId: string, query: string, maxPages = 5): Promise<AdsRow[]> {
  const rows: AdsRow[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await googleCall<{ results?: AdsRow[]; nextPageToken?: string }>(
      account,
      "ads",
      api(`/customers/${customerId}/googleAds:search`),
      { query, ...(pageToken ? { pageToken } : {}) },
      "POST",
      headers(loginCustomerId),
    );
    rows.push(...(res.results ?? []));
    pageToken = res.nextPageToken;
    if (!pageToken) break;
  }
  return rows;
}

// ── Accounts and the connection ─────────────────────────────────────────────

export type AdsCustomer = {
  customerId: string;
  descriptiveName: string;
  currencyCode: string | null;
  timeZone: string | null;
  /** The account the access goes through: a manager (MCC), or the account itself. */
  loginCustomerId: string;
  managerName: string | null;
  testAccount: boolean;
};

const CUSTOMER_QUERY = "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.test_account FROM customer LIMIT 1";
const CLIENTS_QUERY =
  "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.status, customer_client.test_account FROM customer_client WHERE customer_client.manager = FALSE AND customer_client.status = 'ENABLED'";

/**
 * The ad accounts this Google login can read: the ones it has direct access to, and the client
 * accounts under every manager account it has (at any depth). Manager accounts have no campaigns,
 * so they are not listed themselves. Accounts that cannot be queried (cancelled, not yet set up)
 * are left out.
 */
export async function listCustomers(userId: string, accountId: string): Promise<AdsCustomer[]> {
  const account = await ownAccount(userId, accountId, "ads");
  const res = await googleCall<{ resourceNames?: string[] }>(account, "ads", api("/customers:listAccessibleCustomers"), undefined, "GET", headers());
  const ids = (res.resourceNames ?? []).map(customerDigits).filter(Boolean).slice(0, 50);
  const found = new Map<string, AdsCustomer>();
  for (const id of ids) {
    let self: AdsRow["customer"];
    try {
      self = (await search(account, id, id, CUSTOMER_QUERY, 1))[0]?.customer;
    } catch {
      continue;
    }
    if (!self) continue;
    if (!self.manager) {
      // Direct access needs no manager in between; it wins over the same account found under one.
      found.set(id, { customerId: id, descriptiveName: self.descriptiveName || id, currencyCode: self.currencyCode ?? null, timeZone: self.timeZone ?? null, loginCustomerId: id, managerName: null, testAccount: Boolean(self.testAccount) });
      continue;
    }
    const clients = await search(account, id, id, CLIENTS_QUERY, 5).catch(() => [] as AdsRow[]);
    for (const row of clients) {
      const client = row.customerClient;
      const clientId = customerDigits(String(client?.id ?? ""));
      if (!client || !clientId || found.has(clientId)) continue;
      found.set(clientId, {
        customerId: clientId,
        descriptiveName: client.descriptiveName || clientId,
        currencyCode: client.currencyCode ?? null,
        timeZone: client.timeZone ?? null,
        loginCustomerId: id,
        managerName: self.descriptiveName || id,
        testAccount: Boolean(client.testAccount),
      });
    }
  }
  return [...found.values()].sort((a, b) => a.descriptiveName.localeCompare(b.descriptiveName));
}

export async function connectAds(project: Project, userId: string, accountId: string, customerId: string, loginCustomerId: string) {
  const customer = customerDigits(customerId);
  const login = customerDigits(loginCustomerId);
  const match = (await listCustomers(userId, accountId)).find((c) => c.customerId === customer && c.loginCustomerId === login);
  if (!match) throw badRequest("That ad account is not reachable from this Google account");
  const values = {
    projectId: project.id,
    googleAccountId: accountId,
    customerId: match.customerId,
    loginCustomerId: match.loginCustomerId,
    descriptiveName: match.descriptiveName,
    timeZone: match.timeZone,
    currencyCode: match.currencyCode,
  };
  await dataDb.insert(schema.adsConnections).values(values).onConflictDoUpdate({ target: schema.adsConnections.projectId, set: values });
  return values;
}

async function adsFor(project: Pick<Project, "id">) {
  const [connection] = await dataDb.select().from(schema.adsConnections).where(eq(schema.adsConnections.projectId, project.id)).limit(1);
  const account = connection ? await accountById(connection.googleAccountId) : null;
  if (!connection || !account) throw notConnected("ads");
  assertGoogleConfigured();
  return { connection, account };
}

const run = (c: { connection: Connection; account: Account }, query: string, maxPages?: number) => search(c.account, c.connection.customerId, c.connection.loginCustomerId, query, maxPages);

const accountInfo = (connection: Connection) => ({
  customerId: connection.customerId,
  descriptiveName: connection.descriptiveName,
  currencyCode: connection.currencyCode,
  timeZone: connection.timeZone,
});

// ── Periods and metrics ─────────────────────────────────────────────────────

/** Today's date (YYYY-MM-DD) in the account's time zone; UTC when the zone is unknown. */
export function todayIn(timeZone: string | null, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return isoDate(now);
  }
}

/** Complete days ending yesterday in the account's time zone, and the same number of days before. */
export function adsPeriods(range: Range, timeZone: string | null, now = new Date()) {
  const days = RANGES[range];
  const today = Date.parse(`${todayIn(timeZone, now)}T00:00:00Z`);
  const end = today - DAY_MS;
  const start = end - (days - 1) * DAY_MS;
  const previousEnd = start - DAY_MS;
  const previousStart = previousEnd - (days - 1) * DAY_MS;
  const day = (t: number) => isoDate(new Date(t));
  return { current: { startDate: day(start), endDate: day(end) }, previous: { startDate: day(previousStart), endDate: day(previousEnd) } };
}

const during = (p: { startDate: string; endDate: string }) => `segments.date BETWEEN '${p.startDate}' AND '${p.endDate}'`;
const METRICS = "metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value";

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Raw sums: cost in the account's currency (Google sends micros), and the rest as counts. */
export function sumMetrics(rows: (AdsMetrics | undefined)[]) {
  return rows.reduce<{ cost: number; clicks: number; impressions: number; conversions: number; conversionsValue: number }>(
    (sum, m) => ({
      cost: sum.cost + Number(m?.costMicros ?? 0) / 1e6,
      clicks: sum.clicks + Number(m?.clicks ?? 0),
      impressions: sum.impressions + Number(m?.impressions ?? 0),
      conversions: sum.conversions + Number(m?.conversions ?? 0),
      conversionsValue: sum.conversionsValue + Number(m?.conversionsValue ?? 0),
    }),
    { cost: 0, clicks: 0, impressions: 0, conversions: 0, conversionsValue: 0 },
  );
}

/** Sums with the ratios an ad report is read by: CTR %, cost per click, cost per conversion and ROAS. */
export function adsTotals(rows: (AdsMetrics | undefined)[]) {
  const s = sumMetrics(rows);
  return {
    cost: round(s.cost),
    clicks: s.clicks,
    impressions: s.impressions,
    conversions: round(s.conversions),
    conversionsValue: round(s.conversionsValue),
    ctr: s.impressions ? round((s.clicks / s.impressions) * 100) : null,
    cpc: s.clicks ? round(s.cost / s.clicks) : null,
    costPerConversion: s.conversions ? round(s.cost / s.conversions) : null,
    roas: s.cost ? round(s.conversionsValue / s.cost) : null,
  };
}

// ── Reports ─────────────────────────────────────────────────────────────────

/** Spend, clicks, conversions and value for the period against the one before, with a daily series. */
export async function adsOverview(project: Project, range: Range) {
  const c = await adsFor(project);
  const periods = adsPeriods(range, c.connection.timeZone);
  const [current, previous, daily] = await Promise.all([
    run(c, `SELECT ${METRICS} FROM customer WHERE ${during(periods.current)}`),
    run(c, `SELECT ${METRICS} FROM customer WHERE ${during(periods.previous)}`),
    run(c, `SELECT segments.date, ${METRICS} FROM customer WHERE ${during(periods.current)} ORDER BY segments.date`),
  ]);
  return {
    account: accountInfo(c.connection),
    range,
    periods,
    current: adsTotals(current.map((r) => r.metrics)),
    previous: adsTotals(previous.map((r) => r.metrics)),
    daily: daily.map((r) => ({ date: r.segments?.date ?? "", ...adsTotals([r.metrics]) })),
  };
}

/** Campaigns with activity in the period, most spend first. */
export async function adsCampaigns(project: Project, range: Range) {
  const c = await adsFor(project);
  const { current } = adsPeriods(range, c.connection.timeZone);
  const rows = await run(
    c,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, ${METRICS} FROM campaign WHERE ${during(current)} AND campaign.status != 'REMOVED' ORDER BY metrics.cost_micros DESC LIMIT 500`,
  );
  return {
    account: accountInfo(c.connection),
    range,
    period: current,
    rows: rows.map((r) => ({
      campaignId: r.campaign?.id ?? "",
      name: r.campaign?.name ?? "",
      status: r.campaign?.status ?? null,
      channelType: r.campaign?.advertisingChannelType ?? null,
      dailyBudget: r.campaignBudget?.amountMicros ? round(Number(r.campaignBudget.amountMicros) / 1e6) : null,
      ...adsTotals([r.metrics]),
    })),
  };
}

/**
 * What people actually searched before clicking a Search ad, most spend first, with whether the
 * term is already added as a keyword or excluded. A term that cost money and converted nothing is
 * flagged: these are the negative-keyword candidates. Performance Max terms are not in this view.
 */
export async function adsSearchTerms(project: Project, range: Range, limit = 200) {
  const c = await adsFor(project);
  const { current } = adsPeriods(range, c.connection.timeZone);
  const rows = await run(
    c,
    `SELECT search_term_view.search_term, search_term_view.status, campaign.id, campaign.name, ad_group.name, ${METRICS} FROM search_term_view WHERE ${during(current)} ORDER BY metrics.cost_micros DESC LIMIT ${Math.min(Math.max(Math.trunc(limit), 1), 1000)}`,
    1,
  );
  const terms = rows.map((r) => {
    const totals = adsTotals([r.metrics]);
    return {
      searchTerm: r.searchTermView?.searchTerm ?? "",
      status: r.searchTermView?.status ?? null,
      campaignId: r.campaign?.id ?? "",
      campaign: r.campaign?.name ?? "",
      adGroup: r.adGroup?.name ?? "",
      ...totals,
      noConversions: totals.cost > 0 && totals.conversions === 0,
    };
  });
  const wasted = terms.filter((t) => t.noConversions);
  return {
    account: accountInfo(c.connection),
    range,
    period: current,
    summary: { terms: terms.length, cost: round(terms.reduce((s, t) => s + t.cost, 0)), noConversionTerms: wasted.length, noConversionCost: round(wasted.reduce((s, t) => s + t.cost, 0)) },
    rows: terms,
  };
}

/**
 * Spend and results per campaign per day, for other systems (an e-commerce panel's ROAS report) to
 * pull. At most 93 days at a time.
 */
export async function adsCampaignDaily(project: Project, from: string, to: string) {
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  if (!Number.isFinite(days) || days < 1 || days > 93) throw badRequest("from and to are YYYY-MM-DD, from on or before to, at most 93 days apart");
  const c = await adsFor(project);
  const rows = await run(c, `SELECT segments.date, campaign.id, campaign.name, ${METRICS} FROM campaign WHERE ${during({ startDate: from, endDate: to })} ORDER BY segments.date`, 20);
  return {
    account: accountInfo(c.connection),
    from,
    to,
    rows: rows.map((r) => {
      const s = sumMetrics([r.metrics]);
      return { date: r.segments?.date ?? "", campaignId: r.campaign?.id ?? "", campaign: r.campaign?.name ?? "", cost: round(s.cost), clicks: s.clicks, impressions: s.impressions, conversions: round(s.conversions), conversionsValue: round(s.conversionsValue) };
    }),
  };
}
