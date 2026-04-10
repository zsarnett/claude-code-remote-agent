---
name: nymbl-ai-news-refresh
description: Refresh the AI News This Week tab across all NYMBL team member profiles. Searches for this week's AI industry news, curates articles by role, updates ai-news.json, deploys to barett-server, and notifies via Discord.
user_invocable: true
---

# NYMBL AI News Refresh

This skill refreshes the "AI News This Week" tab on every team member's profile in the NYMBL AI Hub at `https://ai.zacknymbl.com`.

## Files Involved

- **Data**: `/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/data/ai-news.json`
- **Renderer**: `initAINews()` in `/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/js/app.js`
- **Team HTML**: `/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/team/{slug}.html` (13 files — tabs already exist, no changes needed)

## Team Members and Their Role Clusters

Use these clusters to curate relevant articles per person:

| Cluster | Members | Focus Areas |
|---|---|---|
| Leadership/Strategy | martyn, zack | Agency strategy, AI consulting market, competitive landscape, pricing |
| Delivery/Engineering | chase, justin, brian | MCP, AI models, dev tools, project management AI, agentic frameworks |
| RevOps/Finance/Legal | melissa, vishan, jenn | RevOps AI, finance AI, contract AI, compliance, EU AI Act |
| Marketing/Creative | joy | Marketing AI, creative tools, ad platforms (Meta, Canva), agency automation |
| HR/Enablement | kori, chris | HR AI, upskilling, workforce transformation |
| Partnerships/Sales | raj, zach | Sales AI, consulting partnerships (OpenAI/Anthropic deals), RevOps |

## Step-by-Step Process

### 1. Get Current Date and Week

```bash
date "+%Y-%m-%d"
```

Note the current date. The week label should be "Week of [Monday's date], [Year]".

### 2. Search for This Week's AI News

Use WebSearch to find 15-20 fresh articles across these topic areas:

```
Search queries to run (run each separately):
- "AI consulting agencies 2025 [current month]"
- "AI tools enterprise 2025 [current month]"  
- "MCP model context protocol [current month]"
- "AI RevOps sales tools 2025"
- "AI marketing creative tools 2025 [current month]"
- "AI HR workforce 2025"
- "AI compliance regulation 2025"
- "AI models releases [current month] 2025"
```

For each article found, collect:
- `title`: Exact article title
- `source`: Publication name (TechCrunch, McKinsey, etc.)
- `url`: Full article URL
- `category`: One of: Agency Strategy, Market Opportunity, Competitive Threat, Developer Tools, RevOps, Sales AI, Marketing AI, HR AI, AI Models, Finance AI, Legal AI, AI Compliance, Workforce AI, Delivery AI, Marketing Tools, Agency Competitive
- `date`: Publication date (e.g. "April 2025")
- `summary`: 2-3 sentences summarizing the article
- `nymbl`: 1-2 sentences on why this matters to NYMBL specifically (business angle, upsell opportunity, or threat to be aware of)

### 3. Assign Articles to Team Members

Create the `assignments` map. Each person gets exactly 4 articles. Use the role clusters above to match articles to people. Overlap is fine (same article can go to multiple people if relevant).

Rules:
- martyn/zack: agency strategy, competitive threats, market trends
- chase/justin/brian: technical AI tools, dev platforms, agent frameworks
- melissa/vishan/jenn: RevOps, finance, legal/compliance AI
- joy: marketing AI, creative tools, paid media automation
- kori/chris: HR AI, training/upskilling, workforce
- raj/zach: sales AI, partnerships, RevOps

### 4. Update ai-news.json

Read the current file first:
```
Read /Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/data/ai-news.json
```

Replace the entire file with the new structure:

```json
{
  "generated": "YYYY-MM-DD",
  "week": "Week of [Monday date], [Year]",
  "articles": {
    "article-slug-here": {
      "title": "...",
      "source": "...",
      "url": "...",
      "category": "...",
      "date": "...",
      "summary": "...",
      "nymbl": "..."
    }
  },
  "assignments": {
    "martyn": ["slug1", "slug2", "slug3", "slug4"],
    "melissa": [...],
    "vishan": [...],
    "chase": [...],
    "chris": [...],
    "joy": [...],
    "justin": [...],
    "brian": [...],
    "zach": [...],
    "raj": [...],
    "zack": [...],
    "jenn": [...],
    "kori": [...]
  }
}
```

Article slugs should be kebab-case, descriptive, unique. Example: `"openai-enterprise-push-may-2025"`.

### 5. Bump the Cache Buster

The cache buster date must be bumped to force Cloudflare to serve fresh JS/CSS.

Get today's date as YYYYMMDD (e.g., `20260415`). Replace in both files:

**In `/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/js/app.js`:**
```
Old: const CACHE_BUST = 'PREVIOUS_DATE';
New: const CACHE_BUST = 'NEW_DATE';
```

**In `/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/index.html`:**
```
Old: href="/css/theme.css?v=PREVIOUS_DATE"
New: href="/css/theme.css?v=NEW_DATE"

Old: src="/js/app.js?v=PREVIOUS_DATE"
New: src="/js/app.js?v=NEW_DATE"
```

### 6. Deploy to barett-server

```bash
# Sync files
rsync -avz --delete /Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/ zack@barett-server:/home/zack/apps/nymbl-ai-hub/public/

# Rebuild container
ssh zack@barett-server "cd /home/zack/apps/nymbl-ai-hub && docker compose up -d --build"
```

### 7. Verify with Playwright

Use Playwright MCP tools to verify the AI News tab loads correctly for at least 2 team members:

```
Navigate to: https://ai.zacknymbl.com/#/team/martyn/ai-news
Wait 2 seconds
Check: document.querySelectorAll('[data-panel="ai-news"] .ai-news-card').length === 4
Take screenshot
```

Repeat for one more member (e.g., joy or melissa).

### 8. Notify Zack via Discord

Post a summary to Discord using the leadership channel:

```bash
bash ~/.claude/bin/discord-notify.sh "**AI News refreshed for Week of [date]**

[X] articles curated across [Y] categories
All 13 team profiles updated

Top picks this week:
- [Article 1 title] ([source])
- [Article 2 title] ([source])
- [Article 3 title] ([source])

Live at: https://ai.zacknymbl.com" "$DISCORD_CHANNEL_ID"
```

## Quality Checklist

Before reporting done:
- [ ] All 13 team members have exactly 4 article assignments
- [ ] All article slugs in `assignments` exist as keys in `articles`
- [ ] All article URLs are real (not placeholder)
- [ ] `generated` date matches today
- [ ] Cache buster version bumped in app.js AND index.html
- [ ] Docker container rebuilt and container is running
- [ ] AI News tab shows 4 cards for martyn (verified via Playwright)
- [ ] Discord notified

## Notes

- Never use mock URLs. If you can't find enough real articles, use fewer categories rather than fabricating sources.
- The JSON renderer in app.js reads from `/data/ai-news.json?v=${CACHE_BUST}` with `cache: 'no-store'` -- no additional cache-busting needed for the JSON file itself.
- The 13 team HTML files already have the AI News tab panel with an empty `.ai-news-grid`. The JS populates it at runtime. No HTML changes needed unless adding a new team member.
