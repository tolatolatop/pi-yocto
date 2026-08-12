import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBitbakeVariables, parseSstateSummary } from "../src/native-cache.js";

test("parses effective BitBake values with their immediate history", () => {
  const parsed = parseBitbakeVariables(`# $SSTATE_DIR [3 operations]
#   set /meta/conf/bitbake.conf:1
#   set /build/conf/local.conf:4
SSTATE_DIR="/data/.cache/sstate-cache"
# $MACHINEOVERRIDES [2 operations]
#   set native.bbclass:114
MACHINEOVERRIDES=""
`, ["SSTATE_DIR", "MACHINEOVERRIDES", "TARGET_ARCH"]);
  assert.deepEqual(parsed[0], { name: "SSTATE_DIR", value: "/data/.cache/sstate-cache", history: ["# $SSTATE_DIR [3 operations]", "#   set /meta/conf/bitbake.conf:1", "#   set /build/conf/local.conf:4"] });
  assert.equal(parsed[1]?.value, "");
  assert.equal(parsed[2]?.value, undefined);
});

test("parses local and mirror sstate cache summary", () => {
  const summary = parseSstateSummary("NOTE: Sstate summary: Wanted 20 Local 14 Mirrors 3 Missed 3 Current 5 (85% match, 88% complete)");
  assert.deepEqual(summary, { wanted: 20, local: 14, mirrors: 3, missed: 3, current: 5, matchPercent: 85, completePercent: 88, line: "NOTE: Sstate summary: Wanted 20 Local 14 Mirrors 3 Missed 3 Current 5 (85% match, 88% complete)" });
});

test("uses the last summary and accepts summaries without percentages", () => {
  const summary = parseSstateSummary("Sstate summary: Wanted 2 Local 0 Mirrors 0 Missed 2 Current 0\nSstate summary: Wanted 2 Local 2 Mirrors 0 Missed 0 Current 0");
  assert.equal(summary?.local, 2);
  assert.equal(summary?.matchPercent, undefined);
});
