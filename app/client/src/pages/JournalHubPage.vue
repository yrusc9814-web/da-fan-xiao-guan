<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue';
import MascotPlaceholder from '../components/mascot/MascotPlaceholder.vue';
</script>

<template>
  <section class="business-page hub-page" aria-labelledby="journal-hub-title">
    <header class="hub-heading">
      <div class="hub-heading__copy">
        <p class="business-eyebrow">Diary</p>
        <h1 id="journal-hub-title">日记</h1>
        <p>回顾每天吃什么，安排接下来的每一餐。</p>
      </div>
      <MascotPlaceholder placement="sidebar-tip" />
    </header>

    <nav class="hub-grid" aria-label="日记功能入口">
      <RouterLink class="hub-card hub-card--primary" :to="{ path: '/records', query: { mealType: 'DINNER' } }">
        <span class="hub-card__icon" aria-hidden="true"><AppIcon name="plus" :size="24" /></span>
        <span class="hub-card__body">
          <strong>记录一餐</strong>
          <small>吃完后把这一餐记下来</small>
        </span>
        <span class="hub-card__cta" aria-hidden="true">去记录<AppIcon name="chevron-right" :size="14" /></span>
      </RouterLink>
      <RouterLink class="hub-card" to="/records">
        <span class="hub-card__icon" aria-hidden="true"><AppIcon name="journal" :size="24" /></span>
        <span class="hub-card__body">
          <strong>饮食记录</strong>
          <small>查看历史记录与待完成餐次</small>
        </span>
        <span class="hub-card__cta" aria-hidden="true">去看看<AppIcon name="chevron-right" :size="14" /></span>
      </RouterLink>
      <RouterLink class="hub-card" to="/plans">
        <span class="hub-card__icon" aria-hidden="true"><AppIcon name="clipboard-check" :size="24" /></span>
        <span class="hub-card__body">
          <strong>用餐计划</strong>
          <small>为某一天提前安排一餐</small>
        </span>
        <span class="hub-card__cta" aria-hidden="true">去安排<AppIcon name="chevron-right" :size="14" /></span>
      </RouterLink>
      <RouterLink class="hub-card" to="/calendar">
        <span class="hub-card__icon" aria-hidden="true"><AppIcon name="calendar" :size="24" /></span>
        <span class="hub-card__body">
          <strong>饮食日历</strong>
          <small>按日期回看计划、记录与完成情况</small>
        </span>
        <span class="hub-card__cta" aria-hidden="true">去日历<AppIcon name="chevron-right" :size="14" /></span>
      </RouterLink>
      <RouterLink class="hub-card" to="/statistics">
        <span class="hub-card__icon" aria-hidden="true"><AppIcon name="statistics" :size="24" /></span>
        <span class="hub-card__body">
          <strong>统计分析</strong>
          <small>用轻量数据看见自己的饮食节奏</small>
        </span>
        <span class="hub-card__cta" aria-hidden="true">去看看<AppIcon name="chevron-right" :size="14" /></span>
      </RouterLink>
      <RouterLink class="hub-card" to="/diners">
        <span class="hub-card__icon" aria-hidden="true"><AppIcon name="user" :size="24" /></span>
        <span class="hub-card__body">
          <strong>食用者</strong>
          <small>管理一起吃饭的人及其忌口过敏</small>
        </span>
        <span class="hub-card__cta" aria-hidden="true">去管理<AppIcon name="chevron-right" :size="14" /></span>
      </RouterLink>
    </nav>
  </section>
</template>

<style scoped>
.hub-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: 24px 28px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-dialog);
  background: linear-gradient(135deg, var(--color-card) 0%, #fff1f5 100%);
  box-shadow: var(--shadow-card);
}

.hub-heading h1 {
  margin: var(--space-1) 0 6px;
  font-size: clamp(26px, 3vw, 38px);
  line-height: var(--line-height-tight);
}

.hub-heading p {
  margin: 0;
  color: var(--color-text-secondary);
}

.hub-heading .mascot-placeholder {
  width: 96px;
  height: 76px;
  flex: 0 0 auto;
}

.hub-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.hub-card {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 14px;
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  background: var(--color-card);
  box-shadow: var(--shadow-card);
  color: inherit;
  text-decoration: none;
}

.hub-card:hover {
  border-color: var(--color-primary);
  box-shadow: 0 10px 26px rgba(92, 58, 70, 0.1);
}

.hub-card__icon {
  display: grid;
  width: 46px;
  height: 46px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 14px;
  color: var(--color-primary-hover);
  background: var(--color-primary-soft);
}

.hub-card--primary .hub-card__icon {
  color: var(--color-card);
  background: var(--color-primary);
}

.hub-card__body {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}

.hub-card__body strong {
  font-size: 17px;
  line-height: 1.3;
}

.hub-card__body small {
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.45;
  text-overflow: ellipsis;
}

.hub-card__cta {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
  color: var(--color-primary-hover);
  font-size: 13px;
  font-weight: 700;
}

@media (max-width: 767px) {
  .hub-heading {
    align-items: stretch;
    flex-direction: column;
    padding: var(--space-5);
    border-radius: 20px;
  }

  .hub-heading .mascot-placeholder {
    display: none;
  }

  .hub-grid {
    grid-template-columns: 1fr;
    gap: 10px;
  }

  .hub-card {
    padding: 14px;
    border-radius: var(--radius-card);
  }
}
</style>
