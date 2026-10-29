-- DSH Ready — anonymous app launch statistics.
--
-- The website never reports page views: only the desktop app sends a launch
-- signal. Each row is a random device id, the UTC date, the app version and the
-- coarse geo Cloudflare derived from the request. No IP, no user agent, no
-- fingerprint, no cookies.
--
-- `d1_migrations` records migrations by file name, so the file name carries the
-- project prefix (`0001_ready_*`).

CREATE TABLE IF NOT EXISTS ready_launches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  date TEXT NOT NULL,
  version TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ready_launches_date ON ready_launches (date);
CREATE INDEX IF NOT EXISTS idx_ready_launches_device ON ready_launches (device_id);
CREATE INDEX IF NOT EXISTS idx_ready_launches_city ON ready_launches (city);
