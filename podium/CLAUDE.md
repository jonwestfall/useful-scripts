# Working on Podium

## Testing: fast checks here, the full suite on GitHub

Jon's preference: don't run the whole end-to-end suite locally before pushing.
Run the fast checks, push, open (or update) the PR, and let GitHub Actions run
everything (`.github/workflows/podium-tests.yml`). Then read the failures on
GitHub and fix them.

Before pushing, run:

- **Lint**: `npx eslint .` in `podium/`, with the versions the workflow pins
  (`eslint@10.11.0 @eslint/js@10.0.1 globals@17.12.0`). Install them somewhere
  outside the repo if they are not already here, and leave nothing in
  `podium/node_modules` behind.
- **The unit tests for what changed**: `node test/<name>.test.mjs`. All of
  them is quick too (`for f in test/*.test.mjs; do node "$f"; done`).
- **The one e2e section the change is about**, if any:
  `node test/e2e/<group>.mjs --only "<section name>"`. Not whole groups.

After pushing:

- Watch the PR's checks. A failed group's log tail ends at the failing step.
  `ok` / `FAIL` lines say which check failed, and `console/page errors:` at the
  end fails a group even when every check passed.
- Fix the cause rather than re-running. Several e2e checks have proved
  timing-sensitive on CI's slower runners. The fix is to wait for the state the
  check depends on, never a longer fixed pause, and never skipping the check.

## LibreOffice

The conversion tests (`test/pptx-convert.test.mjs`, `test/zip-staging.test.mjs`,
the editor's "Word and RTF" section) pass with or without LibreOffice. The
real conversions only run where it is installed: on CI, the "Conversion
(LibreOffice)" job.
