export function getRoleRoute(user) {
  if (!user || !user.role) {
    return "/auth/login";
  }

  switch (user.role) {
    case "super_admin":
    case "school_admin":
      return "/admin/dashboard";

    // The bursar shares the admin dashboard, which filters its own tiles and
    // its own stats by role — see app/admin/dashboard/index.js. A separate
    // screen would mean two copies of the header, the school banner, the sync
    // bar and the logout flow, kept in step by hand.
    //
    // What a bursar actually opens this app for is the offline fee desk: taking
    // cash where there is no signal. That is app/admin/fees, one tap away and
    // the first tile they are shown.
    case "bursar":
      return "/admin/dashboard";

    case "teacher":
      return "/teacher/dashboard";

    case "student":
      return "/student";

    default:
      console.warn("Unknown user role:", user.role);
      return "/auth/login";
  }
}