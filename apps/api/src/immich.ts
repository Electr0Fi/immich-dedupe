import * as sdk from "@immich/sdk";
import type { ImmichClient } from "./immichClient";
import { env } from "./config";

sdk.init({
  baseUrl: env.IMMICH_URL,
  apiKey: env.IMMICH_API_KEY,
});

export const immich: ImmichClient = sdk;
