# 搭饭小馆 — UX Recovery Baseline V1.3 — FINAL

---

## 1. Final Product Verdict

**Current Shippable: NO**

一句话原因：普通用户无法独立完成「今天吃什么 → 吃下这一餐 → 留下记录」的核心闭环——随机结果页没有「就吃这个/换一个」的决策出口，首页「今日饮食记录」卡片、三餐行与移动端「+」全部不可点，计划→草稿→库存确认的既有链路存在却没有面向用户的连续引导。

---

## 2. Source-of-Truth Hierarchy

本基线全文的事实分层如下，后续一切整改引用必须标注层级：

1. **agent.md** — 工程、安全、数据库、执行约束的最高事实源。
2. **docs/PRD.md（V2 正式 PRD）** — 功能、字段、业务规则的**唯一正式权威**。凡本文件标注 [PRD] 的条款，均出自该文件。
3. **已确认的视觉参考图**（docs/design/*）— 首页布局、色系、比例、小羊风格的事实源。
4. **docs/archive/\*** — 仅作历史设计参考与需求演变证据，**不得覆盖 V2 PRD**。archive 与 V2 冲突时一律以 V2 为准。

标记规范：
- **[PRD]** = V2 PRD 明确要求；
- **[IMPL]** = 当前代码已实现的真实行为（附文件证据）；
- **[UX-D]** = 因真实用户反馈而新增的 UX 决策，不属于 PRD 也不是现状。

---

## 3. Engineering Gates — Proved / Did Not Prove

**Proved（W0–W4、CI 三矩阵、Release、LAN 全部 PASS）：** API 契约、事务一致性、库存安全扣减（preview→confirm）、幂等与乐观锁、PIN/上传安全、Windows 打包、LAN 访问、测试数据库守护。

**Did Not Prove：** 首页入口可点性、移动端触控、核心流程连续性、推荐语义与用户预期、文案可读性、字体与视觉气质。

工程 Gate 通过不构成产品完成的证据。此结论冻结，不再展开。

---

## 4. Corrected Facts（V1.3 相对 V1.1/V1.2 的全部纠偏）

1. **「转盘」不是 V2 PRD 要求。** V2 PRD 第 6 章对推荐无转盘/转轮动画条款（docs/PRD.md L538–547，仅「直接推荐 / 根据条件推荐」）。旧档 archive PRD 描述的是「圆形决策器 + 500–900ms 轻量随机切换动画，明确不做复杂转盘动画」（该时长仅作旧设计历史参考，不作为新转盘的验收硬指标）。「转盘式可视决策器」因此归类为 **[UX-D]**（由真实用户反馈驱动的新交互方向），不是“恢复 PRD 转盘”。
2. **桌面一级导航：V2 PRD = 9 项**（首页/菜谱推荐/饮食记录/食材库存/饮食日历/统计分析/收藏夹/购物清单/设置，docs/PRD.md L205–219）；**当前实现 = 12 项**（额外拆出「我的菜谱/饮食计划/厨房工具」）。这是 **Current IA Deviation**，不是「PRD 就是 12 项」。
3. **重复周期：** V2 PRD（RECO-008 硬条件，L611–623）要求「重复周期内直接排除」；当前实现只是 `score −= 40` 降权（recommendations/service.ts 候选打分）。**改判为 PRD Functional Gap：语义错误，不是「已实现但 UI 未暴露」。**
4. **餐次筛选：** V2 PRD 要求可多选（RECO-002，L549–557）；当前 `RecommendationInput.mealType` 为单选且前端是单选下拉。**改判 Partial。**
5. **收藏拆分：** 「收藏状态作为软权重 +30」已真正实现（recipe/store 打分）；`favoriteOnly` 硬筛选参数后端存在但**前端无入口**。两者不得混为一谈。
6. **「开始制作」：** V2 PRD 菜谱详情操作项明确包含（L843 附近）；当前 RecipeDetailPage **不存在**该操作（代码零命中）。定性：**PRD Functional Gap**。PRD 未规定其具体页面形态/步骤看板/份量换算，V1.3 只冻结缺口本身。
7. **手动快速记录与库存联动**：原 PRD 只规定「计划完成→preview→确认→扣减」；手动新增记录是否联动库存 PRD 未定死。**列为 D-xx Decision Required，不在 Baseline 中替用户决定。** 删除 V1.2 Target Flow 中「保存 CONFIRMED ＋ 可选库存扣减 checkbox」的预设结论。
8. **手动记录路径** [IMPL]：`createRecord` 默认 `CONFIRMED`（meal-records/service.ts:145–155），前端显式传 `CONFIRMED`（RecordsPage.vue:201–212）；不触发库存扣减。
9. **计划完成路径** [IMPL]：`completePlan` 生成 `DRAFT` 记录并将计划置 `COMPLETED`（meal-plans/service.ts:194–251）；后端返回 `inventoryDeductionPromptEnabled` 但前端未读取（MealPlansPage.vue:217–225, 342–345）。
10. **库存扣减只有一条安全链**：`POST /records/:id/consumption-preview` → 用户确认 → `confirmConsumption`（consumption/service.ts:60–291）；手动记录与 `/records/:id/confirm` 旁路均不扣库存。
11. **「今日推荐菜谱」** [IMPL]：`deletedAt=null AND enabledForRecommendation=true ORDER BY createdAt ASC LIMIT 6`（dashboard/service.ts），即**最早创建且仍参与推荐的前 6 条**。此事实只写入审计证据；不得建议 UI 对用户说「这是你最早创建的 6 道菜」。
12. **移动端导航四栏「首页/厨师/觅食/日记」为 V2 PRD 明确条款**（4.2 节），改名不得由审计/整改代理擅定，列 Decision Required。
13. **8787 端口固定**：只优化占用时的用户可读提示，禁止自动换端口。
14. **/backup 路由存在但无 UI 入口**；V2 PRD 设置范围（品牌/推荐偏好/食用者/PIN/备份恢复/数据导出/LAN/AI 配置）与 Onboarding「可在设置中重新打开」在 Settings 页均缺入口，列为 **PRD IA Gap**。

---

## 5. PRD vs IMPL vs UX Recovery Decisions

| 主题 | [PRD] V2 要求 | [IMPL] 当前现状 | [UX-D] 整改决策 |
|---|---|---|---|
| 随机入口 | 直接推荐/条件推荐（L538–547) | 首页快捷卡 + 推荐页按钮 | 无可争议保留 |
| 转盘/可视决策器 | **无**（亦无 archive 可引用为现状）| 只有「生成推荐」按钮 + 「摇一摇」假文案 | **UX-D：转盘式轻量可视决策器**（原则：轻量、快速、明确停定、不拖慢决策；具体时长 UX-A 实测决定，不作硬指标；不做大型游戏动画）；移动端摇一摇仅作辅助触发 |
| 「就吃这个」 | 无此按钮 | 无 | **UX-D**：结果页新增，允许作为不经过 Plan 的即时用餐入口；不得删除/替代/破坏原 Plan 流程；涉库存仍必须 preview → 用户确认 → confirmConsumption |
| 「开始制作」 | 菜谱详情操作项（L843) | **未实现** | UX-A 补齐入口；页面形态留给 UX-A 技术/交互设计 |
| 重复周期 | 硬条件排除（RECO-008) | 仅降权 -40 | Recommendation Functional Recovery |
| 餐次多选 | 多选（RECO-002) | 单选 | Recommendation Functional Recovery |
| 移动端四栏 | 首页/厨师/觅食/日记（4.2) | 一致 | 改名与否列 Decision Required |
| 桌面一级导航 | 9 项（4.1) | 12 项 | UX-C 归并/保留逐项裁决 |
| Backup/Export/Onboarding 重开 | 设置页范畴（4.1 设置/3.3 ONBOARD-004) | 功能在后端/路由存在，无 UI 入口 | UX-C 补入口，IA Gap |
| 到店/外卖 | 获取方式之一（RECO-003）+ 觅食模块（4.2) | 后端 STORE 候选已实现，前端推荐页未暴露 | 保留范围；UX-A 只主攻「自己做」 |

---

## 6. Product Core Model

### Current Model（当前真实模型）

1. 菜谱由用户手工录入；「参与推荐」是编辑表单末尾一个 checkbox，入口隐蔽。
2. 随机 = 点「生成推荐」→ 后端按餐次+参与推荐+忌口硬过滤+加权打分返回 1 条；候选池用户不可见。
3. 推荐结果页操作只有：喜欢这组结果 / 缺料加入购物清单 / 整组加入计划 / 查看详情。
4. 记录两条路径语义不一致：手动记录直接 `CONFIRMED` 不扣库存；计划完成生成 `DRAFT` 需另行 preview→confirm 才扣库存。
5. 统计、首页、日历只认 `CONFIRMED`；日历同时展示计划/草稿/正式记录三种标记。
6. 获取方式（到店/外卖）在后端存在 STORE 候选，但前端推荐页未暴露，普通用户感知不到。

### Target V1 Model（目标模型）

1. 用户自己的菜谱是「自己做」场景的核心资产；候选池在「今天吃什么」页可见（数量 + 列表 + 管理入口 + 去新增）。候选池不只服务随机，也服务条件推荐。
2. 核心交互 = 转盘式轻量可视决策器 **[UX-D]**：启动→轻旋转→停定结果→明确动作。
3. 结果页动作集合（UX-A 范围）：**就吃这个 / 换一个 / 加入计划 / 查看详情**；收藏、标记不想吃等归入推荐后续阶段。
4. 「就吃这个」→ 「完成这一餐」流程 → 形成饮食记录 → 如涉及库存走既有 preview→用户确认→confirmConsumption 安全链，**不静默扣减、不绕过确认**。
5. Plan → 生成草稿 → 确认 → 扣库存的原 PRD 链路完整保留；「就吃这个」作为不经过 Plan 的即时用餐入口，不得删除、替代或破坏原 Plan 流程；对用户只呈现「完成这一餐/记录成功」语言，DRAFT/CONFIRMED 字样不出现。
6. Primary Journey = 自己做饭；到店/外卖保留在既有产品范围内，不删减。

---

## 7. Primary UX Recovery Journey

UX-A 的第一优先级是 **「自己做饭」** 链路：

新增菜谱 → 让它参与随机 → 「今天吃什么」转盘 → 就吃这个 → （需做时）开始制作 → 完成这一餐 → 记录 + 库存按安全规则确认扣减 → 首页/日历/统计同步。

选它的原因：真实用户当前核心使用场景、且是当前断点最密集的位置；不是降格到店/外卖，而是固定主攻方向。

---

## 8. Existing Product Scope

以下属 PRD 已有范围，**不因 UX-A 聚焦而缩窄**：到店（觅食/店铺）、外卖、食用者管理、收藏、购物清单、厨房工具、统计、备份/恢复、数据导出、PIN、LAN/二维码、Onboarding。这些模块的问题按各 Phase 处理或在 Recommendation Functional Recovery 中处理。

---

## 9. Current Recommendation Logic（[IMPL]，仅写实测事实）

- **Random**（POST /api/v1/recommendations/random）：候选 = Recipe(`deletedAt=null, enabledForRecommendation=true`，可按 mealType/favoriteOnly 过滤）+ Store（supportsDineIn/Takeout）；硬过滤 = 忌口/过敏词（来自食用者）+ 必备工具缺失；inventoryOnly 可硬排除缺料菜谱；打分 = 收藏+30、库存齐+25、近期吃过 -40、有结构化食材+5；加权随机选 1。
- **Meal-set**（…/meal-set）：同候选（强制 RECIPE），按 MAIN/SIDE/STAPLE/SOUP/DRINK 角色各挑一道。
- **Kitchen/库存推荐**（POST /api/v1/kitchen/recommend）：按临期/开封/超上限/优先消耗打分，支持「只用现有库存/允许补购/优先消耗」三模式与指定必消耗食材。
- **Dashboard 今日推荐**：最早创建且参与推荐的前 6 条菜谱。
- **前端暴露**（RecommendationsPage）：只有 推荐方式 / 单餐次 / 加入计划日期 / 人数 / 食用者多选；后端其余参数（repeatDays、inventoryOnly、favoriteOnly、acquisitionModes、sourceTypes）**无任何 UI**。其中日期与人数仅用于「整组加入计划」。
- **推荐历史**（RECO-011 对齐项）：candidateCount / filters / accepted / addedToPlan 已写入 RecommendationHistory（recommendations/service.ts save/markRecommendation，**仅 Random 与 Meal-set 两通道**；Kitchen/库存推荐不写历史，其 candidateCount 仅是响应字段，不构成历史持久化）。

---

## 10. Recommendation PRD Compliance Matrix

R=Random，M=Meal-set，K=Kitchen/库存，D=Dashboard。Status 明确定义：Implemented＝后端实现且（如属用户规则）前端可用；Backend-Only＝后端有参数/逻辑但前端无入口；Partial＝实现语义不完整；Not Implemented＝无实现；N/A。

| # | Rule（V2 PRD） | R | M | K | D | Status |
|---|---|---|---|---|---|---|
| 1 | 直接推荐/条件推荐双模式 | 有（条件面单薄） | 同左 | — | — | Partial |
| 2 | 餐次筛选（多选） | 单选 | 单选 | 无 | 无 | **Partial（多选未实现）** |
| 3 | 获取方式多选 | Backend-Only | N/A | N/A | 无 | **Backend-Only** |
| 4 | 标签筛选 | 无 | 无 | 无 | 无 | Not Implemented |
| 5 | 重复周期（硬排除） | 降权≠排除 | 同左 | 无 | 无 | **Partial（语义错误，PRD Gap）** |
| 6 | 想吃关键词 | 无 | 无 | 无 | 无 | Not Implemented |
| 7 | 不想吃关键词（硬条件） | 无 | 无 | 无 | 无 | Not Implemented |
| 8 | 随机程度三档（普通/完全随机/尝鲜） | 仅固定加权 | 同左 | 无 | 无 | Partial（仅"普通"近似） |
| 9 | 食用者忌口硬过滤 | ✅ | ✅ | ✅ | 无 | Implemented（除 D） |
| 10 | 食用者过敏硬过滤 | ✅ | ✅ | ✅ | 无 | Implemented（除 D） |
| 11 | 必须消耗指定食材（硬条件） | 无 | 无 | ✅ | 无 | Partial |
| 12 | 必须具备厨房工具（硬条件） | ✅ | ✅ | ✅ | 无 | Implemented（除 D；K 经只读核实为缺工具硬过滤，inventory/service.ts 候选过滤） |
| 13 | 仅用已有食材（硬条件） | Backend-Only | 无 | ✅ | 无 | **Backend-Only（R）/ Implemented（K）** |
| 14 | 收藏软权重 | ✅(+30) | ✅ | 无 | 无 | Implemented（软权重） |
| 15 | 仅收藏筛选（favoriteOnly） | Backend-Only | 无 | 无 | 无 | **Backend-Only** |
| 16 | 个人评分加权 | 无（Store rating 有 +rating×4） | 同左 | 无 | 无 | Partial |
| 17 | 库存匹配度加权 | ✅(+25/缺料标记） | ✅ | ✅ | 无 | Implemented（除 D） |
| 18 | 即将过期食材优先 | 无 | 无 | ✅(wasteScore) | 无 | Partial |
| 19 | 最近未吃 | ✅(-40) | ✅ | 无 | 无 | Partial（与 #5 重复周期混用） |
| 20 | 最近未推荐 | 无 | 无 | 无 | 无 | Not Implemented |
| 21 | 新尝试加权 | 无 | 无 | 无 | 无 | Not Implemented |
| 22 | 历史接受率加权 | 无 | 无 | 无 | 无 | Not Implemented |
| 23 | 推荐理由 | 简陋文案 | 同左 | 有缺料/临期说明 | 无 | Partial |
| 24 | 命中条件展示 | 无 | 无 | 无 | 无 | Not Implemented |
| 25 | 可消耗库存展示 | 无 | 无 | Partial | 无 | Partial |
| 26 | 最近食用时间展示 | 无 | 无 | 无 | 无 | Not Implemented |
| 27 | 评分展示 | 无 | 无 | 无 | 有（聚合） | Partial |
| 28 | 标签展示 | 无 | 无 | 无 | 有 | Partial |
| 29 | 缺少食材展示 | ✅ | ✅ | ✅ | 无 | Implemented（除 D） |
| 30 | 加入计划 | ✅ | ✅ | 经结果页 | 无 | Implemented |
| 31 | 换一个 | 无（重点按钮重来但无单条语义） | 无 | 无 | 无 | **Partial（无显式"换一个"）** |
| 32 | 收藏（结果即收藏） | 无 | 无 | 无 | 无 | Not Implemented |
| 33 | 查看详情 | ✅ | ✅ | ✅ | ✅ | Implemented |
| 34 | 标记不想吃 | 无 | 无 | 无 | 无 | Not Implemented |
| 35 | 缺料加入购物清单 | ✅ | ✅ | ✅ | 无 | Implemented |
| 36 | 推荐历史 | ✅ | ✅ | 无 | 无 | Implemented（R/M）；Not Implemented（K/D） |
| 37 | 推荐条件历史保存 | ✅(filtersJson) | ✅ | 无 | 无 | Implemented（R/M）；Not Implemented（K/D） |
| 38 | candidateCount | ✅ | ✅ | 仅响应值 | 无 | Implemented（R/M 持久化）；K 仅存于响应、不等于历史持久化 |
| 39 | accepted 标记 | ✅ | ✅ | 无 | 无 | Partial（UI「喜欢」语义需核） |
| 40 | addedToPlan 标记 | ✅ | ✅ | 无 | 无 | Implemented |

**总结论**：PRD 推荐能力大量 Not Implemented / Backend-Only / 语义不符；这不是 UX 打磨，是 **PRD Functional Gap**，需单独的 Recommendation Functional Recovery 阶段（见 §21），不得塞进 UX-A。

---

## 10A. Meal-set PRD Compliance Matrix（MEALSET-\* 专项，不复用 RECO-\* 口径）

依据 V2 PRD 6.2 节（MEALSET-001~004，docs/PRD.md L677–717）逐条核对，实现证据为 `recommendations/service.ts:224–234`（mealSetRecommendation）与 `RecommendationsPage` 结果区。

**MEALSET-001 输入条件**

| PRD 要求 | 实现 | 判定 |
|---|---|---|
| 餐次 | `mealType` 单选（前端单选） | Partial（PRD 语境下单选即满足输入；多选缺口记在 RECO-002） |
| 食用人数 | 推荐入参无 dinerCount（仅在「加入计划」时填写） | Not Implemented（输入条件） |
| 获取方式 | 强制 `sourceTypes=['RECIPE']`，不支持到店/外卖套餐 | Not Implemented |
| 可用总时间 | 无此参数 | Not Implemented |
| 是否只使用库存 | `inventoryOnly` 后端生效，前端无入口 | Backend-Only |
| 是否允许购买 | `allowPurchase` 仅存在于入参类型，service 未使用（死参数） | Not Implemented |
| 标签 | 无 | Not Implemented |
| 忌口 | 食用者忌口/过敏硬过滤生效 | Implemented |
| 是否需要主食 / 是否需要汤品 | 无开关；固定按 MAIN/SIDE/STAPLE/SOUP/DRINK 顺序各挑一道，有候选才进 | Not Implemented |

**MEALSET-002 输出结构**：主菜/配菜/主食/汤品或饮品角色齐备（MAIN/SIDE/STAPLE/SOUP/DRINK），不强制齐全（无候选即缺该角色）——**Implemented**。

**MEALSET-003 结果信息**：总制作时间——无；可用库存——无（仅有缺料）；缺少食材——✅；简要制作顺序——无；预计可消耗数量——无。**→ Not Implemented（仅缺料一项）**。

**MEALSET-004 操作**：整套加入计划 ✅（Implemented）；替换单项——无（Not Implemented）；锁定单项——无（Not Implemented）；收藏套餐——无（Not Implemented）；缺少食材加入购物清单 ✅（Implemented）。

**小结**：Meal-set 仅覆盖角色组装 + 忌口过滤 + 加入计划/购物清单两个操作；输入条件与结果信息大半缺位，全部归入 Recommendation Functional Recovery，不进 UX-A。

---

## 11. Recommendation Gap Classification

- **Backend Rule Gap（规则未实现/语义错误）**：重复周期硬排除、想吃/不想吃、随机程度三档、标签筛选、最近未推荐、新尝试、历史接受率加权、尝鲜权重、多餐次。
- **Frontend Exposure Gap（后端有参数，前端无入口）**：获取方式、inventoryOnly（R 通道）、favoriteOnly、repeatDays、sourceTypes。
- **Result UX Gap（结果展示与操作缺）**：命中条件、可消耗库存、最近食用时间、评分、标签、推荐理由质量、换一个（显式）、收藏、标记不想吃。

---

## 12. Seven Parent Problems

### M1 — 推荐结果无法自然进入「完成这一餐」 —— **PX0**
- 影响：出结果后无路可走；用户不知下一步。
- 根因：结果页缺「就吃这个/换一个」；「开始制作」未实现；Plan→Draft 链路无引导。
- 证据：RecommendationsPage.vue 结果区按钮集合；meal-plans/service.ts:194–251；MealPlansPage.vue:342–345。
- 方向：UX-A 补「就吃这个/换一个」+「完成这一餐」用户层语言收敛 + 补「开始制作」缺口。

### M2 — 首页核心记录入口失效 —— **PX0**
- 影响：首屏无法记录「我吃了什么」、无法进日历；移动端无任何相关入口。
- 根因：今日饮食记录卡/三餐行无事件；移动端「+」为 `::after` 伪元素；`.inline-action`/`.calendar-actions` 在 max-width:1023px 下被 `display:none`；首页日历日格纯 div。
- 证据：HomePage.vue:329–358、423–455；styles/homepage.css:1244–1257 及对应 media query。
- 方向：UX-B 接通首页记录/日历入口，移动端恢复关键入口。

### M3 — 「摇一摇」假文案 + 无决策仪式感 —— **PX1**
- 影响：用户不知该摇还是该点；无仪式感。
- 根因：页面文案写「准备好摇一摇了吗」，无任何 shake/转盘实现。
- 证据：RecommendationsPage.vue:239；V2 PRD 无转盘条款（L538–547）。
- 方向：**[UX-D] 转盘式轻量决策器**——轻量、快速、明确停定、不阻塞决策；旧档 500–900ms 仅作历史设计参考，不冻结为新转盘的验收硬指标，具体时长 UX-A 实测决定；移动端摇一摇仅作辅助触发。非 PRD 恢复，是 UX Recovery 新决策。

### M4 — 「今日推荐菜谱」名不副实且来源不透明 —— **PX1**
- 根因：Dashboard 固定取最早创建的前 6 条；无任何来源说明。
- 证据：dashboard/service.ts 推荐查询。
- 方向：UX-C 文案收口为「来自我的菜谱 / 菜谱灵感」类诚实文案+管理入口；算法升级归 Recommendation Functional Recovery（不塞 UX-A）。

### M5 — Plan→Record→Consumption 状态机暴露给用户且无引导 —— **PX1**
- 根因：DRAFT/CONFIRMED/完成并生成草稿/库存预览确认等内部概念直接出现在用户界面；两条记录路径语义不一致。
- 证据：meal-records/service.ts:145–155、194–225；consumption/service.ts:60–291；RecordsPage/MealPlansPage 界面文案。
- 方向：保留底层状态机与安全语义，用户层语言收敛为「完成这一餐/记录成功」。

### M6 — 信息架构与图标语义不清 —— **PX1**
- 包含：桌面 PRD 9 项 vs 实现 12 项（IA Deviation）；移动端四栏命名理解成本（Decision Required）；顶部铃铛/日历/头像圆圈误读；/backup、export、Onboarding 重开无入口。
- 证据：DesktopSidebar（12 项）；router/index.ts L59；docs/PRD.md L205–219、4.2 节。
- 方向：UX-C 逐项裁决归并/补入口；Dashboard 圆圈的语义澄清。

### M7 — 全局视觉过大且偏正式 —— **PX2**
- 根因：H1 clamp(24px,3vw,36px)、设置页 H2 24px、标题与正文共用正式系统 sans、英文 eyebrow 贯穿全站。
- 证据：tokens.css、main.css、各页页头。
- 方向：UX-D 落实 Typography & Visual Baseline（含标题字族方向评估，非仅缩字号）。

> PX0 全篇仅有 M1、M2；任何模块级严重度一律继承 Parent Problem，不得另造 PX0。

---

## 13. Current User Flow

```
[首页]
 ├─ 快捷入口 →[/recommendations?mode=random]→「生成推荐」→ 结果
 │    ├─ 喜欢这组结果（写历史标记）
 │    ├─ 缺料加入购物清单
 │    └─ 整组加入计划 →[/plans]→「完成并生成草稿」→ DRAFT 记录
 │          └─ （无引导）→ 需自行到[/records]→该 DRAFT 点「预览并确认」
 │               → 库存 preview → 用户确认 → confirmConsumption → 扣库存/缺料入购物 → CONFIRMED
 ├─ 今日饮食记录卡/三餐行 → 不可点；桌面仅「查看饮食记录」链接，移动端被隐藏
 ├─ 移动端「+」→ 伪元素，无任何行为
 ├─ 首页日历区 → 日格不可点；上周/下周仅换数据（移动端被隐藏）
 ├─ 侧边栏（桌面 12 项 / 移动四栏）直达各业务页
 └─ /backup 等路由存在但无入口
```

---

## 14. Target User Flow V1

```
[首页]
 ├─ 今天吃什么 → 转盘式决策器([UX-D])
 │    ├─ 可见候选数/候选列表 + 「管理候选菜」
 │    ├─ 启动（点击；移动端可摇）→ 轻量旋转 → 停定结果
 │    └─ 结果：[就吃这个] [换一个] [加入计划] [查看详情]
 ├─ 就吃这个 → 完成这一餐
 │    ├─ 若为「自己做」菜谱 → 可先进入「开始制作」
 │    ├─ 形成饮食记录
 │    └─ 涉库存 → preview → 用户确认 → confirmConsumption → 扣减/缺料入购物
 ├─ 已吃完快速记录 → 首页餐次行/+ → 记录表 → 保存
 │    （※ 是否联动库存：D-09 Decision Required）
 ├─ 饮食日历 → 首页日历区可点 → 日历页 → 某日 → 当日计划/记录
 └─ 今日推荐 → 「来自我的菜谱」说明 + 管理入口
```

Plan→Draft→确认 的 PRD 主链路原样保留；上图只是把用户路径收敛。

---

## 15. 「开始制作 / 就吃这个 / Plan / Record / Consumption」关系

- **开始制作** [PRD gap]：菜谱详情应有的操作，当前未实现。冻结范围仅限：进入适合实际做菜的制作视图，至少清楚呈现菜谱、食材、制作步骤，并能自然进入「完成这一餐」。页面/弹层/步骤引导的形态由 UX-A 设计决定，本基线不预设。
- **就吃这个** [UX-D]：推荐结果页的快速入口，进入「完成这一餐」流程；**不等于**开始制作，不强制经过它。
- **关系链**（对「自己做」）：推荐/转盘 → 就吃这个 →（可选）开始制作 → 做完 → 完成这一餐（记录+库存确认）。
- 对「到店/外卖」结果：就吃这个 → 完成这一餐（记录来源为到店/外卖），**不进入**开始制作。
- **Plan**：原有的「加入计划→完成计划→生成草稿→预览→确认→扣减」不变；「就吃这个」只是并行入口，不替代、不删除 Plan 流程。
- **Consumption 安全链**：任何入口下库存扣减都必须经过 preview + 用户确认；库存不足/单位不可换算/关联异常时不得静默扣减。

---

## 16. Page Impact Matrix

| 页面 | 相关母问题 | 当前状态[IMPL] | 整改阶段 |
|---|---|---|---|
| 首页 | M2、M3、M7 | 记录/日历不可点、伪「+」 | UX-B、UX-D |
| 今天吃什么/推荐 | M1、M3、M4 | 无转盘、无就吃这个/换一个操作 | UX-A（核心）；高级筛选归 Rec-Recovery |
| 菜谱列表/编辑/详情 | M1、M4 | 详情缺「开始制作」；参与推荐入口隐蔽 | UX-A、UX-B |
| 食材库存 | M5 | 功能在；默认单位表单引导弱 | UX-B |
| 饮食计划 | M1、M5 | 完成→DRAFT 无后续引导 | UX-A、UX-B |
| 饮食记录 | M2、M5 | 手动路径 CONFIRMED 不扣库存；术语外露 | UX-B |
| 饮食日历 | M2、M6 | 首页区块不可点 | UX-B、UX-C |
| 设置 | M6、M7 | 保存按钮置顶、Backup/Export/重开向导无入口 | UX-C、UX-D |
| 统计分析 | M7 | 空态无引导 | UX-E |
| 收藏夹 | M6 | 与推荐联动弱 | UX-E |
| 觅食（店铺） | M6 | PRD 模块在；推荐结果里存在感弱 | UX-E（命名另行裁决） |
| 厨房工具 | M6 | 页面存在，价值不明 | UX-E |
| 购物清单 | M5 | 缺料自动加入可用 | UX-E |
| 备份/恢复 | M6 | 功能在、无入口 | UX-C |
| Onboarding | M6 | 首次有；设置中不能重开 | UX-C、UX-E |

---

## 17. Secondary Modules Coverage Matrix

状态定义：Implementation = Implemented / Partial / Not Implemented / Unknown；UX Audit = Audited OK / Audited Issues / Partially Audited / Not Yet UX Audited。

| Module | PRD In Scope | Implementation | UX Audit | Known Gap | Parent Problem | Phase |
|---|---|---|---|---|---|---|
| 菜谱 CRUD | 是 | Implemented | Audited Issues | 表单重、参与推荐隐蔽 | M4 | UX-B |
| 开始制作 | 是 | **Not Implemented** | Audited Issues | PRD Gap 详情页无操作 | M1 | UX-A |
| 店铺/到店/外卖 | 是 | Implemented | Partially Audited | 推荐前端未暴露获取方式 | M6/Rec-Gap | UX-E + Rec-Recovery |
| 食用者 | 是 | Implemented | Audited Issues | 入口仅在设置 | M6 | UX-C |
| 收藏夹 | 是 | Implemented | Partially Audited | 结果页直接收藏缺失（Rec Gap） | M6 | UX-E |
| 库存 | 是 | Implemented | Audited Issues | 新增表单默认单位引导 | M5 | UX-B |
| 厨房工具 | 是 | Implemented | Not Yet UX Audited | 用户价值未传达 | M6 | UX-E |
| 购物清单 | 是 | Implemented | Partially Audited | 空态与解释弱 | M5 | UX-E |
| 计划 | 是 | Implemented | Audited Issues | 完成无后续引导 | M1/M5 | UX-A/B |
| 记录 | 是 | Implemented | Audited Issues | 手动路径不扣库存、术语外露 | M2/M5 | UX-B |
| 日历 | 是 | Implemented | Audited Issues | 首页区不可点 | M2 | UX-B |
| 统计 | 是 | Implemented | Audited Issues | 仅认 CONFIRMED，空态弱 | M7 | UX-E |
| 备份/恢复 | 是 | Implemented | Audited Issues | **无 UI 入口** | M6 | UX-C |
| 数据导出 | 是（PRD 21.1 列为独立 `GET /export` 能力） | **Not Implemented**（仅有备份导出 `/backups/export`，无 PRD 独立数据导出实现） | Not Yet UX Audited | PRD Functional Gap；设置页亦无任何入口 | M6 | UX-C |
| 回收站 | 是 | Implemented | Partially Audited | 仅设置内入口 | M6 | UX-C |
| PIN/安全 | 是 | Implemented | Audited OK | — | — | — |
| LAN/二维码 | 是 | Implemented | Audited Issues | 位置深 | M6 | UX-C |
| 全局搜索 | 是 | Implemented | Partially Audited | 覆盖面有限 | M6 | UX-E |
| Onboarding | 是 | **Partial**（首次向导存在；ONBOARD-004 要求可从设置重开，当前无此入口） | Partially Audited | 设置中不能重开（PRD Gap） | M6 | UX-C/E |
| AI 可选配置 | 是（可选，PRD 3.1 / 设置范围） | **Not Implemented**（已只读核实：无 AI 配置/凭据/调用代码，RECIPE-EDIT-005 的本地关键词规则亦未发现实现） | Not Yet UX Audited | 无任何能力痕迹 | M6 | UX-C |
| 首次空态 | 是 | Partial | Audited Issues | 多为纯文字无 CTA | M7 | UX-E |

---

## 18. Typography & Visual Baseline

- **字号**：Desktop：H1 28 / H2 20 / 卡片标题 17 / 正文 15 / 辅助 12–13 / 按钮 15。Mobile：H1 22 / H2 18 / 卡片 16 / 正文 14–15 / 辅助 12–13 / 按钮 14–15。
- **字族**：正文保持系统中文高可读字体；**标题必须做一次更温暖、圆润、生活化的中文 Display 字族方案评估**（UX-D 定夺；不下载新字库、不引外部依赖）；不允许最终仍以同一套正式 sans 同时承正文与主标题。
- **密度**：字号下降的同时收紧卡片体量与 padding，**适度提高信息密度**，不是缩小字号再放大留白。
- **图标**：设置齿轮轴向修正（用户感知歪斜需复核 viewBox/stroke 中心）；icon-only 按钮配文字标签或 tooltip；触区 ≥44px。
- **设置页**：标题字号下调；保存操作置于用户完成编辑后自然可见的位置（移动端 sticky bottom；桌面页面底部 action，是否 sticky 由 UX-D 视实际页长决定）；顶部圆圈（头像）与设置语义分离（Decision D-06）。

---

## 19. Mobile / Desktop IA Rules

- **移动端四栏**（首页/厨师/觅食/日记）为 V2 PRD 明条款（4.2）：UX Recovery **不得直接改名**，只列 Decision Required（D-01/D-07）请在 UX-C 拍板。
- **桌面侧边栏**：PRD 9 项、实现 12 项，判定为 **Current IA Deviation**；UX-C 逐项裁决哪些恢复为二级结构、哪些保留一级入口。
- **顶部**：桌面保留搜索/库存铃铛/日历/用户圆圈+昵称，圆圈须明确为用户菜单（含「设置」项）；移动端品牌栏仅保留设置齿轮；任何情况下不出现两个含义不明的圆形图标。
- **/backup、导出、Onboarding 重开、Diners**：UX-C 补 Settings 内入口。

---

## 20. UX Recovery Roadmap

### UX-A — Core Decision / Meal Completion（冻结范围）
候选池可见与管理入口；转盘式决策器 **[UX-D]**（轻量、快速、可停、不阻塞）；结果页四动作（就吃这个/换一个/加入计划/查看详情）；补齐「开始制作」入口（仅冻结缺口与最小语义）；「完成这一餐」用户层语言收敛；一切库存动作走既有 preview→confirm 安全链。
**明确不做**：推荐算法重写、整体视觉重做、导航大改、次级模块大修、任何新后端模型的臆造实现。

### UX-B — Home / Record / Calendar
首页今日记录卡、三餐行、移动端真实「+」、日历区全部接通；移动端恢复被隐藏的入口；快速记录表单进入流；完成这一餐后首页/日历/统计的即时同步；设置 D-09 落地后的记录-库存联动行为。

### UX-C — Information Architecture
桌面 9 vs 12 项归并裁决；移动端四栏命名裁决（Decision）；Settings 补 Backup/Export/Diners/Onboarding 重开入口；顶部用户圆圈语义澄清；今日推荐文案+入口；候选管理入口落位。

### UX-D — Visual System
Typography Baseline 全面落地（含标题字族方向评估）、卡片密度、图标对齐与触区、Settings 页（字号 + 保存位置）、中英文混排清理。

### UX-E — Secondary UX / Copy
空态 CTA 全量；英文 eyebrow 与工程术语（DRAFT/CONFIRMED/冲突保护等）清理；统计、工具、购物、收藏、觅食等次级页面体验；Onboarding 深度。

### UX-F — Real Product Acceptance
至少 **1 台真实手机**走完整主 Journey（禁止模拟器替代）；桌面同时走通；视觉与交互按 Baseline 验收。

---

## 21. Recommendation Functional Recovery（独立阶段，不入 UX-A）

触发依据：§10 矩阵大量 Partial / Not Implemented / Backend-Only / 语义错误。
候选内容（优先级由用户在 UX-A/B 完成后决定）：重复周期硬排除、多餐次、想吃/不想吃、标签筛选、随机程度三档、最近未推荐、新尝试、历史接受率加权、结果完整展示字段（命中条件/可消耗库存/最近食用时间/评分/标签）、换一个的显式语义、收藏、标记不想吃、推荐前端筛选区补全。
适合作为 UX 阶段之后的独立 Product/Engineering 阶段，不允许夹带进 UX-A。

---

## 22. Decision Required List

| ID | 主题 | PRD/现状 | 候选方案 | 拍板阶段 |
|---|---|---|---|---|
| D-01 | 移动端四栏命名 | PRD：首页/厨师/觅食/日记 | A 保留+辅助提示；B 口语化改名（需用户选词） | UX-C |
| D-02 | 今日推荐定位 | 实现=最早前6条 | A 文案诚实化+管理入口；B 后续真升级推荐 | UX-C |
| D-03 | 「就吃这个」流程形态 | PRD 无 | A 直进确认页；B 先确认份数/日期再进 | UX-A |
| D-04 | 设置保存按钮位置 | 当前置顶 | A 移动 sticky 底 + 桌面底部；B 全端 sticky 底 | UX-D |
| D-05 | 标题字族 | 当前系统 sans | A 系统字+字重层级优化；B 本地静态圆润中文字（资产审核后） | UX-D |
| D-06 | 顶部圆圈语义 | 当前=头像 | A 昵称文字化入口；B 头像+「账号」标签；C 移动仅齿轮 | UX-C |
| D-07 | 「觅食」命名 | PRD 用词 | A 保留；B 改「店铺/外卖·到店」 | UX-C |
| D-08 | 「开始制作」形态 | 仅 PRD 操作项 | A 简洁步骤视图；B 含份量换算与完成入口的引导流程 | UX-A |
| D-09 | 手动快速记录是否联动库存 | PRD 未定 | A 只记录（同现状）；B 保存后询问是否进入库存 preview；C 由设置项决定默认 | UX-B |
| D-10 | 真实手机验收设备数 | — | A 1 台真实手机（最低）；B 各 1 台 iPhone+Android | UX-F |

---

## 23. Definition of Product Done

Product Done 必须同时满足：

1. **Engineering Gate PASS**（既有 CI/测试/打包红线不下降）；
2. **PRD Functional Compliance**——本基线认定的必修 Gap 关闭（开始制作、Settings/Backup 入口、IA 归位等）；Recommendation Gap 有关闭结论或正式的 Deferred Decision；
3. **Core User Journey PASS**——§14 主链路在无说明书情况下完成，库存经 preview→确认安全链；
4. **Real User Mobile PASS**——至少 1 台真实手机完整通过（**UX Gate 与兼容性 Gate 分离**：PRD 声明的 iPhone Safari / Android Chrome 兼容范围仍须满足，缩减需用户明确批准）；
5. **Visual / Interaction PASS**——字体、字号、密度、图标、空态、设置页、触区全部达标。

以下信号单独均不能证明产品完成：CI green、210/210 tests、API PASS、Windows package PASS。

---

## 24. Subagent Cross-Audit Disclosure

本轮（V1.3）+前两轮累计调度只读交叉审计子代理共 **7 次调用尝试：2 次成功，5 次失败**（V1.1 三次：1 成功 2 失败；V1.2 三次：全失败；V1.3 一次：成功）。全文只保留本口径，不再出现其他计数。

| 轮次 | 任务 | 结果 | 处理 |
|---|---|---|---|
| V1.1 | Record/Plan/Consumption 状态机复核 | **成功** | 全部采纳（状态机事实、计划完成无弹层等） |
| V1.1 | 主报告严重性复查 | 失败（model request failed） | 披露，主代理自核 |
| V1.1 | PRD 转盘原设计 | 失败（model request failed） | 披露，主代理自核 |
| V1.2 | PRD 开始制作+推荐矩阵 / V1.1 一致性 / 次级模块 | 3 次全部失败（captcha/stream） | 披露，主代理自查补齐 |
| V1.3 | V2 PRD 推荐规则+导航原文速查 | **成功** | 采纳：V2 无转盘条款、桌面 9 项、重复周期属硬条件等原文证据 |

裁决原则：任何子代理失败均如实披露并由主代理以源码+PRD 原文+真实 Journey 直接核实代替；最终事实、严重度、范围均由 Kimi-K3 主代理统一裁决，不拼接子代理输出。

（注：计数口径唯一——V1.1 共 3 次（状态机复核成功 1、主报告复查失败 1、转盘原设计失败 1，失败后未重试）、V1.2 共 3 次（三个任务各 1 次、全部失败）、V1.3 共 1 次（成功）；合计 7 次调用尝试，2 成功 5 失败。）

---

## 25. Final Consistency Check（逐项已过）

- archive 未被当正式 PRD：转盘已改标 [UX-D]，旧档「轻动画」仅作历史参考引用；
- 转盘不再被写成 PRD 要求；
- 桌面导航明确写「PRD 9 项 / 实现 12 项 / Current IA Deviation」；
- 重复周期改判硬条件 Gap（Partial/语义错误），不再称「已实现仅未暴露 UI」；
- 餐次多选标 Partial；
- 收藏软权重（+30，Implemented）与 favoriteOnly（Backend-Only）已分列；
- 「开始制作」只冻结 PRD 缺口，未发明步骤看板/份量换算等具体功能；
- 快速记录库存联动已抽出为 D-09，无预设 checkbox 结论；
- Secondary 矩阵已区分 Implementation 与 UX Audit 两列；
- Settings/Backup/Export/Onboarding 重开入口齐到位；
- 全篇 PX0 仅 M1、M2；模块级严重度均继承母问题；
- Primary Journey= 自己做饭，到店/外卖明确保留在 Existing Scope；
- 今日推荐内部算法只留在证据层，未建议作为用户文案；
- 真机 UX Gate 与 PRD 兼容性 Gate 已分开；
- 推荐前端暴露缺口（Frontend Exposure Gap）完整记录；
- Kitchen 推荐「必备工具硬过滤」已只读核实为 Implemented（缺工具硬排除）；Kitchen 推荐历史/条件持久化改判 Not Implemented，candidateCount 仅响应值；
- Meal-set 已按 MEALSET-\* 单列专项核对矩阵（§10A），不套用 RECO-\* 口径；
- 数据导出改判 Not Implemented（PRD 独立能力，非备份导出）；
- Onboarding 改判 Partial（首启向导在、设置重开入口缺）；
- AI 可选配置经只读核实改判 Not Implemented（无任何实现痕迹）；
- 「就吃这个」口径统一：允许不经过 Plan 的即时用餐入口，不删除/替代/破坏 Plan 流程，库存必经 preview→确认→confirmConsumption；
- 转盘时长不再冻结硬指标，仅保留「轻量、快速、明确停定、不拖慢决策」原则，具体时长 UX-A 实测；
- 子代理计数全文统一为 7 次调用（2 成功 5 失败）唯一口径；
- 错字已清理（草稿、RECO-011、换一个等）；
- 无新增 API/route/component 级技术方案；
- 全文无乱码、无中英混排杂质、无前后矛盾。

**Baseline V1.3（含 9 项已知修正）冻结。** 不再重新审计、不再有 V1.4。下一步直接进入 **UX-A**。