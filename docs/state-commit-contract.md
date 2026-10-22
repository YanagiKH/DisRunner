# State commit contract

`VirtualState` records every successful, outermost, synchronous mutation that changes resource data as one atomic commit. Each commit advances a monotonic revision and is delivered to in-process commit listeners after it is complete. This is an internal state observation API. It is not an event bus, it does not broadcast anything, and it does not publish to REST, Gateway, or UI observers by itself.

## API

- `state.revision` is the number of committed net data changes on this instance.
- `state.revisionedSnapshot()` returns `{ revision, snapshot }` read at the same moment. The `snapshot` has the same version 1 format and hash as `state.snapshot()`.
- `state.subscribeCommits(listener)` registers a listener and returns an unsubscribe function.
- `state.transactionActive` is `true` while a transaction callback on this instance is running.
- `VirtualStateOptions.maxCommitSubscribers` limits the number of subscriptions. The default is 100 and the value must be a positive safe integer.

A `StateCommit` has exactly these fields:

- `schemaVersion` is always `1`.
- `revision` is the revision after this commit, and `previousRevision` is always `revision - 1`.
- `operation` is `create`, `update`, `delete`, `transaction`, `undo`, `redo`, `restore`, `reset`, or `import`.
- `label` is the history label, such as `create:guild/100`, `restore-snapshot`, `reset`, or the transaction label.
- `atMs` is the virtual clock time when the commit was made.
- `diff` is the actual change from the state before the operation to the state after it, as a `StateDiff`.

## Revisions

- A new instance starts at revision 0, also when it is created with initial resources. Construction does not emit a commit.
- Each successful outermost operation with a net data change adds exactly 1. A nested transaction contributes only to the single commit of the outermost transaction.
- Failed operations and operations without a net data change do not change the revision and do not notify. Examples are `reset()` on an empty state, restoring or importing the current content, `undo()` or `redo()` with nothing to apply, and a transaction whose changes cancel out.
- `undo()` and `redo()` are commits too. They move the revision forward; the revision never goes back.
- An `undo()` or `redo()` whose result equals the current state still moves the history position and returns `true`, but it does not change the revision or notify.
- This revision belongs to one `VirtualState` instance only. It is unrelated to any other counter, such as a Gateway sequence number.

### History entries and commits are counted separately

History entries and commits are counted by different rules, so their numbers can differ. For example, `update()` with values equal to the current ones still records a history entry, but it changes no data, so it does not add a revision or notify. Undoing or redoing that entry returns `true`, again without a revision change or notification. In the other direction, a mutation too large for the history limit clears history as an undo barrier, but it is still a commit.

### Commit diffs

- For `create`, `update`, `delete`, `transaction`, `restore`, `reset`, and `import`, the commit diff equals the diff recorded in history.
- For `undo` and `redo`, the diff describes the resources actually present right before and right after the move, including `changedFields`. It can differ from the stored history entry, for example after an undo inside a transaction changed the resource the entry applies to. The history entry itself is not changed.
- The label of an `undo` or `redo` commit is the label of the history entry it applies. Its `atMs` is the time of the undo or redo, not the time of the original entry.

## Clones

`clone()` returns an independent instance with the same resources. The clone starts at revision 0 with empty history and `transactionActive` set to `false`. It keeps every configured limit of the original, including `maxCommitSubscribers`, but it does not inherit any subscriber: it starts with no subscriptions and its own full subscription quota. Commits on the clone are delivered only to listeners subscribed on the clone, and commits on the original only to listeners subscribed on the original.

## Atomicity

A failed operation leaves the instance exactly as it was: resources, byte accounting, history entries and their order, the history position, history bytes, and the revision. This includes transactions that fail after the history was already full, after undo created a redo branch, after an undo inside the transaction, and after whole-state replacement inside the transaction. Rejected input such as a duplicate ID, an unknown resource, a changed ID or resource type, a capacity limit, a snapshot with a wrong hash, duplicate resources or an unsupported version, and broken or oversized fixtures is rejected before any change. `undo()` and `redo()` check `maxResources` against the resulting state before any change and throw `StateCapacityError` if it would be exceeded.

The error thrown by a transaction callback is rethrown unchanged.

## Notifications

1. Listeners are called after the commit is complete and outside the transaction rollback path. A listener sees the new revision and the new state through any read method.
2. Listeners are called synchronously in subscription order. The list is fixed when notification starts: a listener subscribed during notification first receives the next commit, and a listener unsubscribed before its turn is not called.
3. Every listener receives its own deep copy of the commit. Changing it does not affect other listeners, history, or state.
4. An exception thrown by a listener is swallowed. It does not change the result of the operation, does not roll anything back, and does not stop the remaining listeners. Nothing is logged. A value returned by a listener is ignored, including a Promise.
5. Subscribing does not deliver an initial event.
6. Calling an unsubscribe function more than once is harmless and affects only its own subscription. Subscribing the same function twice creates two independent subscriptions that each count toward the limit.
7. A subscription beyond `maxCommitSubscribers` is rejected with `StateCapacityError` and is not registered. A listener that is not a function is rejected with `TypeError`.

### Reentrancy

While listeners run, reads and unsubscribing are allowed. Every mutating entry point (`create`, `update`, `delete`, `transaction`, `undo`, `redo`, `restore`, `reset`, and `importFixture`) is rejected with `StateConflictError` before it has any effect, so a listener can never start a recursive commit. Subscribing is allowed and takes effect from the next commit.

## Transaction activity

`transactionActive` lets a caller check, before mutating, whether it is running inside a transaction on the same instance. It is `true` inside every transaction callback, including nested ones and after an inner transaction has finished, and it returns to `false` when the outermost transaction ends, whether it succeeded, failed, or was rejected. It is `false` while commit listeners run, because a commit is only delivered after the transaction has ended. It is a read-only getter and reading it has no effect.

## Synchronous transactions only

Transaction callbacks must be synchronous. Asynchronous transactions are not supported and are not safe.

When a callback returns a value that could be a thenable, the transaction first rolls back everything the callback changed synchronously and then throws `TypeError`. No commit is made and no listener is called. The check never runs caller code: it calls no getter, no setter, no `then` method, and no Proxy trap, and it attaches no handler to the returned value.

The returned value is classified as follows:

1. `undefined`, `null`, and other primitives are returned normally.
2. Each object the `then` lookup visits, from the value itself up to and including the object where the lookup stops, is checked for being a Proxy before anything else is read from it. A Proxy on any visited object is rejected.
3. A native Promise, including the result of an `async` function, is rejected.
4. An own `then` property that is an accessor is rejected. An own data property `then` whose value is a function is rejected. An own data property `then` with any other value ends the check and the value is returned normally.
5. Otherwise the check continues with the next prototype. A chain that ends without a `then` property is returned normally.

### Limits of the synchronous return contract

- A Proxy on any object the `then` lookup visits, from the result itself up to and including the object where the lookup stops, is rejected even when the result is not a thenable. The lookup stops at the first object that owns a `then` data property whose value is not a function, so prototypes beyond that object are never visited.
- A `then` accessor is always rejected, whatever its getter would return, because the getter is never called.
- A `then` lookup that visits more than 64 objects is rejected. The limit applies only to the traversed prefix; objects beyond a shadowing non-callable data `then` property are not visited.
- A result that cannot be classified safely for any other reason is rejected.
- The transaction does not observe the settlement of a rejected Promise. If that Promise later rejects, handling the rejection is the caller's responsibility.
- Rejection cannot stop an `async` callback. Code after its first `await` runs after the transaction has ended, outside any transaction. Each mutation made there is an ordinary outermost operation with its own commit and revision, and it is not part of the rejected transaction. Late mutations are not detected.

## Revision limit

When the revision has reached `Number.MAX_SAFE_INTEGER`, every mutating entry point is rejected with `StateCapacityError` before any effect. This includes calls that would not change anything, such as `undo()` with nothing to undo, which then throws instead of returning `false`, and nested transactions, which are stopped at the outermost entry.

## Other limits

- Commits are in memory only. There is no replay, persistence, or cross-instance ordering.
- An `undo()` or `redo()` called inside a transaction moves the history position immediately. If the transaction fails, the position is restored with the rest of the history. If it succeeds without a net data change, no history entry is recorded and the moved position stays. If it succeeds with a net change, its entry replaces any redo entries after the moved position.
