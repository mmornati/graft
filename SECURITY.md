# Security policy

## Reporting a vulnerability

Please do **not** open a public issue, discussion or pull request for a security problem.

Report it privately through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**
(<https://github.com/mmornati/graft/security/advisories/new>).

Include what you can of:

- the affected component (webhook receiver, policy engine, intent service, CLI, ...) and version or commit;
- steps to reproduce, or a proof of concept;
- the impact you expect (for example: signature bypass, policy bypass, secret or PR content leaking
  into logs, prompt injection that changes a verdict).

You should get a first answer within 7 days. Once the issue is confirmed, a fix and a GitHub
Security Advisory are prepared together with you, and you are credited unless you ask not to be.

## Supported versions

Graft is pre-1.0. Only the latest commit on `main` receives security fixes.

## Scope

In scope: the code in this repository, its default configuration (`.env.example`,
`docker-compose.yml`, `github/app-manifest.json`) and its CI workflow.

Out of scope: vulnerabilities in GitHub, the Anthropic API or third-party dependencies (report
those upstream), and issues that need an already-compromised host, App private key or webhook
secret.

## Handling secrets

Never commit real credentials. `.env`, `*.pem` and other key files are git-ignored; the App's
private key, webhook secret, `ANTHROPIC_API_KEY` and `GRAFT_EVAL_KEY` belong in a secret store.
If you find a credential in this repository or its history, report it as above.
