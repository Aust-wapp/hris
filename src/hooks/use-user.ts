"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getCurrentUser, type AuthUserData } from "@/lib/actions/auth-actions";

export type AuthUser = AuthUserData;

/**
 * The signed-in user for client components.
 *
 * `initialUser` is the user the server already resolved for this request (the
 * dashboard layout passes it). Starting from it means the sidebar renders the
 * right items on first paint instead of fetching them after mount.
 *
 * A refetch that comes back empty or throws does NOT clear a user we already
 * hold. On load this hook fetches twice (mount + the INITIAL_SESSION event),
 * and a transient miss on the second call — a token refresh racing the server
 * action, a network blip — used to drop the user to null. The sidebar then
 * fell back to the "employee" role and per-account items such as Attendance
 * Corrections appeared and then vanished. Only the server saying there is no
 * user (checked on SIGNED_OUT) clears it — never the browser client's own view
 * of the session.
 */
export function useUser(initialUser?: AuthUser | null) {
  const [user, setUser] = useState<AuthUser | null>(initialUser ?? null);
  const [loading, setLoading] = useState(!initialUser);

  useEffect(() => {
    const supabase = createClient();

    async function fetchUser() {
      try {
        const userData = await getCurrentUser();
        setUser((prev) => userData ?? prev);
      } catch {
        // Keep whatever we already have; see the note above.
      } finally {
        setLoading(false);
      }
    }

    fetchUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      // INITIAL_SESSION duplicates the fetch on mount above. It also reports the
      // BROWSER client's view of the session, which can be empty while the
      // server (cookies, refreshed by src/proxy.ts) still has the user signed in
      // — clearing on it hid per-account items like Attendance Corrections.
      if (event === "INITIAL_SESSION") return;

      if (event === "SIGNED_OUT") {
        // Ask the server before believing it. Only a definite "no user" from
        // the server clears the sidebar; a real sign-out also redirects to
        // /login, which unmounts this anyway.
        getCurrentUser()
          .then((userData) => setUser(userData))
          .catch(() => {})
          .finally(() => setLoading(false));
        return;
      }

      fetchUser();
    });

    return () => subscription.unsubscribe();
  }, []);

  return { user, loading };
}
