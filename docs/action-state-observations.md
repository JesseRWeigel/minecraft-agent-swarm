# Action state observation contract

Each captured action emits one `before_execution` observation and one `at_terminal` observation. The terminal snapshot is taken immediately before the terminal event is persisted. Both observation payload references appear in the terminal event's `observationRefs` and outcome evidence.

The payload source is `mineflayer_client_state`. It samples the bot's finite XYZ coordinates, independently available dimension, health, and aggregated inventory item counts. A real zero remains zero; unavailable or invalid scalar state is `null`. Inventory counts accept only nonnegative safe integers.

Inventory capture is bounded to 4,096 input entries and 128 aggregated item types. `entriesExamined`, `observedDistinctItemTypes`, and `observedTotalCount` describe only the observed portion. `truncated` and `totalCountComplete` prevent partial data from being read as a complete inventory. Invalid values, arithmetic overflow, or either cap mark the observation telemetry incomplete.

The event recorder supplies observer time through the observation event's `occurredAt` field and observer identity through `botId`; the payload points to those fields in `provenance`. Capture failures do not change control flow or action outcomes.

These observations are independent of executor result prose, but they are not an independent server oracle. They use the same process and client world view as the executor and are subject to client update and sampling timing. Before/terminal deltas alone do not establish mission success, item-transfer attribution, or recovery.
