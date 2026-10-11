# Privacy Policy — LicenseGate

**Effective date:** October 11, 2026

LicenseGate ("we", "the App") is a GitHub App that scans pull-request dependency changes for open-source license risks.

## What we collect

When you install LicenseGate on a repository, the App receives GitHub webhook events for pull requests and, in order to perform its function, accesses:

- **Pull request metadata** (repository name, PR number, head/base SHAs) — to know what to scan.
- **Dependency change data** via GitHub's dependency-review API — to evaluate newly introduced licenses.
- **Installation ID** — to authenticate API calls on your behalf.

We store a minimal scan log (repository, PR number, scan conclusion, timestamp) to operate the service and show scan history.

## What we do NOT collect

- We do not access your source code contents beyond the dependency metadata GitHub provides.
- We do not collect personal data beyond what GitHub includes in webhook payloads (e.g., the GitHub username that opened a PR).
- We do not sell, rent, or share any data with third parties.
- We do not use your data for advertising or training machine-learning models.

## Data retention

Scan logs are retained for 90 days and then deleted. You may request deletion of your data at any time by contacting us.

## Security

All API communication uses HTTPS. Webhook payloads are verified with HMAC-SHA256 signatures. Access tokens are held in memory only and never written to disk in plaintext.

## Contact

For privacy questions or data-deletion requests: zjiang5211@gmail.com

## Changes

We will update this policy if our data practices change. The current version is always available at this URL.
