/**
 * TEY fork: Google Analytics 4. Upstream removed it on 2026-10-26 to keep its hosted OAuth app on
 * the webmasters scope only; a self-hosted agency panel needs it to see what visitors do after
 * search and ads bring them in.
 *
 * The connection is its own grant (analytics.readonly), made as in services/google.ts. Reports read
 * Google live with the Data API and store nothing; disconnecting forgets the property.
 */
import { eq } from "drizzle-orm";
import { dataDb, schema } from "../db";
import { badRequest } from "../lib/errors";
import { accountById, assertGoogleConfigured, googleCall, notConnected, ownAccount, RANGES, type Range } from "./google";

type Project = typeof schema.projects.$inferSelect;
type Account = typeof schema.googleAccounts.$inferSelect;

// ── Properties and the connection ───────────────────────────────────────────

export type Ga4Property = { propertyId: string; displayName: string; account: string };

export async function listProperties(userId: string, accountId: string): Promise<Ga4Property[]> {
  const account = await ownAccount(userId, accountId, "ga4");
  const out: Ga4Property[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await googleCall<{
      accountSummaries?: { displayName?: string; propertySummaries?: { property: string; displayName?: string }[] }[];
      nextPageToken?: string;
    }>(account, "admin", `/v1beta/accountSummaries?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
    for (const summary of res.accountSummaries ?? []) {
      for (const property of summary.propertySummaries ?? []) {
        out.push({ propertyId: property.property, displayName: property.displayName ?? property.property, account: summary.displayName ?? "" });
      }
    }
    pageToken = res.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

export async function connectGa4(project: Project, userId: string, accountId: string, propertyId: string) {
  if (!/^properties\/\d+$/.test(propertyId)) throw badRequest("A GA4 property ID looks like properties/123456789");
  const properties = await listProperties(userId, accountId);
  if (!properties.some((p) => p.propertyId === propertyId)) throw badRequest("That property is not in this Google account's Analytics");
  const account = await ownAccount(userId, accountId, "ga4");
  const details = await googleCall<{ displayName?: string; timeZone?: string; currencyCode?: string }>(account, "admin", `/v1beta/${propertyId}`);
  const values = {
    projectId: project.id,
    googleAccountId: accountId,
    propertyId,
    displayName: details.displayName ?? propertyId,
    timeZone: details.timeZone ?? null,
    currencyCode: details.currencyCode ?? null,
  };
  await dataDb.insert(schema.ga4Connections).values(values).onConflictDoUpdate({ target: schema.ga4Connections.projectId, set: values });
  return values;
}

async function ga4For(project: Pick<Project, "id">) {
  const [connection] = await dataDb.select().from(schema.ga4Connections).where(eq(schema.ga4Connections.projectId, project.id)).limit(1);
  const account = connection ? await accountById(connection.googleAccountId) : null;
  if (!connection || !account) throw notConnected("ga4");
  assertGoogleConfigured();
  return { connection, account };
}

// ── Reports ─────────────────────────────────────────────────────────────────

export const CHANNELS = ["all", "organic", "paid"] as const;
export type Channel = (typeof CHANNELS)[number];

/** GA4's default channel groups that are paid for. */
export const PAID_CHANNEL_GROUPS = ["Paid Search", "Paid Social", "Paid Shopping", "Paid Video", "Paid Other", "Display", "Cross-network", "Audio"];

function channelFilter(channel: Channel) {
  if (channel === "organic") return { dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: "Organic Search" } } } };
  if (channel === "paid") return { dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", inListFilter: { values: PAID_CHANNEL_GROUPS } } } };
  return {};
}

/** Complete days in the property's own time zone, ending yesterday; the previous period is the same length. */
export function ga4Periods(range: Range) {
  const days = RANGES[range];
  return {
    current: { startDate: `${days}daysAgo`, endDate: "yesterday" },
    previous: { startDate: `${days * 2}daysAgo`, endDate: `${days + 1}daysAgo` },
  };
}

type Ga4Report = {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string }[];
  rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[];
  metadata?: { dataLossFromOtherRow?: boolean; subjectToThresholding?: boolean; samplingMetadatas?: unknown[]; currencyCode?: string; timeZone?: string };
};

/** Rows as plain objects: dimensions as strings, metrics as numbers. */
export function ga4Rows(report: Ga4Report): Record<string, string | number>[] {
  const dims = (report.dimensionHeaders ?? []).map((h) => h.name);
  const metrics = (report.metricHeaders ?? []).map((h) => h.name);
  return (report.rows ?? []).map((row) => ({
    ...Object.fromEntries(dims.map((name, i) => [name, row.dimensionValues?.[i]?.value ?? ""])),
    ...Object.fromEntries(metrics.map((name, i) => [name, Number(row.metricValues?.[i]?.value ?? 0)])),
  }));
}

/** Google trims or samples reports in some cases; say so rather than present the numbers as exact. */
const limitedData = (report: Ga4Report) =>
  Boolean(report.metadata?.dataLossFromOtherRow || report.metadata?.subjectToThresholding || report.metadata?.samplingMetadatas?.length);

async function runReport(account: Account, propertyId: string, body: Record<string, unknown>): Promise<Ga4Report> {
  return googleCall<Ga4Report>(account, "data", `/v1beta/${propertyId}:runReport`, body);
}

const property = (connection: typeof schema.ga4Connections.$inferSelect) => ({
  propertyId: connection.propertyId,
  displayName: connection.displayName,
  timeZone: connection.timeZone,
  currencyCode: connection.currencyCode,
});

const OVERVIEW_METRICS = ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents", "transactions", "purchaseRevenue"];

/** Sessions, users, engagement, key events, purchases and revenue for this period and the last, plus a daily series. */
export async function analyticsOverview(project: Project, range: Range, channel: Channel = "all") {
  const { connection, account } = await ga4For(project);
  const periods = ga4Periods(range);
  const filter = channelFilter(channel);
  const [totals, daily] = await Promise.all([
    runReport(account, connection.propertyId, { dateRanges: [periods.current, periods.previous], metrics: OVERVIEW_METRICS.map((name) => ({ name })), ...filter }),
    runReport(account, connection.propertyId, {
      dateRanges: [periods.current],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "sessions" }, { name: "keyEvents" }, { name: "purchaseRevenue" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 400,
      ...filter,
    }),
  ]);
  // With two date ranges Google adds a dateRange dimension: date_range_0 is the first.
  const rows = ga4Rows(totals);
  const pick = (name: string) => {
    const row = rows.find((r) => r.dateRange === name) ?? (rows.length === 1 && name === "date_range_0" ? rows[0] : undefined);
    return Object.fromEntries(OVERVIEW_METRICS.map((m) => [m, Number(row?.[m] ?? 0)]));
  };
  return {
    property: property(connection),
    channel,
    range,
    current: pick("date_range_0"),
    previous: pick("date_range_1"),
    daily: ga4Rows(daily).map((r) => ({
      date: String(r.date).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
      sessions: Number(r.sessions),
      keyEvents: Number(r.keyEvents),
      purchaseRevenue: Number(r.purchaseRevenue),
    })),
    limitedData: limitedData(totals) || limitedData(daily),
  };
}

/** Sessions, key events, purchases and revenue per default channel group (Organic Search, Paid Search, Direct…). */
export async function analyticsChannels(project: Project, range: Range) {
  const { connection, account } = await ga4For(project);
  const report = await runReport(account, connection.propertyId, {
    dateRanges: [ga4Periods(range).current],
    dimensions: [{ name: "sessionDefaultChannelGroup" }],
    metrics: ["sessions", "engagedSessions", "engagementRate", "keyEvents", "transactions", "purchaseRevenue"].map((name) => ({ name })),
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 50,
  });
  return {
    property: property(connection),
    range,
    paidGroups: PAID_CHANNEL_GROUPS,
    rows: ga4Rows(report).map((r) => ({ ...r, paid: PAID_CHANNEL_GROUPS.includes(String(r.sessionDefaultChannelGroup)) })),
    limitedData: limitedData(report),
  };
}

/** Source, medium and campaign of each session, with what those sessions bought. */
export async function analyticsSources(project: Project, range: Range, channel: Channel = "all", limit = 100) {
  const { connection, account } = await ga4For(project);
  const report = await runReport(account, connection.propertyId, {
    dateRanges: [ga4Periods(range).current],
    dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }, { name: "sessionCampaignName" }],
    metrics: ["sessions", "engagementRate", "keyEvents", "transactions", "purchaseRevenue"].map((name) => ({ name })),
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit,
    ...channelFilter(channel),
  });
  return { property: property(connection), channel, range, rows: ga4Rows(report), limitedData: limitedData(report) };
}

/** Landing pages by sessions, with engagement, key events and revenue. */
export async function landingPages(project: Project, range: Range, channel: Channel = "all", limit = 100) {
  const { connection, account } = await ga4For(project);
  const report = await runReport(account, connection.propertyId, {
    dateRanges: [ga4Periods(range).current],
    dimensions: [{ name: "hostName" }, { name: "landingPage" }],
    metrics: ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents", "sessionKeyEventRate", "purchaseRevenue"].map((name) => ({ name })),
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit,
    ...channelFilter(channel),
  });
  return { property: property(connection), channel, range, rows: ga4Rows(report), limitedData: limitedData(report) };
}
