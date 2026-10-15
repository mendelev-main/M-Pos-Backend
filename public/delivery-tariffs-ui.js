/* Tariff choices always come from the server; the browser never sets the price. */
(function (global) {
  'use strict';
  function create({ fetchList, changed = () => {} }) {
    let tariffs = [], version = null, selected = null, published = false, loading = false, error = '', request = 0;
    const snapshot = () => ({ tariffs, version, selected, published, loading, error });
    async function refresh() {
      const current = ++request;
      loading = true; error = ''; changed(snapshot());
      try {
        const data = await fetchList();
        if (current !== request) return false;
        if (!Number.isSafeInteger(data.version) || typeof data.published !== 'boolean' || !Array.isArray(data.tariffs)) throw new Error('Не удалось получить тарифы доставки');
        const ids = new Set();
        for (const rate of data.tariffs) {
          if (typeof rate.id !== 'string' || ids.has(rate.id) || typeof rate.name !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(String(rate.amount))) throw new Error('Некорректный тариф доставки');
          ids.add(rate.id);
        }
        tariffs = data.tariffs; version = data.version; published = data.published;
        if (selected) {
          const match = tariffs.find(rate => rate.id === selected.id);
          if (!match || match.name !== selected.name || Number(match.amount) !== Number(selected.amount) || selected.version !== version) {
            selected = null; error = 'Тарифы изменились. Проверьте стоимость и выберите тариф заново';
          }
        }
        return true;
      } catch (failure) {
        if (current !== request) return false;
        selected = null; tariffs = []; error = failure.message || 'Не удалось загрузить тарифы доставки';
        return false;
      } finally {
        if (current === request) { loading = false; changed(snapshot()); }
      }
    }
    function select(id) {
      const rate = tariffs.find(rate => rate.id === id);
      selected = rate ? { ...rate, version } : null;
      error = ''; changed(snapshot());
    }
    function clear() { selected = null; changed(snapshot()); }
    function ready() { return !loading && !error && (published ? Boolean(selected) : version !== null); }
    function payload() { return selected ? { deliveryTariffId: selected.id, deliveryTariffAmount: selected.amount, deliveryTariffVersion: selected.version } : {}; }
    return { refresh, select, clear, ready, payload, snapshot };
  }
  global.DeliveryTariffsUI = { create };
})(typeof window === 'undefined' ? globalThis : window);
