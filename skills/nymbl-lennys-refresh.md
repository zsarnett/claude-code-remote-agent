---
name: nymbl-lennys-refresh
description: Refresh the Lenny's Newsletter tab across all 13 NYMBL team member profiles. Re-curates articles from the Lenny's archive per role, updates lennys-articles.json and all team HTML files, deploys to barett-server, and notifies via Discord.
user_invocable: true
---

# NYMBL Lenny's Newsletter Refresh

This skill refreshes the "Lenny's" tab on every team member's profile in the NYMBL AI Hub. It re-curates articles from the Lenny's Newsletter/Podcast archive and updates both the article data and the team HTML files.

## Files Involved

- **Article data**: `/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/data/lennys-articles.json`
- **Team HTML** (13 files): `/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/team/{slug}.html`
- **Modal reader**: `initLennysReader()` in `/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/js/app.js` (usually no changes needed)

## Team Members and Their Role Focus

| Member | Slug | Role | Lenny's Topics |
|---|---|---|---|
| Martyn Mason | martyn | CEO/Co-Founder | Strategy, leadership, executive decision-making, company building |
| Melissa | melissa | RevOps/Sales | RevOps, sales strategy, PLG, growth metrics |
| Vishan | vishan | Finance | Pricing, unit economics, finance frameworks |
| Chase | chase | Delivery Lead | Product management, roadmaps, delivery |
| Chris | chris | HR/People | Management, hiring, team building, culture |
| Joy | joy | Marketing | Marketing, growth, content strategy, brand |
| Justin | justin | Solutions/Eng | Technical PM, developer tools, platform strategy |
| Brian | brian | Operations | Operations, OKRs, process improvement, PM |
| Zach | zach | Partnerships | Business development, partnerships, GTM |
| Raj | raj | Client Success | Customer success, retention, onboarding |
| Zack | zack | CEO (NYMBL) | Strategy, leadership, AI product, company building |
| Jenn | jenn | Legal/Ops | Operations, contracts, process, risk |
| Kori | kori | HR/Enablement | Management, hiring, onboarding, training |

## Step-by-Step Process

### 1. Search Lenny's Archive Using lennysdata MCP

Use the `mcp__lennysdata__search_content` tool to find articles. 

**IMPORTANT**: The lennysdata MCP only supports pipe-delimited single-word terms. Multi-word phrases return 0 results.

Good query format: `strategy|framework|operator`
Bad query format: `"product strategy framework"` (returns nothing)

Run searches across these topic clusters:

```
Leadership/Strategy: strategy|leadership|vision|decisions|frameworks
Product Management: roadmap|prioritization|discovery|shipping|metrics
Growth/Marketing: growth|acquisition|retention|PLG|marketing|content
Sales/Revenue: sales|revenue|GTM|pipeline|closing|pricing
Operations/Process: operations|OKRs|hiring|process|execution
Management/Team: management|1on1|feedback|culture|hiring|performance
Customer Success: customers|retention|onboarding|success|churn
Finance/Pricing: pricing|monetization|unit-economics|revenue
Technical/Platform: platform|technical|engineering|developer|API
```

For each result from `mcp__lennysdata__list_content` or search, use `mcp__lennysdata__read_excerpt` to get a preview.

Collect 25-35 unique articles total.

### 2. For Each Selected Article, Read Excerpt

Use `mcp__lennysdata__read_excerpt` with the article slug/ID to get:
- Title
- Summary
- Key points

Then write:
- `summary`: 2-3 sentence description of what the article is about
- `takeaways`: 5 concrete, actionable bullet points (not generic, based on actual article content)
- `readTime`: Estimated read time (e.g., "8 min read")
- `category`: One of: Product Strategy, Growth, Leadership, Management, Sales, Marketing, RevOps, Operations, Pricing, Customer Success, Engineering, Hiring, Company Building

### 3. Update lennys-articles.json

Read current file first, then replace with new content:

```json
{
  "articles": {
    "article-slug-from-url": {
      "title": "Full Article Title",
      "url": "https://www.lennysnewsletter.com/p/article-slug",
      "category": "Product Strategy",
      "date": "Month Year",
      "summary": "2-3 sentence summary of the article...",
      "takeaways": [
        "Concrete takeaway 1...",
        "Concrete takeaway 2...",
        "Concrete takeaway 3...",
        "Concrete takeaway 4...",
        "Concrete takeaway 5..."
      ],
      "readTime": "8 min read"
    }
  }
}
```

The slug used as the JSON key MUST match the `data-article` attribute in the team HTML files (step 4).

### 4. Update Team HTML Files

Each team HTML file has a Lenny's tab panel with cards. Each card needs:

```html
<div class="card lennys-card" data-article="article-slug" style="cursor:pointer;">
  <strong>Article Title</strong>
  <p>1 sentence teaser...</p>
  <div class="lennys-read-btn">Read summary</div>
</div>
```

For each of the 13 team members, update their Lenny's panel with 3-5 relevant articles. Match articles to the role focus table above.

File locations:
```
/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/team/martyn.html
/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/team/melissa.html
/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/team/vishan.html
/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/team/chase.html
/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/team/chris.html
/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/team/joy.html
/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/team/justin.html
/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/team/brian.html
/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/team/zach.html
/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/team/raj.html
/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/team/zack.html
/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/team/jenn.html
/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/team/kori.html
```

Find the Lenny's panel in each file (look for `data-panel="lennys"`) and replace the card list inside it.

### 5. Bump the Cache Buster

Get today's date as YYYYMMDD. Update in both files:

**`/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/js/app.js`:**
```
const CACHE_BUST = 'NEW_DATE';
```

**`/Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/index.html`:**
```
href="/css/theme.css?v=NEW_DATE"
src="/js/app.js?v=NEW_DATE"
```

### 6. Deploy to barett-server

```bash
# Sync files
rsync -avz --delete /Users/zackbarett/Documents/ZacksWorkspace/nymbl-ai-hub/public/ zack@barett-server:/home/zack/apps/nymbl-ai-hub/public/

# Rebuild container
ssh zack@barett-server "cd /home/zack/apps/nymbl-ai-hub && docker compose up -d --build"
```

### 7. Verify with Playwright

Use Playwright MCP tools to verify:

```
Navigate to: https://ai.zacknymbl.com/#/team/martyn/lennys
Wait 2 seconds
Check cards exist: document.querySelectorAll('.lennys-card').length > 0
Click a card and verify modal opens
Take screenshot of modal
```

### 8. Notify Zack via Discord

```bash
bash ~/.claude/bin/discord-notify.sh "**Lenny's tab refreshed**

[X] articles curated across [Y] categories
All 13 team profiles updated with role-matched reading

New articles include:
- [Article 1 title]
- [Article 2 title]
- [Article 3 title]

Live at: https://ai.zacknymbl.com" "$DISCORD_CHANNEL_ID"
```

## Quality Checklist

Before reporting done:
- [ ] lennys-articles.json has 25+ articles with full summary + 5 takeaways each
- [ ] All 13 team HTML files updated with role-relevant cards
- [ ] Every `data-article` slug in HTML exists as a key in lennys-articles.json
- [ ] Cache buster bumped in app.js AND index.html
- [ ] Docker container rebuilt and running
- [ ] Lenny's tab verified for at least 2 team members via Playwright
- [ ] Modal opens and shows content when a card is clicked
- [ ] Discord notified

## Notes

- lennysdata MCP search: use `mcp__lennysdata__search_content` with single pipe-delimited terms only
- To list all available content: use `mcp__lennysdata__list_content`
- To read a specific article: use `mcp__lennysdata__read_content` with the article ID
- The modal is pre-built in index.html and populated by `openLennysModal(slug)` in app.js
- Cards must have class `lennys-card` and `data-article="slug"` for the modal reader to work
- The "Read summary" button inside each card is cosmetic — the whole card is clickable
