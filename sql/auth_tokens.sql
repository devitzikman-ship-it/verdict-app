-- Durable store for signup 2FA codes, email-verification links, and
-- password-reset codes. Previously these lived only in server memory, so
-- every deploy/restart wiped pending signups & resets. Run once in the
-- Supabase SQL editor (Dashboard -> SQL Editor -> New query -> Run).

create table if not exists public.auth_tokens (
  token       text primary key,
  type        text,
  code        text,
  user_id     bigint,
  email       text,
  attempts    integer not null default 0,
  payload     jsonb,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists auth_tokens_expires_at_idx on public.auth_tokens (expires_at);
create index if not exists auth_tokens_user_type_idx   on public.auth_tokens (user_id, type);

-- Service role bypasses RLS, but enable it so the table is not exposed via the
-- public/anon API.
alter table public.auth_tokens enable row level security;
