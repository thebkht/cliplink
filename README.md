# CLIPLINK

CLIPLINK is a lightweight zero-auth clipboard sync app built with Next.js App Router and deployed to Cloudflare via OpenNext.

## Getting Started

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Deployment

CLIPLINK deploys to Cloudflare Workers using OpenNext.

Required Cloudflare build settings:

```bash
Build command: npx @opennextjs/cloudflare build
Deploy command: npx @opennextjs/cloudflare deploy
```

Before deploying, make sure [wrangler.jsonc](/Users/thebkht/Projects/cliplink/wrangler.jsonc) has real KV namespace IDs for the `CLIPLINK_ROOMS` binding.

Useful local commands:

```bash
npm run build
npm run build:worker
npm run deploy:worker
```

The app currently ships M1 polling transport and has begun the M2 SSE upgrade path.
