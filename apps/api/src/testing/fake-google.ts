/**
 * Test stand-in for Google's OAuth and Search Console APIs. Point GOOGLE_API_BASE_URL
 * at it; requests arrive as /<host>/<path> (see googleUrl in services/google.ts).
 *
 * - The token endpoint accepts any code. The account it signs in comes from the code:
 *   "code:<sub>:<email>". A code containing "noscope" grants only openid and email; one
 *   containing "norefresh" gets no refresh token, as on a repeat grant.
 * - Refresh tokens work unless they are "revoked".
 * - A code containing "readonly" grants read-only Search Console, as grants made before full
 *   access was asked for.
 * - URL inspection says "Crawled - currently not indexed" for URLs containing "not-indexed".
 * - Also stands in for IndexNow at /indexnow/indexnow: a key of "bad-key" gets 403, a URL list
 *   containing "slow-down" gets 429, anything else 200.
 * - TEY fork: a code containing "ga4" grants Analytics (analytics.readonly), one containing "ads"
 *   grants Google Ads (adwords). Ads: manager 1112223333 ("TEY MCC") with clients 7778889999
 *   ("HSM Ads", reachable only through the manager, so the login-customer-id header is checked) and
 *   4445556666 ("Direct Shop", also directly accessible); 9990001111 is cancelled and fails.
 *   Search results come 25 rows a page.
 * - TEY fork, Meta under /graph/<version>/ (META_API_BASE_URL = this server): the code exchange gives
 *   "short-<code>", the 60-day swap "long-<short>". Pasted tokens: "sys-…" is a system user,
 *   "expired-…" fails with code 190, "noads-…" has ads_read declined. appsecret_proof is checked
 *   against FAKE_META_SECRET when sent. Ad accounts act_111 and act_222 work; act_333 is closed and
 *   its insights fail with (#274). Lists come 30 rows a page.
 * - Data is made up and deterministic. Nothing here reflects real search data.
 */
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_CLIENT_ID = "fake-client.apps.googleusercontent.com";
export const FAKE_META_APP_ID = "123456789";
export const FAKE_META_SECRET = "fake-meta-secret-0123456789";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const idToken = (sub: string, email: string) => `${b64({ alg: "none" })}.${b64({ iss: "https://accounts.google.com", aud: FAKE_CLIENT_ID, sub, email, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

const QUERIES = ["plumber austin", "emergency plumber", "drain cleaning cost", "water heater repair", "leak detection", "acme plumbing", "toilet repair near me", "sewer line camera"];
const PAGES = ["/", "/services/drains", "/services/water-heaters", "/blog/leak-signs", "/pricing", "/contact"];

/** One fake Search Console row per combination of the requested dimensions. */
function gscRows(body: { dimensions?: string[]; startDate: string; endDate: string; rowLimit?: number; startRow?: number; dimensionFilterGroups?: { filters: { dimension: string; operator: string; expression: string }[] }[] }, site: string) {
  const host = site.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const dims = body.dimensions ?? [];
  const days: string[] = [];
  for (let t = Date.parse(body.startDate); t <= Date.parse(body.endDate); t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  const values: Record<string, string[]> = {
    date: days,
    query: QUERIES,
    page: PAGES.map((p) => `https://${host}${p}`),
    country: ["usa", "gbr", "can"],
    device: ["DESKTOP", "MOBILE", "TABLET"],
  };
  let combos: string[][] = [[]];
  for (const d of dims) combos = combos.flatMap((c) => (values[d] ?? [""]).map((v) => [...c, v]));
  const filters = body.dimensionFilterGroups?.[0]?.filters ?? [];
  const rows = combos
    .filter((keys) =>
      filters.every((f) => {
        const i = dims.indexOf(f.dimension);
        if (i < 0) return true;
        const v = (keys[i] ?? "").toLowerCase();
        const e = f.expression.toLowerCase();
        return f.operator === "contains" ? v.includes(e) : v === e;
      }),
    )
    .map((keys) => {
      const h = hash(keys.join("|") + body.startDate);
      const impressions = 50 + (h % 900);
      const clicks = Math.floor(impressions * (0.01 + (h % 9) / 100));
      return { keys, clicks, impressions, ctr: clicks / impressions, position: 1 + (h % 2400) / 100 };
    })
    .sort((a, b) => b.clicks - a.clicks);
  const start = body.startRow ?? 0;
  return rows.slice(start, start + (body.rowLimit ?? 1000));
}

/** Fake GA4 Data API report: one row per combination of the requested dimensions (and date range). */
function ga4Report(body: { dateRanges?: unknown[]; dimensions?: { name: string }[]; metrics?: { name: string }[]; limit?: number }) {
  const ranges = body.dateRanges?.length ?? 1;
  const dims = (body.dimensions ?? []).map((d) => d.name);
  const metrics = (body.metrics ?? []).map((m) => m.name);
  const dimensionHeaders = [...dims, ...(ranges > 1 ? ["dateRange"] : [])].map((name) => ({ name }));
  const values: Record<string, string[]> = {
    date: Array.from({ length: 28 }, (_, i) => `202610${String(i + 1).padStart(2, "0")}`),
    hostName: ["www.acme.com"],
    landingPage: PAGES,
    sessionDefaultChannelGroup: ["Organic Search", "Paid Search", "Direct", "Paid Social"],
    sessionSource: ["google", "facebook"],
    sessionMedium: ["organic", "cpc"],
    sessionCampaignName: ["(organic)", "brand-search"],
  };
  let combos: string[][] = [[]];
  for (const d of dims) combos = combos.flatMap((c) => (values[d] ?? ["(not set)"]).map((v) => [...c, v]));
  const rows = combos.flatMap((keys) =>
    Array.from({ length: ranges }, (_, r) => {
      const h = hash(keys.join("|") + r);
      const metric = (name: string) => {
        if (name.endsWith("Rate")) return ((h % 60) / 100 + 0.1).toFixed(4);
        if (name === "purchaseRevenue") return ((h % 5000) / 10).toFixed(2);
        return String(20 + (h % 400));
      };
      return {
        dimensionValues: [...keys, ...(ranges > 1 ? [`date_range_${r}`] : [])].map((value) => ({ value })),
        metricValues: metrics.map((name) => ({ value: metric(name) })),
      };
    }),
  );
  return { dimensionHeaders, metricHeaders: metrics.map((name) => ({ name, type: "TYPE_INTEGER" })), rows: rows.slice(0, body.limit ?? 10000), rowCount: rows.length, metadata: { currencyCode: "TRY", timeZone: "Europe/Istanbul" } };
}

const ADS_CUSTOMERS: Record<string, { descriptiveName: string; currencyCode: string; timeZone: string; manager: boolean; direct: boolean; viaManager: boolean }> = {
  "1112223333": { descriptiveName: "TEY MCC", currencyCode: "TRY", timeZone: "Europe/Istanbul", manager: true, direct: true, viaManager: false },
  "7778889999": { descriptiveName: "HSM Ads", currencyCode: "TRY", timeZone: "Europe/Istanbul", manager: false, direct: false, viaManager: true },
  "4445556666": { descriptiveName: "Direct Shop", currencyCode: "EUR", timeZone: "Europe/Berlin", manager: false, direct: true, viaManager: true },
};
const ADS_CAMPAIGNS = [
  { id: "101", name: "HSM Arama", status: "ENABLED", advertisingChannelType: "SEARCH" },
  { id: "102", name: "HSM PMax", status: "PAUSED", advertisingChannelType: "PERFORMANCE_MAX" },
];
const ADS_TERMS = ["e-ticaret sitesi kur", "sanal market", "hazır e-ticaret paketi", "migros sanal market"];
const ADS_PAGE = 25;

/** Metrics for one key: cost in micros and counts as strings, conversions as numbers, as the REST API sends them. A term with "market" in it never converts. */
function adsMetrics(key: string) {
  const h = hash(key);
  const conversions = key.includes("market") ? 0 : 1 + (h % 7);
  return { costMicros: String((50 + (h % 900)) * 1_000_000), clicks: String(10 + (h % 90)), impressions: String(200 + (h % 4000)), conversions, conversionsValue: conversions * 450 };
}

function adsSearch(customerId: string, query: string): unknown[] {
  const between = query.match(/segments\.date BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/);
  const days: string[] = [];
  if (between) for (let t = Date.parse(between[1]!); t <= Date.parse(between[2]!); t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  const byDate = /SELECT segments\.date/.test(query);
  const customer = ADS_CUSTOMERS[customerId]!;
  if (/FROM customer_client/.test(query)) {
    return Object.entries(ADS_CUSTOMERS)
      .filter(([, c]) => c.viaManager)
      .map(([id, c]) => ({ customerClient: { resourceName: `customers/${customerId}/customerClients/${id}`, id, descriptiveName: c.descriptiveName, currencyCode: c.currencyCode, timeZone: c.timeZone, manager: false, status: "ENABLED", testAccount: false } }));
  }
  if (/FROM customer LIMIT 1/.test(query)) return [{ customer: { resourceName: `customers/${customerId}`, id: customerId, descriptiveName: customer.descriptiveName, currencyCode: customer.currencyCode, timeZone: customer.timeZone, manager: customer.manager, testAccount: false } }];
  if (/FROM customer WHERE/.test(query)) {
    if (byDate) return days.map((date) => ({ segments: { date }, metrics: adsMetrics(`${customerId}|${date}`) }));
    return [{ metrics: adsMetrics(`${customerId}|${days[0]}|${days.length}`) }];
  }
  if (/FROM campaign WHERE/.test(query)) {
    if (byDate) return days.flatMap((date) => ADS_CAMPAIGNS.map((campaign) => ({ segments: { date }, campaign: { id: campaign.id, name: campaign.name }, metrics: adsMetrics(`${campaign.id}|${date}`) })));
    return ADS_CAMPAIGNS.map((campaign) => ({ campaign, campaignBudget: { amountMicros: "250000000" }, metrics: adsMetrics(`${campaign.id}|${days[0]}`) }));
  }
  if (/FROM search_term_view/.test(query)) {
    const limit = Number(query.match(/LIMIT (\d+)/)?.[1] ?? 10000);
    return ADS_TERMS.map((term, i) => ({
      searchTermView: { searchTerm: term, status: i === 0 ? "ADDED" : "NONE" },
      campaign: { id: "101", name: "HSM Arama" },
      adGroup: { name: "E-ticaret" },
      metrics: adsMetrics(term),
    })).slice(0, limit);
  }
  return [];
}

/** Fake Meta insight metrics for one key; campaigns without sales (awareness) report no purchases. */
function metaInsight(key: string, sales = true) {
  const h = hash(key);
  const linkClicks = 20 + (h % 200);
  const buys = sales ? 1 + (h % 6) : 0;
  return {
    spend: (100 + (h % 900) + (h % 100) / 100).toFixed(2),
    impressions: String(2000 + (h % 20000)),
    clicks: String(linkClicks + (h % 30)),
    inline_link_clicks: String(linkClicks),
    actions: [
      { action_type: "link_click", value: String(linkClicks) },
      ...(buys ? [{ action_type: "omni_purchase", value: String(buys) }, { action_type: "purchase", value: String(buys) }] : []),
      ...(sales ? [] : [{ action_type: "lead", value: String(1 + (h % 5)) }]),
    ],
    action_values: buys ? [{ action_type: "omni_purchase", value: (buys * 350).toFixed(2) }, { action_type: "purchase", value: (buys * 350).toFixed(2) }] : [],
  };
}

const META_CAMPAIGNS = [
  { id: "c1", name: "HSM Satış", effective_status: "ACTIVE", objective: "OUTCOME_SALES", daily_budget: "25000", sales: true },
  { id: "c2", name: "HSM Bilinirlik", effective_status: "PAUSED", objective: "OUTCOME_AWARENESS", lifetime_budget: "100000", sales: false },
];
const META_PAGE = 30;

/** Answers one Graph API GET, or null when the path is not faked. */
function metaGraph(path: string, q: URLSearchParams, origin: string): { status: number; body: unknown } | null {
  const token = q.get("access_token") ?? "";
  const fail = (status: number, code: number, message: string) => ({ status, body: { error: { message, type: "OAuthException", code, fbtrace_id: "fake" } } });
  const proof = q.get("appsecret_proof");
  if (proof && proof !== createHmac("sha256", FAKE_META_SECRET).update(token).digest("hex")) return fail(400, 100, "Invalid appsecret_proof provided in the API argument");
  const page = (rows: unknown[]) => {
    const start = Number(q.get("after") ?? 0);
    const next = new URLSearchParams(q);
    next.set("after", String(start + META_PAGE));
    return { status: 200, body: { data: rows.slice(start, start + META_PAGE), ...(start + META_PAGE < rows.length ? { paging: { next: `${origin}/graph/v26.0${path}?${next}` } } : {}) } };
  };

  if (path === "/oauth/access_token") {
    if (q.get("grant_type") === "fb_exchange_token") return { status: 200, body: { access_token: `long-${q.get("fb_exchange_token")}`, token_type: "bearer", expires_in: 5_184_000 } };
    if (q.get("client_id") !== FAKE_META_APP_ID || q.get("client_secret") !== FAKE_META_SECRET || !q.get("redirect_uri")) return fail(400, 101, "Error validating application.");
    if (String(q.get("code")).includes("bad")) return fail(400, 100, "Invalid verification code format.");
    return { status: 200, body: { access_token: `short-${q.get("code")}`, token_type: "bearer", expires_in: 5000 } };
  }
  if (path === "/debug_token") {
    if (token !== `${FAKE_META_APP_ID}|${FAKE_META_SECRET}`) return fail(400, 190, "Invalid OAuth access token.");
    return { status: 200, body: { data: { is_valid: true, expires_at: String(q.get("input_token")).startsWith("sys-") ? 0 : Math.floor(Date.now() / 1000) + 30 * 86_400 } } };
  }
  if (token.startsWith("expired")) return fail(400, 190, "Error validating access token: Session has expired.");
  if (!/^(sys-|long-|noads-)/.test(token)) return fail(400, 190, "Invalid OAuth access token.");
  if (path === "/me/permissions") {
    return { status: 200, body: { data: [{ permission: "public_profile", status: "granted" }, { permission: "ads_read", status: token.startsWith("noads") ? "declined" : "granted" }] } };
  }
  if (path === "/me") return { status: 200, body: token.startsWith("sys-") ? { id: "20002", name: "TEY Sistem Kullanıcısı" } : { id: "10001", name: "Halit Ajans" } };
  if (path === "/me/adaccounts") {
    return page([
      { id: "act_111", name: "HSM Meta", currency: "TRY", timezone_name: "Europe/Istanbul", account_status: 1, business: { id: "b1", name: "TEY Bilişim" } },
      { id: "act_333", name: "Eski Hesap", currency: "TRY", timezone_name: "Europe/Istanbul", account_status: 101 },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `act_9${String(i).padStart(2, "0")}`, name: `Müşteri ${i + 1}`, currency: "TRY", timezone_name: "Europe/Istanbul", account_status: 1, business: { id: "b2", name: "Partner" } })),
      { id: "act_222", name: "Butik Moda", currency: "EUR", timezone_name: "Europe/Berlin", account_status: 1, business: { id: "b2", name: "Partner" } },
    ]);
  }
  const campaigns = path.match(/^\/(act_\d+)\/campaigns$/);
  if (campaigns) return page(META_CAMPAIGNS.map(({ sales: _sales, ...c }) => c));
  const insights = path.match(/^\/(act_\d+)\/insights$/);
  if (insights) {
    const act = insights[1]!;
    if (act === "act_333") return fail(400, 274, "(#274) The ad account is not enabled for usage in Ads API.");
    const range = JSON.parse(q.get("time_range") ?? "{}") as { since: string; until: string };
    const days: string[] = [];
    for (let t = Date.parse(range.since); t <= Date.parse(range.until); t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
    const daily = q.get("time_increment") === "1";
    const slots = daily ? days.map((d) => ({ date_start: d, date_stop: d })) : [{ date_start: range.since, date_stop: range.until }];
    if (q.get("level") === "campaign") {
      return page(slots.flatMap((slot) => META_CAMPAIGNS.map((c) => ({ ...slot, campaign_id: c.id, campaign_name: c.name, ...metaInsight(`${act}|${c.id}|${slot.date_start}|${slot.date_stop}`, c.sales) }))));
    }
    return page(slots.map((slot) => ({ ...slot, ...metaInsight(`${act}|${slot.date_start}|${slot.date_stop}`) })));
  }
  return null;
}

export type FakeGoogle = {
  server: Server;
  url: string;
  /** Every request, in order: host-qualified path, form or JSON body, the bearer token and Google Ads' login-customer-id header. */
  requests: { path: string; body: any; token: string | null; loginCustomerId?: string }[];
  close(): Promise<void>;
};

export async function startFakeGoogle(port = 0): Promise<FakeGoogle> {
  const requests: FakeGoogle["requests"] = [];
  let issued = 0;
  const server = createServer((req, res) => {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      const auth = req.headers.authorization;
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      let body: any = {};
      if (req.headers["content-type"]?.includes("application/x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(raw));
      else if (raw) body = JSON.parse(raw);
      const loginCustomerId = typeof req.headers["login-customer-id"] === "string" ? req.headers["login-customer-id"] : undefined;
      requests.push({ path: req.url ?? path, body, token, loginCustomerId });

      if (path === "/token/token") {
        if (body.grant_type === "authorization_code") {
          if (!body.code_verifier) return send(400, { error: "invalid_request", error_description: "Missing code_verifier" });
          const [, sub = "sub-1", email = "owner@example.test"] = String(body.code).split(":");
          const scope = String(body.code).includes("noscope")
            ? "openid https://www.googleapis.com/auth/userinfo.email"
            : `openid https://www.googleapis.com/auth/userinfo.email ${
                String(body.code).includes("ga4")
                  ? "https://www.googleapis.com/auth/analytics.readonly"
                  : String(body.code).includes("ads")
                    ? "https://www.googleapis.com/auth/adwords"
                    : String(body.code).includes("readonly")
                      ? "https://www.googleapis.com/auth/webmasters.readonly"
                      : "https://www.googleapis.com/auth/webmasters"
              }`;
          // Google often sends no refresh token when the account already granted access.
          const refresh = String(body.code).includes("norefresh") ? {} : { refresh_token: `rt-${sub}` };
          return send(200, { access_token: `at-${++issued}`, expires_in: 3599, ...refresh, scope, token_type: "Bearer", id_token: idToken(sub, email) });
        }
        if (body.grant_type === "refresh_token") {
          if (body.refresh_token === "revoked") return send(400, { error: "invalid_grant" });
          return send(200, { access_token: `at-${++issued}`, expires_in: 3599, scope: "", token_type: "Bearer" });
        }
        return send(400, { error: "unsupported_grant_type" });
      }

      if (path === "/indexnow/indexnow") {
        if (body.key === "bad-key") return send(403, {});
        if ((body.urlList ?? []).some((u: string) => u.includes("slow-down"))) return send(429, {});
        return send(200, {});
      }

      // ── Meta Graph API (TEY fork) ──
      const graph = path.match(/^\/graph\/v[\d.]+(\/.*)$/);
      if (graph?.[1]) {
        const answer = metaGraph(graph[1], new URL(req.url ?? "", "http://fake").searchParams, `http://${req.headers.host}`);
        return answer ? send(answer.status, answer.body) : send(404, { error: { code: 803, message: `No fake for ${path}` } });
      }

      if (!token?.startsWith("at-")) return send(401, { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } });

      if (path === "/webmasters/webmasters/v3/sites") {
        return send(200, {
          siteEntry: [
            { siteUrl: "sc-domain:acme.com", permissionLevel: "siteOwner" },
            { siteUrl: "https://other.example/", permissionLevel: "siteUnverifiedUser" },
          ],
        });
      }
      const query = path.match(/^\/webmasters\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/);
      if (query?.[1]) return send(200, { rows: gscRows(body, decodeURIComponent(query[1])), responseAggregationType: "byProperty" });
      const sitemaps = path.match(/^\/webmasters\/webmasters\/v3\/sites\/([^/]+)\/sitemaps(?:\/([^/]+))?$/);
      if (sitemaps) {
        if (req.method === "PUT") return send(204, {});
        return send(200, { sitemap: [{ path: "https://acme.com/sitemap.xml", lastSubmitted: "2026-10-01T00:00:00Z", lastDownloaded: "2026-10-20T00:00:00Z", isPending: false, isSitemapsIndex: false, warnings: "0", errors: "1", contents: [{ type: "web", submitted: "42" }] }] });
      }
      if (path === "/searchconsole/v1/urlInspection/index:inspect") {
        if (String(body.inspectionUrl).includes("not-in-property")) return send(400, { error: { code: 400, message: "URL is not in the property" } });
        if (String(body.inspectionUrl).includes("not-indexed")) return send(200, { inspectionResult: { indexStatusResult: { verdict: "NEUTRAL", coverageState: "Crawled - currently not indexed", lastCrawlTime: "2026-10-01T08:00:00Z" } } });
        return send(200, { inspectionResult: { inspectionResultLink: "https://search.google.com/x", indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", indexingState: "INDEXING_ALLOWED", robotsTxtState: "ALLOWED", pageFetchState: "SUCCESSFUL", lastCrawlTime: "2026-10-10T08:00:00Z", googleCanonical: body.inspectionUrl, userCanonical: body.inspectionUrl } } });
      }
      // ── Google Analytics 4 ──
      if (path === "/admin/v1beta/accountSummaries") {
        return send(200, { accountSummaries: [{ account: "accounts/1", displayName: "Acme Inc", propertySummaries: [{ property: "properties/123", displayName: "acme.com - GA4" }, { property: "properties/456", displayName: "Old site" }] }] });
      }
      if (path === "/admin/v1beta/properties/123") return send(200, { name: "properties/123", displayName: "acme.com - GA4", timeZone: "Europe/Istanbul", currencyCode: "TRY" });
      if (path === "/data/v1beta/properties/123:runReport") return send(200, ga4Report(body));

      // ── Google Ads ──
      const ads = path.match(/^\/ads\/v\d+\/customers(?::listAccessibleCustomers|\/(\d+)\/googleAds:search)$/);
      if (ads) {
        if (!ads[1]) return send(200, { resourceNames: ["customers/1112223333", "customers/4445556666", "customers/9990001111"] });
        const customerId = ads[1];
        const customer = ADS_CUSTOMERS[customerId];
        const permission = (message: string) =>
          send(403, { error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure", errors: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" }, message }] }] } });
        if (!customer) return permission("The customer account can't be accessed because it is not yet enabled or has been deactivated.");
        const throughManager = loginCustomerId === "1112223333" && customer.viaManager;
        const directly = customer.direct && (!loginCustomerId || loginCustomerId === customerId);
        if (!throughManager && !directly) return permission("User doesn't have permission to access customer. Note: If you're accessing a client customer, the manager's customer id must be set in the 'login-customer-id' header.");
        const results = adsSearch(customerId, String(body.query ?? ""));
        const start = body.pageToken ? Number(String(body.pageToken).replace("page-", "")) : 0;
        const next = start + ADS_PAGE < results.length ? { nextPageToken: `page-${start + ADS_PAGE}` } : {};
        return send(200, { results: results.slice(start, start + ADS_PAGE), fieldMask: "", ...next });
      }

      return send(404, { error: { code: 404, message: `No fake for ${path}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: bound } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${bound}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
