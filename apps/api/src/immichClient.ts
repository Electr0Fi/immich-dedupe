import type * as sdk from "@immich/sdk";

/** Only the SDK operations used by the backend; importing this type has no side effects. */
export type ImmichClient = Pick<typeof sdk,
  | "getAllAlbums"
  | "getAlbumInfo"
  | "getAssetDuplicates"
  | "getAssetInfo"
  | "pingServer"
  | "addAssetsToAlbums"
  | "resolveDuplicates"
>;
