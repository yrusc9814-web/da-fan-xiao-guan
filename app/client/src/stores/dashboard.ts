import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { fetchDashboard } from '../services/api';
import type { DashboardDto } from '../../../shared/types';

export type DashboardStatus = 'idle' | 'loading' | 'success' | 'error';

export const useDashboardStore = defineStore('dashboard', () => {
  const status = ref<DashboardStatus>('idle');
  const data = ref<DashboardDto | null>(null);
  const errorMessage = ref<string | null>(null);
  const isLoading = computed(() => status.value === 'loading');

  async function load(): Promise<void> {
    status.value = 'loading';
    errorMessage.value = null;

    try {
      data.value = await fetchDashboard();
      status.value = 'success';
    } catch (error) {
      status.value = 'error';
      errorMessage.value = error instanceof Error ? error.message : '首页数据暂时不可用';
    }
  }

  return { status, data, errorMessage, isLoading, load };
});
