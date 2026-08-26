// app/teacher/_layout.js

import { Stack } from "expo-router";
import { Alert, View, StyleSheet } from "react-native";
import { useUploadQueue } from "../../src/hooks/useUploadQueue";
import SyncStatusBar from "../../src/components/SyncStatusBar";
import { useTranslation } from "../../src/i18n/useTranslation";

export default function TeacherLayout() {
  const { t } = useTranslation();
  useUploadQueue({
    onComplete: (summary) => {
      if (summary.succeeded > 0) {
        Alert.alert(
          t("teacherLayout.uploadsDone"),
          `${summary.succeeded} queued upload${
            summary.succeeded > 1 ? "s" : ""
          } synced successfully.`
        );
      }

      if (summary.failed > 0) {
        Alert.alert(
          t("teacherLayout.uploadsFailed"),
          `${summary.failed} upload${
            summary.failed > 1 ? "s" : ""
          } could not be synced. They will retry next time.`
        );
      }
    },
  });

  return (
    <View style={styles.root}>
      <Stack
        screenOptions={{
          headerShown: false,
        }}
      />
      {/* Overlay — rendered after the navigator so it sits on top without
          displacing any screen's layout. */}
      <SyncStatusBar />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
