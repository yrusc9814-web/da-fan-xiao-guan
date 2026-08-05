import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../../', '');
  const backendProxyTarget = env.BACKEND_PROXY_TARGET ?? 'http://127.0.0.1:8787';

  return {
    plugins: [vue()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': {
          target: backendProxyTarget,
          changeOrigin: true
        }
      }
    }
  };
});
