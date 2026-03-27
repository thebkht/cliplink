declare namespace Cloudflare {
  interface Env {
    CLIPLINK_ROOMS: KVNamespace;
    ASSETS: Fetcher;
    NEXTJS_ENV: string;
  }
}

type CloudflareEnv = Cloudflare.Env;

type StringifyValues<EnvType extends Record<string, unknown>> = {
  [Binding in keyof EnvType]: EnvType[Binding] extends string
    ? EnvType[Binding]
    : string;
};

declare namespace NodeJS {
  interface ProcessEnv extends StringifyValues<Pick<Cloudflare.Env, "NEXTJS_ENV">> {
    NEXTJS_ENV: string;
  }
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: {
      expirationTtl?: number;
    },
  ): Promise<void>;
}
