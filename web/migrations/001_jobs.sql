create table if not exists jobs (
  id text primary key,
  owner text not null default '',
  prompt text not null,
  status text not null,
  progress double precision not null default 0,
  message text not null default '',
  video_url text,
  prediction_id text,
  aspect text not null default '16:9',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_created_at_idx on jobs (created_at desc);
create index if not exists jobs_owner_idx on jobs (owner);
