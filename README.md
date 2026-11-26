<p align="center">
  <img src="public/icon-128.png" width="96" alt="Bash AI" />
</p>

<h1 align="center">Bash AI</h1>

<p align="center">Kinetic Scaling's internal AI assistant for Chrome.</p>

Bash AI is a Chrome extension for the Kinetic Scaling team. It opens in the browser's side panel, signs in with your Command Center account, and works from the company's own SOPs, clients and data. Ask it a question, or give it a task, and it reads pages, clicks, types and moves between tabs to get it done.

It is an internal tool, not a public product. It is not in the Chrome Web Store; the team loads it from a build.

## What it does

- **Signs in with Command Center.** There are no API keys in the browser. Bash AI acts as you, with your current role in Command Center, and stops working if your account is turned off.
- **Uses the company's models.** Claude, OpenAI and Grok answer through Command Center, which adds the company's keys and decides which models can be used.
- **Knows the company.** Each person gets a brief written for them: the systems and links we use, their role and ClickUp list, the SOPs, the team's rules and memories, and the Command Center pages they can open.
- **Uses Command Center's tools.** It can look up clients, ad accounts, calls, appointments, meetings, payments and tasks, as far as your role allows. It searches and reads the SOPs, searches by meaning across SOPs, meeting summaries and your past chats, and can remember a fact you ask it to keep.
- **Works in the browser.** It reads pages and acts on them. You choose how much it may do on its own (see below).
- **Talks.** A voice agent (Grok, with OpenAI as the fallback) at the top of the panel, with a live sound wave. You can also dictate instead of typing.
- **Makes images and videos** with the company's OpenAI and Grok image and video models.
- **Keeps your chats in Command Center.** Under Assistant → Bash AI chats, each person sees their own; managers can see everyone's.

## You decide what it may do

| What Bash AI does                                  | Ask mode (default)    | Auto mode             |
| -------------------------------------------------- | --------------------- | --------------------- |
| Read pages, click links, scroll, move between tabs | Goes ahead            | Goes ahead            |
| Submit, send, delete or upload                     | Asks you first        | Goes ahead            |
| Change something in Command Center                 | Asks you first        | Goes ahead            |
| Pay, enter a password or code, grant access        | Hands the step to you | Hands the step to you |

You can also set a site to **Allow**, **Ask** or **Block** in Settings → Permissions. Text on a web page is treated as information, never as instructions. Press **Stop** at any time to take over.

## Install

1. Get the latest build (the `bash-ai-<version>.zip` file) from Aaron, and unzip it. Or build it yourself (below) and use the `dist/` folder.
2. Open `chrome://extensions` (in Edge, `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and choose the unzipped folder.
4. Open Bash AI from the toolbar (or press `Alt+Shift+N`) and sign in with Command Center when it asks.

To update, replace the folder with the new build and click the reload icon on the Bash AI card in the extensions page.

## Build from source

You need Node.js 24 and pnpm 10 (`corepack enable` switches to the pinned version).

```bash
pnpm install
pnpm build        # builds the extension into dist/
pnpm zip          # builds and packs it into dist-zip/
```

By default a build talks to the live Command Center. To point a build at a Command Center running on your computer:

```bash
VITE_COMMAND_CENTER_URL=http://localhost:3000 pnpm build
```

On a machine whose Node is not 24, prefix the commands with `npm_config_use_node_version=24.22.1`.

Checks to run before pushing:

```bash
pnpm exec prettier --check .
pnpm lint
pnpm type-check
pnpm test
pnpm build
```

[AGENTS.md](AGENTS.md) (also `CLAUDE.md`) describes how the extension is built, its design rules and the folder layout, for people and for AI coding assistants. Its "This fork" section lists everything that is specific to Bash AI.

## Where the Command Center side lives

Sign-in, the model route, the company brief, the knowledge tools and chat history are in the Command Center repository (`kinetic-command-center`): `src/lib/ai-browser*.ts` and `src/app/api/ai-browser/**`.

## Privacy and security

What leaves the browser, and where it goes, is in [PRIVACY.md](PRIVACY.md). To report a security problem, see [SECURITY.md](SECURITY.md).

## Credits and license

Bash AI is based on [Nanobrowser](https://github.com/nanobrowser/nanobrowser), an open-source AI web agent for Chrome, and keeps its browser control layer. Nanobrowser itself builds on [Puppeteer](https://github.com/puppeteer/puppeteer), the [Vercel AI SDK](https://github.com/vercel/ai), [WXT](https://wxt.dev) and ideas from [Browser Use](https://github.com/browser-use/browser-use). Thanks to their authors.

Like Nanobrowser, it is licensed under the Apache License 2.0. See [LICENSE](LICENSE). Settings → About in the extension also credits Nanobrowser and lists the libraries it uses with their licenses.
