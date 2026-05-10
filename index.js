import express from "express";

// =====================
// APP
// =====================
const app = express();
app.use(express.json({ limit: "2mb" }));

const VERSION_STAMP = "ppc-proxy-001";

// =====================
// ENV
// =====================
const {
  // LWA — same app as your MCF proxy, just needs advertising scope
  LWA_CLIENT_ID,
  LWA_CLIENT_SECRET,
  ADS_REFRESH_TOKEN,         // may be same as SPAPI_REFRESH_TOKEN if scope was included

  // Ads API profile ID (your seller account's advertising profile)
  ADS_PROFILE_ID,

  // Ads API region endpoint
  ADS_HOST = "advertising-api-eu.amazon.com",

  // Target ACoS — your hard ceiling (default 15% = 0.15)
  TARGET_ACOS = "0.15",

  // Dry run — logs changes without pushing them
  DRY_RUN = "false",

  // Optional proxy auth
  PROXY_API_KEY,

  PORT = "3001",
} = process.env;

const TARGET_ACOS_NUM = parseFloat(TARGET_ACOS);
const IS_DRY_RUN = DRY_RUN === "true";

// =====================
// HELPERS
// =====================
function requireApiKey(req, res, next) {
  if (!PROXY_API_KEY) return next();
  if (req.headers["x-api-key"] !== PROXY_API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  return next();
}

function assertEnv() {
  const required = { LWA_CLIENT_ID, LWA_CLIENT_SECRET, ADS_REFRESH_TOKEN, ADS_PROFILE_ID };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);
}

function safeJsonParse(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function dryRunResponse(action, payload) {
  return {
    ok: true,
    dryRun: true,
    action,
    wouldSend: payload,
    message: "DRY_RUN=true — no changes pushed to Amazon",
  };
}

// =====================
// LWA TOKEN (cached)
// =====================
let cachedLwa = { token: null, expiresAt: 0 };

async function getLwaAccessToken() {
  const now = Date.now();
  if (cachedLwa.token && now < cachedLwa.expiresAt - 60_000) return cachedLwa.token;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: ADS_REFRESH_TOKEN,
    client_id: LWA_CLIENT_ID,
    client_secret: LWA_CLIENT_SECRET,
  });

  const resp = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
  });

  const text = await resp.text();
  const json = safeJsonParse(text);

  if (!resp.ok) {
    const e = new Error(`LWA error ${resp.status}`);
    e.status = resp.status;
    e.details = json;
    throw e;
  }

  cachedLwa = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
  return cachedLwa.token;
}

// =====================
// ADS API REQUEST
// — Much simpler than SP-API: bearer token + profile header, no AWS signing
// =====================
async function adsRequest({ method, path, bodyObj, version = "v2", noVersion = false, contentType = "application/json", acceptType = "application/json" }) {
  const lwaToken = await getLwaAccessToken();

  const url = noVersion ? `https://${ADS_HOST}${path}` : `https://${ADS_HOST}/${version}${path}`;
  const payloadString = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);

  const headers = {
    "Authorization": `Bearer ${lwaToken}`,
    "Amazon-Advertising-API-ClientId": LWA_CLIENT_ID,
    "Amazon-Advertising-API-Scope": ADS_PROFILE_ID,
    "Accept": acceptType,
    ...(payloadString ? { "Content-Type": contentType } : {}),
  };

  const resp = await fetch(url, {
    method,
    headers,
    body: payloadString,
  });

  const text = await resp.text();
  const json = safeJsonParse(text);

  if (!resp.ok) {
    const e = new Error(`Ads API error ${resp.status}`);
    e.status = resp.status;
    e.adsApi = json;
    e.adsMethod = method;
    e.adsPath = path;
    throw e;
  }

  return { json, adsMethod: method, adsPath: path };
}

// =====================
// OAUTH CALLBACK
// — Catches the redirect from Amazon and displays the auth code clearly
// — Visit this URL in browser after authorizing
// =====================
app.get("/oauth/callback", (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.send(`
      <h2 style="color:red">Authorization Error</h2>
      <p><strong>Error:</strong> ${error}</p>
      <p><strong>Description:</strong> ${error_description}</p>
    `);
  }

  if (!code) {
    return res.send(`<h2 style="color:red">No code received</h2>`);
  }

  res.send(`
    <html>
    <body style="font-family:monospace;padding:40px;background:#f5f5f5">
      <h2 style="color:green">✅ Authorization successful</h2>
      <p>Copy the code below and exchange it for a refresh token.</p>
      <p><strong>⚠️ This code expires in 5 minutes.</strong></p>
      <div style="background:#fff;border:2px solid #333;padding:20px;font-size:18px;word-break:break-all;margin:20px 0">
        ${code}
      </div>
      <p>Now run this in your terminal:</p>
      <div style="background:#222;color:#0f0;padding:20px;font-size:13px;word-break:break-all">
        curl -X POST https://api.amazon.com/auth/o2/token \\<br>
        &nbsp;-d "grant_type=authorization_code" \\<br>
        &nbsp;-d "code=${code}" \\<br>
        &nbsp;-d "redirect_uri=https://amazon-ppc-production-51f5.up.railway.app/oauth/callback" \\<br>
        &nbsp;-d "client_id=${LWA_CLIENT_ID}" \\<br>
        &nbsp;-d "client_secret=${LWA_CLIENT_SECRET}"
      </div>
    </body>
    </html>
  `);
});

// =====================
// ROUTES — INFO
// =====================
app.get("/health", (req, res) =>
  res.json({ ok: true, dryRun: IS_DRY_RUN, targetAcos: TARGET_ACOS_NUM })
);

app.get("/version", (req, res) =>
  res.json({
    ok: true,
    version: VERSION_STAMP,
    adsHost: ADS_HOST,
    targetAcos: TARGET_ACOS_NUM,
    dryRun: IS_DRY_RUN,
  })
);

// =====================
// ROUTES — PROFILES
// Useful to look up your ADS_PROFILE_ID if you don't have it yet
// =====================
app.get("/ppc/profiles", requireApiKey, async (req, res) => {
  try {
    assertEnv();
    const result = await adsRequest({ method: "GET", path: "/profiles" });
    res.json({ ok: true, version: VERSION_STAMP, ...result });
  } catch (err) {
    res.status(err?.status || 500).json({
      ok: false,
      version: VERSION_STAMP,
      error: err?.message || String(err),
      details: err?.adsApi,
    });
  }
});

// =====================
// ROUTES — CAMPAIGNS
// GET /ppc/campaigns          → list all campaigns (id, name, budget, state, acos)
// PUT /ppc/campaigns/budgets  → batch update daily budgets
// =====================
app.get("/ppc/campaigns", requireApiKey, async (req, res) => {
  try {
    assertEnv();
    const { state = "enabled" } = req.query;
    const result = await adsRequest({
      method: "GET",
      path: `/campaigns?state=${state}&count=100`,
    });
    res.json({ ok: true, version: VERSION_STAMP, ...result });
  } catch (err) {
    res.status(err?.status || 500).json({
      ok: false, version: VERSION_STAMP,
      error: err?.message || String(err), details: err?.adsApi,
    });
  }
});

app.put("/ppc/campaigns/budgets", requireApiKey, async (req, res) => {
  try {
    assertEnv();

    // Expected body: array of { campaignId, newBudget, reason }
    const updates = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ ok: false, error: "Body must be a non-empty array of { campaignId, newBudget, reason }" });
    }

    // Safety check — flag any suspiciously large increases
    const flagged = updates.filter(u => {
      const increase = (u.newBudget - (u.currentBudget || u.newBudget)) / (u.currentBudget || 1);
      return increase > 0.5; // flag >50% increase
    });

    if (flagged.length > 0 && !req.query.force) {
      return res.status(400).json({
        ok: false,
        error: "One or more updates exceed 50% budget increase. Review and add ?force=true to proceed.",
        flagged,
      });
    }

    const payload = updates.map(u => ({
      campaignId: u.campaignId,
      dailyBudget: parseFloat(u.newBudget),
    }));

    if (IS_DRY_RUN) {
      return res.json(dryRunResponse("budget_updates", payload));
    }

    const result = await adsRequest({
      method: "PUT",
      path: "/campaigns",
      bodyObj: payload,
    });

    res.json({ ok: true, version: VERSION_STAMP, applied: updates.length, ...result });
  } catch (err) {
    res.status(err?.status || 500).json({
      ok: false, version: VERSION_STAMP,
      error: err?.message || String(err), details: err?.adsApi,
    });
  }
});

// =====================
// ROUTES — KEYWORDS
// GET /ppc/keywords           → list keywords with bids, match type, state
// PUT /ppc/keywords/bids      → batch update bids
// POST /ppc/keywords/negatives → add negative keywords to a campaign
// =====================
app.get("/ppc/keywords", requireApiKey, async (req, res) => {
  try {
    assertEnv();
    const { campaignId, adGroupId } = req.query;

    // SP API v3 — list keywords via POST with filter body
    const body = {
      stateFilter: { include: ["ENABLED"] },
      maxResults: 500,
    };
    if (campaignId) body.campaignIdFilter = { include: [String(campaignId)] };
    if (adGroupId) body.adGroupIdFilter = { include: [String(adGroupId)] };

    const result = await adsRequest({
      method: "POST",
      path: "/sp/keywords/list",
      bodyObj: body,
      version: "v2",
      contentType: "application/vnd.spKeyword.v3+json",
    });

    // Return the keywords array directly for easy consumption
    const keywords = result.json?.keywords || result.json || [];
    res.json({ ok: true, version: VERSION_STAMP, count: keywords.length, json: keywords });
  } catch (err) {
    res.status(err?.status || 500).json({
      ok: false, version: VERSION_STAMP,
      error: err?.message || String(err), details: err?.adsApi,
    });
  }
});

app.put("/ppc/keywords/bids", requireApiKey, async (req, res) => {
  try {
    assertEnv();

    // Expected body: array of { keywordId, currentBid, newBid, acos, reason }
    const updates = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ ok: false, error: "Body must be a non-empty array of { keywordId, currentBid, newBid, acos, reason }" });
    }

    // Safety check — reject any bid update on a keyword above target ACoS that increases the bid
    const violations = updates.filter(u =>
      (u.acos / 100) > TARGET_ACOS_NUM && parseFloat(u.newBid) > parseFloat(u.currentBid)
    );

    if (violations.length > 0) {
      return res.status(400).json({
        ok: false,
        error: `${violations.length} keyword(s) have ACoS above target (${TARGET_ACOS_NUM * 100}%) but bid increases were requested. This violates your profitability rules.`,
        violations,
      });
    }

    const payload = updates.map(u => ({
      keywordId: parseInt(u.keywordId, 10),
      bid: parseFloat(u.newBid),
    }));

    if (IS_DRY_RUN) {
      return res.json(dryRunResponse("bid_updates", payload));
    }

    const result = await adsRequest({
      method: "PUT",
      path: "/sp/keywords",
      bodyObj: payload,
      version: "v2",
    });

    res.json({ ok: true, version: VERSION_STAMP, applied: updates.length, ...result });
  } catch (err) {
    res.status(err?.status || 500).json({
      ok: false, version: VERSION_STAMP,
      error: err?.message || String(err), details: err?.adsApi,
    });
  }
});

app.post("/ppc/keywords/negatives", requireApiKey, async (req, res) => {
  try {
    assertEnv();

    // Expected body: array of { campaignId, adGroupId, keywordText, matchType, reason }
    const negatives = req.body;
    if (!Array.isArray(negatives) || negatives.length === 0) {
      return res.status(400).json({ ok: false, error: "Body must be a non-empty array of { campaignId, adGroupId, keywordText, matchType, reason }" });
    }

    const payload = negatives.map(n => ({
      campaignId: n.campaignId,
      adGroupId: n.adGroupId,
      keywordText: n.keywordText,
      matchType: n.matchType || "negativeExact",
      state: "enabled",
    }));

    if (IS_DRY_RUN) {
      return res.json(dryRunResponse("add_negatives", payload));
    }

    const result = await adsRequest({
      method: "POST",
      path: "/negativeKeywords",
      bodyObj: payload,
    });

    res.json({ ok: true, version: VERSION_STAMP, added: negatives.length, ...result });
  } catch (err) {
    res.status(err?.status || 500).json({
      ok: false, version: VERSION_STAMP,
      error: err?.message || String(err), details: err?.adsApi,
    });
  }
});

// =====================
// POST /ppc/keywords
// Add new keywords to a campaign/ad group (used for keyword harvesting)
// Expected body: array of { campaignId, adGroupId, keywordText, matchType, bid, reason }
// matchType: BROAD | PHRASE | EXACT
// =====================
app.post("/ppc/keywords", requireApiKey, async (req, res) => {
  try {
    assertEnv();

    const keywords = req.body;
    if (!Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Body must be a non-empty array of { campaignId, adGroupId, keywordText, matchType, bid, reason }",
      });
    }

    // Validate required fields
    const invalid = keywords.filter(k => !k.campaignId || !k.adGroupId || !k.keywordText || !k.matchType || !k.bid);
    if (invalid.length > 0) {
      return res.status(400).json({
        ok: false,
        error: `${invalid.length} keyword(s) missing required fields (campaignId, adGroupId, keywordText, matchType, bid)`,
        invalid,
      });
    }

    // Safety check — never bid above £5 on a new keyword
    const overBid = keywords.filter(k => parseFloat(k.bid) > 5);
    if (overBid.length > 0) {
      return res.status(400).json({
        ok: false,
        error: `${overBid.length} keyword(s) have bids above £5 safety limit`,
        overBid,
      });
    }

    const payload = keywords.map(k => ({
      campaignId: k.campaignId,
      adGroupId: k.adGroupId,
      keywordText: k.keywordText,
      matchType: k.matchType.toUpperCase(),
      bid: parseFloat(parseFloat(k.bid).toFixed(2)),
      state: "enabled",
    }));

    if (IS_DRY_RUN) {
      return res.json(dryRunResponse("add_keywords", payload));
    }

    const result = await adsRequest({
      method: "POST",
      path: "/keywords",
      bodyObj: payload,
    });

    res.json({ ok: true, version: VERSION_STAMP, added: keywords.length, ...result });
  } catch (err) {
    res.status(err?.status || 500).json({
      ok: false, version: VERSION_STAMP,
      error: err?.message || String(err), details: err?.adsApi,
    });
  }
});

// =====================
// ROUTES — REPORTS (v3 API)
// Amazon Ads reporting v3 — all reports use /reporting/reports
// v2 was deprecated March 2023 for SP, Oct 2024 for all others
//
// Flow:
//   1. POST /ppc/reports/request  → get reportId
//   2. GET  /ppc/reports/:id      → poll until status = "COMPLETED"
//   3. GET  /ppc/reports/:id/download → fetch + return the gzipped data
//
// reportType options: keywords | searchTerms | campaigns
// =====================

// Column definitions per report type
// Reference: Amazon Ads API v3 reporting docs
const V3_REPORT_CONFIG = {
  keywords: {
    adProduct: "SPONSORED_PRODUCTS",
    reportTypeId: "spTargeting",
    groupBy: ["targeting"],
    columns: [
      "campaignId", "adGroupId", "keywordId", "keyword", "matchType",
      "impressions", "clicks", "cost",
      "purchases14d", "sales14d",
      "startDate", "endDate"
    ],
    filters: [
      { field: "keywordType", values: ["BROAD", "PHRASE", "EXACT"] }
    ],
  },
  searchTerms: {
    adProduct: "SPONSORED_PRODUCTS",
    reportTypeId: "spSearchTerm",
    groupBy: ["searchTerm"],
    columns: [
      "campaignId", "adGroupId", "keywordId", "keyword", "matchType", "searchTerm",
      "impressions", "clicks", "cost",
      "purchases14d", "sales14d",
      "startDate", "endDate"
    ],
  },
  campaigns: {
    adProduct: "SPONSORED_PRODUCTS",
    reportTypeId: "spCampaigns",
    groupBy: ["campaign"],
    columns: [
      "campaignId", "campaignStatus",
      "campaignBudgetAmount", "campaignBudgetType",
      "impressions", "clicks", "cost",
      "purchases14d", "sales14d",
      "startDate", "endDate"
    ],
  },
};

app.post("/ppc/reports/request", requireApiKey, async (req, res) => {
  try {
    assertEnv();

    const { reportType = "keywords", startDate, endDate } = req.body;

    // startDate/endDate in YYYYMMDD → convert to YYYY-MM-DD for v3
    if (!startDate || !endDate) {
      return res.status(400).json({ ok: false, error: "startDate and endDate required (YYYYMMDD)" });
    }

    const fmt = d => `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;

    const config = V3_REPORT_CONFIG[reportType];
    if (!config) {
      return res.status(400).json({ ok: false, error: `Unknown reportType: ${reportType}. Use keywords | searchTerms | campaigns` });
    }

    const payload = {
      name: `${reportType}-${startDate}-${endDate}`,
      startDate: fmt(startDate),
      endDate: fmt(endDate),
      configuration: {
        adProduct: config.adProduct,
        groupBy: config.groupBy,
        columns: config.columns,
        reportTypeId: config.reportTypeId,
        timeUnit: "SUMMARY",
        format: "GZIP_JSON",
        ...(config.filters ? { filters: config.filters } : {}),
      },
    };

    const result = await adsRequest({
      method: "POST",
      path: "/reporting/reports", noVersion: true, contentType: "application/vnd.createasyncreportrequest.v3+json",
      bodyObj: payload,
      version: "v2", // v3 reporting endpoint lives under /v2/reporting/reports
    });

    res.json({ ok: true, version: VERSION_STAMP, reportType, ...result });
  } catch (err) {
    res.status(err?.status || 500).json({
      ok: false, version: VERSION_STAMP,
      error: err?.message || String(err), details: err?.adsApi,
    });
  }
});

app.get("/ppc/reports/:reportId", requireApiKey, async (req, res) => {
  try {
    assertEnv();
    const { reportId } = req.params;
    const result = await adsRequest({
      method: "GET",
      path: `/reporting/reports/${reportId}`, noVersion: true,
      version: "v2",
    });
    res.json({ ok: true, version: VERSION_STAMP, ...result });
  } catch (err) {
    res.status(err?.status || 500).json({
      ok: false, version: VERSION_STAMP,
      error: err?.message || String(err), details: err?.adsApi,
    });
  }
});

app.get("/ppc/reports/:reportId/download", requireApiKey, async (req, res) => {
  try {
    assertEnv();

    // Get report status + download URL
    const statusResult = await adsRequest({
      method: "GET",
      path: `/reporting/reports/${req.params.reportId}`, noVersion: true,
      version: "v2",
    });

    const { status, url } = statusResult.json;

    if (status !== "COMPLETED") {
      return res.status(202).json({
        ok: false,
        error: `Report not ready. Status: ${status}`,
        status,
      });
    }

    // Download from S3 — no auth needed
    const dlResp = await fetch(url);
    if (!dlResp.ok) {
      return res.status(502).json({ ok: false, error: `Failed to download report: ${dlResp.status}` });
    }

    // Decompress gzip in the proxy — returns plain JSON so n8n needs no zlib
    const { createGunzip } = await import('zlib');
    const buffer = await dlResp.arrayBuffer();
    const compressed = Buffer.from(buffer);

    const decompressed = await new Promise((resolve, reject) => {
      const gunzip = createGunzip();
      const chunks = [];
      gunzip.on('data', chunk => chunks.push(chunk));
      gunzip.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      gunzip.on('error', reject);
      gunzip.end(compressed);
    });

    const rows = JSON.parse(decompressed);

    res.json({
      ok: true,
      version: VERSION_STAMP,
      reportId: req.params.reportId,
      rowCount: rows.length,
      rows,
    });
  } catch (err) {
    res.status(err?.status || 500).json({
      ok: false, version: VERSION_STAMP,
      error: err?.message || String(err), details: err?.adsApi,
    });
  }
});

// =====================
// START
// =====================
app.listen(Number(PORT), () => {
  console.log(`Amazon Ads API PPC proxy listening on :${PORT} (${VERSION_STAMP})`);
  console.log(`Target ACoS: ${TARGET_ACOS_NUM * 100}% | Dry run: ${IS_DRY_RUN}`);
});
