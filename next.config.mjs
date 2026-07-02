/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the dev-tools indicator out of the bottom-left, where our sidebar footer lives.
  devIndicators: { position: 'bottom-right' },
  // The agent SDK + node:sqlite + pdfkit must run in the Node server, never bundled.
  serverExternalPackages: ['@anthropic-ai/claude-agent-sdk', 'pdfkit'],
  experimental: {
    // Long-running agent jobs stream over a while; don't kill them early.
    proxyTimeout: 1000 * 60 * 30,
  },
};

export default nextConfig;
