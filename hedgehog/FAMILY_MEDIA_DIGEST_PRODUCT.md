# Family Media Digest

## Working concept

Family Media Digest is a private, local-first parental intelligence product that summarizes what a child consumed across short-form video and social apps, identifies emotional and safety signals selected by the family, and combines those signals with device, schedule, and location context.

The internal nickname may be `Brain Rot Report`. The customer-facing product should use a neutral name such as `Family Media Digest`, `Family Signal`, or `Digital Daybook`.

The product is not designed to give parents a raw surveillance console. Its primary output is a concise, useful explanation of:

- What content dominated the child's attention
- What themes, creators, communities, and narratives repeatedly appeared
- What conversations materially affected the child's mood or safety
- What changed relative to the child's normal baseline
- Which items match concerns configured by the parent or guardian
- What is probably harmless noise and should not trigger an intervention

## Primary outputs

### Daily digest

- Time spent by app
- Approximate number of videos/posts consumed
- Top themes and repeated topics
- Dominant creators, accounts, and communities
- New interests and abrupt shifts in content
- Mood and emotional-tone distribution
- Advertising, product, gambling, scam, or political persuasion exposure
- Notable social interactions
- Location and schedule context
- Parent-configured concern matches
- Suggested conversation starters

### Immediate alerts

Alerts are generated only for configured high-priority concerns and confidence thresholds, such as:

- Self-harm or suicide themes
- Eating-disorder or extreme body-image content
- Bullying, humiliation, or social exclusion
- Grooming or suspicious adult contact
- Sextortion or intimate-image pressure
- Drug sale, unsafe pharmacology, or overdose risk
- Threats or credible violence
- Acute panic, despair, or escalating anxiety
- Running away or school avoidance
- Scam, account takeover, or financial coercion
- Dangerous challenges
- Location anomalies combined with concerning communications

The family controls which categories are active, the sensitivity for each category, and whether the response is an immediate alert, daily summary item, or no report.

## Data sources

### On-device Android collector

The first viable implementation should be Android-first and designed for a parent-managed device.

Collect narrowly scoped data through:

- Android usage statistics for app duration and foreground activity
- Notification access for message and alert snippets that are already displayed to the child
- User-initiated or supervised social-account data exports
- Shared links, saved posts, and explicit "analyze this" actions
- Managed-device screen/content capture only when clearly disclosed and technically necessary
- Local extraction of visible captions, creator names, URLs, post IDs, and timestamps

Raw screen recordings should not be the default. The device agent should extract small structured observations and hashes, then discard frames as early as possible.

### TikTok

Use a layered approach:

1. TikTok watch-history and account-data exports for retrospective reconciliation
2. On-device capture of visible video metadata, captions, creator identity, hashtags, and timestamps for near-real-time summaries
3. TikTok Family Pairing as the existing control layer for time limits, restricted mode, privacy, direct-message settings, and notifications

Do not assume TikTok exposes a complete real-time parental watch-history API.

### Instagram and Meta apps

Use:

- Meta Family Center supervision data such as usage, interaction/account metadata, algorithm-interest categories, and platform-provided risk alerts
- Notification-visible DM content for partial conversation summaries
- Child-approved account exports for fuller retrospective summaries
- On-device managed capture only when the family explicitly enables full conversation digesting

The product must distinguish between:

- `FULL`: messages available through approved local capture or export
- `PARTIAL`: notification-visible message snippets only
- `METADATA_ONLY`: participants, timing, frequency, and platform risk signals

Never imply a complete conversation summary when only partial data was available.

### Google Family Link

Family Link is the family policy and device-control plane rather than the primary content feed.

Use it to support:

- Parent-approved installation and permissions
- App access and screen-time controls
- Device and account supervision
- Location and place notifications where available
- Third-party app access approvals
- Parent notification workflows

The Family Media Digest agent should complement Family Link instead of attempting to replace it.

### Life360

Use Life360 as an opt-in location and family-safety context source:

- Home, school, activity, and other saved-place arrivals/departures
- No-show events
- SOS and safety notifications
- Drive and travel context
- Location-sharing state

Initial integration may consume user-authorized Life360 notifications, shared links, and exported events. A formal partner or supported API integration should replace fragile notification parsing if available.

## Hedgehog processing pipeline

1. Child device produces encrypted structured observations.
2. The collector removes duplicate posts and content already analyzed.
3. Hedgehog retrieves or transcribes only the required public content.
4. Small local models classify topics, tone, entities, and risk indicators.
5. Larger local models summarize conversations and multi-item patterns.
6. A family-specific rules engine applies configured concerns and thresholds.
7. Independent local judges review high-severity alerts.
8. Frontier commercial models may sanity-check de-identified policy or legal questions, but raw child data remains on Hedgehog.
9. Parent receives a daily digest and only high-confidence urgent alerts.
10. Raw content expires according to the family's retention policy.

## Context fusion

Location and schedule data should reduce false positives rather than create more surveillance.

Examples:

- Distressing content at school during class may warrant a different summary than the same content during a planned mental-health research assignment.
- A late-night cluster of panic-themed content combined with insomnia and repeated messages may justify an alert.
- Drug content near a concert or party may be treated differently from a classroom pharmacology discussion.
- Sudden route deviation plus coercive or threatening messages may warrant immediate escalation.

The system must show the evidence behind an alert and the confidence level.

## Parent concern profile

Each family configures:

- Topics of concern
- People or accounts of concern
- Behavioral baselines
- Schedule and location expectations
- Alert sensitivity
- Quiet hours
- Which parent or guardian receives which alerts
- Raw-data retention
- Whether the child sees the same summary
- Emergency escalation rules

The model should not impose a universal moral or political standard. It reports against the family's lawful configuration while retaining hard safety boundaries.

## Child-facing experience

The child should have a visible dashboard showing:

- Which apps and data types are included
- Whether collection is active
- What categories can generate alerts
- What was included in the latest digest
- How to flag a false positive
- How to request deletion where appropriate
- Which adult receives the information

The preferred relationship is "the family installed a private safety analyst," not "there is invisible spyware on the phone."

## Retention and minimization

Default proposal:

- Raw screenshots/video frames: delete immediately after extraction or within hours
- Raw public-post cache: content-addressed and deduplicated, with short retention
- Message snippets: retain only long enough to produce and verify the summary unless the family explicitly selects longer retention
- Structured events: 30 days
- Daily summaries: family-selected retention
- High-severity evidence: retained only under an explicit incident policy

## Technical distribution strategy

A normal Play Store build may be constrained by sensitive-permission and accessibility policies. Support two editions:

1. `Family Media Digest Standard`: narrow permissions, Family Link integration, usage statistics, notifications, social exports, and voluntary sharing
2. `Family Media Digest Managed`: provisioned on a parent-managed Android device with broader disclosed collection and device-management controls

The managed edition must remain visible, documented, and locally auditable.

## Acceptance criteria

A successful first version must:

- Produce an accurate daily TikTok/Instagram topic digest from test accounts
- Label message summaries as full, partial, or metadata-only
- Support at least five configurable concern categories
- Use Life360 and/or Family Link events as context
- Demonstrate materially fewer false alerts when context is applied
- Keep raw child data off commercial frontier-model services
- Show all collection and retention settings in the child and parent interfaces
- Pass a false-positive review and deletion test
- Produce a complete audit record for every urgent alert
