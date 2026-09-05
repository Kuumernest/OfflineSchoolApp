// mobile/src/hooks/useScreenInsets.js
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Padding that clears the system bars, for a screen that draws its own edges.
 *
 * Android has drawn edge-to-edge since Expo SDK 54 and there is no opting out
 * of it: the app paints behind the status bar and behind the navigation bar.
 * A screen that pads with a guessed constant therefore either wastes a strip
 * of a display that has no notch, or puts its first line under the clock.
 *
 * Every screen in the signed-out flow guessed. Login used 60, the application
 * form 48, the parent portal 40, the school picker 56 on iOS and 36 on
 * Android — and not one of them padded the bottom at all, which is why the
 * parent portal link sat behind the navigation bar on the very screen that
 * exists to send guardians to it.
 *
 * The insets are the real measurement, taken from the device. Ask for those,
 * then add whatever breathing room the design wants on top of them.
 *
 *   const pad = useScreenInsets({ top: 28 });
 *   <ScrollView contentContainerStyle={[styles.scroll, pad]}>
 *
 * `top` and `bottom` are the design's own spacing, not an allowance for the
 * bars — the bars are already accounted for.
 */
export function useScreenInsets({ top = 24, bottom = 32 } = {}) {
  const insets = useSafeAreaInsets();

  return {
    paddingTop:    insets.top    + top,
    paddingBottom: insets.bottom + bottom,
  };
}

export default useScreenInsets;
