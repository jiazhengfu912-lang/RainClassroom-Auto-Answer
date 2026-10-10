# 雨课堂自动答题 · RainClassroom Auto Answer

[简体中文](README.md) · [Issues](https://github.com/jiazhengfu912-lang/RainClassroom-Auto-Answer/issues)

An experimental Windows 11 x64 app for standard RainClassroom (`www.yuketang.cn`). Sign in through the official website, select one live classroom, capture question images, and use your own vision-model API to preview or automatically submit single-choice, multiple-choice and fill-in-the-blank answers.

> 懒人必备，鼠标也想下班。 Your mouse deserves a coffee break.

Let the app handle repeated screenshots, answer entry and submission clicks. You bring the account and vision API; it brings the button-pressing stamina. AI can still be confidently wrong, so a successful submission is not a passing grade.

**Version 0.1.4 fixes an `ERR_ABORTED` failure notice when the official page redirects while entering a classroom.** An earlier live run matched all 12 submissions against fresh official stored answers. A second classroom reached 12 accepted submissions; its final full comparison and restart check were stopped by the user and remain pending. See [validation evidence and remaining checks](docs/VALIDATION.md).

Real login, published-question recovery, new-question detection, original images and the configured vision API have been exercised. The screenshot function captured a complete real question in the authenticated page. Live end-to-end download-failure fallback, multiple blanks, network reconnection and grading correctness still require further acceptance.

## Run

```powershell
npm ci
npm test
npm run test:capture
npm run build
npm run test:e2e
npm start
npm run package
```

Build environment: Node.js 24.13+, npm, Windows 11 x64. The current-user installer is produced in `deliverables/`; it does not require Node.js on the user's machine. Publishing is explicitly disabled during packaging.

## Workflow

Open the official page and sign in there, then return to the dashboard and verify your login. Configure a Chat Completions-compatible API root, API key and vision model; the image capability test makes two billable model calls. Select a live classroom, completing any official entry verification, and choose preview or automatic submission. Entering a classroom can also perform platform attendance.

If the classroom list is empty, use the same account to check in or enter the active classroom through RainClassroom, then refresh the app. The local installer is unsigned. An installed-app smoke check is available with `node tests/package-smoke.mjs "absolute installed executable path"`; it uses an isolated Chinese user-data path.

For a previously skipped question that the teacher reopens or extends, stop and start answering again to resynchronize. Accepted or unknown submissions remain protected against automatic retries.

Pause blocks unsent submissions while retaining receipts for requests already sent. Closing the main window exits; restart never automatically starts answering. Minimized operation is supported. Suspend and network interruption require reconnection and resynchronization.

## Reliability and data

- Platform image first; failed downloads refresh the question image URL once before falling back to an authenticated screenshot. The region must match the question identifier or its verified slide cover. Wrong slides and clipped or incomplete content are rejected.
- Official classroom type mapping: single=1, multiple=2, blanks=4. Ordered blank answers preserve punctuation.
- Exact identifiers, validated structured model output, fresh identity/question/deadline checks, write-ahead persistence and duplicate suppression.
- Interrupted submissions become `UNKNOWN`. Accepted, rejected or unknown submissions are never automatically resent. Platform acceptance is separate from grading correctness.
- Grading is explicitly displayed as not retrieved: its platform protocol has not been validated. Check actual scores and correctness in the official page.
- API keys are encrypted using Electron safeStorage/Windows DPAPI. Platform cookies are isolated from model requests. The model receives image bytes and necessary text, never classroom credentials.
- Model configuration is restored independently of platform session snapshots. An unreadable login snapshot prompts login verification without hiding saved model settings. Saved API keys are not echoed into the form.
- Published questions are recovered from the official timeline. Discovery reuses presentation data while pre-submit checks still fetch fresh content. Verified CDN signature rotation does not change question identity; actual version, image-path and transformation changes still invalidate answers.
- User data remains local; images stay in memory. Logout clears platform storage but retains the submission ledger. Same-user malicious software is outside DPAPI's protection boundary.
- Remote official pages run in sandboxed WebContentsView instances without Node.js or privileged IPC bridges.

The E2E suite uses an isolated local HTTP/WebSocket/model fixture and separate user data. Test endpoint overrides are disabled in packaged builds. Private data, screenshots, installers, research bundles and build artifacts are excluded from Git.

Internal RainClassroom APIs and DOM structures can change. This release targets one account and classroom, with three question types; it does not promise correct model answers. [Sources and third-party notices](THIRD_PARTY_NOTICES.md). [Public privacy audit](docs/PRIVACY_AUDIT.md). No project-level license has been added.
