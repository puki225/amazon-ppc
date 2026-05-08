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
async function adsRequest({ method, path, bodyObj, version = "v2" }) {
  const lwaToken = await getLwaAccessToken();

  const url = `https://${ADS_HOST}/${version}${path}`;
  const payloadString = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);

  const headers = {
    "Authorization": `Bearer ${lwaToken}`,
    "Amazon-Advertising-API-ClientId": LWA_CLIENT_ID,
    "Amazon-Advertising-API-Scope": ADS_PROFILE_ID,
    "Accept": "application/json",
    ...(payloadString ? { "Content-Type": "application/json" } : {}),
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
    const { campaignId, adGroupId, state = "enabled" } = req.query;

    let path = `/keywords?state=${state}&count=100`;
    if (campaignId) path += `&campaignIdFilter=${campaignId}`;
    if (adGroupId) path += `&adGroupIdFilter=${adGroupId}`;

    const result = await adsRequest({ method: "GET", path });
    res.json({ ok: true, version: VERSION_STAMP, ...result });
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
      u.acos > TARGET_ACOS_NUM && parseFloat(u.newBid) > parseFloat(u.currentBid)
    );

    if (violations.length > 0) {
      return res.status(400).json({
        ok: false,
        error: `${violations.length} keyword(s) have ACoS above target (${TARGET_ACOS_NUM * 100}%) but bid increases were requested. This violates your profitability rules.`,
        violations,
      });
    }

    const payload = updates.map(u => ({
      keywordId: u.keywordId,
      bid: parseFloat(u.newBid),
    }));

    if (IS_DRY_RUN) {
      return res.json(dryRunResponse("bid_updates", payload));
    }

    const result = await adsRequest({
      method: "PUT",
      path: "/keywords",
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
// ROUTES — REPORTS
// Reports are async in Amazon Ads API:
//   1. POST /ppc/reports/request  → get reportId
//   2. GET  /ppc/reports/:id      → poll until status = "SUCCESS"
//   3. GET  /ppc/reports/:id/download → fetch the gzipped data
//
// Report types: campaigns | adGroups | keywords | searchTerms | targets
// =====================
app.post("/ppc/reports/request", requireApiKey, async (req, res) => {
  try {
    assertEnv();

    const {
      reportType = "keywords",
      startDate,
      endDate,
      metrics,
    } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ ok: false, error: "startDate and endDate required (YYYYMMDD)" });
    }

    const defaultMetrics = {
      keywords:    "campaignId,campaignName,adGroupId,keywordId,keywordText,matchType,impressions,clicks,cost,attributedSales14d,attributedConversions14d",
      searchTerms: "campaignId,campaignName,adGroupId,keywordId,query,impressions,clicks,cost,attributedSales14d,attributedConversions14d",
      campaigns:   "campaignId,campaignName,impressions,clicks,cost,attributedSales14d,attributedConversions14d",
    };

    const payload = {
      reportDate: endDate,
      metrics: metrics || defaultMetrics[reportType] || defaultMetrics.keywords,
      // For date range reports use the v3 reporting API (see /ppc/reports/request-v3)
    };

    const result = await adsRequest({
      method: "POST",
      path: `/${reportType}/report`,
      bodyObj: payload,
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
    const result = await adsRequest({ method: "GET", path: `/reports/${reportId}` });
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

    // First get the report status to find the download URL
    const statusResult = await adsRequest({ method: "GET", path: `/reports/${req.params.reportId}` });
    const { status, location } = statusResult.json;

    if (status !== "SUCCESS") {
      return res.status(202).json({
        ok: false,
        error: `Report not ready. Status: ${status}`,
        status,
      });
    }

    // Download the gzipped report from the S3 location (no auth needed)
    const dlResp = await fetch(location);
    if (!dlResp.ok) {
      return res.status(502).json({ ok: false, error: `Failed to download report from S3: ${dlResp.status}` });
    }

    // Stream it back — caller can decompress (gzip)
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("X-Report-Id", req.params.reportId);

    const buffer = await dlResp.arrayBuffer();
    res.send(Buffer.from(buffer));
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
