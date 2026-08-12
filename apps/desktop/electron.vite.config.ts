import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const workspacePackages = [
  '@outreachr/core',
  '@outreachr/connectors',
  '@outreachr/agents',
  '@outreachr/mcp',
  '@modelcontextprotocol/sdk',
  '@anthropic-ai/claude-agent-sdk',
  'zod',
];

const developmentCspPlugin = {
  name: 'outreachr-development-csp',
  apply: 'serve' as const,
  transformIndexHtml(html: string): string {
    const productionDirective = "connect-src 'self';";
    if (!html.includes(productionDirective)) {
      throw new Error('Outreachr renderer CSP is missing its production connect-src directive');
    }
    return html.replace(
      productionDirective,
      "connect-src 'self' ws://localhost:* ws://127.0.0.1:* ws://[::1]:*;",
    );
  },
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'mcp-stdio': resolve('src/main/mcp-stdio-entry.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      sourcemap: true,
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    // Local WebSocket origins are injected only by the development server for
    // Vite HMR. Packaged renderer HTML retains connect-src 'self' exclusively.
    plugins: [react(), developmentCspPlugin],
    build: {
      sourcemap: true,
      rollupOptions: {
        input: resolve('src/renderer/index.html'),
      },
    },
  },
});
