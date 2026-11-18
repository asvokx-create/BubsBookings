# Listing-active email formatting and verification

New listing email payloads opt into `stacked-actions-v1`: separate HTML table rows and explicit plain text with each label and destination on separate lines.

Existing frozen payloads without a render version retain the original HTML and no text part. Do not rewrite queued payloads, change their idempotency keys, or remove the versioned renderer during rollback while versioned retries exist. This protects the email provider's identical-body retry requirement.

Automatic delivery remains handled by the authenticated provider-welcome scheduled endpoint, which discovers newly public eligible listings. Existing public listings are baselined once; private/age-held/deleted listings do not qualify. Retry and deduplication controls are unchanged.

Validation uses synthetic recipients and mocked transport, with PGlite exercising the queue SQL. No external email was sent. Production scheduler configuration, actual mailbox delivery and client-specific visual rendering were not tested; a live test requires separate authorization. Source fixes do not resend historical messages or manually reset delivery state.
