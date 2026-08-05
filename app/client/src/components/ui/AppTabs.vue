<script setup lang="ts">
export interface AppTab {
  label: string;
  value: string;
}

const props = defineProps<{ tabs: AppTab[]; modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <div class="app-tabs" role="tablist" aria-label="内容切换">
    <button
      v-for="tab in props.tabs"
      :key="tab.value"
      type="button"
      class="app-tab"
      :class="{ 'app-tab--active': tab.value === modelValue }"
      role="tab"
      :aria-selected="tab.value === modelValue"
      @click="emit('update:modelValue', tab.value)"
    >
      {{ tab.label }}
    </button>
  </div>
</template>
