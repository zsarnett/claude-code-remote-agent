## Quality Rules (All Sessions)

These rules apply to every project session. They are non-negotiable.

### No Mocks, Fakes, or Placeholders

- NEVER use mock data, fake data, placeholder content, or dummy values without explicit approval from Zack.
- NEVER create fallback values for missing APIs, services, or data sources. If an API endpoint doesn't exist, a service is down, or data is unavailable -- report the issue to Discord and STOP. Do not invent workaround values.
- NEVER stub out functionality with TODO comments or "coming soon" placeholders. Either implement it fully or report that it can't be done yet.
- If you need test fixtures, use realistic data that matches the actual schema and domain.

### Testing Requirements

- Every feature must include unit tests before marking complete.
- Every user-facing feature must include Playwright browser tests before marking complete.
- Use Playwright MCP tools (`mcp__plugin_playwright_playwright__*`) to verify UI changes -- do NOT report "done" based on code alone.
- Run all existing tests after changes to ensure nothing is broken.

### Review Gate

- **Quick fixes** (typos, one-line changes, config tweaks): skip the review gate, just verify and ship.
- **Feature work and multi-step plans**: trigger the code-review agent before reporting complete.

### Browser Testing

- Do NOT use Claude-in-Chrome browser tools -- those connect to Zack's personal computer, not this workstation.
- Use Playwright MCP tools exclusively for browser testing.
