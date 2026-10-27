// metro.config.js
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Add 'wasm' to the list of assets Metro can handle
config.resolver.assetExts.push('wasm');

// The repo's shared/ folder sits beside mobile/. It holds plain CommonJS logic
// the server and desktop already run — the timetable conflict detector among
// it — so the phone answers the same question offline. Metro only bundles
// files it watches, so the folder is added explicitly.
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../shared')];

module.exports = config;
