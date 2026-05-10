import type {
  AlbumMembership,
  AssetRecord,
  DuplicateGroup,
  NormalizedDuplicatesResponse,
} from "@immich-dedupe/shared";
import { getAllAlbums, getAlbumInfo } from "@immich/sdk";

type RawAlbumListItem = {
  id?: string;
  albumName?: string;
};

type RawAlbumAsset = {
  id?: string;
};

type RawAlbumDetail = {
  id?: string;
  albumName?: string;
  assets?: RawAlbumAsset[];
};

type AssetAlbumIndex = Map<string, AlbumMembership[]>;

function pushMembership(
  index: AssetAlbumIndex,
  assetId: string,
  membership: AlbumMembership
) {
  const existing = index.get(assetId) ?? [];
  existing.push(membership);
  index.set(assetId, existing);
}

async function buildAssetAlbumIndex(): Promise<AssetAlbumIndex> {
  const index: AssetAlbumIndex = new Map();

  const albums = (await getAllAlbums({})) as RawAlbumListItem[];

  for (const album of albums) {
    if (typeof album.id !== "string") continue;

    const detail = (await getAlbumInfo({
      id: album.id,
      withoutAssets: false,
    })) as RawAlbumDetail;

    const albumId = typeof detail.id === "string" ? detail.id : album.id;
    const albumName =
      typeof detail.albumName === "string"
        ? detail.albumName
        : typeof album.albumName === "string"
          ? album.albumName
          : "Unknown Album";

    if (!Array.isArray(detail.assets)) continue;

    for (const asset of detail.assets) {
      if (typeof asset.id !== "string") continue;

      pushMembership(index, asset.id, {
        albumId,
        albumName,
      });
    }
  }

  return index;
}

function enrichAssetWithAlbums(
  asset: AssetRecord,
  index: AssetAlbumIndex
): AssetRecord {
  return {
    ...asset,
    albums: index.get(asset.id) ?? [],
  };
}

function enrichGroupWithAlbums(
  group: DuplicateGroup,
  index: AssetAlbumIndex
): DuplicateGroup {
  return {
    ...group,
    assets: group.assets.map((asset) => enrichAssetWithAlbums(asset, index)),
  };
}

export async function enrichDuplicatesWithAlbums(
  normalized: NormalizedDuplicatesResponse
): Promise<NormalizedDuplicatesResponse> {
  const index = await buildAssetAlbumIndex();

  const groups = normalized.groups.map((group) =>
    enrichGroupWithAlbums(group, index)
  );

  const totalAssets = groups.reduce((sum, group) => sum + group.assets.length, 0);

  return {
    groups,
    totalGroups: groups.length,
    totalAssets,
  };
}