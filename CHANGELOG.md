# Changelog

## 0.1.1

- Fix Antigravity showing quota remaining when it was actually exhausted. The API omits
  `remainingFraction` once it hits zero, which was read as "no quota info" and silently fell back
  to another model pool. An absent field is now treated as zero, and the card says so.

## 0.1.0

First release.

- Live limit cards for Codex (5-hour, weekly, credits), Claude Code (5-hour, weekly, extra usage)
  and Antigravity (rolling Gemini quota), each with a countdown to reset and a colour that turns
  yellow past 40% used and red past 80%.
- Token usage by model and by project over 24 hours / 7 days / 30 days, with fresh input, cache
  reads and writes, output and reasoning tokens.
- Daily token chart comparing the three tools, with a data-table view.
- Incremental caching of parsed session logs, and a 5-minute auto-refresh while the tab is open.
