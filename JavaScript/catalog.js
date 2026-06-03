/* ═══════════════════════════════════════════════════════════════════════
   FAROS COFFEE POS — catalog.js
   Catalog Manager & POS Grid Builder

   Responsibilities:
   ─────────────────
   • Holds the current in-memory catalog (refreshed from DB.getCatalog)
   • Renders the interactive product grid on the POS screen
   • Manages the cart state: { catalogId → quantity }
   • Provides cart read functions consumed by app.js

   Cart design:
   ────────────
   The cart is a Map:  catalogId (number) → quantity (number, in item's unit)
   Quantities for 'kg' items are adjusted in 0.025 kg steps (25g)
   Quantities for 'piece'/'pack' items are adjusted in steps of 1

   Public API (used by app.js):
   ─────────────────────────────
   Catalog.load()              — reload catalog from DB, re-render grid
   Catalog.getCartItems()      — returns array of cart line objects
   Catalog.getCartTotals()     — { subtotal, totalWeight, itemCount }
   Catalog.clearCart()         — reset all quantities
   Catalog.buildCatalogTable() — render the Catalog page management table
═══════════════════════════════════════════════════════════════════════ */

'use strict';

const Catalog = (() => {

  /* ─────────────────────────────────────────────────────────────────
     PRIVATE STATE
  ───────────────────────────────────────────────────────────────── */

  /** All active catalog items (loaded from DB) */
  let _items = [];

  /**
   * Cart: Map from catalogId (number) → quantity (number)
   * Quantities in item's own unit (kg for coffees, pieces for packages)
   */
  const _cart = new Map();

  /** Step sizes per unit */
  const STEP = {
    kg:    0.025,  // 25 grams
    g:     25,     // 25 grams
    piece: 1,
    pack:  1,
  };

  /** Human-readable type labels for table display */
  const TYPE_LABEL = {
    coffee:     '☕ Coffee',
    package:    '📦 Package',
    ingredient: '🧂 Ingredient',
  };

  /** CSS badge class per type */
  const TYPE_BADGE = {
    coffee:     'badge-amber',
    package:    'badge-teal',
    ingredient: 'badge-violet',
  };


  /* ─────────────────────────────────────────────────────────────────
     PRIVATE: _renderGrid()
     Build the product card grid inside #catalogGrid (POS page).
     Called whenever the catalog or cart changes.
  ───────────────────────────────────────────────────────────────── */
  function _renderGrid() {
    const container = document.getElementById('catalogGrid');
    if (!container) return;

    if (_items.length === 0) {
      container.innerHTML = `
        <p class="muted" style="grid-column:1/-1;text-align:center;padding:2rem;font-size:.85rem">
          No active items in catalog.<br/>
          <small>Go to the Catalog tab to add items.</small>
        </p>`;
      return;
    }

    container.innerHTML = _items.map(item => _buildCard(item)).join('');
  }


  /* ─────────────────────────────────────────────────────────────────
     PRIVATE: _buildCard(item)
     Returns the HTML string for a single product card.
  ───────────────────────────────────────────────────────────────── */
  function _buildCard(item) {
    const qty      = _cart.get(item.id) || 0;
    const selected = qty > 0;
    const step     = STEP[item.unit] ?? 1;

    // Format the displayed quantity based on unit
    let qtyDisplay = '—';
    if (qty > 0) {
      if (item.unit === 'kg') {
        qtyDisplay = qty.toFixed(3) + ' kg';
      } else if (item.unit === 'g') {
        qtyDisplay = qty + ' g';
      } else {
        qtyDisplay = qty + ' ' + item.unit;
      }
    }

    return `
      <div class="catalog-card ${selected ? 'selected' : ''}"
           id="card-${item.id}"
           data-id="${item.id}"
           data-type="${item.type}">

        <!-- Type label chip -->
        <div class="card-type-badge">${TYPE_LABEL[item.type] ?? item.type}</div>

        <!-- Arabic name (RTL) -->
        <div class="card-name-ar rtl">${item.name_ar}</div>

        <!-- English name -->
        <div class="card-name-en">${item.name_en}</div>

        <!-- Price display -->
        <div class="card-price">
          <span>EGP ${item.price.toLocaleString('en-EG')}</span>
          <span class="price-unit">/ ${item.unit}</span>
        </div>

        <!-- Quantity adjuster -->
        <div class="qty-row">
          <span class="qty-label">Qty (${item.unit})</span>
          <div class="qty-controls">
            <button class="qty-btn"
                    onclick="Catalog._adjust(${item.id}, -${step})"
                    title="Remove ${step} ${item.unit}">−</button>

            <span class="qty-display" id="qty-${item.id}">${qtyDisplay}</span>

            <button class="qty-btn"
                    onclick="Catalog._adjust(${item.id}, ${step})"
                    title="Add ${step} ${item.unit}">+</button>
          </div>
        </div>
      </div>
    `;
  }

  /* ─────────────────────────────────────────────────────────────────
     PRIVATE: _refreshCard(itemId)
     Lightweight update of just one card's qty display + selected
     state, without re-rendering the whole grid.
  ───────────────────────────────────────────────────────────────── */
  function _refreshCard(itemId) {
    const item = _items.find(i => i.id === itemId);
    if (!item) return;

    const qty    = _cart.get(itemId) || 0;
    const qtyEl  = document.getElementById('qty-' + itemId);
    const cardEl = document.getElementById('card-' + itemId);

    if (qtyEl) {
      if (qty <= 0) {
        qtyEl.textContent = '—';
      } else if (item.unit === 'kg') {
        qtyEl.textContent = qty.toFixed(3) + ' kg';
      } else if (item.unit === 'g') {
        qtyEl.textContent = qty + ' g';
      } else {
        qtyEl.textContent = qty + ' ' + item.unit;
      }
    }

    if (cardEl) {
      cardEl.classList.toggle('selected', qty > 0);
    }
  }


  /* ═══════════════════════════════════════════════════════════════
     PUBLIC API
  ═══════════════════════════════════════════════════════════════ */
  return {

    /* ───────────────────────────────────────────────────────────────
       _adjust(itemId, delta)
       PUBLIC (but prefixed _ to signal internal use only — called
       from inline onclick handlers in the generated HTML).
       Adjusts the quantity for a cart item and triggers a UI refresh.
    ─────────────────────────────────────────────────────────────── */
    _adjust(itemId, delta) {
      const current = _cart.get(itemId) || 0;

      // Round to avoid floating-point drift
      const next = Math.round((current + delta) * 10000) / 10000;

      if (next <= 0) {
        _cart.delete(itemId); // remove from cart if qty reaches zero
      } else {
        _cart.set(itemId, next);
      }

      // Refresh this card's display
      _refreshCard(itemId);

      // Notify app.js to update the cart panel
      if (typeof App !== 'undefined') App.onCartChange();
    },


    /* ───────────────────────────────────────────────────────────────
       load()
       Pull fresh catalog from DB and re-render the POS grid.
       Call this on startup and after catalog edits.
    ─────────────────────────────────────────────────────────────── */
    load() {
      _items = DB.getCatalog(true); // activeOnly = true for POS
      _renderGrid();
    },


    /* ───────────────────────────────────────────────────────────────
       clearCart()
       Empties the cart Map and refreshes the grid.
    ─────────────────────────────────────────────────────────────── */
    clearCart() {
      _cart.clear();
      _renderGrid(); // rebuild so all cards lose 'selected' class
    },


    /* ───────────────────────────────────────────────────────────────
       getCartItems()
       Returns an array of enriched cart line objects ready for
       DB.saveOrder() and the cart panel renderer.

       Each element: {
         catalogId, nameAr, nameEn, price, quantity, unit, lineTotal
       }
    ─────────────────────────────────────────────────────────────── */
    getCartItems() {
      const lines = [];
      _cart.forEach((qty, itemId) => {
        const item = _items.find(i => i.id === itemId);
        if (!item) return; // item may have been deleted — skip
        lines.push({
          catalogId: item.id,
          nameAr:    item.name_ar,
          nameEn:    item.name_en,
          price:     item.price,
          quantity:  qty,
          unit:      item.unit,
          lineTotal: item.price * qty,
        });
      });
      return lines;
    },


    /* ───────────────────────────────────────────────────────────────
       getCartTotals(taxRate)
       Computes aggregate cart values.
       Returns: { subtotal, taxAmount, grandTotal, totalKg, itemCount }
    ─────────────────────────────────────────────────────────────── */
    getCartTotals(taxRate = 14) {
      const lines    = this.getCartItems();
      const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
      const taxAmount = subtotal * (taxRate / 100);

      // Total weight: only sum kg-unit items
      const totalKg = lines
        .filter(l => l.unit === 'kg')
        .reduce((s, l) => s + l.quantity, 0);

      return {
        subtotal,
        taxAmount,
        grandTotal: subtotal + taxAmount,
        totalKg,
        itemCount: lines.length,
      };
    },


    /* ───────────────────────────────────────────────────────────────
       buildCatalogTable()
       Render the management table on the Catalog admin page.
       Shows ALL items (active + archived) with toggle/delete buttons.
    ─────────────────────────────────────────────────────────────── */
    buildCatalogTable() {
      const allItems = DB.getCatalog(false); // false = include inactive
      const tbody    = document.getElementById('catalogTableBody');
      if (!tbody) return;

      if (allItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="table-empty">No items in catalog</td></tr>`;
        return;
      }

      tbody.innerHTML = allItems.map(item => `
        <tr style="${item.active ? '' : 'opacity:0.45'}">

          <!-- ID -->
          <td><span class="badge badge-amber">${item.id}</span></td>

          <!-- Arabic name -->
          <td class="rtl mono">${item.name_ar}</td>

          <!-- English name -->
          <td>${item.name_en}</td>

          <!-- Type badge -->
          <td>
            <span class="badge ${TYPE_BADGE[item.type] ?? 'badge-sky'}">
              ${TYPE_LABEL[item.type] ?? item.type}
            </span>
          </td>

          <!-- Price -->
          <td class="mono">EGP ${item.price.toLocaleString('en-EG')}</td>

          <!-- Unit -->
          <td class="mono">${item.unit}</td>

          <!-- Active status -->
          <td>
            <span class="badge ${item.active ? 'badge-teal' : 'badge-coral'}">
              ${item.active ? 'Active' : 'Archived'}
            </span>
          </td>

          <!-- Action buttons -->
          <td style="display:flex;gap:.35rem;flex-wrap:wrap">
            <button class="btn btn-teal btn-sm"
                    onclick="Catalog._onToggle(${item.id})">
              ${item.active ? 'Archive' : 'Restore'}
            </button>
            <button class="btn btn-danger"
                    onclick="Catalog._onDelete(${item.id})">
              Delete
            </button>
          </td>
        </tr>
      `).join('');
    },


    /* ───────────────────────────────────────────────────────────────
       _onToggle(id)  — called from inline onclick in catalog table
    ─────────────────────────────────────────────────────────────── */
    _onToggle(id) {
      DB.toggleCatalogItem(id);
      this.buildCatalogTable();
      this.load(); // refresh POS grid too
      if (typeof App !== 'undefined') App.toast('Item updated');
    },


    /* ───────────────────────────────────────────────────────────────
       _onDelete(id)  — called from inline onclick in catalog table
    ─────────────────────────────────────────────────────────────── */
    _onDelete(id) {
      if (!confirm('Delete this item? If it has been ordered before, it will be archived instead.')) return;
      DB.deleteCatalogItem(id);
      this.buildCatalogTable();
      this.load();
      if (typeof App !== 'undefined') App.toast('Item removed');
    },

  }; // end public API

})(); // end IIFE
