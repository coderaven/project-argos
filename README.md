# Project Argos — Amazon Counterfeit Detector

A web app that crawls Amazon search results for a given keyword and flags physical products sold by third-party sellers (potential counterfeits). Built as a prototype for integration into a larger counterfeit detection system.

**Live demo:** https://argos.ravenduran.com (password: `argos`)

---

## What It Does

Given a keyword (e.g. a brand name), Argos:

1. Crawls Amazon search results page by page (up to 20 pages)
2. Pre-filters each product on the search page (no extra API call):
   - Skips products where the keyword is not an exact word in the title (case-insensitive)
   - Skips digital products (Kindle, Prime Video, MP3, Audible, etc.)
   - Skips media/entertainment (Blu-ray, DVD, film collections, animated series, etc.)
   - Skips books, coloring books, art books, puzzles, pinball machines
3. For remaining candidates, fetches the product detail page to get the seller name
4. Flags as a **HIT** if:
   - Seller is NOT Amazon (Amazon.com, Amazon Export Sales LLC, etc.)
   - Product is NOT digital
   - Product is NOT licensed media
5. Returns the full hit list with title, ASIN, seller, price, category, and Amazon URL
6. Allows export of results to CSV

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| Styling | Tailwind CSS + shadcn/ui |
| Scraping API | Oxylabs Amazon Scraper API |
| Streaming | Server-Sent Events (SSE) for live progress |
| Auth | Edge Middleware + httpOnly cookie |
| Hosting | Vercel |

---

## Project Structure

```
src/
├── app/
│   ├── page.tsx              # Main UI — search form + live log + results + CSV export
│   ├── login/
│   │   └── page.tsx          # Password-protected login page
│   └── api/
│       ├── auth/
│       │   └── route.ts      # POST /api/auth — validates password, sets httpOnly cookie
│       └── scan/
│           └── route.ts      # POST /api/scan — SSE stream, core crawl + filter logic
├── middleware.ts              # Edge auth guard — protects all routes + API endpoints
└── providers/
    └── query-provider.tsx    # TanStack Query provider
```

---

## Core Logic (`/api/scan/route.ts`)

The scan endpoint streams Server-Sent Events (SSE) to the client. All crawling and filtering is deterministic TypeScript — no LLM involved in the crawl loop.

### Flow

```
POST /api/scan { keyword, pages }
  └── for page 1..N:
        └── oxylabsSearch(keyword, page)          → search results page
              └── pre-filter items (title, digital, media)
                    └── Promise.all(oxylabsProduct(asin)) → parallel detail fetches
                          └── apply seller + category filters
                                └── emit SSE "candidate" event if HIT
  └── emit SSE "done" event with full report
```

### SSE Event Types

| Event | Payload | Description |
|-------|---------|-------------|
| `status` | `{ message }` | Scan started |
| `progress` | `{ message }` | Page-level or ASIN-level progress |
| `candidate` | `{ message }` | A hit was found (real-time) |
| `done` | `{ report }` | Final report JSON |
| `error` | `{ message }` | Something failed |

### Report Shape

```typescript
{
  keyword: string;
  pages_crawled: number;
  total_products_checked: number;
  hits: Array<{
    title: string;
    asin: string;
    seller: string;
    price: string;
    url: string;
    category: string;
    reason: string;
  }>;
}
```

---

## Filter Logic

### What Gets Skipped (NOT flagged)

| Filter | Examples |
|--------|---------|
| Amazon as seller | "Amazon.com", "Amazon Export Sales LLC" |
| Digital products | Kindle editions, Prime Video, MP3, Audible, digital downloads |
| Entertainment media | Blu-ray, DVD, 4K UHD, film collections, animated series, criterion collection |
| Books & other | Coloring books, art books, encyclopedias, puzzles, pinball machines |
| Keyword mismatch | Title doesn't contain the keyword as an exact word |

### What Gets Flagged (HIT)

Physical products (toys, clothing, accessories, figures, merchandise, etc.) sold by a **third-party seller** that are NOT Amazon, NOT digital, NOT licensed media, and contain the keyword in the title.

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OXYLABS_USER` | Oxylabs API username |
| `OXYLABS_PASS` | Oxylabs API password |
| `OPENAI_API_KEY` | OpenAI API key (used in standalone Python script, not web app) |
| `ARGOS_PASSWORD` | The password users type to log in (e.g. `argos`) |
| `ARGOS_SECRET` | Internal cookie token — must be a long random string, never exposed |

---

## Auth

- **Edge Middleware** (`src/middleware.ts`) intercepts ALL requests (pages + API routes) before they hit any handler
- Unauthenticated requests → redirect to `/login`
- `POST /api/auth` validates `ARGOS_PASSWORD`, sets an `httpOnly + secure + sameSite=strict` cookie containing `ARGOS_SECRET`
- Cookie is valid for 7 days
- Direct API abuse (hitting `/api/scan` without cookie) is blocked at the middleware level — no way to bypass from the frontend

---

## Oxylabs API

Uses two endpoints:

### Search
```
POST https://realtime.oxylabs.io/v1/queries
{
  "source": "amazon_search",
  "domain": "com",
  "query": "<keyword>",
  "start_page": <N>,
  "pages": 1,
  "parse": true
}
```

Response structure used:
- `results[0].content.results.organic[]` — main product list
- `results[0].content.results.amazons_choices[]` — Amazon's Choice products
- `results[0].content.last_visible_page` — to detect when results run out

### Product Detail
```
POST https://realtime.oxylabs.io/v1/queries
{
  "source": "amazon_product",
  "domain": "com",
  "query": "<ASIN>",
  "parse": true
}
```

Fields used from response:
- `results[0].content.featured_merchant.name` → seller name (primary)
- `results[0].content.buybox[0].seller_name` → seller name (fallback)
- `results[0].content.category[0].ladder[]` → category breadcrumb
- `results[0].content.title` → full product title
- `results[0].content.variation[]` → variations (for digital detection)

---

## Standalone Python Script

A standalone CLI script also exists at `../project-argos/argos.py` (sibling directory). It uses the same Oxylabs + OpenAI agent approach and can be run directly:

```bash
python3 argos.py --keyword "Godzilla" --pages 20 --output results.json
```

The web app's scan route is the production-ready version (no LLM, deterministic, parallel).

---

## Integration Notes for AI Agent

When integrating into a larger app:

1. **Copy the filter logic** from `src/app/api/scan/route.ts` — the `isDigital()`, `isMediaProduct()`, `isAmazonSeller()`, and `keywordInTitle()` functions are self-contained and reusable.

2. **The scan loop** (lines inside `start(controller)`) can be extracted into a standalone `scanAmazon(keyword, maxPages, onEvent)` function. The SSE streaming is just a delivery mechanism.

3. **Parallelization pattern** — product detail calls are batched with `Promise.all()` per page. This keeps the scan fast without overwhelming Oxylabs.

4. **Auth is self-contained** — `middleware.ts` + `/api/auth/route.ts` can be dropped in or replaced with whatever auth system the larger app uses.

5. **Vercel timeout** — max 300s on Vercel Pro. For scans > 20 pages or slower keywords, consider moving the scan to a long-running backend (VPS + FastAPI/Express) and having Vercel proxy to it.

6. **Oxylabs rate limits** — the free trial gives 2,000 results. Each search page = 1 result, each product detail = 1 result. A 20-page scan with ~5 candidates/page = ~120 Oxylabs calls.

---

## Local Development

```bash
npm install

# Create .env.local
cp .env.example .env.local
# Fill in your values

npm run dev
# → http://localhost:3000
```

`.env.local`:
```
OXYLABS_USER=your_oxylabs_username
OXYLABS_PASS=your_oxylabs_password
OPENAI_API_KEY=sk-...
ARGOS_PASSWORD=argos
ARGOS_SECRET=any-long-random-string
```

---

## Deployment (Vercel)

```bash
vercel --prod
```

Set env vars via Vercel dashboard or CLI:
```bash
printf "value" | vercel env add VAR_NAME production
```

> ⚠️ Use `printf` not `echo` — `echo` adds a trailing newline that corrupts the value.

---

*Built by Nap Solutions · May 2026*
