"use client";

// TEY fork: the Meta ads connection card in project settings. The API is apps/api/src/services/meta.ts.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plug, Trash2 } from "lucide-react";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog, Note } from "@/components/tracking/kit";
import { Badge, Button, Card, CardHeader, ErrorNote, Field, Input, Select } from "@/components/ui";
import { api, dateOnly } from "@/lib/api";

export type MetaLogin = { id: string; kind: "user" | "token"; name: string | null; expiresAt: string | null; createdAt: string };
export type MetaState = {
  configured: boolean;
  redirectUri: string;
  connection: { adAccountId: string; name: string; currency: string | null; timeZone: string | null; accountId: string; login: string | null; kind: "user" | "token"; expiresAt: string | null; createdAt: string } | null;
  accounts: MetaLogin[];
};
type AdAccount = { adAccountId: string; name: string; currency: string | null; status: string; active: boolean; business: string | null };

export const META_ERRORS: Record<string, string> = {
  state_mismatch: "The Facebook link expired or was opened in another session. Try again from this page.",
  access_denied: "Facebook access was not granted.",
  scope_denied: "The ads_read permission was not granted, so nothing was connected.",
  token_exchange_failed: "Facebook did not accept the sign-in. Check the app's redirect URI and META_APP_ID / META_APP_SECRET.",
  signed_out: "You were signed out. Sign in and try again.",
  failed: "Connecting failed. Try again.",
};

export function useMetaState(projectId: string) {
  return useQuery({ queryKey: ["meta", projectId, "state"], queryFn: () => api<MetaState>(`/projects/${projectId}/meta`) });
}

const DAY_MS = 86_400_000;
function expiry(login: { kind: string; expiresAt: string | null }): { text: string; tone: "neutral" | "warn" | "neg" } {
  if (!login.expiresAt) return { text: login.kind === "token" ? "does not expire" : "no expiry known", tone: "neutral" };
  const left = new Date(login.expiresAt).getTime() - Date.now();
  if (left <= 0) return { text: `expired ${dateOnly(login.expiresAt)}`, tone: "neg" };
  return { text: `expires ${dateOnly(login.expiresAt)}`, tone: left < 7 * DAY_MS ? "warn" : "neutral" };
}

function AdAccountPicker({ projectId, logins, onDone }: { projectId: string; logins: MetaLogin[]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState(logins[0]?.id ?? "");
  const [choice, setChoice] = useState("");
  const options = useQuery({
    queryKey: ["meta", projectId, "ad-accounts", accountId],
    queryFn: () => api<AdAccount[]>(`/projects/${projectId}/meta/ad-accounts`, { query: { accountId } }),
    enabled: Boolean(accountId),
  });
  const save = useMutation({
    mutationFn: () => api(`/projects/${projectId}/meta`, { method: "PUT", body: { accountId, adAccountId: choice } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["meta", projectId] });
      onDone();
    },
  });
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (choice) save.mutate();
      }}
    >
      <Field label="Meta login">
        <Select
          value={accountId}
          onChange={(event) => {
            setAccountId(event.target.value);
            setChoice("");
          }}
        >
          {logins.map((login) => (
            <option key={login.id} value={login.id}>
              {login.name ?? login.id} ({login.kind === "token" ? "token" : "Facebook"})
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Ad account" hint="Accounts shared with your business as a partner are listed too, when the login can see them.">
        <Select value={choice} onChange={(event) => setChoice(event.target.value)} disabled={!options.data?.length}>
          <option value="">{options.isPending ? "Loading…" : options.data?.length ? "Choose…" : "None for this login"}</option>
          {options.data?.map((a) => (
            <option key={a.adAccountId} value={a.adAccountId}>
              {a.name} ({a.adAccountId.replace("act_", "")}
              {a.currency ? `, ${a.currency}` : ""}){a.business ? ` · ${a.business}` : ""}
              {a.active ? "" : ` · ${a.status}`}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={!choice} loading={save.isPending}>
          Use this ad account
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <div className="sm:col-span-2">
        <ErrorNote error={options.error ?? save.error} />
      </div>
    </form>
  );
}

function TokenForm({ onAdded }: { onAdded: () => void }) {
  const [token, setToken] = useState("");
  const add = useMutation({
    mutationFn: () => api("/meta/accounts", { method: "POST", body: { token } }),
    onSuccess: () => {
      setToken("");
      onAdded();
    },
  });
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (token.trim()) add.mutate();
      }}
    >
      <Field
        label="Access token"
        hint="Business settings → Users → System users: assign the ad accounts, then generate a token for your app with ads_read. A system user's token does not expire. Stored encrypted."
      >
        <div className="flex gap-2">
          <Input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="EAAB…" />
          <Button type="submit" disabled={token.trim().length < 20} loading={add.isPending}>
            <KeyRound className="size-3.5" aria-hidden /> Add
          </Button>
        </div>
      </Field>
      <ErrorNote error={add.error} />
    </form>
  );
}

export function MetaCard({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const state = useMetaState(projectId);
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState<MetaLogin | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["meta", projectId] });
  const disconnect = useMutation({
    mutationFn: () => api(`/projects/${projectId}/meta`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirming(false);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/meta/accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setRemoving(null);
      void queryClient.invalidateQueries({ queryKey: ["meta"] });
    },
  });
  const data = state.data;
  const connection = data?.connection;
  const logins = data?.accounts ?? [];
  const connectionExpiry = connection ? expiry(connection) : null;

  return (
    <Card>
      <CardHeader
        title="Meta Ads"
        description="Facebook and Instagram ads: spend, link clicks, purchases and ROAS of one ad account, read only."
        action={<Badge tone={connection ? "pos" : "neutral"}>{connection ? "Connected" : "Not connected"}</Badge>}
      />
      <div className="space-y-4 p-4 text-[13px]">
        <ErrorNote error={state.error} />
        {connection && !picking && (
          <>
            <p>
              <span className="font-medium">
                {connection.name} ({connection.adAccountId.replace("act_", "")})
              </span>
              <span className="block text-xs text-muted">
                Read through {connection.login ?? "a Meta login"} ({connection.kind === "token" ? "token" : "Facebook"}, {connectionExpiry?.text}), since {dateOnly(connection.createdAt)}.
              </span>
            </p>
            {connectionExpiry && connectionExpiry.tone !== "neutral" && <Note tone="warn">This login {connectionExpiry.text}. Connect with Facebook again, or add a system-user token, to keep the reports running.</Note>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setPicking(true)}>
                Change ad account
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
                Disconnect from this project
              </Button>
            </div>
          </>
        )}
        {(!connection || picking) &&
          (logins.length ? (
            <AdAccountPicker projectId={projectId} logins={logins} onDone={() => setPicking(false)} />
          ) : (
            <p className="text-muted">No Meta login yet. Add one below.</p>
          ))}

        <div className="space-y-3 border-t border-line pt-4">
          {data?.configured && (
            <a href={`/api/meta/connect?returnTo=${encodeURIComponent(pathname)}`} className="inline-flex items-center gap-1.5 text-[13px] font-medium underline underline-offset-2">
              <Plug className="size-3.5" aria-hidden /> Continue with Facebook (60-day access)
            </a>
          )}
          <TokenForm onAdded={refresh} />
          {data && !data.configured && <p className="text-xs text-muted">To connect with Facebook instead, set META_APP_ID and META_APP_SECRET with the redirect URI {data.redirectUri}.</p>}
        </div>

        {logins.length > 0 && (
          <ul className="divide-y divide-line rounded-md border border-line">
            {logins.map((login) => {
              const e = expiry(login);
              return (
                <li key={login.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span>
                    <span className="font-medium">{login.name ?? login.id}</span>{" "}
                    <span className={e.tone === "neg" ? "text-neg" : e.tone === "warn" ? "text-warn" : "text-muted"}>
                      · {login.kind === "token" ? "token" : "Facebook"}, {e.text}
                    </span>
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(login)}>
                    <Trash2 className="size-3.5" aria-hidden /> Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => disconnect.mutate()}
        title="Disconnect Meta Ads?"
        confirmLabel="Disconnect"
        danger
        pending={disconnect.isPending}
        error={disconnect.error}
      >
        <p>This project stops reading {connection?.name ?? "this ad account"}. The Meta login stays, so you can pick the account again later.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing.id)}
        title="Remove this Meta login?"
        confirmLabel="Remove"
        danger
        pending={remove.isPending}
        error={remove.error}
      >
        <p>OpenSEO deletes its token for {removing?.name ?? "this login"} and disconnects every project that reads through it. To revoke it on Meta&apos;s side too, remove the app in Business settings or your Facebook settings.</p>
      </ConfirmDialog>
    </Card>
  );
}
