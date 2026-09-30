-- Motorcycle fleet garage schema. Money is integer cents; times are timestamptz; dates are date.

CREATE TABLE clients (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  contact_name       text NOT NULL DEFAULT '',
  email              text,
  phone              text NOT NULL DEFAULT '',
  address            text NOT NULL DEFAULT '',
  labour_rate_cents  integer CHECK (labour_rate_cents >= 0),
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX clients_name_key ON clients (lower(name));

CREATE TABLE users (
  id            text PRIMARY KEY,
  email         text NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'manager', 'technician', 'client')),
  client_id     text REFERENCES clients(id),
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- A client login always belongs to exactly one client; staff never do.
  CHECK ((role = 'client') = (client_id IS NOT NULL))
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Gapless job and invoice numbers, taken inside the transaction that uses them.
CREATE TABLE counters (
  name  text PRIMARY KEY,
  value bigint NOT NULL
);

CREATE TABLE bikes (
  id                    text PRIMARY KEY,
  client_id             text NOT NULL REFERENCES clients(id),
  plate                 text NOT NULL,
  vin                   text NOT NULL DEFAULT '',
  make                  text NOT NULL,
  model                 text NOT NULL,
  year                  integer NOT NULL,
  engine_cc             integer NOT NULL DEFAULT 0,
  odometer_km           integer NOT NULL CHECK (odometer_km >= 0),
  service_interval_km   integer NOT NULL CHECK (service_interval_km > 0),
  service_interval_days integer NOT NULL CHECK (service_interval_days > 0),
  last_service_km       integer NOT NULL CHECK (last_service_km >= 0),
  last_service_date     date NOT NULL,
  notes                 text NOT NULL DEFAULT '',
  retired               boolean NOT NULL DEFAULT false,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- A registration belongs to one bike in service at a time; retired bikes keep theirs for history.
CREATE UNIQUE INDEX bikes_plate_live_key ON bikes (plate) WHERE NOT retired;
CREATE INDEX bikes_client_idx ON bikes (client_id);

CREATE TABLE parts (
  id          text PRIMARY KEY,
  sku         text NOT NULL UNIQUE,
  name        text NOT NULL,
  unit        text NOT NULL CHECK (unit IN ('each', 'litre', 'metre')),
  stock_qty   numeric(12, 2) NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  min_qty     numeric(12, 2) NOT NULL DEFAULT 0,
  cost_cents  integer NOT NULL CHECK (cost_cents >= 0),
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  active      boolean NOT NULL DEFAULT true
);

CREATE TABLE invoices (
  id             text PRIMARY KEY,
  number         text NOT NULL UNIQUE,
  client_id      text NOT NULL REFERENCES clients(id),
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  due_date       date NOT NULL,
  tax_percent    numeric(5, 2) NOT NULL,
  subtotal_cents integer NOT NULL,
  tax_cents      integer NOT NULL,
  total_cents    integer NOT NULL,
  status         text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'paid', 'void')),
  issued_by      text REFERENCES users(id),
  CHECK (total_cents = subtotal_cents + tax_cents)
);

CREATE TABLE jobs (
  id             text PRIMARY KEY,
  number         text NOT NULL UNIQUE,
  bike_id        text NOT NULL REFERENCES bikes(id),
  client_id      text NOT NULL REFERENCES clients(id),
  kind           text NOT NULL CHECK (kind IN ('service', 'inspection', 'repair', 'defect')),
  priority       text NOT NULL CHECK (priority IN ('low', 'normal', 'urgent')),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'scheduled', 'in_progress', 'waiting_parts', 'done', 'cancelled')),
  title          text NOT NULL,
  description    text NOT NULL DEFAULT '',
  source         text NOT NULL DEFAULT 'workshop' CHECK (source IN ('workshop', 'client')),
  off_road       boolean NOT NULL DEFAULT false,
  off_road_since timestamptz,
  scheduled_for  date,
  assigned_to    text REFERENCES users(id),
  reported_by    text REFERENCES users(id),
  odometer_km    integer,
  checklist      jsonb NOT NULL DEFAULT '[]',
  summary        text NOT NULL DEFAULT '',
  follow_up_of   text REFERENCES jobs(id),
  invoice_id     text REFERENCES invoices(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  completed_at   timestamptz,
  version        integer NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'done') = (completed_at IS NOT NULL)),
  CHECK (invoice_id IS NULL OR status = 'done'),
  CHECK (NOT off_road OR off_road_since IS NOT NULL)
);
CREATE INDEX jobs_bike_idx ON jobs (bike_id, created_at DESC);
CREATE INDEX jobs_open_idx ON jobs (status) WHERE status IN ('open', 'scheduled', 'in_progress', 'waiting_parts');
CREATE INDEX jobs_client_done_idx ON jobs (client_id, completed_at) WHERE status = 'done';
CREATE INDEX jobs_assigned_idx ON jobs (assigned_to) WHERE status IN ('open', 'scheduled', 'in_progress', 'waiting_parts');

-- When a bike could not be ridden, for availability reporting. One open interval per job at most.
CREATE TABLE bike_downtime (
  id         bigserial PRIMARY KEY,
  bike_id    text NOT NULL REFERENCES bikes(id),
  job_id     text NOT NULL REFERENCES jobs(id),
  started_at timestamptz NOT NULL,
  ended_at   timestamptz,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX bike_downtime_one_open ON bike_downtime (job_id) WHERE ended_at IS NULL;
CREATE INDEX bike_downtime_bike_idx ON bike_downtime (bike_id, started_at);

CREATE TABLE job_labour (
  id            text PRIMARY KEY,
  job_id        text NOT NULL REFERENCES jobs(id),
  technician_id text NOT NULL REFERENCES users(id),
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  CHECK (ended_at IS NULL OR ended_at > started_at)
);
-- A technician can only have one clock running.
CREATE UNIQUE INDEX job_labour_one_running ON job_labour (technician_id) WHERE ended_at IS NULL;
CREATE INDEX job_labour_job_idx ON job_labour (job_id);

CREATE TABLE job_parts (
  id               text PRIMARY KEY,
  job_id           text NOT NULL REFERENCES jobs(id),
  part_id          text NOT NULL REFERENCES parts(id),
  qty              numeric(12, 2) NOT NULL CHECK (qty > 0),
  unit_cost_cents  integer NOT NULL,
  unit_price_cents integer NOT NULL,
  added_by         text REFERENCES users(id),
  added_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_parts_job_idx ON job_parts (job_id);

CREATE TABLE stock_moves (
  id      bigserial PRIMARY KEY,
  part_id text NOT NULL REFERENCES parts(id),
  qty     numeric(12, 2) NOT NULL,
  reason  text NOT NULL CHECK (reason IN ('delivery', 'adjustment', 'return', 'job', 'job_removed')),
  job_id  text REFERENCES jobs(id),
  user_id text REFERENCES users(id),
  note    text NOT NULL DEFAULT '',
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_moves_part_idx ON stock_moves (part_id, at DESC);

CREATE TABLE job_notes (
  id      text PRIMARY KEY,
  job_id  text NOT NULL REFERENCES jobs(id),
  user_id text REFERENCES users(id),
  text    text NOT NULL,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_notes_job_idx ON job_notes (job_id, at);

CREATE TABLE job_photos (
  id       text PRIMARY KEY,
  job_id   text NOT NULL REFERENCES jobs(id),
  name     text NOT NULL,
  mime     text NOT NULL,
  size     integer NOT NULL,
  bytes    bytea NOT NULL,
  added_by text REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_photos_job_idx ON job_photos (job_id);

CREATE TABLE invoice_lines (
  id           bigserial PRIMARY KEY,
  invoice_id   text NOT NULL REFERENCES invoices(id),
  job_id       text REFERENCES jobs(id),
  description  text NOT NULL,
  qty          numeric(12, 4) NOT NULL,
  unit_cents   integer NOT NULL,
  amount_cents integer NOT NULL,
  is_labour    boolean NOT NULL DEFAULT false
);
CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (invoice_id);

-- Operations from the technician app. A phone that lost signal replays its queue; the op id makes
-- each operation apply once however many times it arrives.
CREATE TABLE processed_ops (
  op_id   uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  result  jsonb NOT NULL,
  at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  user_id   text REFERENCES users(id) ON DELETE SET NULL,
  action    text NOT NULL,
  entity    text NOT NULL,
  entity_id text,
  details   jsonb NOT NULL DEFAULT '{}',
  ip        text
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
