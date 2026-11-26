# AGENTS.md

This file provides guidance to AI coding assistants (e.g., Claude Code, GitHub Copilot, Cursor) when working with this repository.

## Project Overview

This repository is the next version of Nanobrowser, an AI web automation Chrome extension, rebuilt from the ground up. It has two parts:

- **The browser control layer**: a deterministic layer that observes a page, acts on it, and reports what happened. It is part of the extension, and its client is the extension's own agent, in-process.
- **The extension** that end users run: the side panel, the one agent that works in it, model providers, and the features around them. It sits on top of the layer.

## This fork: Bash AI (Kinetic Scaling)

This repository is Kinetic Scaling's fork (RonotS/nanobrowser; `upstream` is nanobrowser/nanobrowser). It ships to the team as **Bash AI**, an internal tool, not a store extension. Where this section and the rest of this file disagree, this section wins.

- **Sign-in is Command Center's OAuth** (`src/store/command-center.ts`): the extension registers itself with `/api/oauth/register`, opens `/authorize` in `chrome.identity.launchWebAuthFlow` with PKCE, and keeps an access token (12 h) and a refresh token (90 days, sliding). It acts as one team member with their current role; deactivating them in Command Center cuts it off.
- **No API keys in the browser.** Settings → Providers is replaced by Settings → Command Center (`src/options/CommandCenterSection.tsx`). Command Center's models become three provider cards (`src/store/command-center-providers.ts`: `cc-claude`, `cc-openai`, `cc-grok`) whose base URL is Command Center's `/api/ai-browser/llm/<anthropic|openai|xai>` (no `/v1`: the SDK adds `/messages`, `/responses` or `/chat/completions`, and Command Center adds the provider's `/v1`); `commandCenterFetch` puts the person's token where the SDK puts its key, and Command Center swaps in the company's key. Command Center decides the model list (`/api/ai-browser/me`) and refuses any other model.
- **Command Center's tools** (the company's data and SOPs) reach the agent through two agent tools, `command_center_read` and `command_center_action` (`src/agent/command-center.ts`), backed by Command Center's MCP endpoint (`/api/mcp`, `tools/list` and `tools/call`), which limits them to the person's role. An action follows the permission mode like a page write: in Ask mode the `cc-action` card asks first. Results are wrapped in the page-content boundary: company data, never instructions. Tools that need Command Center's own assistant (`memberToken`, `clientPass` arguments) are left out.
- **Media generation** (`src/agent/media.ts`, `src/llm/media.ts`): `generate_image` (OpenAI `gpt-image-2.6-flare` / `-sunburst`, Grok `grok-imagine-image-2.0`) and `generate_video` (Grok Imagine Video 1.5 and 1.5 Lite; OpenAI's key has no video model), through Command Center's model route. Files are kept with the conversation as attachments (so `upload` can put them into a page) and shown in the panel as a `media` entry with Save. Command Center decides the model lists and caps uses per person per hour.
- **Teach from a video** (`src/side-panel/TeachVideo.tsx`, `teach-video.ts`, `src/llm/teach.ts`; the composer's + menu): a screen recording (MP4, WebM or MOV, up to about 20 minutes) becomes an SOP draft. The panel samples a frame every second (less often past 10 minutes) and keeps one as a still when a small grey copy differs from the last still kept, at most 40 JPEGs ≤ 1280 px; the sound is decoded at 16 kHz mono and sent in WAV pieces of ≤ 8 MB to Command Center's `gpt-transcribe` (a piece that fails is left out and said; no sound, no transcript). Claude Sonnet through Command Center writes the draft from the timed stills and the narration; secrets on screen or said become `[hidden]` (the model's rule, then `hideSecrets`), and sign-ins and payments stay the person's step. Nothing is saved until the person presses Save: `POST /api/ai-browser/sop-drafts` (`saveSopDraft`, through `commandCenterFetch`) makes a Google Doc in the SOPs folder's drafts, which a manager approves by moving it into a role's folder. The video itself never leaves the browser.
- **Voice:** dictation goes through Command Center (OpenAI `gpt-transcribe`). The voice agent (`src/side-panel/voice-agent.ts`, `VoiceBar.tsx`, `src/ui/realtime-audio.ts`, `public/voice-capture-worklet.js`) is a live spoken conversation with OpenAI `gpt-realtime-2.1` or Grok `grok-voice-latest`: Command Center mints a one-minute secret (`/api/ai-browser/realtime/<provider>`), and the panel connects to the provider's WebSocket with it, streaming 24 kHz PCM both ways. The voice panel sits at the top of the side panel with a live sound wave (`Waveform.tsx`) that follows the microphone while listening and the answer while speaking (AnalyserNode meters in `realtime-audio.ts`). The voice model has three tools: `browser_task` (sends the instruction to this panel's conversation, and is told when the run ends), `stop_browser_task`, and `command_center_lookup` (read tools only). OpenAI and xAI share event names but not the `session.update` shape; `sessionUpdate` writes each.
- **Company grounding** (`readKnowledge`, `companySection`, voice `voiceInstructions`): Command Center's `/api/ai-browser/knowledge` writes a brief per person (systems and links, where things are such as Fathom calls in Command Center, their role and ClickUp list, the SOP index, the team's rules and memories, the pages they can open). It goes into both agents' prompts (browser ≤ 32,000 characters, voice ≤ 16,000), and is read again at sign-in, at every renewal, and at a worker start when older than six hours. Bash AI's own tools (`search_sops`, `read_sop`, `my_tasks`, `search_knowledge`, `search_past_chats`, `read_past_chat`, `remember`, marked `via: 'bash-ai'`) run on `/api/ai-browser/tools/call`; every other tool still goes to `/api/mcp`. Staff read every SOP folder except Leadership and Finance (pay structures). `search_knowledge` searches by meaning (Command Center embeds the SOPs, Fathom meeting summaries and Bash AI chats with OpenAI `text-embedding-3-small`); meetings need the role's meeting access, and chats are the person's own unless they may see everyone's. `remember` is the one that changes something: it keeps Command Center's read-only mark, so Ask mode asks first, and a saved memory re-reads the brief (`refreshKnowledge`) so the next message has it. The voice agent gets the read tools only.
- **Side views** (`PanelRail.tsx`, `SideView.tsx`, `side-view.ts`; Command Center's `/api/ai-browser/panel`): a strip down the right of the panel switches between Chat and the views Command Center opens to the person's role: My tasks (every open ClickUp task assigned to them, straight from ClickUp; Command Center's mirror when no ClickUp user is linked; client-record tasks left out), ClickUp lists (theirs first, then every list by space), Quality checks and Churn risk (by permission). Read-only: a row opens the real page, Ask puts a question about it into the chat. The chat stays mounted while another view shows, and a card that needs the person switches back to it. Follows view-as.
- **Voice extras**: a mute button; "Show what Bash AI is doing" (Settings → General, `followAgent`, on by default) brings the agent's tabs to the front; the voice agent opens the page for anything that has one; each voice call is saved to Command Center as "Voice call: …" (not in temporary chats). Tab chips above the composer stay on one scrolling row. "Teach from a video" keeps its stills under a 5.5 MB budget (1,024 px, JPEG 0.7) so the request fits Command Center's 9.5 MB limit.
- **Bash AI's cursor** (`src/extension/cursor.ts`; Settings → General "Show Bash AI's cursor", `agentCursor`, on by default): while a run works, a blue pointer labelled "Bash AI" glides to each click, hover and scroll the agent makes, and a press shows a ripple. It is drawn like the page border (worker → `chrome.scripting.executeScript` into the top frame's isolated world; fixed, no pointer events, aria-hidden, closed shadow root), hidden for the model's screenshots (`layerPort`, after the border), and removed when the run stops. It learns where the agent points without changing the layer: `src/extension/layer.ts` builds the controller with `watchPointerInput(chromeAttacher, …)`, a proxy over each attachment whose `cdp.send` shows a top-level `Input.dispatchMouseEvent` to the cursor first; a move or wheel waits for the glide (at most `MOVE_WAIT_MS`, 450 ms, inside the pointer guard's 4 s lifetime), everything else passes through unchanged.
- **Chat history in Command Center** (`src/agent/history.ts`, `RunManager.saveHistory`): after every run (and a rename) the conversation's transcript goes to Command Center (`POST /api/ai-browser/conversations`), where Assistant → Bash AI chats shows it: each person their own, `assistant.bash_ai.all` everyone's. The transcript is what the panel showed (messages, answers, one label per step, files by name), never page text, screenshots or typed values; the whole transcript is sent each time. Conversations from before go once (`kai.historyBackfilled`).
- **Temporary chat** (`src/extension/temporary.ts`): the eye-off button beside New chat starts a chat that is never kept. The first message carries `temporary`, and the conversation is created with `temporary: true`: it is left out of Recent tasks, `saveHistory` skips it (so it never reaches Command Center's history or search index), and it is deleted with its messages, files and run record once no panel shows it and no run works in it. The worker checks when a panel moves to another conversation, when a panel closes (after a 5 s grace, for a panel that reloads), when a run ends, and 30 s after each worker start; a chat younger than 10 s is never dropped. A slim banner under the header says it is not saved. Not offered while a task runs.
- **View as** (developers; `viewAsStorage` = `kai.viewAs`, `setViewAs`, `listViewAsMembers` in `src/store/command-center.ts`): Settings → Command Center lists the members Command Center lets this person view as (`GET /api/ai-browser/view-as`, asked as themselves). While one is chosen, every Command Center request (all `/api/ai-browser/*` routes, the model route and `/api/mcp`) goes through `ccFetch`, which adds `X-Bash-AI-View-As: <memberId>`, so the role, tools, brief and chats are that member's. Command Center refuses changes meanwhile and files the chats under the real person. The panel header shows an amber "Viewing as" chip with Exit. A view-as Command Center refuses (403 on `/me`) is dropped, the reason kept in `kai.viewAsNotice` for the panel, and everything is read again as the person signed in. Sign-out clears it.
- **Type and reading:** Inter everywhere, as in Command Center, shipped in `public/fonts` (OFL, `Inter-OFL.txt`); answers no longer use a serif. Streamed answers are revealed at an even pace (`SmoothText.tsx`), faster when there is a backlog, and carry on into the finished answer without a jump. The panel header shows the signed-in person's name and role (Chrome's own title bar shows only the extension's name).
- **Not in this build:** analytics (no PostHog key is set, and the toggles are hidden), the store-rating card, Nanobrowser's What's new card, the uninstall survey, and the website links.
- **Brand:** the name is "Bash AI" (renamed from "The AI" on 2026-11-25) (UI catalogues and `public/_locales`), the icon is Kinetic Scaling's mark, and the colours are Command Center's (`src/ui/index.css`). Dark is the default theme (a theme still on System moved to Dark once, `kai.darkDefault`), and the panel header has a sun/moon switch. The Apache-2.0 credit to Nanobrowser stays in Settings → About.
- **Building:** `pnpm build` (set `VITE_COMMAND_CENTER_URL=http://localhost:3000` to point a build at a local Command Center), then load `dist/` unpacked. On a machine whose Node is not 24, prefix commands with `npm_config_use_node_version=24.22.1` so pnpm runs them on Node 24.
- The Command Center side lives in the kinetic-command-center repo: `src/lib/ai-browser.ts`, `src/app/api/ai-browser/**`, and `/api/ai-browser` in middleware's public API prefixes (each route checks the token itself).

## Scope

- **Built and maintained:** the browser control layer, a simple Chrome extension for testing it by hand (the test panel), fixture pages, unit tests, and the automated checks.
- **Built and maintained:** the extension. Its first release has a side panel per tab, one agent loop, model providers through the Vercel AI SDK, the permission modes, shortcuts, attachments (images and text), upload into pages, saved files, voice input through OpenAI's or Gemini's voice model, three UI languages (English, Simplified Chinese, Traditional Chinese), a glowing border on the pages the agent works on (with a switch in Settings), anonymous analytics (a daily count of users and usage counts, both on until the user turns them off) with no identifier, and a card that asks a user who uses it often to rate it in the store.
- **Not in the first release:** for example skills the model loads, site notes, saved memory, the in-page Stop pill, PDF and Office parsing, the text tool-call parser, scheduled tasks. Do not add any of these unless asked.
- **Not in scope:** an MCP bridge, browsers other than Chrome and Edge, a planner and navigator design, several cooperating agents.

## Fixed design constraints

These are settled and not open for redesign.

For the layer:

- **The layer is part of a Chrome extension, not a standalone tool.** It is not a runtime like agent-browser: no CLI, no daemon, no socket of its own, no launching or attaching to a browser, no remote CDP. Applications outside the extension will use it through an MCP bridge in future, and only that way. Do not add any other external entry point.
- **`chrome.debugger` is the only way to reach CDP.** The product is a Chrome extension. Do not add CDP over WebSocket, not even for tests.
- **Puppeteer is the frame manager.** It detects frames, including out-of-process iframes, and tracks their sessions and navigation. Do not build a parallel frame or session registry from CDP events.
- **Elements are never found through Puppeteer.** No selectors, `ElementHandle` clicks or selector-based `evaluate`. Element commands are raw CDP commands sent to the session of the frame Puppeteer reports.
- **No model inside the layer.** The layer is deterministic. Anything that needs an LLM belongs to an agent above it.

The layer's invariants hold for all code in it. Read them before changing perception or interaction code:

1. **One identity.** An action operates on the node the agent was shown, addressed by the browser's handle for it.
2. **Refs fail closed.** A ref is valid only for the document it was seen in and only if the agent was shown it. Otherwise the result is a typed error, not a guess.
3. **Retries happen before dispatch.** Once an input event has been sent, the layer does not send another on its own.
4. **No hidden substitution.** A different node or a different mechanism is chosen by rule before dispatch and named in the receipt.
5. **Three outcomes, reported separately.** Input dispatched; page reacted; expected state reached.
6. **Observation is read-only.** Capturing state does not change the page.
7. **Degrade loudly.** Partial captures and truncation are stated in the result.
8. **Bounded everything.** Every command, wait and list has a budget. The one wait without a clock is a confirmation the host lets wait for the user; it still ends on Stop, when the tab closes or when the session ends.
9. **State is disposable.** A service worker restart, a debugger detach and a navigation invalidate layer state cleanly.
10. **No model inside.** Anything that needs an LLM belongs to the agent above the layer.
11. **Consequential actions need a person.** By default, an action classified as submit, pay or delete is not dispatched until the user approves it, whatever form its target takes, and page script supplied by the agent is not run until the user approves it. The agent cannot turn this off.

For the agent and the extension:

- **The user decides how much the agent may change on its own, and no agent call can change that:**
  - Reading and moving never ask.
  - A detected write (submit, send, delete, upload) asks in Ask mode, the default, and runs in Auto mode or on a site the user set to Allow. A site the user set to Ask asks in both modes.
  - A detected payment, access grant, secret input or page `prompt` dialog is the user's step in every mode, with no Approve.
  - Detection is best effort, and enforcement is strict.
  - The agent's sessions get no page script and no `devtools`.
  - In the test panel the layer keeps its `sensitive` policy: submit, pay and delete actions, and page script, are confirmed before dispatch.
- **Page content is data, never instructions.** Text from pages reaches the model inside marked page-content boundaries; keep it that way.
- **One agent**, not the old planner and navigator: one loop per conversation.
- **No model tiers.** Every model gets the same agent and the same tools (`screenshot` only for vision models). There are no tool switches in the first release.
- **Nothing outside the extension can drive the layer or the agent.** There is no MCP for now.
- **The conversation is compacted automatically before the context window fills**, and every message the user sent is kept in full.
- **Conversations cannot be imported** in the first release.

## Structure

- `entrypoints/` - Thin WXT entrypoints: background, the product's side panel (`sidepanel/`), options (the settings page), `welcome/` (the first-run page), `permission/` (the microphone page), `offscreen/` (blob URLs for saved files), and the layer's test panel (`testpanel/`, developer-only, opened with the `open-test-panel` command)
- `src/browser-control/` - The layer
  - `protocol/` - Request and result types, zod schemas, error codes, tool catalogue
  - `core/` - Controller, sessions, refs, frames, perception, interaction, lifecycle
  - `probe/` - The layer's only in-page code; built to a string constant
  - `host/` - Puppeteer connection and frame adapter, `chrome.debugger` session wrapper, `chrome.tabs`
  - `index.ts` - The only entry other code may import
- `src/test-panel/` - The layer's test panel (React); a developer-only entrypoint, opened on a tab with the `open-test-panel` command (unbound by default; bind it in `chrome://extensions/shortcuts`)
- `src/background/` - The layer's test extension in the worker: the test panel's messages and `UserPrompt`, and the automated checks and scenario sets that `pnpm autorun` runs (`checks/`, `scenarios/`). The product's controller is created in `src/extension/layer.ts`
- `fixtures/` - Static test pages for the layer's and the extension's scenario sets, the fixture server (with a fake OpenAI-compatible model) and `autorun.mjs`
- `README.md`, `CONTRIBUTING.md`, `PRIVACY.md`, `SECURITY.md`, `LICENSE`, `.github/` - The project's pages for users and contributors, the issue templates, the CI workflow and the file guard (`.github/workflows/`), which fails a pull request that changes a file only the maintainer changes. `PRIVACY.md` says what data leaves the browser and where it goes; a change to that updates it
- `AGENTS.md` - This file; `CLAUDE.md` is a link to it
- `.env.example` - The PostHog key and host a production build reads; with both set it sends analytics, and development and autorun builds never send to PostHog

The extension:

- `src/agent/` - Loop, hooks, agent tools, prompts, context management, run records
- `src/llm/` - Providers, model profiles, usage, retries, overflow detection
- `src/store/` - IndexedDB schema and stores, settings, keys
- `src/extension/` - Wiring in the worker: RunManager, PromptBroker, permissions, TabScope, downloads, notifications
- `src/ui/` - Shared components, theme, the i18n runtime and the catalogues (`locales/`: English, Simplified and Traditional Chinese)
- `src/side-panel/` - The chat UI
- `src/options/` - The settings UI

**Import rules:**

- Nothing under `src/browser-control/` imports from outside that folder, and other code imports the layer only through `src/browser-control/index.ts`.
- `src/agent/` reaches Chrome APIs only through interfaces passed in by `src/extension/`.
- `src/side-panel/` and `src/options/` never import `src/agent/` or `src/extension/`; they talk to the worker through one typed message protocol.
- `src/llm/` knows nothing about browsers.

## Toolchain

The project is a single pnpm package built by WXT: Node 24 LTS, pnpm 10.34.7, WXT 0.21.4, TypeScript 6.0.3, Vitest 5.0.5, puppeteer-core ^25.16.0, zod 4.6.7, React 18.3.1. A patch or minor update is taken once the checks pass; a major update is evaluated and decided on its own.

pnpm 10.34.7 is pinned in `package.json` (`packageManager`). If the global `pnpm` is a different version, run the scripts through `corepack pnpm <script>`.

- `pnpm install` - Install dependencies (also runs `wxt prepare`)
- `pnpm dev` - WXT development mode; load `dist/` unpacked in Chrome
- `pnpm build` - Build the Chrome MV3 extension into `dist/`
- `pnpm zip` - Build, then pack `dist/` into `dist-zip/nanobrowser-<version>.zip` (source maps left out) for a release or the Chrome Web Store
- `pnpm type-check` - TypeScript type checking
- `pnpm lint` - ESLint, including the import rules: the layer's (`src/browser-control/`) and the extension's (Import rules, above)
- `pnpm test` - Unit tests (Vitest); tests live in `__tests__/` folders under `src/`
- `pnpm prettier` - Format the repository
- `pnpm fixtures` - Fixture server on port 8787 (localhost, 127.0.0.1 and [::1])
- `pnpm install-chrome` - Install the current stable Chrome for Testing (never beta or canary) into `~/.cache/puppeteer`, then ask to remove every other build there so only that one is kept (nothing is removed without a terminal to ask in). Run it after cloning and to update Chrome; `pnpm autorun` starts only the build recorded there as stable (or `CHROME_PATH`)
- `pnpm clean-chrome` - Ask, then remove the whole `~/.cache/puppeteer` (shared with other projects that use Puppeteer; they download their browser again)
- `pnpm autorun <check>[,<check>...] [--args <json>] [--scale <n>] [--product-permissions]` - Build an autorun copy of the extension into `.output/autorun`, start the fixture server and Chrome for Testing (headless, plain process, no external CDP, `--use-mock-keychain`), run the named checks in the extension and print the reports. `--scale 2` runs Chrome with that device scale factor, as on a Retina display. The autorun copy requires the Chrome permissions the product only asks for (tab groups, notifications, downloads); `--product-permissions` builds with the product's permission lists into `.output/autorun-product`, for the `without-permissions` check. `pnpm autorun permission-warnings` checks that the product's manifest adds no install warning to the old version's; run it before every release. Results go to `fixtures/.results/` (ignored by git)

CI (`.github/workflows/ci.yml`) runs `prettier --check`, `pnpm lint`, `pnpm type-check`, `pnpm test` and `pnpm build` on every push and pull request, on Ubuntu with the newest Node 24 and the pinned pnpm. Its actions are pinned to a commit, and its token can only read. The browser checks (`pnpm autorun`) and the checks that call real models (the evaluations, the model smoke run) are not in CI: they are run by hand, before a merge that touches what they cover and before a release. The file guard (`.github/workflows/file-guard.yml`) is the other required check on a pull request: it fails one that changes a path on its deny list (the files tools run or load on their own, and the other files only the maintainer changes) or a path with unusual characters, or 300 files or more, and it never checks out the pull request's code. `CONTRIBUTING.md` says in words which files a pull request may not change. CI runs on a pull request from a fork once a maintainer approves the run.

The extension's dependencies: `ai` with `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai` and `@ai-sdk/amazon-bedrock`, `aws4fetch` (signing for Bedrock's model list), `idb`, `react-markdown` with `rehype-sanitize` and `remark-gfm`, and `@radix-ui/react-dialog`; `fake-indexeddb` is a development dependency for the store tests. Any other dependency is proposed in a pull request that changes only `dependencies` or `devDependencies` in `package.json`, with the lockfile `pnpm install` writes, as `CONTRIBUTING.md` says, and the maintainers decide. Settings → About lists them with their licences, and a unit test keeps that list equal to `package.json`.

## Working rules

- Always use `pnpm`.
- Chrome and Edge only; the automated checks run in Chrome. The extension is loaded unpacked from `dist/`.
- One change per branch and pull request. Keep diffs scoped to it.
- Ask before adding a dependency, renaming or moving files, or changing global configuration.
- Pure functions get unit tests over recorded CDP payloads. Anything that needs a browser gets a fixture page and a scenario in the test panel.
- Formatting: Prettier with 2 spaces, semicolons, single quotes, trailing commas, `printWidth: 120`. Use `import type` for type-only imports.
- Comments say in plain words what the code does and why.
- Never log, commit or expose credentials. Mask password, payment-card and one-time-code values wherever page content is returned.
- Do not edit generated output (`dist/**`, `.wxt/**`).
- Chrome for Testing must never reach the real macOS Keychain. Every launch of it, by `pnpm autorun` or any other script or by hand, passes `--use-mock-keychain`.
