# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.
# mobile/.npmrc
#
# Sets --legacy-peer-deps as default for all npm installs
# in this project. This is needed because Expo SDK 57 has
# peer dependency conflicts with some React 19 packages.
#
# Without this file you would need to add --legacy-peer-deps
# to every npm install command manually.
#
legacy-peer-deps=true