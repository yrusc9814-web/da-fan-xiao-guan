<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(defineProps<{ modelValue: boolean; title: string }>(), {
  modelValue: false
});
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const dialogRef = ref<HTMLElement | null>(null);
let restoreElement: HTMLElement | null = null;

function close(): void {
  emit('update:modelValue', false);
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.modelValue) {
    close();
  }
}

watch(() => props.modelValue, async (isOpen) => {
  if (isOpen) {
    restoreElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.addEventListener('keydown', handleKeydown);
    await nextTick();
    dialogRef.value?.focus();
  } else {
    document.removeEventListener('keydown', handleKeydown);
    restoreElement?.focus();
    restoreElement = null;
  }
}, { immediate: true });

onBeforeUnmount(() => document.removeEventListener('keydown', handleKeydown));
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="app-overlay" role="presentation" @click.self="close">
      <section
        ref="dialogRef"
        class="app-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
      >
        <header class="app-dialog__header">
          <h2>{{ title }}</h2>
          <button type="button" class="app-dialog__close" aria-label="关闭弹窗" @click="close">
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div class="app-dialog__body"><slot /></div>
        <footer v-if="$slots.footer" class="app-dialog__footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>
