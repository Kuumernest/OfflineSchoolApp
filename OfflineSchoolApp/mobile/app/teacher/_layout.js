// app/teacher/_layout.js

import { Stack } from "expo-router";
import { Alert } from "react-native";
import { useUploadQueue } from "../../src/hooks/useUploadQueue";

export default function TeacherLayout() {
  useUploadQueue({
    onComplete: (summary) => {
      if (summary.succeeded > 0) {
        Alert.alert(
          "Uploads Complete",
          `${summary.succeeded} queued upload${
            summary.succeeded > 1 ? "s" : ""
          } synced successfully.`
        );
      }

      if (summary.failed > 0) {
        Alert.alert(
          "Some Uploads Failed",
          `${summary.failed} upload${
            summary.failed > 1 ? "s" : ""
          } could not be synced. They will retry next time.`
        );
      }
    },
  });

  return (
    <Stack
      screenOptions={{
        headerShown: false,
      }}
    />
  );
}