import express from "express";
import cors from "cors";
import { env } from "./config";
import "./immich";

import {
  getAllAlbums,
  getAlbumInfo,
  getAssetDuplicates,
  getAssetInfo,
  pingServer,
} from "@immich/sdk";

import { normalizeDuplicates } from "./normalizeDuplicates";
import { enrichDuplicatesWithAssetInfo } from "./enrichWithAssetInfo";
import { enrichDuplicatesWithAlbums } from "./enrichWithAlbums";
import { evaluateDuplicateGroups } from "@immich-dedupe/rule-engine";
import type {
  DuplicateDecision,
  DuplicateGroup,
  ExecutionPlanItem,
} from "@immich-dedupe/shared";
import { executeDuplicateDecision } from "./executeDecision";
import { executePlan, isExecutableDecision } from "./executePlan";
import {
  type ExecutionLogEntry,
  clearExecutionLog,
  getExecutionLogPath,
  getProcessedGroupIds,
  loadExecutionLog,
} from "./executionLog";

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

function parseExecutionLimits(body: any): {
  scanLimit: number;
  executeLimit: number;
} {
  const legacyLimit = parsePositiveLimit(body?.limit, 10);

  const scanLimit = parsePositiveLimit(
    body?.scanLimit,
    body?.limit ? legacyLimit : 100
  );

  const executeLimit = parsePositiveLimit(
    body?.executeLimit,
    body?.limit ? legacyLimit : 10
  );

  return {
    scanLimit,
    executeLimit,
  };
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

function escapeCsvValue(value: string | boolean | null): string {
  if (value === null) {
    return "";
  }

  const text = String(value);

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function buildExecutionLogCsv(log: ExecutionLogEntry[]): string {
  const columns: Array<keyof ExecutionLogEntry> = [
    "timestamp",
    "groupId",
    "mode",
    "keepAssetId",
    "trashAssetId",
    "executed",
    "resolvedDuplicate",
    "trashedAsset",
    "message",
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

    const results = evaluateDuplicateGroups(withAlbums.groups);

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

    const decisions = evaluateDuplicateGroups(withAlbums.groups);

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

app.post("/execution/log/clear", (_req, res) => {
  const clearedCount = clearExecutionLog();

  res.json({
    ok: true,
    path: getExecutionLogPath(),
    clearedCount,
  });
});

app.get("/execution/status", async (req, res) => {
  try {
    const scanLimit = parsePositiveLimit(req.query.scanLimit, 100);

    const duplicates = await getAssetDuplicates({});
    const rawGroups = Array.isArray(duplicates) ? duplicates : [];
    const slicedGroups = rawGroups.slice(0, scanLimit);

    const normalized = normalizeDuplicates(slicedGroups);
    const withFileSize = await enrichDuplicatesWithAssetInfo(normalized);
    const withAlbums = await enrichDuplicatesWithAlbums(withFileSize);

    const decisions = evaluateDuplicateGroups(withAlbums.groups);

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
    const decision = evaluateDuplicateGroups([group])[0];

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

app.post("/execution/duplicates/:groupId", async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const dryRun = req.body?.dryRun === true;

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
    const decision = evaluateDuplicateGroups([group])[0];

    if (!group || !decision) {
      return res.status(500).json({
        ok: false,
        error: "Failed to execute duplicate decision",
      });
    }

    const result = await executeDuplicateDecision(group, decision, dryRun);

    res.json({
      ok: true,
      dryRun,
      decision,
      execution: result,
    });
  } catch (error) {
    console.error("POST /execution/duplicates/:groupId failed:", error);

    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/execution/run", async (req, res) => {
  try {
    const { scanLimit, executeLimit } = parseExecutionLimits(req.body);
    const dryRun = req.body?.dryRun === true;

    const duplicates = await getAssetDuplicates({});
    const rawGroups = Array.isArray(duplicates) ? duplicates : [];
    const slicedGroups = rawGroups.slice(0, scanLimit);

    const normalized = normalizeDuplicates(slicedGroups);
    const withFileSize = await enrichDuplicatesWithAssetInfo(normalized);
    const withAlbums = await enrichDuplicatesWithAlbums(withFileSize);

    const decisions = evaluateDuplicateGroups(withAlbums.groups);
    const processedGroupIds = getProcessedGroupIds();
    const eligibleCount = decisions.filter(
      (decision) =>
        isExecutableDecision(decision) && !processedGroupIds.has(decision.groupId)
    ).length;

    const results = await executePlan(
      withAlbums.groups,
      decisions,
      executeLimit,
      dryRun
    );

    const actuallyExecutedCount = results.filter((result) => result.executed).length;
    const resolvedCount = results.filter(
      (result) => result.resolvedDuplicate
    ).length;
    const trashedCount = results.filter((result) => result.trashedAsset).length;

    res.json({
      ok: true,
      dryRun,
      scanLimit,
      executeLimit,
      fetchedGroups: slicedGroups.length,
      eligibleCount,
      actuallyExecutedCount,
      resolvedCount,
      trashedCount,
      results,
    });
  } catch (error) {
    console.error("POST /execution/run failed:", error);

    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT}`);
});
