-- Public artifact sharing. A non-NULL public_shared_at makes the artifact
-- world-readable at its normal /artifacts/:id URL until public_share_expires_at
-- passes. NULL expires_at means shared forever.

ALTER TABLE artifacts
  ADD COLUMN public_shared_at timestamptz,
  ADD COLUMN public_share_expires_at timestamptz;

CREATE INDEX artifacts_public_live_idx
  ON artifacts (id, public_share_expires_at)
  WHERE public_shared_at IS NOT NULL;
