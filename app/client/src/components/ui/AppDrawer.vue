<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(defineProps<{ modelValue: boolean; title: string; side?: 'left' | 'right' }>(), {
  modelValue: false,
  side: 'right'
});
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const drawerRef = ref<HTMLElement | null>(null);

function close(): void {
  emit('update:modelValue', false);
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.modelValue) close();
}

watch(
  () => props.modelValue,
  async (isOpen) => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeydown);
      await nextTick();
      drawerRef.value?.focus();
    } else {
      document.removeEventListener('keydown', handleKeydown);
    }
  },
  { immediate: true }
);

onBeforeUnmount(() => document.removeEventListener('keydown', handleKeydown));
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="app-overlay app-overlay--drawer" role="presentation" @click.self="close">
      <aside
        ref="drawerRef"
        class="app-drawer"
        :class="`app-drawer--${side}`"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
      >
        <header class="app-drawer__header">
          <h2>{{ title }}</h2>
          <button type="button" class="app-dialog__close" aria-label="关闭抽屉" @click="close">
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div class="app-drawer__body"><slot /></div>
      </aside>
    </div>
  </Teleport>
</template>
