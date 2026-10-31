import express from "express";
import cors from "cors";
import { ExecutionRequestSchema, CreatePlanSchema, ReviewedRunSchema, PrepareQuickSelectionSchema } from "./executionRequest";
import { AssetMediaSize } from "@immich/sdk";

import { normalizeDuplicates } from "./normalizeDuplicates";
import { createAssetInfoEnricher } from "./enrichWithAssetInfo";
import { createAlbumEnricher } from "./enrichWithAlbums";
import type {
  DuplicateDecision,
  DuplicateGroup,
  ExecutionPlanItem,
  ReviewPreparationEvent,
  ReviewPreparationProgress,
} from "@immich-dedupe/shared";
import { createExecutionService, ExecutionServiceError } from "./executionService";
import type { ExecutionJournal } from "./executionJournal";
import { z } from "zod";
import { isExecutableDecision } from "./executePlan";
import type { ExecutionLogEntry, ExecutionLog } from "./executionLog";
import type { ImmichClient } from "./immichClient";
import { createRulesStore, ruleSetDraftSchema, type RulesStore } from "./rulesStore";
import { createScanStore, type ScanStore } from "./scanStore";

export type AppDependencies = {
  immich: ImmichClient;
  journal: ExecutionJournal;
  config: { IMMICH_URL: string; IMMICH_API_KEY: string };
  log: ExecutionLog;
  fetch: typeof globalThis.fetch;
  saveConnection: (updates: Record<string, string>) => void;
  now?: () => number;
  rules?: RulesStore;
  scan?: ScanStore;
};

export function createApp(dependencies: AppDependencies) {
  const { immich, config: env, log, fetch, saveConnection } = dependencies;
  const { getAllAlbums, getAlbumInfo, getAssetDuplicates, getAssetInfo, pingServer } = immich;
  const { getExecutionLogPath, loadExecutionLog } = log;
  const enrichDuplicatesWithAssetInfo = createAssetInfoEnricher(immich);
  const enrichDuplicatesWithAlbums = createAlbumEnricher(immich);
  const execution = createExecutionService({ client: immich, apiUrl: env.IMMICH_URL, journal: dependencies.journal, log, now: dependencies.now,
    rules: dependencies.rules ?? createRulesStore(), scan: dependencies.scan ?? createScanStore() });
  const app = express();

  app.use(cors());
  app.use(express.json());

  function parsePositiveLimit(value: unknown, fallback: number): number {
    if (typeof value !== "string" && typeof value !== "number") {
      return fallback;
    }

    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }

    return parsed;
  }

  function unique<T>(items: T[]): T[] {
    return [...new Set(items)];
  }

  function getAlbumTransferCount(
    group: DuplicateGroup,
    keepAssetId: string,
    trashAssetId: string
  ): number {
    const keepAsset = group.assets.find((asset) => asset.id === keepAssetId);
    const trashAsset = group.assets.find((asset) => asset.id === trashAssetId);

    if (!keepAsset || !trashAsset) {
      return 0;
    }

    const keepAlbumIds = new Set(keepAsset.albums.map((album) => album.albumId));
    const trashAlbumIds = unique(trashAsset.albums.map((album) => album.albumId));

    return trashAlbumIds.filter((albumId) => !keepAlbumIds.has(albumId)).length;
  }

  function buildExecutionPlanItems(
    groups: DuplicateGroup[],
    decisions: DuplicateDecision[]
  ): ExecutionPlanItem[] {
    const groupById = new Map(groups.map((group) => [group.groupId, group]));

    return decisions.flatMap((decision) => {
      if (!isExecutableDecision(decision)) {
        return [];
      }

      const keepAssetId = decision.keepAssetId;
      const trashAssetId = decision.trashAssetIds[0];
      const group = groupById.get(decision.groupId);

      if (!keepAssetId || !trashAssetId || !group) {
        return [];
      }

      return [
        {
          groupId: decision.groupId,
          keepAssetId,
          trashAssetId,
          confidence: decision.confidence,
          ruleName: decision.matchedRuleName,
          reasons: decision.reasons,
          albumTransferCount: getAlbumTransferCount(
            group,
            keepAssetId,
            trashAssetId
          ),
        },
      ];
    });
  }

  function buildExecutionLogResponse(log: ExecutionLogEntry[]) {
    return {
      ok: true,
      path: getExecutionLogPath(),
      count: log.length,
      data: log,
    };
  }

  function escapeCsvValue(value: string | boolean | string[] | null | undefined): string {
    if (value == null) {
      return "";
    }

    const text = Array.isArray(value) ? JSON.stringify(value) : String(value);

    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }

    return text;
  }

  function buildExecutionLogCsv(log: ExecutionLogEntry[]): string {
    const columns: Array<keyof ExecutionLogEntry> = [
      "timestamp",
      "runId",
      "attemptId",
      "groupId",
      "mode",
      "keepAssetId",
      "trashAssetId",
      "executed",
      "resolvedDuplicate",
      "trashedAsset",
      "message",
      "outcome",
      "failureStage",
      "proposedAlbumIds",
      "transferredAlbumIds",
      "skippedAlbumIds",
    ];

    const rows = [
      columns.join(","),
      ...log.map((entry) =>
        columns.map((column) => escapeCsvValue(entry[column])).join(",")
      ),
    ];

    return `\ufeff${rows.join("\r\n")}\r\n`;
  }

  app.get("/", (_req, res) => {
    res.json({
      ok: true,
      service: "api",
      routes: [
        "/health",
        "/immich/test",
        "/immich/duplicates",
        "/immich/duplicates/normalized",
        "/immich/duplicates/enriched?limit=5",
        "/immich/duplicates/enriched-albums?limit=5",
        "/analysis/duplicates?limit=10",
        "/execution/plan?scanLimit=100",
        "/execution/status?scanLimit=100",
        "/execution/log",
        "POST /execution/log/clear",
        "/execution/log/export.json",
        "/execution/log/export.csv",
        "POST /execution/run { scanLimit, executeLimit, dryRun }",
        "POST /execution/quick-reviews { scanLimit, executeLimit }",
        "POST /execution/quick-reviews/:reviewId/prepare-plan { selectedGroupIds, executeLimit }",
      ],
    });
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "api",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/settings/status", async (_req, res) => {
    try {
      const pingRes = await fetch(`${env.IMMICH_URL}/server/ping`);
      const pingData = await pingRes.json() as { res?: string };

      if (!pingRes.ok || pingData?.res !== "pong") {
        return res.json({ ok: true, status: "disconnected", immichUrl: env.IMMICH_URL });
      }

      const aboutRes = await fetch(`${env.IMMICH_URL}/server/about`, {
        headers: { "x-api-key": env.IMMICH_API_KEY },
      });

      if (aboutRes.status === 401) {
        return res.json({ ok: true, status: "error", immichUrl: env.IMMICH_URL });
      }

      const about = await aboutRes.json() as { version?: string };

      if (about?.version) {
        return res.json({ ok: true, status: "connected", immichUrl: env.IMMICH_URL });
      }

      res.json({ ok: true, status: "error", immichUrl: env.IMMICH_URL });
    } catch {
      res.json({ ok: true, status: "disconnected", immichUrl: env.IMMICH_URL });
    }
  });

  app.get("/settings/connection", (_req, res) => {
    res.json({
      ok: true,
      immichUrl: env.IMMICH_URL,
      apiKey: env.IMMICH_API_KEY,
    });
  });

  app.post("/settings/connection", (req, res) => {
    const { immichUrl, apiKey } = req.body ?? {};

    if (!immichUrl || !apiKey) {
      return res.status(400).json({ ok: false, error: "immichUrl and apiKey are required." });
    }

    try {
      saveConnection({ IMMICH_URL: immichUrl, IMMICH_API_KEY: apiKey });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to save settings.",
      });
    }
  });

  app.post("/settings/test-connection", async (req, res) => {
    const { immichUrl, apiKey } = req.body ?? {};

    if (!immichUrl || !apiKey) {
      return res.status(400).json({ ok: false, error: "immichUrl and apiKey are required." });
    }

    try {
      const aboutRes = await fetch(`${immichUrl}/server/about`, {
        headers: { "x-api-key": apiKey },
      });

      if (aboutRes.status === 401) {
        return res.json({ ok: false, error: "Error: API key is invalid." });
      }

      if (!aboutRes.ok) {
        return res.json({ ok: false, error: `Server error: HTTP ${aboutRes.status}` });
      }

      const about = await aboutRes.json() as { version?: string };

      res.json({
        ok: true,
        version: about.version ?? "unknown",
      });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "Connection failed.",
      });
    }
  });

  app.get("/immich/test", async (_req, res) => {
    try {
      const result = await pingServer();

      res.json({
        ok: true,
        source: "immich",
        result,
      });
    } catch (error) {
      console.error("GET /immich/test failed:", error);

      res.status(500).json({
        ok: false,
        source: "immich",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.get("/immich/duplicates", async (_req, res) => {
    try {
      const duplicates = await getAssetDuplicates({});

      res.json({
        ok: true,
        count: Array.isArray(duplicates) ? duplicates.length : 0,
        data: duplicates,
      });
    } catch (error) {
      console.error("GET /immich/duplicates failed:", error);

      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.get("/immich/duplicates/normalized", async (_req, res) => {
    try {
      const duplicates = await getAssetDuplicates({});
      const rawGroups = Array.isArray(duplicates) ? duplicates : [];
      const normalized = normalizeDuplicates(rawGroups);

      res.json({
        ok: true,
        ...normalized,
      });
    } catch (error) {
      console.error("GET /immich/duplicates/normalized failed:", error);

      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.get("/immich/duplicates/enriched", async (req, res) => {
    try {
      const limit = parsePositiveLimit(req.query.limit, 10);

      const duplicates = await getAssetDuplicates({});
      const rawGroups = Array.isArray(duplicates) ? duplicates : [];
      const slicedGroups = rawGroups.slice(0, limit);

      const normalized = normalizeDuplicates(slicedGroups);
      const enriched = await enrichDuplicatesWithAssetInfo(normalized);

      res.json({
        ok: true,
        requestedLimit: limit,
        fetchedGroups: slicedGroups.length,
        ...enriched,
      });
    } catch (error) {
      console.error("GET /immich/duplicates/enriched failed:", error);

      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.get("/immich/duplicates/enriched-albums", async (req, res) => {
    try {
      const limit = parsePositiveLimit(req.query.limit, 10);

      const duplicates = await getAssetDuplicates({});
      const rawGroups = Array.isArray(duplicates) ? duplicates : [];
      const slicedGroups = rawGroups.slice(0, limit);

      const normalized = normalizeDuplicates(slicedGroups);
      const withFileSize = await enrichDuplicatesWithAssetInfo(normalized);
      const withAlbums = await enrichDuplicatesWithAlbums(withFileSize);

      res.json({
        ok: true,
        requestedLimit: limit,
        fetchedGroups: slicedGroups.length,
        ...withAlbums,
      });
    } catch (error) {
      console.error("GET /immich/duplicates/enriched-albums failed:", error);

      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.get("/immich/duplicates/:groupId", async (req, res) => {
    try {
      const duplicates = await getAssetDuplicates({});
      const rawGroups = Array.isArray(duplicates) ? duplicates : [];

      const group = rawGroups.find(
        (rawGroup: any) => rawGroup.duplicateId === req.params.groupId
      );

      res.json({
        ok: true,
        exists: Boolean(group),
        data: group ?? null,
      });
    } catch (error) {
      console.error("GET /immich/duplicates/:groupId failed:", error);

      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.get("/immich/assets/:id", async (req, res) => {
    try {
      const asset = await getAssetInfo({ id: req.params.id });

      res.json({
        ok: true,
        data: asset,
      });
    } catch (error) {
      console.error("GET /immich/assets/:id failed:", error);

      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.get("/immich/albums", async (_req, res) => {
    try {
      const albums = await getAllAlbums({});

      res.json({
        ok: true,
        count: Array.isArray(albums) ? albums.length : 0,
        data: albums,
      });
    } catch (error) {
      console.error("GET /immich/albums failed:", error);

      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.get("/immich/albums/:id", async (req, res) => {
    try {
      const album = await getAlbumInfo({
        id: req.params.id,
        withoutAssets: false,
      });

      res.json({
        ok: true,
        data: album,
      });
    } catch (error) {
      console.error("GET /immich/albums/:id failed:", error);

      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.get("/analysis/duplicates", async (req, res) => {
    try {
      const limit = parsePositiveLimit(req.query.limit, 10);

      const duplicates = await getAssetDuplicates({});
      const rawGroups = Array.isArray(duplicates) ? duplicates : [];
      const slicedGroups = rawGroups.slice(0, limit);

      const normalized = normalizeDuplicates(slicedGroups);
      const withFileSize = await enrichDuplicatesWithAssetInfo(normalized);
      const withAlbums = await enrichDuplicatesWithAlbums(withFileSize);

      const results = await execution.evaluateGroups(withAlbums.groups);

      const autoResolveCount = results.filter(
        (result) => result.status === "auto-resolve"
      ).length;

      const uncertainCount = results.filter(
        (result) => result.status === "uncertain"
      ).length;

      const skipCount = results.filter((result) => result.status === "skip").length;

      res.json({
        ok: true,
        results,
        totalGroups: results.length,
        autoResolveCount,
        uncertainCount,
        skipCount,
      });
    } catch (error) {
      console.error("GET /analysis/duplicates failed:", error);

      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.get("/execution/plan", async (req, res) => {
    try {
      const scanLimit = parsePositiveLimit(req.query.scanLimit, 100);

      const duplicates = await getAssetDuplicates({});
      const rawGroups = Array.isArray(duplicates) ? duplicates : [];
      const slicedGroups = rawGroups.slice(0, scanLimit);

      const normalized = normalizeDuplicates(slicedGroups);
      const withFileSize = await enrichDuplicatesWithAssetInfo(normalized);
      const withAlbums = await enrichDuplicatesWithAlbums(withFileSize);

      const decisions = await execution.evaluateGroups(withAlbums.groups);

      const executable = decisions.filter(isExecutableDecision);
      const items = buildExecutionPlanItems(withAlbums.groups, decisions);

      res.json({
        ok: true,
        scanLimit,
        fetchedGroups: slicedGroups.length,
        executableCount: items.length,
        items,
        executable,
      });
    } catch (error) {
      console.error("GET /execution/plan failed:", error);

      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.get("/execution/log", (_req, res) => {
    const log = loadExecutionLog();

    res.json(buildExecutionLogResponse(log));
  });

  app.get("/execution/log/export.json", (_req, res) => {
    const log = loadExecutionLog();

    res
      .type("application/json")
      .attachment("immich-dedupe-execution-log.json")
      .send(JSON.stringify(buildExecutionLogResponse(log), null, 2));
  });

  app.get("/execution/log/export.csv", (_req, res) => {
    const log = loadExecutionLog();

    res
      .type("text/csv")
      .attachment("immich-dedupe-execution-log.csv")
      .send(buildExecutionLogCsv(log));
  });

  function executionError(res: express.Response, error: unknown) {
    if (error instanceof ExecutionServiceError) return res.status(error.status).json({ ok: false, code: error.code, error: error.message, ...error.details });
    return res.status(503).json({ ok: false, error: error instanceof Error && error.name !== "ZodError" ? error.message : "Recovery state is unavailable" });
  }

  app.get("/rules", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json(await execution.rulesState()); } catch (error) { executionError(res, error); }
  });
  for (const publish of [false, true]) app[publish ? "post" : "put"](publish ? "/rules/publish" : "/rules/draft", async (req, res) => {
    const parsed = z.object({ ruleset: ruleSetDraftSchema }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Invalid rules configuration", issues: parsed.error.issues });
    try { res.json(await execution.saveRules(parsed.data.ruleset, publish)); } catch (error) { executionError(res, error); }
  });
  app.post("/rules/test", async (req, res) => {
    const parsed = z.object({ ruleset: ruleSetDraftSchema, snapshotId: z.string().uuid() }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Supply valid rules and a prepared review ID" });
    try { res.json(await execution.testRules(parsed.data.snapshotId, parsed.data.ruleset)); } catch (error) { executionError(res, error); }
  });
  app.get("/execution/scan/pending", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json(await execution.scanPending()); } catch (error) { executionError(res, error); }
  });
  app.post("/execution/scan/prepare-pending", async (req, res) => {
    try { res.json(await execution.preparePending(req.body)); } catch (error) { executionError(res, error); }
  });
  for (const recheck of [false, true]) app.post(recheck ? "/execution/scan/recheck-excluded" : "/execution/scan/reset", async (req, res) => {
    if (!z.object({}).strict().safeParse(req.body ?? {}).success) return res.status(400).json({ ok: false, error: "Invalid scan request" });
    try { res.json(await execution.resetScan(recheck)); } catch (error) { executionError(res, error); }
  });

  app.post("/execution/log/clear", async (_req, res) => {
    try { res.json({ ok: true, ...await execution.clearLog() }); }
    catch (error) { executionError(res, error); }
  });
  for (const quick of [false, true]) app.post(quick ? "/execution/quick-reviews" : "/execution/plans", async (req, res) => {
    const parsed = CreatePlanSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Invalid review limits" });
    if (req.get("Accept")?.includes("application/x-ndjson")) {
      function send(event: ReviewPreparationEvent) {
        if (res.destroyed || res.writableEnded) return;
        if (!res.headersSent) {
          res.status(200).set({ "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
          res.flushHeaders();
        }
        // Skip intermediate updates for a slow reader, but always deliver the terminal event.
        if (event.type !== "progress" || !res.writableNeedDrain) res.write(`${JSON.stringify(event)}\n`);
      }
      try {
        const observer = (progress: ReviewPreparationProgress) => send({ type: "progress", progress });
        const result = await (quick ? execution.prepareQuickReview(parsed.data, observer) : execution.preparePlanStream(parsed.data, observer));
        send({ type: "result", result });
      } catch (error) {
        const known = error instanceof ExecutionServiceError;
        const status = known ? error.status : 503;
        const code = known ? error.code : "preparation_unavailable";
        const message = known && code !== "execution_error" ? error.message : "Review preparation failed; fresh Immich data could not be verified";
        if (!res.headersSent && !res.destroyed) return res.status(status).json({ ok: false, code, error: message });
        send({ type: "error", status, code, error: message });
      }
      if (!res.destroyed) res.end();
      return;
    }
    try {
      if (quick) {
        const result = await execution.prepareQuickReview(parsed.data);
        res.set("Cache-Control", "no-store").json({ ok: true, quickReview: result.quickReview });
      } else res.json(await execution.preparePlan(parsed.data));
    } catch (error) { executionError(res, error); }
  });
  app.post("/execution/quick-reviews/:reviewId/prepare-plan", async (req, res) => {
    const parsed = PrepareQuickSelectionSchema.safeParse(req.body);
    if (!z.string().uuid().safeParse(req.params.reviewId).success || !parsed.success) return res.status(400).json({ ok: false, error: "Invalid quick selection" });
    res.set("Cache-Control", "no-store");
    try { res.json(await execution.prepareQuickSelection(req.params.reviewId, parsed.data)); } catch (error) { executionError(res, error); }
  });
  app.post("/execution/preparations/:preparationId/cancel", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!z.string().uuid().safeParse(req.params.preparationId).success) return res.status(400).json({ ok: false, error: "Invalid preparation ID" });
    try { res.json(execution.cancelPreparation(req.params.preparationId)); } catch (error) { executionError(res, error); }
  });
  app.post("/execution/plans/:planId/select-all", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!z.string().uuid().safeParse(req.params.planId).success || !z.object({}).strict().safeParse(req.body ?? {}).success) return res.status(400).json({ ok: false, error: "Invalid select-all request" });
    try { res.json(await execution.selectAllReviewed(req.params.planId)); } catch (error) { executionError(res, error); }
  });
  app.post("/execution/plans/:planId/run", async (req, res) => {
    const parsed = ReviewedRunSchema.safeParse(req.body);
    if (!parsed.success || !z.string().uuid().safeParse(req.params.planId).success) return res.status(400).json({ ok: false, error: "Invalid reviewed execution request" });
    try {
      const { decision: _decision, ...result } = await execution.runReviewed(req.params.planId, parsed.data);
      res.json(result);
    } catch (error) { executionError(res, error); }
  });
  app.get("/execution/plans/:planId/assets/:assetId/thumbnail", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!z.string().uuid().safeParse(req.params.planId).success || !req.params.assetId) return res.status(400).json({ ok: false, error: "Invalid reviewed asset request" });
    try {
      await execution.reviewedAsset(req.params.planId, req.params.assetId);
      const blob = await immich.viewAsset({ id: req.params.assetId, size: AssetMediaSize.Thumbnail });
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(blob.type) || blob.size === 0) return res.status(502).json({ ok: false, error: "Immich returned an unsupported thumbnail" });
      res.set("X-Content-Type-Options", "nosniff");
      res.type(blob.type).send(Buffer.from(await blob.arrayBuffer()));
    } catch (error) {
      if (error instanceof ExecutionServiceError) return executionError(res, error);
      res.status(502).json({ ok: false, error: "Thumbnail unavailable; check image access permissions in Immich" });
    }
  });

  app.get("/execution/runs/latest", async (_req, res) => {
    try { res.json(await execution.readRun()); } catch (error) { executionError(res, error); }
  });
  app.get("/execution/runs/:runId", async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.runId).success) return res.status(400).json({ ok: false, error: "Invalid run ID" });
    try { res.json(await execution.readRun(req.params.runId)); } catch (error) { executionError(res, error); }
  });

  app.get("/execution/recovery", async (req, res) => {
    const parsed = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(25) }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Invalid recovery pagination" });
    try { res.json(await execution.list(parsed.data.offset, parsed.data.limit)); } catch (error) { executionError(res, error); }
  });
  app.get("/execution/recovery/:attemptId", async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.attemptId).success) return res.status(400).json({ ok: false, error: "Invalid attempt ID" });
    try { res.json({ ok: true, attempt: await execution.detail(req.params.attemptId) }); } catch (error) { executionError(res, error); }
  });
  for (const action of ["recheck", "release"] as const) {
    app.post(`/execution/recovery/:attemptId/${action}`, async (req, res) => {
      if (!z.string().uuid().safeParse(req.params.attemptId).success) return res.status(400).json({ ok: false, error: "Invalid attempt ID" });
      if (action === "release" && !z.object({ confirm: z.literal(true) }).safeParse(req.body).success) return res.status(400).json({ ok: false, error: "Explicit confirmation is required" });
      try { res.json({ ok: true, attempt: await execution.recheck(req.params.attemptId, action === "release") }); } catch (error) { executionError(res, error); }
    });
  }

  app.get("/execution/status", async (req, res) => {
    try {
      const scanLimit = parsePositiveLimit(req.query.scanLimit, 100);

      const duplicates = await getAssetDuplicates({});
      const rawGroups = Array.isArray(duplicates) ? duplicates : [];
      const slicedGroups = rawGroups.slice(0, scanLimit);

      const normalized = normalizeDuplicates(slicedGroups);
      const withFileSize = await enrichDuplicatesWithAssetInfo(normalized);
      const withAlbums = await enrichDuplicatesWithAlbums(withFileSize);

      const decisions = await execution.evaluateGroups(withAlbums.groups);

      const executable = decisions.filter(isExecutableDecision);

      const log = loadExecutionLog();
      const lastExecutionEntry = log.length > 0 ? log[log.length - 1] : null;

      res.json({
        ok: true,
        scanLimit,
        duplicateCount: rawGroups.length,
        scannedDuplicateCount: slicedGroups.length,
        executableCount: executable.length,
        logCount: log.length,
        lastExecutionEntry,
      });
    } catch (error) {
      console.error("GET /execution/status failed:", error);

      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.get("/execution/duplicates/:groupId/preview", async (req, res) => {
    try {
      const groupId = req.params.groupId;

      const duplicates = await getAssetDuplicates({});
      const rawGroups = Array.isArray(duplicates) ? duplicates : [];

      const targetRawGroup = rawGroups.find(
        (rawGroup: any) => rawGroup.duplicateId === groupId
      );

      if (!targetRawGroup) {
        return res.status(404).json({
          ok: false,
          error: "Duplicate group not found",
        });
      }

      const normalized = normalizeDuplicates([targetRawGroup]);
      const withFileSize = await enrichDuplicatesWithAssetInfo(normalized);
      const withAlbums = await enrichDuplicatesWithAlbums(withFileSize);

      const group = withAlbums.groups[0];
      const decision = (await execution.evaluateGroups([group]))[0];

      if (!group || !decision) {
        return res.status(500).json({
          ok: false,
          error: "Failed to build preview",
        });
      }

      if (decision.status !== "auto-resolve") {
        return res.json({
          ok: true,
          executable: false,
          decision,
        });
      }

      const keepAsset = group.assets.find((asset) => asset.id === decision.keepAssetId);
      const trashAsset = group.assets.find(
        (asset) => asset.id === decision.trashAssetIds[0]
      );

      const keepAlbumIds = new Set(
        (keepAsset?.albums ?? []).map((album) => album.albumId)
      );

      const trashAlbums = trashAsset?.albums ?? [];

      const missingAlbums = trashAlbums.filter(
        (album) => !keepAlbumIds.has(album.albumId)
      );

      res.json({
        ok: true,
        executable: true,
        decision,
        preview: {
          keepAssetId: keepAsset?.id ?? null,
          trashAssetId: trashAsset?.id ?? null,
          albumsToTransfer: missingAlbums,
        },
      });
    } catch (error) {
      console.error("GET /execution/duplicates/:groupId/preview failed:", error);

      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  async function loadExecutionGroups(scanLimit: number, groupId?: string) {
    const duplicates = await getAssetDuplicates({});
    const rawGroups = Array.isArray(duplicates) ? duplicates : [];
    const selected = groupId ? rawGroups.filter((group) => group.duplicateId === groupId) : rawGroups.slice(0, scanLimit);
    if (groupId && selected.length !== 1) throw new ExecutionServiceError(404, "group_not_found", "Duplicate group not found");
    const normalized = normalizeDuplicates(selected);
    const withFileSize = await enrichDuplicatesWithAssetInfo(normalized);
    const withAlbums = await enrichDuplicatesWithAlbums(withFileSize);
    return { groups: withAlbums.groups, decisions: await execution.evaluateGroups(withAlbums.groups) };
  }

  app.post("/execution/duplicates/:groupId", async (req, res) => {
    const parsed = ExecutionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Invalid execution request", issues: parsed.error.issues });
    try {
      const groupId = req.params.groupId;
      const batch = await execution.run({ ...parsed.data, singleGroupId: groupId, executeLimit: 1 }, () => loadExecutionGroups(1, groupId));
      res.json({ ok: true, runId: batch.runId, dryRun: batch.dryRun, decision: batch.decision, execution: batch.results[0] });
    } catch (error) { executionError(res, error); }
  });
  app.post("/execution/run", async (req, res) => {
    const parsed = ExecutionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Invalid execution request", issues: parsed.error.issues });
    try {
      const batch = await execution.run(parsed.data, () => loadExecutionGroups(parsed.data.scanLimit));
      const { decision: _decision, ...response } = batch;
      res.json(response);
    } catch (error) { executionError(res, error); }
  });

  return app;
}
