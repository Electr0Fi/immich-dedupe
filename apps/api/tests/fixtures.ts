import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import {
  AssetTypeEnum, AssetVisibility, UserAvatarColor,
  type AssetResponseDto, type AlbumResponseDto, type DuplicateResponseDto,
} from '@immich/sdk';
import { normalizeDuplicates } from '../src/normalizeDuplicates';
import { createExecutionLog } from '../src/executionLog';
import { createExecutionJournal } from "../src/executionJournal";
import type { ImmichClient } from '../src/immichClient';

const timestamp = '2026-01-01T00:00:00.000Z';

export function rawAsset(id: string, overrides: Partial<AssetResponseDto> = {}): AssetResponseDto {
  return {
    id, checksum: 'checksum', createdAt: timestamp, updatedAt: timestamp,
    deviceAssetId: id, deviceId: 'device', duplicateId: 'group', duration: '0:00:00',
    fileCreatedAt: timestamp, fileModifiedAt: timestamp, localDateTime: timestamp,
    hasMetadata: true, height: 2000, width: 3000, isArchived: false, isEdited: false,
    isFavorite: false, isOffline: false, isTrashed: false, originalFileName: 'photo.jpg',
    originalPath: '/external/photo.jpg', ownerId: 'owner', thumbhash: null,
    type: AssetTypeEnum.Image, visibility: AssetVisibility.Timeline,
    ...overrides,
  };
}

export function rawGroup(groupId = 'group'): DuplicateResponseDto {
  return {
    duplicateId: groupId, suggestedKeepAssetIds: [],
    assets: [
      rawAsset(`${groupId}-keep`, { duplicateId: groupId }),
      rawAsset(`${groupId}-trash`, { duplicateId: groupId, originalPath: '/photos/internal/photo.jpg' }),
    ],
  };
}

export function group(groupId = 'group') {
  const normalized = normalizeDuplicates([rawGroup(groupId)]).groups[0];
  normalized.assets[0].fileSize = 200;
  normalized.assets[1].fileSize = 100;
  normalized.assets[0].albums = [{ albumId: 'shared', albumName: 'Shared' }];
  normalized.assets[1].albums = [
    { albumId: 'shared', albumName: 'Shared' },
    { albumId: 'missing', albumName: 'Missing' },
  ];
  return normalized;
}

export function album(id: string, assets: AssetResponseDto[]): AlbumResponseDto {
  return {
    id, albumName: id, albumThumbnailAssetId: null, albumUsers: [], assetCount: assets.length,
    assets, createdAt: timestamp, description: '', hasSharedLink: false, isActivityEnabled: false,
    owner: { id: 'owner', name: 'Owner', email: 'owner@example.test', avatarColor: UserAvatarColor.Primary,
      profileChangedAt: timestamp, profileImagePath: '' },
    ownerId: 'owner', shared: false, updatedAt: timestamp,
  };
}

export function fakeImmich(overrides: Partial<ImmichClient> = {}): ImmichClient {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected Immich call'); };
  return {
    getAssetDuplicates: unexpected, getAssetInfo: unexpected, getAllAlbums: unexpected,
    getAlbumInfo: unexpected, pingServer: unexpected, addAssetsToAlbums: unexpected, viewAsset: unexpected,
    resolveDuplicates: unexpected, getMyUser: async () => ({ id: "test-user" }), ...overrides,
  };
}

export function temporaryLog(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'immich-dedupe-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createExecutionLog(path.join(dir, 'data', 'execution-log.json'));
}

/** Stateful fake: album transfers and resolution change only these in-memory records. */
export function executionHarness(groupId = 'group') {
  const raw = rawGroup(groupId);
  raw.assets[0].exifInfo = { fileSizeInByte: 200 };
  raw.assets[1].exifInfo = { fileSizeInByte: 100 };
  const assets = new Map(raw.assets.map((asset) => [asset.id, asset]));
  const albums = new Map([
    ['shared', album('shared', [...raw.assets])],
    ['missing', album('missing', [raw.assets[1]])],
  ]);
  const calls: string[] = [];
  const delays: number[] = [];
  const mutations: string[] = [];
  const client = fakeImmich({
    getAssetDuplicates: async () => { calls.push('groups'); return [structuredClone(raw)]; },
    getAssetInfo: async ({ id }) => {
      calls.push(`asset:${id}`);
      const asset = assets.get(id);
      if (!asset) throw new Error('Asset not found');
      return structuredClone(asset);
    },
    getAllAlbums: async ({ assetId }) => {
      calls.push(`albums:${assetId}`);
      return [...albums.values()].filter((a) => !assetId || a.assets.some((asset) => asset.id === assetId)).map((a) => structuredClone(a));
    },
    getAlbumInfo: async ({ id }) => {
      calls.push(`album:${id}`);
      const result = albums.get(id);
      if (!result) throw new Error('Album not found');
      return structuredClone(result);
    },
    addAssetsToAlbums: async ({ albumsAddAssetsDto: dto }) => {
      calls.push('add'); mutations.push('add');
      for (const id of dto.albumIds) {
        const target = albums.get(id)!;
        for (const assetId of dto.assetIds) if (!target.assets.some((a) => a.id === assetId)) target.assets.push(assets.get(assetId)!);
      }
      return { success: true };
    },
    resolveDuplicates: async ({ duplicateResolveDto: dto }) => {
      calls.push('resolve'); mutations.push('resolve');
      for (const item of dto.groups) {
        for (const id of item.trashAssetIds) {
          assets.get(id)!.isTrashed = true;
          assets.get(id)!.duplicateId = null;
        }
        for (const id of item.keepAssetIds) assets.get(id)!.duplicateId = null;
      }
      return dto.groups.map((item) => ({ id: item.duplicateId, success: true }));
    },
  });
  return { client, raw, assets, albums, calls, mutations, delays,
    delay: async (ms: number) => { delays.push(ms); } };
}

export function temporaryJournal(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'immich-recovery-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createExecutionJournal(path.join(dir, 'execution-journal'));
}
