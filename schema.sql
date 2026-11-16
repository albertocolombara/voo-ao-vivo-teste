-- Uma linha por execução do cron (a cada 10 min)
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,            -- epoch ms
  metered_calls INTEGER NOT NULL, -- chamadas que contam na cota do adsb.lol
  route_calls INTEGER NOT NULL,   -- chamadas ao routeset (grátis)
  errors INTEGER NOT NULL,
  ms INTEGER NOT NULL             -- duração total
);

-- Uma linha por ponto consultado em cada execução
CREATE TABLE IF NOT EXISTS point_stats (
  run_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  point TEXT NOT NULL,
  status TEXT NOT NULL,           -- ok | quota (429) | error
  http INTEGER,
  ms INTEGER,
  seen INTEGER DEFAULT 0,         -- aeronaves retornadas
  airborne INTEGER DEFAULT 0,     -- no ar, com indicativo
  routed INTEGER DEFAULT 0,       -- com rota encontrada
  coherent INTEGER DEFAULT 0,     -- rota passou no filtro de coerência
  b25 INTEGER DEFAULT 0,          -- pousa em 25 a 49 min
  b50 INTEGER DEFAULT 0,          -- 50 a 89
  b90 INTEGER DEFAULT 0,          -- 90 a 179
  b180 INTEGER DEFAULT 0,         -- 180 a 359
  b360 INTEGER DEFAULT 0          -- 360 ou mais
);
CREATE INDEX IF NOT EXISTS idx_point_stats_ts ON point_stats(ts);

-- Última foto de cada ponto (é o que o app consumiria)
CREATE TABLE IF NOT EXISTS snapshot (
  point TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  json TEXT NOT NULL
);

-- Voos acompanhados até o pouso, para medir o erro da previsão
CREATE TABLE IF NOT EXISTS watch (
  hex TEXT NOT NULL,
  first_ts INTEGER NOT NULL,
  point TEXT NOT NULL,
  callsign TEXT,
  orig TEXT,
  dest TEXT,
  dest_lat REAL,
  dest_lon REAL,
  eta_min REAL,                   -- previsão no primeiro avistamento
  pred_land INTEGER,              -- epoch ms previsto para o pouso
  last_seen INTEGER,
  last_dist_km REAL,
  last_alt INTEGER,
  last_gs REAL,
  status TEXT NOT NULL,           -- active | landed | lost
  actual_land INTEGER,
  error_min REAL,                 -- real menos previsto (positivo = atrasou)
  PRIMARY KEY (hex, first_ts)
);
CREATE INDEX IF NOT EXISTS idx_watch_status ON watch(status);
