import { z } from 'zod';
import type { ImmichClient } from './immichClient';
import { albumDetailSchema } from './freshPreflight';

const headerSchema = z.object({ id: z.string().min(1) }).passthrough();
const modernAlbumSchema = z.object({ id: z.string().min(1), albumName: z.string(), assetCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
const membershipsSchema = z.array(z.object({ id: z.string().min(1), albumName: z.string() }));
export class AlbumMembershipError extends Error {}

/** Fresh positive membership evidence, supporting both embedded assets and Immich v3 album metadata. */
export async function readAlbumMembership(client: Pick<ImmichClient, 'getAlbumInfo' | 'getAllAlbums'>, albumId: string, assetIds: string[]) {
  let raw: unknown;
  try { raw = await client.getAlbumInfo({ id: albumId, withoutAssets: false }); }
  catch { throw new AlbumMembershipError('Album details could not be read from Immich; check album.read and account access.'); }
  const header = headerSchema.safeParse(raw);
  if (!header.success) throw new AlbumMembershipError('Immich returned incomplete album details; membership could not be verified.');
  if (header.data.id !== albumId) throw new AlbumMembershipError('Album identity changed; membership could not be verified.');
  if ('assets' in header.data) {
    const legacy = albumDetailSchema.safeParse(raw);
    if (!legacy.success) throw new AlbumMembershipError('Immich returned an invalid album assets list; membership could not be verified.');
    return { id: albumId, assetIds: new Set(legacy.data.assets.map((asset) => asset.id)) };
  }
  const modern = modernAlbumSchema.safeParse(raw);
  if (!modern.success) throw new AlbumMembershipError('Immich returned incomplete album metadata; membership could not be verified.');
  // v2.7 and v3 both support assetId on GET /albums and include accessible shared
  // albums. Counts and a successful add response alone never prove membership.
  const ids = [...new Set(assetIds)];
  const reads = await Promise.allSettled(ids.map(async (assetId) => {
    let response: unknown;
    try { response = await client.getAllAlbums({ assetId }); }
    catch { throw new AlbumMembershipError('Album memberships could not be read from Immich; check album.read and account access.'); }
    const parsed = membershipsSchema.safeParse(response);
    if (!parsed.success) throw new AlbumMembershipError('Immich returned an incomplete album membership response.');
    const names = new Map<string, string>();
    for (const album of parsed.data) {
      if (names.has(album.id) && names.get(album.id) !== album.albumName) throw new AlbumMembershipError('Immich returned conflicting album membership information.');
      names.set(album.id, album.albumName);
    }
    if (names.has(albumId) && names.get(albumId) !== modern.data.albumName) throw new AlbumMembershipError('Album information changed during membership verification.');
    return names.has(albumId);
  }));
  const confirmed = new Set<string>();
  for (const [index, read] of reads.entries()) {
    if (read.status === 'rejected') throw read.reason;
    if (read.value) confirmed.add(ids[index]);
  }
  return { id: albumId, assetIds: confirmed };
}
