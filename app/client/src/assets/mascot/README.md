# 小羊素材目录

节点 4 已接入用户提供的本地透明小羊素材。原始素材保留在 `docs/design/`，应用运行时使用复制到本目录的打包副本；不裁切参考图、不生成新画风、不引入网络图片。

统一资产待提供后，放置以下文件名：

- `brand-logo.png`：来自 `docs/design/小羊左上角.png`
- `home-hero.png`：来自 `docs/design/小羊右上角.png`
- `sidebar-tip.png`：来自 `docs/design/小羊左下角.png`
- `empty-state.png`：后续按同一角色补充

当前界面继续使用 `MascotPlaceholder.vue` 作为统一素材渲染入口，以保持布局尺寸和无障碍标识稳定。
