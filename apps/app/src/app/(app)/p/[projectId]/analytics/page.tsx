"use client";

// TEY fork: Google Analytics 4 report. Upstream dropped GA4 on 2026-10-26; the API is services/analytics.ts.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, Settings } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useState } from "react";
import { projectSettingsHref, useGoogleState } from "@/components/google/connection";
import { type Column, DataTable } from "@/components/research/data-table";
import { Note, Segmented } from "@/components/tracking/kit";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, PageHeader, Spinner, Stat } from "@/components/ui";
import { api, num } from "@/lib/api";
import { downloadCsv } from "@/lib/lookup";

type Range = "last_7_days" | "last_28_days" | "last_3_months";
type Channel = "all" | "organic" | "paid";
type Metrics = { sessions: number; activeUsers: number; engagedSessions: number; engagementRate: number; keyEvents: number; transactions: number; purchaseRevenue: number };
type Property = { propertyId: string; displayName: string; timeZone: string | null; currencyCode: string | null };
type Overview = { property: Property; current: Metrics; previous: Metrics; limitedData: boolean };
type Row = Record<string, string | number | boolean>;
type Rows = { rows: Row[]; limitedData: boolean };

const RANGES: { id: Range; label: string }[] = [
  { id: "last_7_days", label: "7 days" },
  { id: "last_28_days", label: "28 days" },
  { id: "last_3_months", label: "3 months" },
];
const CHANNELS: { id: Channel; label: string }[] = [
  { id: "all", label: "All traffic" },
  { id: "organic", label: "Organic search" },
  { id: "paid", label: "Paid" },
];

function change(current: number, previous: number): { text: string; good: boolean | null } | null {
  if (previous === 0) return current === 0 ? { text: "no change", good: null } : null;
  const delta = ((current - previous) / previous) * 100;
  return { text: `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta).toFixed(1)}% vs previous period`, good: Math.abs(delta) < 0.05 ? null : delta > 0 };
}

function Change({ value }: { value: ReturnType<typeof change> }) {
  if (!value) return <span>no earlier data</span>;
  return <span className={value.good === null ? "" : value.good ? "text-pos" : "text-neg"}>{value.text}</span>;
}

const percent = (value: unknown) => `${(Number(value) * 100).toFixed(1)}%`;

function Report({ projectId, currency }: { projectId: string; currency: string | null }) {
  const [range, setRange] = useState<Range>("last_28_days");
  const [channel, setChannel] = useState<Channel>("all");
  const query = { range, channel };
  const overview = useQuery({ queryKey: ["ga4", projectId, "overview", query], queryFn: () => api<Overview>(`/projects/${projectId}/analytics/overview`, { query }), placeholderData: keepPreviousData });
  const channels = useQuery({ queryKey: ["ga4", projectId, "channels", range], queryFn: () => api<Rows>(`/projects/${projectId}/analytics/channels`, { query: { range } }), placeholderData: keepPreviousData });
  const sources = useQuery({ queryKey: ["ga4", projectId, "sources", query], queryFn: () => api<Rows>(`/projects/${projectId}/analytics/sources`, { query: { ...query, limit: 100 } }), placeholderData: keepPreviousData });
  const pages = useQuery({ queryKey: ["ga4", projectId, "pages", query], queryFn: () => api<Rows>(`/projects/${projectId}/analytics/landing-pages`, { query: { ...query, limit: 50 } }), placeholderData: keepPreviousData });
  const data = overview.data;
  const money = (value: unknown) => new Intl.NumberFormat(undefined, { style: "currency", currency: currency ?? "USD", maximumFractionDigits: 0 }).format(Number(value));
  const totalRevenue = (channels.data?.rows ?? []).reduce((sum, r) => sum + Number(r.purchaseRevenue), 0);

  const channelColumns: Column<Row>[] = [
    {
      key: "sessionDefaultChannelGroup",
      header: "Channel",
      rowHeader: true,
      sortValue: (r) => String(r.sessionDefaultChannelGroup),
      render: (r) => (
        <span className="flex items-center gap-2 font-medium">
          {String(r.sessionDefaultChannelGroup)}
          {r.paid === true && <Badge tone="accent">paid</Badge>}
        </span>
      ),
    },
    { key: "sessions", header: "Sessions", align: "right", sortValue: (r) => Number(r.sessions), render: (r) => num(Number(r.sessions)) },
    { key: "engagementRate", header: "Engagement", align: "right", sortValue: (r) => Number(r.engagementRate), render: (r) => percent(r.engagementRate) },
    { key: "keyEvents", header: "Key events", align: "right", sortValue: (r) => Number(r.keyEvents), render: (r) => num(Number(r.keyEvents)) },
    { key: "transactions", header: "Purchases", align: "right", sortValue: (r) => Number(r.transactions), render: (r) => num(Number(r.transactions)) },
    { key: "purchaseRevenue", header: "Revenue", align: "right", sortValue: (r) => Number(r.purchaseRevenue), render: (r) => money(r.purchaseRevenue) },
    { key: "share", header: "Share of revenue", align: "right", sortValue: (r) => Number(r.purchaseRevenue), render: (r) => (totalRevenue ? `${((Number(r.purchaseRevenue) / totalRevenue) * 100).toFixed(1)}%` : "—") },
  ];
  const sourceColumns: Column<Row>[] = [
    { key: "source", header: "Source / medium", rowHeader: true, sortValue: (r) => `${r.sessionSource}/${r.sessionMedium}`, render: (r) => <span className="font-medium">{`${r.sessionSource} / ${r.sessionMedium}`}</span> },
    { key: "sessionCampaignName", header: "Campaign", sortValue: (r) => String(r.sessionCampaignName), render: (r) => <span className="text-muted">{String(r.sessionCampaignName)}</span> },
    { key: "sessions", header: "Sessions", align: "right", sortValue: (r) => Number(r.sessions), render: (r) => num(Number(r.sessions)) },
    { key: "keyEvents", header: "Key events", align: "right", sortValue: (r) => Number(r.keyEvents), render: (r) => num(Number(r.keyEvents)) },
    { key: "transactions", header: "Purchases", align: "right", sortValue: (r) => Number(r.transactions), render: (r) => num(Number(r.transactions)) },
    { key: "purchaseRevenue", header: "Revenue", align: "right", sortValue: (r) => Number(r.purchaseRevenue), render: (r) => money(r.purchaseRevenue) },
  ];
  const pageColumns: Column<Row>[] = [
    { key: "landingPage", header: "Landing page", rowHeader: true, sortValue: (r) => String(r.landingPage), render: (r) => <span className="font-mono text-xs break-all">{String(r.landingPage)}</span> },
    { key: "sessions", header: "Sessions", align: "right", sortValue: (r) => Number(r.sessions), render: (r) => num(Number(r.sessions)) },
    { key: "engagementRate", header: "Engagement", align: "right", sortValue: (r) => Number(r.engagementRate), render: (r) => percent(r.engagementRate) },
    { key: "keyEvents", header: "Key events", align: "right", sortValue: (r) => Number(r.keyEvents), render: (r) => num(Number(r.keyEvents)) },
    { key: "sessionKeyEventRate", header: "Key-event rate", align: "right", sortValue: (r) => Number(r.sessionKeyEventRate), render: (r) => percent(r.sessionKeyEventRate) },
    { key: "purchaseRevenue", header: "Revenue", align: "right", sortValue: (r) => Number(r.purchaseRevenue), render: (r) => money(r.purchaseRevenue) },
  ];
  const channelLabel = { all: "all", organic: "organic search", paid: "paid" }[channel];

  return (
    <section className="space-y-5" aria-label="Google Analytics">
      <div className="flex flex-wrap items-end gap-3">
        <Segmented label="Period" value={range} onChange={setRange} options={RANGES} />
        <Segmented label="Traffic" value={channel} onChange={setChannel} options={CHANNELS} />
        {data && (
          <p className="font-mono text-xs text-muted">
            {data.property.displayName} · complete days to yesterday{data.property.timeZone ? `, ${data.property.timeZone}` : ""}
          </p>
        )}
      </div>
      {overview.isPending && <Spinner />}
      <ErrorNote error={overview.error ?? channels.error ?? sources.error ?? pages.error} />
      {(data?.limitedData || channels.data?.limitedData) && <Note tone="warn">Google sampled, thresholded or grouped part of this data, so the numbers are approximate.</Note>}
      {data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Sessions" value={num(data.current.sessions)} sub={<Change value={change(data.current.sessions, data.previous.sessions)} />} />
          <Stat label="Engagement rate" value={percent(data.current.engagementRate)} sub={<Change value={change(data.current.engagementRate, data.previous.engagementRate)} />} />
          <Stat label="Key events" value={num(data.current.keyEvents)} sub={<Change value={change(data.current.keyEvents, data.previous.keyEvents)} />} />
          <Stat label="Purchases" value={num(data.current.transactions)} sub={<Change value={change(data.current.transactions, data.previous.transactions)} />} />
          <Stat label="Revenue" value={money(data.current.purchaseRevenue)} sub={<Change value={change(data.current.purchaseRevenue, data.previous.purchaseRevenue)} />} />
        </div>
      )}
      {channels.data && (
        <Card>
          <CardHeader
            title="Channels"
            description="Every channel in the period, whatever the traffic filter: where visits and revenue come from, paid next to organic."
            action={
              <Button size="sm" disabled={!channels.data.rows.length} onClick={() => channels.data && downloadCsv("analytics-channels.csv", channels.data.rows)}>
                <Download className="size-3.5" aria-hidden /> CSV
              </Button>
            }
          />
          <DataTable rows={channels.data.rows} columns={channelColumns} rowKey={(r) => String(r.sessionDefaultChannelGroup)} caption="Channels" initialSort={{ key: "sessions", order: "desc" }} empty={<p className="p-4 text-[13px] text-muted">No sessions in this period.</p>} />
        </Card>
      )}
      {sources.data && (
        <Card>
          <CardHeader
            title="Sources and campaigns"
            description={`Source, medium and campaign of ${channelLabel} sessions, with what they bought. Top 100 by sessions.`}
            action={
              <Button size="sm" disabled={!sources.data.rows.length} onClick={() => sources.data && downloadCsv(`analytics-sources-${channel}.csv`, sources.data.rows)}>
                <Download className="size-3.5" aria-hidden /> CSV
              </Button>
            }
          />
          <DataTable rows={sources.data.rows} columns={sourceColumns} rowKey={(r) => `${r.sessionSource}|${r.sessionMedium}|${r.sessionCampaignName}`} caption="Sources and campaigns" initialSort={{ key: "sessions", order: "desc" }} empty={<p className="p-4 text-[13px] text-muted">No sessions in this period.</p>} />
        </Card>
      )}
      {pages.data && (
        <Card>
          <CardHeader
            title="Landing pages"
            description={`Where ${channelLabel} visitors arrive, top 50 by sessions.`}
            action={
              <Button size="sm" disabled={!pages.data.rows.length} onClick={() => pages.data && downloadCsv(`analytics-landing-pages-${channel}.csv`, pages.data.rows)}>
                <Download className="size-3.5" aria-hidden /> CSV
              </Button>
            }
          />
          <DataTable rows={pages.data.rows} columns={pageColumns} rowKey={(r) => `${r.hostName}${r.landingPage}`} caption="Landing pages" initialSort={{ key: "sessions", order: "desc" }} empty={<p className="p-4 text-[13px] text-muted">No sessions in this period.</p>} />
        </Card>
      )}
    </section>
  );
}

function Analytics() {
  const { projectId } = useParams<{ projectId: string }>();
  const google = useGoogleState(projectId);
  const state = google.data;
  return (
    <>
      <PageHeader title="Analytics" description="From your own Google Analytics 4: visits, channels and revenue." />
      <div className="space-y-6">
        {google.isPending && <Spinner />}
        <ErrorNote error={google.error} />
        {state &&
          (state.ga4 ? (
            <Report projectId={projectId} currency={state.ga4.currencyCode} />
          ) : (
            <EmptyState
              title="Connect Google Analytics to see visits and revenue"
              action={
                <Link href={projectSettingsHref(projectId)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 text-[13px] font-medium text-accent-fg shadow-card hover:brightness-95">
                  <Settings className="size-3.5" aria-hidden /> Connect in project settings
                </Link>
              }
            >
              Sessions, channels, key events and revenue from the site&apos;s GA4 property, read live from Google. Free and read only.
            </EmptyState>
          ))}
      </div>
    </>
  );
}

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Analytics />
    </Suspense>
  );
}
