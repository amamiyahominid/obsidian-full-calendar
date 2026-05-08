// Pin tests to UTC so the ics snapshot fixtures (src/calendars/parsing/ics.test.ts)
// are deterministic on contributors' machines regardless of host timezone.
// Runtime parsing intentionally uses the host's local zone.
process.env.TZ = "UTC";

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
	preset: "ts-jest",
	testEnvironment: "node",
};
