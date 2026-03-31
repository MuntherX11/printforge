/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  serverExternalPackages: ['@printforge/types'],
};

module.exports = nextConfig;
