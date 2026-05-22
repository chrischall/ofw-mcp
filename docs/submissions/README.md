# Registry submissions — ofw-mcp

Ready-to-paste copy for registries that need a manual browser-form submission. Automated pipelines run from the `publish` job in `.github/workflows/release-please.yml` after release-please creates a new tag.

## Coverage matrix

| Registry                          | Automated?                               | Where |
| --- | --- | --- |
| npm                               | ✅ `release-please.yml` publish job        | `npm publish --provenance` |
| GitHub Releases                   | ✅ release-please-action + `gh release upload --clobber` | `.skill` + `.mcpb` attached to the release release-please authored |
| modelcontextprotocol/registry     | ✅ `release-please.yml` publish job (OIDC) | `mcp-publisher publish` using `server.json` |
| PulseMCP                          | ✅ transitive (auto-ingests weekly)       | — |
| ClawHub (OpenClaw)                | ✅ conditional on `CLAWHUB_TOKEN`         | `clawhub skill publish` |
| mcpservers.org                    | ❌ manual — [mcpservers.org/submit](https://mcpservers.org/submit) | |
| Anthropic community plugins       | ❌ manual — [clau.de/plugin-directory-submission](https://clau.de/plugin-directory-submission) | |

## mcpservers.org

- **Server Name:** `ofw-mcp`
- **Short Description:** `OurFamilyWizard co-parenting tools for Claude — messages, calendar, expenses, and journal via natural language`
- **Link:** `https://github.com/chrischall/ofw-mcp`
- **Category:** `Productivity`
- **Contact Email:** `chris.c.hall@gmail.com`

## Anthropic community plugins

- **Repo URL:** `https://github.com/chrischall/ofw-mcp`
- **Plugin name:** `ofw-mcp`
- **Short description:** `OurFamilyWizard co-parenting tools for Claude — messages, calendar, expenses, and journal via natural language`
- **Category:** Productivity
- **Tags:** ofw, ourfamilywizard, co-parenting, family, messages, calendar, expenses, mcp
