import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mediaQueryList = window.matchMedia(query);
    const handleChange = (event: MediaQueryListEvent): void => { setMatches(event.matches); };
    setMatches(mediaQueryList.matches);
    mediaQueryList.addEventListener("change", handleChange);
    return () => { mediaQueryList.removeEventListener("change", handleChange); };
  }, [query]);

  return matches;
}

// Keep in sync with the $pwa-mobile-breakpoint comment in public/pwa-app.css.
const MOBILE_BREAKPOINT_QUERY = "(max-width: 767px)";

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_BREAKPOINT_QUERY);
}
