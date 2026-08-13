// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Add 'wasm' to the list of assets Metro can handle
config.resolver.assetExts.push('wasm');

module.exports = config;