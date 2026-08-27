// The graduation years UCLA students can currently pick, oldest first.
//
// Every graduation-year dropdown on the platform reads from here - the signup
// forms, the application add/edit modals, and the admin filters - so the range
// moves in one edit each time a class graduates out. Free-text graduation-year
// fields (the talent portal, member resume upload) validate against a plain
// four-digit pattern on the server instead and are deliberately not bounded by
// this list, so an out-of-range year is still storable.
export const GRADUATION_YEARS = ['2027', '2028', '2029', '2030'];

export default GRADUATION_YEARS;
