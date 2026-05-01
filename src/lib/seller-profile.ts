/**
 * Fetches the Amazon seller profile page (/sp?seller=SELLER_ID)
 * using a headless Chromium browser and extracts the business address.
 *
 * Uses @sparticuz/chromium for Vercel/Lambda compatibility.
 */

import { chromium as playwrightChromium } from "playwright-core";

export interface SellerProfile {
  sellerId: string;
  businessName?: string;
  businessAddress?: string;
  city?: string;
  state?: string;
  country?: string;        // e.g. "US", "CN", "KR"
  countryFull?: string;    // e.g. "United States", "China"
  rawText?: string;
  error?: string;
}

function parseAddressText(raw: string): Partial<SellerProfile> {
  const result: Partial<SellerProfile> = { rawText: raw };

  // Extract country code (always last line of address block, e.g. "US", "CN", "KR", "GB")
  const countryCodeMatch = raw.match(/\n([A-Z]{2})\s*\n?(?:Shipping|Other|Help|$)/);
  if (countryCodeMatch) result.country = countryCodeMatch[1];

  // Map country codes to full names
  const countryMap: Record<string, string> = {
    US: "United States", CN: "China", HK: "Hong Kong", TW: "Taiwan",
    KR: "South Korea", JP: "Japan", SG: "Singapore", MY: "Malaysia",
    TH: "Thailand", VN: "Vietnam", PH: "Philippines", IN: "India",
    ID: "Indonesia", GB: "United Kingdom", DE: "Germany", FR: "France",
    CA: "Canada", AU: "Australia", MX: "Mexico", BR: "Brazil",
    PK: "Pakistan", BD: "Bangladesh",
  };
  if (result.country && countryMap[result.country]) {
    result.countryFull = countryMap[result.country];
  }

  // Extract state (US only — 2-letter before country code)
  const stateMatch = raw.match(/\n([A-Z]{2})\n[A-Z0-9 ]+\n[A-Z]{2}\n/);
  if (stateMatch) result.state = stateMatch[1];

  // Extract city — line before state/zip
  const lines = raw
    .replace(/Business Address:\s*/i, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // Lines: [street, city, state, zip, country_code, ...]
  if (lines.length >= 4) {
    result.businessAddress = lines.slice(0, 4).join(", ");
    result.city = lines[1] ?? "";
  } else if (lines.length >= 2) {
    result.businessAddress = lines.join(", ");
  }

  return result;
}

export async function fetchSellerProfile(sellerId: string): Promise<SellerProfile> {
  const url = `https://www.amazon.com/sp?seller=${sellerId}`;
  let browser = null;

  try {
    // In production (Vercel Lambda), use @sparticuz/chromium
    // In dev, fall back to local playwright chromium
    let executablePath: string | undefined;
    let chromiumArgs: string[] = [];

    if (process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL) {
      const chromium = (await import("@sparticuz/chromium")).default;
      executablePath = await chromium.executablePath();
      chromiumArgs = chromium.args;
    }

    browser = await playwrightChromium.launch({
      executablePath,
      args: [
        ...chromiumArgs,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
      headless: true,
    });

    const page = await browser.newPage();

    // Set a realistic user agent
    await page.setExtraHTTPHeaders({
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

    // Extract business address from page body text
    const bodyText = await page.evaluate(() => document.body.innerText);

    const addrIdx = bodyText.indexOf("Business Address:");
    if (addrIdx === -1) {
      // Seller hasn't disclosed address, or page didn't load right
      return {
        sellerId,
        error: "Business address not disclosed on seller profile",
      };
    }

    const addressBlock = bodyText.substring(addrIdx, addrIdx + 300);
    const parsed = parseAddressText(addressBlock);

    // Also try to grab seller display name
    const nameEl = await page.$("h1.a-size-large, .a-profile-name, h1");
    const businessName = nameEl ? await nameEl.innerText() : undefined;

    return {
      sellerId,
      businessName: businessName?.trim(),
      ...parsed,
    };
  } catch (err) {
    return {
      sellerId,
      error: err instanceof Error ? err.message : "Unknown error fetching seller profile",
    };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Determine if a seller is Asia-based (excluding Japan) based on their profile.
 * Returns: "asia" | "japan" | "non-asia" | "unknown"
 */
export type SellerOriginCategory = "asia" | "japan" | "non-asia" | "unknown";

const ASIA_NON_JAPAN_COUNTRIES = new Set([
  "CN", "HK", "TW", "KR", "SG", "MY", "TH", "VN", "PH",
  "IN", "ID", "PK", "BD", "MM", "KH", "LK", "MN",
]);

const JAPAN_COUNTRIES = new Set(["JP"]);

export function categorizeSellerOrigin(profile: SellerProfile): SellerOriginCategory {
  if (profile.error || !profile.country) return "unknown";
  if (JAPAN_COUNTRIES.has(profile.country)) return "japan";
  if (ASIA_NON_JAPAN_COUNTRIES.has(profile.country)) return "asia";
  return "non-asia";
}
