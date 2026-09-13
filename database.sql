CREATE TABLE IF NOT EXISTS services(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'item',
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'Received',
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT,
  pickup_date TEXT,
  pickup_time TEXT,
  delivery_date TEXT,
  notes TEXT,
  payment_method TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  total NUMERIC(12,2) NOT NULL DEFAULT 0
);


-- Version 6 migration additions
ALTER TABLE orders ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS whatsapp_confirmation_clicked_at TIMESTAMPTZ;
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'Pending';
