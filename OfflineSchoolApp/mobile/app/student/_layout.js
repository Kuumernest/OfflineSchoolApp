// app/student/_layout.js

import { Stack } from "expo-router";
import { View, StyleSheet } from "react-native";
import { useUploadQueue } from "../../src/hooks/useUploadQueue";
import SyncStatusBar from "../../src/components/SyncStatusBar";

export default function StudentLayout() {
  // Students queue uploads too (homework attachments). Only the teacher
  // layout used to drain the queue, so a student's queued file sat until
  // they happened to open a screen that processed it — which never happened.
  useUploadQueue();

  return (
    <View style={styles.root}>
      <Stack
        screenOptions={{
          headerShown: false,
        }}
      />
      <SyncStatusBar />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
