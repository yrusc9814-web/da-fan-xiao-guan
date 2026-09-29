# Google 2.0 接线记录

## 架构与范围

- `app/client/index.html` 保持 Google 2.0 DOM/CSS/视觉结构冻结；`public/google2-adapter.js` 只通过既有 `data-binding` 叶子节点、BentoService 方法和 BentoBus 事件接线。
- Fastify 静态托管继续使用 `app/client/dist`，API 前缀为 `/api/v1`。
- `BentoBus` 的真实事件名已由入口核对：`stores:changed` 监听 `renderStores()`，`recipes:changed` 监听 `renderRecipes()`（入口约 7487-7488 行）；适配器写入后发出这些事件，确保列表 UI 重绘，而不是只改 `service.data`。

## Endpoint → 服务 / Modal 映射

### stores

| 后端 | BentoService / Modal | 请求体与版本 |
|---|---|---|
| `GET /stores?page=&pageSize=` | `stores.reload` | 顺序读取所有页，完整结果才替换列表；空列表清除旧/seed 数据 |
| `GET /stores/:id` | `stores.getByIdRemote`；`storeDetail` 打开前调用 | 真实 DTO 映射后更新 cache，确保最新 `version` 传入 Modal |
| `POST /stores` | `stores.save({id: undefined})` | 只发送真实 Store schema 字段，不生成本地 id/date/random |
| `PUT /stores/:id` | `stores.save({id, version})` | body 带服务端缓存的 `version` |
| `DELETE /stores/:id` | `stores.delete(id)` | DELETE body `{version}` |
| `POST /stores/:id/favorite` | `stores.toggleFavorite(id)` | body `{favorite, version}` |

门店 DTO 仅映射 `imagePath/address/storeType/cuisine/averageCost/...`；`icon` 仅为 UI 缺省展示，不写回业务字段。后端没有门店菜单实体，`menuItems` 写入会明确报错 `STORE_MENU_UNSUPPORTED`，不会伪造成功。

### recipes

| 后端 | BentoService / Modal | 请求体与版本 |
|---|---|---|
| `GET /recipes?page=&pageSize=` | `recipes.reload` | 遍历 `totalPages`（兼容 total/pageSize）并一次性替换 |
| `GET /recipes/:id` | `recipes.getByIdRemote`；`recipeDetail` 打开前调用 | 真实 DTO 先更新 cache/version，再传原 Modal |
| `POST /recipes` | `recipes.save({id: undefined})` | ingredients 映射 `ingredientId/name/quantity/unit/optional/isPrimary`；steps 映射 `content/imagePath`；tags 仅发送字符串数组；mealTypes、mealRoles、toolIds 仅发送 UI 的真实值 |
| `PUT /recipes/:id` | `recipes.save({id, version})` | body 带最新 version |
| `DELETE /recipes/:id?version=` | `recipes.delete(id)` | version 在 query，不发送 DELETE body |
| `POST /recipes/:id/favorite` | `recipes.toggleFavorite(id)` | body `{favorite, version}` |

后端 Recipe DTO 没有 calories 字段；表单 calories 非空时提交被明确阻止并提示 `RECIPE_CALORIES_UNSUPPORTED`，不会静默丢弃。`cookCheckin` 仍统一封堵并提示“该功能尚未接通真实后端”；`addMissingIngredientsToShopping` 已解封（见 shopping 节末尾）。

### pantry（库存/食材）

| 后端 | BentoService / Modal | 请求体与版本 |
|---|---|---|
| `GET /ingredients?page=&pageSize=` | `pantry.reload` | 遍历 `totalPages`（兼容 total/pageSize）并一次性替换；空列表清除旧数据；`pantry:changed` 驱动 `renderInventory()` |
| `GET /ingredients/:id` | `pantry.getByIdRemote`；`ingredientDetail` 打开前调用 | 真实 DTO 映射后更新 cache，确保最新 `version` 供 delete 使用；失败 toast 且不打开 Modal |
| `POST /ingredients` | `pantry.save({id: undefined})`；legacy `handleIngredientFormSubmit` 走此路径 | body 只含后端 schema 字段：`name/imagePath/category/unit/minStock/maxStock/notes` + `batches:[{quantity,unit,purchaseDate,expiryDate,location,opened,consumePriority,notes}]`；数量/存放位置入批次，不生成本地 id/date |
| `PUT /ingredients/:id` | `pantry.save({id, version})` | body 带服务端缓存 `version`；后端 update 不接受批次字段，提交带 `batches` 或变更 `storageLocation` 时明确报 `INGREDIENT_BATCHES_UNSUPPORTED` |
| `DELETE /ingredients/:id?version=` | `pantry.delete(id)` | version 在 query，不发送 DELETE body（与 recipes 相同语义） |

库存 DTO → UI 映射（`mapPantryItem`）：`stock ← quantity`、`storageLocation ← location`、`expireDate ← expiryDate`、`expireDaysLeft ← expiryDate 与本地今日的差值`（纯展示派生，无日期时为 undefined）、`icon ← imagePath || '🥬'`、`unit ← 后端枚举的中文标签（GRAM→g、PIECE→个、PORTION→份、OTHER→空），原始枚举保留在 unitKey`。UI 表单单位（g/kg/个/根/块/盒/份/瓶/袋）映射到后端 QuantityUnit 枚举：g→GRAM、kg→KILOGRAM、个→PIECE、根/块→OTHER、盒→BOX、份→PORTION、瓶→BOTTLE、袋→BAG；未知值阻断并报 `INGREDIENT_UNIT_UNSUPPORTED`。表单「预计保质期(剩余天数)」按用户输入换算为 `expiryDate`（今天+N 天，本地日期）；无输入则发送 null，不伪造日期。

库存固定日期残留的处理：legacy `handleIngredientFormSubmit`（原写入固定 `expireDate: '2026-09-21'` 与本地生成 id/日期）已被 adapter 以真实 submit 覆盖，固定日期路径不再执行；`shopping.importCheckedToPantry`（另一处固定 `expireDate: '2026-09-18'`）已在本轮接线中改为真实入库流程，固定日期与本地 id 路径不再执行。入口 HTML 中 `ingredientDetail` 的静态默认日期文案属于视觉冻结范围，仅在详情未加载时可见，接通后会被真实 DTO 清空/覆盖。

 pantry 域保留 gap：`pantry.consume`（快捷消耗 100g/250g/全部用完）——后端 `POST /ingredients/:id/adjust` 是批次级精确调整（必须 `batchId`+`batchVersion`、单位需与批次可换算、无“全部用完”等价端点），UI 按钮固定克数且无批次选择，强行映射会伪造语义，故继续封堵提示“该功能尚未接通真实后端”。入口静态托管的 `GET /api/v1/inventory/logs`、`POST /api/v1/kitchen/recommend` 与 `GET /api/v1/ingredients/:id/logs` 暂无对应 UI 入口，未接线。后端没有食材 favorite 端点（favorite 仅 stores/recipes 存在）。`pantryRecommend`（智能配菜）与 `recipeDetail` 食材比对均为纯前端读取（recipes×pantry 名称/库存匹配），接通真实 pantry 数据后自然生效，不需要后端调用。`pantry.addToShopping` 已随购物域接线解封（见下节）。

### shopping（购物清单）

后端实体为两级结构（`ShoppingList` → `ShoppingListItem`），入口 UI 是单一平铺清单且无清单选择概念。adapter 将 UI 域绑定到「最近更新的 ACTIVE 清单」（`updatedAt desc` 第一个）；无 ACTIVE 清单时以固定名称「购物补货清单」自动 `POST /shopping-lists` 创建（不生成本地 id/date）。多个 ACTIVE 清单并存时其余清单在 UI 不可见，属已知 gap。

关键版本语义（与 stores/recipes/pantry 不同，务必区分）：项目级端点（add/update/delete item）携带的 `version` 全部是**父清单的 version**，`ShoppingListItem` 自身没有 version 字段。写成功响应都是更新后的完整清单 DTO（`{id,name,status,version,items:[...]}`），adapter 用它整体替换 cache；唯 `DELETE /shopping-list-items/:id` 响应只含 `{id, shoppingListId}`（无新 version），因此删除后 adapter 回拉一次 `GET /shopping-lists/:id` 同步最新清单与 version。

| 后端 | BentoService / Modal | 请求体与版本 |
|---|---|---|
| `GET /shopping-lists?status=ACTIVE` | `shopping.reload` | 后端无分页（返回数组），单请求；序号防竞态保留；空结果自动创建清单；`shopping:changed` 驱动 `renderShoppingList()` |
| `POST /shopping-lists`（自动创建） | `shopping.reload` / `shopping.add` 内 `ensureList` | body 只含 `{name:'购物补货清单'}`，无本地 id/date/random |
| `POST /shopping-lists/:id/items` | `shopping.add(item, notify)` | body `{version=清单version, ingredientName, quantity, unit, sourceType, sourceId:null, completed}`；`amount` 字符串（如 `500g`、`1份`）经单位映射表解析为 quantity+QuantityUnit，无法解析时 422 `SHOPPING_AMOUNT_UNSUPPORTED` 阻断；`source` 以 `菜谱:` 开头映射 `sourceType:'RECIPE'`，否则 `MANUAL`；无本地 id/date |
| `PUT /shopping-list-items/:id` | `shopping.toggle(id)`（勾选/取消勾选） | body 精确为 `{version=清单version, completed:!isChecked}`，不携带其余字段（避免把后端 `ingredientId` 等写空）；成功后以响应清单 DTO 更新 |
| `DELETE /shopping-list-items/:id?version=` | `shopping.delete(id)` | **version 在 query**（父清单 version），不发送 DELETE body；响应无新 version，回拉 `GET /shopping-lists/:id` 同步；成功 toast 由入口 `confirmDeleteShoppingItem` 负责，adapter 静默更新 |
| `PUT /shopping-list-items/:id` + `POST /shopping-lists/:id/clear-completed` | `shopping.importCheckedToPantry` | 见下 |

UI DTO → UI 映射（`mapShoppingItem`）：`name ← ingredientNameSnapshot`、`amount ← quantity + 单位中文标签`、`unitKey ← unit`（原始枚举）、`unit ← UNIT_LABELS 中文标签`、`isChecked ← completed`、`source ← sourceType 中文标签`（MANUAL→手动备忘、RECIPE→菜谱补料、LOW_STOCK/INSUFFICIENT_STOCK→库存预警、PLAN→排餐计划、RECOMMENDATION→智能推荐）。后端 `ShoppingListItem` 没有分类字段，UI `category` 固定映射为空字符串（分类徽章为空），不伪造数据。

`shopping.importCheckedToPantry`（勾选入库）已解封，映射为组合流程：对每个勾选项（1）无 `ingredientId` 的项 `POST /ingredients` 创建食材——沿用 pantry 域 batches 结构 `{quantity, unit(原始枚举), purchaseDate:null, expiryDate:null, location:null, opened:false, consumePriority:false, notes:null}`，缺失批次字段全部发 null，名称沿用入口语义去除括号后缀（如 `(手动补货)`）；（2）有 `ingredientId` 的项（低库存/缺货生成的项）**不重复建档**——后端没有“向已有食材加入库存”的端点（`adjust` 是批次级且新买无批次），仅做清单清理，文档记录为真实 gap；（3）全部建档完成后逐项 `PUT /shopping-list-items/:id {version,completed:true}`（version 随响应串联），最后 `POST /shopping-lists/:id/clear-completed {version}` 一次性清理所有已勾选项。无勾选项时仅提示不发请求；任何一步失败错误向调用层传播，已入库食材保留（真实状态），清单数据不变。legacy `handleShoppingFormSubmit`（原写入本地 id `shop-${Date.now()}`）已被 adapter 以真实 submit 覆盖（withSubmitGuard 防重入），成功后关闭 Modal 并恢复按钮，失败不关闭。

`pantry.addToShopping`（库存加入补货清单）已解封：quantity 固定 1、unit 直接使用库存项 `unitKey` 枚举（`1${unit 标签}` 经同一解析路径）、`sourceType:MANUAL`、名称保留入口语义 `名称 (手动补货)`；成功后关闭详情 Modal 并 toast。`unitKey:OTHER`（无单位食材）无法映射采购单位，422 `SHOPPING_AMOUNT_UNSUPPORTED` 阻断且不发请求。`pantry.consume` 内部的 `shopping.add` 调用随 consume 封堵不生效。

`recipes.addMissingIngredientsToShopping`（菜谱缺料一键补齐）已解封：按入口原语义用 pantry 名称匹配（`pantry.name 包含食材名 || 食材名包含 pantry.name`）筛出缺料项，数量/单位经 `parseShoppingAmount` 全量预解析，任一缺料项无法映射采购单位（如菜谱单位「克」「斗」）时 422 `SHOPPING_AMOUNT_UNSUPPORTED` 阻断且不发请求（避免半提交）；可解析时逐项 `POST /shopping-lists/:id/items`，名称保留入口语义 `食材名 (数量单位)`、`sourceType:'RECIPE'`；全部在库时仅提示不发起请求。成功后复用入口行为刷新 recipeDetail（走既有回拉守卫）并 toast 数量。

### plans（排餐计划）

后端实体为 `MealPlan`（`planDate`+`mealType` 唯一、`items` 关联 RECIPE/STORE/CUSTOM、`status` 四态、乐观锁 `version`）。`GET /plans` 无分页（数组直返，按 planDate+mealType 升序）。UI 的单目标计划（targetType/targetId/time/title/subtext/icon）映射到后端 plan 的第一个 item：title/icon/targetType/targetId/channel 均从 item 关联的 recipe/store DTO 推导（recipe → 🥘/cook，store → 按 supportsTakeout/DineIn 推导 takeout/dinein 与 🛵/🍽️）；UI 计划时刻（`time`）与 `title/subtext/icon` 自由文案在后端无对应字段，不发送，展示为空，属已知字段级 gap。`plans:changed` 驱动 `renderPlans()`。

| 后端 | BentoService / Modal | 请求体与版本 |
|---|---|---|
| `GET /plans` | `plans.reload` | 数组直返，单请求；序号防竞态保留；空列表清除旧数据 |
| `POST /plans` | `plans.add(plan)`（legacy `handlePlanPickerSubmit` 新建走此路径） | body 精确为 `{planDate, mealType, dinerCount:1, items:[{itemType, recipeId/storeId, sortOrder:0}]}`；UI slot 中文映射枚举（早餐→BREAKFAST、午餐→LUNCH、晚餐→DINNER、下午茶→AFTERNOON_TEA），「夜宵」等无法映射时 422 `PLAN_MEAL_TYPE_UNSUPPORTED` 阻断；缺目标时 422 `PLAN_TARGET_UNSUPPORTED` 阻断；`dinerCount` 固定 1（UI 无人数概念，后端必填，Prisma 默认值）；不生成本地 id |
| `PUT /plans/:id` | `plans.update(id, updates)`（legacy `handlePlanPickerSubmit` 编辑走此路径） | body `{version=cache version, planDate, mealType, dinerCount:1, items}`；COMPLETED 计划后端 409（UI 不再本地预判，由后端权威校验） |
| `DELETE /plans/:id?version=` | `plans.delete(id)` / `plans.remove`（别名） | version 在 query，不发送 DELETE body（与 recipes/pantry 相同语义） |
| `POST /plans/:id/complete` | `plans.checkin(id)` / `plans.toggleCheckin`（未完成时） | body `{version}`；后端原子完成计划并生成 DRAFT 记录（`sourceMealPlanId` 唯一约束幂等）；adapter 用响应 `plan` 更新 cache（`isCompleted ← status==='COMPLETED'`），响应 `record` 经 mapRecord 写入 records 域 cache 并 emit `records:changed`；`idempotent:true` 时记录只替换不重复插入，toast 文案区分「生成/恢复」 |
| —（无端点） | `plans.uncheckin` / `toggleCheckin`（已完成时） | gap：后端没有「取消完成/回退打卡」端点（`cancelPlan` 与 `updatePlan` 对 COMPLETED 均 409），继续封堵提示“该功能尚未接通真实后端” |

打卡完成响应中的 `inventoryDeductionPromptEnabled`（库存扣减确认提示开关）在入口 HTML 无对应 UI（消耗确认界面在被冻结的 Vue 页面），当前忽略；`POST /records/:id/consumption-preview`、`POST /records/:id/confirm-consumption`、`POST /consumption/preview-from-recipe`、`POST /consumption/confirm-from-recipe` 均无入口入口，未接线（见「仍未接通的写入口」）。

### records（饮食日记）

后端实体为 `MealRecord`（分页 `GET /records?page=&pageSize=`，默认 20、上限 100，按 recordDate/recordTime 倒序）。UI 日记的字段映射（`mapRecord`）：`date ← recordDate`、`slot ← mealType 中文标签`、`type ← sourceType 中文标签`（HOMEMADE→自烹、TAKEOUT→外卖、DINE_IN→堂食、CUSTOM→其他）、`icon ← sourceType 推导`（🍳/🛵/🍽️/🍱）、`title ← 第一个 item 的 customName/recipe.name/store.name`、`photos ← [imagePath]`；UI 的 `calories/cost/satiety` 在后端无对应字段，映射为空值（UI 走各自缺省展示）。

| 后端 | BentoService / Modal | 请求体与版本 |
|---|---|---|
| `GET /records?page=&pageSize=` | `records.reload` | 遍历 `totalPages`（兼容 total/pageSize）并一次性替换；序号防竞态保留；`records:changed` 驱动 `renderRecords()` |
| `POST /records` | `records.add(rec)`（legacy `handleRecordFormSubmit` 新建走此路径） | body `{recordDate(表单无日期字段，取本地今天), mealType, sourceType, rating, notes, imagePath(photos 首张), items:[{itemType:'CUSTOM', customName:title, sortOrder:0}]}`；「夜宵」slot 422 `RECORD_MEAL_TYPE_UNSUPPORTED`、未知就餐类型 422 `RECORD_SOURCE_TYPE_UNSUPPORTED`；calories/cost/satiety 任一非空时 422 `RECORD_EXTRA_FIELDS_UNSUPPORTED` 阻断（后端无这三个字段，为不静默丢弃用户输入，与 recipes.calories 同构处理；表单预填值需清空后保存） |
| `PUT /records/:id` | `records.update(id, updates)`（legacy 编辑走此路径） | body 按变更精确发送 `{version, mealType?, sourceType?, items?, rating?, notes?, imagePath?}`；photos 为空数组时不发送 imagePath（保留后端已有照片，避免把未改动字段清空）；多项目记录经 UI 编辑会退化为单项目（UI 无多项目编辑概念，字段级 gap） |
| `DELETE /records/:id?version=` | `records.delete(id)` / `records.remove`（别名） | version 在 query，不发送 DELETE body |
| —（无端点） | `records.buildFromPlan` | gap：无独立 UI 入口（仅被已接通的 `plans.checkin → POST /plans/:id/complete` 覆盖），继续封堵提示“该功能尚未接通真实后端” |

照片为字段级部分映射：后端仅 `imagePath` 单字段，UI 最多 3 张，提交仅取第一张（从 photoSlotView 预览 DOM 读取），第 2/3 张无法保存，属已知 gap。legacy mock 的 `userEdited` 标记在后端无等价字段，不发送。

### tools（厨房工具）

后端实体为 `KitchenTool`（`GET /tools` 无分页，数组直返，按 updatedAt 倒序；字段 name/imagePath/category/quantity/status/notes/version）。UI 映射（`mapTool`）：`icon ← imagePath || '🍲'`；UI 表单的图标 emoji 在后端无对应字段，不发送（入口必选装饰字段，阻断会使整个域不可用），展示回落到缺省 🍲，属已知字段级 gap。接通后 `mochi_tools` localStorage 的 mock 读写路径整体失效（`getAll` 不再读取、`save/delete` 不再写入该 key）。`tools:changed` 事件由 adapter 发出（入口 `renderTools` 由 mock 方法调用，接通后依赖 emit 驱动）。

| 后端 | BentoService / Modal | 请求体与版本 |
|---|---|---|
| `GET /tools` | `tools.reload` | 数组直返，单请求；序号防竞态保留；空列表清除旧数据 |
| `POST /tools` | `tools.save(tool)`（legacy `handleToolFormSubmit` 新建走此路径） | body 精确为 `{name, imagePath:null, category, status, notes}`；无本地 `tool-${Date.now()}` id、无 icon |
| `PUT /tools/:id` | `tools.save({id, ...})`（cache 命中时） | body 全量字段 + `version=cache version`（后端 update 为全量替换语义） |
| `DELETE /tools/:id?version=` | `tools.delete(id)` | version 在 query，不发送 DELETE body；响应 `{id, deleted:true}` |


## 分页、竞态与错误

- stores/recipes/records 的列表加载使用独立序号覆盖整次分页请求；旧请求即使晚返回也不能覆盖新结果。`totalPages` 优先，兼容 `total/pageSize` 推导；不再固定只显示第一页 100 条。shopping/plans/tools 列表后端无分页（数组直返），单请求加载并保留同样的序号防竞态。
- reload 失败按域分别 `catch` 并 toast，一个域失败不会掩盖另一个域的成功。
- API 客户端保留 HTTP 状态、后端 code/message/details；400、404、409、503 均走 error toast。写操作异常直接向调用层传播，失败不关闭 Modal、不显示 success、不修改旧数据。
- 成功写入只采用服务端返回 DTO 更新本地 cache；删除后移除服务端确认的 id。没有本地 ID、日期或随机业务值。
- 表单 submitter 使用 `data-submitting` + `disabled` 防重入，并在 `finally` 恢复；错误和成功路径都不会残留禁用状态。

## Dashboard 映射

`mapDashboard()` 恢复并清空所有既有业务槽位：branding/currentDate/greeting/tip、推荐菜谱卡片（name/tag/time/rating 与详情 handler）、今日三餐 title/status/count、inventory 三项统计、weeklyStats 四项统计、calendar 7 项 weekday/dayOfMonth/label/date/status 与 handler、临期食材 name/expiry/id 与 handler。空态会清理 text、hidden、dataset 和 onclick；问候卡只更新叶子节点，不破坏结构，也不使用视觉 class 或 nth-child 定位。

## 仍未接通的写入口

仅保留真实 gap：plans.uncheckin / plans.toggleCheckin（已完成侧，后端无「取消完成」端点，cancel/update 对 COMPLETED 均 409）、records.buildFromPlan（无独立 UI 入口，等价能力由 `POST /plans/:id/complete` 覆盖）、recipes.cookCheckin、pantry.consume（UI 固定克数消耗与后端批次级 adjust 语义不匹配）、shopping.importCheckedToPantry 对已有 ingredientId 项的库存增加（后端无“向已有食材加入库存”端点，仅清理清单不重复建档）、门店菜单实体、recipe calories、记录 calories/cost/satiety（`RECORD_EXTRA_FIELDS_UNSUPPORTED`，清空后可保存，非入口级 gap）、记录照片第 2/3 张（后端仅 imagePath 单字段）、计划时刻 time 与 title/subtext/icon 自由文案（后端无对应字段）、工具图标 emoji（后端无对应字段）、计划 dinerCount（UI 无概念，固定 1）、记录多项目编辑退化（UI 单 title 概念）、打卡后库存消耗确认流程（`/records/:id/consumption-preview`、`/records/:id/confirm-consumption`、`/consumption/preview-from-recipe`、`/consumption/confirm-from-recipe` 的 UI 在被冻结的 Vue 页面，入口 HTML 无对应界面）、食材批次编辑（INGREDIENT_BATCHES_UNSUPPORTED，UI 表单无编辑入口，属服务契约防御）、购物清单的清单级管理（UI 无清单列表/删除/完成入口，`DELETE /shopping-lists/:id`、`PUT /shopping-lists/:id`、`POST /shopping-lists/generate` 未接线）、多个 ACTIVE 清单并存时其余清单在 UI 不可见。stores/recipes/pantry/plans/records/tools 的 CRUD 与删除、shopping 域全部四个写入口（add/toggle/delete/importCheckedToPantry）、pantry.addToShopping、recipes.addMissingIngredientsToShopping、plans.checkin（→ complete）已从封堵清单移除。

## 收口轮（2026-09-29）修复与登记

### index.html DOM 损坏修复（视觉还原）

收口 UI Freeze 对比（原版 Source of Truth 逐行 diff + 浏览器渲染验证）发现：入口 HTML 移动端周打卡区域此前的 data-empty-action 批量替换误删了 4 处结构——桌面周历网格的闭合 `</div>`、移动端列表注释、`mobile-week-calendar-list` 容器开始标签、首条目开标签前半段，残留一行以 `8EEDB]` 开头的裸文本。后果：裸文本渲染进桌面网格、首条目内容（周一 9/1 等）成为孤立网格子元素、其余 6 条目错位到容器外、`mobile-week-calendar-list` 容器缺失导致移动端列表失去承载。已按原版逐字还原该 4 处结构（首条目 `onclick` 改为 `data-empty-action="dailyDiary"`，与其余 6 条目接线约定一致），并核验：还原区域与原版仅差该属性替换；修复引入的一处裸 CR 行尾已修正回 CRLF；浏览器复查桌面网格 7 子元素、无裸文本、无孤立子元素、移动端列表容器与 7 条目完整。

### 收口轮新登记的未接线区域与行为差异

- 移动端周打卡列表（`mobile-week-calendar-list` 7 条目）：dashboard `GET /dashboard` 已返回 calendarDays 数据，但 adapter 仅接线桌面 `calendarDay-0..6`，移动端列表无 data-binding、未接线，条目保留原版静态演示内容（周一 9/1 … 今天 9/7），移动端视口可见、条目点击无响应（原 onclick 已按接线约定移除）。按「UI 冻结不改」边界与用户决策登记为 gap，不在本轮补接线。
- 转盘落点：原版 `Math.floor(Math.random() * items.length)` 在假数据清零中改为 `targetIndex = 0`，候选来自真实 stores/recipes，但每次旋转固定停在第一项。属行为差异（非视觉/DOM/CSS），登记待后续决策（恢复随机或接后端推荐）。
- 设置页文案：原版演示文案（忌口关联、最近备份日期、风格生效声明）改为「暂无可用数据」「视觉风格已启用」诚实空态；「修改 →」（忌口偏好编辑，后端无对应能力）按钮无动作，属 fail-closed；「立即备份 →」由 adapter 接 `GET /backups/export`。
- Dashboard `greetingTitle`（问候卡主标题）：后端 dashboard 无该字段（仅有 `greetingText`，进提示气泡 `tip` 槽位），主标题在正式运行中为诚实空态，不伪造问候语。
- `git diff --check`：30 条 trailing whitespace 警告全部位于 `app/client/index.html`，与原版源文件的 30 行行尾空格逐行一致（零新增），属冻结源文件固有属性，不做清洗。

## 修改文件

- `app/client/public/google2-adapter.js`
- `app/client/tests/google2-adapter.test.ts`
- `docs/integration/google2-wiring.md`
- `app/client/index.html`：仅收口轮上述 DOM 结构还原（+行尾 CRLF 修正），视觉结构回到原版；另有前序接线轮的 data-binding 属性、mock 种子清空（`data: []`）、本地 id/固定日期改真实值、adapter `<script>` 引用。
- `app/client/src/services/api.ts`：apiRequest 容错增强（非 JSON/空响应解析、Content-Type 头合并、错误信息含状态码），非视觉。
- `.prettierignore`：排除 `app/client/index.html`（保护冻结源文件不被 prettier 重排）。
- 既有入口/视觉基线保持不变；CompleteMealPage.vue 与 uxa-journey.test.ts 无修改。

## 当前验证

- `node --check app/client/public/google2-adapter.js`：通过。
- Google2 adapter 定向测试：71/71 通过（上轮 51 基例中 2 例按三域接通如实更新：「所有未接后端写入口」用例的封堵清单收敛为 pantry save/consume/delete + plans.uncheckin + records.buildFromPlan、addMissingIngredientsToShopping 从 gap 用例表移入解封契约用例、cookCheckin gap 用例保留；本轮新增 20 例测试实例净值，含 plans 数组直返 reload 与竞态/DTO 目标推导、add/update/delete 精确契约与 version 串联、checkin→complete 联动 records 域写入 DRAFT 记录与幂等不重复插入、uncheckin gap 阻断、plans 400/404/409/503 失败传播、records 分页 reload 与竞态、add 精确契约与 RECORD_EXTRA_FIELDS/餐次/来源类型 422 阻断、update 精确契约与 photos 为空不覆盖后端照片、records 400/404/409/503 失败传播、legacy record 表单真实 submit（清空不支持字段后提交关闭 Modal、预填卡路里阻断不关闭）、tools 数组直返 reload 与竞态、save/delete 精确契约（POST 无 icon/本地 id、PUT version 串联、DELETE query）、mochi_tools localStorage 失效（boot 后不读取、save/delete 不写入）、legacy tool 表单真实 submit、addMissingIngredientsToShopping 解封契约（RECIPE 来源、在库跳过、不可映射单位阻断、全部在库仅提示））。
- client 全量测试：14 个文件、135/135 通过（上轮 115 基线 + 本轮新增 20 例净值）；根 `npm test`（server）：30 个文件、150/150 通过。
- `npm run typecheck`：通过；`npm run lint`：通过；`npm run build`：通过。
- `npx prettier --check app/client/public/google2-adapter.js app/client/tests/google2-adapter.test.ts docs/integration/google2-wiring.md`：通过。
- `npm run format:check`：失败，仅两个既有禁改文件不符合格式：`app/client/src/pages/CompleteMealPage.vue`、`app/server/src/modules/meal-records/uxa-journey.test.ts`。
- 后端事实核对（与任务假设的差异，以后端实际为准）：`GET /api/v1/plans` 无分页（数组直返，planDate+mealType 升序），与任务假设的「列表分页」不同，仅保留序号防竞态；`GET /api/v1/records` 分页（默认 20、上限 100）；plans/records/tools 的 DELETE version 全部在 query 且不发 DELETE body（与 recipes/pantry 相同语义）；plans 的 `POST /plans/:id/complete` 即打卡端点（原子生成 DRAFT 记录、sourceMealPlanId 唯一约束幂等、返回 `{plan, record, idempotent, inventoryDeductionPromptEnabled}`），后端没有「取消完成」端点（cancel/update 对 COMPLETED 均 409），uncheckin 因此保留 gap；`POST /plans` 必填 `dinerCount`（UI 无人数概念，固定发送 1 = 后端/Prisma 默认值）；后端 plan/record 无 time/title/subtext/icon/calories/cost/satiety/userEdited 字段（相关 UI 字段不发送或映射为空）；MealType 枚举含 AFTERNOON_TEA/SOUP，无「夜宵」等价；`KitchenTool` 有 quantity 字段（UI 表单无数量输入，未接线该字段）；后端 400/409 业务错误 code 为通用 `VALIDATION_ERROR`/`VERSION_CONFLICT` 等，无 plans/records/tools 专用码；consumption 四端点为两步 preview/confirm 流程（previewToken+operationId），UI 在被冻结的 Vue 页面，入口 HTML 无对应界面。
- 扫描结果：`mochi_theme` 与 PIN token 的 localStorage 保留；`mochi_tools` localStorage 的 mock 读写路径已随 tools 接线整体失效（getAll 不再读取、save/delete 不再写入，index.html 中的 legacy 代码按视觉冻结不改、运行时不再触达）。legacy `handleToolFormSubmit` 的 `tool-${Date.now()}` 本地 id 路径、legacy `handlePlanPickerSubmit` 的 `plan-${Date.now()}` 路径、legacy `handleRecordFormSubmit` 的 `rec-${Date.now()}` 与 `new Date().toISOString()` 本地 id/日期路径均已由 adapter 真实 submit 覆盖失效。彩带 `Math.random` 仅用于纯视觉动画。本轮实际修改仅 `app/client/public/google2-adapter.js`、`app/client/tests/google2-adapter.test.ts`、`docs/integration/google2-wiring.md` 三个文件；`CompleteMealPage.vue`、`uxa-journey.test.ts`、`app/server/**`、入口 HTML、`docs/visual-baseline`、`.prettierignore`、`package.json` 均无本轮改动。
- 浏览器端到端冒烟（主代理执行，2026-09-29）：`npm run seed:dev`（DATABASE_URL=file:../../../data/app.db，幂等 seed）+ `npm run dev:server` + `npm run dev:client`，经 Vite (5173) 打开 Google2 入口：adapter 成功 boot（`DafanDomainAdapter` 就绪、写入口封堵标记生效），七域全部加载真实后端数据——stores 1（审计小馆）、recipes 7、pantry 14（含 expireDaysLeft 派生值 93/10）、shopping 1（审计苹果 1个）、plans 2（isCompleted 状态正确）、records 16、tools 0；`mochi_tools` localStorage 保持空（mock 写路径未触达）；页面无 console 错误、无页面异常；`/api/v1/stores` 经 Vite 代理返回真实种子数据。环境备注：直接访问 8787 返回 API 404 是既有设计（静态托管仅 production 模式）；本机 5173/8787 的 127.0.0.1 监听被其他会话进程占用，冒烟经 192.168.5.9:5173 完成。
- 收口轮复验（2026-09-29，DOM 修复后重新执行）：`npm test` 全绿（client 14 文件 135/135、server 30 文件 150/150，含 adapter 定向 71/71；run-tests.mjs 的 data/app.db SHA-256/mtime 前后一致守卫通过）；`npm run typecheck`/`lint`/`build` 通过；`npm run format:check` 仍仅两个既有禁改文件失败；`git diff --check` 仅上述 30 条继承自原版的行尾空白警告，其余修改文件干净。冒烟轮使用隔离测试数据库，未触碰 data/app.db。
- 以上命令均为本轮实际执行结果；format:check 的两个既有失败项是已知限制，不能宣称全套格式检查通过。
