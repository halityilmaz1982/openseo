"use client";

// TEY fork: Meta (Facebook and Instagram) ads report, read only. The API is services/meta.ts.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, Settings } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useState } from "react";
import { projectSettingsHref } from "@/components/google/connection";
import { useMetaState } from "@/components/meta/connection";
import { type Column, DataTable } from "@/components/research/data-table";
import { Segmented } from "@/components/tracking/kit";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, PageHeader, Spinner, Stat } from "@/components/ui";
import { api, num } from "@/lib/api";
import { downloadCsv } from "@/lib/lookup";

type Range = "last_7_days" | "last_28_days" | "last_3_months";
type Totals = {
  spend: number;
  impressions: number;
  linkClicks: number;
  purchases: number;
  purchaseValue: number;
  leads: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  costPerPurchase: number | null;
  costPerLead: number | null;
  roas: number | null;
};
type Period = { startDate: string; endDate: string };
type Overview = { account: { adAccountId: string; name: string; timeZone: string | null }; periods: { current: Period; previous: Period }; current: Totals; previous: Totals };
type Campaign = Totals & { campaignId: string; name: string; status: string | null; objective: string | null; dailyBudget: number | null; lifetimeBudget: number | null };

const RANGES: { id: Range; label: string }[] = [
  { id: "last_7_days", label: "7 days" },
  { id: "last_28_days", label: "28 days" },
  { id: "last_3_months", label: "3 months" },
];

function change(current: number | null, previous: number | null, better: "up" | "down" | "none" = "up"): { text: string; good: boolean | null } | null {
  if (current == null || previous == null) return null;
  if (previous === 0) return current === 0 ? { text: "no change", good: null } : null;
  const delta = ((current - previous) / previous) * 100;
  const flat = Math.abs(delta) < 0.05;
  return { text: `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta).toFixed(1)}% vs previous period`, good: flat || better === "none" ? null : better === "up" ? delta > 0 : delta < 0 };
}

function Change({ value }: { value: ReturnType<typeof change> }) {
  if (!value) return <span>no earlier data</span>;
  return <span className={value.good === null ? "" : value.good ? "text-pos" : "text-neg"}>{value.text}</span>;
}

const STATUS_TONE: Record<string, "pos" | "warn" | "neutral"> = { ACTIVE: "pos", PAUSED: "warn", CAMPAIGN_PAUSED: "warn" };
const label = (value: string | null) => (value ? value.replace(/^OUTCOME_/, "").toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "—");

function Report({ projectId, currency }: { projectId: string; currency: string | null }) {
  const [range, setRange] = useState<Range>("last_28_days");
  const overview = useQuery({ queryKey: ["meta", projectId, "overview", range], queryFn: () => api<Overview>(`/projects/${projectId}/meta/overview`, { query: { range } }), placeholderData: keepPreviousData });
  const campaigns = useQuery({ queryKey: ["meta", projectId, "campaigns", range], queryFn: () => api<{ rows: Campaign[] }>(`/projects/${projectId}/meta/campaigns`, { query: { range } }), placeholderData: keepPreviousData });
  const data = overview.data;
  const money = (value: number | null, digits = 0) =>
    value == null ? "—" : new Intl.NumberFormat(undefined, { style: "currency", currency: currency ?? "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  const roas = (value: number | null) => (value == null ? "—" : `${value.toFixed(2)}×`);
  const hasLeads = (campaigns.data?.rows ?? []).some((r) => r.leads > 0);

  const columns: Column<Campaign>[] = [
    {
      key: "name",
      header: "Campaign",
      rowHeader: true,
      sortValue: (r) => r.name,
      render: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{r.name}</span>
          {r.status && <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{label(r.status)}</Badge>}
          <span className="text-xs text-muted">{label(r.objective)}</span>
        </span>
      ),
    },
    {
      key: "budget",
      header: "Budget",
      align: "right",
      sortValue: (r) => r.dailyBudget ?? r.lifetimeBudget,
      render: (r) => (r.dailyBudget != null ? `${money(r.dailyBudget)}/day` : r.lifetimeBudget != null ? `${money(r.lifetimeBudget)} total` : "—"),
    },
    { key: "spend", header: "Spend", align: "right", sortValue: (r) => r.spend, render: (r) => money(r.spend) },
    { key: "linkClicks", header: "Link clicks", align: "right", sortValue: (r) => r.linkClicks, render: (r) => num(r.linkClicks) },
    { key: "cpc", header: "CPC", align: "right", sortValue: (r) => r.cpc, render: (r) => money(r.cpc, 2) },
    { key: "purchases", header: "Purchases", align: "right", sortValue: (r) => r.purchases, render: (r) => num(r.purchases) },
    { key: "costPerPurchase", header: "Cost / purchase", align: "right", firstOrder: "asc", sortValue: (r) => r.costPerPurchase, render: (r) => money(r.costPerPurchase, 2) },
    { key: "purchaseValue", header: "Purchase value", align: "right", sortValue: (r) => r.purchaseValue, render: (r) => money(r.purchaseValue) },
    { key: "roas", header: "ROAS", align: "right", sortValue: (r) => r.roas, render: (r) => roas(r.roas) },
    ...(hasLeads ? [{ key: "leads", header: "Leads", align: "right" as const, sortValue: (r: Campaign) => r.leads, render: (r: Campaign) => num(r.leads) }] : []),
  ];

  return (
    <section className="space-y-5" aria-label="Meta Ads">
      <div className="flex flex-wrap items-end gap-3">
        <Segmented label="Period" value={range} onChange={setRange} options={RANGES} />
        {data && (
          <p className="font-mono text-xs text-muted">
            {data.account.name} ({data.account.adAccountId.replace("act_", "")}) · {data.periods.current.startDate} to {data.periods.current.endDate}
            {data.account.timeZone ? `, ${data.account.timeZone}` : ""}
          </p>
        )}
      </div>
      {overview.isPending && <Spinner />}
      <ErrorNote error={overview.error ?? campaigns.error} />
      {data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Spend" value={money(data.current.spend)} sub={<Change value={change(data.current.spend, data.previous.spend, "none")} />} />
          <Stat label="Link clicks" value={num(data.current.linkClicks)} sub={<span>CPC {money(data.current.cpc, 2)} · CTR {data.current.ctr == null ? "—" : `${data.current.ctr}%`}</span>} />
          <Stat label="Purchases" value={num(data.current.purchases)} sub={<Change value={change(data.current.purchases, data.previous.purchases)} />} />
          <Stat label="Cost per purchase" value={money(data.current.costPerPurchase, 2)} sub={<Change value={change(data.current.costPerPurchase, data.previous.costPerPurchase, "down")} />} />
          <Stat label="ROAS" value={roas(data.current.roas)} sub={<Change value={change(data.current.roas, data.previous.roas)} />} />
        </div>
      )}
      {campaigns.data && (
        <Card>
          <CardHeader
            title="Campaigns"
            description="Campaigns with delivery in the period, most spend first. Purchases and value are as Meta attributes them (its default attribution window)."
            action={
              <Button size="sm" disabled={!campaigns.data.rows.length} onClick={() => campaigns.data && downloadCsv(`meta-campaigns-${range}.csv`, campaigns.data.rows)}>
                <Download className="size-3.5" aria-hidden /> CSV
              </Button>
            }
          />
          <DataTable rows={campaigns.data.rows} columns={columns} rowKey={(r) => r.campaignId} caption="Campaigns" initialSort={{ key: "spend", order: "desc" }} empty={<p className="p-4 text-[13px] text-muted">No campaign delivered in this period.</p>} />
        </Card>
      )}
    </section>
  );
}

function MetaAds() {
  const { projectId } = useParams<{ projectId: string }>();
  const state = useMetaState(projectId);
  return (
    <>
      <PageHeader title="Meta Ads" description="Facebook and Instagram ads of the project's ad account, read live and read only." />
      <div className="space-y-6">
        {state.isPending && <Spinner />}
        <ErrorNote error={state.error} />
        {state.data &&
          (state.data.connection ? (
            <Report projectId={projectId} currency={state.data.connection.currency} />
          ) : (
            <EmptyState
              title="Connect a Meta ad account to see spend and results"
              action={
                <Link href={projectSettingsHref(projectId)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 text-[13px] font-medium text-accent-fg shadow-card hover:brightness-95">
                  <Settings className="size-3.5" aria-hidden /> Connect in project settings
                </Link>
              }
            >
              Spend, link clicks, purchases, ROAS and campaigns from Meta, with a system-user token or by continuing with Facebook. OpenSEO changes nothing in the account.
            </EmptyState>
          ))}
      </div>
    </>
  );
}

export default function MetaAdsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <MetaAds />
    </Suspense>
  );
}
