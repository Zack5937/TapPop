const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const defaultResolve = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // rpc-websockets exports only node/browser conditions. Use the browser client
  // on Android, which uses React Native's WebSocket instead of Node's ws server.
  if (moduleName === 'rpc-websockets') {
    return context.resolveRequest({
      ...context,
      unstable_conditionNames: ['browser', 'require'],
      isESMImport: false,
    }, moduleName, platform);
  }
  return defaultResolve ? defaultResolve(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
