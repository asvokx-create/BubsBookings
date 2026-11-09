-- Better Auth 1.7.0-1.7.2 wrote account.issuer. From 1.7.3 onward,
-- identity uses (providerId, accountId) again and issuer is no longer written.
-- Preserve every account and the legacy values; only remove obsolete constraints.
-- https://www.better-auth.com/docs/guides/1-7-upgrade-guide#account-identity-keeps-the-provider-key
DO $$
BEGIN
  -- Fail safely instead of waiting indefinitely for active authentication traffic.
  PERFORM set_config('lock_timeout', '5s', true);

  IF EXISTS (
    SELECT 1 FROM "account"
    GROUP BY "providerId", "accountId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Resolve duplicate account providerId/accountId keys before the Better Auth issuer migration';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'account'::regclass
      AND attname = 'issuer' AND NOT attisdropped AND attnotnull
  ) THEN
    ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;
  END IF;

  DROP INDEX IF EXISTS "account_issuer_accountId_uidx";
END $$;
