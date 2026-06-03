/* ═══════════════════════════════════════════════════════════════════════
   FAROS COFFEE POS — app.js
   Main Application Controller

   Responsibilities:
   ─────────────────
   • Page routing (nav tab switching)
   • All DOM event listeners (buttons, inputs)
   • Cart panel rendering (right column on POS page)
   • Order saving flow (validate → DB.saveOrder → receipt modal)
   • Customer receipt rendering (name, address, mobile, weight, total ONLY)
   • Customers & Orders page data loading
   • Toast notification system
   • Startup sequence (await DB.init → Catalog.load → wire events)

   Receipt spec (per user request):
   ─────────────────────────────────
   The printed customer receipt shows ONLY:
     ✓ Customer name
     ✓ Customer address
     ✓ Customer mobile
     ✓ Total weight
     ✓ Grand total (with tax)
   It does NOT show individual item names, prices, or breakdown.
═══════════════════════════════════════════════════════════════════════ */

'use strict';

/* ──────────────────────────────────────────────────────────────────────
   App namespace
   All functions are either on the App object (callable from HTML attrs)
   or local private functions within this IIFE.
────────────────────────────────────────────────────────────────────── */
const App = (() => {

  /* ─────────────────────────────────────────────────────────────────
     PRIVATE STATE
  ───────────────────────────────────────────────────────────────── */

  /** Currently selected payment method */
  let _payMethod = 'Cash';

  /** Toast auto-hide timer */
  let _toastTimer = null;

  /** Running invoice counter (preview only — real invoice set on save) */
  let _invoicePreview = 'FC-' + Date.now().toString().slice(-7);


  /* ═══════════════════════════════════════════════════════════════
     SECTION 1: PAGE ROUTING
  ═══════════════════════════════════════════════════════════════ */

  /* ─────────────────────────────────────────────────────────────────
     _showPage(pageName)
     Hide all .page divs and show only #page-{pageName}.
     Also updates the nav button active state and loads data
     for pages that need it (customers, orders, catalog).
  ───────────────────────────────────────────────────────────────── */
  function _showPage(pageName) {
    // Hide all pages
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

    // Show target page
    const target = document.getElementById('page-' + pageName);
    if (target) target.classList.add('active');

    // Update nav button highlight
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.page === pageName);
    });

    // Trigger data loading for each page
    if (pageName === 'customers') _loadCustomersPage();
    if (pageName === 'orders')    _loadOrdersPage();
    if (pageName === 'catalog')   Catalog.buildCatalogTable();
  }


  /* ═══════════════════════════════════════════════════════════════
     SECTION 2: CART PANEL RENDERER
  ═══════════════════════════════════════════════════════════════ */

  /* ─────────────────────────────────────────────────────────────────
     _renderCart()
     Rebuilds the right-column order cart using current cart state.
     Shows the empty state when no items are selected.
  ───────────────────────────────────────────────────────────────── */
  function _renderCart() {
    const lines   = Catalog.getCartItems();
    const taxRate = parseFloat(document.getElementById('taxRate')?.value) || 14;
    const totals  = Catalog.getCartTotals(taxRate);

    const cartItemsEl  = document.getElementById('cartItems');
    const cartTotalsEl = document.getElementById('cartTotals');

    /* ── Empty state ── */
    if (lines.length === 0) {
      cartItemsEl.innerHTML = `
        <div class="cart-empty" id="cartEmpty">
          <div class="empty-icon">☕</div>
          <p>No items selected</p>
          <small>Choose coffee from the grid</small>
        </div>`;
      if (cartTotalsEl) cartTotalsEl.style.display = 'none';
      return;
    }

    /* ── Item list ── */
    if (cartTotalsEl) cartTotalsEl.style.display = '';

    cartItemsEl.innerHTML = lines.map(line => `
      <div class="cart-line">

        <!-- Item info -->
        <div class="cl-info">
          <div class="cl-name">${line.nameAr}</div>
          <div class="cl-detail mono">
            ${_fmtQty(line.quantity, line.unit)} × EGP ${line.price.toLocaleString('en-EG')} / ${line.unit}
          </div>
        </div>

        <!-- Line total -->
        <div class="cl-price">EGP ${line.lineTotal.toFixed(2)}</div>

        <!-- Remove button -->
        <button class="cl-remove"
                onclick="App._removeCartItem(${line.catalogId})"
                title="Remove item">✕</button>
      </div>
    `).join('');

    /* ── Update totals display ── */
    _setText('totalWeight',  totals.totalKg.toFixed(3) + ' kg');
    _setText('subtotalVal',  'EGP ' + totals.subtotal.toFixed(2));
    _setText('taxVal',       'EGP ' + totals.taxAmount.toFixed(2));
    _setText('grandVal',     'EGP ' + totals.grandTotal.toFixed(2));
    _setText('taxPctDisplay', taxRate);
  }


  /* ─────────────────────────────────────────────────────────────────
     _fmtQty(qty, unit)
     Format a quantity for display in the cart detail line.
  ───────────────────────────────────────────────────────────────── */
  function _fmtQty(qty, unit) {
    if (unit === 'kg') return qty.toFixed(3) + ' kg';
    if (unit === 'g')  return qty + ' g';
    return qty + ' ' + unit;
  }


  /* ═══════════════════════════════════════════════════════════════
     SECTION 3: ORDER SAVING
  ═══════════════════════════════════════════════════════════════ */

  /* ─────────────────────────────────────────────────────────────────
     _saveOrder()
     Validates form → upserts customer → saves order to DB →
     shows the customer receipt modal.
  ───────────────────────────────────────────────────────────────── */
  function _saveOrder() {
    /* ── Validation ── */
    const name   = document.getElementById('custName')?.value.trim();
    const mobile = document.getElementById('custMobile')?.value.trim();
    const addr   = document.getElementById('custAddr')?.value.trim();
    const notes  = document.getElementById('orderNotes')?.value.trim();
    const taxRate = parseFloat(document.getElementById('taxRate')?.value) || 14;

    if (!name) {
      toast('Please enter customer name', 'error');
      document.getElementById('custName')?.focus();
      return;
    }

    const lines = Catalog.getCartItems();
    if (lines.length === 0) {
      toast('Add at least one item to the order', 'error');
      return;
    }

    /* ── Upsert customer (dedup by mobile) ── */
    const customerId = DB.upsertCustomer({ name, mobile, address: addr });

    /* ── Save order ── */
    const result = DB.saveOrder({
      customerId,
      cart:     lines,
      payment:  _payMethod,
      notes,
      taxRate,
    });

    /* ── Success feedback ── */
    toast('✓ Order saved — ' + result.invoice);

    /* ── Show customer receipt modal ── */
    _showReceipt({
      invoice:     result.invoice,
      date:        result.date,
      custName:    name,
      mobile:      mobile,
      address:     addr,
      taxRate,
      subtotal:    result.subtotal,
      taxAmount:   result.taxAmount,
      grandTotal:  result.total,
      totalKg:     Catalog.getCartTotals(taxRate).totalKg,
      payment:     _payMethod,
    });

    /* ── Reset form for next order ── */
    _clearOrder(false); // false = don't show toast (already showed above)

    /* ── Refresh invoice preview for next order ── */
    _invoicePreview = 'FC-' + Date.now().toString().slice(-7);
    _setText('invoiceBadge', _invoicePreview);
  }


  /* ─────────────────────────────────────────────────────────────────
     _clearOrder(showToast)
     Resets the cart and form fields.
  ───────────────────────────────────────────────────────────────── */
  function _clearOrder(showToast = true) {
    Catalog.clearCart();
    _renderCart();

    // Clear customer fields
    ['custName', 'custMobile', 'custAddr', 'orderNotes'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });

    if (showToast) toast('Order cleared');
  }


  /* ═══════════════════════════════════════════════════════════════
     SECTION 4: CUSTOMER RECEIPT MODAL
     Shows ONLY: Name, Address, Mobile, Weight, Total
     No item breakdown (per spec)
  ═══════════════════════════════════════════════════════════════ */

  /* ─────────────────────────────────────────────────────────────────
     _showReceipt(data)
     Builds and shows the printable customer receipt.
     Intentionally minimal — customer only needs to know
     who it's for and what they owe.
  ───────────────────────────────────────────────────────────────── */
  function _showReceipt(data) {
    const {
      invoice, date, custName, mobile, address,
      taxRate, subtotal, taxAmount, grandTotal, totalKg, payment
    } = data;

    const content = document.getElementById('receiptContent');
    if (!content) return;

    content.innerHTML = `

      <!-- ── Brand Header ── -->
      <div class="rp-brand">
        <h2>Faros Coffee</h2>
        <div class="tagline">rise &amp; grind</div>
      </div>

      <hr class="rp-divider"/>

      <!-- ── Invoice & Date ── -->
      <div class="rp-info">
        <span class="rk">Invoice</span>
        <span class="rv mono">${invoice}</span>

        <span class="rk">Date</span>
        <span class="rv">${_formatDate(date)}</span>

        <span class="rk">Payment</span>
        <span class="rv">${payment}</span>
      </div>

      <hr class="rp-divider"/>

      <!-- ── Customer Details ── -->
      <div class="rp-info">
        <span class="rk">Name</span>
        <span class="rv">${custName}</span>

        ${mobile ? `
          <span class="rk">Mobile</span>
          <span class="rv mono">${mobile}</span>
        ` : ''}

        ${address ? `
          <span class="rk">Address</span>
          <span class="rv">${address.replace(/\n/g, '<br/>')}</span>
        ` : ''}
      </div>

      <hr class="rp-divider"/>

      <!-- ── Order Summary (NO item breakdown — customer receipt spec) ── -->
      <div class="rp-summary">

        <div class="rp-summary-row">
          <span class="sk">Total Weight</span>
          <span class="sv mono">${totalKg.toFixed(3)} kg</span>
        </div>

        <div class="rp-summary-row">
          <span class="sk">Subtotal</span>
          <span class="sv mono">EGP ${subtotal.toFixed(2)}</span>
        </div>

        <div class="rp-summary-row">
          <span class="sk">Tax (${taxRate}%)</span>
          <span class="sv mono">EGP ${taxAmount.toFixed(2)}</span>
        </div>

        <!-- Grand total — prominent -->
        <div class="rp-summary-row final">
          <span class="sk">TOTAL DUE</span>
          <span class="sv mono">EGP ${grandTotal.toFixed(2)}</span>
        </div>

      </div>

      <!-- ── Footer ── -->
      <div class="rp-footer">
        ☕ Thank you for choosing Faros Coffee ☕<br/>
        Rise &amp; Grind — Every Cup Counts
      </div>
    `;

    // Open the modal
    document.getElementById('receiptOverlay')?.classList.add('open');
  }


  /* ─────────────────────────────────────────────────────────────────
     _closeModal()
     Hides the receipt modal overlay.
  ───────────────────────────────────────────────────────────────── */
  function _closeModal() {
    document.getElementById('receiptOverlay')?.classList.remove('open');
  }


  /* ─────────────────────────────────────────────────────────────────
     _showOrderReceipt(orderId)
     Re-display the receipt for a past order (from Orders page).
  ───────────────────────────────────────────────────────────────── */
  function _showOrderReceipt(orderId) {
    const order = DB.getOrderDetails(orderId);
    if (!order) { toast('Order not found', 'error'); return; }

    const totalKg = order.items
      .filter(i => i.unit === 'kg')
      .reduce((s, i) => s + i.quantity, 0);

    _showReceipt({
      invoice:    order.invoice,
      date:       order.date,
      custName:   order.customer_name,
      mobile:     order.mobile,
      address:    order.address,
      taxRate:    order.tax_rate,
      subtotal:   order.subtotal,
      taxAmount:  order.tax_amount,
      grandTotal: order.total,
      totalKg,
      payment:    order.payment,
    });
  }


  /* ═══════════════════════════════════════════════════════════════
     SECTION 5: CUSTOMERS PAGE
  ═══════════════════════════════════════════════════════════════ */

  /* ─────────────────────────────────────────────────────────────────
     _loadCustomersPage()
     Populates the stats row and customer table on the Customers page.
  ───────────────────────────────────────────────────────────────── */
  function _loadCustomersPage() {
    const customers = DB.getAllCustomers();

    /* ── Stats cards ── */
    const totalSpent = customers.reduce((s, c) => s + c.total_spent, 0);
    const avgSpend   = customers.length ? totalSpent / customers.length : 0;

    document.getElementById('customerStats').innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${customers.length}</div>
        <div class="stat-label">Total Customers</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">EGP ${Math.round(totalSpent).toLocaleString('en-EG')}</div>
        <div class="stat-label">Total Revenue</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">EGP ${Math.round(avgSpend).toLocaleString('en-EG')}</div>
        <div class="stat-label">Avg. per Customer</div>
      </div>
    `;

    /* ── Customer table ── */
    const tbody = document.getElementById('customerTableBody');

    if (customers.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty">No customers yet</td></tr>`;
      return;
    }

    tbody.innerHTML = customers.map(c => `
      <tr>
        <td><span class="badge badge-amber">${c.id}</span></td>
        <td>${_esc(c.name)}</td>
        <td class="mono">${c.mobile || '—'}</td>
        <td class="muted" style="font-size:.8rem">${_esc(c.address || '—')}</td>
        <td><span class="badge badge-teal">${c.order_count}</span></td>
        <td class="mono" style="color:var(--amber-lt)">
          EGP ${c.total_spent.toFixed(2)}
        </td>
        <td class="mono muted" style="font-size:.75rem">
          ${_formatDate(c.created_at?.split('T')[0])}
        </td>
      </tr>
    `).join('');
  }


  /* ═══════════════════════════════════════════════════════════════
     SECTION 6: ORDERS PAGE
  ═══════════════════════════════════════════════════════════════ */

  /* ─────────────────────────────────────────────────────────────────
     _loadOrdersPage()
     Populates the stats row and orders table on the Orders page.
  ───────────────────────────────────────────────────────────────── */
  function _loadOrdersPage() {
    const orders = DB.getAllOrders();

    /* ── Stats cards ── */
    const totalRevenue = orders.reduce((s, o) => s + o.total, 0);
    const totalKg      = orders.reduce((s, o) => s + (o.total_weight || 0), 0);

    document.getElementById('orderStats').innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${orders.length}</div>
        <div class="stat-label">Total Orders</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">EGP ${Math.round(totalRevenue).toLocaleString('en-EG')}</div>
        <div class="stat-label">Total Revenue</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${totalKg.toFixed(2)} kg</div>
        <div class="stat-label">Coffee Sold</div>
      </div>
    `;

    /* ── Orders table ── */
    const tbody = document.getElementById('orderTableBody');

    if (orders.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty">No orders yet</td></tr>`;
      return;
    }

    tbody.innerHTML = orders.map(o => `
      <tr>
        <td><span class="badge badge-amber">${o.invoice}</span></td>
        <td class="muted">${_formatDate(o.date)}</td>
        <td>${_esc(o.customer_name)}</td>
        <td class="mono">${(o.total_weight || 0).toFixed(3)} kg</td>
        <td class="mono" style="color:var(--amber-lt)">EGP ${o.total.toFixed(2)}</td>
        <td><span class="badge badge-sky">${o.payment}</span></td>
        <td>
          <button class="btn btn-teal btn-sm"
                  onclick="App._viewOrderReceipt(${o.id})">
            Receipt
          </button>
        </td>
      </tr>
    `).join('');
  }


  /* ═══════════════════════════════════════════════════════════════
     SECTION 7: CATALOG PAGE (Add Item)
  ═══════════════════════════════════════════════════════════════ */

  /* ─────────────────────────────────────────────────────────────────
     _addCatalogItem()
     Reads the "Add New Item" form and inserts into DB.
  ───────────────────────────────────────────────────────────────── */
  function _addCatalogItem() {
    const name_ar = document.getElementById('newItemNameAr')?.value.trim();
    const name_en = document.getElementById('newItemNameEn')?.value.trim();
    const type    = document.getElementById('newItemType')?.value;
    const price   = parseFloat(document.getElementById('newItemPrice')?.value);
    const unit    = document.getElementById('newItemUnit')?.value;

    /* ── Validation ── */
    if (!name_ar) { toast('Arabic name is required', 'error'); return; }
    if (!name_en) { toast('English name is required', 'error'); return; }
    if (isNaN(price) || price < 0) { toast('Enter a valid price', 'error'); return; }

    DB.addCatalogItem({ name_ar, name_en, type, price, unit });

    /* ── Clear form ── */
    ['newItemNameAr','newItemNameEn','newItemPrice'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });

    /* ── Refresh both views ── */
    Catalog.buildCatalogTable();
    Catalog.load(); // update POS grid too

    toast('✓ Item added to catalog');
  }


  /* ═══════════════════════════════════════════════════════════════
     SECTION 8: TOAST NOTIFICATIONS
  ═══════════════════════════════════════════════════════════════ */

  /* ─────────────────────────────────────────────────────────────────
     toast(message, type?)
     Shows a brief toast notification.
     type: 'success' (default) | 'error'
  ───────────────────────────────────────────────────────────────── */
  function toast(message, type = 'success') {
    const el = document.getElementById('toastEl');
    if (!el) return;

    // Clear any existing timer
    if (_toastTimer) clearTimeout(_toastTimer);

    el.textContent = message;
    el.className   = `visible toast-${type}`;

    // Auto-hide after 2.5 seconds
    _toastTimer = setTimeout(() => {
      el.className = '';
    }, 2500);
  }


  /* ═══════════════════════════════════════════════════════════════
     SECTION 9: UTILITY HELPERS
  ═══════════════════════════════════════════════════════════════ */

  /**
   * _setText(id, value)  — sets the textContent of an element by id
   */
  function _setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  /**
   * _esc(str) — basic HTML escape to prevent XSS in table output
   */
  function _esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * _formatDate(isoDate)  — e.g. "2026-03-12" → "12 Mar 2026"
   */
  function _formatDate(isoDate) {
    if (!isoDate) return '—';
    const d = new Date(isoDate);
    if (isNaN(d)) return isoDate;
    return d.toLocaleDateString('en-EG', { day: '2-digit', month: 'short', year: 'numeric' });
  }


  /* ═══════════════════════════════════════════════════════════════
     SECTION 10: EVENT WIRING
  ═══════════════════════════════════════════════════════════════ */

  /* ─────────────────────────────────────────────────────────────────
     _wireEvents()
     Attaches all DOM event listeners. Called once after DB.init().
  ───────────────────────────────────────────────────────────────── */
  function _wireEvents() {

    /* ── Navigation tabs ── */
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => _showPage(btn.dataset.page));
    });

    /* ── Payment method pills ── */
    document.querySelectorAll('.pill').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        _payMethod = pill.dataset.val;
      });
    });

    /* ── Tax rate live update ── */
    document.getElementById('taxRate')?.addEventListener('input', () => {
      _renderCart();
    });

    /* ── Save order button ── */
    document.getElementById('btnSaveOrder')?.addEventListener('click', _saveOrder);

    /* ── Clear order button ── */
    document.getElementById('btnClearOrder')?.addEventListener('click', () => _clearOrder(true));

    /* ── Modal close buttons ── */
    document.getElementById('btnCloseModal')?.addEventListener('click',  _closeModal);
    document.getElementById('btnCloseModal2')?.addEventListener('click', _closeModal);

    /* ── Close modal by clicking the overlay background ── */
    document.getElementById('receiptOverlay')?.addEventListener('click', e => {
      if (e.target === e.currentTarget) _closeModal();
    });

    /* ── Add catalog item button ── */
    document.getElementById('btnAddItem')?.addEventListener('click', _addCatalogItem);

    /* ── Allow Enter key in catalog price field ── */
    document.getElementById('newItemPrice')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') _addCatalogItem();
    });
  }


  /* ═══════════════════════════════════════════════════════════════
     SECTION 11: STARTUP SEQUENCE
  ═══════════════════════════════════════════════════════════════ */

  /* ─────────────────────────────────────────────────────────────────
     _init()
     Entry point. Runs on DOMContentLoaded.
     1. Init DB (async — loads sql.js WASM)
     2. Load catalog into POS grid
     3. Wire all events
     4. Set dynamic header content
  ───────────────────────────────────────────────────────────────── */
  async function _init() {
    try {
      // 1. Initialize SQLite database
      await DB.init();
      console.log('[App] Database ready.');

      // 2. Build catalog grid on POS page
      Catalog.load();
      console.log('[App] Catalog loaded.');

      // 3. Attach all event listeners
      _wireEvents();
      console.log('[App] Events wired.');

      // 4. Set today's date in cart header
      const dateEl = document.getElementById('cartDate');
      if (dateEl) {
        dateEl.textContent = new Date().toLocaleDateString('en-EG', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        });
      }

      // 5. Set initial invoice preview badge
      _setText('invoiceBadge', _invoicePreview);

    } catch (err) {
      console.error('[App] Startup failed:', err);
      alert('⚠️ Failed to initialize database. Please reload the page.\n\n' + err.message);
    }
  }


  /* ═══════════════════════════════════════════════════════════════
     PUBLIC API  (exposed on App object)
  ═══════════════════════════════════════════════════════════════ */
  return {

    /**
     * Called by Catalog._adjust() whenever cart quantities change.
     * Triggers cart panel re-render.
     */
    onCartChange() {
      _renderCart();
    },

    /**
     * Called by Catalog inline buttons (toggle/delete via _onToggle/_onDelete)
     */
    toast,

    /**
     * Called from Orders page table "Receipt" button
     */
    _viewOrderReceipt(orderId) {
      _showOrderReceipt(orderId);
    },

    /**
     * Remove a cart item by catalog ID (called from cart panel)
     */
    _removeCartItem(catalogId) {
      // Force the quantity to 0 by adjusting down by a large number
      // Catalog._adjust handles clamping to 0
      Catalog._adjust(catalogId, -999999);
    },

  };

})(); // end App IIFE


/* ──────────────────────────────────────────────────────────────────────
   BOOT
   Wait for the HTML to be fully parsed before initializing.
────────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  // Access the private _init via a small indirection —
  // since _init is private we trigger it through a module-level call.
  // (Re-expose it temporarily for boot only.)
  await App._boot?.() ?? void 0;
});

// Make _boot accessible just for the DOMContentLoaded handler above
// by attaching it before the IIFE closes — but since IIFEs close before
// the event fires, we use a simpler pattern: call init directly.
(async () => {
  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', async () => {
      await _appInit();
    });
  } else {
    await _appInit();
  }

  async function _appInit() {
    try {
      await DB.init();
      console.log('[App] Database ready.');
      Catalog.load();
      console.log('[App] Catalog loaded.');
      _wireAllEvents();
      _setHeaderDate();
    } catch (err) {
      console.error('[App] Startup error:', err);
      alert('⚠️ Could not start Faros Coffee POS.\n\n' + err.message);
    }
  }

  /* ── All event listeners ── */
  function _wireAllEvents() {

    /* ── Desktop/tablet top navigation ── */
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => _navigateTo(btn.dataset.page));
    });

    /* ── Mobile bottom navigation bar ── */
    document.querySelectorAll('.bottom-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => _navigateTo(btn.dataset.page));
    });

    /* ── Payment pills ── */
    document.querySelectorAll('.pill').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
      });
    });

    /* ── Tax rate change → update cart totals ── */
    document.getElementById('taxRate')?.addEventListener('input', updateCartDisplay);

    /* ── POS buttons ── */
    document.getElementById('btnSaveOrder')?.addEventListener('click', handleSaveOrder);
    document.getElementById('btnClearOrder')?.addEventListener('click', () => handleClearOrder(true));

    /* ── Modal close ── */
    document.getElementById('btnCloseModal')?.addEventListener('click',  closeReceiptModal);
    document.getElementById('btnCloseModal2')?.addEventListener('click', closeReceiptModal);
    document.getElementById('receiptOverlay')?.addEventListener('click', e => {
      if (e.target === e.currentTarget) closeReceiptModal();
    });

    /* ── Catalog add form ── */
    document.getElementById('btnAddItem')?.addEventListener('click', handleAddCatalogItem);

    /* ── Mobile cart FAB — opens/closes the cart drawer ── */
    document.getElementById('cartFab')?.addEventListener('click', toggleCartDrawer);

    /* ── Close cart drawer when tapping the overlay behind it ── */
    document.getElementById('page-pos')?.addEventListener('click', e => {
      if (e.target.classList.contains('cart-drawer-overlay')) {
        closeCartDrawer();
      }
    });

    /* ── Swipe down on cart drawer to close it ── */
    _wireCartDrawerSwipe();
  }

  /* ─────────────────────────────────────────────────────────────────
     Cart drawer helpers (mobile)
  ───────────────────────────────────────────────────────────────── */

  /** Opens the cart slide-up drawer on mobile */
  function openCartDrawer() {
    document.getElementById('page-pos')?.classList.add('cart-open');
    // Inject overlay element if not present
    const posEl = document.getElementById('page-pos');
    if (posEl && !posEl.querySelector('.cart-drawer-overlay')) {
      const overlay = document.createElement('div');
      overlay.className = 'cart-drawer-overlay';
      overlay.addEventListener('click', closeCartDrawer);
      posEl.appendChild(overlay);
    }
  }

  /** Closes the cart drawer */
  function closeCartDrawer() {
    document.getElementById('page-pos')?.classList.remove('cart-open');
  }

  /** Toggles the cart drawer open/closed */
  function toggleCartDrawer() {
    const posEl = document.getElementById('page-pos');
    if (posEl?.classList.contains('cart-open')) {
      closeCartDrawer();
    } else {
      openCartDrawer();
    }
  }

  /**
   * Swipe-down gesture to close the cart drawer.
   * Uses touch events: track vertical delta, close if swiped down > 80px.
   */
  function _wireCartDrawerSwipe() {
    const cartPanel = document.querySelector('.pos-right');
    if (!cartPanel) return;

    let startY = 0;
    let isDragging = false;

    cartPanel.addEventListener('touchstart', e => {
      startY      = e.touches[0].clientY;
      isDragging  = true;
    }, { passive: true });

    cartPanel.addEventListener('touchmove', e => {
      if (!isDragging) return;
      const delta = e.touches[0].clientY - startY;
      // Only apply drag-down visual when near the top of the drawer
      if (delta > 0 && cartPanel.scrollTop === 0) {
        cartPanel.style.transform = `translateY(${Math.min(delta * 0.4, 60)}px)`;
      }
    }, { passive: true });

    cartPanel.addEventListener('touchend', e => {
      if (!isDragging) return;
      isDragging = false;
      const delta = e.changedTouches[0].clientY - startY;
      cartPanel.style.transform = ''; // reset transform

      // If dragged down more than 80px — close the drawer
      if (delta > 80) {
        closeCartDrawer();
      }
    });
  }

  /* ── Page navigation ── */
  function _navigateTo(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-' + page)?.classList.add('active');

    // Sync both top nav buttons and bottom nav buttons
    document.querySelectorAll('.nav-btn, .bottom-nav-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.page === page)
    );

    // Close cart drawer when navigating away from POS
    if (page !== 'pos') closeCartDrawer();

    if (page === 'customers') renderCustomersPage();
    if (page === 'orders')    renderOrdersPage();
    if (page === 'catalog')   Catalog.buildCatalogTable();
  }

  /* ── Header date ── */
  function _setHeaderDate() {
    const el = document.getElementById('cartDate');
    if (el) {
      el.textContent = new Date().toLocaleDateString('en-EG', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });
    }
    const badge = document.getElementById('invoiceBadge');
    if (badge) badge.textContent = 'FC-' + Date.now().toString().slice(-7);
  }

  /* ── Cart display update (called on tax change) ── */
  function updateCartDisplay() {
    App.onCartChange();
  }

  /* ── Save order handler ── */
  function handleSaveOrder() {
    const name    = document.getElementById('custName')?.value.trim();
    const mobile  = document.getElementById('custMobile')?.value.trim();
    const addr    = document.getElementById('custAddr')?.value.trim();
    const notes   = document.getElementById('orderNotes')?.value.trim();
    const taxRate = parseFloat(document.getElementById('taxRate')?.value) || 14;

    if (!name) {
      App.toast('Enter customer name', 'error');
      document.getElementById('custName')?.focus();
      return;
    }

    const lines = Catalog.getCartItems();
    if (lines.length === 0) {
      App.toast('Select at least one item', 'error');
      return;
    }

    /* Get selected payment method */
    const activePill = document.querySelector('.pill.active');
    const payment    = activePill?.dataset.val || 'Cash';

    /* Upsert customer */
    const customerId = DB.upsertCustomer({ name, mobile, address: addr });

    /* Save order */
    const result = DB.saveOrder({ customerId, cart: lines, payment, notes, taxRate });

    App.toast('✓ Order saved — ' + result.invoice);

    /* Show customer receipt */
    showCustomerReceipt({
      invoice:    result.invoice,
      date:       result.date,
      custName:   name,
      mobile,
      address:    addr,
      taxRate,
      subtotal:   result.subtotal,
      taxAmount:  result.taxAmount,
      grandTotal: result.total,
      totalKg:    Catalog.getCartTotals(taxRate).totalKg,
      payment,
    });

    /* Close cart drawer on mobile (receipt modal is now showing) */
    closeCartDrawer();

    handleClearOrder(false);
  }

  /* ── Clear order ── */
  function handleClearOrder(notify) {
    Catalog.clearCart();
    App.onCartChange();
    ['custName','custMobile','custAddr','orderNotes'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    if (notify) App.toast('Order cleared');
  }

  /* ── Build & show customer receipt modal ──
     ONLY shows: Name, Address, Mobile, Weight, Total
     No item breakdown.
  ── */
  function showCustomerReceipt({ invoice, date, custName, mobile, address, taxRate, subtotal, taxAmount, grandTotal, totalKg, payment }) {
    document.getElementById('receiptContent').innerHTML = `
      <div class="rp-brand">
        <h2>Faros Coffee</h2>
        <div class="tagline">rise &amp; grind</div>
      </div>
      <hr class="rp-divider"/>
      <div class="rp-info">
        <span class="rk">Invoice</span>  <span class="rv mono">${invoice}</span>
        <span class="rk">Date</span>     <span class="rv">${fmtDate(date)}</span>
        <span class="rk">Payment</span>  <span class="rv">${payment}</span>
      </div>
      <hr class="rp-divider"/>
      <div class="rp-info">
        <span class="rk">Customer</span> <span class="rv">${esc(custName)}</span>
        ${mobile  ? `<span class="rk">Mobile</span>  <span class="rv mono">${esc(mobile)}</span>`  : ''}
        ${address ? `<span class="rk">Address</span> <span class="rv">${esc(address).replace(/\n/g,'<br/>')}</span>` : ''}
      </div>
      <hr class="rp-divider"/>
      <div class="rp-summary">
        <div class="rp-summary-row">
          <span class="sk">Total Weight</span>
          <span class="sv mono">${totalKg.toFixed(3)} kg</span>
        </div>
        <div class="rp-summary-row">
          <span class="sk">Subtotal</span>
          <span class="sv mono">EGP ${subtotal.toFixed(2)}</span>
        </div>
        <div class="rp-summary-row">
          <span class="sk">Tax (${taxRate}%)</span>
          <span class="sv mono">EGP ${taxAmount.toFixed(2)}</span>
        </div>
        <div class="rp-summary-row final">
          <span class="sk">TOTAL DUE</span>
          <span class="sv mono">EGP ${grandTotal.toFixed(2)}</span>
        </div>
      </div>
      <div class="rp-footer">
        ☕ Thank you for choosing Faros Coffee ☕<br/>
        Rise &amp; Grind — Every Cup Counts
      </div>
    `;
    document.getElementById('receiptOverlay')?.classList.add('open');
  }

  /* Re-show a past order's receipt */
  App._viewOrderReceipt = function(orderId) {
    const o = DB.getOrderDetails(orderId);
    if (!o) { App.toast('Order not found', 'error'); return; }
    const totalKg = o.items.filter(i => i.unit === 'kg').reduce((s,i) => s + i.quantity, 0);
    showCustomerReceipt({
      invoice:    o.invoice,
      date:       o.date,
      custName:   o.customer_name,
      mobile:     o.mobile,
      address:    o.address,
      taxRate:    o.tax_rate,
      subtotal:   o.subtotal,
      taxAmount:  o.tax_amount,
      grandTotal: o.total,
      totalKg,
      payment:    o.payment,
    });
  };

  /* Close modal */
  function closeReceiptModal() {
    document.getElementById('receiptOverlay')?.classList.remove('open');
  }

  /* ── Add catalog item ── */
  function handleAddCatalogItem() {
    const name_ar = document.getElementById('newItemNameAr')?.value.trim();
    const name_en = document.getElementById('newItemNameEn')?.value.trim();
    const type    = document.getElementById('newItemType')?.value;
    const price   = parseFloat(document.getElementById('newItemPrice')?.value);
    const unit    = document.getElementById('newItemUnit')?.value;

    if (!name_ar) { App.toast('Arabic name required', 'error'); return; }
    if (!name_en) { App.toast('English name required', 'error'); return; }
    if (isNaN(price) || price < 0) { App.toast('Valid price required', 'error'); return; }

    DB.addCatalogItem({ name_ar, name_en, type, price, unit });
    ['newItemNameAr','newItemNameEn','newItemPrice'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    Catalog.buildCatalogTable();
    Catalog.load();
    App.toast('✓ Item added to catalog');
  }

  /* ── Customers page ── */
  function renderCustomersPage() {
    const list = DB.getAllCustomers();
    const totalSpent = list.reduce((s,c) => s + c.total_spent, 0);
    const avg = list.length ? totalSpent / list.length : 0;

    document.getElementById('customerStats').innerHTML = `
      <div class="stat-card"><div class="stat-value">${list.length}</div><div class="stat-label">Customers</div></div>
      <div class="stat-card"><div class="stat-value">EGP ${Math.round(totalSpent).toLocaleString('en-EG')}</div><div class="stat-label">Total Revenue</div></div>
      <div class="stat-card"><div class="stat-value">EGP ${Math.round(avg).toLocaleString('en-EG')}</div><div class="stat-label">Avg. per Customer</div></div>
    `;

    const tbody = document.getElementById('customerTableBody');
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty">No customers yet</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map(c => `
      <tr>
        <td><span class="badge badge-amber">${c.id}</span></td>
        <td>${esc(c.name)}</td>
        <td class="mono">${c.mobile || '—'}</td>
        <td class="muted" style="font-size:.8rem">${esc(c.address || '—')}</td>
        <td><span class="badge badge-teal">${c.order_count}</span></td>
        <td class="mono" style="color:var(--amber-lt)">EGP ${c.total_spent.toFixed(2)}</td>
        <td class="mono muted" style="font-size:.75rem">${fmtDate(c.created_at?.split('T')[0])}</td>
      </tr>
    `).join('');
  }

  /* ── Orders page ── */
  function renderOrdersPage() {
    const list = DB.getAllOrders();
    const revenue = list.reduce((s,o) => s + o.total, 0);
    const kg = list.reduce((s,o) => s + (o.total_weight || 0), 0);

    document.getElementById('orderStats').innerHTML = `
      <div class="stat-card"><div class="stat-value">${list.length}</div><div class="stat-label">Orders</div></div>
      <div class="stat-card"><div class="stat-value">EGP ${Math.round(revenue).toLocaleString('en-EG')}</div><div class="stat-label">Revenue</div></div>
      <div class="stat-card"><div class="stat-value">${kg.toFixed(2)} kg</div><div class="stat-label">Coffee Sold</div></div>
    `;

    const tbody = document.getElementById('orderTableBody');
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty">No orders yet</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map(o => `
      <tr>
        <td><span class="badge badge-amber">${o.invoice}</span></td>
        <td class="muted">${fmtDate(o.date)}</td>
        <td>${esc(o.customer_name)}</td>
        <td class="mono">${(o.total_weight||0).toFixed(3)} kg</td>
        <td class="mono" style="color:var(--amber-lt)">EGP ${o.total.toFixed(2)}</td>
        <td><span class="badge badge-sky">${o.payment}</span></td>
        <td><button class="btn btn-teal btn-sm" onclick="App._viewOrderReceipt(${o.id})">Receipt</button></td>
      </tr>
    `).join('');
  }

  /* ── Shared helpers ── */
  function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleDateString('en-EG', { day:'2-digit', month:'short', year:'numeric' });
  }

  /* ── Override App.onCartChange to call local renderCart ── */
  App.onCartChange = function() { renderCart(); };

  /* ── Cart renderer (local, full) ── */
  function renderCart() {
    const lines   = Catalog.getCartItems();
    const taxRate = parseFloat(document.getElementById('taxRate')?.value) || 14;
    const totals  = Catalog.getCartTotals(taxRate);

    const cartItemsEl  = document.getElementById('cartItems');
    const cartTotalsEl = document.getElementById('cartTotals');

    /* ── Update FAB badge count ── */
    const badge = document.getElementById('cartFabBadge');
    if (badge) {
      badge.textContent = lines.length;
      badge.setAttribute('data-count', lines.length);
    }

    if (lines.length === 0) {
      cartItemsEl.innerHTML = `
        <div class="cart-empty">
          <div class="empty-icon">☕</div>
          <p>No items selected</p>
          <small>Choose coffee from the grid</small>
        </div>`;
      if (cartTotalsEl) cartTotalsEl.style.display = 'none';
      return;
    }

    if (cartTotalsEl) cartTotalsEl.style.display = '';

    cartItemsEl.innerHTML = lines.map(line => {
      const qty = line.unit === 'kg'
        ? line.quantity.toFixed(3) + ' kg'
        : line.unit === 'g'
        ? line.quantity + ' g'
        : line.quantity + ' ' + line.unit;

      return `
        <div class="cart-line">
          <div class="cl-info">
            <div class="cl-name">${line.nameAr}</div>
            <div class="cl-detail mono">${qty} × EGP ${line.price.toLocaleString('en-EG')} / ${line.unit}</div>
          </div>
          <div class="cl-price">EGP ${line.lineTotal.toFixed(2)}</div>
          <button class="cl-remove" onclick="App._removeCartItem(${line.catalogId})">✕</button>
        </div>`;
    }).join('');

    setText('totalWeight',   totals.totalKg.toFixed(3) + ' kg');
    setText('subtotalVal',   'EGP ' + totals.subtotal.toFixed(2));
    setText('taxVal',        'EGP ' + totals.taxAmount.toFixed(2));
    setText('grandVal',      'EGP ' + totals.grandTotal.toFixed(2));
    setText('taxPctDisplay', taxRate);
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  /* ── Remove cart item override ── */
  App._removeCartItem = function(catalogId) {
    Catalog._adjust(catalogId, -999999);
  };

})();
