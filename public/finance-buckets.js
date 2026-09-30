// Expense buckets and colors from the owner's expenses workbook, plus the
// rules that put each bank/card transaction into a bucket. Shared by the
// Finance page and the finance/ scripts. Plain script so the browser can load
// it with a <script> tag; Node imports it for its side effect and reads
// globalThis.FinanceBuckets.
(function () {
  // Colors are the exact fills from "1143 Autumn Star Point Expenses.xlsx".
  const BUCKETS = [
    { name: 'Home Costs', color: '#8ED873' },
    { name: 'Cleaning', color: '#CC0000' },
    { name: 'Maintenance & Remodelling', color: '#7F6000' },
    { name: 'General Supplies', color: '#4EA72E' },
    { name: 'Meals', color: '#E97132' },
    { name: 'Software', color: '#156082' },
    { name: 'Legal Fees', color: '#0F9ED5' },
    { name: 'Shipping', color: '#A02B93' },
    { name: 'Parking / Mileage', color: '#196B24' },
    { name: 'Other', color: '#9CA3AF' },
  ];
  const INCOME = { name: 'Income', color: '#1F6FEB' };
  const COLOR = Object.fromEntries([...BUCKETS, INCOME].map((b) => [b.name, b.color]));

  // First matching rule wins. `d` is the description, `c` the Stessa
  // category, `s` the sub-category.
  const RULES = [
    [(t) => t.c === 'Income', 'Income'],
    // Pricing tools are sometimes filed under Cleaning or platform fees in Stessa.
    [(t) => /pricelabs|wheelhouse|airdna/i.test(t.d), 'Software'],
    [(t) => t.s === 'Cleaning & Janitorial', 'Cleaning'],
    [(t) => t.s === 'Mileage', 'Parking / Mileage'],
    [(t) => t.s === 'Meals', 'Meals'],
    [(t) => /postage|shipping/i.test(t.s) || /usps|fedex|ups store/i.test(t.d), 'Shipping'],
    [(t) => /software/i.test(t.s) || t.c === 'Management Fees', 'Software'],
    [(t) => t.c === 'Legal & Professional' || t.s === 'Tax Licenses & Registrations', 'Legal Fees'],
    [(t) => ['Mortgages & Loans', 'Utilities', 'Insurance', 'Taxes'].includes(t.c) || t.s === 'HOA Dues' || t.s === 'Closing Costs', 'Home Costs'],
    // Furnishings, consumables and listing extras (photography etc.) were
    // colored General Supplies in the workbook.
    [(t) => /linens|consumables|furniture|appliances|advertising/i.test(t.s), 'General Supplies'],
    [(t) => t.c === 'Repairs & Maintenance' || /remodel|flooring|carpet/i.test(t.s), 'Maintenance & Remodelling'],
  ];

  function bucketOf(tx) {
    // Expenses entered in the activity log carry the bucket chosen for them.
    if (tx.bucket) return tx.bucket;
    const t ={ d: tx.description || '', c: tx.category || '', s: tx.sub_category || '' };
    const hit = RULES.find(([test]) => test(t));
    return hit ? hit[1] : 'Other';
  }

  globalThis.FinanceBuckets = { BUCKETS, INCOME, COLOR, bucketOf };
})();
