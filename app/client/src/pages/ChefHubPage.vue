<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue';
import MascotPlaceholder from '../components/mascot/MascotPlaceholder.vue';
</script>

<template>
  <section class="business-page hub-page" aria-labelledby="chef-hub-title">
    <header class="hub-heading">
      <div class="hub-heading__copy">
        <p class="business-eyebrow">Kitchen</p>
        <h1 id="chef-hub-title">厨师</h1>
        <p>管理自己的菜谱和厨房，从这里开始做饭。</p>
      </div>
      <MascotPlaceholder placement="sidebar-tip" />
    </header>

    <nav class="hub-grid" aria-label="厨师功能入口">
      <RouterLink class="hub-card" to="/recipes">
        <span class="hub-card__icon" aria-hidden="true"><AppIcon name="journal" :size="24" /></span>
        <span class="hub-card__body">
          <strong>我的菜谱</strong>
          <small>查看、搜索和管理自己录入的菜谱</small>
        </span>
        <span class="hub-card__cta" aria-hidden="true">去管理<AppIcon name="chevron-right" :size="14" /></span>
      </RouterLink>
      <RouterLink class="hub-card hub-card--primary" to="/recipes/new">
        <span class="hub-card__icon" aria-hidden="true"><AppIcon name="plus" :size="24" /></span>
        <span class="hub-card__body">
          <strong>新增菜谱</strong>
          <small>录入一道新菜，之后可以参与推荐</small>
        </span>
        <span class="hub-card__cta" aria-hidden="true">去新增<AppIcon name="chevron-right" :size="14" /></span>
      </RouterLink>
      <RouterLink class="hub-card" to="/inventory">
        <span class="hub-card__icon" aria-hidden="true"><AppIcon name="ingredient" :size="24" /></span>
        <span class="hub-card__body">
          <strong>食材库存</strong>
          <small>登记食材批次、数量与到期日</small>
        </span>
        <span class="hub-card__cta" aria-hidden="true">去管理<AppIcon name="chevron-right" :size="14" /></span>
      </RouterLink>
      <RouterLink class="hub-card" to="/tools">
        <span class="hub-card__icon" aria-hidden="true"><AppIcon name="chef" :size="24" /></span>
        <span class="hub-card__body">
          <strong>厨房工具</strong>
          <small>维护家里可用的锅具和工具</small>
        </span>
        <span class="hub-card__cta" aria-hidden="true">去管理<AppIcon name="chevron-right" :size="14" /></span>
      </RouterLink>
      <RouterLink class="hub-card" :to="{ path: '/inventory', query: { panel: 'recommend' } }">
        <span class="hub-card__icon" aria-hidden="true"><AppIcon name="sparkle" :size="24" /></span>
        <span class="hub-card__body">
          <strong>库存推荐</strong>
          <small>根据现有库存推荐能做的菜</small>
        </span>
        <span class="hub-card__cta" aria-hidden="true">去看看<AppIcon name="chevron-right" :size="14" /></span>
      </RouterLink>
      <RouterLink class="hub-card" to="/shopping">
        <span class="hub-card__icon" aria-hidden="true"><AppIcon name="clipboard-check" :size="24" /></span>
        <span class="hub-card__body">
          <strong>购物清单</strong>
          <small>整理需要补购的食材，勾选完成</small>
        </span>
        <span class="hub-card__cta" aria-hidden="true">去清单<AppIcon name="chevron-right" :size="14" /></span>
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
