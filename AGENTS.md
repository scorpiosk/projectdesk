<!-- Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT -->

# ProjectDesk development

Preserve the existing application, its styles and SQLite data. Use small complete edits
and verify behavior early. Keep model services and unrelated tools out of app fixes.

Task callbacks must read stable current state. Merge filters before requests and reject
stale responses across both filtering and refreshes.

Notes use one StoreProvider-owned controller per ID. Keep drafts and serialized writes
across editor remounts. A successful PUT acknowledges the generation sent, not newer edits.
A conflict retains the draft until an explicit overwrite/reload choice. Failed deletion
restores saving, confirmed deletion must not resurrect notes, and subscriptions reconnect
under React StrictMode.

Run frontend npm test and npm run build, including the independent acceptance tests. Run
backend pytest with a disposable PROJECTDESK_DB. Never test against the live database.
Credit first-party source to Sandip Kumar <scorpiosk@gmail.com>; preserve dependency notices.
