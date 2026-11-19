# AGENTS.md — coretrace-vscode

Rules for AI agents (Codex, Copilot, Cursor, Claude Code…) working on this repository.
Humans follow the same rules. This file is protected by `CODEOWNERS`: any change requires a review.

## Project
CoreTrace VS Code extension (strict TypeScript, Node 20, VS Code API ^1.82). License GPL-3.0.
- `src/`: extension (TypeScript). `src/ctrace/`: running `ctrace`, SARIF parsing, analyzer installation.
- `media/`: webview (framework-free JS, CSS). `media/lucide.min.js` is generated: do not edit it.
- `src/test/`: mocha tests run inside VS Code via `@vscode/test-cli`.

## Commands
- Install: `npm ci`
- Build: `npm run compile` (must pass with no errors)
- Test: `npm test` (on headless Linux: `xvfb-run -a npm test`)
- Measure debt: `npm run debt` — check it does not increase: `npm run debt:check`
- Enable local hooks (once): `npm run hooks:install`

## Definition of done
1. `npm run compile` and `npm test` pass.
2. Every behavior change in `src/` (outside `src/test/`) comes with a test in `src/test/`.
3. `npm run debt:check` reports no increase: no dead code, no new file over 500 lines,
   no new npm vulnerability, no `TODO` / `FIXME` added without a linked issue (`TODO(#123)`).
4. If debt goes down, update the baseline with `npm run debt:baseline` in the same PR.

## Conventions
- Follow the style of the file you edit (indentation, quotes). Do not reformat a whole file.
- Reuse what exists before writing new code: `CommandBuilder` to build a command, `SarifParser` to read a report,
  `DiagnosticsManager` to display a problem.
- Do not grow `src/extension.ts`, `src/SidebarProvider.ts` or `media/main.js` (already over 500 lines):
  put new code in a dedicated module.
- No new `any` without a justification in a comment.

## Security (forbidden)
- Building a shell command by concatenating a value that comes from the user, a setting or a file:
  go through `CommandBuilder` (`execFile` without a shell, or `shellEscapeArg` for WSL).
- Weakening the webview Content-Security-Policy, injecting unescaped HTML, using `eval` or `new Function`.
- Downloading a binary or an archive without HTTPS, or extracting an archive without checking paths (path traversal).
- Writing a secret, a token or an absolute machine path in code, tests or logs.

## Dependencies and licenses
- Do not add any dependency without stating it explicitly in the PR description, with its license.
- The repository is GPL-3.0. Accepted licenses: MIT, ISC, BSD, Apache-2.0, LGPL, MPL-2.0, GPL-3.0.
  Rejected: GPL-2.0-only, SSPL, BUSL, proprietary or missing licenses.
- Do not copy code from an external source without stating its origin and license.

## Pull requests
- If an AI wrote part of the code: tick « Assistée par IA » in the PR template, add the `ai-assisted` label
  and the commit trailer `Assisted-by: <tool>`.
- Describe what changed, how it is tested, and the debt introduced or paid down.

## Do not modify without an explicit request
`LICENSE`, `.github/workflows/`, `debt-baseline.json` (except to lower it), `media/lucide.min.js`, `package-lock.json` (except for a justified dependency addition).
