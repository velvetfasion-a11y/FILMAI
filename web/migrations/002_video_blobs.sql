alter table jobs add column if not exists has_video boolean not null default false;

create table if not exists video_blobs (
  job_id text primary key references jobs(id) on delete cascade,
  content_type text not null default 'video/mp4',
  bytes bytea not null,
  byte_size integer not null default 0,
  created_at timestamptz not null default now()
);
