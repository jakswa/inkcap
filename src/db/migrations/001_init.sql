CREATE TABLE users (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  email_normalized text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
