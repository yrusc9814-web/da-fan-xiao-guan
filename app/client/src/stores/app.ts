import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { fetchHealth } from '../services/api';
import type { HealthData } from '../types/health';

export type BackendStatus = 'unknown' | 'checking' | 'available' | 'unavailable';

export const useAppStore = defineStore('app', () => {
  const backendStatus = ref<BackendStatus>('unknown');
  const health = ref<HealthData | null>(null);
  const errorMessage = ref<string | null>(null);

  const statusLabel = computed(() => {
    switch (backendStatus.value) {
      case 'checking':
        return '检查中';
      case 'available':
        return '服务正常';
      case 'unavailable':
        return '服务不可用';
      default:
        return '尚未检查';
    }
  });

  async function checkHealth(): Promise<void> {
    backendStatus.value = 'checking';
    errorMessage.value = null;

    try {
      health.value = await fetchHealth();
      backendStatus.value = 'available';
    } catch (error) {
      backendStatus.value = 'unavailable';
      errorMessage.value = error instanceof Error ? error.message : '后端服务不可用';
    }
  }

  return {
    backendStatus,
    health,
    errorMessage,
    statusLabel,
    checkHealth
  };
});
