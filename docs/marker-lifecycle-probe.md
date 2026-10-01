# Marker lifecycle diagnostic probe

`MarkerLifecycleProbe` supplies bounded lifecycle evidence for the reversible
marker used by approval-bridge diagnostics. It is not connected to the normal
Gateway runtime and is disabled unless its caller explicitly sets `enabled:
true`.

## Guarantee boundaries

- **Snapshot:** At the synchronous start of `run()`, the probe copies
  `workerId`, `requestId`, `turnId`, `sessionId`, `probeId`, `receiptId`, and
  `directoryPath` into a deeply immutable object that it owns. Receipt checks,
  the consumer binding, directory selection, all filesystem work and cleanup,
  and audit-record generation use only that snapshot. Caller-owned input and
  binding objects are never frozen. Mutation or whole-object replacement after
  `run()` begins therefore cannot redirect the invocation or change its audit
  identity.
- **Receipt:** The probe validates and claims the snapshotted receipt before
  the first await, then gives the receipt consumer only the snapshotted binding.
  The broker atomically consumes one exact receipt for that binding. A mismatch,
  concurrent use, replay after success, or replay after failure reaches no
  filesystem operation, and a consumed receipt is never restored.
- **Cleanup:** Directory and marker capabilities remain pinned to the validated
  inode, owner, mode, link-count, size, and type identity observed before and
  after opening. Failure cleanup conditionally removes only the marker and
  parent identities created or opened by this invocation. A pathname race,
  replacement inode, symlink, non-empty parent, or cleanup failure cannot widen
  deletion to another object. Provider close failures, including synchronous
  throws, cannot prevent the remaining capabilities from being closed. Cleanup
  failure is fail-closed and emits no audit batch.
- **Audit and privacy:** The audit callback receives exactly one deeply
  immutable four-event batch only after marker and parent absence are verified.
  It receives no partial batch. Failures are rebuilt from the fixed
  `MarkerLifecycleProbeFailureCode` allowlist, so raw exception messages,
  caller values, paths, receipt IDs, marker data, and synthetic canaries are not
  exposed.

The caller must provide one opaque approval receipt and an approval-system
consumer that validates it against the exact worker, request, turn, session,
and non-secret probe ID used for the invocation. The probe does not trust a
caller-supplied decision. It claims the receipt before asking that consumer and
never restores it after success or failure. A missing or rejected receipt, a
binding mismatch, and a replay all stop before marker access.

`createMarkerLifecycleReceiptBroker()` returns separate process-local issuer
and consumer capabilities. The issuer belongs only to the handler that has
received the bound human decision; the probe receives only the consumer. The
broker stores the exact binding and
decision behind a random opaque receipt, consumes it atomically, and rejects a
mismatch or replay. The probe also keeps a process-local pre-await claim so
concurrent calls cannot race the broker. Receipts are intentionally not durable:
a replacement worker has a different worker binding and a fresh broker, so it
cannot accept an old receipt.

The configured temporary root and the requested probe directory must already
be canonical, absolute, non-symlink directories. The probe directory must be a
direct child of that root, owner-only, current-user-owned, and empty. A probe
caller must provide an openat-style filesystem capability; there is deliberately
no path-based default. The capability contract pins all child creation,
inspection, and deletion to open directory identities and requires conditional
deletion to reject an inode mismatch. A parent pathname swap therefore cannot
redirect marker I/O or cleanup to a symlink target.

The probe exclusively creates its fixed marker, keeps the file handle open, and
revalidates regular-file mode `0600`, size, link count, owner, and inode after
creation, after content inspection, and immediately before conditional removal.
It then verifies marker absence, verifies the parent is empty, conditionally
removes that same parent inode through the root handle, and verifies parent
absence. Path escape, any checked symlink, a non-empty directory, unexpected
identity/content/mode/link count, a partial cleanup, or an I/O failure is
fail-closed. The receipt remains consumed.

Only after both the marker and parent are confirmed absent does the probe pass
one complete, immutable batch containing these fixed events to the audit sink:

1. `marker_created`
2. `marker_inspected`
3. `marker_removed`
4. `parent_removed`

The audit sink must persist that callback atomically; the probe never calls it
with a partial lifecycle. Each record contains only `event`, `workerRef`, `requestRef`, `turnRef`,
`sessionRef`, and `probeRef`. All references are domain-separated hashes. Raw
paths, marker names or contents, receipt IDs, commands, and exception text are
never placed in the record or in failure messages.

The normal configuration has no instance of this probe. A diagnostic caller
must obtain its receipt from the already-bound approval interaction and use an
isolated temporary directory created for that one invocation. Do not infer a
receipt from a Slack message or mint one in the probe. Production data,
repository paths, and shared/non-empty temporary directories are out of scope.
