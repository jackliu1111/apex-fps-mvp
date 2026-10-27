# Spec review

Pinned diff: `git diff 86f7ef7c536493282a66265996223dc372293126...48030e08ca198c93c6c40f0e5af4c94e5d56e4ba`; both refs resolve, diff is nonempty. Commit list inspected with `git log 86f7ef7..48030e0 --oneline`.

1. **[P1] One unreadable fingerprint blocks healthy imports permanently for the session.** Spec line 82: “单份录像准备未完成不阻塞其他已就绪录像”. `app.js:91–102` hashes the entire batch sequentially before importing any record, and its cleanup `try/finally` starts only after hashing. If the second file's read rejects, the first remains in `pendingImports` without ever entering the queue. Browser reproduction `/tmp/cormorant-spec-import-repro.cjs`: queue count remained 1 before/after retrying a new healthy file; UI incorrectly said it was already imported. Isolate hashing failures per file, begin ready imports independently, and always release pending identity reservations.

2. **[P2] Large-export submission freezes too late.** Spec line 188: “提交时固定本批的片段、请求范围”. `app.js:80–81` awaits the directory picker before `workspace.submitBatch()` reads current selections. Background candidates or edits during the picker can change the batch after the submit click. Freeze a snapshot before asynchronous destination work, or finish directory preparation before enabling an explicit final submit.

3. **[P2] Matching outputs are never reused.** Spec line 49: “已有且范围与设置一致的成片 → 复用，避免重复转换”. `export-queue.mjs:32–39` unconditionally calls `convert` for every submission, even while an identical available output is retained. Add bounded source/range/audio/settings matching with correct URL ownership/eviction.

4. **[P2] Batch selection controls are missing.** Spec line 94: “通过列表快速跳转和批量修改选择”. `index.html:25` and `app.js:187–210` expose only per-clip toggles/exclusion. Add explicit bulk operations that preserve manual-decision semantics and skip provisional candidates.

5. **[P2] Partial exports omit remaining-clip status.** Spec line 192: “失败或取消保留已完成片段，并明确其他片段的状态”. `export-queue.mjs:49` stores only batch failure/cancellation; `app.js:283–298` renders completed outputs plus one batch label. The failed clip and never-attempted remainder are not identified. Record/render per-clip outcomes or an equally explicit completed/failed/not-started breakdown.

No material scope creep found. Five findings; worst within Spec: healthy-file import becomes unretryable after another file's read failure. Known concurrent-player stall excluded because its dedicated fix is already underway.

## Final recheck — f46796e83d759a873f85c3068ecf22f5cbf7c4a8

Reviewed `git diff ba56c21...f46796e83d759a873f85c3068ecf22f5cbf7c4a8` and its commit list, including fix `a9e9309`. Both refs resolve and the diff is nonempty. All five original Spec findings are resolved:

1. **Independent imports — resolved.** Spec 82: “单份录像准备未完成不阻塞其他已就绪录像”. `app.js:101–124` handles each fingerprint/import independently, catches each failure and clears its reservation in `finally`. Actual browser checks confirmed both unreadable-plus-healthy import and healthy import proceeding while another fingerprint is gated.
2. **Submission snapshot — resolved.** Spec 188: “提交时固定本批的片段、请求范围”. `app.js:79–99` calls `submitBatch` before awaiting the picker and uses that frozen batch afterward. Browser regression confirmed pending-picker edits cannot change it; picker cancellation starts no conversion.
3. **Artifact reuse — resolved.** Spec 49: “已有且范围与设置一致的成片 → 复用，避免重复转换”. `export-queue.mjs:21–45,60–82` matches source/range/audio/output, checks disk destination and file metadata, bounds the index and memory, and invalidates all references when a shared URL is released. Public-interface tests confirmed reuse with an unavailable encoder, mismatched-input rejection, disk invalidation and single URL revocation.
4. **Bulk selection — resolved.** Spec 94: “通过列表快速跳转和批量修改选择”. `index.html:25`, `app.js:391–392`, `review-workspace.mjs:209–214` expose bulk retention/exclusion, preserve independent decisions, skip provisional candidates and avoid duplicate retained ranges. Both public-interface and actual UI checks passed.
5. **Partial outcomes — resolved.** Spec 192: “失败或取消保留已完成片段，并明确其他片段的状态”. `export-queue.mjs:47–52,85–89,115–121` records per-clip outcomes; `review-workspace.mjs:116–129` restores them truthfully; `app.js:307–312` renders them. Actual conversion with an injected disk-write failure showed completed/failed/not-started before and after IndexedDB reload.

Independent validation: 24/24 workspace/export tests passed; `tests/verify-review-fixes.cjs` passed in Chrome against the current pinned checkout. No remaining actionable Spec findings or material scope creep found in this fix diff. Performance evidence was supplied by the parent; no unlanded parameter-tuning experiment was treated as an implemented feature.

## Final delta recheck — 08a2a09a5616e11b4495b476b6aa9d532e0a4981

Reviewed `git diff f46796e83d759a873f85c3068ecf22f5cbf7c4a8...08a2a09a5616e11b4495b476b6aa9d532e0a4981`. The complete delta changes only `media-read-source.mjs:1` from 1 MiB to 4 MiB reads and updates its explanatory comment at line 36.

**No new actionable Spec deviation.** Spec 111 requires resource contention to be scheduled; Spec 171 requires bounded preparation and obsolete requests not to overwrite current frames. The change retains one outstanding physical read, the same four-preview-chunk fairness rule, independent abort lifetimes, abort checks before and after each physical read, and the 8 MiB per-input parser-cache limit. It adds no full-file preparation or navigation-triggered analysis pause. Cancellation can still wait for one in-flight physical chunk; that chunk is now bounded at 4 MiB instead of 1 MiB.

Under Specs 176–178, the larger read size still requires empirical performance acceptance. Parent-supplied evidence reports three alternating runs for each size, mean first-candidate time improving from 16.842 to 15.303 seconds, all seven playback runs including 2 MiB at maximum event-loop lag <=16.7 ms, and 46 passing Node tests. These measurements were not independently rerun in this delta review. Final two-run full-recording throughput acceptance remains owned by the parent and was still running when this review completed.
