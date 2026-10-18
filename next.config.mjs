/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep large native/Node-only SDKs out of the server bundle; they are provided
  // by node_modules at runtime on Vercel.
  experimental: {
    serverComponentsExternalPackages: ["firebase-admin"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
nextConfig.swcMinify = false;
