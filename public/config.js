// Fill these in after creating your Supabase project (Project Settings -> API).
// The URL and anon key are meant to be public - they are safe to ship in frontend code.
window.APP_CONFIG = {
  SUPABASE_URL: "https://cgelbsronyqiexwevhqp.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNnZWxic3JvbnlxaWV4d2V2aHFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0Mjc5ODksImV4cCI6MjEwMzAwMzk4OX0.vq_SA1JRBNfptO-y6YX6IC1d_D9zQ-KUS2V5xlb6kzY",

  CLEANERS: [
    { id: "kyle_stephanie", label: "Kyle & Stephanie" },
    { id: "baylie", label: "Baylie Kidd" },
    { id: "em", label: "Em Bollander" },
  ],

  // Used to color-code cleaning bars by who's assigned.
  CLEANER_COLORS: {
    kyle_stephanie: "#8b5cf6",
    baylie: "#f59e0b",
    em: "#06b6d4",
  },

  SOURCE_LABELS: {
    airbnb: "Airbnb",
    vrbo: "VRBO",
    booking: "Booking.com",
  },

  SOURCE_COLORS: {
    airbnb: "#FF385C",
    vrbo: "#00A699",
    booking: "#003580",
  },

  // Edit this list any time to change the cleaner checklist.
  CHECKLIST_ITEMS: [
    { id: "strip_beds", label: "Strip beds & start laundry" },
    { id: "remake_beds", label: "Remake beds (check next guest count for linen sets)" },
    { id: "clean_bathrooms", label: "Clean & sanitize bathroom(s)" },
    { id: "clean_kitchen", label: "Clean kitchen & appliances" },
    { id: "restock_supplies", label: "Restock toiletries, paper products, coffee/tea" },
    { id: "trash", label: "Empty all trash & replace liners" },
    { id: "floors", label: "Vacuum & mop all floors" },
    { id: "dust", label: "Dust surfaces & wipe down furniture" },
    { id: "bulbs_batteries", label: "Check light bulbs & remote batteries" },
    { id: "walkthrough", label: "Final walkthrough - check for damage or missing items" },
  ],
};
