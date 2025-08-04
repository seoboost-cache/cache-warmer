import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { parseStringPromise } from "xml2js";
import * as dotenv from "dotenv";

dotenv.config();

const DOMAINS_MAP = {
  id: "https://seoboost.co.id",
};

const PROXIES = {
  id: process.env.BRD_PROXY_ID,
};

const USER_AGENTS = {
  id: "SeoBoost-CacheWarmer-ID/1.0",
};

const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithProxy(url, country) {
  const proxy = PROXIES[country];
  const agent = new HttpsProxyAgent(proxy);
  const res = await axios.get(url, {
    httpsAgent: agent,
    headers: { "User-Agent": USER_AGENTS[country] },
    timeout: 15000,
  });
  return res.data;
}

async function fetchIndexSitemaps(domain, country) {
  try {
    const xml = await fetchWithProxy(`${domain}/sitemap_index.xml`, country);
    const result = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });

    const sitemapList = result?.sitemapindex?.sitemap;
    if (!sitemapList) return [];
    const sitemaps = Array.isArray(sitemapList) ? sitemapList : [sitemapList];
    return sitemaps.map((entry) => entry.loc);
  } catch (err) {
    console.warn(`[${country}] ❌ Failed to fetch sitemap index: ${err?.message}`);
    return [];
  }
}

async function fetchUrlsFromSitemap(sitemapUrl, country) {
  try {
    const xml = await fetchWithProxy(sitemapUrl, country);
    const result = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });

    const urlList = result?.urlset?.url;
    if (!urlList) return [];
    const urls = Array.isArray(urlList) ? urlList : [urlList];
    return urls.map((entry) => entry.loc);
  } catch (err) {
    console.warn(`[${country}] ❌ Failed to fetch URLs from ${sitemapUrl}: ${err?.message}`);
    return [];
  }
}

async function retryableGet(url, config, retries = 3) {
  let lastError = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, config);
    } catch (err) {
      lastError = err;
      const isRetryable = axios.isAxiosError(err) && ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT"].includes(err.code);
      if (!isRetryable) break;
      await sleep(2000);
    }
  }
  throw lastError;
}

async function purgeCloudflareCache(url) {
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

    if (purgeRes.data.success) {
      console.log(`✅ Cloudflare cache purged: ${url}`);
    } else {
      console.warn(`⚠️ Failed to purge Cloudflare: ${url}`);
    }
  } catch (err) {
    console.warn(`❌ Error purging Cloudflare: ${url}`);
  }
}

async function warmUrls(urls, country, batchSize = 1, delay = 2000) {
  const proxy = PROXIES[country];
  const agent = new HttpsProxyAgent(proxy);

  const batches = Array.from({ length: Math.ceil(urls.length / batchSize) }, (_, i) => urls.slice(i * batchSize, i * batchSize + batchSize));

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (url) => {
        try {
          const res = await retryableGet(url, {
            httpsAgent: agent,
            headers: { "User-Agent": USER_AGENTS[country] },
            timeout: 15000,
          });

          const cfCache = res.headers["cf-cache-status"] || "N/A";
          const lsCache = res.headers["x-litespeed-cache"] || "N/A";
          const cfRay = res.headers["cf-ray"] || "N/A";

         const cfEdge = cfRay.includes("-") ? cfRay.split("-")[1] : "N/A";

         console.log(`[${country}] ${res.status} cf=${cfCache} ls=${lsCache} edge=${cfEdge} - ${url}`);

          if (lsCache.toLowerCase() !== "hit") {
            await purgeCloudflareCache(url);
          }
        } catch (err) {
          console.warn(`[${country}] ❌ Failed to warm ${url}: ${err?.message}`);
        }
      })
    );
    await sleep(delay);
  }
}

// 🚀 Main
(async () => {
  console.log(`[CacheWarmer] Started: ${new Date().toISOString()}`);

  await Promise.all(
    Object.entries(DOMAINS_MAP).map(async ([country, domain]) => {
      const sitemapList = await fetchIndexSitemaps(domain, country);
      const urlArrays = await Promise.all(sitemapList.map((sitemapUrl) => fetchUrlsFromSitemap(sitemapUrl, country)));

      const urls = urlArrays.flat().filter(Boolean);
      console.log(`[${country}] Found ${urls.length} URLs`);

      await warmUrls(urls, country);
    })
  );

  console.log(`[CacheWarmer] Finished: ${new Date().toISOString()}`);
})();
