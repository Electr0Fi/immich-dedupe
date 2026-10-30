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
    getAlbumInfo: unexpected, pingServer: unexpected, addAssetsToAlbums: unexpected,
    resolveDuplicates: unexpected, ...overrides,
  };
}

export function temporaryLog(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'immich-dedupe-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createExecutionLog(path.join(dir, 'data', 'execution-log.json'));
}
