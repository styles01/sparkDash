import { useState, useEffect, useRef, useCallback } from "react";
import type { LlmMetrics, SlotTelemetry, RecipeMetadata, RecipeInfo } from "../../api/types";
import { setLlmApiKey, updateLlmPort, updateLlmPorts } from "../../api/client";
import { Sparkline } from "../ui/Sparkline";
import { Panel } from "../ui/Panel";
import { TelemetryChart, type ChartSeries } from "../ui/TelemetryChart";
import { BotIcon, GearIcon, InfoIcon } from "../ui/icons";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";
import { BenchmarkDialog } from "./BenchmarkDialog";

interface LlmPanelProps {
  llm: LlmMetrics | null;
  sparkId: string;
  llmPort: number;
/** Legacy single-port change callback. Optional now that SparkPage manages multi-port. */
  onLlmPortChange?: (port: number) => void;
  /** Called when the user clicks the remove-port button (only when >1 port configured). */
  llmPorts?: number[];
  hasApiKey?: boolean;
  onRemovePort?: (port: number) => void;
  /** Total number of LLM ports configured for this Spark (controls remove-button visibility). */
  llmPortsCount?: number;
  className?: string;
}

const VLLM_METRIC_INFO = {
  kvCache:
    "Fraction of the engine KV cache memory currently in use (0-100%). High values mean little room for new or long contexts and often lead to queuing or preemptions.",
  requests:
    "Run = requests actively generating on the GPU. Wait = accepted but not yet scheduled (capacity or constraints). Growing wait with high KV cache usually means the server is overloaded.",
  ttftP95:
    "95th percentile time-to-first-token from vLLM history of requests: how long slow requests wait until the first output token. Spikes mean queueing, long prefills, or cold paths.",
  preempts:
    "Cumulative times the engine paused a running request to free KV cache for others. Rising under load signals memory pressure; zero is normal when the server is comfortable.",
  prefixCache:
    "Lifetime fraction of prefix-cache lookups that hit (hits / queries). Higher means more prompt reuse and less prefill work.",
  e2eP95:
    "95th percentile end-to-end request latency from vLLM history: arrival until the request finishes. Includes queue wait, prefill, and decode.",
  itlP95:
    "95th percentile inter-token latency (time between successive output tokens) from vLLM history. Spikes mean decode stalls or contention.",
  mtpAccept:
    "Lifetime speculative / MTP acceptance rate (accepted draft tokens / drafted tokens). Higher means speculative decoding is paying off.",
} as const;

const DS4_METRIC_INFO = {
  peakAggregate: "Peak combined decode throughput (max ds4_decode_tok_s observed since probe start).",
  perStream: "Per-stream decode throughput: high/low/avg tok/s across active context banks.",
  totalTokens: "Cumulative decoded tokens (ds4_tokens_decoded_total counter).",
  dspark: "DSpark speculative decode acceptance ratio (ds4_spec_accept_ratio gauge). Higher is better.",
  banks: "Active Lanes: context banks currently in use / total configured.",
  kvPages: "KV cache memory in use (ds4_kv_pages_resident × 2048 KiB page size).",
  prefill: "Prefill tokens served from prefix cache vs computed.",
  warm: "Prefix cache warm records (ds4_warm_records). Higher means more cache hits.",
  recipe: "Recipe metadata from /v1/models: model name, context length, supported parameters.",
} as const;

const HISTORY = 60;

interface History {
  genTps: number[];
  prefillTps: number[];
  ttft: number[];
  e2e: number[];
  prevE2e?: number;
  prevTtft?: number;
  prevTokensPerReq?: number;
  prevTpsPerSlot?: number;
}

function pushSample(arr: number[], v: number, max = HISTORY): number[] {
  const next = arr.length >= max ? arr.slice(arr.length - max + 1) : arr.slice();
  next.push(v);
  return next;
}

function BackendBadge({ backend }: { backend: string | null }) {
  if (!backend) return <span className="text-xs text-muted">No backend</span>;
  const labels: Record<string, string> = {
    vllm: "vLLM",
    "llama.cpp": "llama.cpp",
    sglang: "sgLang",
    ds4: "DS4",
  };
  return (
    <span className="llm-badge">
      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
      {labels[backend] || backend}
    </span>
  );
}

/** Exposure / auth posture from the unauthenticated probe (issue #17). */
function PostureBadge({
  posture,
}: {
  posture: NonNullable<LlmMetrics["posture"]>;
}) {
  return (
    <span
      className={`llm-posture llm-posture--${posture.level}`}
      title={posture.detail}
    >
      <span className="llm-posture__dot" />
      {posture.label}
    </span>
  );
}

/** Small (i) next to a metric label; one open tooltip at a time. */
function MetricInfoTip({
  id,
  label,
  text,
  openId,
  setOpenId,
  align = "left",
}: {
  id: string;
  label: string;
  text: string;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  align?: "left" | "right";
}) {
  const open = openId === id;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const scheduleClose = useCallback(() => {
    clearTimer();
    timer.current = setTimeout(() => setOpenId(null), 2000);
  }, [clearTimer, setOpenId]);
  useEffect(() => () => clearTimer(), [clearTimer]);
  return (
    <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted">
      <span>{label}</span>
      <button
        type="button"
        onClick={() => {
          if (open) { clearTimer(); setOpenId(null); }
          else { setOpenId(id); scheduleClose(); }
        }}
        onMouseEnter={() => { clearTimer(); setOpenId(id); }}
        onMouseLeave={scheduleClose}
        className="relative cursor-pointer opacity-60 hover:opacity-100"
        aria-label={`${label} info`}
      >
        <InfoIcon className="h-2.5 w-2.5" />
        {open && (
          <div
            onMouseEnter={clearTimer}
            onMouseLeave={scheduleClose}
            className={`absolute top-full z-20 mt-1 w-52 max-w-[min(13rem,calc(100vw-1.5rem))] rounded-md border border-border bg-surface-elevated px-3 py-2 text-left text-[11px] font-normal normal-case leading-snug text-text shadow-lg ${align === "right" ? "right-0 left-auto" : "left-0 right-auto"}`}
          >
            {text}
          </div>
        )}
      </button>
    </div>
  );
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

function mtpColor(rate: number | undefined | null): string {
  if (rate == null) return "var(--color-muted)";
  const p = rate * 100;
  if (p > 70) return "var(--color-success)";
  if (p >= 50) return "var(--color-warning)";
  return "var(--color-danger)";
}

function latencyColor(seconds: number, fast: number, slow: number): string {
  if (!Number.isFinite(seconds)) return "var(--color-muted)";
  if (seconds <= fast) return "var(--color-success)";
  if (seconds >= slow) return "var(--color-danger)";
  return "var(--color-warning)";
}

function tpsColor(tps: number): string {
  if (!Number.isFinite(tps) || tps <= 0) return "var(--color-muted)";
  if (tps >= 40) return "var(--color-success)";
  if (tps >= 15) return "var(--color-warning)";
  return "var(--color-danger)";
}

function StatCard({
  label,
  value,
  sub,
  valueColor,
  bar,
}: {
  label: string;
  value: string;
  sub?: string;
  valueColor?: string;
  bar?: { pct: number; color: string };
}) {
  return (
    <div className="llm-stat-card">
      <div className="llm-stat-label">{label}</div>
      <div className="llm-stat-value font-tabular" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </div>
      {sub && <div className="llm-stat-sub font-tabular">{sub}</div>}
      {bar && (
        <div className="llm-stat-bar">
          <div className="llm-stat-bar-fill" style={{ width: `${Math.max(0, Math.min(100, bar.pct))}%`, background: bar.color }} />
        </div>
      )}
    </div>
  );
}

function TrendArrow({ current, previous, lowerIsBetter = false }: { current?: number; previous?: number; lowerIsBetter?: boolean }) {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return <span className="llm-trend-neutral">\u2500</span>;
  }
  const delta = current - previous;
  const epsilon = Math.abs(previous) * 0.001 || 1e-6;
  if (Math.abs(delta) < epsilon) return <span className="llm-trend-neutral">\u2500</span>;
  const up = delta > 0;
  const good = lowerIsBetter ? !up : up;
  return (
    <span className={good ? "llm-trend-up" : "llm-trend-down"} aria-label={up ? "up" : "down"}>
      {up ? "\u25B2" : "\u25BC"}
    </span>
  );
}

function AcceptanceGauge({ rate }: { rate: number | null | undefined }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const pctVal = rate == null ? 0 : Math.max(0, Math.min(1, rate));
  const dash = c * pctVal;
  const color = mtpColor(rate);
  const label = rate == null ? "\u2014" : `${Math.round(rate * 100)}%`;
  return (
    <div className="llm-gauge">
      <svg width="92" height="92" viewBox="0 0 92 92">
        <circle cx="46" cy="46" r={r} fill="none" stroke="var(--color-border)" strokeWidth="7" />
        <circle cx="46" cy="46" r={r} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${dash} ${c}`} transform="rotate(-90 46 46)" style={{ transition: "stroke-dasharray 0.4s ease, stroke 0.4s ease" }} />
        <text x="46" y="50" textAnchor="middle" className="llm-gauge-text font-tabular" fill={color}>{label}</text>
      </svg>
      <div className="llm-gauge-caption">Acceptance</div>
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

/** Format a token count with K suffix, e.g. 54515 → "54.5K", 69306 → "69.3K" */
function fmtK(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "\u2014";
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return String(Math.round(v));
}

/** Badge for a supported parameter, with optional inline stat. */
function ParamBadge({
  param,
  stat,
}: {
  param: string;
  stat?: { label: string; value: string; accent?: string } | null;
}) {
  return (
    <span className="recipe-param-badge">
      <span className="recipe-param-badge-name">{param}</span>
      {stat && (
        <span className={`recipe-param-badge-stat${stat.accent ? ` recipe-param-badge-stat--${stat.accent}` : ""}`}>
          {stat.value}
        </span>
      )}
    </span>
  );
}

/** Merged recipe info + metadata section shown at the bottom of the LLM panel. */
function RecipeSection({
  info,
  metadata,
  llm,
}: {
  info: RecipeInfo | null | undefined;
  metadata: RecipeMetadata | null | undefined;
  llm: LlmMetrics | null;
}) {
  const hasInfo = info != null;
  const hasMeta = metadata != null && (metadata.model != null || metadata.supportedParameters.length > 0);
  if (!hasInfo && !hasMeta) return null;

  const acceptPct = info?.acceptRatio != null ? `${Math.round(info.acceptRatio * 100)}%` : "\u2014";
  const acceptAccent = info?.acceptRatio != null && info.acceptRatio > 0.7 ? "success" : info?.acceptRatio != null && info.acceptRatio >= 0.5 ? "warning" : "danger";

  // Params from metadata
  const params = metadata?.supportedParameters ?? [];

  // Build param→stat mappings using live DS4 metrics
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
      // reasoning_effort → show the actual last-known reasoning effort level
      if (p === "reasoning_effort") {
        const effort = llm.reasoningEffort;
        if (effort) {
          const accent = effort === "high" ? "danger" : effort === "medium" ? "warning" : "success";
          paramStats[p] = { label: "last", value: effort, accent };
        } else {
          paramStats[p] = null;
        }
      }
    }
  }

  // Stats that map to recipe config fields with live metric counterparts
  const liveStats: { label: string; value: string; sub?: string; accent?: string }[] = [];
  if (llm) {
    // Spec decode acceptance → relates to specDecodeMethod
    if (llm.dsparkAcceptRatio != null) {
      liveStats.push({ label: "DSpark accept", value: pct(llm.dsparkAcceptRatio, 1), accent: llm.dsparkAcceptRatio > 0.7 ? "success" : llm.dsparkAcceptRatio >= 0.5 ? "warning" : "danger" });
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
    // Spec drafts/hits → removed per user request (not useful dashboard metrics)

    // Total tokens decoded
    if (llm.totalTokensDecoded != null) {
      liveStats.push({ label: "Tokens decoded", value: fmtInt(llm.totalTokensDecoded), accent: "accent" });
    }
    // Context used (KV cache)
    if (llm.contextUsedBytes != null) {
      liveStats.push({ label: "KV Cache", value: fmtBytes(llm.contextUsedBytes), accent: "accent" });
    }
    // Requests inflight
    if (llm.requestsInflight != null) {
      liveStats.push({ label: "In Flight", value: fmtInt(llm.requestsInflight), accent: llm.requestsInflight > 0 ? "success" : undefined });
    }
    // Reasoning effort
    if (llm.reasoningEffort) {
      const accent = llm.reasoningEffort === "high" ? "danger" : llm.reasoningEffort === "medium" ? "warning" : "success";
      liveStats.push({ label: "Reasoning", value: llm.reasoningEffort, accent });
    }
    // Uptime
    if (llm.ds4Uptime != null) {
      liveStats.push({ label: "Uptime", value: fmtUptime(llm.ds4Uptime) });
    }
  }

  return (
    <div className="recipe-merged-section">
      {/* ── Header: engine type + model name + attribution ── */}
      <div className="recipe-merged-header">
        <div className="recipe-merged-title-row">
          {info?.engineType && (
            <span className="recipe-info-engine-type">{info.engineType}</span>
          )}
          <span className="recipe-info-model">{info?.modelName ?? metadata?.model ?? "\u2014"}</span>
        </div>
        {(info?.author || info?.containerImage || info?.uptime != null) && (
          <div className="recipe-info-attribution">
            {info?.author && (
              <>
                <span className="recipe-info-author-label">Recipe by</span>
                <span className="recipe-info-author">{info.author}</span>
                {info.authorName && info.authorName !== info.author && (
                  <span className="recipe-info-author-name">({info.authorName})</span>
                )}
              </>
            )}
            {info?.containerImage && (
              <>
                {info?.author && <span className="recipe-info-sep">\u00B7</span>}
                <span className="recipe-info-container" title={info.containerImage}>{info.containerImage}</span>
              </>
            )}
            {info?.uptime != null && (
              <>
                <span className="recipe-info-sep">\u00B7</span>
                <span className="recipe-info-uptime">up {fmtUptime(info.uptime)}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Grid: config badges (left) + live stats (right) ── */}
      <div className="recipe-merged-grid">
        {/* Config badges subsection */}
        <div className="recipe-merged-subsection">
          <div className="recipe-merged-subsection-title">Configuration</div>
          <div className="recipe-info-badges">
            {(info?.contextLength ?? metadata?.contextLength) != null && (
              <RecipeBadge label="Context" value={(info?.contextLength ?? metadata?.contextLength)! >= 1024 ? `${Math.round((info?.contextLength ?? metadata?.contextLength)! / 1024)}K` : String((info?.contextLength ?? metadata?.contextLength)!)} />
            )}
            {info?.maxLanes != null && (
              <RecipeBadge label="Lanes" value={String(info.maxLanes)} accent="accent" />
            )}
            {info?.specDecodeMethod && (
              <RecipeBadge label="Spec Decode" value={info.specDecodeMethod} accent="success" />
            )}
            {info?.quantization && (
              <RecipeBadge label="Quant" value={info.quantization} accent="warning" />
            )}
            {info?.kvCacheDtype && (
              <RecipeBadge label="KV Cache" value={info.kvCacheDtype} />
            )}
            {info?.prefixCaching != null && (
              <RecipeBadge label="Prefix Cache" value={info.prefixCaching ? "ON" : "OFF"} accent={info.prefixCaching ? "success" : "danger"} />
            )}
            {info?.gmu != null && (
              <RecipeBadge label="GMU" value={`${Math.round(info.gmu * 100)}%`} />
            )}
            {info?.acceptRatio != null && (
              <RecipeBadge label="Accept" value={acceptPct} accent={acceptAccent} />
            )}
            {metadata?.ownedBy && (
              <RecipeBadge label="Owned by" value={metadata.ownedBy} />
            )}
          </div>
        </div>

        {/* Live stats subsection (only for DS4 with live metrics) */}
        {liveStats.length > 0 && (
          <div className="recipe-merged-subsection">
            <div className="recipe-merged-subsection-title">Live Stats</div>
            <div className="recipe-merged-live-stats">
              {liveStats.map((s, i) => (
                <div key={i} className={`recipe-merged-live-stat${s.accent ? ` recipe-merged-live-stat--${s.accent}` : ""}`}>
                  <span className="recipe-merged-live-stat-label">{s.label}</span>
                  <span className="recipe-merged-live-stat-value font-tabular">{s.value}</span>
                  {s.sub && <span className="recipe-merged-live-stat-sub font-tabular">{s.sub}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Supported parameters as badges ── */}
      {params.length > 0 && (
        <div className="recipe-merged-subsection">
          <div className="recipe-merged-subsection-title">Supported Parameters</div>
          <div className="recipe-merged-params">
            {params.map((p) => (
              <ParamBadge key={p} param={p} stat={paramStats[p] ?? null} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function fmtBytes(v: number | undefined | null): string {
  if (v == null || !Number.isFinite(v)) return "\u2014";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} GB`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} MB`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)} KB`;
  return `${v} B`;
}

export function LlmPanel({
  llm,
  sparkId,
  llmPort,
  llmPorts,
  hasApiKey = false,
  onLlmPortChange,
  onRemovePort,
  llmPortsCount,
  className,
}: LlmPanelProps) {
  // Tail keyed by port so multi-port LLM sparklines stay distinct (8b).
  const genHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.tps`);
  const [history, setHistory] = useState<History>({ genTps: [], prefillTps: [], ttft: [], e2e: [] });
  const [showSettings, setShowSettings] = useState(false);
  const [portDraft, setPortDraft] = useState(String(llmPort));
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [engineInfoOpen, setEngineInfoOpen] = useState(false);
  const [benchOpen, setBenchOpen] = useState(false);
  const [metricInfoId, setMetricInfoId] = useState<string | null>(null);
  const engineInfoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearEngineInfoTimer = useCallback(() => {
    if (engineInfoTimer.current != null) { clearTimeout(engineInfoTimer.current); engineInfoTimer.current = null; }
  }, []);
  const startEngineInfoTimer = useCallback(() => {
    clearEngineInfoTimer();
    engineInfoTimer.current = setTimeout(() => setEngineInfoOpen(false), 2000);
  }, [clearEngineInfoTimer]);

  const available = llm?.available ?? false;

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
    setHistory((prev) => ({
      genTps: pushSample(prev.genTps, gen),
      prefillTps: pushSample(prev.prefillTps, pre),
      ttft: pushSample(prev.ttft, ttft),
      e2e: pushSample(prev.e2e, e2e),
      prevE2e: prev.e2e.length ? prev.e2e[prev.e2e.length - 1] : undefined,
      prevTtft: prev.ttft.length ? prev.ttft[prev.ttft.length - 1] : undefined,
      prevTokensPerReq: prev.prevTokensPerReq === undefined ? llm.genTokensPerReq : prev.prevTokensPerReq,
      prevTpsPerSlot: prev.prevTpsPerSlot === undefined ? llm.rollingAvgTpsPerSlot : prev.prevTpsPerSlot,
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
      setSaveError("Port must be an integer 1–65535");
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
        const currentPorts =
          Array.isArray(llmPorts) && llmPorts.length > 0 ? llmPorts : [llmPort];
        if (currentPorts.includes(parsedPort) && parsedPort !== llmPort) {
          setSaveError(`Port ${parsedPort} is already configured`);
          setSaving(false);
          return;
        }
        // Rename this panel's port in-place so sibling ports (and their keys) survive
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

  const genSeries: ChartSeries = { label: "gen tok/s", color: "var(--color-success)", data: history.genTps, area: true, yAxis: "left" };
  const preSeries: ChartSeries = { label: "prefill tok/s", color: "var(--color-accent)", data: history.prefillTps, area: false, yAxis: "right" };
  const ttftSeries: ChartSeries = { label: "TTFT", color: "var(--color-warning)", data: history.ttft, area: false };
  const e2eSeries: ChartSeries = { label: "E2E", color: "var(--color-danger)", data: history.e2e, area: false };

  const runningSlots = llm?.runningSlots ?? llm?.slotsActive ?? 0;
  const waitingSlots = llm?.waitingSlots ?? 0;
  const kvUsage = llm?.kvCacheUsage ?? null;
  const genTps = llm?.generationTps ?? 0;
  const mtpRate = llm?.mtpAcceptanceRate ?? null;
  const prefixHit = llm?.prefixCacheHitRate ?? null;
  const slots: SlotTelemetry[] = llm?.slots ?? [];
  const perPos: number[] = llm?.perPositionAcceptance ?? [];
  const mtpAccepted = llm?.mtpAcceptedTokens ?? null;
  const mtpDrafted = llm?.mtpDraftedTokens ?? null;
  const isDs4 = llm?.backend === "ds4";

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
              <span aria-hidden>\u00D7</span><span>Remove</span>
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
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-hover disabled:opacity-50 ${
              showSettings ? "bg-surface-elevated text-text" : ""
            }`}
          >
            <GearIcon />
            <span>{showSettings ? "Done" : "Settings"}</span>
          </button>
          {llmPortsCount != null && llmPortsCount > 1 && onRemovePort && (
            <button type="button" title={`Remove port :${llmPort}`} onClick={() => onRemovePort(llmPort)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-danger transition-colors hover:bg-surface-hover">
              <span>\u00D7</span><span>Remove</span>
            </button>
          )}
        </div>
      }
    >
      {showSettings ? (
        <div className="space-y-3">
          <p className="text-[10px] text-muted">
            HTTP port of the LLM server on this Spark (vLLM / llama.cpp / sglang / ds4 / OpenAI-compatible gateway).
          </p>
          <label className="block space-y-1">
            <span className="text-xs text-muted">Port</span>
            <input
              type="number"
              min={1}
              max={65535}
              inputMode="numeric"
              value={portDraft}
              onChange={(e) => {
                setPortDraft(e.target.value);
                setSaveError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSaveSettings();
                }
              }}
              className="w-full rounded-md border border-border bg-surface-elevated px-3 py-1.5 font-tabular text-sm text-text outline-none focus:border-accent"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted">API key (optional)</span>
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={apiKeyDraft}
              disabled={clearApiKey}
              placeholder={hasApiKey && !clearApiKey ? "•••••••• (saved — leave blank to keep)" : "Bearer token if required"}
              onChange={(e) => {
                setApiKeyDraft(e.target.value);
                setClearApiKey(false);
                setSaveError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSaveSettings();
                }
              }}
              className="w-full rounded-md border border-border bg-surface-elevated px-3 py-1.5 font-mono text-sm text-text outline-none focus:border-accent disabled:opacity-50"
            />
          </label>
          {hasApiKey && (
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={clearApiKey}
                onChange={(e) => {
                  setClearApiKey(e.target.checked);
                  if (e.target.checked) setApiKeyDraft("");
                  setSaveError(null);
                }}
                className="h-3.5 w-3.5 accent-[var(--color-accent)]"
              />
              Clear saved API key
            </label>
          )}
          {portInvalid && (
            <p className="text-[10px] text-danger">Enter an integer between 1 and 65535</p>
          )}
          {saveError && <p className="text-[10px] text-danger">{saveError}</p>}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setPortDraft(String(llmPort));
                setApiKeyDraft("");
                setClearApiKey(false);
                setSaveError(null);
                setShowSettings(false);
              }}
              disabled={saving}
              className="rounded border border-border px-2 py-1 text-[10px] text-muted hover:bg-surface-hover disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSaveSettings()}
              disabled={saving || portInvalid || !settingsDirty}
              className="rounded bg-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : !available ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 py-1">
            {llm?.posture ? (
              <PostureBadge posture={llm.posture} />
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-muted" />
            )}
            <p className="text-xs text-muted">
              {llm?.posture?.auth === "protected"
                ? `${llm.posture.label} on :${llmPort}`
                : `No model loaded on :${llmPort}`}
            </p>
          </div>
          <div className="border-t border-border pt-3 space-y-2">
            <button
              type="button"
              onClick={() => {
                const params = new URLSearchParams();
                if (llmPort) params.set("port", String(llmPort));
                const q = params.toString() ? `?${params.toString()}` : "";
                window.open(
                  `/showcase/${encodeURIComponent(sparkId)}${q}`,
                  "_blank",
                  "noopener,noreferrer"
                );
              }}
              className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text transition-colors hover:border-accent hover:bg-accent-soft"
              title="Open prompt showcase (works offline to view history or prepare a run)"
            >
              Showcase
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <BackendBadge backend={llm?.backend ?? null} />
            {llm?.posture && <PostureBadge posture={llm.posture} />}
            {llm?.modelId && (
              <span
                className="min-w-0 flex-1 whitespace-normal break-words text-xs leading-snug text-text [overflow-wrap:anywhere]"
                title={llm.modelId}
              >
                {llm.modelId}
              </span>
            )}
            <span className="shrink-0 font-tabular text-[10px] text-muted">:{llmPort}</span>
          </div>
          {llm?.modelPath &&
            llm.modelPath !== llm.modelId &&
            !llm.modelPath.includes("models--") && (
            <div className="-mt-1.5 truncate text-[10px] text-muted" title={llm.modelPath}>
              {llm.modelPath}
            </div>
          )}

          {/* 2. Stat cards: KV cache, Gen tok/s, MTP accept, Prefix cache */}
          <div className="llm-stat-grid">
            <StatCard label="Running slots" value={fmtInt(runningSlots)} sub={llm?.slotsTotal ? `of ${llm.slotsTotal}` : undefined} valueColor={runningSlots > 0 ? "var(--color-success)" : "var(--color-muted)"} />
            <StatCard label="Waiting slots" value={fmtInt(waitingSlots)} valueColor={waitingSlots > 0 ? "var(--color-danger)" : "var(--color-muted)"} />
            <StatCard label="KV cache" value={pct(kvUsage, 0)} valueColor={kvUsage != null && kvUsage > 0.85 ? "var(--color-danger)" : kvUsage != null && kvUsage > 0.6 ? "var(--color-warning)" : "var(--color-text)"} bar={kvUsage != null ? { pct: kvUsage * 100, color: kvUsage > 0.85 ? "var(--color-danger)" : kvUsage > 0.6 ? "var(--color-warning)" : "var(--color-accent)" } : undefined} />
            <StatCard label="Gen tok/s" value={fmtNum(genTps, 1)} sub={fmtNum(llm?.prefillTps, 1, " prefill")} valueColor={tpsColor(genTps)} />
            <StatCard label={isDs4 ? "DSpark accept" : "MTP accept"} value={pct(mtpRate, 0)} valueColor={mtpColor(mtpRate)} bar={mtpRate != null ? { pct: mtpRate * 100, color: mtpColor(mtpRate) } : undefined} />
            <StatCard label="Prefix cache" value={pct(prefixHit, 0)} valueColor={prefixHit != null ? "var(--color-accent)" : "var(--color-muted)"} bar={prefixHit != null ? { pct: prefixHit * 100, color: "var(--color-accent)" } : undefined} />
          </div>

          {/* 3. Real-time t/s chart */}
          <div className="llm-chart-block">
            <div className="llm-chart-title">Throughput <span className="llm-chart-sub">tok/s \u00B7 last 60 samples</span></div>
            <TelemetryChart series={[genSeries, preSeries]} maxPoints={HISTORY} height={170} yUnit="" yUnitRight="" yMin={0} yMax={140} yMaxRight={2000} />
          </div>

          {/* 4. TTFT + E2E latency chart */}
          <div className="llm-chart-block">
            <div className="llm-chart-title">Latency <span className="llm-chart-sub">seconds \u00B7 TTFT + E2E</span></div>
            <TelemetryChart series={[ttftSeries, e2eSeries]} maxPoints={HISTORY} height={150} yUnit="s" yMin={0} />
          </div>

          {/* 5. Per-slot table */}
          {slots.length > 0 && (
            <div className="llm-chart-block">
              <div className="llm-chart-title">Per-slot <span className="llm-chart-sub">{slots.length} active</span></div>
              <div className="llm-slot-table">
                <table>
                  <thead><tr><th>Slot</th><th>Context</th><th>t/s</th><th>TTFT</th><th>RTT</th></tr></thead>
                  <tbody>
                    {slots.map((s) => (
                      <tr key={s.id}>
                        <td className="font-tabular">#{s.id}</td>
                        <td className="font-tabular">{s.contextLength.toLocaleString()}</td>
                        <td className="font-tabular" style={{ color: tpsColor(s.tps) }}>{fmtNum(s.tps, 1)}</td>
                        <td className="font-tabular" style={{ color: latencyColor(s.ttft, 0.2, 1.0) }}>{fmtNum(s.ttft, 3, "s")}</td>
                        <td className="font-tabular" style={{ color: latencyColor(s.roundTrip, 0.5, 3.0) }}>{fmtNum(s.roundTrip, 3, "s")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 6. Moving averages + 7. MTP panel */}
          <div className="llm-bottom-grid">
            <div className="llm-chart-block">
              <div className="llm-chart-title">Moving averages <span className="llm-chart-sub">last 10 inferences</span></div>
              <div className="llm-ma-grid">
                <div className="llm-ma-card">
                  <div className="llm-ma-label">Avg E2E</div>
                  <div className="llm-ma-value font-tabular" style={{ color: latencyColor(llm?.rollingAvgE2e ?? NaN, 0.5, 3.0) }}>{fmtNum(llm?.rollingAvgE2e, 3, "s")}</div>
                  <TrendArrow current={llm?.rollingAvgE2e} previous={history.prevE2e} lowerIsBetter />
                </div>
                <div className="llm-ma-card">
                  <div className="llm-ma-label">Avg TTFT</div>
                  <div className="llm-ma-value font-tabular" style={{ color: latencyColor(llm?.rollingAvgTtft ?? NaN, 0.2, 1.0) }}>{fmtNum(llm?.rollingAvgTtft, 3, "s")}</div>
                  <TrendArrow current={llm?.rollingAvgTtft} previous={history.prevTtft} lowerIsBetter />
                </div>
                <div className="llm-ma-card">
                  <div className="llm-ma-label">Avg tokens/req</div>
                  <div className="llm-ma-value font-tabular">{fmtInt(llm?.rollingAvgTokensPerReq)}</div>
                  <TrendArrow current={llm?.rollingAvgTokensPerReq} previous={history.prevTokensPerReq} />
                </div>
                <div className="llm-ma-card">
                  <div className="llm-ma-label">Avg tok/s \u00B7 slot</div>
                  <div className="llm-ma-value font-tabular" style={{ color: tpsColor(llm?.rollingAvgTpsPerSlot ?? 0) }}>{fmtNum(llm?.rollingAvgTpsPerSlot, 1)}</div>
                  <TrendArrow current={llm?.rollingAvgTpsPerSlot} previous={history.prevTpsPerSlot} />
                </div>
              </div>
            </div>

            <div className="llm-chart-block">
              <div className="llm-chart-title">Speculative decode <span className="llm-chart-sub">{isDs4 ? "DSpark" : "MTP"}</span></div>
              <div className="llm-mtp-body">
                <AcceptanceGauge rate={mtpRate} />
                <div className="llm-mtp-right">
                  <div className="llm-mtp-counters">
                    <div className="llm-mtp-counter">
                      <div className="llm-mtp-counter-label">{isDs4 ? "Hits" : "Accepted"}</div>
                      <div className="llm-mtp-counter-val font-tabular" style={{ color: "var(--color-success)" }}>{fmtInt(mtpAccepted)}</div>
                    </div>
                    <div className="llm-mtp-counter">
                      <div className="llm-mtp-counter-label">{isDs4 ? "Drafts" : "Drafted"}</div>
                      <div className="llm-mtp-counter-val font-tabular">{fmtInt(mtpDrafted)}</div>
                    </div>
                  </div>
                  {perPos.length > 0 && (
                    <div className="llm-mtp-positions">
                      <div className="llm-mtp-pos-label">Per-position acceptance</div>
                      <div className="llm-mtp-pos-bars">
                        {perPos.slice(0, 4).map((p, i) => (
                          <div key={i} className="llm-mtp-pos-bar">
                            <div className="llm-mtp-pos-bar-track"><div className="llm-mtp-pos-bar-fill" style={{ width: `${Math.max(0, Math.min(100, p * 100))}%`, background: mtpColor(p) }} /></div>
                            <div className="llm-mtp-pos-bar-label font-tabular">pos{i}</div>
                            <div className="llm-mtp-pos-bar-val font-tabular">{pct(p, 0)}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* ── DS4 ENGINE METRICS PANEL ─────────────────────── */}
          {(llm?.backend === "ds4" || llm?.backend === "sglang" || llm?.backend === "vllm") && (
            <div className="llm-chart-block" style={{ borderTop: "1px solid var(--color-border)", paddingTop: "0.75rem" }}>
              <div className="llm-chart-title">DS4 Engine Metrics <span className="llm-chart-sub">CUDA engine telemetry</span></div>

              {/* Peak Aggregate + Per-Stream + Total Tokens */}
              <div className="llm-stat-grid" style={{ marginBottom: "0.75rem" }}>
                <StatCard label="Peak Aggregate tok/s" value={fmtNum(llm?.peakAggregateTps, 1)} valueColor={tpsColor(llm?.peakAggregateTps ?? 0)} />
                <StatCard label="Per-Stream High" value={fmtNum(llm?.perStreamHigh, 1)} valueColor={tpsColor(llm?.perStreamHigh ?? 0)} />
                <StatCard label="Per-Stream Low" value={fmtNum(llm?.perStreamLow, 1)} valueColor={tpsColor(llm?.perStreamLow ?? 0)} />
                <StatCard label="Per-Stream Avg" value={fmtNum(llm?.perStreamAvg, 1)} valueColor={tpsColor(llm?.perStreamAvg ?? 0)} />
                <StatCard label="Total Tokens" value={fmtInt(llm?.totalTokensDecoded)} valueColor="var(--color-accent)" />
                <StatCard label="DSpark Accept %" value={pct(llm?.dsparkAcceptRatio, 1)} valueColor={mtpColor(llm?.dsparkAcceptRatio)} bar={llm?.dsparkAcceptRatio != null ? { pct: llm.dsparkAcceptRatio * 100, color: mtpColor(llm.dsparkAcceptRatio) } : undefined} />
              </div>

              {/* Key metrics: Decode, Prefill, Active Lanes, Context, Inflight, Uptime */}
              <div className="llm-stat-grid" style={{ marginBottom: "0.75rem" }}>
                <StatCard label="Decode tok/s" value={fmtNum(llm?.generationTps, 1)} valueColor={tpsColor(llm?.generationTps ?? 0)} />
                <StatCard label="Prefill Speed" value={fmtNum(llm?.prefillTps, 1)} valueColor={tpsColor(llm?.prefillTps ?? 0)} />
                <StatCard label="Active Lanes" value={fmtInt(llm?.banksLive)} sub={llm?.banksTotal != null ? `of ${llm.banksTotal}` : undefined} valueColor={(llm?.banksLive ?? 0) > 0 ? "var(--color-success)" : "var(--color-muted)"} bar={llm?.banksTotal != null && llm.banksTotal > 0 ? { pct: ((llm?.banksLive ?? 0) / llm.banksTotal) * 100, color: "var(--color-accent)" } : undefined} />
                <StatCard label="KV Cache" value={fmtBytes(llm?.contextUsedBytes)} sub={llm?.kvPagesResident != null ? `${fmtInt(llm.kvPagesResident)} pages` : undefined} valueColor="var(--color-accent)" />
                <StatCard label="In Flight" value={fmtInt(llm?.requestsInflight)} valueColor={(llm?.requestsInflight ?? 0) > 0 ? "var(--color-success)" : "var(--color-muted)"} />
                <StatCard label="Uptime" value={fmtUptime(llm?.ds4Uptime)} valueColor="var(--color-muted)" />
              </div>

              {/* Additional counters row */}
              <div className="llm-stat-grid" style={{ marginBottom: "0.75rem" }}>
                <StatCard label="Warm records" value={fmtInt(llm?.warmRecords)} valueColor="var(--color-accent)" />
                <StatCard label="Tok/step" value={fmtNum(llm?.tokPerStep, 3)} valueColor="var(--color-text)" />
                <StatCard label="Decode steps" value={fmtInt(llm?.decodeSteps)} valueColor="var(--color-text)" />
                <StatCard label="Derived artifacts" value={fmtInt(llm?.derivedArtifacts)} sub={fmtBytes(llm?.derivedArtifactBytes)} valueColor="var(--color-text)" />
                <StatCard label="Prefill cached" value={fmtInt(llm?.prefillCached)} valueColor="var(--color-success)" />
                <StatCard label="Reasoning" value={llm?.reasoningEffort ?? "\u2014"} sub={llm?.reasoningEffortTs != null ? new Date(llm.reasoningEffortTs).toLocaleTimeString() : undefined} valueColor={llm?.reasoningEffort === "high" ? "var(--color-danger)" : llm?.reasoningEffort === "medium" ? "var(--color-warning)" : llm?.reasoningEffort === "low" ? "var(--color-success)" : "var(--color-muted)"} />
                <StatCard label="Active Context" value={fmtK(llm?.activeContext)} sub={llm?.activeContextTs != null ? new Date(llm.activeContextTs).toLocaleTimeString() : undefined} valueColor="var(--color-accent)" />
              </div>

              {/* Admits breakdown */}
              <div className="llm-stat-grid" style={{ marginBottom: "0.75rem" }}>
                <StatCard label="Admits: cold" value={fmtInt(llm?.admitsCold)} valueColor="var(--color-danger)" />
                <StatCard label="Admits: warm" value={fmtInt(llm?.admitsWarm)} valueColor="var(--color-success)" />
                <StatCard label="Admits: fork" value={fmtInt(llm?.admitsFork)} valueColor="var(--color-accent)" />
                <StatCard label="Admits: p.fork" value={fmtInt(llm?.admitsPartialFork)} valueColor="var(--color-warning)" />
                <StatCard label="Admits: p.trunc" value={fmtInt(llm?.admitsPartialTruncate)} valueColor="var(--color-warning)" />
                <StatCard label="Requests" value={fmtInt(llm?.requestsStarted)} sub={llm?.requestsCompleted != null ? `${llm.requestsCompleted} done` : undefined} valueColor="var(--color-text)" />
              </div>

            </div>
          )}

          {/* ── vLLM-specific metric tiles (unchanged) ─────── */}
          {(llm?.backend === "vllm" || llm?.backend === "sglang") && (
            <div className="grid grid-cols-2 gap-2 border-t border-border pt-3 sm:grid-cols-4">
              <div className="space-y-0.5"><MetricInfoTip id="kvCache" label="KV Cache" text={VLLM_METRIC_INFO.kvCache} openId={metricInfoId} setOpenId={setMetricInfoId} /><div className={`font-tabular text-sm ${llm.kvCacheUsage == null ? "text-text" : llm.kvCacheUsage >= 0.8 ? "text-danger" : llm.kvCacheUsage >= 0.5 ? "text-warning" : "text-success"}`}>{llm.kvCacheUsage != null ? `${(llm.kvCacheUsage * 100).toFixed(1)}%` : "\u2014"}</div></div>
              <div className="space-y-0.5"><MetricInfoTip id="requests" label="Requests" text={VLLM_METRIC_INFO.requests} openId={metricInfoId} setOpenId={setMetricInfoId} align="right" /><div className="font-tabular text-sm text-text">{llm.requestsRunning != null && llm.requestsWaiting != null ? `${Math.round(llm.requestsRunning)} run / ${Math.round(llm.requestsWaiting)} wait` : "\u2014"}</div></div>
              <div className="space-y-0.5"><MetricInfoTip id="ttftP95" label="TTFT p95" text={VLLM_METRIC_INFO.ttftP95} openId={metricInfoId} setOpenId={setMetricInfoId} /><div className="font-tabular text-sm text-text">{llm.ttftP95Seconds != null ? `${llm.ttftP95Seconds.toFixed(3)}s` : "\u2014"}</div></div>
              <div className="space-y-0.5"><MetricInfoTip id="preempts" label="Preempts" text={VLLM_METRIC_INFO.preempts} openId={metricInfoId} setOpenId={setMetricInfoId} align="right" /><div className="font-tabular text-sm text-text">{llm.preemptionsTotal != null ? Math.round(llm.preemptionsTotal).toLocaleString() : "\u2014"}</div></div>
            </div>
          )}

          {(llm?.backend === "vllm" || llm?.backend === "sglang") && (
            <div className="grid grid-cols-2 gap-2 border-t border-border pt-3 sm:grid-cols-4">
              <div className="space-y-0.5"><MetricInfoTip id="prefixCache" label="Prefix Cache" text={VLLM_METRIC_INFO.prefixCache} openId={metricInfoId} setOpenId={setMetricInfoId} /><div className="font-tabular text-sm text-text">{llm.prefixCacheHitRate != null ? `${(llm.prefixCacheHitRate * 100).toFixed(1)}%` : "\u2014"}</div></div>
              <div className="space-y-0.5"><MetricInfoTip id="e2eP95" label="E2E p95" text={VLLM_METRIC_INFO.e2eP95} openId={metricInfoId} setOpenId={setMetricInfoId} align="right" /><div className="font-tabular text-sm text-text">{llm.e2eP95Seconds != null ? `${llm.e2eP95Seconds.toFixed(3)}s` : "\u2014"}</div></div>
              <div className="space-y-0.5"><MetricInfoTip id="itlP95" label="ITL p95" text={VLLM_METRIC_INFO.itlP95} openId={metricInfoId} setOpenId={setMetricInfoId} /><div className="font-tabular text-sm text-text">{llm.itlP95Seconds != null ? `${llm.itlP95Seconds.toFixed(3)}s` : "\u2014"}</div></div>
              <div className="space-y-0.5"><MetricInfoTip id="mtpAccept" label="MTP Accept" text={VLLM_METRIC_INFO.mtpAccept} openId={metricInfoId} setOpenId={setMetricInfoId} align="right" /><div className="font-tabular text-sm text-text">{llm.mtpAcceptanceRate != null ? `${(llm.mtpAcceptanceRate * 100).toFixed(1)}%` : "\u2014"}</div></div>
            </div>
          )}

          {/* ── Merged Recipe Info + Metadata section (bottom) ── */}
          <RecipeSection info={llm?.recipeInfo} metadata={llm?.recipeMetadata} llm={llm ?? null} />

          <div className="border-t border-border pt-3 space-y-2">
            <button type="button" onClick={() => setBenchOpen(true)} className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text transition-colors hover:border-accent hover:bg-accent-soft">Run decode benchmark</button>
            <button type="button" onClick={() => { const params = new URLSearchParams(); if (llmPort) params.set("port", String(llmPort)); if (llm?.modelId) params.set("model", llm.modelId); const q = params.toString() ? `?${params.toString()}` : ""; window.open(`/showcase/${encodeURIComponent(sparkId)}${q}`, "_blank", "noopener,noreferrer"); }} className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text transition-colors hover:border-accent hover:bg-accent-soft">Showcase</button>
          </div>
        </div>
      )}

      <BenchmarkDialog open={benchOpen} onClose={() => setBenchOpen(false)} sparkId={sparkId} llmPort={llmPort} modelId={llm?.modelId ?? null} />
    </Panel>
  );
}