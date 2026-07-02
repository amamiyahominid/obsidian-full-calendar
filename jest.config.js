// Pin tests to a fixed zone so the ics snapshot fixtures
// (src/calendars/parsing/ics.test.ts) are deterministic on contributors'
// machines regardless of host timezone. Runtime parsing intentionally uses
// the host's local zone.
//
// Asia/Tokyo rather than UTC: a whole class of rrule day-shift bugs only
// manifests when the host sits east of UTC (an event whose local time is
// before the UTC offset starts on the previous UTC day), so at UTC those
// regressions are structurally invisible. See src/ui/interop.test.ts.
process.env.TZ = "Asia/Tokyo";

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
	preset: "ts-jest",
	testEnvironment: "node",
};
