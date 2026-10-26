# Cue: a chief of staff for people who run many AI sessions

**Status:** draft spec, v0.1 scope. Package and repo name: `cuedesk`. Product name: Cue.

## The problem

One person now runs several AI agent sessions at once, plus a ticket board, plus people asking them for things. Four kinds of work fall through the cracks:

1. **Asks get lost.** A session stops and waits for an answer, a tap or an approval. Its question scrolls away in one of five terminals.
2. **Work goes quiet.** A ticket sits in "In progress" for days. A session holds a device for hours and has gone silent. A promised reply never comes.
3. **Resources collide.** Two sessions drive the same test device, or change the same config, at the same time.
4. **The same questions come back every day.** "What needs me?" "What happened while I was away?" "What do I do first?"

Existing tools solve neighbouring problems:
- **Coding-agent managers** (Conductor, Vibe Kanban, Claude Squad) run agents in separate worktrees and help you review their diffs.
- **Approval tools** gate single yes/no actions.

None of them keeps one queue of what needs the human, watches the ticket board for neglect, and coordinates shared resources across sessions. That is Cue.

## Who it is for

The first user is a QA lead running several Claude Code sessions against shared test devices and a Jira board. Nothing in Cue is QA-specific, though. Presets cover a QA lead, an engineering manager and a solo developer.

## Principles

- **Local-first.** Cue listens on `127.0.0.1` only and rejects requests whose `Host` or `Origin` isn't Cue. Secrets live in the OS keychain or environment variables, never in config files or the page.
- **Bring your own connectors.** Cue doesn't ship a Jira client or a Linear client. It talks to the MCP servers the user already runs, plus a built-in GitHub source for the demo. Source code is project-agnostic; anything project-specific lives in config.
- **The human decides.** Cue suggests, ranks and reminds. Anything that changes the outside world (moving a ticket, posting a message) waits for an explicit approval in the UI, like fledge's approval cards.
- **Agent-agnostic.** Claude Code reports in through hooks. Any agent, or any script, can use Cue's MCP tools or its small HTTP API.
- **Boring storage.** Everything goes in one SQLite file (`node:sqlite`). Any fresh process can rebuild its view from it.

## Concepts

| Concept | What it is |
|---|---|
| **Session** | An agent session, identified by `session_id` (from hooks or MCP). It has a label, a last-seen time, its current activity and the resources it holds. |
| **Ask** | Something a session or person needs from the human. It has kind (`answer`, `approve`, `action`), a one-line summary, details, who asked, a due time and a status (`open`, `answered`, `dismissed`). The answer goes back to the asker. |
| **Item** | A unit of tracked work from a source: a ticket, issue or PR. Status is mapped to a fixed **stage**: `todo`, `active`, `review`, `blocked`, `done`. |
| **Resource** | Anything only one session should use at a time: a device, an environment or a test account. **Claims** have an owner, a reason and an expiry. |
| **Rule** | A watch condition, written in config: "item in `active` with no update for 24 h", "session holding a claim and silent for 30 min", "ask open longer than 2 h". A rule that fires creates a **Signal**. |
| **Signal** | Something that needs attention. It has a severity, a source and a link. Signals and open asks together make the **Needs you** list. |
| **Event** | Everything that happened, appended to a log. The "since you left" summary and the morning brief are built from events. |

## Config (`cue.config.yaml`)

```yaml
project: my-app
preset: qa-lead            # qa-lead | eng-manager | solo-dev; rules below override it

sources:
  - type: github           # built in: issues and PRs of a repo
    repo: owner/name
    tokenEnv: GITHUB_TOKEN
  - type: mcp              # any MCP server the user already has
    name: jira
    command: ["npx", "-y", "some-jira-mcp"]   # or url: http://…
    query: { tool: search_issues, args: { jql: "project = APP AND status != Done" } }
    map:                   # tracker fields → Cue item fields
      id: key
      title: fields.summary
      status: fields.status.name
      updated: fields.updated
      url: self
    stages:                # tracker status names → Cue stages
      active: ["In Progress", "In Testing"]
      review: ["Code Review", "Ready for test"]
      done: ["Done", "Tested"]

resources:
  - id: tablet-1
    kind: device
  - id: staging-config
    kind: config

rules:
  - id: stale-active
    when: { stage: active, idleHours: 24 }
    severity: warn
  - id: silent-claim
    when: { session: holdsClaim, silentMinutes: 30 }
    severity: urgent
  - id: old-ask
    when: { ask: open, ageHours: 2 }
    severity: warn

quietHours: { start: "19:00", end: "08:00" }   # non-urgent signals wait for the brief
```

## Interfaces

**1. Claude Code hooks.** `cuedesk hooks install` prints, or merges with the user's OK, a settings snippet. It sends `Notification`, `Stop`, `SessionStart` and `SessionEnd` events to `POST /api/hooks/claude`. A `Notification` becomes an Ask. `Stop` and `SessionEnd` update the session's last-seen time and state.

**2. MCP server** at `http://127.0.0.1:4520/mcp` (Streamable HTTP). It offers these tools:
- `ask_human(summary, details?, kind?, dueMinutes?)` returns an ask id. `get_answer(askId)` polls for the answer, or `ask_human` can wait for it.
- `report_progress(summary, item?)` adds an event to the log.
- `claim_resource(resourceId, reason, minutes)` and `release_resource(resourceId)`. A claim is refused while another session holds the resource, and the refusal names the holder.
- `whats_next()` returns the ranked Needs-you list and current priorities.
- `list_sessions()`, `list_signals()`, `since(timestamp)`.

**3. HTTP API** for scripts, with the same operations under `/api/*`, JSON in and out.

**4. Web UI** at `http://127.0.0.1:4520`. It has four views:
- **Needs you:** asks and signals, newest urgent first. Each card has its actions (Answer, Done, Dismiss, Snooze).
- **Now:** sessions and what they are doing, plus resources and who holds each one.
- **Board watch:** items grouped by stage, with stale ones highlighted.
- **Since you left / Brief:** a summary built from events since a time you choose.

## Ranking (whats_next)

Urgent signals and overdue asks come first. Then asks blocking a session that holds a claim, because they waste a resource. Then the rest by age. Presets can reorder; the QA preset, for example, puts dev questions first.

## Demo mode

`cuedesk --demo` starts with a fake project:
- three fake sessions sending asks and heartbeats;
- a fake board where some items are going stale;
- two resources, one of them claimed by a silent session.

Anyone can see what Cue does in one command, with no accounts.

## Out of scope for v0.1

- Driving devices or running tests. Cue coordinates; sessions do the work.
- Writing to trackers. A later version adds approved writes through the same MCP connectors.
- Multi-user and cloud hosting.
- Slack and phone push. Planned for v0.2.

## Roadmap

- **v0.1:** core model and SQLite store; hooks ingest; MCP server; GitHub and generic-MCP sources; rules engine; web UI with the four views; demo mode; presets.
- **v0.2:** Slack DM brief and urgent push, quiet hours, approved tracker writes, a promise tracker ("X said they'd do Y by Z").
- **v0.3:** a build desk (resumable, verified artifact downloads), a capacity forecast, and a decision log ("did I already decide this?").

## Tech

- Node ≥ 22 and TypeScript, run directly with Node's type stripping, or compiled for the release package.
- `node:http` server, `node:sqlite` store, `@modelcontextprotocol/sdk` for the MCP server and the MCP client sources, and `yaml` for config.
- The UI is static HTML, CSS and plain JavaScript served by the same process, with no build step in v0.1.
- `node:test` for tests.
- Releases are a packed tarball on GitHub Releases, installed with `npm install -g <release url>`.

## v0.1 implementation notes

Small deviations and clarifications made while building v0.1.

- **Runtime.** Source is TypeScript in `src/`, run directly with `--experimental-strip-types` for development and tests. The package ships `dist/`, compiled by `tsc` (`rewriteRelativeImportExtensions`). `bin/cuedesk` runs `dist/` when present and falls back to the source. `node:sqlite` is unflagged from Node 22.13; on 22.6–22.12 the launcher adds `--experimental-sqlite`. Its experimental warning is filtered from the terminal.
- **Ranking.** Tiers are `urgent` (urgent signals, overdue asks), `claimBlocking`, `tagged` and `rest`, in an order presets and `ranking.order` can change; `ranking.tags` names the tags for the `tagged` tier (qa-lead: `dev`, first). Inside a tier: more severe first, then oldest first. The UI line "newest urgent first" is read as "urgent first"; the UI shows the `whats_next` order as is. A rule signal about an open ask is shown on that ask's card instead of as a second card.
- **Quiet hours** (listed for v0.2) have a minimal v0.1 form: during quiet hours, non-urgent signals move to a "held for the brief" section. No push or brief delivery yet.
- **Hook asks.** A `Notification` ask cannot send an answer back into the terminal, so its card offers Done, Dismiss and Snooze, and Cue closes it when the session's next `Stop` or `SessionEnd` arrives. `SessionEnd` also releases the session's claims. Other hook events (e.g. `PostToolUse`) count as heartbeats.
- **`hooks install`** prints by default. `--write <path>` merges into the named settings file only, keeping `<path>.cuedesk-backup`.
- **Session identity.** Every MCP tool takes an optional `session` (id or label). Without it, each MCP connection is its own session, labelled with the client's name. Claims through the HTTP API need a named session; the UI can release any claim (the human decides).
- **Extra parameters.** `ask_human` also takes `tags` and `waitSeconds` (up to 600 s); `get_answer` takes `waitSeconds`.
- **HTTP API.** Every tool is `POST /api/<tool>`, read-only tools also `GET /api/<tool>`, with aliases `/api/sessions` and `/api/signals`. `/api/state` feeds the UI.
- **Items** missing from a source's next result are marked gone and leave the board (closed, or no longer matched by the query).
- **Extra config keys.** Top level: `port`, `db`, `pollMinutes`, `ranking`. GitHub: `name`, `apiUrl`, `include`, `stages` (labels to stages). MCP: `url` (Streamable HTTP), `env` (env var names passed to the server), `headersFromEnv`, `itemsPath`, `urlTemplate`, `defaultStage`. Rules: `disabled`, `idleMinutes`/`idleDays`, `silentHours`, `ageMinutes`, `session: any`, `source`.
- **Approvals for writes** do not apply yet: v0.1 never writes to trackers. Asks of kind `approve` get Approve and Reject buttons.
