ALTER TABLE zx_admins ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE zx_admins ADD COLUMN IF NOT EXISTS appointed_by text;
ALTER TABLE zx_admins ADD COLUMN IF NOT EXISTS expires_at timestamptz;
