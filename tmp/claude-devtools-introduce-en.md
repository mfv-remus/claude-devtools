# Claude DevTools — Internal Introduction

---

## 1. What is Claude DevTools?

### The problem it solves

- **Claude's reasoning (thinking)** is almost invisible in the terminal.
- **Tool call details** only show a one-line summary — you can't see the real input/output.
- **Subagent activity** (an agent calling a sub-agent) only shows the final result, not the process.
- **Context window** only has a 3-color progress bar — you don't know what's actually "eating" the tokens.
- **Team coordination** (messages between teammates, task assignment, shutdown requests...) is completely hidden.
- **Reviewing chat history** — many people don't know where to find old conversation history, or have to read the raw JSONL log files with a huge amount of raw data.

### What is Claude DevTools?

**Claude DevTools is a debugging tool for Claude Code** — an application that runs entirely on your own machine. It **reads back** the JSONL log files that Claude Code already writes automatically to `~/.claude/`, and reconstructs the entire session visually.

An important point: **this is not a wrapper** — it doesn't intervene in or modify how Claude Code runs. It only reads existing logs, so it works with every session that has already run, whether you ran Claude Code from the terminal, an IDE, or any other tool. No configuration, no API key required.

| What the terminal hides | What Claude DevTools shows |
|---|---|
| `Read 3 files` | The exact file path, syntax-highlighted content, line numbers |
| `Searched for 1 pattern` | The actual regex pattern, list of matching files, matching lines |
| `Edited 2 files` | Inline diff, highlighted additions/deletions |
| The 3-color context bar | Token allocation per conversation turn, broken down by source group (CLAUDE.md, skill, @-mentioned file, tool I/O, thinking, team overhead, user text...), plus a chart when compaction occurs |
| Merged subagent output | The full execution tree of each agent: tool trace, tokens, time, cost |
| No visible thinking | Full extended thinking content displayed |
| Raw JSON from `--verbose` | A structured interface — filterable, navigable |
| Project memory hidden in `~/.claude/projects/.../memory/` | `MEMORY.md` displayed as a clickable index, each layer openable in an editor |
| Copying from the terminal breaks lines and picks up ANSI color codes | Real selectable text, one-click copy for any message/code block |

### Main features

- **Context Reconstruction** — token allocation per conversation turn across 7 source groups, so you know exactly what's occupying the context window.
- **Copy & Paste friendliness** — select real text, one-click copy, export the whole session to Markdown / JSON / plain text.
- **Project Memory Viewer** — view `MEMORY.md` and Claude Code's memory layers as a structured sidebar, supports Obsidian-style `[[wikilinks]]`, quick-open via Finder/VS Code/Cursor/Zed...
- **Team & Subagent Trees** — isolated execution trees for each sub-agent, nested subagents still fully displayed.
- **Tool Call Inspector** — each tool call has its own viewer (Read with syntax highlighting, Edit showing a diff, Bash showing output...).
- **SSH Remote Sessions** — view sessions on a remote machine over SSH, with support for agent forwarding and key auth.
- **Compaction Visualization** — see exactly when the context becomes full, gets compacted, and refilled.
- **Notification Triggers** — system notifications on `.env` access, tool errors, high token usage, or custom regex patterns.
- **Command Palette & Multi-Pane** — `Cmd+K` to search across sessions, open multiple sessions side by side using drag-and-drop tabs.

Runs on **macOS, Linux, Windows** (desktop version) and **Docker** (standalone version, running as an internal web server).

> Because Claude Code changes constantly, some features/information may no longer display correctly.
> We need to continuously survey the log file data to make timely, appropriate changes.

---

## 2. What has this repo updated compared to the original repo?

`mfv-remus/claude-devtools` is a **fork** of the open-source repo [`matt1398/claude-devtools`](https://github.com/matt1398/claude-devtools).

### View Hook runs in the timeline too

Claude Code can run custom "hooks" at various points (session start, after receiving a prompt, after each tool call...).

Original Claude DevTools:
Hook runs are almost invisible.

Updated Claude DevTools:
Now Claude DevTools displays them directly in the conversation timeline, showing which hook ran and whether it succeeded or failed. When exporting a session to a file, the hook content is also fully included.

### View Subagent details in a separate window

Previously, to see what a subagent did, you had to scroll through the entire main conversation flow.
There are a few ways Claude Code can spawn a subagent:
- 1. The main agent calls a subagent — the main session calls the Agent tool.
- 2. A subagent attached to a skill.
  ```yaml
  ---
  name: skill-name
  description: "description of what skill will do"
  context: fork
  agent: general-purpose
  ---
  ```

Original Claude DevTools:
Only supports viewing subagents spawned via case 1, by scrolling through the entire main conversation flow. Does not support viewing subagents spawned via case 2.

Updated Claude DevTools:
Supports viewing both cases.

### Direct sharable links to a specific project/session

Original Claude DevTools:
The URL is always localhost:3456, regardless of which workspace or session the user opens. So when the user hits reload, the page goes back to the original home page.

Updated Claude DevTools:
Each workspace and each session has its own URL, so hitting reload still takes you back to the intended session.

### Compatible with the latest Claude Code version & models

Claude Code updates continuously (renaming internal tools, releasing new models like the Claude 5 line: Sonnet 5, Opus 5, Fable 5...).

Original Claude DevTools:
Model parsing has a bug when it fails to parse the new model format. As a result, the web UI doesn't show which model a session/subagent used.

Updated Claude DevTools:
Fixed.

### Strengthened security for self-hosting with Docker

Original Claude DevTools:
The Docker container is configured normally. If any flow in the source code sends information outward, it could leak information and create a security issue.

Updated Claude DevTools:
The Docker configuration has been redesigned so the application runs inside an isolated internal network with no ability to connect to the internet on its own — only a single intermediary port is exposed for user access.

---

## 3. Installation / trying it out

There are several ways to install the original Claude DevTools. However, I recommend running it via Docker, since I've optimized it for security.

**Run with Docker:**

```bash
docker compose up
# Open http://localhost:3456
```

---

## 4. Frequently Asked Questions (FAQ)

**Origin and license:**
Claude DevTools is fundamentally an open-source project, released under the **MIT** license.
The `mfv-remus/claude-devtools` repo is an **internal fork**.

**Does Claude DevTools change how Claude Code operates?**
No. It's a read-only tool, not a wrapper, and doesn't interfere with how Claude Code runs.

**Do I need to configure an API key?**
No. The application only reads JSONL logs that already exist on your machine.

**Is there more detailed documentation?**
The original repo has full documentation at [claude-dev.tools/docs](https://claude-dev.tools/docs).
