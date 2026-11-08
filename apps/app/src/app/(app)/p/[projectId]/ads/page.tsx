"use client";

// TEY fork: Google Ads report, read only. The API is services/ads.ts.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, Settings } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useState } from "react";
import { dashed, projectSettingsHref, useGoogleState } from "@/components/google/connection";
import { type Column, DataTable } from "@/components/research/data-table";
import { Check, Note, Segmented, TabPanel, Tabs, useQueryState } from "@/components/tracking/kit";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, PageHeader, Spinner, Stat } from "@/components/ui";
import { api, num } from "@/lib/api";
import { downloadCsv } from "@/lib/lookup";

type Range = "last_7_days" | "last_28_days" | "last_3_months";
type Totals = { cost: number; clicks: number; impressions: number; conversions: number; conversionsValue: number; ctr: number | null; cpc: number | null; costPerConversion: number | null; roas: number | null };
type Period = { startDate: string; endDate: string };
type Account = { customerId: string; descriptiveName: string; currencyCode: string | null; timeZone: string | null };
type Overview = { account: Account; periods: { current: Period; previous: Period }; current: Totals; previous: Totals };
type Campaign = Totals & { campaignId: string; name: string; status: string | null; channelType: string | null; dailyBudget: number | null };
type Term = Totals & { searchTerm: string; status: string | null; campaign: string; adGroup: string; noConversions: boolean };
type Terms = { summary: { terms: number; cost: number; noConversionTerms: number; noConversionCost: number }; rows: Term[] };

const RANGES: { id: Range; label: string }[] = [
  { id: "last_7_days", label: "7 days" },
  { id: "last_28_days", label: "28 days" },
  { id: "last_3_months", label: "3 months" },
];
const TABS = ["campaigns", "terms"] as const;
type TabId = (typeof TABS)[number];

/** Percentage change. `better` says which way is good: spend going up is neither good nor bad. */
function change(current: number | null, previous: number | null, better: "up" | "down" | "none" = "up"): { text: string; good: boolean | null } | null {
  if (current == null || previous == null) return null;
  if (previous === 0) return current === 0 ? { text: "no change", good: null } : null;
  const delta = ((current - previous) / previous) * 100;
  const flat = Math.abs(delta) < 0.05;
  return {
    text: `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta).toFixed(1)}% vs previous period`,
    good: flat || better === "none" ? null : better === "up" ? delta > 0 : delta < 0,
  };
}

function Change({ value }: { value: ReturnType<typeof change> }) {
  if (!value) return <span>no earlier data</span>;
  return <span className={value.good === null ? "" : value.good ? "text-pos" : "text-neg"}>{value.text}</span>;
}

const STATUS_TONE: Record<string, "pos" | "neutral" | "warn"> = { ENABLED: "pos", PAUSED: "warn" };
const TERM_STATUS: Record<string, string> = { ADDED: "keyword", EXCLUDED: "excluded", ADDED_EXCLUDED: "keyword, excluded" };
const titleCase = (value: string | null) => (value ? value.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "—");

function Report({ projectId, currency }: { projectId: string; currency: string | null }) {
  const [range, setRange] = useState<Range>("last_28_days");
  const [tab, setTab] = useQueryState<TabId>("tab", TABS, "campaigns");
  const [onlyWasted, setOnlyWasted] = useState(false);
  const overview = useQuery({ queryKey: ["ads", projectId, "overview", range], queryFn: () => api<Overview>(`/projects/${projectId}/ads/overview`, { query: { range } }), placeholderData: keepPreviousData });
  const campaigns = useQuery({ queryKey: ["ads", projectId, "campaigns", range], queryFn: () => api<{ rows: Campaign[] }>(`/projects/${projectId}/ads/campaigns`, { query: { range } }), placeholderData: keepPreviousData });
  const terms = useQuery({
    queryKey: ["ads", projectId, "terms", range],
    queryFn: () => api<Terms>(`/projects/${projectId}/ads/search-terms`, { query: { range, limit: 500 } }),
    placeholderData: keepPreviousData,
    enabled: tab === "terms",
  });
  const data = overview.data;
  const money = (value: number | null, digits = 0) =>
    value == null ? "—" : new Intl.NumberFormat(undefined, { style: "currency", currency: currency ?? "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  const roas = (value: number | null) => (value == null ? "—" : `${value.toFixed(2)}×`);

  const metricColumns = <T extends Totals>(): Column<T>[] => [
    { key: "cost", header: "Spend", align: "right", sortValue: (r) => r.cost, render: (r) => money(r.cost) },
    { key: "clicks", header: "Clicks", align: "right", sortValue: (r) => r.clicks, render: (r) => num(r.clicks) },
    { key: "cpc", header: "CPC", align: "right", sortValue: (r) => r.cpc, render: (r) => money(r.cpc, 2) },
    { key: "conversions", header: "Conversions", align: "right", sortValue: (r) => r.conversions, render: (r) => num(r.conversions) },
    { key: "costPerConversion", header: "Cost / conv.", align: "right", firstOrder: "asc", sortValue: (r) => r.costPerConversion, render: (r) => money(r.costPerConversion, 2) },
    { key: "conversionsValue", header: "Conv. value", align: "right", sortValue: (r) => r.conversionsValue, render: (r) => money(r.conversionsValue) },
    { key: "roas", header: "ROAS", align: "right", sortValue: (r) => r.roas, render: (r) => roas(r.roas) },
  ];
  const campaignColumns: Column<Campaign>[] = [
    {
      key: "name",
      header: "Campaign",
      rowHeader: true,
      sortValue: (r) => r.name,
      render: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{r.name}</span>
          {r.status && <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{titleCase(r.status)}</Badge>}
          <span className="text-xs text-muted">{titleCase(r.channelType)}</span>
        </span>
      ),
    },
    { key: "dailyBudget", header: "Daily budget", align: "right", sortValue: (r) => r.dailyBudget, render: (r) => money(r.dailyBudget) },
    ...metricColumns<Campaign>(),
  ];
  const termColumns: Column<Term>[] = [
    {
      key: "searchTerm",
      header: "Search term",
      rowHeader: true,
      sortValue: (r) => r.searchTerm,
      render: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className={r.noConversions ? "font-medium text-neg" : "font-medium"}>{r.searchTerm}</span>
          {r.status && TERM_STATUS[r.status] && <Badge tone={r.status === "EXCLUDED" ? "neutral" : "accent"}>{TERM_STATUS[r.status]}</Badge>}
        </span>
      ),
    },
    { key: "campaign", header: "Campaign · ad group", sortValue: (r) => `${r.campaign} ${r.adGroup}`, render: (r) => <span className="text-xs text-muted">{`${r.campaign} · ${r.adGroup}`}</span> },
    ...metricColumns<Term>().filter((c) => c.key !== "roas" && c.key !== "conversionsValue"),
  ];
  const shownTerms = (terms.data?.rows ?? []).filter((r) => !onlyWasted || r.noConversions);

  return (
    <section className="space-y-5" aria-label="Google Ads">
      <div className="flex flex-wrap items-end gap-3">
        <Segmented label="Period" value={range} onChange={setRange} options={RANGES} />
        {data && (
          <p className="font-mono text-xs text-muted">
            {data.account.descriptiveName} ({dashed(data.account.customerId)}) · {data.periods.current.startDate} to {data.periods.current.endDate}
            {data.account.timeZone ? `, ${data.account.timeZone}` : ""}
          </p>
        )}
      </div>
      {overview.isPending && <Spinner />}
      <ErrorNote error={overview.error ?? campaigns.error} />
      {data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Spend" value={money(data.current.cost)} sub={<Change value={change(data.current.cost, data.previous.cost, "none")} />} />
          <Stat label="Clicks" value={num(data.current.clicks)} sub={<span>CPC {money(data.current.cpc, 2)} · CTR {data.current.ctr == null ? "—" : `${data.current.ctr}%`}</span>} />
          <Stat label="Conversions" value={num(data.current.conversions)} sub={<Change value={change(data.current.conversions, data.previous.conversions)} />} />
          <Stat label="Cost per conversion" value={money(data.current.costPerConversion, 2)} sub={<Change value={change(data.current.costPerConversion, data.previous.costPerConversion, "down")} />} />
          <Stat label="ROAS" value={roas(data.current.roas)} sub={<Change value={change(data.current.roas, data.previous.roas)} />} />
        </div>
      )}
      <Tabs
        label="Google Ads views"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "campaigns", label: "Campaigns", count: campaigns.data?.rows.length ?? null },
          { id: "terms", label: "Search terms" },
        ]}
      />
      <TabPanel id="campaigns" hidden={tab !== "campaigns"}>
        {campaigns.isPending && <Spinner />}
        {campaigns.data && (
          <Card>
            <CardHeader
              title="Campaigns"
              description="Campaigns with activity in the period, most spend first. Conversions and value are as Google Ads counts them."
              action={
                <Button size="sm" disabled={!campaigns.data.rows.length} onClick={() => campaigns.data && downloadCsv(`google-ads-campaigns-${range}.csv`, campaigns.data.rows)}>
                  <Download className="size-3.5" aria-hidden /> CSV
                </Button>
              }
            />
            <DataTable rows={campaigns.data.rows} columns={campaignColumns} rowKey={(r) => r.campaignId} caption="Campaigns" initialSort={{ key: "cost", order: "desc" }} empty={<p className="p-4 text-[13px] text-muted">No campaign had activity in this period.</p>} />
          </Card>
        )}
      </TabPanel>
      <TabPanel id="terms" hidden={tab !== "terms"}>
        {terms.isPending && <Spinner />}
        <ErrorNote error={terms.error} />
        {terms.data && (
          <div className="space-y-3">
            {terms.data.summary.noConversionTerms > 0 && (
              <Note tone="warn">
                {num(terms.data.summary.noConversionTerms)} of the top {num(terms.data.summary.terms)} search terms cost {money(terms.data.summary.noConversionCost)} and brought no conversions (
                {terms.data.summary.cost ? `${((terms.data.summary.noConversionCost / terms.data.summary.cost) * 100).toFixed(0)}%` : "—"} of their spend). They are the candidates for negative keywords.
              </Note>
            )}
            <Card>
              <CardHeader
                title="Search terms"
                description="What people searched before clicking a Search ad, top 500 by spend. Performance Max terms are not included."
                action={
                  <div className="flex flex-wrap items-center gap-3">
                    <Check checked={onlyWasted} onChange={setOnlyWasted}>
                      Only terms with no conversions
                    </Check>
                    <Button size="sm" disabled={!shownTerms.length} onClick={() => downloadCsv(`google-ads-search-terms-${range}${onlyWasted ? "-no-conversions" : ""}.csv`, shownTerms)}>
                      <Download className="size-3.5" aria-hidden /> CSV
                    </Button>
                  </div>
                }
              />
              <DataTable rows={shownTerms} columns={termColumns} rowKey={(r) => `${r.searchTerm}|${r.campaign}|${r.adGroup}`} caption="Search terms" initialSort={{ key: "cost", order: "desc" }} empty={<p className="p-4 text-[13px] text-muted">No search terms in this period.</p>} />
            </Card>
          </div>
        )}
      </TabPanel>
    </section>
  );
}

function GoogleAds() {
  const { projectId } = useParams<{ projectId: string }>();
  const google = useGoogleState(projectId);
  const state = google.data;
  return (
    <>
      <PageHeader title="Google Ads" description="Spend and results of the project's ad account, read live and read only." />
      <div className="space-y-6">
        {google.isPending && <Spinner />}
        <ErrorNote error={google.error} />
        {state &&
          (state.ads ? (
            <Report projectId={projectId} currency={state.ads.currencyCode} />
          ) : (
            <EmptyState
              title="Connect Google Ads to see spend and results"
              action={
                <Link href={projectSettingsHref(projectId)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 text-[13px] font-medium text-accent-fg shadow-card hover:brightness-95">
                  <Settings className="size-3.5" aria-hidden /> Connect in project settings
                </Link>
              }
            >
              Spend, conversions, ROAS, campaigns and the search terms that cost money without converting. Connect the Google account that reaches the ad account, directly or through a manager account (MCC). OpenSEO changes nothing in the account.
            </EmptyState>
          ))}
      </div>
    </>
  );
}

export default function GoogleAdsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <GoogleAds />
    </Suspense>
  );
}
