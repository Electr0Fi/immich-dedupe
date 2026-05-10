import { init } from "@immich/sdk";
import { env } from "./config";

init({
  baseUrl: env.IMMICH_URL,
  apiKey: env.IMMICH_API_KEY,
});