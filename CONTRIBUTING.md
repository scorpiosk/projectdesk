<!-- Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT -->

# Contributing

Start with a small issue, a synthetic reproduction and a focused regression test. Useful
work includes accessibility, reliable task/note workflows, dependency updates and clearer
local setup. Preserve existing user data and imported workspace semantics.

Run the backend tests with a disposable PROJECTDESK_DB, then frontend `npm test` and
`npm run build`. Do not run destructive import or sample-data checks against your daily
workspace. Do not commit databases, exports, private notes, environments or credentials.

Tests in frontend/tests/acceptance.test.tsx preserve the reviewed behavior of filtering,
serialized note saves, conflict recovery and failed deletion. Keep assertions meaningful;
repair demonstrated behavior instead of weakening checks.

First-party contributions are covered by the MIT license. Preserve third-party attribution.
