## Git

- Always `git push origin master` immediately after every commit — no exceptions.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)

## Discord Bridge

This project has access to the owner's Discord #comms channel via a bot.
Use ONLY when explicitly asked to send or read Discord messages.

**Script:** `C:\Users\MuntherX\.claude\helpers\echo-bridge.ps1`
**Channel:** #comms — ID `1505306925305430179`
**Token env var:** `CLAUDE_CODE_BOT_TOKEN` (set at User level — available in all terminals)

**How to send a message:**
```powershell
. "$env:USERPROFILE\.claude\helpers\echo-bridge.ps1"
Send-Echo "your message here"
```

**How to read recent messages:**
```powershell
. "$env:USERPROFILE\.claude\helpers\echo-bridge.ps1"
Read-Echo 5   # reads last 5 messages
```

Never send to Discord automatically — only when the user explicitly asks.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
