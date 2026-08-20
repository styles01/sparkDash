import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { LlmMetrics, LlmBenchTarget } from "../../api/types";
import { setLlmApiKey, updateLlmPort, updateLlmPorts } from "../../api/client";
import { Panel } from "../ui/Panel";
import { BotIcon, GearIcon, InfoIcon } from "../ui/icons";
import {
  useMetricsHistory,
  useMetricsHistoryTail,
  avgPositive,
} from "../../hooks/metricsStore";
import { BenchmarkDialog } from "./BenchmarkDialog";
import { PrefillBenchDialog } from "./PrefillBenchDialog";
import { LlmDailyChart } from "./LlmDailyChart";
import { parseLlmTargetInput } from "../../shared/llmTarget.js";
import { LlmTrendChart } from "./LlmTrendChart";

interface LlmPanelProps {
  llm: LlmMetrics | null;
  sparkId: string;
  llmPort: number;
  llmPorts?: number[];
  hasApiKey?: boolean;
  onRemovePort?: (port: number) => void;
  llmPortsCount?: number;
  className?: string;
}

const VLLM_METRIC_INFO = {
  kvCache:
    "Fraction of the engine KV cache memory currently in use (0-100%). High values mean little room for new or long contexts and often lead to queuing or preemptions.",
  requests:
    "Run = requests actively generating on the GPU. Wait = accepted but not yet scheduled (capacity or constraints). Growing wait with high KV cache usually means the server is overloaded.",
  ttftP95:
    "95th percentile time-to-first-token from the engine’s request history: how long “slow” requests wait until the first output token. Spikes mean queueing, long prefills, or cold paths—not average decode speed.",
  preempts:
    "Cumulative times the engine paused a running request to free KV cache for others. Rising under load signals memory pressure; zero is normal when the server is comfortable.",
  prefixCache:
    "Lifetime fraction of prefix-cache lookups that hit (hits / queries). Higher means more prompt reuse and less prefill work.",
  e2eP95:
    "95th percentile end-to-end request latency from the engine’s request history: arrival until the request finishes. Includes queue wait, prefill, and decode—not just token generation speed.",
  itlP95:
    "95th percentile inter-token latency (time between successive output tokens) from the engine’s request history. Spikes mean decode stalls or contention; lower is smoother streaming.",
  mtpAccept:
    "Lifetime speculative / MTP acceptance rate (accepted draft tokens / drafted tokens). Higher means speculative decoding is paying off.",
} as const;

const LAUNCHER_BTN =
  "rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text transition-colors hover:border-accent hover:bg-accent-soft";
const REMOTE_STORAGE_KEY = "sparkdash.remote-bench-target";

function readStoredRemote(): { host: string; port: string; tls: boolean } {
  try {
    const raw = localStorage.getItem(REMOTE_STORAGE_KEY);
    if (!raw) return { host: "", port: "443", tls: true };
    const v = JSON.parse(raw) as { host?: string; port?: number; tls?: boolean };
    return {
      host: typeof v.host === "string" ? v.host : "",
      port: v.port != null ? String(v.port) : "443",
      tls: v.tls !== false,
    };
  } catch {
    return { host: "", port: "443", tls: true };
  }
}

/** Decode / prefill / Showcase launchers — shown even when the live probe is empty
 *  (remote loopback-bound servers can still be benched via SSH tunnel). */
function LlmLaunchers({
  sparkId,
  llmPort,
  modelId,
  onDecode,
  onPrefill,
  onRemoteDecode,
  onRemotePrefill,
}: {
  sparkId: string;
  llmPort: number;
  modelId?: string | null;
  onDecode: () => void;
  onPrefill: () => void;
  onRemoteDecode: (target: LlmBenchTarget) => void;
  onRemotePrefill: (target: LlmBenchTarget) => void;
}) {
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [hostDraft, setHostDraft] = useState(() => readStoredRemote().host);
  const [portDraft, setPortDraft] = useState(() => readStoredRemote().port);
  const [tls, setTls] = useState(() => readStoredRemote().tls);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  const persist = (t: LlmBenchTarget) => {
    try {
      localStorage.setItem(REMOTE_STORAGE_KEY, JSON.stringify(t));
    } catch {
      /* ignore */
    }
  };

  const applyHostBlur = () => {
    if (!hostDraft.trim()) return;
    try {
      const p = parseLlmTargetInput(hostDraft, portDraft, tls);
      setHostDraft(p.host);
      setPortDraft(String(p.port));
      setTls(p.tls);
      setRemoteError(null);
    } catch {
      /* leave as typed until Run */
    }
  };

  const launchRemote = (kind: "decode" | "prefill") => {
    try {
      const p = parseLlmTargetInput(hostDraft, portDraft, tls);
      persist(p);
      setHostDraft(p.host);
      setPortDraft(String(p.port));
      setTls(p.tls);
      setRemoteError(null);
      if (kind === "decode") onRemoteDecode(p);
      else onRemotePrefill(p);
    } catch (err: unknown) {
      setRemoteError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="border-t border-border pt-3 space-y-2">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDecode}
          className={`${LAUNCHER_BTN} min-w-0 flex-1`}
          title="Runs against this Spark’s LLM. Remote units use LAN HTTP, or an SSH tunnel to loopback if the server only listens on 127.0.0.1."
        >
          Run decode benchmark
        </button>
        <button
          type="button"
          onClick={() => {
            setRemoteOpen((v) => !v);
            setRemoteError(null);
          }}
          className={`shrink-0 rounded border px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wide transition-colors ${
            remoteOpen
              ? "border-accent bg-accent-soft text-accent"
              : "border-border bg-surface-elevated text-muted hover:border-accent hover:text-accent"
          }`}
          aria-expanded={remoteOpen}
          title="On-demand bench against a typed host (HTTPS Tailscale, LAN IP, …). Not probed until you run."
        >
          Remote
        </button>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onPrefill}
          className={`${LAUNCHER_BTN} min-w-0 flex-1`}
          title="Runs against this Spark’s LLM. Remote units use LAN HTTP, or an SSH tunnel to loopback if the server only listens on 127.0.0.1."
        >
          Run prefill benchmark
        </button>
        <button
          type="button"
          onClick={() => {
            setRemoteOpen((v) => !v);
            setRemoteError(null);
          }}
          className={`shrink-0 rounded border px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wide transition-colors ${
            remoteOpen
              ? "border-accent bg-accent-soft text-accent"
              : "border-border bg-surface-elevated text-muted hover:border-accent hover:text-accent"
          }`}
          aria-expanded={remoteOpen}
          title="On-demand bench against a typed host (HTTPS Tailscale, LAN IP, …). Not probed until you run."
        >
          Remote
        </button>
      </div>
      {remoteOpen && (
        <div className="space-y-2 rounded border border-border bg-surface-elevated p-2">
          <p className="text-[10px] leading-snug text-muted">
            On-demand endpoint. Paste a URL or type host + port — nothing is probed until you run.
          </p>
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-wide text-muted">Host</span>
            <input
              type="text"
              value={hostDraft}
              onChange={(e) => setHostDraft(e.target.value)}
              onBlur={applyHostBlur}
              placeholder="https://name.tailxxxxx.ts.net/v1/models"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5 font-tabular text-xs text-text outline-none focus:border-accent"
            />
          </label>
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-muted">Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                inputMode="numeric"
                value={portDraft}
                onChange={(e) => setPortDraft(e.target.value)}
                className="w-full rounded-md border border-border bg-surface px-2 py-1.5 font-tabular text-xs text-text outline-none focus:border-accent"
              />
            </label>
            <label className="flex shrink-0 items-center gap-1.5 pb-1.5 text-[10px] text-muted">
              <input
                type="checkbox"
                checked={tls}
                onChange={(e) => {
                  const next = e.target.checked;
                  setTls(next);
                  if (next && portDraft === "8888") setPortDraft("443");
                  if (!next && portDraft === "443") setPortDraft("8888");
                }}
                className="h-3.5 w-3.5 accent-[var(--color-accent)]"
              />
              HTTPS
            </label>
          </div>
          {remoteError && <p className="text-[10px] text-danger">{remoteError}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => launchRemote("decode")}
              className={`${LAUNCHER_BTN} flex-1`}
            >
              Decode
            </button>
            <button
              type="button"
              onClick={() => launchRemote("prefill")}
              className={`${LAUNCHER_BTN} flex-1`}
            >
              Prefill
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          const params = new URLSearchParams();
          if (llmPort) params.set("port", String(llmPort));
          if (modelId) params.set("model", modelId);
          const q = params.toString() ? `?${params.toString()}` : "";
          window.open(
            `/showcase/${encodeURIComponent(sparkId)}${q}`,
            "_blank",
            "noopener,noreferrer"
          );
        }}
        className={`${LAUNCHER_BTN} w-full`}
      >
        Showcase
      </button>
    </div>
  );
}

function arrMean(arr: number[]): number | null {
  const valid = arr.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function fmtNum(v: number | undefined | null, digits = 1, suffix = ""): string {
  if (v == null || !Number.isFinite(v)) return "\u2014";
  return `${v.toFixed(digits)}${suffix}`;
}

function fmtInt(v: number | undefined | null): string {
  if (v == null || !Number.isFinite(v)) return "\u2014";
  return Math.round(v).toLocaleString();
}

function pct(v: number | undefined | null, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "\u2014";
  return `${(v * 100).toFixed(digits)}%`;
}

/* ── SYNTHWAVE COLOR SPECTRUM ── */
function tpsColor(tps: number): string {
  if (!Number.isFinite(tps) || tps <= 0) return "var(--color-muted)";
  if (tps >= 40) return "var(--color-success)";
  if (tps >= 15) return "var(--color-accent)";
  return "var(--color-warning)";
}

function mtpColor(rate: number | undefined | null): string {
  if (rate == null) return "var(--color-muted)";
  const p = rate * 100;
  if (p > 70) return "var(--color-success)";
  if (p >= 50) return "var(--color-accent)";
  return "var(--color-warning)";
}

function latencyColor(seconds: number): string {
  if (!Number.isFinite(seconds)) return "var(--color-muted)";
  if (seconds <= 0.5) return "var(--color-success)";
  if (seconds >= 3.0) return "var(--color-danger)";
  return "var(--color-accent)";
}

function fmtUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "\u2014";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/* ── SPARKLINE ── */
function Sparkline({ data, color, height = 24 }: { data: number[]; color: string; height?: number }) {
  const valid = data.filter((v) => Number.isFinite(v));
  if (valid.length < 2) return <div style={{ height }} />;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const range = max - min || 1;
  const w = 100;
  const h = height;
  const n = valid.length;
  const points = valid.map((v, i) => {
    const x = (i / (n - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="llm-sparkline" style={{ width: "100%", height }}>
      <polygon points={`0,${h} ${points} ${w},${h}`} fill={`${color}20`} />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ── ARC GAUGE ── */
function ArcGauge({
  value,
  max,
  label,
  displayValue,
  sub,
  color,
  size = 120,
}: {
  value: number;
  max: number;
  label: string;
  displayValue: string;
  sub?: string;
  color: string;
  size?: number;
}) {
  const r = size * 0.42;
  const strokeWidth = size * 0.075;
  const cx = size / 2;
  const cy = size / 2 + size * 0.04;
  const pctVal = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;

  const polarToCartesian = (angleDeg: number) => {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  };

  const describeArc = (angleStart: number, angleEnd: number) => {
    const start = polarToCartesian(angleStart);
    const end = polarToCartesian(angleEnd);
    const largeArc = angleEnd - angleStart > 180 ? 1 : 0;
    return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
  };

  const startAngle = 135;
  const sweep = 270;
  const trackArc = describeArc(startAngle, startAngle + sweep);
  const currentAngle = startAngle + sweep * pctVal;
  const valueArc = describeArc(startAngle, currentAngle);

  return (
    <div className="llm-arc-gauge" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <path d={trackArc} fill="none" stroke="var(--color-border)" strokeWidth={strokeWidth} strokeLinecap="round" />
        <path d={valueArc} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" style={{ transition: "d 0.4s ease, stroke 0.4s ease" }} />
        <text x={cx} y={cy - size * 0.02} textAnchor="middle" fill="var(--color-text-strong)" fontSize={Math.max(18, size * 0.22)} fontWeight={800} className="font-tabular">
          {displayValue}
        </text>
        {sub && (
          <text x={cx} y={cy + size * 0.14} textAnchor="middle" fill="var(--color-muted)" fontSize={Math.max(9, size * 0.085)} className="font-tabular">
            {sub}
          </text>
        )}
      </svg>
      <div className="llm-arc-gauge-label">{label}</div>
    </div>
  );
}

/* ── FULL CIRCLE GAUGE ── */
function FullCircleGauge({
  value,
  max,
  displayValue,
  sub,
  color,
  size = 120,
}: {
  value: number;
  max: number;
  displayValue: string;
  sub?: string;
  color: string;
  size?: number;
}) {
  const r = size * 0.42;
  const strokeWidth = size * 0.075;
  const cx = size / 2;
  const cy = size / 2;
  const pctVal = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - pctVal);

  return (
    <div className="llm-arc-gauge" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--color-border)" strokeWidth={strokeWidth} />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={dashOffset}
          style={{ transition: "stroke-dashoffset 0.4s ease, stroke 0.4s ease", transform: "rotate(-90deg)", transformOrigin: `${cx}px ${cy}px` }}
        />
        <text x={cx} y={cy - size * 0.02} textAnchor="middle" fill="var(--color-text-strong)" fontSize={Math.max(18, size * 0.22)} fontWeight={800} className="font-tabular">
          {displayValue}
        </text>
        {sub && (
          <text x={cx} y={cy + size * 0.14} textAnchor="middle" fill="var(--color-muted)" fontSize={Math.max(9, size * 0.085)} className="font-tabular">
            {sub}
          </text>
        )}
      </svg>
    </div>
  );
}

/* ── GAUGE CARD ── */
function GaugeCard({
  label,
  children,
  sparkData,
  sparkColor,
}: {
  label: string;
  children: React.ReactNode;
  sparkData?: number[];
  sparkColor?: string;
}) {
  return (
    <div className="llm-gauge-card">
      <div className="llm-gauge-card-label">{label}</div>
      <div className="llm-gauge-card-body">{children}</div>
      {sparkData && sparkColor && <Sparkline data={sparkData} color={sparkColor} height={22} />}
    </div>
  );
}

/* ── STAT SPARK CARD ── */
function StatSparkCard({
  label,
  value,
  sub,
  color,
  sparkData,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  sparkData: number[];
}) {
  return (
    <div className="llm-stat-spark-card">
      <div className="llm-stat-spark-label">{label}</div>
      <div className="llm-stat-spark-value font-tabular" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="llm-stat-spark-sub font-tabular">{sub}</div>}
      <div className="llm-stat-sparkline-wrap"><Sparkline data={sparkData} color={color || "var(--color-success)"} height={24} /></div>
    </div>
  );
}

/* ── HORIZONTAL BAR ── */
function HorizontalBar({
  label,
  value,
  pct: pctVal,
  color,
}: {
  label: string;
  value: string;
  pct: number;
  color: string;
}) {
  return (
    <div className="llm-hbar">
      <div className="llm-hbar-label font-tabular">{label}</div>
      <div className="llm-hbar-track">
        <div className="llm-hbar-fill" style={{ width: `${Math.max(0, Math.min(100, pctVal))}%`, background: color }} />
      </div>
      <div className="llm-hbar-val font-tabular">{value}</div>
    </div>
  );
}

/* ── COMPACT STAT CARD (for advanced grid) ── */
function CompactCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="llm-adv-card">
      <div className="llm-adv-label">{label}</div>
      <div className="llm-adv-val font-tabular" style={color ? { color } : undefined}>{value}</div>
    </div>
  );
}

/* ── ODOMETER CARD (radial gauge for tok/s) ── */
function OdometerCard({
  label,
  value,
  max,
  displayValue,
  color,
  sparkData,
}: {
  label: string;
  value: number;
  max: number;
  displayValue: string;
  color: string;
  sparkData: number[];
}) {
  return (
    <div className="llm-odometer-card">
      <div className="llm-odometer-label">{label}</div>
      <div className="llm-odometer-body">
        <ArcGauge value={value} max={max} label="" displayValue={displayValue} sub="tok/s" color={color} size={100} />
      </div>
      <div className="llm-odometer-spark"><Sparkline data={sparkData} color={color} height={18} /></div>
    </div>
  );
}

function RecipeBadge({ label, value, accent }: { label: string; value: string; accent?: string }) {
  if (!value || value === "\u2014") return null;
  return (
    <span className={`recipe-badge${accent ? ` recipe-badge--${accent}` : ""}`}>
      <span className="recipe-badge-label">{label}</span>
      <span className="recipe-badge-value">{value}</span>
    </span>
  );
}

/* ── CONFIG / PROVENANCE SECTION (top of panel) ── */
function ConfigProvenanceSection({
  llm,
}: {
  llm: LlmMetrics | null;
}) {
  const info = llm?.recipeInfo;
  const metadata = llm?.recipeMetadata;
  const hasInfo = info != null;
  const hasMeta = metadata != null && (metadata.model != null || metadata.supportedParameters.length > 0);
  if (!hasInfo && !hasMeta) return null;

  const params = metadata?.supportedParameters ?? [];
  const specDecodeMethod = info?.specDecodeMethod ?? null;
  const specDecodeLabel = specDecodeMethod
    ? specDecodeMethod.replace(/\s*k=\d+$/, "").trim()
    : llm?.backend === "ds4"
      ? "DSpark"
      : llm?.backend === "sglang"
        ? "DFlash"
        : "MTP";

  const paramStats: Record<string, { label: string; value: string; accent?: string } | null> = {};
  if (llm) {
    for (const p of params) {
      // tools / tool_choice → tool call parser (show "parser ready" type info)
      if (p === "tools" || p === "tool_choice") {
        // No numeric stat, but we can indicate it is parsed
        paramStats[p] = null;
      }
      // stream → streaming status
      if (p === "stream") {
        paramStats[p] = { label: "streaming", value: "live", accent: "success" };
      }
      // reasoning_effort → show the reasoning effort level if available
      if (p === "reasoning_effort") {
        // DS4 supports reasoning — show spec decode method as proxy
        paramStats[p] = info?.specDecodeMethod
          ? { label: "reasoning", value: info.specDecodeMethod, accent: "accent" }
          : null;
      }
    }
  }

  // Stats that map to recipe config fields with live metric counterparts
  const liveStats: { label: string; value: string; sub?: string; accent?: string }[] = [];
  if (llm) {
    // Spec decode acceptance → relates to specDecodeMethod
    if (llm.dsparkAcceptRatio != null) {
      liveStats.push({ label: `${specDecodeLabel} accept`, value: pct(llm.dsparkAcceptRatio, 1), accent: llm.dsparkAcceptRatio > 0.7 ? "success" : llm.dsparkAcceptRatio >= 0.5 ? "warning" : "danger" });
    } else if (info?.acceptRatio != null) {
      liveStats.push({ label: "Accept ratio", value: acceptPct, accent: acceptAccent });
    }
    // Banks live/total → relates to maxLanes
    if (llm.banksLive != null) {
      liveStats.push({ label: "Banks", value: `${fmtInt(llm.banksLive)}/${fmtInt(llm.banksTotal)}`, accent: llm.banksLive > 0 ? "success" : undefined });
    }
    // Prefill cached/computed → relates to prefixCaching
    if (llm.prefillCached != null || llm.prefillComputed != null) {
      const cached = llm.prefillCached ?? 0;
      const computed = llm.prefillComputed ?? 0;
      const total = cached + computed;
      const ratio = total > 0 ? cached / total : 0;
      liveStats.push({ label: "Prefill cache", value: pct(ratio, 0), sub: `${fmtInt(cached)} cached`, accent: ratio > 0.5 ? "success" : "warning" });
    }
    // Warm records → relates to prefixCaching
    if (llm.warmRecords != null) {
      liveStats.push({ label: "Warm records", value: fmtInt(llm.warmRecords), accent: "accent" });
    }
    // Spec drafts/hits → relates to specDecodeMethod
    if (llm.specDrafts != null && llm.specHits != null) {
      liveStats.push({ label: "Spec drafts", value: fmtInt(llm.specDrafts), sub: `${fmtInt(llm.specHits)} hits`, accent: "accent" });
    }
    // Total tokens decoded
    if (llm.totalTokensDecoded != null) {
      liveStats.push({ label: "Tokens decoded", value: fmtInt(llm.totalTokensDecoded), accent: "accent" });
    }
    // Uptime
    if (llm.ds4Uptime != null) {
      liveStats.push({ label: "Uptime", value: fmtUptime(llm.ds4Uptime) });
    }
  }

  return (
    <div className="llm-config-section">
      {/* Provenance / Accreditation */}
      {(author || authorName || engineType || containerImage) && (
        <div className="llm-provenance-row">
          {engineType && <span className="recipe-info-engine-type">{engineType}</span>}
          {modelName && <span className="llm-config-model">{modelName}</span>}
          {(author || authorName) && (
            <span className="llm-provenance-author">
              <span className="recipe-info-author-label">Built by</span>{" "}
              <span className="recipe-info-author">{author || "\u2014"}</span>
              {authorName && <span className="recipe-info-author-name"> ({authorName})</span>}
            </span>
          )}
          {containerImage && (
            <span className="llm-provenance-container">
              <span className="recipe-info-sep">·</span>
              <span className="recipe-info-container" title={containerImage}>{containerImage}</span>
            </span>
          )}
        </div>
      )}

      {/* Config badges */}
      <div className="recipe-info-badges">
        {engineType && <RecipeBadge label="Engine" value={engineType} />}
        {modelName && <RecipeBadge label="Model" value={modelName} accent="accent" />}
        {(info?.contextLength ?? metadata?.contextLength) != null && (
          <RecipeBadge label="Ctx" value={(info?.contextLength ?? metadata?.contextLength)! >= 1024 ? `${Math.round((info?.contextLength ?? metadata?.contextLength)! / 1024)}K` : String((info?.contextLength ?? metadata?.contextLength)!)} />
        )}
        {info?.maxLanes != null && <RecipeBadge label="Lanes" value={String(info.maxLanes)} accent="accent" />}
        {specDecodeMethod && <RecipeBadge label="Spec" value={specDecodeMethod} accent="success" />}
        {info?.quantization && <RecipeBadge label="Quant" value={info.quantization} accent="warning" />}
        {info?.prefixCaching != null && <RecipeBadge label="Prefix" value={info.prefixCaching ? "ON" : "OFF"} accent={info.prefixCaching ? "success" : "danger"} />}
        {info?.kvCacheDtype && <RecipeBadge label="KV dtype" value={info.kvCacheDtype} />}
        {info?.gmu != null && <RecipeBadge label="GMU" value={pct(info.gmu, 0)} />}
      </div>

      {/* Params (collapsible) */}
      {params.length > 0 && (
        <div className="llm-config-params-wrap">
          <button
            type="button"
            className="llm-config-params-toggle"
            onClick={() => setParamsExpanded(!paramsExpanded)}
          >
            <span className="llm-config-params-toggle-icon">{paramsExpanded ? "\u25BC" : "\u25B8"}</span>
            Params ({params.length})
          </button>
          {paramsExpanded && (
            <div className="recipe-merged-params" style={{ marginTop: "6px" }}>
              {params.map((p) => (
                <span key={p} className="recipe-param-badge">
                  <span className="recipe-param-badge-name">{p}</span>
                  {paramStats[p] && (
                    <span className={`recipe-param-badge-stat${paramStats[p]!.accent ? ` recipe-param-badge-stat--${paramStats[p]!.accent}` : ""}`}>
                      {paramStats[p]!.value}
                    </span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function LlmPanel({
  llm,
  sparkId,
  llmPort,
  llmPorts,
  hasApiKey = false,
  onRemovePort,
  className,
}: LlmPanelProps) {
  const genHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.tps`);
  const prefillHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.prefill`);
  const cachedPrefillHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.prefillCached`);
  const uncachedPrefillHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.prefillUncached`);

  // Full series (~1 h) for running averages over busy (>0) samples only.
  const genFull = useMetricsHistory(sparkId, `llm:${llmPort}.tps`);
  const prefillFull = useMetricsHistory(sparkId, `llm:${llmPort}.prefill`);
  const cachedFull = useMetricsHistory(sparkId, `llm:${llmPort}.prefillCached`);
  const uncachedFull = useMetricsHistory(sparkId, `llm:${llmPort}.prefillUncached`);
  const genAvg = useMemo(() => avgPositive(genFull), [genFull]);
  const prefillAvg = useMemo(() => avgPositive(prefillFull), [prefillFull]);
  const cachedPrefillAvg = useMemo(() => avgPositive(cachedFull), [cachedFull]);
  const uncachedPrefillAvg = useMemo(() => avgPositive(uncachedFull), [uncachedFull]);
  const [showSettings, setShowSettings] = useState(false);
  const [portDraft, setPortDraft] = useState(String(llmPort));
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [benchOpen, setBenchOpen] = useState(false);
  const [prefillBenchOpen, setPrefillBenchOpen] = useState(false);
  const [remoteTarget, setRemoteTarget] = useState<LlmBenchTarget | null>(null);
  const openRemoteDecode = useCallback((target: LlmBenchTarget) => {
    setRemoteTarget(target);
    setBenchOpen(true);
  }, []);
  const openRemotePrefill = useCallback((target: LlmBenchTarget) => {
    setRemoteTarget(target);
    setPrefillBenchOpen(true);
  }, []);
  const openLocalDecode = useCallback(() => {
    setRemoteTarget(null);
    setBenchOpen(true);
  }, []);
  const openLocalPrefill = useCallback(() => {
    setRemoteTarget(null);
    setPrefillBenchOpen(true);
  }, []);
  /** Which vLLM metric info tip is open (kvCache | requests | ttftP95 | preempts). */
  const [metricInfoId, setMetricInfoId] = useState<string | null>(null);
  const engineInfoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sticky refs
  const stickyGenTps = useRef<number>(0);
  const stickyPrefillTps = useRef<number>(0);
  const stickyAggTps = useRef<number>(0);
  const stickySingleTps = useRef<number>(0);
  const stickyPeak = useRef<number>(0);

  const generationTps = llm?.generationTps ?? 0;
  const prefillTps = llm?.prefillTps ?? 0;
  const showPrefillSplit = llm?.cachedPrefillTps != null || llm?.uncachedPrefillTps != null;
  const cachedPrefillTps = llm?.cachedPrefillTps ?? 0;
  const uncachedPrefillTps = llm?.uncachedPrefillTps ?? 0;
  const available = llm?.available ?? false;

  useEffect(() => {
    if (!llm || !available) return;
    const gen = llm.generationTps ?? 0;
    const pre = llm.prefillTps ?? 0;
    const agg = gen + pre;
    const single = llm.perStreamAvg ?? llm.rollingAvgTpsPerSlot ?? 0;
    const peak = llm.peakAggregateTps ?? 0;
    if (gen > 0) stickyGenTps.current = gen;
    if (pre > 0) stickyPrefillTps.current = pre;
    if (agg > 0) stickyAggTps.current = agg;
    if (single > 0) stickySingleTps.current = single;
    if (peak > 0) stickyPeak.current = peak;
  }, [llm, available]);

  const displayGenTps = (llm?.generationTps ?? 0) > 0 ? (llm!.generationTps ?? 0) : stickyGenTps.current;
  const displayPrefillTps = (llm?.prefillTps ?? 0) > 0 ? (llm!.prefillTps ?? 0) : stickyPrefillTps.current;
  const displayAggTps = displayGenTps + displayPrefillTps;
  const liveSingleTps = llm?.perStreamAvg ?? llm?.rollingAvgTpsPerSlot ?? 0;
  const displaySingleTps = liveSingleTps > 0 ? liveSingleTps : stickySingleTps.current;
  const displayPeak = (llm?.peakAggregateTps ?? 0) > 0 ? (llm!.peakAggregateTps ?? 0) : stickyPeak.current;

  const isThinking = available &&
    ((llm?.requestsRunning ?? llm?.slotsActive ?? 0) > 0) &&
    (llm?.generationTps ?? 0) < 1;
  const isPrefilling = available &&
    ((llm?.requestsRunning ?? llm?.slotsActive ?? 0) > 0) &&
    (llm?.generationTps ?? 0) < 1 &&
    ((llm?.prefillTps ?? 0) > 0 || (llm?.activeContext ?? 0) > 0);

  useEffect(() => {
    if (!showSettings) {
      setPortDraft(String(llmPort));
      setApiKeyDraft("");
      setClearApiKey(false);
    }
  }, [llmPort, showSettings]);

  useEffect(() => {
    if (!llm || !available) return;
    const gen = llm.generationTps ?? 0;
    const pre = llm.prefillTps ?? 0;
    const ttft = llm.ttft ?? NaN;
    const e2e = llm.e2eLatency ?? NaN;
    const specRate = llm.backend === "ds4"
      ? (llm.dsparkAcceptRatio ?? llm.mtpAcceptanceRate ?? NaN)
      : (llm.mtpAcceptanceRate ?? llm.dsparkAcceptRatio ?? NaN);
    setHistory((prev) => ({
      genTps: pushSample(prev.genTps, gen),
      prefillTps: pushSample(prev.prefillTps, pre),
      ttft: pushSample(prev.ttft, ttft),
      e2e: pushSample(prev.e2e, e2e),
      specAccept: pushSample(prev.specAccept, specRate),
    }));
  }, [llm, available]);

  const parsedPort = (() => {
    const n = parseInt(portDraft, 10);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
    return n;
  })();

  const portDirty = parsedPort !== null && parsedPort !== llmPort;
  const portInvalid = portDraft.trim() !== "" && parsedPort === null;
  const apiKeyDirty = apiKeyDraft.trim() !== "" || clearApiKey;
  const settingsDirty = portDirty || apiKeyDirty;

  const handleSaveSettings = async () => {
    if (parsedPort === null) {
      setSaveError("Port must be an integer 1\u201365535");
      return;
    }
    if (!settingsDirty) {
      setShowSettings(false);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      if (portDirty) {
        const currentPorts = Array.isArray(llmPorts) && llmPorts.length > 0 ? llmPorts : [llmPort];
        if (currentPorts.includes(parsedPort) && parsedPort !== llmPort) {
          setSaveError(`Port ${parsedPort} is already configured`);
          setSaving(false);
          return;
        }
        if (currentPorts.length > 1) {
          const next = currentPorts.map((p) => (p === llmPort ? parsedPort : p));
          await updateLlmPorts(sparkId, next);
        } else {
          await updateLlmPort(sparkId, parsedPort);
        }
      }
      const keyPort = parsedPort;
      if (clearApiKey) {
        await setLlmApiKey(sparkId, keyPort, "");
      } else if (apiKeyDraft.trim() !== "") {
        await setLlmApiKey(sparkId, keyPort, apiKeyDraft.trim());
      }
      setApiKeyDraft("");
      setClearApiKey(false);
      setShowSettings(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save LLM settings");
    } finally {
      setSaving(false);
    }
  };

  const runningSlots = llm?.runningSlots ?? llm?.slotsActive ?? 0;
  const waitingSlots = llm?.waitingSlots ?? 0;
  const kvUsage = llm?.kvCacheUsage ?? null;
  const genTps = llm?.generationTps ?? 0;
  const mtpRate = llm?.mtpAcceptanceRate ?? null;
  const prefixHit = llm?.prefixCacheHitRate ?? null;
  const slots: SlotTelemetry[] = llm?.slots ?? [];
  const genSeries: ChartSeries = { label: "decode", color: "var(--color-success)", data: history.genTps, area: true, yAxis: "left" };
  const preSeries: ChartSeries = { label: "prefill", color: "var(--color-accent)", data: history.prefillTps, area: false, yAxis: "right" };
  const ttftSeries: ChartSeries = { label: "TTFT", color: "var(--color-danger)", data: history.ttft, area: false };
  const e2eSeries: ChartSeries = { label: "E2E", color: "var(--color-info)", data: history.e2e, area: false };

  const currentSpecAccept = llm?.backend === "ds4"
    ? (llm.dsparkAcceptRatio ?? llm.mtpAcceptanceRate ?? null)
    : (llm.mtpAcceptanceRate ?? llm.dsparkAcceptRatio ?? null);
  const avgSpecAccept = arrMean(history.specAccept);
  const mtpRate = currentSpecAccept;
  const mtpAccepted = llm?.mtpAcceptedTokens ?? null;
  const mtpDrafted = llm?.mtpDraftedTokens ?? null;
  const specHits = llm?.specHits ?? null;
  const specDrafts = llm?.specDrafts ?? null;
  const perPos: number[] = llm?.perPositionAcceptance ?? [];
  const kvUsage = llm?.kvCacheUsage ?? null;
  const banksLive = llm?.banksLive ?? null;
  const banksTotal = llm?.banksTotal ?? null;
  const prefixHit = llm?.prefixCacheHitRate ?? null;
  const slots = llm?.slots ?? [];
  const runningSlots = llm?.runningSlots ?? llm?.slotsActive ?? 0;
  const waitingSlots = llm?.waitingSlots ?? 0;

  const specDecodeMethod = llm?.recipeInfo?.specDecodeMethod ?? null;
  const specDecodeLabel = specDecodeMethod
    ? specDecodeMethod.replace(/\s*k=\d+$/, "").trim()
    : llm?.backend === "ds4"
      ? "DSpark"
      : llm?.backend === "sglang"
        ? "DFlash"
        : "MTP";

  const kvColor = kvUsage != null && kvUsage >= 0.8 ? "var(--color-danger)" : kvUsage != null && kvUsage >= 0.5 ? "var(--color-accent)" : "var(--color-success)";
  const lanesColor = (banksLive ?? 0) > 0 ? "var(--color-success)" : "var(--color-muted)";

  const sparkGen = history.genTps;
  const sparkAgg = history.genTps.map((g, i) => g + (history.prefillTps[i] ?? 0));
  const sparkAvg = history.genTps.map((_, i) => llm?.rollingAvgTpsPerSlot ?? history.genTps[i] ?? 0);
  const sparkSingle = history.genTps.map((_, i) => llm?.perStreamAvg ?? llm?.rollingAvgTpsPerSlot ?? history.genTps[i] ?? 0);
  const sparkPeak = history.genTps.map((_, i) => llm?.peakAggregateTps ?? displayPeak);

  const reasoningEffort = llm?.reasoningEffort ?? null;
  const effortIndex = reasoningEffort === "high" ? 3 : reasoningEffort === "medium" ? 2 : reasoningEffort === "low" ? 1 : 0;

  /* ── Derive spec decode per-position data ── */
  // Per-position acceptance bars (Pos 0, Pos 1, Pos 2, ...) — same as vLLM had.
  // For vLLM: perPositionAcceptance is populated from spec_decode_num_accepted_tokens_per_pos_total.
  // For DS4 (DSpark k=2): no per-position breakdown in /metrics, so synthesize from
  // overall acceptance ratio using geometric decay: pos 0 = 1.0 (base), pos 1 = r, pos 2 = r^2, etc.
  const specDecodeBars: { label: string; value: number }[] = (() => {
    // vLLM path: use actual per-position data
    if (perPos.length > 0) {
      return perPos.map((p, i) => ({ label: `Pos ${i}`, value: p }));
    }
    // DS4 path: synthesize per-position from overall acceptance ratio
    // Determine k (number of draft positions) from spec decode method or default to 2
    const specMethod = llm?.recipeInfo?.specDecodeMethod ?? "";
    const kMatch = specMethod.match(/k=(\d+)/);
    const k = kMatch ? parseInt(kMatch[1]) : 2; // default k=2 for DSpark, no cap (supports up to 15+)
    // Get overall acceptance ratio
    let overallRate: number | null = null;
    if (specHits != null && specDrafts != null && specDrafts > 0) {
      overallRate = specHits / specDrafts;
    } else if (currentSpecAccept != null) {
      overallRate = currentSpecAccept;
    } else if (llm?.dsparkAcceptRatio != null) {
      overallRate = llm.dsparkAcceptRatio;
    }
    if (overallRate != null && overallRate > 0) {
      // Position 0 is the base token (always accepted = 1.0)
      // Position N has acceptance = overallRate^N (geometric decay)
      const bars: { label: string; value: number }[] = [];
      for (let i = 0; i <= k; i++) {
        const rate = i === 0 ? 1.0 : Math.pow(overallRate, i);
        bars.push({ label: `Pos ${i}`, value: Math.round(rate * 10000) / 10000 });
      }
      return bars;
    }
    // No data at all — show placeholder bars at 0
    return [{ label: "Pos 0", value: 0 }, { label: "Pos 1", value: 0 }];
  })();

  return (
    <Panel
      title="LLM"
      accent={available}
      icon={<BotIcon />}
      className={`panel-llm ${className}`}
      actions={
        <div className="flex items-center gap-1.5">
          {onRemovePort && (
            <button type="button" title={`Remove port ${llmPort}`} onClick={() => onRemovePort(llmPort)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-danger transition-colors hover:bg-danger/10">
              <span aria-hidden>{"\u00D7"}</span><span>Remove</span>
            </button>
          )}
          <button
            type="button"
            title={showSettings ? "Done" : "LLM settings"}
            onClick={() => {
              if (showSettings) {
                setPortDraft(String(llmPort));
                setApiKeyDraft("");
                setClearApiKey(false);
                setSaveError(null);
              }
              setShowSettings(!showSettings);
            }}
            disabled={saving}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-hover disabled:opacity-50 ${showSettings ? "bg-surface-elevated text-text" : ""}`}
          >
            <GearIcon />
            <span>{showSettings ? "Done" : "Settings"}</span>
          </button>
        </div>
      }
    >
      {showSettings ? (
        <div className="space-y-3">
          <p className="text-[10px] text-muted">
            HTTP port of the LLM server on this Spark (vLLM / llama.cpp / sglang / ds4 / EXL3 / OpenAI-compatible gateway).
          </p>
          <label className="block space-y-1">
            <span className="text-xs text-muted">Port</span>
            <input type="number" min={1} max={65535} inputMode="numeric" value={portDraft} onChange={(e) => { setPortDraft(e.target.value); setSaveError(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handleSaveSettings(); } }} className="w-full rounded-md border border-border bg-surface-elevated px-3 py-1.5 font-tabular text-sm text-text outline-none focus:border-accent" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted">API key (optional)</span>
            <input type="password" autoComplete="new-password" spellCheck={false} value={apiKeyDraft} disabled={clearApiKey} placeholder={hasApiKey && !clearApiKey ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (saved)" : "Bearer token if required"} onChange={(e) => { setApiKeyDraft(e.target.value); setClearApiKey(false); setSaveError(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handleSaveSettings(); } }} className="w-full rounded-md border border-border bg-surface-elevated px-3 py-1.5 font-mono text-sm text-text outline-none focus:border-accent disabled:opacity-50" />
          </label>
          {hasApiKey && (
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted">
              <input type="checkbox" checked={clearApiKey} onChange={(e) => { setClearApiKey(e.target.checked); if (e.target.checked) setApiKeyDraft(""); setSaveError(null); }} className="h-3.5 w-3.5 accent-[var(--color-accent)]" />
              Clear saved API key
            </label>
          )}
          {portInvalid && <p className="text-[10px] text-danger">Enter an integer between 1 and 65535</p>}
          {saveError && <p className="text-[10px] text-danger">{saveError}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => { setPortDraft(String(llmPort)); setApiKeyDraft(""); setClearApiKey(false); setSaveError(null); setShowSettings(false); }} disabled={saving} className="rounded border border-border px-2 py-1 text-[10px] text-muted hover:bg-surface-hover disabled:opacity-50">Cancel</button>
            <button type="button" onClick={() => void handleSaveSettings()} disabled={saving || portInvalid || !settingsDirty} className="rounded bg-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-accent-hover disabled:opacity-50">{saving ? "Saving\u2026" : "Save"}</button>
          </div>
        </div>
      ) : !available ? (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 py-1">
            {llm?.posture ? (
              <span className={`llm-posture llm-posture--${llm.posture.level}`}><span className="llm-posture__dot" />{llm.posture.label}</span>
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-muted" />
            )}
            <p className="text-xs text-muted">{llm?.posture?.auth === "protected" ? `${llm.posture.label} on :${llmPort}` : `No model loaded on :${llmPort}`}</p>
          </div>
          <LlmLaunchers
            sparkId={sparkId}
            llmPort={llmPort}
            modelId={llm?.modelId}
            onDecode={openLocalDecode}
            onPrefill={openLocalPrefill}
            onRemoteDecode={openRemoteDecode}
            onRemotePrefill={openRemotePrefill}
          />
          <LlmDailyChart sparkId={sparkId} llmPort={llmPort} />
        </div>
      ) : (
        <div className="llm-dashboard">
          {/* ═══ ROW 1 — HEADER BAR ═══ */}
          <div className="llm-header-bar">
            <span className="llm-badge"><span className="h-1.5 w-1.5 rounded-full bg-accent" />{llm?.backend ?? "\u2014"}</span>
            {llm?.posture && <span className={`llm-posture llm-posture--${llm.posture.level}`}><span className="llm-posture__dot" />{llm.posture.label}</span>}
            {llm?.modelId && <span className="min-w-0 flex-1 truncate text-[11px] text-text" title={llm.modelId}>{llm.modelId}</span>}
            <span className="shrink-0 font-tabular text-[10px] text-muted">:{llmPort}</span>
            {(() => {
              const active = isThinking || isPrefilling;
              const label = isPrefilling ? "PREFILLING" : "ACTIVELY THINKING";
              return (
                <span className={`llm-thinking-badge ${active ? "llm-thinking-badge--active" : "llm-thinking-badge--idle"} ${isPrefilling ? "llm-thinking-badge--prefill" : ""}`}>
                  <span className="llm-thinking-pulse" />
                  <span className="llm-thinking-label">{label}</span>
                </span>
              );
            })()}
          </div>

          {/* ═══ ROW 2 — CONFIG / PROVENANCE SECTION (moved to top) ═══ */}
          <ConfigProvenanceSection llm={llm ?? null} />

          {/* ═══ ROW 3 — HERO STATS (4 cards: 2 spark + 2 odometer) ═══ */}
          <div className="llm-hero-grid">
            <StatSparkCard label="Decode tok/s" value={fmtNum(displayGenTps, 1)} color={tpsColor(displayGenTps)} sparkData={sparkGen} />
            <StatSparkCard label="Aggregate tok/s" value={fmtNum(displayGenTps, 1)} sub={`prefill ${fmtNum(displayPrefillTps, 1)}`} color={tpsColor(displayGenTps)} sparkData={sparkGen} />
            <OdometerCard label="Avg tok/s" value={displaySingleTps} max={100} displayValue={fmtNum(displaySingleTps, 1)} color={tpsColor(displaySingleTps)} sparkData={sparkSingle} />
            <OdometerCard label="Peak tok/s" value={displayPeak} max={100} displayValue={fmtNum(displayPeak, 1)} color={tpsColor(displayPeak)} sparkData={sparkPeak} />
          </div>

          {/* ═══ ROW 4 — GAUGE ARCS ═══ */}
          <div className="llm-gauge-row">
            {mtpAccepted != null && mtpDrafted != null && mtpDrafted > 0 && (
              <GaugeCard label="Spec Accept">
                <ArcGauge value={mtpAccepted} max={mtpDrafted} label="" displayValue={fmtInt(mtpAccepted)} sub={`of ${fmtInt(mtpDrafted)}`} color={mtpColor(mtpAccepted / mtpDrafted)} size={90} />
              </GaugeCard>
            )}
            {currentSpecAccept != null && (
              <GaugeCard label="Spec Accept %" sparkData={history.specAccept} sparkColor={mtpColor(currentSpecAccept)}>
                <FullCircleGauge value={currentSpecAccept} max={1} displayValue={pct(currentSpecAccept, 0)} color={mtpColor(currentSpecAccept)} size={120} />
              </GaugeCard>
            )}
            {banksTotal != null && (
              <GaugeCard label="Active Lanes">
                <ArcGauge value={banksLive ?? 0} max={banksTotal} label="" displayValue={`${fmtInt(banksLive)}/${fmtInt(banksTotal)}`} color={lanesColor} size={100} />
              </GaugeCard>
            )}
            {kvUsage != null && (
              <GaugeCard label="KV Cache">
                <ArcGauge value={kvUsage} max={1} label="" displayValue={pct(kvUsage, 1)} sub={llm?.contextUsedBytes != null ? `${(llm.contextUsedBytes / 1e9).toFixed(1)}GB` : undefined} color={kvColor} size={100} />
              </GaugeCard>
            )}
            {reasoningEffort != null && effortIndex > 0 && (
              <GaugeCard label="Reasoning">
                <ArcGauge value={effortIndex} max={4} label="" displayValue={reasoningEffort} color="var(--color-accent)" size={90} />
              </GaugeCard>
            )}
          </div>

          {/* ═══ ROW 5 — CHART ROW: Throughput + Latency + Spec Decode (ALL THREE ALWAYS VISIBLE) ═══ */}
          <div className="llm-chart-row">
            <div className="llm-chart-block">
              <div className="llm-chart-title">Throughput <span className="llm-chart-sub">decode + prefill · last 60</span></div>
              <TelemetryChart series={[genSeries, preSeries]} maxPoints={HISTORY} height={110} yUnit="" yUnitRight="" yMin={0} yMax={100} yMaxRight={2000} />
            </div>
            <div className="llm-chart-block">
              <div className="llm-chart-title">Latency <span className="llm-chart-sub">TTFT + E2E · seconds</span></div>
              <TelemetryChart series={[ttftSeries, e2eSeries]} maxPoints={HISTORY} height={110} yUnit="s" yMin={0} />
            </div>
            <div className="llm-chart-block llm-specdecode-block">
              <div className="llm-chart-title">Speculative Decode <span className="llm-chart-sub">{specDecodeLabel} · acceptance</span></div>
              <div className={specDecodeBars.length > 6 ? "llm-hbar-grid llm-hbar-grid-multi" : "llm-hbar-grid"}>
                {specDecodeBars.map((bar, i) => (
                  <HorizontalBar key={i} label={bar.label} value={pct(bar.value, 0)} pct={bar.value * 100} color={mtpColor(bar.value)} />
                ))}
              </div>
              {specHits != null && specDrafts != null && (
                <div className="llm-specdecode-counters font-tabular">
                  <span className="text-muted text-[10px]">{fmtInt(specHits)} hits / {fmtInt(specDrafts)} drafts</span>
                </div>
              )}
              {perPos.length === 0 && (
                <div className="llm-specdecode-note">
                  <span className="text-muted text-[9px]">⚠️ {llm?.backend === "ds4" ? "DS4 reports aggregate acceptance only — per-position bars are estimated from overall ratio (geometric decay)" : "No per-position breakdown available — bars estimated from overall ratio"}</span>
                </div>
              )}
            </div>
          </div>

          {/* ═══ ROW 6 — ADVANCED STATS (30+ compact cards) ═══ */}
          <div className="llm-advanced-grid">
            {/* Latency metrics */}
            <CompactCard label="TTFT" value={fmtNum(llm?.ttft, 3, "s")} color={latencyColor(llm?.ttft ?? NaN)} />
            <CompactCard label="E2E" value={fmtNum(llm?.e2eLatency, 2, "s")} color={latencyColor(llm?.e2eLatency ?? NaN)} />
            <CompactCard label="ITL p95" value={fmtNum(llm?.itlP95Seconds, 3, "s")} />
            <CompactCard label="TTFT p95" value={fmtNum(llm?.ttftP95Seconds, 3, "s")} />
            <CompactCard label="E2E p95" value={fmtNum(llm?.e2eP95Seconds, 2, "s")} />
            {/* Slot metrics */}
            <CompactCard label="Running" value={fmtInt(runningSlots)} color={runningSlots > 0 ? "var(--color-success)" : "var(--color-muted)"} />
            <CompactCard label="Waiting" value={fmtInt(waitingSlots)} color={waitingSlots > 0 ? "var(--color-accent)" : "var(--color-muted)"} />
            <CompactCard label="Preempts" value={fmtInt(llm?.preemptionsTotal)} />
            <CompactCard label="Slots Active" value={fmtInt(llm?.slotsActive)} />
            <CompactCard label="Slots Total" value={fmtInt(llm?.slotsTotal)} />
            {/* Token metrics */}
            <CompactCard label="Total Tokens" value={fmtInt(llm?.totalTokensDecoded ?? llm?.totalOutputTokens)} />
            <CompactCard label="Tokens Decoded" value={fmtInt(llm?.totalTokensDecoded)} />
            <CompactCard label="Tokens Output" value={fmtInt(llm?.totalOutputTokens)} />
            <CompactCard label="Prefill Cached" value={fmtInt(llm?.prefillCached)} />
            <CompactCard label="Prefill Computed" value={fmtInt(llm?.prefillComputed)} />
            {/* Spec decode metrics */}
            <CompactCard label="Spec Accept" value={pct(avgSpecAccept, 0)} color={mtpColor(avgSpecAccept)} />
            <CompactCard label="Spec Hits" value={fmtInt(specHits)} />
            <CompactCard label="Spec Drafts" value={fmtInt(specDrafts)} />
            <CompactCard label="MTP Accepted" value={fmtInt(mtpAccepted)} />
            <CompactCard label="MTP Drafted" value={fmtInt(mtpDrafted)} />
            <CompactCard label="DSpark Ratio" value={pct(llm?.dsparkAcceptRatio, 1)} color={mtpColor(llm?.dsparkAcceptRatio)} />
            <CompactCard label="MTP Rate" value={pct(llm?.mtpAcceptanceRate, 1)} color={mtpColor(llm?.mtpAcceptanceRate)} />
            {/* Throughput metrics */}
            <CompactCard label="Decode tok/s" value={fmtNum(displayGenTps, 1)} color={tpsColor(displayGenTps)} />
            <CompactCard label="Prefill tok/s" value={fmtNum(displayPrefillTps, 1)} color={tpsColor(displayPrefillTps)} />
            <CompactCard label="Agg tok/s" value={fmtNum(displayAggTps, 1)} color={tpsColor(displayAggTps)} />
            <CompactCard label="Avg tok/s" value={fmtNum(displaySingleTps, 1)} color={tpsColor(displaySingleTps)} />
            <CompactCard label="Peak tok/s" value={fmtNum(displayPeak, 1)} color={tpsColor(displayPeak)} />
            <CompactCard label="Per-stream Hi" value={fmtNum(llm?.perStreamHigh, 1)} />
            <CompactCard label="Per-stream Lo" value={fmtNum(llm?.perStreamLow, 1)} />
            {/* Cache / memory metrics */}
            <CompactCard label="Prefix Hit" value={pct(prefixHit, 0)} color={prefixHit != null ? "var(--color-success)" : "var(--color-muted)"} />
            <CompactCard label="KV Cache" value={pct(kvUsage, 1)} color={kvColor} />
            <CompactCard label="Banks Live" value={fmtInt(banksLive)} color={(banksLive ?? 0) > 0 ? "var(--color-success)" : "var(--color-muted)"} />
            <CompactCard label="Banks Total" value={fmtInt(banksTotal)} />
            <CompactCard label="KV Pages" value={fmtInt(llm?.kvPagesResident)} />
            <CompactCard label="Warm Records" value={fmtInt(llm?.warmRecords)} />
            <CompactCard label="GPU Mem" value={pct(llm?.gpuMemoryUtilization, 1)} color={llm?.gpuMemoryUtilization != null && llm.gpuMemoryUtilization >= 0.9 ? "var(--color-danger)" : llm?.gpuMemoryUtilization != null && llm.gpuMemoryUtilization >= 0.7 ? "var(--color-accent)" : "var(--color-success)"} />
            {/* Context metrics */}
            <CompactCard label="Active Context" value={fmtInt(llm?.activeContext)} />
            <CompactCard label="Context Used" value={llm?.contextUsedBytes != null ? `${(llm.contextUsedBytes / 1e9).toFixed(1)}GB` : "\u2014"} />
            {/* Engine metrics */}
            <CompactCard label="Uptime" value={fmtUptime(llm?.ds4Uptime ?? llm?.recipeInfo?.uptime)} />
            <CompactCard label="Reasoning" value={reasoningEffort ?? "\u2014"} color={effortIndex > 0 ? "var(--color-accent)" : "var(--color-muted)"} />
            <CompactCard label="Requests Started" value={fmtInt(llm?.requestsStarted)} />
            <CompactCard label="Requests Done" value={fmtInt(llm?.requestsCompleted)} />
            <CompactCard label="Requests Failed" value={fmtInt(llm?.requestsFailed)} />
            <CompactCard label="Inflight" value={fmtInt(llm?.requestsInflight)} />
            <CompactCard label="Decode Steps" value={fmtInt(llm?.decodeSteps)} />
            <CompactCard label="Tok/Step" value={fmtNum(llm?.tokPerStep, 2)} />
          </div>

          {/* ═══ ROW 7 — ACTIONS ═══ */}
          <div className="llm-actions">
            <button type="button" onClick={() => setBenchOpen(true)} className="llm-action-btn">Run decode benchmark</button>
            <button type="button" onClick={() => { const params = new URLSearchParams(); if (llmPort) params.set("port", String(llmPort)); if (llm?.modelId) params.set("model", llm.modelId); const q = params.toString() ? `?${params.toString()}` : ""; window.open(`/showcase/${encodeURIComponent(sparkId)}${q}`, "_blank", "noopener,noreferrer"); }} className="llm-action-btn">Showcase</button>
          </div>
        </div>
      )}

      <BenchmarkDialog
        open={benchOpen}
        onClose={() => setBenchOpen(false)}
        sparkId={sparkId}
        llmPort={llmPort}
        modelId={remoteTarget ? null : llm?.modelId ?? null}
        remoteTarget={remoteTarget}
      />
      <PrefillBenchDialog
        open={prefillBenchOpen}
        onClose={() => setPrefillBenchOpen(false)}
        sparkId={sparkId}
        llmPort={llmPort}
        modelId={remoteTarget ? null : llm?.modelId ?? null}
        contextLength={remoteTarget ? null : llm?.contextLength ?? null}
        remoteTarget={remoteTarget}
      />
    </Panel>
  );
}
