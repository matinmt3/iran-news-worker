# Local validation — 2026-10-15

Validated on Windows with Node.js 26.4.0. No production credentials, Telegram channel, Cloudflare account or D1 data were used.

| Check | Actual result |
| --- | --- |
| Fresh dependency installation | `npm ci --ignore-scripts` succeeded; public npm registry URLs only |
| Worker syntax | Passed |
| ESLint | Passed, including after dependency maintenance |
| Isolated regression suite | All 27 test files in `run_all.ps1` passed |
| Stress/property subset | 126,027 checks passed within the isolated suite; this is not a live service load test |
| Dependency maintenance | Compatible development dependency updates applied to the clean copy; npm reported zero known vulnerabilities afterward |
| Wrangler packaging | 4.151.0 binding-free `deploy --dry-run` succeeded, 628.98 KiB / 128.00 KiB gzip; no upload or deployment |
| Original source preservation | Original worker/test/source files were not modified |

The copied package lock was updated within the declared dependency ranges. Application and test code remain the supplied revision. Configuration templates replace infrastructure identifiers; actual runtime configuration is ignored. The local test configuration is generated from the sanitized example and is not committed.

The tests use controlled VM contexts and mock provider responses. This does not establish live Telegram delivery, AI output/news accuracy, production D1/cron behavior, a security certification or public availability. The CI workflow is configured; no hosted CI success is claimed before publication.
