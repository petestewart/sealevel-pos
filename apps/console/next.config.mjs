/** @type {import('next').NextConfig} */
const nextConfig = {
  // pg is a Node-native driver; keep it (and the core package that wraps it)
  // out of the Next server bundle and require them at runtime instead.
  serverExternalPackages: ["pg", "@ai-manager/core"],
};

export default nextConfig;
