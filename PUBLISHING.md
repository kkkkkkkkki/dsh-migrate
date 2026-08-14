# Publishing dsh-migrate to the DSH community

Step-by-step, from this directory (`G:\ds\dsh-migrate`). The git repo is
initialized and committed; `gh` (GitHub CLI) is installed via winget.

## 1. Log in and create the GitHub repo

```sh
gh auth login            # pick GitHub.com → HTTPS → browser
gh repo create dsh-migrate --public --source . --push \
  --description "Import chat history & memory from other AI agents (Claude Code, Codex, Gemini CLI, Aider, Cline, OpenCode) into DeepSeek Harness"
```

## 2. Add the `dsh-plugin` topic (this is the community listing)

DeepSeek Harness's "Community plugins" page is
<https://github.com/topics/dsh-plugin> — repos carrying that topic appear
there automatically.

```sh
gh repo edit --add-topic dsh-plugin --add-topic deepseek-harness --add-topic agent-migration
```

Verify: <https://github.com/topics/dsh-plugin> should list the repo within a
few minutes.

## 3. (Optional) Publish to npm so `dsh plugin add` / `npx` work by name

The README's install flows assume the npm package `@kodzhima/dsh-migrate`.
(If you publish under a different scope, update `package.json` `name`,
`cordis.patch.yml`, and both READMEs first.)

```sh
npm run build
npm publish --access public      # needs `npm login` with publish rights on @kodzhima
```

Until it is on npm, installation from the GitHub repo also works:

```sh
dsh plugin --profile web add kodzhima/dsh-migrate   # or <you>/dsh-migrate
```

## 4. (Optional) Announce

Open a "Show and tell" post in
<https://github.com/deepseek-ai/deepseek-harness/discussions> — that is the
channel the maintainers watch per CONTRIBUTING.md.
