import { z } from "zod";
import type { NormalizedDuplicatesResponse } from "@immich-dedupe/shared";
import type { ImmichClient } from "./immichClient";

const albumList = z.array(z.object({ id: z.string().min(1), albumName: z.string() }));

/** Read complete per-asset album memberships, including shared albums. */
export function createAlbumEnricher(client: Pick<ImmichClient, "getAllAlbums" | "getAlbumInfo">) {
  return async function enrichDuplicatesWithAlbums(normalized: NormalizedDuplicatesResponse): Promise<NormalizedDuplicatesResponse> {
    const result = structuredClone(normalized);
    for (const group of result.groups) for (const asset of group.assets) {
      // Settle every started read before returning, including on the coordinator path.
      const settled = await Promise.allSettled([
        client.getAllAlbums({ assetId: asset.id }), client.getAllAlbums({ assetId: asset.id, shared: true }),
      ]);
      const memberships = new Map<string, string>();
      for (const response of settled) {
        if (response.status === "rejected") throw new Error("Album memberships could not be read");
        for (const album of albumList.parse(response.value)) {
          if (memberships.has(album.id) && memberships.get(album.id) !== album.albumName) throw new Error("Conflicting album information");
          memberships.set(album.id, album.albumName);
        }
      }
      asset.albums = [...memberships].sort(([a], [b]) => a.localeCompare(b)).map(([albumId, albumName]) => ({ albumId, albumName }));
      asset.albumsKnown = true;
    }
    return result;
  };
}
