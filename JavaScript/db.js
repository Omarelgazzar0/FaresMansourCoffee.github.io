/* ═══════════════════════════════════════════════════════════════════════
   FAROS COFFEE POS — db.js
   Database Layer (sql.js / SQLite in the browser)

   This file handles ALL database interactions:
   ─────────────────────────────────────────────
   • Initializes an SQLite database using sql.js (pure-JS SQLite)
   • Persists the database to localStorage as Base64 so data survives
     page reloads without needing a server
   • Provides clean helper functions for every read/write operation
   • All SQL is here — no raw queries leak into app.js or catalog.js

   Tables:
   ───────
   catalog_items   — expandable product catalog (coffees, packages, ingredients)
   customers       — customer records (name, mobile, address)
   orders          — order header (invoice, date, totals, payment method)
   order_items     — line items per order (FK → orders, FK → catalog_items)

   Usage (from app.js):
   ─────────────────────
     await DB.init();          // must be called first on page load
     DB.getCatalog()           // returns all active catalog items
     DB.saveOrder(...)         // persists a full order + customer
     DB.getAllOrders()          // order history
     DB.getAllCustomers()       // customer list with aggregates
═══════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Namespace: everything lives on the DB object ────────────────────
const DB = (() => {

  /* ─────────────────────────────────────────────────────────────────
     PRIVATE: internal state
  ───────────────────────────────────────────────────────────────── */
  let _db = null; // the sql.js Database instance

  /* LocalStorage key where the DB binary is stored as Base64 */
  const STORAGE_KEY = 'faros_coffee_v2_db';


  /* ─────────────────────────────────────────────────────────────────
     PRIVATE: _persist()
     Serialise the in-memory SQLite database back to localStorage.
     Called after every write operation.
  ───────────────────────────────────────────────────────────────── */
  function _persist() {
    const data  = _db.export();                                    // Uint8Array
    const b64   = btoa(String.fromCharCode(...data));              // → Base64 string
    localStorage.setItem(STORAGE_KEY, b64);
  }


  /* ─────────────────────────────────────────────────────────────────
     PRIVATE: _exec(sql, params?)
     Thin wrapper around db.exec / db.run.
     Returns the result set array (may be empty for INSERTs etc.)
  ───────────────────────────────────────────────────────────────── */
  function _exec(sql, params = []) {
    return _db.exec(sql, params);
  }

  function _run(sql, params = []) {
    _db.run(sql, params);
  }

  function _lastId() {
    return _db.exec("SELECT last_insert_rowid()")[0].values[0][0];
  }


  /* ─────────────────────────────────────────────────────────────────
     PRIVATE: _createSchema()
     Create all tables if they don't yet exist.
     Uses IF NOT EXISTS so it's safe to call on every startup.
  ───────────────────────────────────────────────────────────────── */
  function _createSchema() {

    /* ── catalog_items ────────────────────────────────────────────
       The expandable product catalog.
       type: 'coffee' | 'package' | 'ingredient'
       unit: 'kg' | 'g' | 'piece' | 'pack'
       active: 1 = shown in POS, 0 = archived
    ──────────────────────────────────────────────────────────── */
    _db.run(`
      CREATE TABLE IF NOT EXISTS catalog_items (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name_ar     TEXT    NOT NULL,
        name_en     TEXT    NOT NULL,
        type        TEXT    NOT NULL DEFAULT 'coffee',
        price       REAL    NOT NULL DEFAULT 0,
        unit        TEXT    NOT NULL DEFAULT 'kg',
        active      INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT    DEFAULT (datetime('now'))
      );
    `);

    /* ── customers ────────────────────────────────────────────────
       One record per unique customer.
       Mobile is used as the deduplication key (upsert logic).
    ──────────────────────────────────────────────────────────── */
    _db.run(`
      CREATE TABLE IF NOT EXISTS customers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        mobile      TEXT,
        address     TEXT,
        created_at  TEXT    DEFAULT (datetime('now'))
      );
    `);

    /* ── orders ───────────────────────────────────────────────────
       One row per order transaction.
       customer_id → customers(id)
    ──────────────────────────────────────────────────────────── */
    _db.run(`
      CREATE TABLE IF NOT EXISTS orders (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id  INTEGER REFERENCES customers(id),
        invoice      TEXT    NOT NULL,
        date         TEXT    NOT NULL,
        payment      TEXT    NOT NULL DEFAULT 'Cash',
        notes        TEXT,
        subtotal     REAL    NOT NULL DEFAULT 0,
        tax_rate     REAL    NOT NULL DEFAULT 14,
        tax_amount   REAL    NOT NULL DEFAULT 0,
        total        REAL    NOT NULL DEFAULT 0,
        created_at   TEXT    DEFAULT (datetime('now'))
      );
    `);

    /* ── order_items ──────────────────────────────────────────────
       Line items — each coffee/package/ingredient in an order.
       order_id      → orders(id)
       catalog_id    → catalog_items(id)
    ──────────────────────────────────────────────────────────── */
    _db.run(`
      CREATE TABLE IF NOT EXISTS order_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id     INTEGER REFERENCES orders(id),
        catalog_id   INTEGER REFERENCES catalog_items(id),
        name_ar      TEXT    NOT NULL,
        name_en      TEXT    NOT NULL,
        price        REAL    NOT NULL,
        quantity     REAL    NOT NULL,
        unit         TEXT    NOT NULL,
        line_total   REAL    NOT NULL,
        created_at   TEXT    DEFAULT (datetime('now'))
      );
    `);
  }


  /* ─────────────────────────────────────────────────────────────────
     PRIVATE: _seedDefaultCatalog()
     Insert the original 4 coffees from the Faros receipt Excel file
     only on a brand-new (empty) database.
  ───────────────────────────────────────────────────────────────── */
  function _seedDefaultCatalog() {

    // Check if already seeded
    const existing = _db.exec("SELECT COUNT(*) FROM catalog_items")[0].values[0][0];
    if (existing > 0) return;

    /* Default coffee beans from Faros_COFFEE_Receipt_2.xlsx */
    const defaults = [
      { ar: 'حبشي هرهري',     en: 'Ethiopian Harari',   type: 'coffee',     price: 440, unit: 'kg' },
      { ar: 'برازيلي سانتوس', en: 'Brazilian Santos',   type: 'coffee',     price: 580, unit: 'kg' },
      { ar: 'إندونيسي',        en: 'Indonesian',         type: 'coffee',     price: 300, unit: 'kg' },
      { ar: 'هندي أرابيكا',    en: 'Indian Arabica',     type: 'coffee',     price: 700, unit: 'kg' },
      { ar: 'باكيت ٢٥٠ جم',    en: '250g Pack',          type: 'package',    price: 15,  unit: 'piece' },
      { ar: 'باكيت ٥٠٠ جم',    en: '500g Pack',          type: 'package',    price: 25,  unit: 'piece' },
      { ar: 'سكر',             en: 'Sugar',              type: 'ingredient', price: 30,  unit: 'kg' },
      { ar: 'هيل',             en: 'Cardamom',           type: 'ingredient', price: 250, unit: 'kg' },
    ];

    defaults.forEach(item => {
      _db.run(
        `INSERT INTO catalog_items (name_ar, name_en, type, price, unit)
         VALUES (?, ?, ?, ?, ?)`,
        [item.ar, item.en, item.type, item.price, item.unit]
      );
    });

    console.log('[DB] Seeded default catalog with', defaults.length, 'items.');
  }


  /* ═══════════════════════════════════════════════════════════════
     PUBLIC API
  ═══════════════════════════════════════════════════════════════ */
  return {

    /* ───────────────────────────────────────────────────────────────
       init()
       Load (or create) the database. Must be awaited before any
       other DB call. Called once from app.js on DOMContentLoaded.
    ─────────────────────────────────────────────────────────────── */
    async init() {
      // Load sql.js WASM binary from CDN
      const SQL = await initSqlJs({
        locateFile: file =>
          `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${file}`
      });

      // Restore existing database from localStorage, or create fresh
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const bytes = Uint8Array.from(atob(saved), c => c.charCodeAt(0));
        _db = new SQL.Database(bytes);
        console.log('[DB] Restored from localStorage.');
      } else {
        _db = new SQL.Database();
        console.log('[DB] Fresh database created.');
      }

      // Ensure schema exists (idempotent)
      _createSchema();

      // Seed default catalog on first run
      _seedDefaultCatalog();

      // Save initial state
      _persist();
    },


    /* ───────────────────────────────────────────────────────────────
       getCatalog(activeOnly?)
       Returns all catalog items. If activeOnly=true, filters to
       items with active=1 (used by the POS grid).
    ─────────────────────────────────────────────────────────────── */
    getCatalog(activeOnly = false) {
      const sql = activeOnly
        ? `SELECT * FROM catalog_items WHERE active = 1 ORDER BY type, id`
        : `SELECT * FROM catalog_items ORDER BY type, id`;

      const res = _exec(sql);
      if (!res.length) return [];

      const [cols, ...rows] = [res[0].columns, ...res[0].values];

      // Map each row array → plain object with column names as keys
      return rows.map(row =>
        Object.fromEntries(cols.map((col, i) => [col, row[i]]))
      );
    },


    /* ───────────────────────────────────────────────────────────────
       addCatalogItem(item)
       Insert a new item into catalog_items.
       Returns the new item's id.
    ─────────────────────────────────────────────────────────────── */
    addCatalogItem({ name_ar, name_en, type, price, unit }) {
      _run(
        `INSERT INTO catalog_items (name_ar, name_en, type, price, unit)
         VALUES (?, ?, ?, ?, ?)`,
        [name_ar, name_en, type, parseFloat(price), unit]
      );
      const id = _lastId();
      _persist();
      return id;
    },


    /* ───────────────────────────────────────────────────────────────
       toggleCatalogItem(id)
       Flip the active flag (archive / restore).
    ─────────────────────────────────────────────────────────────── */
    toggleCatalogItem(id) {
      _run(
        `UPDATE catalog_items SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE id = ?`,
        [id]
      );
      _persist();
    },


    /* ───────────────────────────────────────────────────────────────
       deleteCatalogItem(id)
       Hard delete — only safe if no order_items reference it.
       If referenced, archive instead (set active=0).
    ─────────────────────────────────────────────────────────────── */
    deleteCatalogItem(id) {
      // Check if item is used in any order
      const used = _exec(
        `SELECT COUNT(*) FROM order_items WHERE catalog_id = ?`, [id]
      )[0].values[0][0];

      if (used > 0) {
        // Archive instead of deleting to preserve order history
        _run(`UPDATE catalog_items SET active = 0 WHERE id = ?`, [id]);
      } else {
        _run(`DELETE FROM catalog_items WHERE id = ?`, [id]);
      }
      _persist();
    },


    /* ───────────────────────────────────────────────────────────────
       upsertCustomer({ name, mobile, address })
       If a customer with the same mobile already exists → update.
       Otherwise → insert.
       Returns the customer's id.
    ─────────────────────────────────────────────────────────────── */
    upsertCustomer({ name, mobile, address }) {
      // Try to find by mobile number first
      if (mobile && mobile.trim()) {
        const existing = _exec(
          `SELECT id FROM customers WHERE mobile = ? LIMIT 1`,
          [mobile.trim()]
        );
        if (existing.length && existing[0].values.length) {
          const existingId = existing[0].values[0][0];
          _run(
            `UPDATE customers SET name = ?, address = ? WHERE id = ?`,
            [name, address, existingId]
          );
          _persist();
          return existingId;
        }
      }

      // No match → insert new customer
      _run(
        `INSERT INTO customers (name, mobile, address) VALUES (?, ?, ?)`,
        [name, mobile || '', address || '']
      );
      const id = _lastId();
      _persist();
      return id;
    },


    /* ───────────────────────────────────────────────────────────────
       saveOrder({ customerId, cart, payment, notes, taxRate })
       Inserts one orders row + N order_items rows.
       Returns: { orderId, invoice }
    ─────────────────────────────────────────────────────────────── */
    saveOrder({ customerId, cart, payment, notes, taxRate }) {

      /* cart is an array of:
         { catalogId, nameAr, nameEn, price, quantity, unit } */

      // Calculate financial totals
      const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const taxAmount = subtotal * (taxRate / 100);
      const total     = subtotal + taxAmount;

      // Generate invoice number: FC- + timestamp suffix
      const invoice = 'FC-' + Date.now().toString().slice(-7);
      const date    = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

      // Insert orders header
      _run(
        `INSERT INTO orders
           (customer_id, invoice, date, payment, notes, subtotal, tax_rate, tax_amount, total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [customerId, invoice, date, payment, notes || '', subtotal, taxRate, taxAmount, total]
      );
      const orderId = _lastId();

      // Insert each line item
      cart.forEach(item => {
        _run(
          `INSERT INTO order_items
             (order_id, catalog_id, name_ar, name_en, price, quantity, unit, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            orderId,
            item.catalogId,
            item.nameAr,
            item.nameEn,
            item.price,
            item.quantity,
            item.unit,
            item.price * item.quantity
          ]
        );
      });

      _persist();
      return { orderId, invoice, subtotal, taxAmount, total, date };
    },


    /* ───────────────────────────────────────────────────────────────
       getAllCustomers()
       Returns customers joined with aggregate order stats.
    ─────────────────────────────────────────────────────────────── */
    getAllCustomers() {
      const res = _exec(`
        SELECT
          c.id,
          c.name,
          c.mobile,
          c.address,
          COUNT(o.id)            AS order_count,
          COALESCE(SUM(o.total), 0) AS total_spent,
          c.created_at
        FROM customers c
        LEFT JOIN orders o ON o.customer_id = c.id
        GROUP BY c.id
        ORDER BY c.id DESC
      `);
      if (!res.length) return [];
      const cols = res[0].columns;
      return res[0].values.map(row =>
        Object.fromEntries(cols.map((col, i) => [col, row[i]]))
      );
    },


    /* ───────────────────────────────────────────────────────────────
       getAllOrders()
       Returns all orders with customer name and total weight.
    ─────────────────────────────────────────────────────────────── */
    getAllOrders() {
      const res = _exec(`
        SELECT
          o.id,
          o.invoice,
          o.date,
          c.name         AS customer_name,
          o.payment,
          o.subtotal,
          o.tax_rate,
          o.tax_amount,
          o.total,
          o.notes,
          SUM(oi.quantity) AS total_weight
        FROM orders o
        JOIN customers   c  ON c.id = o.customer_id
        JOIN order_items oi ON oi.order_id = o.id
        GROUP BY o.id
        ORDER BY o.id DESC
      `);
      if (!res.length) return [];
      const cols = res[0].columns;
      return res[0].values.map(row =>
        Object.fromEntries(cols.map((col, i) => [col, row[i]]))
      );
    },


    /* ───────────────────────────────────────────────────────────────
       getOrderDetails(orderId)
       Returns full order + its items for re-printing a receipt.
    ─────────────────────────────────────────────────────────────── */
    getOrderDetails(orderId) {

      // Order header + customer info
      const orderRes = _exec(`
        SELECT
          o.*, c.name AS customer_name, c.mobile, c.address
        FROM orders o
        JOIN customers c ON c.id = o.customer_id
        WHERE o.id = ?
      `, [orderId]);

      if (!orderRes.length || !orderRes[0].values.length) return null;

      const cols  = orderRes[0].columns;
      const order = Object.fromEntries(cols.map((col, i) => [col, orderRes[0].values[0][i]]));

      // Line items
      const itemRes = _exec(
        `SELECT * FROM order_items WHERE order_id = ?`, [orderId]
      );

      order.items = [];
      if (itemRes.length) {
        const iCols = itemRes[0].columns;
        order.items = itemRes[0].values.map(row =>
          Object.fromEntries(iCols.map((col, i) => [col, row[i]]))
        );
      }

      return order;
    },


    /* ───────────────────────────────────────────────────────────────
       getStats()
       High-level aggregate numbers for dashboard stat cards.
    ─────────────────────────────────────────────────────────────── */
    getStats() {
      const r = _exec(`
        SELECT
          (SELECT COUNT(*) FROM orders)    AS total_orders,
          (SELECT COUNT(*) FROM customers) AS total_customers,
          (SELECT COALESCE(SUM(total), 0) FROM orders) AS total_revenue,
          (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE unit = 'kg') AS total_kg
      `);
      if (!r.length) return {};
      const cols = r[0].columns;
      return Object.fromEntries(cols.map((col, i) => [col, r[0].values[0][i]]));
    }

  }; // end return (public API)

})(); // end IIFE
