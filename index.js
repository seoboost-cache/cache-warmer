// cache-warmer.js
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { parseStringPromise } from "xml2js";
import * as dotenv from "dotenv";

dotenv.config();

/* ====== ENV WAJIB ====== */
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

/* ====== KONFIG DOMAIN/PROXY/UA ====== */
const DOMAINS_MAP = {
  id: "https://seoboost.co.id",
};

const PROXIES = {
  id: process.env.BRD_PROXY_ID,
};

const USER_AGENTS = {
  id: "Seoboost-CacheWarmer-ID/1.0",
};

/* ====== CLOUDFLARE (opsional) ====== */
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

/* ====== APPS SHEET HEADERS (WITH vercel_edge) ====== */
const APPS_SHEET_HEADERS = [
  "run_id",
  "started_at",
  "finished_at",
  "country",
  "url",
  "status",
  "cf_cache",
  "vercel_cache",
  "cf_ray",
  "vercel_edge", // <-- added
  "response_ms",
  "error",
  "message",
];

/* ====== UTIL ====== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cryptoRandomId = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);

function makeSheetNameForRun(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const local = new Date(date.getTime() + 8 * 3600 * 1000); // WITA
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(
    local.getUTCDate()
  )}_${pad(local.getUTCHours())}-${pad(local.getUTCMinutes())}-${pad(
    local.getUTCSeconds()
  )}_WITA`;
}

/* ====== LOGGER → APPS SCRIPT ====== */
class AppsScriptLogger {
  constructor() {
    this.rows = [];
    this.runId = cryptoRandomId();
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.sheetName = makeSheetNameForRun();
  }

  log({
    country = "",
    url = "",
    status = "",
    cfCache = "",
    vcCache = "",
    cfRay = "",
    vercelEdge = "",
    responseMs = "",
    error = 0,
    message = "",
  }) {
    this.rows.push([
      this.runId,
      this.startedAt,
      this.finishedAt,
      country,
      url,
      status,
      cfCache,
      vcCache,
      cfRay,
      vercelEdge, // <-- new value
      typeof responseMs === "number" ? responseMs : "",
      error ? 1 : 0,
      message,
    ]);
  }

  setFinished() {
    this.finishedAt = new Date().toISOString();
    this.rows = this.rows.map((r) => ((r[2] = this.finishedAt), r));
  }

  async flush() {
    if (!APPS_SCRIPT_URL) return;

    if (this.rows.length === 0) return;

    try {
      const payload = {
        sheetName: this.sheetName,
        headers: APPS_SHEET_HEADERS,
        rows: this.rows,
      };

      const res = await axios.post(APPS_SCRIPT_URL, payload, {
        timeout: 60000,
        headers: { "Content-Type": "application/json" },
      });

      console.log("Apps Script response:", res.status, res.data);
      this.rows = [];
    } catch (e) {
      console.warn("Apps Script logging error:", e);
    }
  }
}

/* ====== HTTP helper ====== */
function buildAxiosCfg(country, extra = {}) {
  const proxy = PROXIES[country];
  const headers = { "User-Agent": USER_AGENTS[country] };

  let httpAgent, httpsAgent;

  if (proxy) {
    try {
      const u = new URL(proxy);
      if (u.username && u.password) {
        const basic = Buffer.from(
          `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`
        ).toString("base64");
        headers["Proxy-Authorization"] = `Basic ${basic}`;
      }
      const agent = new HttpsProxyAgent(proxy, { keepAlive: true });
      httpAgent = agent;
      httpsAgent = agent;
    } catch (e) {
      console.warn(`[${country}] Invalid proxy URL: ${proxy}`);
    }
  }

  return {
    headers,
    timeout: 30000,
    httpAgent,
    httpsAgent,
    ...extra,
  };
}

/* ====== SITEMAP ====== */
async function fetchWithProxy(url, country, timeout = 15000) {
  const cfg = buildAxiosCfg(country, { timeout });
  const res = await axios.get(url, cfg);
  return res.data;
}

async function fetchUrlsFromSingleSitemap(domain, country) {
  try {
    const xml = await fetchWithProxy(`${domain}/sitemap.xml`, country, 20000);
    const result = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });

    const urlList = result?.urlset?.url;
    if (!urlList) return [];

    const urls = Array.isArray(urlList) ? urlList : [urlList];
    const locs = urls.map((entry) => entry.loc).filter(Boolean);

    const sameHost = new URL(domain).host.replace(/^www\./i, "");

    return Array.from(
      new Set(
        locs.filter((u) => {
          try {
            return new URL(u).host.replace(/^www\./i, "") === sameHost;
          } catch {
            return false;
          }
        })
      )
    );
  } catch (err) {
    console.warn(`[${country}] sitemap fetch failed:`, err.message);
    return [];
  }
}

/* ====== vercel edge POP parser ====== */
function getVercelEdgePop(vercelId) {
  if (typeof vercelId !== "string") return "N/A";
  const parts = vercelId.split("::").filter(Boolean);
  return parts[0] || "N/A"; // contoh: "sin1", "fra1", "iad1"
}

/* ====== WARMING ====== */
async function retryableGet(url, cfg, retries = 3) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, cfg);
    } catch (err) {
      lastErr = err;
      if (!["ECONNABORTED", "ECONNRESET", "ETIMEDOUT"].includes(err?.code))
        break;
      await sleep(2000);
    }
  }
  throw lastErr;
}

async function purgeCloudflareCache(url) {
  if (!CLOUDFLARE_ZONE_ID || !CLOUDFLARE_API_TOKEN) return;
  try {
    const purgeRes = await axios.post(
      `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache`,
      { files: [url] },
      {
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (purgeRes.data?.success) {
      console.log(`✅ Cloudflare cache purged: ${url}`);
    } else {
      console.warn(`⚠️ Failed to purge Cloudflare: ${url}`);
    }
  } catch {
    console.warn(`❌ Error purging Cloudflare: ${url}`);
  }
}

async function warmUrls(urls, country, logger, batchSize = 1, delay = 2000) {
  const batches = Array.from(
    { length: Math.ceil(urls.length / batchSize) },
    (_, i) => urls.slice(i * batchSize, i * batchSize + batchSize)
  );

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (url) => {
        const t0 = Date.now();
        try {
          const res = await retryableGet(
            url,
            buildAxiosCfg(country, { timeout: 15000 }),
            3
          );
          const dt = Date.now() - t0;

          const cfCache = res.headers["cf-cache-status"] || "N/A";
          const vcCache = res.headers["x-vercel-cache"] || "N/A";
          const cfRay = res.headers["cf-ray"] || "N/A";
          const vercelId = res.headers["x-vercel-id"] || "N/A";
          const vercelEdge = getVercelEdgePop(vercelId);

          // CF edge sebagai countryTag
          let cfEdge = "N/A";
          if (typeof cfRay === "string" && cfRay.includes("-")) {
            const parts = cfRay.split("-");
            cfEdge = parts[parts.length - 1] || "N/A";
          }

          const countryTag = cfEdge && cfEdge !== "N/A" ? cfEdge : country;

          console.log(
            `[${countryTag}] ${res.status} cf=${cfCache} vc=${vcCache} cf_edge=${cfEdge} vercel_edge=${vercelEdge} - ${url}`
          );

          logger.log({
            country: countryTag,
            url,
            status: res.status,
            cfCache,
            vcCache,
            cfRay,
            vercelEdge,
            responseMs: dt,
            error: 0,
            message: "",
          });

          // Purge Cloudflare cache if Vercel cache is not HIT
          if (String(vcCache).toUpperCase() !== "HIT") {
            await purgeCloudflareCache(url);
          }
        } catch (err) {
          const dt = Date.now() - t0;
          console.warn(
            `[${country}] ❌ Failed to warm ${url}: ${err?.message || err}`
          );

          logger.log({
            country,
            url,
            responseMs: dt,
            error: 1,
            message: err?.message || "request failed",
          });
        }
      })
    );

    await sleep(delay);
  }
}

/* ====== MAIN ====== */
(async () => {
  console.log(`[CacheWarmer] Started`);
  const logger = new AppsScriptLogger();

  try {
    await Promise.all(
      Object.entries(DOMAINS_MAP).map(async ([country, domain]) => {
        const urls = await fetchUrlsFromSingleSitemap(domain, country);

        logger.log({
          country,
          message: `Found ${urls.length} URLs`,
        });

        await warmUrls(urls, country, logger);
      })
    );
  } finally {
    logger.setFinished();
    await logger.flush();
  }

  console.log(`[CacheWarmer] Finished`);
})();
