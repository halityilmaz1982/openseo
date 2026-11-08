/**
 * TEY fork: Meta ads routes. A login comes from /meta/connect ("Continue with Facebook") or a pasted
 * token; a project then picks one ad account and reads its reports. Read only and free.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env";
import { requireProject, requireSessionUser, requireUser, resolveUser } from "../lib/context";
import { AppError, parse, uuidParam } from "../lib/errors";
import { addMetaToken, connectMeta, disconnectMeta, finishMetaLink, listAdAccounts, listMetaAccounts, MetaLinkError, metaCampaignDaily, metaCampaigns, metaOverview, metaState, removeMetaAccount, startMetaLink } from "../services/meta";
import { RANGES } from "../services/google";

type P = { Params: { projectId: string } };
const range = z.enum(Object.keys(RANGES) as [keyof typeof RANGES, ...(keyof typeof RANGES)[]]).default("last_28_days");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");

export async function metaRoutes(app: FastifyInstance) {
  // ── Logins ──

  app.get<{ Querystring: { returnTo?: string } }>("/meta/connect", async (request, reply) => {
    const user = await requireUser(request);
    if (user.via !== "session") throw new AppError(403, "forbidden", "Connect Meta from the dashboard, signed in");
    return reply.redirect(await startMetaLink(user.id, request.query.returnTo));
  });

  // Facebook sends the browser back here; every outcome ends on the dashboard with ?meta_connected=1 or ?meta_error=<code>.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/meta/callback", async (request, reply) => {
    const back = (path: string, params: Record<string, string>) => {
      const url = new URL(path, env.APP_URL);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      return reply.redirect(url.toString());
    };
    const user = await resolveUser(request);
    if (!user || user.via !== "session") return back("/sign-in", { meta_error: "signed_out" });
    try {
      return back(await finishMetaLink(user.id, request.query), { meta_connected: "1" });
    } catch (error) {
      if (error instanceof MetaLinkError) return back(error.returnTo, { meta_error: error.code });
      request.log.error(error);
      return back("/projects", { meta_error: "failed" });
    }
  });

  app.post("/meta/accounts", async (request) => {
    const user = await requireSessionUser(request);
    const { token } = parse(z.object({ token: z.string().trim().min(20).max(1000) }), request.body);
    return { ok: true, data: await addMetaToken(user.id, token) };
  });

  app.get("/meta/accounts", async (request) => {
    const user = await requireUser(request);
    return { ok: true, data: await listMetaAccounts(user.id) };
  });

  app.delete<{ Params: { accountId: string } }>("/meta/accounts/:accountId", async (request) => {
    const user = await requireSessionUser(request);
    return { ok: true, data: await removeMetaAccount(user.id, uuidParam(request.params.accountId, "Meta login")) };
  });

  // ── A project's ad account ──

  app.get<P>("/projects/:projectId/meta", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    return { ok: true, data: await metaState(project, user.id) };
  });

  app.get<{ Params: { projectId: string }; Querystring: { accountId?: string } }>("/projects/:projectId/meta/ad-accounts", async (request) => {
    const user = await requireUser(request);
    await requireProject(user.id, request.params.projectId);
    return { ok: true, data: await listAdAccounts(user.id, uuidParam(String(request.query.accountId ?? ""), "Meta login")) };
  });

  app.put<P>("/projects/:projectId/meta", async (request) => {
    const user = await requireSessionUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const input = parse(z.object({ accountId: z.string().uuid(), adAccountId: z.string().regex(/^act_\d+$/, "an ad account ID like act_1234567890") }), request.body);
    return { ok: true, data: await connectMeta(project, user.id, input.accountId, input.adAccountId) };
  });

  app.delete<P>("/projects/:projectId/meta", async (request) => {
    const user = await requireSessionUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    await disconnectMeta(project);
    return { ok: true };
  });

  // ── Reports ──

  app.get<P>("/projects/:projectId/meta/overview", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    return { ok: true, data: await metaOverview(project, parse(z.object({ range }), request.query).range) };
  });

  app.get<P>("/projects/:projectId/meta/campaigns", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    return { ok: true, data: await metaCampaigns(project, parse(z.object({ range }), request.query).range) };
  });

  app.get<P>("/projects/:projectId/meta/campaign-daily", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const q = parse(z.object({ from: day, to: day }), request.query);
    return { ok: true, data: await metaCampaignDaily(project, q.from, q.to) };
  });
}
