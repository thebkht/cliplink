import { getCloudflareContext } from "@opennextjs/cloudflare";

type CliplinkKvNamespace = {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: {
      expirationTtl?: number;
    },
  ): Promise<void>;
};

export type CliplinkCloudflareEnv = {
  CLIPLINK_ROOMS?: CliplinkKvNamespace;
};

export function getOptionalCloudflareEnv(): CliplinkCloudflareEnv | null {
  try {
    return getCloudflareContext().env as CliplinkCloudflareEnv;
  } catch {
    return null;
  }
}
