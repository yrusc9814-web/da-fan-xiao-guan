<script setup lang="ts">
withDefaults(defineProps<{ modelValue: boolean; message: string; tone?: 'info' | 'success' | 'error' }>(), {
  modelValue: false,
  tone: 'info'
});

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>

<template>
  <div v-if="modelValue" class="app-toast" :class="`app-toast--${tone}`" role="status">
    <span>{{ message }}</span>
    <button type="button" aria-label="关闭提示" @click="emit('update:modelValue', false)">×</button>
  </div>
</template>
