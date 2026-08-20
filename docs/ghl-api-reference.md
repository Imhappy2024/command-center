# GoHighLevel API — verified reference

Every endpoint this codebase calls, checked against
[marketplace.gohighlevel.com/docs](https://marketplace.gohighlevel.com/docs/) on
**2026-08-21**. Written down because this integration lost three debugging rounds
to details that are not guessable and not consistent between endpoints.

Base: `https://services.leadconnectorhq.com`

## The failure mode that matters

**A wrong parameter name or Version header usually is not an error.** Several
endpoints answer `200` with an empty list instead, which is indistinguishable from
"this sub-account has no data". Every one of the following was diagnosed as
missing data before it was diagnosed as a wrong request:

| Symptom | Actual cause |
|---|---|
| No leads, ever | `/opportunities/search` sent `location_id`; it wants `locationId` |
| Empty conversation threads | conversations endpoints sent `2021-07-28`; they want `v3` |
| Sends silently did nothing | `/conversations/messages` missing required `status` |
| Value-only edits rejected | `PUT /opportunities/{id}` requires `pipelineId` **and** `pipelineStageId` on every call |

If data is missing, suspect the request before suspecting the account.

## Version header

Two API generations are live. `v3` is current; `2021-07-28` is previous. This is
per-endpoint and must not be assumed.

| Endpoint | Version | Basis |
|---|---|---|
| `GET /locations/{locationId}` | `v3` | documented |
| `GET /contacts/` | `2021-07-28` | **empirical** — see note |
| `PUT /contacts/{contactId}` | `v3` | documented |
| `GET /opportunities/pipelines` | `v3` | documented |
| `GET /opportunities/search` | `v3` | documented |
| `GET /opportunities/{id}` | `v3` | documented |
| `PUT /opportunities/{id}` | `v3` | documented |
| `GET /conversations/search` | `v3` | documented |
| `GET /conversations/{id}/messages` | `v3` | documented |
| `POST /conversations/messages` | `v3` | documented |
| `GET /phone-system/numbers/location/{locationId}` | `v3` | documented |

**The `/contacts/` exception.** Its reference page does not render, and search
results describe the endpoint as deprecated in favour of `POST /contacts/search`.
But the dated version is mirroring thousands of contacts in production, so it
stays until there is evidence to move it. If contact syncing ever returns zero
while other endpoints work, this is the first thing to change.

## Casing

**camelCase everywhere.** `locationId`, `pipelineId`, `contactId`,
`pipelineStageId`. No endpoint in this list takes snake_case, despite older
third-party docs showing `location_id` for `/opportunities/search`.

## Per-endpoint detail

### `GET /opportunities/search`
Required: `locationId`. Optional: `pipelineId`, `pipelineStageId`, `contactId`,
`status`, `q`, `assignedTo`, `startAfter`, `startAfterId`, `page`, `limit`
(default 20, max 100).
Response: `{ opportunities: [], total, aggregations }`. Pagination is either a
`meta` cursor or `page`/`limit` against `total`, depending on version — handle
both, and treat a short page as the end.

### `PUT /opportunities/{id}`
**`pipelineId` and `pipelineStageId` are required on every call**, including one
that only changes `monetaryValue`. Optional: `name`, `status`
(`open|won|lost|abandoned`), `monetaryValue`, `assignedTo`,
`forecastExpectedCloseDate`, `forecastProbability`, `customFields`.
Response: `{ opportunity: {...} }`.

### `POST /conversations/messages`
Required: `type` (`SMS|Email|WhatsApp|IG|FB|Custom|Live_Chat|InternalComment`),
`contactId`, **`status`** (`delivered|failed|pending|read`).
Optional: `message`, `html`, `subject`, `emailFrom`, `emailTo`, `fromNumber`,
`toNumber`, `conversationId`, `threadId`, `replyMessageId`, `attachments`,
`scheduledTimestamp`.
Response: `{ conversationId, messageId, emailMessageId?, msg? }` — ids only, not a
message object, so the caller composes its own mirror row.

**`fromNumber` / `emailFrom` are optional and are deliberately left unset here for
email.** GHL requires the From address to be a *verified sender* and exposes no
way to ask whether a given address qualifies, so forcing one fails hard whenever
the sub-account sends from a different verified domain. Numbers are different —
they can be enumerated, so naming one is safe.

### `GET /conversations/{conversationId}/messages`
Response nests twice: `{ messages: { messages: [], lastMessageId, nextPage } }`.
Message fields: `id`, `type`, `messageType` (`TYPE_SMS`, `TYPE_EMAIL`, …),
`direction` (`inbound`/`outbound`), `body`, `dateAdded`, `contactId`,
`conversationId`, `status`, `attachments`.

### `GET /phone-system/numbers/location/{locationId}`
Location is a **path** parameter. Optional: `pageSize` (default 50, max 1000),
`page`, `searchFilter`, `skipNumberPool` (default true).
Response: `{ numbers: [{ phoneNumber, friendlyName, countryCode }], total, page, pageSize }`.

### `GET /locations/{locationId}`
Response nests under `location`. Carries `email` — the sub-account's admin
address, which GHL treats as pre-verified for sending. There is **no endpoint
listing verified senders**, so this is the only sending address obtainable.

## Rate limits

Per location: **100 requests / 10 seconds**, **200,000 / day**. Headers:
`X-RateLimit-Max`, `X-RateLimit-Remaining`, `X-RateLimit-Limit-Daily`,
`X-RateLimit-Daily-Remaining`. `lib/ghl-limiter.js` paces against a local window
first and the headers second, and does not retry a 401.

## Scopes

```
contacts.readonly contacts.write
opportunities.readonly opportunities.write
conversations.readonly conversations.write
conversations/message.readonly conversations/message.write
locations.readonly users.readonly
```

Phone numbers additionally need the phone-system scope; without it
`syncSenders()` logs and continues rather than failing the sync.

## Webhooks

The Custom Webhook workflow action sends **no HMAC** — there is no signature to
verify, which is why `/webhooks/ghl` is unauthenticated and contained by the
`locationId` allow-list instead. Its payload is contact-shaped whatever the
trigger, so the event type comes from a field the workflow sets and opportunity
events must re-fetch by id rather than trusting the body.
