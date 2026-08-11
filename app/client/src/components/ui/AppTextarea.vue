<script setup lang="ts">
withDefaults(
  defineProps<{
    modelValue?: string;
    label: string;
    placeholder?: string;
    rows?: number;
    disabled?: boolean;
    error?: string;
  }>(),
  {
    modelValue: '',
    placeholder: '',
    rows: 4,
    disabled: false,
    error: ''
  }
);

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <label class="app-field">
    <span class="app-field__label">{{ label }}</span>
    <textarea
      :value="modelValue"
      :rows="rows"
      :placeholder="placeholder"
      :disabled="disabled"
      :aria-invalid="Boolean(error)"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    ></textarea>
    <span v-if="error" class="app-field__error" role="alert">{{ error }}</span>
  </label>
</template>
