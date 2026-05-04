# Amazon PPC Proxy

Amazon Ads API proxy for AI-driven PPC automation. Same structure as your MCF proxy — no AWS STS or aws4 signing needed, just LWA bearer auth.

## Setup

```bash
npm install
cp .env.example .env
# Fill in your credentials, then:
npm run dry-run   # always start here
```

## First run checklist

1. **Check your LWA scope** — your existing LWA app needs `advertising::campaign_management` scope. If it wasn't included when you originally authorized, re-run the OAuth flow with it added.

2. **Find your profile ID** — start the proxy and hit `GET /ppc/profiles`. Copy the `profileId` for your seller account into `ADS_PROFILE_ID`.

3. **Run in dry-run mode first** — `DRY_RUN=true` means all write endpoints log what *would* be sent without pushing anything to Amazon. Keep this on until you've validated the AI output over at least one cycle.

4. **Confirm your target ACoS** — default is `0.15` (15%). Adjust in `.env` if your gross margin differs.

## Endpoints

### Info
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Returns ok, dryRun status, targetAcos |
| GET | `/version` | Version info |
| GET | `/ppc/profiles` | List ad profiles — use this to find your ADS_PROFILE_ID |

### Campaigns
| Method | Path | Description |
|--------|------|-------------|
| GET | `/ppc/campaigns` | List campaigns with budgets. `?state=enabled\|paused\|archived` |
| PUT | `/ppc/campaigns/budgets` | Batch update daily budgets |

Budget update body:
```json
[
  {
    "campaignId": "123456",
    "currentBudget": 30.00,
    "newBudget": 45.00,
    "reason": "Hit cap 11/14 days, ACoS 12%"
  }
]
```
Safety: >50% increases are blocked unless `?force=true` is passed.

### Keywords
| Method | Path | Description |
|--------|------|-------------|
| GET | `/ppc/keywords` | List keywords. `?campaignId=x&adGroupId=y&state=enabled` |
| PUT | `/ppc/keywords/bids` | Batch update bids |
| POST | `/ppc/keywords/negatives` | Add negative keywords |

Bid update body:
```json
[
  {
    "keywordId": "789",
    "currentBid": 0.85,
    "newBid": 1.05,
    "acos": 0.12,
    "reason": "ACoS 12%, below 15% target, increasing to capture volume"
  }
]
```
Safety: The proxy **hard-blocks** any bid increase on a keyword whose `acos` is above `TARGET_ACOS`. This is enforced server-side regardless of what the AI sends.

Negative keywords body:
```json
[
  {
    "campaignId": "123456",
    "adGroupId": "789",
    "keywordText": "free",
    "matchType": "negativeExact",
    "reason": "High impressions, zero conversions"
  }
]
```

### Reports (async — 3 steps)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/ppc/reports/request` | Request a report, returns reportId |
| GET | `/ppc/reports/:reportId` | Poll status — wait for `SUCCESS` |
| GET | `/ppc/reports/:reportId/download` | Download gzipped report data |

Report request body:
```json
{
  "reportType": "keywords",
  "startDate": "20240101",
  "endDate": "20240114"
}
```
`reportType` options: `keywords` | `searchTerms` | `campaigns`

Downloaded reports are gzipped JSON — decompress before parsing.

## The 14-day AI cycle

Typical flow for your fortnightly run:

```
1. POST /ppc/reports/request  { reportType: "keywords", last 14 days }
2. POST /ppc/reports/request  { reportType: "searchTerms", last 14 days }
3. POST /ppc/reports/request  { reportType: "campaigns", last 14 days }
4. Poll /ppc/reports/:id until SUCCESS (usually 1-5 min)
5. Download + decompress all 3 reports
6. Send to AI with your ACoS target and margin rules
7. Review AI output (10 min)
8. PUT /ppc/keywords/bids      with approved bid changes
9. PUT /ppc/campaigns/budgets  with approved budget changes
10. POST /ppc/keywords/negatives with approved negatives
```

## Safety features

- **DRY_RUN mode** — all writes return what would have been sent, nothing pushed
- **ACoS hard block** — bid increases on over-target keywords are rejected at proxy level
- **Budget increase cap** — >50% single-cycle increases require `?force=true`
- **Reason field** — every change carries a reason string for your review log
