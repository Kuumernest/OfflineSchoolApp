export function getRoleRoute(user) {
  if (!user || !user.role) {
    return "/auth/login";
  }

  switch (user.role) {
    case "super_admin":
    case "school_admin":
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