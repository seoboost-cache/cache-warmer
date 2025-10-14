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
  // ganti key "id" sesuai grouping kamu (hanya label internal)
  id: "https://seoboost.co.id",
};

const PROXIES = {
  // contoh: http://user:pass@zproxy.lum-superproxy.io:22225
  id: process.env.BRD_PROXY_ID,
};

const USER_AGENTS = {
  id: "Seoboost-CacheWarmer-ID/1.0",
};

/* ====== CLOUDFLARE (opsional) ====== */
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

/* ====== UTIL ====== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cryptoRandomId = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);

function makeSheetNameForRun(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const local = new Date(date.getTime() + 8 * 3600 * 1000); // WITA +08
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(
    local.getUTCDate()
  )}_${pad(local.getUTCHours())}-${pad(local.getUTCMinutes())}-${pad(
    local.getUTCSeconds()
  )}_WITA`;
}

/* ====== LOGGER → APPS SCRIPT (BATCH PER-RUN) ====== */
class AppsScriptLogger {
  constructor() {
    this.rows = [];
    this.runId = cryptoRandomId();
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.sheetName = makeSheetNameForRun(); // satu tab per-run
  }

  log({
    country = "",
    url = "",
    status = "",
    cfCache = "",
    vcCache = "",
    cfRay = "",
    vercelId = "",
    responseMs = "",
    error = 0,
    message = "",
  }) {
    this.rows.push([
      this.runId, // run_id
      this.startedAt, // started_at (ISO)
      this.finishedAt, // finished_at (isi saat finalize)
      country, // ⟵ diisi POP vercel (syd1/cdg1/...) bila ada
      url, // url
      status, // status code
      cfCache, // cf_cache (Cloudflare)
      vcCache, // vercel_cache (x-vercel-cache)
      cfRay, // cf_ray
      vercelId, // x-vercel-id (edge route)
      typeof responseMs === "number" ? responseMs : "", // response_ms
      error ? 1 : 0, // error (0/1)
      message, // message
    ]);
  }

  setFinished() {
    this.finishedAt = new Date().toISOString();
    this.rows = this.rows.map((r) => ((r[2] = this.finishedAt), r));
  }

  async flush() {
    if (!APPS_SCRIPT_URL) {
      console.warn("Apps Script logging disabled (missing APPS_SCRIPT_URL).");
      return;
    }
    if (this.rows.length === 0) return;

    try {
      const res = await axios.post(
        APPS_SCRIPT_URL,
        { sheetName: this.sheetName, rows: this.rows },
        { timeout: 20000, headers: { "Content-Type": "application/json" } }
      );
      console.log("Apps Script response:", res.status, res.data);
      if (!res.data?.ok) console.warn("Apps Script replied error:", res.data);
      this.rows = []; // bersihkan buffer
    } catch (e) {
      console.warn(
        "Apps Script logging error:",
        e?.response?.status,
        e?.response?.data || e?.message || e
      );
    }
  }
}

/* ====== HTTP helper (proxy) ====== */
function buildAxiosCfg(country, extra = {}) {
  const proxy = PROXIES[country];
  const headers = { "User-Agent": USER_AGENTS[country] };

  // siapkan agent + paksa Proxy-Authorization kalau ada user:pass
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
      console.warn(
        `[${country}] Invalid proxy URL: ${proxy} (${e?.message || e})`
      );
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

/* ====== SITEMAP (single /sitemap.xml) ====== */
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

    // dedup + pastikan host sama (jaga-jaga)
    const sameHost = new URL(domain).host.replace(/^www\./i, "");
    const unique = Array.from(
      new Set(
        locs.filter((u) => {
          try {
            const h = new URL(u).host.replace(/^www\./i, "");
            return h === sameHost;
          } catch {
            return false;
          }
        })
      )
    );

    return unique;
  } catch (err) {
    console.warn(
      `[${country}] ❌ Failed to fetch URLs from ${domain}/sitemap.xml: ${
        err?.message || err
      }`
    );
    return [];
  }
}

/* ====== WARMING ====== */
async function retryableGet(url, cfg, retries = 3) {
  let lastError = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, cfg);
    } catch (err) {
      lastError = err;
      const code = err?.code || "";
      const retryable =
        axios.isAxiosError(err) &&
        ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT"].includes(code);
      if (!retryable) break;
      await sleep(2000);
    }
  }
  throw lastError;
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

/* === Ambil POP vercel dari x-vercel-id (contoh: "syd1::iad1::xxxxx") === */
function getVercelEdgePop(vercelIdHeader) {
  if (typeof vercelIdHeader !== "string") return "N/A";
  const parts = vercelIdHeader.split("::").filter(Boolean);
  return parts[0] || "N/A"; // contoh: "syd1"
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

          // Isi kolom country dgn POP vercel (syd1/cdg1/...), fallback ke label country lama
          const edgePop = getVercelEdgePop(vercelId);
          const countryTag = edgePop !== "N/A" ? edgePop : country;

          console.log(
            `[${countryTag}] ${res.status} cf=${cfCache} vercel=${vcCache} edge=${edgePop} - ${url}`
          );

          logger.log({
            country: countryTag,
            url,
            status: res.status,
            cfCache,
            vcCache,
            cfRay,
            vercelId,
            responseMs: dt,
            error: 0,
            message: "",
          });

          // (opsional) purge Cloudflare jika Vercel belum HIT
          if (String(vcCache).toUpperCase() !== "HIT") {
            await purgeCloudflareCache(url);
          }
        } catch (err) {
          const dt = Date.now() - t0;
          console.warn(
            `[${country}] ❌ Failed to warm ${url}: ${err?.message || err}`
          );

          logger.log({
            country, // saat gagal, tidak ada header → pakai label lama
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
  console.log(`[CacheWarmer] Started: ${new Date().toISOString()}`);
  const logger = new AppsScriptLogger();

  try {
    await Promise.all(
      Object.entries(DOMAINS_MAP).map(async ([country, domain]) => {
        const urls = await fetchUrlsFromSingleSitemap(domain, country);

        console.log(`[${country}] Found ${urls.length} URLs`);
        logger.log({
          country,
          message: `Found ${urls.length} URLs for ${country}`,
        });

        await warmUrls(urls, country, logger);
      })
    );
  } finally {
    logger.setFinished();
    await logger.flush();
  }

  console.log(`[CacheWarmer] Finished: ${new Date().toISOString()}`);
})();
