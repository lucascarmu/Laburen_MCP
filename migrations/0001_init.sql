DROP TABLE IF EXISTS cart_items;
DROP TABLE IF EXISTS carts;
DROP TABLE IF EXISTS products;

-- products
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo_prenda TEXT NOT NULL,
  talla TEXT NOT NULL,
  color TEXT NOT NULL,
  cantidad_disponible INTEGER NOT NULL DEFAULT 0,
  precio_50_u_cents INTEGER NOT NULL,
  precio_100_u_cents INTEGER NOT NULL,
  precio_200_u_cents INTEGER NOT NULL,
  disponible INTEGER NOT NULL DEFAULT 1,
  categoria TEXT,
  descripcion TEXT
);

-- carts: uno por conversation_id
CREATE TABLE IF NOT EXISTS carts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- cart_items: guarda precio aplicado (para totals consistentes)
CREATE TABLE IF NOT EXISTS cart_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  UNIQUE(cart_id, product_id),
  FOREIGN KEY(cart_id) REFERENCES carts(id),
  FOREIGN KEY(product_id) REFERENCES products(id)
);