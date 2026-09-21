-- Bike transfers: 4-sides photo record at each stage of moving a repossessed bike
-- to storage. Run once in the Supabase SQL editor (officer-tracker project).
create table if not exists bike_transfers (
  id bigint generated always as identity primary key,
  day date not null,
  stage text not null,                 -- 'field' (officer collects) | 'receiver' (received at HQ)
  actor_imei text,                     -- field officer imei (null for receiver)
  actor_name text not null,            -- who performed this stage
  customer_plate text,
  customer_name text,
  lat double precision,
  lng double precision,
  ts bigint not null,
  photo_front text,
  photo_back text,
  photo_left text,
  photo_right text,
  note text,
  created_at timestamptz default now()
);
create index if not exists bike_transfers_day on bike_transfers(day, stage);
