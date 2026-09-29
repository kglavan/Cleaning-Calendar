// The date logic lives in public/rank-dates.js so the Rankings page and the
// tracker use exactly the same rules.
import '../public/rank-dates.js';

export const { isoDay, addDays, bookedNights, openStays, calendarStays, openGaps, staysForSearch, weekOf, oneStayPerWeek } = globalThis.RankDates;
