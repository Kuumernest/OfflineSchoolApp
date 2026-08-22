// app/admin/_layout.js

import { Stack } from "expo-router";
import { View, StyleSheet } from "react-native";
import { useUploadQueue } from "../../src/hooks/useUploadQueue";
import SyncStatusBar from "../../src/components/SyncStatusBar";

export default function AdminLayout() {
  // The admin section had no layout at all, so it inherited neither the
  // upload-queue drain nor any offline indicator.
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
