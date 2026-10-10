# Validation / 验证记录

Date: 2026-09-16. Target: Windows 11 x64. Version: 0.1.3.

This document separates software checks from real platform acceptance. Test accounts, cookies, model keys, question images and logs are synthetic or local only and are not published.

The latest Windows navigation fix is 0.1.4, dated 2026-10-10: [ERR_ABORTED reproduction, regression checks and installation evidence](ENTER_CLASSROOM_FIX_0.1.4.md). The records below describe the earlier 0.1.3 validation.

## Local checks

| Check | Evidence | Result |
|---|---|---|
| TypeScript and production bundles | `npm run build` | PASS |
| Core and integration tests | `npm test`: 60 tests, 3 files | PASS |
| Current fullscreen screenshot layout | `npm run test:capture`: matching cover with Qiniu signature rotation at 100% display scaling (0.1.3); prior 150% display-scaling check (0.1.2); wrong slide, transformed content and clipped cover rejected; expired-link refresh and changed/closed/answered/expired question guards | PASS |
| Electron desktop fixture | 16 scenarios, 4 synthetic submissions, 7 model calls | PASS |
| Dependency audit | `npm audit`: 0 reported vulnerabilities on 2026-09-16 | PASS |
| Startup recovery | `node tests/startup-recovery.mjs`: saved API fields survive an unreadable login snapshot | PASS |

The 16 desktop scenarios cover login, persistent login, logout, encrypted API key, randomized image probes, preview without submission, single choice, duplicate events, multiple choice, ordered multiple blanks with punctuation, authenticated screenshot fallback, long-question segmentation, minimized capture, WebSocket reconnection, uncertain receipt without retry, and stopped startup with the recovered ledger.

The core tests also cover malformed model output, exact 64-bit IDs, invalid option sets, deadline changes, model service errors, atomic-write failure, and pause/stop/question closure during asynchronous Cookie lookup immediately before network dispatch. A real local TCP reset test verifies that the POST transport does not silently retry an already received request.

Reports and screenshots are generated locally under ignored `test-results/`. Fixture results do not contain evidence of real classroom compatibility or model answer accuracy.

Version 0.1.1 regressions reproduced and fixed: unreadable platform-session ciphertext blocked initialization; the real `hello.timeline` problem entries were ignored; repeated presentation reads caused platform HTTP 429; rotating CDN `auth_key` values falsely invalidated pending answers. Tests verify that startup still restores model fields, timeline discovery does not refetch presentations, pre-submit verification still fetches fresh content, and server version/image-content changes still invalidate an answer.

Version 0.1.2 reproduces and fixes two additional failures: `rain-pri-ups-ali.yuketang.cn` signature rotation changed the revision, and the current fullscreen page rendered its question in `.page-exercise .slide__wrap > img.cover` rather than the previously supported question nodes. Failed original downloads now refresh the question once, with revision/status checks before retry. Screenshot matching uses the cover URL supplied by that question's presentation response, retaining all non-signature URL components.

Version 0.1.3 fixes `rain-pri-ups-qn.yuketang.cn` rotating `e` / `token` credentials being treated as a question revision. The failure was reproduced through the real adapter-to-engine flow with local fixtures before the fix. Only credentials on this exact observed CDN are excluded; changed image-processing parameters and unknown-host query changes still cancel submission. Old and refreshed live image URLs returned identical image bytes. A production screenshot regression also covers rotated Qiniu cover links. See [Qiniu private download URL documentation](https://developer.qiniu.com/kodo/1656/download-private).

## Installer

The current-user NSIS installer was built and installed on Windows 11 x64 (OS build 26200); the installer returned exit code 0. No GitHub Release was created.

| Artifact | Value |
|---|---|
| Filename | `RainClassroom-AI-0.1.3-Setup.exe` |
| Size | 112,182,913 bytes |
| SHA-256 | `27B308E8BBC2FB292C99DB4625356CF61B61C82630B61C3927CB946B824B27BE` |
| Authenticode | NotSigned; no signing certificate configured |
| Installed runtime | PASS: `app.isPackaged === true`, version 0.1.3 |
| Chinese paths | Installer launched from a Chinese project path; isolated Chinese user-data path passed. Installation destination used the default current-user Programs directory. |
| Window/zoom | PASS: 1030 × 720 window, 125% page zoom, no horizontal overflow in dashboard or model settings; screenshot visually reviewed |
| Archive contents | PASS: no research, fixture tests, runtime data, session snapshots, settings or ledger files |
| Renderer isolation | PASS: `window.require` and `window.process` unavailable |

The installed app launched its bundled Electron runtime directly, with no Node.js runtime used by the application. This machine has development tools installed; a separate clean Windows machine test has not been performed. `tests/package-smoke.mjs` uses Playwright as the external test driver and creates an isolated profile, preserving the interactive user's account session. Local reports remain ignored.

## Live acceptance — PARTIAL / 待完成

| Check | State |
|---|---|
| Real official login and identity verification | OBSERVED on 2026-09-16; no account identifiers published |
| Real account/model settings across restart | PASS: installed 0.1.2 retains Base URL, model name, encrypted key, vision-test status and all 14 ledger records after the final restart; retained login session was verified against the platform; server-side logout invalidation remains NOT_RUN |
| Real active-classroom list and valid student session | OBSERVED |
| Recovery of published questions from official timeline | PASS: published questions recovered across three presentations in the same lesson; accepted tasks retained after restart |
| Real new-question detection | PASS: seven newly published questions detected and submitted by installed 0.1.2 without restarting the listener |
| Real close-question and reconnect events | Teacher closure observed after a completed submission; closure during solving and actual network-interruption recovery remain NOT_RUN, covered by fixtures |
| Real original question images | PASS |
| Real authenticated screenshot fallback | PARTIAL: the production screenshot function captured the complete real Q02 region in the shared authenticated view and was visually reviewed; end-to-end failed-download fallback and long segmentation passed with fixtures |
| User-configured external vision-model API | PASS: 12 valid answers automatically submitted across the live test; 2 earlier empty-template tasks rejected by answer validation without submission |
| Single-choice: 3 questions and official submission records | PASS: 3 submitted, 3 matched official stored results |
| Multiple-choice: 3 questions and official submission records | PASS: 3 submitted, 3 matched official stored results; answer sets contained two or three choices |
| Fill-in-the-blank: 3 questions and official submission records | PASS: 3 single-blank questions submitted and matched, including a negative number and a decimal; real multiple blanks, Chinese and mathematical-expression answers remain NOT_RUN |
| Additional A/B judgment exercises | PASS: 3 submitted and matched as single-choice questions; this does not add native judgment-type support |
| Model correctness / official grading | NOT_RUN; submission acceptance is not correctness |

At 19:53 China Standard Time, installed version 0.1.2 was restarted, the saved login was verified, and the same classroom was entered again. Three fresh official presentation responses were compared locally with the durable ledger: all 12 accepted submissions matched (multiple-choice compared as a set; blanks compared in order). The earlier four submissions were retained, and eight more were completed with 0.1.2. Two old empty-template tasks remain skipped and are excluded from valid-question counts. Startup remained stopped and did not resend any answers. Raw responses, images, account identifiers, credentials and answers are not published.

A second classroom was tested later on the same date. Two questions were accepted with 0.1.2; the newly observed Qiniu signatures then caused pending answers to be skipped. After installing 0.1.3, those skipped tasks were recovered and the lesson reached 12 accepted submissions in total (six single-choice including three A/B judgment exercises, three multiple-choice, three single-blank). The teacher view explicitly confirmed the final multiple-choice submission. The user ended testing before the final restart and fresh full-class official-answer comparison; those checks are **NOT_RUN for this second classroom**. This does not replace the earlier 12/12 stored-answer comparison. A reopened/extended skipped question required stopping and restarting the listener to resynchronize.

The first classroom's live submission-count target is complete. Overall acceptance remains partial: real multiple-blank ordering and text variations, full download-failure screenshot fallback, long-question segmentation, network interruption and uncertain-receipt recovery, server-side logout invalidation, and a separate clean Windows installation still need their corresponding real-world checks. Automated grading retrieval is not implemented.

These require a signed-in user, a live classroom activity and a user-configured vision API. They must not be marked passed from HTTP 200 alone, a local status label or fixture tests. Keep AI answer correctness separate from submission acceptance. Unknown submissions must be checked through official records before any further action.

## Protocol observations

The adapter uses candidate paths `/api/v3/user/basic-info`, `/api/v3/classroom/on-lesson`, `/api/v3/lesson/presentation/fetch`, `/api/v3/lesson/problem/answer` and `/wsapp/`. The official page, not the app, initiates classroom check-in; its response supplies the classroom token and Set-Auth bearer for the selected student classroom. Extra verification is handled in the official page.

`hello.timeline` and `fetchtimeline` contain published `type: problem` entries with `prob`, `pres`, `sid`, `dt` and `limit`. These were observed in the live classroom. The `unlockedproblem` field is optional. `unlockproblem`, `probleminfo`, presentation updates and lesson completion are also implemented. A fresh question-info response and presentation read precede submission. Only the observed `rain-pri-ups.yuketang.cn` and `rain-pri-ups-ali.yuketang.cn` CDNs' `auth_key`, and `rain-pri-ups-qn.yuketang.cn`'s `e` / `token`, are excluded from the content revision; real content and server version remain checked.

截图基于准确题目标识或平台本题封面定位，不截图整个桌面。长页面按顺序分段；无法证明完整的嵌套裁剪布局不自动提交。
