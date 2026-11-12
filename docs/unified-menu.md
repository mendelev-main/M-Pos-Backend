# Unified guest menu

The root page and `/menu/` render the same production ordering UI. `public/menu/index.html` is a relative symlink to the root template so the two entry points cannot drift. The account navigation also has only Menu and Account.

The browser requests `/api/menu?surface=combined` and uses the separate `combined` local catalog cache. Categories and products are included when active and visible in the menu or available online; the existing default online-only API and `surface=menu` retain their filters. Online purchase eligibility still depends on `available_online`, known availability, and current stock. Venue-only products display the yellow informational action and have a zero online cart limit. The checkout service continues to independently filter out venue-only products.

Checkout retains the existing contact validation, verified-account autofill, guest Telegram confirmation, gifts, live stock refresh, request idempotency and order submission. Fulfilment uses purple for pickup and green for delivery. The cash/card UI appears only for delivery. Cash is the sole available option; card is disabled and marked Soon, so this release introduces no card-payment processing or new payment API contract. Removed explanatory text does not change delivery pricing or the goods-only total with `+ доставка`.

No database migration is needed. Tests cover the combined endpoint alongside both legacy surfaces, exclusion of venue-only items from the cart after stock updates, and payment visibility/disabled-card behavior.
