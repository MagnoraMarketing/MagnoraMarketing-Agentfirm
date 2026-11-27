import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  useHostNavigation,
  usePluginAction,
  usePluginData,
  usePluginToast,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { ACTION_KEYS, DATA_KEYS, PAGE_ROUTE } from "../constants.js";

type State = "CONNECTED" | "NOT_CONFIGURED" | "DISABLED" | "ERROR" | "EXPIRED";

interface IntegrationStatus {
  key: string;
  label: string;
  category: string;
  state: State;
  detail: string;
  missing: string[];
}

interface OutboxRow {
  id: string;
  kind: "social_post" | "email_send";
  channel: string;
  status: string;
  payload: Record<string, unknown>;
  requestedBy: string | null;
  scheduledFor: string | null;
  decisionNote: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  createdAt: string;
}

interface ErrorRow {
  id: string;
  source: string;
  task: string;
  agentName: string | null;
  error: string;
  retryStatus: string;
  createdAt: string;
}

interface Overview {
  generatedAt: string;
  integrations: IntegrationStatus[];
  outboxCounts: Record<string, number>;
  pendingApprovals: OutboxRow[];
  failedItems: OutboxRow[];
  recentErrors: ErrorRow[];
  repeatedFailures: Array<{ key: string; count: number }>;
}

interface Stats {
  clicks: number;
  leads: number;
  conversions: number;
  sales: number;
  commission: number;
  payouts: number;
  conversionRate: number;
  currency: string;
}

interface AffiliateReport {
  period: string;
  range: { startDate: string; endDate: string };
  providers: Array<{ key: string; name: string; status: State; current: Stats; previous: Stats; change: Record<string, number | null> | null; error: string | null }>;
}

const PERIODS: Array<{ key: string; label: string }> = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "this_month", label: "This month" },
];

const STATE_CLASS: Record<State, string> = {
  CONNECTED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  NOT_CONFIGURED: "bg-muted text-muted-foreground",
  DISABLED: "bg-muted text-muted-foreground",
  ERROR: "bg-red-500/15 text-red-700 dark:text-red-300",
  EXPIRED: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};

function Badge({ state }: { state: State }) {
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-semibold ${STATE_CLASS[state]}`}>{state.replace("_", " ")}</span>;
}

function Card({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Button({ children, onClick, tone = "default", disabled }: { children: ReactNode; onClick: () => void; tone?: "default" | "primary" | "danger"; disabled?: boolean }) {
  const toneClass =
    tone === "primary"
      ? "bg-foreground text-background hover:opacity-90"
      : tone === "danger"
        ? "border border-red-500/50 text-red-700 hover:bg-red-500/10 dark:text-red-300"
        : "border border-border hover:bg-accent";
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={`rounded px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${toneClass}`}>
      {children}
    </button>
  );
}

const fmtDate = (value: string | null) => (value ? new Date(value).toLocaleString() : "—");
const fmtNum = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
const fmtPct = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`);

function useRunner() {
  const toast = usePluginToast();
  const [busy, setBusy] = useState<string | null>(null);
  return {
    busy,
    async run(label: string, fn: () => Promise<unknown>, after?: () => void) {
      setBusy(label);
      try {
        const result = await fn();
        after?.();
        return result;
      } catch (error) {
        toast({ title: `${label} failed`, body: error instanceof Error ? error.message : String(error), tone: "error" });
        return null;
      } finally {
        setBusy(null);
      }
    },
    toast,
  };
}

function ApprovalCard({ item, onDone }: { item: OutboxRow; onDone: () => void }) {
  const approve = usePluginAction(ACTION_KEYS.approve);
  const reject = usePluginAction(ACTION_KEYS.reject);
  const { busy, run, toast } = useRunner();
  const [note, setNote] = useState("");
  const isEmail = item.kind === "email_send";
  const p = item.payload;
  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded bg-amber-500/15 px-2 py-0.5 font-semibold text-amber-700 dark:text-amber-300">PENDING APPROVAL</span>
        <span className="font-medium text-foreground">{isEmail ? "Email send" : `Post → ${item.channel}`}</span>
        <span>by {item.requestedBy ?? "agent"}</span>
        <span>{fmtDate(item.createdAt)}</span>
        {item.scheduledFor ? <span>scheduled {fmtDate(item.scheduledFor)}</span> : null}
      </div>
      {isEmail ? (
        <div className="space-y-1 text-sm">
          <div>
            <b>To:</b> {String(p.to ?? "")}
          </div>
          <div>
            <b>Subject:</b> {String(p.subject ?? "")}
          </div>
          <div className="text-muted-foreground">{String(p.snippet ?? "")}</div>
          {p.reason ? <div className="text-xs">Reason: {String(p.reason)}</div> : null}
        </div>
      ) : (
        <div className="space-y-1 text-sm">
          <pre className="whitespace-pre-wrap font-sans">{String(p.text ?? "")}</pre>
          {p.link ? <div className="text-xs">Link: {String(p.link)}</div> : null}
          {p.imageUrl ? <div className="text-xs">Image: {String(p.imageUrl)}</div> : null}
          {p.note ? <div className="text-xs text-muted-foreground">Note: {String(p.note)}</div> : null}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note"
          className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-1 text-xs"
        />
        <Button
          tone="primary"
          disabled={busy !== null}
          onClick={() =>
            void run("Approve", () => approve({ id: item.id, note }), () => {
              toast({ title: isEmail ? "Approved – sending" : "Approved – publishing", tone: "success" });
              onDone();
            })
          }
        >
          {isEmail ? "Approve & send" : "Approve & publish"}
        </Button>
        <Button tone="danger" disabled={busy !== null} onClick={() => void run("Reject", () => reject({ id: item.id, note }), onDone)}>
          Reject
        </Button>
      </div>
    </div>
  );
}

function GmailConnect({ companyId, status, onChange }: { companyId: string; status: IntegrationStatus | undefined; onChange: () => void }) {
  const nav = useHostNavigation();
  const begin = usePluginAction(ACTION_KEYS.gmailBeginOAuth);
  const complete = usePluginAction(ACTION_KEYS.gmailCompleteOAuth);
  const disconnect = usePluginAction(ACTION_KEYS.gmailDisconnect);
  const { busy, run, toast } = useRunner();
  const redirectUri = typeof window !== "undefined" ? `${window.location.origin}${nav.resolveHref(`/${PAGE_ROUTE}`)}` : "";
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const oauthError = params.get("error");
    if (!code && !oauthError) return;
    handled.current = true;
    nav.navigate(`/${PAGE_ROUTE}`, { replace: true });
    if (oauthError) {
      toast({ title: "Gmail connection cancelled", body: oauthError, tone: "error" });
      return;
    }
    void run("Connect Gmail", () => complete({ code, state }), () => {
      toast({ title: "Gmail connected", tone: "success" });
      onChange();
    });
  }, [companyId]);

  const connect = () =>
    void run("Connect Gmail", async () => {
      const result = (await begin({ redirectUri })) as { authUrl: string };
      window.location.assign(result.authUrl);
    });

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <b>Gmail</b>
        {status ? <Badge state={status.state} /> : null}
        <span className="text-muted-foreground">{status?.detail}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button tone="primary" disabled={busy !== null} onClick={connect}>
          {status?.state === "CONNECTED" ? "Reconnect Gmail" : "Connect Gmail"}
        </Button>
        {status?.state === "CONNECTED" || status?.state === "EXPIRED" ? (
          <Button tone="danger" disabled={busy !== null} onClick={() => void run("Disconnect", () => disconnect({}), onChange)}>
            Disconnect
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Authorized redirect URI to add to your Google OAuth client: <code className="break-all">{redirectUri}</code>
      </p>
    </div>
  );
}

function IntegrationsTab({ companyId, overview, refresh }: { companyId: string; overview: Overview; refresh: () => void }) {
  const test = usePluginAction(ACTION_KEYS.testConnection);
  const { busy, run, toast } = useRunner();
  const nav = useHostNavigation();
  return (
    <div className="space-y-4">
      <Card title="Gmail">
        <GmailConnect companyId={companyId} status={overview.integrations.find((i) => i.key === "gmail")} onChange={refresh} />
      </Card>
      <Card
        title="All integrations"
        actions={
          <a className="text-xs underline" {...nav.linkProps("/company/settings/instance/plugins")}>
            Configure credentials & permissions
          </a>
        }
      >
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-1">Integration</th>
              <th>Status</th>
              <th>Details</th>
              <th>Missing</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {overview.integrations.map((integration) => (
              <tr key={integration.key} className="border-t border-border align-top">
                <td className="py-2 font-medium">{integration.label}</td>
                <td className="py-2">
                  <Badge state={integration.state} />
                </td>
                <td className="py-2 text-muted-foreground">{integration.detail}</td>
                <td className="py-2 text-xs text-muted-foreground">{integration.missing.join(", ") || "—"}</td>
                <td className="py-2 text-right">
                  {integration.key !== "affiliate" ? (
                    <Button
                      disabled={busy !== null}
                      onClick={() =>
                        void run("Test connection", async () => {
                          const result = (await test({ key: integration.key })) as { ok: boolean; message: string };
                          toast({ title: result.ok ? "Connection OK" : "Connection failed", body: result.message, tone: result.ok ? "success" : "error" });
                          refresh();
                        })
                      }
                    >
                      Test connection
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function AffiliateTab({ companyId }: { companyId: string }) {
  const [period, setPeriod] = useState("7d");
  const report = usePluginData<AffiliateReport>(DATA_KEYS.affiliate, { companyId, period });
  const rows = report.data?.providers ?? [];
  return (
    <Card
      title={report.data ? `Affiliate · ${report.data.range.startDate} → ${report.data.range.endDate}` : "Affiliate"}
      actions={
        <div className="flex flex-wrap gap-1">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPeriod(p.key)}
              className={`rounded px-2 py-1 text-xs ${period === p.key ? "bg-foreground text-background" : "border border-border"}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      }
    >
      {report.loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {report.error ? <p className="text-sm text-red-600">{report.error.message}</p> : null}
      {!report.loading && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No affiliate providers configured. Add one under the plugin settings (report URL + API token from the network's official API).</p>
      ) : null}
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1">Provider</th>
                <th>Status</th>
                <th>Clicks</th>
                <th>Leads</th>
                <th>Sales</th>
                <th>Commission</th>
                <th>Payouts</th>
                <th>Conv. rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-border">
                  <td className="py-2 font-medium">{row.name}</td>
                  <td>
                    <Badge state={row.status} />
                    {row.error ? <div className="text-xs text-red-600">{row.error}</div> : null}
                  </td>
                  <td>
                    {fmtNum(row.current.clicks)} <span className="text-xs text-muted-foreground">{fmtPct(row.change?.clicks)}</span>
                  </td>
                  <td>{fmtNum(row.current.leads)}</td>
                  <td>
                    {fmtNum(row.current.sales)} {row.current.currency}
                  </td>
                  <td>
                    {fmtNum(row.current.commission)} {row.current.currency}{" "}
                    <span className="text-xs text-muted-foreground">{fmtPct(row.change?.commission)}</span>
                  </td>
                  <td>
                    {fmtNum(row.current.payouts)} {row.current.currency}
                  </td>
                  <td>{(row.current.conversionRate * 100).toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function HistoryTab({ companyId }: { companyId: string }) {
  const history = usePluginData<OutboxRow[]>(DATA_KEYS.outbox, { companyId, limit: 100 });
  const retry = usePluginAction(ACTION_KEYS.retry);
  const { busy, run } = useRunner();
  return (
    <Card title="Posts & emails history">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="py-1">Created</th>
            <th>Type</th>
            <th>Status</th>
            <th>Requested by</th>
            <th>Result</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(history.data ?? []).map((row) => (
            <tr key={row.id} className="border-t border-border align-top">
              <td className="py-2 text-xs">{fmtDate(row.createdAt)}</td>
              <td className="py-2">{row.kind === "email_send" ? "Email" : row.channel}</td>
              <td className="py-2">{row.status}</td>
              <td className="py-2">{row.requestedBy ?? "—"}</td>
              <td className="py-2 text-xs">
                {row.result?.url ? (
                  <a className="underline" href={String(row.result.url)} target="_blank" rel="noreferrer">
                    open
                  </a>
                ) : null}
                {row.error ? <span className="text-red-600">{row.error}</span> : null}
              </td>
              <td className="py-2 text-right">
                {row.status === "failed" ? (
                  <Button disabled={busy !== null} onClick={() => void run("Retry", () => retry({ id: row.id }), history.refresh)}>
                    Retry
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function ErrorsTab({ errors }: { errors: ErrorRow[] }) {
  return (
    <Card title="Errors (agent · task · time · error · retry status)">
      {errors.length === 0 ? <p className="text-sm text-muted-foreground">No errors recorded.</p> : null}
      <table className="w-full text-left text-sm">
        <tbody>
          {errors.map((e) => (
            <tr key={e.id} className="border-t border-border align-top">
              <td className="py-2 text-xs">{fmtDate(e.createdAt)}</td>
              <td className="py-2">{e.agentName || "system"}</td>
              <td className="py-2 text-xs">
                {e.source} · {e.task}
              </td>
              <td className="py-2 text-xs text-red-600">{e.error}</td>
              <td className="py-2 text-xs">{e.retryStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

const TABS = ["Overview", "Approvals", "Integrations", "Affiliate", "History", "Errors"] as const;

export function MagnoraPage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? "";
  const hasOAuthReturn = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("state");
  const [tab, setTab] = useState<(typeof TABS)[number]>(hasOAuthReturn ? "Integrations" : "Overview");
  const overview = usePluginData<Overview>(DATA_KEYS.overview, { companyId });

  if (!companyId) return <div className="p-6 text-sm">Select a company.</div>;
  const data = overview.data;
  const pending = data?.pendingApprovals ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Magnora Marketing AI Company</h1>
          <p className="text-sm text-muted-foreground">Integrations, approvals, affiliate revenue and errors.</p>
        </div>
        <Button onClick={overview.refresh}>Refresh</Button>
      </header>
      <nav className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === name ? "border-foreground font-semibold" : "border-transparent text-muted-foreground"}`}
          >
            {name}
            {name === "Approvals" && pending.length > 0 ? ` (${pending.length})` : ""}
          </button>
        ))}
      </nav>
      {overview.error ? <p className="text-sm text-red-600">{overview.error.message}</p> : null}
      {!data ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {data && tab === "Overview" ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Pending approvals">
            <p className="text-3xl font-semibold">{pending.length}</p>
            {pending.length > 0 ? (
              <Button onClick={() => setTab("Approvals")}>Review</Button>
            ) : (
              <p className="text-xs text-muted-foreground">Nothing waiting for you.</p>
            )}
          </Card>
          <Card title="Integrations">
            <ul className="space-y-1 text-sm">
              {data.integrations.map((i) => (
                <li key={i.key} className="flex items-center justify-between gap-2">
                  <span>{i.label}</span>
                  <Badge state={i.state} />
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Activity">
            <ul className="space-y-1 text-sm">
              {Object.entries(data.outboxCounts).map(([status, n]) => (
                <li key={status} className="flex justify-between">
                  <span>{status}</span>
                  <b>{n}</b>
                </li>
              ))}
              {Object.keys(data.outboxCounts).length === 0 ? <li className="text-muted-foreground">No posts or emails yet.</li> : null}
            </ul>
          </Card>
          <Card title="Failures">
            <p className="text-sm">
              Failed items: <b>{data.failedItems.length}</b> · Recent errors: <b>{data.recentErrors.length}</b>
            </p>
            {data.repeatedFailures.map((f) => (
              <p key={f.key} className="text-xs text-red-600">
                Repeated failures: {f.key} ({f.count}×)
              </p>
            ))}
          </Card>
        </div>
      ) : null}
      {data && tab === "Approvals" ? (
        <div className="space-y-3">
          {pending.length === 0 ? <p className="text-sm text-muted-foreground">No pending approvals.</p> : null}
          {pending.map((item) => (
            <ApprovalCard key={item.id} item={item} onDone={overview.refresh} />
          ))}
        </div>
      ) : null}
      {data && tab === "Integrations" ? <IntegrationsTab companyId={companyId} overview={data} refresh={overview.refresh} /> : null}
      {tab === "Affiliate" ? <AffiliateTab companyId={companyId} /> : null}
      {tab === "History" ? <HistoryTab companyId={companyId} /> : null}
      {data && tab === "Errors" ? <ErrorsTab errors={data.recentErrors} /> : null}
    </div>
  );
}

export function MagnoraSidebarLink(_props: PluginSidebarProps) {
  const nav = useHostNavigation();
  const href = nav.resolveHref(`/${PAGE_ROUTE}`);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      {...nav.linkProps(`/${PAGE_ROUTE}`)}
      aria-current={isActive ? "page" : undefined}
      className={`flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors ${
        isActive ? "bg-accent text-foreground" : "text-foreground/80 hover:bg-accent/50 hover:text-foreground"
      }`}
    >
      <span className="flex-1 truncate">Magnora</span>
    </a>
  );
}

export function MagnoraDashboardWidget({ context }: PluginWidgetProps) {
  const nav = useHostNavigation();
  const overview = usePluginData<Overview>(DATA_KEYS.overview, { companyId: context.companyId ?? "" });
  const data = overview.data;
  if (!context.companyId) return null;
  const problems = data?.integrations.filter((i) => i.state === "ERROR" || i.state === "EXPIRED") ?? [];
  return (
    <section className="space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <strong>Magnora</strong>
        <a className="text-xs underline" {...nav.linkProps(`/${PAGE_ROUTE}`)}>
          Open
        </a>
      </div>
      {!data ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <ul className="space-y-1">
          <li>
            Pending approvals: <b>{data.pendingApprovals.length}</b>
          </li>
          <li>
            Failed items: <b>{data.failedItems.length}</b>
          </li>
          <li>
            Integrations connected: <b>{data.integrations.filter((i) => i.state === "CONNECTED").length}</b> / {data.integrations.length}
          </li>
          {problems.map((p) => (
            <li key={p.key} className="text-red-600">
              {p.label}: {p.state}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
