<script setup lang="ts">
withDefaults(
  defineProps<{
    modelValue?: string;
    label: string;
    placeholder?: string;
    type?: 'text' | 'search' | 'email' | 'password' | 'date' | 'number';
    error?: string;
    disabled?: boolean;
  }>(),
  {
    modelValue: '',
    placeholder: '',
    type: 'text',
    error: '',
    disabled: false
  }
);

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <label class="app-field">
    <span class="app-field__label">{{ label }}</span>
    <input
      :value="modelValue"
      :type="type"
      :placeholder="placeholder"
      :disabled="disabled"
      :aria-invalid="Boolean(error)"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <span v-if="error" class="app-field__error" role="alert">{{ error }}</span>
  </label>
</template>
