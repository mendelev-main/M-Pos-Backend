function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

export function validateLoyaltyAllocation({ items = [], programs = [], redemptions = {}, rewardAllocations = {} }) {
  const originalByProduct = new Map();
  for (const item of items) {
    const productId = String(item?.productId || "");
    const quantity = positiveInteger(item?.quantity ?? item?.qty);
    if (!productId || !quantity) throw new Error("INVALID_LOYALTY_ITEMS");
    originalByProduct.set(productId, (originalByProduct.get(productId) || 0) + quantity);
  }

  const allocatedByProduct = new Map();
  const allocatedByProgram = new Map();
  for (const program of programs) {
    const programId = String(program.id);
    const requested = Math.max(0, Math.trunc(Number(redemptions[programId]) || 0));
    const allowed = new Set((program.loyalty_reward_products || []).map(row => String(row.product_id)));
    let rows = Array.isArray(rewardAllocations[programId]) ? rewardAllocations[programId] : null;
    if (rows === null) {
      rows = [];
      let remaining = requested;
      for (const productId of originalByProduct.keys()) {
        if (!allowed.has(productId) || !remaining) continue;
        const available = (originalByProduct.get(productId) || 0) - (allocatedByProduct.get(productId) || 0);
        const quantity = Math.min(available, remaining);
        if (quantity > 0) rows.push({ productId, quantity });
        remaining -= quantity;
      }
    }
    let allocated = 0;
    for (const row of rows) {
      const productId = String(row?.productId || "");
      const quantity = positiveInteger(row?.quantity);
      if (!productId || !quantity || !allowed.has(productId)) throw new Error("INVALID_REWARD_ALLOCATION");
      allocated += quantity;
      allocatedByProduct.set(productId, (allocatedByProduct.get(productId) || 0) + quantity);
    }
    if (allocated !== requested) throw new Error("INVALID_REWARD_ALLOCATION");
    allocatedByProgram.set(programId, allocated);
  }

  for (const programId of Object.keys(rewardAllocations || {})) {
    if (!programs.some(program => String(program.id) === String(programId))) throw new Error("INVALID_REWARD_ALLOCATION");
  }
  for (const [productId, quantity] of allocatedByProduct) {
    if (quantity > (originalByProduct.get(productId) || 0)) throw new Error("REWARD_ITEM_REUSED");
  }

  const paidByProduct = new Map(originalByProduct);
  for (const [productId, quantity] of allocatedByProduct) paidByProduct.set(productId, paidByProduct.get(productId) - quantity);
  return { paidByProduct, allocatedByProgram };
}
