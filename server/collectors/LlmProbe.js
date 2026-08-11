/**
 * LlmProbe — probes an LLM server on port 8888, auto-detects backend,
 * computes live tokens/sec (generation + prefill).
 *
 * Ported from legacy `probeLlamaServerType` and `_getLlamaMetricsFor`.
 *
 * Supports vLLM, llama.cpp, sglang, and ds4 (DeepSeek-V4-Flash CUDA engine).
 * The ds4 backend is detected via /v1/models `owned_by: "ds4.c"` and exposes
 * its own ds4_* Prometheus metrics.
 */
import { LLM_PROBE_TIMEOUT_MS } from "../config.js";
import { VllmMetricsParser } from "./VllmMetricsParser.js";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { classifyHostScope } from "../validate.js";
import { llmProbeHost } from "./llmHost.js";

const FAIL_RESET_THRESHOLD = 3;
const REDETECT_INTERVAL_MS = 60_000;
const HOST_ROOT = process.env.HOST_ROOT_PATH || "/host/root";
const HOST_PROC = process.env.HOST_PROC_PATH || "/host/proc";
/**
 * SGLang's last_gen_throughput is a sticky gauge (holds last decode rate when
 * idle). Only treat it as live after we observe a change between polls, and
 * expire back to 0 if it stops changing.
 */
const SGLANG_STICKY_TPS_LIVE_MS = 6_000;

/**
 * Prefer a short model id when the server returns a Hugging Face hub cache path.
 * e.g. /root/.cache/huggingface/hub/models--org--Name/snapshots/<hash>
 *   → org/Name
 * @param {unknown} id
 * @returns {string | null}
 */
export function normalizeModelId(id) {
  if (id == null) return null;
  const s = String(id).trim();
  if (!s) return null;

  const hub = s.match(/(?:^|\/)models--([^/]+?)(?:\/snapshots\/[^/]+)?\/?$/);
  if (hub) return hub[1].replace(/--/g, "/");

  const mid = s.match(/models--([^/]+)\/snapshots\//);
  if (mid) return mid[1].replace(/--/g, "/");

  return s;
}

/** True when `id` looks like a Hugging Face hub cache directory (models--org--name). */
export function isHfHubCachePath(id) {
  if (id == null) return false;
  return /(?:^|\/)models--[^/]+/.test(String(id));
}

/**
 * Set modelId (always normalized) and modelPath (omit HF hub cache paths —
 * they duplicate the short id and clutter the LLM panel).
 * @param {unknown} raw
 */
function applyModelRef(probe, raw) {
  if (raw == null || raw === "") return;
  const s = String(raw);
  probe.modelId = normalizeModelId(s);
  probe.modelPath = isHfHubCachePath(s) ? null : s;
}
const DS4_LOG_PATH = process.env.DS4_LOG_PATH || "/host/root/tmp/ds4-196k.log";
const KV_PAGE_SIZE_BYTES = 2048 * 1024; // 2048 KiB per page

export class LlmProbe {
  constructor(spark, port = 8888) {
    this.spark = spark;
    this.port = port;
    this.baseUrl = `http://${llmProbeHost(spark)}:${port}`;

    // State
    this.backendType = null; // 'vllm' | 'llama.cpp' | 'sglang' | 'ds4' | null
    this.serverIsOpenAI = null; // true = OpenAI-compatible
    /** Whether /v1/models (or /slots) answered without credentials. null = unknown. */
    this.authOpen = null;
    this.stepId = 0;
    this.modelId = null;
    this.modelPath = null;
    this.contextLength = null;
    this.gpuMemoryUtilization = null;
    this.slotsActive = 0;
    this.slotsTotal = 0;
    this.generationTps = 0;
    this.prefillTps = 0;
    this.error = null;

    // Per-slot rate tracking (for llama.cpp native path)
    this.slotState = new Map();
    this.lastTokenCounts = { input: 0, output: 0 };
    this.lastProbeTime = 0;

    // Cumulative total output tokens (generation) as reported by the LLM server
    this.totalOutputTokens = 0;

    // vLLM inference metrics from /metrics (null when not vLLM / missing series)
    this.kvCacheUsage = null;
    this.requestsRunning = null;
    this.requestsWaiting = null;
    this.ttftP95Seconds = null;
    this.ttft = null;
    this.e2eLatency = null;
    this.genTokensPerReq = null;
    this.mtpAcceptedTokens = null;
    this.mtpDraftedTokens = null;
    this.aggregateDecodeTps = null;
    this.rollingAvgE2e = null;
    this.rollingAvgTtft = null;
    this.rollingAvgTokensPerReq = null;
    this.rollingAvgTpsPerSlot = null;
    this.preemptionsTotal = null;
    this.prefixCacheHitRate = null;
    this.e2eP95Seconds = null;
    this.itlP95Seconds = null;
    this.mtpAcceptanceRate = null;

    // DS4 engine metrics
    this.ds4Uptime = null;
    this.peakAggregateTps = 0;
    this.perStreamHigh = null;
    this.perStreamLow = null;
    this.perStreamAvg = null;
    this.totalTokensDecoded = null;
    this.dsparkAcceptRatio = null;
    this.banksLive = null;
    this.banksTotal = null;
    this.kvPagesResident = null;
    this.prefillCached = null;
    this.prefillComputed = null;
    this.specDrafts = null;
    this.specHits = null;
    this.specQuench = null;
    this.warmRecords = null;
    this.derivedArtifacts = null;
    this.derivedArtifactBytes = null;
    this.requestsStarted = null;
    this.requestsCompleted = null;
    this.requestsFailed = null;
    this.requestsRefusedDeepSerial = null;
    this.requestsInflight = null;
    this.requestsSerial = null;
    this.contAdmitRejects = null;
    this.contBatchFailures = null;
    this.graphFitRefusals = null;
    this.admitsCold = null;
    this.admitsWarm = null;
    this.admitsFork = null;
    this.admitsPartialFork = null;
    this.admitsPartialTruncate = null;
    this.decodeSteps = null;
    this.tokPerStep = null;
    this.recipeMetadata = null;
    this.recipeInfo = null;

    // Reasoning effort tracking (from ds4 request logs)
    this.reasoningEffort = null; // 'low' | 'medium' | 'high' | null
    this.reasoningEffortTs = null; // ms epoch when last set
    this._ds4LogSize = 0; // last read position in ds4 log file

    // Active context tracking (from ds4 request logs: ctx=0..N:N)
    this.activeContext = null; // total context tokens in the most recent request
    this.activeContextTs = null; // ms epoch when last seen
    this._ds4LogSizeCtx = 0; // separate read position for context tailing

    // DS4 per-cycle deltas + rolling window (for latency/moving-avg derivation)
    this._ds4Prev = {
      tokensDecoded: null,
      decodeSteps: null,
      requestsStarted: null,
      requestsCompleted: null,
      prefillComputed: null,
      prefillCached: null,
      time: 0,
    };
    this._ds4Rolling = [];

    this._consecutiveFailures = 0;
    this._lastDetectAt = 0;
    this._vllmMetricsParser = new VllmMetricsParser();
    /** @type {{ value: number, liveUntil: number } | null} */
    this._sglangStickyTps = null;
  }

  /** Update probe port (and host from spark). Resets detection when the target changes. */
  setPort(port) {
    const next = Number(port);
    const prevUrl = this.baseUrl;
    if (Number.isInteger(next) && next >= 1 && next <= 65535) {
      this.port = next;
    }
    this.baseUrl = `http://${llmProbeHost(this.spark)}:${this.port}`;
    if (this.baseUrl !== prevUrl) {
      this._resetDetection();
      this._lastDetectAt = 0;
      this._consecutiveFailures = 0;
    }
  }

  /** Probe the LLM server and return a snapshot. */
  async probe() {
    try {
      const shouldDetect =
        this.serverIsOpenAI === null ||
        Date.now() - this._lastDetectAt > REDETECT_INTERVAL_MS;

      if (shouldDetect) {
        await this._detectServerType();
        this._lastDetectAt = Date.now();
      }

      if (this.serverIsOpenAI === false) {
        const snap = await this._probeLlamaCpp();
        this._noteSuccess();
        return snap;
      } else if (this.serverIsOpenAI === true) {
        if (this.backendType === "ds4") {
          const snap = await this._probeDs4();
          this._noteSuccess();
          return snap;
        }
        const snap = await this._probeOpenAICompatible();
        this._noteSuccess();
        return snap;
      } else {
        this._noteFailure("LLM server not reachable");
        return this._defaultLlm();
      }
    } catch (err) {
      this._noteFailure(err.message);
      return this._defaultLlm();
    }
  }

  _noteSuccess() {
    this._consecutiveFailures = 0;
    this.error = null;
  }

  _noteFailure(message) {
    this.error = message;
    this._consecutiveFailures += 1;
    if (this._consecutiveFailures >= FAIL_RESET_THRESHOLD) {
      this._resetDetection();
    }
  }

  _resetDetection() {
    this.serverIsOpenAI = null;
    this.backendType = null;
    this.authOpen = null;
    this.modelId = null;
    this.modelPath = null;
    this.generationTps = 0;
    this.prefillTps = 0;
    this.contextLength = null;
    this.gpuMemoryUtilization = null;
    this.slotsActive = 0;
    this.slotsTotal = 0;
    this.totalOutputTokens = 0;
    this.kvCacheUsage = null;
    this.requestsRunning = null;
    this.requestsWaiting = null;
    this.ttftP95Seconds = null;
    this.ttft = null;
    this.e2eLatency = null;
    this.genTokensPerReq = null;
    this.mtpAcceptedTokens = null;
    this.mtpDraftedTokens = null;
    this.aggregateDecodeTps = null;
    this.rollingAvgE2e = null;
    this.rollingAvgTtft = null;
    this.rollingAvgTokensPerReq = null;
    this.rollingAvgTpsPerSlot = null;
    this.preemptionsTotal = null;
    this.prefixCacheHitRate = null;
    this.e2eP95Seconds = null;
    this.itlP95Seconds = null;
    this.mtpAcceptanceRate = null;
    // DS4
    this.ds4Uptime = null;
    this.peakAggregateTps = 0;
    this.perStreamHigh = null;
    this.perStreamLow = null;
    this.perStreamAvg = null;
    this.totalTokensDecoded = null;
    this.dsparkAcceptRatio = null;
    this.banksLive = null;
    this.banksTotal = null;
    this.kvPagesResident = null;
    this.prefillCached = null;
    this.prefillComputed = null;
    this.specDrafts = null;
    this.specHits = null;
    this.specQuench = null;
    this.warmRecords = null;
    this.derivedArtifacts = null;
    this.derivedArtifactBytes = null;
    this.requestsStarted = null;
    this.requestsCompleted = null;
    this.requestsFailed = null;
    this.requestsRefusedDeepSerial = null;
    this.requestsInflight = null;
    this.requestsSerial = null;
    this.contAdmitRejects = null;
    this.contBatchFailures = null;
    this.graphFitRefusals = null;
    this.admitsCold = null;
    this.admitsWarm = null;
    this.admitsFork = null;
    this.admitsPartialFork = null;
    this.admitsPartialTruncate = null;
    this.decodeSteps = null;
    this.tokPerStep = null;
    this.recipeMetadata = null;
    this.recipeInfo = null;
    this.reasoningEffort = null;
    this.reasoningEffortTs = null;
    this.activeContext = null;
    this.activeContextTs = null;
    this._ds4LogSizeCtx = 0;
    this._ds4LogSize = 0;
    this._ds4Prev = {
      tokensDecoded: null,
      decodeSteps: null,
      requestsStarted: null,
      requestsCompleted: null,
      prefillComputed: null,
      prefillCached: null,
      time: 0,
    };
    this._ds4Rolling = [];
    this.slotState.clear();
    this.lastTokenCounts = { input: 0, output: 0 };
    this._sglangStickyTps = null;
  }

  /** Note auth from an HTTP status on an unauthenticated probe request. */
  _noteAuthStatus(status) {
    if (status >= 200 && status < 300) {
      this.authOpen = true;
      return "ok";
    }
    if (status === 401 || status === 403) {
      this.authOpen = false;
      return "auth";
    }
    return "other";
  }

  // ─── Server type detection ───────────────────────────────
  async _detectServerType() {
    // Skip the llama.cpp /slots probe once we've positively identified an
    // OpenAI-compatible backend. vLLM / sglang / ds4-server have no /slots,
    // so re-probing it on every re-detect cycle just spams 404s in the
    // backend's access log (#15). Still probe /slots on first contact, when
    // the type is unknown, or when the backend was previously llama.cpp.
    if (
      this.backendType !== "vllm" &&
      this.backendType !== "sglang" &&
      this.backendType !== "ds4"
    ) {
      const slotUrl = `${this.baseUrl}/slots`;
      try {
        const slotRes = await this._fetch(slotUrl);
        const auth = this._noteAuthStatus(slotRes.status);
        if (auth === "ok") {
          const slots = await slotRes.json();
          if (Array.isArray(slots)) {
            this.serverIsOpenAI = false;
            this.backendType = "llama.cpp";
            return;
          }
        } else if (auth === "auth") {
          // Authenticated llama.cpp — treat as protected OpenAI-style for posture
          this.serverIsOpenAI = false;
          this.backendType = "llama.cpp";
          return;
        }
      } catch {}
    }

    // Try OpenAI-compatible (vLLM, SGLang, or ds4-server)
    try {
      const modelRes = await this._fetch(`${this.baseUrl}/v1/models`);
      const auth = this._noteAuthStatus(modelRes.status);
      if (auth === "ok" || auth === "auth") {
        this.serverIsOpenAI = true;
        let owned = null;
        if (auth === "ok") {
          try {
            const modelsData = await modelRes.json();
            owned = modelsData?.data?.[0]?.owned_by;
          } catch {
            /* body optional for detection */
          }
        }
        this.backendType = await this._classifyOpenAIBackend(owned);
        return;
      }
    } catch {}

    this.serverIsOpenAI = null;
    this.backendType = null;
  }

  // ─── DS4 engine path ─────────────────────────────────────
  async _probeDs4() {
    const now = Date.now();
    const dtSec = (now - this.lastProbeTime) / 1000;
    this.lastProbeTime = now;

    // Model info from /v1/models
    let modelsOk = false;
    try {
      const modelsRes = await this._fetch(`${this.baseUrl}/v1/models`);
      if (modelsRes.ok) {
        modelsOk = true;
        const modelsData = await modelsRes.json();
        const model = modelsData?.data?.[0];
        this.modelId = model?.id || null;
        this.contextLength = model?.context_length || null;
        this.recipeMetadata = {
          name: model?.id || null,
          model: model?.name || null,
          contextLength: model?.context_length || null,
          ownedBy: model?.owned_by || null,
          supportedParameters: model?.supported_parameters || [],
        };
      }
    } catch {}

    if (!modelsOk) {
      throw new Error("ds4 /v1/models unreachable");
    }

    // Parse /metrics
    try {
      const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
      if (metricsRes.ok) {
        const txt = await metricsRes.text();

        // Gauges
        this.ds4Uptime = this._getDs4Metric(txt, "ds4_uptime_seconds");
        this.generationTps = this._getDs4Metric(txt, "ds4_decode_tok_s") ?? 0;
        this.prefillTps = this._getDs4Metric(txt, "ds4_prefill_tok_s") ?? 0;
        this.dsparkAcceptRatio = this._getDs4Metric(txt, "ds4_spec_accept_ratio");
        this.tokPerStep = this._getDs4Metric(txt, "ds4_tok_per_step");
        this.banksLive = this._getDs4Metric(txt, "ds4_banks_live");
        this.banksTotal = this._getDs4Metric(txt, "ds4_banks_total");
        this.kvPagesResident = this._getDs4Metric(txt, "ds4_kv_pages_resident");
        this.warmRecords = this._getDs4Metric(txt, "ds4_warm_records");
        this.derivedArtifacts = this._getDs4Metric(txt, "ds4_derived_artifacts");
        this.derivedArtifactBytes = this._getDs4Metric(txt, "ds4_derived_artifact_bytes");
        this.requestsInflight = this._getDs4Metric(txt, "ds4_requests_inflight");

        // Counters
        this.totalTokensDecoded = this._getDs4Metric(txt, "ds4_tokens_decoded_total");
        this.decodeSteps = this._getDs4Metric(txt, "ds4_decode_steps_total");
        this.specDrafts = this._getDs4Metric(txt, "ds4_spec_drafts_total");
        this.specHits = this._getDs4Metric(txt, "ds4_spec_hits_total");
        this.specQuench = this._getDs4Metric(txt, "ds4_spec_quench_total");
        this.requestsStarted = this._getDs4Metric(txt, "ds4_requests_started_total");
        this.requestsSerial = this._getDs4Metric(txt, "ds4_requests_serial_total");
        this.contAdmitRejects = this._getDs4Metric(txt, "ds4_cont_admit_rejects_total");
        this.contBatchFailures = this._getDs4Metric(txt, "ds4_cont_batch_failures_total");
        this.graphFitRefusals = this._getDs4Metric(txt, "ds4_graph_fit_refusals_total");

        // Labeled counters
        this.requestsCompleted = this._getDs4LabeledMetric(txt, "ds4_requests_total", "outcome", "completed");
        this.requestsFailed = this._getDs4LabeledMetric(txt, "ds4_requests_total", "outcome", "failed");
        this.requestsRefusedDeepSerial = this._getDs4LabeledMetric(txt, "ds4_requests_total", "outcome", "refused_deep_serial");
        this.prefillCached = this._getDs4LabeledMetric(txt, "ds4_tokens_prefilled_total", "kind", "cached");
        this.prefillComputed = this._getDs4LabeledMetric(txt, "ds4_tokens_prefilled_total", "kind", "computed");
        this.admitsCold = this._getDs4LabeledMetric(txt, "ds4_admits_total", "kind", "cold");
        this.admitsWarm = this._getDs4LabeledMetric(txt, "ds4_admits_total", "kind", "warm");
        this.admitsFork = this._getDs4LabeledMetric(txt, "ds4_admits_total", "kind", "fork");
        this.admitsPartialFork = this._getDs4LabeledMetric(txt, "ds4_admits_total", "kind", "partial_fork");
        this.admitsPartialTruncate = this._getDs4LabeledMetric(txt, "ds4_admits_total", "kind", "partial_truncate");

        // Slots = banks_live (active lanes), slotsTotal = banks_total
        this.slotsActive = this.banksLive != null ? Math.round(this.banksLive) : 0;
        this.slotsTotal = this.banksTotal != null ? Math.round(this.banksTotal) : 0;
        this.requestsRunning = this.requestsInflight;

        // Total output tokens from decoded counter
        if (this.totalTokensDecoded != null) {
          this.totalOutputTokens = Math.round(this.totalTokensDecoded);
        }

        // Track peak aggregate tok/s
        const currentAggregate = this.generationTps;
        if (currentAggregate > this.peakAggregateTps) {
          this.peakAggregateTps = currentAggregate;
        }

        // Per-stream tracking: use banks_live as the number of active streams
        // When inflight > 0, per-stream = decode_tok_s / inflight
        const inflight = this.requestsInflight != null ? this.requestsInflight : 0;
        if (inflight > 0 && currentAggregate > 0) {
          const perStream = currentAggregate / inflight;
          if (this.perStreamHigh == null || perStream > this.perStreamHigh) {
            this.perStreamHigh = Math.round(perStream * 100) / 100;
          }
          if (this.perStreamLow == null || perStream < this.perStreamLow) {
            this.perStreamLow = Math.round(perStream * 100) / 100;
          }
          this.perStreamAvg = Math.round(perStream * 100) / 100;
        }

        // MTP/spec acceptance — use ds4_spec_accept_ratio as the gauge
        this.mtpAcceptanceRate = this.dsparkAcceptRatio;
        this.mtpAcceptedTokens = this.specHits;
        this.mtpDraftedTokens = this.specDrafts;

        // ── Derive latency, genTokensPerReq, and rolling averages from
        //    ds4 counter deltas (ds4 has no latency histograms, so we
        //    approximate from throughput + completed-request counts). ──
        const nowMs = Date.now();
        const prev = this._ds4Prev;
        const dt = prev.time > 0 ? (nowMs - prev.time) / 1000 : 0;

        const deltaDecoded =
            this.totalTokensDecoded != null && prev.tokensDecoded != null
                ? Math.max(0, this.totalTokensDecoded - prev.tokensDecoded)
                : 0;
        const deltaSteps =
            this.decodeSteps != null && prev.decodeSteps != null
                ? Math.max(0, this.decodeSteps - prev.decodeSteps)
                : 0;
        const deltaStarted =
            this.requestsStarted != null && prev.requestsStarted != null
                ? Math.max(0, this.requestsStarted - prev.requestsStarted)
                : 0;
        const deltaCompleted =
            this.requestsCompleted != null && prev.requestsCompleted != null
                ? Math.max(0, this.requestsCompleted - prev.requestsCompleted)
                : 0;
        const deltaPrefillComputed =
            this.prefillComputed != null && prev.prefillComputed != null
                ? Math.max(0, this.prefillComputed - prev.prefillComputed)
                : 0;

        // Per-request average tokens (generation) — if requests completed
        // this cycle, avg tokens per request = deltaDecoded / deltaCompleted.
        // Fallback to cumulative if we have totals.
        if (deltaCompleted > 0) {
          this.genTokensPerReq =
              Math.round((deltaDecoded / deltaCompleted) * 100) / 100;
        } else if (this.requestsCompleted != null && this.requestsCompleted > 0) {
          this.genTokensPerReq =
              Math.round((this.totalTokensDecoded / this.requestsCompleted) * 100) / 100;
        }

        // Approximate TTFT: prefill time for the average request.
        // Use counter-based prefill rate (deltaPrefillComputed / dt) instead of
        // the instantaneous prefillTps gauge, which is near-zero between bursts.
        const prefillRate = dt > 0 && deltaPrefillComputed > 0
            ? deltaPrefillComputed / dt
            : this.prefillTps;
        if (deltaCompleted > 0 && deltaPrefillComputed > 0 && prefillRate > 0) {
          const avgPromptTokens = deltaPrefillComputed / deltaCompleted;
          this.ttft = Math.round((avgPromptTokens / prefillRate) * 1000) / 1000;
          this.ttftP95Seconds = this.ttft; // best estimate (no histogram)
        }

        // Approximate E2E: TTFT + decode time for avg request.
        // decode time ≈ avgGenTokens / decodeRate, where decodeRate = generationTps / inflight.
        if (deltaCompleted > 0 && this.genTokensPerReq != null && this.genTokensPerReq > 0) {
          const inflight = this.requestsInflight != null ? Math.max(1, this.requestsInflight) : 1;
          const decodeRate = this.generationTps > 0 ? this.generationTps / inflight : 0;
          const ttftEst = this.ttft ?? 0;
          if (decodeRate > 0) {
            const decodeTime = this.genTokensPerReq / decodeRate;
            this.e2eLatency = Math.round((ttftEst + decodeTime) * 1000) / 1000;
            this.e2eP95Seconds = this.e2eLatency;
          } else {
            this.e2eLatency = Math.round(ttftEst * 1000) / 1000;
            this.e2eP95Seconds = this.e2eLatency;
          }
        }

        // ── Rolling window: last 10 completed-request batches ──
        if (deltaCompleted > 0 && this.e2eLatency != null) {
          const activeSlots = this.banksLive != null ? Math.max(1, this.banksLive) : 1;
          const tpsPerSlot = dt > 0 && this.generationTps > 0
              ? this.generationTps / activeSlots
              : 0;
          const tokensPerReq = (deltaPrefillComputed + deltaDecoded) / deltaCompleted;

          this._ds4Rolling.push({
            e2e: this.e2eLatency,
            ttft: this.ttft ?? 0,
            tokens: tokensPerReq,
            tpsPerSlot: Math.round(tpsPerSlot * 100) / 100,
          });
          if (this._ds4Rolling.length > 10) {
            this._ds4Rolling = this._ds4Rolling.slice(-10);
          }
        }

        // Compute rolling averages
        if (this._ds4Rolling.length > 0) {
          const n = this._ds4Rolling.length;
          let sumE2e = 0, sumTtft = 0, sumTokens = 0, sumTps = 0;
          for (const r of this._ds4Rolling) {
            sumE2e += r.e2e;
            sumTtft += r.ttft;
            sumTokens += r.tokens;
            sumTps += r.tpsPerSlot;
          }
          this.rollingAvgE2e = Math.round((sumE2e / n) * 1000) / 1000;
          this.rollingAvgTtft = Math.round((sumTtft / n) * 1000) / 1000;
          this.rollingAvgTokensPerReq = Math.round((sumTokens / n) * 100) / 100;
          this.rollingAvgTpsPerSlot = Math.round((sumTps / n) * 100) / 100;
        }

        // Aggregate decode TPS alias
        this.aggregateDecodeTps = this.generationTps;

        // Save state for next cycle
        this._ds4Prev = {
          tokensDecoded: this.totalTokensDecoded,
          decodeSteps: this.decodeSteps,
          requestsStarted: this.requestsStarted,
          requestsCompleted: this.requestsCompleted,
          prefillComputed: this.prefillComputed,
          prefillCached: this.prefillCached,
          time: nowMs,
        };
      }
    } catch {}

    this.backendType = "ds4";
    this._tailDs4LogForReasoningEffort();
    this._tailDs4LogForActiveContext();
    await this._collectRecipeInfo();
    return this._getSnapshot();
  }

  // ─── DS4 reasoning effort log tailing ──────────────────
  /**
   * Tail the ds4 log file for reasoning_effort entries.
   * The ds4 engine may log "reasoning_effort" or "effort=low|medium|high"
   * in request lines. We scan new bytes since last read.
   */
  _tailDs4LogForReasoningEffort() {
    try {
      const stat = statSync(DS4_LOG_PATH);
      if (!stat.isFile()) return;
      const currentSize = stat.size;
      // File was truncated or rotated — reset
      if (currentSize < this._ds4LogSize) {
        this._ds4LogSize = 0;
      }
      // No new bytes
      if (currentSize === this._ds4LogSize) return;

      const fd = openSync(DS4_LOG_PATH, "r");
      try {
        const buf = Buffer.alloc(Math.min(currentSize - this._ds4LogSize, 512 * 1024));
        const bytesRead = readSync(fd, buf, 0, buf.length, this._ds4LogSize);
        this._ds4LogSize = currentSize;
        if (bytesRead <= 0) return;

        const text = buf.subarray(0, bytesRead).toString("utf8");

        // Match patterns like:
        //   reasoning_effort=low
        //   reasoning_effort: medium
        //   "reasoning_effort":"high"
        //   effort=low
        const re = /reasoning_effort["'\s:=]+(\w+)|effort[=\s]+(low|medium|high)/gi;
        let m;
        let lastEffort = null;
        while ((m = re.exec(text)) !== null) {
          const val = (m[1] || m[2] || "").toLowerCase();
          if (val === "low" || val === "medium" || val === "high") {
            lastEffort = val;
          }
        }
        if (lastEffort) {
          this.reasoningEffort = lastEffort;
          this.reasoningEffortTs = Date.now();
        }
      } finally {
        closeSync(fd);
      }
    } catch {}
  }

  // ─── DS4 active context log tailing ─────────────────────
  /**
   * Tail the ds4 log file for active context size entries.
   * ds4 logs lines like:
   *   chat ctx=0..54515:54515 TOOLS prompt start
   *   chat ctx=0..69306:69306 TOOLS prompt start
   * The number after the last colon is the total context tokens in that request.
   * We scan new bytes since last read (shared with reasoning-effort tailing).
   */
  _tailDs4LogForActiveContext() {
    try {
      const stat = statSync(DS4_LOG_PATH);
      if (!stat.isFile()) return;
      const currentSize = stat.size;
      // File was truncated or rotated — reset
      if (currentSize < this._ds4LogSizeCtx) {
        this._ds4LogSizeCtx = 0;
      }
      // No new bytes
      if (currentSize === this._ds4LogSizeCtx) return;

      const fd = openSync(DS4_LOG_PATH, "r");
      try {
        const buf = Buffer.alloc(Math.min(currentSize - this._ds4LogSizeCtx, 512 * 1024));
        const bytesRead = readSync(fd, buf, 0, buf.length, this._ds4LogSizeCtx);
        this._ds4LogSizeCtx = currentSize;
        if (bytesRead <= 0) return;

        const text = buf.subarray(0, bytesRead).toString("utf8");

        // Match patterns like:
        //   chat ctx=0..54515:54515 TOOLS prompt start
        //   chat ctx=0..69306:69306 TOOLS prompt start
        // Capture the number after the last colon.
        const re = /ctx=0\.\.(\d+):(\d+)/g;
        let m;
        let lastCtx = null;
        while ((m = re.exec(text)) !== null) {
          const val = parseInt(m[2], 10);
          if (Number.isFinite(val) && val > 0) {
            lastCtx = val;
          }
        }

        // Fallback: parse "warm admit bank=N cached=C suffix=S" lines where
        // the total context tokens = cached + suffix. This covers the common
        // case where the ctx=0..N:N pattern hasn't been emitted (non-tools
        // requests). We take the most recent warm-admit as the active context.
        if (lastCtx == null) {
          const reWarm = /warm admit bank=\d+ cached=(\d+) suffix=(\d+)/g;
          let mw;
          while ((mw = reWarm.exec(text)) !== null) {
            const cached = parseInt(mw[1], 10);
            const suffix = parseInt(mw[2], 10);
            const total = cached + suffix;
            if (Number.isFinite(total) && total > 0) {
              lastCtx = total;
            }
          }
        }

        if (lastCtx != null) {
          this.activeContext = lastCtx;
          this.activeContextTs = Date.now();
        }
      } finally {
        closeSync(fd);
      }
    } catch {}
  }

  // ─── OpenAI-compatible path (vLLM/sglang) ────────────────
  /**
   * Classify an OpenAI-compatible server: ds4-server, SGLang, or vLLM (default).
   * @param {unknown} ownedBy
   * @returns {Promise<"ds4" | "sglang" | "vllm">}
   */
  async _classifyOpenAIBackend(ownedBy) {
    if (typeof ownedBy === "string") {
      if (/ds4/i.test(ownedBy)) return "ds4";
      if (/sglang/i.test(ownedBy)) return "sglang";
    }
    if (await this._probeIsDs4()) return "ds4";
    if (await this._probeIsSglang()) return "sglang";
    return "vllm";
  }

  /** True when SGLang native server-info endpoints respond. */
  async _probeIsSglang() {
    for (const path of ["/get_server_info", "/server_info"]) {
      try {
        const res = await this._fetch(`${this.baseUrl}${path}`);
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        if (data && typeof data === "object" && !Array.isArray(data)) return true;
      } catch {
        /* try next */
      }
    }
    return false;
  }

  /** True when Prometheus /metrics exposes ds4-server series (ds4-on-spark). */
  async _probeIsDs4() {
    try {
      const res = await this._fetch(`${this.baseUrl}/metrics`);
      if (!res.ok) return false;
      const txt = await res.text();
      return LlmProbe._metricsLookLikeDs4(txt);
    } catch {
      return false;
    }
  }

  /** @param {string} body */
  static _metricsLookLikeDs4(body) {
    return /(?:^|\n)ds4_tokens_decoded_total(?:\{|\s)/m.test(String(body || ""));
  }

  // ─── OpenAI-compatible path (vLLM/sglang/ds4) ────────────
  async _probeOpenAICompatible() {
    const now = Date.now();
    const dtSec = (now - this.lastProbeTime) / 1000;
    this.lastProbeTime = now;

    // Model info from /v1/models — 401/403 means protected; other failure = down
    let modelsOk = false;
    let owned = null;
    try {
      const modelsRes = await this._fetch(`${this.baseUrl}/v1/models`);
      const auth = this._noteAuthStatus(modelsRes.status);
      if (auth === "auth") {
        return this._getSnapshot();
      }
      if (auth === "ok") {
        modelsOk = true;
        const modelsData = await modelsRes.json();
        const model = modelsData?.data?.[0];
        this.modelId = normalizeModelId(model?.id || null);
        // Drop HF hub cache paths from modelPath if /v1/models id was a cache dir
        if (isHfHubCachePath(model?.id)) this.modelPath = null;
        // ds4-server uses context_length; vLLM uses max_model_len
        this.contextLength =
          model?.max_model_len ?? model?.context_length ?? this.contextLength;
        owned = model?.owned_by;
      }
    } catch {}

    if (!modelsOk) {
      throw new Error("OpenAI-compatible /v1/models unreachable");
    }

    // Self-heal backend from owned_by before branching (cheap, no extra HTTP)
    if (typeof owned === "string") {
      if (/ds4/i.test(owned)) this.backendType = "ds4";
      else if (/sglang/i.test(owned) && this.backendType !== "ds4") {
        this.backendType = "sglang";
      }
    }

    // SGLang: native info endpoints. Skip on known vLLM/ds4 to avoid 404 spam.
    if (this.backendType === "sglang" || this.backendType == null) {
      try {
        const sgRes = await this._fetch(`${this.baseUrl}/get_server_info`);
        if (sgRes.ok) {
          this.backendType = "sglang";
          const sgData = await sgRes.json();
          this._applySglangServerInfo(sgData, dtSec);
        }
      } catch {}
    }

    if (this.backendType === "sglang") {
      // Optional Prometheus path when launched with --enable-metrics
      if (this.generationTps === 0 && this.prefillTps === 0) {
        try {
          const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
          if (metricsRes.ok) {
            this._applySglangMetrics(await metricsRes.text(), dtSec);
          }
        } catch {
          /* metrics optional */
        }
      }
      await this._enrichSglangModelInfo();
      await this._collectRecipeInfo();
      console.log("[sglang-recipe] final recipeInfo=", JSON.stringify(this.recipeInfo));
      return this._getSnapshot();
    }

    // Single /metrics fetch: ds4-server or vLLM Prometheus exposition
    try {
      const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
      if (metricsRes.ok) {
        const txt = await metricsRes.text();
        if (
          this.backendType === "ds4" ||
          LlmProbe._metricsLookLikeDs4(txt)
        ) {
          this.backendType = "ds4";
          this._applyDs4Metrics(txt, dtSec);
        } else {
          this.backendType = "vllm";
          this._applyVllmMetrics(txt, dtSec);
        }
      } else if (this.backendType !== "ds4") {
        this.backendType = "vllm";
      }
    } catch {
      if (this.backendType !== "ds4") this.backendType = "vllm";
    }
    if (this.backendType === "vllm" || this.backendType === "sglang") await this._collectRecipeInfo();

    return this._getSnapshot();
  }

  /**
   * Apply ds4-server Prometheus /metrics (Entrpi/ds4-on-spark).
   * Live tok/s from counter diffs (same as vLLM) so idle → 0. The engine's
   * `ds4_decode_tok_s` / `ds4_prefill_tok_s` gauges are ~60s windows and stay
   * non-zero long after requests finish — do not use them for the live panel.
   * @param {string} txt
   * @param {number} dtSec
   */
  _applyDs4Metrics(txt, dtSec) {
    const decoded = this._getPromMetric(txt, "ds4_tokens_decoded_total");
    const prefilled = this._getPromMetric(txt, "ds4_tokens_prefilled_total");

    if (decoded != null) {
      if (prefilled != null && dtSec > 0 && dtSec < 10) {
        const deltaIn = prefilled - this.lastTokenCounts.input;
        const deltaOut = decoded - this.lastTokenCounts.output;
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
        this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
      } else if (dtSec > 0 && dtSec < 10) {
        const deltaOut = decoded - this.lastTokenCounts.output;
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
      }
      if (prefilled != null) this.lastTokenCounts.input = prefilled;
      this.lastTokenCounts.output = decoded;
      this.totalOutputTokens = decoded;
    } else {
      // No counters — fall back to window gauges only while something is in flight
      const inflightHint = this._getPromMetric(txt, "ds4_requests_inflight");
      const gaugeGen = this._getPromMetric(txt, "ds4_decode_tok_s");
      const gaugePrefill = this._getPromMetric(txt, "ds4_prefill_tok_s");
      if (inflightHint != null && inflightHint > 0) {
        if (gaugeGen != null) {
          this.generationTps = Math.max(0, Math.round(gaugeGen * 100) / 100);
        }
        if (gaugePrefill != null) {
          this.prefillTps = Math.max(0, Math.round(gaugePrefill * 100) / 100);
        }
      } else {
        this.generationTps = 0;
        this.prefillTps = 0;
      }
    }

    const inflight = this._getPromMetric(txt, "ds4_requests_inflight");
    this.requestsRunning = inflight;
    if (inflight != null) this.slotsActive = Math.round(inflight);

    const banksTotal = this._getPromMetric(txt, "ds4_banks_total");
    if (banksTotal != null) this.slotsTotal = Math.round(banksTotal);

    const specAccept = this._getPromMetric(txt, "ds4_spec_accept_ratio");
    this.mtpAcceptanceRate =
      specAccept != null ? Math.round(specAccept * 10000) / 10000 : null;

    // Prefix-cache hit rate from prefill kind labels (cached / (computed+cached))
    const cached = this._getPromMetricLabeled(
      txt,
      "ds4_tokens_prefilled_total",
      "kind",
      "cached"
    );
    const computed = this._getPromMetricLabeled(
      txt,
      "ds4_tokens_prefilled_total",
      "kind",
      "computed"
    );
    if (cached != null && computed != null) {
      const total = cached + computed;
      this.prefixCacheHitRate =
        total > 0 ? Math.round((cached / total) * 10000) / 10000 : null;
    } else {
      this.prefixCacheHitRate = null;
    }

    // Clear tiles that are vLLM-histogram-specific (no ds4 equivalent yet)
    this.kvCacheUsage = null;
    this.requestsWaiting = null;
    this.ttftP95Seconds = null;
    this.preemptionsTotal = null;
    this.e2eP95Seconds = null;
    this.itlP95Seconds = null;
  }

  /**
   * Apply stock vLLM Prometheus /metrics (tok/s + inference tiles).
   * @param {string} txt
   * @param {number} dtSec
   */
  _applyVllmMetrics(txt, dtSec) {
    const promptTokens = this._getVllmMetric(txt, "prompt_tokens_total");
    const genTokens = this._getVllmMetric(txt, "generation_tokens_total");
    if (promptTokens != null && genTokens != null) {
      const deltaIn = promptTokens - this.lastTokenCounts.input;
      const deltaOut = genTokens - this.lastTokenCounts.output;
      this.lastTokenCounts.input = promptTokens;
      this.lastTokenCounts.output = genTokens;
      this.totalOutputTokens = genTokens;
      if (dtSec > 0 && dtSec < 10) {
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
        this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
      }
    }

    const running = this._getVllmMetric(txt, "num_requests_running");
    this.requestsRunning = running;
    if (running != null) this.slotsActive = Math.round(running);

    if (this.gpuMemoryUtilization == null) {
      const sleepState = this._getVllmMetric(txt, "engine_sleep_state");
      if (sleepState != null) this.gpuMemoryUtilization = sleepState;
    }

    this.requestsWaiting = this._getVllmMetric(txt, "num_requests_waiting");
    this.kvCacheUsage = this._getVllmMetric(txt, "kv_cache_usage_perc");
    this.preemptionsTotal = this._getVllmMetric(txt, "num_preemptions_total");

    const ttftHist = this._parseVllmHistogram(txt, "vllm:time_to_first_token_seconds");
    const ttftP95 = this._histogramQuantile(ttftHist.buckets, ttftHist.total, 0.95);
    this.ttftP95Seconds = ttftP95 == null ? null : Math.round(ttftP95 * 1000) / 1000;

    const e2eHist = this._parseVllmHistogram(txt, "vllm:e2e_request_latency_seconds");
    const e2eP95 = this._histogramQuantile(e2eHist.buckets, e2eHist.total, 0.95);
    this.e2eP95Seconds = e2eP95 == null ? null : Math.round(e2eP95 * 1000) / 1000;

    const itlHist = this._parseVllmHistogram(txt, "vllm:inter_token_latency_seconds");
    const itlP95 = this._histogramQuantile(itlHist.buckets, itlHist.total, 0.95);
    this.itlP95Seconds = itlP95 == null ? null : Math.round(itlP95 * 1000) / 1000;

    const prefixHits = this._getVllmMetric(txt, "prefix_cache_hits_total");
    const prefixQueries = this._getVllmMetric(txt, "prefix_cache_queries_total");
    this.prefixCacheHitRate =
      prefixHits != null && prefixQueries != null && prefixQueries > 0
        ? Math.round((prefixHits / prefixQueries) * 10000) / 10000
        : null;

    const mtpAccepted = this._getVllmMetric(txt, "spec_decode_num_accepted_tokens_total");
    const mtpDrafted = this._getVllmMetric(txt, "spec_decode_num_draft_tokens_total");
    this.mtpAcceptanceRate =
      mtpAccepted != null && mtpDrafted != null && mtpDrafted > 0
        ? Math.round((mtpAccepted / mtpDrafted) * 10000) / 10000
        : null;
  }

  /**
   * Apply SGLang /get_server_info.
   * Older builds expose total_input_tokens / total_output_tokens.
   * Current builds (metrics often off) expose sticky last_gen_throughput under
   * internal_states[i]. Only treat it as live after the value changes between
   * polls, then expire to 0 when it stops moving (idle leftover).
   * @param {Record<string, unknown>} sgData
   * @param {number} dtSec
   */
  _applySglangServerInfo(sgData, dtSec) {
    // Prefer true max context (context_length / max_total_tokens). Do NOT use
    // max_total_num_tokens — that is the KV-cache pool budget across concurrent
    // sequences and is often ~2× the configured context (showed 2.1M for a 1M run).
    const explicitCtx =
      LlmProbe._positiveNumber(sgData.context_length) ??
      LlmProbe._positiveNumber(sgData.max_total_tokens);
    if (explicitCtx != null) {
      this.contextLength = explicitCtx;
    } else if (this.contextLength == null) {
      this.contextLength =
        LlmProbe._positiveNumber(sgData.max_req_input_len) ??
        LlmProbe._positiveNumber(sgData.max_total_num_tokens) ??
        null;
    }

    if (sgData.model_path) {
      applyModelRef(this, sgData.model_path);
    }

    const maxRunning = Number(sgData.max_running_requests);
    if (Number.isFinite(maxRunning) && maxRunning > 0) {
      this.slotsTotal = Math.round(maxRunning);
    }

    const inTok = sgData.total_input_tokens;
    const outTok = sgData.total_output_tokens;
    if (inTok != null && outTok != null) {
      const input = Number(inTok);
      const output = Number(outTok);
      if (Number.isFinite(input) && Number.isFinite(output)) {
        const deltaIn = input - this.lastTokenCounts.input;
        const deltaOut = output - this.lastTokenCounts.output;
        this.lastTokenCounts.input = input;
        this.lastTokenCounts.output = output;
        this.totalOutputTokens = output;
        if (dtSec > 0 && dtSec < 10) {
          this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
          this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
        }
        return;
      }
    }

    // No cumulative counters — sticky last_gen_throughput only while it moves
    const lastGen = LlmProbe._sglangLastGenThroughput(sgData);
    this.generationTps = this._sglangStickyThroughput(lastGen);
  }

  /**
   * Map SGLang's sticky last_gen_throughput gauge to a live panel rate.
   * Returns 0 until the value changes between polls (avoids showing a stale
   * leftover after idle); stays live for a short window after each change.
   * @param {number | null} raw
   * @returns {number}
   */
  _sglangStickyThroughput(raw) {
    if (raw == null || !Number.isFinite(raw) || raw < 0) {
      this._sglangStickyTps = null;
      return 0;
    }
    const rounded = Math.round(raw * 100) / 100;
    const now = Date.now();
    const prev = this._sglangStickyTps;

    if (!prev) {
      // First sample after reset/start — seed only; do not display stale gauge
      this._sglangStickyTps = { value: rounded, liveUntil: 0 };
      return 0;
    }

    if (rounded !== prev.value) {
      this._sglangStickyTps = {
        value: rounded,
        liveUntil: now + SGLANG_STICKY_TPS_LIVE_MS,
      };
      return rounded;
    }

    if (prev.liveUntil > now) {
      return rounded;
    }
    return 0;
  }

  /**
   * @param {unknown} v
   * @returns {number | null}
   */
  static _positiveNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * Max last_gen_throughput across internal_states (or top-level).
   * @param {Record<string, unknown>} sgData
   * @returns {number | null}
   */
  static _sglangLastGenThroughput(sgData) {
    if (!sgData || typeof sgData !== "object") return null;
    const top = Number(sgData.last_gen_throughput);
    if (Number.isFinite(top) && top >= 0) return top;

    const states = sgData.internal_states;
    if (!Array.isArray(states) || !states.length) return null;
    let best = null;
    for (const st of states) {
      if (!st || typeof st !== "object") continue;
      const v = Number(st.last_gen_throughput);
      if (!Number.isFinite(v) || v < 0) continue;
      if (best == null || v > best) best = v;
    }
    return best;
  }

  /**
   * Apply SGLang Prometheus /metrics (--enable-metrics).
   * Supports both `sglang:` and `sglang_` prefixes.
   * @param {string} txt
   * @param {number} dtSec
   */
_applySglangMetrics(txt, dtSec) {
    const gen =
      this._getPromMetric(txt, "sglang:generation_tokens_total") ??
      this._getPromMetric(txt, "sglang_generation_tokens_total");
    const prompt =
      this._getPromMetric(txt, "sglang:prompt_tokens_total") ??
      this._getPromMetric(txt, "sglang_prompt_tokens_total");
    if (gen == null) {
      const gauge =
        this._getPromMetric(txt, "sglang:gen_throughput") ??
        this._getPromMetric(txt, "sglang_gen_throughput");
      if (gauge != null) {
        this.generationTps = Math.max(0, Math.round(gauge * 100) / 100);
      }
    } else {
      if (dtSec > 0 && dtSec < 10) {
        const deltaOut = gen - this.lastTokenCounts.output;
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
        if (prompt != null) {
          const deltaIn = prompt - this.lastTokenCounts.input;
          this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
          this.lastTokenCounts.input = prompt;
        }
      }
      this.lastTokenCounts.output = gen;
      this.totalOutputTokens = gen;
      this.totalTokensDecoded = gen;
    }

    // Peak aggregate tok/s = max of gen_throughput over poll history
    const gt = this._getPromMetric(txt, "sglang:gen_throughput");
    if (gt != null) {
      this.generationTps = Math.max(0, Math.round(gt * 100) / 100);
      if (this.peakAggregateTps == null || this.generationTps > this.peakAggregateTps) {
        this.peakAggregateTps = this.generationTps;
      }
    }

    const running =
      this._getPromMetric(txt, "sglang:num_running_reqs") ??
      this._getPromMetric(txt, "sglang_num_running_reqs");
    if (running != null) {
      this.requestsRunning = running;
      this.slotsActive = Math.round(running);
      this.requestsInflight = Math.round(running);
      this.banksLive = Math.round(running);
    }
    const waiting =
      this._getPromMetric(txt, "sglang:num_queue_reqs") ??
      this._getPromMetric(txt, "sglang_num_queue_reqs");
    if (waiting != null) this.requestsWaiting = waiting;

    // In-flight HTTP requests
    const httpActive = this._getPromMetricLabeled(txt, "sglang:http_requests_active", "method", "POST");
    if (httpActive != null) this.requestsInflight = Math.round(httpActive);

    // KV cache usage (0..1 fraction of pool used)
    const kvUsed = this._getPromMetric(txt, "sglang:token_usage");
    if (kvUsed != null) this.kvCacheUsage = kvUsed;

    // Prefix cache hit rate
    const hit = this._getPromMetric(txt, "sglang:cache_hit_rate");
    if (hit != null) this.prefixCacheHitRate = hit;

    // Context length
    const ctx = this._getPromMetric(txt, "sglang:context_len");
    if (ctx != null) this.contextLength = ctx;

    // Active context size (tokens in KV cache)
    const usedTokens = this._getPromMetric(txt, "sglang:num_used_tokens");
    if (usedTokens != null) this.activeContext = Math.round(usedTokens);

    // Speculative decode acceptance rate (DFlash/MTP)
    const acceptRate = this._getPromMetric(txt, "sglang:spec_accept_rate");
    if (acceptRate != null) this.mtpAcceptanceRate = acceptRate;
    const drafted = this._getPromMetric(txt, "sglang:spec_num_draft_tokens");
    if (drafted != null) this.mtpDraftedTokens = Math.round(drafted);
    const accepted = this._getPromMetric(txt, "sglang:spec_accept_length");
    if (accepted != null) this.mtpAcceptedTokens = Math.round(accepted);

    // Tok/step = sum of seq lens in decode batch
    const decodeSum = this._getPromMetric(txt, "sglang:decode_sum_seq_lens");
    if (decodeSum != null) this.tokPerStep = decodeSum;

    // Decode steps = spec verify calls (counter)
    const verifyCalls = this._getPromMetric(txt, "sglang:spec_verify_calls_total");
    if (verifyCalls != null) this.decodeSteps = Math.round(verifyCalls);

    // Prefill cached vs computed
    const prefillCached = this._getPromMetricLabeled(txt, "sglang:realtime_tokens_total", "mode", "prefill_cache");
    if (prefillCached != null) this.prefillCached = Math.round(prefillCached);
    const prefillComputed = this._getPromMetricLabeled(txt, "sglang:realtime_tokens_total", "mode", "prefill_compute");
    if (prefillComputed != null) this.prefillComputed = Math.round(prefillComputed);

    // Requests started / completed
    const reqsStarted = this._getPromMetric(txt, "sglang:num_requests_total");
    if (reqsStarted != null) this.requestsStarted = Math.round(reqsStarted);
    const reqsCompleted = this._getPromMetric(txt, "sglang:http_responses_total");
    if (reqsCompleted != null) this.requestsCompleted = Math.round(reqsCompleted);

    // TTFT histogram -> P95 + rolling avg
    const ttftHist = this._parseSglangHistogram(txt, "sglang:time_to_first_token_seconds");
    if (ttftHist && ttftHist.total > 0) {
      const p95 = this._histogramQuantile(ttftHist.buckets, ttftHist.total, 0.95);
      if (p95 != null) this.ttftP95Seconds = Math.round(p95 * 1000) / 1000;
      const avg = ttftHist.sum / ttftHist.total;
      this.rollingAvgTtft = Math.round(avg * 1000) / 1000;
      this.ttft = this.rollingAvgTtft;
    }

    // E2E latency histogram -> P95 + rolling avg
    const e2eHist = this._parseSglangHistogram(txt, "sglang:e2e_request_latency_seconds");
    if (e2eHist && e2eHist.total > 0) {
      const p95 = this._histogramQuantile(e2eHist.buckets, e2eHist.total, 0.95);
      if (p95 != null) this.e2eP95Seconds = Math.round(p95 * 1000) / 1000;
      const avg = e2eHist.sum / e2eHist.total;
      this.rollingAvgE2e = Math.round(avg * 1000) / 1000;
      this.e2eLatency = this.rollingAvgE2e;
    }

    // Inter-token latency histogram -> P95
    const itlHist = this._parseSglangHistogram(txt, "sglang:inter_token_latency_seconds");
    if (itlHist && itlHist.total > 0) {
      const p95 = this._histogramQuantile(itlHist.buckets, itlHist.total, 0.95);
      if (p95 != null) this.itlP95Seconds = Math.round(p95 * 1000) / 1000;
    }

    // Tokens per request (generation tokens histogram)
    const genHist = this._parseSglangHistogram(txt, "sglang:generation_tokens_histogram");
    if (genHist && genHist.total > 0) {
      this.genTokensPerReq = Math.round(genHist.sum / genHist.total);
      this.rollingAvgTokensPerReq = this.genTokensPerReq;
    }

    if (this.slotsActive > 0 && this.generationTps > 0) {
      this.rollingAvgTpsPerSlot = Math.round((this.generationTps / this.slotsActive) * 100) / 100;
    }
  }

  _parseSglangHistogram(body, metricPrefix) {
    const esc = metricPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bucketRe = new RegExp(
      "^" + esc + "_bucket\\{[^}]*\\ble=\"([^\"]+)\"[^}]*\\}\\s+([\\d.eE+-]+)\\s*$",
      "gm"
    );
    const buckets = [];
    let m;
    while ((m = bucketRe.exec(body)) !== null) {
      const upper = m[1] === "+Inf" ? Infinity : parseFloat(m[1]);
      const count = parseFloat(m[2]);
      if (Number.isFinite(upper) && Number.isFinite(count)) {
        buckets.push({ upper, count });
      }
    }
    if (buckets.length === 0) return null;
    buckets.sort((a, b) => a.upper - b.upper);
    const total = buckets[buckets.length - 1].count;
    const sumRe = new RegExp("^" + esc + "_sum\\{[^}]*\\}\\s+([\\d.eE+-]+)\\s*$", "gm");
    let sum = 0;
    while ((m = sumRe.exec(body)) !== null) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v)) sum += v;
    }
    return { buckets, total, sum };
  }

  /** Prefer SGLang /get_model_info (or /model_info) over raw HF cache paths. */
  async _enrichSglangModelInfo() {
    for (const path of ["/get_model_info", "/model_info"]) {
      try {
        const res = await this._fetch(`${this.baseUrl}${path}`);
        if (!res.ok) continue;
        const data = await res.json();
        const raw = data?.model_path || data?.tokenizer_path;
        if (!raw) continue;
        applyModelRef(this, raw);
        return;
      } catch {
        /* try next */
      }
    }
  }

  // ─── llama.cpp native path ────────────────────────────────
  async _probeLlamaCpp() {
    const now = Date.now();
    const dtSec = (now - this.lastProbeTime) / 1000;
    this.lastProbeTime = now;

    let slotsOk = false;
    try {
      const slotsRes = await this._fetch(`${this.baseUrl}/slots`);
      const auth = this._noteAuthStatus(slotsRes.status);
      if (auth === "auth") {
        return this._getSnapshot();
      }
      if (auth === "ok") {
        const slots = await slotsRes.json();
        if (Array.isArray(slots)) {
          slotsOk = true;
          this.slotsTotal = slots.length;
          this.slotsActive = slots.filter((s) => s.is_processing || (s.state && s.state !== "idle")).length;

          let totalGen = 0;
          let totalPrefill = 0;
          let totalDecoded = 0;

          for (const slot of slots) {
            const slotId = slot.id ?? "default";
            const decoded = this._getSlotDecoded(slot);
            const prompted = this._getSlotPrefilled(slot);
            totalDecoded += decoded;
            const lastState = this.slotState.get(slotId) || { decoded: 0, prompted: 0 };
            const dDecoded = decoded - lastState.decoded;
            const dPrompted = prompted - lastState.prompted;
            this.slotState.set(slotId, { decoded, prompted });
            if (dtSec > 0 && dtSec < 10) {
              totalGen += dDecoded / dtSec;
              totalPrefill += dPrompted / dtSec;
            }
          }

          this.totalOutputTokens = totalDecoded;
          this.generationTps = Math.max(0, Math.round(totalGen * 100) / 100);
          this.prefillTps = Math.max(0, Math.round(totalPrefill * 100) / 100);
        }
      }
    } catch {}

    if (!slotsOk) {
      throw new Error("llama.cpp /slots unreachable");
    }

    try {
      const propsRes = await this._fetch(`${this.baseUrl}/props`);
      if (propsRes.ok) {
        const props = await propsRes.json();
        const raw = props.model_alias || props.model_path || this.modelId;
        if (props.model_path && !isHfHubCachePath(props.model_path)) {
          this.modelPath = props.model_path;
        } else if (isHfHubCachePath(props.model_path) || isHfHubCachePath(props.model_alias)) {
          this.modelPath = null;
        }
        if (raw) this.modelId = normalizeModelId(raw);
        this.contextLength = props.total_context_length || props.context_length || this.contextLength;
      }
    } catch {}

    this.backendType = "llama.cpp";
    return this._getSnapshot();
  }

  // ─── DS4 metrics helpers ──────────────────────────────────
  /** Extract a plain ds4_* gauge/counter (sum across all label permutations). */
  _getDs4Metric(body, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${esc}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)\\s*$`, "gm");
    let sum = 0;
    let found = false;
    let m;
    while ((m = re.exec(body)) !== null) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v)) {
        sum += v;
        found = true;
      }
    }
    return found ? sum : null;
  }

  /** Extract a labeled ds4_* counter for a specific label=value pair. */
  _getDs4LabeledMetric(body, name, label, value) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const labelEsc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const valueEsc = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `^${esc}\\{[^}]*\\b${labelEsc}="${valueEsc}"[^}]*\\}\\s+([\\d.eE+-]+)\\s*$`,
      "gm"
    );
    let m;
    while ((m = re.exec(body)) !== null) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v)) return v;
    }
    return null;
  }

  // ─── vLLM metrics helpers ─────────────────────────────
  /**
   * Sum all Prometheus series matching `name` (optional labels).
   * @param {string} body
   * @param {string} name Full metric name, e.g. "ds4_decode_tok_s" or "vllm:prompt_tokens_total"
   * @returns {number | null}
   */
  _getPromMetric(body, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${esc}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)\\s*$`, "gm");
    let sum = 0;
    let found = false;
    let m;
    while ((m = re.exec(body)) !== null) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v)) {
        sum += v;
        found = true;
      }
    }
    return found ? sum : null;
  }

  /**
   * Sum series of `name` whose label `labelKey` equals `labelValue`.
   * @param {string} body
   * @param {string} name
   * @param {string} labelKey
   * @param {string} labelValue
   * @returns {number | null}
   */
  _getPromMetricLabeled(body, name, labelKey, labelValue) {
    const escName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escKey = labelKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escVal = labelValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `^${escName}\\{[^}]*\\b${escKey}="${escVal}"[^}]*\\}\\s+([\\d.eE+-]+)\\s*$`,
      "gm"
    );
    let sum = 0;
    let found = false;
    let m;
    while ((m = re.exec(body)) !== null) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v)) {
        sum += v;
        found = true;
      }
    }
    return found ? sum : null;
  }

  _getVllmMetric(body, name) {
    return this._getPromMetric(body, `vllm:${name}`);
  }

  /**
   * Parse a vLLM Prometheus histogram from /metrics text.
   * Returns { buckets: [{upper, count}], total } with cumulative counts per `le`,
   * summed across label sets. `total` is the summed `_count` series (or null).
   */
  _parseVllmHistogram(body, metricPrefix) {
    const esc = metricPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bucketRe = new RegExp(
      `^${esc}_bucket\\{[^}]*\\ble="([^"]+)"[^}]*\\}\\s+([\\d.eE+-]+)\\s*$`,
      "gm"
    );
    const byUpper = new Map();
    let infCount = 0;
    let m;
    while ((m = bucketRe.exec(body)) !== null) {
      const le = m[1];
      const count = parseFloat(m[2]);
      if (!Number.isFinite(count)) continue;
      const upper = le === "+Inf" ? Infinity : parseFloat(le);
      if (upper !== Infinity && !Number.isFinite(upper)) continue;
      if (upper === Infinity) infCount += count;
      byUpper.set(upper, (byUpper.get(upper) || 0) + count);
    }
    const total = this._getVllmMetric(body, `${metricPrefix.replace(/^vllm:/, "")}_count`);
    if (total != null && infCount > 0 && Math.abs(infCount - total) > 1e-6) {
      return { buckets: [], total: null };
    }
    const buckets = Array.from(byUpper, ([upper, count]) => ({ upper, count }));
    buckets.sort((a, b) => a.upper - b.upper);
    return { buckets, total };
  }

  _histogramQuantile(buckets, total, quantile) {
    if (!buckets || !buckets.length || total == null || total <= 0) return null;
    const target = total * quantile;
    let prevUpper = 0.0;
    let prevCount = 0.0;
    for (const { upper, count } of buckets) {
      if (count >= target) {
        if (!Number.isFinite(upper)) return null;
        if (count === prevCount) return upper;
        return prevUpper + (upper - prevUpper) * ((target - prevCount) / (count - prevCount));
      }
      prevUpper = upper;
      prevCount = count;
    }
    return null;
  }

  _getSlotDecoded(slot) {
    if (slot.n_decoded != null) {
      if (Array.isArray(slot.n_decoded)) return slot.n_decoded[0] || 0;
      return slot.n_decoded || 0;
    }
    if (Array.isArray(slot.next_token) && slot.next_token[0]?.n_decoded != null) {
      return slot.next_token[0].n_decoded;
    }
    return 0;
  }

  _getSlotPrefilled(slot) {
    return slot.n_prompt_tokens_processed || slot.n_prompt_tokens || 0;
  }

  // ─── Recipe info / attribution collection ────────────────
  /**
   * Collect rich recipe info (engine type, model, container, author, config badges)
   * by inspecting the host process environment and command line.
   * Called once per probe cycle; cheap because it caches and short-circuits.
   */
async _collectSglangRecipeInfo() {
    try {
      const info = await this._getSglangModelInfo();
      console.log("[sglang-recipe] info=", JSON.stringify(info));
      if (!info) return null;
      const ctx = info.context_length || this.contextLength || null;
      const arch = Array.isArray(info.architectures) ? info.architectures[0] : null;
      const quant = info.quantization || (info.model_path && /nvfp4|fp4|int4|fp8/i.test(info.model_path) ? (info.model_path.match(/(nvfp4|fp4|int4|fp8)/i) || [])[1] : null) || null;
      return {
        engineType: "SGLang",
        modelName: info.model_path ? info.model_path.split("/").pop() : this.modelId,
        containerImage: "lmsysorg/sglang:dev-muse-glimmer",
        author: null,
        authorName: null,
        contextLength: ctx,
        maxLanes: null,
        specDecodeMethod: "DFlash",
        quantization: quant,
        gmu: info.mem_fraction_static != null ? info.mem_fraction_static : null,
        kvCacheDtype: info.kv_cache_dtype || null,
        prefixCaching: true,
        acceptRatio: this.mtpAcceptanceRate,
        ownedBy: info.model_type || arch || null,
      };
    } catch (e) {
      console.error("[sglang-recipe] ERROR:", e.message);
      return null;
    }
  }

  async _getSglangModelInfo() {
    try {
      const res = await this._fetch(`${this.baseUrl}/get_model_info`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async _collectRecipeInfo() {
    try {
      if (this.backendType === "ds4") {
        this.recipeInfo = this._collectDs4RecipeInfo();
      } else if (this.backendType === "sglang") {
        this.recipeInfo = await this._collectSglangRecipeInfo();
      } else if (this.backendType === "vllm") {
        this.recipeInfo = this._collectVllmRecipeInfo();
      } else {
        this.recipeInfo = null;
      }
    } catch(e) {
      console.error("[ds4-recipe] ERROR:", e.message, e.stack?.substring(0, 200));
      this.recipeInfo = null;
    }
  }

  /** Find the PID of the process listening on this.port by scanning host /proc. */
  _findHostPid() {
    try {
      const procDir = HOST_PROC;
      const entries = readdirSync(procDir);
      for (const pid of entries) {
        if (!/^\d+$/.test(pid)) continue;
        const cmdlinePath = `${procDir}/${pid}/cmdline`;
        try {
          const cmdline = readFileSync(cmdlinePath, "utf8");
          const parts = cmdline.split("\0").filter(Boolean);
          if (parts.length === 0) continue;
          // ds4-server or vllm or python processes
          const exe = parts[0].toLowerCase();
          if (exe.includes("ds4-server") || exe.includes("ds4")) {
            // Check if this process has --port matching our port
            const portArg = parts.find((p, i) => parts[i - 1] === "--port" && /^\d+$/.test(p));
            if (portArg && parseInt(portArg) === this.port) return parseInt(pid);
            // Also check for --host 0.0.0.0 --port <port> pattern
            const allArgs = parts.join(" ");
            if (allArgs.includes(`--port ${this.port}`) || allArgs.includes(`port=${this.port}`)) return parseInt(pid);
          }
          if (exe.includes("vllm") || exe.includes("python")) {
            const allArgs = parts.join(" ");
            if (allArgs.includes(`--port ${this.port}`) || allArgs.includes(`port=${this.port}`)) return parseInt(pid);
          }
        } catch {}
      }
    } catch {}
    return null;
  }

  /** Collect recipe info for the ds4 CUDA engine backend. */
  _collectDs4RecipeInfo() {
    const pid = this._findHostPid();
    if (!pid) return null;

    let environ = {};
    let cmdline = "";
    try {
      const envRaw = readFileSync(`${HOST_PROC}/${pid}/environ`, "utf8");
      for (const pair of envRaw.split("\0")) {
        if (!pair) continue;
        const eq = pair.indexOf("=");
        if (eq > 0) environ[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
    } catch {}
    try {
      cmdline = readFileSync(`${HOST_PROC}/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    } catch {}

    // Parse model file from cmdline: -m <path>
    const modelMatch = cmdline.match(/-m\s+(\S+)/);
    const modelPath = modelMatch ? modelMatch[1] : null;
    const modelFile = modelPath ? modelPath.split("/").pop() : null;

    // Detect quantization from model filename
    let quantization = null;
    if (modelFile) {
      if (/IQ2XXS/i.test(modelFile)) quantization = "IQ2XXS";
      else if (/IQ3/i.test(modelFile)) quantization = "IQ3";
      else if (/IQ4/i.test(modelFile)) quantization = "IQ4";
      else if (/Q2K/i.test(modelFile)) quantization = "Q2_K";
      else if (/Q4_K/i.test(modelFile)) quantization = "Q4_K";
      else if (/Q8_0/i.test(modelFile)) quantization = "Q8_0";
      else if (/FP8/i.test(modelFile)) quantization = "FP8";
      else if (/NVFP4/i.test(modelFile)) quantization = "NVFP4";
    }

    // Context length from cmdline: -c <num> (take last occurrence)
    let contextLength = this.contextLength;
    const ctxMatches = [...cmdline.matchAll(/-c\s+(\d+)/g)];
    if (ctxMatches.length > 0) {
      contextLength = parseInt(ctxMatches[ctxMatches.length - 1][1]);
    }

    // Max lanes from DS4_BATCH_FIT_HEADROOM_MB (maps to banks_total)
    const maxLanes = this.banksTotal ?? null;

    // DSpark config
    const dsparkEnabled = environ.DS4_CONT_DSPARK === "1" || environ.DS4_CONT_DSPARK === "true";
    const mtpMode = environ.DS4_CONT_MTP_MODE || null;
    const dsparkModel = environ.DS4_DSPARK_MODEL || null;

    let specDecodeMethod = null;
    if (dsparkEnabled) {
      const drafterFile = dsparkModel ? dsparkModel.split("/").pop() : null;
      // k value: MTP mode 2 = k=4 for DSpark typically
      const k = mtpMode ? `k=${mtpMode}` : "k=4";
      specDecodeMethod = `DSpark ${k}`;
    } else if (mtpMode) {
      specDecodeMethod = `MTP k=${mtpMode}`;
    }

    // KV cache dtype: ds4 uses native CUDA cache, no env var for dtype
    const kvCacheDtype = "native";

    // Prefix caching: ds4 always has warm/prefix cache (warmRecords)
    const prefixCaching = this.warmRecords != null ? this.warmRecords > 0 : null;

    // Author attribution for ds4
    const author = "@bleysg";
    const authorName = "Bleys Goodson";

    // Engine type
    const engineType = "DS4 CUDA Engine";

    // Container: native build
    const containerImage = "Native build (Entrpi/ds4 fork)";

    // Model display name from recipeMetadata
    const modelName = this.recipeMetadata?.model || this.modelId || modelFile || null;

    // Accept ratio
    const acceptRatio = this.dsparkAcceptRatio ?? null;

    // Uptime
    const uptime = this.ds4Uptime ?? null;

    return {
      engineType,
      modelName,
      containerImage,
      author,
      authorName,
      contextLength,
      maxLanes,
      specDecodeMethod,
      quantization,
      gmu: null, // ds4 doesn't expose GMU directly
      kvCacheDtype,
      prefixCaching,
      acceptRatio,
      uptime,
    };
  }

  /** Collect recipe info for a vLLM container backend. */
  _collectVllmRecipeInfo() {
    // Try to find the container via docker
    let containerImage = null;
    let containerName = null;
    try {
      // List containers, find one with port mapping to this.port
      const containersRaw = execSync("docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'", {
        timeout: 5000,
        encoding: "utf8",
      });
      for (const line of containersRaw.trim().split("\n")) {
        if (!line) continue;
        const [name, image, ports] = line.split("\t");
        if (ports && ports.includes(`${this.port}->`)) {
          containerImage = image;
          containerName = name;
          break;
        }
      }
    } catch {}

    if (!containerImage) return null;

    // Try docker inspect for env vars
    let environ = {};
    if (containerName) {
      try {
        const inspectRaw = execSync(
          `docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' ${containerName}`,
          { timeout: 5000, encoding: "utf8" }
        );
        for (const line of inspectRaw.trim().split("\n")) {
          if (!line) continue;
          const eq = line.indexOf("=");
          if (eq > 0) environ[line.slice(0, eq)] = line.slice(eq + 1);
        }
      } catch {}
    }

    // Try docker inspect for cmdline args
    let cmdline = "";
    if (containerName) {
      try {
        cmdline = execSync(
          `docker inspect --format '{{range .Args}}{{.}} {{end}}' ${containerName}`,
          { timeout: 5000, encoding: "utf8" }
        ).trim();
      } catch {}
    }

    // Parse model from cmdline: --model <path>
    const modelMatch = cmdline.match(/--model\s+(\S+)/);
    const modelPath = modelMatch ? modelMatch[1] : null;
    const modelFile = modelPath ? modelPath.split("/").pop() : null;

    // Detect quantization
    let quantization = null;
    const quantArg = cmdline.match(/--quantization\s+(\S+)/);
    if (quantArg) {
      quantization = quantArg[1].toUpperCase();
    } else if (modelFile) {
      if (/FP8/i.test(modelFile)) quantization = "FP8";
      else if (/NVFP4/i.test(modelFile)) quantization = "NVFP4";
      else if (/AWQ/i.test(modelFile)) quantization = "AWQ";
      else if (/GPTQ/i.test(modelFile)) quantization = "GPTQ";
    }

    // Context length from cmdline: --max-model-len <num>
    let contextLength = this.contextLength;
    const ctxMatch = cmdline.match(/--max-model-len\s+(\d+)/);
    if (ctxMatch) contextLength = parseInt(ctxMatch[1]);

    // Max lanes from cmdline: --tensor-parallel-size or --gpu-memory-utilization
    const tpMatch = cmdline.match(/--tensor-parallel-size\s+(\d+)/);
    const maxLanes = tpMatch ? parseInt(tpMatch[1]) : null;

    // Speculative decode method
    let specDecodeMethod = null;
    if (/--speculative-model/.test(cmdline) || /--speculative_config/.test(cmdline)) {
      const numSpecMatch = cmdline.match(/--num-speculative-tokens\s+(\d+)/);
      const k = numSpecMatch ? numSpecMatch[1] : "?";
      specDecodeMethod = `MTP k=${k}`;
    }

    // KV cache dtype
    let kvCacheDtype = null;
    const kvMatch = cmdline.match(/--kv-cache-dtype\s+(\S+)/);
    if (kvMatch) kvCacheDtype = kvMatch[1];
    else kvCacheDtype = "auto";

    // Prefix caching
    let prefixCaching = null;
    if (/--enable-prefix-caching/.test(cmdline)) prefixCaching = true;
    else if (/--no-prefix-caching/.test(cmdline)) prefixCaching = false;

    // GMU
    let gmu = null;
    const gmuMatch = cmdline.match(/--gpu-memory-utilization\s+([\d.]+)/);
    if (gmuMatch) gmu = parseFloat(gmuMatch[1]);

    // Author attribution for vLLM recipes
    const author = "@styles01";
    const authorName = "styles01";

    // Engine type
    const engineType = "vLLM";

    // Model display name
    const modelName = this.modelId || modelFile || null;

    // Accept ratio
    const acceptRatio = this.mtpAcceptanceRate ?? null;

    return {
      engineType,
      modelName,
      containerImage,
      author,
      authorName,
      contextLength,
      maxLanes,
      specDecodeMethod,
      quantization,
      gmu,
      kvCacheDtype,
      prefixCaching,
      acceptRatio,
      uptime: null,
    };
  }

  /**
   * Observational exposure hint from probe target + unauthenticated reachability.
   * Does not claim process bind address (0.0.0.0 vs interface).
   */
  _buildPosture() {
    if (this.authOpen == null) return null;

    const host = llmProbeHost(this.spark);
    const scope = classifyHostScope(host);
    const keyed = Boolean(this._apiKey());
    /** @type {"open" | "protected" | "keyed"} */
    let auth;
    if (keyed) {
      // Key configured: success → keyed; 401/403 → protected (rejected)
      auth = this.authOpen === false ? "protected" : "keyed";
    } else {
      auth = this.authOpen ? "open" : "protected";
    }

    let level = "ok";
    if (auth === "open") {
      if (scope === "public") level = "danger";
      else if (scope === "local") level = "ok";
      else level = "warn"; // lan or unknown hostname
    } else if (keyed && auth === "protected") {
      level = "danger";
    }

    const scopeWords = {
      local: "loopback",
      lan: "LAN",
      public: "public",
      unknown: "unknown-host",
    };
    const shortScope = {
      local: "Local",
      lan: "LAN",
      public: "Public",
      unknown: "Host",
    };
    const label =
      auth === "protected"
        ? keyed
          ? "Bad API key"
          : "Auth required"
        : auth === "keyed"
          ? `API key · ${shortScope[scope]}`
          : `Open · ${shortScope[scope]}`;
    const detail =
      auth === "protected"
        ? keyed
          ? `Configured API key was rejected (401/403) · ${scopeWords[scope]} target (${host || "—"}).`
          : `API key required · ${scopeWords[scope]} target (${host || "—"}). Based on the configured probe host, not the process bind address.`
        : auth === "keyed"
          ? `Using configured API key · ${scopeWords[scope]} target (${host || "—"}). Based on the configured probe host, not the process bind address.`
          : `Unauthenticated · ${scopeWords[scope]} target (${host || "—"}). Based on the configured probe host, not the process bind address.`;

    return { level, auth, scope, label, detail };
  }

  _getSnapshot() {
    const metricsLive = this.serverIsOpenAI !== null && this.authOpen !== false;
    return {
      available: metricsLive,
      backend: this.backendType,
      modelId: this.modelId || null,
      modelPath: this.modelPath || null,
      contextLength: this.contextLength,
      gpuMemoryUtilization: this.gpuMemoryUtilization,
      slotsActive: this.slotsActive,
      slotsTotal: this.slotsTotal,
      generationTps: this.generationTps,
      prefillTps: this.prefillTps,
      totalOutputTokens: this.totalOutputTokens,
      kvCacheUsage: this.kvCacheUsage,
      requestsRunning: this.requestsRunning,
      requestsWaiting: this.requestsWaiting,
      ttftP95Seconds: this.ttftP95Seconds,
      preemptionsTotal: this.preemptionsTotal,
      prefixCacheHitRate: this.prefixCacheHitRate,
      e2eP95Seconds: this.e2eP95Seconds,
      itlP95Seconds: this.itlP95Seconds,
      mtpAcceptanceRate: this.mtpAcceptanceRate,
      ttft: this.ttft ?? this.ttftP95Seconds,
      e2eLatency: this.e2eLatency ?? this.e2eP95Seconds,
      genTokensPerReq: this.genTokensPerReq,
      mtpAcceptedTokens: this.mtpAcceptedTokens,
      mtpDraftedTokens: this.mtpDraftedTokens,
      aggregateDecodeTps: this.aggregateDecodeTps,
      rollingAvgE2e: this.rollingAvgE2e,
      rollingAvgTtft: this.rollingAvgTtft,
      rollingAvgTokensPerReq: this.rollingAvgTokensPerReq,
      rollingAvgTpsPerSlot: this.rollingAvgTpsPerSlot,
      posture: this._buildPosture(),
      recipeInfo: this.recipeInfo,
      recipeMetadata: this.recipeMetadata,
      peakAggregateTps: this.peakAggregateTps,
      perStreamHigh: this.perStreamHigh,
      perStreamLow: this.perStreamLow,
      perStreamAvg: this.perStreamAvg,
      totalTokensDecoded: this.totalTokensDecoded,
      dsparkAcceptRatio: this.dsparkAcceptRatio,
      banksLive: this.banksLive,
      banksTotal: this.banksTotal,
      kvPagesResident: this.kvPagesResident,
      prefillCached: this.prefillCached,
      prefillComputed: this.prefillComputed,
      specDrafts: this.specDrafts,
      specHits: this.specHits,
      warmRecords: this.warmRecords,
      specQuench: this.specQuench,
      tokPerStep: this.tokPerStep,
      decodeSteps: this.decodeSteps,
      derivedArtifacts: this.derivedArtifacts,
      derivedArtifactBytes: this.derivedArtifactBytes,
      ds4Uptime: this.ds4Uptime,
      admitsCold: this.admitsCold,
      admitsWarm: this.admitsWarm,
      admitsFork: this.admitsFork,
      admitsPartialFork: this.admitsPartialFork,
      admitsPartialTruncate: this.admitsPartialTruncate,
      requestsStarted: this.requestsStarted,
      requestsCompleted: this.requestsCompleted,
      requestsInflight: this.requestsInflight,
      activeContext: this.activeContext,
      activeContextTs: this.activeContextTs,
      contextUsedBytes: this.contextUsedBytes,
      error: this.error,
    };

    // DS4 fields (always include — null for non-ds4 backends)
    snap.ds4Uptime = this.ds4Uptime;
    snap.peakAggregateTps = this.peakAggregateTps;
    snap.perStreamHigh = this.perStreamHigh;
    snap.perStreamLow = this.perStreamLow;
    snap.perStreamAvg = this.perStreamAvg;
    snap.totalTokensDecoded = this.totalTokensDecoded;
    snap.dsparkAcceptRatio = this.dsparkAcceptRatio;
    snap.banksLive = this.banksLive;
    snap.banksTotal = this.banksTotal;
    snap.kvPagesResident = this.kvPagesResident;
    snap.prefillCached = this.prefillCached;
    snap.prefillComputed = this.prefillComputed;
    snap.specDrafts = this.specDrafts;
    snap.specHits = this.specHits;
    snap.specQuench = this.specQuench;
    snap.warmRecords = this.warmRecords;
    snap.derivedArtifacts = this.derivedArtifacts;
    snap.derivedArtifactBytes = this.derivedArtifactBytes;
    snap.requestsStarted = this.requestsStarted;
    snap.requestsCompleted = this.requestsCompleted;
    snap.requestsFailed = this.requestsFailed;
    snap.requestsRefusedDeepSerial = this.requestsRefusedDeepSerial;
    snap.requestsInflight = this.requestsInflight;
    snap.requestsSerial = this.requestsSerial;
    snap.contAdmitRejects = this.contAdmitRejects;
    snap.contBatchFailures = this.contBatchFailures;
    snap.graphFitRefusals = this.graphFitRefusals;
    snap.admitsCold = this.admitsCold;
    snap.admitsWarm = this.admitsWarm;
    snap.admitsFork = this.admitsFork;
    snap.admitsPartialFork = this.admitsPartialFork;
    snap.admitsPartialTruncate = this.admitsPartialTruncate;
    snap.decodeSteps = this.decodeSteps;
    snap.tokPerStep = this.tokPerStep;
    snap.recipeMetadata = this.recipeMetadata;
    snap.recipeInfo = this.recipeInfo;
    snap.reasoningEffort = this.reasoningEffort;
    snap.reasoningEffortTs = this.reasoningEffortTs;
    snap.activeContext = this.activeContext;
    snap.activeContextTs = this.activeContextTs;
    snap.contextUsedBytes = this.kvPagesResident != null
      ? this.kvPagesResident * KV_PAGE_SIZE_BYTES
      : null;

    return snap;
  }

  _defaultLlm() {
    const snap = {
      available: false,
      backend: this.backendType,
      modelId: null,
      modelPath: null,
      contextLength: null,
      gpuMemoryUtilization: null,
      slotsActive: 0,
      slotsTotal: 0,
      generationTps: 0,
      prefillTps: 0,
      totalOutputTokens: 0,
      kvCacheUsage: null,
      requestsRunning: null,
      requestsWaiting: null,
      ttftP95Seconds: null,
      preemptionsTotal: null,
      prefixCacheHitRate: null,
      e2eP95Seconds: null,
      itlP95Seconds: null,
      mtpAcceptanceRate: null,
      ttft: null,
      e2eLatency: null,
      genTokensPerReq: null,
      mtpAcceptedTokens: null,
      mtpDraftedTokens: null,
      aggregateDecodeTps: null,
      rollingAvgE2e: null,
      rollingAvgTtft: null,
      rollingAvgTokensPerReq: null,
      rollingAvgTpsPerSlot: null,
      posture: this._buildPosture(),
      error: this.error,
      ds4Uptime: null,
      peakAggregateTps: 0,
      perStreamHigh: null,
      perStreamLow: null,
      perStreamAvg: null,
      totalTokensDecoded: null,
      dsparkAcceptRatio: null,
      banksLive: null,
      banksTotal: null,
      kvPagesResident: null,
      prefillCached: null,
      prefillComputed: null,
      specDrafts: null,
      specHits: null,
      specQuench: null,
      warmRecords: null,
      derivedArtifacts: null,
      derivedArtifactBytes: null,
      requestsStarted: null,
      requestsCompleted: null,
      requestsFailed: null,
      requestsRefusedDeepSerial: null,
      requestsInflight: null,
      requestsSerial: null,
      contAdmitRejects: null,
      contBatchFailures: null,
      graphFitRefusals: null,
      admitsCold: null,
      admitsWarm: null,
      admitsFork: null,
      admitsPartialFork: null,
      admitsPartialTruncate: null,
      decodeSteps: null,
      tokPerStep: null,
      recipeMetadata: null,
      recipeInfo: null,
      reasoningEffort: null,
      reasoningEffortTs: null,
      activeContext: null,
      activeContextTs: null,
      contextUsedBytes: null,
    };
    return snap;
  }

  // ─── HTTP helpers ────────────────────────────────────────
  _apiKey() {
    const keys = this.spark?.llmApiKeys;
    if (!keys || typeof keys !== "object") return null;
    const raw = keys[String(this.port)] ?? keys[this.port];
    const key = raw != null ? String(raw).trim() : "";
    return key || null;
  }

  async _fetch(url) {
    const headers = {};
    const apiKey = this._apiKey();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return fetch(url, { signal: AbortSignal.timeout(LLM_PROBE_TIMEOUT_MS), headers });
  }
}