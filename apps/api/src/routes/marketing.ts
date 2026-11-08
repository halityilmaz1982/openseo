/**
 * TEY fork: Google Analytics 4 and Google Ads routes. Connecting starts at /google/ga4/connect and
 * /google/ads/connect (routes/google.ts); here a project picks its property or ad account and reads
 * the reports. Free: Google's APIs cost nothing and nothing is spent from YepAPI.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireProject, requireSessionUser, requireUser } from "../lib/context";
import { parse, uuidParam } from "../lib/errors";
import { adsCampaignDaily, adsCampaigns, adsOverview, adsSearchTerms, connectAds, listCustomers } from "../services/ads";
import { analyticsChannels, analyticsOverview, analyticsSources, CHANNELS, connectGa4, landingPages, listProperties } from "../services/analytics";
import { RANGES } from "../services/google";

type P = { Params: { projectId: string } };

const range = z.enum(Object.keys(RANGES) as [keyof typeof RANGES, ...(keyof typeof RANGES)[]]).default("last_28_days");
const channel = z.enum(CHANNELS).default("all");
const limit = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");
const customerId = z.string().regex(/^\d{3}-?\d{3}-?\d{4}$/, "a ten-digit Google Ads customer ID");

export async function marketingRoutes(app: FastifyInstance) {
  // ── Choosing what a project reads ──

  app.get<{ Params: { projectId: string }; Querystring: { accountId?: string } }>("/projects/:projectId/google/ga4/properties", async (request) => {
    const user = await requireUser(request);
    await requireProject(user.id, request.params.projectId);
    const accountId = uuidParam(String(request.query.accountId ?? ""), "Google account");
    return { ok: true, data: await listProperties(user.id, accountId) };
  });

  app.put<P>("/projects/:projectId/google/ga4", async (request) => {
    const user = await requireSessionUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const input = parse(z.object({ accountId: z.string().uuid(), propertyId: z.string().min(3).max(100) }), request.body);
    return { ok: true, data: await connectGa4(project, user.id, input.accountId, input.propertyId) };
  });

  app.get<{ Params: { projectId: string }; Querystring: { accountId?: string } }>("/projects/:projectId/google/ads/customers", async (request) => {
    const user = await requireUser(request);
    await requireProject(user.id, request.params.projectId);
    const accountId = uuidParam(String(request.query.accountId ?? ""), "Google account");
    return { ok: true, data: await listCustomers(user.id, accountId) };
  });

  app.put<P>("/projects/:projectId/google/ads", async (request) => {
    const user = await requireSessionUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const input = parse(z.object({ accountId: z.string().uuid(), customerId, loginCustomerId: customerId }), request.body);
    return { ok: true, data: await connectAds(project, user.id, input.accountId, input.customerId, input.loginCustomerId) };
  });

  // ── Google Analytics 4 ──

  app.get<P>("/projects/:projectId/analytics/overview", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const q = parse(z.object({ range, channel }), request.query);
    return { ok: true, data: await analyticsOverview(project, q.range, q.channel) };
  });

  app.get<P>("/projects/:projectId/analytics/channels", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const q = parse(z.object({ range }), request.query);
    return { ok: true, data: await analyticsChannels(project, q.range) };
  });

  app.get<P>("/projects/:projectId/analytics/sources", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const q = parse(z.object({ range, channel, limit: limit(1000, 100) }), request.query);
    return { ok: true, data: await analyticsSources(project, q.range, q.channel, q.limit) };
  });

  app.get<P>("/projects/:projectId/analytics/landing-pages", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const q = parse(z.object({ range, channel, limit: limit(1000, 100) }), request.query);
    return { ok: true, data: await landingPages(project, q.range, q.channel, q.limit) };
  });

  // ── Google Ads ──

  app.get<P>("/projects/:projectId/ads/overview", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const q = parse(z.object({ range }), request.query);
    return { ok: true, data: await adsOverview(project, q.range) };
  });

  app.get<P>("/projects/:projectId/ads/campaigns", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const q = parse(z.object({ range }), request.query);
    return { ok: true, data: await adsCampaigns(project, q.range) };
  });

  app.get<P>("/projects/:projectId/ads/search-terms", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const q = parse(z.object({ range, limit: limit(1000, 200) }), request.query);
    return { ok: true, data: await adsSearchTerms(project, q.range, q.limit) };
  });

  // For other systems (HSM's ROAS report) pulling spend per campaign per day with an API key.
  app.get<P>("/projects/:projectId/ads/campaign-daily", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const q = parse(z.object({ from: day, to: day }), request.query);
    return { ok: true, data: await adsCampaignDaily(project, q.from, q.to) };
  });
}
