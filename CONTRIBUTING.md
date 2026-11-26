# Working on Bash AI

Bash AI is maintained by Kinetic Scaling's developers. This page is the short version of how we work; [AGENTS.md](AGENTS.md) has the full design rules and folder layout.

## Who changes what

- Aaron owns the repository and decides what goes in.
- The extension is this repository. The Command Center side (sign-in, the model route, the company brief, knowledge tools, chat history) is in `kinetic-command-center`. A change that needs both is two commits in two repositories.
- Build configuration, CI under `.github/`, the entrypoints and the extension's permission list are changed only with Aaron's OK.

## How we work

- There is one branch, `master`. Do not create other branches.
- Keep each change small and about one thing.
- Ask before adding a dependency.
- Never commit secrets: no API keys, tokens, passwords or `.env` files.
- Follow the code style: Prettier with 2 spaces, semicolons, single quotes, trailing commas, 120 characters a line. Comments say in plain words what the code does and why.

## Checks before pushing

Use Node 24 and pnpm 10. On a machine whose Node is not 24, prefix the commands with `npm_config_use_node_version=24.22.1`.

```bash
pnpm exec prettier --check .
pnpm lint
pnpm type-check
pnpm test
pnpm build
```

Load `dist/` unpacked in Chrome and try the change before you push.
