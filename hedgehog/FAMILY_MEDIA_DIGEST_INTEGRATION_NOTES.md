# Family Media Digest Integration Notes

## Current platform reality

### Meta / Instagram

Meta supervision can expose time spent, recent interaction/account metadata, algorithm-interest categories, and platform-generated risk alerts. It does not provide parents with unrestricted access to message text. Therefore conversation summaries must be explicitly labeled as:

- FULL — authorized local capture or export
- PARTIAL — notification-visible snippets only
- METADATA_ONLY — participants, timing, frequency, and platform risk signals

### TikTok

TikTok account-data exports may include watch video history, comments, and privacy settings, but exports are asynchronous. Family Pairing provides safety and control settings, not a complete real-time parental watch-history feed. Near-real-time content summaries therefore require a disclosed on-device collector or explicit share/export workflow.

### Google Family Link

Family Link should be treated as the parent policy and permission layer. It supports app controls, permissions, notifications, location-related controls, and approval of third-party account access. The product should integrate operationally with Family Link rather than assume an unrestricted Family Link content API.

### Life360

Life360 is opt-in and supplies location-sharing, saved-place, no-show, SOS, drive, and safety notifications. Initial integration should consume user-authorized events, notifications, or shared links. A formal partner interface should replace notification parsing if one becomes available.

## Android data collection

- `UsageStatsManager` supplies aggregated device/app usage history, not content details.
- `NotificationListenerService` can receive posted/removed notifications and conversation notifications after the user grants access.
- `MediaProjection` can capture screen content only after a user-granted capture session and with visible system controls.
- Accessibility-based collection requires prominent disclosure, affirmative consent, minimum necessary data, and Play Console declarations; narrower APIs should be preferred.

## Product implication

The first release should be Android-first and support two modes:

1. Standard mode: app usage, notifications, exports, platform supervision data, and voluntary sharing.
2. Managed-device mode: broader but visible and disclosed local content extraction on a parent-managed device.

The system must never claim complete message or watch-history coverage when the underlying collection path is partial.
