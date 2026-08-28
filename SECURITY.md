# Security

DOI Grabber is a personal, single-machine tool (see the README's opening note) — it isn't published on the Chrome Web Store, and it isn't a piece of software with a userbase in the traditional sense. Even so, it runs local code on your behalf (a Native Messaging host that can read, write, and delete files, and spawn a Python interpreter) and integrates with Sci-Hub, so it's worth being upfront about what that means and how to report a problem.

## Reporting a vulnerability

If you find a security issue — in the native host's path handling, the self-update mechanism, the extension's permissions, or anywhere else — please open a private report rather than a public issue:

- Preferred: [GitHub's private vulnerability reporting](https://github.com/materialcritic/doi-extension/security/advisories/new) for this repo (Security tab → "Report a vulnerability").
- Otherwise: use the [bug report form](https://github.com/materialcritic/doi-extension/issues) but avoid including exploit details in the public issue body — flag that you have a security concern and ask for a private channel instead.

This is a single-maintainer personal project, not a company with an SLA — there's no guaranteed response time, but real reports are taken seriously and fixed when found valid. Several real security-relevant issues have already been found and fixed this way (see `SESSION_LOG.md`'s history if you have access to it, or the commit history for anything mentioning "privacy," "validate," or "redact").

## What this tool can do to your machine

Worth knowing regardless of whether you're reporting something:

- **The native host (`doi_host.py`) can read, write, and delete files, and spawn a Python interpreter**, gated by Chrome's Native Messaging `allowed_origins` pin (only the one specific extension ID you installed can talk to it) plus explicit path/interpreter validation on the host side. This is defense in depth, not a claim that the extension surface is risk-free — the extension itself renders remote metadata from several third-party APIs across many pages.
- **It downloads from Sci-Hub**, which operates in a legal gray area depending on jurisdiction. See the README's legality note.
- **DOIs you view are sent to Crossref, OpenAlex, Semantic Scholar, and (on a download attempt) Unpaywall**, for availability checks and metadata. See the README's Privacy section for what's sent and when.
- **Diagnostic logs are stored locally and redacted before export**, but "redacted" means "OS usernames and URL query strings are stripped on a best-effort basis," not "guaranteed to contain nothing sensitive." Review an exported log before sharing it if you're not sure.

## Scope

In scope: the extension (`extension/`), the native host (`native-host/`), and the installers. Out of scope: Sci-Hub itself, Crossref/OpenAlex/Semantic Scholar/Unpaywall's own APIs, and Chrome's own Native Messaging implementation.
